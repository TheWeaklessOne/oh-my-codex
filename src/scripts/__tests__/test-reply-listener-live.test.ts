import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDiscordReplySource, buildTelegramReplySource } from '../../notifications/reply-source.js';
import {
  inspectReplyListenerStatusForLiveSmoke,
  resolveReplyListenerLiveEnv,
  runReplyListenerLiveSmoke,
} from '../test-reply-listener-live.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return new Response(JSON.stringify(body), { ...init, headers });
}

test('resolveReplyListenerLiveEnv stays disabled until explicitly opted in', () => {
  const result = resolveReplyListenerLiveEnv({
    OMX_DISCORD_NOTIFIER_BOT_TOKEN: 'discord-token',
    OMX_DISCORD_NOTIFIER_CHANNEL: 'channel-1',
    OMX_TELEGRAM_BOT_TOKEN: 'telegram-token',
    OMX_TELEGRAM_CHAT_ID: 'chat-1',
  });

  assert.deepEqual(result, {
    enabled: false,
    missing: [],
    config: null,
  });
});

test('resolveReplyListenerLiveEnv reports missing credentials when opted in', () => {
  const result = resolveReplyListenerLiveEnv({
    OMX_REPLY_LISTENER_LIVE: '1',
    OMX_DISCORD_NOTIFIER_BOT_TOKEN: 'discord-token',
    OMX_TELEGRAM_CHAT_ID: 'chat-1',
  });

  assert.equal(result.enabled, true);
  assert.deepEqual(result.missing, [
    'OMX_DISCORD_NOTIFIER_CHANNEL',
    'OMX_TELEGRAM_BOT_TOKEN',
  ]);
  assert.equal(result.config, null);
});

test('resolveReplyListenerLiveEnv exposes reply-listener expectation defaults and env overrides', () => {
  const result = resolveReplyListenerLiveEnv({
    OMX_REPLY_LISTENER_LIVE: '1',
    OMX_DISCORD_NOTIFIER_BOT_TOKEN: 'discord-token',
    OMX_DISCORD_NOTIFIER_CHANNEL: 'channel-1',
    OMX_TELEGRAM_BOT_TOKEN: 'telegram-token',
    OMX_TELEGRAM_CHAT_ID: 'chat-1',
    OMX_REPLY_ACK_MODE: 'summary',
    OMX_REPLY_TELEGRAM_POLL_TIMEOUT_SECONDS: '45',
    OMX_REPLY_TELEGRAM_ALLOWED_UPDATES: 'message,edited_message',
    OMX_REPLY_TELEGRAM_STARTUP_BACKLOG: 'drop_pending',
    OMX_REPLY_TELEGRAM_USER_IDS: '1001,1002',
  });

  assert.equal(result.enabled, true);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.config?.expectations, {
    ackMode: 'summary',
    telegramPollTimeoutSeconds: 45,
    telegramAllowedUpdates: ['message', 'edited_message'],
    telegramStartupBacklogPolicy: 'drop_pending',
    authorizedTelegramUserIdsConfigured: true,
  });
});

