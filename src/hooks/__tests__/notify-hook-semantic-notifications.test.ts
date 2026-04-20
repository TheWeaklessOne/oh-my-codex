import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');

async function writeNotificationConfig(codexHome: string): Promise<void> {
  await mkdir(codexHome, { recursive: true });
  await writeFile(join(codexHome, '.omx-config.json'), JSON.stringify({
    notifications: {
      enabled: true,
      verbosity: 'session',
      webhook: {
        enabled: true,
        url: 'https://example.com/hooks/notify',
      },
      events: {
        'session-start': { enabled: false },
        'session-stop': { enabled: false },
        'session-idle': { enabled: false },
        'result-ready': { enabled: true },
        'ask-user-question': { enabled: true },
        'session-end': { enabled: true },
      },
    },
  }, null, 2));
}

async function writeFetchCapturePreload(dir: string): Promise<string> {
  const preloadPath = join(dir, 'mock-fetch.mjs');
  await writeFile(preloadPath, `
import { appendFileSync } from 'node:fs';

const capturePath = process.env.OMX_FETCH_CAPTURE_PATH;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? String(input) : input.url;
  if (capturePath) {
    appendFileSync(capturePath, JSON.stringify({
      url,
      body: typeof init.body === 'string' ? init.body : '',
    }) + '\\n');
  }
  return new Response('', { status: 200 });
};
`, 'utf-8');
  return preloadPath;
}

async function readCapturedRequests(path: string): Promise<Array<{ url: string; body: string }>> {
  try {
    const raw = await readFile(path, 'utf-8');
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { url: string; body: string });
  } catch {
    return [];
  }
}

async function writeSessionIdleHookPlugin(workdir: string, capturePath: string): Promise<void> {
  const hooksDir = join(workdir, '.omx', 'hooks');
  await mkdir(hooksDir, { recursive: true });
  await writeFile(join(hooksDir, 'capture-session-idle.mjs'), `
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const capturePath = ${JSON.stringify(capturePath)};

export async function onHookEvent(event) {
  if (event.event !== 'session-idle') return;
  mkdirSync(dirname(capturePath), { recursive: true });
  appendFileSync(capturePath, JSON.stringify({
    reason: event.context?.reason || '',
    semantic_phase: event.context?.semantic_phase || '',
    semantic_notification_event: event.context?.semantic_notification_event || '',
    session_id: event.session_id || '',
    turn_id: event.turn_id || '',
  }) + '\\n');
}
`, 'utf-8');
}

async function readCapturedHookEvents(path: string): Promise<Array<Record<string, string>>> {
  try {
    const raw = await readFile(path, 'utf-8');
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, string>);
  } catch {
    return [];
  }
}

function runNotifyHook(
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
) {
  return spawnSync(process.execPath, ['dist/scripts/notify-hook.js', JSON.stringify(payload)], {
    cwd: repoRoot,
    encoding: 'utf-8',
    env: {
      ...process.env,
      ...env,
      OMX_TEAM_WORKER: '',
      TMUX: '',
      TMUX_PANE: '',
    },
  });
}

