import { after, before, beforeEach, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FullNotificationConfig, NonStandardNotificationResult } from '../types.js';

const ENV_KEYS = ['CODEX_HOME', 'TMUX', 'TMUX_PANE', 'PATH'] as const;

const originalFetch = globalThis.fetch;

function writeNotificationConfig(codexHome: string): void {
  writeFileSync(join(codexHome, '.omx-config.json'), JSON.stringify({
    notifications: {
      enabled: true,
      webhook: {
        enabled: true,
        url: 'https://example.com/hook',
      },
    },
  }, null, 2));
}

function writeFakeTmux(fakeBinDir: string, output: string): void {
  const tmuxPath = join(fakeBinDir, 'tmux');
  writeFileSync(tmuxPath, `#!/usr/bin/env bash
set -eu
if [[ "$1" == "list-panes" ]]; then
  printf '0 %s\\n' "$PPID"
  exit 0
fi
if [[ "$1" == "capture-pane" ]]; then
  printf '%s\\n' ${JSON.stringify(output)}
  exit 0
fi
exit 2
`);
  chmodSync(tmuxPath, 0o755);
}

async function waitUntil(
  predicate: () => boolean,
  message: string,
  timeoutMs = 1_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

function lifecycleEventStatus(projectPath: string, sessionId: string, event: string): string | undefined {
  const statePath = join(projectPath, '.omx', 'state', 'sessions', sessionId, 'lifecycle-notif-state.json');
  if (!existsSync(statePath)) return undefined;
  const state = JSON.parse(readFileSync(statePath, 'utf-8')) as {
    events?: Record<string, { status?: string }>;
  };
  return state.events?.[event]?.status;
}

describe('notifyLifecycle tmux tail auto-capture', () => {
  let originalEnv: NodeJS.ProcessEnv;
  const codexHome = mkdtempSync(join(tmpdir(), 'omx-notify-index-codex-home-'));
  const fakeBinDir = mkdtempSync(join(tmpdir(), 'omx-notify-index-fake-bin-'));

  before(() => {
    originalEnv = { ...process.env };
    process.env.CODEX_HOME = codexHome;
    process.env.PATH = `${fakeBinDir}:${originalEnv.PATH || ''}`;
    process.env.TMUX = '/tmp/tmux-1000/default,12345,0';
    process.env.TMUX_PANE = '%42';
  });

  beforeEach(() => {
    process.env.CODEX_HOME = codexHome;
    process.env.PATH = `${fakeBinDir}:${originalEnv.PATH || ''}`;
    process.env.TMUX = '/tmp/tmux-1000/default,12345,0';
    process.env.TMUX_PANE = '%42';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  after(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(fakeBinDir, { recursive: true, force: true });
  });

  it('does not auto-capture historical tmux tail for terminal notifications', async () => {
    writeFakeTmux(fakeBinDir, 'historical risk line');
    writeNotificationConfig(codexHome);
    const { notifyLifecycle } = await import('../index.js');

    for (const eventName of ['session-end', 'session-stop'] as const) {
      let capturedBody = '';
      globalThis.fetch = async (_input, init) => {
        capturedBody = typeof init?.body === 'string' ? init.body : '';
        return new Response('', { status: 200 });
      };

      const projectPath = mkdtempSync(join(tmpdir(), `omx-notify-index-project-${eventName}-`));
      const result = await notifyLifecycle(eventName, {
        sessionId: `sess-${eventName}-${Date.now()}`,
        projectPath,
        projectName: 'project',
        reason: 'session_exit',
      });
      rmSync(projectPath, { recursive: true, force: true });

      assert.ok(result);
      assert.equal(result.anySuccess, true);
      const parsed = JSON.parse(capturedBody) as { message: string };
      assert.doesNotMatch(parsed.message, /Recent output:/);
      assert.doesNotMatch(parsed.message, /historical risk line/);
    }
  });


  it('awaits ask-user-question OpenClaw dispatch so reply routing stays on the live launch path', async () => {
    let openClawCalls = 0;
    let openClawResolved = false;
    let openClawStatus = 200;
    let openClawError = '';

    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? String(input) : input.url;
      if (!url.includes('127.0.0.1:18789')) {
        return new Response('', { status: 200 });
      }
      openClawCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 60));
      openClawResolved = true;
      if (openClawError) {
        throw new Error(openClawError);
      }
      return new Response('', { status: openClawStatus });
    };

    writeFileSync(join(codexHome, '.omx-config.json'), JSON.stringify({
      notifications: {
        enabled: true,
        verbosity: 'verbose',
        webhook: {
          enabled: true,
          url: 'https://example.com/hook',
        },
        events: {
          'ask-user-question': { enabled: true },
          'session-start': { enabled: true },
        },
        openclaw: {
          enabled: true,
          gateways: {
            local: { type: 'http', url: 'http://127.0.0.1:18789/hooks/agent' },
          },
          hooks: {
            'ask-user-question': {
              enabled: true,
              gateway: 'local',
              instruction: 'ask {{question}}',
            },
            'session-start': {
              enabled: true,
              gateway: 'local',
              instruction: 'start {{sessionId}}',
            },
          },
        },
      },
    }, null, 2));

    process.env.OMX_OPENCLAW = '1';
    const { resetOpenClawConfigCache } = await import('../../openclaw/config.js');
    resetOpenClawConfigCache();

    const projectPath = mkdtempSync(join(tmpdir(), 'omx-notify-index-project-ask-'));
    const { notifyLifecycle } = await import(`../index.js?ask-user-question-await=${Date.now()}`);

    const askStarted = Date.now();
    const askResult = await notifyLifecycle('ask-user-question', {
      sessionId: `sess-ask-${Date.now()}`,
      projectPath,
      question: 'Need approval?',
    }, undefined, {
      dispatchNotificationsImpl: async (_config: unknown, event: string, _payload: unknown) => ({
        event,
        anySuccess: false,
        results: [{
          platform: 'webhook',
          success: false,
          error: 'HTTP 500',
        }],
      }),
    });
    const askElapsed = Date.now() - askStarted;

    assert.ok(askResult);
    assert.equal(askResult.anySuccess, true);
    assert.equal(askResult.nonStandardAnySuccess, true);
    assert.equal(askResult.nonStandardResults?.some((entry: NonStandardNotificationResult) =>
      entry.transport === 'openclaw'
      && entry.success === true
    ), true);
    assert.equal(openClawCalls, 1);
    assert.equal(openClawResolved, true);
    assert.ok(askElapsed >= 50, `ask-user-question should await OpenClaw dispatch, got ${askElapsed}ms`);

    openClawCalls = 0;
    openClawResolved = false;
    const startSessionId = `sess-start-${Date.now()}`;
    const startStarted = Date.now();
    const startResult = await notifyLifecycle('session-start', {
      sessionId: startSessionId,
      projectPath,
    }, undefined, {
      dispatchNotificationsImpl: async (_config: unknown, event: string, _payload: unknown) => ({
        event,
        anySuccess: false,
        results: [{
          platform: 'webhook',
          success: false,
          error: 'HTTP 500',
        }],
      }),
    });
    const startElapsed = Date.now() - startStarted;

    assert.ok(startResult);
    assert.equal(startResult.anySuccess, false);
    assert.equal(startResult.nonStandardAnySuccess, undefined);
    assert.equal(openClawResolved, false, 'session-start should keep fire-and-forget OpenClaw dispatch');
    const pendingDuplicateStart = await notifyLifecycle('session-start', {
      sessionId: startSessionId,
      projectPath,
    }, undefined, {
      dispatchNotificationsImpl: async () => {
        throw new Error('pending duplicate session-start should not dispatch standard transports');
      },
    });
    assert.ok(pendingDuplicateStart);
    assert.equal(pendingDuplicateStart.anySuccess, true);
    assert.equal(openClawCalls, 1);
    await waitUntil(() => openClawResolved, 'session-start deferred OpenClaw dispatch did not resolve');
    assert.equal(openClawCalls, 1);
    assert.ok(
      startElapsed < askElapsed,
      `session-start should remain faster than awaited ask-user-question dispatch (start=${startElapsed}ms ask=${askElapsed}ms)`,
    );

    openClawCalls = 0;
    const duplicateStart = await notifyLifecycle('session-start', {
      sessionId: startSessionId,
      projectPath,
    }, undefined, {
      dispatchNotificationsImpl: async () => {
        throw new Error('deduped session-start should not dispatch standard transports');
      },
    });
    assert.ok(duplicateStart);
    assert.equal(duplicateStart.anySuccess, true);
    assert.equal(openClawCalls, 0);

    delete process.env.OMX_OPENCLAW;
    let slowStandardCalls = 0;
    const slowStandardControl: { resolve?: () => void } = {};
    const slowStandardSessionId = `sess-start-slow-standard-${Date.now()}`;
    const slowStandardResultPromise = notifyLifecycle('session-start', {
      sessionId: slowStandardSessionId,
      projectPath,
    }, undefined, {
      dispatchNotificationsImpl: async (_config: unknown, event: string, _payload: unknown) => {
        slowStandardCalls += 1;
        await new Promise<void>((resolve) => {
          slowStandardControl.resolve = resolve;
        });
        return {
          event,
          anySuccess: true,
          results: [{
            platform: 'webhook',
            success: true,
          }],
        };
      },
    });
    await waitUntil(() => slowStandardCalls === 1, 'slow standard dispatch did not start');
    const duplicateSlowStandard = await notifyLifecycle('session-start', {
      sessionId: slowStandardSessionId,
      projectPath,
    }, undefined, {
      dispatchNotificationsImpl: async () => {
        throw new Error('pending standard session-start should not dispatch twice');
      },
    });
    assert.ok(duplicateSlowStandard);
    assert.equal(duplicateSlowStandard.anySuccess, true);
    assert.equal(slowStandardCalls, 1);
    assert.ok(slowStandardControl.resolve);
    slowStandardControl.resolve();
    const slowStandardResult = await slowStandardResultPromise;
    assert.ok(slowStandardResult);
    assert.equal(slowStandardResult.anySuccess, true);

    let ambiguousStandardCalls = 0;
    const ambiguousStandardSessionId = `sess-start-ambiguous-standard-${Date.now()}`;
    const ambiguousStandardResult = await notifyLifecycle('session-start', {
      sessionId: ambiguousStandardSessionId,
      projectPath,
    }, undefined, {
      dispatchNotificationsImpl: async (_config: unknown, event: string, _payload: unknown) => {
        ambiguousStandardCalls += 1;
        return {
          event,
          anySuccess: false,
          results: [{
            platform: 'webhook',
            success: false,
            error: 'HTTP 504',
            statusCode: 504,
          }],
        };
      },
    });
    assert.ok(ambiguousStandardResult);
    assert.equal(ambiguousStandardResult.anySuccess, false);
    const duplicateAmbiguousStandard = await notifyLifecycle('session-start', {
      sessionId: ambiguousStandardSessionId,
      projectPath,
    }, undefined, {
      dispatchNotificationsImpl: async () => {
        throw new Error('ambiguous standard lifecycle failure should keep the pending claim');
      },
    });
    assert.ok(duplicateAmbiguousStandard);
    assert.equal(duplicateAmbiguousStandard.anySuccess, true);
    assert.equal(ambiguousStandardCalls, 1);

    let timeoutStandardCalls = 0;
    const timeoutStandardSessionId = `sess-start-timeout-standard-${Date.now()}`;
    const timeoutStandardResult = await notifyLifecycle('session-start', {
      sessionId: timeoutStandardSessionId,
      projectPath,
    }, undefined, {
      dispatchNotificationsImpl: async (_config: unknown, event: string, _payload: unknown) => {
        timeoutStandardCalls += 1;
        return {
          event,
          anySuccess: false,
          results: [{
            platform: 'webhook',
            success: false,
            error: 'Dispatch timeout',
          }],
        };
      },
    });
    assert.ok(timeoutStandardResult);
    assert.equal(timeoutStandardResult.anySuccess, false);
    const duplicateTimeoutStandard = await notifyLifecycle('session-start', {
      sessionId: timeoutStandardSessionId,
      projectPath,
    }, undefined, {
      dispatchNotificationsImpl: async () => {
        throw new Error('timeout standard lifecycle failure should keep the pending claim');
      },
    });
    assert.ok(duplicateTimeoutStandard);
    assert.equal(duplicateTimeoutStandard.anySuccess, true);
    assert.equal(timeoutStandardCalls, 1);

    let telegramCleanupCalls = 0;
    const telegramCleanupSessionId = `sess-start-telegram-cleanup-${Date.now()}`;
    const telegramCleanupResult = await notifyLifecycle('session-start', {
      sessionId: telegramCleanupSessionId,
      projectPath,
    }, undefined, {
      dispatchNotificationsImpl: async (_config: unknown, event: string, _payload: unknown) => {
        telegramCleanupCalls += 1;
        return {
          event,
          anySuccess: false,
          results: [{
            platform: 'telegram',
            success: false,
            error: 'Telegram topic delivery mismatch cleanup failed',
          }],
        };
      },
    });
    assert.ok(telegramCleanupResult);
    assert.equal(telegramCleanupResult.anySuccess, false);
    const duplicateTelegramCleanup = await notifyLifecycle('session-start', {
      sessionId: telegramCleanupSessionId,
      projectPath,
    }, undefined, {
      dispatchNotificationsImpl: async () => {
        throw new Error('telegram cleanup ambiguity should keep the pending claim');
      },
    });
    assert.ok(duplicateTelegramCleanup);
    assert.equal(duplicateTelegramCleanup.anySuccess, true);
    assert.equal(telegramCleanupCalls, 1);

    process.env.OMX_OPENCLAW = '1';
    openClawCalls = 0;
    openClawResolved = false;
    openClawError = '';
    openClawStatus = 504;
    const ambiguousOpenClawSessionId = `sess-start-ambiguous-openclaw-${Date.now()}`;
    const ambiguousOpenClawResult = await notifyLifecycle('session-start', {
      sessionId: ambiguousOpenClawSessionId,
      projectPath,
    }, undefined, {
      dispatchNotificationsImpl: async (_config: unknown, event: string, _payload: unknown) => ({
        event,
        anySuccess: false,
        results: [{
          platform: 'webhook',
          success: false,
          error: 'HTTP 500',
        }],
      }),
    });
    assert.ok(ambiguousOpenClawResult);
    assert.equal(ambiguousOpenClawResult.anySuccess, false);
    await waitUntil(() => openClawResolved, 'ambiguous deferred OpenClaw dispatch did not resolve');
    assert.equal(openClawCalls, 1);
    const duplicateAmbiguousOpenClaw = await notifyLifecycle('session-start', {
      sessionId: ambiguousOpenClawSessionId,
      projectPath,
    }, undefined, {
      dispatchNotificationsImpl: async () => {
        throw new Error('ambiguous deferred OpenClaw failure should keep the pending claim');
      },
    });
    assert.ok(duplicateAmbiguousOpenClaw);
    assert.equal(duplicateAmbiguousOpenClaw.anySuccess, true);
    assert.equal(openClawCalls, 1);

    openClawCalls = 0;
    openClawResolved = false;
    openClawStatus = 200;
    openClawError = 'Dispatch timeout';
    const timeoutOpenClawSessionId = `sess-start-timeout-openclaw-${Date.now()}`;
    const timeoutOpenClawResult = await notifyLifecycle('session-start', {
      sessionId: timeoutOpenClawSessionId,
      projectPath,
    }, undefined, {
      dispatchNotificationsImpl: async (_config: unknown, event: string, _payload: unknown) => ({
        event,
        anySuccess: false,
        results: [{
          platform: 'webhook',
          success: false,
          error: 'HTTP 500',
        }],
      }),
    });
    assert.ok(timeoutOpenClawResult);
    assert.equal(timeoutOpenClawResult.anySuccess, false);
    await waitUntil(() => openClawResolved, 'timeout deferred OpenClaw dispatch did not resolve');
    assert.equal(openClawCalls, 1);
    const duplicateTimeoutOpenClaw = await notifyLifecycle('session-start', {
      sessionId: timeoutOpenClawSessionId,
      projectPath,
    }, undefined, {
      dispatchNotificationsImpl: async () => {
        throw new Error('timeout deferred OpenClaw failure should keep the pending claim');
      },
    });
    assert.ok(duplicateTimeoutOpenClaw);
    assert.equal(duplicateTimeoutOpenClaw.anySuccess, true);
    assert.equal(openClawCalls, 1);

    openClawCalls = 0;
    openClawResolved = false;
    openClawError = '';
    openClawStatus = 500;
    const failedStartSessionId = `sess-start-failed-${Date.now()}`;
    const failedStartResult = await notifyLifecycle('session-start', {
      sessionId: failedStartSessionId,
      projectPath,
    }, undefined, {
      dispatchNotificationsImpl: async (_config: unknown, event: string, _payload: unknown) => ({
        event,
        anySuccess: false,
        results: [{
          platform: 'webhook',
          success: false,
          error: 'HTTP 500',
        }],
      }),
    });

    assert.ok(failedStartResult);
    assert.equal(failedStartResult.anySuccess, false);
    assert.equal(failedStartResult.nonStandardAnySuccess, undefined);
    await waitUntil(() => openClawResolved, 'failed deferred OpenClaw dispatch did not resolve');
    assert.equal(openClawCalls, 1);
    await waitUntil(
      () => lifecycleEventStatus(projectPath, failedStartSessionId, 'session-start') === undefined,
      'definitive lifecycle failure did not clear pending claim',
    );

    openClawResolved = false;
    let standardRetryCalls = 0;
    const duplicateFailedStart = await notifyLifecycle('session-start', {
      sessionId: failedStartSessionId,
      projectPath,
    }, undefined, {
      dispatchNotificationsImpl: async (_config: unknown, event: string, _payload: unknown) => {
        standardRetryCalls += 1;
        return {
          event,
          anySuccess: false,
          results: [{
            platform: 'webhook',
            success: false,
            error: 'HTTP 500',
          }],
        };
      },
    });
    assert.ok(duplicateFailedStart);
    assert.equal(duplicateFailedStart.anySuccess, false);
    assert.equal(standardRetryCalls, 1);
    await waitUntil(() => openClawResolved, 'retried deferred OpenClaw dispatch did not resolve');
    assert.equal(openClawCalls, 2);

    rmSync(projectPath, { recursive: true, force: true });
    delete process.env.OMX_OPENCLAW;
  });

  it('keeps auto-capturing tmux tail for live session-idle notifications', async () => {
    writeFakeTmux(fakeBinDir, 'waiting for live input');

    let capturedBody = '';
    globalThis.fetch = async (_input, init) => {
      capturedBody = typeof init?.body === 'string' ? init.body : '';
      return new Response('', { status: 200 });
    };
    writeNotificationConfig(codexHome);

    const projectPath = mkdtempSync(join(tmpdir(), 'omx-notify-index-project-idle-'));
    const { notifyLifecycle } = await import('../index.js');
    const result = await notifyLifecycle('session-idle', {
      sessionId: `sess-idle-${Date.now()}`,
      projectPath,
      projectName: 'project',
    });
    rmSync(projectPath, { recursive: true, force: true });

    assert.ok(result);
    assert.equal(result.anySuccess, true);
    const parsed = JSON.parse(capturedBody) as { message: string };
    assert.match(parsed.message, /Recent output:/);
    assert.match(parsed.message, /waiting for live input/);
  });

  it('auto-captures tmux tail for result-ready notifications', async () => {
    writeFakeTmux(fakeBinDir, 'PASS semantic notifications');

    let capturedBody = '';
    globalThis.fetch = async (_input, init) => {
      capturedBody = typeof init?.body === 'string' ? init.body : '';
      return new Response('', { status: 200 });
    };
    writeNotificationConfig(codexHome);

    const projectPath = mkdtempSync(join(tmpdir(), 'omx-notify-index-project-result-'));
    const { notifyLifecycle } = await import(`../index.js?result-ready-tail=${Date.now()}`);
    const result = await notifyLifecycle('result-ready', {
      sessionId: `sess-result-${Date.now()}`,
      projectPath,
      projectName: 'project',
      contextSummary: 'All tests passed and commit created.',
    });
    rmSync(projectPath, { recursive: true, force: true });

    assert.ok(result);
    assert.equal(result.anySuccess, true);
    const parsed = JSON.parse(capturedBody) as { message: string };
    assert.match(parsed.message, /Result Ready/);
    assert.match(parsed.message, /Recent output:/);
    assert.match(parsed.message, /PASS semantic notifications/);
  });
});

