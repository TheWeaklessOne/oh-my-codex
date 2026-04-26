import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { stdin as defaultInput, stdout as defaultOutput, stderr as defaultError } from 'node:process';
import {
  isOmxTmuxOwnedMarker,
  OMX_TMUX_KIND_OPTION,
  OMX_TMUX_OWNED_OPTION,
  OMX_TMUX_PROJECT_PATH_OPTION,
  OMX_TMUX_SESSION_ID_OPTION,
  OMX_TMUX_TEAM_NAME_OPTION,
} from '../tmux/omx-session-markers.js';
import { resolveTmuxBinaryForPlatform } from '../utils/platform-command.js';
import {
  promptForSelectionsWithArrows,
  supportsInteractiveSelectUi,
  type InteractiveSelectionState,
  type SelectUiInput,
  type SelectUiOutput,
} from '../ui/select.js';

const HELP = `omx sessions - Browse and attach to live OMX tmux sessions

Usage:
  omx sessions                 Interactively choose a live OMX tmux session
  omx sessions list [--all]    Print grouped live OMX tmux sessions
  omx sessions --json [--all]  Emit grouped live OMX tmux sessions as JSON
  omx sessions attach <name|number> [--all]
                               Attach/switch to a session by exact name or list number

Options:
  --all               Include non-OMX tmux sessions
  --json              Emit structured JSON only
  -h, --help          Show this help

Examples:
  omx sessions
  omx sessions list
  omx sessions --json
  omx sessions attach 2
  omx sessions attach omx-oh-my-codex-main-1777233580203-m2zeq3

Notes:
  Inside tmux, attach uses:  tmux switch-client -t <session>
  Outside tmux, attach uses: tmux attach-session -t <session>
  The singular command remains history search: omx session search <query>
`;

