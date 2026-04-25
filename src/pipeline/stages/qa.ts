import { RepoManager } from '../../git/repo-manager.js';
import { TrelloApi } from '../../trello/api.js';
import { PromptBuilder } from '../../claude/prompt-builder.js';
import { KnowledgeManager } from '../../claude/knowledge.js';
import { runClaude } from '../../claude/headless-runner.js';
import { WorkspaceBootstrapper } from '../../claude/workspace-bootstrapper.js';
import { TrelloCommenter } from '../../notifications/trello-commenter.js';
import type { WorkerEvent } from '../../shared/types/worker-event.js';

export interface QaResult {
  merged: boolean;
  costUsd: number;
  durationMs: number;
}

export interface QaContext {
  branchName: string;
  prUrl: string;
  workDir: string;
}

export class QaStage {
  private readonly promptBuilder: PromptBuilder;
  private readonly knowledgeMgr: KnowledgeManager;
  private readonly workspaceBootstrapper: WorkspaceBootstrapper;

  constructor(
    private readonly repoManager: RepoManager,
    private readonly trelloApi: TrelloApi,
    private readonly commenter: TrelloCommenter,
  ) {
    this.promptBuilder = new PromptBuilder();
    this.knowledgeMgr = new KnowledgeManager();
    this.workspaceBootstrapper = new WorkspaceBootstrapper();
  }

  async execute(event: WorkerEvent, context: QaContext): Promise<QaResult> {
    const startTime = Date.now();
    this.promptBuilder.reset();

    const [card, checklists] = await Promise.all([
      this.trelloApi.getCard(event.cardId),
      this.trelloApi.getCardChecklists(event.cardId),
    ]);
    card.checklists = checklists;

    const { branchName, workDir } = context;

    if (event.rules.length > 0) {
      this.promptBuilder.setRules(event.rules);
    }

    // Check if workDir exists, clone fresh if not (container restart loses /tmp)
    const fs = await import('fs');
    if (!fs.existsSync(workDir)) {
      console.log(`[QA] workDir ${workDir} missing (container restarted?), cloning fresh`);
      await this.repoManager.clone(event.repoUrl, workDir, event.baseBranch);
    }
    await this.repoManager.checkoutBranch(workDir, branchName);

    // Get PR URL
    const prUrl = context.prUrl || (await this.repoManager.getPrUrl(workDir, branchName)) || '';

    // Load project knowledge from CLAUDE.md if available
    const claudeMdContext = this.knowledgeMgr.formatClaudeMdForPrompt(workDir);
    if (claudeMdContext) {
      this.promptBuilder.setKnowledge(claudeMdContext);
    }

    const workspace = await this.workspaceBootstrapper.prepare(workDir);
    this.promptBuilder.setWorkspaceContext(workspace.promptContext);

    // Comment on Trello: starting QA
    await this.commenter.postQaStarted(card.id, branchName, prUrl, event.projectName);

    // Build QA prompt and run claude headless
    console.log(`[QA] Running QA for branch: ${branchName}`);
    const prompt = this.promptBuilder.buildQA(card, branchName);
    const runResult = await runClaude({
      cwd: workDir,
      prompt,
    });

    const costUsd = runResult.costUsd ?? 0;

    // Block merge if QA itself didn't run cleanly. exitCode 124 = timeout.
    // Without this guard a Claude crash/timeout would still advance to gh pr merge,
    // promoting unverified code to main.
    const qaPassed = runResult.exitCode === 0;
    if (!qaPassed) {
      const reason = runResult.exitCode === 124 ? 'timed out' : `exited with code ${runResult.exitCode}`;
      console.error(`[QA] Claude QA ${reason} on branch "${branchName}" — skipping merge`);
    }

    // Push any QA fixes (safe even when QA failed; just pushes whatever's already committed)
    try {
      await this.repoManager.push(workDir, branchName);
    } catch (err) {
      console.warn(`[QA] Push failed (may have no changes): ${(err as Error).message}`);
    }

    // Merge PR via squash — only if QA passed
    let merged = false;
    if (qaPassed) {
      try {
        console.log(`[QA] Merging PR for branch: ${branchName}`);
        await this.repoManager.mergePr(workDir, branchName);
        merged = true;
        console.log('[QA] PR merged successfully');
      } catch (err) {
        console.error(`[QA] PR merge failed: ${(err as Error).message}`);
      }
    }

    // Comment on Trello
    const durationMs = Date.now() - startTime;
    await this.commenter.postQaComplete(card.id, {
      branchName,
      prUrl,
      durationMs,
      costUsd,
      merged,
      projectName: event.projectName,
    });

    // Cleanup temp directory
    console.log(`[QA] Cleaning up work directory: ${workDir}`);
    await this.repoManager.cleanup(workDir);

    return {
      merged,
      costUsd,
      durationMs,
    };
  }
}
