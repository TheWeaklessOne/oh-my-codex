import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from 'node:child_process';
import { parsePaneIdFromTmuxOutput } from '../hud/tmux.js';
import { resolveOmxEntryPath } from '../utils/paths.js';
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
  const omxEntryPath = deps.omxEntryPath ?? resolveOmxEntryPath();
  if (!omxEntryPath) {
    throw new Error('Unable to resolve the OMX launcher path for detached managed session launch');
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
  const tmuxSpec = buildPlatformCommandSpecImpl('tmux', newSessionArgs);
  const execution = spawnPlatformCommandSyncImpl(tmuxSpec.command, tmuxSpec.args, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = execution.result.stdout ?? '';
  const stderr = execution.result.stderr ?? '';

  if (execution.result.error || execution.result.status !== 0) {
    const details = [
      execution.result.error?.message,
      stderr.trim(),
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);
    throw new Error(
      details.length > 0
        ? `Failed to launch detached OMX session: ${details.join(' | ')}`
        : 'Failed to launch detached OMX session',
    );
  }

  const leaderPaneId = parsePaneIdFromTmuxOutput(stdout);
  if (!leaderPaneId) {
    throw new Error('Detached OMX session launch did not return a leader pane id');
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
