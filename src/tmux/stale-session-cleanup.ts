import { execFileSync } from 'node:child_process';
import {
  isOmxTmuxOwnedMarker,
  OMX_TMUX_KIND_OPTION,
  OMX_TMUX_OWNED_OPTION,
  OMX_TMUX_PROJECT_PATH_OPTION,
  OMX_TMUX_SESSION_ID_OPTION,
} from './omx-session-markers.js';
import { readConfiguredEnvOverrides } from '../config/models.js';
import { resolveTmuxBinaryForPlatform } from '../utils/platform-command.js';

export const DEFAULT_OMX_TMUX_SESSION_IDLE_TTL_MS = 24 * 60 * 60 * 1000;
export const OMX_TMUX_SESSION_IDLE_CLEANUP_ENV = 'OMX_TMUX_SESSION_IDLE_CLEANUP';
export const OMX_TMUX_SESSION_IDLE_TTL_MS_ENV = 'OMX_TMUX_SESSION_IDLE_TTL_MS';
export const OMX_TMUX_SESSION_IDLE_INCLUDE_ATTACHED_ENV = 'OMX_TMUX_SESSION_IDLE_INCLUDE_ATTACHED';

const TMUX_STALE_SESSION_FORMAT = [
  '#{session_name}',
  '#{session_attached}',
  '#{session_activity}',
  `#{${OMX_TMUX_OWNED_OPTION}}`,
  `#{${OMX_TMUX_SESSION_ID_OPTION}}`,
  `#{${OMX_TMUX_PROJECT_PATH_OPTION}}`,
  `#{${OMX_TMUX_KIND_OPTION}}`,
].join('\t');

const FALSE_ENV_VALUES = new Set(['0', 'false', 'no', 'off', 'disabled']);
const TRUE_ENV_VALUES = new Set(['1', 'true', 'yes', 'on', 'enabled']);

export interface OmxTmuxIdleCleanupConfig {
  enabled: boolean;
  ttlMs: number;
  includeAttached: boolean;
}

export interface TmuxIdleSessionRow {
  name: string;
  attachedClients: number;
  activityEpoch?: number;
  omxOwned: boolean;
  omxSessionId?: string;
  projectPath?: string;
  kind?: string;
}

export interface StaleOmxTmuxSessionCandidate extends TmuxIdleSessionRow {
  idleMs: number;
  ttlMs: number;
  lastActivityAt: string;
}

export interface StaleOmxTmuxSessionFailure {
  sessionName: string;
  error: string;
}

export interface CleanupStaleOmxTmuxSessionsResult {
  enabled: boolean;
  dryRun: boolean;
  ttlMs: number;
  includeAttached: boolean;
  unavailable: boolean;
  candidates: StaleOmxTmuxSessionCandidate[];
  killed: string[];
  failed: StaleOmxTmuxSessionFailure[];
}

export interface CleanupStaleOmxTmuxSessionsDependencies {
  runTmux?: (args: string[]) => string;
  env?: NodeJS.ProcessEnv;
  codexHomeOverride?: string | null;
  now?: () => number;
  currentSessionName?: string | null;
  writeLine?: (line: string) => void;
}

function parseInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function envFlag(value: unknown): boolean | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (TRUE_ENV_VALUES.has(normalized)) return true;
  if (FALSE_ENV_VALUES.has(normalized)) return false;
  return undefined;
}

function envPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.floor(parsed);
}

export function resolveOmxTmuxIdleCleanupConfig(
  env: NodeJS.ProcessEnv = process.env,
): OmxTmuxIdleCleanupConfig {
  const ttlMs = envPositiveInteger(env[OMX_TMUX_SESSION_IDLE_TTL_MS_ENV])
    ?? DEFAULT_OMX_TMUX_SESSION_IDLE_TTL_MS;
  const explicitEnabled = envFlag(env[OMX_TMUX_SESSION_IDLE_CLEANUP_ENV]);
  return {
    enabled: explicitEnabled ?? ttlMs > 0,
    ttlMs,
    includeAttached: envFlag(env[OMX_TMUX_SESSION_IDLE_INCLUDE_ATTACHED_ENV]) ?? false,
  };
}

