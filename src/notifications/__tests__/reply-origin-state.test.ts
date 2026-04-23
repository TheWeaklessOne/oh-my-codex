import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  consumePendingReplyOrigin,
  recordPendingReplyOrigin,
} from '../reply-origin-state.js';

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

  it('preserves unmatched pending provenance for a later matching turn', async () => {
    await recordPendingReplyOrigin(projectRoot, 'sess-mismatch-preserve', {
      platform: 'telegram',
      injectedInput: 'second reply',
      createdAt: '2026-04-23T00:00:00Z',
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
    await recordPendingReplyOrigin(projectRoot, 'sess-queue', {
      platform: 'telegram',
      injectedInput: 'first reply',
      createdAt: '2026-04-23T00:00:00Z',
    });
    await recordPendingReplyOrigin(projectRoot, 'sess-queue', {
      platform: 'discord',
      injectedInput: 'second reply',
      createdAt: '2026-04-23T00:00:01Z',
    });

    const first = await consumePendingReplyOrigin(projectRoot, 'sess-queue', 'first reply');
    const second = await consumePendingReplyOrigin(projectRoot, 'sess-queue', 'second reply');

    assert.ok(first);
    assert.equal(first.platform, 'telegram');
    assert.ok(second);
    assert.equal(second.platform, 'discord');
  });

  it('consumes repeated identical replies in FIFO order', async () => {
    await recordPendingReplyOrigin(projectRoot, 'sess-fifo', {
      platform: 'telegram',
      injectedInput: 'same reply',
      createdAt: '2026-04-23T00:00:00Z',
    });
    await recordPendingReplyOrigin(projectRoot, 'sess-fifo', {
      platform: 'telegram',
      injectedInput: 'same reply',
      createdAt: '2026-04-23T00:00:01Z',
    });

    const first = await consumePendingReplyOrigin(projectRoot, 'sess-fifo', 'same reply');
    const second = await consumePendingReplyOrigin(projectRoot, 'sess-fifo', 'same reply');

    assert.ok(first);
    assert.equal(first.createdAt, '2026-04-23T00:00:00Z');
    assert.ok(second);
    assert.equal(second.createdAt, '2026-04-23T00:00:01Z');
  });
});
