export type JobStatus = 'queued' | 'running' | 'success' | 'failed';
export type JobStage = 'implement' | 'review' | 'qa';

export interface TrackedJob {
  id: string;
  cardId: string;
  cardName: string;
  project: string;
  stage: JobStage;
  status: JobStatus;
  branch?: string;
  prUrl?: string;
  error?: string;
  costUsd?: number;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
}

const MAX_JOBS = 100;

export class JobTracker {
  private jobs: TrackedJob[] = [];
  private activeJobs = new Map<string, TrackedJob>();

  /** Record a new job starting */
  start(cardId: string, cardName: string, project: string, stage: JobStage): string {
    const id = `${cardId}-${stage}-${Date.now()}`;
    const job: TrackedJob = {
      id,
      cardId,
      cardName,
      project,
      stage,
      status: 'running',
      startedAt: new Date().toISOString(),
    };

    this.activeJobs.set(id, job);
    this.jobs.unshift(job);

    // Keep only last N jobs
    if (this.jobs.length > MAX_JOBS) {
      this.jobs = this.jobs.slice(0, MAX_JOBS);
    }

    return id;
  }

  /** Mark a job as completed */
  complete(id: string, result: { branch?: string; prUrl?: string; costUsd?: number }): void {
    const job = this.activeJobs.get(id);
    if (!job) return;

    job.status = 'success';
    job.finishedAt = new Date().toISOString();
    job.durationMs = Date.now() - new Date(job.startedAt).getTime();
    job.branch = result.branch;
    job.prUrl = result.prUrl;
    job.costUsd = result.costUsd;

    this.activeJobs.delete(id);
  }

  /** Mark a job as failed */
  fail(id: string, error: string): void {
    const job = this.activeJobs.get(id);
    if (!job) return;

    job.status = 'failed';
    job.error = error;
    job.finishedAt = new Date().toISOString();
    job.durationMs = Date.now() - new Date(job.startedAt).getTime();

    this.activeJobs.delete(id);
  }

  /** Get all jobs (most recent first) */
  getJobs(): TrackedJob[] {
    return this.jobs;
  }

  /** Get active (running) jobs */
  getActiveJobs(): TrackedJob[] {
    return Array.from(this.activeJobs.values());
  }

  /** Get summary stats */
  getStats(): { total: number; running: number; success: number; failed: number; totalCostUsd: number } {
    const running = this.activeJobs.size;
    const success = this.jobs.filter((j) => j.status === 'success').length;
    const failed = this.jobs.filter((j) => j.status === 'failed').length;
    const totalCostUsd = this.jobs.reduce((sum, j) => sum + (j.costUsd || 0), 0);

    return { total: this.jobs.length, running, success, failed, totalCostUsd };
  }
}
