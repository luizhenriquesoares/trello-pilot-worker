import type { PipelineStage } from '../shared/types/pipeline-stage.js';

const SLACK_TIMEOUT_MS = 5000;

export class SlackNotifier {
  constructor(private readonly webhookUrl: string | undefined) {}

  async notifyError(cardId: string, stage: PipelineStage, errorMessage: string): Promise<void> {
    if (!this.webhookUrl) return;

    const payload = {
      text: ':x: *Pipeline Error*',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: [
              ':x: *Pipeline Error*',
              `*Stage:* ${stage}`,
              `*Card:* ${cardId}`,
              `*Error:* ${errorMessage.substring(0, 500)}`,
            ].join('\n'),
          },
        },
      ],
    };

    await this.post(payload);
  }

  async notifyComplete(cardId: string, merged: boolean, totalCostUsd: number): Promise<void> {
    if (!this.webhookUrl) return;

    const emoji = merged ? ':white_check_mark:' : ':warning:';
    const status = merged ? 'PR Merged' : 'Completed (merge pending)';

    const payload = {
      text: `${emoji} Pipeline complete for ${cardId}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: [
              `${emoji} *Pipeline Complete*`,
              `*Card:* ${cardId}`,
              `*Status:* ${status}`,
              `*Total Cost:* $${totalCostUsd.toFixed(4)}`,
            ].join('\n'),
          },
        },
      ],
    };

    await this.post(payload);
  }

  async notifyStageStart(cardId: string, stage: PipelineStage): Promise<void> {
    if (!this.webhookUrl) return;

    const payload = {
      text: `:gear: Starting ${stage} for card ${cardId}`,
    };

    await this.post(payload);
  }

  private async post(payload: Record<string, unknown>): Promise<void> {
    if (!this.webhookUrl) return;

    try {
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
      });

      if (!response.ok) {
        console.warn(`[Slack] Webhook returned ${response.status}: ${await response.text()}`);
      }
    } catch (err) {
      console.warn(`[Slack] Failed to send notification: ${(err as Error).message}`);
    }
  }
}