describe('ensureReplyListenerForConfig', () => {
  it('starts the reply listener when reply mode and Telegram notifications are both enabled', async () => {
    const { ensureReplyListenerForConfig } = await import(`../index.js?reply-listener-start=${Date.now()}`);
    const startCalls: unknown[] = [];

    ensureReplyListenerForConfig(
      {
        enabled: true,
        telegram: {
          enabled: true,
          botToken: 'tg-token',
          chatId: 'tg-chat',
        },
      },
      {
        getReplyConfigImpl: () => ({
          enabled: true,
          pollIntervalMs: 3000,
          maxMessageLength: 500,
          rateLimitPerMinute: 10,
          includePrefix: true,
          ackMode: 'minimal',
          authorizedDiscordUserIds: [],
          authorizedTelegramUserIds: ['telegram-user-1'],
          telegramPollTimeoutSeconds: 30,
          telegramAllowedUpdates: ['message'],
          telegramStartupBacklogPolicy: 'resume',
        }),
        getReplyListenerPlatformConfigImpl: () => ({
          telegramEnabled: true,
          telegramBotToken: 'tg-token',
          telegramChatId: 'tg-chat',
          discordEnabled: false,
        }),
        startReplyListenerImpl: (config: Record<string, unknown>) => {
          startCalls.push(config);
          return { success: true, message: 'started' };
        },
      },
    );

    assert.equal(startCalls.length, 1);
    assert.deepEqual(startCalls[0], {
      enabled: true,
      pollIntervalMs: 3000,
      maxMessageLength: 500,
      rateLimitPerMinute: 10,
      includePrefix: true,
      ackMode: 'minimal',
      authorizedDiscordUserIds: [],
      authorizedTelegramUserIds: ['telegram-user-1'],
      telegramPollTimeoutSeconds: 30,
      telegramAllowedUpdates: ['message'],
      telegramStartupBacklogPolicy: 'resume',
      telegramEnabled: true,
      telegramBotToken: 'tg-token',
      telegramChatId: 'tg-chat',
      discordEnabled: false,
    });
  });

  it('passes mixed Telegram and Discord reply sources through the public integration seam', async () => {
    const { ensureReplyListenerForConfig } = await import(`../index.js?reply-listener-mixed=${Date.now()}`);
    const startCalls: unknown[] = [];

    ensureReplyListenerForConfig(
      {
        enabled: true,
        telegram: {
          enabled: true,
          botToken: 'tg-token',
          chatId: 'tg-chat',
        },
        'discord-bot': {
          enabled: true,
          botToken: 'discord-token',
          channelId: 'discord-channel',
          mention: '<@123456789012345678>',
        },
      },
      {
        getReplyConfigImpl: () => ({
          enabled: true,
          pollIntervalMs: 3000,
          maxMessageLength: 500,
          rateLimitPerMinute: 10,
          includePrefix: true,
          ackMode: 'minimal',
          authorizedDiscordUserIds: ['123456789012345678'],
          authorizedTelegramUserIds: ['telegram-user-1'],
          telegramPollTimeoutSeconds: 30,
          telegramAllowedUpdates: ['message'],
          telegramStartupBacklogPolicy: 'resume',
        }),
        getReplyListenerPlatformConfigImpl: () => ({
          telegramEnabled: true,
          telegramBotToken: 'tg-token',
          telegramChatId: 'tg-chat',
          discordEnabled: true,
          discordBotToken: 'discord-token',
          discordChannelId: 'discord-channel',
          discordMention: '<@123456789012345678>',
        }),
        startReplyListenerImpl: (config: Record<string, unknown>) => {
          startCalls.push(config);
          return { success: true, message: 'started' };
        },
      },
    );

    assert.equal(startCalls.length, 1);
    assert.deepEqual(startCalls[0], {
      enabled: true,
      pollIntervalMs: 3000,
      maxMessageLength: 500,
      rateLimitPerMinute: 10,
      includePrefix: true,
      ackMode: 'minimal',
      authorizedDiscordUserIds: ['123456789012345678'],
      authorizedTelegramUserIds: ['telegram-user-1'],
      telegramPollTimeoutSeconds: 30,
      telegramAllowedUpdates: ['message'],
      telegramStartupBacklogPolicy: 'resume',
      telegramEnabled: true,
      telegramBotToken: 'tg-token',
      telegramChatId: 'tg-chat',
      discordEnabled: true,
      discordBotToken: 'discord-token',
      discordChannelId: 'discord-channel',
      discordMention: '<@123456789012345678>',
    });
  });

  it('stops a running reply listener when reply handling is disabled', async () => {
    const { ensureReplyListenerForConfig } = await import(`../index.js?reply-listener-disabled=${Date.now()}`);
    let startCalled = false;
    let stopCalled = false;

    ensureReplyListenerForConfig(
      {
        enabled: true,
        telegram: {
          enabled: true,
          botToken: 'tg-token',
          chatId: 'tg-chat',
        },
      },
      {
        getReplyConfigImpl: () => null,
        startReplyListenerImpl: () => {
          startCalled = true;
          return { success: true, message: 'started' };
        },
        stopReplyListenerImpl: () => {
          stopCalled = true;
          return { success: true, message: 'stopped' };
        },
      },
    );

    assert.equal(startCalled, false);
    assert.equal(stopCalled, true);
  });
});

