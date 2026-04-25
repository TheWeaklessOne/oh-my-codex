/**
 * Notification Dispatcher
 *
 * Sends notifications to configured platforms (Discord, Telegram, Slack, webhook).
 * All sends are non-blocking with timeouts. Failures are swallowed to avoid
 * blocking hooks.
 */

import type {
  DiscordNotificationConfig,
  DiscordBotNotificationConfig,
  TelegramNotificationConfig,
  SlackNotificationConfig,
  WebhookNotificationConfig,
  FullNotificationPayload,
  NotificationResult,
  NotificationPlatform,
  NotificationTransportOverride,
  DispatchResult,
  FullNotificationConfig,
  NotificationEvent,
} from "./types.js";

import { parseMentionAllowedMentions } from "./config.js";
import {
  coerceTelegramMessageThreadId,
  normalizeTelegramProjectIdentity,
  performTelegramBotApiRequest,
  resolveTelegramDestination,
  type TelegramResolvedDestination,
  type TelegramTopicResolutionDeps,
} from "./telegram-topics.js";
import { updateTelegramTopicRegistryRecord } from "./telegram-topic-registry.js";
import { shouldBlockLiveNotificationNetworkInTests } from "../utils/test-env.js";

const SEND_TIMEOUT_MS = 10_000;
const DISPATCH_TIMEOUT_MS = 15_000;
const DISCORD_MAX_CONTENT_LENGTH = 2000;

function composeDiscordContent(
  message: string,
  mention: string | undefined,
): {
  content: string;
  allowed_mentions: { parse: string[]; users?: string[]; roles?: string[] };
} {
  const mentionParsed = parseMentionAllowedMentions(mention);
  const allowed_mentions = {
    parse: [] as string[],
    users: mentionParsed.users,
    roles: mentionParsed.roles,
  };

  let content: string;
  if (mention) {
    const prefix = `${mention}\n`;
    const maxBody = DISCORD_MAX_CONTENT_LENGTH - prefix.length;
    const body =
      message.length > maxBody
        ? message.slice(0, maxBody - 1) + "\u2026"
        : message;
    content = `${prefix}${body}`;
  } else {
    content =
      message.length > DISCORD_MAX_CONTENT_LENGTH
        ? message.slice(0, DISCORD_MAX_CONTENT_LENGTH - 1) + "\u2026"
        : message;
  }

  return { content, allowed_mentions };
}

