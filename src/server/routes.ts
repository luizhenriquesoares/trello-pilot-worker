import express, { type Express } from 'express';
import { WebhookHandler } from './webhook-handler.js';
import { JobTracker } from '../tracking/job-tracker.js';
import { LogBuffer } from '../tracking/log-buffer.js';
import type { PipelineOrchestrator } from '../pipeline/orchestrator.js';

const STARTED_AT = new Date().toISOString();

export function createApp(
  webhookHandler: WebhookHandler,
  jobTracker: JobTracker,
  logBuffer: LogBuffer,
  orchestrator: PipelineOrchestrator,
): Express {
  const app = express();

  // Capture raw body so the Trello webhook HMAC verifier can hash the exact bytes
  // that were signed (re-serializing req.body would alter whitespace/key order).
  app.use(express.json({
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: string }).rawBody = buf.toString('utf8');
    },
  }));

  // CORS for task-pilot frontend
  app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
  });

  // Health check
  app.get('/health', (_req, res) => {
    const stats = jobTracker.getStats();
    res.status(200).json({
      status: 'ok',
      uptime: process.uptime(),
      startedAt: STARTED_AT,
      timestamp: new Date().toISOString(),
      jobs: stats,
    });
  });

  // Job tracking API
  app.get('/api/status', (_req, res) => {
    res.json({
      online: true,
      uptime: process.uptime(),
      startedAt: STARTED_AT,
      stats: jobTracker.getStats(),
      activeJobs: jobTracker.getActiveJobs(),
    });
  });

  app.get('/api/jobs', (_req, res) => {
    res.json(jobTracker.getJobs());
  });

  app.post('/api/jobs/clear', (_req, res) => {
    jobTracker.clear();
    res.json({ cleared: true });
  });

  app.get('/api/logs', (req, res) => {
    const { level, stage, project, limit } = req.query;
    res.json(logBuffer.query({
      level: level as string,
      stage: stage as string,
      project: project as string,
      limit: limit ? parseInt(limit as string, 10) : undefined,
    }));
  });

  // Metrics endpoint
  app.get('/api/metrics', (_req, res) => {
    const stats = jobTracker.getStats();
    res.json({
      ...stats,
      uptime: process.uptime(),
      memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      timestamp: new Date().toISOString(),
    });
  });

  // Admin: list and release in-memory repo locks. The worker is on an internal
  // Hostinger network behind the task-pilot dashboard (which has bearer auth),
  // so these match the existing no-auth pattern of /api/jobs and /api/logs.
  app.get('/api/admin/locks', (_req, res) => {
    res.json(orchestrator.listRepoLocks());
  });

  app.post('/api/admin/release-lock', (req, res) => {
    const repoUrl = (req.body as { repoUrl?: unknown })?.repoUrl;
    if (typeof repoUrl !== 'string' || !repoUrl) {
      res.status(400).json({ error: 'repoUrl (string) is required in body' });
      return;
    }
    const result = orchestrator.releaseRepoLock(repoUrl);
    res.json(result);
  });

  // Trello webhook verification (HEAD)
  app.head('/webhook', (req, res) => {
    webhookHandler.handleVerification(req, res);
  });

  // Trello webhook events (POST)
  app.post('/webhook', (req, res) => {
    webhookHandler.handleWebhook(req, res);
  });

  return app;
}
