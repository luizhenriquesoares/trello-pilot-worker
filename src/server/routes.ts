import express, { type Express } from 'express';
import { WebhookHandler } from './webhook-handler.js';
import { JobTracker } from '../tracking/job-tracker.js';
import { LogBuffer } from '../tracking/log-buffer.js';

const STARTED_AT = new Date().toISOString();

export function createApp(webhookHandler: WebhookHandler, jobTracker: JobTracker, logBuffer: LogBuffer): Express {
  const app = express();

  app.use(express.json());

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

  app.get('/api/logs', (_req, res) => {
    res.json(logBuffer.getAll());
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
