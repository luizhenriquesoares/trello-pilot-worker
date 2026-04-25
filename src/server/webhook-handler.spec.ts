import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as crypto from 'crypto';
import type { Request, Response } from 'express';
import { WebhookHandler } from './webhook-handler.js';
import { SqsProducer } from '../sqs/producer.js';
import { PipelineStage } from '../shared/types/pipeline-stage.js';
import type { BoardConfig } from '../config/types.js';

const BOARD_ID = 'board-1';
const PROJECT_LIST_ID = 'list-project-1';

const boardConfig: BoardConfig = {
  boardId: BOARD_ID,
  lists: { doing: 'l-doing', review: 'l-review', qa: 'l-qa', done: 'l-done' },
  projectLists: [
    {
      id: PROJECT_LIST_ID,
      name: 'Portal Bb2',
      repoUrl: 'https://github.com/maismilhas-br/maismilhas.b2b.portal',
      baseBranch: 'main',
      branchPrefix: 'feat/',
    },
  ],
  rules: ['rule-1'],
};

const trelloCredentials = { key: 'k', token: 't' };

function mockResponse(): Response {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
  } as unknown as Response;
  return res;
}

function mockSqsProducer(): SqsProducer {
  // Only sendMessage is exercised by the webhook path — keep the stub minimal.
  return {
    sendMessage: vi.fn().mockResolvedValue('msg-id-123'),
  } as unknown as SqsProducer;
}

function buildCardCreatedAction() {
  return {
    type: 'createCard',
    data: {
      card: { id: 'card-abc', name: 'Fix login bug', idShort: 42 },
      list: { id: PROJECT_LIST_ID, name: 'Portal Bb2' },
      board: { id: BOARD_ID, name: 'Board' },
    },
  };
}

function buildCardMovedAction(targetListId = PROJECT_LIST_ID, sourceListId = 'l-doing') {
  return {
    type: 'updateCard',
    data: {
      card: { id: 'card-abc', name: 'Fix login bug', idShort: 42 },
      listAfter: { id: targetListId, name: 'X' },
      listBefore: { id: sourceListId, name: 'Y' },
      board: { id: BOARD_ID, name: 'Board' },
    },
  };
}

