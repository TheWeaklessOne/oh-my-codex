import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateMention,
  validateSlackMention,
  parseMentionAllowedMentions,
  buildConfigFromEnv,
  getNotificationConfig,
  getReplyConfig,
  getReplyListenerPlatformConfig,
  normalizeCompletedTurnPresentationConfig,
} from '../config.js';
import { getEffectivePlatformConfig } from '../dispatcher.js';
import type { TelegramNotificationConfig } from '../types.js';

const ENV_KEYS = [
  'CODEX_HOME',
  'HOME',
  'OMX_NOTIFY_PROFILE',
  'OMX_DISCORD_NOTIFIER_BOT_TOKEN',
  'OMX_DISCORD_NOTIFIER_CHANNEL',
  'OMX_DISCORD_WEBHOOK_URL',
  'OMX_DISCORD_MENTION',
  'OMX_TELEGRAM_BOT_TOKEN',
  'OMX_TELEGRAM_NOTIFIER_BOT_TOKEN',
  'OMX_TELEGRAM_CHAT_ID',
  'OMX_TELEGRAM_NOTIFIER_CHAT_ID',
  'OMX_TELEGRAM_NOTIFIER_UID',
  'OMX_SLACK_WEBHOOK_URL',
  'OMX_SLACK_MENTION',
  'OMX_REPLY_ENABLED',
  'OMX_REPLY_DISCORD_USER_IDS',
  'OMX_REPLY_TELEGRAM_USER_IDS',
  'OMX_REPLY_TELEGRAM_ALLOWED_UPDATES',
  'OMX_REPLY_POLL_INTERVAL_MS',
  'OMX_REPLY_RATE_LIMIT',
];
const ORIGINAL_ENV = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<string, string | undefined>;

