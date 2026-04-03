import * as fs from 'fs';
import { TrelloApi } from '../trello/api.js';
import { TrelloCommenter } from '../notifications/trello-commenter.js';
import type { BoardConfig } from '../config/types.js';

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

const POLL_INTERVAL_MS = 30_000; // 30 seconds
const PENDING_FILE = '/tmp/trello-pilot-pending-deploys.json';
const MAX_WAIT_MS = 15 * 60_000; // 15 minutes — if deploy doesn't complete, move to Done anyway

interface PendingDeploy {
  cardId: string;
  projectName: string;
  railwayProjectId: string;
  branchName: string;
  repoUrl: string;
  mergedAt: string;
  totalCostUsd: number;
  cardName: string;
  commitSummary?: string;
  prUrl?: string;
  totalDurationMs?: number;
}

interface RailwayDeployment {
  id: string;
  status: string;
  createdAt: string;
}

export class DeployWatcher {
  private polling = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly trelloApi: TrelloApi,
    private readonly boardConfig: BoardConfig,
    private readonly railwayToken: string,
    private readonly commenter?: TrelloCommenter,
  ) {
    // Resume watching on startup if there are pending deploys
    const pending = this.loadPending();
    if (Object.keys(pending).length > 0) {
      console.log(`[DeployWatcher] Resuming watch for ${Object.keys(pending).length} pending deploys`);
      this.start();
    }
  }

  /** Add a card to watch for deploy after QA merge */
  addPending(
    cardId: string,
    projectName: string,
    totalCostUsd: number,
    branchName: string,
    repoUrl: string,
    cardName: string,
    commitSummary?: string,
    prUrl?: string,
    totalDurationMs?: number,
  ): void {
    const project = this.boardConfig.projectLists?.find((p) => p.name === projectName);
    const railwayProjectId = project?.railwayProjectId;

    if (!railwayProjectId) {
      // No Railway project configured — move to Done immediately
      console.log(`[DeployWatcher] No railwayProjectId for "${projectName}" — moving to Done immediately`);
      this.completeCard(cardId, projectName, totalCostUsd, branchName, repoUrl, cardName, false, commitSummary, prUrl, totalDurationMs);
      return;
    }

    const pending = this.loadPending();
    pending[cardId] = {
      cardId, projectName, railwayProjectId, branchName, repoUrl,
      mergedAt: new Date().toISOString(), totalCostUsd,
      cardName, commitSummary, prUrl, totalDurationMs,
    };
    this.savePending(pending);

    console.log(`[DeployWatcher] Watching deploy for "${projectName}" (card ${cardId})`);
    if (!this.timer) this.start();
  }

  start(): void {
    if (this.timer) return;
    console.log('[DeployWatcher] Polling Railway every 30s');
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    this.poll(); // run immediately

    // On startup, recover any cards stuck in QA after a worker restart
    this.recoverStuckCards().catch((err) => {
      console.warn(`[DeployWatcher] Recovery check failed: ${(err as Error).message}`);
    });
  }

  /**
   * On startup, check if any cards in the QA list have successful Railway deploys.
   * This handles the case where the worker restarted and lost the pending deploys file.
   */
  private async recoverStuckCards(): Promise<void> {
    const qaListId = this.boardConfig.lists.qa;
    if (!qaListId) return;

    try {
      const cards = await this.trelloApi.getListCards(qaListId);
      if (cards.length === 0) return;

      console.log(`[DeployWatcher] Recovery: checking ${cards.length} card(s) in QA list`);

      for (const card of cards) {
        // Skip if already in pending (file survived restart)
        const pending = this.loadPending();
        if (pending[card.id]) continue;

        // Check each project for recent successful deploy
        for (const project of this.boardConfig.projectLists || []) {
          if (!project.railwayProjectId) continue;

          const deploy = await this.getLatestDeploy(project.railwayProjectId);
          if (!deploy) continue;

          // If deploy succeeded in the last 30 minutes, move card to Done
          const deployAge = Date.now() - new Date(deploy.createdAt).getTime();
          if ((deploy.status === 'SUCCESS' || deploy.status === 'COMPLETED') && deployAge < 30 * 60_000) {
            console.log(`[DeployWatcher] Recovery: card "${card.name}" has successful deploy on "${project.name}" — moving to Done`);
            await this.completeCard(
              card.id, project.name, 0, '', '', card.name, true,
            );
            break; // only move once
          }
        }
      }
    } catch (err) {
      console.warn(`[DeployWatcher] Recovery scan failed: ${(err as Error).message}`);
    }
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;

    try {
      const pending = this.loadPending();
      const cardIds = Object.keys(pending);
      if (cardIds.length === 0) { this.stop(); return; }

      for (const cardId of cardIds) {
        const entry = pending[cardId];
        try {
          // Timeout: if waiting too long, move to Done anyway
          const waitMs = Date.now() - new Date(entry.mergedAt).getTime();
          if (waitMs > MAX_WAIT_MS) {
            console.log(`[DeployWatcher] Timeout (${Math.round(waitMs / 60_000)}min) for "${entry.projectName}" — moving to Done`);
            await this.completeCard(
              cardId, entry.projectName, entry.totalCostUsd, entry.branchName, entry.repoUrl,
              entry.cardName, false, entry.commitSummary, entry.prUrl, entry.totalDurationMs,
            );
            delete pending[cardId];
            this.savePending(pending);
            continue;
          }

          const deploy = await this.getLatestDeploy(entry.railwayProjectId);
          if (!deploy) {
            console.log(`[DeployWatcher] No deployment found for "${entry.projectName}" (project: ${entry.railwayProjectId})`);
            continue;
          }

          const deployTime = new Date(deploy.createdAt).getTime();
          const mergeTime = new Date(entry.mergedAt).getTime();

          console.log(`[DeployWatcher] "${entry.projectName}" deploy status: ${deploy.status} (created: ${deploy.createdAt})`);

          if (deployTime < mergeTime) continue; // deploy from before merge

          if (deploy.status === 'SUCCESS' || deploy.status === 'COMPLETED') {
            console.log(`[DeployWatcher] Deploy SUCCESS for "${entry.projectName}"`);
            await this.completeCard(
              cardId, entry.projectName, entry.totalCostUsd, entry.branchName, entry.repoUrl,
              entry.cardName, true, entry.commitSummary, entry.prUrl, entry.totalDurationMs,
            );
            delete pending[cardId];
            this.savePending(pending);
          } else if (deploy.status === 'FAILED' || deploy.status === 'CRASHED') {
            console.log(`[DeployWatcher] Deploy FAILED for "${entry.projectName}"`);
            await this.trelloApi.addComment(cardId,
              `**Deploy falhou** [${entry.projectName}]\n\nStatus: ${deploy.status}\nCard permanece em QA. Corrija e re-deploy.`
            ).catch(() => {});
            delete pending[cardId];
            this.savePending(pending);
          }
          // BUILDING, DEPLOYING → keep waiting
        } catch (err) {
          console.error(`[DeployWatcher] Error checking "${entry.projectName}": ${(err as Error).message}`);
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private async completeCard(
    cardId: string,
    projectName: string,
    totalCostUsd: number,
    branchName: string,
    repoUrl: string,
    cardName: string,
    deployVerified: boolean,
    commitSummary?: string,
    prUrl?: string,
    totalDurationMs?: number,
  ): Promise<void> {
    // Move card to Done
    await this.trelloApi.moveCard(cardId, this.boardConfig.lists.done).catch((err) => {
      console.error(`[DeployWatcher] Move to Done failed: ${(err as Error).message}`);
    });

    // Post rich summary comment via TrelloCommenter (or fallback to simple comment)
    if (this.commenter) {
      await this.commenter.postDoneSummary(cardId, {
        merged: true,
        totalCostUsd,
        totalDurationMs: totalDurationMs || 0,
        projectName,
        commitSummary,
        prUrl,
        cardName,
      });
    } else {
      const deployLabel = deployVerified ? 'Deploy verificado via Railway.' : 'Merged para main.';
      const msg = `**Task Concluida** [${projectName}]\n\n${deployLabel}\nCusto: $${totalCostUsd.toFixed(4)}`;
      await this.trelloApi.addComment(cardId, msg).catch(() => {});
    }

    // Notify Slack
    const deployLabel = deployVerified ? 'Deploy verificado' : 'Merged to main';
    this.notifySlack(
      `:white_check_mark: *Task Concluida* [${projectName}] — ${cardName}\n>${deployLabel} | Custo: $${totalCostUsd.toFixed(4)}`
      + (prUrl ? `\n>${prUrl}` : ''),
    ).catch(() => {});

    // Clean up: delete remote feature branch
    if (branchName && branchName !== 'main' && branchName !== 'master') {
      await this.deleteRemoteBranch(repoUrl, branchName);
    }
  }

  /** Delete remote feature branch to keep repo clean */
  private async deleteRemoteBranch(repoUrl: string, branchName: string): Promise<void> {
    try {
      const match = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
      if (!match) return;
      const [, owner, repo] = match;

      const ghToken = process.env.GH_TOKEN;
      if (!ghToken) return;

      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${branchName}`, {
        method: 'DELETE',
        headers: { 'Authorization': `token ${ghToken}`, 'Accept': 'application/vnd.github.v3+json' },
      });

      if (res.ok || res.status === 422) {
        console.log(`[DeployWatcher] Deleted remote branch: ${branchName}`);
      } else {
        console.warn(`[DeployWatcher] Failed to delete branch ${branchName}: ${res.status}`);
      }
    } catch (err) {
      console.warn(`[DeployWatcher] Branch cleanup failed: ${(err as Error).message}`);
    }
  }

  private async getLatestDeploy(railwayProjectId: string): Promise<RailwayDeployment | null> {
    const query = `query { project(id: "${railwayProjectId}") { services { edges { node { deployments(first: 1) { edges { node { id status createdAt } } } } } } } }`;

    const res = await fetch('https://backboard.railway.com/graphql/v2', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.railwayToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });

    if (!res.ok) return null;

    const data = await res.json() as Record<string, unknown>;
    let latest: RailwayDeployment | null = null;

    const project = (data as { data?: { project?: { services?: { edges?: Array<{ node?: { deployments?: { edges?: Array<{ node?: RailwayDeployment }> } } }> } } } }).data?.project;
    for (const svc of project?.services?.edges || []) {
      const deploy = svc.node?.deployments?.edges?.[0]?.node;
      if (deploy && (!latest || new Date(deploy.createdAt) > new Date(latest.createdAt))) {
        latest = deploy;
      }
    }

    return latest;
  }

  private loadPending(): Record<string, PendingDeploy> {
    try { if (fs.existsSync(PENDING_FILE)) return JSON.parse(fs.readFileSync(PENDING_FILE, 'utf-8')); } catch { /* */ }
    return {};
  }

  private savePending(p: Record<string, PendingDeploy>): void {
    fs.writeFileSync(PENDING_FILE, JSON.stringify(p, null, 2), 'utf-8');
  }

  private async notifySlack(text: string): Promise<void> {
    if (!SLACK_WEBHOOK_URL) return;
    try {
      await fetch(SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
    } catch { /* non-blocking */ }
  }
}
