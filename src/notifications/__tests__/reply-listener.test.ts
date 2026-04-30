import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type spawnSync } from 'node:child_process';
import { request as httpsRequest } from 'node:https';
import type { ClientRequestArgs, IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  RateLimiter,
  buildInjectedReplyInput,
  captureReplyAcknowledgementSummary,
  formatReplyAcknowledgement,
  redactSensitiveTokens,
  reconcileSourceRateLimiters,
  resetStartupPoliciesForDaemonStart,
  sanitizeReplyInput,
  isReplyListenerProcess,
  normalizeReplyListenerConfig,
  pollDiscordOnce,
  pollTelegramOnce,
  refreshReplyListenerRuntimeConfig,
  resetReplyListenerTransientState,
  startReplyListener,
} from '../reply-listener.js';
import type { ReplyListenerDaemonConfig, ReplyListenerRateLimiter, ReplyListenerState } from '../reply-listener.js';
import type { SessionMapping } from '../session-registry.js';
import { NO_TRACKED_SESSION_MESSAGE } from '../session-status.js';
import { buildDiscordReplySource, buildTelegramReplySource } from '../reply-source.js';
import { consumePendingReplyOrigin } from '../reply-origin-state.js';
import { pendingRoutesStatePath } from '../pending-routes.js';
import { markMockTelegramTransportForTests } from '../../utils/test-env.js';
import { OMX_ENTRY_PATH_ENV, OMX_STARTUP_CWD_ENV } from '../../utils/paths.js';

function createBaseConfig(overrides: Partial<ReplyListenerDaemonConfig> = {}): ReplyListenerDaemonConfig {
  return {
    enabled: true,
    pollIntervalMs: 3000,
    maxMessageLength: 500,
    rateLimitPerMinute: 10,
    includePrefix: true,
    ackMode: 'minimal',
    authorizedDiscordUserIds: ['discord-user-1'],
    authorizedTelegramUserIds: ['telegram-user-1'],
    telegramPollTimeoutSeconds: 30,
    telegramAllowedUpdates: ['message'],
    telegramStartupBacklogPolicy: 'resume',
    discordEnabled: true,
    discordBotToken: 'discord-token',
    discordChannelId: 'discord-channel',
    telegramEnabled: true,
    telegramBotToken: '123456:telegram-token',
    telegramChatId: '777',
    ...overrides,
  };
}

function createBaseState(): ReplyListenerState {
  return {
    isRunning: true,
    pid: 123,
    startedAt: '2026-03-20T00:00:00.000Z',
    lastPollAt: null,
    telegramLastUpdateId: null,
    discordLastMessageId: null,
    telegramStartupPolicyApplied: false,
    sourceStates: {},
    messagesInjected: 0,
    errors: 0,
  };
}

function cloneState(state: ReplyListenerState): ReplyListenerState {
  return JSON.parse(JSON.stringify(state)) as ReplyListenerState;
}

async function findSavedAttachmentPath(root: string, fileName: string): Promise<string> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      try {
        return await findSavedAttachmentPath(fullPath, fileName);
      } catch (error) {
        if (!(error instanceof Error && error.message.includes('not found'))) {
          throw error;
        }
      }
    } else if (entry.isFile() && entry.name === fileName) {
      return fullPath;
    }
  }
  throw new Error(`Saved attachment ${fileName} not found under ${root}`);
}

async function importReplyListenerFresh() {
  const moduleUrl = new URL('../reply-listener.js', import.meta.url);
  moduleUrl.searchParams.set('t', `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  return import(moduleUrl.href);
}

function createMapping(platform: SessionMapping['platform']): SessionMapping {
  return {
    platform,
    messageId: platform === 'discord-bot' ? 'orig-discord-msg' : '222',
    source: platform === 'discord-bot'
      ? buildDiscordReplySource('discord-token', 'discord-channel')
      : buildTelegramReplySource('123456:telegram-token', '777'),
    sessionId: 'session-1',
    tmuxPaneId: '%9',
    tmuxSessionName: 'omx-session',
    event: 'session-idle',
    createdAt: '2026-03-20T00:00:00.000Z',
    projectPath: '/tmp/project',
    projectKey: platform === 'telegram' ? 'project-key-1' : undefined,
    messageThreadId: platform === 'telegram' ? '9001' : undefined,
    topicName: platform === 'telegram' ? 'project-a' : undefined,
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return new Response(JSON.stringify(body), { ...init, headers });
}

type HttpsRouteHandler = (body: string, options: ClientRequestArgs) => {
  statusCode: number;
  body?: unknown;
};

function createHttpsRequestMock(routes: Record<string, HttpsRouteHandler>): typeof import('node:https').request {
  return markMockTelegramTransportForTests(((options: ClientRequestArgs, callback?: (res: IncomingMessage) => void) => {
    const listeners = new Map<string, Array<(value?: unknown) => void>>();
    let requestBody = '';

    const emit = (event: string, value?: unknown) => {
      for (const handler of listeners.get(event) ?? []) {
        handler(value);
      }
    };

    const request = {
      on(event: string, handler: (value?: unknown) => void) {
        listeners.set(event, [...(listeners.get(event) ?? []), handler]);
        return request;
      },
      write(chunk: string | Buffer) {
        requestBody += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : chunk;
        return true;
      },
      end() {
        queueMicrotask(() => {
          try {
            const key = `${options.method ?? 'GET'} ${options.path ?? ''}`;
            const route = routes[key];
            assert.ok(route, `Unexpected https request: ${key}`);
            const result = route(requestBody, options);
            const response = new PassThrough() as PassThrough & IncomingMessage;
            (response as { statusCode?: number }).statusCode = result.statusCode;
            callback?.(response);
            if (result.body !== undefined) {
              response.write(
                typeof result.body === 'string'
                  ? result.body
                  : JSON.stringify(result.body),
              );
            }
            response.end();
          } catch (error) {
            emit('error', error);
          }
        });
        return request;
      },
      destroy() {
        return request;
      },
    };

    return request;
  }) as typeof import('node:https').request);
}

describe('sanitizeReplyInput', () => {
  it('passes through normal text', () => {
    assert.equal(sanitizeReplyInput('hello world'), 'hello world');
  });

  it('strips control characters', () => {
    assert.equal(sanitizeReplyInput('hello\x00world'), 'helloworld');
    assert.equal(sanitizeReplyInput('test\x07bell'), 'testbell');
    assert.equal(sanitizeReplyInput('test\x1bescseq'), 'testescseq');
  });

  it('replaces newlines with spaces', () => {
    assert.equal(sanitizeReplyInput('line1\nline2'), 'line1 line2');
    assert.equal(sanitizeReplyInput('line1\r\nline2'), 'line1 line2');
  });

  it('escapes backslashes', () => {
    assert.equal(sanitizeReplyInput('path\\to\\file'), 'path\\\\to\\\\file');
  });

  it('escapes backticks', () => {
    assert.equal(sanitizeReplyInput('run `cmd`'), 'run \\`cmd\\`');
  });

  it('escapes $( command substitution', () => {
    assert.equal(sanitizeReplyInput('$(whoami)'), '\\$(whoami)');
  });

  it('escapes ${ variable expansion', () => {
    assert.equal(sanitizeReplyInput('${HOME}'), '\\${HOME}');
  });

  it('trims whitespace', () => {
    assert.equal(sanitizeReplyInput('  hello  '), 'hello');
  });

  it('handles empty string', () => {
    assert.equal(sanitizeReplyInput(''), '');
  });

  it('handles whitespace-only string', () => {
    assert.equal(sanitizeReplyInput('   '), '');
  });

  it('handles combined dangerous patterns', () => {
    const input = '$(rm -rf /) && `evil` ${PATH}\nmore';
    const result = sanitizeReplyInput(input);
    assert.ok(!result.includes('\n'));
    assert.ok(result.includes('\\$('));
    assert.ok(result.includes('\\${'));
    assert.ok(result.includes('\\`'));
  });

  it('preserves normal special characters', () => {
    assert.equal(sanitizeReplyInput('hello! @user #tag'), 'hello! @user #tag');
  });

  it('handles unicode text', () => {
    const result = sanitizeReplyInput('Hello world');
    assert.ok(result.length > 0);
  });
});

describe('isReplyListenerProcess', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  });

  it('returns false for the current process (test runner has no daemon marker)', () => {
    assert.equal(isReplyListenerProcess(process.pid), false);
  });

  it('returns false on native Windows instead of shelling out to ps', (_, done) => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const child = spawn(
      process.execPath,
      ['-e', 'const pollLoop = () => {}; setInterval(pollLoop, 60000);'],
      { stdio: 'ignore' },
    );
    child.once('spawn', () => {
      const pid = child.pid!;
      const result = isReplyListenerProcess(pid);
      child.kill();
      assert.equal(result, false);
      done();
    });
    child.once('error', (err) => {
      done(err);
    });
  });

  it('returns true for a process whose command line contains the daemon marker', (_, done) => {
    const child = spawn(
      process.execPath,
      ['-e', 'const pollLoop = () => {}; setInterval(pollLoop, 60000);'],
      { stdio: 'ignore' },
    );
    child.once('spawn', () => {
      const pid = child.pid!;
      const result = isReplyListenerProcess(pid);
      child.kill();
      assert.equal(result, true);
      done();
    });
    child.once('error', (err) => {
      done(err);
    });
  });

  it('returns false for a process whose command line lacks the daemon marker', (_, done) => {
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 60000);'],
      { stdio: 'ignore' },
    );
    child.once('spawn', () => {
      const pid = child.pid!;
      const result = isReplyListenerProcess(pid);
      child.kill();
      assert.equal(result, false);
      done();
    });
    child.once('error', (err) => {
      done(err);
    });
  });

  it('returns false for a non-existent PID', () => {
    assert.equal(isReplyListenerProcess(0), false);
  });

  it('returns false on Windows when ps is unavailable', () => {
    const result = isReplyListenerProcess(123, {
      platform: 'win32',
      env: {
        PATH: '',
        PATHEXT: '.EXE;.CMD;.PS1',
      },
      spawnImpl: ((() => ({
        pid: 0,
        output: [null, '', ''],
        stdout: '',
        stderr: '',
        status: null,
        signal: null,
        error: Object.assign(new Error('spawnSync ps ENOENT'), { code: 'ENOENT' }),
      })) as unknown) as typeof spawnSync,
    });

    assert.equal(result, false);
  });
});

describe('normalizeReplyListenerConfig', () => {
  it('clamps invalid runtime numeric values and sanitizes authorized users', () => {
    const normalized = normalizeReplyListenerConfig({
      enabled: true,
      pollIntervalMs: 0,
      maxMessageLength: -10,
      rateLimitPerMinute: -1,
      includePrefix: false,
      ackMode: 'summary',
      authorizedDiscordUserIds: ['123', '', '  ', '456'],
      authorizedTelegramUserIds: ['4001', '', '  ', '4002'],
      telegramPollTimeoutSeconds: 0,
      telegramAllowedUpdates: ['message', '', 'edited_message'],
      telegramStartupBacklogPolicy: 'drop_pending',
      discordEnabled: true,
      discordBotToken: 'bot-token',
      discordChannelId: 'channel-id',
    });

    assert.equal(normalized.pollIntervalMs, 500);
    assert.equal(normalized.maxMessageLength, 1);
    assert.equal(normalized.rateLimitPerMinute, 1);
    assert.equal(normalized.includePrefix, false);
    assert.equal(normalized.ackMode, 'summary');
    assert.deepEqual(normalized.authorizedDiscordUserIds, ['123', '456']);
    assert.deepEqual(normalized.authorizedTelegramUserIds, ['4001', '4002']);
    assert.equal(normalized.telegramPollTimeoutSeconds, 1);
    assert.deepEqual(normalized.telegramAllowedUpdates, ['message', 'edited_message']);
    assert.equal(normalized.telegramStartupBacklogPolicy, 'drop_pending');
  });

  it('infers enabled flags from credentials when omitted', () => {
    const normalized = normalizeReplyListenerConfig({
      enabled: true,
      pollIntervalMs: 3000,
      maxMessageLength: 500,
      rateLimitPerMinute: 10,
      includePrefix: true,
      ackMode: 'minimal',
      authorizedDiscordUserIds: [],
      authorizedTelegramUserIds: [],
      telegramPollTimeoutSeconds: 30,
      telegramAllowedUpdates: ['message'],
      telegramStartupBacklogPolicy: 'resume',
      telegramBotToken: 'tg-token',
      telegramChatId: 'tg-chat',
    });

    assert.equal(normalized.telegramEnabled, true);
    assert.equal(normalized.discordEnabled, false);
  });
});

describe('refreshReplyListenerRuntimeConfig', () => {
  it('reloads persisted runtime config without resetting the limiter when the rate is unchanged', () => {
    const currentConfig = createBaseConfig({ pollIntervalMs: 3000, rateLimitPerMinute: 10 });
    const currentRateLimiter = { canProceed: () => true, reset: () => {} };

    const refreshed = refreshReplyListenerRuntimeConfig(
      currentConfig,
      currentRateLimiter,
      {
        readDaemonConfigImpl: () => ({
          ...currentConfig,
          pollIntervalMs: 5000,
        }),
      },
    );

    assert.equal(refreshed.config.pollIntervalMs, 5000);
    assert.equal(refreshed.config.rateLimitPerMinute, 10);
    assert.equal(refreshed.rateLimiter, currentRateLimiter);
  });

  it('rebuilds the limiter when the persisted rate limit changes', () => {
    const currentConfig = createBaseConfig({ rateLimitPerMinute: 10 });
    const currentRateLimiter = { canProceed: () => true, reset: () => {} };

    const refreshed = refreshReplyListenerRuntimeConfig(
      currentConfig,
      currentRateLimiter,
      {
        readDaemonConfigImpl: () => ({
          ...currentConfig,
          rateLimitPerMinute: 2,
        }),
      },
    );

    assert.equal(refreshed.config.rateLimitPerMinute, 2);
    assert.notEqual(refreshed.rateLimiter, currentRateLimiter);
  });

  it('requests daemon shutdown when refreshed config disables every reply platform', () => {
    const currentConfig = createBaseConfig();
    const currentRateLimiter = { canProceed: () => true, reset: () => {} };

    const refreshed = refreshReplyListenerRuntimeConfig(
      currentConfig,
      currentRateLimiter,
      {
        readDaemonConfigImpl: () => ({
          ...currentConfig,
          telegramEnabled: false,
          telegramBotToken: undefined,
          telegramChatId: undefined,
          discordEnabled: false,
          discordBotToken: undefined,
          discordChannelId: undefined,
        }),
      },
    );

    assert.equal(refreshed.shouldStopDaemon, true);
  });
});

describe('reconcileSourceRateLimiters', () => {
  it('allocates independent rate limiters per active source and preserves unaffected entries', () => {
    const config = createBaseConfig();
    const initial = reconcileSourceRateLimiters(config, new Map());
    const discordSourceKey = buildDiscordReplySource('discord-token', 'discord-channel').key;
    const telegramSourceKey = buildTelegramReplySource('123456:telegram-token', '777').key;

    const discordLimiter = initial.get(discordSourceKey);
    const telegramLimiter = initial.get(telegramSourceKey);
    assert.ok(discordLimiter);
    assert.ok(telegramLimiter);
    assert.notEqual(discordLimiter, telegramLimiter);

    const rotatedTelegramConfig = createBaseConfig({
      telegramBotToken: '123456:new-telegram-token',
      telegramChatId: '999',
    });
    const refreshed = reconcileSourceRateLimiters(rotatedTelegramConfig, initial, config);
    const rotatedTelegramSourceKey = buildTelegramReplySource('123456:new-telegram-token', '999').key;

    assert.equal(refreshed.get(discordSourceKey), discordLimiter);
    assert.ok(refreshed.get(rotatedTelegramSourceKey));
    assert.notEqual(refreshed.get(rotatedTelegramSourceKey), telegramLimiter);
    assert.equal(refreshed.has(telegramSourceKey), false);
  });
});

describe('resetStartupPoliciesForDaemonStart', () => {
  it('clears persisted startup-policy flags across daemon restarts while preserving cursors', () => {
    const telegramSource = buildTelegramReplySource('123456:telegram-token', '777');
    const originalState: ReplyListenerState = {
      ...createBaseState(),
      telegramLastUpdateId: 88,
      telegramStartupPolicyApplied: true,
      sourceStates: {
        [telegramSource.key]: {
          sourceKey: telegramSource.key,
          platform: 'telegram',
          label: telegramSource.label,
          telegramLastUpdateId: 88,
          telegramStartupPolicyApplied: true,
          lastPollAt: null,
          lastIngestAt: null,
          lastFailureAt: null,
          lastFailureCategory: null,
          lastFailureMessage: null,
          failureCounts: {},
        },
      },
    };

    const reset = resetStartupPoliciesForDaemonStart(originalState);

    assert.equal(reset.telegramLastUpdateId, 88);
    assert.equal(reset.telegramStartupPolicyApplied, false);
    assert.equal(reset.sourceStates[telegramSource.key]?.telegramLastUpdateId, 88);
    assert.equal(reset.sourceStates[telegramSource.key]?.telegramStartupPolicyApplied, false);
  });
});