function clearEnvVars(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

function restoreEnvVars(): void {
  for (const key of ENV_KEYS) {
    if (ORIGINAL_ENV[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = ORIGINAL_ENV[key];
    }
  }
}

describe('validateMention', () => {
  it('accepts valid user mention', () => {
    assert.equal(validateMention('<@12345678901234567>'), '<@12345678901234567>');
  });

  it('accepts valid user mention with exclamation (nickname)', () => {
    assert.equal(validateMention('<@!12345678901234567>'), '<@!12345678901234567>');
  });

  it('accepts valid role mention', () => {
    assert.equal(validateMention('<@&12345678901234567>'), '<@&12345678901234567>');
  });

  it('accepts 20-digit IDs', () => {
    assert.equal(validateMention('<@12345678901234567890>'), '<@12345678901234567890>');
  });

  it('rejects @everyone', () => {
    assert.equal(validateMention('@everyone'), undefined);
  });

  it('rejects @here', () => {
    assert.equal(validateMention('@here'), undefined);
  });

  it('rejects arbitrary text', () => {
    assert.equal(validateMention('hello world'), undefined);
  });

  it('rejects mention with trailing text', () => {
    assert.equal(validateMention('<@123456789012345678> extra'), undefined);
  });

  it('rejects too-short ID', () => {
    assert.equal(validateMention('<@1234>'), undefined);
  });

  it('returns undefined for empty string', () => {
    assert.equal(validateMention(''), undefined);
  });

  it('returns undefined for undefined', () => {
    assert.equal(validateMention(undefined), undefined);
  });

  it('trims whitespace and validates', () => {
    assert.equal(validateMention('  <@12345678901234567>  '), '<@12345678901234567>');
  });

  it('rejects whitespace-only string', () => {
    assert.equal(validateMention('   '), undefined);
  });
});

describe('validateSlackMention', () => {
  it('accepts valid user mentions', () => {
    assert.equal(validateSlackMention('<@U12345678>'), '<@U12345678>');
    assert.equal(validateSlackMention('<@W1234567890>'), '<@W1234567890>');
  });

  it('accepts special channel-style mentions and user groups', () => {
    assert.equal(validateSlackMention('<!channel>'), '<!channel>');
    assert.equal(validateSlackMention('<!subteam^S12345678>'), '<!subteam^S12345678>');
  });

  it('rejects invalid or plain-text mentions', () => {
    assert.equal(validateSlackMention('@channel'), undefined);
    assert.equal(validateSlackMention('<@12345678901234567>'), undefined);
    assert.equal(validateSlackMention(''), undefined);
  });
});

describe('parseMentionAllowedMentions', () => {
  it('parses user mention', () => {
    assert.deepEqual(parseMentionAllowedMentions('<@12345678901234567>'), { users: ['12345678901234567'] });
  });

  it('parses nickname user mention', () => {
    assert.deepEqual(parseMentionAllowedMentions('<@!12345678901234567>'), { users: ['12345678901234567'] });
  });

  it('parses role mention', () => {
    assert.deepEqual(parseMentionAllowedMentions('<@&12345678901234567>'), { roles: ['12345678901234567'] });
  });

  it('returns empty for undefined', () => {
    assert.deepEqual(parseMentionAllowedMentions(undefined), {});
  });

  it('returns empty for invalid mention', () => {
    assert.deepEqual(parseMentionAllowedMentions('@everyone'), {});
  });
});

describe('buildConfigFromEnv', () => {
  beforeEach(() => {
    clearEnvVars();
  });

  afterEach(() => {
    restoreEnvVars();
  });

  it('returns null when no env vars set', () => {
    assert.equal(buildConfigFromEnv(), null);
  });

  it('builds discord-bot config from env vars', () => {
    process.env.OMX_DISCORD_NOTIFIER_BOT_TOKEN = 'test-token';
    process.env.OMX_DISCORD_NOTIFIER_CHANNEL = '123456';
    const config = buildConfigFromEnv();
    assert.ok(config);
    assert.equal(config.enabled, true);
    assert.deepEqual(config['discord-bot'], {
      enabled: true,
      botToken: 'test-token',
      channelId: '123456',
      mention: undefined,
    });
  });

  it('includes validated mention in discord-bot config', () => {
    process.env.OMX_DISCORD_NOTIFIER_BOT_TOKEN = 'test-token';
    process.env.OMX_DISCORD_NOTIFIER_CHANNEL = '123456';
    process.env.OMX_DISCORD_MENTION = '<@12345678901234567>';
    const config = buildConfigFromEnv();
    assert.ok(config);
    assert.equal(config['discord-bot']!.mention, '<@12345678901234567>');
  });

  it('rejects invalid mention in env var', () => {
    process.env.OMX_DISCORD_NOTIFIER_BOT_TOKEN = 'test-token';
    process.env.OMX_DISCORD_NOTIFIER_CHANNEL = '123456';
    process.env.OMX_DISCORD_MENTION = '@everyone';
    const config = buildConfigFromEnv();
    assert.ok(config);
    assert.equal(config['discord-bot']!.mention, undefined);
  });

  it('builds discord webhook config from env var', () => {
    process.env.OMX_DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/test';
    const config = buildConfigFromEnv();
    assert.ok(config);
    assert.deepEqual(config.discord, {
      enabled: true,
      webhookUrl: 'https://discord.com/api/webhooks/test',
      mention: undefined,
    });
  });

  it('builds telegram config from env vars', () => {
    process.env.OMX_TELEGRAM_BOT_TOKEN = '123:abc';
    process.env.OMX_TELEGRAM_CHAT_ID = '999';
    const config = buildConfigFromEnv();
    assert.ok(config);
    assert.deepEqual(config.telegram, {
      enabled: true,
      botToken: '123:abc',
      chatId: '999',
    });
    assert.equal(config.telegram?.projectTopics, undefined);
  });

  it('builds slack config from env var', () => {
    process.env.OMX_SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/test';
    const config = buildConfigFromEnv();
    assert.ok(config);
    assert.deepEqual(config.slack, {
      enabled: true,
      webhookUrl: 'https://hooks.slack.com/services/test',
    });
  });

  it('includes a validated slack mention in slack config', () => {
    process.env.OMX_SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/test';
    process.env.OMX_SLACK_MENTION = '<!here>';

    const config = buildConfigFromEnv();
    assert.ok(config);
    assert.deepEqual(config.slack, {
      enabled: true,
      webhookUrl: 'https://hooks.slack.com/services/test',
      mention: '<!here>',
    });
  });

  it('drops invalid slack mention env values', () => {
    process.env.OMX_SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/test';
    process.env.OMX_SLACK_MENTION = '@here';

    const config = buildConfigFromEnv();
    assert.ok(config);
    assert.deepEqual(config.slack, {
      enabled: true,
      webhookUrl: 'https://hooks.slack.com/services/test',
    });
  });

  it('uses OMX_TELEGRAM_NOTIFIER_BOT_TOKEN as fallback', () => {
    process.env.OMX_TELEGRAM_NOTIFIER_BOT_TOKEN = '123:fallback';
    process.env.OMX_TELEGRAM_CHAT_ID = '999';
    const config = buildConfigFromEnv();
    assert.ok(config);
    assert.equal(config.telegram!.botToken, '123:fallback');
  });

  it('uses OMX_TELEGRAM_NOTIFIER_UID as fallback for chat ID', () => {
    process.env.OMX_TELEGRAM_BOT_TOKEN = '123:abc';
    process.env.OMX_TELEGRAM_NOTIFIER_UID = 'uid-999';
    const config = buildConfigFromEnv();
    assert.ok(config);
    assert.equal(config.telegram!.chatId, 'uid-999');
  });

  it('builds config with multiple platforms from env', () => {
    process.env.OMX_DISCORD_NOTIFIER_BOT_TOKEN = 'bot-token';
    process.env.OMX_DISCORD_NOTIFIER_CHANNEL = 'channel-123';
    process.env.OMX_TELEGRAM_BOT_TOKEN = '456:tg';
    process.env.OMX_TELEGRAM_CHAT_ID = 'chat-789';
    process.env.OMX_SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/test';

    const config = buildConfigFromEnv();
    assert.ok(config);
    assert.equal(config.enabled, true);
    assert.equal(config['discord-bot']!.enabled, true);
    assert.equal(config.telegram!.enabled, true);
    assert.equal(config.slack!.enabled, true);
  });

  it('mention from env is shared across discord-bot and discord webhook', () => {
    process.env.OMX_DISCORD_NOTIFIER_BOT_TOKEN = 'bot-token';
    process.env.OMX_DISCORD_NOTIFIER_CHANNEL = 'channel-123';
    process.env.OMX_DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/test';
    process.env.OMX_DISCORD_MENTION = '<@12345678901234567>';

    const config = buildConfigFromEnv();
    assert.ok(config);
    assert.equal(config['discord-bot']!.mention, '<@12345678901234567>');
    assert.equal(config.discord!.mention, '<@12345678901234567>');
  });
});

describe('normalizeCompletedTurnPresentationConfig', () => {
  it('normalizes Telegram completed-turn entity format overrides', () => {
    const config = normalizeCompletedTurnPresentationConfig({
      platformOverrides: {
        telegram: {
          telegramFormat: 'entities',
        },
      },
    });

    assert.equal(config.platformOverrides?.telegram?.telegramFormat, 'entities');
  });

  it('normalizes Telegram literal opt-out overrides', () => {
    const config = normalizeCompletedTurnPresentationConfig({
      platformOverrides: {
        telegram: {
          telegramFormat: 'literal',
        },
      },
    });

    assert.equal(config.platformOverrides?.telegram?.telegramFormat, 'literal');
  });

  it('falls invalid Telegram completed-turn formats back to entities', () => {
    const config = normalizeCompletedTurnPresentationConfig({
      platformOverrides: {
        telegram: {
          telegramFormat: 'MarkdownV2',
        },
      },
    } as unknown as Parameters<typeof normalizeCompletedTurnPresentationConfig>[0]);

    assert.equal(config.platformOverrides?.telegram?.telegramFormat, 'entities');
  });

  it('ignores telegramFormat on non-Telegram platform overrides', () => {
    const config = normalizeCompletedTurnPresentationConfig({
      platformOverrides: {
        discord: {
          telegramFormat: 'literal',
        },
      },
    } as unknown as Parameters<typeof normalizeCompletedTurnPresentationConfig>[0]);

    assert.equal(config.platformOverrides, undefined);
  });
});

describe('getNotificationConfig', () => {
  beforeEach(() => {
    clearEnvVars();
  });

  afterEach(() => {
    restoreEnvVars();
  });

  it('inherits user notification policy when project CODEX_HOME has no .omx-config.json', async () => {
    const tempHome = await mkdtemp(join(tmpdir(), 'omx-notification-config-'));
    const userCodexHome = join(tempHome, '.codex');
    const projectCodexHome = join(tempHome, 'project', '.codex');

    try {
      await mkdir(userCodexHome, { recursive: true });
      await mkdir(projectCodexHome, { recursive: true });
      await writeFile(join(userCodexHome, '.omx-config.json'), JSON.stringify({
        notifications: {
          enabled: true,
          webhook: {
            enabled: true,
            url: 'https://example.com/webhook',
          },
          telegram: {
            enabled: true,
            botToken: '123456:telegram-token',
            chatId: '777',
            projectTopics: {
              enabled: true,
            },
          },
        },
      }, null, 2));
      process.env.HOME = tempHome;
      process.env.CODEX_HOME = projectCodexHome;

      const config = getNotificationConfig();
      assert.ok(config);
      assert.equal(config.webhook?.enabled, true);
      assert.equal(config.telegram?.projectTopics?.enabled, true);
      assert.equal(config.telegram?.progress?.enabled, false);
      assert.equal(config.telegram?.progress?.mode, 'off');
      assert.equal(config.completedTurn?.resultReadyMode, 'raw-assistant-text');
      assert.equal(config.completedTurn?.askUserQuestionMode, 'raw-assistant-text');
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  it('loads Telegram completed-turn format overrides from .omx-config.json', async () => {
    const tempHome = await mkdtemp(join(tmpdir(), 'omx-notification-config-'));
    const codexHome = join(tempHome, '.codex');

    try {
      await mkdir(codexHome, { recursive: true });
      await writeFile(join(codexHome, '.omx-config.json'), JSON.stringify({
        notifications: {
          enabled: true,
          webhook: {
            enabled: true,
            url: 'https://example.com/webhook',
          },
          completedTurn: {
            platformOverrides: {
              telegram: {
                telegramFormat: 'literal',
              },
            },
          },
        },
      }, null, 2));
      process.env.HOME = tempHome;
      process.env.CODEX_HOME = codexHome;

      const config = getNotificationConfig();
      assert.ok(config);
      assert.equal(
        config.completedTurn?.platformOverrides?.telegram?.telegramFormat,
        'literal',
      );
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  it('normalizes Telegram progress config from .omx-config.json', async () => {
    const tempHome = await mkdtemp(join(tmpdir(), 'omx-notification-config-'));
    const codexHome = join(tempHome, '.codex');

    try {
      await mkdir(codexHome, { recursive: true });
      await writeFile(join(codexHome, '.omx-config.json'), JSON.stringify({
        notifications: {
          enabled: true,
          telegram: {
            enabled: true,
            botToken: '123456:telegram-token',
            chatId: '777',
            progress: {
              enabled: true,
              mode: 'peek',
              transport: 'draft',
              minUpdateIntervalMs: 10,
              maxDraftChars: 99_999,
              maxStoredEntries: 5,
              showButton: true,
            },
          },
        },
      }, null, 2));
      process.env.HOME = tempHome;
      process.env.CODEX_HOME = codexHome;

      const config = getNotificationConfig();
      assert.ok(config);
      assert.equal(config.telegram?.progress?.enabled, true);
      assert.equal(config.telegram?.progress?.mode, 'peek');
      assert.equal(config.telegram?.progress?.transport, 'draft');
      assert.equal(config.telegram?.progress?.minUpdateIntervalMs, 800);
      assert.equal(config.telegram?.progress?.maxDraftChars, 4096);
      assert.equal(config.telegram?.progress?.maxStoredEntries, 5);
      assert.equal(config.telegram?.progress?.showButton, true);
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  it('keeps explicit Telegram progress off disabled', async () => {
    const tempHome = await mkdtemp(join(tmpdir(), 'omx-notification-config-'));
    const codexHome = join(tempHome, '.codex');

    try {
      await mkdir(codexHome, { recursive: true });
      await writeFile(join(codexHome, '.omx-config.json'), JSON.stringify({
        notifications: {
          enabled: true,
          telegram: {
            enabled: true,
            botToken: '123456:telegram-token',
            chatId: '777',
            progress: {
              enabled: true,
              mode: 'off',
              transport: 'draft',
            },
          },
        },
      }, null, 2));
      process.env.HOME = tempHome;
      process.env.CODEX_HOME = codexHome;

      const config = getNotificationConfig();
      assert.ok(config);
      assert.equal(config.telegram?.progress?.enabled, false);
      assert.equal(config.telegram?.progress?.mode, 'off');
      assert.equal(config.telegram?.progress?.transport, 'none');
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  it('preserves top-level Telegram progress when event Telegram overrides omit progress', async () => {
    const tempHome = await mkdtemp(join(tmpdir(), 'omx-notification-config-'));
    const codexHome = join(tempHome, '.codex');

    try {
      await mkdir(codexHome, { recursive: true });
      await writeFile(join(codexHome, '.omx-config.json'), JSON.stringify({
        notifications: {
          enabled: true,
          telegram: {
            enabled: true,
            botToken: '123456:telegram-token',
            chatId: '777',
            progress: {
              enabled: true,
              mode: 'peek',
              transport: 'draft',
            },
          },
          events: {
            'result-ready': {
              enabled: true,
              telegram: {
                enabled: true,
                botToken: '123456:event-token',
                chatId: '888',
              },
            },
          },
        },
      }, null, 2));
      process.env.HOME = tempHome;
      process.env.CODEX_HOME = codexHome;

      const config = getNotificationConfig();
      assert.ok(config);
      const effective = getEffectivePlatformConfig<TelegramNotificationConfig>(
        'telegram',
        config,
        'result-ready',
      );
      assert.equal(effective?.botToken, '123456:event-token');
      assert.equal(effective?.chatId, '888');
      assert.equal(effective?.progress?.enabled, true);
      assert.equal(effective?.progress?.mode, 'peek');
      assert.equal(effective?.progress?.transport, 'draft');
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  it('deep-merges partial event Telegram progress overrides with top-level progress', async () => {
    const tempHome = await mkdtemp(join(tmpdir(), 'omx-notification-config-'));
    const codexHome = join(tempHome, '.codex');

    try {
      await mkdir(codexHome, { recursive: true });
      await writeFile(join(codexHome, '.omx-config.json'), JSON.stringify({
        notifications: {
          enabled: true,
          telegram: {
            enabled: true,
            botToken: '123456:telegram-token',
            chatId: '777',
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
                progress: {
                  showButton: false,
                  fullTraceDelivery: 'none',
                },
              },
            },
          },
        },
      }, null, 2));
      process.env.HOME = tempHome;
      process.env.CODEX_HOME = codexHome;

      const config = getNotificationConfig();
      assert.ok(config);
      const effective = getEffectivePlatformConfig<TelegramNotificationConfig>(
        'telegram',
        config,
        'result-ready',
      );
      assert.equal(effective?.progress?.enabled, true);
      assert.equal(effective?.progress?.mode, 'peek');
      assert.equal(effective?.progress?.transport, 'draft');
      assert.equal(effective?.progress?.showButton, false);
      assert.equal(effective?.progress?.fullTraceDelivery, 'none');
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  it('adds callback_query allowed updates when Telegram progress buttons are enabled', async () => {
    const tempHome = await mkdtemp(join(tmpdir(), 'omx-notification-config-'));
    const codexHome = join(tempHome, '.codex');

    try {
      await mkdir(codexHome, { recursive: true });
      await writeFile(join(codexHome, '.omx-config.json'), JSON.stringify({
        notifications: {
          enabled: true,
          telegram: {
            enabled: true,
            botToken: '123456:telegram-token',
            chatId: '777',
            progress: {
              enabled: true,
              mode: 'peek',
              transport: 'draft',
              showButton: true,
            },
          },
          reply: {
            enabled: true,
            telegramAllowedUpdates: ['message'],
            authorizedTelegramUserIds: ['telegram-user-1'],
          },
        },
      }, null, 2));
      process.env.HOME = tempHome;
      process.env.CODEX_HOME = codexHome;

      const config = getNotificationConfig();
      assert.ok(config);
      assert.deepEqual(getReplyConfig(config)?.telegramAllowedUpdates, [
        'message',
        'callback_query',
      ]);

      await writeFile(join(codexHome, '.omx-config.json'), JSON.stringify({
        notifications: {
          enabled: true,
          telegram: {
            enabled: true,
            botToken: '123456:telegram-token',
            chatId: '777',
            progress: {
              enabled: true,
              mode: 'peek',
              transport: 'draft',
              showButton: true,
            },
          },
          reply: {
            enabled: true,
            authorizedTelegramUserIds: ['telegram-user-1'],
          },
        },
      }, null, 2));

      const defaultConfig = getNotificationConfig();
      assert.ok(defaultConfig);
      assert.deepEqual(getReplyConfig(defaultConfig)?.telegramAllowedUpdates, [
        'message',
        'callback_query',
      ]);
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  it('keeps project-local notification config authoritative when it exists', async () => {
    const tempHome = await mkdtemp(join(tmpdir(), 'omx-notification-config-'));
    const userCodexHome = join(tempHome, '.codex');
    const projectCodexHome = join(tempHome, 'project', '.codex');

    try {
      await mkdir(userCodexHome, { recursive: true });
      await mkdir(projectCodexHome, { recursive: true });
      await writeFile(join(userCodexHome, '.omx-config.json'), JSON.stringify({
        notifications: {
          enabled: true,
          webhook: {
            enabled: true,
            url: 'https://example.com/user-webhook',
          },
          completedTurn: {
            resultReadyMode: 'formatted-notification',
          },
        },
      }, null, 2));
      await writeFile(join(projectCodexHome, '.omx-config.json'), JSON.stringify({
        notifications: {
          enabled: true,
          webhook: {
            enabled: true,
            url: 'https://example.com/project-webhook',
          },
        },
      }, null, 2));
      process.env.HOME = tempHome;
      process.env.CODEX_HOME = projectCodexHome;

      const config = getNotificationConfig();
      assert.ok(config);
      assert.equal(config.webhook?.url, 'https://example.com/project-webhook');
      assert.equal(config.completedTurn?.resultReadyMode, 'raw-assistant-text');
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  it('supports explicit codexHomeOverride fallback independently of process.env.CODEX_HOME', async () => {
    const tempHome = await mkdtemp(join(tmpdir(), 'omx-notification-config-'));
    const userCodexHome = join(tempHome, '.codex');
    const projectCodexHome = join(tempHome, 'project', '.codex');
    const unrelatedCodexHome = join(tempHome, 'elsewhere', '.codex');

    try {
      await mkdir(userCodexHome, { recursive: true });
      await mkdir(projectCodexHome, { recursive: true });
      await mkdir(unrelatedCodexHome, { recursive: true });
      await writeFile(join(userCodexHome, '.omx-config.json'), JSON.stringify({
        notifications: {
          enabled: true,
          webhook: {
            enabled: true,
            url: 'https://example.com/user-webhook',
          },
        },
      }, null, 2));
      await writeFile(join(unrelatedCodexHome, '.omx-config.json'), JSON.stringify({
        notifications: {
          enabled: true,
          webhook: {
            enabled: true,
            url: 'https://example.com/unrelated-webhook',
          },
        },
      }, null, 2));
      process.env.HOME = tempHome;
      process.env.CODEX_HOME = unrelatedCodexHome;

      const config = getNotificationConfig(undefined, {
        codexHomeOverride: projectCodexHome,
      });

      assert.ok(config);
      assert.equal(config.webhook?.url, 'https://example.com/user-webhook');
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  it('uses the provided env for profile and transport resolution', async () => {
    const tempHome = await mkdtemp(join(tmpdir(), 'omx-notification-config-'));
    const userCodexHome = join(tempHome, '.codex');

    try {
      await mkdir(userCodexHome, { recursive: true });
      await writeFile(join(userCodexHome, '.omx-config.json'), JSON.stringify({
        notifications: {
          enabled: true,
          defaultProfile: 'default',
          profiles: {
            default: {
              enabled: true,
              webhook: {
                enabled: true,
                url: 'https://example.com/default-webhook',
              },
            },
            alternate: {
              enabled: true,
              webhook: {
                enabled: true,
                url: 'https://example.com/alternate-webhook',
              },
            },
          },
        },
      }, null, 2));
      process.env.HOME = tempHome;
      process.env.OMX_NOTIFY_PROFILE = 'default';

      const config = getNotificationConfig(undefined, {
        env: {
          ...process.env,
          HOME: tempHome,
          OMX_NOTIFY_PROFILE: 'alternate',
        },
      });

      assert.ok(config);
      assert.equal(config.webhook?.url, 'https://example.com/alternate-webhook');
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  it('uses the provided env for temp-mode filtering', async () => {
    const tempHome = await mkdtemp(join(tmpdir(), 'omx-notification-config-'));
    const userCodexHome = join(tempHome, '.codex');

    try {
      await mkdir(userCodexHome, { recursive: true });
      await writeFile(join(userCodexHome, '.omx-config.json'), JSON.stringify({
        notifications: {
          enabled: true,
          telegram: {
            enabled: true,
            botToken: '123456:telegram-token',
            chatId: '777',
          },
          webhook: {
            enabled: true,
            url: 'https://example.com/webhook',
          },
        },
      }, null, 2));
      process.env.HOME = tempHome;
      delete process.env.OMX_NOTIFY_TEMP_CONTRACT;

      const config = getNotificationConfig(undefined, {
        env: {
          ...process.env,
          HOME: tempHome,
          OMX_NOTIFY_TEMP_CONTRACT: JSON.stringify({
            active: true,
            selectors: ['telegram'],
            canonicalSelectors: ['telegram'],
            warnings: [],
            source: 'env',
          }),
        },
      });

      assert.ok(config);
      assert.equal(config.telegram?.enabled, true);
      assert.equal(config.webhook, undefined);
      assert.equal(config.events?.['result-ready']?.enabled, true);
      assert.equal(config.events?.['session-start']?.enabled, false);
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });
});

describe('getReplyListenerPlatformConfig', () => {
  it('does not expose credentials for disabled channels', () => {
    const config = {
      enabled: true,
      telegram: {
        enabled: false,
        botToken: 'tg-token',
        chatId: 'tg-chat',
      },
      'discord-bot': {
        enabled: false,
        botToken: 'dc-token',
        channelId: 'dc-channel',
      },
    };

    const platformConfig = getReplyListenerPlatformConfig(config);
    assert.equal(platformConfig.telegramEnabled, false);
    assert.equal(platformConfig.discordEnabled, false);
    assert.equal(platformConfig.telegramBotToken, undefined);
    assert.equal(platformConfig.discordBotToken, undefined);
  });

  it('returns credentials for enabled channels only', () => {
    const config = {
      enabled: true,
      telegram: {
        enabled: true,
        botToken: 'tg-token',
        chatId: 'tg-chat',
        projectTopics: {
          enabled: true,
          autoCreate: true,
          fallbackToGeneral: true,
        },
      },
      'discord-bot': {
        enabled: false,
        botToken: 'dc-token',
        channelId: 'dc-channel',
      },
    };

    const platformConfig = getReplyListenerPlatformConfig(config);
    assert.equal(platformConfig.telegramEnabled, true);
    assert.equal(platformConfig.telegramBotToken, 'tg-token');
    assert.equal(platformConfig.discordEnabled, false);
    assert.equal(platformConfig.discordBotToken, undefined);
  });
});
