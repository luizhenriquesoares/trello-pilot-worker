import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PipelineOrchestrator } from './orchestrator.js';
import { ImplementStage } from './stages/implement.js';
import { ReviewStage } from './stages/review.js';
import { QaStage } from './stages/qa.js';
import { SqsProducer } from '../sqs/producer.js';
import { TrelloApi } from '../trello/api.js';
import { TrelloCommenter } from '../notifications/trello-commenter.js';
import { SlackNotifier } from '../notifications/slack.js';
import { PipelineStage } from '../shared/types/pipeline-stage.js';
import { isPermanentError } from '../shared/errors.js';
import type { BoardConfig } from '../config/types.js';
import type { WorkerEvent } from '../shared/types/worker-event.js';

const boardConfig: BoardConfig = {
  boardId: 'b1',
  lists: { doing: 'l-doing', review: 'l-review', qa: 'l-qa', done: 'l-done' },
  projectLists: [],
  rules: [],
};

const event: WorkerEvent = {
  cardId: 'card-1',
  boardId: 'b1',
  stage: PipelineStage.IMPLEMENT,
  repoUrl: 'https://github.com/org/repo',
  baseBranch: 'main',
  branchPrefix: 'feat/',
  rules: [],
  originListId: 'l-todo',
  projectName: 'Project X',
  trelloCredentials: { key: 'k', token: 't' },
};

function buildOrchestrator(opts: {
  implementResult: Awaited<ReturnType<ImplementStage['execute']>>;
}) {
  const implementStage = {
    execute: vi.fn().mockResolvedValue(opts.implementResult),
  } as unknown as ImplementStage;

  const reviewExecute = vi.fn();
  const qaExecute = vi.fn();
  const reviewStage = { execute: reviewExecute } as unknown as ReviewStage;
  const qaStage = { execute: qaExecute } as unknown as QaStage;

  const sqsProducer = {
    sendWithDelay: vi.fn().mockResolvedValue(undefined),
  } as unknown as SqsProducer;

  const trelloApi = {
    // getCard is called twice in processEvent (cardName lookup + stale guard)
    getCard: vi.fn().mockResolvedValue({ id: 'card-1', name: 'Some Card', idList: 'l-todo' }),
    moveCard: vi.fn().mockResolvedValue(undefined),
    getCardChecklists: vi.fn().mockResolvedValue([]),
  } as unknown as TrelloApi;

  const postError = vi.fn().mockResolvedValue(undefined);
  const commenter = {
    postError,
    postImplementComplete: vi.fn().mockResolvedValue(undefined),
    postReviewStarted: vi.fn().mockResolvedValue(undefined),
    postReviewComplete: vi.fn().mockResolvedValue(undefined),
    postQaStarted: vi.fn().mockResolvedValue(undefined),
    postQaComplete: vi.fn().mockResolvedValue(undefined),
    postDoneSummary: vi.fn().mockResolvedValue(undefined),
  } as unknown as TrelloCommenter;

  const slackNotifier = {
    notifyStageStart: vi.fn().mockResolvedValue(undefined),
    notifyError: vi.fn().mockResolvedValue(undefined),
    notifyComplete: vi.fn().mockResolvedValue(undefined),
  } as unknown as SlackNotifier;

  const orchestrator = new PipelineOrchestrator(
    implementStage,
    reviewStage,
    qaStage,
    sqsProducer,
    trelloApi,
    commenter,
    slackNotifier,
    boardConfig,
  );

  return { orchestrator, reviewExecute, qaExecute, postError, slackNotifier, sqsProducer };
}

