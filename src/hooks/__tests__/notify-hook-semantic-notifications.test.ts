import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildInjectedReplyInput } from '../../notifications/reply-listener.js';
import { recordPendingReplyOrigin } from '../../notifications/reply-origin-state.js';
import { sanitizeLiveNotificationEnv } from '../../utils/test-env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');

async function writeNotificationConfig(
  codexHome: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await mkdir(codexHome, { recursive: true });
  const baseNotifications = {
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
  };
  await writeFile(join(codexHome, '.omx-config.json'), JSON.stringify({
    notifications: {
      ...baseNotifications,
      ...overrides,
      webhook: {
        ...baseNotifications.webhook,
        ...((typeof overrides.webhook === 'object' && overrides.webhook)
          ? overrides.webhook as Record<string, unknown>
          : {}),
      },
      events: {
        ...baseNotifications.events,
        ...((typeof overrides.events === 'object' && overrides.events)
          ? overrides.events as Record<string, unknown>
          : {}),
      },
    },
  }, null, 2));
}

async function writeFetchCapturePreload(dir: string, fixedNowIso = ''): Promise<string> {
  const preloadPath = join(dir, 'mock-fetch.mjs');
  await writeFile(preloadPath, `
import { appendFileSync } from 'node:fs';

${fixedNowIso ? buildFixedDatePreloadSource(fixedNowIso) : ''}
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

function buildFixedDatePreloadSource(fixedNowIso: string): string {
  return `
const __OMX_TEST_FIXED_NOW_ISO__ = ${JSON.stringify(fixedNowIso)};
const __OMX_TEST_REAL_DATE__ = Date;
globalThis.Date = class extends __OMX_TEST_REAL_DATE__ {
  constructor(...args) {
    if (args.length === 0) {
      super(__OMX_TEST_FIXED_NOW_ISO__);
    } else {
      super(...args);
    }
  }
  static now() {
    return __OMX_TEST_REAL_DATE__.parse(__OMX_TEST_FIXED_NOW_ISO__);
  }
  static parse(value) {
    return __OMX_TEST_REAL_DATE__.parse(value);
  }
  static UTC(...args) {
    return __OMX_TEST_REAL_DATE__.UTC(...args);
  }
};
`;
}

async function writeTelegramCapturePreload(dir: string): Promise<string> {
  const preloadPath = join(dir, 'mock-telegram.mjs');
  await writeFile(preloadPath, `
import { appendFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';

const capturePath = process.env.OMX_TELEGRAM_CAPTURE_PATH;
globalThis.__OMX_TEST_MOCK_TELEGRAM_TRANSPORT__ = 'https-request-capture';
const require = createRequire(import.meta.url);
const https = require('node:https');

https.request = (options, callback) => {
  const listeners = new Map();
  let requestBody = '';

  const emit = (event, value) => {
    for (const handler of listeners.get(event) ?? []) {
      handler(value);
    }
  };

  const request = {
    on(event, handler) {
      listeners.set(event, [...(listeners.get(event) ?? []), handler]);
      return request;
    },
    write(chunk) {
      requestBody += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : chunk;
      return true;
    },
    end() {
      queueMicrotask(() => {
        if (capturePath) {
          appendFileSync(capturePath, JSON.stringify({
            url: String(options?.path ?? ''),
            body: requestBody,
          }) + '\\n');
        }
        const response = new PassThrough();
        response.statusCode = 200;
        callback?.(response);
        response.end(JSON.stringify({
          ok: true,
          result: {
            message_id: 321,
            message_thread_id: 9001,
            is_topic_message: true,
          },
        }));
      });
      return request;
    },
    destroy(error) {
      if (error) emit('error', error);
      return request;
    },
  };

  return request;
};

syncBuiltinESMExports();
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

async function writeTelegramTopicRegistryRecord(
  homeDir: string,
  workdir: string,
  options: {
    botId?: string;
    chatId?: string;
    topicName?: string;
    messageThreadId?: string;
  } = {},
): Promise<void> {
  const sourceChatKey = `telegram:${options.botId ?? '123456'}:${options.chatId ?? '777'}`;
  const registryPath = join(homeDir, '.omx', 'state', 'telegram-topic-registry.json');
  const projectKey = createHash('sha256').update(workdir).digest('hex');
  await mkdir(join(homeDir, '.omx', 'state'), { recursive: true });
  await writeFile(registryPath, JSON.stringify({
    version: 1,
    records: [
      {
        sourceChatKey,
        projectKey,
        canonicalProjectPath: workdir,
        displayName: 'repo',
        topicName: options.topicName ?? 'repo-topic',
        messageThreadId: options.messageThreadId ?? '9001',
        createdAt: '2026-04-23T00:00:00.000Z',
        lastUsedAt: '2026-04-23T00:00:00.000Z',
      },
    ],
  }, null, 2));
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

async function writeCaptureAllHookPlugin(workdir: string, capturePath: string): Promise<void> {
  const hooksDir = join(workdir, '.omx', 'hooks');
  await mkdir(hooksDir, { recursive: true });
  await writeFile(join(hooksDir, 'capture-all-events.mjs'), `
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const capturePath = ${JSON.stringify(capturePath)};

export async function onHookEvent(event) {
  mkdirSync(dirname(capturePath), { recursive: true });
  appendFileSync(capturePath, JSON.stringify({
    event: event.event || '',
    source: event.source || '',
    session_id: event.session_id || '',
    thread_id: event.thread_id || '',
    turn_id: event.turn_id || '',
    output_preview: event.context?.output_preview || '',
    text: event.context?.text || '',
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

async function writeSubagentTrackingFixture(
  workdir: string,
  sessionId: string,
  leaderThreadId: string,
  subagentThreadId: string,
): Promise<void> {
  const now = '2026-04-25T00:00:00.000Z';
  const stateDir = join(workdir, '.omx', 'state');
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, 'subagent-tracking.json'), JSON.stringify({
    schemaVersion: 1,
    sessions: {
      [sessionId]: {
        session_id: sessionId,
        leader_thread_id: leaderThreadId,
        updated_at: now,
        threads: {
          [leaderThreadId]: {
            thread_id: leaderThreadId,
            kind: 'leader',
            first_seen_at: now,
            last_seen_at: now,
            turn_count: 1,
          },
          [subagentThreadId]: {
            thread_id: subagentThreadId,
            kind: 'subagent',
            first_seen_at: now,
            last_seen_at: now,
            turn_count: 1,
          },
        },
      },
    },
  }, null, 2));
}

function codexSessionDirForDate(home: string, now = new Date()): string {
  return join(
    home,
    '.codex',
    'sessions',
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  );
}

function todayCodexSessionDir(home: string): string {
  return codexSessionDirForDate(home);
}

function codexUtcSessionDirForDate(home: string, now = new Date()): string {
  return join(
    home,
    '.codex',
    'sessions',
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
  );
}

async function writeRolloutSessionMeta(
  home: string,
  sessionMeta: Record<string, unknown>,
  options: { now?: Date } = {},
): Promise<void> {
  const dir = codexSessionDirForDate(home, options.now);
  await writeRolloutSessionMetaAtDir(dir, sessionMeta);
}

async function writeUtcRolloutSessionMeta(
  home: string,
  sessionMeta: Record<string, unknown>,
  options: { now?: Date } = {},
): Promise<void> {
  const dir = codexUtcSessionDirForDate(home, options.now);
  await writeRolloutSessionMetaAtDir(dir, sessionMeta);
}

async function writeRolloutSessionMetaAtDir(
  dir: string,
  sessionMeta: Record<string, unknown>,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const threadId = String(sessionMeta.id || `thread-${Date.now()}`);
  await writeFile(
    join(dir, `rollout-test-${threadId}.jsonl`),
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'session_meta',
      payload: sessionMeta,
    })}\n`,
  );
}

async function readJsonLines(path: string): Promise<Array<Record<string, unknown>>> {
  const content = await readFile(path, 'utf-8').catch(() => '');
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function writeRolloutRecords(
  home: string,
  threadId: string,
  records: Array<Record<string, unknown>>,
  options: { now?: Date } = {},
): Promise<void> {
  const dir = codexSessionDirForDate(home, options.now);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `rollout-test-${threadId}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
  );
}

function parseLinuxProcStartTicks(statContent: string): number | undefined {
  const commandEnd = statContent.lastIndexOf(')');
  if (commandEnd === -1) return undefined;
  const fields = statContent.slice(commandEnd + 1).trim().split(/\s+/);
  if (fields.length <= 19) return undefined;
  const value = Number(fields[19]);
  return Number.isFinite(value) ? value : undefined;
}

function readCurrentLinuxIdentityForTest(): { startTicks: number; cmdline?: string } | null {
  if (process.platform !== 'linux') return null;
  try {
    const startTicks = parseLinuxProcStartTicks(readFileSync(`/proc/${process.pid}/stat`, 'utf-8'));
    if (typeof startTicks !== 'number') return null;
    let cmdline = '';
    try {
      cmdline = readFileSync(`/proc/${process.pid}/cmdline`, 'utf-8')
        .replace(/\u0000+/g, ' ')
        .trim();
    } catch {
      cmdline = '';
    }
    return {
      startTicks,
      ...(cmdline ? { cmdline } : {}),
    };
  } catch {
    return null;
  }
}

function buildOwnerSessionState(cwd: string, sessionId: string, nativeSessionId: string): Record<string, unknown> {
  const linuxIdentity = readCurrentLinuxIdentityForTest();
  return {
    session_id: sessionId,
    native_session_id: nativeSessionId,
    started_at: new Date().toISOString(),
    cwd,
    ...(process.platform === 'linux' && !linuxIdentity
      ? {}
      : {
        pid: process.pid,
        platform: process.platform,
      }),
    ...(linuxIdentity
      ? {
        pid_start_ticks: linuxIdentity.startTicks,
        ...(linuxIdentity.cmdline ? { pid_cmdline: linuxIdentity.cmdline } : {}),
      }
      : {}),
  };
}

function writeOwnerSessionStateSync(cwd: string, sessionId: string, nativeSessionId: string): void {
  const stateDir = join(cwd, '.omx', 'state');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, 'session.json'),
    JSON.stringify(buildOwnerSessionState(cwd, sessionId, nativeSessionId), null, 2),
  );
}

async function writeOwnerSessionState(cwd: string, sessionId: string, nativeSessionId: string): Promise<void> {
  await mkdir(join(cwd, '.omx', 'state'), { recursive: true });
  await writeFile(
    join(cwd, '.omx', 'state', 'session.json'),
    JSON.stringify(buildOwnerSessionState(cwd, sessionId, nativeSessionId), null, 2),
  );
}

function runNotifyHook(
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  options: {
    teamWorkerEnv?: string;
    ownerState?: boolean;
  } = {},
) {
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';
  const stateDir = cwd ? join(cwd, '.omx', 'state') : '';
  const sessionPath = stateDir ? join(stateDir, 'session.json') : '';
  const trackingPath = stateDir ? join(stateDir, 'subagent-tracking.json') : '';
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : '';
  const nativeSessionId = typeof payload.thread_id === 'string' ? payload.thread_id : sessionId;
  const origin = payload.origin && typeof payload.origin === 'object'
    ? payload.origin as Record<string, unknown>
    : null;
  const sessionMeta = payload.session_meta && typeof payload.session_meta === 'object'
    ? payload.session_meta as Record<string, unknown>
    : null;
  const sessionMetaSource = sessionMeta?.source && typeof sessionMeta.source === 'object'
    ? sessionMeta.source as Record<string, unknown>
    : null;
  const isSubagentPayload = origin?.kind === 'native-subagent'
    || origin?.kind === 'subagent'
    || Boolean(sessionMetaSource?.subagent);
  if (
    options.ownerState !== false
    && !options.teamWorkerEnv
    && !isSubagentPayload
    && cwd
    && sessionId
    && nativeSessionId
    && !existsSync(sessionPath)
    && !existsSync(trackingPath)
  ) {
    writeOwnerSessionStateSync(cwd, sessionId, nativeSessionId);
  }

  return spawnSync(process.execPath, [join(repoRoot, 'dist/scripts/notify-hook.js'), JSON.stringify(payload)], {
    cwd: repoRoot,
    encoding: 'utf-8',
    env: {
      ...sanitizeLiveNotificationEnv(process.env),
      ...env,
      OMX_TEAM_WORKER: options.teamWorkerEnv ?? '',
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
      assert.equal(body.message, rawMessage);
      assert.doesNotMatch(body.message, /# Result Ready/);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('supports opting result-ready back into formatted notifications via config', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-result-ready-formatted-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');

    try {
      await mkdir(join(workdir, '.omx', 'state'), { recursive: true });
      await writeNotificationConfig(codexHome, {
        completedTurn: {
          resultReadyMode: 'formatted-notification',
        },
      });

      const rawMessage = 'Implemented meaningful Telegram notifications.\nCreated commit abc123 and all tests passed.';

      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: 'sess-result-ready-formatted',
        thread_id: 'thread-result-ready-formatted',
        turn_id: 'turn-result-ready-formatted',
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
      assert.equal(body.message, rawMessage);
      assert.match(body.message, /\?\? TASK\.md/i);
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
      assert.equal(body.message, rawMessage);
      assert.match(body.message, /\?\? \.gitignore/i);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('sends the full raw assistant text even when semantic summaries prefer changed-file bullets', async () => {
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
      assert.equal(body.message, rawMessage);
      assert.match(body.message, /git status/i);
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
      assert.equal(body.message, rawMessage);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('supports opting ask-user-question back into formatted notifications via config', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-input-needed-formatted-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');

    try {
      await mkdir(join(workdir, '.omx', 'state'), { recursive: true });
      await writeNotificationConfig(codexHome, {
        completedTurn: {
          askUserQuestionMode: 'formatted-notification',
        },
      });

      const rawMessage = 'Would you like me to continue with the cleanup?';

      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: 'sess-input-needed-formatted',
        thread_id: 'thread-input-needed-formatted',
        turn_id: 'turn-input-needed-formatted',
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
      assert.equal(body.message, rawMessage);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('reuses stored Telegram topic routing for structured follow-up turns', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-telegram-topic-followup-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'telegram-captures.ndjson');
    const preloadPath = await writeTelegramCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');
    const sessionId = 'sess-telegram-topic-followup';

    try {
      await mkdir(join(workdir, '.omx', 'state'), { recursive: true });
      await writeNotificationConfig(codexHome, {
        webhook: {
          enabled: false,
        },
        telegram: {
          enabled: true,
          botToken: '123456:telegram-token',
          chatId: '777',
          projectTopics: {
            enabled: true,
          },
        },
      });
      await writeTelegramTopicRegistryRecord(tempRoot, workdir, {
        botId: '123456',
        chatId: '777',
        topicName: 'repo-topic',
        messageThreadId: '9001',
      });
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
        thread_id: 'thread-telegram-topic-followup',
        turn_id: 'turn-telegram-topic-followup',
        input_messages: [latestInput],
        last_assistant_message: rawMessage,
      }, {
        CODEX_HOME: codexHome,
        HOME: tempRoot,
        USERPROFILE: tempRoot,
        OMX_TELEGRAM_CAPTURE_PATH: capturePath,
        OMX_TEST_MOCK_TELEGRAM_TRANSPORT: '1',
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const requests = await readCapturedRequests(capturePath);
      const sendMessageRequests = requests.filter((request) => /sendMessage/.test(request.url));
      assert.equal(sendMessageRequests.length, 1);
      const body = JSON.parse(sendMessageRequests[0].body) as {
        text: string;
        message_thread_id?: number;
        parse_mode?: string;
      };
      assert.equal(body.text, rawMessage);
      assert.equal(body.message_thread_id, 9001);
      assert.equal('parse_mode' in body, false);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('sends a Russian leader final as one raw Telegram result-ready message in the project topic', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-russian-leader-topic-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'telegram-captures.ndjson');
    const preloadPath = await writeTelegramCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');
    const rawMessage = 'Готово — составил план исправления...';

    try {
      await mkdir(join(workdir, '.omx', 'state'), { recursive: true });
      await writeNotificationConfig(codexHome, {
        webhook: { enabled: false },
        telegram: {
          enabled: true,
          botToken: '123456:telegram-token',
          chatId: '777',
          projectTopics: { enabled: true },
        },
      });
      await writeTelegramTopicRegistryRecord(tempRoot, workdir, {
        botId: '123456',
        chatId: '777',
        topicName: 'repo-topic',
        messageThreadId: '9001',
      });

      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: 'sess-russian-leader-topic',
        thread_id: 'thread-russian-leader',
        turn_id: 'turn-russian-leader',
        input_messages: [],
        last_assistant_message: rawMessage,
        origin: { kind: 'leader' },
      }, {
        CODEX_HOME: codexHome,
        HOME: tempRoot,
        USERPROFILE: tempRoot,
        OMX_TELEGRAM_CAPTURE_PATH: capturePath,
        OMX_TEST_MOCK_TELEGRAM_TRANSPORT: '1',
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const requests = await readCapturedRequests(capturePath);
      const sendMessageRequests = requests.filter((request) => /sendMessage/.test(request.url));
      assert.equal(sendMessageRequests.length, 1);
      const body = JSON.parse(sendMessageRequests[0].body) as {
        text: string;
        message_thread_id?: number;
        parse_mode?: string;
      };
      assert.equal(body.text, rawMessage);
      assert.equal(body.message_thread_id, 9001);
      assert.equal('parse_mode' in body, false);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('suppresses the same Russian final text from a native subagent', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-russian-subagent-suppressed-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'telegram-captures.ndjson');
    const preloadPath = await writeTelegramCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');
    const rawMessage = 'Готово — составил план исправления...';

    try {
      await mkdir(join(workdir, '.omx', 'state'), { recursive: true });
      await writeNotificationConfig(codexHome, {
        webhook: { enabled: false },
        telegram: {
          enabled: true,
          botToken: '123456:telegram-token',
          chatId: '777',
          projectTopics: { enabled: true },
        },
      });
      await writeTelegramTopicRegistryRecord(tempRoot, workdir);

      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: 'sess-russian-subagent-suppressed',
        thread_id: 'thread-russian-subagent',
        turn_id: 'turn-russian-subagent',
        input_messages: [],
        last_assistant_message: rawMessage,
        origin: {
          kind: 'native-subagent',
          parent_thread_id: 'thread-russian-leader',
          agent_nickname: 'explore',
        },
      }, {
        CODEX_HOME: codexHome,
        HOME: tempRoot,
        USERPROFILE: tempRoot,
        OMX_TELEGRAM_CAPTURE_PATH: capturePath,
        OMX_TEST_MOCK_TELEGRAM_TRANSPORT: '1',
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const requests = await readCapturedRequests(capturePath);
      assert.equal(requests.filter((request) => /sendMessage/.test(request.url)).length, 0);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('uses rollout session metadata to suppress first native subagent completed-turn payloads', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-rollout-subagent-suppressed-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');
    const sessionId = 'sess-rollout-subagent-suppressed';
    const leaderThreadId = 'thread-rollout-leader';
    const subagentThreadId = 'thread-rollout-subagent';

    try {
      await writeNotificationConfig(codexHome);
      await writeRolloutSessionMeta(tempRoot, {
        id: subagentThreadId,
        cwd: workdir,
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: leaderThreadId,
            },
            agent_nickname: 'Godel',
            agent_role: 'code-reviewer',
          },
        },
        agent_nickname: 'Godel',
        agent_role: 'code-reviewer',
      });

      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: sessionId,
        thread_id: subagentThreadId,
        turn_id: 'turn-rollout-subagent',
        input_messages: [],
        last_assistant_message: '{"findings":[{"severity":"high"}]}',
      }, {
        CODEX_HOME: codexHome,
        HOME: tempRoot,
        USERPROFILE: tempRoot,
        OMX_FETCH_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const requests = await readCapturedRequests(capturePath);
      assert.equal(requests.length, 0);

      const notifyLog = join(workdir, '.omx', 'logs', `notify-hook-${new Date().toISOString().split('T')[0]}.jsonl`);
      const entries = (await readFile(notifyLog, 'utf-8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const suppressedEntry = entries.find((entry) => entry.type === 'completed_turn_suppressed_non_leader');
      assert.equal(suppressedEntry?.origin_kind, 'native-subagent');
      assert.equal(suppressedEntry?.parent_thread_id, leaderThreadId);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('uses local-date rollout metadata to suppress native subagent output across a UTC boundary', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-rollout-local-boundary-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const fixedNowIso = '2026-04-26T21:30:00.000Z';
    const preloadPath = await writeFetchCapturePreload(tempRoot, fixedNowIso);
    const workdir = join(tempRoot, 'repo');
    const sessionId = 'sess-rollout-local-boundary';
    const leaderThreadId = 'thread-local-boundary-leader';
    const subagentThreadId = 'thread-local-boundary-subagent';

    try {
      await writeNotificationConfig(codexHome);
      await writeRolloutSessionMeta(tempRoot, {
        id: subagentThreadId,
        cwd: workdir,
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: leaderThreadId,
            },
            agent_nickname: 'Reviewer',
            agent_role: 'code-reviewer',
          },
        },
        agent_nickname: 'Reviewer',
        agent_role: 'code-reviewer',
      }, { now: new Date(2026, 3, 27, 0, 30) });

      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: sessionId,
        thread_id: subagentThreadId,
        turn_id: 'turn-local-boundary-subagent',
        input_messages: [],
        last_assistant_message: '{"findings":[{"severity":"high","blocking":true}]}',
      }, {
        CODEX_HOME: codexHome,
        HOME: tempRoot,
        USERPROFILE: tempRoot,
        TZ: 'Europe/Moscow',
        OMX_FETCH_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const requests = await readCapturedRequests(capturePath);
      assert.equal(requests.length, 0);

      const notifyLog = join(workdir, '.omx', 'logs', 'notify-hook-2026-04-26.jsonl');
      const entries = (await readFile(notifyLog, 'utf-8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const suppressedEntry = entries.find((entry) =>
        entry.type === 'completed_turn_suppressed_non_leader'
        || entry.type === 'completed_turn_delivery_suppressed'
      );
      assert.equal(suppressedEntry?.origin_kind, 'native-subagent');
      assert.equal(suppressedEntry?.parent_thread_id, leaderThreadId);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('uses UTC-date rollout metadata to suppress native subagent output across a local-date boundary', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-rollout-utc-boundary-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const fixedNowIso = '2026-04-26T21:30:00.000Z';
    const preloadPath = await writeFetchCapturePreload(tempRoot, fixedNowIso);
    const workdir = join(tempRoot, 'repo');
    const sessionId = 'sess-rollout-utc-boundary';
    const leaderThreadId = 'thread-utc-boundary-leader';
    const subagentThreadId = 'thread-utc-boundary-subagent';

    try {
      await writeNotificationConfig(codexHome);
      await writeUtcRolloutSessionMeta(tempRoot, {
        id: subagentThreadId,
        cwd: workdir,
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: leaderThreadId,
            },
            agent_nickname: 'Reviewer',
            agent_role: 'code-reviewer',
          },
        },
        agent_nickname: 'Reviewer',
        agent_role: 'code-reviewer',
      }, { now: new Date(fixedNowIso) });

      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: sessionId,
        thread_id: subagentThreadId,
        turn_id: 'turn-utc-boundary-subagent',
        input_messages: [],
        last_assistant_message: '{"findings":[{"severity":"high","blocking":true}]}',
      }, {
        CODEX_HOME: codexHome,
        HOME: tempRoot,
        USERPROFILE: tempRoot,
        TZ: 'Europe/Moscow',
        OMX_FETCH_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      assert.equal((await readCapturedRequests(capturePath)).length, 0);
      const notifyLog = join(workdir, '.omx', 'logs', 'notify-hook-2026-04-26.jsonl');
      const entries = await readJsonLines(notifyLog);
      const suppressedEntry = entries.find((entry) =>
        entry.type === 'completed_turn_suppressed_non_leader'
        || entry.type === 'completed_turn_delivery_suppressed'
      );
      assert.equal(suppressedEntry?.origin_kind, 'native-subagent');
      assert.equal(suppressedEntry?.parent_thread_id, leaderThreadId);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('allows the current external owner even when stale tracking marks the owner thread as a subagent', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-owner-wins-tracking-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');
    const sessionId = 'sess-owner-wins-tracking';
    const ownerThreadId = 'thread-current-owner';
    const rawMessage = 'Implemented notification routing. Verification passed.';

    try {
      await mkdir(join(workdir, '.omx', 'state'), { recursive: true });
      await writeNotificationConfig(codexHome);
      await writeOwnerSessionState(workdir, sessionId, ownerThreadId);
      await writeSubagentTrackingFixture(workdir, sessionId, 'thread-stale-leader', ownerThreadId);

      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: ownerThreadId,
        thread_id: ownerThreadId,
        turn_id: 'turn-current-owner',
        input_messages: [],
        last_assistant_message: rawMessage,
      }, {
        CODEX_HOME: codexHome,
        HOME: tempRoot,
        USERPROFILE: tempRoot,
        OMX_FETCH_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const requests = await readCapturedRequests(capturePath);
      assert.equal(requests.length, 1);
      const body = JSON.parse(requests[0].body) as { event: string; message: string };
      assert.equal(body.event, 'result-ready');
      assert.equal(body.message, rawMessage);

      const notifyLog = join(workdir, '.omx', 'logs', `notify-hook-${new Date().toISOString().split('T')[0]}.jsonl`);
      const entries = (await readFile(notifyLog, 'utf-8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      assert.ok(entries.some((entry) =>
        entry.type === 'completed_turn_delivery_allowed'
        && entry.reason === 'current_external_owner'
      ));
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('suppresses and logs unknown non-owner completed-turn output fail-closed', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-unknown-non-owner-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');
    const ownerSessionId = 'sess-current-owner';

    try {
      await mkdir(join(workdir, '.omx', 'state'), { recursive: true });
      await writeNotificationConfig(codexHome);
      await writeOwnerSessionState(workdir, ownerSessionId, 'thread-current-owner');

      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: 'sess-unknown-child',
        thread_id: 'thread-unknown-child',
        turn_id: 'turn-unknown-child',
        input_messages: [],
        last_assistant_message: '{"findings":[{"severity":"critical","blocking":true}]}',
      }, {
        CODEX_HOME: codexHome,
        HOME: tempRoot,
        USERPROFILE: tempRoot,
        OMX_FETCH_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      assert.equal((await readCapturedRequests(capturePath)).length, 0);
      const notifyLog = join(workdir, '.omx', 'logs', `notify-hook-${new Date().toISOString().split('T')[0]}.jsonl`);
      const entries = (await readFile(notifyLog, 'utf-8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const suppressed = entries.find((entry) => entry.type === 'completed_turn_delivery_suppressed');
      assert.equal(suppressed?.origin_kind, 'unknown');
      assert.equal(suppressed?.audience, 'unknown-non-owner');
      assert.equal(suppressed?.reason, 'unknown_non_owner_fail_closed');
      assert.ok(Array.isArray(suppressed?.origin_evidence));
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('suppresses unknown completed-turn output when no current owner state exists', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-unknown-no-owner-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');
    const rawMessage = '{"findings":[{"severity":"critical","blocking":true}]}';

    try {
      await mkdir(join(workdir, '.omx', 'state'), { recursive: true });
      await writeNotificationConfig(codexHome);

      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: 'sess-unmanaged-unknown',
        thread_id: 'thread-unmanaged-unknown',
        turn_id: 'turn-unmanaged-unknown',
        input_messages: [],
        last_assistant_message: rawMessage,
      }, {
        CODEX_HOME: codexHome,
        HOME: tempRoot,
        USERPROFILE: tempRoot,
        OMX_FETCH_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: `--import=${preloadPath}`,
      }, {
        ownerState: false,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      assert.equal((await readCapturedRequests(capturePath)).length, 0);
      const notifyLog = join(workdir, '.omx', 'logs', `notify-hook-${new Date().toISOString().split('T')[0]}.jsonl`);
      const entries = await readJsonLines(notifyLog);
      const suppressed = entries.find((entry) => entry.type === 'completed_turn_delivery_suppressed');
      assert.equal(suppressed?.origin_kind, 'unknown');
      assert.equal(suppressed?.audience, 'unknown-non-owner');
      assert.equal(suppressed?.reason, 'unknown_without_current_owner_fail_closed');

      const hudState = JSON.parse(
        await readFile(join(workdir, '.omx', 'state', 'hud-state.json'), 'utf-8'),
      ) as Record<string, unknown>;
      assert.equal(hudState.last_agent_output, '');
      assert.equal(hudState.last_agent_output_redacted, true);
      assert.equal(hudState.last_agent_output_length, rawMessage.length);
      assert.equal(hudState.last_agent_output_suppression_reason, 'unknown_without_current_owner_fail_closed');
      assert.equal(hudState.last_agent_output_audience, 'unknown-non-owner');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('does not track suppressed unknown non-owner turns as leaders', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-unknown-non-owner-tracking-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');
    const ownerSessionId = 'sess-current-owner-no-poison';
    const unknownThreadId = 'thread-unknown-non-owner-no-poison';

    try {
      await mkdir(join(workdir, '.omx', 'state'), { recursive: true });
      await writeNotificationConfig(codexHome);
      await writeOwnerSessionState(workdir, ownerSessionId, 'thread-current-owner-no-poison');

      const env = {
        CODEX_HOME: codexHome,
        HOME: tempRoot,
        USERPROFILE: tempRoot,
        OMX_FETCH_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: `--import=${preloadPath}`,
      };
      for (const turnId of ['turn-unknown-no-poison-1', 'turn-unknown-no-poison-2']) {
        const result = runNotifyHook({
          cwd: workdir,
          type: 'agent-turn-complete',
          session_id: 'sess-unknown-non-owner-no-poison',
          thread_id: unknownThreadId,
          turn_id: turnId,
          input_messages: [],
          last_assistant_message: '{"findings":[{"severity":"critical","blocking":true}]}',
        }, env);
        assert.equal(result.status, 0, result.stderr || result.stdout);
      }

      assert.equal((await readCapturedRequests(capturePath)).length, 0);
      const trackingPath = join(workdir, '.omx', 'state', 'subagent-tracking.json');
      assert.doesNotMatch(await readFile(trackingPath, 'utf-8').catch(() => ''), new RegExp(unknownThreadId));
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('suppresses explicit native subagent output even when it carries the current owner session id', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-owner-id-subagent-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');
    const ownerSessionId = 'sess-current-owner-subagent';
    const ownerNativeSessionId = 'thread-current-owner-subagent';
    const childThreadId = 'thread-child-with-owner-session';

    try {
      await mkdir(join(workdir, '.omx', 'state'), { recursive: true });
      await writeNotificationConfig(codexHome);
      await writeOwnerSessionState(workdir, ownerSessionId, ownerNativeSessionId);

      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: ownerNativeSessionId,
        thread_id: childThreadId,
        turn_id: 'turn-child-with-owner-session',
        input_messages: [],
        last_assistant_message: '{"findings":[{"severity":"high","blocking":true}]}',
        origin: {
          kind: 'native-subagent',
          parent_thread_id: ownerNativeSessionId,
          agent_nickname: 'Reviewer',
          agent_role: 'code-reviewer',
        },
      }, {
        CODEX_HOME: codexHome,
        HOME: tempRoot,
        USERPROFILE: tempRoot,
        OMX_FETCH_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      assert.equal((await readCapturedRequests(capturePath)).length, 0);
      const notifyLog = join(workdir, '.omx', 'logs', `notify-hook-${new Date().toISOString().split('T')[0]}.jsonl`);
      const entries = await readJsonLines(notifyLog);
      const suppressed = entries.find((entry) => entry.type === 'completed_turn_delivery_suppressed');
      assert.equal(suppressed?.origin_kind, 'native-subagent');
      assert.equal(suppressed?.audience, 'child');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('suppresses unknown non-owner output that only reuses the current owner session id', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-owner-id-unknown-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');
    const stateDir = join(workdir, '.omx', 'state');
    const ownerSessionId = 'sess-current-owner-session-only';
    const ownerNativeSessionId = 'thread-current-owner-session-only';
    const untrackedThreadId = 'thread-untracked-with-owner-session';

    try {
      await mkdir(stateDir, { recursive: true });
      await writeNotificationConfig(codexHome);
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: ownerSessionId,
        native_session_id: ownerNativeSessionId,
        cwd: workdir,
        pid: process.pid,
        platform: process.platform,
      }, null, 2));
      await writeFile(join(stateDir, 'codex-session-origin-index.json'), JSON.stringify({
        schemaVersion: 1,
        sessions: {
          [ownerNativeSessionId]: {
            thread_id: ownerNativeSessionId,
            origin_kind: 'leader',
            audience: 'external-owner',
            cwd: workdir,
            first_seen_at: '2026-04-26T00:00:00.000Z',
            last_seen_at: new Date().toISOString(),
            evidence: ['session-start-payload'],
          },
        },
      }, null, 2));

      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: ownerNativeSessionId,
        thread_id: untrackedThreadId,
        turn_id: 'turn-unknown-owner-session-only',
        input_messages: [],
        last_assistant_message: '{"findings":[{"severity":"high","blocking":true}]}',
      }, {
        CODEX_HOME: codexHome,
        HOME: tempRoot,
        USERPROFILE: tempRoot,
        OMX_FETCH_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      assert.equal((await readCapturedRequests(capturePath)).length, 0);
      const notifyLog = join(workdir, '.omx', 'logs', `notify-hook-${new Date().toISOString().split('T')[0]}.jsonl`);
      const entries = await readJsonLines(notifyLog);
      const suppressed = entries.find((entry) => entry.type === 'completed_turn_delivery_suppressed');
      assert.equal(suppressed?.origin_kind, 'unknown');
      assert.equal(suppressed?.audience, 'unknown-non-owner');
      assert.equal(suppressed?.reason, 'unknown_non_owner_fail_closed');
      assert.deepEqual(
        (suppressed?.origin_evidence as Array<Record<string, unknown>> | undefined)
          ?.filter((entry) => entry.source === 'current-session-owner')
          .map((entry) => entry.detail),
        ['session_id_match_without_owner_thread_ignored'],
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('suppresses unknown non-owner output that spoofs the canonical OMX session id as a thread', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-canonical-session-thread-spoof-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');
    const stateDir = join(workdir, '.omx', 'state');
    const ownerSessionId = 'sess-current-owner-thread-spoof';
    const ownerNativeSessionId = 'thread-current-owner-thread-spoof';

    try {
      await mkdir(stateDir, { recursive: true });
      await writeNotificationConfig(codexHome);
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: ownerSessionId,
        native_session_id: ownerNativeSessionId,
        cwd: workdir,
        pid: process.pid,
        platform: process.platform,
      }, null, 2));

      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: 'native-session-not-current-owner',
        thread_id: ownerSessionId,
        turn_id: 'turn-canonical-session-thread-spoof',
        input_messages: [],
        last_assistant_message: '{"findings":[{"severity":"critical","blocking":true}]}',
      }, {
        CODEX_HOME: codexHome,
        HOME: tempRoot,
        USERPROFILE: tempRoot,
        OMX_FETCH_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      assert.equal((await readCapturedRequests(capturePath)).length, 0);
      const notifyLog = join(workdir, '.omx', 'logs', `notify-hook-${new Date().toISOString().split('T')[0]}.jsonl`);
      const entries = await readJsonLines(notifyLog);
      const suppressed = entries.find((entry) => entry.type === 'completed_turn_delivery_suppressed');
      assert.equal(suppressed?.origin_kind, 'unknown');
      assert.equal(suppressed?.audience, 'unknown-non-owner');
      assert.equal(suppressed?.reason, 'unknown_non_owner_fail_closed');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('lets tracked child lineage override owner-session-id matches for legacy subagent turns', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-owner-id-tracked-child-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');
    const ownerSessionId = 'sess-current-owner-tracked-child';
    const ownerNativeSessionId = 'thread-current-owner-tracked-child';
    const childThreadId = 'thread-tracked-child-with-owner-session';

    try {
      await mkdir(join(workdir, '.omx', 'state'), { recursive: true });
      await writeNotificationConfig(codexHome);
      await writeOwnerSessionState(workdir, ownerSessionId, ownerNativeSessionId);
      await writeSubagentTrackingFixture(workdir, ownerSessionId, ownerNativeSessionId, childThreadId);

      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: ownerNativeSessionId,
        thread_id: childThreadId,
        turn_id: 'turn-tracked-child-with-owner-session',
        input_messages: [],
        last_assistant_message: '{"findings":[{"severity":"high","blocking":true}]}',
      }, {
        CODEX_HOME: codexHome,
        HOME: tempRoot,
        USERPROFILE: tempRoot,
        OMX_FETCH_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      assert.equal((await readCapturedRequests(capturePath)).length, 0);
      const notifyLog = join(workdir, '.omx', 'logs', `notify-hook-${new Date().toISOString().split('T')[0]}.jsonl`);
      const entries = await readJsonLines(notifyLog);
      const suppressed = entries.find((entry) => entry.type === 'completed_turn_delivery_suppressed');
      assert.equal(suppressed?.origin_kind, 'native-subagent');
      assert.equal(suppressed?.audience, 'child');
      assert.equal(suppressed?.reason, 'tracked_child');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('does not let stale external-owner index entries override the current owner mismatch', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-stale-index-owner-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');
    const stateDir = join(workdir, '.omx', 'state');
    const ownerSessionId = 'sess-current-owner-index';
    const staleThreadId = 'thread-stale-index-external-owner';

    try {
      await mkdir(stateDir, { recursive: true });
      await writeNotificationConfig(codexHome);
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: ownerSessionId,
        native_session_id: 'thread-current-owner-index',
        cwd: workdir,
        pid: process.pid,
        platform: process.platform,
      }, null, 2));
      await writeFile(join(stateDir, 'codex-session-origin-index.json'), JSON.stringify({
        schemaVersion: 1,
        sessions: {
          [staleThreadId]: {
            thread_id: staleThreadId,
            origin_kind: 'leader',
            audience: 'external-owner',
            cwd: workdir,
            first_seen_at: '2026-04-26T00:00:00.000Z',
            last_seen_at: new Date().toISOString(),
            evidence: ['session-start-payload'],
          },
        },
      }, null, 2));

      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: 'sess-stale-index',
        thread_id: staleThreadId,
        turn_id: 'turn-stale-index',
        input_messages: [],
        last_assistant_message: 'This stale owner should not deliver.',
      }, {
        CODEX_HOME: codexHome,
        HOME: tempRoot,
        USERPROFILE: tempRoot,
        OMX_FETCH_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      assert.equal((await readCapturedRequests(capturePath)).length, 0);
      const notifyLog = join(workdir, '.omx', 'logs', `notify-hook-${new Date().toISOString().split('T')[0]}.jsonl`);
      const entries = await readJsonLines(notifyLog);
      const suppressed = entries.find((entry) => entry.type === 'completed_turn_delivery_suppressed');
      assert.equal(suppressed?.audience, 'unknown-non-owner');
      assert.equal(suppressed?.reason, 'indexed_external_owner_mismatch_fail_closed');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('suppresses env-marked internal helper turns before extensibility hooks and tracking', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-env-helper-suppressed-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const hookCapturePath = join(tempRoot, 'hook-events.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');
    const sessionId = 'sess-env-helper-suppressed';
    const helperThreadId = 'thread-env-helper';

    try {
      await mkdir(workdir, { recursive: true });
      await writeNotificationConfig(codexHome);
      await writeCaptureAllHookPlugin(workdir, hookCapturePath);

      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: sessionId,
        thread_id: helperThreadId,
        turn_id: 'turn-env-helper',
        input_messages: [],
        last_assistant_message: 'secret helper output that must stay internal',
      }, {
        CODEX_HOME: codexHome,
        HOME: tempRoot,
        USERPROFILE: tempRoot,
        OMX_FETCH_CAPTURE_PATH: capturePath,
        OMX_SUPPRESS_COMPLETED_TURN: '1',
        OMX_SUPPRESS_COMPLETED_TURN_REASON: 'omx-explore',
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      assert.equal((await readCapturedRequests(capturePath)).length, 0);
      assert.deepEqual(await readCapturedHookEvents(hookCapturePath), []);

      const trackerPath = join(workdir, '.omx', 'state', 'subagent-tracking.json');
      assert.doesNotMatch(await readFile(trackerPath, 'utf-8').catch(() => ''), new RegExp(helperThreadId));

      const notifyLog = join(workdir, '.omx', 'logs', `notify-hook-${new Date().toISOString().split('T')[0]}.jsonl`);
      const entries = await readJsonLines(notifyLog);
      assert.ok(entries.some((entry) => entry.type === 'turn_complete_hooks_suppressed_non_leader'));
      assert.ok(entries.some((entry) => entry.type === 'completed_turn_suppressed_non_leader'));

      const turnsLog = join(workdir, '.omx', 'logs', `turns-${new Date().toISOString().split('T')[0]}.jsonl`);
      const turnEntries = await readJsonLines(turnsLog);
      assert.equal(turnEntries[0]?.output_preview, '');
      assert.equal(turnEntries[0]?.output_redacted, true);
      assert.doesNotMatch(JSON.stringify(turnEntries), /secret helper output/);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('does not classify ordinary leader rollouts as helpers based on prompt text alone', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-prompt-prefix-leader-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');
    const sessionId = 'sess-prompt-prefix-leader';
    const threadId = 'thread-prompt-prefix-leader';

    try {
      await writeNotificationConfig(codexHome);
      await writeRolloutRecords(tempRoot, threadId, [
        {
          timestamp: new Date().toISOString(),
          type: 'session_meta',
          payload: {
            id: threadId,
            cwd: workdir,
            originator: 'codex_exec',
            source: 'exec',
            base_instructions: { text: 'ordinary codex exec instructions' },
          },
        },
        {
          timestamp: new Date().toISOString(),
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: 'You are OMX Explore, but this is quoted by a user in an ordinary leader turn.',
          },
        },
      ]);

      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: sessionId,
        thread_id: threadId,
        turn_id: 'turn-prompt-prefix-leader',
        input_messages: [],
        last_assistant_message: 'ordinary leader final should notify',
      }, {
        CODEX_HOME: codexHome,
        HOME: tempRoot,
        USERPROFILE: tempRoot,
        OMX_FETCH_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const requests = await readCapturedRequests(capturePath);
      assert.equal(requests.length, 1);

      const notifyLog = join(workdir, '.omx', 'logs', `notify-hook-${new Date().toISOString().split('T')[0]}.jsonl`);
      const logContent = await readFile(notifyLog, 'utf-8').catch(() => '');
      assert.doesNotMatch(logContent, /completed_turn_suppressed_non_leader/);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('suppresses the same Russian final text from an OMX team worker', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-russian-worker-suppressed-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'telegram-captures.ndjson');
    const preloadPath = await writeTelegramCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');
    const rawMessage = 'Готово — составил план исправления...';

    try {
      await mkdir(join(workdir, '.omx', 'state'), { recursive: true });
      await writeNotificationConfig(codexHome, {
        webhook: { enabled: false },
        telegram: {
          enabled: true,
          botToken: '123456:telegram-token',
          chatId: '777',
          projectTopics: { enabled: true },
        },
      });
      await writeTelegramTopicRegistryRecord(tempRoot, workdir);

      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: 'sess-russian-worker-suppressed',
        thread_id: 'thread-russian-worker',
        turn_id: 'turn-russian-worker',
        input_messages: [],
        last_assistant_message: rawMessage,
      }, {
        CODEX_HOME: codexHome,
        HOME: tempRoot,
        USERPROFILE: tempRoot,
        OMX_TELEGRAM_CAPTURE_PATH: capturePath,
        OMX_TEST_MOCK_TELEGRAM_TRANSPORT: '1',
        NODE_OPTIONS: `--import=${preloadPath}`,
      }, {
        teamWorkerEnv: 'notify/worker-1',
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const requests = await readCapturedRequests(capturePath);
      assert.equal(requests.filter((request) => /sendMessage/.test(request.url)).length, 0);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('suppresses native subagent ready-for-review summaries without writing external completed-turn cooldown', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-subagent-ready-suppressed-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');
    const rawMessage = 'Implemented notification gate. Ready for review.';

    try {
      await mkdir(join(workdir, '.omx', 'state'), { recursive: true });
      await writeNotificationConfig(codexHome);

      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: 'sess-subagent-ready-suppressed',
        thread_id: 'thread-subagent-ready',
        turn_id: 'turn-subagent-ready',
        input_messages: [],
        last_assistant_message: rawMessage,
        session_meta: {
          id: 'thread-subagent-ready',
          cwd: workdir,
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: 'thread-leader-ready',
              },
              agent_nickname: 'executor',
            },
          },
        },
      }, {
        CODEX_HOME: codexHome,
        OMX_FETCH_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const requests = await readCapturedRequests(capturePath);
      assert.equal(requests.length, 0);
      const cooldownPath = join(
        workdir,
        '.omx',
        'state',
        'sessions',
        'sess-subagent-ready-suppressed',
        'completed-turn-notif-cooldown.json',
      );
      await assert.rejects(readFile(cooldownPath, 'utf-8'));
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('does not let subagent summaries suppress a later leader final with the same text', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-subagent-leader-dedupe-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');
    const sessionId = 'sess-subagent-leader-dedupe';
    const rawMessage = 'Implemented notification gate. Ready for review.';
    const env = {
      CODEX_HOME: codexHome,
      OMX_FETCH_CAPTURE_PATH: capturePath,
      NODE_OPTIONS: `--import=${preloadPath}`,
    };

    try {
      await mkdir(join(workdir, '.omx', 'state'), { recursive: true });
      await writeNotificationConfig(codexHome);

      const subagent = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: sessionId,
        thread_id: 'thread-subagent-dedupe',
        turn_id: 'turn-subagent-dedupe',
        input_messages: [],
        last_assistant_message: rawMessage,
        origin: {
          kind: 'native-subagent',
          parent_thread_id: 'thread-leader-dedupe',
        },
      }, env);
      assert.equal(subagent.status, 0, subagent.stderr || subagent.stdout);

      const leader = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: sessionId,
        thread_id: 'thread-leader-dedupe',
        turn_id: 'turn-leader-dedupe',
        input_messages: [],
        last_assistant_message: rawMessage,
        origin: { kind: 'leader' },
      }, env);
      assert.equal(leader.status, 0, leader.stderr || leader.stdout);

      const requests = await readCapturedRequests(capturePath);
      assert.equal(requests.length, 1);
      const body = JSON.parse(requests[0].body) as { event: string; message: string };
      assert.equal(body.event, 'result-ready');
      assert.equal(body.message, rawMessage);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('uses tracked thread origin to suppress legacy subagent payloads without origin metadata', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-tracked-legacy-subagent-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');
    const sessionId = 'sess-tracked-legacy-subagent';
    const leaderThreadId = 'thread-tracked-leader';
    const subagentThreadId = 'thread-tracked-subagent';
    const rawMessage = 'Готово — составил план исправления...';
    const env = {
      CODEX_HOME: codexHome,
      OMX_FETCH_CAPTURE_PATH: capturePath,
      NODE_OPTIONS: `--import=${preloadPath}`,
    };

    try {
      await writeNotificationConfig(codexHome);
      await writeSubagentTrackingFixture(workdir, sessionId, leaderThreadId, subagentThreadId);
      await writeOwnerSessionState(workdir, sessionId, leaderThreadId);

      const subagent = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: sessionId,
        thread_id: subagentThreadId,
        turn_id: 'turn-tracked-subagent',
        input_messages: [],
        last_assistant_message: rawMessage,
      }, env);
      assert.equal(subagent.status, 0, subagent.stderr || subagent.stdout);

      let requests = await readCapturedRequests(capturePath);
      assert.equal(requests.length, 0);
      await assert.rejects(readFile(
        join(workdir, '.omx', 'state', 'sessions', sessionId, 'completed-turn-notif-cooldown.json'),
        'utf-8',
      ));

      const leader = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: sessionId,
        thread_id: leaderThreadId,
        turn_id: 'turn-tracked-leader',
        input_messages: [],
        last_assistant_message: rawMessage,
      }, env);
      assert.equal(leader.status, 0, leader.stderr || leader.stdout);

      requests = await readCapturedRequests(capturePath);
      assert.equal(requests.length, 1);
      const body = JSON.parse(requests[0].body) as { event: string; message: string };
      assert.equal(body.event, 'result-ready');
      assert.equal(body.message, rawMessage);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('does not let tracked native subagents spoof leader origin', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-tracked-subagent-spoof-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');
    const sessionId = 'sess-tracked-subagent-spoof';
    const leaderThreadId = 'thread-spoof-leader';
    const subagentThreadId = 'thread-spoof-subagent';

    try {
      await writeNotificationConfig(codexHome);
      await writeSubagentTrackingFixture(workdir, sessionId, leaderThreadId, subagentThreadId);
      await writeOwnerSessionState(workdir, sessionId, leaderThreadId);

      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: sessionId,
        thread_id: subagentThreadId,
        turn_id: 'turn-spoof-subagent',
        input_messages: [],
        last_assistant_message: 'Готово — составил план исправления...',
        origin: { kind: 'leader' },
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

  it('does not let suppressed subagents consume session-idle hook dedupe before leader final', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-subagent-hook-dedupe-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const hookCapturePath = join(tempRoot, 'hook-captures.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');
    const sessionId = 'sess-subagent-hook-dedupe';
    const rawMessage = 'Implemented notification gate. Ready for review.';
    const env = {
      CODEX_HOME: codexHome,
      OMX_FETCH_CAPTURE_PATH: capturePath,
      NODE_OPTIONS: `--import=${preloadPath}`,
    };

    try {
      await mkdir(join(workdir, '.omx', 'state'), { recursive: true });
      await writeNotificationConfig(codexHome);
      await writeSessionIdleHookPlugin(workdir, hookCapturePath);

      const subagent = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: sessionId,
        thread_id: 'thread-hook-subagent',
        turn_id: 'turn-hook-subagent',
        input_messages: [],
        last_assistant_message: rawMessage,
        origin: {
          kind: 'native-subagent',
          parent_thread_id: 'thread-hook-leader',
        },
      }, env);
      assert.equal(subagent.status, 0, subagent.stderr || subagent.stdout);

      const leader = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: sessionId,
        thread_id: 'thread-hook-leader',
        turn_id: 'turn-hook-leader',
        input_messages: [],
        last_assistant_message: rawMessage,
        origin: { kind: 'leader' },
      }, env);
      assert.equal(leader.status, 0, leader.stderr || leader.stdout);

      const requests = await readCapturedRequests(capturePath);
      assert.equal(requests.length, 1);

      const hookEvents = await readCapturedHookEvents(hookCapturePath);
      assert.equal(hookEvents.length, 1);
      assert.equal(hookEvents[0].turn_id, 'turn-hook-leader');
      assert.equal(hookEvents[0].semantic_notification_event, 'result-ready');
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

  it('sends failed-looking leader follow-ups as raw result-ready unless input is explicitly needed', async () => {
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
      assert.equal(requests.length, 1);
      const body = JSON.parse(requests[0].body) as { event: string; message: string };
      assert.equal(body.event, 'result-ready');
      assert.equal(body.message, 'Build failed: timeout while running npm test.');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('sends ordinary leader output as result-ready even without structured reply provenance', async () => {
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
      assert.equal(requests.length, 1);
      const body = JSON.parse(requests[0].body) as { event: string; message: string };
      assert.equal(body.event, 'result-ready');
      assert.equal(body.message, 'It’s 11:47 PM on April 22, 2026 in Europe/Moscow (UTC+03:00).');
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

  it('sends progress-looking leader finals as raw result-ready', async () => {
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
      assert.equal(requests.length, 1);
      const body = JSON.parse(requests[0].body) as { event: string; message: string };
      assert.equal(body.event, 'result-ready');
      assert.equal(body.message, 'I can continue with the plan from here.');
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

      await writeOwnerSessionState(workdir, 'sess-hook-input', 'thread-hook-input');
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

  it('dedupes duplicate hook delivery for the same turn while sending each new leader final turn', async () => {
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
        turn_id: 'turn-dedupe-1',
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
        turn_id: 'turn-dedupe-2',
        input_messages: [],
        last_assistant_message: 'Created commit abc123 and all tests passed.',
      }, env);
      assert.equal(third.status, 0, third.stderr || third.stdout);

      requests = await readCapturedRequests(capturePath);
      assert.equal(requests.length, 2);

      const fourth = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: 'sess-dedupe',
        thread_id: 'thread-dedupe',
        turn_id: 'turn-dedupe-3',
        input_messages: [],
        last_assistant_message: 'Implemented review flow and all tests passed.',
      }, env);
      assert.equal(fourth.status, 0, fourth.stderr || fourth.stdout);

      requests = await readCapturedRequests(capturePath);
      assert.equal(requests.length, 3);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
