import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { ClientRequestArgs, IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type {
  DiscordNotificationConfig,
  DiscordBotNotificationConfig,
  TelegramNotificationConfig,
  SlackNotificationConfig,
  WebhookNotificationConfig,
  FullNotificationPayload,
  FullNotificationConfig,
} from '../types.js';
import {
  sendDiscord,
  sendDiscordBot,
  getEffectivePlatformConfig,
  sendSlack,
  sendTelegram,
  sendTelegramMessageDraft,
  sendWebhook,
  dispatchNotifications,
} from '../dispatcher.js';
import {
  TELEGRAM_CONTINUATION_PREFIX,
  TELEGRAM_CONTINUATION_SUFFIX,
} from '../telegram-entities.js';
import { getTelegramTopicRegistryRecord } from '../telegram-topic-registry.js';
import { normalizeTelegramProjectIdentity } from '../telegram-topics.js';
import { markMockTelegramTransportForTests } from '../../utils/test-env.js';

const basePayload: FullNotificationPayload = {
  event: 'session-idle',
  sessionId: 'test-session-123',
  message: 'Test notification message',
  timestamp: new Date('2025-01-15T12:00:00Z').toISOString(),
  projectPath: '/home/user/project',
  projectName: 'project',
};

afterEach(() => {
  mock.restoreAll();
});

function joinTelegramChunkTexts(texts: readonly string[]): string {
  return texts
    .map((text, index) => {
      let logicalText = text;
      if (index > 0 && logicalText.startsWith(TELEGRAM_CONTINUATION_PREFIX)) {
        logicalText = logicalText.slice(TELEGRAM_CONTINUATION_PREFIX.length);
      }
      if (index < texts.length - 1 && logicalText.endsWith(TELEGRAM_CONTINUATION_SUFFIX)) {
        logicalText = logicalText.slice(0, -TELEGRAM_CONTINUATION_SUFFIX.length);
      }
      return logicalText;
    })
    .join('');
}

type HttpsRouteHandler = (body: string, options: ClientRequestArgs) => {
  statusCode: number;
  body?: unknown;
};

function createHttpsRequestMock(
  routes: Record<string, HttpsRouteHandler>,
): typeof import('node:https').request {
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

// ---------------------------------------------------------------------------
// sendDiscord
// ---------------------------------------------------------------------------

describe('sendDiscord', () => {
  it('returns error when not enabled', async () => {
    const config: DiscordNotificationConfig = { enabled: false, webhookUrl: '' };
    const result = await sendDiscord(config, basePayload);
    assert.equal(result.success, false);
    assert.equal(result.platform, 'discord');
    assert.ok(result.error?.includes('Not configured'));
  });

  it('returns error when webhookUrl is empty', async () => {
    const config: DiscordNotificationConfig = { enabled: true, webhookUrl: '' };
    const result = await sendDiscord(config, basePayload);
    assert.equal(result.success, false);
  });

  it('rejects invalid webhook URL (non-discord host)', async () => {
    const config: DiscordNotificationConfig = {
      enabled: true,
      webhookUrl: 'https://evil.com/webhook',
    };
    const result = await sendDiscord(config, basePayload);
    assert.equal(result.success, false);
    assert.equal(result.error, 'Invalid webhook URL');
  });

  it('rejects http:// webhook URL', async () => {
    const config: DiscordNotificationConfig = {
      enabled: true,
      webhookUrl: 'http://discord.com/api/webhooks/123/abc',
    };
    const result = await sendDiscord(config, basePayload);
    assert.equal(result.success, false);
    assert.equal(result.error, 'Invalid webhook URL');
  });

  it('rejects malformed URL', async () => {
    const config: DiscordNotificationConfig = {
      enabled: true,
      webhookUrl: 'not-a-url',
    };
    const result = await sendDiscord(config, basePayload);
    assert.equal(result.success, false);
    assert.equal(result.error, 'Invalid webhook URL');
  });
});

// ---------------------------------------------------------------------------
// sendDiscordBot
// ---------------------------------------------------------------------------

describe('sendDiscordBot', () => {
  it('returns error when not enabled', async () => {
    const config: DiscordBotNotificationConfig = { enabled: false };
    const result = await sendDiscordBot(config, basePayload);
    assert.equal(result.success, false);
    assert.equal(result.platform, 'discord-bot');
    assert.ok(result.error?.includes('Not enabled'));
  });

  it('returns error when missing botToken', async () => {
    const config: DiscordBotNotificationConfig = {
      enabled: true,
      channelId: '123456',
    };
    const result = await sendDiscordBot(config, basePayload);
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('Missing botToken or channelId'));
  });

  it('returns error when missing channelId', async () => {
    const config: DiscordBotNotificationConfig = {
      enabled: true,
      botToken: 'token',
    };
    const result = await sendDiscordBot(config, basePayload);
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('Missing botToken or channelId'));
  });
});

// ---------------------------------------------------------------------------
// sendTelegram
// ---------------------------------------------------------------------------