const HELP_TOKENS = new Set(['--help', '-h', 'help']);
const TMUX_SESSION_FORMAT = [
  '#{session_name}',
  '#{session_attached}',
  '#{session_windows}',
  '#{session_created}',
  `#{${OMX_TMUX_OWNED_OPTION}}`,
  `#{${OMX_TMUX_SESSION_ID_OPTION}}`,
  `#{${OMX_TMUX_PROJECT_PATH_OPTION}}`,
  `#{${OMX_TMUX_KIND_OPTION}}`,
  `#{${OMX_TMUX_TEAM_NAME_OPTION}}`,
].join('\t');
const TMUX_PANE_FORMAT = '#{session_name}\t#{pane_id}\t#{pane_active}\t#{pane_current_path}\t#{pane_current_command}';
const ANSI_ESCAPE_PATTERN = /\u001b(?:\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/g;

type SessionsAction = 'interactive' | 'list' | 'attach' | 'help';

export interface ParsedSessionsArgs {
  action: SessionsAction;
  all: boolean;
  json: boolean;
  target?: string;
}

export interface TmuxRunOptions {
  stdio?: 'pipe' | 'inherit' | 'ignore';
}

export type TmuxRunner = (args: string[], options?: TmuxRunOptions) => string;

export interface SessionsCommandDeps {
  runTmux?: TmuxRunner;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  now?: Date;
  input?: SelectUiInput;
  output?: SelectUiOutput;
  errorOutput?: Pick<SelectUiOutput, 'write'>;
  resolveProjectRoot?: (path: string) => string;
  currentSessionName?: string | null;
  all?: boolean;
}

export interface OmxTmuxSession {
  name: string;
  status: 'attached' | 'detached';
  attached: boolean;
  attachedClients: number;
  windows: number;
  createdEpoch?: number;
  createdAt?: string;
  paneId?: string;
  paneCurrentPath?: string;
  paneCurrentCommand?: string;
  projectPath?: string;
  projectName: string;
  groupKey: string;
  groupLabel: string;
  groupKind: 'project' | 'team' | 'unknown';
  teamName?: string;
  inferredProject?: string;
  omxSessionId?: string;
  omxSessionKind?: string;
  omxOwned: boolean;
  current: boolean;
}

export interface SessionGroup {
  key: string;
  label: string;
  kind: 'project' | 'team' | 'unknown';
  projectPath?: string;
  teamName?: string;
  sessions: OmxTmuxSession[];
}

interface TmuxSessionRow {
  name: string;
  attachedClients: number;
  windows: number;
  createdEpoch?: number;
  omxOwned: boolean;
  omxSessionId?: string;
  omxProjectPath?: string;
  omxSessionKind?: string;
  omxTeamName?: string;
}

interface TmuxPaneRow {
  sessionName: string;
  paneId?: string;
  active: boolean;
  currentPath?: string;
  currentCommand?: string;
}

interface IndexedSession {
  index: number;
  session: OmxTmuxSession;
  group: SessionGroup;
}

export function parseSessionsArgs(args: string[]): ParsedSessionsArgs {
  let action: SessionsAction = 'interactive';
  let all = false;
  let json = false;
  let target: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (HELP_TOKENS.has(token)) return { action: 'help', all, json };
    if (token === '--all') {
      all = true;
      continue;
    }
    if (token === '--json') {
      if (action === 'attach') throw new Error('--json is only supported for listing sessions.');
      json = true;
      action = action === 'interactive' ? 'list' : action;
      continue;
    }
    if (token === 'list') {
      if (action !== 'interactive') throw new Error(`Unexpected sessions subcommand: ${token}`);
      action = 'list';
      continue;
    }
    if (token === 'attach') {
      if (action !== 'interactive') throw new Error(`Unexpected sessions subcommand: ${token}`);
      const next = args[index + 1];
      if (!next || next.startsWith('-')) throw new Error(`Missing session name or number after attach.\n${HELP.trim()}`);
      action = 'attach';
      target = next;
      index += 1;
      continue;
    }
    if (token.startsWith('-')) throw new Error(`Unknown option: ${token}`);
    throw new Error(`Unknown sessions subcommand: ${token}\n${HELP.trim()}`);
  }

  if (action === 'attach' && json) throw new Error('--json is only supported for listing sessions.');
  return { action, all, json, target };
}

function resolveTmuxExecutable(): string {
  const override = process.env.OMX_TMUX_BINARY?.trim();
  if (override) return override;
  return resolveTmuxBinaryForPlatform() ?? 'tmux';
}

function defaultRunTmux(args: string[], options: TmuxRunOptions = {}): string {
  const result = execFileSync(resolveTmuxExecutable(), args, {
    stdio: options.stdio ?? 'pipe',
    encoding: 'utf-8',
    ...(process.platform === 'win32' ? { windowsHide: true } : {}),
  });
  return typeof result === 'string' ? result : '';
}

function defaultResolveProjectRoot(path: string): string {
  try {
    const root = execFileSync('git', ['-C', path, 'rev-parse', '--show-toplevel'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
      ...(process.platform === 'win32' ? { windowsHide: true } : {}),
    }).trim();
    return root || path;
  } catch {
    return path;
  }
}

function isNoTmuxServerError(error: unknown): boolean {
  const parts: string[] = [];
  if (error instanceof Error) parts.push(error.message);
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  if (typeof stderr === 'string') parts.push(stderr);
  if (Buffer.isBuffer(stderr)) parts.push(stderr.toString('utf-8'));
  return /no server running|failed to connect to server/i.test(parts.join('\n'));
}

function sanitizeTerminalText(value: string): string {
  return value
    .replace(ANSI_ESCAPE_PATTERN, '')
    .replace(CONTROL_CHARACTER_PATTERN, '�');
}

function parseInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseSessionRows(raw: string): TmuxSessionRow[] {
  return raw
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const [
        name = '',
        attached = '0',
        windows = '0',
        created = '',
        omxOwned = '',
        omxSessionId = '',
        omxProjectPath = '',
        omxSessionKind = '',
        omxTeamName = '',
      ] = line.split('\t');
      return {
        name,
        attachedClients: parseInteger(attached) ?? 0,
        windows: parseInteger(windows) ?? 0,
        createdEpoch: parseInteger(created),
        omxOwned: isOmxTmuxOwnedMarker(omxOwned),
        omxSessionId: omxSessionId || undefined,
        omxProjectPath: omxProjectPath || undefined,
        omxSessionKind: omxSessionKind || undefined,
        omxTeamName: omxTeamName || undefined,
      };
    })
    .filter((row) => row.name.length > 0);
}

function parsePaneRows(raw: string): TmuxPaneRow[] {
  return raw
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const [sessionName = '', paneId = '', active = '0', currentPath = '', currentCommand = ''] = line.split('\t');
      return {
        sessionName,
        paneId: paneId || undefined,
        active: active === '1',
        currentPath: currentPath || undefined,
        currentCommand: currentCommand || undefined,
      };
    })
    .filter((row) => row.sessionName.length > 0);
}

function choosePaneForSession(panes: TmuxPaneRow[]): TmuxPaneRow | undefined {
  return panes.find((pane) => pane.active) ?? panes[0];
}

function inferProjectFromSessionName(name: string): { projectName: string; branchName?: string } {
  if (name.startsWith('omx-team-')) {
    return { projectName: name.slice('omx-team-'.length) || name };
  }

  const parts = name.replace(/^omx-/, '').split('-').filter(Boolean);
  const timestampIndex = parts.findIndex((part) => /^\d{10,}$/.test(part));
  const prefixParts = timestampIndex > 0 ? parts.slice(0, timestampIndex) : parts;
  if (prefixParts.length >= 2) {
    return {
      projectName: prefixParts.slice(0, -1).join('-') || prefixParts[0],
      branchName: prefixParts.at(-1),
    };
  }
  return { projectName: prefixParts.join('-') || name };
}