export function parseTmuxIdleSessionRows(raw: string): TmuxIdleSessionRow[] {
  return raw
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const [
        name = '',
        attached = '0',
        activity = '',
        omxOwned = '',
        omxSessionId = '',
        projectPath = '',
        kind = '',
      ] = line.split('\t');
      return {
        name,
        attachedClients: parseInteger(attached) ?? 0,
        activityEpoch: parseInteger(activity),
        omxOwned: isOmxTmuxOwnedMarker(omxOwned),
        omxSessionId: normalizeOptionalString(omxSessionId),
        projectPath: normalizeOptionalString(projectPath),
        kind: normalizeOptionalString(kind),
      };
    })
    .filter((row) => row.name.length > 0);
}

function isNoTmuxServerError(error: unknown): boolean {
  const parts: string[] = [];
  if (error instanceof Error) parts.push(error.message);
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  if (typeof stderr === 'string') parts.push(stderr);
  if (Buffer.isBuffer(stderr)) parts.push(stderr.toString('utf-8'));
  return /no server running|failed to connect to server|can't find server|ENOENT/i.test(parts.join('\n'));
}

function resolveTmuxExecutable(): string {
  const override = process.env.OMX_TMUX_BINARY?.trim();
  if (override) return override;
  return resolveTmuxBinaryForPlatform() ?? 'tmux';
}

function defaultRunTmux(args: string[]): string {
  const output = execFileSync(resolveTmuxExecutable(), args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
    ...(process.platform === 'win32' ? { windowsHide: true } : {}),
  });
  return typeof output === 'string' ? output : '';
}

function getCurrentSessionName(
  runTmux: (args: string[]) => string,
  env: NodeJS.ProcessEnv,
  explicit?: string | null,
): string | null {
  if (explicit !== undefined) return explicit;
  if (!env.TMUX) return null;
  try {
    const tmuxPaneTarget = env.TMUX_PANE?.trim();
    const displayArgs = tmuxPaneTarget
      ? ['display-message', '-p', '-t', tmuxPaneTarget, '#S']
      : ['display-message', '-p', '#S'];
    return runTmux(displayArgs).trim() || null;
  } catch {
    return null;
  }
}

export function findStaleOmxTmuxSessions(
  rows: readonly TmuxIdleSessionRow[],
  options: {
    nowMs: number;
    ttlMs: number;
    includeAttached?: boolean;
    currentSessionName?: string | null;
  },
): StaleOmxTmuxSessionCandidate[] {
  if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) return [];
  return rows
    .filter((row) => row.omxOwned)
    .filter((row) => row.name !== options.currentSessionName)
    .filter((row) => options.includeAttached || row.attachedClients <= 0)
    .filter((row) => Number.isFinite(row.activityEpoch) && (row.activityEpoch ?? 0) > 0)
    .map((row) => {
      const activityMs = (row.activityEpoch ?? 0) * 1000;
      return {
        ...row,
        idleMs: Math.max(0, options.nowMs - activityMs),
        ttlMs: options.ttlMs,
        lastActivityAt: new Date(activityMs).toISOString(),
      };
    })
    .filter((candidate) => candidate.idleMs >= options.ttlMs)
    .sort((left, right) =>
      right.idleMs - left.idleMs
      || left.name.localeCompare(right.name),
    );
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formatCandidate(candidate: StaleOmxTmuxSessionCandidate): string {
  const metadata = [
    candidate.kind ? `kind=${candidate.kind}` : '',
    candidate.omxSessionId ? `session_id=${candidate.omxSessionId}` : '',
    candidate.projectPath ? `project=${candidate.projectPath}` : '',
  ].filter(Boolean).join(', ');
  const suffix = metadata ? ` (${metadata})` : '';
  return `${candidate.name} idle=${formatDuration(candidate.idleMs)} last_activity=${candidate.lastActivityAt}${suffix}`;
}

