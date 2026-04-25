import type { Request, Response } from 'express';
import { SqsProducer } from '../sqs/producer.js';
import { TrelloApi } from '../trello/api.js';
import { verifyTrelloWebhookSignature } from '../trello/webhook-verifier.js';
import { resolveProjectForList, resolveProjectByLabel } from '../config/board-config.js';
import { PipelineStage } from '../shared/types/pipeline-stage.js';
import type { WorkerEvent } from '../shared/types/worker-event.js';
import type { BoardConfig, ProjectList } from '../config/types.js';
import type { TrelloCredentials } from '../trello/types.js';

interface RawBodyRequest extends Request {
  rawBody?: string;
}

interface TrelloWebhookBody {
  action: {
    type: string;
    data: {
      card?: {
        id: string;
        name: string;
        idShort: number;
      };
      list?: {
        id: string;
        name: string;
      };
      listAfter?: {
        id: string;
        name: string;
      };
      listBefore?: {
        id: string;
        name: string;
      };
      board?: {
        id: string;
        name: string;
      };
    };
    display: {
      translationKey: string;
    };
  };
  model: {
    id: string;
  };
}

const CARD_MOVE_ACTION = 'updateCard';
const CREATE_CARD_ACTION = 'createCard';

export class WebhookHandler {
  constructor(
    private readonly sqsProducer: SqsProducer,
    private readonly boardConfig: BoardConfig,
    private readonly trelloCredentials: TrelloCredentials,
    private readonly webhookSecret: string | undefined,
    private readonly callbackUrl: string | undefined,
  ) {}

  /**
   * Handle HEAD request from Trello webhook verification.
   * Trello sends a HEAD request to verify the callback URL exists.
   */
  handleVerification(_req: Request, res: Response): void {
    res.status(200).send();
  }

  /**
   * Handle POST request from Trello webhook.
   * Filters for cards moved/created in project lists, then sends a WorkerEvent to SQS.
   *
   * Responds 200 only AFTER the SQS enqueue succeeds. If SQS fails, returns 5xx
   * so Trello retries the delivery — otherwise the card would silently disappear
   * from the pipeline.
   */
  async handleWebhook(req: Request, res: Response): Promise<void> {
    if (this.webhookSecret) {
      if (!this.callbackUrl) {
        console.error('[Webhook] TRELLO_WEBHOOK_SECRET set but PUBLIC_BASE_URL missing — refusing unverified request');
        res.status(500).json({ error: 'Webhook signature verification misconfigured' });
        return;
      }

      const signature = req.headers['x-trello-webhook'] as string | undefined;
      if (!signature) {
        res.status(401).json({ error: 'Missing webhook signature' });
        return;
      }

      const rawBody = (req as RawBodyRequest).rawBody;
      if (!rawBody) {
        console.error('[Webhook] rawBody missing — express.json verify hook not wired');
        res.status(500).json({ error: 'Webhook signature verification misconfigured' });
        return;
      }

      const isValid = verifyTrelloWebhookSignature(rawBody, this.callbackUrl, this.webhookSecret, signature);
      if (!isValid) {
        res.status(401).json({ error: 'Invalid webhook signature' });
        return;
      }
    }

    try {
      const body = req.body as TrelloWebhookBody;
      const action = body?.action;

      if (!action) {
        res.status(200).json({ received: true, ignored: 'no action' });
        return;
      }

      const actionType = action.type;
      const card = action.data.card;

      if (!card) {
        res.status(200).json({ received: true, ignored: `no card on ${actionType}` });
        return;
      }

      if (actionType === CARD_MOVE_ACTION && action.data.listAfter) {
        const targetListId = action.data.listAfter.id;
        const sourceListId = action.data.listBefore?.id;
        const result = await this.handleCardMoved(card, targetListId, sourceListId, action.data.board?.id);
        res.status(200).json({ received: true, ...result });
        return;
      }

      if (actionType === CREATE_CARD_ACTION && action.data.list) {
        const targetListId = action.data.list.id;
        const result = await this.handleCardCreated(card, targetListId, action.data.board?.id);
        res.status(200).json({ received: true, ...result });
        return;
      }

      const silentActions = ['commentCard', 'updateCheckItemStateOnCard', 'updateCheckItem',
        'addAttachmentToCard', 'deleteComment', 'createCheckItem', 'addChecklistToCard',
        'removeChecklistFromCard', 'deleteAttachmentFromCard'];
      if (!silentActions.includes(actionType)) {
        console.log(`[Webhook] Action ${actionType} not handled, ignoring`);
      }
      res.status(200).json({ received: true, ignored: actionType });
    } catch (err) {
      const msg = (err as Error).message;
      console.error(`[Webhook] Failed to enqueue: ${msg}`);
      // 5xx so Trello reattempts delivery — not losing the card silently
      res.status(503).json({ error: 'Failed to enqueue', detail: msg });
    }
  }

