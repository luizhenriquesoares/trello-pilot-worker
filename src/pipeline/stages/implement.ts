import { RepoManager } from '../../git/repo-manager.js';
import { TrelloApi } from '../../trello/api.js';
import { PromptBuilder } from '../../claude/prompt-builder.js';
import { runClaude } from '../../claude/headless-runner.js';
import { KnowledgeManager } from '../../claude/knowledge.js';
import { TrelloCommenter } from '../../notifications/trello-commenter.js';
import type { WorkerEvent } from '../../shared/types/worker-event.js';
import type { TrelloCard } from '../../trello/types.js';

const WORK_DIR_PREFIX = '/tmp/trello-pilot';

export interface ImplementResult {
  branchName: string;
  prUrl: string;
  workDir: string;
  costUsd: number;
  durationMs: number;
}

export class ImplementStage {
  private readonly promptBuilder: PromptBuilder;
  private readonly knowledgeMgr: KnowledgeManager;

  constructor(
    private readonly repoManager: RepoManager,
    private readonly trelloApi: TrelloApi,
    private readonly commenter: TrelloCommenter,
  ) {
    this.promptBuilder = new PromptBuilder();
    this.knowledgeMgr = new KnowledgeManager();
  }

  async execute(event: WorkerEvent): Promise<ImplementResult> {
    const startTime = Date.now();

    const card = await this.fetchFullCard(event.cardId);
    const { repoUrl, baseBranch, branchPrefix, rules } = event;

    if (rules.length > 0) {
      this.promptBuilder.setRules(rules);
    }

    // Clone repo to temp directory
    const workDir = `${WORK_DIR_PREFIX}-${event.cardId}-${Date.now()}`;
    console.log(`[Implement] Cloning ${repoUrl} to ${workDir}`);
    await this.repoManager.clone(repoUrl, workDir, baseBranch);

    // Create feature branch
    const branchName = this.promptBuilder.buildBranchName(card, branchPrefix);
    console.log(`[Implement] Creating branch: ${branchName}`);
    await this.repoManager.createBranch(workDir, branchName);

    // Load or generate project knowledge
    await this.ensureKnowledge(workDir);

    // Run complexity estimation (optional, non-blocking)
    const estimate = await this.estimateComplexity(card, workDir);
    if (estimate) {
      console.log(`[Implement] Complexity: ${estimate.size} (~${estimate.estimatedMinutes}min)`);
      await this.commenter.postComplexityEstimate(card.id, estimate);
    }

    // Build prompt and run claude headless
    const prompt = this.promptBuilder.build(card);
    console.log(`[Implement] Running Claude headless for card: ${card.name}`);

    const runResult = await runClaude({
      cwd: workDir,
      prompt,
    });

    const costUsd = runResult.costUsd ?? 0;

    if (runResult.exitCode !== 0) {
      console.warn(`[Implement] Claude exited with code ${runResult.exitCode}`);
    }

    // Check if Claude made any commits
    const commitLog = await this.repoManager.getCommitLog(workDir);
    if (!commitLog.trim()) {
      console.warn('[Implement] No commits were made by Claude — nothing to push');
      return {
        branchName,
        prUrl: '',
        workDir,
        costUsd,
        durationMs: Date.now() - startTime,
      };
    }

    // Push and create PR
    console.log(`[Implement] Pushing branch: ${branchName}`);
    await this.repoManager.push(workDir, branchName);

    const prBody = [
      `## Trello Card`,
      card.url,
      '',
      `## Changes`,
      commitLog,
      '',
      '---',
      '_Automated by Trello Pilot Worker_',
    ].join('\n');

    let prUrl = '';
    try {
      const prInfo = await this.repoManager.createPr(workDir, card.name, prBody, baseBranch);
      prUrl = prInfo.url;
      console.log(`[Implement] PR created: ${prUrl}`);
    } catch (err) {
      console.warn(`[Implement] PR creation failed: ${(err as Error).message}`);
      // PR may already exist — try to find it
      try {
        prUrl = await this.repoManager.getPrUrl(workDir, branchName);
      } catch { /* ignore */ }
    }

    // Comment on Trello and move card
    const durationMs = Date.now() - startTime;
    await this.commenter.postImplementComplete(card.id, {
      branchName,
      prUrl,
      durationMs,
      costUsd,
    });

    return {
      branchName,
      prUrl,
      workDir,
      costUsd,
      durationMs,
    };
  }

  private async fetchFullCard(cardId: string): Promise<TrelloCard> {
    const card = await this.trelloApi.getCard(cardId);
    const checklists = await this.trelloApi.getCardChecklists(cardId);
    card.checklists = checklists;
    return card;
  }

  private async ensureKnowledge(workDir: string): Promise<void> {
    let knowledge = this.knowledgeMgr.load(workDir);

    if (knowledge) {
      console.log(`[Implement] Knowledge loaded (${knowledge.techStack.join(', ')})`);
    } else {
      console.log('[Implement] Generating project knowledge (first run)...');
      knowledge = await this.knowledgeMgr.generate(workDir, 'claude');
      if (knowledge) {
        console.log(`[Implement] Generated: ${knowledge.architecture}`);
      } else {
        console.log('[Implement] Could not generate knowledge — will scan normally');
        return;
      }
    }

    this.promptBuilder.setKnowledge(this.knowledgeMgr.formatForPrompt(knowledge));
  }

  private async estimateComplexity(
    card: TrelloCard,
    workDir: string,
  ): Promise<{ size: string; reasoning: string; estimatedMinutes: number } | null> {
    try {
      const prompt = [
        'Analyze this task and estimate complexity.',
        `Task: "${card.name}".`,
        `Description: "${card.desc || 'none'}".`,
        'Respond with ONLY valid JSON: {"size":"S|M|L|XL","reasoning":"brief reason","estimatedMinutes":N}',
      ].join(' ');

      const result = await runClaude({
        cwd: workDir,
        prompt,
        maxBudgetUsd: 0.05,
      });

      const jsonMatch = result.output.match(/\{[^}]+\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch {
      console.warn('[Implement] Complexity estimation failed, skipping');
    }
    return null;
  }
}
