import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createSubagentTrackingState,
  recordSubagentTurn,
  summarizeSubagentSession,
} from '../tracker.js';

describe('subagents/tracker', () => {
  it('tracks leader and subagent threads per session and computes active windows', () => {
    let state = createSubagentTrackingState();
    state = recordSubagentTurn(state, {
      sessionId: 'sess-1',
      threadId: 'leader-thread',
      turnId: 'turn-1',
      timestamp: '2026-03-17T00:00:00.000Z',
      mode: 'ralph',
    });
    state = recordSubagentTurn(state, {
      sessionId: 'sess-1',
      threadId: 'sub-thread-1',
      turnId: 'turn-2',
      timestamp: '2026-03-17T00:00:30.000Z',
      mode: 'ralph',
    });
    state = recordSubagentTurn(state, {
      sessionId: 'sess-1',
      threadId: 'sub-thread-2',
      turnId: 'turn-3',
      timestamp: '2026-03-17T00:01:00.000Z',
      mode: 'ralph',
    });

    const active = summarizeSubagentSession(state, 'sess-1', {
      now: '2026-03-17T00:01:15.000Z',
      activeWindowMs: 60_000,
    });
    assert.deepEqual(active, {
      sessionId: 'sess-1',
      leaderThreadId: 'leader-thread',
      allThreadIds: ['leader-thread', 'sub-thread-1', 'sub-thread-2'],
      allSubagentThreadIds: ['sub-thread-1', 'sub-thread-2'],
      activeSubagentThreadIds: ['sub-thread-1', 'sub-thread-2'],
      updatedAt: '2026-03-17T00:01:00.000Z',
    });

    const drained = summarizeSubagentSession(state, 'sess-1', {
      now: '2026-03-17T00:03:30.000Z',
      activeWindowMs: 60_000,
    });
    assert.deepEqual(drained?.activeSubagentThreadIds, []);
  });

  it('uses native subagent parent thread metadata instead of treating the first completed thread as leader', () => {
    let state = createSubagentTrackingState();
    state = recordSubagentTurn(state, {
      sessionId: 'sess-subagent-first',
      threadId: 'sub-thread-first',
      turnId: 'turn-subagent',
      timestamp: '2026-04-25T10:00:00.000Z',
      kind: 'subagent',
      parentThreadId: 'leader-thread-parent',
    });

    let summary = summarizeSubagentSession(state, 'sess-subagent-first', {
      now: '2026-04-25T10:00:10.000Z',
      activeWindowMs: 60_000,
    });
    assert.equal(summary?.leaderThreadId, 'leader-thread-parent');
    assert.deepEqual(summary?.allThreadIds, ['leader-thread-parent', 'sub-thread-first']);
    assert.deepEqual(summary?.allSubagentThreadIds, ['sub-thread-first']);
    assert.equal(state.sessions['sess-subagent-first']?.threads['leader-thread-parent']?.turn_count, 0);

    state = recordSubagentTurn(state, {
      sessionId: 'sess-subagent-first',
      threadId: 'leader-thread-parent',
      turnId: 'turn-leader',
      timestamp: '2026-04-25T10:00:30.000Z',
      kind: 'leader',
    });

    summary = summarizeSubagentSession(state, 'sess-subagent-first', {
      now: '2026-04-25T10:00:45.000Z',
      activeWindowMs: 60_000,
    });
    assert.equal(summary?.leaderThreadId, 'leader-thread-parent');
    assert.equal(state.sessions['sess-subagent-first']?.threads['leader-thread-parent']?.kind, 'leader');
    assert.equal(state.sessions['sess-subagent-first']?.threads['leader-thread-parent']?.turn_count, 1);
    assert.deepEqual(summary?.allSubagentThreadIds, ['sub-thread-first']);
  });
});
