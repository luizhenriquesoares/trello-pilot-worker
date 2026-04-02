import { spawn } from 'child_process';
import { createApp } from './server/routes.js';
import { WebhookHandler } from './server/webhook-handler.js';
import { SqsConsumer } from './sqs/consumer.js';
import { SqsProducer, parseSqsMessage } from './sqs/producer.js';
import { PipelineOrchestrator } from './pipeline/orchestrator.js';
import { ImplementStage } from './pipeline/stages/implement.js';
import { ReviewStage } from './pipeline/stages/review.js';
import { QaStage } from './pipeline/stages/qa.js';
import { RepoManager } from './git/repo-manager.js';
import { TrelloApi } from './trello/api.js';
import { TrelloCommenter } from './notifications/trello-commenter.js';
import { SlackNotifier } from './notifications/slack.js';
import { loadEnvConfig } from './config/env.js';
import { loadBoardConfig } from './config/board-config.js';
import { JobTracker } from './tracking/job-tracker.js';
import { LogBuffer } from './tracking/log-buffer.js';

// --- Globals ---

let isShuttingDown = false;

// --- Bootstrap ---

async function main(): Promise<void> {
  // Install log buffer to capture all console output
  const logBuffer = new LogBuffer();
  logBuffer.install();

  console.log('[Worker] Starting trello-pilot-worker...');

  // Load configuration
  const envConfig = loadEnvConfig();
  const boardConfig = loadBoardConfig();

  console.log(`[Worker] Board: ${boardConfig.boardId}, Projects: ${boardConfig.projectLists.length}`);

  // Authenticate gh CLI with GH_TOKEN (skip if not set)
  if (envConfig.ghToken) {
    await authenticateGhCli(envConfig.ghToken);
  } else {
    console.warn('[Worker] GH_TOKEN not set — gh CLI not authenticated');
  }

  // Initialize dependencies
  const trelloCredentials = { key: envConfig.trelloKey, token: envConfig.trelloToken };
  const trelloApi = new TrelloApi(trelloCredentials);
  const repoManager = new RepoManager();
  const commenter = new TrelloCommenter(trelloApi);
  const slackNotifier = new SlackNotifier(envConfig.slackWebhookUrl);

  // Pipeline stages
  const implementStage = new ImplementStage(repoManager, trelloApi, commenter);
  const reviewStage = new ReviewStage(repoManager, trelloApi, commenter);
  const qaStage = new QaStage(repoManager, trelloApi, commenter);

  // SQS
  const sqsConsumer = new SqsConsumer(envConfig.sqsQueueUrl, envConfig.awsRegion);
  const sqsProducer = new SqsProducer(envConfig.sqsQueueUrl, envConfig.awsRegion);

  // Orchestrator
  const orchestrator = new PipelineOrchestrator(
    implementStage,
    reviewStage,
    qaStage,
    sqsProducer,
    trelloApi,
    commenter,
    slackNotifier,
    boardConfig,
    jobTracker,
  );

  // Job tracker
  const jobTracker = new JobTracker();

  // Webhook handler + Express server
  const webhookHandler = new WebhookHandler(
    sqsProducer,
    boardConfig,
    trelloCredentials,
    envConfig.trelloWebhookSecret,
    undefined, // callbackUrl resolved at runtime if needed
  );
  const app = createApp(webhookHandler, jobTracker, logBuffer);

  const server = app.listen(envConfig.port, () => {
    console.log(`[Worker] Express server listening on port ${envConfig.port}`);
  });

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log('[Worker] Shutting down gracefully...');

    server.close(() => {
      console.log('[Worker] Express server closed');
    });

    // Give in-flight SQS processing time to finish
    await delay(2000);

    console.log('[Worker] Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Start SQS polling loop (only if SQS is configured)
  if (envConfig.sqsQueueUrl) {
    console.log('[Worker] Starting SQS polling loop...');
    await pollLoop(sqsConsumer, orchestrator);
  } else {
    console.warn('[Worker] SQS_QUEUE_URL not set — polling disabled (webhook-only mode)');
  }
}

// --- SQS Polling ---

async function pollLoop(consumer: SqsConsumer, orchestrator: PipelineOrchestrator): Promise<void> {
  while (!isShuttingDown) {
    try {
      const message = await consumer.poll();

      if (!message?.Body) {
        continue; // No messages, long-poll will wait ~20s
      }

      console.log(`[Worker] Received SQS message: ${message.MessageId}`);

      const { event, pipelineContext } = parseSqsMessage(message.Body);
      await orchestrator.processEvent(event, pipelineContext);

      // Delete message after successful processing
      if (message.ReceiptHandle) {
        await consumer.deleteMessage(message.ReceiptHandle);
        console.log(`[Worker] Deleted SQS message: ${message.MessageId}`);
      }
    } catch (err) {
      console.error(`[Worker] Poll loop error: ${(err as Error).message}`);
      // Wait before retrying to avoid tight error loops
      await delay(5000);
    }
  }
}

// --- Helpers ---

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function authenticateGhCli(token: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn('gh', ['auth', 'login', '--with-token'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        console.log('[Worker] gh CLI authenticated successfully');
        resolve();
      } else {
        // gh auth login may fail if already authenticated — treat as non-fatal
        console.warn(`[Worker] gh auth login exited with code ${code}: ${stderr.trim()}`);
        resolve();
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to run gh auth login: ${err.message}`));
    });

    // Pipe token to stdin
    proc.stdin.write(token);
    proc.stdin.end();
  });
}

// --- Entrypoint ---

main().catch((err) => {
  console.error(`[Worker] Fatal error: ${(err as Error).message}`);
  process.exit(1);
});
