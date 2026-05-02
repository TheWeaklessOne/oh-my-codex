import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  claimPendingRouteForOwnerCompletion,
  consumePendingRouteForOwnerCompletion,
  expirePendingRoutes,
  markPendingRouteSent,
  markPendingRouteTerminalFailure,
  markPendingRoutesWaitingForOwner,
  pendingRoutesStatePath,
  recordPendingRoute,
} from '../pending-routes.js';
import { registerExternalOwnerActor } from '../../runtime/session-actors.js';

let projectRoot = '';

describe('pending-routes', () => {
  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'omx-pending-routes-'));
  });

  afterEach(async () => {
    if (projectRoot) {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('matches routes by input hash and consumes repeated identical owner replies FIFO', async () => {
    const sessionId = 'sess-pending-route-fifo';
    const owner = await registerExternalOwnerActor({
      cwd: projectRoot,
      sessionId,
      nativeSessionId: 'leader-pending-route-fifo',
      source: 'test-owner',
      now: new Date('2026-04-30T00:00:00.000Z'),
    });

    await recordPendingRoute(projectRoot, sessionId, {
      platform: 'telegram',
      injectedInput: 'same follow-up',
      createdAt: '2026-04-30T00:00:01.000Z',
    });
    await recordPendingRoute(projectRoot, sessionId, {
      platform: 'telegram',
      injectedInput: 'same follow-up',
      createdAt: '2026-04-30T00:00:02.000Z',
    });

    const first = await consumePendingRouteForOwnerCompletion(projectRoot, sessionId, {
      ownerActorId: owner.actor.actorId,
      latestInput: 'same follow-up',
      completedAt: '2026-04-30T00:00:03.000Z',
    });
    const second = await consumePendingRouteForOwnerCompletion(projectRoot, sessionId, {
      ownerActorId: owner.actor.actorId,
      latestInput: 'same follow-up',
      completedAt: '2026-04-30T00:00:04.000Z',
    });

    assert.equal(first?.createdAt, '2026-04-30T00:00:01.000Z');
    assert.equal(second?.createdAt, '2026-04-30T00:00:02.000Z');
  });

  it('keeps pending routes waiting when a child/subagent completion arrives', async () => {
    const sessionId = 'sess-pending-route-child';
    const owner = await registerExternalOwnerActor({
      cwd: projectRoot,
      sessionId,
      nativeSessionId: 'leader-pending-route-child',
      source: 'test-owner',
    });
    await recordPendingRoute(projectRoot, sessionId, {
      platform: 'telegram',
      injectedInput: 'child must not consume this',
      createdAt: '2026-04-30T00:00:00.000Z',
    });

    const marked = await markPendingRoutesWaitingForOwner(projectRoot, sessionId, {
      ownerActorId: owner.actor.actorId,
      reason: 'non_owner_actor',
      observedAt: '2026-04-30T00:00:01.000Z',
    });
    assert.equal(marked, 1);

    const state = JSON.parse(await readFile(pendingRoutesStatePath(projectRoot, sessionId), 'utf-8')) as {
      routes?: Array<{ status?: string; lastNonTerminalStatus?: string }>;
    };
    assert.equal(state.routes?.length, 1);
    assert.equal(state.routes?.[0]?.status, 'waiting-for-owner');
    assert.equal(state.routes?.[0]?.lastNonTerminalStatus, 'suppressed-non-terminal');

    const consumed = await consumePendingRouteForOwnerCompletion(projectRoot, sessionId, {
      ownerActorId: owner.actor.actorId,
      latestInput: 'child must not consume this',
      completedAt: '2026-04-30T00:00:02.000Z',
    });
    assert.equal(consumed?.injectedInput, 'child must not consume this');
  });


  it('claims a matching route as dispatching and marks it completed only after delivery succeeds', async () => {
    const sessionId = 'sess-pending-route-claim-sent';
    const owner = await registerExternalOwnerActor({
      cwd: projectRoot,
      sessionId,
      nativeSessionId: 'leader-pending-route-claim-sent',
      source: 'test-owner',
    });
    await recordPendingRoute(projectRoot, sessionId, {
      platform: 'telegram',
      injectedInput: 'deliver after claim',
      createdAt: '2026-04-30T00:00:00.000Z',
      telegramAck: { chatId: '777', messageId: '10', messageThreadId: '99' },
    });

    const claimed = await claimPendingRouteForOwnerCompletion(projectRoot, sessionId, {
      ownerActorId: owner.actor.actorId,
      latestInput: 'deliver after claim',
      claimedAt: '2026-04-30T00:00:01.000Z',
    });
    assert.ok(claimed?.routeId);

    const dispatchingState = JSON.parse(await readFile(pendingRoutesStatePath(projectRoot, sessionId), 'utf-8')) as {
      routes?: Array<{ routeId?: string; status?: string }>;
      terminal?: Array<unknown>;
    };
    assert.equal(dispatchingState.routes?.length, 1);
    assert.equal(dispatchingState.routes?.[0]?.routeId, claimed.routeId);
    assert.equal(dispatchingState.routes?.[0]?.status, 'dispatching');
    assert.equal(dispatchingState.terminal?.length, 0);

    const marked = await markPendingRouteSent(projectRoot, sessionId, claimed.routeId, {
      terminalAt: '2026-04-30T00:00:02.000Z',
    });
    assert.equal(marked, true);

    const sentState = JSON.parse(await readFile(pendingRoutesStatePath(projectRoot, sessionId), 'utf-8')) as {
      routes?: Array<unknown>;
      terminal?: Array<{ routeId?: string; status?: string }>;
    };
    assert.deepEqual(sentState.routes, []);
    assert.equal(sentState.terminal?.length, 1);
    assert.equal(sentState.terminal?.[0]?.routeId, claimed.routeId);
    assert.equal(sentState.terminal?.[0]?.status, 'completed');
  });

  it('does not claim an already-dispatching route a second time', async () => {
    const sessionId = 'sess-pending-route-double-claim';
    const owner = await registerExternalOwnerActor({
      cwd: projectRoot,
      sessionId,
      nativeSessionId: 'leader-pending-route-double-claim',
      source: 'test-owner',
    });
    await recordPendingRoute(projectRoot, sessionId, {
      platform: 'telegram',
      injectedInput: 'claim only once',
      createdAt: '2026-04-30T00:00:00.000Z',
    });

    const first = await claimPendingRouteForOwnerCompletion(projectRoot, sessionId, {
      ownerActorId: owner.actor.actorId,
      latestInput: 'claim only once',
      claimedAt: '2026-04-30T00:00:01.000Z',
    });
    const second = await claimPendingRouteForOwnerCompletion(projectRoot, sessionId, {
      ownerActorId: owner.actor.actorId,
      latestInput: 'claim only once',
      claimedAt: '2026-04-30T00:00:02.000Z',
    });

    assert.ok(first?.routeId);
    assert.equal(second, null);
  });

  it('leader completion consumes exactly one matching route and records a completed terminal outcome', async () => {
    const sessionId = 'sess-pending-route-cleanup';
    const owner = await registerExternalOwnerActor({
      cwd: projectRoot,
      sessionId,
      nativeSessionId: 'leader-pending-route-cleanup',
      source: 'test-owner',
    });
    await recordPendingRoute(projectRoot, sessionId, {
      platform: 'telegram',
      injectedInput: 'first input',
      createdAt: '2026-04-30T00:00:00.000Z',
      telegramAck: { chatId: '777', messageId: '10', messageThreadId: '99' },
      telegramReplyTo: { chatId: '777', messageId: '9', messageThreadId: '99' },
    });
    await recordPendingRoute(projectRoot, sessionId, {
      platform: 'telegram',
      injectedInput: 'second input',
      createdAt: '2026-04-30T00:00:01.000Z',
    });

    const consumed = await consumePendingRouteForOwnerCompletion(projectRoot, sessionId, {
      ownerActorId: owner.actor.actorId,
      latestInput: 'first input',
      completedAt: '2026-04-30T00:00:02.000Z',
    });

    assert.equal(consumed?.telegramAck?.messageId, '10');
    assert.equal(consumed?.telegramReplyTo?.messageId, '9');
    const state = JSON.parse(await readFile(pendingRoutesStatePath(projectRoot, sessionId), 'utf-8')) as {
      routes?: Array<{ injectedInput?: string }>;
      terminal?: Array<{ routeId?: string; status?: string }>;
    };
    assert.deepEqual(state.routes?.map((route) => route.injectedInput), ['second input']);
    assert.equal(state.terminal?.length, 1);
    assert.equal(state.terminal?.[0]?.status, 'completed');
  });

  it('expires stale routes before owner completion can consume them', async () => {
    const sessionId = 'sess-pending-route-expired-before-complete';
    const owner = await registerExternalOwnerActor({
      cwd: projectRoot,
      sessionId,
      nativeSessionId: 'leader-pending-route-expired-before-complete',
      source: 'test-owner',
    });
    await recordPendingRoute(projectRoot, sessionId, {
      platform: 'telegram',
      injectedInput: 'stale input',
      createdAt: '2026-04-30T00:00:00.000Z',
      ttlMs: 1,
      telegramAck: { chatId: '777', messageId: '10' },
    });

    const consumed = await consumePendingRouteForOwnerCompletion(projectRoot, sessionId, {
      ownerActorId: owner.actor.actorId,
      latestInput: 'stale input',
      completedAt: '2026-04-30T00:00:01.000Z',
    });

    assert.equal(consumed, null);
    const state = JSON.parse(await readFile(pendingRoutesStatePath(projectRoot, sessionId), 'utf-8')) as {
      routes?: Array<{ injectedInput?: string }>;
      terminal?: Array<{ status?: string; terminalReason?: string; injectedInput?: string }>;
    };
    assert.deepEqual(state.routes, []);
    assert.equal(state.terminal?.length, 1);
    assert.equal(state.terminal?.[0]?.status, 'expired');
    assert.equal(state.terminal?.[0]?.terminalReason, 'route_ttl_expired');
    assert.equal(state.terminal?.[0]?.injectedInput, 'stale input');
  });

  it('can mark a dispatching route as failed after delivery failure', async () => {
    const sessionId = 'sess-pending-route-failed-after-complete';
    const owner = await registerExternalOwnerActor({
      cwd: projectRoot,
      sessionId,
      nativeSessionId: 'leader-pending-route-failed-after-complete',
      source: 'test-owner',
    });
    await recordPendingRoute(projectRoot, sessionId, {
      platform: 'telegram',
      injectedInput: 'delivery will fail',
      createdAt: '2026-04-30T00:00:00.000Z',
    });

    const claimed = await claimPendingRouteForOwnerCompletion(projectRoot, sessionId, {
      ownerActorId: owner.actor.actorId,
      latestInput: 'delivery will fail',
      claimedAt: '2026-04-30T00:00:01.000Z',
    });
    assert.ok(claimed?.routeId);

    const marked = await markPendingRouteTerminalFailure(projectRoot, sessionId, claimed.routeId, {
      status: 'failed',
      reason: 'telegram delivery failed',
      terminalAt: '2026-04-30T00:00:02.000Z',
    });
    assert.equal(marked, true);

    const state = JSON.parse(await readFile(pendingRoutesStatePath(projectRoot, sessionId), 'utf-8')) as {
      terminal?: Array<{ routeId?: string; status?: string; terminalReason?: string }>;
    };
    assert.equal(state.terminal?.length, 1);
    assert.equal(state.terminal?.[0]?.routeId, claimed.routeId);
    assert.equal(state.terminal?.[0]?.status, 'failed');
    assert.equal(state.terminal?.[0]?.terminalReason, 'telegram delivery failed');
  });

  it('does not overwrite a completed terminal route with a later failure', async () => {
    const sessionId = 'sess-pending-route-completed-wins';
    const owner = await registerExternalOwnerActor({
      cwd: projectRoot,
      sessionId,
      nativeSessionId: 'leader-pending-route-completed-wins',
      source: 'test-owner',
    });
    await recordPendingRoute(projectRoot, sessionId, {
      platform: 'telegram',
      injectedInput: 'already delivered',
      createdAt: '2026-04-30T00:00:00.000Z',
    });
    const claimed = await claimPendingRouteForOwnerCompletion(projectRoot, sessionId, {
      ownerActorId: owner.actor.actorId,
      latestInput: 'already delivered',
      claimedAt: '2026-04-30T00:00:01.000Z',
    });
    assert.ok(claimed?.routeId);
    assert.equal(await markPendingRouteSent(projectRoot, sessionId, claimed.routeId), true);

    const failed = await markPendingRouteTerminalFailure(projectRoot, sessionId, claimed.routeId, {
      status: 'failed',
      reason: 'late failure from duplicate sender',
      terminalAt: '2026-04-30T00:00:02.000Z',
    });
    assert.equal(failed, false);

    const state = JSON.parse(await readFile(pendingRoutesStatePath(projectRoot, sessionId), 'utf-8')) as {
      terminal?: Array<{ routeId?: string; status?: string; terminalReason?: string }>;
    };
    assert.equal(state.terminal?.length, 1);
    assert.equal(state.terminal?.[0]?.routeId, claimed.routeId);
    assert.equal(state.terminal?.[0]?.status, 'completed');
    assert.equal(state.terminal?.[0]?.terminalReason, undefined);
  });

  it('expires pending routes explicitly without consuming them', async () => {
    const sessionId = 'sess-pending-route-expire-explicit';
    await registerExternalOwnerActor({
      cwd: projectRoot,
      sessionId,
      nativeSessionId: 'leader-pending-route-expire-explicit',
      source: 'test-owner',
    });
    await recordPendingRoute(projectRoot, sessionId, {
      platform: 'telegram',
      injectedInput: 'expire explicitly',
      createdAt: '2026-04-30T00:00:00.000Z',
      ttlMs: 1,
    });

    const expired = await expirePendingRoutes(projectRoot, sessionId, new Date('2026-04-30T00:00:01.000Z'));
    assert.equal(expired.length, 1);
    assert.equal(expired[0]?.status, 'expired');
    assert.equal(expired[0]?.injectedInput, 'expire explicitly');
  });

  it('preserves concurrent pending route records under the per-session lock', async () => {
    const sessionId = 'sess-pending-route-lock';
    await registerExternalOwnerActor({
      cwd: projectRoot,
      sessionId,
      nativeSessionId: 'leader-pending-route-lock',
      source: 'test-owner',
    });

    await Promise.all(Array.from({ length: 8 }, (_, index) =>
      recordPendingRoute(projectRoot, sessionId, {
        platform: 'telegram',
        injectedInput: `concurrent input ${index}`,
        createdAt: `2026-04-30T00:00:0${index}.000Z`,
      })
    ));

    const state = JSON.parse(await readFile(pendingRoutesStatePath(projectRoot, sessionId), 'utf-8')) as {
      routes?: Array<{ injectedInput?: string }>;
    };
    assert.deepEqual(
      state.routes?.map((route) => route.injectedInput).sort(),
      Array.from({ length: 8 }, (_, index) => `concurrent input ${index}`).sort(),
    );
  });
});
