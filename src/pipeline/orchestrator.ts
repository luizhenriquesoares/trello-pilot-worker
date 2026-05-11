import { ImplementStage } from './stages/implement.js';
import { ReviewStage, type ReviewContext } from './stages/review.js';
import { QaStage, type QaContext } from './stages/qa.js';
import { SqsProducer, type PipelineContext, type SqsMessageEnvelope } from '../sqs/producer.js';
import { TrelloApi } from '../trello/api.js';
import { TrelloCommenter } from '../notifications/trello-commenter.js';
import { SlackNotifier } from '../notifications/slack.js';
import { JobTracker } from '../tracking/job-tracker.js';
import { StreamBroadcaster } from '../server/websocket.js';
import { runClaude } from '../claude/headless-runner.js';
import { PipelineStage } from '../shared/types/pipeline-stage.js';
import { validateWorkerEvent, type WorkerEvent } from '../shared/types/worker-event.js';
import { PermanentError } from '../shared/errors.js';
import type { BoardConfig } from '../config/types.js';

// The full IMPLEMENT → REVIEW → QA pipeline runs inline inside handleImplement
// (no SQS handoff between stages). REVIEW and QA only ever come back to the
// queue if external code re-enqueues them, which the worker no longer does —
// so we treat any REVIEW/QA event as a stale message from a previous deploy
// and reject it as permanent so the SQS DLQ catches it instead of looping.

// Lock auto-expires past this point. Slightly larger than STAGE_TIMEOUT_MS
// (60min) so the in-pipeline timeout always fires first under normal flow;
// TTL is the safety net for orphaned locks (process killed mid-run before
// the finally block, etc.) so other cards on the same repo eventually unblock.
const LOCK_TTL_MS = 65 * 60 * 1000;

interface RepoLock {
  cardId: string;
  acquiredAt: number;
}

