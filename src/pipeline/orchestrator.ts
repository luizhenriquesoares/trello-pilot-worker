import { ImplementStage } from './stages/implement.js';
import { ReviewStage, type ReviewContext } from './stages/review.js';
import { QaStage, type QaContext } from './stages/qa.js';
import { SqsProducer, type PipelineContext } from '../sqs/producer.js';
import { TrelloApi } from '../trello/api.js';
import { TrelloCommenter } from '../notifications/trello-commenter.js';
import { SlackNotifier } from '../notifications/slack.js';
import { JobTracker } from '../tracking/job-tracker.js';
import { StreamBroadcaster } from '../server/websocket.js';
import { PipelineStage } from '../shared/types/pipeline-stage.js';
import type { WorkerEvent } from '../shared/types/worker-event.js';
import type { BoardConfig } from '../config/types.js';

const NEXT_STAGE_MAP: Record<PipelineStage, PipelineStage | null> = {
  [PipelineStage.IMPLEMENT]: PipelineStage.REVIEW,
  [PipelineStage.REVIEW]: PipelineStage.QA,
  [PipelineStage.QA]: null,
};

export class PipelineOrchestrator {
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
    const stageMap: Record<PipelineStage, 'implement' | 'review' | 'qa'> = {
      [PipelineStage.IMPLEMENT]: 'implement',
      [PipelineStage.REVIEW]: 'review',
      [PipelineStage.QA]: 'qa',
    };

    const stageName = stageMap[event.stage];

    // Fetch card name for tracking
    let cardName = event.cardId;
    try {
      const card = await this.trelloApi.getCard(event.cardId);
      cardName = card.name;
    } catch { /* use cardId as fallback */ }

    console.log(`[Orchestrator] Processing ${stageName} for: ${cardName}`);

    // Track job start
    const jobId = this.jobTracker?.start(event.cardId, cardName, event.projectName || 'Unknown', stageName);
    this.broadcaster?.notifyJobStart(event.cardId, cardName, stageName);

    // Create stream handler for real-time updates
    const onEvent = this.broadcaster?.createStreamHandler(event.cardId, cardName, stageName);

    try {
      switch (event.stage) {
        case PipelineStage.IMPLEMENT:
          await this.handleImplement(event, onEvent);
          break;
        case PipelineStage.REVIEW:
          await this.handleReview(event, pipelineContext, onEvent);
          break;
        case PipelineStage.QA:
          await this.handleQa(event, pipelineContext, onEvent);
          break;
        default: {
          const exhaustiveCheck: never = event.stage;
          throw new Error(`Unknown pipeline stage: ${exhaustiveCheck}`);
        }
      }

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

      await this.commenter.postError(event.cardId, event.stage, errorMessage).catch((commentErr) => {
        console.error(`[Orchestrator] Failed to post error comment: ${(commentErr as Error).message}`);
      });

      await this.slackNotifier.notifyError(event.cardId, event.stage, errorMessage).catch(() => {});
    }
  }

  private async handleImplement(event: WorkerEvent, onEvent?: (e: import('../claude/headless-runner.js').ClaudeStreamEvent) => void): Promise<void> {
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
      };

      await this.sqsProducer.sendWithContext(nextEvent, context);
      console.log(`[Orchestrator] Enqueued ${nextStage} stage for card ${event.cardId}`);
    }
  }

  private async handleReview(event: WorkerEvent, context?: PipelineContext): Promise<void> {
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

    // Enqueue next stage (qa)
    const nextStage = NEXT_STAGE_MAP[PipelineStage.REVIEW];
    if (nextStage) {
      const nextEvent: WorkerEvent = { ...event, stage: nextStage };
      const nextContext: PipelineContext = {
        branchName: result.branchName,
        prUrl: result.prUrl,
        workDir: result.workDir,
        cumulativeCostUsd: context.cumulativeCostUsd + result.costUsd,
      };

      await this.sqsProducer.sendWithContext(nextEvent, nextContext);
      console.log(`[Orchestrator] Enqueued ${nextStage} stage for card ${event.cardId}`);
    }
  }

  private async handleQa(event: WorkerEvent, context?: PipelineContext): Promise<void> {
    if (!context) {
      throw new Error('QA stage requires pipeline context (branchName, workDir) from review stage');
    }

    const qaContext: QaContext = {
      branchName: context.branchName,
      prUrl: context.prUrl,
      workDir: context.workDir,
    };

    const result = await this.qaStage.execute(event, qaContext);

    // Always move card to done after QA completes (even if merge failed)
    await this.trelloApi.moveCard(event.cardId, this.boardConfig.lists.done).catch((err) => {
      console.error(`[Orchestrator] Failed to move card to Done: ${(err as Error).message}`);
    });

    const totalCost = context.cumulativeCostUsd + result.costUsd;

    // Post final cost summary to Trello
    await this.commenter.postPipelineSummary(event.cardId, {
      merged: result.merged,
      totalCostUsd: totalCost,
      totalDurationMs: result.durationMs,
    }).catch((err) => {
      console.error(`[Orchestrator] Failed to post summary: ${(err as Error).message}`);
    });

    // Notify Slack of completion
    await this.slackNotifier.notifyComplete(event.cardId, result.merged, totalCost).catch(() => {
      // Best-effort
    });

    console.log(`[Orchestrator] Pipeline complete for card ${event.cardId}. Merged: ${result.merged}. Total cost: $${totalCost.toFixed(4)}`);
  }
}
