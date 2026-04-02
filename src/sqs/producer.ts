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
   * Send a WorkerEvent without pipeline context (first stage trigger).
   */
  async sendMessage(event: WorkerEvent): Promise<string> {
    return this.sendEnvelope({ event });
  }

  /**
   * Send a WorkerEvent with pipeline context (stage-to-stage handoff).
   */
  async sendWithContext(event: WorkerEvent, context: PipelineContext): Promise<string> {
    return this.sendEnvelope({ event, pipelineContext: context });
  }

  /**
   * Re-enqueue a message with a delay (seconds). Used for repo lock contention.
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
