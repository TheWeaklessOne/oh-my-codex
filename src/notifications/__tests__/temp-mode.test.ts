import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { shouldDispatchOpenClaw } from '../index.js';
import { resetOpenClawConfigCache } from '../../openclaw/config.js';

const ENV_KEYS = [
  'CODEX_HOME',
  'OMX_NOTIFY_TEMP',
  'OMX_NOTIFY_TEMP_CONTRACT',
  'OMX_NOTIFY_PROFILE',
  'OMX_DISCORD_WEBHOOK_URL',
  'OMX_DISCORD_NOTIFIER_BOT_TOKEN',
  'OMX_DISCORD_NOTIFIER_CHANNEL',
  'OMX_TELEGRAM_BOT_TOKEN',
  'OMX_TELEGRAM_CHAT_ID',
  'OMX_SLACK_WEBHOOK_URL',
  'OMX_OPENCLAW',
] as const;

const ORIGINAL_HOME = process.env.HOME;
let tempCodexHome: string;
let tempHomeRoot: string;

async function writeCodexConfig(contents: unknown): Promise<void> {
  await mkdir(tempCodexHome, { recursive: true });
  await writeFile(join(tempCodexHome, '.omx-config.json'), JSON.stringify(contents, null, 2));
}

async function getNotificationConfigFresh() {
  const mod = await import(`../config.js?temp-mode=${Date.now()}-${Math.random()}`);
  return mod.getNotificationConfig();
}

function clearEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

