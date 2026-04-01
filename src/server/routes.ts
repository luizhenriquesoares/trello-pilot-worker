import express, { type Express } from 'express';
import { WebhookHandler } from './webhook-handler.js';

const STARTED_AT = new Date().toISOString();

export function createApp(webhookHandler: WebhookHandler): Express {
  const app = express();

  // Parse JSON bodies — also needed for Trello webhook signature verification
  app.use(express.json());

  // Health check
  app.get('/health', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      uptime: process.uptime(),
      startedAt: STARTED_AT,
      timestamp: new Date().toISOString(),
    });
  });

  // Trello webhook verification (HEAD)
  app.head('/webhook', (req, res) => {
    webhookHandler.handleVerification(req, res);
  });

  // Trello webhook events (POST)
  app.post('/webhook', (req, res) => {
    // handleWebhook responds 200 immediately and processes async
    webhookHandler.handleWebhook(req, res);
  });

  return app;
}