function validateDiscordUrl(webhookUrl: string): boolean {
  try {
    const url = new URL(webhookUrl);
    const allowedHosts = ["discord.com", "discordapp.com"];
    if (
      !allowedHosts.some(
        (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
      )
    ) {
      return false;
    }
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

function validateTelegramToken(token: string): boolean {
  return /^[0-9]+:[A-Za-z0-9_-]+$/.test(token);
}

function validateSlackUrl(webhookUrl: string): boolean {
  try {
    const url = new URL(webhookUrl);
    return (
      url.protocol === "https:" &&
      (url.hostname === "hooks.slack.com" ||
        url.hostname.endsWith(".hooks.slack.com"))
    );
  } catch {
    return false;
  }
}

function validateWebhookUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function mergeTelegramPlatformOverrides(
  topLevelPlatform: Record<string, unknown>,
  eventPlatform: Record<string, unknown>,
): Record<string, unknown> {
  const merged = {
    ...topLevelPlatform,
    ...eventPlatform,
  };

  if (
    isPlainRecord(topLevelPlatform.projectTopics)
    && isPlainRecord(eventPlatform.projectTopics)
  ) {
    merged.projectTopics = {
      ...topLevelPlatform.projectTopics,
      ...eventPlatform.projectTopics,
    };
  }

  return merged;
}

function getTransportOverride(
  payload: FullNotificationPayload,
  platform: NotificationPlatform,
): NotificationTransportOverride | undefined {
  return payload.transportOverrides?.[platform];
}

function resolveTransportPayload(
  payload: FullNotificationPayload,
  platform: NotificationPlatform,
): FullNotificationPayload {
  const override = getTransportOverride(payload, platform);
  if (!override?.message) {
    return payload;
  }

  return {
    ...payload,
    message: override.message,
  };
}

export async function sendDiscord(
  config: DiscordNotificationConfig,
  payload: FullNotificationPayload,
): Promise<NotificationResult> {
  if (!config.enabled || !config.webhookUrl) {
    return { platform: "discord", success: false, error: "Not configured" };
  }

  if (!validateDiscordUrl(config.webhookUrl)) {
    return {
      platform: "discord",
      success: false,
      error: "Invalid webhook URL",
    };
  }

  try {
    const message = getTransportOverride(payload, "discord")?.message ?? payload.message;
    const { content, allowed_mentions } = composeDiscordContent(
      message,
      config.mention,
    );
    const body: Record<string, unknown> = { content, allowed_mentions };
    if (config.username) {
      body.username = config.username;
    }

    const response = await fetch(config.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });

    if (!response.ok) {
      return {
        platform: "discord",
        success: false,
        error: `HTTP ${response.status}`,
      };
    }

    return { platform: "discord", success: true };
  } catch (error) {
    return {
      platform: "discord",
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

export async function sendDiscordBot(
  config: DiscordBotNotificationConfig,
  payload: FullNotificationPayload,
): Promise<NotificationResult> {
  if (!config.enabled) {
    return { platform: "discord-bot", success: false, error: "Not enabled" };
  }

  const botToken = config.botToken;
  const channelId = config.channelId;

  if (!botToken || !channelId) {
    return {
      platform: "discord-bot",
      success: false,
      error: "Missing botToken or channelId",
    };
  }

  try {
    const message = getTransportOverride(payload, "discord-bot")?.message ?? payload.message;
    const { content, allowed_mentions } = composeDiscordContent(
      message,
      config.mention,
    );
    const url = `https://discord.com/api/v10/channels/${channelId}/messages`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bot ${botToken}`,
      },
      body: JSON.stringify({ content, allowed_mentions }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });

    if (!response.ok) {
      return {
        platform: "discord-bot",
        success: false,
        error: `HTTP ${response.status}`,
      };
    }

    let messageId: string | undefined;
    try {
      const data = (await response.json()) as { id?: string };
      messageId = data?.id;
    } catch {
      // Non-fatal
    }

    return { platform: "discord-bot", success: true, messageId };
  } catch (error) {
    return {
      platform: "discord-bot",
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

export async function sendTelegram(
  config: TelegramNotificationConfig,
  payload: FullNotificationPayload,
  deps: (TelegramTopicResolutionDeps & {
    resolveTelegramDestinationImpl?: typeof resolveTelegramDestination;
  }) = {},
): Promise<NotificationResult> {
  if (!config.enabled || !config.botToken || !config.chatId) {
    return { platform: "telegram", success: false, error: "Not configured" };
  }

  if (!validateTelegramToken(config.botToken)) {
    return {
      platform: "telegram",
      success: false,
      error: "Invalid bot token format",
    };
  }

  if (
    shouldBlockLiveNotificationNetworkInTests(process.env, deps.httpsRequestImpl)
  ) {
    return {
      platform: "telegram",
      success: false,
      error: "Live Telegram sends are disabled while running tests",
    };
  }

  let destination: TelegramResolvedDestination | null = null;

  try {
    const resolveTelegramDestinationImpl =
      deps.resolveTelegramDestinationImpl ?? resolveTelegramDestination;
    destination = await resolveTelegramDestinationImpl(config, payload, deps);
    if (destination.skipSend) {
      return {
        platform: "telegram",
        success: false,
        error:
          destination.warningMessage
          || "Telegram topic routing is unavailable and fallbackToGeneral is disabled",
        projectKey: destination.projectKey,
        topicName: destination.topicName,
      };
    }

    const result = await performTelegramBotApiRequest<{
      message_id?: number | string;
      message_thread_id?: number | string;
    }>(
      config.botToken,
      "sendMessage",
      {
        ...(() => {
          const transportOverride = getTransportOverride(payload, "telegram");
          const effectiveParseMode =
            Object.prototype.hasOwnProperty.call(transportOverride ?? {}, "parseMode")
              ? transportOverride?.parseMode
              : (config.parseMode ?? "Markdown");
          return effectiveParseMode ? { parse_mode: effectiveParseMode } : {};
        })(),
        chat_id: destination.chatId,
        text: getTransportOverride(payload, "telegram")?.message ?? payload.message,
        ...(destination.messageThreadId
            ? {
                message_thread_id: coerceTelegramMessageThreadId(
                  destination.messageThreadId,
                ),
              }
            : {}),
      },
      {
        ...(deps.httpsRequestImpl ? { httpsRequestImpl: deps.httpsRequestImpl } : {}),
        timeoutMs: deps.timeoutMs ?? SEND_TIMEOUT_MS,
      },
    );

    const messageId =
      result?.message_id !== undefined ? String(result.message_id) : undefined;
    const messageThreadId =
      destination.messageThreadId
      ?? (result?.message_thread_id !== undefined
        ? String(result.message_thread_id)
        : undefined);

    await persistTelegramDestinationMappingBestEffort(
      config,
      payload,
      destination,
      messageThreadId,
    );

    return {
      platform: "telegram",
      success: true,
      messageId,
      messageThreadId,
      projectKey: destination.projectKey,
      topicName: destination.topicName,
    };
  } catch (error) {
    await persistTelegramDestinationMappingBestEffort(
      config,
      payload,
      destination,
      destination?.messageThreadId,
    );
    return {
      platform: "telegram",
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

export async function sendSlack(
  config: SlackNotificationConfig,
  payload: FullNotificationPayload,
): Promise<NotificationResult> {
  if (!config.enabled || !config.webhookUrl) {
    return { platform: "slack", success: false, error: "Not configured" };
  }

  if (!validateSlackUrl(config.webhookUrl)) {
    return { platform: "slack", success: false, error: "Invalid webhook URL" };
  }

  try {
    const message = getTransportOverride(payload, "slack")?.message ?? payload.message;
    const body: Record<string, unknown> = { text: message };
    if (config.channel) {
      body.channel = config.channel;
    }
    if (config.username) {
      body.username = config.username;
    }

    const response = await fetch(config.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });

    if (!response.ok) {
      return {
        platform: "slack",
        success: false,
        error: `HTTP ${response.status}`,
      };
    }

    return { platform: "slack", success: true };
  } catch (error) {
    return {
      platform: "slack",
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

export async function sendWebhook(
  config: WebhookNotificationConfig,
  payload: FullNotificationPayload,
): Promise<NotificationResult> {
  if (!config.enabled || !config.url) {
    return { platform: "webhook", success: false, error: "Not configured" };
  }

  if (!validateWebhookUrl(config.url)) {
    return {
      platform: "webhook",
      success: false,
      error: "Invalid URL (HTTPS required)",
    };
  }

  try {
    const message = getTransportOverride(payload, "webhook")?.message ?? payload.message;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...config.headers,
    };

    const response = await fetch(config.url, {
      method: config.method || "POST",
      headers,
      body: JSON.stringify({
        event: payload.event,
        session_id: payload.sessionId,
        message,
        timestamp: payload.timestamp,
        tmux_session: payload.tmuxSession,
        project_name: payload.projectName,
        project_path: payload.projectPath,
        modes_used: payload.modesUsed,
        duration_ms: payload.durationMs,
        reason: payload.reason,
        active_mode: payload.activeMode,
        question: payload.question,
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });

    if (!response.ok) {
      return {
        platform: "webhook",
        success: false,
        error: `HTTP ${response.status}`,
      };
    }

    return { platform: "webhook", success: true };
  } catch (error) {
    return {
      platform: "webhook",
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function persistTelegramDestinationMappingBestEffort(
  config: TelegramNotificationConfig,
  payload: FullNotificationPayload,
  destination: TelegramResolvedDestination | null,
  messageThreadId: string | undefined,
): Promise<void> {
  if (config.projectTopics?.enabled !== true) {
    return;
  }

  if (!destination?.sourceChatKey || !destination.projectKey || !messageThreadId) {
    return;
  }

  const identity = normalizeTelegramProjectIdentity(payload);
  if (!identity || identity.projectKey !== destination.projectKey) {
    return;
  }

  const nowIso = new Date().toISOString();

  try {
    await updateTelegramTopicRegistryRecord(
      destination.sourceChatKey,
      destination.projectKey,
      (record) => ({
        ...record,
        sourceChatKey: destination.sourceChatKey,
        projectKey: destination.projectKey!,
        canonicalProjectPath: identity.canonicalProjectPath,
        displayName: identity.displayName,
        topicName: destination.topicName || record?.topicName || identity.displayName,
        messageThreadId,
        createdAt: record?.createdAt || nowIso,
        lastUsedAt: nowIso,
        lastCreateAttemptAt: record?.lastCreateAttemptAt || nowIso,
        lastCreateFailureAt: undefined,
        lastCreateFailureCode: undefined,
        lastCreateFailureMessage: undefined,
        createFailureCooldownUntil: undefined,
      }),
    );
  } catch (error) {
    console.warn("[notifications] telegram topic registry persistence warning", {
      warningCode: "topic-registry-persist-after-send-failed",
      sourceChatKey: destination.sourceChatKey,
      projectKey: destination.projectKey,
      canonicalProjectPath: identity.canonicalProjectPath,
      messageThreadId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function getEffectivePlatformConfig<T>(
  platform: NotificationPlatform,
  config: FullNotificationConfig,
  event: NotificationEvent,
): T | undefined {
  const eventConfig = config.events?.[event];
  const eventPlatform = eventConfig?.[platform as keyof typeof eventConfig];
  const topLevelPlatform = config[platform as keyof FullNotificationConfig];

  if (
    eventPlatform &&
    typeof eventPlatform === "object" &&
    "enabled" in eventPlatform
  ) {
    if (
      topLevelPlatform &&
      typeof topLevelPlatform === "object" &&
      "enabled" in topLevelPlatform
    ) {
      const topLevelRecord = topLevelPlatform as unknown as Record<string, unknown>;
      const eventRecord = eventPlatform as unknown as Record<string, unknown>;
      return (
        platform === "telegram"
          ? mergeTelegramPlatformOverrides(topLevelRecord, eventRecord)
          : {
              ...topLevelRecord,
              ...eventRecord,
            }
      ) as T;
    }

    return eventPlatform as T;
  }

  return topLevelPlatform as T | undefined;
}

export async function dispatchNotifications(
  config: FullNotificationConfig,
  event: NotificationEvent,
  payload: FullNotificationPayload,
): Promise<DispatchResult> {
  const promises: Promise<NotificationResult>[] = [];

  const discordConfig = getEffectivePlatformConfig<DiscordNotificationConfig>(
    "discord",
    config,
    event,
  );
  if (discordConfig?.enabled) {
    promises.push(sendDiscord(discordConfig, resolveTransportPayload(payload, "discord")));
  }

  const telegramConfig = getEffectivePlatformConfig<TelegramNotificationConfig>(
    "telegram",
    config,
    event,
  );
  if (telegramConfig?.enabled) {
    promises.push(sendTelegram(telegramConfig, resolveTransportPayload(payload, "telegram")));
  }

  const slackConfig = getEffectivePlatformConfig<SlackNotificationConfig>(
    "slack",
    config,
    event,
  );
  if (slackConfig?.enabled) {
    promises.push(sendSlack(slackConfig, resolveTransportPayload(payload, "slack")));
  }

  const webhookConfig = getEffectivePlatformConfig<WebhookNotificationConfig>(
    "webhook",
    config,
    event,
  );
  if (webhookConfig?.enabled) {
    promises.push(sendWebhook(webhookConfig, resolveTransportPayload(payload, "webhook")));
  }

  const discordBotConfig =
    getEffectivePlatformConfig<DiscordBotNotificationConfig>(
      "discord-bot",
      config,
      event,
    );
  if (discordBotConfig?.enabled) {
    promises.push(sendDiscordBot(discordBotConfig, resolveTransportPayload(payload, "discord-bot")));
  }

  if (promises.length === 0) {
    return { event, results: [], anySuccess: false };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const results = await Promise.race([
      Promise.allSettled(promises).then((settled) =>
        settled.map((s) =>
          s.status === "fulfilled"
            ? s.value
            : {
                platform: "unknown" as NotificationPlatform,
                success: false,
                error: String(s.reason),
              },
        ),
      ),
      new Promise<NotificationResult[]>((resolve) => {
        timer = setTimeout(
          () =>
            resolve([
              {
                platform: "unknown" as NotificationPlatform,
                success: false,
                error: "Dispatch timeout",
              },
            ]),
          DISPATCH_TIMEOUT_MS,
        );
      }),
    ]);

    if (timer) clearTimeout(timer);

    return {
      event,
      results,
      anySuccess: results.some((r) => r.success),
    };
  } catch (error) {
    if (timer) clearTimeout(timer);
    return {
      event,
      results: [
        {
          platform: "unknown" as NotificationPlatform,
          success: false,
          error: String(error),
        },
      ],
      anySuccess: false,
    };
  }
}