describe('notification temp mode', () => {
  beforeEach(async () => {
    clearEnv();
    resetOpenClawConfigCache();
    tempHomeRoot = await mkdtemp(join(tmpdir(), 'omx-notify-home-'));
    tempCodexHome = join(tempHomeRoot, '.codex-explicit');
    process.env.CODEX_HOME = tempCodexHome;
    process.env.HOME = tempHomeRoot;
  });

  afterEach(async () => {
    clearEnv();
    if (typeof ORIGINAL_HOME === 'string') process.env.HOME = ORIGINAL_HOME;
    resetOpenClawConfigCache();
    if (tempHomeRoot) {
      await rm(tempHomeRoot, { recursive: true, force: true });
    }
  });

  it('temp contract preserves persistent profile policy while narrowing transports', async () => {
    await writeCodexConfig({
      notifications: {
        enabled: true,
        defaultProfile: 'file-profile',
        profiles: {
          'file-profile': {
            enabled: true,
            verbosity: 'session',
            discord: { enabled: true, webhookUrl: 'https://discord.com/api/webhooks/file' },
            telegram: { enabled: true, botToken: 'file-token', chatId: 'file-chat' },
            events: {
              'session-start': { enabled: false },
              'session-idle': { enabled: false },
              'result-ready': { enabled: true },
              'ask-user-question': { enabled: true },
              'session-end': { enabled: true },
            },
          },
        },
      },
    });
    process.env.OMX_NOTIFY_PROFILE = 'file-profile';
    process.env.OMX_SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/temp-only';
    process.env.OMX_NOTIFY_TEMP_CONTRACT = JSON.stringify({
      active: true,
      selectors: ['slack'],
      canonicalSelectors: ['slack'],
      warnings: [],
      source: 'cli',
    });

    const config = await getNotificationConfigFresh();
    assert.ok(config);
    assert.equal(config.enabled, true);
    assert.equal(config.verbosity, 'session');
    assert.equal(config.slack?.enabled, true);
    assert.equal(config.discord, undefined);
    assert.equal(config.telegram, undefined);
    assert.equal(config.events?.['result-ready']?.enabled, true);
    assert.equal(config.events?.['ask-user-question']?.enabled, true);
    assert.equal(config.events?.['session-idle']?.enabled, false);
  });

  it('temp contract with no valid configured provider disables dispatch config', async () => {
    process.env.OMX_NOTIFY_TEMP_CONTRACT = JSON.stringify({
      active: true,
      selectors: ['telegram'],
      canonicalSelectors: ['telegram'],
      warnings: [],
      source: 'cli',
    });

    const config = await getNotificationConfigFresh();
    assert.ok(config);
    assert.equal(config.enabled, false);
  });

  it('temp mode does not leak persistent openclaw/custom alias routing unless selected', async () => {
    await writeCodexConfig({
      notifications: {
        enabled: true,
        custom_cli_command: { enabled: true, command: 'echo test' },
        openclaw: {
          enabled: true,
          gateways: { g: { type: 'command', command: 'echo hi' } },
          hooks: { 'session-end': { enabled: true, gateway: 'g', instruction: 'i' } },
        },
      },
    });
    process.env.OMX_OPENCLAW = '1';
    process.env.OMX_NOTIFY_TEMP_CONTRACT = JSON.stringify({
      active: true,
      selectors: ['discord'],
      canonicalSelectors: ['discord'],
      warnings: [],
      source: 'cli',
    });

    const config = await getNotificationConfigFresh();
    assert.ok(config);
    assert.equal(config.openclaw, undefined);
    assert.equal(config.custom_cli_command, undefined);
  });

  it('temp mode strips unselected event-level transport overrides while keeping event policy', async () => {
    await writeCodexConfig({
      notifications: {
        enabled: true,
        telegram: { enabled: true, botToken: 'telegram-token', chatId: 'telegram-chat' },
        slack: { enabled: true, webhookUrl: 'https://hooks.slack.com/services/file' },
        events: {
          'result-ready': {
            enabled: true,
            telegram: { enabled: true, botToken: 'telegram-token', chatId: 'telegram-chat' },
            slack: { enabled: true, webhookUrl: 'https://hooks.slack.com/services/override' },
          },
        },
      },
    });
    process.env.OMX_NOTIFY_TEMP_CONTRACT = JSON.stringify({
      active: true,
      selectors: ['telegram'],
      canonicalSelectors: ['telegram'],
      warnings: [],
      source: 'cli',
    });

    const config = await getNotificationConfigFresh();
    assert.ok(config);
    assert.equal(config.telegram?.enabled, true);
    assert.equal(config.slack, undefined);
    assert.equal(config.events?.['result-ready']?.enabled, true);
    assert.equal(config.events?.['result-ready']?.telegram?.enabled, true);
    assert.equal(config.events?.['result-ready']?.slack, undefined);
  });

  it('temp mode keeps env-supplied credentials for a selected transport even when the profile comes from file config', async () => {
    await writeCodexConfig({
      notifications: {
        enabled: true,
        defaultProfile: 'meaningful',
        profiles: {
          meaningful: {
            enabled: true,
            verbosity: 'session',
            events: {
              'result-ready': { enabled: true },
              'ask-user-question': { enabled: true },
            },
          },
        },
      },
    });
    process.env.OMX_NOTIFY_PROFILE = 'meaningful';
    process.env.OMX_TELEGRAM_BOT_TOKEN = 'env-telegram-token';
    process.env.OMX_TELEGRAM_CHAT_ID = 'env-telegram-chat';
    process.env.OMX_NOTIFY_TEMP_CONTRACT = JSON.stringify({
      active: true,
      selectors: ['telegram'],
      canonicalSelectors: ['telegram'],
      warnings: [],
      source: 'cli',
    });

    const config = await getNotificationConfigFresh();
    assert.ok(config);
    assert.equal(config.telegram?.enabled, true);
    assert.equal(config.telegram?.botToken, 'env-telegram-token');
    assert.equal(config.telegram?.chatId, 'env-telegram-chat');
    assert.equal(config.events?.['result-ready']?.enabled, true);
  });

  it('temp mode applies meaningful telegram defaults when no explicit event policy exists', async () => {
    await writeCodexConfig({
      notifications: {
        enabled: true,
        verbosity: 'session',
      },
    });
    process.env.OMX_TELEGRAM_BOT_TOKEN = 'env-telegram-token';
    process.env.OMX_TELEGRAM_CHAT_ID = 'env-telegram-chat';
    process.env.OMX_NOTIFY_TEMP_CONTRACT = JSON.stringify({
      active: true,
      selectors: ['telegram'],
      canonicalSelectors: ['telegram'],
      warnings: [],
      source: 'cli',
    });

    const config = await getNotificationConfigFresh();
    assert.ok(config);
    assert.equal(config.telegram?.enabled, true);
    assert.equal(config.events?.['session-start']?.enabled, false);
    assert.equal(config.events?.['session-stop']?.enabled, false);
    assert.equal(config.events?.['session-idle']?.enabled, false);
    assert.equal(config.events?.['result-ready']?.enabled, true);
    assert.equal(config.events?.['ask-user-question']?.enabled, true);
    assert.equal(config.events?.['session-end']?.enabled, true);
  });

  it('temp mode enables openclaw config only when explicitly selected', async () => {
    process.env.OMX_OPENCLAW = '1';
    process.env.OMX_NOTIFY_TEMP_CONTRACT = JSON.stringify({
      active: true,
      selectors: ['openclaw:gateway-main'],
      canonicalSelectors: ['openclaw:gateway-main'],
      warnings: [],
      source: 'providers',
    });

    const config = await getNotificationConfigFresh();
    assert.ok(config);
    assert.equal(config.openclaw?.enabled, true);
    assert.equal(config.enabled, true);
  });

  it('shouldDispatchOpenClaw enforces temp-mode explicit selection and gateway matching', async () => {
    process.env.OMX_OPENCLAW = '1';
    await writeCodexConfig({
      notifications: {
        enabled: true,
        openclaw: {
          enabled: true,
          gateways: { g1: { type: 'command', command: 'echo hi' } },
          hooks: { 'session-end': { enabled: true, gateway: 'g1', instruction: 'i' } },
        },
      },
    });

    const activeNoOpenClaw = {
      active: true,
      selectors: ['discord'],
      canonicalSelectors: ['discord'],
      warnings: [],
      source: 'cli' as const,
    };
    const activeWithOpenClaw = {
      active: true,
      selectors: ['openclaw:g1'],
      canonicalSelectors: ['openclaw:g1'],
      warnings: [],
      source: 'cli' as const,
    };

    const activeWithCustomGateway = {
      active: true,
      selectors: ['custom:g1'],
      canonicalSelectors: ['custom:g1'],
      warnings: [],
      source: 'cli' as const,
    };

    const activeWithWrongGateway = {
      active: true,
      selectors: ['custom:other'],
      canonicalSelectors: ['custom:other'],
      warnings: [],
      source: 'cli' as const,
    };

    assert.equal(
      await shouldDispatchOpenClaw('session-end', activeNoOpenClaw, process.env),
      false,
    );
    assert.equal(
      await shouldDispatchOpenClaw('session-end', activeWithOpenClaw, process.env),
      true,
    );
    assert.equal(
      await shouldDispatchOpenClaw('session-end', activeWithCustomGateway, process.env),
      true,
    );
    assert.equal(
      await shouldDispatchOpenClaw('session-end', activeWithWrongGateway, process.env),
      false,
    );
    assert.equal(
      await shouldDispatchOpenClaw('session-end', null, process.env),
      true,
    );
    assert.equal(
      await shouldDispatchOpenClaw('session-end', activeWithOpenClaw, { OMX_OPENCLAW: '0', CODEX_HOME: tempCodexHome }),
      false,
    );
  });
});