describe('PipelineOrchestrator — no-diff guard', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('halts the pipeline before REVIEW when IMPLEMENT produces no commits', async () => {
    const { orchestrator, reviewExecute, qaExecute, postError } = buildOrchestrator({
      implementResult: {
        branchName: 'feat/empty',
        prUrl: '',
        workDir: '/tmp/no-such-dir', // cleanup will no-op on a missing path
        costUsd: 0,
        durationMs: 100,
        commitSummary: '', // ← the key: nothing was committed
      },
    });

    await expect(orchestrator.processEvent(event)).rejects.toThrow(/no commits/i);

    expect(reviewExecute).not.toHaveBeenCalled();
    expect(qaExecute).not.toHaveBeenCalled();
    expect(postError).toHaveBeenCalledTimes(1);
  });

  it('throws a PermanentError so SQS does not retry the same empty implementation', async () => {
    const { orchestrator } = buildOrchestrator({
      implementResult: {
        branchName: 'feat/empty',
        prUrl: '',
        workDir: '/tmp/no-such-dir',
        costUsd: 0,
        durationMs: 100,
        commitSummary: '',
      },
    });

    let captured: unknown;
    await orchestrator.processEvent(event).catch((err) => { captured = err; });

    expect(captured).toBeDefined();
    expect(isPermanentError(captured)).toBe(true);
  });

  it('whitespace-only commitSummary still trips the guard (no fake "previous run" string)', async () => {
    const { orchestrator, reviewExecute } = buildOrchestrator({
      implementResult: {
        branchName: 'feat/empty',
        prUrl: '',
        workDir: '/tmp/no-such-dir',
        costUsd: 0,
        durationMs: 100,
        commitSummary: '   \n\t  ', // looks non-empty but is just whitespace
      },
    });

    await expect(orchestrator.processEvent(event)).rejects.toThrow(/no commits/i);
    expect(reviewExecute).not.toHaveBeenCalled();
  });
});

describe('PipelineOrchestrator — repo lock management', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function buildIdleOrchestrator() {
    return buildOrchestrator({
      implementResult: {
        branchName: 'feat/x',
        prUrl: '',
        workDir: '/tmp/no-such-dir',
        costUsd: 0,
        durationMs: 0,
        commitSummary: 'noop', // skip the no-diff guard so we hit the lock release
      },
    });
  }

  it('listRepoLocks() reports nothing when idle', () => {
    const { orchestrator } = buildIdleOrchestrator();
    expect(orchestrator.listRepoLocks()).toEqual([]);
  });

  it('releaseRepoLock() returns released:false when there is no lock', () => {
    const { orchestrator } = buildIdleOrchestrator();
    const result = orchestrator.releaseRepoLock('https://github.com/org/missing');
    expect(result).toEqual({ released: false });
  });

  it('lock auto-expires past TTL — second card steals it instead of being re-enqueued', async () => {
    // 65min TTL + a hair of slack
    const STALE_MS = 70 * 60 * 1000;
    vi.useFakeTimers();
    const t0 = Date.now();

    const { orchestrator, sqsProducer } = buildIdleOrchestrator();

    // Plant a stale lock from a phantom previous card by reaching into the Map.
    // Going through processEvent for the first card would also work, but it would
    // run the whole pipeline; planting is the surgical setup for this assertion.
    (orchestrator as unknown as { repoLocks: Map<string, { cardId: string; acquiredAt: number }> })
      .repoLocks.set(event.repoUrl, { cardId: 'orphaned-card', acquiredAt: t0 });

    vi.setSystemTime(t0 + STALE_MS);

    // Second card hits processEvent. The stale lock should be reassigned, NOT
    // cause a re-enqueue with delay.
    await orchestrator.processEvent({ ...event, cardId: 'card-2' }).catch(() => { /* pipeline mocks throw — irrelevant */ });

    expect(sqsProducer.sendWithDelay).not.toHaveBeenCalled();
  });

  it('lock within TTL still re-enqueues the second card', async () => {
    vi.useFakeTimers();
    const t0 = Date.now();

    const { orchestrator, sqsProducer } = buildIdleOrchestrator();

    (orchestrator as unknown as { repoLocks: Map<string, { cardId: string; acquiredAt: number }> })
      .repoLocks.set(event.repoUrl, { cardId: 'still-running', acquiredAt: t0 });

    // 10min — well under the 65min TTL
    vi.setSystemTime(t0 + 10 * 60 * 1000);

    await orchestrator.processEvent({ ...event, cardId: 'card-2' });

    expect(sqsProducer.sendWithDelay).toHaveBeenCalledTimes(1);
    expect(sqsProducer.sendWithDelay).toHaveBeenCalledWith(
      expect.objectContaining({ event: expect.objectContaining({ cardId: 'card-2' }) }),
      60,
    );
  });

  it('releaseRepoLock() removes a held lock and returns the previous holder', () => {
    const { orchestrator } = buildIdleOrchestrator();

    (orchestrator as unknown as { repoLocks: Map<string, { cardId: string; acquiredAt: number }> })
      .repoLocks.set('https://github.com/org/repo', { cardId: 'stuck-card', acquiredAt: Date.now() });

    const result = orchestrator.releaseRepoLock('https://github.com/org/repo');
    expect(result).toEqual({ released: true, previousCardId: 'stuck-card' });
    expect(orchestrator.listRepoLocks()).toEqual([]);
  });
});
