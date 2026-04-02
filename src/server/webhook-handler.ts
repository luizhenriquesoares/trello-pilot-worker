import type { Request, Response } from 'express';
import { SqsProducer } from '../sqs/producer.js';
import { TrelloApi } from '../trello/api.js';
import { verifyTrelloWebhookSignature } from '../trello/webhook-verifier.js';
import { resolveProjectForList } from '../config/board-config.js';
import { PipelineStage } from '../shared/types/pipeline-stage.js';
import type { WorkerEvent } from '../shared/types/worker-event.js';
import type { BoardConfig } from '../config/types.js';
import type { TrelloCredentials } from '../trello/types.js';

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
   */
  async handleWebhook(req: Request, res: Response): Promise<void> {
    // Verify signature if webhook secret is configured
    if (this.webhookSecret && this.callbackUrl) {
      const signature = req.headers['x-trello-webhook'] as string | undefined;
      if (!signature) {
        res.status(401).json({ error: 'Missing webhook signature' });
        return;
      }

      const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      const isValid = verifyTrelloWebhookSignature(rawBody, this.callbackUrl, this.webhookSecret, signature);
      if (!isValid) {
        res.status(401).json({ error: 'Invalid webhook signature' });
        return;
      }
    }

    // Respond immediately to avoid Trello timeout
    res.status(200).json({ received: true });

    try {
      const body = req.body as TrelloWebhookBody;
      const action = body?.action;

      if (!action) {
        console.log('[Webhook] No action in body, ignoring');
        return;
      }

      const actionType = action.type;
      const card = action.data.card;

      if (!card) {
        console.log(`[Webhook] Action ${actionType} has no card data, ignoring`);
        return;
      }

      // Handle card moved to a project list (Todo list)
      if (actionType === CARD_MOVE_ACTION && action.data.listAfter) {
        const targetListId = action.data.listAfter.id;
        const sourceListId = action.data.listBefore?.id;
        await this.handleCardMoved(card, targetListId, sourceListId, action.data.board?.id);
        return;
      }

      // Handle card created in a project list
      if (actionType === CREATE_CARD_ACTION && action.data.list) {
        const targetListId = action.data.list.id;
        await this.handleCardCreated(card, targetListId, action.data.board?.id);
        return;
      }

      console.log(`[Webhook] Action ${actionType} not handled, ignoring`);
    } catch (err) {
      console.error(`[Webhook] Error processing webhook: ${(err as Error).message}`);
    }
  }

  private async handleCardMoved(
    card: { id: string; name: string; idShort: number },
    targetListId: string,
    sourceListId?: string,
    boardId?: string,
  ): Promise<void> {
    const project = resolveProjectForList(this.boardConfig, targetListId);
    if (!project) {
      console.log(`[Webhook] Card "${card.name}" moved to non-project list, ignoring`);
      return;
    }

    // Detect reopen: card moved FROM Done back to a project list
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
  }

  private async handleCardCreated(
    card: { id: string; name: string; idShort: number },
    targetListId: string,
    boardId?: string,
  ): Promise<void> {
    const project = resolveProjectForList(this.boardConfig, targetListId);
    if (!project) {
      console.log(`[Webhook] Card "${card.name}" created in non-project list, ignoring`);
      return;
    }

    console.log(`[Webhook] Card "${card.name}" created in project "${project.name}". Enqueueing IMPLEMENT.`);

    const event = this.buildWorkerEvent(card.id, boardId, project);
    const messageId = await this.sqsProducer.sendMessage(event);
    console.log(`[Webhook] SQS message sent: ${messageId}`);
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
    project: { id: string; name: string; repoUrl: string; baseBranch: string; branchPrefix: string; rules?: string[] },
    isRetry = false,
    retryFeedback?: string,
  ): WorkerEvent {
    const event: WorkerEvent = {
      cardId,
      boardId: boardId ?? this.boardConfig.boardId,
      stage: PipelineStage.IMPLEMENT,
      repoUrl: project.repoUrl,
      baseBranch: project.baseBranch,
      branchPrefix: project.branchPrefix,
      rules: project.rules ?? this.boardConfig.rules,
      originListId: project.id,
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
