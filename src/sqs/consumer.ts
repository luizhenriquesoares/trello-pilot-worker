import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  type Message,
} from '@aws-sdk/client-sqs';

const WAIT_TIME_SECONDS = 20;
const MAX_MESSAGES = 1;
const VISIBILITY_TIMEOUT_SECONDS = 900; // 15 minutes — long enough for a pipeline stage

export class SqsConsumer {
  private readonly client: SQSClient;

  constructor(
    private readonly queueUrl: string,
    region: string,
  ) {
    this.client = new SQSClient({ region });
  }

  async poll(): Promise<Message | null> {
    const command = new ReceiveMessageCommand({
      QueueUrl: this.queueUrl,
      WaitTimeSeconds: WAIT_TIME_SECONDS,
      MaxNumberOfMessages: MAX_MESSAGES,
      VisibilityTimeout: VISIBILITY_TIMEOUT_SECONDS,
      MessageAttributeNames: ['All'],
    });

    const response = await this.client.send(command);

    if (!response.Messages || response.Messages.length === 0) {
      return null;
    }

    return response.Messages[0];
  }

  async deleteMessage(receiptHandle: string): Promise<void> {
    const command = new DeleteMessageCommand({
      QueueUrl: this.queueUrl,
      ReceiptHandle: receiptHandle,
    });

    await this.client.send(command);
  }
}