describe('sendTelegram', () => {
  it('blocks live Telegram sends in tests unless the request transport is mocked', async () => {
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: '123456:abc',
      chatId: '777',
    };
    let resolverCalled = false;

    const result = await sendTelegram(
      config,
      basePayload,
      {
        resolveTelegramDestinationImpl: async () => {
          resolverCalled = true;
          return {
            chatId: '777',
            sourceChatKey: 'telegram:123456:777',
          };
        },
      },
    );

    assert.equal(result.success, false);
    assert.equal(result.error, 'Live Telegram sends are disabled while running tests');
    assert.equal(resolverCalled, false);
  });

  it('also blocks tests that accidentally pass the real Telegram transport explicitly', async () => {
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: '123456:abc',
      chatId: '777',
    };
    let resolverCalled = false;

    const result = await sendTelegram(
      config,
      basePayload,
      {
        resolveTelegramDestinationImpl: async () => {
          resolverCalled = true;
          return {
            chatId: '777',
            sourceChatKey: 'telegram:123456:777',
          };
        },
        httpsRequestImpl: httpsRequest,
      },
    );

    assert.equal(result.success, false);
    assert.equal(result.error, 'Live Telegram sends are disabled while running tests');
    assert.equal(resolverCalled, false);
  });

  it('also blocks unmarked wrapper transports in tests', async () => {
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: '123456:abc',
      chatId: '777',
    };
    let resolverCalled = false;
    const wrapperTransport = ((...args: Parameters<typeof httpsRequest>) => {
      return httpsRequest(...args);
    }) as typeof httpsRequest;

    const result = await sendTelegram(
      config,
      basePayload,
      {
        resolveTelegramDestinationImpl: async () => {
          resolverCalled = true;
          return {
            chatId: '777',
            sourceChatKey: 'telegram:123456:777',
          };
        },
        httpsRequestImpl: wrapperTransport,
      },
    );

    assert.equal(result.success, false);
    assert.equal(result.error, 'Live Telegram sends are disabled while running tests');
    assert.equal(resolverCalled, false);
  });

  it('surfaces Telegram HTTP failure status codes in transport results', async () => {
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: '123456:abc',
      chatId: '777',
    };

    const result = await sendTelegram(
      config,
      basePayload,
      {
        resolveTelegramDestinationImpl: async () => ({
          chatId: '777',
          sourceChatKey: 'telegram:123456:777',
        }),
        httpsRequestImpl: createHttpsRequestMock({
          [`POST /bot${config.botToken}/sendMessage`]: () => ({
            statusCode: 504,
            body: {
              ok: false,
              error_code: 504,
              description: 'Gateway timeout',
            },
          }),
        }),
      },
    );

    assert.equal(result.success, false);
    assert.equal(result.statusCode, 504);
  });

  it('passes message_thread_id and returns topic metadata when the resolver selects a project topic', async () => {
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: '123456:abc',
      chatId: '777',
      projectTopics: { enabled: true },
    };
    let requestBody = '';

    const result = await sendTelegram(
      config,
      basePayload,
      {
        resolveTelegramDestinationImpl: async () => ({
          chatId: '777',
          sourceChatKey: 'telegram:123456:777',
          messageThreadId: '9001',
          projectKey: 'project-key-1',
          topicName: 'project-a',
        }),
        httpsRequestImpl: createHttpsRequestMock({
          [`POST /bot${config.botToken}/sendMessage`]: (body) => {
            requestBody = body;
            return {
              statusCode: 200,
              body: {
                ok: true,
                result: {
                  message_id: 321,
                  message_thread_id: 9001,
                  is_topic_message: true,
                },
              },
            };
          },
        }),
      },
    );

    assert.equal(result.success, true);
    assert.equal(result.messageId, '321');
    assert.equal(result.messageThreadId, '9001');
    assert.equal(result.projectKey, 'project-key-1');
    assert.equal(result.topicName, 'project-a');

    const parsedBody = JSON.parse(requestBody) as {
      chat_id: string;
      text: string;
      parse_mode: string;
      message_thread_id: number;
    };
    assert.equal(parsedBody.chat_id, '777');
    assert.equal(parsedBody.text, basePayload.message);
    assert.equal(parsedBody.parse_mode, 'Markdown');
    assert.equal(parsedBody.message_thread_id, 9001);
  });

  it('passes Telegram inline reply markup on the first text chunk', async () => {
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: '123456:abc',
      chatId: '777',
    };
    let requestBody = '';

    const result = await sendTelegram(
      config,
      {
        ...basePayload,
        transportOverrides: {
          telegram: {
            replyMarkup: {
              inline_keyboard: [[
                { text: 'Показать ход', callback_data: 'omx:pg:abc123' },
              ]],
            },
          },
        },
      },
      {
        resolveTelegramDestinationImpl: async () => ({
          chatId: '777',
          sourceChatKey: 'telegram:123456:777',
        }),
        httpsRequestImpl: createHttpsRequestMock({
          [`POST /bot${config.botToken}/sendMessage`]: (body) => {
            requestBody = body;
            return {
              statusCode: 200,
              body: { ok: true, result: { message_id: 321 } },
            };
          },
        }),
      },
    );

    assert.equal(result.success, true);
    const parsedBody = JSON.parse(requestBody) as Record<string, unknown>;
    assert.deepEqual(parsedBody.reply_markup, {
      inline_keyboard: [[
        { text: 'Показать ход', callback_data: 'omx:pg:abc123' },
      ]],
    });
  });

  it('sends Telegram progress drafts with sendMessageDraft', async () => {
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: '123456:abc',
      chatId: '777',
      progress: {
        enabled: true,
        mode: 'peek',
        transport: 'draft',
      },
    };
    let requestBody = '';

    const result = await sendTelegramMessageDraft(
      config,
      basePayload,
      {
        draftId: 42,
        text: 'live progress',
        parseMode: 'HTML',
      },
      {
        resolveTelegramDestinationImpl: async () => ({
          chatId: '777',
          sourceChatKey: 'telegram:123456:777',
          messageThreadId: '9001',
        }),
        httpsRequestImpl: createHttpsRequestMock({
          [`POST /bot${config.botToken}/sendMessageDraft`]: (body) => {
            requestBody = body;
            return {
              statusCode: 200,
              body: { ok: true, result: true },
            };
          },
        }),
      },
    );

    assert.equal(result.sent, true);
    const parsedBody = JSON.parse(requestBody) as Record<string, unknown>;
    assert.equal(parsedBody.chat_id, '777');
    assert.equal(parsedBody.draft_id, 42);
    assert.equal(parsedBody.text, 'live progress');
    assert.equal(parsedBody.parse_mode, 'HTML');
    assert.equal(parsedBody.message_thread_id, 9001);
  });

  it('treats Telegram progress draft failures as non-fatal', async () => {
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: '123456:draft-failure',
      chatId: '778',
      progress: {
        enabled: true,
        mode: 'peek',
        transport: 'draft',
      },
    };
    let now = 1_700_000_000_000;
    let attempts = 0;
    mock.method(Date, 'now', () => now);

    const result = await sendTelegramMessageDraft(
      config,
      basePayload,
      { draftId: 42, text: 'live progress' },
      {
        resolveTelegramDestinationImpl: async () => ({
          chatId: '778',
          sourceChatKey: 'telegram:123456:778',
        }),
        httpsRequestImpl: createHttpsRequestMock({
          [`POST /bot${config.botToken}/sendMessageDraft`]: () => {
            attempts += 1;
            return {
              statusCode: 400,
              body: { ok: false, description: 'draft unsupported' },
            };
          },
        }),
      },
    );

    assert.equal(result.sent, false);
    assert.match(result.error ?? '', /draft unsupported/);

    const cached = await sendTelegramMessageDraft(
      config,
      basePayload,
      { draftId: 42, text: 'live progress' },
      {
        resolveTelegramDestinationImpl: async () => ({
          chatId: '778',
          sourceChatKey: 'telegram:123456:778',
        }),
        httpsRequestImpl: createHttpsRequestMock({
          [`POST /bot${config.botToken}/sendMessageDraft`]: () => {
            attempts += 1;
            return {
              statusCode: 200,
              body: { ok: true, result: true },
            };
          },
        }),
      },
    );

    assert.equal(cached.sent, false);
    assert.equal(cached.suppressedReason, 'draft-failure-cached');
    assert.equal(attempts, 1);

    now += 10 * 60_000 + 1;
    const recovered = await sendTelegramMessageDraft(
      config,
      basePayload,
      { draftId: 42, text: 'live progress recovered' },
      {
        resolveTelegramDestinationImpl: async () => ({
          chatId: '778',
          sourceChatKey: 'telegram:123456:778',
        }),
        httpsRequestImpl: createHttpsRequestMock({
          [`POST /bot${config.botToken}/sendMessageDraft`]: () => {
            attempts += 1;
            return {
              statusCode: 200,
              body: { ok: true, result: true },
            };
          },
        }),
      },
    );

    assert.equal(recovered.sent, true);
    assert.equal(attempts, 2);
  });

  it('skips Telegram progress drafts when progress is disabled', async () => {
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: '123456:abc',
      chatId: '777',
      progress: {
        enabled: false,
        mode: 'off',
        transport: 'none',
      },
    };

    const result = await sendTelegramMessageDraft(
      config,
      basePayload,
      { draftId: 42, text: 'live progress' },
      {
        resolveTelegramDestinationImpl: async () => {
          throw new Error('resolver should not run when drafts are disabled');
        },
        httpsRequestImpl: createHttpsRequestMock({}),
      },
    );

    assert.equal(result.sent, false);
    assert.equal(result.suppressedReason, 'progress-disabled');
  });

  it('sends Telegram final answers as fresh non-silent messages then deletes accepted placeholders', async () => {
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: '123456:abc',
      chatId: '777',
      projectTopics: { enabled: true },
    };
    const requestOrder: string[] = [];
    const sendBodies: Array<Record<string, unknown>> = [];
    const deleteBodies: Array<Record<string, unknown>> = [];

    const result = await sendTelegram(
      config,
      {
        ...basePayload,
        event: 'result-ready',
        message: 'Delayed final answer',
        telegramAcceptedAck: {
          chatId: '777',
          messageId: '701',
          messageThreadId: '9001',
        },
      },
      {
        resolveTelegramDestinationImpl: async () => ({
          chatId: '777',
          sourceChatKey: 'telegram:123456:777',
          messageThreadId: '9001',
          projectKey: 'project-key-1',
          topicName: 'project-a',
        }),
        httpsRequestImpl: createHttpsRequestMock({
          [`POST /bot${config.botToken}/sendMessage`]: (body) => {
            requestOrder.push('sendMessage');
            sendBodies.push(JSON.parse(body) as Record<string, unknown>);
            return {
              statusCode: 200,
              body: {
                ok: true,
                result: {
                  message_id: 702,
                  message_thread_id: 9001,
                  is_topic_message: true,
                },
              },
            };
          },
          [`POST /bot${config.botToken}/deleteMessage`]: (body) => {
            requestOrder.push('deleteMessage');
            deleteBodies.push(JSON.parse(body) as Record<string, unknown>);
            return {
              statusCode: 200,
              body: { ok: true, result: true },
            };
          },
        }),
      },
    );

    assert.equal(result.success, true);
    assert.deepEqual(requestOrder, ['sendMessage', 'deleteMessage']);
    const sendBody = sendBodies[0] ?? {};
    assert.equal(sendBody.text, 'Delayed final answer');
    assert.equal(sendBody.message_thread_id, 9001);
    assert.equal('disable_notification' in sendBody, false);
    assert.deepEqual(deleteBodies[0], { chat_id: '777', message_id: '701' });
  });

  it('sends Telegram topic final answers as replies before deleting launch placeholders', async () => {
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: '123456:abc',
      chatId: '777',
      projectTopics: { enabled: true },
    };
    const requestOrder: string[] = [];
    const sendBodies: Array<Record<string, unknown>> = [];
    const deleteBodies: Array<Record<string, unknown>> = [];

    const result = await sendTelegram(
      config,
      {
        ...basePayload,
        event: 'result-ready',
        message: 'Final topic answer',
        telegramReplyTo: {
          chatId: '777',
          messageId: '350',
          messageThreadId: '9001',
        },
        telegramAcceptedAck: {
          chatId: '777',
          messageId: '551',
          messageThreadId: '9001',
        },
      },
      {
        resolveTelegramDestinationImpl: async () => ({
          chatId: '777',
          sourceChatKey: 'telegram:123456:777',
          messageThreadId: '9001',
          projectKey: 'project-key-1',
          topicName: 'project-a',
        }),
        httpsRequestImpl: createHttpsRequestMock({
          [`POST /bot${config.botToken}/sendMessage`]: (body) => {
            requestOrder.push('sendMessage');
            sendBodies.push(JSON.parse(body) as Record<string, unknown>);
            return {
              statusCode: 200,
              body: {
                ok: true,
                result: {
                  message_id: 702,
                  message_thread_id: 9001,
                  is_topic_message: true,
                },
              },
            };
          },
          [`POST /bot${config.botToken}/deleteMessage`]: (body) => {
            requestOrder.push('deleteMessage');
            deleteBodies.push(JSON.parse(body) as Record<string, unknown>);
            return {
              statusCode: 200,
              body: { ok: true, result: true },
            };
          },
        }),
      },
    );

    assert.equal(result.success, true);
    assert.deepEqual(requestOrder, ['sendMessage', 'deleteMessage']);
    const sendBody = sendBodies[0] ?? {};
    assert.equal(sendBody.text, 'Final topic answer');
    assert.equal(sendBody.message_thread_id, 9001);
    assert.equal(sendBody.reply_to_message_id, 350);
    assert.deepEqual(deleteBodies[0], { chat_id: '777', message_id: '551' });
  });

  it('omits Telegram final reply targets when chat or thread context does not match', async () => {
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: '123456:abc',
      chatId: '777',
      projectTopics: { enabled: true },
    };
    const cases = [
      {
        name: 'chat mismatch',
        replyTo: { chatId: '777', messageId: '350', messageThreadId: '9001' },
        destination: {
          chatId: '888',
          sourceChatKey: 'telegram:123456:888',
          messageThreadId: '9001',
        },
      },
      {
        name: 'target thread without destination thread',
        replyTo: { chatId: '777', messageId: '351', messageThreadId: '9001' },
        destination: {
          chatId: '777',
          sourceChatKey: 'telegram:123456:777',
        },
      },
      {
        name: 'destination thread without target thread',
        replyTo: { chatId: '777', messageId: '352' },
        destination: {
          chatId: '777',
          sourceChatKey: 'telegram:123456:777',
          messageThreadId: '9001',
        },
      },
      {
        name: 'thread mismatch',
        replyTo: { chatId: '777', messageId: '353', messageThreadId: '9001' },
        destination: {
          chatId: '777',
          sourceChatKey: 'telegram:123456:777',
          messageThreadId: '9002',
        },
      },
      {
        name: 'fallback destination',
        replyTo: { chatId: '777', messageId: '354' },
        destination: {
          chatId: '777',
          sourceChatKey: 'telegram:123456:777',
          usedFallback: true,
        },
      },
    ] as const;

    for (const testCase of cases) {
      let sendBody: Record<string, unknown> | null = null;
      const result = await sendTelegram(
        config,
        {
          ...basePayload,
          event: 'result-ready',
          message: `Final answer for ${testCase.name}`,
          telegramReplyTo: testCase.replyTo,
        },
        {
          resolveTelegramDestinationImpl: async () => testCase.destination,
          httpsRequestImpl: createHttpsRequestMock({
            [`POST /bot${config.botToken}/sendMessage`]: (body) => {
              sendBody = JSON.parse(body) as Record<string, unknown>;
              return {
                statusCode: 200,
                body: {
                  ok: true,
                  result: {
                    message_id: 800,
                    ...(sendBody.message_thread_id
                      ? {
                          message_thread_id: sendBody.message_thread_id,
                          is_topic_message: true,
                        }
                      : {}),
                  },
                },
              };
            },
          }),
        },
      );

      assert.equal(result.success, true, testCase.name);
      assert.ok(sendBody, testCase.name);
      assert.equal('reply_to_message_id' in sendBody, false, testCase.name);
    }
  });

  it('keeps Telegram final delivery successful when accepted placeholder deletion fails', async () => {
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: '123456:abc',
      chatId: '777',
    };
    const requestOrder: string[] = [];

    const result = await sendTelegram(
      config,
      {
        ...basePayload,
        event: 'result-ready',
        message: 'Final answer survives cleanup failure',
        telegramAcceptedAck: {
          chatId: '777',
          messageId: '701',
        },
      },
      {
        resolveTelegramDestinationImpl: async () => ({
          chatId: '777',
          sourceChatKey: 'telegram:123456:777',
        }),
        logger: {
          warn: () => {},
        },
        httpsRequestImpl: createHttpsRequestMock({
          [`POST /bot${config.botToken}/sendMessage`]: () => {
            requestOrder.push('sendMessage');
            return {
              statusCode: 200,
              body: { ok: true, result: { message_id: 703 } },
            };
          },
          [`POST /bot${config.botToken}/deleteMessage`]: () => {
            requestOrder.push('deleteMessage');
            return {
              statusCode: 400,
              body: { ok: false, description: 'message to delete not found' },
            };
          },
        }),
      },
    );

    assert.equal(result.success, true);
    assert.equal(result.messageId, '703');
    assert.deepEqual(requestOrder, ['sendMessage', 'deleteMessage']);
  });

  it('does not delete accepted Telegram placeholders when final sendMessage fails', async () => {
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: '123456:abc',
      chatId: '777',
    };
    const requestOrder: string[] = [];

    const result = await sendTelegram(
      config,
      {
        ...basePayload,
        event: 'result-ready',
        message: 'Final answer fails before cleanup',
        telegramAcceptedAck: {
          chatId: '777',
          messageId: '701',
        },
      },
      {
        resolveTelegramDestinationImpl: async () => ({
          chatId: '777',
          sourceChatKey: 'telegram:123456:777',
        }),
        httpsRequestImpl: createHttpsRequestMock({
          [`POST /bot${config.botToken}/sendMessage`]: () => {
            requestOrder.push('sendMessage');
            return {
              statusCode: 500,
              body: { ok: false, description: 'telegram unavailable' },
            };
          },
          [`POST /bot${config.botToken}/deleteMessage`]: () => {
            requestOrder.push('deleteMessage');
            return {
              statusCode: 200,
              body: { ok: true, result: true },
            };
          },
        }),
      },
    );

    assert.equal(result.success, false);
    assert.match(result.error ?? '', /telegram unavailable|HTTP 500/);
    assert.deepEqual(requestOrder, ['sendMessage']);
  });


  it('sends rich local photo payloads with topic and reply metadata before deleting the accepted ack', async () => {
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: '123456:abc',
      chatId: '777',
    };
    const tempDir = await mkdtemp(join(tmpdir(), 'omx-dispatcher-rich-photo-'));
    const photoPath = join(tempDir, 'preview.png');
    await import('node:fs/promises').then(({ writeFile }) => writeFile(photoPath, Buffer.from('png')));
    const requestOrder: string[] = [];

    try {
      const result = await sendTelegram(
        config,
        {
          ...basePayload,
          message: '',
          richContent: {
            visibleText: '',
            parts: [
              { kind: 'photo', source: { type: 'local_path', path: photoPath, trust: 'turn-artifact' } },
            ],
          },
          telegramReplyTo: { chatId: '777', messageId: '42', messageThreadId: '9001' },
          telegramAcceptedAck: { chatId: '777', messageId: '43', messageThreadId: '9001' },
        },
        {
          resolveTelegramDestinationImpl: async () => ({
            chatId: '777',
            sourceChatKey: 'telegram:123456:777',
            messageThreadId: '9001',
          }),
          httpsRequestImpl: createHttpsRequestMock({
            [`POST /bot${config.botToken}/sendChatAction`]: (body) => {
              requestOrder.push('sendChatAction');
              const parsed = JSON.parse(body) as { action?: string; message_thread_id?: number };
              assert.equal(parsed.action, 'upload_photo');
              assert.equal(parsed.message_thread_id, 9001);
              return { statusCode: 200, body: { ok: true, result: true } };
            },
            [`POST /bot${config.botToken}/sendPhoto`]: (body, options) => {
              requestOrder.push('sendPhoto');
              assert.match(String((options.headers as Record<string, unknown>)['Content-Type']), /multipart\/form-data/);
              assert.ok(body.includes('name="chat_id"\r\n\r\n777'));
              assert.ok(body.includes('name="message_thread_id"\r\n\r\n9001'));
              assert.ok(body.includes('name="reply_to_message_id"\r\n\r\n42'));
              assert.match(body, /name="photo"; filename="preview\.png"/);
              assert.ok(body.includes('Content-Type: image/png\r\n\r\npng\r\n'));
              return {
                statusCode: 200,
                body: { ok: true, result: { message_id: 1001, message_thread_id: 9001, is_topic_message: true } },
              };
            },
            [`POST /bot${config.botToken}/deleteMessage`]: (body) => {
              requestOrder.push('deleteMessage');
              const parsed = JSON.parse(body) as { message_id?: number };
              assert.equal(String(parsed.message_id), '43');
              return { statusCode: 200, body: { ok: true, result: true } };
            },
          }),
        },
      );

      assert.equal(result.success, true);
      assert.equal(result.messageId, '1001');
      assert.deepEqual(requestOrder, ['sendChatAction', 'sendPhoto', 'deleteMessage']);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('falls back to sendDocument when Telegram rejects a local sendPhoto payload as invalid', async () => {
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: '123456:abc',
      chatId: '777',
    };
    const tempDir = await mkdtemp(join(tmpdir(), 'omx-dispatcher-photo-document-retry-'));
    const photoPath = join(tempDir, 'preview.png');
    await import('node:fs/promises').then(({ writeFile }) => writeFile(photoPath, Buffer.from('png')));
    const requestOrder: string[] = [];

    try {
      const result = await sendTelegram(
        config,
        {
          ...basePayload,
          message: '',
          richContent: {
            visibleText: '',
            parts: [
              { kind: 'photo', source: { type: 'local_path', path: photoPath, trust: 'turn-artifact' } },
            ],
          },
        },
        {
          resolveTelegramDestinationImpl: async () => ({
            chatId: '777',
            sourceChatKey: 'telegram:123456:777',
            messageThreadId: '9001',
          }),
          httpsRequestImpl: createHttpsRequestMock({
            [`POST /bot${config.botToken}/sendChatAction`]: () => {
              requestOrder.push('sendChatAction');
              return { statusCode: 200, body: { ok: true, result: true } };
            },
            [`POST /bot${config.botToken}/sendPhoto`]: () => {
              requestOrder.push('sendPhoto');
              return {
                statusCode: 400,
                body: {
                  ok: false,
                  error_code: 400,
                  description: 'Bad Request: PHOTO_INVALID_DIMENSIONS',
                },
              };
            },
            [`POST /bot${config.botToken}/sendDocument`]: (body) => {
              requestOrder.push('sendDocument');
              assert.match(body, /name="document"; filename="preview\.png"/);
              assert.ok(body.includes('name="message_thread_id"\r\n\r\n9001'));
              return {
                statusCode: 200,
                body: { ok: true, result: { message_id: 1003, message_thread_id: 9001 } },
              };
            },
          }),
        },
      );

      assert.equal(result.success, true);
      assert.equal(result.messageId, '1003');
      assert.deepEqual(requestOrder, ['sendChatAction', 'sendPhoto', 'sendDocument']);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('does not upload rich media when Telegram rich replies are disabled in the effective config', async () => {
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: '123456:abc',
      chatId: '777',
      richReplies: { enabled: false },
    };
    const tempDir = await mkdtemp(join(tmpdir(), 'omx-dispatcher-rich-disabled-'));
    const photoPath = join(tempDir, 'preview.png');
    await import('node:fs/promises').then(({ writeFile }) => writeFile(photoPath, Buffer.from('png')));
    const requestOrder: string[] = [];

    try {
      const result = await sendTelegram(
        config,
        {
          ...basePayload,
          message: 'Text fallback only',
          richContent: {
            visibleText: 'Text fallback only',
            parts: [
              { kind: 'text', text: 'Text fallback only', format: 'plain' },
              { kind: 'photo', source: { type: 'local_path', path: photoPath, trust: 'turn-artifact' } },
            ],
          },
        },
        {
          resolveTelegramDestinationImpl: async () => ({
            chatId: '777',
            sourceChatKey: 'telegram:123456:777',
          }),
          httpsRequestImpl: createHttpsRequestMock({
            [`POST /bot${config.botToken}/sendMessage`]: (body) => {
              requestOrder.push('sendMessage');
              const parsed = JSON.parse(body) as { text?: string };
              assert.equal(parsed.text, 'Text fallback only');
              return {
                statusCode: 200,
                body: { ok: true, result: { message_id: 1004 } },
              };
            },
            [`POST /bot${config.botToken}/sendPhoto`]: () => {
              requestOrder.push('sendPhoto');
              return { statusCode: 500, body: { ok: false, description: 'should not upload' } };
            },
          }),
        },
      );

      assert.equal(result.success, true);
      assert.equal(result.messageId, '1004');
      assert.deepEqual(requestOrder, ['sendMessage']);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('sends rich document fallback payloads with sendDocument', async () => {
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: '123456:abc',
      chatId: '777',
    };
    const tempDir = await mkdtemp(join(tmpdir(), 'omx-dispatcher-rich-document-'));
    const documentPath = join(tempDir, 'large.png');
    await import('node:fs/promises').then(({ writeFile }) => writeFile(documentPath, Buffer.from('large')));
    const requestOrder: string[] = [];

    try {
      const result = await sendTelegram(
        config,
        {
          ...basePayload,
          message: '',
          richContent: {
            visibleText: '',
            parts: [
              {
                kind: 'document',
                source: { type: 'local_path', path: documentPath, trust: 'turn-artifact' },
                filename: 'large.png"\r\nX-Injected: 1',
                mimeType: 'image/png\r\nX-Injected: 1',
              },
            ],
          },
        },
        {
          resolveTelegramDestinationImpl: async () => ({
            chatId: '777',
            sourceChatKey: 'telegram:123456:777',
          }),
          httpsRequestImpl: createHttpsRequestMock({
            [`POST /bot${config.botToken}/sendChatAction`]: () => {
              requestOrder.push('sendChatAction');
              return { statusCode: 200, body: { ok: true, result: true } };
            },
            [`POST /bot${config.botToken}/sendDocument`]: (body) => {
              requestOrder.push('sendDocument');
              assert.doesNotMatch(body, /\r\nX-Injected/);
              assert.match(body, /name="document"; filename="large\.png___X-Injected: 1"/);
              assert.match(body, /Content-Type: application\/octet-stream/);
              assert.ok(body.includes('Content-Type: application/octet-stream\r\n\r\nlarge\r\n'));
              return {
                statusCode: 200,
                body: { ok: true, result: { message_id: 1002 } },
              };
            },
          }),
        },
      );

      assert.equal(result.success, true);
      assert.equal(result.messageId, '1002');
      assert.deepEqual(requestOrder, ['sendChatAction', 'sendDocument']);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('retries mixed rich text parts as raw text before sending media', async () => {
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: '123456:abc',
      chatId: '777',
      parseMode: 'Markdown',
    };
    const tempDir = await mkdtemp(join(tmpdir(), 'omx-dispatcher-rich-text-fallback-'));
    const photoPath = join(tempDir, 'preview.png');
    await import('node:fs/promises').then(({ writeFile }) => writeFile(photoPath, Buffer.from('png')));
    const requestOrder: string[] = [];
    const requestBodies: Array<{ text: string; parse_mode?: string; entities?: unknown[] }> = [];

    try {
      const result = await sendTelegram(
        config,
        {
          ...basePayload,
          message: '',
          richContent: {
            visibleText: '*unterminated',
            parts: [
              { kind: 'text', text: '*unterminated', format: 'markdown' },
              { kind: 'photo', source: { type: 'local_path', path: photoPath, trust: 'turn-artifact' } },
            ],
          },
        },
        {
          resolveTelegramDestinationImpl: async () => ({
            chatId: '777',
            sourceChatKey: 'telegram:123456:777',
          }),
          httpsRequestImpl: createHttpsRequestMock({
            [`POST /bot${config.botToken}/sendMessage`]: (body) => {
              requestOrder.push('sendMessage');
              requestBodies.push(JSON.parse(body));
              if (requestBodies.length === 1) {
                return {
                  statusCode: 400,
                  body: {
                    ok: false,
                    error_code: 400,
                    description: "Bad Request: can't parse entities: can't find end of the entity",
                  },
                };
              }
              return {
                statusCode: 200,
                body: { ok: true, result: { message_id: 501 } },
              };
            },
            [`POST /bot${config.botToken}/sendChatAction`]: () => {
              requestOrder.push('sendChatAction');
              return { statusCode: 200, body: { ok: true, result: true } };
            },
            [`POST /bot${config.botToken}/sendPhoto`]: (body) => {
              requestOrder.push('sendPhoto');
              assert.match(body, /name="photo"; filename="preview\.png"/);
              return {
                statusCode: 200,
                body: { ok: true, result: { message_id: 502 } },
              };
            },
          }),
        },
      );

      assert.equal(result.success, true);
      assert.deepEqual(requestOrder, ['sendMessage', 'sendMessage', 'sendChatAction', 'sendPhoto']);
      assert.equal(requestBodies[0].parse_mode, 'Markdown');
      assert.equal('parse_mode' in requestBodies[1], false);
      assert.equal('entities' in requestBodies[1], false);
      assert.equal(requestBodies[1].text, '*unterminated');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('uses rich text part content instead of the completed-turn telegram message override', async () => {
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: '123456:abc',
      chatId: '777',
    };
    let requestBody: { text?: string; entities?: unknown[] } | null = null;
    const tempDir = await mkdtemp(join(tmpdir(), 'omx-dispatcher-rich-text-override-'));
    const photoPath = join(tempDir, 'preview.png');
    await import('node:fs/promises').then(({ writeFile }) => writeFile(photoPath, Buffer.from('png')));

    try {
      const result = await sendTelegram(
        config,
        {
          ...basePayload,
          message: 'overall assistant text',
          transportOverrides: {
            telegram: {
              message: 'overall transport override',
              parseMode: null,
              entities: [{ type: 'bold', offset: 0, length: 7 }],
            },
          },
          richContent: {
            visibleText: 'overall assistant text',
            parts: [
              { kind: 'text', text: 'ordered rich text part', format: 'plain' },
              { kind: 'photo', source: { type: 'local_path', path: photoPath, trust: 'turn-artifact' } },
            ],
          },
        },
        {
          resolveTelegramDestinationImpl: async () => ({
            chatId: '777',
            sourceChatKey: 'telegram:123456:777',
          }),
          httpsRequestImpl: createHttpsRequestMock({
            [`POST /bot${config.botToken}/sendMessage`]: (body) => {
              requestBody = JSON.parse(body) as { text?: string; entities?: unknown[] };
              return {
                statusCode: 200,
                body: { ok: true, result: { message_id: 503 } },
              };
            },
            [`POST /bot${config.botToken}/sendChatAction`]: () => ({
              statusCode: 200,
              body: { ok: true, result: true },
            }),
            [`POST /bot${config.botToken}/sendPhoto`]: () => ({
              statusCode: 200,
              body: { ok: true, result: { message_id: 504 } },
            }),
          }),
        },
      );

      assert.equal(result.success, true);
      const capturedBody = requestBody as { text?: string; entities?: unknown[] } | null;
      assert.equal(capturedBody?.text, 'ordered rich text part');
      assert.equal('entities' in (capturedBody ?? {}), false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('attaches Telegram progress reply markup only to the first rich text message anchor', async () => {
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: '123456:abc',
      chatId: '777',
    };
    const requestBodies: Array<Record<string, unknown>> = [];
    const tempDir = await mkdtemp(join(tmpdir(), 'omx-dispatcher-rich-progress-markup-'));
    const photoPath = join(tempDir, 'preview.png');
    await import('node:fs/promises').then(({ writeFile }) => writeFile(photoPath, Buffer.from('png')));

    try {
      const result = await sendTelegram(
        config,
        {
          ...basePayload,
          message: 'overall assistant text',
          transportOverrides: {
            telegram: {
              replyMarkup: {
                inline_keyboard: [[
                  { text: 'Показать ход', callback_data: 'omx:pg:abc123' },
                ]],
              },
            },
          },
          richContent: {
            visibleText: 'overall assistant text',
            parts: [
              { kind: 'text', text: 'first rich text part', format: 'plain' },
              { kind: 'photo', source: { type: 'local_path', path: photoPath, trust: 'turn-artifact' } },
              { kind: 'text', text: 'second rich text part', format: 'plain' },
            ],
          },
        },
        {
          resolveTelegramDestinationImpl: async () => ({
            chatId: '777',
            sourceChatKey: 'telegram:123456:777',
          }),
          httpsRequestImpl: createHttpsRequestMock({
            [`POST /bot${config.botToken}/sendMessage`]: (body) => {
              requestBodies.push(JSON.parse(body) as Record<string, unknown>);
              return {
                statusCode: 200,
                body: { ok: true, result: { message_id: 500 + requestBodies.length } },
              };
            },
            [`POST /bot${config.botToken}/sendChatAction`]: () => ({
              statusCode: 200,
              body: { ok: true, result: true },
            }),
            [`POST /bot${config.botToken}/sendPhoto`]: () => ({
              statusCode: 200,
              body: { ok: true, result: { message_id: 550 } },
            }),
          }),
        },
      );

      assert.equal(result.success, true);
      assert.equal(requestBodies.length, 2);
      assert.deepEqual(requestBodies[0]?.reply_markup, {
        inline_keyboard: [[
          { text: 'Показать ход', callback_data: 'omx:pg:abc123' },
        ]],
      });
      assert.equal(requestBodies[1]?.reply_markup, undefined);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('reports sent rich message ids when partial rich delivery cleanup fails', async () => {
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: '123456:abc',
      chatId: '777',
    };
    const tempDir = await mkdtemp(join(tmpdir(), 'omx-dispatcher-rich-cleanup-failure-'));
    const firstPath = join(tempDir, 'first.png');
    const secondPath = join(tempDir, 'second.png');
    await import('node:fs/promises').then(({ writeFile }) => Promise.all([
      writeFile(firstPath, Buffer.from('first')),
      writeFile(secondPath, Buffer.from('second')),
    ]));
    let photoCalls = 0;

    try {
      const result = await sendTelegram(
        config,
        {
          ...basePayload,
          message: '',
          richContent: {
            visibleText: '',
            parts: [
              { kind: 'photo', source: { type: 'local_path', path: firstPath, trust: 'turn-artifact' } },
              { kind: 'photo', source: { type: 'local_path', path: secondPath, trust: 'turn-artifact' } },
            ],
          },
        },
        {
          resolveTelegramDestinationImpl: async () => ({
            chatId: '777',
            sourceChatKey: 'telegram:123456:777',
          }),
          httpsRequestImpl: createHttpsRequestMock({
            [`POST /bot${config.botToken}/sendChatAction`]: () => ({
              statusCode: 200,
              body: { ok: true, result: true },
            }),
            [`POST /bot${config.botToken}/sendPhoto`]: () => {
              photoCalls += 1;
              if (photoCalls === 1) {
                return {
                  statusCode: 200,
                  body: { ok: true, result: { message_id: 7771 } },
                };
              }
              return {
                statusCode: 500,
                body: { ok: false, description: 'second upload failed' },
              };
            },
            [`POST /bot${config.botToken}/deleteMessage`]: () => ({
              statusCode: 500,
              body: { ok: false, description: 'delete failed' },
            }),
          }),
        },
      );

      assert.equal(result.success, false);
      assert.match(result.error ?? '', /message_ids=7771/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('omits parse_mode when the payload explicitly disables telegram parsing', async () => {
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: '123456:abc',
      chatId: '777',
    };
    let requestBody = '';

    const result = await sendTelegram(
      config,
      {
        ...basePayload,
        message: '# Raw markdown-like text\n\n- keep symbols untouched',
        transportOverrides: {
          telegram: {
            parseMode: null,
          },
        },
      },
      {
        resolveTelegramDestinationImpl: async () => ({
          chatId: '777',
          sourceChatKey: 'telegram:123456:777',
        }),
        httpsRequestImpl: createHttpsRequestMock({
          [`POST /bot${config.botToken}/sendMessage`]: (body) => {
            requestBody = body;
            return {
              statusCode: 200,
              body: {
                ok: true,
                result: {
                  message_id: 111,
                },
              },
            };
          },
        }),
      },
    );

    assert.equal(result.success, true);
    const parsedBody = JSON.parse(requestBody) as {
      chat_id: string;
      text: string;
      parse_mode?: string;
    };
    assert.equal(parsedBody.chat_id, '777');
    assert.equal(parsedBody.text, '# Raw markdown-like text\n\n- keep symbols untouched');
    assert.equal('parse_mode' in parsedBody, false);
  });

  it('sends Telegram entities and omits parse_mode even when config parseMode is set', async () => {
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: '123456:abc',
      chatId: '777',
      parseMode: 'HTML',
      projectTopics: { enabled: true },
    };
    let requestBody = '';

    const result = await sendTelegram(
      config,
      {
        ...basePayload,
        message: 'fallback message',
        transportOverrides: {
          telegram: {
            message: 'Run npm run build',
            parseMode: null,
            entities: [
              { type: 'code', offset: 'Run '.length, length: 'npm run build'.length },
            ],
          },
        },
      },
      {
        resolveTelegramDestinationImpl: async () => ({
          chatId: '777',
          sourceChatKey: 'telegram:123456:777',
          messageThreadId: '9001',
          projectKey: 'project-key-1',
          topicName: 'project-a',
        }),
        httpsRequestImpl: createHttpsRequestMock({
          [`POST /bot${config.botToken}/sendMessage`]: (body) => {
            requestBody = body;
            return {
              statusCode: 200,
              body: {
                ok: true,
                result: {
                  message_id: 222,
                  message_thread_id: 9001,
                  is_topic_message: true,
                },
              },
            };
          },
        }),
      },
    );

    assert.equal(result.success, true);
    assert.equal(result.messageId, '222');
    const parsedBody = JSON.parse(requestBody) as {
      text: string;
      entities?: unknown[];
      parse_mode?: string;
      message_thread_id?: number;
    };
    assert.equal(parsedBody.text, 'Run npm run build');
    assert.deepEqual(parsedBody.entities, [
      { type: 'code', offset: 'Run '.length, length: 'npm run build'.length },
    ]);
    assert.equal('parse_mode' in parsedBody, false);
    assert.equal(parsedBody.message_thread_id, 9001);
  });

  it('sends long Telegram entity overrides as multiple chunks with remapped entities', async () => {
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: '123456:abc',
      chatId: '777',
      projectTopics: { enabled: true },
    };
    const requestBodies: Array<{
      text: string;
      entities?: Array<{ type: string; offset: number; length: number }>;
      message_thread_id?: number;
      parse_mode?: string;
    }> = [];

    const result = await sendTelegram(
      config,
      {
        ...basePayload,
        transportOverrides: {
          telegram: {
            message: `${'a'.repeat(4096)}code`,
            parseMode: null,
            entities: [
              { type: 'code', offset: 4096, length: 4 },
            ],
          },
        },
      },
      {
        resolveTelegramDestinationImpl: async () => ({
          chatId: '777',
          sourceChatKey: 'telegram:123456:777',
          messageThreadId: '9001',
          projectKey: 'project-key-1',
          topicName: 'project-a',
        }),
        httpsRequestImpl: createHttpsRequestMock({
          [`POST /bot${config.botToken}/sendMessage`]: (body) => {
            requestBodies.push(JSON.parse(body));
            return {
              statusCode: 200,
              body: {
                ok: true,
                result: {
                  message_id: requestBodies.length === 1 ? 301 : 302,
                  message_thread_id: 9001,
                  is_topic_message: true,
                },
              },
            };
          },
        }),
      },
    );

    assert.equal(result.success, true);
    assert.equal(result.messageId, '301');
    assert.deepEqual(result.messageIds, ['301', '302']);
    assert.equal(requestBodies.length, 2);
    assert.equal(requestBodies[0].text.length, 4096);
    assert.equal(requestBodies[0].text.endsWith(TELEGRAM_CONTINUATION_SUFFIX), true);
    assert.equal(requestBodies[1].text.startsWith(TELEGRAM_CONTINUATION_PREFIX), true);
    assert.equal(joinTelegramChunkTexts(requestBodies.map((body) => body.text)), `${'a'.repeat(4096)}code`);
    assert.equal(requestBodies[0].message_thread_id, 9001);
    assert.equal(requestBodies[1].message_thread_id, 9001);
    assert.equal('parse_mode' in requestBodies[0], false);
    assert.equal('parse_mode' in requestBodies[1], false);
    assert.deepEqual(requestBodies[1].entities, [
      {
        type: 'code',
        offset: TELEGRAM_CONTINUATION_PREFIX.length + TELEGRAM_CONTINUATION_SUFFIX.length,
        length: 4,
      },
    ]);
  });

  it('keeps short non-entity parse-mode Telegram payloads in parse mode', async () => {
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: '123456:abc',
      chatId: '777',
      parseMode: 'Markdown',
    };
    const requestBodies: Array<{ text: string; parse_mode?: string }> = [];
    const markdownMessage = '*short*';

    const result = await sendTelegram(
      config,
      {
        ...basePayload,
        message: markdownMessage,
      },
      {
        resolveTelegramDestinationImpl: async () => ({
          chatId: '777',
          sourceChatKey: 'telegram:123456:777',
        }),
        httpsRequestImpl: createHttpsRequestMock({
          [`POST /bot${config.botToken}/sendMessage`]: (body) => {
            requestBodies.push(JSON.parse(body));
            return {
              statusCode: 200,
              body: {
                ok: true,
                result: {
                  message_id: 303,
                },
              },
            };
          },
        }),
      },
    );

    assert.equal(result.success, true);
    assert.equal(requestBodies.length, 1);
    assert.equal(requestBodies[0].text, markdownMessage);
    assert.equal(requestBodies[0].parse_mode, 'Markdown');
  });

  it('retries classified parse-mode rich payload failures as raw text without parse_mode', async () => {
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: '123456:abc',
      chatId: '777',
      parseMode: 'Markdown',
    };
    const requestBodies: Array<{ text: string; parse_mode?: string; entities?: unknown[] }> = [];
    const markdownMessage = '*unterminated';

    const result = await sendTelegram(
      config,
      {
        ...basePayload,
        message: markdownMessage,
      },
      {
        resolveTelegramDestinationImpl: async () => ({
          chatId: '777',
          sourceChatKey: 'telegram:123456:777',
        }),
        httpsRequestImpl: createHttpsRequestMock({
          [`POST /bot${config.botToken}/sendMessage`]: (body) => {
            requestBodies.push(JSON.parse(body));
            if (requestBodies.length === 1) {
              return {
                statusCode: 400,
                body: {
                  ok: false,
                  error_code: 400,
                  description: "Bad Request: can't parse entities: can't find end of the entity",
                },
              };
            }
            if (requestBodies.length > 2) {
              throw new Error('parse-mode raw fallback should be attempted once');
            }
            return {
              statusCode: 200,
              body: {
                ok: true,
                result: {
                  message_id: 304,
                },
              },
            };
          },
        }),
      },
    );

    assert.equal(result.success, true);
    assert.equal(result.messageId, '304');
    assert.equal(requestBodies.length, 2);
    assert.equal(requestBodies[0].parse_mode, 'Markdown');
    assert.equal('parse_mode' in requestBodies[1], false);
    assert.equal('entities' in requestBodies[1], false);
    assert.equal(requestBodies[1].text, markdownMessage);
  });

  it('retries Telegram HTML parse-mode failures as raw text without parse_mode', async () => {
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: '123456:abc',
      chatId: '777',
      parseMode: 'HTML',
    };
    const requestBodies: Array<{ text: string; parse_mode?: string; entities?: unknown[] }> = [];
    const htmlMessage = '<span>unsupported</span>';

    const result = await sendTelegram(
      config,
      {
        ...basePayload,
        message: htmlMessage,
      },
      {
        resolveTelegramDestinationImpl: async () => ({
          chatId: '777',
          sourceChatKey: 'telegram:123456:777',
        }),
        httpsRequestImpl: createHttpsRequestMock({
          [`POST /bot${config.botToken}/sendMessage`]: (body) => {
            requestBodies.push(JSON.parse(body));
            if (requestBodies.length === 1) {
              return {
                statusCode: 400,
                body: {
                  ok: false,
                  error_code: 400,
                  description: 'Bad Request: can\'t parse message text: Unsupported start tag "span" at byte offset 0',
                },
              };
            }
            if (requestBodies.length > 2) {
              throw new Error('HTML parse-mode raw fallback should be attempted once');
            }
            return {
              statusCode: 200,
              body: {
                ok: true,
                result: {
                  message_id: 305,
                },
              },
            };
          },
        }),
      },
    );

    assert.equal(result.success, true);
    assert.equal(result.messageId, '305');
    assert.equal(requestBodies.length, 2);
    assert.equal(requestBodies[0].parse_mode, 'HTML');
    assert.equal('parse_mode' in requestBodies[1], false);
    assert.equal('entities' in requestBodies[1], false);
    assert.equal(requestBodies[1].text, htmlMessage);
  });

  it('sends oversized non-entity parse-mode Telegram payloads as raw chunks', async () => {
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: '123456:abc',
      chatId: '777',
      parseMode: 'Markdown',
    };
    const requestBodies: Array<{ text: string; parse_mode?: string }> = [];
    const markdownMessage = `*${'a'.repeat(5000)}*`;

    const result = await sendTelegram(
      config,
      {
        ...basePayload,
        message: markdownMessage,
      },
      {
        resolveTelegramDestinationImpl: async () => ({
          chatId: '777',
          sourceChatKey: 'telegram:123456:777',
        }),
        httpsRequestImpl: createHttpsRequestMock({
          [`POST /bot${config.botToken}/sendMessage`]: (body) => {
            requestBodies.push(JSON.parse(body));
            return {
              statusCode: 200,
              body: {
                ok: true,
                result: {
                  message_id: 303 + requestBodies.length,
                },
              },
            };
          },
        }),
      },
    );

    assert.equal(result.success, true);
    assert.equal(requestBodies.length, 2);
    assert.equal(joinTelegramChunkTexts(requestBodies.map((body) => body.text)), markdownMessage);
    assert.equal(requestBodies.every((body) => !('parse_mode' in body)), true);
  });

  it('deletes accepted Telegram chunks when a later chunk send fails', async () => {
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: '123456:abc',
      chatId: '777',
      projectTopics: { enabled: true },
    };
    const sendBodies: Array<{ text: string; parse_mode?: string }> = [];
    const deleteBodies: Array<{ chat_id: string; message_id: number }> = [];

    const result = await sendTelegram(
      config,
      {
        ...basePayload,
        transportOverrides: {
          telegram: {
            message: `${'a'.repeat(4096)}tail`,
            parseMode: null,
            entities: [],
          },
        },
      },
      {
        resolveTelegramDestinationImpl: async () => ({
          chatId: '777',
          sourceChatKey: 'telegram:123456:777',
          messageThreadId: '9001',
          projectKey: 'project-key-1',
          topicName: 'project-a',
        }),
        httpsRequestImpl: createHttpsRequestMock({
          [`POST /bot${config.botToken}/sendMessage`]: (body) => {
            sendBodies.push(JSON.parse(body));
            if (sendBodies.length === 1) {
              return {
                statusCode: 200,
                body: {
                  ok: true,
                  result: {
                    message_id: 401,
                    message_thread_id: 9001,
                    is_topic_message: true,
                  },
                },
              };
            }
            return {
              statusCode: 500,
              body: {
                ok: false,
                error_code: 500,
                description: 'Internal server error',
              },
            };
          },
          [`POST /bot${config.botToken}/deleteMessage`]: (body) => {
            deleteBodies.push(JSON.parse(body));
            return {
              statusCode: 200,
              body: {
                ok: true,
                result: true,
              },
            };
          },
        }),
      },
    );

    assert.equal(result.success, false);
    assert.equal(sendBodies.length, 2);
    assert.deepEqual(deleteBodies, [{ chat_id: '777', message_id: 401 }]);
    assert.equal('parse_mode' in sendBodies[0], false);
  });

  it('retries Telegram entity send failures as raw text without entities or parse_mode', async () => {
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: '123456:abc',
      chatId: '777',
    };
    const requestBodies: Array<{
      text: string;
      entities?: unknown[];
      parse_mode?: string;
    }> = [];

    const result = await sendTelegram(
      config,
      {
        ...basePayload,
        transportOverrides: {
          telegram: {
            message: 'Run npm run build',
            parseMode: null,
            entities: [
              { type: 'code', offset: 0, length: 3 },
            ],
          },
        },
      },
      {
        resolveTelegramDestinationImpl: async () => ({
          chatId: '777',
          sourceChatKey: 'telegram:123456:777',
        }),
        httpsRequestImpl: createHttpsRequestMock({
          [`POST /bot${config.botToken}/sendMessage`]: (body) => {
            requestBodies.push(JSON.parse(body));
            if (requestBodies.length === 1) {
              return {
                statusCode: 400,
                body: {
                  ok: false,
                  error_code: 400,
                  description: "Bad Request: can't parse entities: invalid entity range",
                },
              };
            }
            return {
              statusCode: 200,
              body: {
                ok: true,
                result: {
                  message_id: 333,
                },
              },
            };
          },
        }),
      },
    );

    assert.equal(result.success, true);
    assert.equal(result.messageId, '333');
    assert.equal(requestBodies.length, 2);
    assert.ok(requestBodies[0].entities);
    assert.equal('entities' in requestBodies[1], false);
    assert.equal('parse_mode' in requestBodies[1], false);
    assert.equal(requestBodies[1].text, 'Run npm run build');
  });

  it('retries classified Telegram entity wording variants as raw text once', async () => {
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: '123456:abc',
      chatId: '777',
    };
    const requestBodies: Array<{
      text: string;
      entities?: unknown[];
      parse_mode?: string;
    }> = [];

    const result = await sendTelegram(
      config,
      {
        ...basePayload,
        transportOverrides: {
          telegram: {
            message: 'Run npm run build',
            parseMode: null,
            entities: [
              { type: 'code', offset: 0, length: 3 },
            ],
          },
        },
      },
      {
        resolveTelegramDestinationImpl: async () => ({
          chatId: '777',
          sourceChatKey: 'telegram:123456:777',
        }),
        httpsRequestImpl: createHttpsRequestMock({
          [`POST /bot${config.botToken}/sendMessage`]: (body) => {
            requestBodies.push(JSON.parse(body));
            if (requestBodies.length === 1) {
              return {
                statusCode: 400,
                body: {
                  ok: false,
                  error_code: 400,
                  description: 'Bad Request: entity start is out of range',
                },
              };
            }
            if (requestBodies.length > 2) {
              throw new Error('raw fallback should be attempted once');
            }
            return {
              statusCode: 200,
              body: { ok: true, result: { message_id: 334 } },
            };
          },
        }),
      },
    );

    assert.equal(result.success, true);
    assert.equal(requestBodies.length, 2);
    assert.ok(requestBodies[0].entities);
    assert.equal('entities' in requestBodies[1], false);
    assert.equal('parse_mode' in requestBodies[1], false);
  });

  it('does not raw-fallback generic 400 failures as entity success', async () => {
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: '123456:abc',
      chatId: '777',
    };
    const requestBodies: Array<{ entities?: unknown[] }> = [];

    const result = await sendTelegram(
      config,
      {
        ...basePayload,
        transportOverrides: {
          telegram: {
            message: 'Run npm run build',
            parseMode: null,
            entities: [
              { type: 'code', offset: 0, length: 3 },
            ],
          },
        },
      },
      {
        resolveTelegramDestinationImpl: async () => ({
          chatId: '777',
          sourceChatKey: 'telegram:123456:777',
        }),
        httpsRequestImpl: createHttpsRequestMock({
          [`POST /bot${config.botToken}/sendMessage`]: (body) => {
            requestBodies.push(JSON.parse(body));
            return {
              statusCode: 400,
              body: {
                ok: false,
                error_code: 400,
                description: 'Bad Request: chat not found',
              },
            };
          },
        }),
      },
    );

    assert.equal(result.success, false);
    assert.match(result.error || '', /chat not found/);
    assert.equal(requestBodies.length, 1);
    assert.ok(requestBodies[0].entities);
  });

  it('retries a split entity message as a fully raw logical message after entity failure', async () => {
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: '123456:abc',
      chatId: '777',
      projectTopics: { enabled: true },
    };
    const sendBodies: Array<{
      text: string;
      entities?: unknown[];
      parse_mode?: string;
      message_thread_id?: number;
    }> = [];
    const deleteBodies: Array<{ chat_id: string; message_id: number }> = [];

    const result = await sendTelegram(
      config,
      {
        ...basePayload,
        transportOverrides: {
          telegram: {
            message: `${'a'.repeat(4096)}code`,
            parseMode: null,
            entities: [
              { type: 'code', offset: 4096, length: 4 },
            ],
          },
        },
      },
      {
        resolveTelegramDestinationImpl: async () => ({
          chatId: '777',
          sourceChatKey: 'telegram:123456:777',
          messageThreadId: '9001',
          projectKey: 'project-key-1',
          topicName: 'project-a',
        }),
        httpsRequestImpl: createHttpsRequestMock({
          [`POST /bot${config.botToken}/sendMessage`]: (body) => {
            sendBodies.push(JSON.parse(body));
            if (sendBodies.length === 1) {
              return {
                statusCode: 200,
                body: {
                  ok: true,
                  result: {
                    message_id: 701,
                    message_thread_id: 9001,
                    is_topic_message: true,
                  },
                },
              };
            }
            if (sendBodies.length === 2) {
              return {
                statusCode: 400,
                body: {
                  ok: false,
                  error_code: 400,
                  description: "Bad Request: can't parse entities: invalid entity range",
                },
              };
            }
            return {
              statusCode: 200,
              body: {
                ok: true,
                result: {
                  message_id: 700 + sendBodies.length,
                  message_thread_id: 9001,
                  is_topic_message: true,
                },
              },
            };
          },
          [`POST /bot${config.botToken}/deleteMessage`]: (body) => {
            deleteBodies.push(JSON.parse(body));
            return {
              statusCode: 200,
              body: { ok: true, result: true },
            };
          },
        }),
      },
    );

    assert.equal(result.success, true);
    assert.deepEqual(deleteBodies, [{ chat_id: '777', message_id: 701 }]);
    assert.equal(sendBodies.length, 4);
    assert.ok(sendBodies[1].entities);
    assert.equal('entities' in sendBodies[2], false);
    assert.equal('parse_mode' in sendBodies[2], false);
    assert.equal('entities' in sendBodies[3], false);
    assert.equal('parse_mode' in sendBodies[3], false);
    assert.equal(
      joinTelegramChunkTexts(sendBodies.slice(2).map((body) => body.text)),
      `${'a'.repeat(4096)}code`,
    );
    assert.equal(sendBodies[2].message_thread_id, 9001);
    assert.equal(sendBodies[3].message_thread_id, 9001);
  });

  it('sends to the root chat without a thread id when topic routing falls back', async () => {
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: '123456:abc',
      chatId: '777',
      projectTopics: { enabled: true },
    };
    let requestBody = '';

    const result = await sendTelegram(
      config,
      basePayload,
      {
        resolveTelegramDestinationImpl: async () => ({
          chatId: '777',
          sourceChatKey: 'telegram:123456:777',
          projectKey: 'project-key-1',
          usedFallback: true,
          warningCode: 'forum-unavailable',
          warningMessage: 'Forum topics are unavailable.',
        }),
        httpsRequestImpl: createHttpsRequestMock({
          [`POST /bot${config.botToken}/sendMessage`]: (body) => {
            requestBody = body;
            return {
              statusCode: 200,
              body: {
                ok: true,
                result: {
                  message_id: 654,
                },
              },
            };
          },
        }),
      },
    );

    assert.equal(result.success, true);
    assert.equal(result.messageId, '654');
    assert.equal(result.messageThreadId, undefined);

    const parsedBody = JSON.parse(requestBody) as {
      chat_id: string;
      message_thread_id?: number;
    };
    assert.equal(parsedBody.chat_id, '777');
    assert.equal(parsedBody.message_thread_id, undefined);
  });

  it('returns a bounded failure when topic routing cannot fall back', async () => {
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: '123456:abc',
      chatId: '777',
      projectTopics: { enabled: true, fallbackToGeneral: false },
    };
    let httpsCalled = false;

    const result = await sendTelegram(
      config,
      basePayload,
      {
        resolveTelegramDestinationImpl: async () => ({
          chatId: '777',
          sourceChatKey: 'telegram:123456:777',
          projectKey: 'project-key-1',
          skipSend: true,
          warningCode: 'topic-create-cooldown',
          warningMessage: 'Topic creation is cooling down.',
        }),
        httpsRequestImpl: createHttpsRequestMock({
          [`POST /bot${config.botToken}/sendMessage`]: () => {
            httpsCalled = true;
            return {
              statusCode: 200,
              body: {
                ok: true,
                result: {
                  message_id: 1,
                },
              },
            };
          },
        }),
      },
    );

    assert.equal(result.success, false);
    assert.equal(result.error, 'Topic creation is cooling down.');
    assert.equal(httpsCalled, false);
  });

  it('refreshes a stale cached topic and retries once when Telegram reports the thread is missing', async () => {
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: '123456:abc',
      chatId: '777',
      projectTopics: { enabled: true },
    };
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const tempHome = await mkdtemp(join(tmpdir(), 'omx-dispatcher-telegram-stale-'));
    const identity = normalizeTelegramProjectIdentity(basePayload);
    assert.ok(identity);
    let resolveCalls = 0;
    const requestBodies: Array<{
      message_thread_id?: number;
      entities?: Array<{ type: string; offset: number; length: number }>;
    }> = [];

    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;

    try {
      const result = await sendTelegram(
        config,
        {
          ...basePayload,
          transportOverrides: {
            telegram: {
              message: 'Topic code',
              parseMode: null,
              entities: [{ type: 'code', offset: 'Topic '.length, length: 'code'.length }],
            },
          },
        },
        {
          resolveTelegramDestinationImpl: async () => {
            resolveCalls += 1;
            return {
              chatId: '777',
              sourceChatKey: 'telegram:123456:777',
              messageThreadId: resolveCalls === 1 ? '9001' : '9002',
              projectKey: identity.projectKey,
              canonicalProjectPath: identity.canonicalProjectPath,
              topicName: 'project',
            };
          },
          httpsRequestImpl: createHttpsRequestMock({
            [`POST /bot${config.botToken}/sendMessage`]: (body) => {
              requestBodies.push(JSON.parse(body) as { message_thread_id?: number });
              if (requestBodies.length === 1) {
                return {
                  statusCode: 400,
                  body: {
                    ok: false,
                    error_code: 400,
                    description: 'Bad Request: message thread not found',
                  },
                };
              }

              return {
                statusCode: 200,
                body: {
                  ok: true,
                  result: {
                    message_id: 433,
                    message_thread_id: 9002,
                    is_topic_message: true,
                  },
                },
              };
            },
          }),
        },
      );

      assert.equal(result.success, true);
      assert.equal(result.messageId, '433');
      assert.equal(result.messageThreadId, '9002');
      assert.equal(resolveCalls, 2);
      assert.deepEqual(
        requestBodies.map((body) => body.message_thread_id),
        [9001, 9002],
      );
      assert.deepEqual(
        requestBodies.map((body) => body.entities),
        [
          [{ type: 'code', offset: 'Topic '.length, length: 'code'.length }],
          [{ type: 'code', offset: 'Topic '.length, length: 'code'.length }],
        ],
      );

      const record = await getTelegramTopicRegistryRecord(
        'telegram:123456:777',
        identity.projectKey,
      );
      assert.equal(record?.messageThreadId, '9002');
      assert.equal(record?.lastCreateFailureCode, undefined);
    } finally {
      await rm(tempHome, { recursive: true, force: true });
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
    }
  });

  it('refreshes a stale cached topic and retries rich photo sends', async () => {
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: '123456:abc',
      chatId: '777',
      projectTopics: { enabled: true },
    };
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const tempHome = await mkdtemp(join(tmpdir(), 'omx-dispatcher-telegram-rich-stale-'));
    const photoPath = join(tempHome, 'preview.png');
    await import('node:fs/promises').then(({ writeFile }) => writeFile(photoPath, Buffer.from('png')));
    const identity = normalizeTelegramProjectIdentity(basePayload);
    assert.ok(identity);
    let resolveCalls = 0;
    const photoThreadIds: number[] = [];

    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;

    try {
      const result = await sendTelegram(
        config,
        {
          ...basePayload,
          message: '',
          richContent: {
            visibleText: '',
            parts: [
              { kind: 'photo', source: { type: 'local_path', path: photoPath, trust: 'turn-artifact' } },
            ],
          },
        },
        {
          resolveTelegramDestinationImpl: async () => {
            resolveCalls += 1;
            return {
              chatId: '777',
              sourceChatKey: 'telegram:123456:777',
              messageThreadId: resolveCalls === 1 ? '9001' : '9002',
              projectKey: identity.projectKey,
              canonicalProjectPath: identity.canonicalProjectPath,
              topicName: 'project',
            };
          },
          httpsRequestImpl: createHttpsRequestMock({
            [`POST /bot${config.botToken}/sendChatAction`]: () => ({
              statusCode: 200,
              body: { ok: true, result: true },
            }),
            [`POST /bot${config.botToken}/sendPhoto`]: (body) => {
              const match = body.match(/name="message_thread_id"\r\n\r\n(\d+)/);
              if (match?.[1]) photoThreadIds.push(Number(match[1]));
              if (photoThreadIds.length === 1) {
                return {
                  statusCode: 400,
                  body: {
                    ok: false,
                    error_code: 400,
                    description: 'Bad Request: message thread not found',
                  },
                };
              }

              return {
                statusCode: 200,
                body: {
                  ok: true,
                  result: {
                    message_id: 733,
                    message_thread_id: 9002,
                    is_topic_message: true,
                  },
                },
              };
            },
          }),
        },
      );

      assert.equal(result.success, true);
      assert.equal(result.messageId, '733');
      assert.equal(result.messageThreadId, '9002');
      assert.equal(resolveCalls, 2);
      assert.deepEqual(photoThreadIds, [9001, 9002]);

      const record = await getTelegramTopicRegistryRecord(
        'telegram:123456:777',
        identity.projectKey,
      );
      assert.equal(record?.messageThreadId, '9002');
      assert.equal(record?.lastCreateFailureCode, undefined);
    } finally {
      await rm(tempHome, { recursive: true, force: true });
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
    }
  });

  it('refreshes topic-mismatch errors for rich entity sends without raw fallback', async () => {
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: '123456:abc',
      chatId: '777',
      projectTopics: { enabled: true },
    };
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const tempHome = await mkdtemp(join(tmpdir(), 'omx-dispatcher-telegram-mismatch-error-'));
    const identity = normalizeTelegramProjectIdentity(basePayload);
    assert.ok(identity);
    let resolveCalls = 0;
    const requestBodies: Array<{
      message_thread_id?: number;
      entities?: Array<{ type: string; offset: number; length: number }>;
      parse_mode?: string;
    }> = [];

    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;

    try {
      const result = await sendTelegram(
        config,
        {
          ...basePayload,
          transportOverrides: {
            telegram: {
              message: 'Topic code',
              parseMode: null,
              entities: [{ type: 'code', offset: 'Topic '.length, length: 'code'.length }],
            },
          },
        },
        {
          resolveTelegramDestinationImpl: async () => {
            resolveCalls += 1;
            return {
              chatId: '777',
              sourceChatKey: 'telegram:123456:777',
              messageThreadId: resolveCalls === 1 ? '9001' : '9002',
              projectKey: identity.projectKey,
              canonicalProjectPath: identity.canonicalProjectPath,
              topicName: 'project',
            };
          },
          httpsRequestImpl: createHttpsRequestMock({
            [`POST /bot${config.botToken}/sendMessage`]: (body) => {
              const parsed = JSON.parse(body) as {
                message_thread_id?: number;
                entities?: Array<{ type: string; offset: number; length: number }>;
                parse_mode?: string;
              };
              requestBodies.push(parsed);
              if (requestBodies.length === 1) {
                return {
                  statusCode: 400,
                  body: {
                    ok: false,
                    error_code: 400,
                    description: 'Bad Request: message is not a forum topic message',
                  },
                };
              }

              assert.equal(parsed.message_thread_id, 9002);
              assert.deepEqual(parsed.entities, [
                { type: 'code', offset: 'Topic '.length, length: 'code'.length },
              ]);
              assert.equal('parse_mode' in parsed, false);
              return {
                statusCode: 200,
                body: {
                  ok: true,
                  result: {
                    message_id: 436,
                    message_thread_id: 9002,
                    is_topic_message: true,
                  },
                },
              };
            },
          }),
        },
      );

      assert.equal(result.success, true);
      assert.equal(result.messageId, '436');
      assert.equal(result.messageThreadId, '9002');
      assert.equal(resolveCalls, 2);
      assert.deepEqual(
        requestBodies.map((body) => body.message_thread_id),
        [9001, 9002],
      );
      assert.deepEqual(
        requestBodies.map((body) => body.entities),
        [
          [{ type: 'code', offset: 'Topic '.length, length: 'code'.length }],
          [{ type: 'code', offset: 'Topic '.length, length: 'code'.length }],
        ],
      );
    } finally {
      await rm(tempHome, { recursive: true, force: true });
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
    }
  });

  it('deletes a topic-mismatched Telegram send and retries with a refreshed topic', async () => {
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: '123456:abc',
      chatId: '777',
      projectTopics: { enabled: true },
    };
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const tempHome = await mkdtemp(join(tmpdir(), 'omx-dispatcher-telegram-mismatch-'));
    const identity = normalizeTelegramProjectIdentity(basePayload);
    assert.ok(identity);
    let resolveCalls = 0;
    let deleteCalled = false;
    let sendCalls = 0;

    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;

    try {
      const result = await sendTelegram(
        config,
        basePayload,
        {
          resolveTelegramDestinationImpl: async () => {
            resolveCalls += 1;
            return {
              chatId: '777',
              sourceChatKey: 'telegram:123456:777',
              messageThreadId: resolveCalls === 1 ? '9001' : '9002',
              projectKey: identity.projectKey,
              canonicalProjectPath: identity.canonicalProjectPath,
              topicName: 'project',
            };
          },
          httpsRequestImpl: createHttpsRequestMock({
            [`POST /bot${config.botToken}/sendMessage`]: () => {
              sendCalls += 1;
              if (sendCalls === 1) {
                return {
                  statusCode: 200,
                  body: {
                    ok: true,
                    result: {
                      message_id: 434,
                      message_thread_id: 9001,
                      is_topic_message: false,
                    },
                  },
                };
              }

              return {
                statusCode: 200,
                body: {
                  ok: true,
                  result: {
                    message_id: 435,
                    message_thread_id: 9002,
                    is_topic_message: true,
                  },
                },
              };
            },
            [`POST /bot${config.botToken}/deleteMessage`]: () => {
              deleteCalled = true;
              return {
                statusCode: 200,
                body: { ok: true, result: true },
              };
            },
          }),
        },
      );

      assert.equal(result.success, true);
      assert.equal(result.messageId, '435');
      assert.equal(result.messageThreadId, '9002');
      assert.equal(deleteCalled, true);
      assert.equal(resolveCalls, 2);
      assert.equal(sendCalls, 2);
    } finally {
      await rm(tempHome, { recursive: true, force: true });
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
    }
  });

  it('accepts topic chunk responses when Telegram omits optional is_topic_message', async () => {
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: '123456:abc',
      chatId: '777',
      projectTopics: { enabled: true },
    };
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const tempHome = await mkdtemp(join(tmpdir(), 'omx-dispatcher-telegram-optional-topic-'));
    const identity = normalizeTelegramProjectIdentity(basePayload);
    assert.ok(identity);
    let resolveCalls = 0;
    let deleteCalled = false;
    const sendBodies: Array<{ message_thread_id?: number }> = [];

    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;

    try {
      const result = await sendTelegram(
        config,
        {
          ...basePayload,
          transportOverrides: {
            telegram: {
              message: `${'a'.repeat(4096)}tail`,
              parseMode: null,
              entities: [],
            },
          },
        },
        {
          resolveTelegramDestinationImpl: async () => {
            resolveCalls += 1;
            return {
              chatId: '777',
              sourceChatKey: 'telegram:123456:777',
              messageThreadId: '9001',
              projectKey: identity.projectKey,
              canonicalProjectPath: identity.canonicalProjectPath,
              topicName: 'project',
            };
          },
          httpsRequestImpl: createHttpsRequestMock({
            [`POST /bot${config.botToken}/sendMessage`]: (body) => {
              sendBodies.push(JSON.parse(body));
              return {
                statusCode: 200,
                body: {
                  ok: true,
                  result: {
                    message_id: 800 + sendBodies.length,
                    message_thread_id: 9001,
                  },
                },
              };
            },
            [`POST /bot${config.botToken}/deleteMessage`]: () => {
              deleteCalled = true;
              return {
                statusCode: 200,
                body: { ok: true, result: true },
              };
            },
          }),
        },
      );

      assert.equal(result.success, true);
      assert.deepEqual(result.messageIds, ['801', '802']);
      assert.equal(resolveCalls, 1);
      assert.equal(sendBodies.length, 2);
      assert.equal(deleteCalled, false);
    } finally {
      await rm(tempHome, { recursive: true, force: true });
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
    }
  });

  it('deletes all accepted chunks for a topic-mismatched chunked send before retrying', async () => {
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: '123456:abc',
      chatId: '777',
      projectTopics: { enabled: true },
    };
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const tempHome = await mkdtemp(join(tmpdir(), 'omx-dispatcher-telegram-chunk-mismatch-'));
    const identity = normalizeTelegramProjectIdentity(basePayload);
    assert.ok(identity);
    let resolveCalls = 0;
    const sendBodies: Array<{ message_thread_id?: number }> = [];
    const deleteBodies: Array<{ chat_id: string; message_id: number }> = [];

    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;

    try {
      const result = await sendTelegram(
        config,
        {
          ...basePayload,
          transportOverrides: {
            telegram: {
              message: `${'a'.repeat(4096)}tail`,
              parseMode: null,
              entities: [],
            },
          },
        },
        {
          resolveTelegramDestinationImpl: async () => {
            resolveCalls += 1;
            return {
              chatId: '777',
              sourceChatKey: 'telegram:123456:777',
              messageThreadId: resolveCalls === 1 ? '9001' : '9002',
              projectKey: identity.projectKey,
              canonicalProjectPath: identity.canonicalProjectPath,
              topicName: 'project',
            };
          },
          httpsRequestImpl: createHttpsRequestMock({
            [`POST /bot${config.botToken}/sendMessage`]: (body) => {
              sendBodies.push(JSON.parse(body));
              const firstAttempt = sendBodies.length <= 2;
              const secondAttemptMessageId = sendBodies.length === 3 ? 803 : 804;
              return {
                statusCode: 200,
                body: {
                  ok: true,
                  result: firstAttempt
                    ? {
                        message_id: 800 + sendBodies.length,
                        message_thread_id: sendBodies.length === 1 ? 9001 : 9999,
                        is_topic_message: true,
                      }
                    : {
                        message_id: secondAttemptMessageId,
                        message_thread_id: 9002,
                        is_topic_message: true,
                      },
                },
              };
            },
            [`POST /bot${config.botToken}/deleteMessage`]: (body) => {
              deleteBodies.push(JSON.parse(body));
              return {
                statusCode: 200,
                body: { ok: true, result: true },
              };
            },
          }),
        },
      );

      assert.equal(result.success, true);
      assert.equal(result.messageId, '803');
      assert.deepEqual(result.messageIds, ['803', '804']);
      assert.equal(resolveCalls, 2);
      assert.deepEqual(deleteBodies, [
        { chat_id: '777', message_id: 801 },
        { chat_id: '777', message_id: 802 },
      ]);
      assert.deepEqual(
        sendBodies.map((body) => body.message_thread_id),
        [9001, 9001, 9002, 9002],
      );
    } finally {
      await rm(tempHome, { recursive: true, force: true });
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
    }
  });

  it('does not retry stale topic sends into the root chat when refresh falls back', async () => {
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: '123456:abc',
      chatId: '777',
      projectTopics: { enabled: true, fallbackToGeneral: true },
    };
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const tempHome = await mkdtemp(join(tmpdir(), 'omx-dispatcher-telegram-fallback-'));
    const identity = normalizeTelegramProjectIdentity(basePayload);
    assert.ok(identity);
    let resolveCalls = 0;
    let sendCalls = 0;

    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;

    try {
      const result = await sendTelegram(
        config,
        basePayload,
        {
          resolveTelegramDestinationImpl: async () => {
            resolveCalls += 1;
            return resolveCalls === 1
              ? {
                  chatId: '777',
                  sourceChatKey: 'telegram:123456:777',
                  messageThreadId: '9001',
                  projectKey: identity.projectKey,
                  canonicalProjectPath: identity.canonicalProjectPath,
                  topicName: 'project',
                }
              : {
                  chatId: '777',
                  sourceChatKey: 'telegram:123456:777',
                  projectKey: identity.projectKey,
                  canonicalProjectPath: identity.canonicalProjectPath,
                  topicName: 'project',
                  usedFallback: true,
                  warningMessage: 'Topic creation is cooling down.',
                };
          },
          httpsRequestImpl: createHttpsRequestMock({
            [`POST /bot${config.botToken}/sendMessage`]: () => {
              sendCalls += 1;
              return {
                statusCode: 400,
                body: {
                  ok: false,
                  error_code: 400,
                  description: 'Bad Request: message thread not found',
                },
              };
            },
          }),
        },
      );

      assert.equal(result.success, false);
      assert.equal(result.error, 'Topic creation is cooling down.');
      assert.equal(resolveCalls, 2);
      assert.equal(sendCalls, 1);
    } finally {
      await rm(tempHome, { recursive: true, force: true });
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
    }
  });

  it('tombstones stale cached topics even when autoCreate is disabled', async () => {
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: '123456:abc',
      chatId: '777',
      projectTopics: { enabled: true, autoCreate: false, fallbackToGeneral: true },
    };
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const tempHome = await mkdtemp(join(tmpdir(), 'omx-dispatcher-telegram-autocreate-off-'));
    const identity = normalizeTelegramProjectIdentity(basePayload);
    assert.ok(identity);
    let resolveCalls = 0;
    let sendCalls = 0;

    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;

    try {
      const result = await sendTelegram(
        config,
        basePayload,
        {
          resolveTelegramDestinationImpl: async () => {
            resolveCalls += 1;
            return {
              chatId: '777',
              sourceChatKey: 'telegram:123456:777',
              messageThreadId: '9001',
              projectKey: identity.projectKey,
              canonicalProjectPath: identity.canonicalProjectPath,
              topicName: 'project',
            };
          },
          httpsRequestImpl: createHttpsRequestMock({
            [`POST /bot${config.botToken}/sendMessage`]: () => {
              sendCalls += 1;
              return {
                statusCode: 400,
                body: {
                  ok: false,
                  error_code: 400,
                  description: 'Bad Request: message thread not found',
                },
              };
            },
          }),
        },
      );

      assert.equal(result.success, false);
      assert.match(result.error || '', /message thread not found/);
      assert.equal(resolveCalls, 1);
      assert.equal(sendCalls, 1);

      const record = await getTelegramTopicRegistryRecord(
        'telegram:123456:777',
        identity.projectKey,
      );
      assert.equal(record?.messageThreadId, undefined);
      assert.equal(record?.lastCreateFailureCode, 'topic-stale');
    } finally {
      await rm(tempHome, { recursive: true, force: true });
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
    }
  });

  it('does not retry a topic mismatch when cleanup fails', async () => {
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: '123456:abc',
      chatId: '777',
      projectTopics: { enabled: true },
    };
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const tempHome = await mkdtemp(join(tmpdir(), 'omx-dispatcher-telegram-delete-failed-'));
    const identity = normalizeTelegramProjectIdentity(basePayload);
    assert.ok(identity);
    let resolveCalls = 0;
    let sendCalls = 0;
    let deleteCalls = 0;

    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;

    try {
      const result = await sendTelegram(
        config,
        basePayload,
        {
          resolveTelegramDestinationImpl: async () => {
            resolveCalls += 1;
            return {
              chatId: '777',
              sourceChatKey: 'telegram:123456:777',
              messageThreadId: '9001',
              projectKey: identity.projectKey,
              canonicalProjectPath: identity.canonicalProjectPath,
              topicName: 'project',
            };
          },
          httpsRequestImpl: createHttpsRequestMock({
            [`POST /bot${config.botToken}/sendMessage`]: () => {
              sendCalls += 1;
              return {
                statusCode: 200,
                body: {
                  ok: true,
                  result: {
                    message_id: 436,
                    message_thread_id: 9001,
                    is_topic_message: false,
                  },
                },
              };
            },
            [`POST /bot${config.botToken}/deleteMessage`]: () => {
              deleteCalls += 1;
              return {
                statusCode: 400,
                body: {
                  ok: false,
                  error_code: 400,
                  description: 'Bad Request: message to delete not found',
                },
              };
            },
          }),
        },
      );

      assert.equal(result.success, false);
      assert.equal(result.error, 'Telegram topic delivery mismatch cleanup failed');
      assert.equal(resolveCalls, 1);
      assert.equal(sendCalls, 1);
      assert.equal(deleteCalls, 1);

      const record = await getTelegramTopicRegistryRecord(
        'telegram:123456:777',
        identity.projectKey,
      );
      assert.equal(record?.messageThreadId, undefined);
      assert.equal(record?.lastCreateFailureCode, 'topic-delivery-mismatch');
    } finally {
      await rm(tempHome, { recursive: true, force: true });
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
    }
  });

  it('stops stale topic retry after one refresh attempt', async () => {
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: '123456:abc',
      chatId: '777',
      projectTopics: { enabled: true },
    };
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const tempHome = await mkdtemp(join(tmpdir(), 'omx-dispatcher-telegram-stale-bounded-'));
    const identity = normalizeTelegramProjectIdentity(basePayload);
    assert.ok(identity);
    let resolveCalls = 0;
    let sendCalls = 0;

    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;

    try {
      const result = await sendTelegram(
        config,
        basePayload,
        {
          resolveTelegramDestinationImpl: async () => {
            resolveCalls += 1;
            return {
              chatId: '777',
              sourceChatKey: 'telegram:123456:777',
              messageThreadId: resolveCalls === 1 ? '9001' : '9002',
              projectKey: identity.projectKey,
              canonicalProjectPath: identity.canonicalProjectPath,
              topicName: 'project',
            };
          },
          httpsRequestImpl: createHttpsRequestMock({
            [`POST /bot${config.botToken}/sendMessage`]: () => {
              sendCalls += 1;
              return {
                statusCode: 400,
                body: {
                  ok: false,
                  error_code: 400,
                  description: 'Bad Request: message thread not found',
                },
              };
            },
          }),
        },
      );

      assert.equal(result.success, false);
      assert.match(result.error || '', /message thread not found/);
      assert.equal(resolveCalls, 2);
      assert.equal(sendCalls, 2);
    } finally {
      await rm(tempHome, { recursive: true, force: true });
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
    }
  });

  it('persists topic metadata after a successful send when an existing topic destination is reused', async () => {
    const config: TelegramNotificationConfig = {
      enabled: true,
      botToken: '123456:abc',
      chatId: '777',
      projectTopics: { enabled: true },
    };
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const tempHome = await mkdtemp(join(tmpdir(), 'omx-dispatcher-telegram-'));
    const identity = normalizeTelegramProjectIdentity(basePayload);
    assert.ok(identity);

    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;

    try {
      const result = await sendTelegram(
        config,
        basePayload,
        {
          resolveTelegramDestinationImpl: async () => ({
            chatId: '777',
            sourceChatKey: 'telegram:123456:777',
            messageThreadId: '9001',
            projectKey: identity.projectKey,
            topicName: 'project',
          }),
          httpsRequestImpl: createHttpsRequestMock({
            [`POST /bot${config.botToken}/sendMessage`]: () => ({
              statusCode: 200,
              body: {
                ok: true,
                result: {
                  message_id: 432,
                  message_thread_id: 9001,
                  is_topic_message: true,
                },
              },
            }),
          }),
        },
      );

      assert.equal(result.success, true);
      const record = await getTelegramTopicRegistryRecord(
        'telegram:123456:777',
        identity.projectKey,
      );
      assert.equal(record?.messageThreadId, '9001');
      assert.equal(record?.topicName, 'project');
      assert.ok(record?.lastUsedAt);
    } finally {
      await rm(tempHome, { recursive: true, force: true });
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
    }
  });
});

