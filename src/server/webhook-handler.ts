import type { Request, Response } from 'express';
import { SqsProducer } from '../sqs/producer.js';
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
        await this.handleCardMoved(card, targetListId, action.data.board?.id);
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
    boardId?: string,
  ): Promise<void> {
    const project = resolveProjectForList(this.boardConfig, targetListId);
    if (!project) {
      console.log(`[Webhook] Card "${card.name}" moved to non-project list, ignoring`);
      return;
    }

    console.log(`[Webhook] Card "${card.name}" moved to project "${project.name}". Enqueueing IMPLEMENT.`);

    const event = this.buildWorkerEvent(card.id, boardId, project);
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

  private buildWorkerEvent(
    cardId: string,
    boardId: string | undefined,
    project: { id: string; name: string; repoUrl: string; baseBranch: string; branchPrefix: string; rules?: string[] },
  ): WorkerEvent {
    return {
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
  }
}
