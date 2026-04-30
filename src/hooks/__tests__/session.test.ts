import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resetSessionMetrics,
  reconcileNativeSessionStart,
  writeSessionStart,
  writeSessionEnd,
  readSessionState,
  readUsableSessionState,
  isSessionStale,
  type SessionState,
} from '../session.js';
import { readSessionActors, recordActorLifecycleEvent, registerActorSessionStart } from '../../runtime/session-actors.js';
import { writeSubagentTrackingState } from '../../subagents/tracker.js';

interface SessionHistoryEntry {
  session_id: string;
  native_session_id?: string;
  started_at: string;
  ended_at: string;
  cwd: string;
  pid: number;
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function makeState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    session_id: 'sess-1',
    started_at: '2026-02-26T00:00:00.000Z',
    cwd: '/tmp/project',
    pid: 12345,
    ...overrides,
  };
}

describe('session lifecycle manager', () => {
  it('resets session metrics files with zeroed counters', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-metrics-'));
    try {
      await resetSessionMetrics(cwd);

      const metricsPath = join(cwd, '.omx', 'metrics.json');
      const hudPath = join(cwd, '.omx', 'state', 'hud-state.json');
      assert.equal(existsSync(metricsPath), true);
      assert.equal(existsSync(hudPath), true);

      const metrics = JSON.parse(await readFile(metricsPath, 'utf-8')) as {
        total_turns: number;
        session_turns: number;
      };
      const hud = JSON.parse(await readFile(hudPath, 'utf-8')) as {
        turn_count: number;
      };

      assert.equal(metrics.total_turns, 0);
      assert.equal(metrics.session_turns, 0);
      assert.equal(hud.turn_count, 0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('writes hud session metrics into the active session scope when session id is provided', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-metrics-scoped-'));
    try {
      await resetSessionMetrics(cwd, 'sess-scoped');

      const metricsPath = join(cwd, '.omx', 'metrics.json');
      const hudPath = join(cwd, '.omx', 'state', 'sessions', 'sess-scoped', 'hud-state.json');
      assert.equal(existsSync(metricsPath), true);
      assert.equal(existsSync(hudPath), true);

      const hud = JSON.parse(await readFile(hudPath, 'utf-8')) as {
        turn_count: number;
      };
      assert.equal(hud.turn_count, 0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not let legacy subagent tracking projection replace a concrete owner actor', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-owner-projection-'));
    const sessionId = 'sess-owner-projection';
    try {
      await writeSessionStart(cwd, sessionId, {
        nativeSessionId: 'leader-current-owner',
      });

      await writeSubagentTrackingState(cwd, {
        schemaVersion: 1,
        sessions: {
          [sessionId]: {
            session_id: sessionId,
            leader_thread_id: 'leader-stale-projection',
            updated_at: '2026-04-30T00:00:01.000Z',
            threads: {
              'leader-stale-projection': {
                thread_id: 'leader-stale-projection',
                kind: 'leader',
                first_seen_at: '2026-04-30T00:00:01.000Z',
                last_seen_at: '2026-04-30T00:00:01.000Z',
                turn_count: 1,
              },
            },
          },
        },
      });

      const registry = await readSessionActors(cwd, sessionId);
      assert.equal(registry.ownerActorId, 'leader-current-owner');
      assert.equal(registry.actors['leader-current-owner']?.kind, 'leader');
      assert.equal(registry.actors['leader-current-owner']?.audience, 'external-owner');
      assert.equal(registry.actors['leader-current-owner']?.nativeSessionId, 'leader-current-owner');
      assert.equal(registry.actors['leader-stale-projection']?.quarantined, true);
      assert.equal(
        registry.actors['leader-stale-projection']?.quarantineReason,
        'external_owner_mismatch_with_active_owner',
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves concurrent child actor registrations under the session actor lock', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-actor-lock-'));
    const sessionId = 'sess-actor-lock';
    try {
      await writeSessionStart(cwd, sessionId, {
        nativeSessionId: 'leader-actor-lock',
      });

      await Promise.all(['child-actor-lock-a', 'child-actor-lock-b'].map((childId) =>
        registerActorSessionStart({
          cwd,
          sessionId,
          classification: {
            kind: 'native-subagent',
            audience: 'child',
            origin: {
              kind: 'native-subagent',
              threadId: childId,
              nativeSessionId: childId,
              parentThreadId: 'leader-actor-lock',
            },
            actorId: childId,
            threadId: childId,
            nativeSessionId: childId,
            parentThreadId: 'leader-actor-lock',
            source: 'test-concurrent-child',
            reason: 'session_start_child',
            evidence: [{ source: 'test', detail: childId }],
          },
        })
      ));

      const registry = await readSessionActors(cwd, sessionId);
      assert.equal(registry.ownerActorId, 'leader-actor-lock');
      assert.equal(registry.actors['child-actor-lock-a']?.parentActorId, 'leader-actor-lock');
      assert.equal(registry.actors['child-actor-lock-b']?.parentActorId, 'leader-actor-lock');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });


  it('treats symlinked cwd aliases as authoritative for the same session state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-cwd-alias-'));
    const aliasCwd = `${cwd}-alias`;
    try {
      await symlink(cwd, aliasCwd, process.platform === 'win32' ? 'junction' : 'dir');
      await writeSessionStart(cwd, 'sess-alias');

      const usable = await readUsableSessionState(aliasCwd);
      assert.ok(usable);
      assert.equal(usable?.session_id, 'sess-alias');
      assert.equal(usable?.cwd, cwd);
    } finally {
      await rm(aliasCwd, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('writes session start/end lifecycle artifacts and archives session history', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-lifecycle-'));
    const sessionId = 'sess-lifecycle-1';
    try {
      await writeSessionStart(cwd, sessionId);

      const state = await readSessionState(cwd);
      assert.ok(state);
      assert.equal(state.session_id, sessionId);
      assert.equal(state.cwd, cwd);
      assert.equal(state.pid, process.pid);
      assert.equal(isSessionStale(state), false);

      const sessionPath = join(cwd, '.omx', 'state', 'session.json');
      assert.equal(existsSync(sessionPath), true);

      await writeSessionEnd(cwd, sessionId);

      assert.equal(existsSync(sessionPath), false);

      const historyPath = join(cwd, '.omx', 'logs', 'session-history.jsonl');
      assert.equal(existsSync(historyPath), true);

      const historyLines = (await readFile(historyPath, 'utf-8'))
        .trim()
        .split('\n')
        .filter(Boolean);
      assert.equal(historyLines.length, 1);

      const historyEntry = JSON.parse(historyLines[0]) as SessionHistoryEntry;
      assert.equal(historyEntry.session_id, sessionId);
      assert.equal(historyEntry.cwd, cwd);
      assert.equal(typeof historyEntry.started_at, 'string');
      assert.equal(typeof historyEntry.ended_at, 'string');

      const dailyLogPath = join(cwd, '.omx', 'logs', `omx-${todayIsoDate()}.jsonl`);
      assert.equal(existsSync(dailyLogPath), true);
      const dailyLog = await readFile(dailyLogPath, 'utf-8');
      assert.match(dailyLog, /"event":"session_start"/);
      assert.match(dailyLog, /"event":"session_end"/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('removes canonical and native session-scoped hud state on session end', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-end-hud-cleanup-'));
    const canonicalSessionId = 'omx-launch-hud';
    const nativeSessionId = 'codex-native-hud';
    try {
      await writeSessionStart(cwd, canonicalSessionId, { nativeSessionId });
      const stateDir = join(cwd, '.omx', 'state');
      const rootHudPath = join(stateDir, 'hud-state.json');
      const canonicalHudPath = join(stateDir, 'sessions', canonicalSessionId, 'hud-state.json');
      const nativeHudPath = join(stateDir, 'sessions', nativeSessionId, 'hud-state.json');
      await mkdir(join(stateDir, 'sessions', canonicalSessionId), { recursive: true });
      await mkdir(join(stateDir, 'sessions', nativeSessionId), { recursive: true });
      await writeFile(rootHudPath, JSON.stringify({ last_turn_at: 'root', turn_count: 1 }), 'utf-8');
      await writeFile(canonicalHudPath, JSON.stringify({ last_turn_at: 'canonical', turn_count: 2 }), 'utf-8');
      await writeFile(nativeHudPath, JSON.stringify({ last_turn_at: 'native', turn_count: 9 }), 'utf-8');

      await writeSessionEnd(cwd, canonicalSessionId);

      assert.equal(existsSync(rootHudPath), false);
      assert.equal(existsSync(canonicalHudPath), false);
      assert.equal(existsSync(nativeHudPath), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves canonical session id while reconciling native SessionStart metadata', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-native-reconcile-'));
    try {
      await writeSessionStart(cwd, 'omx-launch-1');

      const reconciled = await reconcileNativeSessionStart(cwd, 'codex-native-1', {
        pid: 54321,
        platform: 'win32',
      });

      assert.equal(reconciled.session_id, 'omx-launch-1');
      assert.equal(reconciled.native_session_id, 'codex-native-1');
      assert.equal(reconciled.pid, 54321);
      assert.equal(reconciled.platform, 'win32');

      const persisted = await readSessionState(cwd);
      assert.equal(persisted?.session_id, 'omx-launch-1');
      assert.equal(persisted?.native_session_id, 'codex-native-1');
      assert.equal(persisted?.pid, 54321);

      const dailyLogPath = join(cwd, '.omx', 'logs', `omx-${todayIsoDate()}.jsonl`);
      const dailyLog = await readFile(dailyLogPath, 'utf-8');
      assert.match(dailyLog, /"event":"session_start_reconciled"/);
      assert.match(dailyLog, /"native_session_id":"codex-native-1"/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('quarantines a concurrent native SessionStart instead of replacing the active owner', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-native-fresh-'));
    try {
      await writeSessionStart(cwd, 'omx-old-session', {
        nativeSessionId: 'codex-native-old',
      });

      const reconciled = await reconcileNativeSessionStart(cwd, 'codex-native-new', {
        pid: 54321,
        platform: 'win32',
      });

      assert.equal(reconciled.session_id, 'omx-old-session');
      assert.equal(reconciled.native_session_id, 'codex-native-old');

      const persisted = await readSessionState(cwd);
      assert.equal(persisted?.session_id, 'omx-old-session');
      assert.equal(persisted?.native_session_id, 'codex-native-old');

      const dailyLogPath = join(cwd, '.omx', 'logs', `omx-${todayIsoDate()}.jsonl`);
      const dailyLog = await readFile(dailyLogPath, 'utf-8');
      assert.match(dailyLog, /"event":"session_start_external_owner_mismatch_quarantined"/);
      assert.match(dailyLog, /"native_session_id":"codex-native-new"/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not promote unknown SessionStart actors when the actor registry is missing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-missing-registry-unknown-'));
    try {
      const sessionId = 'omx-missing-registry-unknown';
      await writeSessionStart(cwd, sessionId, {
        nativeSessionId: 'codex-owner-before-registry-loss',
      });
      await rm(join(cwd, '.omx', 'state', 'sessions', sessionId, 'actors.json'), { force: true });

      const registration = await registerActorSessionStart({
        cwd,
        sessionId,
        classification: {
          kind: 'unknown',
          audience: 'unknown-non-owner',
          origin: {
            kind: 'unknown',
            threadId: 'codex-unknown-after-registry-loss',
            nativeSessionId: 'codex-unknown-after-registry-loss',
            source: 'session-start-payload',
          },
          actorId: 'codex-unknown-after-registry-loss',
          threadId: 'codex-unknown-after-registry-loss',
          nativeSessionId: 'codex-unknown-after-registry-loss',
          source: 'session-start-payload',
          reason: 'session_start_unknown-non-owner',
          evidence: [{ source: 'session-start-payload', detail: 'origin_kind=unknown' }],
          managedSessionId: sessionId,
        },
        pid: process.pid,
      });

      assert.equal(registration.outcome, 'actor-quarantined');
      assert.equal(registration.reason, 'non_owner_without_owner');

      const registry = await readSessionActors(cwd, sessionId);
      assert.equal(registry.ownerActorId, undefined);
      assert.equal(registry.actors['codex-unknown-after-registry-loss']?.quarantined, true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rebinds canonical native session when the prior owner aborted before completion', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-native-aborted-rebind-'));
    try {
      await writeSessionStart(cwd, 'omx-aborted-rebind', {
        nativeSessionId: 'codex-native-aborted-owner',
      });
      await recordActorLifecycleEvent({
        cwd,
        sessionId: 'omx-aborted-rebind',
        actorIds: ['codex-native-aborted-owner'],
        event: 'task_started',
        turnId: 'turn-aborted-owner',
        source: 'test',
      });
      await recordActorLifecycleEvent({
        cwd,
        sessionId: 'omx-aborted-rebind',
        actorIds: ['codex-native-aborted-owner'],
        event: 'turn_aborted',
        turnId: 'turn-aborted-owner',
        source: 'test',
      });

      const reconciled = await reconcileNativeSessionStart(cwd, 'codex-native-replacement-owner', {
        pid: process.pid,
        platform: 'win32',
        lifecycle: {
          sessionMeta: { id: 'codex-native-replacement-owner', cwd },
          contextCwd: cwd,
          startedTurnCount: 1,
          completedTurnCount: 0,
          abortedTurnCount: 0,
          lastTurnStatus: 'started',
        },
      });

      assert.equal(reconciled.session_id, 'omx-aborted-rebind');
      assert.equal(reconciled.native_session_id, 'codex-native-replacement-owner');

      const persisted = await readSessionState(cwd);
      assert.equal(persisted?.native_session_id, 'codex-native-replacement-owner');

      const registry = await readSessionActors(cwd, 'omx-aborted-rebind');
      assert.equal(registry.ownerActorId, 'codex-native-replacement-owner');
      assert.equal(registry.actors['codex-native-aborted-owner']?.lifecycleStatus, 'superseded');
      assert.equal(
        registry.actors['codex-native-aborted-owner']?.supersededReason,
        'owner_rebound_after_aborted_candidate',
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('quarantines aborted-owner replacements that lack authoritative transcript start evidence', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-native-aborted-missing-evidence-'));
    try {
      await writeSessionStart(cwd, 'omx-aborted-missing-evidence', {
        nativeSessionId: 'codex-native-aborted-missing-evidence-owner',
      });
      await recordActorLifecycleEvent({
        cwd,
        sessionId: 'omx-aborted-missing-evidence',
        actorIds: ['codex-native-aborted-missing-evidence-owner'],
        event: 'task_started',
        turnId: 'turn-aborted-missing-evidence-owner',
        source: 'test',
      });
      await recordActorLifecycleEvent({
        cwd,
        sessionId: 'omx-aborted-missing-evidence',
        actorIds: ['codex-native-aborted-missing-evidence-owner'],
        event: 'turn_aborted',
        turnId: 'turn-aborted-missing-evidence-owner',
        source: 'test',
      });

      const reconciled = await reconcileNativeSessionStart(cwd, 'codex-native-replacement-no-evidence', {
        pid: process.pid,
        platform: 'win32',
      });

      assert.equal(reconciled.session_id, 'omx-aborted-missing-evidence');
      assert.equal(reconciled.native_session_id, 'codex-native-aborted-missing-evidence-owner');

      const registry = await readSessionActors(cwd, 'omx-aborted-missing-evidence');
      assert.equal(registry.ownerActorId, 'codex-native-aborted-missing-evidence-owner');
      assert.equal(registry.actors['codex-native-replacement-no-evidence']?.quarantined, true);
      assert.equal(
        registry.actors['codex-native-replacement-no-evidence']?.quarantineReason,
        'owner_rebind_denied_missing_replacement_evidence',
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('keeps replacement native session quarantined when an aborted owner became active again', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-native-active-again-no-rebind-'));
    try {
      await writeSessionStart(cwd, 'omx-active-again-no-rebind', {
        nativeSessionId: 'codex-native-active-again-owner',
      });
      await recordActorLifecycleEvent({
        cwd,
        sessionId: 'omx-active-again-no-rebind',
        actorIds: ['codex-native-active-again-owner'],
        event: 'task_started',
        turnId: 'turn-aborted-owner',
        source: 'test',
      });
      await recordActorLifecycleEvent({
        cwd,
        sessionId: 'omx-active-again-no-rebind',
        actorIds: ['codex-native-active-again-owner'],
        event: 'turn_aborted',
        turnId: 'turn-aborted-owner',
        source: 'test',
      });
      await recordActorLifecycleEvent({
        cwd,
        sessionId: 'omx-active-again-no-rebind',
        actorIds: ['codex-native-active-again-owner'],
        event: 'task_started',
        turnId: 'turn-active-again-owner',
        source: 'test',
      });

      const reconciled = await reconcileNativeSessionStart(cwd, 'codex-native-active-again-replacement', {
        pid: process.pid,
        platform: 'win32',
      });

      assert.equal(reconciled.session_id, 'omx-active-again-no-rebind');
      assert.equal(reconciled.native_session_id, 'codex-native-active-again-owner');

      const registry = await readSessionActors(cwd, 'omx-active-again-no-rebind');
      assert.equal(registry.ownerActorId, 'codex-native-active-again-owner');
      assert.equal(registry.actors['codex-native-active-again-replacement']?.quarantined, true);
      assert.equal(
        registry.actors['codex-native-active-again-replacement']?.quarantineReason,
        'unknown_actor_with_owner',
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('keeps replacement native session quarantined when runtime pid evidence differs', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-native-runtime-mismatch-no-rebind-'));
    try {
      await writeSessionStart(cwd, 'omx-runtime-mismatch-no-rebind', {
        nativeSessionId: 'codex-native-runtime-owner',
        pid: process.pid,
      });
      await recordActorLifecycleEvent({
        cwd,
        sessionId: 'omx-runtime-mismatch-no-rebind',
        actorIds: ['codex-native-runtime-owner'],
        event: 'task_started',
        turnId: 'turn-runtime-owner',
        source: 'test',
      });
      await recordActorLifecycleEvent({
        cwd,
        sessionId: 'omx-runtime-mismatch-no-rebind',
        actorIds: ['codex-native-runtime-owner'],
        event: 'turn_aborted',
        turnId: 'turn-runtime-owner',
        source: 'test',
      });

      const reconciled = await reconcileNativeSessionStart(cwd, 'codex-native-runtime-replacement', {
        pid: process.pid + 10_000,
        platform: 'win32',
      });

      assert.equal(reconciled.session_id, 'omx-runtime-mismatch-no-rebind');
      assert.equal(reconciled.native_session_id, 'codex-native-runtime-owner');

      const registry = await readSessionActors(cwd, 'omx-runtime-mismatch-no-rebind');
      assert.equal(registry.ownerActorId, 'codex-native-runtime-owner');
      assert.equal(registry.actors['codex-native-runtime-replacement']?.quarantined, true);
      assert.equal(
        registry.actors['codex-native-runtime-replacement']?.quarantineReason,
        'owner_rebind_denied_context_mismatch',
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('keeps replacement native session quarantined when the prior owner completed', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-native-completed-no-rebind-'));
    try {
      await writeSessionStart(cwd, 'omx-completed-no-rebind', {
        nativeSessionId: 'codex-native-completed-owner',
      });
      await recordActorLifecycleEvent({
        cwd,
        sessionId: 'omx-completed-no-rebind',
        actorIds: ['codex-native-completed-owner'],
        event: 'task_started',
        turnId: 'turn-completed-owner',
        source: 'test',
      });
      await recordActorLifecycleEvent({
        cwd,
        sessionId: 'omx-completed-no-rebind',
        actorIds: ['codex-native-completed-owner'],
        event: 'task_complete',
        turnId: 'turn-completed-owner',
        source: 'test',
      });

      const reconciled = await reconcileNativeSessionStart(cwd, 'codex-native-after-completed-owner', {
        pid: process.pid,
        platform: 'win32',
      });

      assert.equal(reconciled.session_id, 'omx-completed-no-rebind');
      assert.equal(reconciled.native_session_id, 'codex-native-completed-owner');

      const registry = await readSessionActors(cwd, 'omx-completed-no-rebind');
      assert.equal(registry.ownerActorId, 'codex-native-completed-owner');
      assert.equal(registry.actors['codex-native-after-completed-owner']?.quarantined, true);
      assert.equal(
        registry.actors['codex-native-after-completed-owner']?.quarantineReason,
        'owner_rebind_denied_completed_owner',
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not let a child native SessionStart replace the current root session owner', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-native-child-preserve-owner-'));
    try {
      await writeSessionStart(cwd, 'omx-root-owner', {
        nativeSessionId: 'codex-root-owner',
      });

      const reconciled = await reconcileNativeSessionStart(cwd, 'codex-child-subagent', {
        pid: 54321,
        platform: 'win32',
        ownerKind: 'child',
        parentThreadId: 'codex-root-owner',
      } as any);

      assert.equal(reconciled.session_id, 'omx-root-owner');
      assert.equal(reconciled.native_session_id, 'codex-root-owner');

      const persisted = await readSessionState(cwd);
      assert.equal(persisted?.session_id, 'omx-root-owner');
      assert.equal(persisted?.native_session_id, 'codex-root-owner');

      const dailyLogPath = join(cwd, '.omx', 'logs', `omx-${todayIsoDate()}.jsonl`);
      const dailyLog = await readFile(dailyLogPath, 'utf-8');
      assert.match(dailyLog, /"event":"session_start_child_indexed"/);
      assert.match(dailyLog, /"native_session_id":"codex-child-subagent"/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('falls back to a fresh canonical session when reconciling without authoritative launch state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-native-fallback-'));
    try {
      const statePath = join(cwd, '.omx', 'state', 'session.json');
      await resetSessionMetrics(cwd);
      await writeFile(statePath, JSON.stringify({
        session_id: 'sess-other-worktree',
        cwd: join(cwd, '..', 'different-worktree'),
      }), 'utf-8');

      const reconciled = await reconcileNativeSessionStart(cwd, 'codex-fallback-1', {
        pid: 67890,
        platform: 'win32',
      });

      assert.equal(reconciled.session_id, 'codex-fallback-1');
      assert.equal(reconciled.native_session_id, 'codex-fallback-1');
      assert.equal(reconciled.pid, 67890);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('treats invalid session JSON as absent state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-invalid-'));
    try {
      const statePath = join(cwd, '.omx', 'state', 'session.json');
      await resetSessionMetrics(cwd);
      await writeFile(statePath, '{ not-json', 'utf-8');
      const state = await readSessionState(cwd);
      assert.equal(state, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('ignores session.json when its recorded cwd points at another worktree', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-mismatched-cwd-'));
    try {
      const statePath = join(cwd, '.omx', 'state', 'session.json');
      await resetSessionMetrics(cwd);
      await writeFile(statePath, JSON.stringify({
        session_id: 'sess-other-worktree',
        cwd: join(cwd, '..', 'different-worktree'),
      }), 'utf-8');

      const state = await readUsableSessionState(cwd);
      assert.equal(state, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('ignores session.json when its PID identity is stale', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-stale-pointer-'));
    try {
      const statePath = join(cwd, '.omx', 'state', 'session.json');
      await resetSessionMetrics(cwd);
      await writeFile(statePath, JSON.stringify({
        session_id: 'sess-stale-pointer',
        cwd,
        pid: 4242,
        pid_start_ticks: 11,
        pid_cmdline: 'node omx',
      }), 'utf-8');

      const state = await readUsableSessionState(cwd, {
        platform: 'linux',
        isPidAlive: () => true,
        readLinuxIdentity: () => ({ startTicks: 22, cmdline: 'node omx' }),
      });
      assert.equal(state, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('marks dead PIDs as stale', () => {
    const impossiblePid = Number.MAX_SAFE_INTEGER;
    const stale = isSessionStale({
      session_id: 'sess-stale',
      started_at: '2026-01-01T00:00:00.000Z',
      cwd: '/tmp',
      pid: impossiblePid,
    });
    assert.equal(stale, true);
  });
});

describe('isSessionStale', () => {
  it('returns false for a live Linux process when identity matches', () => {
    const state = makeState({
      pid_start_ticks: 111,
      pid_cmdline: 'node omx',
    });

    const stale = isSessionStale(state, {
      platform: 'linux',
      isPidAlive: () => true,
      readLinuxIdentity: () => ({ startTicks: 111, cmdline: 'node omx' }),
    });

    assert.equal(stale, false);
  });

  it('returns true for PID reuse on Linux when start ticks mismatch', () => {
    const state = makeState({
      pid_start_ticks: 111,
      pid_cmdline: 'node omx',
    });

    const stale = isSessionStale(state, {
      platform: 'linux',
      isPidAlive: () => true,
      readLinuxIdentity: () => ({ startTicks: 222, cmdline: 'node omx' }),
    });

    assert.equal(stale, true);
  });

  it('returns true on Linux when identity metadata is missing', () => {
    const state = makeState();

    const stale = isSessionStale(state, {
      platform: 'linux',
      isPidAlive: () => true,
      readLinuxIdentity: () => ({ startTicks: 111, cmdline: 'node omx' }),
    });

    assert.equal(stale, true);
  });

  it('returns true on Linux when live identity cannot be read', () => {
    const state = makeState({ pid_start_ticks: 111 });

    const stale = isSessionStale(state, {
      platform: 'linux',
      isPidAlive: () => true,
      readLinuxIdentity: () => null,
    });

    assert.equal(stale, true);
  });

  it('returns true when PID is not alive', () => {
    const state = makeState({ pid_start_ticks: 111 });

    const stale = isSessionStale(state, {
      platform: 'linux',
      isPidAlive: () => false,
    });

    assert.equal(stale, true);
  });

  it('falls back to PID liveness on non-Linux platforms', () => {
    const state = makeState();

    const stale = isSessionStale(state, {
      platform: 'darwin',
      isPidAlive: () => true,
      readLinuxIdentity: () => null,
    });

    assert.equal(stale, false);
  });
});
