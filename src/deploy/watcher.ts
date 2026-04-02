import type { PipelineOrchestrator } from '../pipeline/orchestrator.js';
import type { BoardConfig } from '../config/types.js';

const RAILWAY_API = 'https://backboard.railway.com/graphql/v2';

interface RailwayProject {
  id: string;
  label: string;
}

/**
 * Polls Railway API to detect successful deployments.
 * When a deploy succeeds after a QA merge, moves the card to Done.
 */
export class DeployWatcher {
  private readonly railwayToken: string;
  private readonly projects: RailwayProject[];
  private lastDeployTimes = new Map<string, string>(); // serviceId → last deploy timestamp
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(
    railwayToken: string,
    boardConfig: BoardConfig,
    private readonly orchestrator: PipelineOrchestrator,
  ) {
    this.railwayToken = railwayToken;

    // Map project lists to Railway project IDs
    // These are configured in the board config's projectLists
    this.projects = boardConfig.projectLists
      .filter((p) => p.railwayProjectId)
      .map((p) => ({ id: p.railwayProjectId!, label: p.name }));
  }

  /** Start polling every N seconds */
  start(intervalMs: number = 30_000): void {
    if (!this.railwayToken || this.projects.length === 0) {
      console.log('[DeployWatcher] No Railway token or projects configured — skipping');
      return;
    }

    console.log(`[DeployWatcher] Watching ${this.projects.length} Railway projects (every ${intervalMs / 1000}s)`);

    // Initial check to capture current deploy times
    this.check().catch(() => {});

    this.intervalHandle = setInterval(() => {
      this.check().catch((err) => {
        console.error(`[DeployWatcher] Check failed: ${(err as Error).message}`);
      });
    }, intervalMs);
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  private async check(): Promise<void> {
    const pending = this.orchestrator.getPendingDeploys();
    if (pending.length === 0) return; // Nothing waiting for deploy

    for (const project of this.projects) {
      try {
        const deploys = await this.fetchLatestDeploys(project.id);

        for (const deploy of deploys) {
          if (deploy.status !== 'SUCCESS') continue;

          const lastKnown = this.lastDeployTimes.get(deploy.serviceId);

          if (lastKnown && deploy.createdAt > lastKnown) {
            // New successful deploy detected!
            console.log(`[DeployWatcher] New deploy detected: ${deploy.serviceName} (${project.label})`);

            // Check if any pending card matches this project
            for (const card of pending) {
              if (card.projectName === project.label) {
                await this.orchestrator.confirmDeploy(card.cardId);
              }
            }
          }

          this.lastDeployTimes.set(deploy.serviceId, deploy.createdAt);
        }
      } catch (err) {
        console.error(`[DeployWatcher] Error checking ${project.label}: ${(err as Error).message}`);
      }
    }
  }

  private async fetchLatestDeploys(projectId: string): Promise<
    { serviceId: string; serviceName: string; status: string; createdAt: string }[]
  > {
    const resp = await fetch(RAILWAY_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.railwayToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: `query { project(id: "${projectId}") { services { edges { node { id name deployments(first: 1) { edges { node { status createdAt } } } } } } } }`,
      }),
    });

    const data = await resp.json() as Record<string, unknown>;
    const project = (data.data as Record<string, unknown>)?.project as Record<string, unknown>;
    const services = (project?.services as Record<string, unknown>)?.edges as Array<Record<string, unknown>> || [];

    return services.map((edge) => {
      const svc = edge.node as Record<string, unknown>;
      const deploys = (svc.deployments as Record<string, unknown>)?.edges as Array<Record<string, unknown>> || [];
      const last = (deploys[0]?.node as Record<string, unknown>) || {};
      return {
        serviceId: svc.id as string,
        serviceName: svc.name as string,
        status: (last.status as string) || 'UNKNOWN',
        createdAt: (last.createdAt as string) || '',
      };
    }).filter((d) => !d.serviceName.toLowerCase().includes('mongo') && !d.serviceName.toLowerCase().includes('postgres'));
  }
}
