import * as fs from 'fs';
import * as path from 'path';
import { RepoManager } from '../../git/repo-manager.js';
import { TrelloApi } from '../../trello/api.js';
import { PromptBuilder } from '../../claude/prompt-builder.js';
import { runClaude, type ClaudeStreamEvent } from '../../claude/headless-runner.js';
import { KnowledgeManager } from '../../claude/knowledge.js';
import { TrelloCommenter } from '../../notifications/trello-commenter.js';
import type { WorkerEvent } from '../../shared/types/worker-event.js';
import type { TrelloCard } from '../../trello/types.js';

const WORK_DIR_PREFIX = '/tmp/trello-pilot';
const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB

export interface ImplementResult {
  branchName: string;
  prUrl: string;
  workDir: string;
  costUsd: number;
  durationMs: number;
  commitSummary: string;
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

  async execute(event: WorkerEvent, onEvent?: (e: ClaudeStreamEvent) => void): Promise<ImplementResult> {
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
    await this.ensureKnowledge(workDir, repoUrl);

    // Download image attachments for visual context
    const imagePaths = await this.downloadImageAttachments(card, workDir);
    if (imagePaths.length > 0) {
      this.promptBuilder.setImagePaths(imagePaths);
      console.log(`[Implement] ${imagePaths.length} image(s) attached for context`);
    }

    // Build prompt — use retry prompt if this is a reopened task
    const prompt = event.isRetry && event.retryFeedback
      ? this.promptBuilder.buildRetry(card, event.retryFeedback)
      : this.promptBuilder.build(card);

    const modeLabel = event.isRetry ? 'RETRY' : 'IMPLEMENT';
    console.log(`[Implement] Running Claude headless (${modeLabel}) for card: ${card.name}`);

    const runResult = await runClaude({
      cwd: workDir,
      prompt,
      onEvent,
    });

    const costUsd = runResult.costUsd ?? 0;

    if (runResult.exitCode !== 0) {
      console.warn(`[Implement] Claude exited with code ${runResult.exitCode}`);
    }

    // Check if there are commits to push (new or from previous run)
    let commitLog = '';
    try {
      commitLog = await this.repoManager.getCommitLog(workDir);
    } catch {
      // getCommitLog may fail if on main with no diff — check if branch has any commits at all
      console.warn('[Implement] Could not get commit log — checking branch status');
    }

    if (!commitLog.trim()) {
      console.warn('[Implement] No commits on branch — checking if already pushed to remote');
      // Try to push anyway in case commits exist from a previous run
      try {
        await this.repoManager.push(workDir, branchName);
        commitLog = 'Commits from previous implementation run';
        console.log('[Implement] Pushed existing branch to remote');
      } catch {
        console.warn('[Implement] No commits to push — pipeline will continue without PR');
        return {
          branchName,
          prUrl: '',
          workDir,
          costUsd,
          durationMs: Date.now() - startTime,
          commitSummary: '',
        };
      }
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
        prUrl = (await this.repoManager.getPrUrl(workDir, branchName)) ?? '';
      } catch { /* ignore */ }
    }

    // Comment on Trello and move card
    const durationMs = Date.now() - startTime;
    await this.commenter.postImplementComplete(card.id, {
      branchName,
      prUrl,
      durationMs,
      costUsd,
      projectName: event.projectName,
    });

    return {
      branchName,
      prUrl,
      workDir,
      costUsd,
      durationMs,
      commitSummary: commitLog.trim(),
    };
  }

  private async fetchFullCard(cardId: string): Promise<TrelloCard> {
    const card = await this.trelloApi.getCard(cardId);
    const checklists = await this.trelloApi.getCardChecklists(cardId);
    card.checklists = checklists;
    return card;
  }

  private async ensureKnowledge(workDir: string, repoUrl?: string): Promise<void> {
    // Priority 1: Use existing CLAUDE.md from the repo (richest context, zero cost)
    const claudeMdContext = this.knowledgeMgr.formatClaudeMdForPrompt(workDir);
    if (claudeMdContext) {
      console.log('[Implement] Using CLAUDE.md from repo as project knowledge');
      this.promptBuilder.setKnowledge(claudeMdContext);
      return;
    }

    // Priority 2: Load cached knowledge (workDir or persistent cache by repo URL)
    let knowledge = this.knowledgeMgr.load(workDir, repoUrl);
    if (knowledge) {
      console.log(`[Implement] Knowledge loaded (${knowledge.techStack.join(', ')})`);
      this.promptBuilder.setKnowledge(this.knowledgeMgr.formatForPrompt(knowledge));
      return;
    }

    // Priority 3: Generate knowledge via Claude CLI
    console.log('[Implement] Generating project knowledge (first run)...');
    knowledge = await this.knowledgeMgr.generate(workDir, 'claude', repoUrl);
    if (knowledge) {
      console.log(`[Implement] Generated: ${knowledge.architecture}`);
      this.promptBuilder.setKnowledge(this.knowledgeMgr.formatForPrompt(knowledge));
    } else {
      console.log('[Implement] Could not generate knowledge — will scan normally');
    }
  }

  private async downloadImageAttachments(card: TrelloCard, workDir: string): Promise<{ name: string; filePath: string }[]> {
    const imageAtts = card.attachments?.filter((att) => {
      return IMAGE_EXTENSIONS.test(att.name);
    });
    if (!imageAtts?.length) return [];

    const imgDir = path.join(workDir, '.trello-pilot-images');
    if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });

    const downloaded: { name: string; filePath: string }[] = [];

    for (const att of imageAtts) {
      try {
        const response = await fetch(att.url, { signal: AbortSignal.timeout(30_000) });
        if (!response.ok) continue;

        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > MAX_IMAGE_SIZE) continue;

        const safeName = att.name.replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 100);
        const filePath = path.join(imgDir, `${att.id}_${safeName}`);
        fs.writeFileSync(filePath, buffer);
        downloaded.push({ name: att.name, filePath });
      } catch {
        // Non-blocking — skip failed downloads
      }
    }

    return downloaded;
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
        'Respond with ONLY valid JSON (no markdown, no code fences):',
        '{"size":"S|M|L|XL","reasoning":"brief reason","estimatedMinutes":N}',
      ].join(' ');

      const result = await runClaude({
        cwd: workDir,
        prompt,
        timeoutMs: 2 * 60 * 1000, // 2 min max
        maxBudgetUsd: 0.05,
      });

      // Strip code fences and stream-json event lines, then extract the response JSON
      const output = result.output
        .replace(/```json\s*/g, '')
        .replace(/```\s*/g, '');

      // Try to find a JSON object with the expected "size" field
      // (avoids matching stream-json events like init/result)
      const jsonObjects = output.match(/\{[^{}]*\}/g) || [];
      for (const candidate of jsonObjects) {
        try {
          const parsed = JSON.parse(candidate);
          if (parsed.size && parsed.estimatedMinutes !== undefined) {
            return parsed;
          }
        } catch { /* not valid JSON, skip */ }
      }
      console.warn('[Implement] No valid complexity JSON found in output');
    } catch (err) {
      console.warn(`[Implement] Complexity estimation failed: ${(err as Error).message}`);
    }
    return null;
  }
}
