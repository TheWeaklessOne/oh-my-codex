import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runLinkedRalphBridge } from '../linked-ralph-bridge.js';
import type { TeamSnapshot } from '../runtime.js';
import type { TeamEvent } from '../state/types.js';

function makeSnapshot(phase: TeamSnapshot['phase']): TeamSnapshot {
  return {
    teamName: 'alpha',
    phase,
    workers: [],
    tasks: {
      total: 1,
      pending: phase === 'team-exec' ? 1 : 0,
      blocked: 0,
      in_progress: phase === 'team-exec' ? 1 : 0,
      completed: phase === 'complete' ? 1 : 0,
      failed: phase === 'failed' ? 1 : 0,
      items: [],
    },
    allTasksTerminal: phase === 'complete' || phase === 'failed' || phase === 'cancelled',
    deadWorkers: [],
    nonReportingWorkers: [],
    recommendations: [],
  };
}

describe('runLinkedRalphBridge', () => {
  it('keeps monitoring until the linked team reaches a terminal phase', async () => {
    const snapshots = [makeSnapshot('team-exec'), makeSnapshot('team-exec'), makeSnapshot('complete')];
    let snapshotIndex = 0;

    const updates: Array<Record<string, unknown>> = [];
    const logs: string[] = [];
    let ensureCalls = 0;
    let finalizeCalls = 0;

    const event: TeamEvent = {
      event_id: 'evt-1',
      team: 'alpha',
      type: 'worker_state_changed',
      worker: 'worker-1',
      state: 'idle',
      prev_state: 'working',
      created_at: '2026-03-22T08:30:00.000Z',
    };

    const result = await runLinkedRalphBridge(
      {
        teamName: 'alpha',
        task: 'ship linked bridge fix',
        cwd: '/tmp/demo',
        waitTimeoutMs: 1_000,
        log: (message) => logs.push(message),
      },
      {
        ensureLinkedRalphModeState: async () => { ensureCalls += 1; },
        updateLinkedRalphHeartbeat: async (_teamName, _cwd, patch) => { updates.push(patch); },
        finalizeLinkedRalph: async (_teamName, _cwd, terminalPhase, patch) => {
          finalizeCalls += 1;
          updates.push({ terminalPhase, ...patch });
        },
        monitorTeam: async () => snapshots[Math.min(snapshotIndex++, snapshots.length - 1)] ?? null,
        waitForTeamEvent: async (_teamName, _cwd, opts) => {
          if (!opts.afterEventId) {
            return { status: 'event', event, cursor: event.event_id };
          }
          return { status: 'timeout', cursor: opts.afterEventId ?? '' };
        },
      },
    );

    assert.equal(ensureCalls, 1);
    assert.equal(finalizeCalls, 1);
    assert.equal(result.status, 'terminal');
    assert.equal(result.terminalPhase, 'complete');
    assert.equal(result.cursor, 'evt-1');
    assert.ok(
      updates.some((patch) => patch.linked_team_last_event_type === 'worker_state_changed'),
      'expected bridge to record wake event details',
    );
    assert.ok(
      updates.some((patch) => patch.terminalPhase === 'complete'),
      'expected bridge to finalize Ralph when the team completes',
    );
    assert.ok(
      logs.some((line) => line.includes('bridge active')),
      'expected bridge startup log',
    );
    assert.ok(
      logs.some((line) => line.includes('worker_state_changed')),
      'expected event log while bridge is active',
    );
  });

  it('finalizes linked Ralph when team state disappears unexpectedly', async () => {
    const updates: Array<Record<string, unknown>> = [];
    let finalizeCalls = 0;

    const result = await runLinkedRalphBridge(
      {
        teamName: 'alpha',
        task: 'ship linked bridge fix',
        cwd: '/tmp/demo',
        waitTimeoutMs: 1_000,
      },
      {
        ensureLinkedRalphModeState: async () => {},
        updateLinkedRalphHeartbeat: async () => {},
        finalizeLinkedRalph: async (_teamName, _cwd, terminalPhase, patch) => {
          finalizeCalls += 1;
          updates.push({ terminalPhase, ...patch });
        },
        monitorTeam: async () => null,
        waitForTeamEvent: async () => ({ status: 'timeout', cursor: '' }),
      },
    );

    assert.equal(result.status, 'missing');
    assert.equal(finalizeCalls, 1);
    assert.ok(
      updates.some((patch) => patch.terminalPhase === 'failed' && patch.linked_team_missing === true),
      'expected missing team state to finalize linked Ralph as failed',
    );
  });
});