describe('startReplyListener', () => {
  it('refreshes a running daemon config and preserves unaffected source cursors when only one source changes', () => {
    const previousConfig = createBaseConfig({
      telegramBotToken: '123456:old-telegram-token',
      telegramChatId: 'old-chat',
    });
    const nextConfig = createBaseConfig({
      telegramBotToken: '123456:new-telegram-token',
      telegramChatId: 'new-chat',
    });
    const oldTelegramSource = buildTelegramReplySource('123456:old-telegram-token', 'old-chat');
    const discordSource = buildDiscordReplySource('discord-token', 'discord-channel');
    const newTelegramSource = buildTelegramReplySource('123456:new-telegram-token', 'new-chat');
    const state: ReplyListenerState = {
      ...createBaseState(),
      telegramLastUpdateId: 44,
      discordLastMessageId: 'discord-message-44',
      sourceStates: {
        [oldTelegramSource.key]: {
          sourceKey: oldTelegramSource.key,
          platform: 'telegram',
          label: oldTelegramSource.label,
          telegramLastUpdateId: 44,
          telegramStartupPolicyApplied: true,
          lastPollAt: null,
          lastIngestAt: null,
        },
        [discordSource.key]: {
          sourceKey: discordSource.key,
          platform: 'discord-bot',
          label: discordSource.label,
          discordLastMessageId: 'discord-message-44',
          telegramStartupPolicyApplied: false,
          lastPollAt: null,
          lastIngestAt: null,
        },
      },
    };

    let writtenConfig: ReplyListenerDaemonConfig | null = null;
    let writtenState: ReplyListenerState | null = null;

    const response = startReplyListener(nextConfig, {
      ensureStateDirImpl: () => {},
      isDaemonRunningImpl: () => true,
      readDaemonConfigImpl: () => previousConfig,
      readDaemonStateImpl: () => state,
      writeDaemonConfigImpl: (config) => {
        writtenConfig = config;
      },
      writeDaemonStateImpl: (nextState) => {
        writtenState = nextState;
      },
    });

    assert.equal(response.success, true);
    assert.match(response.message, /config refreshed/);
    assert.ok(writtenConfig);
    assert.ok(writtenState);
    const persistedConfig = writtenConfig as ReplyListenerDaemonConfig;
    const persistedState = writtenState as ReplyListenerState;
    assert.equal(persistedConfig.telegramChatId, 'new-chat');
    assert.equal(persistedState.telegramLastUpdateId, null);
    assert.equal(persistedState.discordLastMessageId, 'discord-message-44');
    assert.equal(persistedState.sourceStates[discordSource.key]?.discordLastMessageId, 'discord-message-44');
    assert.equal(persistedState.sourceStates[newTelegramSource.key]?.telegramLastUpdateId ?? null, null);
    assert.equal(persistedState.sourceStates[oldTelegramSource.key]?.telegramLastUpdateId, 44);
    assert.equal(response.state?.telegramLastUpdateId, null);
    assert.equal(response.state?.discordLastMessageId, 'discord-message-44');
  });

  it('preserves prior source cursors across a stopped-daemon restart before the new daemon boots', () => {
    const previousConfig = createBaseConfig();
    const telegramSource = buildTelegramReplySource(
      previousConfig.telegramBotToken!,
      previousConfig.telegramChatId!,
    );
    const discordSource = buildDiscordReplySource(
      previousConfig.discordBotToken!,
      previousConfig.discordChannelId!,
    );
    const previousState: ReplyListenerState = {
      ...createBaseState(),
      telegramLastUpdateId: 91,
      discordLastMessageId: 'discord-message-91',
      sourceStates: {
        [telegramSource.key]: {
          sourceKey: telegramSource.key,
          platform: 'telegram',
          label: telegramSource.label,
          telegramLastUpdateId: 91,
          telegramStartupPolicyApplied: true,
          lastPollAt: null,
          lastIngestAt: null,
          lastFailureAt: null,
          lastFailureCategory: null,
          lastFailureMessage: null,
          failureCounts: {},
        },
        [discordSource.key]: {
          sourceKey: discordSource.key,
          platform: 'discord-bot',
          label: discordSource.label,
          discordLastMessageId: 'discord-message-91',
          telegramStartupPolicyApplied: false,
          lastPollAt: null,
          lastIngestAt: null,
          lastFailureAt: null,
          lastFailureCategory: null,
          lastFailureMessage: null,
          failureCounts: {},
        },
      },
    };

    let writtenState: ReplyListenerState | null = null;

    const response = startReplyListener(createBaseConfig(), {
      ensureStateDirImpl: () => {},
      isDaemonRunningImpl: () => false,
      isTmuxAvailableImpl: () => true,
      readDaemonConfigImpl: () => previousConfig,
      readDaemonStateImpl: () => previousState,
      spawnImpl: (() => ({ pid: 43210, unref() {} })) as unknown as typeof import('node:child_process').spawn,
      writeDaemonConfigImpl: () => {},
      writeDaemonStateImpl: (nextState) => {
        writtenState = cloneState(nextState);
      },
      writePidFileImpl: () => {},
      logImpl: () => {},
    });

    assert.equal(response.success, true);
    assert.ok(writtenState);
    const persisted = writtenState as ReplyListenerState;
    assert.equal(persisted.telegramLastUpdateId, 91);
    assert.equal(persisted.discordLastMessageId, 'discord-message-91');
    assert.equal(persisted.sourceStates[telegramSource.key]?.telegramLastUpdateId, 91);
    assert.equal(persisted.sourceStates[discordSource.key]?.discordLastMessageId, 'discord-message-91');
  });

  it('forwards canonical config and stable launcher context into the detached daemon environment', () => {
    const originalNotifyProfile = process.env.OMX_NOTIFY_PROFILE;
    const originalCodexHome = process.env.CODEX_HOME;
    const originalEntryPath = process.env[OMX_ENTRY_PATH_ENV];
    const originalStartupCwd = process.env[OMX_STARTUP_CWD_ENV];
    let spawnedEnv: NodeJS.ProcessEnv | undefined;

    try {
      process.env.OMX_NOTIFY_PROFILE = 'ops';
      process.env.CODEX_HOME = '/tmp/custom-codex-home';
      process.env[OMX_ENTRY_PATH_ENV] = '/tmp/codex-native-hook.js';
      delete process.env[OMX_STARTUP_CWD_ENV];

      const response = startReplyListener(createBaseConfig(), {
        ensureStateDirImpl: () => {},
        isDaemonRunningImpl: () => false,
        isTmuxAvailableImpl: () => true,
        spawnImpl: ((command: string, args: string[], options?: import('node:child_process').SpawnOptions) => {
          assert.equal(command, 'node');
          assert.ok(Array.isArray(args));
          spawnedEnv = options?.env;
          return { pid: 54321, unref() {} } as unknown as ReturnType<typeof import('node:child_process').spawn>;
        }) as typeof import('node:child_process').spawn,
        writeDaemonConfigImpl: () => {},
        writeDaemonStateImpl: () => {},
        writePidFileImpl: () => {},
        logImpl: () => {},
      });

      assert.equal(response.success, true);
      assert.equal(spawnedEnv?.OMX_NOTIFY_PROFILE, 'ops');
      assert.equal(spawnedEnv?.CODEX_HOME, '/tmp/custom-codex-home');
      assert.match(spawnedEnv?.[OMX_ENTRY_PATH_ENV] ?? '', /dist\/cli\/omx\.js$/);
      assert.notEqual(spawnedEnv?.[OMX_ENTRY_PATH_ENV], '/tmp/codex-native-hook.js');
      assert.equal(spawnedEnv?.[OMX_STARTUP_CWD_ENV], process.cwd());
    } finally {
      if (typeof originalNotifyProfile === 'string') process.env.OMX_NOTIFY_PROFILE = originalNotifyProfile;
      else delete process.env.OMX_NOTIFY_PROFILE;
      if (typeof originalCodexHome === 'string') process.env.CODEX_HOME = originalCodexHome;
      else delete process.env.CODEX_HOME;
      if (typeof originalEntryPath === 'string') process.env[OMX_ENTRY_PATH_ENV] = originalEntryPath;
      else delete process.env[OMX_ENTRY_PATH_ENV];
      if (typeof originalStartupCwd === 'string') process.env[OMX_STARTUP_CWD_ENV] = originalStartupCwd;
      else delete process.env[OMX_STARTUP_CWD_ENV];
    }
  });

  it('narrows active source mirrors without discarding historical source state on refresh', () => {
    const previousConfig = createBaseConfig();
    const nextConfig = createBaseConfig({
      telegramEnabled: false,
      telegramBotToken: undefined,
      telegramChatId: undefined,
    });
    const telegramSource = buildTelegramReplySource(
      previousConfig.telegramBotToken!,
      previousConfig.telegramChatId!,
    );
    const discordSource = buildDiscordReplySource(
      previousConfig.discordBotToken!,
      previousConfig.discordChannelId!,
    );
    const state: ReplyListenerState = {
      ...createBaseState(),
      telegramLastUpdateId: 55,
      discordLastMessageId: 'discord-message-55',
      sourceStates: {
        [telegramSource.key]: {
          sourceKey: telegramSource.key,
          platform: 'telegram',
          label: telegramSource.label,
          telegramLastUpdateId: 55,
          telegramStartupPolicyApplied: true,
          lastPollAt: null,
          lastIngestAt: null,
          lastFailureAt: null,
          lastFailureCategory: null,
          lastFailureMessage: null,
          failureCounts: {},
        },
        [discordSource.key]: {
          sourceKey: discordSource.key,
          platform: 'discord-bot',
          label: discordSource.label,
          discordLastMessageId: 'discord-message-55',
          telegramStartupPolicyApplied: false,
          lastPollAt: null,
          lastIngestAt: null,
          lastFailureAt: null,
          lastFailureCategory: null,
          lastFailureMessage: null,
          failureCounts: {},
        },
      },
    };

    let writtenState: ReplyListenerState | null = null;
    const response = startReplyListener(nextConfig, {
      ensureStateDirImpl: () => {},
      isDaemonRunningImpl: () => true,
      readDaemonConfigImpl: () => previousConfig,
      readDaemonStateImpl: () => state,
      writeDaemonConfigImpl: () => {},
      writeDaemonStateImpl: (nextState) => {
        writtenState = cloneState(nextState);
      },
    });

    assert.equal(response.success, true);
    assert.ok(writtenState);
    const persisted = writtenState as ReplyListenerState;
    assert.equal(persisted.telegramLastUpdateId, null);
    assert.equal(persisted.discordLastMessageId, 'discord-message-55');
    assert.deepEqual(Object.keys(persisted.sourceStates).sort(), [discordSource.key, telegramSource.key].sort());
    assert.equal(persisted.sourceStates[discordSource.key]?.discordLastMessageId, 'discord-message-55');
    assert.equal(persisted.sourceStates[telegramSource.key]?.telegramLastUpdateId, 55);
  });
});

describe('filesystem-backed daemon config persistence', () => {
  it('avoids persisting fallback reply-listener secrets when canonical env config can re-derive them', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'omx-reply-listener-config-env-'));
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const originalDiscordToken = process.env.OMX_DISCORD_NOTIFIER_BOT_TOKEN;
    const originalDiscordChannel = process.env.OMX_DISCORD_NOTIFIER_CHANNEL;
    const originalTelegramToken = process.env.OMX_TELEGRAM_BOT_TOKEN;
    const originalTelegramChatId = process.env.OMX_TELEGRAM_CHAT_ID;
    const originalReplyEnabled = process.env.OMX_REPLY_ENABLED;

    try {
      process.env.HOME = homeDir;
      process.env.USERPROFILE = homeDir;
      process.env.OMX_DISCORD_NOTIFIER_BOT_TOKEN = 'discord-token';
      process.env.OMX_DISCORD_NOTIFIER_CHANNEL = 'discord-channel';
      process.env.OMX_TELEGRAM_BOT_TOKEN = '123456:telegram-token';
      process.env.OMX_TELEGRAM_CHAT_ID = '777';
      process.env.OMX_REPLY_ENABLED = 'true';

      const mod = await importReplyListenerFresh();
      const response = mod.startReplyListener(createBaseConfig(), {
        ensureStateDirImpl: () => {},
        isDaemonRunningImpl: () => false,
        isTmuxAvailableImpl: () => true,
        spawnImpl: (() => ({ pid: 43210, unref() {} })) as unknown as typeof import('node:child_process').spawn,
        writePidFileImpl: () => {},
        logImpl: () => {},
      });

      assert.equal(response.success, true);

      const stateDir = join(homeDir, '.omx', 'state');
      const publicConfig = JSON.parse(
        await readFile(join(stateDir, 'reply-listener-config.json'), 'utf-8'),
      ) as Record<string, unknown>;
      assert.equal(publicConfig.telegramBotToken, undefined);
      assert.equal(publicConfig.discordBotToken, undefined);
      assert.equal(existsSync(join(stateDir, 'reply-listener-secrets.json')), false);
    } finally {
      if (typeof originalHome === 'string') process.env.HOME = originalHome;
      else delete process.env.HOME;
      if (typeof originalUserProfile === 'string') process.env.USERPROFILE = originalUserProfile;
      else delete process.env.USERPROFILE;
      if (typeof originalDiscordToken === 'string') process.env.OMX_DISCORD_NOTIFIER_BOT_TOKEN = originalDiscordToken;
      else delete process.env.OMX_DISCORD_NOTIFIER_BOT_TOKEN;
      if (typeof originalDiscordChannel === 'string') process.env.OMX_DISCORD_NOTIFIER_CHANNEL = originalDiscordChannel;
      else delete process.env.OMX_DISCORD_NOTIFIER_CHANNEL;
      if (typeof originalTelegramToken === 'string') process.env.OMX_TELEGRAM_BOT_TOKEN = originalTelegramToken;
      else delete process.env.OMX_TELEGRAM_BOT_TOKEN;
      if (typeof originalTelegramChatId === 'string') process.env.OMX_TELEGRAM_CHAT_ID = originalTelegramChatId;
      else delete process.env.OMX_TELEGRAM_CHAT_ID;
      if (typeof originalReplyEnabled === 'string') process.env.OMX_REPLY_ENABLED = originalReplyEnabled;
      else delete process.env.OMX_REPLY_ENABLED;
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('keeps a fallback secret file when canonical config cannot re-derive the active bot tokens', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'omx-reply-listener-config-secret-'));
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const originalDiscordToken = process.env.OMX_DISCORD_NOTIFIER_BOT_TOKEN;
    const originalDiscordChannel = process.env.OMX_DISCORD_NOTIFIER_CHANNEL;
    const originalTelegramToken = process.env.OMX_TELEGRAM_BOT_TOKEN;
    const originalTelegramChatId = process.env.OMX_TELEGRAM_CHAT_ID;
    const originalReplyEnabled = process.env.OMX_REPLY_ENABLED;

    try {
      process.env.HOME = homeDir;
      process.env.USERPROFILE = homeDir;
      delete process.env.OMX_DISCORD_NOTIFIER_BOT_TOKEN;
      delete process.env.OMX_DISCORD_NOTIFIER_CHANNEL;
      delete process.env.OMX_TELEGRAM_BOT_TOKEN;
      delete process.env.OMX_TELEGRAM_CHAT_ID;
      process.env.OMX_REPLY_ENABLED = 'true';

      const mod = await importReplyListenerFresh();
      const response = mod.startReplyListener(createBaseConfig(), {
        ensureStateDirImpl: () => {},
        isDaemonRunningImpl: () => false,
        isTmuxAvailableImpl: () => true,
        spawnImpl: (() => ({ pid: 54321, unref() {} })) as unknown as typeof import('node:child_process').spawn,
        writePidFileImpl: () => {},
        logImpl: () => {},
      });

      assert.equal(response.success, true);

      const stateDir = join(homeDir, '.omx', 'state');
      const secretConfig = JSON.parse(
        await readFile(join(stateDir, 'reply-listener-secrets.json'), 'utf-8'),
      ) as Record<string, unknown>;
      assert.equal(secretConfig.telegramBotToken, '123456:telegram-token');
      assert.equal(secretConfig.discordBotToken, 'discord-token');
    } finally {
      if (typeof originalHome === 'string') process.env.HOME = originalHome;
      else delete process.env.HOME;
      if (typeof originalUserProfile === 'string') process.env.USERPROFILE = originalUserProfile;
      else delete process.env.USERPROFILE;
      if (typeof originalDiscordToken === 'string') process.env.OMX_DISCORD_NOTIFIER_BOT_TOKEN = originalDiscordToken;
      else delete process.env.OMX_DISCORD_NOTIFIER_BOT_TOKEN;
      if (typeof originalDiscordChannel === 'string') process.env.OMX_DISCORD_NOTIFIER_CHANNEL = originalDiscordChannel;
      else delete process.env.OMX_DISCORD_NOTIFIER_CHANNEL;
      if (typeof originalTelegramToken === 'string') process.env.OMX_TELEGRAM_BOT_TOKEN = originalTelegramToken;
      else delete process.env.OMX_TELEGRAM_BOT_TOKEN;
      if (typeof originalTelegramChatId === 'string') process.env.OMX_TELEGRAM_CHAT_ID = originalTelegramChatId;
      else delete process.env.OMX_TELEGRAM_CHAT_ID;
      if (typeof originalReplyEnabled === 'string') process.env.OMX_REPLY_ENABLED = originalReplyEnabled;
      else delete process.env.OMX_REPLY_ENABLED;
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('reports source-aware diagnostics and secret storage mode in reply-listener status', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'omx-reply-listener-status-'));
    const stateDir = join(homeDir, '.omx', 'state');
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const originalDiscordToken = process.env.OMX_DISCORD_NOTIFIER_BOT_TOKEN;
    const originalDiscordChannel = process.env.OMX_DISCORD_NOTIFIER_CHANNEL;
    const originalTelegramToken = process.env.OMX_TELEGRAM_BOT_TOKEN;
    const originalTelegramChatId = process.env.OMX_TELEGRAM_CHAT_ID;
    const originalReplyEnabled = process.env.OMX_REPLY_ENABLED;

    try {
      await mkdir(stateDir, { recursive: true });
      process.env.HOME = homeDir;
      process.env.USERPROFILE = homeDir;
      process.env.OMX_DISCORD_NOTIFIER_BOT_TOKEN = 'discord-token';
      process.env.OMX_DISCORD_NOTIFIER_CHANNEL = 'discord-channel';
      process.env.OMX_TELEGRAM_BOT_TOKEN = '123456:telegram-token';
      process.env.OMX_TELEGRAM_CHAT_ID = '777';
      process.env.OMX_REPLY_ENABLED = 'true';

      const telegramSource = buildTelegramReplySource('123456:telegram-token', '777');
      const discordSource = buildDiscordReplySource('discord-token', 'discord-channel');
      await writeFile(join(stateDir, 'reply-listener-config.json'), JSON.stringify({
        ...createBaseConfig(),
        telegramBotToken: undefined,
        discordBotToken: undefined,
      }, null, 2));
      await writeFile(join(stateDir, 'reply-listener-state.json'), JSON.stringify({
        ...createBaseState(),
        isRunning: true,
        pid: 98765,
        telegramLastUpdateId: 77,
        discordLastMessageId: 'discord-message-77',
        sourceStates: {
          [telegramSource.key]: {
            sourceKey: telegramSource.key,
            platform: 'telegram',
            label: telegramSource.label,
            telegramLastUpdateId: 77,
            telegramStartupPolicyApplied: true,
            lastPollAt: '2026-03-20T00:05:00.000Z',
            lastIngestAt: '2026-03-20T00:05:05.000Z',
            lastFailureAt: null,
            lastFailureCategory: null,
            lastFailureMessage: null,
            failureCounts: {},
          },
          [discordSource.key]: {
            sourceKey: discordSource.key,
            platform: 'discord-bot',
            label: discordSource.label,
            discordLastMessageId: 'discord-message-77',
            telegramStartupPolicyApplied: false,
            lastPollAt: '2026-03-20T00:06:00.000Z',
            lastIngestAt: '2026-03-20T00:06:05.000Z',
            lastFailureAt: '2026-03-20T00:06:06.000Z',
            lastFailureCategory: 'rate-limit',
            lastFailureMessage: 'Deferred Discord message 77',
            failureCounts: { 'rate-limit': 1 },
          },
        },
      }, null, 2));

      const mod = await importReplyListenerFresh();
      const status = mod.getReplyListenerStatus();

      assert.equal(status.success, true);
      assert.equal(status.diagnostics?.ackMode, 'minimal');
      assert.equal(status.diagnostics?.telegramPollTimeoutSeconds, 30);
      assert.deepEqual(
        status.diagnostics?.activeSources.map((source: { key: string }) => source.key).sort(),
        [discordSource.key, telegramSource.key].sort(),
      );
      const telegramDiagnostics = status.diagnostics?.activeSources.find((source: { key: string }) => source.key === telegramSource.key);
      const discordDiagnostics = status.diagnostics?.activeSources.find((source: { key: string }) => source.key === discordSource.key);
      assert.equal(telegramDiagnostics?.cursor, 77);
      assert.equal(discordDiagnostics?.cursor, 'discord-message-77');
      assert.equal(discordDiagnostics?.lastFailureCategory, 'rate-limit');
      assert.equal(status.diagnostics?.secretStorage, 'not-persisted');
    } finally {
      if (typeof originalHome === 'string') process.env.HOME = originalHome;
      else delete process.env.HOME;
      if (typeof originalUserProfile === 'string') process.env.USERPROFILE = originalUserProfile;
      else delete process.env.USERPROFILE;
      if (typeof originalDiscordToken === 'string') process.env.OMX_DISCORD_NOTIFIER_BOT_TOKEN = originalDiscordToken;
      else delete process.env.OMX_DISCORD_NOTIFIER_BOT_TOKEN;
      if (typeof originalDiscordChannel === 'string') process.env.OMX_DISCORD_NOTIFIER_CHANNEL = originalDiscordChannel;
      else delete process.env.OMX_DISCORD_NOTIFIER_CHANNEL;
      if (typeof originalTelegramToken === 'string') process.env.OMX_TELEGRAM_BOT_TOKEN = originalTelegramToken;
      else delete process.env.OMX_TELEGRAM_BOT_TOKEN;
      if (typeof originalTelegramChatId === 'string') process.env.OMX_TELEGRAM_CHAT_ID = originalTelegramChatId;
      else delete process.env.OMX_TELEGRAM_CHAT_ID;
      if (typeof originalReplyEnabled === 'string') process.env.OMX_REPLY_ENABLED = originalReplyEnabled;
      else delete process.env.OMX_REPLY_ENABLED;
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('writes machine-parseable JSON log lines for reply-listener lifecycle events', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'omx-reply-listener-log-json-'));
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const originalDiscordToken = process.env.OMX_DISCORD_NOTIFIER_BOT_TOKEN;
    const originalDiscordChannel = process.env.OMX_DISCORD_NOTIFIER_CHANNEL;
    const originalTelegramToken = process.env.OMX_TELEGRAM_BOT_TOKEN;
    const originalTelegramChatId = process.env.OMX_TELEGRAM_CHAT_ID;
    const originalReplyEnabled = process.env.OMX_REPLY_ENABLED;

    try {
      process.env.HOME = homeDir;
      process.env.USERPROFILE = homeDir;
      process.env.OMX_DISCORD_NOTIFIER_BOT_TOKEN = 'discord-token';
      process.env.OMX_DISCORD_NOTIFIER_CHANNEL = 'discord-channel';
      process.env.OMX_TELEGRAM_BOT_TOKEN = '123456:telegram-token';
      process.env.OMX_TELEGRAM_CHAT_ID = '777';
      process.env.OMX_REPLY_ENABLED = 'true';

      const mod = await importReplyListenerFresh();
      const response = mod.startReplyListener(createBaseConfig(), {
        ensureStateDirImpl: () => {},
        isDaemonRunningImpl: () => false,
        isTmuxAvailableImpl: () => true,
        spawnImpl: (() => ({ pid: 65432, unref() {} })) as unknown as typeof import('node:child_process').spawn,
        writePidFileImpl: () => {},
      });

      assert.equal(response.success, true);
      const logLines = (await readFile(join(homeDir, '.omx', 'state', 'reply-listener.log'), 'utf-8'))
        .trim()
        .split('\n')
        .filter((line) => line.length > 0);
      assert.ok(logLines.length >= 1);

      const first = JSON.parse(logLines[0]) as Record<string, unknown>;
      assert.equal(first.scope, 'reply-listener');
      assert.equal(first.level, 'INFO');
      assert.equal(typeof first.timestamp, 'string');
      assert.match(String(first.message), /Reply listener daemon started/i);
    } finally {
      if (typeof originalHome === 'string') process.env.HOME = originalHome;
      else delete process.env.HOME;
      if (typeof originalUserProfile === 'string') process.env.USERPROFILE = originalUserProfile;
      else delete process.env.USERPROFILE;
      if (typeof originalDiscordToken === 'string') process.env.OMX_DISCORD_NOTIFIER_BOT_TOKEN = originalDiscordToken;
      else delete process.env.OMX_DISCORD_NOTIFIER_BOT_TOKEN;
      if (typeof originalDiscordChannel === 'string') process.env.OMX_DISCORD_NOTIFIER_CHANNEL = originalDiscordChannel;
      else delete process.env.OMX_DISCORD_NOTIFIER_CHANNEL;
      if (typeof originalTelegramToken === 'string') process.env.OMX_TELEGRAM_BOT_TOKEN = originalTelegramToken;
      else delete process.env.OMX_TELEGRAM_BOT_TOKEN;
      if (typeof originalTelegramChatId === 'string') process.env.OMX_TELEGRAM_CHAT_ID = originalTelegramChatId;
      else delete process.env.OMX_TELEGRAM_CHAT_ID;
      if (typeof originalReplyEnabled === 'string') process.env.OMX_REPLY_ENABLED = originalReplyEnabled;
      else delete process.env.OMX_REPLY_ENABLED;
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});

