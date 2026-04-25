import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasInstalledMockTelegramTransport,
  isLiveNotificationEnvKey,
  sanitizeLiveNotificationEnv,
  shouldBlockLiveNotificationNetworkInTests,
} from '../test-env.js';

describe('test environment hardening', () => {
  it('removes live notification credentials and config roots from inherited env', () => {
    const sanitized = sanitizeLiveNotificationEnv({
      PATH: '/usr/bin',
      HOME: '/real-home',
      CODEX_HOME: '/real-codex-home',
      OMX_TELEGRAM_BOT_TOKEN: '123456:real-token',
      OMX_TELEGRAM_CHAT_ID: '777',
      OMX_TELEGRAM_CAPTURE_PATH: '/tmp/capture',
      OMX_DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/live',
      OMX_SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/live',
      OMX_REPLY_ENABLED: 'true',
      OMX_NOTIFY_PROFILE: 'live',
      OMX_TEST_MOCK_TELEGRAM_TRANSPORT: '1',
    });

    assert.equal(sanitized.PATH, '/usr/bin');
    assert.equal(sanitized.HOME, '/real-home');
    assert.equal(sanitized.CODEX_HOME, undefined);
    assert.equal(sanitized.OMX_TELEGRAM_BOT_TOKEN, undefined);
    assert.equal(sanitized.OMX_TELEGRAM_CHAT_ID, undefined);
    assert.equal(sanitized.OMX_TELEGRAM_CAPTURE_PATH, undefined);
    assert.equal(sanitized.OMX_DISCORD_WEBHOOK_URL, undefined);
    assert.equal(sanitized.OMX_SLACK_WEBHOOK_URL, undefined);
    assert.equal(sanitized.OMX_REPLY_ENABLED, undefined);
    assert.equal(sanitized.OMX_NOTIFY_PROFILE, undefined);
    assert.equal(sanitized.OMX_TEST_MOCK_TELEGRAM_TRANSPORT, undefined);
    assert.equal(sanitized.OMX_TEST_DISABLE_LIVE_NOTIFICATIONS, '1');
    assert.equal(sanitized.OMX_TEST_SANITIZED_LIVE_NOTIFICATIONS, '1');
  });

  it('identifies notification env keys that can enable live transports', () => {
    assert.equal(isLiveNotificationEnvKey('OMX_TELEGRAM_BOT_TOKEN'), true);
    assert.equal(isLiveNotificationEnvKey('OMX_DISCORD_NOTIFIER_BOT_TOKEN'), true);
    assert.equal(isLiveNotificationEnvKey('OMX_SLACK_WEBHOOK_URL'), true);
    assert.equal(isLiveNotificationEnvKey('OMX_REPLY_ENABLED'), true);
    assert.equal(isLiveNotificationEnvKey('CODEX_HOME'), true);
    assert.equal(isLiveNotificationEnvKey('PATH'), false);
  });

  it('blocks live notification network paths under node:test or sanitized test env', () => {
    assert.equal(shouldBlockLiveNotificationNetworkInTests({ NODE_TEST_CONTEXT: 'child-v8' }), true);
    assert.equal(shouldBlockLiveNotificationNetworkInTests({ OMX_TEST_DISABLE_LIVE_NOTIFICATIONS: '1' }), true);
    assert.equal(shouldBlockLiveNotificationNetworkInTests({}), false);
  });

  it('only treats Telegram capture as safe when the mock transport marker is installed', () => {
    const globals = globalThis as { __OMX_TEST_MOCK_TELEGRAM_TRANSPORT__?: unknown };
    const previous = globals.__OMX_TEST_MOCK_TELEGRAM_TRANSPORT__;
    try {
      globals.__OMX_TEST_MOCK_TELEGRAM_TRANSPORT__ = undefined;
      assert.equal(hasInstalledMockTelegramTransport({
        OMX_TEST_MOCK_TELEGRAM_TRANSPORT: '1',
        OMX_TELEGRAM_CAPTURE_PATH: '/tmp/capture',
      }), false);
      assert.equal(shouldBlockLiveNotificationNetworkInTests({
        OMX_TEST_DISABLE_LIVE_NOTIFICATIONS: '1',
        OMX_TEST_MOCK_TELEGRAM_TRANSPORT: '1',
        OMX_TELEGRAM_CAPTURE_PATH: '/tmp/capture',
      }), true);

      globals.__OMX_TEST_MOCK_TELEGRAM_TRANSPORT__ = 'https-request-capture';
      assert.equal(hasInstalledMockTelegramTransport({
        OMX_TEST_MOCK_TELEGRAM_TRANSPORT: '1',
        OMX_TELEGRAM_CAPTURE_PATH: '/tmp/capture',
      }), true);
      assert.equal(shouldBlockLiveNotificationNetworkInTests({
        OMX_TEST_DISABLE_LIVE_NOTIFICATIONS: '1',
        OMX_TEST_MOCK_TELEGRAM_TRANSPORT: '1',
        OMX_TELEGRAM_CAPTURE_PATH: '/tmp/capture',
      }), false);
    } finally {
      if (previous === undefined) {
        delete globals.__OMX_TEST_MOCK_TELEGRAM_TRANSPORT__;
      } else {
        globals.__OMX_TEST_MOCK_TELEGRAM_TRANSPORT__ = previous;
      }
    }
  });
});