  /**
   * Pick the project for a card. Prefers list-based routing (the historical
   * mechanism) — projects with a dedicated Trello list match on `targetListId`.
   * If the card landed in the configured triage list, fall back to label-based
   * routing: fetch the card's labels and look for one matching a project name.
   * Anything else is ignored.
   */
  private async resolveProject(cardId: string, targetListId: string): Promise<ProjectList | undefined> {
    const direct = resolveProjectForList(this.boardConfig, targetListId);
    if (direct) return direct;

    const triageId = this.boardConfig.triageListId;
    if (!triageId || targetListId !== triageId) return undefined;

    try {
      const trelloApi = new TrelloApi(this.trelloCredentials);
      const fullCard = await trelloApi.getCard(cardId);
      return resolveProjectByLabel(this.boardConfig, fullCard.labels || []);
    } catch (err) {
      console.warn(`[Webhook] Failed to resolve project by label for card ${cardId}: ${(err as Error).message}`);
      return undefined;
    }
  }

  private async handleCardMoved(
    card: { id: string; name: string; idShort: number },
    targetListId: string,
    sourceListId?: string,
    boardId?: string,
  ): Promise<{ enqueued: boolean; messageId?: string; ignored?: string }> {
    const project = await this.resolveProject(card.id, targetListId);
    if (!project) {
      console.log(`[Webhook] Card "${card.name}" moved to non-project list, ignoring`);
      return { enqueued: false, ignored: 'non-project list' };
    }

    const isRetry = sourceListId === this.boardConfig.lists.done;

    let retryFeedback: string | undefined;
    if (isRetry) {
      console.log(`[Webhook] Card "${card.name}" reopened from Done → "${project.name}". Fetching feedback comments.`);
      retryFeedback = await this.fetchRetryFeedback(card.id);
    }

    const modeLabel = isRetry ? 'RETRY' : 'IMPLEMENT';
    console.log(`[Webhook] Card "${card.name}" moved to project "${project.name}". Enqueueing ${modeLabel}.`);

    const event = this.buildWorkerEvent(card.id, boardId, project, isRetry, retryFeedback);
    const messageId = await this.sqsProducer.sendMessage(event);
    console.log(`[Webhook] SQS message sent: ${messageId}`);
    return { enqueued: true, messageId };
  }

  private async handleCardCreated(
    card: { id: string; name: string; idShort: number },
    targetListId: string,
    boardId?: string,
  ): Promise<{ enqueued: boolean; messageId?: string; ignored?: string }> {
    const project = await this.resolveProject(card.id, targetListId);
    if (!project) {
      console.log(`[Webhook] Card "${card.name}" created in non-project list, ignoring`);
      return { enqueued: false, ignored: 'non-project list' };
    }

    console.log(`[Webhook] Card "${card.name}" created in project "${project.name}". Enqueueing IMPLEMENT.`);

    const event = this.buildWorkerEvent(card.id, boardId, project);
    const messageId = await this.sqsProducer.sendMessage(event);
    console.log(`[Webhook] SQS message sent: ${messageId}`);
    return { enqueued: true, messageId };
  }

  private async fetchRetryFeedback(cardId: string): Promise<string | undefined> {
    try {
      const trelloApi = new TrelloApi(this.trelloCredentials);
      const comments = await trelloApi.getCardComments(cardId);

      if (comments.length === 0) {
        return 'No feedback comments found on the card. Review the task description and check what might be wrong.';
      }

      // Take the most recent comments (up to 10) — they likely contain the feedback
      const recentComments = comments.slice(0, 10);
      const formatted = recentComments
        .map((c) => `**${c.author}** (${new Date(c.date).toLocaleString()}):\n${c.text}`)
        .join('\n\n---\n\n');

      return formatted;
    } catch (err) {
      console.error(`[Webhook] Failed to fetch retry feedback: ${(err as Error).message}`);
      return 'Could not fetch feedback comments. Review the card on Trello for stakeholder feedback.';
    }
  }

  private buildWorkerEvent(
    cardId: string,
    boardId: string | undefined,
    project: ProjectList,
    isRetry = false,
    retryFeedback?: string,
  ): WorkerEvent {
    // For mapped projects we anchor the stale-message guard on the project list.
    // For label-routed projects we anchor on the triage list — the worst-case
    // miss (label changed but list didn't) is still better than skipping the
    // guard entirely.
    const originListId = project.id ?? this.boardConfig.triageListId;
    if (!originListId) {
      throw new Error(
        `Cannot build worker event for project "${project.name}": no list id and no triageListId configured`,
      );
    }
    const event: WorkerEvent = {
      cardId,
      boardId: boardId ?? this.boardConfig.boardId,
      stage: PipelineStage.IMPLEMENT,
      repoUrl: project.repoUrl,
      baseBranch: project.baseBranch,
      branchPrefix: project.branchPrefix,
      rules: project.rules ?? this.boardConfig.rules,
      originListId,
      projectName: project.name,
      trelloCredentials: this.trelloCredentials,
    };

    if (isRetry) {
      event.isRetry = true;
      event.retryFeedback = retryFeedback;
    }

    return event;
  }
}
