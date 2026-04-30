import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  consumePendingReplyOrigin,
  recordPendingReplyOrigin,
} from '../reply-origin-state.js';
import { registerExternalOwnerActor } from '../../runtime/session-actors.js';

let projectRoot = '';

describe('reply-origin-state', () => {
  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'omx-reply-origin-state-'));
  });

  afterEach(async () => {
    if (projectRoot) {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  async function ensureOwner(sessionId: string): Promise<void> {
    await registerExternalOwnerActor({
      cwd: projectRoot,
      sessionId,
      nativeSessionId: `${sessionId}-leader`,
      source: 'test-owner',
    });
  }

  function recentIso(offsetMs = 0): string {
    return new Date(Date.now() + offsetMs).toISOString();
  }

  it('preserves unmatched pending provenance for a later matching turn', async () => {
    await ensureOwner('sess-mismatch-preserve');
    await recordPendingReplyOrigin(projectRoot, 'sess-mismatch-preserve', {
      platform: 'telegram',
      injectedInput: 'second reply',
      createdAt: recentIso(),
    });

    const mismatch = await consumePendingReplyOrigin(
      projectRoot,
      'sess-mismatch-preserve',
      'different input',
    );
    const match = await consumePendingReplyOrigin(
      projectRoot,
      'sess-mismatch-preserve',
      'second reply',
    );

    assert.equal(mismatch, null);
    assert.ok(match);
    assert.equal(match.platform, 'telegram');
    assert.equal(match.injectedInput, 'second reply');
  });

  it('queues multiple pending replies for the same session instead of overwriting them', async () => {
    await ensureOwner('sess-queue');
    await recordPendingReplyOrigin(projectRoot, 'sess-queue', {
      platform: 'telegram',
      injectedInput: 'first reply',
      createdAt: recentIso(),
    });
    await recordPendingReplyOrigin(projectRoot, 'sess-queue', {
      platform: 'discord',
      injectedInput: 'second reply',
      createdAt: recentIso(1000),
    });

    const first = await consumePendingReplyOrigin(projectRoot, 'sess-queue', 'first reply');
    const second = await consumePendingReplyOrigin(projectRoot, 'sess-queue', 'second reply');

    assert.ok(first);
    assert.equal(first.platform, 'telegram');
    assert.ok(second);
    assert.equal(second.platform, 'discord');
  });

  it('preserves Telegram placeholder cleanup and final reply targets', async () => {
    await ensureOwner('sess-telegram-targets');
    await recordPendingReplyOrigin(projectRoot, 'sess-telegram-targets', {
      platform: 'telegram',
      injectedInput: 'topic launch prompt',
      createdAt: recentIso(),
      telegramAck: {
        chatId: '777',
        messageId: '551',
        messageThreadId: '9001',
      },
      telegramReplyTo: {
        chatId: '777',
        messageId: '350',
        messageThreadId: '9001',
      },
    });

    const origin = await consumePendingReplyOrigin(
      projectRoot,
      'sess-telegram-targets',
      'topic launch prompt',
    );

    assert.deepEqual(origin?.telegramAck, {
      chatId: '777',
      messageId: '551',
      messageThreadId: '9001',
    });
    assert.deepEqual(origin?.telegramReplyTo, {
      chatId: '777',
      messageId: '350',
      messageThreadId: '9001',
    });
  });

  it('consumes repeated identical replies in FIFO order', async () => {
    await ensureOwner('sess-fifo');
    const firstCreatedAt = recentIso();
    const secondCreatedAt = recentIso(1000);
    await recordPendingReplyOrigin(projectRoot, 'sess-fifo', {
      platform: 'telegram',
      injectedInput: 'same reply',
      createdAt: firstCreatedAt,
    });
    await recordPendingReplyOrigin(projectRoot, 'sess-fifo', {
      platform: 'telegram',
      injectedInput: 'same reply',
      createdAt: secondCreatedAt,
    });

    const first = await consumePendingReplyOrigin(projectRoot, 'sess-fifo', 'same reply');
    const second = await consumePendingReplyOrigin(projectRoot, 'sess-fifo', 'same reply');

    assert.ok(first);
    assert.equal(first.createdAt, firstCreatedAt);
    assert.ok(second);
    assert.equal(second.createdAt, secondCreatedAt);
  });
});
