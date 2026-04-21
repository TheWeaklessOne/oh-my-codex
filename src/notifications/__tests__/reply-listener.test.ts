import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type spawnSync } from 'node:child_process';
import type { ClientRequestArgs, IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  RateLimiter,
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
import type { ReplyListenerDaemonConfig, ReplyListenerState } from '../reply-listener.js';
import type { SessionMapping } from '../session-registry.js';
import { NO_TRACKED_SESSION_MESSAGE } from '../session-status.js';
import { buildDiscordReplySource, buildTelegramReplySource } from '../reply-source.js';

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
  return ((options: ClientRequestArgs, callback?: (res: IncomingMessage) => void) => {
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
  }) as typeof import('node:https').request;
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

  it('forwards OMX_NOTIFY_PROFILE into the detached daemon environment for canonical config re-derivation', () => {
    const originalNotifyProfile = process.env.OMX_NOTIFY_PROFILE;
    let spawnedEnv: NodeJS.ProcessEnv | undefined;

    try {
      process.env.OMX_NOTIFY_PROFILE = 'ops';

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
    } finally {
      if (typeof originalNotifyProfile === 'string') process.env.OMX_NOTIFY_PROFILE = originalNotifyProfile;
      else delete process.env.OMX_NOTIFY_PROFILE;
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

  it('injects Telegram replies and sends a reply acknowledgement', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig();
    const state = createBaseState();
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
      'Injected into Codex CLI session.',
    );
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
    assert.equal(parsedBody.text, 'Injected into Codex CLI session.');
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

  it('records an error when Telegram injection fails and does not send an acknowledgement', async () => {
    resetReplyListenerTransientState();
    const config = createBaseConfig();
    const state = createBaseState();
    let sendMessageAttempted = false;

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
          [`POST /bot${config.telegramBotToken}/sendMessage`]: () => {
            sendMessageAttempted = true;
            return { statusCode: 200, body: { ok: true, result: { message_id: 446 } } };
          },
        }),
        lookupByMessageIdImpl: () => createMapping('telegram'),
        injectReplyImpl: () => false,
      },
    );

    assert.equal(sendMessageAttempted, false);
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
