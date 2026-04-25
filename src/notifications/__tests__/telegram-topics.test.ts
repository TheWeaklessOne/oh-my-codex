import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ClientRequestArgs, IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TelegramNotificationConfig } from '../types.js';
import { markMockTelegramTransportForTests } from '../../utils/test-env.js';

let tempHome = '';
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

async function importTopicsFresh() {
  const moduleUrl = new URL('../telegram-topics.js', import.meta.url);
  moduleUrl.searchParams.set('t', `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  return import(moduleUrl.href);
}

async function importRegistryFresh() {
  const moduleUrl = new URL('../telegram-topic-registry.js', import.meta.url);
  moduleUrl.searchParams.set('t', `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  return import(moduleUrl.href);
}

type HttpsRouteHandler = (body: string, options: ClientRequestArgs) => {
  statusCode: number;
  body?: unknown;
  delayMs?: number;
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
            setTimeout(() => {
              if (result.body !== undefined) {
                response.write(
                  typeof result.body === 'string'
                    ? result.body
                    : JSON.stringify(result.body),
                );
              }
              response.end();
            }, result.delayMs ?? 0);
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

function createConfig(overrides: Partial<TelegramNotificationConfig> = {}): TelegramNotificationConfig {
  return {
    enabled: true,
    botToken: '123456:telegram-token',
    chatId: '777',
    projectTopics: {
      enabled: true,
      autoCreate: true,
      fallbackToGeneral: true,
      naming: 'projectName',
      createFailureCooldownMs: 60_000,
    },
    ...overrides,
  };
}

describe('telegram-topics', () => {
  before(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'omx-telegram-topics-'));
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
  });

  beforeEach(async () => {
    await rm(join(tempHome, '.omx'), { recursive: true, force: true });
  });

  after(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }

    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }

    await rm(tempHome, { recursive: true, force: true });
  });

  it('blocks live Telegram Bot API requests in tests without a marked mock transport', async () => {
    const topics = await importTopicsFresh();
    const config = createConfig();
    const wrapperTransport = ((...args: Parameters<typeof httpsRequest>) => {
      return httpsRequest(...args);
    }) as typeof httpsRequest;

    await assert.rejects(
      topics.performTelegramBotApiRequest(
        config.botToken,
        'createForumTopic',
        { chat_id: config.chatId, name: 'project-a' },
        { httpsRequestImpl: wrapperTransport },
      ),
      /Live Telegram Bot API requests are disabled while running tests/,
    );
  });

  it('creates a project topic on first send and reuses it on later sends', async () => {
    const topics = await importTopicsFresh();
    const config = createConfig();
    let createCalls = 0;

    const httpsRequestImpl = createHttpsRequestMock({
      [`POST /bot${config.botToken}/createForumTopic`]: () => {
        createCalls += 1;
        return {
          statusCode: 200,
          body: {
            ok: true,
            result: {
              message_thread_id: 9001,
              name: 'project-a',
            },
          },
        };
      },
    });

    const first = await topics.resolveTelegramDestination(
      config,
      {
        projectPath: '/repos/project-a',
        projectName: 'project-a',
      },
      { httpsRequestImpl, logger: { warn() {} } },
    );
    const second = await topics.resolveTelegramDestination(
      config,
      {
        projectPath: '/repos/project-a',
        projectName: 'project-a',
      },
      { httpsRequestImpl, logger: { warn() {} } },
    );

    assert.equal(first.messageThreadId, '9001');
    assert.equal(second.messageThreadId, '9001');
    assert.equal(first.topicName, 'project-a');
    assert.equal(second.topicName, 'project-a');
    assert.equal(createCalls, 1);
  });

  it('adds a short hash suffix when another project in the same chat uses the same display name', async () => {
    const topics = await importTopicsFresh();
    const registry = await importRegistryFresh();
    const config = createConfig();
    const sourceChatKey = 'telegram:123456:777';

    await registry.upsertTelegramTopicRegistryRecord({
      sourceChatKey,
      projectKey: 'existing-project-key',
      canonicalProjectPath: '/repos/team-a/api',
      displayName: 'api',
      topicName: 'api',
      messageThreadId: '9000',
      createdAt: '2026-04-21T16:00:00.000Z',
      lastUsedAt: '2026-04-21T16:00:00.000Z',
    });

    let createdTopicName = '';
    const httpsRequestImpl = createHttpsRequestMock({
      [`POST /bot${config.botToken}/createForumTopic`]: (body) => {
        createdTopicName = (JSON.parse(body) as { name: string }).name;
        return {
          statusCode: 200,
          body: {
            ok: true,
            result: {
              message_thread_id: 9002,
              name: createdTopicName,
            },
          },
        };
      },
    });

    const destination = await topics.resolveTelegramDestination(
      config,
      {
        projectPath: '/repos/team-b/api',
        projectName: 'api',
      },
      { httpsRequestImpl, logger: { warn() {} } },
    );

    assert.match(createdTopicName, /^api · [0-9a-f]{6}$/);
    assert.equal(destination.topicName, createdTopicName);
    assert.equal(destination.messageThreadId, '9002');
  });

  it('falls back to the root chat and records cooldown metadata when topic creation fails', async () => {
    const topics = await importTopicsFresh();
    const registry = await importRegistryFresh();
    const config = createConfig();
    let createCalls = 0;

    const httpsRequestImpl = createHttpsRequestMock({
      [`POST /bot${config.botToken}/createForumTopic`]: () => {
        createCalls += 1;
        return {
          statusCode: 400,
          body: {
            ok: false,
            description: 'Bad Request: chat is not a forum',
          },
        };
      },
    });

    const first = await topics.resolveTelegramDestination(
      config,
      {
        projectPath: '/repos/project-a',
        projectName: 'project-a',
      },
      { httpsRequestImpl, logger: { warn() {} } },
    );
    const second = await topics.resolveTelegramDestination(
      config,
      {
        projectPath: '/repos/project-a',
        projectName: 'project-a',
      },
      { httpsRequestImpl, logger: { warn() {} } },
    );

    assert.equal(first.usedFallback, true);
    assert.equal(first.messageThreadId, undefined);
    assert.equal(first.warningCode, 'forum-unavailable');
    assert.equal(second.usedFallback, true);
    assert.equal(createCalls, 1);

    const identity = topics.normalizeTelegramProjectIdentity({
      projectPath: '/repos/project-a',
      projectName: 'project-a',
    });
    assert.ok(identity);
    const stored = await registry.getTelegramTopicRegistryRecord('telegram:123456:777', identity!.projectKey);
    assert.equal(stored?.lastCreateFailureCode, 'forum-unavailable');
    assert.ok(stored?.createFailureCooldownUntil);
  });

  it('returns skipSend when autoCreate is disabled and fallback to the root chat is forbidden', async () => {
    const topics = await importTopicsFresh();
    const config = createConfig({
      projectTopics: {
        enabled: true,
        autoCreate: false,
        fallbackToGeneral: false,
        naming: 'projectName',
        createFailureCooldownMs: 60_000,
      },
    });
    let createCalls = 0;

    const destination = await topics.resolveTelegramDestination(
      config,
      {
        projectPath: '/repos/project-a',
        projectName: 'project-a',
      },
      {
        httpsRequestImpl: createHttpsRequestMock({
          [`POST /bot${config.botToken}/createForumTopic`]: () => {
            createCalls += 1;
            return {
              statusCode: 200,
              body: {
                ok: true,
                result: {
                  message_thread_id: 9100,
                  name: 'project-a',
                },
              },
            };
          },
        }),
        logger: { warn() {} },
      },
    );

    assert.equal(destination.skipSend, true);
    assert.equal(destination.usedFallback, undefined);
    assert.equal(destination.warningCode, 'topic-auto-create-disabled');
    assert.equal(destination.messageThreadId, undefined);
    assert.equal(createCalls, 0);
  });

  it('returns skipSend when topic creation fails and fallback to the root chat is forbidden', async () => {
    const topics = await importTopicsFresh();
    const config = createConfig({
      projectTopics: {
        enabled: true,
        autoCreate: true,
        fallbackToGeneral: false,
        naming: 'projectName',
        createFailureCooldownMs: 60_000,
      },
    });
    let createCalls = 0;

    const destination = await topics.resolveTelegramDestination(
      config,
      {
        projectPath: '/repos/project-a',
        projectName: 'project-a',
      },
      {
        httpsRequestImpl: createHttpsRequestMock({
          [`POST /bot${config.botToken}/createForumTopic`]: () => {
            createCalls += 1;
            return {
              statusCode: 400,
              body: {
                ok: false,
                description: 'Bad Request: chat is not a forum',
              },
            };
          },
        }),
        logger: { warn() {} },
      },
    );

    assert.equal(destination.skipSend, true);
    assert.equal(destination.usedFallback, undefined);
    assert.equal(destination.warningCode, 'forum-unavailable');
    assert.equal(createCalls, 1);
  });

  it('does not create duplicate topics during concurrent first-send resolution', async () => {
    const topics = await importTopicsFresh();
    const config = createConfig();
    let createCalls = 0;

    const httpsRequestImpl = createHttpsRequestMock({
      [`POST /bot${config.botToken}/createForumTopic`]: () => {
        createCalls += 1;
        return {
          statusCode: 200,
          delayMs: 40,
          body: {
            ok: true,
            result: {
              message_thread_id: 9003,
              name: 'project-a',
            },
          },
        };
      },
    });

    const [left, right] = await Promise.all([
      topics.resolveTelegramDestination(
        config,
        {
          projectPath: '/repos/project-a',
          projectName: 'project-a',
        },
        { httpsRequestImpl, logger: { warn() {} } },
      ),
      topics.resolveTelegramDestination(
        config,
        {
          projectPath: '/repos/project-a',
          projectName: 'project-a',
        },
        { httpsRequestImpl, logger: { warn() {} } },
      ),
    ]);

    assert.equal(left.messageThreadId, '9003');
    assert.equal(right.messageThreadId, '9003');
    assert.equal(createCalls, 1);
  });

  it('recovers the topic destination from session correlation metadata when topic-registry persistence was lost', async () => {
    const topics = await importTopicsFresh();
    const registry = await importRegistryFresh();
    const config = createConfig();
    const sourceChatKey = 'telegram:123456:777';
    const identity = topics.normalizeTelegramProjectIdentity({
      projectPath: '/repos/project-a',
      projectName: 'project-a',
    });
    assert.ok(identity);

    const sessionRegistryPath = join(tempHome, '.omx', 'state', 'reply-session-registry.jsonl');
    await mkdir(join(tempHome, '.omx', 'state'), { recursive: true });
    await writeFile(
      sessionRegistryPath,
      `${JSON.stringify({
        platform: 'telegram',
        messageId: '321',
        source: {
          platform: 'telegram',
          key: sourceChatKey,
          label: 'telegram:777',
          chatId: '777',
          botId: '123456',
        },
        sessionId: 'sess-1',
        tmuxPaneId: '%1',
        tmuxSessionName: 'omx',
        event: 'result-ready',
        createdAt: '2026-04-21T16:05:00.000Z',
        projectPath: '/repos/project-a',
        projectKey: identity!.projectKey,
        messageThreadId: '9004',
        topicName: 'project-a',
      })}\n`,
    );

    const destination = await topics.resolveTelegramDestination(
      config,
      {
        projectPath: '/repos/project-a',
        projectName: 'project-a',
      },
      {
        httpsRequestImpl: createHttpsRequestMock({}),
        logger: { warn() {} },
      },
    );

    assert.equal(destination.messageThreadId, '9004');
    assert.equal(destination.topicName, 'project-a');

    const persisted = await registry.getTelegramTopicRegistryRecord(
      sourceChatKey,
      identity!.projectKey,
    );
    assert.equal(persisted?.messageThreadId, '9004');
    assert.equal(persisted?.topicName, 'project-a');
  });

  it('warns when a topic record exists but the effective config disables projectTopics', async () => {
    const topics = await importTopicsFresh();
    const registry = await importRegistryFresh();
    const sourceChatKey = 'telegram:123456:777';
    const identity = topics.normalizeTelegramProjectIdentity({
      projectPath: '/repos/project-a',
      projectName: 'project-a',
    });
    assert.ok(identity);

    await registry.updateTelegramTopicRegistryRecord(
      sourceChatKey,
      identity!.projectKey,
      () => ({
        sourceChatKey,
        projectKey: identity!.projectKey,
        canonicalProjectPath: identity!.canonicalProjectPath,
        displayName: identity!.displayName,
        topicName: 'project-a',
        messageThreadId: '9005',
        createdAt: '2026-04-21T16:00:00.000Z',
        lastUsedAt: '2026-04-21T16:00:00.000Z',
      }),
    );

    const warnings: Array<{ warningCode?: string; warningMessage?: string }> = [];
    const destination = await topics.resolveTelegramDestination(
      createConfig({ projectTopics: undefined }),
      {
        projectPath: '/repos/project-a',
        projectName: 'project-a',
      },
      {
        logger: {
          warn(_line: string, details?: { warningCode?: string; warningMessage?: string }) {
            warnings.push(details ?? {});
          },
        },
      },
    );

    assert.equal(destination.messageThreadId, undefined);
    assert.equal(destination.chatId, '777');
    assert.equal(
      warnings[0]?.warningCode,
      'topic-routing-disabled-with-existing-record',
    );
  });

  it('derives the same project key from a symlinked project path via canonical path identity', async () => {
    const topics = await importTopicsFresh();
    const realRoot = join(tempHome, 'real-project');
    const aliasRoot = join(tempHome, 'alias-project');
    await mkdir(realRoot, { recursive: true });
    await symlink(realRoot, aliasRoot);

    const realIdentity = topics.normalizeTelegramProjectIdentity({
      projectPath: realRoot,
      projectName: 'project-a',
    });
    const aliasIdentity = topics.normalizeTelegramProjectIdentity({
      projectPath: aliasRoot,
      projectName: 'project-a',
    });

    assert.ok(realIdentity);
    assert.ok(aliasIdentity);
    assert.equal(realIdentity?.projectKey, aliasIdentity?.projectKey);
    assert.equal(realIdentity?.canonicalProjectPath, aliasIdentity?.canonicalProjectPath);
    assert.equal(await readlink(aliasRoot), realRoot);
    const lockEntries = await readdir(join(tempHome, '.omx', 'state')).catch(() => []);
    assert.ok(Array.isArray(lockEntries));
  });
});
