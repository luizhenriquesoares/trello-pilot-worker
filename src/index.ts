import { spawn } from 'child_process';
import { createServer } from 'http';
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
import { loadSecretsFromSSM } from './config/secrets-loader.js';
import { loadBoardConfig } from './config/board-config.js';
import { JobTracker } from './tracking/job-tracker.js';
import { LogBuffer } from './tracking/log-buffer.js';
import { StreamBroadcaster } from './server/websocket.js';
import { validateWorkerEvent } from './shared/types/worker-event.js';
import { isPermanentError, isLikelyTransient } from './shared/errors.js';

// --- Globals ---

let isShuttingDown = false;

// --- Bootstrap ---

async function cleanupStaleTmpDirs(): Promise<void> {
  const { readdir, rm } = await import('fs/promises');
  try {
    const entries = await readdir('/tmp');
    const stale = entries.filter((e) => e.startsWith('trello-pilot'));
    if (stale.length === 0) return;
    console.log(`[Worker] Removing ${stale.length} stale /tmp entries from previous runs`);
    for (const entry of stale) {
      const full = `/tmp/${entry}`;
      try {
        await rm(full, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[Worker] Failed to clean ${full}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    console.warn(`[Worker] Stale /tmp sweep failed: ${(err as Error).message}`);
  }
}

async function main(): Promise<void> {
  // Install log buffer to capture all console output
  const logBuffer = new LogBuffer();
  logBuffer.install();

  console.log('[Worker] Starting trello-pilot-worker...');

  // Load secrets from AWS SSM Parameter Store before reading env vars.
  // Container boots with only SECRETS_SOURCE / SSM_PATH_PREFIX / AWS creds;
  // everything else (Trello, GH, Claude, Slack, etc.) lives in SSM as
  // SecureStrings encrypted with KMS.
  await loadSecretsFromSSM();

  // Clean up leftover work dirs from crashed / killed previous runs
  await cleanupStaleTmpDirs();

  // Load configuration
  const envConfig = loadEnvConfig();
  const boardConfig = loadBoardConfig();

  console.log(`[Worker] Board: ${boardConfig.boardId}, Projects: ${boardConfig.projectLists.length}`);

  // Authenticate gh CLI with GH_TOKEN (skip if not set)
  if (envConfig.ghToken) {
    await authenticateGhCli(envConfig.ghToken);
    await logGhTokenScopes(envConfig.ghToken);
  } else {
    console.warn('[Worker] GH_TOKEN not set — gh CLI not authenticated');
  }

  // Initialize dependencies
  const trelloCredentials = { key: envConfig.trelloKey, token: envConfig.trelloToken };
  const trelloApi = new TrelloApi(trelloCredentials);
  const repoManager = new RepoManager();
  const commenter = new TrelloCommenter(trelloApi);
  const slackNotifier = new SlackNotifier(envConfig.slackWebhookUrl);

  // Job tracker + WebSocket broadcaster
  const jobTracker = new JobTracker();
  const broadcaster = new StreamBroadcaster();

  // Pipeline stages
  const implementStage = new ImplementStage(repoManager, trelloApi, commenter);
  const reviewStage = new ReviewStage(repoManager, trelloApi, commenter);
  const qaStage = new QaStage(repoManager, trelloApi, commenter);

  // SQS
  const sqsConsumer = new SqsConsumer(envConfig.sqsQueueUrl, envConfig.awsRegion);
  const sqsProducer = new SqsProducer(envConfig.sqsQueueUrl, envConfig.awsRegion);

  // Orchestrator. After QA merge the card moves to Done immediately —
  // CI/CD on Hostinger triggers automatically on commit, so the worker has
  // no deploy status API to poll and shouldn't pretend to verify it.
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
    broadcaster,
  );

  // Webhook handler + Express server.
  // Trello signs each request with HMAC(appSecret, rawBody + callbackUrl), so the
  // public URL the webhook was registered against MUST match what we hash here.
  const callbackUrl = envConfig.publicBaseUrl
    ? envConfig.publicBaseUrl.replace(/\/+$/, '') + '/webhook'
    : undefined;

  if (envConfig.trelloWebhookSecret && !callbackUrl) {
    console.warn(
      '[Worker] TRELLO_WEBHOOK_SECRET is set but PUBLIC_BASE_URL is missing — '
      + 'webhook verification will refuse all requests until PUBLIC_BASE_URL is configured',
    );
  } else if (callbackUrl) {
    console.log(`[Worker] Webhook callback URL for HMAC: ${callbackUrl}`);
  }

  const webhookHandler = new WebhookHandler(
    sqsProducer,
    boardConfig,
    trelloCredentials,
    envConfig.trelloWebhookSecret,
    callbackUrl,
  );
  const app = createApp(webhookHandler, jobTracker, logBuffer, orchestrator);

  // Create HTTP server (needed for both Express + WebSocket)
  const server = createServer(app);

  // Attach WebSocket server for real-time streaming
  broadcaster.attach(server);

  server.listen(envConfig.port, () => {
    console.log(`[Worker] Express + WebSocket server listening on port ${envConfig.port}`);
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
      const messages = await consumer.pollBatch();

      if (messages.length === 0) {
        continue; // No messages, long-poll will wait ~20s
      }

      console.log(`[Worker] Received ${messages.length} SQS message(s)`);

      // Process all messages concurrently — repo locks handle same-repo serialization.
      //
      // Retry semantics: deleteMessage runs only when the message was either
      // processed successfully OR failed with a PermanentError. Any other failure
      // (network, Trello/GitHub 5xx, transient timeouts) leaves the message in
      // the queue so SQS redelivers it after the visibility timeout. Configure a
      // DLQ on the queue with maxReceiveCount ~3 to stop infinite retries.
      const tasks = messages
        .filter((m) => m.Body)
        .map(async (message) => {
          let shouldDelete = false;
          try {
            console.log(`[Worker] Processing SQS message: ${message.MessageId}`);
            const { event, pipelineContext } = parseSqsMessage(message.Body!);

            const validationErrors = validateWorkerEvent(event);
            if (validationErrors.length > 0) {
              console.warn(
                `[Worker] Dropping malformed SQS message ${message.MessageId}: ${validationErrors.join('; ')}`,
              );
              shouldDelete = true;
              return;
            }

            await orchestrator.processEvent(event, pipelineContext);
            shouldDelete = true;
          } catch (err) {
            const error = err as Error;
            if (isPermanentError(err)) {
              console.error(
                `[Worker] Message ${message.MessageId} hit a permanent error, removing from queue: ${error.message}`,
              );
              shouldDelete = true;
            } else if (isLikelyTransient(err)) {
              console.warn(
                `[Worker] Message ${message.MessageId} hit a transient error, will retry after visibility timeout: ${error.message}`,
              );
            } else {
              // Unknown errors: keep the message so SQS redelivers; DLQ catches loops.
              console.error(
                `[Worker] Message ${message.MessageId} failed (will retry): ${error.message}`,
              );
            }
          } finally {
            if (shouldDelete && message.ReceiptHandle) {
              try {
                await consumer.deleteMessage(message.ReceiptHandle);
                console.log(`[Worker] Deleted SQS message: ${message.MessageId}`);
              } catch (deleteErr) {
                console.error(
                  `[Worker] Failed to delete SQS message ${message.MessageId}: ${(deleteErr as Error).message}`,
                );
              }
            }
          }
        });

      await Promise.allSettled(tasks);
    } catch (err) {
      console.error(`[Worker] Poll loop error: ${(err as Error).message}`);
      await delay(5000);
    }
  }
}

// --- Helpers ---

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function logGhTokenScopes(token: string): Promise<void> {
  // Hits GET /user with the token to read X-OAuth-Scopes (classic PATs) and
  // confirm the token is actually valid. Helps diagnose "PR merges but branch
  // never deletes" — almost always a missing Contents:Write or repo scope.
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!res.ok) {
      console.warn(`[Worker] GH_TOKEN check failed: HTTP ${res.status} — token may be invalid or expired`);
      return;
    }

    const scopes = res.headers.get('x-oauth-scopes');
    const tokenType = res.headers.get('x-github-authentication-token-type') || 'classic';
    const userLogin = ((await res.json()) as { login?: string }).login || '?';

    if (scopes !== null) {
      console.log(`[Worker] GH_TOKEN ok — user=${userLogin}, type=${tokenType}, scopes=[${scopes || 'none'}]`);
      const required = ['repo'];
      const missing = required.filter((s) => !scopes.split(/,\s*/).some((scope) => scope === s || scope.startsWith(`${s}:`)));
      if (missing.length > 0) {
        console.warn(
          `[Worker] GH_TOKEN missing recommended scope(s): ${missing.join(', ')} — `
          + `branch deletion or PR merge may fail. Classic PAT needs 'repo'; fine-grained needs Contents:Write + Pull requests:Write.`,
        );
      }
    } else {
      console.log(
        `[Worker] GH_TOKEN ok — user=${userLogin}, type=${tokenType} (fine-grained, scopes not exposed via header). `
        + `Ensure permissions include Contents:Read+Write and Pull requests:Read+Write.`,
      );
    }
  } catch (err) {
    console.warn(`[Worker] GH_TOKEN scope check failed: ${(err as Error).message}`);
  }
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