function emptyResult(config: OmxTmuxIdleCleanupConfig, dryRun: boolean, unavailable: boolean): CleanupStaleOmxTmuxSessionsResult {
  return {
    enabled: config.enabled,
    dryRun,
    ttlMs: config.ttlMs,
    includeAttached: config.includeAttached,
    unavailable,
    candidates: [],
    killed: [],
    failed: [],
  };
}

export async function cleanupStaleOmxTmuxSessions(
  args: readonly string[] = [],
  deps: CleanupStaleOmxTmuxSessionsDependencies = {},
): Promise<CleanupStaleOmxTmuxSessionsResult> {
  const rawEnv = deps.env ?? process.env;
  const configuredEnv = deps.env === undefined
    ? readConfiguredEnvOverrides(deps.codexHomeOverride ?? rawEnv.CODEX_HOME)
    : {};
  const env = { ...configuredEnv, ...rawEnv };
  const config = resolveOmxTmuxIdleCleanupConfig(env);
  const dryRun = args.includes('--dry-run');
  const quiet = args.includes('--quiet');
  const writeLine = deps.writeLine ?? ((line: string) => console.log(line));
  if (!config.enabled) {
    if (!quiet) writeLine('OMX tmux idle cleanup is disabled.');
    return emptyResult(config, dryRun, false);
  }

  const runTmux = deps.runTmux ?? defaultRunTmux;
  let rows: TmuxIdleSessionRow[] = [];
  try {
    rows = parseTmuxIdleSessionRows(runTmux(['list-sessions', '-F', TMUX_STALE_SESSION_FORMAT]));
  } catch (error) {
    if (isNoTmuxServerError(error)) {
      if (!quiet) {
        writeLine(dryRun
          ? 'Dry run: no tmux server available for OMX session idle cleanup.'
          : 'No tmux server available for OMX session idle cleanup.');
      }
      return emptyResult(config, dryRun, true);
    }
    throw error;
  }

  const currentSessionName = getCurrentSessionName(runTmux, env, deps.currentSessionName);
  const candidates = findStaleOmxTmuxSessions(rows, {
    nowMs: deps.now?.() ?? Date.now(),
    ttlMs: config.ttlMs,
    includeAttached: config.includeAttached,
    currentSessionName,
  });

  if (candidates.length === 0) {
    if (!quiet) {
      writeLine(dryRun
        ? `Dry run: no OMX-owned tmux sessions idle for ${formatDuration(config.ttlMs)} or longer.`
        : `No OMX-owned tmux sessions idle for ${formatDuration(config.ttlMs)} or longer.`);
    }
    return {
      ...emptyResult(config, dryRun, false),
      candidates,
    };
  }

  if (dryRun) {
    if (!quiet) {
      writeLine(`Dry run: would kill ${candidates.length} OMX-owned tmux session(s) idle for ${formatDuration(config.ttlMs)} or longer:`);
      for (const candidate of candidates) writeLine(`  ${formatCandidate(candidate)}`);
    }
    return {
      ...emptyResult(config, true, false),
      candidates,
    };
  }

  const killed: string[] = [];
  const failed: StaleOmxTmuxSessionFailure[] = [];
  for (const candidate of candidates) {
    try {
      runTmux(['kill-session', '-t', candidate.name]);
      killed.push(candidate.name);
      if (!quiet) writeLine(`Killed idle OMX tmux session: ${candidate.name}`);
    } catch (error) {
      failed.push({
        sessionName: candidate.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (!quiet) {
    writeLine(`Killed ${killed.length} idle OMX tmux session(s).`);
    if (failed.length > 0) {
      writeLine(`Warning: failed to kill ${failed.length} idle OMX tmux session(s): ${failed.map((entry) => entry.sessionName).join(', ')}`);
    }
  }

  return {
    enabled: config.enabled,
    dryRun: false,
    ttlMs: config.ttlMs,
    includeAttached: config.includeAttached,
    unavailable: false,
    candidates,
    killed,
    failed,
  };
}
