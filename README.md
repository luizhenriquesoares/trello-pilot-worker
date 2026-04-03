# TaskPilot Worker

Headless CI/CD pipeline that automates software development from Trello card to production deploy. Receives webhook events from Trello, runs Claude Code (Opus) for implementation, code review, and QA, then deploys via Railway.

Part of the **TaskPilot** ecosystem:
- [taskpilot-app](https://github.com/luizhenriquesoares/taskpilot-app) — Web app for creating tasks via text/voice
- [taskpilot-vscode](https://github.com/luizhenriquesoares/taskpilot-vscode) — VS Code extension for interactive development
- **taskpilot-worker** (this repo) — Headless automation server

## Architecture

```
Trello Webhook → Express Server → SQS Queue → Pipeline Orchestrator
                                                    │
                                          ┌─────────┼─────────┐
                                          ▼         ▼         ▼
                                      IMPLEMENT   REVIEW      QA
                                      (Claude)   (Claude)  (Claude)
                                          │         │         │
                                          └─────────┼─────────┘
                                                    ▼
                                            Deploy Watcher
                                            (Railway API)
                                                    ▼
                                              Card → Done
```

### Pipeline Flow

1. **Webhook** — Trello card created/moved to a project list triggers SQS message
2. **Stale guard** — Verifies card is still in the expected list (prevents duplicate processing)
3. **IMPLEMENT** — Clones repo, loads CLAUDE.md knowledge, runs Claude Opus to implement the task, pushes branch, creates PR
4. **REVIEW** — Claude reviews the code for bugs, security, SOLID compliance, project rules
5. **QA** — Claude runs type checks, tests, validates implementation, merges PR via squash
6. **Deploy Watch** — Polls Railway API until deploy succeeds, then moves card to Done

Stages 3-5 run **inline** (no SQS between them) for speed. The full pipeline typically completes in ~9-12 minutes.

## Project Structure

```
src/
├── index.ts                    # Entry point, SQS poll loop, Express server
├── server/
│   ├── routes.ts               # HTTP endpoints (health, jobs, logs)
│   ├── webhook-handler.ts      # Trello webhook → SQS
│   └── websocket.ts            # Real-time event streaming to TaskPilot App
├── pipeline/
│   ├── orchestrator.ts         # Stage sequencing, repo locks, inline pipeline
│   └── stages/
│       ├── implement.ts        # Clone → branch → Claude implement → PR
│       ├── review.ts           # Claude code review
│       └── qa.ts               # Claude QA → merge → cleanup
├── claude/
│   ├── headless-runner.ts      # Spawns Claude CLI with stream-json parsing
│   ├── prompt-builder.ts       # Builds prompts for each stage (with image support)
│   ├── knowledge.ts            # CLAUDE.md loading + project knowledge cache
│   └── cost-parser.ts          # Extracts cost from Claude stream output
├── sqs/
│   ├── consumer.ts             # Polls up to 5 messages, parallel processing
│   └── producer.ts             # Enqueues events with pipeline context
├── trello/
│   ├── api.ts                  # Trello REST API wrapper
│   └── types.ts                # TrelloCard, BoardConfig, etc.
├── git/
│   └── repo-manager.ts         # Clone, branch, push, PR, merge
├── deploy/
│   └── watcher.ts              # Railway deploy polling + stuck card recovery
├── notifications/
│   ├── trello-commenter.ts     # Card comments at each stage
│   └── slack.ts                # Slack webhook notifications
├── tracking/
│   ├── job-tracker.ts          # Job history (in-memory)
│   └── log-buffer.ts           # Log capture for UI
├── config/
│   ├── board-config.ts         # Loads config.json / BOARD_CONFIG_JSON
│   ├── env.ts                  # Environment variables
│   └── types.ts                # Config interfaces
└── shared/
    └── types/
        ├── pipeline-stage.ts   # IMPLEMENT | REVIEW | QA
        └── worker-event.ts     # SQS message payload
```

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SQS_QUEUE_URL` | Yes | AWS SQS queue URL for job messages |
| `AWS_REGION` | Yes | AWS region (e.g., `us-east-1`) |
| `AWS_ACCESS_KEY_ID` | Yes | AWS credentials for SQS |
| `AWS_SECRET_ACCESS_KEY` | Yes | AWS credentials for SQS |
| `GH_TOKEN` | Yes | GitHub token for cloning private repos and creating PRs |
| `TRELLO_KEY` | Yes | Trello API key |
| `TRELLO_TOKEN` | Yes | Trello API token |
| `CLAUDE_OAUTH_TOKEN` | Yes | Claude Code authentication token |
| `RAILWAY_TOKEN` | No | Railway API token for deploy verification |
| `SLACK_WEBHOOK_URL` | No | Slack webhook for pipeline notifications |
| `TRELLO_WEBHOOK_SECRET` | No | Trello webhook signature verification |
| `PORT` | No | Server port (default: 8080) |

### Board Config (`config.json`)

Maps Trello lists to pipeline stages and repos:

```json
{
  "boardId": "trello-board-id",
  "lists": {
    "doing": "list-id",
    "review": "list-id",
    "qa": "list-id",
    "done": "list-id"
  },
  "projectLists": [
    {
      "id": "trello-list-id",
      "name": "ProjectName",
      "repoUrl": "https://github.com/org/repo",
      "baseBranch": "main",
      "branchPrefix": "feat/",
      "railwayProjectId": "railway-project-uuid"
    }
  ],
  "rules": ["Project-specific rules for Claude to follow"]
}
```

Can also be provided via `BOARD_CONFIG_JSON` env var.

## Key Features

### Inline Pipeline
IMPLEMENT → REVIEW → QA run sequentially in the same process without SQS roundtrips between stages. Saves ~30-60s per card.

### CLAUDE.md Knowledge
If the target repo has a `CLAUDE.md`, it's loaded directly as project context (zero cost, instant). Falls back to persistent cache, then Claude-generated knowledge.

### Stale Message Guard
Before processing IMPLEMENT, verifies the card is still in the expected project list. Prevents duplicate processing when cards are moved between project lists.

### Image Attachments
Downloads image attachments from Trello cards (mockups, screenshots) and passes them to Claude for visual context.

### Parallel SQS Processing
Polls up to 5 messages at once. Cards targeting different repos process concurrently. Same-repo cards are serialized via repo locks.

### Deploy Watcher
Polls Railway every 30s after QA merge. On success, moves card to Done with summary comment. On worker restart, recovers stuck QA cards by scanning for recent successful deploys.

### Notifications
- **Trello comments** — progress at each stage with project name, duration, cost
- **Slack** — stage start, pipeline complete with commit summary, errors
- **WebSocket** — real-time event streaming to TaskPilot App

### Checklist Marking
After QA passes, all checklist items on the Trello card are marked as complete.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `POST` | `/webhook/trello` | Trello webhook receiver |
| `HEAD` | `/webhook/trello` | Trello webhook verification |
| `GET` | `/api/jobs` | Job history |
| `POST` | `/api/jobs/clear` | Clear job history |
| `GET` | `/api/logs` | Recent logs |
| `GET` | `/api/deploys` | Railway deploy status |
| `WS` | `/ws` | Real-time event stream |

## Development

```bash
npm install
npm run dev     # Watch mode with tsup
npm run build   # Production build
npm start       # Run production
```

## Deployment

Deployed on Railway. Pushes to `main` trigger automatic redeploy.

Required Railway setup:
- Node.js environment
- Environment variables configured
- Claude Code CLI installed in container
- GitHub CLI (`gh`) available
