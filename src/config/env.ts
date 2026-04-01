import type { EnvConfig } from './types.js';

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

export function loadEnvConfig(): EnvConfig {
  return {
    port: parseInt(process.env.PORT || '3000', 10),
    sqsQueueUrl: requireEnv('SQS_QUEUE_URL'),
    awsRegion: process.env.AWS_REGION || 'us-east-1',
    anthropicApiKey: requireEnv('ANTHROPIC_API_KEY'),
    ghToken: requireEnv('GH_TOKEN'),
    trelloKey: requireEnv('TRELLO_KEY'),
    trelloToken: requireEnv('TRELLO_TOKEN'),
    trelloWebhookSecret: process.env.TRELLO_WEBHOOK_SECRET,
    slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
  };
}