describe('captureReplyAcknowledgementSummary', () => {
  it('captures a cleaned recent-output summary via tmux-tail parsing', () => {
    const summary = captureReplyAcknowledgementSummary('%9', {
      capturePaneContentImpl: (paneId, lines) => {
        assert.equal(paneId, '%9');
        assert.equal(lines, 200);
        return [
          '● spinner',
          'Meaningful output line',
          '  continuation line',
          '',
        ].join('\n');
      },
    });

    assert.equal(summary, 'Meaningful output line\n  continuation line');
  });

  it('returns null when the captured pane tail has no meaningful lines', () => {
    const summary = captureReplyAcknowledgementSummary('%9', {
      capturePaneContentImpl: () => '● spinner\nctrl+o to expand',
    });

    assert.equal(summary, null);
  });

  it('truncates oversized summaries without cutting the acknowledgment prefix logic', () => {
    const longLine = 'x'.repeat(900);
    const summary = captureReplyAcknowledgementSummary('%9', {
      capturePaneContentImpl: () => longLine,
      parseTmuxTailImpl: () => longLine,
    });

    assert.equal(summary?.length, 700);
    assert.ok(summary?.endsWith('…'));
  });
});

describe('formatReplyAcknowledgement', () => {
  it('returns a minimal acknowledgement by default', () => {
    const message = formatReplyAcknowledgement('Line 1\nLine 2', 'minimal');

    assert.equal(
      message,
      'Injected into Codex CLI session.',
    );
  });

  it('includes recent output when summary mode is enabled', () => {
    const message = formatReplyAcknowledgement('Line 1\nLine 2', 'summary');

    assert.equal(
      message,
      'Injected into Codex CLI session.\n\nRecent output:\nLine 1\nLine 2',
    );
  });

  it('falls back when summary mode has no recent output', () => {
    const message = formatReplyAcknowledgement(null, 'summary');

    assert.equal(
      message,
      'Injected into Codex CLI session.\n\nRecent output summary unavailable.',
    );
  });

  it('suppresses acknowledgements when ack mode is off', () => {
    const message = formatReplyAcknowledgement('Line 1', 'off');

    assert.equal(message, null);
  });
});

describe('redactSensitiveTokens', () => {
  it('redacts OpenAI-style API keys', () => {
    assert.equal(
      redactSensitiveTokens('export OPENAI_API_KEY=sk-proj-abc123def456'),
      'export OPENAI_API_KEY=[REDACTED]',
    );
  });

  it('redacts GitHub PAT tokens', () => {
    assert.equal(
      redactSensitiveTokens('token: ghp_1234567890abcdefABCDEF'),
      'token: [REDACTED]',
    );
  });

  it('redacts generic key=value secrets', () => {
    const result = redactSensitiveTokens('api_key=mysecretvalue123 other text');
    assert.equal(result.includes('mysecretvalue123'), false);
  });

  it('redacts multi-part authorization header values', () => {
    assert.equal(
      redactSensitiveTokens('authorization: Bearer mysecrettoken'),
      'authorization: [REDACTED]',
    );
  });

  it('redacts quoted JSON secret fields', () => {
    assert.equal(
      redactSensitiveTokens('{"api_key":"mysecret","safe":true}'),
      '{"api_key":"[REDACTED]","safe":true}',
    );
  });

  it('preserves text without secrets', () => {
    const input = 'npm run build\n33 tests passed\nno errors found';
    assert.equal(redactSensitiveTokens(input), input);
  });
});

describe('captureReplyAcknowledgementSummary redaction', () => {
  it('redacts secrets from captured tmux output', () => {
    const summary = captureReplyAcknowledgementSummary('%99', {
      capturePaneContentImpl: () => 'export OPENAI_API_KEY=sk-proj-abc123\n$ codex chat',
      parseTmuxTailImpl: (raw: string) => raw,
    });
    assert.ok(summary);
    assert.equal(summary.includes('sk-proj-abc123'), false, 'API key must be redacted');
    assert.ok(summary.includes('[REDACTED]'));
  });
});

describe('pollDiscordOnce', () => {
  it('does not clear stale Discord poll-error diagnostics for malformed successful responses', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig();
    const state = createBaseState();
    assert.ok(config.discordBotToken);
    assert.ok(config.discordChannelId);
    const source = buildDiscordReplySource(config.discordBotToken, config.discordChannelId);
    state.sourceStates[source.key] = {
      sourceKey: source.key,
      platform: 'discord-bot',
      label: source.label,
      discordLastMessageId: null,
      lastPollAt: '2026-03-20T00:00:00.000Z',
      lastIngestAt: null,
      lastFailureAt: '2026-03-20T00:00:01.000Z',
      lastFailureCategory: 'poll-error',
      lastFailureMessage: 'previous malformed response',
      failureCounts: { 'poll-error': 1 },
    };

    await pollDiscordOnce(
      config,
      state,
      new RateLimiter(10),
      {
        fetchImpl: async () => jsonResponse({ malformed: true }),
      },
    );

    const sourceState = state.sourceStates[source.key];
    assert.equal(sourceState?.lastFailureCategory, 'poll-error');
    assert.match(sourceState?.lastFailureMessage ?? '', /Expected Discord messages array/);
    assert.equal(sourceState?.failureCounts?.['poll-error'], 2);
  });

  it('treats exact-match status replies as read-only Discord session lookups', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig();
    const state = createBaseState();
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    let injectCalled = false;

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      fetchCalls.push({ url, init });
      if (url.endsWith('/messages?limit=10')) {
        return jsonResponse([
          {
            id: 'discord-status-1',
            author: { id: 'discord-user-1' },
            content: '  STATUS  ',
            message_reference: { message_id: 'orig-discord-msg' },
          },
        ]);
      }
      if (url.endsWith('/messages')) {
        return jsonResponse({ id: 'status-reply-1' });
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    };

    await pollDiscordOnce(
      config,
      state,
      new RateLimiter(10),
      {
        fetchImpl,
        lookupByMessageIdImpl: () => createMapping('discord-bot'),
        buildSessionStatusReplyImpl: async (mapping) => {
          assert.equal(mapping.sessionId, 'session-1');
          return 'Tracked OMX session status';
        },
        injectReplyImpl: () => {
          injectCalled = true;
          return true;
        },
      },
    );

    assert.equal(injectCalled, false);
    assert.equal(state.messagesInjected, 0);
    assert.equal(state.errors, 0);
    assert.equal(state.discordLastMessageId, 'discord-status-1');
    assert.equal(fetchCalls.length, 2);

    const replyBody = JSON.parse(String(fetchCalls[1].init?.body));
    assert.equal(replyBody.content, 'Tracked OMX session status');
    assert.deepEqual(replyBody.message_reference, { message_id: 'discord-status-1' });
    assert.deepEqual(replyBody.allowed_mentions, { parse: [] });
  });

  it('uses the latest correlated session when a Discord notification message id is reused', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig();
    const state = createBaseState();
    const statusSessionIds: string[] = [];

    await pollDiscordOnce(
      config,
      state,
      new RateLimiter(10),
      {
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.endsWith('/messages?limit=10')) {
            return jsonResponse([
              {
                id: 'discord-status-reused-id',
                author: { id: 'discord-user-1' },
                content: 'status',
                message_reference: { message_id: 'orig-discord-msg' },
              },
            ]);
          }
          if (url.endsWith('/messages')) {
            return jsonResponse({ id: 'status-reply-reused-id' });
          }
          throw new Error(`Unexpected fetch url: ${url}`);
        },
        lookupByMessageIdImpl: () => ({
          ...createMapping('discord-bot'),
          messageId: 'orig-discord-msg',
          sessionId: 'session-newer',
          tmuxPaneId: '%10',
          tmuxSessionName: 'latest-session',
        }),
        buildSessionStatusReplyImpl: async (mapping) => {
          statusSessionIds.push(mapping.sessionId);
          return `Tracked OMX session status\nSession: ${mapping.sessionId}`;
        },
        injectReplyImpl: () => {
          throw new Error('injectReply should not run for exact-match status probes');
        },
      },
    );

    assert.deepEqual(statusSessionIds, ['session-newer']);
    assert.equal(state.messagesInjected, 0);
    assert.equal(state.errors, 0);
    assert.equal(state.discordLastMessageId, 'discord-status-reused-id');
  });

  it('injects authorized replies and posts a threaded acknowledgement with recent output in summary mode', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig({ discordMention: '<@123>', ackMode: 'summary' });
    const state = createBaseState();
    const writes: ReplyListenerState[] = [];
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      fetchCalls.push({ url, init });
      if (url.endsWith('/messages?limit=10')) {
        return jsonResponse([
          {
            id: 'discord-reply-1',
            author: { id: 'discord-user-1' },
            content: 'run status',
            message_reference: { message_id: 'orig-discord-msg' },
          },
        ]);
      }
      if (url.includes('/reactions/')) {
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/messages')) {
        return jsonResponse({ id: 'ack-1' });
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    };

    await pollDiscordOnce(
      config,
      state,
      new RateLimiter(10),
      {
        fetchImpl,
        lookupByMessageIdImpl: () => createMapping('discord-bot'),
        injectReplyImpl: (paneId, text, platform, activeConfig) => {
          assert.equal(paneId, '%9');
          assert.equal(text, 'run status');
          assert.equal(platform, 'discord');
          assert.equal(activeConfig, config);
          return true;
        },
        captureReplyAcknowledgementSummaryImpl: () => 'Recent pane output',
        parseMentionAllowedMentionsImpl: (mention) => {
          assert.equal(mention, '<@123>');
          return { users: ['123'] } as ReturnType<typeof import('../config.js').parseMentionAllowedMentions>;
        },
        writeDaemonStateImpl: (nextState) => {
          writes.push(cloneState(nextState));
        },
      },
    );

    assert.equal(state.messagesInjected, 1);
    assert.equal(state.errors, 0);
    assert.equal(state.discordLastMessageId, 'discord-reply-1');
    assert.ok(writes.length >= 1);
    assert.equal(fetchCalls.length, 3);

    const acknowledgementCall = fetchCalls[2];
    assert.ok(acknowledgementCall.url.endsWith('/messages'));
    const acknowledgementBody = JSON.parse(String(acknowledgementCall.init?.body));
    assert.equal(
      acknowledgementBody.content,
      'Injected into Codex CLI session.\n\nRecent output:\nRecent pane output',
    );
    assert.deepEqual(acknowledgementBody.message_reference, { message_id: 'discord-reply-1' });
    assert.deepEqual(acknowledgementBody.allowed_mentions, { users: ['123'] });
  });

  it('ignores unauthorized Discord replies while still advancing the last message id', async () => {
    resetReplyListenerTransientState();
    const state = createBaseState();

    await pollDiscordOnce(
      createBaseConfig(),
      state,
      new RateLimiter(10),
      {
        fetchImpl: async () => jsonResponse([
          {
            id: 'discord-reply-2',
            author: { id: 'intruder' },
            content: 'malicious',
            message_reference: { message_id: 'orig-discord-msg' },
          },
        ]),
        lookupByMessageIdImpl: () => {
          throw new Error('lookup should not be called for unauthorized replies');
        },
        injectReplyImpl: () => {
          throw new Error('injectReply should not be called for unauthorized replies');
        },
      },
    );

    assert.equal(state.messagesInjected, 0);
    assert.equal(state.errors, 0);
    assert.equal(state.discordLastMessageId, 'discord-reply-2');
  });

  it('does not return status data for unauthorized status replies', async () => {
    resetReplyListenerTransientState();
    const state = createBaseState();
    const fetchCalls: string[] = [];

    await pollDiscordOnce(
      createBaseConfig(),
      state,
      new RateLimiter(10),
      {
        fetchImpl: async (input) => {
          fetchCalls.push(String(input));
          return jsonResponse([
            {
              id: 'discord-reply-unauthorized-status',
              author: { id: 'intruder' },
              content: 'status',
              message_reference: { message_id: 'orig-discord-msg' },
            },
          ]);
        },
        lookupByMessageIdImpl: () => {
          throw new Error('lookup should not run for unauthorized status replies');
        },
        injectReplyImpl: () => {
          throw new Error('injectReply should not run for unauthorized status replies');
        },
      },
    );

    assert.deepEqual(fetchCalls, ['https://discord.com/api/v10/channels/discord-channel/messages?limit=10']);
    assert.equal(state.messagesInjected, 0);
    assert.equal(state.errors, 0);
    assert.equal(state.discordLastMessageId, 'discord-reply-unauthorized-status');
  });

  it('replies with a bounded failure when status has no tracked correlation and does not inject', async () => {
    resetReplyListenerTransientState();
    const state = createBaseState();
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    let injectCalled = false;

    await pollDiscordOnce(
      createBaseConfig(),
      state,
      new RateLimiter(10),
      {
        fetchImpl: async (input, init) => {
          const url = String(input);
          fetchCalls.push({ url, init });
          if (url.endsWith('/messages?limit=10')) {
            return jsonResponse([
              {
                id: 'discord-status-untracked',
                author: { id: 'discord-user-1' },
                content: 'status',
                message_reference: { message_id: 'unknown-msg' },
              },
            ]);
          }
          if (url.endsWith('/messages')) {
            return jsonResponse({ id: 'status-failure-reply' });
          }
          throw new Error(`Unexpected fetch url: ${url}`);
        },
        lookupByMessageIdImpl: () => null,
        injectReplyImpl: () => {
          injectCalled = true;
          return true;
        },
      },
    );

    assert.equal(injectCalled, false);
    assert.equal(state.messagesInjected, 0);
    assert.equal(state.errors, 0);
    assert.equal(fetchCalls.length, 2);
    const replyBody = JSON.parse(String(fetchCalls[1].init?.body));
    assert.equal(replyBody.content, NO_TRACKED_SESSION_MESSAGE);
  });

  it('drops mapped Discord replies when the rate limiter rejects them', async () => {
    resetReplyListenerTransientState();
    const state = createBaseState();
    let injectCalled = false;

    await pollDiscordOnce(
      createBaseConfig(),
      state,
      { canProceed: () => false, reset: () => {} },
      {
        fetchImpl: async () => jsonResponse([
          {
            id: 'discord-reply-3',
            author: { id: 'discord-user-1' },
            content: 'status?',
            message_reference: { message_id: 'orig-discord-msg' },
          },
        ]),
        lookupByMessageIdImpl: () => createMapping('discord-bot'),
        injectReplyImpl: () => {
          injectCalled = true;
          return true;
        },
      },
    );

    assert.equal(injectCalled, false);
    assert.equal(state.messagesInjected, 0);
    assert.equal(state.errors, 1);
    assert.equal(state.discordLastMessageId, null);
  });

  it('does not advance the Discord cursor when injection fails with a retryable error', async () => {
    resetReplyListenerTransientState();
    const state = createBaseState();

    await pollDiscordOnce(
      createBaseConfig(),
      state,
      new RateLimiter(10),
      {
        fetchImpl: async () => jsonResponse([
          {
            id: 'discord-retryable-failure',
            author: { id: 'discord-user-1' },
            content: 'retry me',
            message_reference: { message_id: 'orig-discord-msg' },
          },
        ]),
        lookupByMessageIdImpl: () => createMapping('discord-bot'),
        injectReplyImpl: () => false,
      },
    );

    assert.equal(state.messagesInjected, 0);
    assert.equal(state.errors, 1);
    assert.equal(state.discordLastMessageId, null);
  });
});