test('runReplyListenerLiveSmoke exercises Discord and Telegram send + cleanup requests', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const logs: string[] = [];
  const discordSource = buildDiscordReplySource('discord-token', 'channel-1');
  const telegramSource = buildTelegramReplySource('123456:telegram-token', 'chat-1');

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });

    if (url === 'https://discord.com/api/v10/channels/channel-1/messages') {
      assert.equal(init?.method, 'POST');
      assert.match(String(init?.body), /Discord connectivity probe/);
      return jsonResponse({ id: 'discord-message-1' });
    }

    if (url === 'https://discord.com/api/v10/channels/channel-1/messages/discord-message-1') {
      assert.equal(init?.method, 'DELETE');
      return new Response(null, { status: 204 });
    }

    if (url === 'https://api.telegram.org/bot123456:telegram-token/sendMessage') {
      assert.equal(init?.method, 'POST');
      assert.match(String(init?.body), /Telegram connectivity probe/);
      return jsonResponse({ ok: true, result: { message_id: 42 } });
    }

    if (url === 'https://api.telegram.org/bot123456:telegram-token/deleteMessage') {
      assert.equal(init?.method, 'POST');
      const payload = JSON.parse(String(init?.body)) as { chat_id: string; message_id: number };
      assert.deepEqual(payload, { chat_id: 'chat-1', message_id: 42 });
      return jsonResponse({ ok: true, result: true });
    }

    throw new Error(`Unexpected live smoke fetch url: ${url}`);
  };

  const result = await runReplyListenerLiveSmoke(
    {
      discordBotToken: 'discord-token',
      discordChannelId: 'channel-1',
      telegramBotToken: '123456:telegram-token',
      telegramChatId: 'chat-1',
      expectations: {
        ackMode: 'minimal',
        telegramPollTimeoutSeconds: 30,
        telegramAllowedUpdates: ['message'],
        telegramStartupBacklogPolicy: 'resume',
        authorizedTelegramUserIdsConfigured: false,
      },
    },
    {
      fetchImpl,
      readReplyListenerStatusImpl: () => ({
        success: true,
        message: 'Reply listener daemon is running (2 active sources)',
        diagnostics: {
          ackMode: 'minimal',
          pollIntervalMs: 3000,
          rateLimitPerMinute: 10,
          includePrefix: true,
          telegramPollTimeoutSeconds: 30,
          telegramAllowedUpdates: ['message'],
          telegramStartupBacklogPolicy: 'resume',
          authorizedDiscordUsersConfigured: true,
          authorizedTelegramUserIdsConfigured: false,
          secretStorage: 'not-persisted',
          activeSources: [
            {
              key: discordSource.key,
              platform: 'discord-bot',
              label: 'discord-bot:discord-channel',
              cursor: 'discord-message-77',
              lastPollAt: '2026-03-20T00:05:00.000Z',
              lastIngestAt: '2026-03-20T00:05:01.000Z',
              lastFailureAt: null,
              lastFailureCategory: null,
              lastFailureMessage: null,
              failureCounts: {},
            },
            {
              key: telegramSource.key,
              platform: 'telegram',
              label: telegramSource.label,
              cursor: 77,
              lastPollAt: '2026-03-20T00:06:00.000Z',
              lastIngestAt: '2026-03-20T00:06:01.000Z',
              lastFailureAt: null,
              lastFailureCategory: null,
              lastFailureMessage: null,
              failureCounts: {},
            },
          ],
        },
      }),
      log: (message) => logs.push(message),
    },
  );

  assert.deepEqual(result, {
    discordMessageId: 'discord-message-1',
    telegramMessageId: '42',
    replyListenerStatus: {
      ackMode: 'minimal',
      telegramPollTimeoutSeconds: 30,
      telegramAllowedUpdates: ['message'],
      telegramStartupBacklogPolicy: 'resume',
      authorizedTelegramUserIdsConfigured: false,
      activeSourceKeys: [discordSource.key, telegramSource.key],
      secretStorage: 'not-persisted',
    },
  });
  assert.equal(calls.length, 4);
  assert.ok(logs.some((entry) => entry.includes('Reply listener expectations: ack=minimal')));
  assert.ok(logs.some((entry) => entry.includes('Discord probe message sent: discord-message-1')));
  assert.ok(logs.some((entry) => entry.includes('Telegram probe message sent: 42')));
  assert.ok(logs.some((entry) => entry.includes(`Reply listener status verified: sources=${discordSource.key},${telegramSource.key}`)));
});

test('inspectReplyListenerStatusForLiveSmoke validates live reply-listener expectations against source-aware diagnostics', () => {
  const discordSource = buildDiscordReplySource('discord-token', 'channel-1');
  const telegramSource = buildTelegramReplySource('123456:telegram-token', 'chat-1');
  const result = inspectReplyListenerStatusForLiveSmoke(
    {
      discordBotToken: 'discord-token',
      discordChannelId: 'channel-1',
      telegramBotToken: '123456:telegram-token',
      telegramChatId: 'chat-1',
      expectations: {
        ackMode: 'summary',
        telegramPollTimeoutSeconds: 45,
        telegramAllowedUpdates: ['message', 'edited_message'],
        telegramStartupBacklogPolicy: 'drop_pending',
        authorizedTelegramUserIdsConfigured: true,
      },
    },
    {
      readReplyListenerStatusImpl: () => ({
        success: true,
        message: 'Reply listener daemon is running (2 active sources)',
        diagnostics: {
          ackMode: 'summary',
          pollIntervalMs: 3000,
          rateLimitPerMinute: 10,
          includePrefix: true,
          telegramPollTimeoutSeconds: 45,
          telegramAllowedUpdates: ['message', 'edited_message'],
          telegramStartupBacklogPolicy: 'drop_pending',
          authorizedDiscordUsersConfigured: true,
          authorizedTelegramUserIdsConfigured: true,
          secretStorage: 'fallback-secret-file',
          activeSources: [
            {
              key: discordSource.key,
              platform: 'discord-bot',
              label: 'discord-bot:discord-channel',
              cursor: 'discord-message-91',
              lastPollAt: null,
              lastIngestAt: null,
              lastFailureAt: null,
              lastFailureCategory: null,
              lastFailureMessage: null,
              failureCounts: {},
            },
            {
              key: telegramSource.key,
              platform: 'telegram',
              label: telegramSource.label,
              cursor: 91,
              lastPollAt: null,
              lastIngestAt: null,
              lastFailureAt: null,
              lastFailureCategory: null,
              lastFailureMessage: null,
              failureCounts: {},
            },
          ],
        },
      }),
    },
  );

  assert.deepEqual(result, {
    ackMode: 'summary',
    telegramPollTimeoutSeconds: 45,
    telegramAllowedUpdates: ['message', 'edited_message'],
    telegramStartupBacklogPolicy: 'drop_pending',
    authorizedTelegramUserIdsConfigured: true,
    activeSourceKeys: [discordSource.key, telegramSource.key],
    secretStorage: 'fallback-secret-file',
  });
});

