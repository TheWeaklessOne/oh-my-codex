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
import { pendingRoutesStatePath } from '../../notifications/pending-routes.js';
import { dispatchCodexNativeHook } from '../../scripts/codex-native-hook.js';
import { writeSessionStart } from '../session.js';
import { readSessionActors } from '../../runtime/session-actors.js';
import { reconcileRalphTerminalStateScope } from '../../runtime/ralph-state-scope.js';
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

async function writeFetchCapturePreload(
  dir: string,
  fixedNowIso = '',
  status: number | number[] = 200,
): Promise<string> {
  const preloadPath = join(dir, 'mock-fetch.mjs');
  const statuses = Array.isArray(status) ? status : [status];
  await writeFile(preloadPath, `
import { appendFileSync, readFileSync } from 'node:fs';

${fixedNowIso ? buildFixedDatePreloadSource(fixedNowIso) : ''}
const capturePath = process.env.OMX_FETCH_CAPTURE_PATH;
const responseStatuses = ${JSON.stringify(statuses)};
function resolveStatus() {
  if (responseStatuses.length === 1) return responseStatuses[0];
  if (!capturePath) return responseStatuses[0];
  let requestIndex = 0;
  try {
    requestIndex = readFileSync(capturePath, 'utf-8')
      .split('\\n')
      .filter(Boolean)
      .length;
  } catch {}
  return responseStatuses[Math.min(requestIndex, responseStatuses.length - 1)];
}
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? String(input) : input.url;
  const status = resolveStatus();
  if (capturePath) {
    appendFileSync(capturePath, JSON.stringify({
      url,
      body: typeof init.body === 'string' ? init.body : '',
    }) + '\\n');
  }
  return new Response('', { status });
};
`, 'utf-8');
  return preloadPath;
}

async function writeFetchFailureCapturePreload(dir: string, errorMessage = 'Dispatch timeout'): Promise<string> {
  const preloadPath = join(dir, 'mock-fetch-failure.mjs');
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
  const error = new Error(${JSON.stringify(errorMessage)});
  error.name = 'AbortError';
  throw error;
};
`, 'utf-8');
  return preloadPath;
}

async function writeOpenClawCommandCaptureScript(dir: string, capturePath: string): Promise<string> {
  const scriptPath = join(dir, 'capture-openclaw-command.mjs');
  await writeFile(scriptPath, `
import { appendFileSync } from 'node:fs';

appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
  argv: process.argv.slice(2),
  env: {
    OMX_OPENCLAW: process.env.OMX_OPENCLAW || '',
    OMX_OPENCLAW_COMMAND: process.env.OMX_OPENCLAW_COMMAND || '',
  },
}) + '\\n');
`, 'utf-8');
  return scriptPath;
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


async function writeTelegramFailingSendPhotoPreload(dir: string): Promise<string> {
  const preloadPath = join(dir, 'mock-telegram-send-photo-failure.mjs');
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
    for (const handler of listeners.get(event) ?? []) handler(value);
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
        const path = String(options?.path ?? '');
        if (capturePath) appendFileSync(capturePath, JSON.stringify({ url: path, body: requestBody }) + '\\n');
        const response = new PassThrough();
        if (path.includes('/sendPhoto')) {
          response.statusCode = 500;
          callback?.(response);
          response.end(JSON.stringify({ ok: false, description: 'media upload failed' }));
          return;
        }
        response.statusCode = 200;
        callback?.(response);
        response.end(JSON.stringify({
          ok: true,
          result: { message_id: 321, message_thread_id: 9001, is_topic_message: true },
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

async function writeImageGenerationTranscript(
  path: string,
  turnId: string,
  imagePath: string,
): Promise<void> {
  await writeFile(path, [
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'image_generation_end', saved_path: imagePath } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId, last_agent_message: null } }),
  ].join('\n') + '\n');
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
  const stateDir = join(workdir, '.omx', 'state');
  const actorsPath = join(stateDir, 'sessions', sessionId, 'actors.json');
  if (!existsSync(actorsPath)) {
    const ownerActorId = `owner:${sessionId}`;
    await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
    await writeFile(actorsPath, JSON.stringify({
      schemaVersion: 1,
      sessionId,
      cwd: workdir,
      ownerActorId,
      actors: {
        [ownerActorId]: {
          actorId: ownerActorId,
          kind: 'leader',
          audience: 'external-owner',
          source: 'test-placeholder-owner',
          firstSeenAt: new Date('2026-04-23T00:00:00Z').toISOString(),
          lastSeenAt: new Date('2026-04-23T00:00:00Z').toISOString(),
        },
      },
      aliases: {},
      updatedAt: new Date('2026-04-23T00:00:00Z').toISOString(),
    }, null, 2));
  }
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
  await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
  await writeFile(join(stateDir, 'sessions', sessionId, 'actors.json'), JSON.stringify({
    schemaVersion: 1,
    sessionId,
    cwd: workdir,
    ownerActorId: leaderThreadId,
    actors: {
      [leaderThreadId]: {
        actorId: leaderThreadId,
        kind: 'leader',
        audience: 'external-owner',
        threadId: leaderThreadId,
        nativeSessionId: leaderThreadId,
        source: 'test-owner',
        firstSeenAt: now,
        lastSeenAt: now,
        turnCount: 1,
      },
      [subagentThreadId]: {
        actorId: subagentThreadId,
        kind: 'native-subagent',
        audience: 'child',
        threadId: subagentThreadId,
        nativeSessionId: subagentThreadId,
        parentActorId: leaderThreadId,
        parentThreadId: leaderThreadId,
        source: 'test-child',
        firstSeenAt: now,
        lastSeenAt: now,
        turnCount: 1,
      },
    },
    aliases: {
      [leaderThreadId]: leaderThreadId,
      [subagentThreadId]: subagentThreadId,
    },
    updatedAt: now,
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

async function writeTranscriptRecords(
  path: string,
  records: Array<Record<string, unknown>>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
}

function transcriptSessionMeta(
  id: string,
  cwd: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'session_meta',
    payload: {
      id,
      cwd,
      ...extra,
    },
  };
}

function transcriptTaskStarted(turnId: string): Record<string, unknown> {
  return { type: 'task_started', payload: { turn_id: turnId } };
}

function transcriptTurnAborted(turnId: string): Record<string, unknown> {
  return { type: 'turn_aborted', payload: { turn_id: turnId, reason: 'interrupted' } };
}

function transcriptTaskComplete(turnId: string): Record<string, unknown> {
  return { type: 'task_complete', payload: { turn_id: turnId } };
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

function buildOwnerActorsState(cwd: string, sessionId: string, nativeSessionId: string): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    sessionId,
    cwd,
    ownerActorId: nativeSessionId,
    actors: {
      [nativeSessionId]: {
        actorId: nativeSessionId,
        kind: 'leader',
        audience: 'external-owner',
        threadId: nativeSessionId,
        nativeSessionId,
        source: 'test-owner',
        firstSeenAt: now,
        lastSeenAt: now,
        lifecycleStatus: 'active',
        claimStrength: 'native-start',
      },
    },
    aliases: {
      [nativeSessionId]: nativeSessionId,
    },
    updatedAt: now,
  };
}

function writeOwnerSessionStateSync(cwd: string, sessionId: string, nativeSessionId: string): void {
  const stateDir = join(cwd, '.omx', 'state');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, 'session.json'),
    JSON.stringify(buildOwnerSessionState(cwd, sessionId, nativeSessionId), null, 2),
  );
  mkdirSync(join(stateDir, 'sessions', sessionId), { recursive: true });
  writeFileSync(
    join(stateDir, 'sessions', sessionId, 'actors.json'),
    JSON.stringify(buildOwnerActorsState(cwd, sessionId, nativeSessionId), null, 2),
  );
}

async function writeOwnerSessionState(cwd: string, sessionId: string, nativeSessionId: string): Promise<void> {
  await mkdir(join(cwd, '.omx', 'state'), { recursive: true });
  await writeFile(
    join(cwd, '.omx', 'state', 'session.json'),
    JSON.stringify(buildOwnerSessionState(cwd, sessionId, nativeSessionId), null, 2),
  );
  await mkdir(join(cwd, '.omx', 'state', 'sessions', sessionId), { recursive: true });
  await writeFile(
    join(cwd, '.omx', 'state', 'sessions', sessionId, 'actors.json'),
    JSON.stringify(buildOwnerActorsState(cwd, sessionId, nativeSessionId), null, 2),
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

      const notifyLog = join(workdir, '.omx', 'logs', `notify-hook-${new Date().toISOString().split('T')[0]}.jsonl`);
      const entries = await readJsonLines(notifyLog);
      assert.equal(
        entries.filter((entry) =>
          entry.type === 'completed_turn_delivery_sent'
          && entry.turn_id === 'turn-result-ready'
        ).length,
        1,
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('retries completed-turn delivery after a failed notifier attempt', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-result-ready-retry-failed-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot, '', 500);
    const workdir = join(tempRoot, 'repo');

    try {
      await mkdir(join(workdir, '.omx', 'state'), { recursive: true });
      await writeNotificationConfig(codexHome);

      const payload = {
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: 'sess-result-ready-failed-retry',
        thread_id: 'thread-result-ready-failed-retry',
        turn_id: 'turn-result-ready-failed-retry',
        input_messages: [],
        last_assistant_message: 'Implemented retryable failed notification delivery. Tests passed.',
      };

      const first = runNotifyHook(payload, {
        CODEX_HOME: codexHome,
        OMX_FETCH_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(first.status, 0, first.stderr || first.stdout);

      const second = runNotifyHook(payload, {
        CODEX_HOME: codexHome,
        OMX_FETCH_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(second.status, 0, second.stderr || second.stdout);

      const requests = await readCapturedRequests(capturePath);
      assert.equal(requests.length, 2);
      const notifyLog = join(workdir, '.omx', 'logs', `notify-hook-${new Date().toISOString().split('T')[0]}.jsonl`);
      const entries = await readJsonLines(notifyLog);
      assert.equal(
        entries.filter((entry) =>
          entry.type === 'completed_turn_delivery_allowed'
          && entry.turn_id === 'turn-result-ready-failed-retry'
        ).length,
        2,
      );
      assert.equal(
        entries.filter((entry) =>
          entry.type === 'completed_turn_delivery_failed'
          && entry.turn_id === 'turn-result-ready-failed-retry'
        ).length,
        2,
      );
      assert.equal(
        entries.some((entry) =>
          entry.type === 'completed_turn_duplicate_suppressed'
          && entry.turn_id === 'turn-result-ready-failed-retry'
        ),
        false,
      );
      const projectState = JSON.parse(
        await readFile(join(workdir, '.omx', 'state', 'notify-hook-turn-dedupe.json'), 'utf-8'),
      ) as {
        turn_claims?: Record<string, { delivery_status?: string; delivery_status_at?: number }>;
      };
      const key = 'thread-result-ready-failed-retry|turn-result-ready-failed-retry|agent-turn-complete';
      assert.equal(projectState.turn_claims?.[key]?.delivery_status, 'dispatching');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('marks a consumed pending reply route failed when transport returns no success', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-pending-route-failed-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot, '', 500);
    const workdir = join(tempRoot, 'repo');
    const sessionId = 'sess-pending-route-failed';
    const ownerThreadId = 'thread-pending-route-failed';
    const followup = 'Please continue after the failure.';

    try {
      await mkdir(join(workdir, '.omx', 'state'), { recursive: true });
      await writeNotificationConfig(codexHome);
      await writeOwnerSessionState(workdir, sessionId, ownerThreadId);
      const latestInput = buildExpectedReplyInput(followup, 'telegram');
      await recordPendingReplyOrigin(workdir, sessionId, {
        platform: 'telegram',
        injectedInput: latestInput,
        createdAt: new Date().toISOString(),
      });
      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: sessionId,
        thread_id: ownerThreadId,
        turn_id: 'turn-pending-route-failed',
        input_messages: [latestInput],
        last_assistant_message: 'The requested follow-up failed to deliver externally.',
      }, {
        CODEX_HOME: codexHome,
        OMX_FETCH_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const state = JSON.parse(await readFile(pendingRoutesStatePath(workdir, sessionId), 'utf-8')) as {
        routes?: Array<unknown>;
        terminal?: Array<{ status?: string; terminalReason?: string }>;
      };
      assert.deepEqual(state.routes, []);
      assert.equal(state.terminal?.length, 1);
      assert.equal(state.terminal?.[0]?.status, 'failed');
      assert.match(state.terminal?.[0]?.terminalReason ?? '', /delivery failed|HTTP 500/i);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('closes completed-turn delivery claims when notification preparation throws after dispatch claim', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-result-ready-prep-exception-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');
    const stateDir = join(workdir, '.omx', 'state');
    const sessionId = 'sess-result-ready-prep-exception';
    const threadId = 'thread-result-ready-prep-exception';
    const turnId = 'turn-result-ready-prep-exception';
    const key = `${threadId}|${turnId}|agent-turn-complete`;

    try {
      await mkdir(stateDir, { recursive: true });
      await writeNotificationConfig(codexHome);
      await writeOwnerSessionState(workdir, sessionId, threadId);
      const pendingRoutesPath = pendingRoutesStatePath(workdir, sessionId);
      await mkdir(dirname(pendingRoutesPath), { recursive: true });
      await writeFile(pendingRoutesPath, '{ this is not valid JSON', 'utf-8');

      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: sessionId,
        thread_id: threadId,
        turn_id: turnId,
        input_messages: ['please sync releases'],
        last_assistant_message: 'The release sync completed successfully.',
      }, {
        CODEX_HOME: codexHome,
        OMX_FETCH_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const notifyLog = join(workdir, '.omx', 'logs', `notify-hook-${new Date().toISOString().split('T')[0]}.jsonl`);
      const entries = await readJsonLines(notifyLog);
      assert.ok(entries.some((entry) =>
        entry.type === 'completed_turn_delivery_allowed'
        && entry.turn_id === turnId
      ));
      const exception = entries.find((entry) =>
        entry.type === 'completed_turn_notification_exception'
        && entry.turn_id === turnId
      );
      assert.equal(exception?.delivery_status, 'committed');
      assert.match(String(exception?.error ?? ''), /JSON|valid/i);

      const projectState = JSON.parse(
        await readFile(join(stateDir, 'notify-hook-turn-dedupe.json'), 'utf-8'),
      ) as {
        turn_claims?: Record<string, { delivery_status?: string }>;
      };
      assert.equal(projectState.turn_claims?.[key]?.delivery_status, 'committed');
      assert.equal((await readCapturedRequests(capturePath)).length, 0);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('does not immediately retry completed-turn delivery after ambiguous dispatch timeout evidence', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-result-ready-timeout-fail-closed-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const timeoutPreloadPath = await writeFetchFailureCapturePreload(tempRoot);
    const successPreloadPath = await writeFetchCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');
    const stateDir = join(workdir, '.omx', 'state');

    try {
      await mkdir(stateDir, { recursive: true });
      await writeNotificationConfig(codexHome);
      const threadId = 'thread-result-ready-timeout-fail-closed';
      const turnId = 'turn-result-ready-timeout-fail-closed';
      const key = `${threadId}|${turnId}|agent-turn-complete`;

      const payload = {
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: 'sess-result-ready-timeout-fail-closed',
        thread_id: threadId,
        turn_id: turnId,
        input_messages: [],
        last_assistant_message: 'Do not immediately retry an ambiguous timeout.',
      };

      const first = runNotifyHook(payload, {
        CODEX_HOME: codexHome,
        OMX_FETCH_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: `--import=${timeoutPreloadPath}`,
      });
      assert.equal(first.status, 0, first.stderr || first.stdout);

      const notifyLog = join(workdir, '.omx', 'logs', `notify-hook-${new Date().toISOString().split('T')[0]}.jsonl`);
      const firstEntries = await readJsonLines(notifyLog);
      const failure = firstEntries.find((entry) =>
        entry.type === 'completed_turn_delivery_failed'
        && entry.turn_id === turnId
      );
      assert.equal(failure?.delivery_failure_kind, 'ambiguous_timeout');
      assert.equal(
        (failure?.notification_results as Array<Record<string, unknown>>).some((entry) =>
          entry.success === false
          && String(entry.error).includes('Dispatch timeout')
        ),
        true,
      );
      assert.equal(
        firstEntries.filter((entry) =>
          entry.type === 'completed_turn_delivery_allowed'
          && entry.turn_id === turnId
        ).length,
        1,
      );

      const second = runNotifyHook(payload, {
        CODEX_HOME: codexHome,
        OMX_FETCH_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: `--import=${successPreloadPath}`,
      });
      assert.equal(second.status, 0, second.stderr || second.stdout);

      assert.equal((await readCapturedRequests(capturePath)).length, 1);
      const entries = await readJsonLines(notifyLog);
      assert.equal(
        entries.filter((entry) =>
          entry.type === 'completed_turn_delivery_allowed'
          && entry.turn_id === turnId
        ).length,
        1,
      );
      assert.equal(
        entries.some((entry) =>
          entry.type === 'turn_duplicate_suppressed'
          && entry.scope === 'project'
          && entry.turn_id === turnId
        ),
        true,
      );
      assert.equal(
        entries.some((entry) =>
          entry.type === 'completed_turn_delivery_sent'
          && entry.turn_id === turnId
        ),
        false,
      );
      const projectState = JSON.parse(
        await readFile(join(stateDir, 'notify-hook-turn-dedupe.json'), 'utf-8'),
      ) as {
        turn_claims?: Record<string, { delivery_status?: string; delivery_status_at?: number }>;
      };
      assert.equal(projectState.turn_claims?.[key]?.delivery_status, 'delivery_unknown');

      projectState.turn_claims![key] = {
        ...projectState.turn_claims![key],
        delivery_status_at: 0,
      };
      await writeFile(
        join(stateDir, 'notify-hook-turn-dedupe.json'),
        JSON.stringify(projectState, null, 2),
      );
      await rm(notifyLog, { force: true });

      const third = runNotifyHook(payload, {
        CODEX_HOME: codexHome,
        OMX_FETCH_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: `--import=${successPreloadPath}`,
      });
      assert.equal(third.status, 0, third.stderr || third.stdout);
      assert.equal((await readCapturedRequests(capturePath)).length, 1);
      const finalEntries = await readJsonLines(notifyLog);
      assert.equal(
        finalEntries.some((entry) =>
          entry.type === 'completed_turn_delivery_sent'
          && entry.turn_id === turnId
        ),
        false,
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('keeps newer ambiguous completed-turn evidence fail-closed over older definitive failures', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-result-ready-mixed-fail-closed-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');
    const stateDir = join(workdir, '.omx', 'state');
    const logsDir = join(workdir, '.omx', 'logs');

    try {
      await mkdir(stateDir, { recursive: true });
      await mkdir(logsDir, { recursive: true });
      await writeNotificationConfig(codexHome);
      const threadId = 'thread-result-ready-mixed-fail-closed';
      const turnId = 'turn-result-ready-mixed-fail-closed';
      const sessionId = 'sess-result-ready-mixed-fail-closed';
      const key = `${threadId}|${turnId}|agent-turn-complete`;
      const claimAt = Date.now() - 1_000;
      await writeFile(join(stateDir, 'notify-hook-turn-dedupe.json'), JSON.stringify({
        recent_turns: { [key]: claimAt },
        turn_claims: {
          [key]: {
            timestamp: claimAt,
            delivery: 'allow',
            delivery_status: 'dispatching',
            delivery_status_at: claimAt,
            source_kind: 'native',
            source: '',
            session_id: sessionId,
            audience: 'external-owner',
            reason: 'owner_actor_completed',
          },
        },
        last_event_at: new Date(claimAt).toISOString(),
      }, null, 2));
      await writeFile(join(logsDir, 'notify-hook-seeded.jsonl'), [
        {
          timestamp: new Date(claimAt + 1_000).toISOString(),
          type: 'completed_turn_delivery_failed',
          thread_id: threadId,
          turn_id: turnId,
          omx_session_id: sessionId,
          delivery_failure_kind: 'definitive',
          error: 'HTTP 500',
        },
        {
          timestamp: new Date(claimAt + 2_000).toISOString(),
          type: 'completed_turn_delivery_failed',
          thread_id: threadId,
          turn_id: turnId,
          omx_session_id: sessionId,
          delivery_failure_kind: 'ambiguous_timeout',
          notification_results: [{
            platform: 'webhook',
            success: false,
            error: 'Dispatch timeout',
          }],
        },
      ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');

      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: sessionId,
        thread_id: threadId,
        turn_id: turnId,
        input_messages: [],
        last_assistant_message: 'Do not recover after newer ambiguous timeout evidence.',
      }, {
        CODEX_HOME: codexHome,
        OMX_FETCH_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      assert.equal((await readCapturedRequests(capturePath)).length, 0);
      const notifyLog = join(workdir, '.omx', 'logs', `notify-hook-${new Date().toISOString().split('T')[0]}.jsonl`);
      const entries = await readJsonLines(notifyLog);
      assert.equal(
        entries.some((entry) =>
          entry.type === 'completed_turn_delivery_allowed'
          && entry.turn_id === turnId
        ),
        false,
      );
      assert.equal(
        entries.some((entry) =>
          entry.type === 'turn_duplicate_suppressed'
          && entry.scope === 'project'
          && entry.turn_id === turnId
        ),
        true,
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('recovers completed-turn delivery when definitive failure evidence is newer than ambiguous evidence', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-result-ready-mixed-recover-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');
    const stateDir = join(workdir, '.omx', 'state');
    const logsDir = join(workdir, '.omx', 'logs');

    try {
      await mkdir(stateDir, { recursive: true });
      await mkdir(logsDir, { recursive: true });
      await writeNotificationConfig(codexHome);
      const threadId = 'thread-result-ready-mixed-recover';
      const turnId = 'turn-result-ready-mixed-recover';
      const sessionId = 'sess-result-ready-mixed-recover';
      const key = `${threadId}|${turnId}|agent-turn-complete`;
      const claimAt = Date.now() - 1_000;
      await writeFile(join(stateDir, 'notify-hook-turn-dedupe.json'), JSON.stringify({
        recent_turns: { [key]: claimAt },
        turn_claims: {
          [key]: {
            timestamp: claimAt,
            delivery: 'allow',
            delivery_status: 'dispatching',
            delivery_status_at: claimAt,
            source_kind: 'native',
            source: '',
            session_id: sessionId,
            audience: 'external-owner',
            reason: 'owner_actor_completed',
          },
        },
        last_event_at: new Date(claimAt).toISOString(),
      }, null, 2));
      await writeFile(join(logsDir, 'notify-hook-seeded.jsonl'), [
        {
          timestamp: new Date(claimAt + 100).toISOString(),
          type: 'completed_turn_delivery_failed',
          thread_id: threadId,
          turn_id: turnId,
          omx_session_id: sessionId,
          delivery_failure_kind: 'ambiguous_timeout',
          notification_results: [{
            platform: 'webhook',
            success: false,
            error: 'Dispatch timeout',
          }],
        },
        {
          timestamp: new Date(claimAt + 200).toISOString(),
          type: 'completed_turn_delivery_failed',
          thread_id: threadId,
          turn_id: turnId,
          omx_session_id: sessionId,
          delivery_failure_kind: 'definitive',
          error: 'HTTP 500',
        },
      ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');

      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: sessionId,
        thread_id: threadId,
        turn_id: turnId,
        input_messages: [],
        last_assistant_message: 'Recover after newer definitive failure evidence. Tests passed.',
      }, {
        CODEX_HOME: codexHome,
        OMX_FETCH_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      assert.equal((await readCapturedRequests(capturePath)).length, 1);
      const notifyLog = join(workdir, '.omx', 'logs', `notify-hook-${new Date().toISOString().split('T')[0]}.jsonl`);
      const entries = await readJsonLines(notifyLog);
      assert.equal(
        entries.some((entry) =>
          entry.type === 'project_turn_dedupe_allow_claim_recovered_before_delivery'
          && entry.turn_id === turnId
        ),
        true,
      );
      assert.equal(
        entries.some((entry) =>
          entry.type === 'completed_turn_delivery_sent'
          && entry.turn_id === turnId
        ),
        true,
      );
      const projectState = JSON.parse(
        await readFile(join(stateDir, 'notify-hook-turn-dedupe.json'), 'utf-8'),
      ) as {
        turn_claims?: Record<string, { delivery_status?: string }>;
      };
      assert.equal(projectState.turn_claims?.[key]?.delivery_status, 'sent');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('treats standard webhook gateway timeout statuses as ambiguous', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-result-ready-504-fail-closed-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot, '', 504);
    const workdir = join(tempRoot, 'repo');

    try {
      await mkdir(join(workdir, '.omx', 'state'), { recursive: true });
      await writeNotificationConfig(codexHome);
      const payload = {
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: 'sess-result-ready-504-fail-closed',
        thread_id: 'thread-result-ready-504-fail-closed',
        turn_id: 'turn-result-ready-504-fail-closed',
        input_messages: [],
        last_assistant_message: 'Do not immediately retry a gateway timeout response.',
      };

      const first = runNotifyHook(payload, {
        CODEX_HOME: codexHome,
        OMX_FETCH_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(first.status, 0, first.stderr || first.stdout);

      const second = runNotifyHook(payload, {
        CODEX_HOME: codexHome,
        OMX_FETCH_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(second.status, 0, second.stderr || second.stdout);

      assert.equal((await readCapturedRequests(capturePath)).length, 1);
      const notifyLog = join(workdir, '.omx', 'logs', `notify-hook-${new Date().toISOString().split('T')[0]}.jsonl`);
      const entries = await readJsonLines(notifyLog);
      const failure = entries.find((entry) =>
        entry.type === 'completed_turn_delivery_failed'
        && entry.turn_id === 'turn-result-ready-504-fail-closed'
      );
      assert.equal(failure?.delivery_failure_kind, 'ambiguous_timeout');
      assert.equal(
        (failure?.notification_results as Array<Record<string, unknown>>).some((entry) =>
          entry.platform === 'webhook'
          && entry.success === false
          && entry.error === 'HTTP 504'
          && entry.status_code === 504
        ),
        true,
      );
      assert.equal(
        entries.filter((entry) =>
          entry.type === 'completed_turn_delivery_allowed'
          && entry.turn_id === 'turn-result-ready-504-fail-closed'
        ).length,
        1,
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('does not recover fresh claims from stale claim-changed dispatch evidence', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-claim-changed-fail-closed-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');
    const stateDir = join(workdir, '.omx', 'state');
    const logsDir = join(workdir, '.omx', 'logs');

    try {
      await mkdir(stateDir, { recursive: true });
      await mkdir(logsDir, { recursive: true });
      await writeNotificationConfig(codexHome);
      const threadId = 'thread-claim-changed-fail-closed';
      const turnId = 'turn-claim-changed-fail-closed';
      const key = `${threadId}|${turnId}|agent-turn-complete`;
      const timestamp = Date.now() - 1_000;
      await writeFile(join(stateDir, 'notify-hook-turn-dedupe.json'), JSON.stringify({
        recent_turns: { [key]: timestamp },
        turn_claims: {
          [key]: {
            timestamp,
            delivery: 'allow',
            delivery_status: 'pending',
            delivery_status_at: timestamp,
            source_kind: 'native',
            source: 'native-after-stale-claim',
            session_id: 'sess-claim-changed-fail-closed',
            audience: 'external-owner',
            reason: 'owner_actor_completed',
          },
        },
        last_event_at: new Date(timestamp).toISOString(),
      }));
      await writeFile(join(logsDir, 'notify-hook-existing.jsonl'), `${JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'warn',
        type: 'project_turn_dedupe_delivery_status_failed',
        delivery_status: 'dispatching',
        thread_id: threadId,
        turn_id: turnId,
        omx_session_id: 'sess-stale-owner',
        source: 'stale-owner',
        reason: 'claim_changed_before_dispatch',
      })}\n`);

      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: 'sess-claim-changed-fail-closed',
        thread_id: threadId,
        turn_id: turnId,
        input_messages: [],
        last_assistant_message: 'Do not recover a fresh claim from stale claim-changed dispatch evidence.',
      }, {
        CODEX_HOME: codexHome,
        OMX_FETCH_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      assert.equal((await readCapturedRequests(capturePath)).length, 0);
      const notifyLog = join(workdir, '.omx', 'logs', `notify-hook-${new Date().toISOString().split('T')[0]}.jsonl`);
      const entries = await readJsonLines(notifyLog);
      assert.equal(
        entries.some((entry) =>
          entry.type === 'completed_turn_delivery_allowed'
          && entry.turn_id === turnId
        ),
        false,
      );
      assert.equal(
        entries.some((entry) =>
          entry.type === 'turn_duplicate_suppressed'
          && entry.scope === 'project'
          && entry.turn_id === turnId
        ),
        true,
      );
      const projectState = JSON.parse(
        await readFile(join(stateDir, 'notify-hook-turn-dedupe.json'), 'utf-8'),
      ) as {
        turn_claims?: Record<string, { delivery_status?: string; source?: string }>;
      };
      assert.equal(projectState.turn_claims?.[key]?.delivery_status, 'pending');
      assert.equal(projectState.turn_claims?.[key]?.source, 'native-after-stale-claim');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('fails closed when degraded fallback cannot replay malformed primary dedupe', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-primary-replay-malformed-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');
    const stateDir = join(workdir, '.omx', 'state');

    try {
      await mkdir(stateDir, { recursive: true });
      await writeNotificationConfig(codexHome);
      await writeFile(join(stateDir, 'notify-hook-turn-dedupe.json'), '{ malformed');

      const payload = {
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: 'sess-primary-replay-malformed',
        thread_id: 'thread-primary-replay-malformed',
        turn_id: 'turn-primary-replay-malformed',
        input_messages: [],
        last_assistant_message: 'Do not deliver when degraded fallback cannot validate malformed primary dedupe.',
      };

      const result = runNotifyHook(payload, {
        CODEX_HOME: codexHome,
        OMX_FETCH_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      assert.equal((await readCapturedRequests(capturePath)).length, 0);
      const notifyLog = join(workdir, '.omx', 'logs', `notify-hook-${new Date().toISOString().split('T')[0]}.jsonl`);
      const entries = await readJsonLines(notifyLog);
      assert.equal(
        entries.some((entry) =>
          entry.type === 'project_turn_dedupe_failed'
          && entry.turn_id === 'turn-primary-replay-malformed'
        ),
        true,
      );
      assert.equal(
        entries.some((entry) =>
          entry.type === 'project_turn_dedupe_replay_failed'
          && entry.turn_id === 'turn-primary-replay-malformed'
        ),
        true,
      );
      assert.equal(
        entries.some((entry) =>
          entry.type === 'project_fallback_turn_dedupe_rolled_back'
          && entry.reason === 'primary_replay_failed'
          && entry.rolled_back === true
          && entry.turn_id === 'turn-primary-replay-malformed'
        ),
        true,
      );
      assert.equal(
        entries.some((entry) =>
          entry.type === 'completed_turn_delivery_allowed'
          && entry.turn_id === 'turn-primary-replay-malformed'
        ),
        false,
      );

      const fallbackState = JSON.parse(
        await readFile(join(stateDir, 'notify-hook-state.json'), 'utf-8'),
      ) as {
        turn_claims?: Record<string, unknown>;
      };
      const key = 'thread-primary-replay-malformed|turn-primary-replay-malformed|agent-turn-complete';
      assert.equal(Boolean(fallbackState.turn_claims?.[key]), false);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('stops retrying completed-turn delivery after a failed attempt later succeeds', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-result-ready-retry-succeeds-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot, '', [500, 200, 200]);
    const workdir = join(tempRoot, 'repo');

    try {
      await mkdir(join(workdir, '.omx', 'state'), { recursive: true });
      await writeNotificationConfig(codexHome);

      const payload = {
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: 'sess-result-ready-retry-succeeds',
        thread_id: 'thread-result-ready-retry-succeeds',
        turn_id: 'turn-result-ready-retry-succeeds',
        input_messages: [],
        last_assistant_message: 'Implemented retryable notification delivery. Retry succeeded.',
      };

      const first = runNotifyHook(payload, {
        CODEX_HOME: codexHome,
        OMX_FETCH_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(first.status, 0, first.stderr || first.stdout);

      const second = runNotifyHook(payload, {
        CODEX_HOME: codexHome,
        OMX_FETCH_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(second.status, 0, second.stderr || second.stdout);

      const third = runNotifyHook(payload, {
        CODEX_HOME: codexHome,
        OMX_FETCH_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(third.status, 0, third.stderr || third.stdout);

      const requests = await readCapturedRequests(capturePath);
      assert.equal(requests.length, 2);
      const notifyLog = join(workdir, '.omx', 'logs', `notify-hook-${new Date().toISOString().split('T')[0]}.jsonl`);
      const entries = await readJsonLines(notifyLog);
      assert.equal(
        entries.filter((entry) =>
          entry.type === 'completed_turn_delivery_failed'
          && entry.turn_id === 'turn-result-ready-retry-succeeds'
        ).length,
        1,
      );
      assert.equal(
        entries.filter((entry) =>
          entry.type === 'completed_turn_delivery_sent'
          && entry.turn_id === 'turn-result-ready-retry-succeeds'
        ).length,
        1,
      );
      assert.equal(
        entries.filter((entry) =>
          entry.type === 'completed_turn_delivery_allowed'
          && entry.turn_id === 'turn-result-ready-retry-succeeds'
        ).length,
        2,
      );
      assert.equal(
        entries.some((entry) =>
          entry.type === 'turn_duplicate_suppressed'
          && entry.scope === 'project'
          && entry.turn_id === 'turn-result-ready-retry-succeeds'
        ),
        true,
      );
      const projectState = JSON.parse(
        await readFile(join(workdir, '.omx', 'state', 'notify-hook-turn-dedupe.json'), 'utf-8'),
      ) as {
        turn_claims?: Record<string, { delivery_status?: string; delivery_status_at?: number }>;
      };
      const key = 'thread-result-ready-retry-succeeds|turn-result-ready-retry-succeeds|agent-turn-complete';
      assert.equal(projectState.turn_claims?.[key]?.delivery_status, 'sent');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('commits completed-turn dedupe when only non-standard OpenClaw transport runs', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-ask-openclaw-only-'));
    const codexHome = join(tempRoot, 'codex-home');
    const workdir = join(tempRoot, 'repo');
    const commandCapturePath = join(tempRoot, 'openclaw-command.ndjson');
    const commandScriptPath = await writeOpenClawCommandCaptureScript(tempRoot, commandCapturePath);

    try {
      await mkdir(join(workdir, '.omx', 'state'), { recursive: true });
      await writeNotificationConfig(codexHome, {
        webhook: { enabled: false },
        openclaw: {
          enabled: true,
          gateways: {
            capture: {
              type: 'command',
              command: `${process.execPath} ${commandScriptPath}`,
            },
          },
          hooks: {
            'ask-user-question': {
              enabled: true,
              gateway: 'capture',
              instruction: 'capture ask-user-question',
            },
          },
        },
      });

      const payload = {
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: 'sess-ask-openclaw-only',
        thread_id: 'thread-ask-openclaw-only',
        turn_id: 'turn-ask-openclaw-only',
        input_messages: [],
        last_assistant_message: 'Would you like me to continue with the OpenClaw-only verification?',
      };

      const first = runNotifyHook(payload, {
        CODEX_HOME: codexHome,
        OMX_OPENCLAW: '1',
        OMX_OPENCLAW_COMMAND: '1',
      });
      assert.equal(first.status, 0, first.stderr || first.stdout);

      const second = runNotifyHook(payload, {
        CODEX_HOME: codexHome,
        OMX_OPENCLAW: '1',
        OMX_OPENCLAW_COMMAND: '1',
      });
      assert.equal(second.status, 0, second.stderr || second.stdout);

      const commandCaptures = await readJsonLines(commandCapturePath);
      assert.equal(commandCaptures.length, 1);
      const commandEnv = commandCaptures[0].env as Record<string, string>;
      assert.equal(commandEnv.OMX_OPENCLAW, '1');
      assert.equal(commandEnv.OMX_OPENCLAW_COMMAND, '1');

      const notifyLog = join(workdir, '.omx', 'logs', `notify-hook-${new Date().toISOString().split('T')[0]}.jsonl`);
      const entries = await readJsonLines(notifyLog);
      assert.equal(
        entries.some((entry) =>
          entry.type === 'completed_turn_delivery_failed'
          && entry.turn_id === 'turn-ask-openclaw-only'
        ),
        false,
      );
      assert.equal(
        entries.filter((entry) =>
          entry.type === 'completed_turn_delivery_allowed'
          && entry.turn_id === 'turn-ask-openclaw-only'
        ).length,
        1,
      );
      assert.equal(
        entries.some((entry) =>
          entry.type === 'turn_duplicate_suppressed'
          && entry.scope === 'project'
          && entry.turn_id === 'turn-ask-openclaw-only'
        ),
        true,
      );
      const projectState = JSON.parse(
        await readFile(join(workdir, '.omx', 'state', 'notify-hook-turn-dedupe.json'), 'utf-8'),
      ) as {
        turn_claims?: Record<string, { delivery_status?: string }>;
      };
      const key = 'thread-ask-openclaw-only|turn-ask-openclaw-only|agent-turn-complete';
      assert.equal(projectState.turn_claims?.[key]?.delivery_status, 'sent');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('does not immediately retry after an ambiguous non-standard OpenClaw timeout', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-ask-openclaw-timeout-'));
    const codexHome = join(tempRoot, 'codex-home');
    const workdir = join(tempRoot, 'repo');
    const capturePath = join(tempRoot, 'openclaw-http.ndjson');
    const preloadPath = await writeFetchFailureCapturePreload(tempRoot);

    try {
      await mkdir(join(workdir, '.omx', 'state'), { recursive: true });
      await writeNotificationConfig(codexHome, {
        webhook: { enabled: false },
        openclaw: {
          enabled: true,
          gateways: {
            capture: {
              type: 'http',
              url: 'https://example.com/openclaw',
            },
          },
          hooks: {
            'ask-user-question': {
              enabled: true,
              gateway: 'capture',
              instruction: 'capture ask-user-question',
            },
          },
        },
      });

      const payload = {
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: 'sess-ask-openclaw-timeout',
        thread_id: 'thread-ask-openclaw-timeout',
        turn_id: 'turn-ask-openclaw-timeout',
        input_messages: [],
        last_assistant_message: 'Would you like me to continue after this OpenClaw timeout?',
      };

      const first = runNotifyHook(payload, {
        CODEX_HOME: codexHome,
        OMX_OPENCLAW: '1',
        OMX_FETCH_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(first.status, 0, first.stderr || first.stdout);

      const second = runNotifyHook(payload, {
        CODEX_HOME: codexHome,
        OMX_OPENCLAW: '1',
        OMX_FETCH_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(second.status, 0, second.stderr || second.stdout);

      const requests = await readJsonLines(capturePath);
      assert.equal(requests.length, 1);

      const notifyLog = join(workdir, '.omx', 'logs', `notify-hook-${new Date().toISOString().split('T')[0]}.jsonl`);
      const entries = await readJsonLines(notifyLog);
      const failure = entries.find((entry) =>
        entry.type === 'completed_turn_delivery_failed'
        && entry.turn_id === 'turn-ask-openclaw-timeout'
      );
      assert.equal(failure?.delivery_failure_kind, 'ambiguous_timeout');
      assert.deepEqual(failure?.notification_results, [{
        platform: 'openclaw',
        success: false,
        error: 'Dispatch timeout',
        gateway: 'capture',
      }]);
      assert.equal(
        entries.filter((entry) =>
          entry.type === 'completed_turn_delivery_allowed'
          && entry.turn_id === 'turn-ask-openclaw-timeout'
        ).length,
        1,
      );
      assert.equal(
        entries.some((entry) =>
          entry.type === 'completed_turn_delivery_sent'
          && entry.turn_id === 'turn-ask-openclaw-timeout'
        ),
        false,
      );
      const projectState = JSON.parse(
        await readFile(join(workdir, '.omx', 'state', 'notify-hook-turn-dedupe.json'), 'utf-8'),
      ) as {
        turn_claims?: Record<string, { delivery_status?: string }>;
      };
      const key = 'thread-ask-openclaw-timeout|turn-ask-openclaw-timeout|agent-turn-complete';
      assert.equal(projectState.turn_claims?.[key]?.delivery_status, 'delivery_unknown');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('treats non-standard OpenClaw gateway timeout statuses as ambiguous', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-ask-openclaw-504-'));
    const codexHome = join(tempRoot, 'codex-home');
    const workdir = join(tempRoot, 'repo');
    const capturePath = join(tempRoot, 'openclaw-http.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot, '', 504);

    try {
      await mkdir(join(workdir, '.omx', 'state'), { recursive: true });
      await writeNotificationConfig(codexHome, {
        webhook: { enabled: false },
        openclaw: {
          enabled: true,
          gateways: {
            capture: {
              type: 'http',
              url: 'https://example.com/openclaw',
            },
          },
          hooks: {
            'ask-user-question': {
              enabled: true,
              gateway: 'capture',
              instruction: 'capture ask-user-question',
            },
          },
        },
      });

      const payload = {
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: 'sess-ask-openclaw-504',
        thread_id: 'thread-ask-openclaw-504',
        turn_id: 'turn-ask-openclaw-504',
        input_messages: [],
        last_assistant_message: 'Would you like me to continue after this OpenClaw gateway timeout?',
      };

      const first = runNotifyHook(payload, {
        CODEX_HOME: codexHome,
        OMX_OPENCLAW: '1',
        OMX_FETCH_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(first.status, 0, first.stderr || first.stdout);

      const second = runNotifyHook(payload, {
        CODEX_HOME: codexHome,
        OMX_OPENCLAW: '1',
        OMX_FETCH_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(second.status, 0, second.stderr || second.stdout);

      assert.equal((await readJsonLines(capturePath)).length, 1);
      const notifyLog = join(workdir, '.omx', 'logs', `notify-hook-${new Date().toISOString().split('T')[0]}.jsonl`);
      const entries = await readJsonLines(notifyLog);
      const failure = entries.find((entry) =>
        entry.type === 'completed_turn_delivery_failed'
        && entry.turn_id === 'turn-ask-openclaw-504'
      );
      assert.equal(failure?.delivery_failure_kind, 'ambiguous_timeout');
      assert.deepEqual(failure?.notification_results, [{
        platform: 'openclaw',
        success: false,
        error: 'HTTP 504',
        gateway: 'capture',
        status_code: 504,
      }]);
      assert.equal(
        entries.filter((entry) =>
          entry.type === 'completed_turn_delivery_allowed'
          && entry.turn_id === 'turn-ask-openclaw-504'
        ).length,
        1,
      );
      const projectState = JSON.parse(
        await readFile(join(workdir, '.omx', 'state', 'notify-hook-turn-dedupe.json'), 'utf-8'),
      ) as {
        turn_claims?: Record<string, { delivery_status?: string }>;
      };
      const key = 'thread-ask-openclaw-504|turn-ask-openclaw-504|agent-turn-complete';
      assert.equal(projectState.turn_claims?.[key]?.delivery_status, 'delivery_unknown');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('commits completed-turn dedupe when only custom CLI transport runs', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-ask-custom-only-'));
    const codexHome = join(tempRoot, 'codex-home');
    const workdir = join(tempRoot, 'repo');
    const commandCapturePath = join(tempRoot, 'custom-command.ndjson');
    const commandScriptPath = await writeOpenClawCommandCaptureScript(tempRoot, commandCapturePath);

    try {
      await mkdir(join(workdir, '.omx', 'state'), { recursive: true });
      await writeNotificationConfig(codexHome, {
        webhook: { enabled: false },
        custom_cli_command: {
          command: `${process.execPath} ${commandScriptPath}`,
          events: ['ask-user-question'],
        },
      });

      const payload = {
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: 'sess-ask-custom-only',
        thread_id: 'thread-ask-custom-only',
        turn_id: 'turn-ask-custom-only',
        input_messages: [],
        last_assistant_message: 'Would you like me to continue with the custom-only verification?',
      };

      const first = runNotifyHook(payload, {
        CODEX_HOME: codexHome,
        OMX_OPENCLAW: '1',
        OMX_OPENCLAW_COMMAND: '1',
      });
      assert.equal(first.status, 0, first.stderr || first.stdout);

      const second = runNotifyHook(payload, {
        CODEX_HOME: codexHome,
        OMX_OPENCLAW: '1',
        OMX_OPENCLAW_COMMAND: '1',
      });
      assert.equal(second.status, 0, second.stderr || second.stdout);

      const commandCaptures = await readJsonLines(commandCapturePath);
      assert.equal(commandCaptures.length, 1);
      const commandEnv = commandCaptures[0].env as Record<string, string>;
      assert.equal(commandEnv.OMX_OPENCLAW, '1');
      assert.equal(commandEnv.OMX_OPENCLAW_COMMAND, '1');

      const notifyLog = join(workdir, '.omx', 'logs', `notify-hook-${new Date().toISOString().split('T')[0]}.jsonl`);
      const entries = await readJsonLines(notifyLog);
      assert.equal(
        entries.some((entry) =>
          entry.type === 'completed_turn_delivery_failed'
          && entry.turn_id === 'turn-ask-custom-only'
        ),
        false,
      );
      assert.equal(
        entries.filter((entry) =>
          entry.type === 'completed_turn_delivery_allowed'
          && entry.turn_id === 'turn-ask-custom-only'
        ).length,
        1,
      );
      assert.equal(
        entries.some((entry) =>
          entry.type === 'turn_duplicate_suppressed'
          && entry.scope === 'project'
          && entry.turn_id === 'turn-ask-custom-only'
        ),
        true,
      );
      const projectState = JSON.parse(
        await readFile(join(workdir, '.omx', 'state', 'notify-hook-turn-dedupe.json'), 'utf-8'),
      ) as {
        turn_claims?: Record<string, { delivery_status?: string; delivery_status_at?: number }>;
      };
      const key = 'thread-ask-custom-only|turn-ask-custom-only|agent-turn-complete';
      assert.equal(projectState.turn_claims?.[key]?.delivery_status, 'sent');

      projectState.turn_claims![key] = {
        ...projectState.turn_claims![key],
        delivery_status: 'dispatching',
        delivery_status_at: 0,
      };
      await writeFile(
        join(workdir, '.omx', 'state', 'notify-hook-turn-dedupe.json'),
        JSON.stringify(projectState, null, 2),
      );

      const third = runNotifyHook(payload, {
        CODEX_HOME: codexHome,
        OMX_OPENCLAW: '1',
        OMX_OPENCLAW_COMMAND: '1',
      });
      assert.equal(third.status, 0, third.stderr || third.stdout);
      assert.equal((await readJsonLines(commandCapturePath)).length, 1);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('closes completed-turn dedupe when custom transport succeeds despite standard transport failure', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-ask-mixed-custom-'));
    const codexHome = join(tempRoot, 'codex-home');
    const workdir = join(tempRoot, 'repo');
    const fetchCapturePath = join(tempRoot, 'webhook.ndjson');
    const commandCapturePath = join(tempRoot, 'custom-command.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot, '', 500);
    const commandScriptPath = await writeOpenClawCommandCaptureScript(tempRoot, commandCapturePath);

    try {
      await mkdir(join(workdir, '.omx', 'state'), { recursive: true });
      await writeNotificationConfig(codexHome, {
        webhook: { enabled: true, url: 'https://example.com/hooks/notify' },
        custom_cli_command: {
          command: `${process.execPath} ${commandScriptPath}`,
          events: ['ask-user-question'],
        },
      });

      const payload = {
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: 'sess-ask-mixed-custom',
        thread_id: 'thread-ask-mixed-custom',
        turn_id: 'turn-ask-mixed-custom',
        input_messages: [],
        last_assistant_message: 'Would you like me to continue with the mixed custom verification?',
      };

      const first = runNotifyHook(payload, {
        CODEX_HOME: codexHome,
        OMX_FETCH_CAPTURE_PATH: fetchCapturePath,
        OMX_OPENCLAW: '1',
        OMX_OPENCLAW_COMMAND: '1',
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(first.status, 0, first.stderr || first.stdout);

      const second = runNotifyHook(payload, {
        CODEX_HOME: codexHome,
        OMX_FETCH_CAPTURE_PATH: fetchCapturePath,
        OMX_OPENCLAW: '1',
        OMX_OPENCLAW_COMMAND: '1',
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(second.status, 0, second.stderr || second.stdout);

      assert.equal((await readJsonLines(fetchCapturePath)).length, 1);
      assert.equal((await readJsonLines(commandCapturePath)).length, 1);

      const notifyLog = join(workdir, '.omx', 'logs', `notify-hook-${new Date().toISOString().split('T')[0]}.jsonl`);
      const entries = await readJsonLines(notifyLog);
      const sent = entries.find((entry) =>
        entry.type === 'completed_turn_delivery_sent'
        && entry.turn_id === 'turn-ask-mixed-custom'
      );
      assert.equal(sent?.non_standard_any_success, true);
      assert.deepEqual(sent?.notification_results, [
        { platform: 'webhook', success: false, error: 'HTTP 500', status_code: 500 },
        { platform: 'openclaw', success: true, gateway: 'custom-cli' },
      ]);
      const projectState = JSON.parse(
        await readFile(join(workdir, '.omx', 'state', 'notify-hook-turn-dedupe.json'), 'utf-8'),
      ) as {
        turn_claims?: Record<string, { delivery_status?: string }>;
      };
      const key = 'thread-ask-mixed-custom|turn-ask-mixed-custom|agent-turn-complete';
      assert.equal(projectState.turn_claims?.[key]?.delivery_status, 'sent');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('does not commit custom-only completed-turn dedupe until the custom transport succeeds', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-ask-custom-only-gated-'));
    const codexHome = join(tempRoot, 'codex-home');
    const workdir = join(tempRoot, 'repo');
    const commandCapturePath = join(tempRoot, 'custom-command.ndjson');
    const commandScriptPath = await writeOpenClawCommandCaptureScript(tempRoot, commandCapturePath);

    try {
      await mkdir(join(workdir, '.omx', 'state'), { recursive: true });
      await writeNotificationConfig(codexHome, {
        webhook: { enabled: false },
        custom_cli_command: {
          command: `${process.execPath} ${commandScriptPath}`,
          events: ['ask-user-question'],
        },
      });

      const payload = {
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: 'sess-ask-custom-only-gated',
        thread_id: 'thread-ask-custom-only-gated',
        turn_id: 'turn-ask-custom-only-gated',
        input_messages: [],
        last_assistant_message: 'Would you like me to continue with the gated custom verification?',
      };

      const first = runNotifyHook(payload, {
        CODEX_HOME: codexHome,
        OMX_OPENCLAW: '1',
      });
      assert.equal(first.status, 0, first.stderr || first.stdout);
      assert.deepEqual(await readJsonLines(commandCapturePath), []);

      const key = 'thread-ask-custom-only-gated|turn-ask-custom-only-gated|agent-turn-complete';
      let projectState = JSON.parse(
        await readFile(join(workdir, '.omx', 'state', 'notify-hook-turn-dedupe.json'), 'utf-8'),
      ) as {
        turn_claims?: Record<string, { delivery_status?: string }>;
      };
      assert.equal(projectState.turn_claims?.[key]?.delivery_status, 'dispatching');

      const second = runNotifyHook(payload, {
        CODEX_HOME: codexHome,
        OMX_OPENCLAW: '1',
        OMX_OPENCLAW_COMMAND: '1',
      });
      assert.equal(second.status, 0, second.stderr || second.stdout);

      const commandCaptures = await readJsonLines(commandCapturePath);
      assert.equal(commandCaptures.length, 1);
      const notifyLog = join(workdir, '.omx', 'logs', `notify-hook-${new Date().toISOString().split('T')[0]}.jsonl`);
      const entries = await readJsonLines(notifyLog);
      assert.equal(
        entries.filter((entry) =>
          entry.type === 'completed_turn_delivery_failed'
          && entry.turn_id === 'turn-ask-custom-only-gated'
        ).length,
        1,
      );
      assert.equal(
        entries.filter((entry) =>
          entry.type === 'completed_turn_delivery_allowed'
          && entry.turn_id === 'turn-ask-custom-only-gated'
        ).length,
        2,
      );

      projectState = JSON.parse(
        await readFile(join(workdir, '.omx', 'state', 'notify-hook-turn-dedupe.json'), 'utf-8'),
      ) as {
        turn_claims?: Record<string, { delivery_status?: string }>;
      };
      assert.equal(projectState.turn_claims?.[key]?.delivery_status, 'sent');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('recovers pending completed-turn delivery after dispatch status persistence fails', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-result-ready-dispatch-failed-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');
    const stateDir = join(workdir, '.omx', 'state');
    const logsDir = join(workdir, '.omx', 'logs');

    try {
      await mkdir(stateDir, { recursive: true });
      await mkdir(logsDir, { recursive: true });
      await writeNotificationConfig(codexHome);
      const threadId = 'thread-result-ready-dispatch-failed';
      const turnId = 'turn-result-ready-dispatch-failed';
      const key = `${threadId}|${turnId}|agent-turn-complete`;
      const timestamp = Date.now() - 1_000;
      await writeFile(join(stateDir, 'notify-hook-turn-dedupe.json'), JSON.stringify({
        recent_turns: { [key]: timestamp },
        turn_claims: {
          [key]: {
            timestamp,
            delivery: 'allow',
            delivery_status: 'pending',
            delivery_status_at: timestamp,
            source_kind: 'native',
            source: '',
            session_id: 'sess-result-ready-dispatch-failed',
            audience: 'external-owner',
            reason: 'owner_actor_completed',
          },
        },
        last_event_at: new Date(timestamp).toISOString(),
      }));
      await writeFile(join(logsDir, 'notify-hook-existing.jsonl'), `${JSON.stringify({
        timestamp: new Date().toISOString(),
        type: 'project_turn_dedupe_delivery_status_failed',
        delivery_status: 'dispatching',
        thread_id: threadId,
        turn_id: turnId,
        omx_session_id: 'sess-result-ready-dispatch-failed',
      })}\n`);

      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: 'sess-result-ready-dispatch-failed',
        thread_id: threadId,
        turn_id: turnId,
        input_messages: [],
        last_assistant_message: 'Retry after dispatch status persistence failed.',
      }, {
        CODEX_HOME: codexHome,
        OMX_FETCH_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const requests = await readCapturedRequests(capturePath);
      assert.equal(requests.length, 1);
      const projectState = JSON.parse(
        await readFile(join(stateDir, 'notify-hook-turn-dedupe.json'), 'utf-8'),
      ) as {
        turn_claims?: Record<string, { delivery_status?: string }>;
      };
      assert.equal(projectState.turn_claims?.[key]?.delivery_status, 'sent');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('recovers stale dispatching completed-turn delivery claims without failure logs', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-result-ready-stale-dispatching-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');
    const stateDir = join(workdir, '.omx', 'state');

    try {
      await mkdir(stateDir, { recursive: true });
      await writeNotificationConfig(codexHome);
      const threadId = 'thread-result-ready-stale-dispatching';
      const turnId = 'turn-result-ready-stale-dispatching';
      const key = `${threadId}|${turnId}|agent-turn-complete`;
      const timestamp = Date.now() - 61_000;
      await writeFile(join(stateDir, 'notify-hook-turn-dedupe.json'), JSON.stringify({
        recent_turns: { [key]: timestamp },
        turn_claims: {
          [key]: {
            timestamp,
            delivery: 'allow',
            delivery_status: 'dispatching',
            delivery_status_at: timestamp,
            source_kind: 'native',
            source: '',
            session_id: 'sess-result-ready-stale-dispatching',
            audience: 'external-owner',
            reason: 'owner_actor_completed',
          },
        },
        last_event_at: new Date(timestamp).toISOString(),
      }));

      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: 'sess-result-ready-stale-dispatching',
        thread_id: threadId,
        turn_id: turnId,
        input_messages: [],
        last_assistant_message: 'Retry after stale dispatching delivery claim.',
      }, {
        CODEX_HOME: codexHome,
        OMX_FETCH_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const requests = await readCapturedRequests(capturePath);
      assert.equal(requests.length, 1);
      const projectState = JSON.parse(
        await readFile(join(stateDir, 'notify-hook-turn-dedupe.json'), 'utf-8'),
      ) as {
        turn_claims?: Record<string, { delivery_status?: string }>;
      };
      assert.equal(projectState.turn_claims?.[key]?.delivery_status, 'sent');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('suppresses fresh pending completed-turn delivery claims without failure evidence', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-result-ready-fresh-pending-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');
    const stateDir = join(workdir, '.omx', 'state');
    const logsDir = join(workdir, '.omx', 'logs');

    try {
      await mkdir(stateDir, { recursive: true });
      await mkdir(logsDir, { recursive: true });
      await writeNotificationConfig(codexHome);
      const threadId = 'thread-result-ready-fresh-pending';
      const turnId = 'turn-result-ready-fresh-pending';
      const key = `${threadId}|${turnId}|agent-turn-complete`;
      const timestamp = Date.now() - 1_000;
      await writeFile(join(stateDir, 'notify-hook-turn-dedupe.json'), JSON.stringify({
        recent_turns: { [key]: timestamp },
        turn_claims: {
          [key]: {
            timestamp,
            delivery: 'allow',
            delivery_status: 'pending',
            delivery_status_at: timestamp,
            source_kind: 'native',
            source: '',
            session_id: 'sess-result-ready-fresh-pending',
            audience: 'external-owner',
            reason: 'owner_actor_completed',
          },
        },
        last_event_at: new Date(timestamp).toISOString(),
      }));
      await writeFile(join(logsDir, 'notify-hook-existing.jsonl'), `${JSON.stringify({
        timestamp: new Date(timestamp - 1_000).toISOString(),
        type: 'completed_turn_delivery_failed',
        thread_id: threadId,
        turn_id: turnId,
        omx_session_id: 'sess-result-ready-fresh-pending',
      })}\n`);

      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: 'sess-result-ready-fresh-pending',
        thread_id: threadId,
        turn_id: turnId,
        input_messages: [],
        last_assistant_message: 'Do not recover a fresh pending delivery claim.',
      }, {
        CODEX_HOME: codexHome,
        OMX_FETCH_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const requests = await readCapturedRequests(capturePath);
      assert.equal(requests.length, 0);
      const notifyLog = join(workdir, '.omx', 'logs', `notify-hook-${new Date().toISOString().split('T')[0]}.jsonl`);
      const entries = await readJsonLines(notifyLog);
      assert.equal(
        entries.some((entry) =>
          entry.type === 'completed_turn_delivery_allowed'
          && entry.turn_id === turnId
        ),
        false,
      );
      const projectState = JSON.parse(
        await readFile(join(stateDir, 'notify-hook-turn-dedupe.json'), 'utf-8'),
      ) as {
        turn_claims?: Record<string, { delivery_status?: string }>;
      };
      assert.equal(projectState.turn_claims?.[key]?.delivery_status, 'pending');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('suppresses fresh dispatching completed-turn delivery claims without failure evidence', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-result-ready-fresh-dispatching-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');
    const stateDir = join(workdir, '.omx', 'state');

    try {
      await mkdir(stateDir, { recursive: true });
      await writeNotificationConfig(codexHome);
      const threadId = 'thread-result-ready-fresh-dispatching';
      const turnId = 'turn-result-ready-fresh-dispatching';
      const key = `${threadId}|${turnId}|agent-turn-complete`;
      const timestamp = Date.now() - 120_000;
      const deliveryStatusAt = Date.now() - 1_000;
      await writeFile(join(stateDir, 'notify-hook-turn-dedupe.json'), JSON.stringify({
        recent_turns: { [key]: timestamp },
        turn_claims: {
          [key]: {
            timestamp,
            delivery: 'allow',
            delivery_status: 'dispatching',
            delivery_status_at: deliveryStatusAt,
            source_kind: 'native',
            source: '',
            session_id: 'sess-result-ready-fresh-dispatching',
            audience: 'external-owner',
            reason: 'owner_actor_completed',
          },
        },
        last_event_at: new Date(deliveryStatusAt).toISOString(),
      }));

      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: 'sess-result-ready-fresh-dispatching',
        thread_id: threadId,
        turn_id: turnId,
        input_messages: [],
        last_assistant_message: 'Do not recover a fresh dispatching delivery claim.',
      }, {
        CODEX_HOME: codexHome,
        OMX_FETCH_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const requests = await readCapturedRequests(capturePath);
      assert.equal(requests.length, 0);
      const projectState = JSON.parse(
        await readFile(join(stateDir, 'notify-hook-turn-dedupe.json'), 'utf-8'),
      ) as {
        turn_claims?: Record<string, { delivery_status?: string }>;
      };
      assert.equal(projectState.turn_claims?.[key]?.delivery_status, 'dispatching');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('recovers stale pending completed-turn delivery claims without failure logs', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-result-ready-stale-pending-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');
    const stateDir = join(workdir, '.omx', 'state');

    try {
      await mkdir(stateDir, { recursive: true });
      await writeNotificationConfig(codexHome);
      const threadId = 'thread-result-ready-stale-pending';
      const turnId = 'turn-result-ready-stale-pending';
      const key = `${threadId}|${turnId}|agent-turn-complete`;
      const timestamp = Date.now() - (6 * 60_000);
      await writeFile(join(stateDir, 'notify-hook-turn-dedupe.json'), JSON.stringify({
        recent_turns: { [key]: timestamp },
        turn_claims: {
          [key]: {
            timestamp,
            delivery: 'allow',
            delivery_status: 'pending',
            delivery_status_at: timestamp,
            source_kind: 'native',
            source: '',
            session_id: 'sess-result-ready-stale-pending',
            audience: 'external-owner',
            reason: 'owner_actor_completed',
          },
        },
        last_event_at: new Date(timestamp).toISOString(),
      }));

      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: 'sess-result-ready-stale-pending',
        thread_id: threadId,
        turn_id: turnId,
        input_messages: [],
        last_assistant_message: 'Retry after stale pending delivery claim.',
      }, {
        CODEX_HOME: codexHome,
        OMX_FETCH_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const requests = await readCapturedRequests(capturePath);
      assert.equal(requests.length, 1);
      const projectState = JSON.parse(
        await readFile(join(stateDir, 'notify-hook-turn-dedupe.json'), 'utf-8'),
      ) as {
        turn_claims?: Record<string, { delivery_status?: string }>;
      };
      assert.equal(projectState.turn_claims?.[key]?.delivery_status, 'sent');
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


  it('sends a generated image-only Telegram follow-up as sendPhoto and completes the pending route after delivery', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-telegram-image-only-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'telegram-captures.ndjson');
    const preloadPath = await writeTelegramCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');
    const sessionId = 'sess-telegram-image-only';
    const threadId = 'thread-telegram-image-only';
    const turnId = 'turn-telegram-image-only';

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
      await writeOwnerSessionState(workdir, sessionId, threadId);
      const generatedDir = join(codexHome, 'generated_images', threadId);
      await mkdir(generatedDir, { recursive: true });
      await writeFile(join(generatedDir, 'stale.png'), Buffer.from('stale-png'));
      const imagePath = join(generatedDir, 'result.png');
      await writeFile(imagePath, Buffer.from('png'));
      const transcriptPath = join(tempRoot, 'rollout-image-only.jsonl');
      await writeImageGenerationTranscript(transcriptPath, turnId, imagePath);

      const latestInput = buildExpectedReplyInput('Generate an image of a blue robot', 'telegram');
      await recordPendingReplyOrigin(workdir, sessionId, {
        platform: 'telegram',
        injectedInput: latestInput,
        createdAt: new Date().toISOString(),
        telegramAck: { chatId: '777', messageId: '3760', messageThreadId: '9001' },
        telegramReplyTo: { chatId: '777', messageId: '3759', messageThreadId: '9001' },
      });

      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: sessionId,
        thread_id: threadId,
        turn_id: turnId,
        transcript_path: transcriptPath,
        input_messages: [latestInput],
        last_assistant_message: null,
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
      const sendPhotoRequests = requests.filter((request) => /sendPhoto/.test(request.url));
      assert.equal(sendPhotoRequests.length, 1);
      assert.match(sendPhotoRequests[0].body, /name="photo"; filename="result\.png"/);
      assert.ok(sendPhotoRequests[0].body.includes('name="message_thread_id"\r\n\r\n9001'));
      assert.ok(sendPhotoRequests[0].body.includes('name="reply_to_message_id"\r\n\r\n3759'));
      assert.equal(requests.filter((request) => /deleteMessage/.test(request.url)).length, 1);

      const routes = JSON.parse(await readFile(pendingRoutesStatePath(workdir, sessionId), 'utf-8')) as {
        routes?: unknown[];
        terminal?: Array<{ status?: string }>;
      };
      assert.deepEqual(routes.routes, []);
      assert.equal(routes.terminal?.[0]?.status, 'completed');

      const notifyLog = join(workdir, '.omx', 'logs', `notify-hook-${new Date().toISOString().split('T')[0]}.jsonl`);
      const entries = await readJsonLines(notifyLog);
      assert.ok(entries.some((entry) => entry.type === 'completed_turn_delivery_allowed' && entry.rich_media_part_count === 1));
      assert.ok(entries.some((entry) => entry.type === 'completed_turn_delivery_sent'));
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('sends an image-only Telegram follow-up as sendDocument when photo policy rejects it', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-telegram-image-document-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'telegram-captures.ndjson');
    const preloadPath = await writeTelegramCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');
    const sessionId = 'sess-telegram-image-document';
    const threadId = 'thread-telegram-image-document';
    const turnId = 'turn-telegram-image-document';

    try {
      await mkdir(join(workdir, '.omx', 'state'), { recursive: true });
      await writeNotificationConfig(codexHome, {
        webhook: { enabled: false },
        telegram: {
          enabled: true,
          botToken: '123456:telegram-token',
          chatId: '777',
          projectTopics: { enabled: true },
          richReplies: { maxPhotoBytes: 1 },
        },
      });
      await writeTelegramTopicRegistryRecord(tempRoot, workdir, {
        botId: '123456',
        chatId: '777',
        topicName: 'repo-topic',
        messageThreadId: '9001',
      });
      await writeOwnerSessionState(workdir, sessionId, threadId);
      const generatedDir = join(codexHome, 'generated_images', threadId);
      await mkdir(generatedDir, { recursive: true });
      const imagePath = join(generatedDir, 'result.png');
      await writeFile(imagePath, Buffer.from('png'));
      const transcriptPath = join(tempRoot, 'rollout-image-document.jsonl');
      await writeImageGenerationTranscript(transcriptPath, turnId, imagePath);

      const latestInput = buildExpectedReplyInput('Generate a large image of a blue robot', 'telegram');
      await recordPendingReplyOrigin(workdir, sessionId, {
        platform: 'telegram',
        injectedInput: latestInput,
        createdAt: new Date().toISOString(),
        telegramAck: { chatId: '777', messageId: '3760', messageThreadId: '9001' },
        telegramReplyTo: { chatId: '777', messageId: '3759', messageThreadId: '9001' },
      });

      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: sessionId,
        thread_id: threadId,
        turn_id: turnId,
        transcript_path: transcriptPath,
        input_messages: [latestInput],
        last_assistant_message: '',
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
      assert.equal(requests.filter((request) => /sendPhoto/.test(request.url)).length, 0);
      const sendDocumentRequests = requests.filter((request) => /sendDocument/.test(request.url));
      assert.equal(sendDocumentRequests.length, 1);
      assert.match(sendDocumentRequests[0].body, /name="document"; filename="result\.png"/);
      assert.ok(sendDocumentRequests[0].body.includes('name="message_thread_id"\r\n\r\n9001'));
      assert.ok(sendDocumentRequests[0].body.includes('name="reply_to_message_id"\r\n\r\n3759'));
      assert.equal(requests.filter((request) => /deleteMessage/.test(request.url)).length, 1);

      const routes = JSON.parse(await readFile(pendingRoutesStatePath(workdir, sessionId), 'utf-8')) as {
        routes?: unknown[];
        terminal?: Array<{ status?: string }>;
      };
      assert.deepEqual(routes.routes, []);
      assert.equal(routes.terminal?.[0]?.status, 'completed');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });


  it('marks a generated image-only Telegram follow-up route failed when sendPhoto fails', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-telegram-image-failure-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'telegram-captures.ndjson');
    const preloadPath = await writeTelegramFailingSendPhotoPreload(tempRoot);
    const workdir = join(tempRoot, 'repo');
    const sessionId = 'sess-telegram-image-failure';
    const threadId = 'thread-telegram-image-failure';
    const turnId = 'turn-telegram-image-failure';

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
      await writeOwnerSessionState(workdir, sessionId, threadId);
      const generatedDir = join(codexHome, 'generated_images', threadId);
      await mkdir(generatedDir, { recursive: true });
      await writeFile(join(generatedDir, 'stale.png'), Buffer.from('stale-png'));
      const imagePath = join(generatedDir, 'result.png');
      await writeFile(imagePath, Buffer.from('png'));
      const transcriptPath = join(tempRoot, 'rollout-image-failure.jsonl');
      await writeImageGenerationTranscript(transcriptPath, turnId, imagePath);

      const latestInput = buildExpectedReplyInput('Generate an image of a red robot', 'telegram');
      await recordPendingReplyOrigin(workdir, sessionId, {
        platform: 'telegram',
        injectedInput: latestInput,
        createdAt: new Date().toISOString(),
        telegramAck: { chatId: '777', messageId: '3760', messageThreadId: '9001' },
        telegramReplyTo: { chatId: '777', messageId: '3759', messageThreadId: '9001' },
      });

      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: sessionId,
        thread_id: threadId,
        turn_id: turnId,
        transcript_path: transcriptPath,
        input_messages: [latestInput],
        last_assistant_message: '',
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
      assert.equal(requests.filter((request) => /sendPhoto/.test(request.url)).length, 1);
      assert.equal(requests.filter((request) => /deleteMessage/.test(request.url)).length, 0);

      const routes = JSON.parse(await readFile(pendingRoutesStatePath(workdir, sessionId), 'utf-8')) as {
        routes?: unknown[];
        terminal?: Array<{ status?: string; terminalReason?: string }>;
      };
      assert.deepEqual(routes.routes, []);
      assert.equal(routes.terminal?.[0]?.status, 'failed');
      assert.match(routes.terminal?.[0]?.terminalReason ?? '', /media upload failed|HTTP 500/);

      const notifyLog = join(workdir, '.omx', 'logs', `notify-hook-${new Date().toISOString().split('T')[0]}.jsonl`);
      const entries = await readJsonLines(notifyLog);
      assert.ok(entries.some((entry) => entry.type === 'completed_turn_delivery_failed'));
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('marks a claimed Telegram route failed when result-ready delivery is disabled before dispatch', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-telegram-route-not-dispatched-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'telegram-captures.ndjson');
    const preloadPath = await writeTelegramCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');
    const sessionId = 'sess-telegram-route-not-dispatched';
    const threadId = 'thread-telegram-route-not-dispatched';
    const turnId = 'turn-telegram-route-not-dispatched';

    try {
      await mkdir(join(workdir, '.omx', 'state'), { recursive: true });
      await writeNotificationConfig(codexHome, {
        webhook: { enabled: false },
        telegram: {
          enabled: true,
          botToken: '123456:telegram-token',
          chatId: '777',
        },
        events: {
          'result-ready': { enabled: false },
        },
      });
      await writeOwnerSessionState(workdir, sessionId, threadId);

      const latestInput = buildExpectedReplyInput('Do the work', 'telegram');
      await recordPendingReplyOrigin(workdir, sessionId, {
        platform: 'telegram',
        injectedInput: latestInput,
        createdAt: new Date().toISOString(),
        telegramAck: { chatId: '777', messageId: '3760' },
        telegramReplyTo: { chatId: '777', messageId: '3759' },
      });

      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: sessionId,
        thread_id: threadId,
        turn_id: turnId,
        input_messages: [latestInput],
        last_assistant_message: 'Done.',
      }, {
        CODEX_HOME: codexHome,
        HOME: tempRoot,
        USERPROFILE: tempRoot,
        OMX_TELEGRAM_CAPTURE_PATH: capturePath,
        OMX_TEST_MOCK_TELEGRAM_TRANSPORT: '1',
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.deepEqual(await readCapturedRequests(capturePath), []);

      const routes = JSON.parse(await readFile(pendingRoutesStatePath(workdir, sessionId), 'utf-8')) as {
        routes?: unknown[];
        terminal?: Array<{ status?: string; terminalReason?: string }>;
      };
      assert.deepEqual(routes.routes, []);
      assert.equal(routes.terminal?.[0]?.status, 'failed');
      assert.equal(routes.terminal?.[0]?.terminalReason, 'completed turn notification event disabled');

      const notifyLog = join(workdir, '.omx', 'logs', `notify-hook-${new Date().toISOString().split('T')[0]}.jsonl`);
      const entries = await readJsonLines(notifyLog);
      assert.ok(entries.some((entry) =>
        entry.type === 'pending_route_delivery_not_dispatched'
        && entry.reason === 'event_disabled'
      ));
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('keeps Telegram follow-up route through native subagent completions and delivers the leader final', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-telegram-route-actor-registry-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'telegram-captures.ndjson');
    const preloadPath = await writeTelegramCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');
    const leaderThreadId = 'thread-telegram-route-leader';
    const sessionId = leaderThreadId;
    const childThreadId = 'thread-telegram-route-child';
    const userInput = buildExpectedReplyInput('Please finish the plan', 'telegram');
    const rawMessage = 'Done — the route stayed bound to the leader and this is the final reply.';

    try {
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
      await dispatchCodexNativeHook({
        hook_event_name: 'SessionStart',
        cwd: workdir,
        session_id: leaderThreadId,
        thread_id: leaderThreadId,
      }, {
        cwd: workdir,
        sessionOwnerPid: process.pid,
      });
      await dispatchCodexNativeHook({
        hook_event_name: 'SessionStart',
        cwd: workdir,
        session_id: childThreadId,
        thread_id: childThreadId,
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: leaderThreadId,
            },
            agent_role: 'code-reviewer',
          },
        },
      }, {
        cwd: workdir,
        sessionOwnerPid: process.pid,
      });
      await recordPendingReplyOrigin(workdir, sessionId, {
        platform: 'telegram',
        injectedInput: userInput,
        createdAt: new Date().toISOString(),
        telegramAck: { chatId: '777', messageId: '3760', messageThreadId: '9001' },
        telegramReplyTo: { chatId: '777', messageId: '3759', messageThreadId: '9001' },
      });

      const env = {
        CODEX_HOME: codexHome,
        HOME: tempRoot,
        USERPROFILE: tempRoot,
        OMX_TELEGRAM_CAPTURE_PATH: capturePath,
        OMX_TEST_MOCK_TELEGRAM_TRANSPORT: '1',
        NODE_OPTIONS: `--import=${preloadPath}`,
      };
      const child = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: childThreadId,
        thread_id: childThreadId,
        turn_id: 'turn-telegram-route-child',
        input_messages: [userInput],
        last_assistant_message: 'internal child summary must not be sent',
      }, env);
      assert.equal(child.status, 0, child.stderr || child.stdout);
      assert.equal((await readCapturedRequests(capturePath)).filter((request) => /sendMessage/.test(request.url)).length, 0);

      const leader = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: leaderThreadId,
        thread_id: leaderThreadId,
        turn_id: 'turn-telegram-route-leader',
        input_messages: [userInput],
        last_assistant_message: rawMessage,
      }, env);
      assert.equal(leader.status, 0, leader.stderr || leader.stdout);

      const requests = await readCapturedRequests(capturePath);
      const sendMessageRequests = requests.filter((request) => /sendMessage/.test(request.url));
      assert.equal(sendMessageRequests.length, 1);
      const body = JSON.parse(sendMessageRequests[0].body) as {
        text: string;
        message_thread_id?: number;
        reply_to_message_id?: number;
      };
      assert.equal(body.text, rawMessage);
      assert.equal(body.message_thread_id, 9001);
      assert.equal(body.reply_to_message_id, 3759);

      const routes = JSON.parse(await readFile(join(workdir, '.omx', 'state', 'sessions', sessionId, 'pending-routes.json'), 'utf-8')) as {
        routes?: unknown[];
        terminal?: Array<{ status?: string }>;
      };
      assert.equal(routes.routes?.length, 0);
      assert.equal(routes.terminal?.[0]?.status, 'completed');

      const notifyLog = join(workdir, '.omx', 'logs', `notify-hook-${new Date().toISOString().split('T')[0]}.jsonl`);
      const entries = await readJsonLines(notifyLog);
      assert.ok(entries.some((entry) => entry.type === 'pending_route_waiting_for_owner'));
      assert.ok(entries.some((entry) => entry.type === 'completed_turn_delivery_allowed' && entry.reason === 'owner_actor_completed'));
      assert.ok(!entries.some((entry) =>
        entry.reason === 'tracked_leader_owner_mismatch_fail_closed'
        || entry.reason === 'indexed_external_owner_mismatch_fail_closed'
      ));
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
      }, { ownerState: false });
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
      }, { ownerState: false });
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
      }, { ownerState: false });
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
      await writeFile(join(workdir, '.omx', 'state', 'subagent-tracking.json'), JSON.stringify({
        schemaVersion: 1,
        sessions: {
          [sessionId]: {
            session_id: sessionId,
            leader_thread_id: 'thread-stale-leader',
            updated_at: new Date().toISOString(),
            threads: {
              [ownerThreadId]: {
                thread_id: ownerThreadId,
                kind: 'subagent',
                first_seen_at: '2026-04-25T00:00:00.000Z',
                last_seen_at: new Date().toISOString(),
                turn_count: 1,
              },
            },
          },
        },
      }, null, 2));

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
        && entry.reason === 'owner_actor_completed'
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
      assert.equal(suppressed?.reason, 'unknown_actor_with_owner');
      assert.ok(Array.isArray(suppressed?.origin_evidence));
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('delivers a replacement root final turn after aborted owner rebinding', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-aborted-owner-rebind-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');
    const stateDir = join(workdir, '.omx', 'state');
    const canonicalSessionId = 'omx-notify-aborted-owner-rebind';
    const firstOwnerNativeSessionId = 'codex-notify-owner-aborted';
    const replacementNativeSessionId = 'codex-notify-owner-replacement';
    const firstOwnerTranscript = join(workdir, 'notify-owner-aborted-rollout.jsonl');
    const replacementTranscript = join(workdir, 'notify-owner-replacement-rollout.jsonl');
    const rawMessage = 'Replacement root completed after the first owner was interrupted.';

    try {
      await mkdir(workdir, { recursive: true });
      await writeNotificationConfig(codexHome);
      await writeSessionStart(workdir, canonicalSessionId);
      await writeTranscriptRecords(firstOwnerTranscript, [
        transcriptSessionMeta(firstOwnerNativeSessionId, workdir),
        transcriptTaskStarted('turn-notify-owner-started'),
      ]);
      await dispatchCodexNativeHook(
        {
          hook_event_name: 'SessionStart',
          cwd: workdir,
          session_id: firstOwnerNativeSessionId,
          transcript_path: firstOwnerTranscript,
        },
        { cwd: workdir, sessionOwnerPid: process.pid },
      );

      await writeTranscriptRecords(firstOwnerTranscript, [
        transcriptSessionMeta(firstOwnerNativeSessionId, workdir),
        transcriptTaskStarted('turn-notify-owner-started'),
        transcriptTurnAborted('turn-notify-owner-started'),
      ]);
      await writeTranscriptRecords(replacementTranscript, [
        transcriptSessionMeta(replacementNativeSessionId, workdir),
        transcriptTaskStarted('turn-notify-replacement-started'),
        transcriptTaskComplete('turn-notify-replacement-started'),
      ]);
      await dispatchCodexNativeHook(
        {
          hook_event_name: 'SessionStart',
          cwd: workdir,
          session_id: replacementNativeSessionId,
          transcript_path: replacementTranscript,
        },
        { cwd: workdir, sessionOwnerPid: process.pid },
      );

      const registry = await readSessionActors(workdir, canonicalSessionId);
      assert.equal(registry.ownerActorId, replacementNativeSessionId);
      assert.equal(registry.actors[firstOwnerNativeSessionId]?.lifecycleStatus, 'superseded');

      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: replacementNativeSessionId,
        thread_id: replacementNativeSessionId,
        turn_id: 'turn-notify-replacement-final',
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

      const persistedSession = JSON.parse(
        await readFile(join(stateDir, 'session.json'), 'utf-8'),
      ) as { session_id?: string; native_session_id?: string };
      assert.equal(persistedSession.session_id, canonicalSessionId);
      assert.equal(persistedSession.native_session_id, replacementNativeSessionId);

      const requests = await readCapturedRequests(capturePath);
      assert.equal(requests.length, 1);
      const body = JSON.parse(requests[0].body) as { event: string; message: string };
      assert.equal(body.event, 'result-ready');
      assert.equal(body.message, rawMessage);

      const notifyLog = join(workdir, '.omx', 'logs', `notify-hook-${new Date().toISOString().split('T')[0]}.jsonl`);
      const entries = await readJsonLines(notifyLog);
      assert.ok(entries.some((entry) =>
        entry.type === 'completed_turn_delivery_allowed'
        && entry.reason === 'owner_actor_completed'
        && entry.actor_id === replacementNativeSessionId
      ));
      assert.equal(
        entries.some((entry) =>
          entry.type === 'completed_turn_delivery_suppressed'
          && entry.reason === 'unknown_actor_with_owner'
          && entry.thread_id === replacementNativeSessionId
        ),
        false,
      );

      const completedRegistry = await readSessionActors(workdir, canonicalSessionId);
      assert.equal(completedRegistry.actors[replacementNativeSessionId]?.lifecycleStatus, 'completed');
      assert.equal(completedRegistry.actors[replacementNativeSessionId]?.claimStrength, 'completion-validated');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('suppresses late completed turns from a superseded owner actor', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-superseded-owner-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');
    const stateDir = join(workdir, '.omx', 'state');
    const sessionId = 'omx-superseded-owner';
    const oldOwnerThreadId = 'thread-superseded-owner';
    const replacementThreadId = 'thread-current-replacement-owner';

    try {
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      await writeNotificationConfig(codexHome);
      await writeFile(
        join(stateDir, 'session.json'),
        JSON.stringify(buildOwnerSessionState(workdir, sessionId, replacementThreadId), null, 2),
      );
      const now = new Date().toISOString();
      await writeFile(join(stateDir, 'sessions', sessionId, 'actors.json'), JSON.stringify({
        schemaVersion: 1,
        sessionId,
        cwd: workdir,
        ownerActorId: replacementThreadId,
        actors: {
          [oldOwnerThreadId]: {
            actorId: oldOwnerThreadId,
            kind: 'leader',
            audience: 'external-owner',
            threadId: oldOwnerThreadId,
            nativeSessionId: oldOwnerThreadId,
            source: 'test-owner',
            firstSeenAt: now,
            lastSeenAt: now,
            lifecycleStatus: 'superseded',
            claimStrength: 'turn-started',
            startedTurnCount: 1,
            abortedTurnCount: 1,
            lastTurnStatus: 'aborted',
            supersededByActorId: replacementThreadId,
            supersededReason: 'owner_rebound_after_aborted_candidate',
          },
          [replacementThreadId]: {
            actorId: replacementThreadId,
            kind: 'leader',
            audience: 'external-owner',
            threadId: replacementThreadId,
            nativeSessionId: replacementThreadId,
            source: 'test-owner',
            firstSeenAt: now,
            lastSeenAt: now,
            lifecycleStatus: 'active',
            claimStrength: 'turn-started',
            startedTurnCount: 1,
            lastTurnStatus: 'started',
          },
        },
        aliases: {
          [oldOwnerThreadId]: oldOwnerThreadId,
          [replacementThreadId]: replacementThreadId,
        },
        updatedAt: now,
      }, null, 2));

      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: oldOwnerThreadId,
        thread_id: oldOwnerThreadId,
        turn_id: 'turn-late-superseded-owner',
        input_messages: [],
        last_assistant_message: 'Late output from the old owner must not notify.',
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
      assert.ok(entries.some((entry) =>
        entry.type === 'completed_turn_delivery_suppressed'
        && entry.reason === 'superseded_owner_actor'
        && entry.actor_id === oldOwnerThreadId
      ));
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('does not completion-validate an owner until completed-turn dispatch succeeds', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-owner-completion-failed-dispatch-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const preloadPath = await writeFetchFailureCapturePreload(tempRoot, 'Dispatch timeout');
    const workdir = join(tempRoot, 'repo');
    const sessionId = 'omx-owner-completion-failed-dispatch';
    const ownerThreadId = 'thread-owner-completion-failed-dispatch';

    try {
      await mkdir(join(workdir, '.omx', 'state'), { recursive: true });
      await writeNotificationConfig(codexHome);
      await writeOwnerSessionState(workdir, sessionId, ownerThreadId);

      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: ownerThreadId,
        thread_id: ownerThreadId,
        turn_id: 'turn-owner-completion-failed-dispatch',
        input_messages: [],
        last_assistant_message: 'This final would be valid, but dispatch fails.',
      }, {
        CODEX_HOME: codexHome,
        HOME: tempRoot,
        USERPROFILE: tempRoot,
        OMX_FETCH_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const registry = await readSessionActors(workdir, sessionId);
      assert.equal(registry.actors[ownerThreadId]?.lifecycleStatus, 'active');
      assert.equal(registry.actors[ownerThreadId]?.claimStrength, 'native-start');
      assert.equal(registry.actors[ownerThreadId]?.completedTurnCount ?? 0, 0);

      const notifyLog = join(workdir, '.omx', 'logs', `notify-hook-${new Date().toISOString().split('T')[0]}.jsonl`);
      const entries = await readJsonLines(notifyLog);
      assert.ok(entries.some((entry) =>
        entry.type === 'completed_turn_delivery_allowed'
        && entry.reason === 'owner_actor_completed'
      ));
      assert.ok(entries.some((entry) => entry.type === 'completed_turn_delivery_failed'));
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('syncs terminal root Ralph state into the active session scope during final owner turns', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-ralph-scope-terminal-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');
    const stateDir = join(workdir, '.omx', 'state');
    const sessionId = 'omx-ralph-terminal-scope';
    const ownerThreadId = 'thread-ralph-terminal-scope';

    try {
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      await writeNotificationConfig(codexHome);
      await writeOwnerSessionState(workdir, sessionId, ownerThreadId);
      await writeFile(join(stateDir, 'ralph-state.json'), JSON.stringify({
        active: false,
        mode: 'ralph',
        current_phase: 'complete',
        completed_at: '2026-04-30T18:00:00.000Z',
        owner_omx_session_id: sessionId,
      }, null, 2));
      await writeFile(join(stateDir, 'sessions', sessionId, 'ralph-state.json'), JSON.stringify({
        active: true,
        mode: 'ralph',
        current_phase: 'starting',
        iteration: 1,
        owner_omx_session_id: sessionId,
      }, null, 2));

      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: ownerThreadId,
        thread_id: ownerThreadId,
        turn_id: 'turn-ralph-terminal-scope',
        input_messages: [],
        last_assistant_message: 'Ralph completed and should not stay active in the session scope.',
      }, {
        CODEX_HOME: codexHome,
        HOME: tempRoot,
        USERPROFILE: tempRoot,
        OMX_FETCH_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const scopedRalph = JSON.parse(
        await readFile(join(stateDir, 'sessions', sessionId, 'ralph-state.json'), 'utf-8'),
      ) as Record<string, unknown>;
      assert.equal(scopedRalph.active, false);
      assert.equal(scopedRalph.current_phase, 'complete');
      assert.equal(scopedRalph.session_scope_reconciled_from, 'root-terminal');

      const notifyLog = join(workdir, '.omx', 'logs', `notify-hook-${new Date().toISOString().split('T')[0]}.jsonl`);
      const entries = await readJsonLines(notifyLog);
      assert.ok(entries.some((entry) => entry.type === 'ralph_session_scope_terminal_reconciled'));
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('does not sync terminal root Ralph state from a different owner session', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-ralph-scope-mismatch-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');
    const stateDir = join(workdir, '.omx', 'state');
    const sessionId = 'omx-ralph-terminal-scope-current';
    const ownerThreadId = 'thread-ralph-terminal-scope-current';

    try {
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      await writeNotificationConfig(codexHome);
      await writeOwnerSessionState(workdir, sessionId, ownerThreadId);
      await writeFile(join(stateDir, 'ralph-state.json'), JSON.stringify({
        active: false,
        mode: 'ralph',
        current_phase: 'complete',
        completed_at: '2026-04-30T18:00:00.000Z',
        owner_omx_session_id: 'omx-different-ralph-owner',
      }, null, 2));
      await writeFile(join(stateDir, 'sessions', sessionId, 'ralph-state.json'), JSON.stringify({
        active: true,
        mode: 'ralph',
        current_phase: 'starting',
        iteration: 1,
        owner_omx_session_id: sessionId,
      }, null, 2));

      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: ownerThreadId,
        thread_id: ownerThreadId,
        turn_id: 'turn-ralph-terminal-scope-mismatch',
        input_messages: [],
        last_assistant_message: 'Ralph completed elsewhere and should not rewrite this session.',
      }, {
        CODEX_HOME: codexHome,
        HOME: tempRoot,
        USERPROFILE: tempRoot,
        OMX_FETCH_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: `--import=${preloadPath}`,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const scopedRalph = JSON.parse(
        await readFile(join(stateDir, 'sessions', sessionId, 'ralph-state.json'), 'utf-8'),
      ) as Record<string, unknown>;
      assert.equal(scopedRalph.active, true);
      assert.equal(scopedRalph.current_phase, 'starting');
      assert.equal(scopedRalph.session_scope_reconciled_from, undefined);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('does not sync terminal root Ralph state when root affinity is missing', async () => {
    const workdir = await mkdtemp(join(tmpdir(), 'omx-notify-hook-ralph-scope-missing-root-affinity-'));
    try {
      const stateDir = join(workdir, '.omx', 'state');
      const sessionId = 'omx-ralph-missing-root-affinity';
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      await writeFile(join(stateDir, 'ralph-state.json'), JSON.stringify({
        active: false,
        mode: 'ralph',
        current_phase: 'complete',
      }, null, 2));
      await writeFile(join(stateDir, 'sessions', sessionId, 'ralph-state.json'), JSON.stringify({
        active: true,
        mode: 'ralph',
        current_phase: 'starting',
        owner_omx_session_id: sessionId,
      }, null, 2));

      const result = await reconcileRalphTerminalStateScope(workdir, sessionId);
      assert.equal(result.reconciled, false);
      assert.equal(result.reason, 'root_ralph_session_affinity_missing');

      const scopedRalph = JSON.parse(
        await readFile(join(stateDir, 'sessions', sessionId, 'ralph-state.json'), 'utf-8'),
      ) as Record<string, unknown>;
      assert.equal(scopedRalph.active, true);
      assert.equal(scopedRalph.current_phase, 'starting');
      assert.equal(scopedRalph.session_scope_reconciled_from, undefined);
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  it('does not sync terminal root Ralph state when session affinity points elsewhere', async () => {
    const workdir = await mkdtemp(join(tmpdir(), 'omx-notify-hook-ralph-scope-session-affinity-mismatch-'));
    try {
      const stateDir = join(workdir, '.omx', 'state');
      const sessionId = 'omx-ralph-session-affinity-current';
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      await writeFile(join(stateDir, 'ralph-state.json'), JSON.stringify({
        active: false,
        mode: 'ralph',
        current_phase: 'complete',
        owner_omx_session_id: sessionId,
      }, null, 2));
      await writeFile(join(stateDir, 'sessions', sessionId, 'ralph-state.json'), JSON.stringify({
        active: true,
        mode: 'ralph',
        current_phase: 'starting',
        owner_omx_session_id: 'omx-other-session',
      }, null, 2));

      const result = await reconcileRalphTerminalStateScope(workdir, sessionId);
      assert.equal(result.reconciled, false);
      assert.equal(result.reason, 'session_ralph_session_affinity_mismatch');

      const scopedRalph = JSON.parse(
        await readFile(join(stateDir, 'sessions', sessionId, 'ralph-state.json'), 'utf-8'),
      ) as Record<string, unknown>;
      assert.equal(scopedRalph.active, true);
      assert.equal(scopedRalph.current_phase, 'starting');
      assert.equal(scopedRalph.session_scope_reconciled_from, undefined);
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  it('rejects unsafe Ralph session ids before building session-scoped paths', async () => {
    const workdir = await mkdtemp(join(tmpdir(), 'omx-notify-hook-ralph-scope-invalid-session-id-'));
    try {
      const stateDir = join(workdir, '.omx', 'state');
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, 'ralph-state.json'), JSON.stringify({
        active: false,
        mode: 'ralph',
        current_phase: 'complete',
        owner_omx_session_id: '../escape',
      }, null, 2));

      const result = await reconcileRalphTerminalStateScope(workdir, '../escape');
      assert.equal(result.reconciled, false);
      assert.equal(result.reason, 'session_id_invalid');
      assert.equal(existsSync(join(workdir, '.omx', 'state', 'escape', 'ralph-state.json')), false);
    } finally {
      await rm(workdir, { recursive: true, force: true });
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
      await writeNotificationConfig(codexHome);
      await writeOwnerSessionState(workdir, ownerSessionId, ownerNativeSessionId);
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
      assert.equal(suppressed?.reason, 'unknown_actor_with_owner');
      assert.ok(
        (suppressed?.origin_evidence as Array<Record<string, unknown>> | undefined)
          ?.some((entry) => entry.source === 'actor-registry' && entry.detail === 'unknown_actor_with_owner'),
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
      await writeNotificationConfig(codexHome);
      await writeOwnerSessionState(workdir, ownerSessionId, ownerNativeSessionId);

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
      assert.equal(suppressed?.reason, 'unknown_actor_with_owner');
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
      assert.equal(suppressed?.reason, 'non_owner_actor');
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
      await writeNotificationConfig(codexHome);
      await writeOwnerSessionState(workdir, ownerSessionId, 'thread-current-owner-index');
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
      assert.equal(suppressed?.reason, 'unknown_actor_with_owner');
      assert.ok(!String(JSON.stringify(suppressed?.origin_evidence ?? [])).includes('codex-session-origin-index'));
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('does not let a quarantined concurrent root actor suppress the original owner final', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-notify-hook-concurrent-root-quarantined-'));
    const codexHome = join(tempRoot, 'codex-home');
    const capturePath = join(tempRoot, 'captures.ndjson');
    const preloadPath = await writeFetchCapturePreload(tempRoot);
    const workdir = join(tempRoot, 'repo');
    const sessionId = 'sess-original-owner-route';
    const ownerThreadId = 'thread-original-owner-route';
    const rawMessage = 'Original owner completed successfully after a concurrent background root was quarantined.';

    try {
      await writeNotificationConfig(codexHome);
      await writeOwnerSessionState(workdir, sessionId, ownerThreadId);
      const actorsPath = join(workdir, '.omx', 'state', 'sessions', sessionId, 'actors.json');
      const actors = JSON.parse(await readFile(actorsPath, 'utf-8')) as Record<string, any>;
      actors.actors['thread-background-root'] = {
        actorId: 'thread-background-root',
        kind: 'unknown',
        audience: 'unknown-non-owner',
        threadId: 'thread-background-root',
        nativeSessionId: 'thread-background-root',
        source: 'native-session-start',
        firstSeenAt: '2026-04-30T00:00:00.000Z',
        lastSeenAt: '2026-04-30T00:00:00.000Z',
        quarantined: true,
        quarantineReason: 'external_owner_mismatch_with_active_owner',
      };
      actors.aliases['thread-background-root'] = 'thread-background-root';
      await writeFile(actorsPath, JSON.stringify(actors, null, 2));

      const result = runNotifyHook({
        cwd: workdir,
        type: 'agent-turn-complete',
        session_id: ownerThreadId,
        thread_id: ownerThreadId,
        turn_id: 'turn-original-owner-after-quarantine',
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
      }, { ownerState: false });
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