describe('pollTelegramOnce', () => {
  it('blocks live Telegram polling in tests without a marked mock transport', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig();
    const state = createBaseState();
    const wrapperTransport = ((...args: Parameters<typeof httpsRequest>) => {
      return httpsRequest(...args);
    }) as typeof httpsRequest;

    await pollTelegramOnce(
      config,
      state,
      new RateLimiter(10),
      { httpsRequestImpl: wrapperTransport },
    );

    assert.equal(state.errors, 0);
    assert.equal(state.lastPollAt, null);
    assert.ok(config.telegramBotToken);
    assert.ok(config.telegramChatId);
    const source = buildTelegramReplySource(config.telegramBotToken, config.telegramChatId);
    assert.equal(state.sourceStates[source.key]?.lastPollAt, null);
  });

  it('uses long polling parameters and default allowed_updates', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig();
    let observedPath = '';

    await pollTelegramOnce(
      config,
      createBaseState(),
      new RateLimiter(10),
      {
        httpsRequestImpl: createHttpsRequestMock({
          [`GET /bot${config.telegramBotToken}/getUpdates?offset=0&timeout=30&allowed_updates=%5B%22message%22%5D`]: (_body, options) => {
            observedPath = String(options.path);
            return {
              statusCode: 200,
              body: {
                ok: true,
                result: [],
              },
            };
          },
        }),
      },
    );

    assert.equal(
      observedPath,
      `/bot${config.telegramBotToken}/getUpdates?offset=0&timeout=30&allowed_updates=%5B%22message%22%5D`,
    );
  });

  it('clears stale Telegram poll-error diagnostics after a successful poll', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig();
    const state = createBaseState();
    assert.ok(config.telegramBotToken);
    assert.ok(config.telegramChatId);
    const source = buildTelegramReplySource(config.telegramBotToken, config.telegramChatId);
    state.sourceStates[source.key] = {
      sourceKey: source.key,
      platform: 'telegram',
      label: source.label,
      telegramLastUpdateId: null,
      telegramStartupPolicyApplied: true,
      lastPollAt: '2026-03-20T00:00:00.000Z',
      lastIngestAt: null,
      lastFailureAt: '2026-03-20T00:00:01.000Z',
      lastFailureCategory: 'poll-error',
      lastFailureMessage: 'Request timeout',
      failureCounts: { 'poll-error': 1 },
    };

    await pollTelegramOnce(
      config,
      state,
      new RateLimiter(10),
      {
        httpsRequestImpl: createHttpsRequestMock({
          [`GET /bot${config.telegramBotToken}/getUpdates?offset=0&timeout=30&allowed_updates=%5B%22message%22%5D`]: () => ({
            statusCode: 200,
            body: {
              ok: true,
              result: [],
            },
          }),
        }),
      },
    );

    const sourceState = state.sourceStates[source.key];
    assert.ok(sourceState?.lastPollAt);
    assert.equal(sourceState?.lastFailureAt, null);
    assert.equal(sourceState?.lastFailureCategory, null);
    assert.equal(sourceState?.lastFailureMessage, null);
    assert.equal(sourceState?.failureCounts?.['poll-error'], 1);
  });

  it('injects Telegram replies and sends a removable placeholder acknowledgement', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig();
    const state = createBaseState();
    const source = buildTelegramReplySource(config.telegramBotToken!, config.telegramChatId!);
    state.sourceStates[source.key] = {
      sourceKey: source.key,
      platform: 'telegram',
      label: source.label,
      telegramLastUpdateId: null,
      telegramStartupPolicyApplied: true,
      lastPollAt: '2026-03-20T00:00:00.000Z',
      lastIngestAt: null,
      lastFailureAt: '2026-03-20T00:00:01.000Z',
      lastFailureCategory: 'retryable-injection',
      lastFailureMessage: 'previous pane verification failure',
      failureCounts: { 'retryable-injection': 1 },
    };
    const writes: ReplyListenerState[] = [];
    let sendMessageBody = '';

    await pollTelegramOnce(
      config,
      state,
      new RateLimiter(10),
      {
        httpsRequestImpl: createHttpsRequestMock({
          [`GET /bot${config.telegramBotToken}/getUpdates?offset=0&timeout=30&allowed_updates=%5B%22message%22%5D`]: () => ({
            statusCode: 200,
            body: {
              ok: true,
              result: [
                {
                  update_id: 44,
                  message: {
                    message_id: 333,
                    message_thread_id: 9001,
                    chat: { id: 777 },
                    from: { id: 'telegram-user-1' },
                    text: 'continue',
                    reply_to_message: { message_id: 222 },
                  },
                },
              ],
            },
          }),
          [`POST /bot${config.telegramBotToken}/sendMessage`]: (body) => {
            sendMessageBody = body;
            return { statusCode: 200, body: { ok: true, result: { message_id: 444 } } };
          },
        }),
        lookupByMessageIdImpl: () => createMapping('telegram'),
        injectReplyImpl: (paneId, text, platform) => {
          assert.equal(paneId, '%9');
          assert.equal(text, 'continue');
          assert.equal(platform, 'telegram');
          return true;
        },
        captureReplyAcknowledgementSummaryImpl: () => 'Recent telegram output',
        writeDaemonStateImpl: (nextState) => {
          writes.push(cloneState(nextState));
        },
      },
    );

    assert.equal(state.messagesInjected, 1);
    assert.equal(state.errors, 0);
    assert.equal(state.telegramLastUpdateId, 44);
    assert.equal(state.sourceStates[source.key]?.lastFailureAt, null);
    assert.equal(state.sourceStates[source.key]?.lastFailureCategory, null);
    assert.equal(state.sourceStates[source.key]?.lastFailureMessage, null);
    assert.ok(writes.length >= 1);

    const parsedBody = JSON.parse(sendMessageBody) as {
      chat_id: string;
      text: string;
      reply_to_message_id: number;
      message_thread_id: number;
    };
    assert.equal(parsedBody.chat_id, config.telegramChatId);
    assert.equal(parsedBody.reply_to_message_id, 333);
    assert.equal(parsedBody.message_thread_id, 9001);
    assert.equal(
      parsedBody.text,
      'Got it — sending your follow-up to Codex…',
    );
  });

  it('keeps Telegram replies silent when telegram ack mode is off', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig({ telegramAckMode: 'off' });
    const state = createBaseState();
    let injectedText = '';

    await pollTelegramOnce(
      config,
      state,
      new RateLimiter(10),
      {
        httpsRequestImpl: createHttpsRequestMock({
          [`GET /bot${config.telegramBotToken}/getUpdates?offset=0&timeout=30&allowed_updates=%5B%22message%22%5D`]: () => ({
            statusCode: 200,
            body: {
              ok: true,
              result: [
                {
                  update_id: 145,
                  message: {
                    message_id: 432,
                    message_thread_id: 9001,
                    chat: { id: 777 },
                    from: { id: 'telegram-user-1' },
                    text: 'continue silently',
                    reply_to_message: { message_id: 222 },
                  },
                },
              ],
            },
          }),
        }),
        lookupByMessageIdImpl: () => createMapping('telegram'),
        injectReplyImpl: (_paneId, text) => {
          injectedText = text;
          return true;
        },
      },
    );

    assert.equal(injectedText, 'continue silently');
    assert.equal(state.messagesInjected, 1);
    assert.equal(state.telegramLastUpdateId, 145);
    assert.equal(state.errors, 0);
  });

  it('removes Telegram placeholders immediately when reply-origin metadata cannot be recorded', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig();
    const state = createBaseState();
    const requestOrder: string[] = [];
    const sendBodies: Array<Record<string, unknown>> = [];
    const deleteBodies: Array<Record<string, unknown>> = [];

    await pollTelegramOnce(
      config,
      state,
      new RateLimiter(10),
      {
        httpsRequestImpl: createHttpsRequestMock({
          [`GET /bot${config.telegramBotToken}/getUpdates?offset=0&timeout=30&allowed_updates=%5B%22message%22%5D`]: () => ({
            statusCode: 200,
            body: {
              ok: true,
              result: [
                {
                  update_id: 148,
                  message: {
                    message_id: 435,
                    message_thread_id: 9001,
                    chat: { id: 777 },
                    from: { id: 'telegram-user-1' },
                    text: 'continue without project path',
                    reply_to_message: { message_id: 222 },
                  },
                },
              ],
            },
          }),
          [`POST /bot${config.telegramBotToken}/sendMessage`]: (body) => {
            requestOrder.push('sendMessage');
            sendBodies.push(JSON.parse(body) as Record<string, unknown>);
            return {
              statusCode: 200,
              body: {
                ok: true,
                result: {
                  message_id: sendBodies.length === 1 ? 702 : 703,
                  message_thread_id: 9001,
                },
              },
            };
          },
          [`POST /bot${config.telegramBotToken}/deleteMessage`]: (body) => {
            requestOrder.push('deleteMessage');
            deleteBodies.push(JSON.parse(body) as Record<string, unknown>);
            return { statusCode: 200, body: { ok: true, result: true } };
          },
        }),
        lookupByMessageIdImpl: () => ({
          ...createMapping('telegram'),
          projectPath: undefined,
        }),
        injectReplyImpl: () => true,
      },
    );

    assert.deepEqual(requestOrder, ['sendMessage', 'deleteMessage', 'sendMessage']);
    assert.equal(sendBodies[0]?.text, 'Got it — sending your follow-up to Codex…');
    assert.deepEqual(deleteBodies[0], { chat_id: '777', message_id: '702' });
    assert.equal(sendBodies[1]?.text, 'Injected into Codex CLI session.');
    assert.equal(state.messagesInjected, 1);
    assert.equal(state.telegramLastUpdateId, 148);
  });

  it('injects Telegram media reply captions and saves screenshots for Codex context', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig();
    const state = createBaseState();
    const attachmentRoot = await mkdtemp(join(tmpdir(), 'omx-telegram-attachments-'));
    const projectRoot = await mkdtemp(join(tmpdir(), 'omx-telegram-origin-project-'));
    const previousAttachmentDir = process.env.OMX_TELEGRAM_ATTACHMENT_DIR;
    process.env.OMX_TELEGRAM_ATTACHMENT_DIR = attachmentRoot;
    let injectedText = '';

    try {
      await pollTelegramOnce(
        config,
        state,
        new RateLimiter(10),
        {
          httpsRequestImpl: createHttpsRequestMock({
            [`GET /bot${config.telegramBotToken}/getUpdates?offset=0&timeout=30&allowed_updates=%5B%22message%22%5D`]: () => ({
              statusCode: 200,
              body: {
                ok: true,
                result: [
                  {
                    update_id: 45,
                    message: {
                      message_id: 333,
                      message_thread_id: 9001,
                      chat: { id: 777 },
                      from: { id: 'telegram-user-1' },
                      caption: 'скрин и подробности в подписи',
                      photo: [
                        { file_id: 'photo-small', width: 320, height: 640, file_size: 4 },
                        { file_id: 'photo-large', width: 1170, height: 2532, file_size: 12 },
                      ],
                      reply_to_message: { message_id: 222 },
                    },
                  },
                ],
              },
            }),
            [`GET /bot${config.telegramBotToken}/getFile?file_id=photo-large`]: () => ({
              statusCode: 200,
              body: {
                ok: true,
                result: {
                  file_path: 'photos/file_1.jpg',
                  file_size: 12,
                },
              },
            }),
            [`GET /file/bot${config.telegramBotToken}/photos/file_1.jpg`]: () => ({
              statusCode: 200,
              body: 'image-bytes',
            }),
            [`POST /bot${config.telegramBotToken}/sendMessage`]: () => ({
              statusCode: 200,
              body: { ok: true, result: { message_id: 444 } },
            }),
          }),
          lookupByMessageIdImpl: () => ({
            ...createMapping('telegram'),
            projectPath: projectRoot,
          }),
          injectReplyImpl: (_paneId, text, platform) => {
            assert.equal(platform, 'telegram');
            injectedText = text;
            return true;
          },
        },
      );

      const savedPath = await findSavedAttachmentPath(attachmentRoot, '777-333-1-photo.jpg');
      assert.equal(await readFile(savedPath, 'utf-8'), 'image-bytes');
      const metadata = JSON.parse(await readFile(`${savedPath}.metadata.json`, 'utf-8')) as Record<string, unknown>;
      assert.equal(metadata.kind, 'photo');
      assert.equal(metadata.telegramFilePath, 'photos/file_1.jpg');
      assert.match(injectedText, /скрин и подробности в подписи/);
      assert.match(injectedText, /Telegram attachment saved locally:/);
      assert.match(injectedText, /777-333-1-photo\.jpg/);
      const origin = await consumePendingReplyOrigin(
        projectRoot,
        'session-1',
        buildInjectedReplyInput(injectedText, 'telegram', config),
      );
      assert.equal(origin?.platform, 'telegram');
      assert.match(origin?.injectedInput ?? '', /777-333-1-photo\.jpg/);
      assert.equal(state.messagesInjected, 1);
      assert.equal(state.telegramLastUpdateId, 45);
    } finally {
      if (previousAttachmentDir === undefined) {
        delete process.env.OMX_TELEGRAM_ATTACHMENT_DIR;
      } else {
        process.env.OMX_TELEGRAM_ATTACHMENT_DIR = previousAttachmentDir;
      }
      await rm(attachmentRoot, { recursive: true, force: true });
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('sends Telegram placeholder before media download and records cleanup metadata', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig({ telegramAckMode: 'accepted-final-message' });
    const state = createBaseState();
    const attachmentRoot = await mkdtemp(join(tmpdir(), 'omx-telegram-accepted-attachments-'));
    const projectRoot = await mkdtemp(join(tmpdir(), 'omx-telegram-accepted-origin-'));
    const previousAttachmentDir = process.env.OMX_TELEGRAM_ATTACHMENT_DIR;
    process.env.OMX_TELEGRAM_ATTACHMENT_DIR = attachmentRoot;
    const requestOrder: string[] = [];
    const acceptedBodies: Array<Record<string, unknown>> = [];
    let injectedText = '';

    try {
      await pollTelegramOnce(
        config,
        state,
        new RateLimiter(10),
        {
          httpsRequestImpl: createHttpsRequestMock({
            [`GET /bot${config.telegramBotToken}/getUpdates?offset=0&timeout=30&allowed_updates=%5B%22message%22%5D`]: () => ({
              statusCode: 200,
              body: {
                ok: true,
                result: [
                  {
                    update_id: 146,
                    message: {
                      message_id: 433,
                      message_thread_id: 9001,
                      chat: { id: 777 },
                      from: { id: 'telegram-user-1' },
                      caption: 'please inspect this accepted screenshot',
                      photo: [{ file_id: 'accepted-photo', width: 1024, height: 768, file_size: 9 }],
                      reply_to_message: { message_id: 222 },
                    },
                  },
                ],
              },
            }),
            [`POST /bot${config.telegramBotToken}/sendMessage`]: (body) => {
              requestOrder.push('accepted');
              acceptedBodies.push(JSON.parse(body) as Record<string, unknown>);
              return {
                statusCode: 200,
                body: { ok: true, result: { message_id: 701, message_thread_id: 9001 } },
              };
            },
            [`POST /bot${config.telegramBotToken}/sendChatAction`]: (body) => {
              requestOrder.push('typing');
              const parsed = JSON.parse(body) as { chat_id: string; action: string; message_thread_id: number };
              assert.equal(parsed.chat_id, config.telegramChatId);
              assert.equal(parsed.action, 'typing');
              assert.equal(parsed.message_thread_id, 9001);
              return { statusCode: 200, body: { ok: true, result: true } };
            },
            [`GET /bot${config.telegramBotToken}/getFile?file_id=accepted-photo`]: () => {
              requestOrder.push('getFile');
              return {
                statusCode: 200,
                body: { ok: true, result: { file_path: 'photos/accepted.jpg', file_size: 9 } },
              };
            },
            [`GET /file/bot${config.telegramBotToken}/photos/accepted.jpg`]: () => {
              requestOrder.push('download');
              return { statusCode: 200, body: 'accepted' };
            },
          }),
          lookupByMessageIdImpl: () => ({
            ...createMapping('telegram'),
            projectPath: projectRoot,
          }),
          injectReplyImpl: (_paneId, text, platform) => {
            assert.equal(platform, 'telegram');
            injectedText = text;
            return true;
          },
        },
      );

      assert.deepEqual(requestOrder, ['accepted', 'typing', 'getFile', 'download']);
      const acceptedBody = acceptedBodies[0] ?? {};
      assert.equal(acceptedBody.text, 'Got it — sending your follow-up to Codex…');
      assert.equal(acceptedBody.reply_to_message_id, 433);
      assert.equal(acceptedBody.message_thread_id, 9001);
      assert.equal('disable_notification' in acceptedBody, false);
      assert.match(injectedText, /accepted screenshot/);
      assert.match(injectedText, /777-433-1-photo\.jpg/);

      const origin = await consumePendingReplyOrigin(
        projectRoot,
        'session-1',
        buildInjectedReplyInput(injectedText, 'telegram', config),
      );
      assert.equal(origin?.platform, 'telegram');
      assert.deepEqual(origin?.telegramAck, {
        chatId: '777',
        messageId: '701',
        messageThreadId: '9001',
      });
      assert.deepEqual(origin?.telegramReplyTo, {
        chatId: '777',
        messageId: '433',
        messageThreadId: '9001',
      });
      assert.equal(state.messagesInjected, 1);
    } finally {
      if (previousAttachmentDir === undefined) {
        delete process.env.OMX_TELEGRAM_ATTACHMENT_DIR;
      } else {
        process.env.OMX_TELEGRAM_ATTACHMENT_DIR = previousAttachmentDir;
      }
      await rm(attachmentRoot, { recursive: true, force: true });
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('deletes accepted Telegram ack before deferring retryable injection failures', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig({ telegramAckMode: 'accepted-final-message' });
    const state = createBaseState();
    const requestOrder: string[] = [];
    const deleteBodies: Array<Record<string, unknown>> = [];

    await pollTelegramOnce(
      config,
      state,
      new RateLimiter(10),
      {
        httpsRequestImpl: createHttpsRequestMock({
          [`GET /bot${config.telegramBotToken}/getUpdates?offset=0&timeout=30&allowed_updates=%5B%22message%22%5D`]: () => ({
            statusCode: 200,
            body: {
              ok: true,
              result: [
                {
                  update_id: 147,
                  message: {
                    message_id: 434,
                    message_thread_id: 9001,
                    chat: { id: 777 },
                    from: { id: 'telegram-user-1' },
                    text: 'retry this later',
                    reply_to_message: { message_id: 222 },
                  },
                },
              ],
            },
          }),
          [`POST /bot${config.telegramBotToken}/sendMessage`]: () => {
            requestOrder.push('accepted');
            return {
              statusCode: 200,
              body: { ok: true, result: { message_id: 701, message_thread_id: 9001 } },
            };
          },
          [`POST /bot${config.telegramBotToken}/deleteMessage`]: (body) => {
            requestOrder.push('delete');
            deleteBodies.push(JSON.parse(body) as Record<string, unknown>);
            return { statusCode: 200, body: { ok: true, result: true } };
          },
        }),
        lookupByMessageIdImpl: () => createMapping('telegram'),
        injectReplyImpl: () => ({ outcome: 'retryable-failure', reason: 'temporary tmux failure' }),
      },
    );

    assert.deepEqual(requestOrder, ['accepted', 'delete']);
    assert.deepEqual(deleteBodies[0], { chat_id: '777', message_id: '701' });
    assert.equal(state.messagesInjected, 0);
    assert.equal(state.errors, 1);
    assert.equal(state.telegramLastUpdateId, null);
  });

  it('downloads document, audio, and voice replies and injects paths plus metadata without transcription', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig();
    const state = createBaseState();
    const attachmentRoot = await mkdtemp(join(tmpdir(), 'omx-telegram-attachments-'));
    const previousAttachmentDir = process.env.OMX_TELEGRAM_ATTACHMENT_DIR;
    process.env.OMX_TELEGRAM_ATTACHMENT_DIR = attachmentRoot;
    let injectedText = '';

    try {
      await pollTelegramOnce(
        config,
        state,
        new RateLimiter(10),
        {
          httpsRequestImpl: createHttpsRequestMock({
            [`GET /bot${config.telegramBotToken}/getUpdates?offset=0&timeout=30&allowed_updates=%5B%22message%22%5D`]: () => ({
              statusCode: 200,
              body: {
                ok: true,
                result: [
                  {
                    update_id: 46,
                    message: {
                      message_id: 334,
                      message_thread_id: 9001,
                      chat: { id: 777 },
                      from: { id: 'telegram-user-1' },
                      caption: 'media bundle',
                      document: {
                        file_id: 'document-image',
                        file_name: 'screen.png',
                        mime_type: 'image/png',
                        file_size: 5,
                      },
                      audio: {
                        file_id: 'audio-file',
                        file_name: 'note.mp3',
                        mime_type: 'audio/mpeg',
                        duration: 42,
                        file_size: 6,
                      },
                      voice: {
                        file_id: 'voice-file',
                        mime_type: 'audio/ogg',
                        duration: 5,
                        file_size: 7,
                      },
                      reply_to_message: { message_id: 222 },
                    },
                  },
                ],
              },
            }),
            [`GET /bot${config.telegramBotToken}/getFile?file_id=document-image`]: () => ({
              statusCode: 200,
              body: { ok: true, result: { file_path: 'documents/screen.png', file_size: 5 } },
            }),
            [`GET /file/bot${config.telegramBotToken}/documents/screen.png`]: () => ({ statusCode: 200, body: 'image' }),
            [`GET /bot${config.telegramBotToken}/getFile?file_id=audio-file`]: () => ({
              statusCode: 200,
              body: { ok: true, result: { file_path: 'audio/note.mp3', file_size: 6 } },
            }),
            [`GET /file/bot${config.telegramBotToken}/audio/note.mp3`]: () => ({ statusCode: 200, body: 'audio!' }),
            [`GET /bot${config.telegramBotToken}/getFile?file_id=voice-file`]: () => ({
              statusCode: 200,
              body: { ok: true, result: { file_path: 'voice/file.ogg', file_size: 7 } },
            }),
            [`GET /file/bot${config.telegramBotToken}/voice/file.ogg`]: () => ({ statusCode: 200, body: 'voice!!' }),
            [`POST /bot${config.telegramBotToken}/sendMessage`]: () => ({
              statusCode: 200,
              body: { ok: true, result: { message_id: 445 } },
            }),
          }),
          lookupByMessageIdImpl: () => createMapping('telegram'),
          injectReplyImpl: (_paneId, text, platform) => {
            assert.equal(platform, 'telegram');
            injectedText = text;
            return true;
          },
        },
      );

      assert.equal(await readFile(await findSavedAttachmentPath(attachmentRoot, '777-334-1-document.png'), 'utf-8'), 'image');
      assert.equal(await readFile(await findSavedAttachmentPath(attachmentRoot, '777-334-2-audio.mp3'), 'utf-8'), 'audio!');
      assert.equal(await readFile(await findSavedAttachmentPath(attachmentRoot, '777-334-3-voice.ogg'), 'utf-8'), 'voice!!');
      assert.match(injectedText, /media bundle/);
      assert.match(injectedText, /777-334-1-document\.png \(document, image\/png, 5 bytes, name=screen\.png\)/);
      assert.match(injectedText, /777-334-2-audio\.mp3 \(audio, audio\/mpeg, 42s, 6 bytes, name=note\.mp3\)/);
      assert.match(injectedText, /777-334-3-voice\.ogg \(voice, audio\/ogg, 5s, 7 bytes\)/);
      assert.doesNotMatch(injectedText, /transcri/i);
      assert.equal(state.messagesInjected, 1);
    } finally {
      if (previousAttachmentDir === undefined) {
        delete process.env.OMX_TELEGRAM_ATTACHMENT_DIR;
      } else {
        process.env.OMX_TELEGRAM_ATTACHMENT_DIR = previousAttachmentDir;
      }
      await rm(attachmentRoot, { recursive: true, force: true });
    }
  });

  it('injects media failure diagnostics and advances the Telegram cursor when attachment download fails', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig();
    const state = createBaseState();
    let injectedText = '';

    await pollTelegramOnce(
      config,
      state,
      new RateLimiter(10),
      {
        httpsRequestImpl: createHttpsRequestMock({
          [`GET /bot${config.telegramBotToken}/getUpdates?offset=0&timeout=30&allowed_updates=%5B%22message%22%5D`]: () => ({
            statusCode: 200,
            body: {
              ok: true,
              result: [
                {
                  update_id: 47,
                  message: {
                    message_id: 335,
                    message_thread_id: 9001,
                    chat: { id: 777 },
                    from: { id: 'telegram-user-1' },
                    caption: 'keep this caption despite failed media',
                    photo: [{ file_id: 'broken-photo', width: 100, height: 200, file_size: 8 }],
                    reply_to_message: { message_id: 222 },
                  },
                },
              ],
            },
          }),
          [`GET /bot${config.telegramBotToken}/getFile?file_id=broken-photo`]: () => ({
            statusCode: 500,
            body: { ok: false, description: 'temporary Telegram file failure' },
          }),
          [`POST /bot${config.telegramBotToken}/sendMessage`]: () => ({
            statusCode: 200,
            body: { ok: true, result: { message_id: 446 } },
          }),
        }),
        lookupByMessageIdImpl: () => createMapping('telegram'),
        injectReplyImpl: (_paneId, text, platform) => {
          assert.equal(platform, 'telegram');
          injectedText = text;
          return true;
        },
      },
    );

    assert.match(injectedText, /keep this caption despite failed media/);
    assert.match(injectedText, /Telegram attachment could not be saved:/);
    assert.match(injectedText, /photo#1: temporary Telegram file failure/);
    assert.equal(state.messagesInjected, 1);
    assert.equal(state.telegramLastUpdateId, 47);
  });

  it('preserves saved Telegram media paths when long captions exceed injection limits', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig({ maxMessageLength: 400 });
    const state = createBaseState();
    const attachmentRoot = await mkdtemp(join(tmpdir(), 'omx-telegram-long-caption-'));
    const previousAttachmentDir = process.env.OMX_TELEGRAM_ATTACHMENT_DIR;
    process.env.OMX_TELEGRAM_ATTACHMENT_DIR = attachmentRoot;
    let injectedText = '';

    try {
      await pollTelegramOnce(
        config,
        state,
        new RateLimiter(10),
        {
          httpsRequestImpl: createHttpsRequestMock({
            [`GET /bot${config.telegramBotToken}/getUpdates?offset=0&timeout=30&allowed_updates=%5B%22message%22%5D`]: () => ({
              statusCode: 200,
              body: {
                ok: true,
                result: [
                  {
                    update_id: 48,
                    message: {
                      message_id: 336,
                      message_thread_id: 9001,
                      chat: { id: 777 },
                      from: { id: 'telegram-user-1' },
                      caption: `long caption ${'x'.repeat(1200)}`,
                      photo: [{ file_id: 'long-caption-photo', width: 100, height: 200, file_size: 8 }],
                      reply_to_message: { message_id: 222 },
                    },
                  },
                ],
              },
            }),
            [`GET /bot${config.telegramBotToken}/getFile?file_id=long-caption-photo`]: () => ({
              statusCode: 200,
              body: { ok: true, result: { file_path: 'photos/long-caption.jpg', file_size: 8 } },
            }),
            [`GET /file/bot${config.telegramBotToken}/photos/long-caption.jpg`]: () => ({
              statusCode: 200,
              body: 'longpath',
            }),
            [`POST /bot${config.telegramBotToken}/sendMessage`]: () => ({
              statusCode: 200,
              body: { ok: true, result: { message_id: 447 } },
            }),
          }),
          lookupByMessageIdImpl: () => createMapping('telegram'),
          injectReplyImpl: (_paneId, text, platform) => {
            assert.equal(platform, 'telegram');
            injectedText = text;
            return true;
          },
        },
      );

      const injected = buildInjectedReplyInput(injectedText, 'telegram', config);
      assert.ok(injected.length <= config.maxMessageLength);
      assert.match(injected, /long caption/);
      assert.match(injected, /…/);
      assert.match(injected, /Telegram attachment saved locally:/);
      assert.match(injected, /777-336-1-photo\.jpg/);
      assert.equal(await readFile(await findSavedAttachmentPath(attachmentRoot, '777-336-1-photo.jpg'), 'utf-8'), 'longpath');
      assert.equal(state.messagesInjected, 1);
      assert.equal(state.telegramLastUpdateId, 48);
    } finally {
      if (previousAttachmentDir === undefined) {
        delete process.env.OMX_TELEGRAM_ATTACHMENT_DIR;
      } else {
        process.env.OMX_TELEGRAM_ATTACHMENT_DIR = previousAttachmentDir;
      }
      await rm(attachmentRoot, { recursive: true, force: true });
    }
  });

  it('ignores Telegram replies from the wrong chat', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig();
    let sendMessageAttempted = false;

    await pollTelegramOnce(
      config,
      createBaseState(),
      new RateLimiter(10),
      {
        httpsRequestImpl: createHttpsRequestMock({
          [`GET /bot${config.telegramBotToken}/getUpdates?offset=0&timeout=30&allowed_updates=%5B%22message%22%5D`]: () => ({
            statusCode: 200,
            body: {
              ok: true,
              result: [
                {
                  update_id: 45,
                  message: {
                    message_id: 334,
                    chat: { id: 999 },
                    from: { id: 'telegram-user-1' },
                    text: 'wrong chat',
                    reply_to_message: { message_id: 222 },
                  },
                },
              ],
            },
          }),
          [`POST /bot${config.telegramBotToken}/sendMessage`]: () => {
            sendMessageAttempted = true;
            return { statusCode: 200, body: { ok: true, result: { message_id: 445 } } };
          },
        }),
        lookupByMessageIdImpl: () => createMapping('telegram'),
        injectReplyImpl: () => {
          throw new Error('injectReply should not run for wrong-chat messages');
        },
      },
    );

    assert.equal(sendMessageAttempted, false);
  });

  it('does not attempt Telegram usage replies for non-reply messages from the wrong chat', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig();
    let sendMessageAttempted = false;

    await pollTelegramOnce(
      config,
      createBaseState(),
      new RateLimiter(10),
      {
        httpsRequestImpl: createHttpsRequestMock({
          [`GET /bot${config.telegramBotToken}/getUpdates?offset=0&timeout=30&allowed_updates=%5B%22message%22%5D`]: () => ({
            statusCode: 200,
            body: {
              ok: true,
              result: [
                {
                  update_id: 54,
                  message: {
                    message_id: 344,
                    chat: { id: 999 },
                    from: { id: 'telegram-user-1' },
                    text: 'hello from elsewhere',
                  },
                },
              ],
            },
          }),
          [`POST /bot${config.telegramBotToken}/sendMessage`]: () => {
            sendMessageAttempted = true;
            return { statusCode: 200, body: { ok: true, result: { message_id: 452 } } };
          },
        }),
      },
    );

    assert.equal(sendMessageAttempted, false);
  });

  it('launches a detached OMX session from a known Telegram project topic and registers the launch acknowledgement', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig();
    const state = createBaseState();
    const telegramSource = buildTelegramReplySource(config.telegramBotToken!, config.telegramChatId!);
    const projectRoot = await mkdtemp(join(tmpdir(), 'omx-telegram-topic-launch-project-'));
    state.sourceStates[telegramSource.key] = {
      sourceKey: telegramSource.key,
      platform: 'telegram',
      label: telegramSource.label,
      telegramLastUpdateId: null,
      telegramStartupPolicyApplied: true,
      lastPollAt: '2026-03-20T00:00:00.000Z',
      lastIngestAt: null,
      lastFailureAt: '2026-03-20T00:00:01.000Z',
      lastFailureCategory: 'topic-launch-failure',
      lastFailureMessage: 'previous launcher resolution failure',
      failureCounts: { 'topic-launch-failure': 1 },
    };
    const sentBodies: string[] = [];
    const registeredMappings: SessionMapping[] = [];
    const launchedSessions: Array<{ cwd: string; codexHomeOverride?: string; notifyProfile?: string | null }> = [];
    const submittedPrompts: Array<{ paneId: string; text: string }> = [];

    try {
      await pollTelegramOnce(
        config,
        state,
        new RateLimiter(10),
        {
          httpsRequestImpl: createHttpsRequestMock({
            [`GET /bot${config.telegramBotToken}/getUpdates?offset=0&timeout=30&allowed_updates=%5B%22message%22%5D`]: () => ({
              statusCode: 200,
              body: {
                ok: true,
                result: [
                  {
                    update_id: 60,
                    message: {
                      message_id: 350,
                      message_thread_id: 9001,
                      chat: { id: 777, type: 'supergroup' },
                      from: { id: 'telegram-user-1' },
                      text: 'Investigate this topic from Telegram',
                    },
                  },
                ],
              },
            }),
            [`POST /bot${config.telegramBotToken}/sendMessage`]: (body) => {
              sentBodies.push(body);
              return {
                statusCode: 200,
                body: { ok: true, result: { message_id: 551, message_thread_id: 9001 } },
              };
            },
          }),
          getNotificationConfigImpl: () => ({
            enabled: true,
            telegram: {
              enabled: true,
              botToken: config.telegramBotToken,
              chatId: config.telegramChatId,
              projectTopics: { enabled: true },
            },
          }) as any,
          findTopicRecordByThreadIdImpl: async (sourceKey, threadId) => {
            assert.equal(sourceKey, telegramSource.key);
            assert.equal(threadId, 9001);
            return {
              sourceChatKey: telegramSource.key,
              projectKey: 'project-key-1',
              canonicalProjectPath: projectRoot,
              displayName: 'worktree-a',
              topicName: 'worktree-a',
              messageThreadId: '9001',
            };
          },
          launchDetachedManagedSessionImpl: async (options) => {
            launchedSessions.push(options);
            return {
              sessionId: 'omx-topic-session-1',
              tmuxSessionName: 'omx-worktree-a-main',
              leaderPaneId: '%91',
              cwd: projectRoot,
            };
          },
          waitForCodexPaneReadyImpl: (paneId, timeoutMs) => {
            assert.equal(paneId, '%91');
            assert.equal(timeoutMs, 30_000);
            return true;
          },
          submitPromptToCodexPaneImpl: async (paneId, text) => {
            submittedPrompts.push({ paneId, text });
            return true;
          },
          registerMessageImpl: (mapping) => {
            registeredMappings.push(mapping);
            return true;
          },
        },
      );

      assert.equal(state.telegramLastUpdateId, 60);
      assert.equal(state.messagesInjected, 1);
      assert.equal(state.errors, 0);
      assert.equal(state.sourceStates[telegramSource.key]?.lastFailureAt, null);
      assert.equal(state.sourceStates[telegramSource.key]?.lastFailureCategory, null);
      assert.equal(state.sourceStates[telegramSource.key]?.lastFailureMessage, null);
      assert.deepEqual(launchedSessions, [
        {
          cwd: projectRoot,
          codexHomeOverride: undefined,
          notifyProfile: null,
        },
      ]);
      assert.deepEqual(submittedPrompts, [
        { paneId: '%91', text: 'Investigate this topic from Telegram' },
      ]);
      assert.equal(registeredMappings.length, 1);
      assert.equal(registeredMappings[0]?.messageId, '551');
      assert.equal(registeredMappings[0]?.sessionId, 'omx-topic-session-1');
      assert.equal(registeredMappings[0]?.tmuxPaneId, '%91');
      assert.equal(registeredMappings[0]?.messageThreadId, '9001');
      assert.equal(registeredMappings[0]?.topicName, 'worktree-a');

      const parsedBody = JSON.parse(sentBodies[0] ?? '{}') as {
        text: string;
        reply_to_message_id: number;
        message_thread_id: number;
      };
      assert.equal(parsedBody.reply_to_message_id, 350);
      assert.equal(parsedBody.message_thread_id, 9001);
      assert.equal(parsedBody.text, 'Starting a new Codex chat — working on it…');

      const origin = await consumePendingReplyOrigin(
        projectRoot,
        'omx-topic-session-1',
        'Investigate this topic from Telegram',
      );
      assert.deepEqual(origin?.telegramAck, {
        chatId: '777',
        messageId: '551',
        messageThreadId: '9001',
      });
      assert.deepEqual(origin?.telegramReplyTo, {
        chatId: '777',
        messageId: '350',
        messageThreadId: '9001',
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('launches a Telegram project topic with captioned media and submits the rendered prompt', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig();
    const state = createBaseState();
    const telegramSource = buildTelegramReplySource(config.telegramBotToken!, config.telegramChatId!);
    const attachmentRoot = await mkdtemp(join(tmpdir(), 'omx-telegram-topic-attachments-'));
    const projectRoot = await mkdtemp(join(tmpdir(), 'omx-telegram-topic-project-'));
    const previousAttachmentDir = process.env.OMX_TELEGRAM_ATTACHMENT_DIR;
    process.env.OMX_TELEGRAM_ATTACHMENT_DIR = attachmentRoot;
    const submittedPrompts: Array<{ paneId: string; text: string }> = [];

    try {
      await pollTelegramOnce(
        config,
        state,
        new RateLimiter(10),
        {
          httpsRequestImpl: createHttpsRequestMock({
            [`GET /bot${config.telegramBotToken}/getUpdates?offset=0&timeout=30&allowed_updates=%5B%22message%22%5D`]: () => ({
              statusCode: 200,
              body: {
                ok: true,
                result: [
                  {
                    update_id: 61,
                    message: {
                      message_id: 351,
                      message_thread_id: 9001,
                      chat: { id: 777, type: 'supergroup' },
                      from: { id: 'telegram-user-1' },
                      caption: 'Investigate this screenshot from Telegram topic',
                      photo: [{ file_id: 'topic-photo', width: 100, height: 200, file_size: 8 }],
                    },
                  },
                ],
              },
            }),
            [`GET /bot${config.telegramBotToken}/getFile?file_id=topic-photo`]: () => ({
              statusCode: 200,
              body: { ok: true, result: { file_path: 'photos/topic.jpg', file_size: 8 } },
            }),
            [`GET /file/bot${config.telegramBotToken}/photos/topic.jpg`]: () => ({ statusCode: 200, body: 'topicimg' }),
            [`POST /bot${config.telegramBotToken}/sendMessage`]: () => ({
              statusCode: 200,
              body: { ok: true, result: { message_id: 552, message_thread_id: 9001 } },
            }),
          }),
          getNotificationConfigImpl: () => ({
            enabled: true,
            telegram: {
              enabled: true,
              botToken: config.telegramBotToken,
              chatId: config.telegramChatId,
              projectTopics: { enabled: true },
            },
          }) as any,
          findTopicRecordByThreadIdImpl: async () => ({
            sourceChatKey: telegramSource.key,
            projectKey: 'project-key-1',
            canonicalProjectPath: projectRoot,
            displayName: 'worktree-a',
            topicName: 'worktree-a',
            messageThreadId: '9001',
          }),
          launchDetachedManagedSessionImpl: async () => ({
            sessionId: 'omx-topic-session-media',
            tmuxSessionName: 'omx-worktree-a-main',
            leaderPaneId: '%91',
            cwd: '/repos/worktree-a',
          }),
          waitForCodexPaneReadyImpl: () => true,
          submitPromptToCodexPaneImpl: async (paneId, text) => {
            submittedPrompts.push({ paneId, text });
            return true;
          },
          registerMessageImpl: () => true,
        },
      );

      const savedPath = await findSavedAttachmentPath(attachmentRoot, '777-351-1-photo.jpg');
      assert.equal(await readFile(savedPath, 'utf-8'), 'topicimg');
      assert.equal(submittedPrompts.length, 1);
      assert.equal(submittedPrompts[0]?.paneId, '%91');
      assert.match(submittedPrompts[0]?.text ?? '', /Investigate this screenshot/);
      assert.match(submittedPrompts[0]?.text ?? '', /777-351-1-photo\.jpg/);
      const origin = await consumePendingReplyOrigin(
        projectRoot,
        'omx-topic-session-media',
        submittedPrompts[0]?.text ?? '',
      );
      assert.equal(origin?.platform, 'telegram');
      assert.match(origin?.injectedInput ?? '', /777-351-1-photo\.jpg/);
      assert.equal(state.messagesInjected, 1);
      assert.equal(state.telegramLastUpdateId, 61);
    } finally {
      if (previousAttachmentDir === undefined) {
        delete process.env.OMX_TELEGRAM_ATTACHMENT_DIR;
      } else {
        process.env.OMX_TELEGRAM_ATTACHMENT_DIR = previousAttachmentDir;
      }
      await rm(attachmentRoot, { recursive: true, force: true });
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rate-limits Telegram topic media before downloading attachments', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig();
    const state = createBaseState();
    const telegramSource = buildTelegramReplySource(config.telegramBotToken!, config.telegramChatId!);
    const blockedRateLimiter: ReplyListenerRateLimiter = {
      canProceed: () => false,
      reset: () => {},
    };

    await pollTelegramOnce(
      config,
      state,
      blockedRateLimiter,
      {
        httpsRequestImpl: createHttpsRequestMock({
          [`GET /bot${config.telegramBotToken}/getUpdates?offset=0&timeout=30&allowed_updates=%5B%22message%22%5D`]: () => ({
            statusCode: 200,
            body: {
              ok: true,
              result: [
                {
                  update_id: 62,
                  message: {
                    message_id: 352,
                    message_thread_id: 9001,
                    chat: { id: 777, type: 'supergroup' },
                    from: { id: 'telegram-user-1' },
                    caption: 'do not download yet',
                    photo: [{ file_id: 'topic-photo-rate-limited', width: 100, height: 200, file_size: 8 }],
                  },
                },
              ],
            },
          }),
        }),
        getNotificationConfigImpl: () => ({
          enabled: true,
          telegram: {
            enabled: true,
            botToken: config.telegramBotToken,
            chatId: config.telegramChatId,
            projectTopics: { enabled: true },
          },
        }) as any,
        findTopicRecordByThreadIdImpl: async () => ({
          sourceChatKey: telegramSource.key,
          projectKey: 'project-key-1',
          canonicalProjectPath: '/repos/worktree-a',
          displayName: 'worktree-a',
          topicName: 'worktree-a',
          messageThreadId: '9001',
        }),
        launchDetachedManagedSessionImpl: async () => {
          throw new Error('topic launch should not run when rate-limited');
        },
        submitPromptToCodexPaneImpl: async () => {
          throw new Error('prompt submit should not run when rate-limited');
        },
      },
    );

    assert.equal(state.messagesInjected, 0);
    assert.equal(state.errors, 1);
    assert.equal(state.telegramLastUpdateId, null);
  });

  it('keeps topic-launch diagnostics when acknowledgement registration fails', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig();
    const state = createBaseState();
    const telegramSource = buildTelegramReplySource(config.telegramBotToken!, config.telegramChatId!);
    state.sourceStates[telegramSource.key] = {
      sourceKey: telegramSource.key,
      platform: 'telegram',
      label: telegramSource.label,
      telegramLastUpdateId: null,
      telegramStartupPolicyApplied: true,
      lastPollAt: '2026-03-20T00:00:00.000Z',
      lastIngestAt: null,
      lastFailureAt: '2026-03-20T00:00:01.000Z',
      lastFailureCategory: 'topic-launch-failure',
      lastFailureMessage: 'previous launcher resolution failure',
      failureCounts: { 'topic-launch-failure': 1 },
    };

    await pollTelegramOnce(
      config,
      state,
      new RateLimiter(10),
      {
        httpsRequestImpl: createHttpsRequestMock({
          [`GET /bot${config.telegramBotToken}/getUpdates?offset=0&timeout=30&allowed_updates=%5B%22message%22%5D`]: () => ({
            statusCode: 200,
            body: {
              ok: true,
              result: [
                {
                  update_id: 61,
                  message: {
                    message_id: 351,
                    message_thread_id: 9001,
                    chat: { id: 777, type: 'supergroup' },
                    from: { id: 'telegram-user-1' },
                    text: 'launch from topic but registration fails',
                  },
                },
              ],
            },
          }),
          [`POST /bot${config.telegramBotToken}/sendMessage`]: () => ({
            statusCode: 200,
            body: { ok: true, result: { message_id: 559, message_thread_id: 9001 } },
          }),
        }),
        getNotificationConfigImpl: () => ({
          enabled: true,
          telegram: {
            enabled: true,
            botToken: config.telegramBotToken,
            chatId: config.telegramChatId,
            projectTopics: { enabled: true },
          },
        }) as any,
        findTopicRecordByThreadIdImpl: async () => ({
          sourceChatKey: telegramSource.key,
          projectKey: 'project-key-1',
          canonicalProjectPath: '/repos/worktree-a',
          displayName: 'worktree-a',
          topicName: 'worktree-a',
          messageThreadId: '9001',
        }),
        launchDetachedManagedSessionImpl: async () => ({
          sessionId: 'omx-topic-session-registration-fail',
          tmuxSessionName: 'omx-worktree-a-registration-fail',
          leaderPaneId: '%91',
          cwd: '/repos/worktree-a',
        }),
        waitForCodexPaneReadyImpl: () => true,
        submitPromptToCodexPaneImpl: async () => true,
        registerMessageImpl: () => false,
      },
    );

    assert.equal(state.telegramLastUpdateId, 61);
    assert.equal(state.messagesInjected, 1);
    assert.equal(state.errors, 1);
    assert.equal(state.sourceStates[telegramSource.key]?.lastFailureCategory, 'topic-launch-ack-registration-failure');
    assert.match(state.sourceStates[telegramSource.key]?.lastFailureMessage ?? '', /559/);
    assert.equal(state.sourceStates[telegramSource.key]?.failureCounts?.['topic-launch-failure'], 1);
    assert.equal(state.sourceStates[telegramSource.key]?.failureCounts?.['topic-launch-ack-registration-failure'], 1);
  });

  it('routes replies to the registered Telegram launch acknowledgement back into the freshly started session', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig();
    const state = createBaseState();
    const telegramSource = buildTelegramReplySource(config.telegramBotToken!, config.telegramChatId!);
    let registeredAck: SessionMapping | null = null;
    const injected: Array<{ paneId: string; text: string; sessionName?: string }> = [];

    await pollTelegramOnce(
      config,
      state,
      new RateLimiter(10),
      {
        httpsRequestImpl: createHttpsRequestMock({
          [`GET /bot${config.telegramBotToken}/getUpdates?offset=0&timeout=30&allowed_updates=%5B%22message%22%5D`]: () => ({
            statusCode: 200,
            body: {
              ok: true,
              result: [
                {
                  update_id: 64,
                  message: {
                    message_id: 360,
                    message_thread_id: 9001,
                    chat: { id: 777, type: 'supergroup' },
                    from: { id: 'telegram-user-1' },
                    text: 'launch from topic',
                  },
                },
              ],
            },
          }),
          [`POST /bot${config.telegramBotToken}/sendMessage`]: () => ({
            statusCode: 200,
            body: { ok: true, result: { message_id: 551, message_thread_id: 9001 } },
          }),
        }),
        getNotificationConfigImpl: () => ({
          enabled: true,
          telegram: {
            enabled: true,
            botToken: config.telegramBotToken,
            chatId: config.telegramChatId,
            projectTopics: { enabled: true },
          },
        }) as any,
        findTopicRecordByThreadIdImpl: async () => ({
          sourceChatKey: telegramSource.key,
          projectKey: 'project-key-1',
          canonicalProjectPath: '/repos/worktree-a',
          displayName: 'worktree-a',
          topicName: 'worktree-a',
          messageThreadId: '9001',
        }),
        launchDetachedManagedSessionImpl: async () => ({
          sessionId: 'omx-topic-session-1',
          tmuxSessionName: 'omx-worktree-a-main',
          leaderPaneId: '%91',
          cwd: '/repos/worktree-a',
        }),
        waitForCodexPaneReadyImpl: () => true,
        submitPromptToCodexPaneImpl: async () => true,
        registerMessageImpl: (mapping) => {
          registeredAck = mapping;
          return true;
        },
      },
    );

    assert.ok(registeredAck);

    await pollTelegramOnce(
      config,
      state,
      new RateLimiter(10),
      {
        httpsRequestImpl: createHttpsRequestMock({
          [`GET /bot${config.telegramBotToken}/getUpdates?offset=65&timeout=30&allowed_updates=%5B%22message%22%5D`]: () => ({
            statusCode: 200,
            body: {
              ok: true,
              result: [
                {
                  update_id: 65,
                  message: {
                    message_id: 361,
                    message_thread_id: 9001,
                    chat: { id: 777, type: 'supergroup' },
                    from: { id: 'telegram-user-1' },
                    text: 'follow up in the launched session',
                    reply_to_message: { message_id: 551 },
                  },
                },
              ],
            },
          }),
          [`POST /bot${config.telegramBotToken}/sendMessage`]: () => ({
            statusCode: 200,
            body: { ok: true, result: { message_id: 552, message_thread_id: 9001 } },
          }),
        }),
        lookupByMessageIdImpl: (_platform, messageId, sourceKey) => {
          if (messageId === '551' && sourceKey === telegramSource.key) {
            return registeredAck;
          }
          return null;
        },
        injectReplyImpl: (paneId, text, _platform, _config, options) => {
          injected.push({
            paneId,
            text,
            sessionName: options?.expectedSessionName,
          });
          return true;
        },
      },
    );

    assert.deepEqual(injected, [
      {
        paneId: '%91',
        text: 'follow up in the launched session',
        sessionName: 'omx-worktree-a-main',
      },
    ]);
    assert.equal(state.telegramLastUpdateId, 65);
    assert.equal(state.messagesInjected, 2);
  });

  it('reports a bounded failure when a launched Telegram topic session never becomes ready for the first prompt', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig();
    const state = createBaseState();
    const telegramSource = buildTelegramReplySource(config.telegramBotToken!, config.telegramChatId!);
    let sendMessageBody = '';
    let registerCalled = false;

    await pollTelegramOnce(
      config,
      state,
      new RateLimiter(10),
      {
        httpsRequestImpl: createHttpsRequestMock({
          [`GET /bot${config.telegramBotToken}/getUpdates?offset=0&timeout=30&allowed_updates=%5B%22message%22%5D`]: () => ({
            statusCode: 200,
            body: {
              ok: true,
              result: [
                {
                  update_id: 66,
                  message: {
                    message_id: 362,
                    message_thread_id: 9001,
                    chat: { id: 777, type: 'supergroup' },
                    from: { id: 'telegram-user-1' },
                    text: 'launch but never get ready',
                  },
                },
              ],
            },
          }),
          [`POST /bot${config.telegramBotToken}/sendMessage`]: (body) => {
            sendMessageBody = body;
            return { statusCode: 200, body: { ok: true, result: { message_id: 553, message_thread_id: 9001 } } };
          },
        }),
        getNotificationConfigImpl: () => ({
          enabled: true,
          telegram: {
            enabled: true,
            botToken: config.telegramBotToken,
            chatId: config.telegramChatId,
            projectTopics: { enabled: true },
          },
        }) as any,
        findTopicRecordByThreadIdImpl: async () => ({
          sourceChatKey: telegramSource.key,
          projectKey: 'project-key-1',
          canonicalProjectPath: '/repos/worktree-a',
          displayName: 'worktree-a',
          topicName: 'worktree-a',
          messageThreadId: '9001',
        }),
        launchDetachedManagedSessionImpl: async () => ({
          sessionId: 'omx-topic-session-2',
          tmuxSessionName: 'omx-worktree-a-main',
          leaderPaneId: '%92',
          cwd: '/repos/worktree-a',
        }),
        waitForCodexPaneReadyImpl: () => false,
        submitPromptToCodexPaneImpl: async () => {
          throw new Error('submit should not run when readiness times out');
        },
        registerMessageImpl: () => {
          registerCalled = true;
          return true;
        },
      },
    );

    assert.equal(state.telegramLastUpdateId, 66);
    assert.equal(state.messagesInjected, 0);
    assert.equal(state.errors, 1);
    assert.equal(registerCalled, false);
    const parsedBody = JSON.parse(sendMessageBody) as { text: string; reply_to_message_id: number };
    assert.equal(parsedBody.reply_to_message_id, 362);
    assert.match(parsedBody.text, /did not become ready/i);
  });

  it('reports a bounded failure when a launched Telegram topic session cannot accept the first prompt', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig();
    const state = createBaseState();
    const telegramSource = buildTelegramReplySource(config.telegramBotToken!, config.telegramChatId!);
    const projectRoot = await mkdtemp(join(tmpdir(), 'omx-telegram-topic-submit-failure-'));
    const requestOrder: string[] = [];
    const sendMessageBodies: Array<Record<string, unknown>> = [];
    const deleteBodies: Array<Record<string, unknown>> = [];
    let registerCalled = false;

    try {
      await pollTelegramOnce(
        config,
        state,
        new RateLimiter(10),
        {
          httpsRequestImpl: createHttpsRequestMock({
          [`GET /bot${config.telegramBotToken}/getUpdates?offset=0&timeout=30&allowed_updates=%5B%22message%22%5D`]: () => ({
            statusCode: 200,
            body: {
              ok: true,
              result: [
                {
                  update_id: 67,
                  message: {
                    message_id: 363,
                    message_thread_id: 9001,
                    chat: { id: 777, type: 'supergroup' },
                    from: { id: 'telegram-user-1' },
                    text: 'launch but fail prompt submit',
                  },
                },
              ],
            },
          }),
          [`POST /bot${config.telegramBotToken}/sendMessage`]: (body) => {
            requestOrder.push('sendMessage');
            sendMessageBodies.push(JSON.parse(body) as Record<string, unknown>);
            return {
              statusCode: 200,
              body: {
                ok: true,
                result: {
                  message_id: sendMessageBodies.length === 1 ? 554 : 555,
                  message_thread_id: 9001,
                },
              },
            };
          },
          [`POST /bot${config.telegramBotToken}/deleteMessage`]: (body) => {
            requestOrder.push('deleteMessage');
            deleteBodies.push(JSON.parse(body) as Record<string, unknown>);
            return {
              statusCode: 200,
              body: { ok: true, result: true },
            };
          },
        }),
          getNotificationConfigImpl: () => ({
            enabled: true,
            telegram: {
              enabled: true,
              botToken: config.telegramBotToken,
              chatId: config.telegramChatId,
              projectTopics: { enabled: true },
            },
          }) as any,
          findTopicRecordByThreadIdImpl: async () => ({
            sourceChatKey: telegramSource.key,
            projectKey: 'project-key-1',
            canonicalProjectPath: projectRoot,
            displayName: 'worktree-a',
            topicName: 'worktree-a',
            messageThreadId: '9001',
          }),
          launchDetachedManagedSessionImpl: async () => ({
            sessionId: 'omx-topic-session-3',
            tmuxSessionName: 'omx-worktree-a-main',
            leaderPaneId: '%93',
            cwd: projectRoot,
          }),
          waitForCodexPaneReadyImpl: () => true,
          submitPromptToCodexPaneImpl: async () => false,
          registerMessageImpl: () => {
            registerCalled = true;
            return true;
          },
        },
      );

      assert.equal(state.telegramLastUpdateId, 67);
      assert.equal(state.messagesInjected, 0);
      assert.equal(state.errors, 1);
      assert.equal(registerCalled, true);
      assert.deepEqual(requestOrder, ['sendMessage', 'deleteMessage', 'sendMessage']);
      assert.deepEqual(deleteBodies[0], { chat_id: '777', message_id: '554' });
      const parsedBody = sendMessageBodies[1] as { text: string; reply_to_message_id: number };
      assert.equal(parsedBody.reply_to_message_id, 363);
      assert.match(parsedBody.text, /failed to deliver the first prompt/i);
      assert.equal(existsSync(pendingRoutesStatePath(projectRoot, 'omx-topic-session-3')), false);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('returns a clear diagnostic for non-reply Telegram messages outside a project topic when topic entry is enabled', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig();
    let sendMessageBody = '';

    await pollTelegramOnce(
      config,
      createBaseState(),
      new RateLimiter(10),
      {
        httpsRequestImpl: createHttpsRequestMock({
          [`GET /bot${config.telegramBotToken}/getUpdates?offset=0&timeout=30&allowed_updates=%5B%22message%22%5D`]: () => ({
            statusCode: 200,
            body: {
              ok: true,
              result: [
                {
                  update_id: 61,
                  message: {
                    message_id: 351,
                    chat: { id: 777, type: 'supergroup' },
                    from: { id: 'telegram-user-1' },
                    text: 'start something here',
                  },
                },
              ],
            },
          }),
          [`POST /bot${config.telegramBotToken}/sendMessage`]: (body) => {
            sendMessageBody = body;
            return { statusCode: 200, body: { ok: true, result: { message_id: 552 } } };
          },
        }),
        getNotificationConfigImpl: () => ({
          enabled: true,
          telegram: {
            enabled: true,
            botToken: config.telegramBotToken,
            chatId: config.telegramChatId,
            projectTopics: { enabled: true },
          },
        }) as any,
        findTopicRecordByThreadIdImpl: async () => {
          throw new Error('topic lookup should not run without a message_thread_id');
        },
        launchDetachedManagedSessionImpl: async () => {
          throw new Error('launch should not run outside a topic');
        },
      },
    );

    const parsedBody = JSON.parse(sendMessageBody) as { text: string };
    assert.match(parsedBody.text, /known project topic/i);
  });

  it('refuses to start a detached OMX session from an unknown Telegram topic', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig();
    let sendMessageBody = '';

    await pollTelegramOnce(
      config,
      createBaseState(),
      new RateLimiter(10),
      {
        httpsRequestImpl: createHttpsRequestMock({
          [`GET /bot${config.telegramBotToken}/getUpdates?offset=0&timeout=30&allowed_updates=%5B%22message%22%5D`]: () => ({
            statusCode: 200,
            body: {
              ok: true,
              result: [
                {
                  update_id: 62,
                  message: {
                    message_id: 352,
                    message_thread_id: 9876,
                    chat: { id: 777, type: 'supergroup' },
                    from: { id: 'telegram-user-1' },
                    text: 'start from an unknown topic',
                  },
                },
              ],
            },
          }),
          [`POST /bot${config.telegramBotToken}/sendMessage`]: (body) => {
            sendMessageBody = body;
            return { statusCode: 200, body: { ok: true, result: { message_id: 553 } } };
          },
        }),
        getNotificationConfigImpl: () => ({
          enabled: true,
          telegram: {
            enabled: true,
            botToken: config.telegramBotToken,
            chatId: config.telegramChatId,
            projectTopics: { enabled: true },
          },
        }) as any,
        findTopicRecordByThreadIdImpl: async () => null,
        launchDetachedManagedSessionImpl: async () => {
          throw new Error('launch should not run when the topic is unbound');
        },
      },
    );

    const parsedBody = JSON.parse(sendMessageBody) as { text: string; message_thread_id: number };
    assert.equal(parsedBody.message_thread_id, 9876);
    assert.match(parsedBody.text, /not bound to an omx project/i);
  });

  it('reports detached topic launch failures back into the same Telegram topic', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig();
    const state = createBaseState();
    const telegramSource = buildTelegramReplySource(config.telegramBotToken!, config.telegramChatId!);
    let sendMessageBody = '';

    await pollTelegramOnce(
      config,
      state,
      new RateLimiter(10),
      {
        httpsRequestImpl: createHttpsRequestMock({
          [`GET /bot${config.telegramBotToken}/getUpdates?offset=0&timeout=30&allowed_updates=%5B%22message%22%5D`]: () => ({
            statusCode: 200,
            body: {
              ok: true,
              result: [
                {
                  update_id: 63,
                  message: {
                    message_id: 353,
                    message_thread_id: 9001,
                    chat: { id: 777, type: 'supergroup' },
                    from: { id: 'telegram-user-1' },
                    text: 'start from a failing topic',
                  },
                },
              ],
            },
          }),
          [`POST /bot${config.telegramBotToken}/sendMessage`]: (body) => {
            sendMessageBody = body;
            return { statusCode: 200, body: { ok: true, result: { message_id: 554, message_thread_id: 9001 } } };
          },
        }),
        getNotificationConfigImpl: () => ({
          enabled: true,
          telegram: {
            enabled: true,
            botToken: config.telegramBotToken,
            chatId: config.telegramChatId,
            projectTopics: { enabled: true },
          },
        }) as any,
        findTopicRecordByThreadIdImpl: async () => ({
          sourceChatKey: telegramSource.key,
          projectKey: 'project-key-1',
          canonicalProjectPath: '/repos/worktree-a',
          displayName: 'worktree-a',
          topicName: 'worktree-a',
          messageThreadId: '9001',
        }),
        launchDetachedManagedSessionImpl: async () => {
          throw new Error('tmux bootstrap failed');
        },
        registerMessageImpl: () => {
          throw new Error('launch acknowledgements must not register after launch failure');
        },
      },
    );

    assert.equal(state.errors, 1);
    const parsedBody = JSON.parse(sendMessageBody) as { text: string };
    assert.match(parsedBody.text, /failed to start a new omx session/i);
    assert.match(parsedBody.text, /tmux bootstrap failed/i);
  });

  it('cleans up the detached session when the topic-launched pane never becomes ready', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig();
    const state = createBaseState();
    const telegramSource = buildTelegramReplySource(config.telegramBotToken!, config.telegramChatId!);
    const killedSessions: string[] = [];
    let sendMessageBody = '';

    await pollTelegramOnce(
      config,
      state,
      new RateLimiter(10),
      {
        httpsRequestImpl: createHttpsRequestMock({
          [`GET /bot${config.telegramBotToken}/getUpdates?offset=0&timeout=30&allowed_updates=%5B%22message%22%5D`]: () => ({
            statusCode: 200,
            body: {
              ok: true,
              result: [
                {
                  update_id: 64,
                  message: {
                    message_id: 354,
                    message_thread_id: 9001,
                    chat: { id: 777, type: 'supergroup' },
                    from: { id: 'telegram-user-1' },
                    text: 'start but never get ready',
                  },
                },
              ],
            },
          }),
          [`POST /bot${config.telegramBotToken}/sendMessage`]: (body) => {
            sendMessageBody = body;
            return { statusCode: 200, body: { ok: true, result: { message_id: 555, message_thread_id: 9001 } } };
          },
        }),
        getNotificationConfigImpl: () => ({
          enabled: true,
          telegram: {
            enabled: true,
            botToken: config.telegramBotToken,
            chatId: config.telegramChatId,
            projectTopics: { enabled: true },
          },
        }) as any,
        findTopicRecordByThreadIdImpl: async () => ({
          sourceChatKey: telegramSource.key,
          projectKey: 'project-key-1',
          canonicalProjectPath: '/repos/worktree-a',
          displayName: 'worktree-a',
          topicName: 'worktree-a',
          messageThreadId: '9001',
        }),
        launchDetachedManagedSessionImpl: async () => ({
          sessionId: 'omx-topic-session-2',
          tmuxSessionName: 'omx-worktree-a-detached',
          leaderPaneId: '%92',
          cwd: '/repos/worktree-a',
        }),
        waitForCodexPaneReadyImpl: () => false,
        killDetachedManagedSessionImpl: async (sessionName) => {
          killedSessions.push(sessionName);
          return true;
        },
        registerMessageImpl: () => {
          throw new Error('readiness timeout must not register a launch acknowledgement');
        },
      },
    );

    assert.equal(state.errors, 1);
    assert.deepEqual(killedSessions, ['omx-worktree-a-detached']);
    const parsedBody = JSON.parse(sendMessageBody) as { text: string };
    assert.match(parsedBody.text, /did not become ready/i);
  });

  it('surfaces a trust-confirmation diagnostic when a topic launch is blocked by Codex trust gating', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig();
    const state = createBaseState();
    const telegramSource = buildTelegramReplySource(config.telegramBotToken!, config.telegramChatId!);
    let sendMessageBody = '';

    await pollTelegramOnce(
      config,
      state,
      new RateLimiter(10),
      {
        httpsRequestImpl: createHttpsRequestMock({
          [`GET /bot${config.telegramBotToken}/getUpdates?offset=0&timeout=30&allowed_updates=%5B%22message%22%5D`]: () => ({
            statusCode: 200,
            body: {
              ok: true,
              result: [
                {
                  update_id: 65,
                  message: {
                    message_id: 356,
                    message_thread_id: 9001,
                    chat: { id: 777, type: 'supergroup' },
                    from: { id: 'telegram-user-1' },
                    text: 'start but trust prompt blocks',
                  },
                },
              ],
            },
          }),
          [`POST /bot${config.telegramBotToken}/sendMessage`]: (body) => {
            sendMessageBody = body;
            return { statusCode: 200, body: { ok: true, result: { message_id: 557, message_thread_id: 9001 } } };
          },
        }),
        getNotificationConfigImpl: () => ({
          enabled: true,
          telegram: {
            enabled: true,
            botToken: config.telegramBotToken,
            chatId: config.telegramChatId,
            projectTopics: { enabled: true },
          },
        }) as any,
        findTopicRecordByThreadIdImpl: async () => ({
          sourceChatKey: telegramSource.key,
          projectKey: 'project-key-1',
          canonicalProjectPath: '/repos/worktree-a',
          displayName: 'worktree-a',
          topicName: 'worktree-a',
          messageThreadId: '9001',
        }),
        launchDetachedManagedSessionImpl: async () => ({
          sessionId: 'omx-topic-session-2b',
          tmuxSessionName: 'omx-worktree-a-trust-gated',
          leaderPaneId: '%92',
          cwd: '/repos/worktree-a',
        }),
        waitForCodexPaneReadyImpl: () => false,
        detectCodexBlockingPanePromptImpl: () => 'trust',
        killDetachedManagedSessionImpl: async () => true,
      },
    );

    const parsedBody = JSON.parse(sendMessageBody) as { text: string };
    assert.match(parsedBody.text, /trust the project locally/i);
  });

  it('cleans up the detached session when the first prompt cannot be submitted', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig();
    const state = createBaseState();
    const telegramSource = buildTelegramReplySource(config.telegramBotToken!, config.telegramChatId!);
    const killedSessions: string[] = [];
    const requestOrder: string[] = [];
    const sendMessageBodies: Array<Record<string, unknown>> = [];
    const deleteBodies: Array<Record<string, unknown>> = [];

    await pollTelegramOnce(
      config,
      state,
      new RateLimiter(10),
      {
        httpsRequestImpl: createHttpsRequestMock({
          [`GET /bot${config.telegramBotToken}/getUpdates?offset=0&timeout=30&allowed_updates=%5B%22message%22%5D`]: () => ({
            statusCode: 200,
            body: {
              ok: true,
              result: [
                {
                  update_id: 65,
                  message: {
                    message_id: 355,
                    message_thread_id: 9001,
                    chat: { id: 777, type: 'supergroup' },
                    from: { id: 'telegram-user-1' },
                    text: 'start but fail to submit',
                  },
                },
              ],
            },
          }),
          [`POST /bot${config.telegramBotToken}/sendMessage`]: (body) => {
            requestOrder.push('sendMessage');
            sendMessageBodies.push(JSON.parse(body) as Record<string, unknown>);
            return {
              statusCode: 200,
              body: {
                ok: true,
                result: {
                  message_id: sendMessageBodies.length === 1 ? 556 : 557,
                  message_thread_id: 9001,
                },
              },
            };
          },
          [`POST /bot${config.telegramBotToken}/deleteMessage`]: (body) => {
            requestOrder.push('deleteMessage');
            deleteBodies.push(JSON.parse(body) as Record<string, unknown>);
            return {
              statusCode: 200,
              body: { ok: true, result: true },
            };
          },
        }),
        getNotificationConfigImpl: () => ({
          enabled: true,
          telegram: {
            enabled: true,
            botToken: config.telegramBotToken,
            chatId: config.telegramChatId,
            projectTopics: { enabled: true },
          },
        }) as any,
        findTopicRecordByThreadIdImpl: async () => ({
          sourceChatKey: telegramSource.key,
          projectKey: 'project-key-1',
          canonicalProjectPath: '/repos/worktree-a',
          displayName: 'worktree-a',
          topicName: 'worktree-a',
          messageThreadId: '9001',
        }),
        launchDetachedManagedSessionImpl: async () => ({
          sessionId: 'omx-topic-session-3',
          tmuxSessionName: 'omx-worktree-a-submit-failure',
          leaderPaneId: '%93',
          cwd: '/repos/worktree-a',
        }),
        waitForCodexPaneReadyImpl: () => true,
        submitPromptToCodexPaneImpl: async () => false,
        killDetachedManagedSessionImpl: async (sessionName) => {
          killedSessions.push(sessionName);
          return true;
        },
        registerMessageImpl: () => true,
      },
    );

    assert.equal(state.errors, 1);
    assert.deepEqual(killedSessions, ['omx-worktree-a-submit-failure']);
    assert.deepEqual(requestOrder, ['sendMessage', 'deleteMessage', 'sendMessage']);
    assert.deepEqual(deleteBodies[0], { chat_id: '777', message_id: '556' });
    const parsedBody = sendMessageBodies[1] as { text: string };
    assert.match(parsedBody.text, /failed to deliver the first prompt/i);
  });

  it('surfaces a permissions-confirmation diagnostic when a topic launch is blocked during first-prompt submission', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig();
    const state = createBaseState();
    const telegramSource = buildTelegramReplySource(config.telegramBotToken!, config.telegramChatId!);
    const requestOrder: string[] = [];
    const sendMessageBodies: Array<Record<string, unknown>> = [];
    const deleteBodies: Array<Record<string, unknown>> = [];

    await pollTelegramOnce(
      config,
      state,
      new RateLimiter(10),
      {
        httpsRequestImpl: createHttpsRequestMock({
          [`GET /bot${config.telegramBotToken}/getUpdates?offset=0&timeout=30&allowed_updates=%5B%22message%22%5D`]: () => ({
            statusCode: 200,
            body: {
              ok: true,
              result: [
                {
                  update_id: 66,
                  message: {
                    message_id: 357,
                    message_thread_id: 9001,
                    chat: { id: 777, type: 'supergroup' },
                    from: { id: 'telegram-user-1' },
                    text: 'start but permissions prompt blocks',
                  },
                },
              ],
            },
          }),
          [`POST /bot${config.telegramBotToken}/sendMessage`]: (body) => {
            requestOrder.push('sendMessage');
            sendMessageBodies.push(JSON.parse(body) as Record<string, unknown>);
            return {
              statusCode: 200,
              body: {
                ok: true,
                result: {
                  message_id: sendMessageBodies.length === 1 ? 558 : 559,
                  message_thread_id: 9001,
                },
              },
            };
          },
          [`POST /bot${config.telegramBotToken}/deleteMessage`]: (body) => {
            requestOrder.push('deleteMessage');
            deleteBodies.push(JSON.parse(body) as Record<string, unknown>);
            return {
              statusCode: 200,
              body: { ok: true, result: true },
            };
          },
        }),
        getNotificationConfigImpl: () => ({
          enabled: true,
          telegram: {
            enabled: true,
            botToken: config.telegramBotToken,
            chatId: config.telegramChatId,
            projectTopics: { enabled: true },
          },
        }) as any,
        findTopicRecordByThreadIdImpl: async () => ({
          sourceChatKey: telegramSource.key,
          projectKey: 'project-key-1',
          canonicalProjectPath: '/repos/worktree-a',
          displayName: 'worktree-a',
          topicName: 'worktree-a',
          messageThreadId: '9001',
        }),
        launchDetachedManagedSessionImpl: async () => ({
          sessionId: 'omx-topic-session-3b',
          tmuxSessionName: 'omx-worktree-a-bypass-gated',
          leaderPaneId: '%93',
          cwd: '/repos/worktree-a',
        }),
        waitForCodexPaneReadyImpl: () => true,
        submitPromptToCodexPaneImpl: async () => false,
        detectCodexBlockingPanePromptImpl: () => 'bypass',
        killDetachedManagedSessionImpl: async () => true,
        registerMessageImpl: () => true,
      },
    );

    assert.deepEqual(requestOrder, ['sendMessage', 'deleteMessage', 'sendMessage']);
    assert.deepEqual(deleteBodies[0], { chat_id: '777', message_id: '558' });
    const parsedBody = sendMessageBodies[1] as { text: string };
    assert.match(parsedBody.text, /permissions confirmation/i);
  });

  it('does not download media for untracked Telegram replies', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig();
    const state = createBaseState();
    let sendMessageBody = '';

    await pollTelegramOnce(
      config,
      state,
      new RateLimiter(10),
      {
        httpsRequestImpl: createHttpsRequestMock({
          [`GET /bot${config.telegramBotToken}/getUpdates?offset=0&timeout=30&allowed_updates=%5B%22message%22%5D`]: () => ({
            statusCode: 200,
            body: {
              ok: true,
              result: [
                {
                  update_id: 145,
                  message: {
                    message_id: 433,
                    message_thread_id: 9001,
                    chat: { id: 777 },
                    from: { id: 'telegram-user-1' },
                    caption: 'untracked screenshot',
                    photo: [{ file_id: 'must-not-download', width: 100, height: 100, file_size: 5 }],
                    reply_to_message: { message_id: 999999 },
                  },
                },
              ],
            },
          }),
          [`POST /bot${config.telegramBotToken}/sendMessage`]: (body) => {
            sendMessageBody = body;
            return { statusCode: 200, body: { ok: true, result: { message_id: 455 } } };
          },
        }),
        lookupByMessageIdImpl: () => null,
        injectReplyImpl: () => {
          throw new Error('injectReply should not run for untracked replies');
        },
      },
    );

    assert.equal(state.messagesInjected, 0);
    assert.equal(state.errors, 0);
    assert.match((JSON.parse(sendMessageBody) as { text: string }).text, /no tracked omx session/i);
  });

  it('does not download media for rate-limited Telegram replies', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig();
    const state = createBaseState();
    const blockedRateLimiter: ReplyListenerRateLimiter = {
      canProceed: () => false,
      reset: () => {},
    };

    await pollTelegramOnce(
      config,
      state,
      blockedRateLimiter,
      {
        httpsRequestImpl: createHttpsRequestMock({
          [`GET /bot${config.telegramBotToken}/getUpdates?offset=0&timeout=30&allowed_updates=%5B%22message%22%5D`]: () => ({
            statusCode: 200,
            body: {
              ok: true,
              result: [
                {
                  update_id: 146,
                  message: {
                    message_id: 434,
                    message_thread_id: 9001,
                    chat: { id: 777 },
                    from: { id: 'telegram-user-1' },
                    caption: 'rate limited screenshot',
                    photo: [{ file_id: 'must-not-download', width: 100, height: 100, file_size: 5 }],
                    reply_to_message: { message_id: 222 },
                  },
                },
              ],
            },
          }),
        }),
        lookupByMessageIdImpl: () => createMapping('telegram'),
        injectReplyImpl: () => {
          throw new Error('injectReply should not run when rate-limited');
        },
      },
    );

    assert.equal(state.messagesInjected, 0);
    assert.equal(state.errors, 1);
    assert.equal(state.telegramLastUpdateId, null);
  });

  it('does not download media for Telegram status probes', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig();
    const state = createBaseState();
    let sendMessageBody = '';

    await pollTelegramOnce(
      config,
      state,
      new RateLimiter(10),
      {
        httpsRequestImpl: createHttpsRequestMock({
          [`GET /bot${config.telegramBotToken}/getUpdates?offset=0&timeout=30&allowed_updates=%5B%22message%22%5D`]: () => ({
            statusCode: 200,
            body: {
              ok: true,
              result: [
                {
                  update_id: 147,
                  message: {
                    message_id: 435,
                    message_thread_id: 9001,
                    chat: { id: 777 },
                    from: { id: 'telegram-user-1' },
                    caption: 'status',
                    photo: [{ file_id: 'must-not-download', width: 100, height: 100, file_size: 5 }],
                    reply_to_message: { message_id: 222 },
                  },
                },
              ],
            },
          }),
          [`POST /bot${config.telegramBotToken}/sendMessage`]: (body) => {
            sendMessageBody = body;
            return { statusCode: 200, body: { ok: true, result: { message_id: 456 } } };
          },
        }),
        lookupByMessageIdImpl: () => createMapping('telegram'),
        buildSessionStatusReplyImpl: async () => 'Tracked OMX session status',
        injectReplyImpl: () => {
          throw new Error('injectReply should not run for status probes');
        },
      },
    );

    assert.equal(state.messagesInjected, 0);
    assert.equal(state.errors, 0);
    assert.equal((JSON.parse(sendMessageBody) as { text: string }).text, 'Tracked OMX session status');
  });

  it('does not download media for unauthorized Telegram replies', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig();
    const state = createBaseState();
    let sendMessageBody = '';

    await pollTelegramOnce(
      config,
      state,
      new RateLimiter(10),
      {
        httpsRequestImpl: createHttpsRequestMock({
          [`GET /bot${config.telegramBotToken}/getUpdates?offset=0&timeout=30&allowed_updates=%5B%22message%22%5D`]: () => ({
            statusCode: 200,
            body: {
              ok: true,
              result: [
                {
                  update_id: 148,
                  message: {
                    message_id: 436,
                    message_thread_id: 9001,
                    chat: { id: 777 },
                    from: { id: 'intruder' },
                    caption: 'unauthorized screenshot',
                    photo: [{ file_id: 'must-not-download', width: 100, height: 100, file_size: 5 }],
                    reply_to_message: { message_id: 222 },
                  },
                },
              ],
            },
          }),
          [`POST /bot${config.telegramBotToken}/sendMessage`]: (body) => {
            sendMessageBody = body;
            return { statusCode: 200, body: { ok: true, result: { message_id: 457 } } };
          },
        }),
        lookupByMessageIdImpl: () => {
          throw new Error('lookup should not run for unauthorized Telegram senders');
        },
        injectReplyImpl: () => {
          throw new Error('injectReply should not run for unauthorized Telegram senders');
        },
      },
    );

    assert.equal(state.messagesInjected, 0);
    assert.equal(state.errors, 0);
    assert.match((JSON.parse(sendMessageBody) as { text: string }).text, /not authorized/i);
  });

  it('rejects unauthorized Telegram senders even when the chat matches', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig();
    const state = createBaseState();
    let sendMessageBody = '';

    await pollTelegramOnce(
      config,
      state,
      new RateLimiter(10),
      {
        httpsRequestImpl: createHttpsRequestMock({
          [`GET /bot${config.telegramBotToken}/getUpdates?offset=0&timeout=30&allowed_updates=%5B%22message%22%5D`]: () => ({
            statusCode: 200,
            body: {
              ok: true,
              result: [
                {
                  update_id: 46,
                  message: {
                    message_id: 335,
                    message_thread_id: 9001,
                    chat: { id: 777 },
                    from: { id: 'intruder' },
                    text: 'wrong sender',
                    reply_to_message: { message_id: 222 },
                  },
                },
              ],
            },
          }),
          [`POST /bot${config.telegramBotToken}/sendMessage`]: (body) => {
            sendMessageBody = body;
            return { statusCode: 200, body: { ok: true, result: { message_id: 447 } } };
          },
        }),
        lookupByMessageIdImpl: () => {
          throw new Error('lookup should not run for unauthorized Telegram senders');
        },
        injectReplyImpl: () => {
          throw new Error('injectReply should not run for unauthorized Telegram senders');
        },
      },
    );

    assert.equal(state.telegramLastUpdateId, 46);
    assert.equal(state.messagesInjected, 0);
    assert.equal(state.errors, 0);
    const parsedBody = JSON.parse(sendMessageBody) as {
      text: string;
      reply_to_message_id: number;
      message_thread_id: number;
    };
    assert.equal(parsedBody.reply_to_message_id, 335);
    assert.equal(parsedBody.message_thread_id, 9001);
    assert.match(parsedBody.text, /not authorized/i);
  });

  it('does not send usage replies for unauthorized non-reply Telegram messages in the configured chat', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig();
    let sendMessageAttempted = false;

    await pollTelegramOnce(
      config,
      createBaseState(),
      new RateLimiter(10),
      {
        httpsRequestImpl: createHttpsRequestMock({
          [`GET /bot${config.telegramBotToken}/getUpdates?offset=0&timeout=30&allowed_updates=%5B%22message%22%5D`]: () => ({
            statusCode: 200,
            body: {
              ok: true,
              result: [
                {
                  update_id: 46,
                  message: {
                    message_id: 336,
                    chat: { id: 777, type: 'private' },
                    from: { id: 'intruder' },
                    text: 'hello',
                  },
                },
              ],
            },
          }),
          [`POST /bot${config.telegramBotToken}/sendMessage`]: () => {
            sendMessageAttempted = true;
            return { statusCode: 200, body: { ok: true, result: { message_id: 452 } } };
          },
        }),
      },
    );

    assert.equal(sendMessageAttempted, false);
  });

  it('refuses reply injection from non-private Telegram chats when no sender allowlist is configured', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig({ authorizedTelegramUserIds: [] });
    const state = createBaseState();
    let sendMessageBody = '';
    let injectCalled = false;

    await pollTelegramOnce(
      config,
      state,
      new RateLimiter(10),
      {
        httpsRequestImpl: createHttpsRequestMock({
          [`GET /bot${config.telegramBotToken}/getUpdates?offset=0&timeout=30&allowed_updates=%5B%22message%22%5D`]: () => ({
            statusCode: 200,
            body: {
              ok: true,
              result: [
                {
                  update_id: 47,
                  message: {
                    message_id: 337,
                    chat: { id: 777, type: 'supergroup' },
                    from: { id: 'telegram-user-2' },
                    text: 'resume',
                    reply_to_message: { message_id: 222 },
                  },
                },
              ],
            },
          }),
          [`POST /bot${config.telegramBotToken}/sendMessage`]: (body) => {
            sendMessageBody = body;
            return { statusCode: 200, body: { ok: true, result: { message_id: 453 } } };
          },
        }),
        lookupByMessageIdImpl: () => createMapping('telegram'),
        injectReplyImpl: () => {
          injectCalled = true;
          return true;
        },
      },
    );

    assert.equal(injectCalled, false);
    const parsedBody = JSON.parse(sendMessageBody) as { text: string };
    assert.match(parsedBody.text, /not authorized/i);
    assert.equal(state.messagesInjected, 0);
  });

  it('responds to Telegram status probes without injecting command text', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig();
    const state = createBaseState();
    let sendMessageBody = '';
    let injectCalled = false;

    await pollTelegramOnce(
      config,
      state,
      new RateLimiter(10),
      {
        httpsRequestImpl: createHttpsRequestMock({
          [`GET /bot${config.telegramBotToken}/getUpdates?offset=0&timeout=30&allowed_updates=%5B%22message%22%5D`]: () => ({
            statusCode: 200,
            body: {
              ok: true,
              result: [
                {
                  update_id: 47,
                  message: {
                    message_id: 336,
                    chat: { id: 777 },
                    from: { id: 'telegram-user-1' },
                    text: ' status ',
                    reply_to_message: { message_id: 222 },
                  },
                },
              ],
            },
          }),
          [`POST /bot${config.telegramBotToken}/sendMessage`]: (body) => {
            sendMessageBody = body;
            return { statusCode: 200, body: { ok: true, result: { message_id: 448 } } };
          },
        }),
        lookupByMessageIdImpl: () => createMapping('telegram'),
        buildSessionStatusReplyImpl: async (mapping) => {
          assert.equal(mapping.sessionId, 'session-1');
          return 'Tracked OMX session status';
        },
        injectReplyImpl: () => {
          injectCalled = true;
          return true;
        },
      },
    );

    assert.equal(injectCalled, false);
    const parsedBody = JSON.parse(sendMessageBody) as {
      text: string;
      reply_to_message_id: number;
      message_thread_id: number;
    };
    assert.equal(parsedBody.reply_to_message_id, 336);
    assert.equal(parsedBody.message_thread_id, 9001);
    assert.equal(parsedBody.text, 'Tracked OMX session status');
  });

  it('reuses the tracked mapping thread id when an inbound Telegram reply omits message_thread_id', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig();
    const state = createBaseState();
    let sendMessageBody = '';

    await pollTelegramOnce(
      config,
      state,
      new RateLimiter(10),
      {
        httpsRequestImpl: createHttpsRequestMock({
          [`GET /bot${config.telegramBotToken}/getUpdates?offset=0&timeout=30&allowed_updates=%5B%22message%22%5D`]: () => ({
            statusCode: 200,
            body: {
              ok: true,
              result: [
                {
                  update_id: 47,
                  message: {
                    message_id: 336,
                    chat: { id: 777 },
                    from: { id: 'telegram-user-1' },
                    text: 'continue',
                    reply_to_message: { message_id: 222 },
                  },
                },
              ],
            },
          }),
          [`POST /bot${config.telegramBotToken}/sendMessage`]: (body) => {
            sendMessageBody = body;
            return {
              statusCode: 200,
              body: { ok: true, result: { message_id: 448 } },
            };
          },
        }),
        lookupByMessageIdImpl: () => createMapping('telegram'),
        injectReplyImpl: () => true,
      },
    );

    const parsedBody = JSON.parse(sendMessageBody) as {
      text: string;
      reply_to_message_id: number;
      message_thread_id: number;
    };
    assert.equal(parsedBody.reply_to_message_id, 336);
    assert.equal(parsedBody.message_thread_id, 9001);
    assert.equal(parsedBody.text, 'Got it — sending your follow-up to Codex…');
  });

  it('sends an explicit Telegram error reply when the original notification is no longer tracked', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig();
    let sendMessageBody = '';

    await pollTelegramOnce(
      config,
      createBaseState(),
      new RateLimiter(10),
      {
        httpsRequestImpl: createHttpsRequestMock({
          [`GET /bot${config.telegramBotToken}/getUpdates?offset=0&timeout=30&allowed_updates=%5B%22message%22%5D`]: () => ({
            statusCode: 200,
            body: {
              ok: true,
              result: [
                {
                  update_id: 48,
                  message: {
                    message_id: 337,
                    message_thread_id: 9001,
                    chat: { id: 777 },
                    from: { id: 'telegram-user-1' },
                    text: 'resume',
                    reply_to_message: { message_id: 999 },
                  },
                },
              ],
            },
          }),
          [`POST /bot${config.telegramBotToken}/sendMessage`]: (body) => {
            sendMessageBody = body;
            return { statusCode: 200, body: { ok: true, result: { message_id: 449 } } };
          },
        }),
        lookupByMessageIdImpl: () => null,
        injectReplyImpl: () => {
          throw new Error('injectReply should not run for untracked Telegram replies');
        },
      },
    );

    const parsedBody = JSON.parse(sendMessageBody) as {
      text: string;
      message_thread_id: number;
    };
    assert.equal(parsedBody.message_thread_id, 9001);
    assert.match(parsedBody.text, /no tracked omx session/i);
  });

  it('sends an explicit Telegram error reply when pane verification fails terminally', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig();
    let sendMessageBody = '';

    await pollTelegramOnce(
      config,
      createBaseState(),
      new RateLimiter(10),
      {
        httpsRequestImpl: createHttpsRequestMock({
          [`GET /bot${config.telegramBotToken}/getUpdates?offset=0&timeout=30&allowed_updates=%5B%22message%22%5D`]: () => ({
            statusCode: 200,
            body: {
              ok: true,
              result: [
                {
                  update_id: 49,
                  message: {
                    message_id: 338,
                    chat: { id: 777 },
                    from: { id: 'telegram-user-1' },
                    text: 'resume',
                    reply_to_message: { message_id: 222 },
                  },
                },
              ],
            },
          }),
          [`POST /bot${config.telegramBotToken}/sendMessage`]: (body) => {
            sendMessageBody = body;
            return { statusCode: 200, body: { ok: true, result: { message_id: 450 } } };
          },
        }),
        lookupByMessageIdImpl: () => createMapping('telegram'),
        injectReplyImpl: () => ({
          outcome: 'terminal-ignore',
          reason: 'Target pane is no longer an OMX session',
        }),
      },
    );

    const parsedBody = JSON.parse(sendMessageBody) as { text: string };
    assert.match(parsedBody.text, /target pane is no longer an omx session/i);
  });

  it('records an error when Telegram injection fails and removes the placeholder acknowledgement', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig();
    const state = createBaseState();
    const sendMessageBodies: Array<Record<string, unknown>> = [];
    const deleteMessageBodies: Array<Record<string, unknown>> = [];

    await pollTelegramOnce(
      config,
      state,
      new RateLimiter(10),
      {
        httpsRequestImpl: createHttpsRequestMock({
          [`GET /bot${config.telegramBotToken}/getUpdates?offset=0&timeout=30&allowed_updates=%5B%22message%22%5D`]: () => ({
            statusCode: 200,
            body: {
              ok: true,
              result: [
                {
                  update_id: 46,
                  message: {
                    message_id: 335,
                    chat: { id: 777 },
                    from: { id: 'telegram-user-1' },
                    text: 'blocked',
                    reply_to_message: { message_id: 222 },
                  },
                },
              ],
            },
          }),
          [`POST /bot${config.telegramBotToken}/sendMessage`]: (body) => {
            sendMessageBodies.push(JSON.parse(body) as Record<string, unknown>);
            return { statusCode: 200, body: { ok: true, result: { message_id: 446 } } };
          },
          [`POST /bot${config.telegramBotToken}/deleteMessage`]: (body) => {
            deleteMessageBodies.push(JSON.parse(body) as Record<string, unknown>);
            return { statusCode: 200, body: { ok: true, result: true } };
          },
        }),
        lookupByMessageIdImpl: () => createMapping('telegram'),
        injectReplyImpl: () => false,
      },
    );

    assert.equal(sendMessageBodies.length, 1);
    assert.equal(sendMessageBodies[0]?.text, 'Got it — sending your follow-up to Codex…');
    assert.deepEqual(deleteMessageBodies, [{ chat_id: '777', message_id: '446' }]);
    assert.equal(state.messagesInjected, 0);
    assert.equal(state.errors, 1);
    assert.equal(state.telegramLastUpdateId, null);
    const sourceKey = buildTelegramReplySource(config.telegramBotToken!, config.telegramChatId!).key;
    assert.equal(state.sourceStates[sourceKey]?.lastFailureCategory, 'retryable-injection');
    assert.equal(state.sourceStates[sourceKey]?.failureCounts?.['retryable-injection'], 1);
  });

  it('drops pending Telegram backlog deterministically when configured', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig({ telegramStartupBacklogPolicy: 'drop_pending' });
    const state = createBaseState();
    let injectCalled = false;

    await pollTelegramOnce(
      config,
      state,
      new RateLimiter(10),
      {
        httpsRequestImpl: createHttpsRequestMock({
          [`GET /bot${config.telegramBotToken}/getUpdates?offset=0&timeout=0&allowed_updates=%5B%22message%22%5D`]: () => ({
            statusCode: 200,
            body: {
              ok: true,
              result: [
                {
                  update_id: 50,
                  message: {
                    message_id: 340,
                    chat: { id: 777 },
                    from: { id: 'telegram-user-1' },
                    text: 'stale backlog',
                    reply_to_message: { message_id: 222 },
                  },
                },
              ],
            },
          }),
        }),
        lookupByMessageIdImpl: () => createMapping('telegram'),
        injectReplyImpl: () => {
          injectCalled = true;
          return true;
        },
      },
    );

    assert.equal(injectCalled, false);
    assert.equal(state.telegramLastUpdateId, 50);
    assert.equal(state.telegramStartupPolicyApplied, true);
  });

  it('retries drop_pending backlog handling when the startup discard fetch fails', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig({ telegramStartupBacklogPolicy: 'drop_pending' });
    const state = createBaseState();

    await pollTelegramOnce(
      config,
      state,
      new RateLimiter(10),
      {
        httpsRequestImpl: createHttpsRequestMock({
          [`GET /bot${config.telegramBotToken}/getUpdates?offset=0&timeout=0&allowed_updates=%5B%22message%22%5D`]: () => {
            throw new Error('startup fetch failed');
          },
        }),
      },
    );

    assert.equal(state.telegramStartupPolicyApplied, false);
    assert.equal(state.telegramLastUpdateId, null);
    assert.equal(state.errors, 1);
  });

  it('retries drop_pending backlog handling when Telegram getUpdates returns ok=false on startup', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig({ telegramStartupBacklogPolicy: 'drop_pending' });
    const state = createBaseState();

    await pollTelegramOnce(
      config,
      state,
      new RateLimiter(10),
      {
        httpsRequestImpl: createHttpsRequestMock({
          [`GET /bot${config.telegramBotToken}/getUpdates?offset=0&timeout=0&allowed_updates=%5B%22message%22%5D`]: () => ({
            statusCode: 200,
            body: {
              ok: false,
              description: 'backlog fetch failed',
            },
          }),
        }),
      },
    );

    assert.equal(state.telegramStartupPolicyApplied, false);
    assert.equal(state.telegramLastUpdateId, null);
    assert.equal(state.errors, 1);
    assert.equal(state.lastError, 'backlog fetch failed');
  });

  it('surfaces Telegram getUpdates descriptions for non-2xx Bot API errors', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig({ telegramStartupBacklogPolicy: 'drop_pending' });
    const state = createBaseState();

    await pollTelegramOnce(
      config,
      state,
      new RateLimiter(10),
      {
        httpsRequestImpl: createHttpsRequestMock({
          [`GET /bot${config.telegramBotToken}/getUpdates?offset=0&timeout=0&allowed_updates=%5B%22message%22%5D`]: () => ({
            statusCode: 400,
            body: {
              ok: false,
              description: 'bad request from Telegram',
            },
          }),
        }),
      },
    );

    assert.equal(state.telegramStartupPolicyApplied, false);
    assert.equal(state.telegramLastUpdateId, null);
    assert.equal(state.errors, 1);
    assert.equal(state.lastError, 'bad request from Telegram');
  });

  it('replays pending Telegram backlog exactly once when replay_once is configured', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig({ telegramStartupBacklogPolicy: 'replay_once' });
    const state = createBaseState();
    let injectCalled = 0;

    await pollTelegramOnce(
      config,
      state,
      new RateLimiter(10),
      {
        httpsRequestImpl: createHttpsRequestMock({
          [`GET /bot${config.telegramBotToken}/getUpdates?offset=0&timeout=0&allowed_updates=%5B%22message%22%5D`]: () => ({
            statusCode: 200,
            body: {
              ok: true,
              result: [
                {
                  update_id: 51,
                  message: {
                    message_id: 341,
                    chat: { id: 777 },
                    from: { id: 'telegram-user-1' },
                    text: 'replay this once',
                    reply_to_message: { message_id: 222 },
                  },
                },
              ],
            },
          }),
          [`POST /bot${config.telegramBotToken}/sendMessage`]: () => ({
            statusCode: 200,
            body: { ok: true, result: { message_id: 451 } },
          }),
        }),
        lookupByMessageIdImpl: () => createMapping('telegram'),
        injectReplyImpl: () => {
          injectCalled += 1;
          return true;
        },
      },
    );

    assert.equal(injectCalled, 1);
    assert.equal(state.telegramStartupPolicyApplied, true);
    assert.equal(state.telegramLastUpdateId, 51);
  });

  it('logs Telegram reply-send failures instead of silently swallowing them', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig();
    const state = createBaseState();
    const logs: string[] = [];

    await pollTelegramOnce(
      config,
      state,
      new RateLimiter(10),
      {
        httpsRequestImpl: createHttpsRequestMock({
          [`GET /bot${config.telegramBotToken}/getUpdates?offset=0&timeout=30&allowed_updates=%5B%22message%22%5D`]: () => ({
            statusCode: 200,
            body: {
              ok: true,
              result: [
                {
                  update_id: 52,
                  message: {
                    message_id: 342,
                    chat: { id: 777 },
                    from: { id: 'telegram-user-1' },
                    text: 'status',
                    reply_to_message: { message_id: 222 },
                  },
                },
              ],
            },
          }),
          [`POST /bot${config.telegramBotToken}/sendMessage`]: () => ({
            statusCode: 500,
            body: { ok: false, description: 'bot API unavailable' },
          }),
        }),
        lookupByMessageIdImpl: () => createMapping('telegram'),
        buildSessionStatusReplyImpl: async () => 'Tracked OMX session status',
        logImpl: (message) => {
          logs.push(message);
        },
      },
    );

    assert.ok(logs.some((entry) => entry.includes('WARN: Failed to send Telegram reply')));
  });

  it('treats Telegram ok=false reply bodies as failures and logs them', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig();
    const logs: string[] = [];

    await pollTelegramOnce(
      config,
      createBaseState(),
      new RateLimiter(10),
      {
        httpsRequestImpl: createHttpsRequestMock({
          [`GET /bot${config.telegramBotToken}/getUpdates?offset=0&timeout=30&allowed_updates=%5B%22message%22%5D`]: () => ({
            statusCode: 200,
            body: {
              ok: true,
              result: [
                {
                  update_id: 53,
                  message: {
                    message_id: 343,
                    chat: { id: 777 },
                    from: { id: 'telegram-user-1' },
                    text: 'status',
                    reply_to_message: { message_id: 222 },
                  },
                },
              ],
            },
          }),
          [`POST /bot${config.telegramBotToken}/sendMessage`]: () => ({
            statusCode: 200,
            body: { ok: false, description: 'chat not found' },
          }),
        }),
        lookupByMessageIdImpl: () => createMapping('telegram'),
        buildSessionStatusReplyImpl: async () => 'Tracked OMX session status',
        logImpl: (message) => {
          logs.push(message);
        },
      },
    );

    assert.ok(logs.some((entry) => entry.includes('WARN: Failed to send Telegram reply')));
    assert.ok(logs.some((entry) => entry.includes('chat not found')));
  });
});