export class PipelineOrchestrator {
  private readonly repoLocks = new Map<string, RepoLock>(); // repoUrl → lock

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
  ) {}

  async processEvent(event: WorkerEvent, pipelineContext?: PipelineContext): Promise<void> {
    const validationErrors = validateWorkerEvent(event);
    if (validationErrors.length > 0) {
      // Permanent: a malformed event will never become valid on retry.
      throw new PermanentError(`Malformed worker event: ${validationErrors.join('; ')}`);
    }

    // The pipeline only runs from IMPLEMENT — REVIEW/QA are inline within it.
    // Anything else is a stale message from before the inline refactor.
    if (event.stage !== PipelineStage.IMPLEMENT) {
      throw new PermanentError(
        `Stage "${event.stage}" is no longer enqueued — pipeline runs inline from IMPLEMENT. Drop this stale message.`,
      );
    }

    // Repo lock: prevent concurrent tasks on the same repository
    const lockHolder = this.repoLocks.get(event.repoUrl);
    if (lockHolder && lockHolder.cardId !== event.cardId) {
      const heldFor = Date.now() - lockHolder.acquiredAt;
      if (heldFor > LOCK_TTL_MS) {
        // Stale lock: holder card never released (process killed mid-pipeline,
        // STAGE_TIMEOUT didn't fire, etc.). Steal it so this repo isn't blocked forever.
        console.warn(
          `[Orchestrator] Repo ${event.repoUrl} lock held by card ${lockHolder.cardId} ` +
          `for ${Math.round(heldFor / 60_000)}min (> ${LOCK_TTL_MS / 60_000}min TTL). ` +
          `Treating as stale and reassigning to card ${event.cardId}.`,
        );
        // fall through to acquire below
      } else {
        console.log(
          `[Orchestrator] Repo ${event.repoUrl} is locked by card ${lockHolder.cardId}. ` +
          `Re-enqueueing card ${event.cardId} with 60s delay.`,
        );
        const envelope: SqsMessageEnvelope = { event, pipelineContext };
        await this.sqsProducer.sendWithDelay(envelope, 60);
        return;
      }
    }

    // Acquire repo lock
    this.repoLocks.set(event.repoUrl, { cardId: event.cardId, acquiredAt: Date.now() });
    console.log(`[Orchestrator] Acquired repo lock for ${event.repoUrl} (card ${event.cardId})`);

    const stageName = 'implement';
    const projectName = event.projectName || 'Unknown';

    // Fetch card name for tracking
    let cardName = pipelineContext?.cardName || event.cardId;
    try {
      const card = await this.trelloApi.getCard(event.cardId);
      cardName = card.name;
    } catch { /* use fallback */ }

    const retryLabel = event.isRetry ? ' (RETRY)' : '';
    console.log(`[Orchestrator] Processing ${stageName}${retryLabel} for: ${cardName} [${projectName}]`);

    // Stale guard: verify the card is still in the expected origin list before
    // we kick off the (expensive) Claude pipeline. Catches users who moved the
    // card between project lists between webhook fire and SQS drain.
    if (event.originListId) {
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
      // 60 min — covers the full inline pipeline (IMPLEMENT + REVIEW + QA).
      const STAGE_TIMEOUT_MS = 60 * 60 * 1000;
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Pipeline timed out after ${STAGE_TIMEOUT_MS / 60_000}min`)), STAGE_TIMEOUT_MS),
      );

      await Promise.race([this.handleImplement(event, cardName, onEvent), timeoutPromise]);

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

      // Re-throw so the SQS poll loop can decide to retry vs delete based on
      // the error type (PermanentError → delete, anything else → keep for redelivery).
      throw err;
    } finally {
      // Release repo lock
      if (this.repoLocks.get(event.repoUrl)?.cardId === event.cardId) {
        this.repoLocks.delete(event.repoUrl);
        console.log(`[Orchestrator] Released repo lock for ${event.repoUrl} (card ${event.cardId})`);
      }

      // Inline pipeline cleans up its own workDir in handleImplement's finally,
      // so there's nothing additional to remove here.
      void pipelineContext;
    }
  }

  /**
   * Snapshot of all currently held repo locks.
   * Used by GET /api/admin/locks to surface stuck cards in ops UI.
   */
  listRepoLocks(): Array<{ repoUrl: string; cardId: string; acquiredAt: string; heldForMs: number }> {
    const now = Date.now();
    return Array.from(this.repoLocks.entries()).map(([repoUrl, lock]) => ({
      repoUrl,
      cardId: lock.cardId,
      acquiredAt: new Date(lock.acquiredAt).toISOString(),
      heldForMs: now - lock.acquiredAt,
    }));
  }

  /**
   * Force-release a repo lock. Returns the prior holder cardId if a lock existed.
   * Used by POST /api/admin/release-lock to unstick orphaned locks without restart.
   */
  releaseRepoLock(repoUrl: string): { released: boolean; previousCardId?: string } {
    const existing = this.repoLocks.get(repoUrl);
    if (!existing) return { released: false };
    this.repoLocks.delete(repoUrl);
    console.warn(
      `[Orchestrator] Manually released repo lock for ${repoUrl} ` +
      `(was held by card ${existing.cardId})`,
    );
    return { released: true, previousCardId: existing.cardId };
  }

  /**
   * Full pipeline: IMPLEMENT → REVIEW → QA inline (no SQS between stages).
   * Eliminates 2 SQS roundtrips + 2 cold starts = ~30-60s saved.
   */
  private async handleImplement(
    event: WorkerEvent,
    cardName: string,
    onEvent?: (e: import('../claude/headless-runner.js').ClaudeStreamEvent) => void,
  ): Promise<void> {
    const pipelineStart = Date.now();

    // === IMPLEMENT ===
    await this.trelloApi.moveCard(event.cardId, this.boardConfig.lists.doing);
    const implResult = await this.implementStage.execute(event, onEvent);

    try {
      return await this.runInlineReviewAndQa(event, cardName, implResult, pipelineStart);
    } finally {
      // Always clean up inline work directory once IMPLEMENT has produced one,
      // regardless of whether REVIEW/QA succeeded. Prevents /tmp exhaustion that
      // caused "cannot fork()" errors on subsequent git clones.
      if (implResult.workDir) {
        try {
          const { rm } = await import('fs/promises');
          await rm(implResult.workDir, { recursive: true, force: true });
          console.log(`[Orchestrator] Cleaned up inline workDir: ${implResult.workDir}`);
        } catch (cleanupErr) {
          console.warn(`[Orchestrator] Failed to clean up workDir ${implResult.workDir}: ${(cleanupErr as Error).message}`);
        }
      }
    }
  }

  private async runInlineReviewAndQa(
    event: WorkerEvent,
    cardName: string,
    implResult: Awaited<ReturnType<ImplementStage['execute']>>,
    pipelineStart: number,
  ): Promise<void> {
    // Guard: if IMPLEMENT produced no commits, there is literally nothing for
    // REVIEW or QA to act on (`git diff main...HEAD` is empty, Claude exits 1
    // ~30s in with "refusing to advance to QA"). Stop here with a clear signal
    // so a human can decide whether to retry, refine the card, or close it.
    if (!implResult.commitSummary.trim()) {
      throw new PermanentError(
        `Implement produced no commits on branch "${implResult.branchName}" — ` +
        'card may already be done, or the prompt was too vague for Claude to act on. ' +
        'Halting before REVIEW.',
      );
    }

    // === REVIEW (inline) ===
    await this.trelloApi.moveCard(event.cardId, this.boardConfig.lists.review);
    console.log(`[Orchestrator] Running inline REVIEW for card ${event.cardId}`);

    const reviewContext: ReviewContext = {
      branchName: implResult.branchName,
      prUrl: implResult.prUrl,
      workDir: implResult.workDir,
    };
    const reviewResult = await this.reviewStage.execute(event, reviewContext);

    // === QA (inline) ===
    await this.trelloApi.moveCard(event.cardId, this.boardConfig.lists.qa);
    console.log(`[Orchestrator] Running inline QA for card ${event.cardId}`);

    const qaContext: QaContext = {
      branchName: reviewResult.branchName,
      prUrl: reviewResult.prUrl,
      workDir: reviewResult.workDir,
    };
    const qaResult = await this.qaStage.execute(event, qaContext);

    // === POST-QA ===
    const totalCost = implResult.costUsd + reviewResult.costUsd + qaResult.costUsd;
    const totalDurationMs = Date.now() - pipelineStart;
    const projectName = event.projectName || 'Unknown';

    // Don't promote a card to Done when QA didn't merge — leave it in the QA
    // list with the failure comment posted by the QA stage so a human can
    // intervene. Without this guard the deploy watcher would move it to Done
    // after the 15min timeout (with a misleading "merged" message), or the
    // no-watcher fallback would promote immediately.
    if (!qaResult.merged) {
      console.warn(
        `[Orchestrator] QA did not merge for card ${event.cardId} — card stays in QA list, no Done promotion`,
      );
      this.slackNotifier.notifyError(
        cardName,
        event.stage,
        'QA failed or PR merge was blocked — card left in QA for review',
        projectName,
      ).catch(() => {});
      console.log(`[Orchestrator] Pipeline halted at QA for card ${event.cardId}. Cost: $${totalCost.toFixed(4)}. Duration: ${Math.round(totalDurationMs / 1000)}s`);
      return;
    }

    // Mark all checklist items as complete
    await this.markChecklistsComplete(event.cardId).catch((err) => {
      console.warn(`[Orchestrator] Failed to mark checklists: ${(err as Error).message}`);
    });

    // Auto-update CLAUDE.md
    if (implResult.workDir) {
      await this.autoUpdateClaudeMd(implResult.workDir, event.repoUrl).catch((err) => {
        console.warn(`[Orchestrator] CLAUDE.md auto-update failed (non-blocking): ${(err as Error).message}`);
      });
    }

    // Move card to Done. Hostinger CI/CD picks up the merged commit and deploys
    // automatically — no API to verify the deploy itself, and waiting on a poll
    // would just delay the card without adding signal.
    await this.trelloApi.moveCard(event.cardId, this.boardConfig.lists.done).catch((err) => {
      console.error(`[Orchestrator] Failed to move card to Done: ${(err as Error).message}`);
    });

    await this.commenter.postDoneSummary(event.cardId, {
      merged: qaResult.merged,
      totalCostUsd: totalCost,
      totalDurationMs,
      projectName,
      commitSummary: implResult.commitSummary,
      prUrl: implResult.prUrl,
      cardName,
    });

    this.slackNotifier.notifyComplete(
      cardName, qaResult.merged, totalCost, projectName, implResult.commitSummary, implResult.prUrl,
    ).catch(() => {});

    console.log(`[Orchestrator] Pipeline complete for card ${event.cardId}. Merged: ${qaResult.merged}. Cost: $${totalCost.toFixed(4)}. Duration: ${Math.round(totalDurationMs / 1000)}s`);
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
}
