import { ImplementStage } from './stages/implement.js';
import { ReviewStage, type ReviewContext } from './stages/review.js';
import { QaStage, type QaContext } from './stages/qa.js';
import { SqsProducer, type PipelineContext, type SqsMessageEnvelope } from '../sqs/producer.js';
import { TrelloApi } from '../trello/api.js';
import { TrelloCommenter } from '../notifications/trello-commenter.js';
import { SlackNotifier } from '../notifications/slack.js';
import { JobTracker } from '../tracking/job-tracker.js';
import { StreamBroadcaster } from '../server/websocket.js';
import { DeployWatcher } from '../deploy/watcher.js';
import { runClaude } from '../claude/headless-runner.js';
import { PipelineStage } from '../shared/types/pipeline-stage.js';
import type { WorkerEvent } from '../shared/types/worker-event.js';
import type { BoardConfig } from '../config/types.js';

const NEXT_STAGE_MAP: Record<PipelineStage, PipelineStage | null> = {
  [PipelineStage.IMPLEMENT]: PipelineStage.REVIEW,
  [PipelineStage.REVIEW]: PipelineStage.QA,
  [PipelineStage.QA]: null,
};

interface PendingDeploy {
  cardId: string;
  projectName: string;
  mergedAt: string;
  totalCostUsd: number;
}

export class PipelineOrchestrator {
  readonly pendingDeploys = new Map<string, PendingDeploy>();
  private readonly repoLocks = new Map<string, string>(); // repoUrl → cardId

  constructor(
    private readonly implementStage: ImplementStage,
    private readonly reviewStage: ReviewStage,
    private readonly qaStage: QaStage,
    private readonly sqsProducer: SqsProducer,
    private readonly trelloApi: TrelloApi,
    private readonly commenter: TrelloCommenter,
    private readonly slackNotifier: SlackNotifier,
    private readonly boardConfig: BoardConfig,
    private readonly jobTracker?: JobTracker,
    private readonly broadcaster?: StreamBroadcaster,
    private readonly deployWatcher?: DeployWatcher,
  ) {}