describe('notify-hook semantic notifications', () => {
  it('emits result-ready for finished summaries', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-result-ready-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');

    try {
      await mkdir(join(workdir, '.omx', 'state'), { recursive: true });
      await writeNotificationConfig(codexHome);

      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: 'sess-result-ready',
        thread_id: 'thread-result-ready',
        turn_id: 'turn-result-ready',
        input_messages: [],
        last_assistant_message: [
          'Implemented meaningful Telegram notifications.',
          'Created commit abc123 and all tests passed.',
        ].join('\n'),
      }, {
        CODEX_HOME: codexHome,
        OMX_FETCH_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const requests = await readCapturedRequests(capturePath);
      assert.equal(requests.length, 1);
      const body = JSON.parse(requests[0].body) as { event: string; message: string };
      assert.equal(body.event, 'result-ready');
      assert.match(body.message, /# Result Ready/);
      assert.match(body.message, /Created commit abc123 and all tests passed/i);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('emits ask-user-question for real approval prompts', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-input-needed-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');

    try {
      await mkdir(join(workdir, '.omx', 'state'), { recursive: true });
      await writeNotificationConfig(codexHome);

      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: 'sess-input-needed',
        thread_id: 'thread-input-needed',
        turn_id: 'turn-input-needed',
        input_messages: [],
        last_assistant_message: 'Would you like me to continue with the cleanup?',
      }, {
        CODEX_HOME: codexHome,
        OMX_FETCH_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const requests = await readCapturedRequests(capturePath);
      assert.equal(requests.length, 1);
      const body = JSON.parse(requests[0].body) as { event: string; message: string };
      assert.equal(body.event, 'ask-user-question');
      assert.match(body.message, /# Input Needed/);
      assert.match(body.message, /Would you like me to continue with the cleanup\?/);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('suppresses human-facing notifications for progress-only chatter', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-progress-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');

    try {
      await mkdir(join(workdir, '.omx', 'state'), { recursive: true });
      await writeNotificationConfig(codexHome);

      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: 'sess-progress',
        thread_id: 'thread-progress',
        turn_id: 'turn-progress',
        input_messages: [],
        last_assistant_message: 'I can continue with the plan from here.',
      }, {
        CODEX_HOME: codexHome,
        OMX_FETCH_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const requests = await readCapturedRequests(capturePath);
      assert.equal(requests.length, 0);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('preserves the coarse session-idle hook compatibility path for result-ready and ask-user-question turns', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-hook-compat-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const hookCapturePath = join(tempRoot, 'hook-captures.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');

    try {
      await mkdir(join(workdir, '.omx', 'state'), { recursive: true });
      await writeNotificationConfig(codexHome);
      await writeSessionIdleHookPlugin(workdir, hookCapturePath);

      const resultReady = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: 'sess-hook-result',
        thread_id: 'thread-hook-result',
        turn_id: 'turn-hook-result',
        input_messages: [],
        last_assistant_message: 'Ready for review.',
      }, {
        CODEX_HOME: codexHome,
        OMX_FETCH_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(resultReady.status, 0, resultReady.stderr || resultReady.stdout);

      const askUser = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: 'sess-hook-input',
        thread_id: 'thread-hook-input',
        turn_id: 'turn-hook-input',
        input_messages: [],
        last_assistant_message: 'Would you like me to continue with the cleanup?',
      }, {
        CODEX_HOME: codexHome,
        OMX_FETCH_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(askUser.status, 0, askUser.stderr || askUser.stdout);

      const hookEvents = await readCapturedHookEvents(hookCapturePath);
      assert.equal(hookEvents.length, 2);
      assert.deepEqual(
        hookEvents.map((event) => event.semantic_notification_event).sort(),
        ['ask-user-question', 'result-ready'],
      );
      assert.deepEqual(
        hookEvents.map((event) => event.reason),
        ['post_turn_idle_notification', 'post_turn_idle_notification'],
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('dedupes repeated identical semantic notifications within the same session and re-emits when the fingerprint changes', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-semantic-dedupe-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');

    try {
      await mkdir(join(workdir, '.omx', 'state'), { recursive: true });
      await writeNotificationConfig(codexHome);

      const env = {
        CODEX_HOME: codexHome,
        OMX_FETCH_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: `--import=${preloadPath}`,
      };

      const first = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: 'sess-dedupe',
        thread_id: 'thread-dedupe',
        turn_id: 'turn-dedupe-1',
        input_messages: [],
        last_assistant_message: 'Created commit abc123 and all tests passed.',
      }, env);
      assert.equal(first.status, 0, first.stderr || first.stdout);

      const second = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: 'sess-dedupe',
        thread_id: 'thread-dedupe',
        turn_id: 'turn-dedupe-2',
        input_messages: [],
        last_assistant_message: 'Created commit abc123 and all tests passed.',
      }, env);
      assert.equal(second.status, 0, second.stderr || second.stdout);

      let requests = await readCapturedRequests(capturePath);
      assert.equal(requests.length, 1);

      const third = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: 'sess-dedupe',
        thread_id: 'thread-dedupe',
        turn_id: 'turn-dedupe-3',
        input_messages: [],
        last_assistant_message: 'Implemented review flow and all tests passed.',
      }, env);
      assert.equal(third.status, 0, third.stderr || third.stdout);

      requests = await readCapturedRequests(capturePath);
      assert.equal(requests.length, 2);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
