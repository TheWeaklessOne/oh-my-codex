import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildInjectedReplyInput } from '../../notifications/reply-listener.js';
import { recordPendingReplyOrigin } from '../../notifications/reply-origin-state.js';

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

async function writePendingReplyOrigin(
  workdir: string,
  sessionId: string,
  pending: {
    platform: 'telegram' | 'discord';
    inputText: string;
  },
  options: {
    includePrefix?: boolean;
    maxMessageLength?: number;
  } = {},
): Promise<void> {
  const injectedInput = buildInjectedReplyInput(
    pending.inputText,
    pending.platform,
    {
      includePrefix: options.includePrefix ?? true,
      maxMessageLength: options.maxMessageLength ?? 500,
    },
  );
  await recordPendingReplyOrigin(workdir, sessionId, {
    platform: pending.platform,
    injectedInput,
    createdAt: new Date('2026-04-23T00:00:00Z').toISOString(),
  });
}

function buildExpectedReplyInput(
  inputText: string,
  platform: 'telegram' | 'discord',
  options: {
    includePrefix?: boolean;
    maxMessageLength?: number;
  } = {},
): string {
  return buildInjectedReplyInput(inputText, platform, {
    includePrefix: options.includePrefix ?? true,
    maxMessageLength: options.maxMessageLength ?? 500,
  });
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

      const rawMessage = [
        'Implemented meaningful Telegram notifications.',
        'Created commit abc123 and all tests passed.',
      ].join('\n');

      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: 'sess-result-ready',
        thread_id: 'thread-result-ready',
        turn_id: 'turn-result-ready',
        input_messages: [],
        last_assistant_message: rawMessage,
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

  it('keeps result-ready for completions that include fenced git-status output', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-result-ready-git-status-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');

    try {
      await mkdir(join(workdir, '.omx', 'state'), { recursive: true });
      await writeNotificationConfig(codexHome);

      const rawMessage = [
        'Created the requested files:',
        '- `README.md` with a title and 3 short bullet points',
        '- `NOTES.md` with a 3-item checklist',
        '',
        'Ran `git status --short`:',
        '```text',
        '?? .gitignore',
        '?? AGENTS.md',
        '?? NOTES.md',
        '?? README.md',
        '?? TASK.md',
        '```',
        '',
        'Ready for review.',
      ].join('\n');

      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: 'sess-result-ready-git-status',
        thread_id: 'thread-result-ready-git-status',
        turn_id: 'turn-result-ready-git-status',
        input_messages: [],
        last_assistant_message: rawMessage,
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
      assert.match(body.message, /Created the requested files/i);
      assert.match(body.message, /README\.md/i);
      assert.match(body.message, /NOTES\.md/i);
      assert.doesNotMatch(body.message, /\?\? TASK\.md/i);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('keeps result-ready for completions that inline git-status porcelain output in verification bullets', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-result-ready-inline-git-status-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');

    try {
      await mkdir(join(workdir, '.omx', 'state'), { recursive: true });
      await writeNotificationConfig(codexHome);

      const rawMessage = [
        'Done in solo mode.',
        '',
        '- Created `README.md` with a title and 3 short bullet points.',
        '- Created `NOTES.md` with a 3-item checklist.',
        '- Kept both files intentionally small and simple.',
        '',
        'Verification:',
        '- Ran `git status --short` → ?? .gitignore, ?? AGENTS.md, ?? NOTES.md, ?? README.md, ?? TASK.md',
        '',
        'Ready for review.',
      ].join('\n');

      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: 'sess-result-ready-inline-git-status',
        thread_id: 'thread-result-ready-inline-git-status',
        turn_id: 'turn-result-ready-inline-git-status',
        input_messages: [],
        last_assistant_message: rawMessage,
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
      assert.match(body.message, /README\.md/i);
      assert.match(body.message, /NOTES\.md/i);
      assert.doesNotMatch(body.message, /\?\? \.gitignore/i);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('prefers changed-file bullets over verification bullets in result-ready notifications', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-result-ready-change-summary-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');

    try {
      await mkdir(join(workdir, '.omx', 'state'), { recursive: true });
      await writeNotificationConfig(codexHome);

      const rawMessage = [
        'Changed:',
        '- `README.md` — added a small title and 3 short bullet points for the Telegram smoke demo.',
        '- `NOTES.md` — added a 3-item checklist.',
        '',
        'Verification:',
        '- Confirmed both files contain the requested minimal content.',
        '- Ran `git status --short` successfully.',
        '',
        'Ready for review.',
      ].join('\n');

      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: 'sess-result-ready-change-summary',
        thread_id: 'thread-result-ready-change-summary',
        turn_id: 'turn-result-ready-change-summary',
        input_messages: [],
        last_assistant_message: rawMessage,
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
      assert.match(body.message, /README\.md/i);
      assert.match(body.message, /NOTES\.md/i);
      assert.doesNotMatch(body.message, /git status/i);
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

      const rawMessage = 'Would you like me to continue with the cleanup?';

      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: 'sess-input-needed',
        thread_id: 'thread-input-needed',
        turn_id: 'turn-input-needed',
        input_messages: [],
        last_assistant_message: rawMessage,
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

  it('emits result-ready for structured telegram follow-up turns even when semantic classification is noise', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-telegram-reply-followup-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');
    const sessionId = 'sess-telegram-followup';

    try {
      await mkdir(join(workdir, '.omx', 'state'), { recursive: true });
      await writeNotificationConfig(codexHome);
      await writePendingReplyOrigin(workdir, sessionId, {
        platform: 'telegram',
        inputText: 'Which time is it ?',
      });

      const rawMessage = 'It’s 11:47 PM on April 22, 2026 in Europe/Moscow (UTC+03:00).';
      const latestInput = buildExpectedReplyInput('Which time is it ?', 'telegram');
      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: sessionId,
        thread_id: 'thread-telegram-followup',
        turn_id: 'turn-telegram-followup',
        input_messages: [latestInput],
        last_assistant_message: rawMessage,
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
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('supports structured reply provenance when includePrefix is disabled', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-include-prefix-disabled-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');
    const sessionId = 'sess-include-prefix-disabled';

    try {
      await mkdir(join(workdir, '.omx', 'state'), { recursive: true });
      await writeNotificationConfig(codexHome);
      await writePendingReplyOrigin(workdir, sessionId, {
        platform: 'telegram',
        inputText: 'Which time is it ?',
      }, {
        includePrefix: false,
      });

      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: sessionId,
        thread_id: 'thread-include-prefix-disabled',
        turn_id: 'turn-include-prefix-disabled',
        input_messages: ['Which time is it ?'],
        last_assistant_message: 'It’s 11:47 PM on April 22, 2026 in Europe/Moscow (UTC+03:00).',
      }, {
        CODEX_HOME: codexHome,
        OMX_FETCH_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const requests = await readCapturedRequests(capturePath);
      assert.equal(requests.length, 1);
      const body = JSON.parse(requests[0].body) as { event: string };
      assert.equal(body.event, 'result-ready');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('does not force failed structured reply follow-ups into result-ready notifications', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-failed-reply-followup-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');
    const sessionId = 'sess-failed-reply-followup';

    try {
      await mkdir(join(workdir, '.omx', 'state'), { recursive: true });
      await writeNotificationConfig(codexHome);
      await writePendingReplyOrigin(workdir, sessionId, {
        platform: 'telegram',
        inputText: 'Run the tests again',
      });
      const latestInput = buildExpectedReplyInput('Run the tests again', 'telegram');

      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: sessionId,
        thread_id: 'thread-failed-reply-followup',
        turn_id: 'turn-failed-reply-followup',
        input_messages: [latestInput],
        last_assistant_message: 'Build failed: timeout while running npm test.',
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

  it('ignores reply-prefix spoofing when no structured reply provenance exists', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-prefix-spoof-'));
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
        session_id: 'sess-prefix-spoof',
        thread_id: 'thread-prefix-spoof',
        turn_id: 'turn-prefix-spoof',
        input_messages: ['[reply:telegram] Which time is it ?'],
        last_assistant_message: 'It’s 11:47 PM on April 22, 2026 in Europe/Moscow (UTC+03:00).',
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

  it('re-emits identical reply-origin follow-up turns when each turn has new structured provenance', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-structured-reply-dedupe-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');
    const sessionId = 'sess-structured-reply-dedupe';
    const env = {
      CODEX_HOME: codexHome,
      OMX_FETCH_CAPTURE_PATH: capturePath,
      NODE_OPTIONS: `--import=${preloadPath}`,
    };

    try {
      await mkdir(join(workdir, '.omx', 'state'), { recursive: true });
      await writeNotificationConfig(codexHome);

      await writePendingReplyOrigin(workdir, sessionId, {
        platform: 'telegram',
        inputText: 'Which time is it ?',
      });
      const latestInput = buildExpectedReplyInput('Which time is it ?', 'telegram');
      const first = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: sessionId,
        thread_id: 'thread-structured-reply-dedupe',
        turn_id: 'turn-structured-reply-dedupe-1',
        input_messages: [latestInput],
        last_assistant_message: 'It’s 11:47 PM on April 22, 2026 in Europe/Moscow (UTC+03:00).',
      }, env);
      assert.equal(first.status, 0, first.stderr || first.stdout);

      await writePendingReplyOrigin(workdir, sessionId, {
        platform: 'telegram',
        inputText: 'Which time is it ?',
      });
      const second = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: sessionId,
        thread_id: 'thread-structured-reply-dedupe',
        turn_id: 'turn-structured-reply-dedupe-2',
        input_messages: [latestInput],
        last_assistant_message: 'It’s 11:47 PM on April 22, 2026 in Europe/Moscow (UTC+03:00).',
      }, env);
      assert.equal(second.status, 0, second.stderr || second.stdout);

      const requests = await readCapturedRequests(capturePath);
      assert.equal(requests.length, 2);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('aligns session-idle hook metadata with the effective completed-turn event', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-hook-metadata-alignment-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const hookCapturePath = join(tempRoot, 'hook-captures.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');
    const sessionId = 'sess-hook-metadata-alignment';

    try {
      await mkdir(join(workdir, '.omx', 'state'), { recursive: true });
      await writeNotificationConfig(codexHome);
      await writeSessionIdleHookPlugin(workdir, hookCapturePath);
      await writePendingReplyOrigin(workdir, sessionId, {
        platform: 'telegram',
        inputText: 'Which time is it ?',
      });
      const latestInput = buildExpectedReplyInput('Which time is it ?', 'telegram');

      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: sessionId,
        thread_id: 'thread-hook-metadata-alignment',
        turn_id: 'turn-hook-metadata-alignment',
        input_messages: [latestInput],
        last_assistant_message: 'It’s 11:47 PM on April 22, 2026 in Europe/Moscow (UTC+03:00).',
      }, {
        CODEX_HOME: codexHome,
        OMX_FETCH_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const hookEvents = await readCapturedHookEvents(hookCapturePath);
      assert.equal(hookEvents.length, 1);
      assert.equal(hookEvents[0].semantic_notification_event, 'result-ready');
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