  async processEvent(event: WorkerEvent, pipelineContext?: PipelineContext): Promise<void> {
    // Repo lock: prevent concurrent tasks on the same repository
    const lockHolder = this.repoLocks.get(event.repoUrl);
    if (lockHolder && lockHolder !== event.cardId) {
      console.log(
        `[Orchestrator] Repo ${event.repoUrl} is locked by card ${lockHolder}. ` +
        `Re-enqueueing card ${event.cardId} with 60s delay.`,
      );
      const envelope: SqsMessageEnvelope = { event, pipelineContext };
      await this.sqsProducer.sendWithDelay(envelope, 60);
      return;
    }

    // Acquire repo lock
    this.repoLocks.set(event.repoUrl, event.cardId);
    console.log(`[Orchestrator] Acquired repo lock for ${event.repoUrl} (card ${event.cardId})`);

    const stageMap: Record<PipelineStage, 'implement' | 'review' | 'qa'> = {
      [PipelineStage.IMPLEMENT]: 'implement',
      [PipelineStage.REVIEW]: 'review',
      [PipelineStage.QA]: 'qa',
    };

    const stageName = stageMap[event.stage];
    const projectName = event.projectName || 'Unknown';

    // Fetch card name for tracking
    let cardName = pipelineContext?.cardName || event.cardId;
    try {
      const card = await this.trelloApi.getCard(event.cardId);
      cardName = card.name;
    } catch { /* use fallback */ }

    const retryLabel = event.isRetry ? ' (RETRY)' : '';
    console.log(`[Orchestrator] Processing ${stageName}${retryLabel} for: ${cardName} [${projectName}]`);

    // Guard: for IMPLEMENT stage, verify the card is still in the expected project list.
    // This prevents stale SQS messages from running (e.g. card moved between project lists).
    if (event.stage === PipelineStage.IMPLEMENT && event.originListId) {
      try {
        const card = await this.trelloApi.getCard(event.cardId);
        if (card.idList !== event.originListId) {
          console.log(
            `[Orchestrator] Card ${event.cardId} is no longer in origin list ${event.originListId} ` +
            `(current list: ${card.idList}). Skipping stale IMPLEMENT for ${event.repoUrl}.`,
          );
          return;
        }
      } catch (err) {
        console.warn(`[Orchestrator] Failed to verify card list (proceeding anyway): ${(err as Error).message}`);
      }
    }

    // Track job start
    const jobId = this.jobTracker?.start(event.cardId, cardName, projectName, stageName);
    this.broadcaster?.notifyJobStart(event.cardId, cardName, stageName);
    this.slackNotifier.notifyStageStart(cardName, event.stage, projectName).catch(() => {});

    // Create stream handler for real-time updates
    const onEvent = this.broadcaster?.createStreamHandler(event.cardId, cardName, stageName);

    try {
      // Timeout per stage
      const STAGE_TIMEOUTS: Record<string, number> = {
        implement: 40 * 60 * 1000,
        review: 15 * 60 * 1000,
        qa: 20 * 60 * 1000,
      };
      const STAGE_TIMEOUT_MS = STAGE_TIMEOUTS[stageName] || 30 * 60 * 1000;
      const stagePromise = (async () => {
        switch (event.stage) {
          case PipelineStage.IMPLEMENT:
            await this.handleImplement(event, cardName, onEvent);
            break;
          case PipelineStage.REVIEW:
            await this.handleReview(event, cardName, pipelineContext, onEvent);
            break;
          case PipelineStage.QA:
            await this.handleQa(event, cardName, pipelineContext, onEvent);
            break;
          default: {
            const exhaustiveCheck: never = event.stage;
            throw new Error(`Unknown pipeline stage: ${exhaustiveCheck}`);
          }
        }
      })();

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Stage ${stageName} timed out after ${STAGE_TIMEOUTS[stageName]! / 60_000}min`)), STAGE_TIMEOUT_MS),
      );

      await Promise.race([stagePromise, timeoutPromise]);

      // Track job success
      if (jobId) {
        this.jobTracker?.complete(jobId, {
          branch: pipelineContext?.branchName,
          prUrl: pipelineContext?.prUrl,
        });
      }
      this.broadcaster?.notifyJobComplete(event.cardId, cardName, stageName, 'Completed successfully');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`[Orchestrator] Stage ${event.stage} failed for card ${event.cardId}: ${errorMessage}`);

      if (jobId) {
        this.jobTracker?.fail(jobId, errorMessage);
      }
      this.broadcaster?.notifyJobFail(event.cardId, cardName, stageName, errorMessage);
      this.slackNotifier.notifyError(cardName, event.stage, errorMessage, projectName).catch(() => {});

      await this.commenter.postError(event.cardId, event.stage, errorMessage, projectName).catch((commentErr) => {
        console.error(`[Orchestrator] Failed to post error comment: ${(commentErr as Error).message}`);
      });
    } finally {
      // Release repo lock
      if (this.repoLocks.get(event.repoUrl) === event.cardId) {
        this.repoLocks.delete(event.repoUrl);
        console.log(`[Orchestrator] Released repo lock for ${event.repoUrl} (card ${event.cardId})`);
      }

      // Cleanup /tmp repos only after QA (last stage) — earlier stages pass workDir to next stage
      if (event.stage === PipelineStage.QA && pipelineContext?.workDir) {
        try {
          const { rm } = await import('fs/promises');
          await rm(pipelineContext.workDir, { recursive: true, force: true });
          console.log(`[Orchestrator] Cleaned up: ${pipelineContext.workDir}`);
        } catch { /* ignore cleanup errors */ }
      }
    }
  }

  private async handleImplement(
    event: WorkerEvent,
    cardName: string,
    onEvent?: (e: import('../claude/headless-runner.js').ClaudeStreamEvent) => void,
  ): Promise<void> {
    // Move card to doing list
    await this.trelloApi.moveCard(event.cardId, this.boardConfig.lists.doing);

    const result = await this.implementStage.execute(event, onEvent);

    // Move card to review list
    await this.trelloApi.moveCard(event.cardId, this.boardConfig.lists.review);

    // Enqueue next stage (review) with context from implement
    const nextStage = NEXT_STAGE_MAP[PipelineStage.IMPLEMENT];
    if (nextStage) {
      const nextEvent: WorkerEvent = { ...event, stage: nextStage };
      const context: PipelineContext = {
        branchName: result.branchName,
        prUrl: result.prUrl,
        workDir: result.workDir,
        cumulativeCostUsd: result.costUsd,
        cardName,
        projectName: event.projectName,
        commitSummary: result.commitSummary,
      };

      await this.sqsProducer.sendWithContext(nextEvent, context);
      console.log(`[Orchestrator] Enqueued ${nextStage} stage for card ${event.cardId}`);
    }
  }

  private async handleReview(
    event: WorkerEvent,
    cardName: string,
    context?: PipelineContext,
    _onEvent?: (e: import('../claude/headless-runner.js').ClaudeStreamEvent) => void,
  ): Promise<void> {
    if (!context) {
      throw new Error('Review stage requires pipeline context (branchName, workDir) from implement stage');
    }

    const reviewContext: ReviewContext = {
      branchName: context.branchName,
      prUrl: context.prUrl,
      workDir: context.workDir,
    };

    const result = await this.reviewStage.execute(event, reviewContext);

    // Move card to QA list
    await this.trelloApi.moveCard(event.cardId, this.boardConfig.lists.qa);

    // Enqueue next stage (qa) — carry forward cardName, projectName, commitSummary
    const nextStage = NEXT_STAGE_MAP[PipelineStage.REVIEW];
    if (nextStage) {
      const nextEvent: WorkerEvent = { ...event, stage: nextStage };
      const nextContext: PipelineContext = {
        branchName: result.branchName,
        prUrl: result.prUrl,
        workDir: result.workDir,
        cumulativeCostUsd: context.cumulativeCostUsd + result.costUsd,
        cardName,
        projectName: context.projectName,
        commitSummary: context.commitSummary,
      };

      await this.sqsProducer.sendWithContext(nextEvent, nextContext);
      console.log(`[Orchestrator] Enqueued ${nextStage} stage for card ${event.cardId}`);
    }
  }

  private async handleQa(
    event: WorkerEvent,
    cardName: string,
    context?: PipelineContext,
    _onEvent?: (e: import('../claude/headless-runner.js').ClaudeStreamEvent) => void,
  ): Promise<void> {
    if (!context) {
      throw new Error('QA stage requires pipeline context (branchName, workDir) from review stage');
    }

    const qaContext: QaContext = {
      branchName: context.branchName,
      prUrl: context.prUrl,
      workDir: context.workDir,
    };

    const result = await this.qaStage.execute(event, qaContext);

    const totalCost = context.cumulativeCostUsd + result.costUsd;
    const projectName = event.projectName || context.projectName || 'Unknown';

    // Mark all checklist items as complete on Trello
    await this.markChecklistsComplete(event.cardId).catch((err) => {
      console.warn(`[Orchestrator] Failed to mark checklists: ${(err as Error).message}`);
    });

    // Auto-update CLAUDE.md with any new patterns discovered during implementation
    if (result.merged && context.workDir) {
      await this.autoUpdateClaudeMd(context.workDir, event.repoUrl).catch((err) => {
        console.warn(`[Orchestrator] CLAUDE.md auto-update failed (non-blocking): ${(err as Error).message}`);
      });
    }

    // Delegate to DeployWatcher (or move to Done immediately)
    if (this.deployWatcher) {
      this.deployWatcher.addPending(
        event.cardId,
        projectName,
        totalCost,
        context.branchName,
        event.repoUrl,
        cardName,
        context.commitSummary,
        context.prUrl,
        result.durationMs,
      );
    } else {
      // No deploy watcher — move to Done immediately with summary
      await this.trelloApi.moveCard(event.cardId, this.boardConfig.lists.done).catch((err) => {
        console.error(`[Orchestrator] Failed to move card to Done: ${(err as Error).message}`);
      });

      await this.commenter.postDoneSummary(event.cardId, {
        merged: result.merged,
        totalCostUsd: totalCost,
        totalDurationMs: result.durationMs,
        projectName,
        commitSummary: context.commitSummary,
        prUrl: context.prUrl,
        cardName,
      });

      this.slackNotifier.notifyComplete(
        cardName, result.merged, totalCost, projectName, context.commitSummary, context.prUrl,
      ).catch(() => {});
    }

    console.log(`[Orchestrator] QA complete for card ${event.cardId}. Merged: ${result.merged}. Cost: $${totalCost.toFixed(4)}`);
  }

  /** Mark all checklist items as complete on the Trello card */
  private async markChecklistsComplete(cardId: string): Promise<void> {
    const checklists = await this.trelloApi.getCardChecklists(cardId);
    for (const checklist of checklists) {
      for (const item of checklist.checkItems) {
        if (item.state !== 'complete') {
          await this.trelloApi.updateCheckItem(cardId, item.id, 'complete');
        }
      }
    }
    if (checklists.length > 0) {
      console.log(`[Orchestrator] Marked all checklist items as complete for card ${cardId}`);
    }
  }

  /**
   * Run a lightweight Claude call to update CLAUDE.md with any new patterns
   * discovered during the implementation. Non-blocking — failures are logged and swallowed.
   */
  private async autoUpdateClaudeMd(_workDir: string, repoUrl: string): Promise<void> {
    const CLAUDE_MD_TIMEOUT_MS = 2 * 60 * 1000;
    const CLAUDE_MD_MAX_BUDGET = 0.10;

    const { mkdtemp } = await import('fs/promises');
    const { join } = await import('path');
    const tmpDir = await mkdtemp(join('/tmp', 'claude-md-'));

    try {
      const { spawn } = await import('child_process');

      // Build authenticated URL for private repos
      const ghToken = process.env.GH_TOKEN;
      let cloneUrl = repoUrl;
      if (ghToken) {
        try {
          const parsed = new URL(repoUrl);
          parsed.username = 'x-access-token';
          parsed.password = ghToken;
          cloneUrl = parsed.toString();
        } catch { /* use original URL */ }
      }

      await new Promise<void>((resolve, reject) => {
        const proc = spawn('git', ['clone', '--depth', '5', cloneUrl, tmpDir], {
          stdio: ['ignore', 'ignore', 'pipe'],
          env: { ...process.env },
        });
        let stderr = '';
        proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
        proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`git clone failed (exit ${code}): ${stderr.trim()}`)));
        proc.on('error', reject);
      });

      const prompt = [
        'Read the CLAUDE.md and the recent git diff (use `git log --oneline -5` and `git diff HEAD~1`).',
        'If the implementation introduced new patterns, endpoints, components, or architectural changes',
        'that should be documented, update CLAUDE.md.',
        'If nothing significant changed, do nothing.',
      ].join(' ');

      console.log('[Orchestrator] Running CLAUDE.md auto-update...');
      const result = await runClaude({
        cwd: tmpDir,
        prompt,
        timeoutMs: CLAUDE_MD_TIMEOUT_MS,
        maxBudgetUsd: CLAUDE_MD_MAX_BUDGET,
      });

      if (result.exitCode !== 0) {
        console.warn(`[Orchestrator] CLAUDE.md update exited with code ${result.exitCode}`);
        return;
      }

      const { execSync } = await import('child_process');
      const diffOutput = execSync('git diff --name-only', { cwd: tmpDir, encoding: 'utf-8' }).trim();

      if (diffOutput.includes('CLAUDE.md')) {
        execSync('git add CLAUDE.md', { cwd: tmpDir });
        execSync('git commit -m "docs: auto-update CLAUDE.md"', { cwd: tmpDir });
        execSync('git push', { cwd: tmpDir });
        console.log('[Orchestrator] CLAUDE.md updated and pushed successfully');
      } else {
        console.log('[Orchestrator] CLAUDE.md unchanged — no update needed');
      }
    } finally {
      const { rm } = await import('fs/promises');
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Called by deploy watcher when a deployment succeeds.
   * Moves card from QA to Done and comments on Trello.
   */
  async confirmDeploy(cardId: string): Promise<boolean> {
    const pending = this.pendingDeploys.get(cardId);
    if (!pending) return false;

    console.log(`[Orchestrator] Deploy confirmed for card ${cardId}. Moving to Done.`);

    await this.trelloApi.moveCard(cardId, this.boardConfig.lists.done).catch((err) => {
      console.error(`[Orchestrator] Failed to move card to Done: ${(err as Error).message}`);
    });

    await this.trelloApi.addComment(cardId,
      `**Deployed to production** :rocket:\n\nTotal pipeline cost: $${pending.totalCostUsd.toFixed(4)}\nTask **Done**.`
    ).catch(() => {});

    this.pendingDeploys.delete(cardId);
    return true;
  }

  /** Get all cards waiting for deploy confirmation */
  getPendingDeploys(): PendingDeploy[] {
    return Array.from(this.pendingDeploys.values());
  }
}