function getCurrentSessionName(runTmux: TmuxRunner, env: NodeJS.ProcessEnv, explicit?: string | null): string | null {
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

function sessionToOmxTmuxSession(
  row: TmuxSessionRow,
  pane: TmuxPaneRow | undefined,
  resolveProjectRoot: (path: string) => string,
  currentSessionName: string | null,
): OmxTmuxSession {
  const createdAt = row.createdEpoch ? new Date(row.createdEpoch * 1000).toISOString() : undefined;
  const teamName = row.omxTeamName
    ?? (row.name.startsWith('omx-team-') ? row.name.slice('omx-team-'.length) || row.name : undefined);
  const inferred = inferProjectFromSessionName(row.name);
  const projectPathSource = row.omxProjectPath ?? pane?.currentPath;
  const projectPath = projectPathSource ? resolveProjectRoot(projectPathSource) : undefined;

  let groupKind: OmxTmuxSession['groupKind'] = 'unknown';
  let groupKey = 'unknown';
  let groupLabel = 'unknown';
  let projectName = inferred.projectName;

  if (row.omxSessionKind === 'team' && teamName) {
    groupKind = 'team';
    groupKey = `team:${teamName}`;
    groupLabel = `team:${teamName}`;
    projectName = teamName;
  } else if (projectPath) {
    groupKind = 'project';
    groupKey = `project:${projectPath}`;
    groupLabel = basename(projectPath) || projectPath;
    projectName = basename(projectPath) || projectPath;
  } else if (inferred.projectName) {
    groupKind = 'project';
    groupKey = `project-name:${inferred.projectName}`;
    groupLabel = inferred.projectName;
    projectName = inferred.projectName;
  }

  return {
    name: row.name,
    status: row.attachedClients > 0 ? 'attached' : 'detached',
    attached: row.attachedClients > 0,
    attachedClients: row.attachedClients,
    windows: row.windows,
    createdEpoch: row.createdEpoch,
    createdAt,
    paneId: pane?.paneId,
    paneCurrentPath: pane?.currentPath,
    paneCurrentCommand: pane?.currentCommand,
    projectPath,
    projectName,
    groupKey,
    groupLabel,
    groupKind,
    teamName,
    inferredProject: inferred.projectName,
    omxSessionId: row.omxSessionId,
    omxSessionKind: row.omxSessionKind,
    omxOwned: row.omxOwned,
    current: currentSessionName === row.name,
  };
}

export function listOmxTmuxSessions(deps: SessionsCommandDeps = {}): OmxTmuxSession[] {
  const runTmux = deps.runTmux ?? defaultRunTmux;
  const resolveProjectRoot = deps.resolveProjectRoot ?? defaultResolveProjectRoot;
  const env = deps.env ?? process.env;
  let rawSessions = '';
  try {
    rawSessions = runTmux(['list-sessions', '-F', TMUX_SESSION_FORMAT]);
  } catch (error) {
    if (isNoTmuxServerError(error)) return [];
    throw error;
  }

  let rawPanes = '';
  try {
    rawPanes = runTmux(['list-panes', '-a', '-F', TMUX_PANE_FORMAT]);
  } catch (error) {
    if (!isNoTmuxServerError(error)) throw error;
  }

  const panesBySession = new Map<string, TmuxPaneRow[]>();
  for (const pane of parsePaneRows(rawPanes)) {
    const existing = panesBySession.get(pane.sessionName) ?? [];
    existing.push(pane);
    panesBySession.set(pane.sessionName, existing);
  }

  const currentSessionName = getCurrentSessionName(runTmux, env, deps.currentSessionName);
  return parseSessionRows(rawSessions)
    .filter((row) => deps.all || row.omxOwned)
    .map((row) => sessionToOmxTmuxSession(
      row,
      choosePaneForSession(panesBySession.get(row.name) ?? []),
      resolveProjectRoot,
      currentSessionName,
    ))
    .sort(compareSessions);
}

function compareSessions(left: OmxTmuxSession, right: OmxTmuxSession): number {
  return left.groupLabel.localeCompare(right.groupLabel)
    || Number(right.current) - Number(left.current)
    || Number(right.attached) - Number(left.attached)
    || (right.createdEpoch ?? 0) - (left.createdEpoch ?? 0)
    || left.name.localeCompare(right.name);
}

function compareGroups(left: SessionGroup, right: SessionGroup): number {
  const kindRank = (kind: SessionGroup['kind']) => (kind === 'team' ? 0 : kind === 'project' ? 1 : 2);
  return kindRank(left.kind) - kindRank(right.kind) || left.label.localeCompare(right.label) || left.key.localeCompare(right.key);
}

export function groupSessionsByProject(sessions: OmxTmuxSession[]): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();
  for (const session of sessions) {
    const group = groups.get(session.groupKey) ?? {
      key: session.groupKey,
      label: session.groupLabel,
      kind: session.groupKind,
      projectPath: session.projectPath,
      teamName: session.teamName,
      sessions: [],
    };
    group.sessions.push(session);
    groups.set(session.groupKey, group);
  }
  return [...groups.values()]
    .map((group) => ({ ...group, sessions: [...group.sessions].sort(compareSessions) }))
    .sort(compareGroups);
}

function enumerateSessions(groups: SessionGroup[]): IndexedSession[] {
  const indexed: IndexedSession[] = [];
  for (const group of groups) {
    for (const session of group.sessions) {
      indexed.push({ index: indexed.length + 1, session, group });
    }
  }
  return indexed;
}

function formatAge(createdEpoch: number | undefined, now: Date): string {
  if (!createdEpoch) return 'unknown';
  const ageSeconds = Math.max(0, Math.floor((now.getTime() - createdEpoch * 1000) / 1000));
  if (ageSeconds < 60) return `${ageSeconds}s`;
  const ageMinutes = Math.floor(ageSeconds / 60);
  if (ageMinutes < 60) return `${ageMinutes}m`;
  const ageHours = Math.floor(ageMinutes / 60);
  if (ageHours < 48) return `${ageHours}h`;
  return `${Math.floor(ageHours / 24)}d`;
}

