import {
  getReplyListenerStatus,
  type ReplyListenerStatusDiagnostics,
} from '../notifications/reply-listener.js';

interface ReplyListenerLiveConfig {
  discordBotToken: string;
  discordChannelId: string;
  telegramBotToken: string;
  telegramChatId: string;
  expectations?: {
    ackMode: 'off' | 'minimal' | 'summary';
    telegramPollTimeoutSeconds: number;
    telegramAllowedUpdates: string[];
    telegramStartupBacklogPolicy: 'resume' | 'drop_pending' | 'replay_once';
    authorizedTelegramUserIdsConfigured: boolean;
  };
}

interface ReplyListenerLiveEnvResolution {
  enabled: boolean;
  missing: string[];
  config: ReplyListenerLiveConfig | null;
}

interface ReplyListenerLiveSmokeResult {
  discordMessageId: string;
  telegramMessageId: string;
  replyListenerStatus: ReplyListenerLiveStatusSummary | null;
}

interface ReplyListenerLiveSmokeDeps {
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
  readReplyListenerStatusImpl?: typeof getReplyListenerStatus;
}

export interface ReplyListenerLiveStatusSummary {
  ackMode: 'off' | 'minimal' | 'summary';
  telegramPollTimeoutSeconds: number;
  telegramAllowedUpdates: string[];
  telegramStartupBacklogPolicy: 'resume' | 'drop_pending' | 'replay_once';
  authorizedTelegramUserIdsConfigured: boolean;
  activeSourceKeys: string[];
  secretStorage: string;
}

const LIVE_ENABLE_ENV = 'OMX_REPLY_LISTENER_LIVE';
const REQUIRED_ENV_KEYS = [
  'OMX_DISCORD_NOTIFIER_BOT_TOKEN',
  'OMX_DISCORD_NOTIFIER_CHANNEL',
  'OMX_TELEGRAM_BOT_TOKEN',
  'OMX_TELEGRAM_CHAT_ID',
] as const;
const DEFAULT_EXPECTATIONS = {
  ackMode: 'minimal' as const,
  telegramPollTimeoutSeconds: 30,
  telegramAllowedUpdates: ['message'],
  telegramStartupBacklogPolicy: 'resume' as const,
};

function parseAckMode(value: string | undefined): 'off' | 'minimal' | 'summary' {
  return value === 'off' || value === 'summary' || value === 'minimal'
    ? value
    : DEFAULT_EXPECTATIONS.ackMode;
}

function parseTelegramStartupBacklogPolicy(
  value: string | undefined,
): 'resume' | 'drop_pending' | 'replay_once' {
  return value === 'drop_pending' || value === 'replay_once' || value === 'resume'
    ? value
    : DEFAULT_EXPECTATIONS.telegramStartupBacklogPolicy;
}

function parseAllowedUpdates(value: string | undefined): string[] {
  if (!value) {
    return [...DEFAULT_EXPECTATIONS.telegramAllowedUpdates];
  }
  const updates = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return updates.length > 0 ? updates : [...DEFAULT_EXPECTATIONS.telegramAllowedUpdates];
}

function requireJsonObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} returned a non-object JSON payload`);
  }
  return value as Record<string, unknown>;
}

async function parseResponseJson(response: Response, label: string): Promise<Record<string, unknown>> {
  const body = await response.json() as unknown;
  return requireJsonObject(body, label);
}

export function resolveReplyListenerLiveEnv(env: NodeJS.ProcessEnv = process.env): ReplyListenerLiveEnvResolution {
  const enabled = env[LIVE_ENABLE_ENV] === '1';
  if (!enabled) {
    return { enabled: false, missing: [], config: null };
  }

  const missing = REQUIRED_ENV_KEYS.filter((key) => {
    const value = env[key];
    return typeof value !== 'string' || value.trim().length === 0;
  });
  if (missing.length > 0) {
    return { enabled: true, missing: [...missing], config: null };
  }

  return {
    enabled: true,
    missing: [],
    config: {
      discordBotToken: env.OMX_DISCORD_NOTIFIER_BOT_TOKEN!.trim(),
      discordChannelId: env.OMX_DISCORD_NOTIFIER_CHANNEL!.trim(),
      telegramBotToken: env.OMX_TELEGRAM_BOT_TOKEN!.trim(),
      telegramChatId: env.OMX_TELEGRAM_CHAT_ID!.trim(),
      expectations: {
        ackMode: parseAckMode(env.OMX_REPLY_ACK_MODE),
        telegramPollTimeoutSeconds: Number.parseInt(env.OMX_REPLY_TELEGRAM_POLL_TIMEOUT_SECONDS || '', 10) || DEFAULT_EXPECTATIONS.telegramPollTimeoutSeconds,
        telegramAllowedUpdates: parseAllowedUpdates(env.OMX_REPLY_TELEGRAM_ALLOWED_UPDATES),
        telegramStartupBacklogPolicy: parseTelegramStartupBacklogPolicy(env.OMX_REPLY_TELEGRAM_STARTUP_BACKLOG),
        authorizedTelegramUserIdsConfigured: Boolean(env.OMX_REPLY_TELEGRAM_USER_IDS?.trim()),
      },
    },
  };
}

export function inspectReplyListenerStatusForLiveSmoke(
  expectations: NonNullable<ReplyListenerLiveConfig['expectations']>,
  deps: {
    readReplyListenerStatusImpl?: typeof getReplyListenerStatus;
  } = {},
): ReplyListenerLiveStatusSummary {
  const readReplyListenerStatusImpl = deps.readReplyListenerStatusImpl ?? getReplyListenerStatus;
  const status = readReplyListenerStatusImpl();
  const diagnostics = status.diagnostics as ReplyListenerStatusDiagnostics | undefined;
  if (!diagnostics) {
    throw new Error('Reply listener status diagnostics are unavailable; start the daemon before running live smoke.');
  }

  if (diagnostics.ackMode !== expectations.ackMode) {
    throw new Error(`Reply listener ackMode mismatch: expected ${expectations.ackMode}, got ${diagnostics.ackMode}`);
  }
  if (diagnostics.telegramPollTimeoutSeconds !== expectations.telegramPollTimeoutSeconds) {
    throw new Error(
      `Reply listener telegramPollTimeoutSeconds mismatch: expected ${expectations.telegramPollTimeoutSeconds}, got ${diagnostics.telegramPollTimeoutSeconds}`,
    );
  }
  if (diagnostics.telegramStartupBacklogPolicy !== expectations.telegramStartupBacklogPolicy) {
    throw new Error(
      `Reply listener telegramStartupBacklogPolicy mismatch: expected ${expectations.telegramStartupBacklogPolicy}, got ${diagnostics.telegramStartupBacklogPolicy}`,
    );
  }
  if (diagnostics.authorizedTelegramUserIdsConfigured !== expectations.authorizedTelegramUserIdsConfigured) {
    throw new Error(
      `Reply listener authorizedTelegramUserIdsConfigured mismatch: expected ${expectations.authorizedTelegramUserIdsConfigured}, got ${diagnostics.authorizedTelegramUserIdsConfigured}`,
    );
  }

  const normalizedAllowedUpdates = [...diagnostics.telegramAllowedUpdates].sort();
  const expectedAllowedUpdates = [...expectations.telegramAllowedUpdates].sort();
  if (normalizedAllowedUpdates.join('\u0000') !== expectedAllowedUpdates.join('\u0000')) {
    throw new Error(
      `Reply listener telegramAllowedUpdates mismatch: expected ${expectedAllowedUpdates.join(',')}, got ${normalizedAllowedUpdates.join(',')}`,
    );
  }

  return {
    ackMode: diagnostics.ackMode,
    telegramPollTimeoutSeconds: diagnostics.telegramPollTimeoutSeconds ?? expectations.telegramPollTimeoutSeconds,
    telegramAllowedUpdates: [...diagnostics.telegramAllowedUpdates],
    telegramStartupBacklogPolicy: diagnostics.telegramStartupBacklogPolicy ?? expectations.telegramStartupBacklogPolicy,
    authorizedTelegramUserIdsConfigured: diagnostics.authorizedTelegramUserIdsConfigured,
    activeSourceKeys: diagnostics.activeSources.map((source) => source.key),
    secretStorage: diagnostics.secretStorage,
  };
}

export async function runReplyListenerLiveSmoke(
  config: ReplyListenerLiveConfig,
  deps: ReplyListenerLiveSmokeDeps = {},
): Promise<ReplyListenerLiveSmokeResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const log = deps.log ?? console.log;
  const readReplyListenerStatusImpl = deps.readReplyListenerStatusImpl ?? getReplyListenerStatus;
  const stamp = new Date().toISOString();
  const replyListenerStatus = config.expectations
    ? inspectReplyListenerStatusForLiveSmoke(config.expectations, { readReplyListenerStatusImpl })
    : null;

  if (config.expectations) {
    log(
      `Reply listener expectations: ack=${config.expectations.ackMode}, ` +
      `telegram_timeout=${config.expectations.telegramPollTimeoutSeconds}s, ` +
      `allowed_updates=${config.expectations.telegramAllowedUpdates.join('|')}, ` +
      `backlog=${config.expectations.telegramStartupBacklogPolicy}, ` +
      `telegram_sender_allowlist=${config.expectations.authorizedTelegramUserIdsConfigured ? 'configured' : 'chat-only-fallback'}`
    );
    log(
      `Reply listener status verified: sources=${replyListenerStatus?.activeSourceKeys.join(',') || 'none'}, ` +
      `secrets=${replyListenerStatus?.secretStorage || 'unknown'}`,
    );
  }

  const discordSendResponse = await fetchImpl(
    `https://discord.com/api/v10/channels/${config.discordChannelId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bot ${config.discordBotToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: `[omx live smoke ${stamp}] reply-listener Discord connectivity probe`,
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!discordSendResponse.ok) {
    throw new Error(`Discord live smoke failed: HTTP ${discordSendResponse.status}`);
  }
  const discordPayload = await parseResponseJson(discordSendResponse, 'Discord sendMessage');
  const discordMessageId = typeof discordPayload.id === 'string' && discordPayload.id.trim()
    ? discordPayload.id
    : null;
  if (!discordMessageId) {
    throw new Error('Discord live smoke failed: missing message id');
  }
  log(`Discord probe message sent: ${discordMessageId}`);

  try {
    await fetchImpl(
      `https://discord.com/api/v10/channels/${config.discordChannelId}/messages/${discordMessageId}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bot ${config.discordBotToken}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch {
    log(`Discord probe cleanup skipped for ${discordMessageId}`);
  }

  const telegramSendResponse = await fetchImpl(
    `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.telegramChatId,
        text: `[omx live smoke ${stamp}] reply-listener Telegram connectivity probe`,
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!telegramSendResponse.ok) {
    throw new Error(`Telegram live smoke failed: HTTP ${telegramSendResponse.status}`);
  }
  const telegramPayload = await parseResponseJson(telegramSendResponse, 'Telegram sendMessage');
  const telegramResult = requireJsonObject(telegramPayload.result, 'Telegram sendMessage.result');
  const telegramMessageId = typeof telegramResult.message_id === 'number' || typeof telegramResult.message_id === 'string'
    ? String(telegramResult.message_id)
    : null;
  if (!telegramMessageId) {
    throw new Error('Telegram live smoke failed: missing message id');
  }
  log(`Telegram probe message sent: ${telegramMessageId}`);

  try {
    await fetchImpl(
      `https://api.telegram.org/bot${config.telegramBotToken}/deleteMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: config.telegramChatId,
          message_id: Number(telegramMessageId),
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch {
    log(`Telegram probe cleanup skipped for ${telegramMessageId}`);
  }

  return { discordMessageId, telegramMessageId, replyListenerStatus };
}

export async function main(): Promise<void> {
  const resolution = resolveReplyListenerLiveEnv();
  if (!resolution.enabled) {
    console.log(`reply-listener live smoke: SKIP (${LIVE_ENABLE_ENV}=1 to enable)`);
    return;
  }
  if (!resolution.config) {
    console.log(`reply-listener live smoke: SKIP (missing env: ${resolution.missing.join(', ')})`);
    return;
  }

  const result = await runReplyListenerLiveSmoke(resolution.config);
  console.log('reply-listener live smoke: PASS');
  console.log(`discord_message_id=${result.discordMessageId}`);
  console.log(`telegram_message_id=${result.telegramMessageId}`);
  if (result.replyListenerStatus) {
    console.log(`reply_listener_sources=${result.replyListenerStatus.activeSourceKeys.join(',')}`);
    console.log(`reply_listener_secrets=${result.replyListenerStatus.secretStorage}`);
  }
}

const isMain = process.argv[1]
  ? import.meta.url === new URL(`file://${process.argv[1]}`).href
  : false;

if (isMain) {
  main().catch((error) => {
    console.error(`reply-listener live smoke: FAIL\n${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