describe('WebhookHandler.handleWebhook', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('returns 200 only AFTER sendMessage succeeds (createCard)', async () => {
    const sqs = mockSqsProducer();
    const handler = new WebhookHandler(sqs, boardConfig, trelloCredentials, undefined, undefined);
    const req = { body: { action: buildCardCreatedAction() }, headers: {} } as unknown as Request;
    const res = mockResponse();

    await handler.handleWebhook(req, res);

    expect(sqs.sendMessage).toHaveBeenCalledTimes(1);
    const enqueuedEvent = (sqs.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(enqueuedEvent.cardId).toBe('card-abc');
    expect(enqueuedEvent.stage).toBe(PipelineStage.IMPLEMENT);
    expect(enqueuedEvent.repoUrl).toBe('https://github.com/maismilhas-br/maismilhas.b2b.portal');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('returns 503 when SQS sendMessage fails — ensures Trello will redeliver', async () => {
    const sqs = mockSqsProducer();
    (sqs.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('SQS unreachable'));
    const handler = new WebhookHandler(sqs, boardConfig, trelloCredentials, undefined, undefined);
    const req = { body: { action: buildCardCreatedAction() }, headers: {} } as unknown as Request;
    const res = mockResponse();

    await handler.handleWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Failed to enqueue' }));
  });

  it('returns 200 with ignored=... for non-card actions (no SQS call)', async () => {
    const sqs = mockSqsProducer();
    const handler = new WebhookHandler(sqs, boardConfig, trelloCredentials, undefined, undefined);
    const req = {
      body: { action: { type: 'commentCard', data: {} } },
      headers: {},
    } as unknown as Request;
    const res = mockResponse();

    await handler.handleWebhook(req, res);

    expect(sqs.sendMessage).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('ignores card moves into a list that is not a project list', async () => {
    const sqs = mockSqsProducer();
    const handler = new WebhookHandler(sqs, boardConfig, trelloCredentials, undefined, undefined);
    const action = buildCardMovedAction('l-doing'); // not a project list — it's the workflow "doing"
    const req = { body: { action }, headers: {} } as unknown as Request;
    const res = mockResponse();

    await handler.handleWebhook(req, res);

    expect(sqs.sendMessage).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('routes a card in the triage list by label to the matching label-only project', async () => {
    const sqs = mockSqsProducer();
    const triageBoardConfig: BoardConfig = {
      ...boardConfig,
      triageListId: 'l-triage',
      projectLists: [
        ...boardConfig.projectLists,
        { name: 'Admin API', repoUrl: 'https://github.com/maismilhas-br/maismilhas.admin.api', baseBranch: 'main', branchPrefix: 'feat/' },
      ],
    };
    const handler = new WebhookHandler(sqs, triageBoardConfig, trelloCredentials, undefined, undefined);

    // Stub the trello API call that resolveProject uses to fetch labels for triage cards.
    type ResolveStub = (cardId: string, listId: string) => Promise<unknown>;
    (handler as unknown as { resolveProject: ResolveStub }).resolveProject = async (cardId: string, listId: string) => {
      if (listId !== 'l-triage') return undefined;
      void cardId;
      return triageBoardConfig.projectLists.find((p) => !p.id && p.name === 'Admin API');
    };

    const action = buildCardCreatedAction();
    action.data.list.id = 'l-triage';
    const req = { body: { action }, headers: {} } as unknown as Request;
    const res = mockResponse();

    await handler.handleWebhook(req, res);

    expect(sqs.sendMessage).toHaveBeenCalledTimes(1);
    const enqueued = (sqs.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(enqueued.repoUrl).toBe('https://github.com/maismilhas-br/maismilhas.admin.api');
    expect(enqueued.projectName).toBe('Admin API');
    // For label-routed cards we anchor the stale guard on the triage list id.
    expect(enqueued.originListId).toBe('l-triage');
  });

  it('detects retry mode when card moves from Done back to a project list', async () => {
    const sqs = mockSqsProducer();
    // Stub fetchRetryFeedback so we don't make a real Trello API call.
    const handler = new WebhookHandler(sqs, boardConfig, trelloCredentials, undefined, undefined);
    (handler as unknown as { fetchRetryFeedback: typeof fetch }).fetchRetryFeedback = vi
      .fn()
      .mockResolvedValue('previous failure context');

    const action = buildCardMovedAction(PROJECT_LIST_ID, 'l-done');
    const req = { body: { action }, headers: {} } as unknown as Request;
    const res = mockResponse();

    await handler.handleWebhook(req, res);

    const enqueued = (sqs.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(enqueued.isRetry).toBe(true);
    expect(enqueued.retryFeedback).toBe('previous failure context');
  });
});

describe('WebhookHandler HMAC verification', () => {
  const SECRET = 'trello-app-secret';
  const CALLBACK = 'https://taskpilot.maismilhas.com.br/webhook';

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  function sign(body: string, callbackUrl: string, secret: string): string {
    return crypto.createHmac('sha1', secret).update(body + callbackUrl).digest('base64');
  }

  it('accepts a correctly signed request and enqueues', async () => {
    const sqs = mockSqsProducer();
    const handler = new WebhookHandler(sqs, boardConfig, trelloCredentials, SECRET, CALLBACK);
    const action = buildCardCreatedAction();
    const rawBody = JSON.stringify({ action });
    const sig = sign(rawBody, CALLBACK, SECRET);

    const req = {
      body: { action },
      rawBody,
      headers: { 'x-trello-webhook': sig },
    } as unknown as Request;
    const res = mockResponse();

    await handler.handleWebhook(req, res);

    expect(sqs.sendMessage).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('rejects with 401 when signature header is missing', async () => {
    const sqs = mockSqsProducer();
    const handler = new WebhookHandler(sqs, boardConfig, trelloCredentials, SECRET, CALLBACK);
    const req = { body: { action: buildCardCreatedAction() }, rawBody: '{}', headers: {} } as unknown as Request;
    const res = mockResponse();

    await handler.handleWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(sqs.sendMessage).not.toHaveBeenCalled();
  });

  it('rejects with 401 when signature does not match the body', async () => {
    const sqs = mockSqsProducer();
    const handler = new WebhookHandler(sqs, boardConfig, trelloCredentials, SECRET, CALLBACK);
    const action = buildCardCreatedAction();
    const rawBody = JSON.stringify({ action });
    const tamperedSig = sign('{"action":"different"}', CALLBACK, SECRET);

    const req = {
      body: { action },
      rawBody,
      headers: { 'x-trello-webhook': tamperedSig },
    } as unknown as Request;
    const res = mockResponse();

    await handler.handleWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(sqs.sendMessage).not.toHaveBeenCalled();
  });

  it('returns 500 when secret is set but rawBody is missing — surfaces misconfiguration loudly', async () => {
    const sqs = mockSqsProducer();
    const handler = new WebhookHandler(sqs, boardConfig, trelloCredentials, SECRET, CALLBACK);
    // rawBody intentionally absent — simulates the express.json verify hook not being wired.
    const sig = sign('whatever', CALLBACK, SECRET);
    const req = { body: { action: buildCardCreatedAction() }, headers: { 'x-trello-webhook': sig } } as unknown as Request;
    const res = mockResponse();

    await handler.handleWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(sqs.sendMessage).not.toHaveBeenCalled();
  });

  it('returns 500 when secret is set but callbackUrl is missing — refuses unverifiable requests', async () => {
    const sqs = mockSqsProducer();
    const handler = new WebhookHandler(sqs, boardConfig, trelloCredentials, SECRET, undefined);
    const req = {
      body: { action: buildCardCreatedAction() },
      rawBody: '{}',
      headers: { 'x-trello-webhook': 'irrelevant' },
    } as unknown as Request;
    const res = mockResponse();

    await handler.handleWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(sqs.sendMessage).not.toHaveBeenCalled();
  });

  it('skips verification entirely when no secret is configured (dev mode)', async () => {
    const sqs = mockSqsProducer();
    const handler = new WebhookHandler(sqs, boardConfig, trelloCredentials, undefined, undefined);
    const req = { body: { action: buildCardCreatedAction() }, headers: {} } as unknown as Request;
    const res = mockResponse();

    await handler.handleWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(sqs.sendMessage).toHaveBeenCalled();
  });
});
