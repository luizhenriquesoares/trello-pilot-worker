import { RepoManager } from '../../git/repo-manager.js';
import { TrelloApi } from '../../trello/api.js';
import { PromptBuilder } from '../../claude/prompt-builder.js';
import { runClaude } from '../../claude/headless-runner.js';
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

  constructor(
    private readonly repoManager: RepoManager,
    private readonly trelloApi: TrelloApi,
    private readonly commenter: TrelloCommenter,
  ) {
    this.promptBuilder = new PromptBuilder();
  }

  async execute(event: WorkerEvent, context: QaContext): Promise<QaResult> {
    const startTime = Date.now();

    const card = await this.trelloApi.getCard(event.cardId);
    const checklists = await this.trelloApi.getCardChecklists(event.cardId);
    card.checklists = checklists;

    const { branchName, workDir } = context;

    if (event.rules.length > 0) {
      this.promptBuilder.setRules(event.rules);
    }

    // Checkout the branch (clone fresh if workDir is gone)
    try {
      await this.repoManager.checkoutBranch(workDir, branchName);
    } catch {
      console.log('[QA] workDir missing, cloning fresh');
      await this.repoManager.clone(event.repoUrl, workDir, event.baseBranch);
      await this.repoManager.checkoutBranch(workDir, branchName);
    }

    // Get PR URL
    const prUrl = context.prUrl || (await this.repoManager.getPrUrl(workDir, branchName)) || '';

    // Comment on Trello: starting QA
    await this.commenter.postQaStarted(card.id, branchName, prUrl);

    // Build QA prompt and run claude headless
    console.log(`[QA] Running QA for branch: ${branchName}`);
    const prompt = this.promptBuilder.buildQA(card, branchName);
    const runResult = await runClaude({
      cwd: workDir,
      prompt,
    });

    const costUsd = runResult.costUsd ?? 0;

    // Push any QA fixes
    try {
      await this.repoManager.push(workDir, branchName);
    } catch (err) {
      console.warn(`[QA] Push failed (may have no changes): ${(err as Error).message}`);
    }

    // Merge PR via squash
    let merged = false;
    try {
      console.log(`[QA] Merging PR for branch: ${branchName}`);
      await this.repoManager.mergePr(workDir, branchName);
      merged = true;
      console.log('[QA] PR merged successfully');
    } catch (err) {
      console.error(`[QA] PR merge failed: ${(err as Error).message}`);
    }

    // Comment on Trello
    const durationMs = Date.now() - startTime;
    await this.commenter.postQaComplete(card.id, {
      branchName,
      prUrl,
      durationMs,
      costUsd,
      merged,
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