function plural(count: number, singular: string, pluralValue = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralValue}`;
}

function groupHeader(group: SessionGroup): string {
  const label = sanitizeTerminalText(group.label);
  const suffix = group.projectPath && group.kind === 'project' ? `  ${sanitizeTerminalText(group.projectPath)}` : '';
  return `▾ ${label}${suffix}`;
}

function formatSessionLine(index: number, session: OmxTmuxSession, now: Date, activeIndex?: number): string {
  const cursor = activeIndex === index ? '›' : ' ';
  const current = session.current ? '  current' : '';
  const windows = `${session.windows}w`;
  const name = sanitizeTerminalText(session.name);
  return `  ${cursor} ${String(index).padStart(2, ' ')}  ${session.status.padEnd(8)}  ${formatAge(session.createdEpoch, now).padEnd(7)}  ${windows.padEnd(4)}  ${name}${current}`;
}

export function formatSessionsTable(groups: SessionGroup[], options: { now?: Date; includeHint?: boolean } = {}): string {
  const now = options.now ?? new Date();
  const indexed = enumerateSessions(groups);
  if (indexed.length === 0) return 'No live OMX tmux sessions found.';

  const lines = [
    `OMX tmux sessions (${plural(groups.length, 'group')}, ${plural(indexed.length, 'session')})`,
    '',
  ];
  for (const group of groups) {
    lines.push(groupHeader(group));
    for (const item of indexed.filter((candidate) => candidate.group.key === group.key)) {
      lines.push(formatSessionLine(item.index, item.session, now));
    }
    lines.push('');
  }
  if (options.includeHint) lines.push('Use omx sessions attach <number|session> to attach.');
  return lines.join('\n').trimEnd();
}

function formatInteractiveSessionsFrame(groups: SessionGroup[], state: InteractiveSelectionState, now: Date): string {
  const indexed = enumerateSessions(groups);
  const lines = [
    `OMX tmux sessions (${plural(groups.length, 'group')}, ${plural(indexed.length, 'session')})`,
    '',
  ];
  for (const group of groups) {
    lines.push(groupHeader(group));
    for (const item of indexed.filter((candidate) => candidate.group.key === group.key)) {
      lines.push(formatSessionLine(item.index, item.session, now, state.cursorIndex + 1));
    }
    lines.push('');
  }
  lines.push('Use ↑/↓ to move, Enter to attach, 1-9 to attach directly, q to quit.');
  return `${lines.join('\n')}\n`;
}

function groupsToJson(groups: SessionGroup[], now: Date): unknown {
  const indexed = enumerateSessions(groups);
  const indexByName = new Map(indexed.map((item) => [item.session.name, item.index]));
  return {
    kind: 'omx.sessions/v1',
    generated_at: now.toISOString(),
    group_count: groups.length,
    session_count: indexed.length,
    groups: groups.map((group) => ({
      key: group.key,
      label: group.label,
      kind: group.kind,
      project_path: group.projectPath,
      team_name: group.teamName,
      sessions: group.sessions.map((session) => ({
        index: indexByName.get(session.name),
        name: session.name,
        status: session.status,
        attached: session.attached,
        attached_clients: session.attachedClients,
        windows: session.windows,
        created_epoch: session.createdEpoch,
        created_at: session.createdAt,
        age_seconds: session.createdEpoch ? Math.max(0, Math.floor((now.getTime() - session.createdEpoch * 1000) / 1000)) : undefined,
        project: session.projectName,
        project_path: session.projectPath,
        pane_id: session.paneId,
        pane_current_path: session.paneCurrentPath,
        pane_current_command: session.paneCurrentCommand,
        team_name: session.teamName,
        inferred_project: session.inferredProject,
        omx_owned: session.omxOwned,
        omx_session_id: session.omxSessionId,
        omx_session_kind: session.omxSessionKind,
        current: session.current,
        attach_command_hint: `omx sessions attach ${indexByName.get(session.name) ?? session.name}`,
      })),
    })),
  };
}

function resolveSessionTarget(target: string, groups: SessionGroup[]): OmxTmuxSession | null {
  const numeric = /^\d+$/.test(target) ? Number.parseInt(target, 10) : null;
  if (numeric !== null) {
    return enumerateSessions(groups).find((item) => item.index === numeric)?.session ?? null;
  }
  const sessions = enumerateSessions(groups).map((item) => item.session);
  return sessions.find((session) => session.name === target) ?? null;
}

export function attachToTmuxSession(sessionName: string, deps: SessionsCommandDeps = {}): 'switch-client' | 'attach-session' | 'none' {
  const runTmux = deps.runTmux ?? defaultRunTmux;
  const env = deps.env ?? process.env;
  const output = deps.output ?? defaultOutput;
  if (env.TMUX) {
    const currentSessionName = getCurrentSessionName(runTmux, env, deps.currentSessionName);
    if (currentSessionName === sessionName) {
      output.write(`Already attached to ${sanitizeTerminalText(sessionName)}.\n`);
      return 'none';
    }
    runTmux(['switch-client', '-t', sessionName], { stdio: 'inherit' });
    return 'switch-client';
  }
  runTmux(['attach-session', '-t', sessionName], { stdio: 'inherit' });
  return 'attach-session';
}

async function runInteractive(groups: SessionGroup[], deps: SessionsCommandDeps, now: Date): Promise<void> {
  const input = deps.input ?? defaultInput;
  const output = deps.output ?? defaultOutput;
  const indexed = enumerateSessions(groups);
  if (indexed.length === 0) {
    output.write('No live OMX tmux sessions found.\n');
    return;
  }
  if (!supportsInteractiveSelectUi(input, output)) {
    output.write(`${formatSessionsTable(groups, { now, includeHint: true })}\n`);
    return;
  }

  const labels = indexed.map((item) => item.session.name);
  const selection = await promptForSelectionsWithArrows(
    {
      question: 'Select a live OMX tmux session',
      labels,
      allowQuit: true,
      renderFrame: (state) => formatInteractiveSessionsFrame(groups, state, now),
    },
    { input, output },
  );
  if (!selection) return;
  const selected = indexed[selection[0] - 1]?.session;
  if (!selected) throw new Error('Selected session no longer exists.');
  attachToTmuxSession(selected.name, deps);
}

export async function sessionsCommand(args: string[], deps: SessionsCommandDeps = {}): Promise<void> {
  const parsed = parseSessionsArgs(args);
  const output = deps.output ?? defaultOutput;
  const errorOutput = deps.errorOutput ?? defaultError;
  const now = deps.now ?? new Date();
  if (parsed.action === 'help') {
    output.write(`${HELP.trim()}\n`);
    return;
  }

  const sessions = listOmxTmuxSessions({ ...deps, all: parsed.all });
  const groups = groupSessionsByProject(sessions);

  if (parsed.json) {
    output.write(`${JSON.stringify(groupsToJson(groups, now), null, 2)}\n`);
    return;
  }

  if (parsed.action === 'list') {
    output.write(`${formatSessionsTable(groups, { now })}\n`);
    return;
  }

  if (parsed.action === 'attach') {
    const target = parsed.target;
    if (!target) throw new Error(`Missing session name or number after attach.\n${HELP.trim()}`);
    const session = resolveSessionTarget(target, groups);
    if (!session) {
      errorOutput.write(`No live OMX tmux session matches "${sanitizeTerminalText(target)}".\n`);
      process.exitCode = 1;
      return;
    }
    attachToTmuxSession(session.name, deps);
    return;
  }

  await runInteractive(groups, deps, now);
}