// ---------------------------------------------------------------------------
// sendSlack
// ---------------------------------------------------------------------------

describe('sendSlack', () => {
  it('returns error when not enabled', async () => {
    const config: SlackNotificationConfig = { enabled: false, webhookUrl: '' };
    const result = await sendSlack(config, basePayload);
    assert.equal(result.success, false);
    assert.equal(result.platform, 'slack');
  });

  it('rejects invalid slack webhook URL', async () => {
    const config: SlackNotificationConfig = {
      enabled: true,
      webhookUrl: 'https://evil.com/services/hook',
    };
    const result = await sendSlack(config, basePayload);
    assert.equal(result.success, false);
    assert.equal(result.error, 'Invalid webhook URL');
  });

  it('rejects http:// slack webhook URL', async () => {
    const config: SlackNotificationConfig = {
      enabled: true,
      webhookUrl: 'http://hooks.slack.com/services/test',
    };
    const result = await sendSlack(config, basePayload);
    assert.equal(result.success, false);
    assert.equal(result.error, 'Invalid webhook URL');
  });
});

// ---------------------------------------------------------------------------
// sendWebhook
// ---------------------------------------------------------------------------

describe('sendWebhook', () => {
  it('returns error when not enabled', async () => {
    const config: WebhookNotificationConfig = { enabled: false, url: '' };
    const result = await sendWebhook(config, basePayload);
    assert.equal(result.success, false);
    assert.equal(result.platform, 'webhook');
  });

  it('rejects http:// URL (requires HTTPS)', async () => {
    const config: WebhookNotificationConfig = {
      enabled: true,
      url: 'http://example.com/hook',
    };
    const result = await sendWebhook(config, basePayload);
    assert.equal(result.success, false);
    assert.equal(result.error, 'Invalid URL (HTTPS required)');
  });

  it('rejects malformed URL', async () => {
    const config: WebhookNotificationConfig = {
      enabled: true,
      url: 'not-a-url',
    };
    const result = await sendWebhook(config, basePayload);
    assert.equal(result.success, false);
    assert.equal(result.error, 'Invalid URL (HTTPS required)');
  });
});

