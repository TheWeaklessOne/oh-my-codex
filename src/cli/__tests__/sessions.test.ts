import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import {
  attachToTmuxSession,
  formatSessionsTable,
  groupSessionsByProject,
  listOmxTmuxSessions,
  parseSessionsArgs,
  sessionsCommand,
  type TmuxRunOptions,
} from '../sessions.js';

class CaptureOutput {
  isTTY: boolean;
  chunks: string[] = [];

  constructor(isTTY = false) {
    this.isTTY = isTTY;
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  toString(): string {
    return this.chunks.join('');
  }
}

class FakeTtyInput extends EventEmitter {
  isTTY = true;
  rawMode = false;

  setRawMode(mode: boolean): void {
    this.rawMode = mode;
  }

  resume(): void {}
  pause(): void {}
}

function makeRunner() {
  const calls: Array<{ args: string[]; options?: TmuxRunOptions }> = [];
  const runTmux = (args: string[], options?: TmuxRunOptions): string => {
    calls.push({ args, options });
    if (args[0] === 'list-sessions') {
      return [
        'omx-oh-my-codex-main-1777233580-m2zeq3\t1\t2\t1777233580\t1\tsess-1\t/Users/me/oh-my-codex\tsession\t',
        'plain-user-session\t0\t1\t1777230000',
        'omx-team-alpha\t0\t3\t1777231000\t1\tsess-team\t/Users/me/oh-my-codex\tteam\talpha',
        'omx-yolo-main-1777132110-l98bq1\t0\t1\t1777132110\t1\tsess-yolo\t/Users/me/yolo\tsession\t',
        'omx-spoofed-prefix\t0\t1\t1777132000',
      ].join('\n');
    }
    if (args[0] === 'list-panes') {
      return [
        'omx-oh-my-codex-main-1777233580-m2zeq3\t%1\t1\t/Users/me/oh-my-codex\tzsh',
        'plain-user-session\t%2\t1\t/Users/me/plain\tzsh',
        'omx-team-alpha\t%3\t1\t/Users/me/oh-my-codex\tcodex',
        'omx-yolo-main-1777132110-l98bq1\t%4\t1\t/Users/me/yolo\tzsh',
        'omx-spoofed-prefix\t%5\t1\t/Users/me/spoof\tzsh',
      ].join('\n');
    }
    if (args[0] === 'display-message') return 'omx-oh-my-codex-main-1777233580-m2zeq3\n';
    return '';
  };
  return { runTmux, calls };
}

describe('parseSessionsArgs', () => {
  it('parses default, JSON list, list all, and attach forms', () => {
    assert.deepEqual(parseSessionsArgs([]), { action: 'interactive', all: false, json: false, target: undefined });
    assert.deepEqual(parseSessionsArgs(['--json']), { action: 'list', all: false, json: true, target: undefined });
    assert.deepEqual(parseSessionsArgs(['list', '--all']), { action: 'list', all: true, json: false, target: undefined });
    assert.deepEqual(parseSessionsArgs(['attach', '2']), { action: 'attach', all: false, json: false, target: '2' });
    assert.throws(() => parseSessionsArgs(['attach', '2', '--json']), /--json is only supported/);
  });
});

describe('listOmxTmuxSessions', () => {
  it('discovers, filters, annotates, and groups OMX tmux sessions', () => {
    const { runTmux } = makeRunner();
    const sessions = listOmxTmuxSessions({
      runTmux,
      env: { TMUX: '/tmp/tmux' },
      resolveProjectRoot: (path) => (path.includes('oh-my-codex') ? '/Users/me/oh-my-codex' : path),
    });

    assert.deepEqual(sessions.map((session) => session.name).sort(), [
      'omx-oh-my-codex-main-1777233580-m2zeq3',
      'omx-team-alpha',
      'omx-yolo-main-1777132110-l98bq1',
    ].sort());
    assert.equal(sessions.find((session) => session.name.startsWith('plain')), undefined);
    assert.equal(sessions.find((session) => session.name === 'omx-spoofed-prefix'), undefined);
    assert.equal(sessions.find((session) => session.name.startsWith('omx-oh'))?.current, true);
    assert.equal(sessions.find((session) => session.name === 'omx-team-alpha')?.groupKind, 'team');
    assert.equal(sessions.find((session) => session.name === 'omx-team-alpha')?.omxSessionKind, 'team');

    const groups = groupSessionsByProject(sessions);
    assert.equal(groups[0].key, 'team:alpha');
    assert.equal(groups.some((group) => group.projectPath === '/Users/me/oh-my-codex'), true);
  });

  it('uses TMUX_PANE when detecting the current tmux session', () => {
    const calls: string[][] = [];
    const runTmux = (args: string[]): string => {
      calls.push(args);
      if (args[0] === 'list-sessions') {
        return [
          'omx-current\t1\t1\t1777233580\t1\tsess-current\t/Users/me/current\tsession\t',
          'omx-other\t0\t1\t1777231000\t1\tsess-other\t/Users/me/other\tsession\t',
        ].join('\n');
      }
      if (args[0] === 'list-panes') {
        return [
          'omx-current\t%1\t1\t/Users/me/current\tzsh',
          'omx-other\t%2\t1\t/Users/me/other\tzsh',
        ].join('\n');
      }
      if (args.join('\0') === ['display-message', '-p', '-t', '%7', '#S'].join('\0')) return 'omx-current\n';
      return '';
    };

    const sessions = listOmxTmuxSessions({
      runTmux,
      env: { TMUX: '/tmp/tmux', TMUX_PANE: '%7' },
      resolveProjectRoot: (path) => path,
    });

    assert.equal(sessions.find((session) => session.name === 'omx-current')?.current, true);
    assert.deepEqual(calls.find((args) => args[0] === 'display-message'), ['display-message', '-p', '-t', '%7', '#S']);
  });

  it('can include non-OMX sessions with --all semantics', () => {
    const { runTmux } = makeRunner();
    const sessions = listOmxTmuxSessions({ runTmux, all: true, resolveProjectRoot: (path) => path });
    assert.equal(sessions.some((session) => session.name === 'plain-user-session'), true);
    assert.equal(sessions.some((session) => session.name === 'omx-spoofed-prefix'), true);
  });

  it('returns an empty list when no tmux server is running', () => {
    const sessions = listOmxTmuxSessions({
      runTmux: () => {
        throw new Error('no server running on /tmp/tmux-501/default');
      },
    });

    assert.deepEqual(sessions, []);
  });
});

describe('sessions formatting and JSON', () => {
  it('prints a grouped table with stable numeric indices', () => {
    const { runTmux } = makeRunner();
    const groups = groupSessionsByProject(listOmxTmuxSessions({ runTmux, resolveProjectRoot: (path) => path }));
    const table = formatSessionsTable(groups, { now: new Date(1777234000 * 1000) });

    assert.match(table, /OMX tmux sessions/);
    assert.match(table, /▾ team:alpha/);
    assert.match(table, /\b1\s+detached|\b1\s+attached/);
    assert.match(table, /omx-oh-my-codex-main-1777233580-m2zeq3/);
  });

  it('emits JSON only for omx sessions --json', async () => {
    const { runTmux } = makeRunner();
    const output = new CaptureOutput();
    await sessionsCommand(['--json'], {
      runTmux,
      output,
      now: new Date(1777234000 * 1000),
      resolveProjectRoot: (path) => path,
    });

    const parsed = JSON.parse(output.toString()) as {
      kind: string;
      session_count: number;
      groups: Array<{ sessions: Array<{ name: string; attach_command_hint: string }> }>;
    };
    assert.equal(parsed.kind, 'omx.sessions/v1');
    assert.equal(parsed.session_count, 3);
    assert.equal(parsed.groups.flatMap((group) => group.sessions).some((session) => session.name === 'plain-user-session'), false);
    assert.match(parsed.groups[0].sessions[0].attach_command_hint, /^omx sessions attach \d+/);
  });

  it('escapes tmux-provided control characters in terminal output only', async () => {
    const output = new CaptureOutput();
    await sessionsCommand(['list'], {
      runTmux: (args) => {
        if (args[0] === 'list-sessions') {
          return 'omx-\u001b]52;c;AAAA\u0007spoof\t0\t1\t1777233580\t1\tsess-spoof\t/Users/me/\u001b[31mred\tsession\t\n';
        }
        if (args[0] === 'list-panes') return 'omx-\u001b]52;c;AAAA\u0007spoof\t%1\t1\t/Users/me/\u001b[31mred\tzsh\n';
        return '';
      },
      output,
      resolveProjectRoot: (path) => path,
      now: new Date(1777234000 * 1000),
    });

    assert.doesNotMatch(output.toString(), /\u001b|\u0007/);
    assert.match(output.toString(), /omx-spoof/);
  });

  it('emits empty JSON when no tmux server is running', async () => {
    const output = new CaptureOutput();
    await sessionsCommand(['--json'], {
      runTmux: () => {
        throw new Error('failed to connect to server');
      },
      output,
    });

    const parsed = JSON.parse(output.toString()) as { session_count: number; groups: unknown[] };
    assert.equal(parsed.session_count, 0);
    assert.deepEqual(parsed.groups, []);
  });
});

describe('sessions attach behavior', () => {
  it('uses switch-client inside tmux', () => {
    const calls: Array<{ args: string[]; options?: TmuxRunOptions }> = [];
    const action = attachToTmuxSession('omx-target', {
      env: { TMUX: '/tmp/tmux' },
      currentSessionName: 'omx-other',
      runTmux: (args, options) => {
        calls.push({ args, options });
        return '';
      },
    });

    assert.equal(action, 'switch-client');
    assert.deepEqual(calls[0].args, ['switch-client', '-t', 'omx-target']);
    assert.equal(calls[0].options?.stdio, 'inherit');
  });

  it('uses attach-session outside tmux', () => {
    const calls: Array<{ args: string[]; options?: TmuxRunOptions }> = [];
    const action = attachToTmuxSession('omx-target', {
      env: {},
      runTmux: (args, options) => {
        calls.push({ args, options });
        return '';
      },
    });

    assert.equal(action, 'attach-session');
    assert.deepEqual(calls[0].args, ['attach-session', '-t', 'omx-target']);
  });

  it('resolves numeric attach targets from list ordering', async () => {
    const { runTmux, calls } = makeRunner();
    await sessionsCommand(['attach', '1'], {
      runTmux,
      env: { TMUX: '/tmp/tmux' },
      currentSessionName: 'omx-other',
      resolveProjectRoot: (path) => path,
      output: new CaptureOutput(),
      errorOutput: new CaptureOutput(),
    });

    const attachCall = calls.find((call) => call.args[0] === 'switch-client');
    assert.deepEqual(attachCall?.args, ['switch-client', '-t', 'omx-team-alpha']);
  });

  it('drives the default TTY interactive path into attach', async () => {
    const { runTmux, calls } = makeRunner();
    const input = new FakeTtyInput();
    const output = new CaptureOutput(true);
    const command = sessionsCommand([], {
      runTmux,
      env: { TMUX: '/tmp/tmux' },
      currentSessionName: 'omx-other',
      resolveProjectRoot: (path) => path,
      input,
      output,
      now: new Date(1777234000 * 1000),
    });

    queueMicrotask(() => {
      input.emit('keypress', '1', { sequence: '1' });
    });

    await command;
    assert.equal(input.rawMode, false);
    assert.deepEqual(calls.find((call) => call.args[0] === 'switch-client')?.args, ['switch-client', '-t', 'omx-team-alpha']);
  });

  it('does not hang in non-TTY default mode and prints attach hint', async () => {
    const { runTmux } = makeRunner();
    const output = new CaptureOutput();
    await sessionsCommand([], {
      runTmux,
      output,
      input: { isTTY: false, on() { return this; }, off() { return this; } },
      resolveProjectRoot: (path) => path,
      now: new Date(1777234000 * 1000),
    });

    assert.match(output.toString(), /Use omx sessions attach <number\|session>/);
  });
});
