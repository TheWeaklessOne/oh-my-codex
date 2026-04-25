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
  sendWebhook,
  dispatchNotifications,
} from '../dispatcher.js';
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
    const requestBodies: Array<{ message_thread_id?: number }> = [];

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
});
