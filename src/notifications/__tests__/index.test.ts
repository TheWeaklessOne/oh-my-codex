import { after, before, beforeEach, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FullNotificationConfig } from '../types.js';

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

    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? String(input) : input.url;
      if (!url.includes('127.0.0.1:18789')) {
        return new Response('', { status: 200 });
      }
      openClawCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 60));
      openClawResolved = true;
      return new Response('', { status: 200 });
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
        anySuccess: true,
        results: [{
          platform: 'webhook',
          success: true,
        }],
      }),
    });
    const askElapsed = Date.now() - askStarted;

    assert.ok(askResult);
    assert.equal(askResult.anySuccess, true);
    assert.equal(openClawCalls, 1);
    assert.equal(openClawResolved, true);
    assert.ok(askElapsed >= 50, `ask-user-question should await OpenClaw dispatch, got ${askElapsed}ms`);

    openClawCalls = 0;
    openClawResolved = false;
    const startStarted = Date.now();
    const startResult = await notifyLifecycle('session-start', {
      sessionId: `sess-start-${Date.now()}`,
      projectPath,
    }, undefined, {
      dispatchNotificationsImpl: async (_config: unknown, event: string, _payload: unknown) => ({
        event,
        anySuccess: true,
        results: [{
          platform: 'webhook',
          success: true,
        }],
      }),
    });
    const startElapsed = Date.now() - startStarted;

    assert.ok(startResult);
    assert.equal(startResult.anySuccess, true);
    assert.equal(openClawCalls, 1);
    assert.equal(openClawResolved, false, 'session-start should keep fire-and-forget OpenClaw dispatch');
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(openClawResolved, true, 'session-start should eventually finish the deferred OpenClaw dispatch');
    assert.ok(
      startElapsed < askElapsed,
      `session-start should remain faster than awaited ask-user-question dispatch (start=${startElapsed}ms ask=${askElapsed}ms)`,
    );
    assert.ok(startElapsed < 60, `session-start should return before the 60ms OpenClaw dispatch delay, got ${startElapsed}ms`);

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
