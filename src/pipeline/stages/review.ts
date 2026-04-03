import { RepoManager } from '../../git/repo-manager.js';
import { TrelloApi } from '../../trello/api.js';
import { PromptBuilder } from '../../claude/prompt-builder.js';
import { runClaude } from '../../claude/headless-runner.js';
import { TrelloCommenter } from '../../notifications/trello-commenter.js';
import type { WorkerEvent } from '../../shared/types/worker-event.js';

export interface ReviewResult {
  branchName: string;
  prUrl: string;
  workDir: string;
  costUsd: number;
  durationMs: number;
}

export interface ReviewContext {
  branchName: string;
  prUrl: string;
  workDir: string;
}

export class ReviewStage {
  private readonly promptBuilder: PromptBuilder;

  constructor(
    private readonly repoManager: RepoManager,
    private readonly trelloApi: TrelloApi,
    private readonly commenter: TrelloCommenter,
  ) {
    this.promptBuilder = new PromptBuilder();
  }

  async execute(event: WorkerEvent, context: ReviewContext): Promise<ReviewResult> {
    const startTime = Date.now();

    const card = await this.trelloApi.getCard(event.cardId);
    const checklists = await this.trelloApi.getCardChecklists(event.cardId);
    card.checklists = checklists;

    const { branchName, workDir } = context;

    if (event.rules.length > 0) {
      this.promptBuilder.setRules(event.rules);
    }

    // Check if workDir exists, clone fresh if not (container restart loses /tmp)
    const fs = await import('fs');
    if (!fs.existsSync(workDir)) {
      console.log(`[Review] workDir ${workDir} missing (container restarted?), cloning fresh`);
      await this.repoManager.clone(event.repoUrl, workDir, event.baseBranch);
    }
    await this.repoManager.checkoutBranch(workDir, branchName);

    // Get PR URL
    let prUrl = context.prUrl;
    if (!prUrl) {
      prUrl = (await this.repoManager.getPrUrl(workDir, branchName)) ?? '';
    }

    console.log(`[Review] Reviewing branch: ${branchName}, PR: ${prUrl || 'N/A'}`);

    // Comment on Trello: starting review
    await this.commenter.postReviewStarted(card.id, branchName, prUrl, event.projectName);

    // Build review prompt and run claude headless
    const prompt = this.promptBuilder.buildReview(card, branchName, prUrl);
    const runResult = await runClaude({
      cwd: workDir,
      prompt,
    });

    const costUsd = runResult.costUsd ?? 0;

    // Push review fixes
    console.log(`[Review] Pushing review fixes for branch: ${branchName}`);
    try {
      await this.repoManager.push(workDir, branchName);
    } catch (err) {
      console.warn(`[Review] Push failed (may have no changes): ${(err as Error).message}`);
    }

    // Comment on Trello
    const durationMs = Date.now() - startTime;
    await this.commenter.postReviewComplete(card.id, {
      branchName,
      prUrl,
      durationMs,
      costUsd,
      projectName: event.projectName,
    });

    return {
      branchName,
      prUrl,
      workDir,
      costUsd,
      durationMs,
    };
  }
}
