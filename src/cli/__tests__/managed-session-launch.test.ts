import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  killDetachedManagedSession,
  launchDetachedManagedSession,
} from '../managed-session-launch.js';

describe('launchDetachedManagedSession', () => {
  it('returns detached launch metadata with the captured leader pane id', async () => {
    const observed: {
      command?: string;
      args?: string[];
      options?: { encoding?: string };
    } = {};

    const result = await launchDetachedManagedSession(
      {
        cwd: '/repo/project-a',
        sessionId: 'omx-explicit-session-1',
        codexHomeOverride: '/tmp/codex-home',
        notifyProfile: 'ops',
      },
      {
        omxEntryPath: '/repo/dist/cli/omx.js',
        buildPlatformCommandSpecImpl: (command, args) => ({ command, args }),
        spawnPlatformCommandSyncImpl: (command, args, options) => {
          observed.command = command;
          observed.args = [...args];
          observed.options = options;
          return {
            spec: { command, args, resolvedPath: command },
            result: {
              pid: 123,
              output: [],
              stdout: '%42\n',
              stderr: '',
              status: 0,
              signal: null,
            },
          };
        },
      },
    );

    assert.equal(observed.command, 'tmux');
    assert.deepEqual(
      observed.args?.slice(0, 8),
      ['new-session', '-d', '-P', '-F', '#{pane_id}', '-s', result.tmuxSessionName, '-c'],
    );
    assert.ok(observed.args?.includes('OMX_SESSION_ID=omx-explicit-session-1'));
    assert.ok(observed.args?.includes('CODEX_HOME=/tmp/codex-home'));
    assert.ok(observed.args?.includes('OMX_NOTIFY_PROFILE=ops'));
    assert.equal(result.sessionId, 'omx-explicit-session-1');
    assert.equal(result.leaderPaneId, '%42');
    assert.equal(result.cwd, '/repo/project-a');
  });

  it('fails when tmux does not return a pane id for the new session', async () => {
    await assert.rejects(
      () => launchDetachedManagedSession(
        {
          cwd: '/repo/project-a',
          sessionId: 'omx-explicit-session-2',
        },
        {
          omxEntryPath: '/repo/dist/cli/omx.js',
          buildPlatformCommandSpecImpl: (command, args) => ({ command, args }),
          spawnPlatformCommandSyncImpl: (command, args) => ({
            spec: { command, args, resolvedPath: command },
            result: {
              pid: 123,
              output: [],
              stdout: '',
              stderr: '',
              status: 0,
              signal: null,
            },
          }),
        },
      ),
      /leader pane id/i,
    );
  });

  it('uses the stable OMX CLI resolver when no explicit entry path is provided', async () => {
    const observed: { args?: string[] } = {};
    let resolverCalled = false;

    const result = await launchDetachedManagedSession(
      {
        cwd: '/repo/project-a',
        sessionId: 'omx-explicit-session-3',
      },
      {
        resolveOmxCliEntryPathImpl: () => {
          resolverCalled = true;
          return '/repo/dist/cli/omx.js';
        },
        buildPlatformCommandSpecImpl: (command, args) => ({ command, args }),
        spawnPlatformCommandSyncImpl: (command, args) => {
          observed.args = [...args];
          return {
            spec: { command, args, resolvedPath: command },
            result: {
              pid: 123,
              output: [],
              stdout: '%43\n',
              stderr: '',
              status: 0,
              signal: null,
            },
          };
        },
      },
    );

    assert.equal(resolverCalled, true);
    assert.equal(result.leaderPaneId, '%43');
    assert.match(observed.args?.at(-1) ?? '', /\/repo\/dist\/cli\/omx\.js/);
  });

  it('fails closed when the stable OMX CLI resolver has no launchable entry', async () => {
    await assert.rejects(
      () => launchDetachedManagedSession(
        {
          cwd: '/repo/project-a',
          sessionId: 'omx-explicit-session-4',
        },
        {
          resolveOmxCliEntryPathImpl: () => null,
          buildPlatformCommandSpecImpl: (command, args) => ({ command, args }),
          spawnPlatformCommandSyncImpl: () => {
            throw new Error('tmux must not be called without a CLI entry path');
          },
        },
      ),
      /OMX CLI launcher path/i,
    );
  });

  it('kills a detached tmux session by name', async () => {
    const observed: { command?: string; args?: string[] } = {};

    const killed = await killDetachedManagedSession(
      'omx-worktree-a-main',
      {
        buildPlatformCommandSpecImpl: (command, args) => ({ command, args }),
        spawnPlatformCommandSyncImpl: (command, args) => {
          observed.command = command;
          observed.args = [...args];
          return {
            spec: { command, args, resolvedPath: command },
            result: {
              pid: 123,
              output: [],
              stdout: '',
              stderr: '',
              status: 0,
              signal: null,
            },
          };
        },
      },
    );

    assert.equal(killed, true);
    assert.equal(observed.command, 'tmux');
    assert.deepEqual(observed.args, ['kill-session', '-t', 'omx-worktree-a-main']);
  });
});
