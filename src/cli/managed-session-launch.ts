import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from 'node:child_process';
import { parsePaneIdFromTmuxOutput } from '../hud/tmux.js';
import { buildSetOmxTmuxSessionMarkerArgs } from '../tmux/omx-session-markers.js';
import { resolveOmxCliEntryPath } from '../utils/paths.js';
import { buildPlatformCommandSpec, spawnPlatformCommandSync } from '../utils/platform-command.js';
import {
  buildDetachedTmuxSessionName,
  buildTmuxPaneCommand,
  buildWindowsPromptCommand,
} from './index.js';
import { generateOmxSessionId } from './session-id.js';

export interface DetachedManagedSessionLaunchOptions {
  cwd: string;
  cliArgs?: string[];
  sessionId?: string;
  codexHomeOverride?: string;
  notifyProfile?: string | null;
}

export interface DetachedManagedSessionLaunchResult {
  sessionId: string;
  tmuxSessionName: string;
  leaderPaneId: string;
  cwd: string;
}

interface ManagedSessionLaunchDeps {
  omxEntryPath?: string | null;
  resolveOmxCliEntryPathImpl?: typeof resolveOmxCliEntryPath;
  buildPlatformCommandSpecImpl?: typeof buildPlatformCommandSpec;
  spawnPlatformCommandSyncImpl?: (
    command: string,
    args: string[],
    options?: SpawnSyncOptionsWithStringEncoding,
  ) => {
    spec: { command: string; args: string[]; resolvedPath?: string };
    result: SpawnSyncReturns<string>;
  };
}

function summarizeTmuxFailure(prefix: string, result: SpawnSyncReturns<string>): Error {
  const details = [
    result.error?.message,
    (result.stderr || '').trim(),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  return new Error(details.length > 0 ? `${prefix}: ${details.join(' | ')}` : prefix);
}

function buildManagedSessionCommand(
  cwd: string,
  omxEntryPath: string,
  cliArgs: string[],
): string {
  if (process.platform === 'win32') {
    return buildWindowsPromptCommand(process.execPath, [omxEntryPath, ...cliArgs]);
  }

  return buildTmuxPaneCommand(process.execPath, [omxEntryPath, ...cliArgs], process.env.SHELL, cwd);
}

export async function launchDetachedManagedSession(
  options: DetachedManagedSessionLaunchOptions,
  deps: ManagedSessionLaunchDeps = {},
): Promise<DetachedManagedSessionLaunchResult> {
  const sessionId = options.sessionId?.trim() || generateOmxSessionId();
  const tmuxSessionName = buildDetachedTmuxSessionName(options.cwd, sessionId);
  const resolveOmxCliEntryPathImpl = deps.resolveOmxCliEntryPathImpl ?? resolveOmxCliEntryPath;
  const omxEntryPath = deps.omxEntryPath ?? resolveOmxCliEntryPathImpl();
  if (!omxEntryPath) {
    throw new Error('Unable to resolve the OMX CLI launcher path for detached managed session launch');
  }

  const cliArgs = Array.isArray(options.cliArgs) ? [...options.cliArgs] : [];
  const launchCommand = buildManagedSessionCommand(options.cwd, omxEntryPath, cliArgs);
  const newSessionArgs = [
    'new-session',
    '-d',
    '-P',
    '-F',
    '#{pane_id}',
    '-s',
    tmuxSessionName,
    '-c',
    options.cwd,
    '-e',
    `OMX_SESSION_ID=${sessionId}`,
    ...(options.codexHomeOverride
      ? ['-e', `CODEX_HOME=${options.codexHomeOverride}`]
      : []),
    ...(options.notifyProfile && options.notifyProfile.trim()
      ? ['-e', `OMX_NOTIFY_PROFILE=${options.notifyProfile.trim()}`]
      : []),
    launchCommand,
  ];

  const buildPlatformCommandSpecImpl = deps.buildPlatformCommandSpecImpl ?? buildPlatformCommandSpec;
  const spawnPlatformCommandSyncImpl = deps.spawnPlatformCommandSyncImpl ?? spawnPlatformCommandSync;
  const runTmux = (args: string[]) => {
    const tmuxSpec = buildPlatformCommandSpecImpl('tmux', args);
    return spawnPlatformCommandSyncImpl(tmuxSpec.command, tmuxSpec.args, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  };

  const execution = runTmux(newSessionArgs);
  const stdout = execution.result.stdout ?? '';

  if (execution.result.error || execution.result.status !== 0) {
    throw summarizeTmuxFailure('Failed to launch detached OMX session', execution.result);
  }

  const leaderPaneId = parsePaneIdFromTmuxOutput(stdout);
  if (!leaderPaneId) {
    throw new Error('Detached OMX session launch did not return a leader pane id');
  }

  for (const args of buildSetOmxTmuxSessionMarkerArgs(tmuxSessionName, {
    sessionId,
    projectPath: options.cwd,
    kind: 'session',
  })) {
    const mark = runTmux(args);
    if (mark.result.error || mark.result.status !== 0) {
      runTmux(['kill-session', '-t', tmuxSessionName]);
      throw summarizeTmuxFailure('Failed to mark detached OMX tmux session', mark.result);
    }
  }

  return {
    sessionId,
    tmuxSessionName,
    leaderPaneId,
    cwd: options.cwd,
  };
}

export async function killDetachedManagedSession(
  tmuxSessionName: string,
  deps: ManagedSessionLaunchDeps = {},
): Promise<boolean> {
  const trimmedSessionName = tmuxSessionName.trim();
  if (trimmedSessionName.length === 0) {
    return false;
  }

  const buildPlatformCommandSpecImpl = deps.buildPlatformCommandSpecImpl ?? buildPlatformCommandSpec;
  const spawnPlatformCommandSyncImpl = deps.spawnPlatformCommandSyncImpl ?? spawnPlatformCommandSync;
  const tmuxSpec = buildPlatformCommandSpecImpl('tmux', ['kill-session', '-t', trimmedSessionName]);
  const execution = spawnPlatformCommandSyncImpl(tmuxSpec.command, tmuxSpec.args, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return !execution.result.error && execution.result.status === 0;
}
