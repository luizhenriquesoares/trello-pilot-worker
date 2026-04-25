import {
  SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import type { WorkerEvent } from '../shared/types/worker-event.js';

export interface SqsMessageEnvelope {
  event: WorkerEvent;
  pipelineContext?: PipelineContext;
}

export interface PipelineContext {
  branchName: string;
  prUrl: string;
  workDir: string;
  cumulativeCostUsd: number;
  cardName?: string;
  projectName?: string;
  commitSummary?: string;
}

export class SqsProducer {
  private readonly client: SQSClient;

  constructor(
    private readonly queueUrl: string,
    region: string,
  ) {
    this.client = new SQSClient({ region });
  }

  /**
   * Send a WorkerEvent. Used by the webhook handler when a Trello card lands
   * on a project (or triage) list to kick off the IMPLEMENT pipeline.
   */
  async sendMessage(event: WorkerEvent): Promise<string> {
    return this.sendEnvelope({ event });
  }

  /**
   * Re-enqueue a message with a delay (seconds). Used for repo lock contention
   * — the orchestrator pushes the same envelope back when another card is
   * already running on the same repo.
   */
  async sendWithDelay(envelope: SqsMessageEnvelope, delaySeconds: number): Promise<string> {
    return this.sendEnvelope(envelope, delaySeconds);
  }

  private async sendEnvelope(envelope: SqsMessageEnvelope, delaySeconds?: number): Promise<string> {
    const command = new SendMessageCommand({
      QueueUrl: this.queueUrl,
      MessageBody: JSON.stringify(envelope),
      DelaySeconds: delaySeconds,
      MessageAttributes: {
        stage: {
          DataType: 'String',
          StringValue: envelope.event.stage,
        },
        cardId: {
          DataType: 'String',
          StringValue: envelope.event.cardId,
        },
      },
    });

    const response = await this.client.send(command);

    if (!response.MessageId) {
      throw new Error('SQS SendMessage returned no MessageId');
    }

    return response.MessageId;
  }
}

/**
 * Parse an SQS message body into event + optional pipeline context.
 * Supports both envelope format (stage handoff) and direct event format (first trigger).
 */
export function parseSqsMessage(body: string): SqsMessageEnvelope {
  const parsed = JSON.parse(body);

  // Envelope format: { event, pipelineContext }
  if (parsed.event !== undefined) {
    return {
      event: parsed.event as WorkerEvent,
      pipelineContext: parsed.pipelineContext as PipelineContext | undefined,
    };
  }

  // Direct event format (backward compat, webhook trigger)
  return {
    event: parsed as WorkerEvent,
  };
}
