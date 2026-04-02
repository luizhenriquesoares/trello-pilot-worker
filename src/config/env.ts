import type { EnvConfig } from './types.js';

export function loadEnvConfig(): EnvConfig {
  const missing: string[] = [];
  const warn = (name: string) => {
    if (!process.env[name]) missing.push(name);
  };

  warn('CLAUDE_CODE_OAUTH_TOKEN');
  warn('GH_TOKEN');
  warn('TRELLO_KEY');
  warn('TRELLO_TOKEN');

  if (missing.length > 0) {
    console.warn(`[Config] Missing env vars (some features disabled): ${missing.join(', ')}`);
  }

  return {
    port: parseInt(process.env.PORT || '3000', 10),
    sqsQueueUrl: process.env.SQS_QUEUE_URL || '',
    awsRegion: process.env.AWS_REGION || 'us-east-1',
    claudeOauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN || '',
    ghToken: process.env.GH_TOKEN || '',
    trelloKey: process.env.TRELLO_KEY || '',
    trelloToken: process.env.TRELLO_TOKEN || '',
    trelloWebhookSecret: process.env.TRELLO_WEBHOOK_SECRET,
    slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
    railwayToken: process.env.RAILWAY_TOKEN,
  };
}
