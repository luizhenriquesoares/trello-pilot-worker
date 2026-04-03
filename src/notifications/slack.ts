import type { PipelineStage } from '../shared/types/pipeline-stage.js';

const SLACK_TIMEOUT_MS = 5000;

export class SlackNotifier {
  constructor(private readonly webhookUrl: string | undefined) {}

  async notifyError(cardName: string, stage: PipelineStage, errorMessage: string, projectName?: string): Promise<void> {
    if (!this.webhookUrl) return;

    const project = projectName ? ` [${projectName}]` : '';
    const payload = {
      text: `:x: *Erro no pipeline*${project} — ${cardName}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: [
              `:x: *Erro no pipeline*${project}`,
              `*Task:* ${cardName}`,
              `*Stage:* ${stage}`,
              `*Erro:* ${errorMessage.substring(0, 500)}`,
            ].join('\n'),
          },
        },
      ],
    };

    await this.post(payload);
  }

  async notifyComplete(
    cardName: string,
    merged: boolean,
    totalCostUsd: number,
    projectName?: string,
    commitSummary?: string,
    prUrl?: string,
  ): Promise<void> {
    if (!this.webhookUrl) return;

    const project = projectName ? ` [${projectName}]` : '';
    const emoji = merged ? ':white_check_mark:' : ':warning:';
    const status = merged ? 'PR Merged' : 'Merge pendente';

    const textLines = [
      `${emoji} *Task Concluida*${project}`,
      `*Task:* ${cardName}`,
      `*Status:* ${status}`,
    ];

    if (commitSummary) {
      const commits = commitSummary
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 5);
      textLines.push(`*O que foi feito:*`);
      for (const c of commits) {
        textLines.push(`> ${c}`);
      }
    }

    if (prUrl) {
      textLines.push(`*PR:* ${prUrl}`);
    }
    textLines.push(`*Custo:* $${totalCostUsd.toFixed(4)}`);

    const payload = {
      text: `${emoji} Task Concluida${project} — ${cardName}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: textLines.join('\n'),
          },
        },
      ],
    };

    await this.post(payload);
  }

  async notifyStageStart(cardName: string, stage: PipelineStage, projectName?: string): Promise<void> {
    if (!this.webhookUrl) return;

    const project = projectName ? ` [${projectName}]` : '';
    const payload = {
      text: `:gear: ${stage}${project} — ${cardName}`,
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
