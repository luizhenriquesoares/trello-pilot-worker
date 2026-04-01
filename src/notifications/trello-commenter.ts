import { TrelloApi } from '../trello/api.js';
import type { PipelineStage } from '../shared/types/pipeline-stage.js';

interface StageCompleteData {
  branchName: string;
  prUrl: string;
  durationMs: number;
  costUsd: number;
}

interface QaCompleteData extends StageCompleteData {
  merged: boolean;
}

interface PipelineSummaryData {
  merged: boolean;
  totalCostUsd: number;
  totalDurationMs: number;
}

interface ComplexityEstimate {
  size: string;
  reasoning: string;
  estimatedMinutes: number;
}

export class TrelloCommenter {
  constructor(private readonly trelloApi: TrelloApi) {}

  async postComplexityEstimate(cardId: string, estimate: ComplexityEstimate): Promise<void> {
    const comment = [
      `**Complexity Estimate: ${estimate.size}** (~${estimate.estimatedMinutes}min)`,
      estimate.reasoning,
    ].join('\n');

    await this.safeComment(cardId, comment);
  }

  async postImplementComplete(cardId: string, data: StageCompleteData): Promise<void> {
    const durationMin = Math.round(data.durationMs / 60_000);
    const comment = [
      `**Implementation complete** (${durationMin}min | $${data.costUsd.toFixed(4)})`,
      '',
      `Branch: \`${data.branchName}\``,
      data.prUrl ? `PR: ${data.prUrl}` : '',
      '',
      'Moving to **Review** for code analysis.',
    ].filter(Boolean).join('\n');

    await this.safeComment(cardId, comment);
  }

  async postReviewStarted(cardId: string, branchName: string, prUrl: string): Promise<void> {
    const comment = [
      '**Code Review started**',
      '',
      `Branch: \`${branchName}\``,
      prUrl ? `PR: ${prUrl}` : '',
      '',
      'Analyzing code changes for bugs, security, and project rules compliance...',
    ].filter(Boolean).join('\n');

    await this.safeComment(cardId, comment);
  }

  async postReviewComplete(cardId: string, data: StageCompleteData): Promise<void> {
    const durationMin = Math.round(data.durationMs / 60_000);
    const comment = [
      `**Code Review complete** (${durationMin}min | $${data.costUsd.toFixed(4)})`,
      '',
      `Branch: \`${data.branchName}\``,
      'Reviewed for: bugs, security, SOLID, typing, project rules.',
      'Any fixes were committed and pushed.',
      data.prUrl ? `PR: ${data.prUrl}` : '',
      '',
      'Moving to **QA** for testing and validation.',
    ].filter(Boolean).join('\n');

    await this.safeComment(cardId, comment);
  }

  async postQaStarted(cardId: string, branchName: string, prUrl: string): Promise<void> {
    const comment = [
      '**QA started**',
      '',
      `Branch: \`${branchName}\``,
      prUrl ? `PR: ${prUrl}` : '',
      '',
      'Running type checks, tests, lint, and validating implementation against requirements...',
    ].filter(Boolean).join('\n');

    await this.safeComment(cardId, comment);
  }

  async postQaComplete(cardId: string, data: QaCompleteData): Promise<void> {
    const durationMin = Math.round(data.durationMs / 60_000);
    const mergeStatus = data.merged
      ? 'PR merged to main via squash merge.'
      : 'Changes pushed. Manual merge may be needed.';

    const comment = [
      `**QA complete** (${durationMin}min | $${data.costUsd.toFixed(4)})`,
      '',
      mergeStatus,
      data.prUrl ? `PR: ${data.prUrl}` : '',
      '',
      data.merged ? 'Task **Done**.' : 'Review merge status manually.',
    ].filter(Boolean).join('\n');

    await this.safeComment(cardId, comment);
  }

  async postPipelineSummary(cardId: string, data: PipelineSummaryData): Promise<void> {
    const totalMin = Math.round(data.totalDurationMs / 60_000);
    const status = data.merged ? 'Merged' : 'Completed (merge pending)';

    const comment = [
      '**Pipeline Summary**',
      '',
      `- Status: ${status}`,
      `- Total Cost: $${data.totalCostUsd.toFixed(4)}`,
      `- Total Duration: ${totalMin}min`,
      '',
      'Task fully automated from Todo to Done.',
    ].join('\n');

    await this.safeComment(cardId, comment);
  }

  async postError(cardId: string, stage: PipelineStage, errorMessage: string): Promise<void> {
    const comment = [
      `**Pipeline Error** at stage: ${stage}`,
      '',
      '```',
      errorMessage.substring(0, 1000),
      '```',
      '',
      'Pipeline halted. Manual intervention required.',
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
