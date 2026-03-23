import { readModeState, startMode, updateModeState } from '../modes/base.js';
import { monitorTeam, type TeamSnapshot } from './runtime.js';
import { waitForTeamEvent } from './state/events.js';
import type { TeamEvent } from './state/types.js';
import type { TerminalPhase } from './orchestrator.js';

const TERMINAL_PHASES = new Set<TerminalPhase>(['complete', 'failed', 'cancelled']);
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;

export interface LinkedRalphBridgeOptions {
  teamName: string;
  task: string;
  cwd: string;
  waitTimeoutMs?: number;
  log?: (message: string) => void;
}

export interface LinkedRalphBridgeResult {
  status: 'terminal' | 'missing';
  terminalPhase?: TerminalPhase;
  cursor: string;
}

export interface LinkedRalphBridgeDeps {
  ensureLinkedRalphModeState: (task: string, teamName: string, cwd: string) => Promise<void>;
  updateLinkedRalphHeartbeat: (
    teamName: string,
    cwd: string,
    updates: Record<string, unknown>,
  ) => Promise<void>;
  finalizeLinkedRalph: (
    teamName: string,
    cwd: string,
    terminalPhase: TerminalPhase,
    updates?: Record<string, unknown>,
  ) => Promise<void>;
  monitorTeam: (teamName: string, cwd: string) => Promise<TeamSnapshot | null>;
  waitForTeamEvent: typeof waitForTeamEvent;
}

function isTerminalPhase(value: string): value is TerminalPhase {
  return TERMINAL_PHASES.has(value as TerminalPhase);
}

function formatEvent(event: TeamEvent): string {
  return [
    `event=${event.type}`,
    `worker=${event.worker}`,
    event.state ? `state=${event.state}` : '',
    event.prev_state ? `prev=${event.prev_state}` : '',
    event.task_id ? `task=${event.task_id}` : '',
  ].filter(Boolean).join(' ');
}

export async function ensureLinkedRalphModeState(
  task: string,
  teamName: string,
  cwd: string,
): Promise<void> {
  const existing = await readModeState('ralph', cwd);
  if (existing?.active === true) {
    await updateModeState('ralph', {
      current_phase: 'executing',
      task_description: task,
      linked_team: true,
      team_name: teamName,
      linked_team_started_at: new Date().toISOString(),
    }, cwd);
    return;
  }

  await startMode('ralph', task, 50, cwd);
  await updateModeState('ralph', {
    current_phase: 'executing',
    linked_team: true,
    team_name: teamName,
    linked_team_started_at: new Date().toISOString(),
  }, cwd);
}

export async function updateLinkedRalphHeartbeat(
  _teamName: string,
  cwd: string,
  updates: Record<string, unknown>,
): Promise<void> {
  await updateModeState('ralph', {
    current_phase: 'executing',
    linked_team: true,
    ...updates,
  }, cwd);
}

export async function finalizeLinkedRalph(
  _teamName: string,
  cwd: string,
  terminalPhase: TerminalPhase,
  updates: Record<string, unknown> = {},
): Promise<void> {
  await updateModeState('ralph', {
    active: false,
    current_phase: terminalPhase,
    completed_at: new Date().toISOString(),
    linked_team: true,
    linked_team_terminal_phase: terminalPhase,
    linked_team_terminal_at: new Date().toISOString(),
    ...updates,
  }, cwd);
}

export async function runLinkedRalphBridge(
  options: LinkedRalphBridgeOptions,
  deps: LinkedRalphBridgeDeps = {
    ensureLinkedRalphModeState,
    updateLinkedRalphHeartbeat,
    finalizeLinkedRalph,
    monitorTeam,
    waitForTeamEvent,
  },
): Promise<LinkedRalphBridgeResult> {
  const waitTimeoutMs = Math.max(1_000, Math.floor(options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS));
  let cursor = '';
  let heartbeatCount = 0;

  await deps.ensureLinkedRalphModeState(options.task, options.teamName, options.cwd);
  options.log?.(`[linked-ralph] bridge active for team=${options.teamName}`);

  while (true) {
    const snapshot = await deps.monitorTeam(options.teamName, options.cwd);
    if (!snapshot) {
      await deps.finalizeLinkedRalph(options.teamName, options.cwd, 'failed', {
        linked_team_phase: 'missing',
        linked_team_event_cursor: cursor,
        linked_team_last_snapshot_at: new Date().toISOString(),
        linked_team_missing: true,
      });
      options.log?.(`[linked-ralph] team state missing for team=${options.teamName}`);
      return { status: 'missing', cursor };
    }

    if (isTerminalPhase(snapshot.phase)) {
      await deps.finalizeLinkedRalph(options.teamName, options.cwd, snapshot.phase, {
        linked_team_phase: snapshot.phase,
        linked_team_event_cursor: cursor,
        linked_team_last_snapshot_at: new Date().toISOString(),
      });
      options.log?.(`[linked-ralph] team=${options.teamName} terminal phase=${snapshot.phase}`);
      return { status: 'terminal', terminalPhase: snapshot.phase, cursor };
    }

    heartbeatCount += 1;
    await deps.updateLinkedRalphHeartbeat(options.teamName, options.cwd, {
      linked_team_phase: snapshot.phase,
      linked_team_all_tasks_terminal: snapshot.allTasksTerminal,
      linked_team_heartbeat_count: heartbeatCount,
      linked_team_last_snapshot_at: new Date().toISOString(),
    });

    const eventResult = await deps.waitForTeamEvent(options.teamName, options.cwd, {
      ...(cursor ? { afterEventId: cursor } : {}),
      timeoutMs: waitTimeoutMs,
      pollMs: 100,
      wakeableOnly: true,
    });

    if (eventResult.status === 'event' && eventResult.event) {
      cursor = eventResult.cursor;
      await deps.updateLinkedRalphHeartbeat(options.teamName, options.cwd, {
        linked_team_event_cursor: cursor,
        linked_team_last_event_type: eventResult.event.type,
        linked_team_last_event_at: eventResult.event.created_at,
        linked_team_last_event_worker: eventResult.event.worker,
      });
      options.log?.(`[linked-ralph] team=${options.teamName} ${formatEvent(eventResult.event)}`);
      continue;
    }

    options.log?.(`[linked-ralph] team=${options.teamName} waiting... phase=${snapshot.phase}`);
  }
}
