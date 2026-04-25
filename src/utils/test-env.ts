/**
 * Test-process environment hardening.
 *
 * The test suite must never inherit a developer's live notification credentials
 * or a real CODEX_HOME that can contain live notification config. Unit tests may
 * install explicit dummy values or mock transports after startup, but parent
 * shell credentials must not leak into spawned test processes.
 */

const LIVE_NOTIFICATION_ENV_EXACT_KEYS = new Set([
  'CODEX_HOME',
  'OMX_NOTIFY_PROFILE',
  'OMX_NOTIFY_VERBOSITY',
  'OMX_OPENCLAW',
  'OMX_TEST_MOCK_TELEGRAM_TRANSPORT',
]);

const LIVE_NOTIFICATION_ENV_PREFIXES = [
  'OMX_DISCORD_',
  'OMX_OPENCLAW_',
  'OMX_REPLY_',
  'OMX_SLACK_',
  'OMX_TELEGRAM_',
  'OMX_NOTIFY_TEMP',
];

const MOCK_TELEGRAM_TRANSPORT_MARKER = 'https-request-capture';
const MOCK_TELEGRAM_TRANSPORT_PROPERTY = '__OMX_TEST_MOCK_TELEGRAM_TRANSPORT__';

export function isLiveNotificationEnvKey(key: string): boolean {
  return LIVE_NOTIFICATION_ENV_EXACT_KEYS.has(key)
    || LIVE_NOTIFICATION_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function sanitizeLiveNotificationEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || key === 'NODE_TEST_CONTEXT' || isLiveNotificationEnvKey(key)) {
      continue;
    }
    sanitized[key] = value;
  }

  sanitized.OMX_TEST_DISABLE_LIVE_NOTIFICATIONS = '1';
  sanitized.OMX_TEST_SANITIZED_LIVE_NOTIFICATIONS = '1';
  return sanitized;
}

export function isNodeTestContext(env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof env.NODE_TEST_CONTEXT === 'string' && env.NODE_TEST_CONTEXT.length > 0;
}

export function markMockTelegramTransportForTests<T extends object>(transport: T): T {
  Object.defineProperty(transport, MOCK_TELEGRAM_TRANSPORT_PROPERTY, {
    value: MOCK_TELEGRAM_TRANSPORT_MARKER,
    enumerable: false,
    configurable: true,
  });
  return transport;
}

export function isMarkedMockTelegramTransport(transport: unknown): boolean {
  return Boolean(
    transport
      && typeof transport === 'function'
      && (transport as unknown as Record<string, unknown>)[MOCK_TELEGRAM_TRANSPORT_PROPERTY]
        === MOCK_TELEGRAM_TRANSPORT_MARKER,
  );
}

export function hasInstalledMockTelegramTransport(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const globals = globalThis as { __OMX_TEST_MOCK_TELEGRAM_TRANSPORT__?: unknown };
  return env.OMX_TEST_MOCK_TELEGRAM_TRANSPORT === '1'
    && typeof env.OMX_TELEGRAM_CAPTURE_PATH === 'string'
    && env.OMX_TELEGRAM_CAPTURE_PATH.length > 0
    && globals.__OMX_TEST_MOCK_TELEGRAM_TRANSPORT__ === MOCK_TELEGRAM_TRANSPORT_MARKER;
}

export function shouldBlockLiveNotificationNetworkInTests(
  env: NodeJS.ProcessEnv = process.env,
  transport?: unknown,
): boolean {
  const isTestContext = env.OMX_TEST_DISABLE_LIVE_NOTIFICATIONS === '1' || isNodeTestContext(env);
  if (!isTestContext) {
    return false;
  }
  if (isMarkedMockTelegramTransport(transport) || hasInstalledMockTelegramTransport(env)) {
    return false;
  }
  return true;
}