// ---------------------------------------------------------------------------
// dispatchNotifications
// ---------------------------------------------------------------------------

describe('dispatchNotifications', () => {
  it('returns empty results when no platforms enabled', async () => {
    const config: FullNotificationConfig = { enabled: true };
    const result = await dispatchNotifications(config, 'session-idle', basePayload);
    assert.equal(result.event, 'session-idle');
    assert.equal(result.results.length, 0);
    assert.equal(result.anySuccess, false);
  });

  it('returns empty when config disabled', async () => {
    const config: FullNotificationConfig = {
      enabled: true,
      discord: { enabled: false, webhookUrl: '' },
    };
    const result = await dispatchNotifications(config, 'session-end', basePayload);
    assert.equal(result.results.length, 0);
    assert.equal(result.anySuccess, false);
  });

  it('dispatches to enabled platforms and collects results', async () => {
    const config: FullNotificationConfig = {
      enabled: true,
      discord: { enabled: true, webhookUrl: 'not-valid' },
      slack: { enabled: true, webhookUrl: 'not-valid' },
    };
    const result = await dispatchNotifications(config, 'session-end', basePayload);
    assert.ok(result.results.length > 0);
    // Both should fail (invalid URLs)
    assert.equal(result.anySuccess, false);
  });

  it('applies per-platform message overrides without changing other transports', async () => {
    const config: FullNotificationConfig = {
      enabled: true,
      webhook: { enabled: true, url: 'https://example.com/webhook' },
    };

    const fetchCalls: Array<{ url: string; body: string }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      fetchCalls.push({
        url: typeof input === 'string' ? input : input instanceof URL ? String(input) : input.url,
        body: typeof init?.body === 'string' ? init.body : '',
      });
      return new Response('', { status: 200 });
    };

    try {
      let telegramRequestBody = '';
      const result = await dispatchNotifications(
        config,
        'result-ready',
        {
          ...basePayload,
          event: 'result-ready',
          message: '# Result Ready\n\n**Summary:** Tests passed.',
          transportOverrides: {
            telegram: {
              message: 'Raw Telegram reply body',
              parseMode: null,
            },
          },
        },
      );

      assert.equal(result.anySuccess, true);
      assert.equal(fetchCalls.length, 1);
      const webhookBody = JSON.parse(fetchCalls[0].body) as { message: string };
      assert.equal(webhookBody.message, '# Result Ready\n\n**Summary:** Tests passed.');

      const telegramResult = await sendTelegram(
        { enabled: true, botToken: '123456:abc', chatId: '777' },
        {
          ...basePayload,
          message: '# Result Ready\n\n**Summary:** Tests passed.',
          transportOverrides: {
            telegram: {
              message: 'Raw Telegram reply body',
              parseMode: null,
            },
          },
        },
        {
          resolveTelegramDestinationImpl: async () => ({
            chatId: '777',
            sourceChatKey: 'telegram:123456:777',
          }),
          httpsRequestImpl: createHttpsRequestMock({
            'POST /bot123456:abc/sendMessage': (body) => {
              telegramRequestBody = body;
              return {
                statusCode: 200,
                body: {
                  ok: true,
                  result: {
                    message_id: 777,
                  },
                },
              };
            },
          }),
        },
      );

      assert.equal(telegramResult.success, true);
      const telegramBody = JSON.parse(telegramRequestBody) as {
        text: string;
        parse_mode?: string;
      };
      assert.equal(telegramBody.text, 'Raw Telegram reply body');
      assert.equal('parse_mode' in telegramBody, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('uses event-level platform config when present', async () => {
    const config: FullNotificationConfig = {
      enabled: true,
      events: {
        'session-end': {
          enabled: true,
          discord: { enabled: true, webhookUrl: 'invalid-url' },
        },
      },
    };
    const result = await dispatchNotifications(config, 'session-end', basePayload);
    assert.ok(result.results.length > 0);
    assert.equal(result.results[0].platform, 'discord');
  });

  it('falls back to top-level config when event has no platform override', async () => {
    const config: FullNotificationConfig = {
      enabled: true,
      discord: { enabled: true, webhookUrl: 'invalid-url' },
      events: {
        'session-start': { enabled: true },
      },
    };
    const result = await dispatchNotifications(config, 'session-start', basePayload);
    assert.ok(result.results.length > 0);
    assert.equal(result.results[0].platform, 'discord');
  });
});

describe('getEffectivePlatformConfig', () => {
  it('merges event-level Telegram overrides with top-level projectTopics config', () => {
    const merged = getEffectivePlatformConfig<TelegramNotificationConfig>(
      'telegram',
      {
        enabled: true,
        telegram: {
          enabled: true,
          botToken: 'top-token',
          chatId: 'top-chat',
          parseMode: 'Markdown',
          projectTopics: {
            enabled: true,
            autoCreate: true,
            fallbackToGeneral: false,
          },
        },
        events: {
          'session-end': {
            enabled: true,
            telegram: {
              enabled: true,
              botToken: 'event-token',
              chatId: 'event-chat',
            },
          },
        },
      },
      'session-end',
    );

    assert.ok(merged);
    assert.equal(merged?.botToken, 'event-token');
    assert.equal(merged?.chatId, 'event-chat');
    assert.equal(merged?.parseMode, 'Markdown');
    assert.deepEqual(merged?.projectTopics, {
      enabled: true,
      autoCreate: true,
      fallbackToGeneral: false,
    });
  });

  it('deep-merges nested event-level Telegram projectTopics overrides', () => {
    const merged = getEffectivePlatformConfig<TelegramNotificationConfig>(
      'telegram',
      {
        enabled: true,
        telegram: {
          enabled: true,
          botToken: 'top-token',
          chatId: 'top-chat',
          projectTopics: {
            enabled: true,
            autoCreate: true,
            fallbackToGeneral: true,
            naming: 'projectName',
            createFailureCooldownMs: 60_000,
          },
        },
        events: {
          'session-end': {
            enabled: true,
            telegram: {
              enabled: true,
              botToken: 'event-token',
              chatId: 'event-chat',
              projectTopics: {
                enabled: true,
                fallbackToGeneral: false,
                naming: 'projectNameWithHash',
              },
            },
          },
        },
      },
      'session-end',
    );

    assert.ok(merged);
    assert.equal(merged?.botToken, 'event-token');
    assert.equal(merged?.chatId, 'event-chat');
    assert.deepEqual(merged?.projectTopics, {
      enabled: true,
      autoCreate: true,
      fallbackToGeneral: false,
      naming: 'projectNameWithHash',
      createFailureCooldownMs: 60_000,
    });
  });

  it('deep-merges nested event-level Telegram richReplies overrides', () => {
    const merged = getEffectivePlatformConfig<TelegramNotificationConfig>(
      'telegram',
      {
        enabled: true,
        telegram: {
          enabled: true,
          botToken: 'top-token',
          chatId: 'top-chat',
          richReplies: {
            enabled: false,
            maxPhotoBytes: 1024,
            maxUploadBytes: 2048,
          },
        },
        events: {
          'result-ready': {
            enabled: true,
            telegram: {
              enabled: true,
              botToken: 'event-token',
              chatId: 'event-chat',
              richReplies: {
                enabled: true,
                maxPhotoBytes: 4096,
              },
            },
          },
        },
      },
      'result-ready',
    );

    assert.ok(merged);
    assert.deepEqual(merged?.richReplies, {
      enabled: true,
      maxPhotoBytes: 4096,
      maxUploadBytes: 2048,
    });
  });

  it('deep-merges nested event-level Telegram progress overrides', () => {
    const merged = getEffectivePlatformConfig<TelegramNotificationConfig>(
      'telegram',
      {
        enabled: true,
        telegram: {
          enabled: true,
          botToken: 'top-token',
          chatId: 'top-chat',
          progress: {
            enabled: true,
            mode: 'peek',
            transport: 'draft',
            showButton: true,
            fullTraceDelivery: 'message',
          },
        },
        events: {
          'result-ready': {
            enabled: true,
            telegram: {
              enabled: true,
              botToken: 'event-token',
              chatId: 'event-chat',
              progress: {
                showButton: false,
                fullTraceDelivery: 'none',
              },
            },
          },
        },
      },
      'result-ready',
    );

    assert.ok(merged);
    assert.deepEqual(merged?.progress, {
      enabled: true,
      mode: 'peek',
      transport: 'draft',
      showButton: false,
      fullTraceDelivery: 'none',
    });
  });
});
