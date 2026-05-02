import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cleanupStaleOmxTmuxSessions,
  DEFAULT_OMX_TMUX_SESSION_IDLE_TTL_MS,
  findStaleOmxTmuxSessions,
  OMX_TMUX_SESSION_IDLE_CLEANUP_ENV,
  OMX_TMUX_SESSION_IDLE_INCLUDE_ATTACHED_ENV,
  OMX_TMUX_SESSION_IDLE_TTL_MS_ENV,
  parseTmuxIdleSessionRows,
  resolveOmxTmuxIdleCleanupConfig,
  type TmuxIdleSessionRow,
} from '../stale-session-cleanup.js';

describe('tmux stale OMX session cleanup', () => {
  const nowMs = Date.parse('2026-05-03T12:00:00.000Z');
  const staleActivityEpoch = Math.floor((nowMs - DEFAULT_OMX_TMUX_SESSION_IDLE_TTL_MS - 60_000) / 1000);
  const freshActivityEpoch = Math.floor((nowMs - 60_000) / 1000);

  it('parses tmux list-sessions rows with OMX markers', () => {
    const rows = parseTmuxIdleSessionRows([
      [
        'omx-project-main-session-a',
        '0',
        String(staleActivityEpoch),
        '1',
        'omx-session-a',
        '/repo/project',
        'session',
      ].join('\t'),
      [
        'plain-tmux',
        '1',
        String(staleActivityEpoch),
        '',
        '',
        '',
        '',
      ].join('\t'),
    ].join('\n'));

    assert.deepEqual(rows, [
      {
        name: 'omx-project-main-session-a',
        attachedClients: 0,
        activityEpoch: staleActivityEpoch,
        omxOwned: true,
        omxSessionId: 'omx-session-a',
        projectPath: '/repo/project',
        kind: 'session',
      },
      {
        name: 'plain-tmux',
        attachedClients: 1,
        activityEpoch: staleActivityEpoch,
        omxOwned: false,
        omxSessionId: undefined,
        projectPath: undefined,
        kind: undefined,
      },
    ]);
  });

  it('selects only OMX-owned detached non-current sessions idle past the TTL', () => {
    const rows: TmuxIdleSessionRow[] = [
      { name: 'stale-detached', attachedClients: 0, activityEpoch: staleActivityEpoch, omxOwned: true },
      { name: 'fresh-detached', attachedClients: 0, activityEpoch: freshActivityEpoch, omxOwned: true },
      { name: 'stale-attached', attachedClients: 1, activityEpoch: staleActivityEpoch, omxOwned: true },
      { name: 'stale-current', attachedClients: 0, activityEpoch: staleActivityEpoch, omxOwned: true },
      { name: 'stale-not-omx', attachedClients: 0, activityEpoch: staleActivityEpoch, omxOwned: false },
    ];

    assert.deepEqual(
      findStaleOmxTmuxSessions(rows, {
        nowMs,
        ttlMs: DEFAULT_OMX_TMUX_SESSION_IDLE_TTL_MS,
        currentSessionName: 'stale-current',
      }).map((candidate) => candidate.name),
      ['stale-detached'],
    );
  });

  it('can opt into attached-session cleanup explicitly', () => {
    const rows: TmuxIdleSessionRow[] = [
      { name: 'stale-attached', attachedClients: 2, activityEpoch: staleActivityEpoch, omxOwned: true },
    ];

    assert.deepEqual(
      findStaleOmxTmuxSessions(rows, {
        nowMs,
        ttlMs: DEFAULT_OMX_TMUX_SESSION_IDLE_TTL_MS,
        includeAttached: true,
      }).map((candidate) => candidate.name),
      ['stale-attached'],
    );
  });

  it('resolves env overrides for disable, ttl, and attached inclusion', () => {
    assert.deepEqual(resolveOmxTmuxIdleCleanupConfig({
      [OMX_TMUX_SESSION_IDLE_CLEANUP_ENV]: '0',
      [OMX_TMUX_SESSION_IDLE_TTL_MS_ENV]: '1234',
      [OMX_TMUX_SESSION_IDLE_INCLUDE_ATTACHED_ENV]: '1',
    }), {
      enabled: false,
      ttlMs: 1234,
      includeAttached: true,
    });
  });

  it('dry-runs without killing candidate sessions', async () => {
    const calls: string[][] = [];
    const lines: string[] = [];

    const result = await cleanupStaleOmxTmuxSessions(['--dry-run'], {
      now: () => nowMs,
      env: {},
      writeLine: (line) => lines.push(line),
      runTmux: (args) => {
        calls.push(args);
        assert.equal(args[0], 'list-sessions');
        return [
          [
            'omx-project-main-session-a',
            '0',
            String(staleActivityEpoch),
            '1',
            'omx-session-a',
            '/repo/project',
            'session',
          ].join('\t'),
        ].join('\n');
      },
    });

    assert.equal(result.dryRun, true);
    assert.deepEqual(result.candidates.map((candidate) => candidate.name), ['omx-project-main-session-a']);
    assert.deepEqual(calls.map((args) => args[0]), ['list-sessions']);
    assert.match(lines.join('\n'), /would kill 1 OMX-owned tmux session/);
  });

  it('kills stale sessions by exact tmux session target', async () => {
    const calls: string[][] = [];

    const result = await cleanupStaleOmxTmuxSessions([], {
      now: () => nowMs,
      env: {},
      writeLine: () => {},
      runTmux: (args) => {
        calls.push(args);
        if (args[0] === 'list-sessions') {
          return [
            [
              'omx-project-main-session-a',
              '0',
              String(staleActivityEpoch),
              '1',
              'omx-session-a',
              '/repo/project',
              'session',
            ].join('\t'),
          ].join('\n');
        }
        assert.deepEqual(args, ['kill-session', '-t', 'omx-project-main-session-a']);
        return '';
      },
    });

    assert.deepEqual(result.killed, ['omx-project-main-session-a']);
    assert.deepEqual(calls, [
      ['list-sessions', '-F', '#{session_name}\t#{session_attached}\t#{session_activity}\t#{@omx-owned}\t#{@omx-session-id}\t#{@omx-project-path}\t#{@omx-session-kind}'],
      ['kill-session', '-t', 'omx-project-main-session-a'],
    ]);
  });

  it('honors .omx-config.json env fallbacks when process env does not override them', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'omx-tmux-idle-config-'));
    const calls: string[][] = [];
    try {
      await writeFile(join(codexHome, '.omx-config.json'), JSON.stringify({
        env: {
          [OMX_TMUX_SESSION_IDLE_CLEANUP_ENV]: '0',
        },
      }));

      const result = await cleanupStaleOmxTmuxSessions([], {
        codexHomeOverride: codexHome,
        now: () => nowMs,
        writeLine: () => {},
        runTmux: (args) => {
          calls.push(args);
          throw new Error('tmux should not be called when config disables cleanup');
        },
      });

      assert.equal(result.enabled, false);
      assert.deepEqual(calls, []);
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });
});