test('inspectReplyListenerStatusForLiveSmoke fails when the daemon is not actually running', () => {
  assert.throws(
    () => inspectReplyListenerStatusForLiveSmoke(
      {
        discordBotToken: 'discord-token',
        discordChannelId: 'channel-1',
        telegramBotToken: '123456:telegram-token',
        telegramChatId: 'chat-1',
        expectations: {
          ackMode: 'minimal',
          telegramPollTimeoutSeconds: 30,
          telegramAllowedUpdates: ['message'],
          telegramStartupBacklogPolicy: 'resume',
          authorizedTelegramUserIdsConfigured: false,
        },
      },
      {
        readReplyListenerStatusImpl: () => ({
          success: true,
          message: 'Reply listener daemon is not running',
          diagnostics: {
            ackMode: 'minimal',
            pollIntervalMs: 3000,
            rateLimitPerMinute: 10,
            includePrefix: true,
            telegramPollTimeoutSeconds: 30,
            telegramAllowedUpdates: ['message'],
            telegramStartupBacklogPolicy: 'resume',
            authorizedDiscordUsersConfigured: true,
            authorizedTelegramUserIdsConfigured: false,
            secretStorage: 'not-persisted',
            activeSources: [],
          },
        }),
      },
    ),
    /reply listener is not running/i,
  );
});

test('inspectReplyListenerStatusForLiveSmoke fails when an expected source is not active', () => {
  assert.throws(
    () => inspectReplyListenerStatusForLiveSmoke(
      {
        discordBotToken: 'discord-token',
        discordChannelId: 'channel-1',
        telegramBotToken: '123456:telegram-token',
        telegramChatId: 'chat-1',
        expectations: {
          ackMode: 'summary',
          telegramPollTimeoutSeconds: 45,
          telegramAllowedUpdates: ['message', 'edited_message'],
          telegramStartupBacklogPolicy: 'drop_pending',
          authorizedTelegramUserIdsConfigured: true,
        },
      },
      {
        readReplyListenerStatusImpl: () => ({
          success: true,
          message: 'Reply listener daemon is running (1 active source)',
          diagnostics: {
            ackMode: 'summary',
            pollIntervalMs: 3000,
            rateLimitPerMinute: 10,
            includePrefix: true,
            telegramPollTimeoutSeconds: 45,
            telegramAllowedUpdates: ['message', 'edited_message'],
            telegramStartupBacklogPolicy: 'drop_pending',
            authorizedDiscordUsersConfigured: true,
            authorizedTelegramUserIdsConfigured: true,
            secretStorage: 'fallback-secret-file',
            activeSources: [
              {
                key: buildDiscordReplySource('discord-token', 'channel-1').key,
                platform: 'discord-bot',
                label: 'discord-bot:discord-channel',
                cursor: 'discord-message-91',
                lastPollAt: null,
                lastIngestAt: null,
                lastFailureAt: null,
                lastFailureCategory: null,
                lastFailureMessage: null,
                failureCounts: {},
              },
            ],
          },
        }),
      },
    ),
    /missing expected active source/i,
  );
});

test('inspectReplyListenerStatusForLiveSmoke fails when the running daemon diverges from the expected long-poll config', () => {
  assert.throws(
    () => inspectReplyListenerStatusForLiveSmoke(
      {
        discordBotToken: 'discord-token',
        discordChannelId: 'channel-1',
        telegramBotToken: '123456:telegram-token',
        telegramChatId: 'chat-1',
        expectations: {
          ackMode: 'minimal',
          telegramPollTimeoutSeconds: 30,
          telegramAllowedUpdates: ['message'],
          telegramStartupBacklogPolicy: 'resume',
          authorizedTelegramUserIdsConfigured: false,
        },
      },
      {
        readReplyListenerStatusImpl: () => ({
          success: true,
          message: 'Reply listener daemon is running',
          diagnostics: {
            ackMode: 'summary',
            pollIntervalMs: 3000,
            rateLimitPerMinute: 10,
            includePrefix: true,
            telegramPollTimeoutSeconds: 45,
            telegramAllowedUpdates: ['message', 'edited_message'],
            telegramStartupBacklogPolicy: 'drop_pending',
            authorizedDiscordUsersConfigured: true,
            authorizedTelegramUserIdsConfigured: true,
            secretStorage: 'fallback-secret-file',
            activeSources: [],
          },
        }),
      },
    ),
    /reply listener ackMode mismatch/i,
  );
});