describe('notifications public exports', () => {
  it('re-exports the source-aware reply correlation lookup', async () => {
    const mod = await import(`../index.js?reply-listener-export=${Date.now()}`);
    assert.equal(typeof mod.lookupBySourceMessage, 'function');
  });

  it('re-exports Telegram topic routing helpers', async () => {
    const mod = await import(`../index.js?telegram-topic-export=${Date.now()}`);
    assert.equal(typeof mod.resolveTelegramDestination, 'function');
    assert.equal(typeof mod.ensureProjectTopic, 'function');
    assert.equal(typeof mod.buildProjectTopicName, 'function');
    assert.equal(typeof mod.getTelegramTopicRegistryRecord, 'function');
  });
});

describe('notifyLifecycle reply listener sync', () => {
  it('syncs reply-listener config through notifyLifecycle before dispatch', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'omx-notify-index-reply-sync-'));
    const { notifyLifecycle } = await import(`../index.js?reply-listener-notify=${Date.now()}`);
    const config = {
      enabled: true,
      telegram: {
        enabled: true,
        botToken: 'tg-token',
        chatId: 'tg-chat',
      },
    } as const;
    const syncedConfigs: unknown[] = [];

    const result = await notifyLifecycle(
      'session-start',
      {
        sessionId: `sess-reply-sync-${Date.now()}`,
        projectPath,
        tmuxPaneId: '%42',
        tmuxSession: 'omx',
        message: 'hello',
      },
      undefined,
      {
        getNotificationConfigImpl: () => config,
        isEventEnabledImpl: () => true,
        ensureReplyListenerForConfigImpl: (replyConfig: unknown) => {
          syncedConfigs.push(replyConfig);
        },
        dispatchNotificationsImpl: async () => ({
          event: 'session-start',
          anySuccess: true,
          results: [],
        }),
      },
    );

    rmSync(projectPath, { recursive: true, force: true });

    assert.deepEqual(syncedConfigs, [config]);
    assert.ok(result);
    assert.equal(result.anySuccess, true);
  });

  it('can resolve session-start notifications through an explicit codexHomeOverride chain', async () => {
    const originalHome = process.env.HOME;
    const originalCodexHome = process.env.CODEX_HOME;
    const tempHome = mkdtempSync(join(tmpdir(), 'omx-notify-index-explicit-home-'));
    const userCodexHome = join(tempHome, '.codex');
    const projectCodexHome = join(tempHome, 'project', '.codex');
    const unrelatedCodexHome = join(tempHome, 'elsewhere', '.codex');
    const projectPath = mkdtempSync(join(tmpdir(), 'omx-notify-index-explicit-home-project-'));

    try {
      mkdirSync(userCodexHome, { recursive: true });
      mkdirSync(projectCodexHome, { recursive: true });
      mkdirSync(unrelatedCodexHome, { recursive: true });
      writeFileSync(join(userCodexHome, '.omx-config.json'), JSON.stringify({
        notifications: {
          enabled: true,
          webhook: {
            enabled: true,
            url: 'https://example.com/user-webhook',
          },
        },
      }, null, 2));
      process.env.HOME = tempHome;
      process.env.CODEX_HOME = unrelatedCodexHome;

      const capturedConfigs: unknown[] = [];
      const { notifyLifecycle } = await import(`../index.js?session-start-explicit-home=${Date.now()}`);
      const { getNotificationConfig } = await import(`../config.js?session-start-explicit-home=${Date.now()}`);

      const result = await notifyLifecycle(
        'session-start',
        {
          sessionId: `sess-explicit-home-${Date.now()}`,
          projectPath,
          projectName: 'project',
        },
        undefined,
        {
          getNotificationConfigImpl: (profileName?: string) =>
            getNotificationConfig(profileName, { codexHomeOverride: projectCodexHome }),
          isEventEnabledImpl: () => true,
          ensureReplyListenerForConfigImpl: () => {},
          dispatchNotificationsImpl: async (config: FullNotificationConfig) => {
            capturedConfigs.push(config);
            return {
              event: 'session-start',
              anySuccess: true,
              results: [],
            };
          },
        },
      );

      assert.ok(result);
      assert.equal(result.anySuccess, true);
      assert.equal(capturedConfigs.length, 1);
      assert.equal(
        (capturedConfigs[0] as { webhook?: { url?: string } }).webhook?.url,
        'https://example.com/user-webhook',
      );
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = originalCodexHome;
      rmSync(projectPath, { recursive: true, force: true });
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

describe('notifyCompletedTurn transport override filtering', () => {
  it('does not render Telegram entity overrides when Telegram is disabled', async () => {
    const { notifyCompletedTurn, planCompletedTurnNotification } = await import(`../index.js?completed-turn-filter=${Date.now()}`);
    const decision = planCompletedTurnNotification({
      semanticOutcome: {
        kind: 'result-ready',
        summary: 'Done.',
        notificationEvent: 'result-ready',
      },
      assistantText: 'Run `npm test`',
      turnId: 'turn-filter-disabled-telegram',
    });
    assert.ok(decision);

    const config: FullNotificationConfig = {
      enabled: true,
      webhook: {
        enabled: true,
        url: 'https://example.com/webhook',
      },
    };
    let capturedPayload: { transportOverrides?: unknown } | undefined;

    const result = await notifyCompletedTurn(
      decision,
      {
        sessionId: 'sess-filter-disabled-telegram',
        assistantText: 'Run `npm test`',
        timestamp: new Date('2026-04-25T12:00:00Z').toISOString(),
      },
      undefined,
      {
        getNotificationConfigImpl: () => config,
        isEventEnabledImpl: () => true,
        ensureReplyListenerForConfigImpl: () => {},
        dispatchNotificationsImpl: async (_config: FullNotificationConfig, event: string, payload: unknown) => {
          capturedPayload = payload as { transportOverrides?: unknown };
          return {
            event: event as never,
            anySuccess: true,
            results: [],
          };
        },
      },
    );

    assert.ok(result);
    assert.equal(capturedPayload?.transportOverrides, undefined);
  });

  it('propagates Telegram accepted placeholder cleanup metadata into completed-turn payloads', async () => {
    const { notifyCompletedTurn, planCompletedTurnNotification } = await import(`../index.js?completed-turn-telegram-ack=${Date.now()}`);
    const decision = planCompletedTurnNotification({
      semanticOutcome: {
        kind: 'result-ready',
        summary: 'Done.',
        notificationEvent: 'result-ready',
      },
      replyOrigin: {
        platform: 'telegram',
        injectedInput: '[reply:telegram] show details',
        createdAt: new Date('2026-04-27T00:00:00Z').toISOString(),
        telegramAck: {
          chatId: '777',
          messageId: '701',
          messageThreadId: '9001',
        },
        telegramReplyTo: {
          chatId: '777',
          messageId: '350',
          messageThreadId: '9001',
        },
      },
      assistantText: 'Final answer',
      turnId: 'turn-telegram-ack',
    });
    assert.ok(decision);

    const config: FullNotificationConfig = {
      enabled: true,
      telegram: {
        enabled: true,
        botToken: '123456:abc',
        chatId: '777',
      },
    };
    let capturedPayload: { telegramAcceptedAck?: unknown; telegramReplyTo?: unknown } | undefined;

    const result = await notifyCompletedTurn(
      decision,
      {
        sessionId: 'sess-telegram-ack',
        assistantText: 'Final answer',
        timestamp: new Date('2026-04-27T12:00:00Z').toISOString(),
      },
      undefined,
      {
        getNotificationConfigImpl: () => config,
        isEventEnabledImpl: () => true,
        ensureReplyListenerForConfigImpl: () => {},
        dispatchNotificationsImpl: async (_config: FullNotificationConfig, event: string, payload: unknown) => {
          capturedPayload = payload as { telegramAcceptedAck?: unknown; telegramReplyTo?: unknown };
          return {
            event: event as never,
            anySuccess: true,
            results: [],
          };
        },
      },
    );

    assert.ok(result);
    assert.deepEqual(capturedPayload?.telegramAcceptedAck, {
      chatId: '777',
      messageId: '701',
      messageThreadId: '9001',
    });
    assert.deepEqual(capturedPayload?.telegramReplyTo, {
      chatId: '777',
      messageId: '350',
      messageThreadId: '9001',
    });
  });

  it('shows Telegram progress inline by default when the trace fits', async () => {
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const tempHome = mkdtempSync(join(tmpdir(), 'omx-notify-index-progress-home-'));
    const projectPath = mkdtempSync(join(tmpdir(), 'omx-notify-index-progress-project-'));

    try {
      process.env.HOME = tempHome;
      process.env.USERPROFILE = tempHome;
      const {
        notifyCompletedTurn,
        planCompletedTurnNotification,
      } = await import(`../index.js?completed-turn-progress=${Date.now()}`);
      const {
        appendTelegramProgressEntry,
        loadTelegramProgressFinalState,
      } = await import(`../telegram-progress.js?completed-turn-progress=${Date.now()}`);
      const assistantText = '**Final** answer';
      const decision = planCompletedTurnNotification({
        semanticOutcome: {
          kind: 'result-ready',
          summary: 'Done.',
          notificationEvent: 'result-ready',
        },
        assistantText,
        turnId: 'turn-progress-button',
      });
      assert.ok(decision);
      await appendTelegramProgressEntry(projectPath, 'sess-progress-button', 'turn-progress-button', {
        kind: 'commentary',
        text: 'Public progress update',
      });

      const config: FullNotificationConfig = {
        enabled: true,
        telegram: {
          enabled: true,
          botToken: '123456:abc',
          chatId: '777',
          progress: {
            enabled: true,
            mode: 'peek',
            transport: 'draft',
            showButton: true,
            fullTraceDelivery: 'message',
          },
        },
      };
      let capturedPayload: {
        message?: string;
        transportOverrides?: {
          telegram?: {
            message?: string;
            entities?: Array<{ type: string; offset: number; length: number }>;
            parseMode?: 'Markdown' | 'HTML' | null;
            replyMarkup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
          };
        };
        telegramProgressFinal?: { token: string; shown?: boolean };
      } | undefined;

      const result = await notifyCompletedTurn(
        decision,
        {
          sessionId: 'sess-progress-button',
          assistantText,
          projectPath,
          tmuxPaneId: '%42',
          tmuxSession: 'omx-test',
        },
        undefined,
        {
          getNotificationConfigImpl: () => config,
          isEventEnabledImpl: () => true,
          ensureReplyListenerForConfigImpl: () => {},
          dispatchNotificationsImpl: async (_config: FullNotificationConfig, event: string, payload: unknown) => {
            capturedPayload = payload as typeof capturedPayload;
            return {
              event: event as never,
              anySuccess: true,
              results: [{
                platform: 'telegram',
                success: true,
                messageId: '501',
                messageThreadId: '9001',
              }],
            };
          },
        },
      );

      assert.ok(result);
      const button = capturedPayload?.transportOverrides?.telegram?.replyMarkup?.inline_keyboard[0]?.[0];
      assert.equal(button?.text, 'Скрыть ход');
      assert.match(button?.callback_data ?? '', /^omx:pg:/);
      assert.match(capturedPayload?.transportOverrides?.telegram?.message ?? '', /Public progress update/);
      assert.match(capturedPayload?.transportOverrides?.telegram?.message ?? '', /Final answer/);
      assert.equal(capturedPayload?.transportOverrides?.telegram?.parseMode, null);
      assert.equal(capturedPayload?.transportOverrides?.telegram?.entities?.[0]?.type, 'expandable_blockquote');
      assert.ok(capturedPayload?.telegramProgressFinal?.token);
      assert.equal(capturedPayload?.telegramProgressFinal?.shown, true);
      const finalState = await loadTelegramProgressFinalState(
        projectPath,
        'sess-progress-button',
        capturedPayload.telegramProgressFinal.token,
      );
      assert.equal(finalState?.finalText, 'Final answer');
      assert.equal(finalState?.finalParseMode, null);
      assert.equal(finalState?.finalEntities?.[0]?.type, 'bold');
      assert.equal(finalState?.messageId, '501');
      assert.equal(finalState?.fullTraceDelivery, 'message');
      assert.equal(finalState?.shown, true);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
      rmSync(projectPath, { recursive: true, force: true });
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('keeps oversized Telegram finals clean and uses the progress button fallback', async () => {
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const tempHome = mkdtempSync(join(tmpdir(), 'omx-notify-index-progress-home-'));
    const projectPath = mkdtempSync(join(tmpdir(), 'omx-notify-index-progress-project-'));

    try {
      process.env.HOME = tempHome;
      process.env.USERPROFILE = tempHome;
      const {
        notifyCompletedTurn,
        planCompletedTurnNotification,
      } = await import(`../index.js?completed-turn-progress-overflow=${Date.now()}`);
      const {
        appendTelegramProgressEntry,
      } = await import(`../telegram-progress.js?completed-turn-progress-overflow=${Date.now()}`);
      const assistantText = 'Final answer '.repeat(500);
      const decision = planCompletedTurnNotification({
        semanticOutcome: {
          kind: 'result-ready',
          summary: 'Done.',
          notificationEvent: 'result-ready',
        },
        assistantText,
        turnId: 'turn-progress-overflow',
      });
      assert.ok(decision);
      await appendTelegramProgressEntry(projectPath, 'sess-progress-overflow', 'turn-progress-overflow', {
        kind: 'commentary',
        text: 'Public progress update',
      });

      const config: FullNotificationConfig = {
        enabled: true,
        telegram: {
          enabled: true,
          botToken: '123456:abc',
          chatId: '777',
          progress: {
            enabled: true,
            mode: 'peek',
            transport: 'draft',
            showButton: true,
            fullTraceDelivery: 'message',
          },
        },
      };
      let capturedPayload: {
        transportOverrides?: {
          telegram?: {
            message?: string;
            replyMarkup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
          };
        };
        telegramProgressFinal?: { token: string; shown?: boolean };
      } | undefined;

      await notifyCompletedTurn(
        decision,
        {
          sessionId: 'sess-progress-overflow',
          assistantText,
          projectPath,
          tmuxPaneId: '%42',
          tmuxSession: 'omx-test',
        },
        undefined,
        {
          getNotificationConfigImpl: () => config,
          isEventEnabledImpl: () => true,
          ensureReplyListenerForConfigImpl: () => {},
          dispatchNotificationsImpl: async (_config: FullNotificationConfig, event: string, payload: unknown) => {
            capturedPayload = payload as typeof capturedPayload;
            return {
              event: event as never,
              anySuccess: true,
              results: [{
                platform: 'telegram',
                success: true,
                messageId: '502',
                messageIds: ['502', '503'],
                messageThreadId: '9001',
              }],
            };
          },
        },
      );

      const button = capturedPayload?.transportOverrides?.telegram?.replyMarkup?.inline_keyboard[0]?.[0];
      assert.equal(button?.text, 'Показать ход');
      assert.equal(capturedPayload?.transportOverrides?.telegram?.message, assistantText.trim());
      assert.doesNotMatch(capturedPayload?.transportOverrides?.telegram?.message ?? '', /Public progress update/);
      assert.equal(capturedPayload?.telegramProgressFinal?.shown, false);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
      rmSync(projectPath, { recursive: true, force: true });
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('omits Telegram progress buttons when a rich-media final answer has no safe text anchor', async () => {
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const tempHome = mkdtempSync(join(tmpdir(), 'omx-notify-index-progress-home-'));
    const projectPath = mkdtempSync(join(tmpdir(), 'omx-notify-index-progress-project-'));

    try {
      process.env.HOME = tempHome;
      process.env.USERPROFILE = tempHome;
      const {
        notifyCompletedTurn,
        planCompletedTurnNotification,
      } = await import(`../index.js?completed-turn-progress-rich=${Date.now()}`);
      const {
        appendTelegramProgressEntry,
      } = await import(`../telegram-progress.js?completed-turn-progress-rich=${Date.now()}`);
      const decision = planCompletedTurnNotification({
        semanticOutcome: {
          kind: 'result-ready',
          summary: 'Done.',
          notificationEvent: 'result-ready',
        },
        assistantText: 'Final answer',
        turnId: 'turn-progress-rich',
      });
      assert.ok(decision);
      await appendTelegramProgressEntry(projectPath, 'sess-progress-rich', 'turn-progress-rich', {
        kind: 'commentary',
        text: 'Public progress update',
      });

      const config: FullNotificationConfig = {
        enabled: true,
        telegram: {
          enabled: true,
          botToken: '123456:abc',
          chatId: '777',
          progress: {
            enabled: true,
            mode: 'peek',
            transport: 'draft',
            showButton: true,
          },
        },
      };
      let capturedPayload: {
        transportOverrides?: {
          telegram?: {
            replyMarkup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
          };
        };
        telegramProgressFinal?: { token: string };
      } | undefined;

      await notifyCompletedTurn(
        decision,
        {
          sessionId: 'sess-progress-rich',
          assistantText: 'Final answer',
          projectPath,
          tmuxPaneId: '%42',
          tmuxSession: 'omx-test',
          richContent: {
            parts: [
              {
                kind: 'photo',
                source: {
                  type: 'https_url',
                  url: 'https://example.test/image.png',
                  trust: 'explicit',
                },
              },
              { kind: 'text', text: 'Final answer' },
            ],
          },
        },
        undefined,
        {
          getNotificationConfigImpl: () => config,
          isEventEnabledImpl: () => true,
          ensureReplyListenerForConfigImpl: () => {},
          dispatchNotificationsImpl: async (_config: FullNotificationConfig, event: string, payload: unknown) => {
            capturedPayload = payload as typeof capturedPayload;
            return {
              event: event as never,
              anySuccess: true,
              results: [{
                platform: 'telegram',
                success: true,
                messageId: '501',
                messageIds: ['501', '502'],
              }],
            };
          },
        },
      );

      assert.equal(capturedPayload?.transportOverrides?.telegram?.replyMarkup, undefined);
      assert.equal(capturedPayload?.telegramProgressFinal, undefined);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
      rmSync(projectPath, { recursive: true, force: true });
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('omits Telegram progress buttons when result-ready route differs from the reply listener route', async () => {
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const tempHome = mkdtempSync(join(tmpdir(), 'omx-notify-index-progress-mismatch-home-'));
    const projectPath = mkdtempSync(join(tmpdir(), 'omx-notify-index-progress-mismatch-project-'));

    try {
      process.env.HOME = tempHome;
      process.env.USERPROFILE = tempHome;
      const {
        notifyCompletedTurn,
        planCompletedTurnNotification,
      } = await import(`../index.js?completed-turn-progress-mismatch=${Date.now()}`);
      const {
        appendTelegramProgressEntry,
      } = await import(`../telegram-progress.js?completed-turn-progress-mismatch=${Date.now()}`);
      const decision = planCompletedTurnNotification({
        semanticOutcome: {
          kind: 'result-ready',
          summary: 'Done.',
          notificationEvent: 'result-ready',
        },
        assistantText: 'Final answer',
        turnId: 'turn-progress-mismatch',
      });
      assert.ok(decision);
      await appendTelegramProgressEntry(projectPath, 'sess-progress-mismatch', 'turn-progress-mismatch', {
        kind: 'commentary',
        text: 'Public progress update',
      });

      const config: FullNotificationConfig = {
        enabled: true,
        telegram: {
          enabled: true,
          botToken: '123456:listener-route',
          chatId: '777',
        },
        events: {
          'result-ready': {
            enabled: true,
            telegram: {
              enabled: true,
              botToken: '123456:result-ready-route',
              chatId: '888',
              progress: {
                enabled: true,
                mode: 'peek',
                transport: 'draft',
                showButton: true,
              },
            },
          },
        },
      };
      let capturedPayload: {
        transportOverrides?: {
          telegram?: {
            replyMarkup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
          };
        };
        telegramProgressFinal?: { token: string };
      } | undefined;

      const result = await notifyCompletedTurn(
        decision,
        {
          sessionId: 'sess-progress-mismatch',
          assistantText: 'Final answer',
          projectPath,
          tmuxPaneId: '%42',
          tmuxSession: 'omx-test',
        },
        undefined,
        {
          getNotificationConfigImpl: () => config,
          isEventEnabledImpl: () => true,
          ensureReplyListenerForConfigImpl: () => {},
          dispatchNotificationsImpl: async (_config: FullNotificationConfig, event: string, payload: unknown) => {
            capturedPayload = payload as typeof capturedPayload;
            return {
              event: event as never,
              anySuccess: true,
              results: [{
                platform: 'telegram',
                success: true,
                messageId: '501',
              }],
            };
          },
        },
      );

      assert.ok(result);
      assert.equal(capturedPayload?.transportOverrides?.telegram?.replyMarkup, undefined);
      assert.equal(capturedPayload?.telegramProgressFinal, undefined);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
      rmSync(projectPath, { recursive: true, force: true });
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('registers every Telegram message id from multipart rich completed-turn deliveries for replies', async () => {
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const tempHome = mkdtempSync(join(tmpdir(), 'omx-notify-index-message-ids-home-'));
    const projectPath = mkdtempSync(join(tmpdir(), 'omx-notify-index-message-ids-project-'));

    try {
      process.env.HOME = tempHome;
      process.env.USERPROFILE = tempHome;
      const { notifyCompletedTurn, planCompletedTurnNotification } = await import(`../index.js?completed-turn-message-ids=${Date.now()}`);
      const sessionId = `sess-telegram-message-ids-${Date.now()}`;
      const decision = planCompletedTurnNotification({
        semanticOutcome: {
          kind: 'result-ready',
          summary: 'Done.',
          notificationEvent: 'result-ready',
        },
        assistantText: 'Done.',
        turnId: 'turn-telegram-message-ids',
      });
      assert.ok(decision);

      const config: FullNotificationConfig = {
        enabled: true,
        telegram: {
          enabled: true,
          botToken: '123456:abc',
          chatId: '777',
        },
      };

      const result = await notifyCompletedTurn(
        decision,
        {
          sessionId,
          assistantText: 'Done.',
          projectPath,
          tmuxPaneId: '%42',
          tmuxSession: 'omx-test',
        },
        undefined,
        {
          getNotificationConfigImpl: () => config,
          isEventEnabledImpl: () => true,
          ensureReplyListenerForConfigImpl: () => {},
          dispatchNotificationsImpl: async (_config: FullNotificationConfig, event: string) => ({
            event: event as never,
            anySuccess: true,
            results: [{
              platform: 'telegram',
              success: true,
              messageId: '501',
              messageIds: ['501', '502'],
              messageThreadId: '9001',
            }],
          }),
        },
      );

      assert.ok(result);
      const { loadAllMappings } = await import('../session-registry.js');
      const mappings = loadAllMappings()
        .filter((mapping) => mapping.sessionId === sessionId)
        .filter((mapping) => mapping.messageId === '501' || mapping.messageId === '502');
      assert.deepEqual(mappings.map((mapping) => mapping.messageId).sort(), ['501', '502']);
      assert.deepEqual(new Set(mappings.map((mapping) => mapping.tmuxPaneId)), new Set(['%42']));
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
      rmSync(projectPath, { recursive: true, force: true });
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
