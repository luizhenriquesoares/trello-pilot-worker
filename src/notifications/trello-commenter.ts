import { TrelloApi } from '../trello/api.js';
import type { PipelineStage } from '../shared/types/pipeline-stage.js';

interface StageCompleteData {
  branchName: string;
  prUrl: string;
  durationMs: number;
  costUsd: number;
  projectName?: string;
}

interface QaCompleteData extends StageCompleteData {
  merged: boolean;
}

interface PipelineSummaryData {
  merged: boolean;
  totalCostUsd: number;
  totalDurationMs: number;
  projectName?: string;
  commitSummary?: string;
  prUrl?: string;
  cardName?: string;
}

interface ComplexityEstimate {
  size: string;
  reasoning: string;
  estimatedMinutes: number;
}

export class TrelloCommenter {
  constructor(private readonly trelloApi: TrelloApi) {}

  async postComplexityEstimate(cardId: string, estimate: ComplexityEstimate): Promise<void> {
    const comment = `**Complexidade: ${estimate.size}** (~${estimate.estimatedMinutes}min) — ${estimate.reasoning}`;
    await this.safeComment(cardId, comment);
  }

  async postImplementComplete(cardId: string, data: StageCompleteData): Promise<void> {
    const durationMin = Math.round(data.durationMs / 60_000);
    const project = data.projectName ? ` [${data.projectName}]` : '';
    const comment = [
      `**Implementacao concluida**${project} (${durationMin}min | $${data.costUsd.toFixed(4)})`,
      data.prUrl ? `PR: ${data.prUrl}` : `Branch: \`${data.branchName}\``,
      'Seguindo para **Code Review**.',
    ].join('\n');

    await this.safeComment(cardId, comment);
  }

  async postReviewStarted(cardId: string, branchName: string, prUrl: string, projectName?: string): Promise<void> {
    const project = projectName ? ` [${projectName}]` : '';
    const comment = [
      `**Code Review iniciado**${project}`,
      prUrl ? `PR: ${prUrl}` : `Branch: \`${branchName}\``,
    ].join('\n');

    await this.safeComment(cardId, comment);
  }

  async postReviewComplete(cardId: string, data: StageCompleteData): Promise<void> {
    const durationMin = Math.round(data.durationMs / 60_000);
    const project = data.projectName ? ` [${data.projectName}]` : '';
    const comment = [
      `**Code Review concluido**${project} (${durationMin}min | $${data.costUsd.toFixed(4)})`,
      'Seguindo para **QA**.',
    ].join('\n');

    await this.safeComment(cardId, comment);
  }

  async postQaStarted(cardId: string, branchName: string, prUrl: string, projectName?: string): Promise<void> {
    const project = projectName ? ` [${projectName}]` : '';
    const comment = [
      `**QA iniciado**${project}`,
      prUrl ? `PR: ${prUrl}` : `Branch: \`${branchName}\``,
    ].join('\n');

    await this.safeComment(cardId, comment);
  }

  async postQaComplete(cardId: string, data: QaCompleteData): Promise<void> {
    const durationMin = Math.round(data.durationMs / 60_000);
    const project = data.projectName ? ` [${data.projectName}]` : '';
    const mergeStatus = data.merged ? 'PR merged para main.' : 'Merge manual necessario.';

    const comment = [
      `**QA concluido**${project} (${durationMin}min | $${data.costUsd.toFixed(4)})`,
      mergeStatus,
      data.merged ? 'Aguardando deploy...' : '',
    ].filter(Boolean).join('\n');

    await this.safeComment(cardId, comment);
  }

  async postDoneSummary(cardId: string, data: PipelineSummaryData): Promise<void> {
    const totalMin = Math.round(data.totalDurationMs / 60_000);
    const project = data.projectName ? ` [${data.projectName}]` : '';

    const lines: string[] = [
      `**Task Concluida**${project}`,
      '',
    ];

    if (data.commitSummary) {
      lines.push('**O que foi feito:**');
      // Parse commit log lines into bullet points
      const commits = data.commitSummary
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 10);
      for (const commit of commits) {
        lines.push(`- ${commit}`);
      }
      lines.push('');
    }

    if (data.prUrl) {
      lines.push(`**PR:** ${data.prUrl}`);
    }
    lines.push(`**Custo:** $${data.totalCostUsd.toFixed(4)} | **Duracao:** ${totalMin}min`);
    lines.push('');
    lines.push('Pipeline automatizado de Todo ate Done.');

    await this.safeComment(cardId, lines.join('\n'));
  }

  async postError(cardId: string, stage: PipelineStage, errorMessage: string, projectName?: string): Promise<void> {
    const project = projectName ? ` [${projectName}]` : '';
    const comment = [
      `**Erro no pipeline**${project} — stage: ${stage}`,
      '',
      '```',
      errorMessage.substring(0, 1000),
      '```',
      '',
      'Pipeline parado. Necessario intervencao manual.',
    ].join('\n');

    await this.safeComment(cardId, comment);
  }

  private async safeComment(cardId: string, text: string): Promise<void> {
    try {
      await this.trelloApi.addComment(cardId, text);
    } catch (err) {
      console.error(`[TrelloCommenter] Failed to comment on card ${cardId}: ${(err as Error).message}`);
    }
  }
}
