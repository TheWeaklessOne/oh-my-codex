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
  TelegramMessageEntity,
} from "./types.js";

import { parseMentionAllowedMentions } from "./config.js";
import {
  splitTelegramRenderedMessage,
  TELEGRAM_MESSAGE_MAX_LENGTH,
} from "./telegram-entities.js";
import {
  coerceTelegramMessageThreadId,
  normalizeTelegramProjectIdentity,
  performTelegramBotApiRequest,
  resolveTelegramDestination,
  type TelegramResolvedDestination,
  type TelegramTopicResolutionDeps,
} from "./telegram-topics.js";
import {
  classifyTelegramBotApiError,
  isTelegramDeliveryTopicMismatchError,
  isTelegramRichPayloadError,
  isTelegramStaleTopicError,
} from "./telegram-errors.js";
import { updateTelegramTopicRegistryRecord } from "./telegram-topic-registry.js";
import { deleteTelegramAcceptedAckBestEffort } from "./telegram-inbound/ack.js";
import { shouldBlockLiveNotificationNetworkInTests } from "../utils/test-env.js";

const SEND_TIMEOUT_MS = 10_000;
const DISPATCH_TIMEOUT_MS = 15_000;
const DISCORD_MAX_CONTENT_LENGTH = 2000;
const TELEGRAM_RENDER_DEBUG_ENV = "OMX_TELEGRAM_RENDER_DEBUG";

interface TelegramSendMessageResult {
  message_id?: number | string;
  message_thread_id?: number | string;
  is_topic_message?: boolean;
}

interface TelegramDestinationSendResult extends TelegramSendMessageResult {
  message_ids: Array<number | string>;
  chunkResults: TelegramSendMessageResult[];
}

interface TelegramPreparedMessageChunk {
  text: string;
  entities?: TelegramMessageEntity[];
}

interface TelegramPreparedMessage {
  chunks: TelegramPreparedMessageChunk[];
  rawFallbackChunks: TelegramPreparedMessageChunk[];
  parseMode?: "Markdown" | "HTML";
}

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
        statusCode: response.status,
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
        statusCode: response.status,
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

function telegramFailureResult(
  error: unknown,
  extra: Partial<NotificationResult> = {},
): NotificationResult {
  const classification = classifyTelegramBotApiError(error);
  return {
    platform: "telegram",
    success: false,
    error: error instanceof Error ? error.message : "Unknown error",
    ...(classification.statusCode !== undefined ? { statusCode: classification.statusCode } : {}),
    ...extra,
  };
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
  let refreshedStaleTopic = false;

  while (true) {
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
      if (refreshedStaleTopic && isUnsafeStaleTopicRetryDestination(destination)) {
        return {
          platform: "telegram",
          success: false,
          error:
            destination.warningMessage
            || "Telegram topic refresh did not produce a topic destination",
          projectKey: destination.projectKey,
          topicName: destination.topicName,
        };
      }

      const result = await sendTelegramMessageToDestination(
        config,
        payload,
        destination,
        deps,
      );

      const mismatchResult = findTelegramTopicDeliveryMismatch(
        destination,
        result.chunkResults,
      );
      if (mismatchResult) {
        const cleanupSucceeded = await deleteTelegramMessagesBestEffort(
          config,
          destination,
          result.chunkResults
            .map((chunkResult) => chunkResult.message_id)
            .filter((messageId): messageId is number | string => messageId !== undefined),
          deps,
        );
        if (
          !refreshedStaleTopic
          && shouldMarkStaleTelegramTopic(config, destination)
        ) {
          refreshedStaleTopic = true;
          await markTelegramTopicDestinationStaleBestEffort(
            payload,
            destination,
            "topic-delivery-mismatch",
            "Telegram accepted the cached topic id but returned a non-topic or different-topic message; refreshing the topic mapping.",
          );
          if (!cleanupSucceeded) {
            return {
              platform: "telegram",
              success: false,
              error: "Telegram topic delivery mismatch cleanup failed",
              projectKey: destination.projectKey,
              topicName: destination.topicName,
            };
          }
          if (!canRetryStaleTelegramTopic(config, destination)) {
            return {
              platform: "telegram",
              success: false,
              error: "Telegram topic delivery mismatch",
              projectKey: destination.projectKey,
              topicName: destination.topicName,
            };
          }
          continue;
        }
        return {
          platform: "telegram",
          success: false,
          error: "Telegram topic delivery mismatch",
          projectKey: destination.projectKey,
          topicName: destination.topicName,
        };
      }

      const messageId =
        result?.message_id !== undefined ? String(result.message_id) : undefined;
      const messageIds = result.message_ids.map((id) => String(id));
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
      if (payload.telegramAcceptedAck) {
        await deleteTelegramAcceptedAckBestEffort(
          { botToken: config.botToken },
          payload.telegramAcceptedAck,
          deps,
        );
      }

      return {
        platform: "telegram",
        success: true,
        messageId,
        ...(messageIds.length > 1 ? { messageIds } : {}),
        messageThreadId,
        projectKey: destination.projectKey,
        topicName: destination.topicName,
      };
    } catch (error) {
      const staleTopicError = isTelegramStaleTopicError(error);
      if (
        staleTopicError
        && destination
        && !refreshedStaleTopic
        && shouldMarkStaleTelegramTopic(config, destination)
      ) {
        refreshedStaleTopic = true;
        await markTelegramTopicDestinationStaleBestEffort(
          payload,
          destination,
          "topic-stale",
          error instanceof Error ? error.message : String(error),
        );
        if (!canRetryStaleTelegramTopic(config, destination)) {
          return telegramFailureResult(error, {
            projectKey: destination.projectKey,
            topicName: destination.topicName,
          });
        }
        continue;
      }

      const deliveryMismatchError = isTelegramDeliveryTopicMismatchError(error);
      if (
        deliveryMismatchError
        && destination
        && !refreshedStaleTopic
        && shouldMarkStaleTelegramTopic(config, destination)
      ) {
        refreshedStaleTopic = true;
        await markTelegramTopicDestinationStaleBestEffort(
          payload,
          destination,
          "topic-delivery-mismatch",
          error instanceof Error ? error.message : String(error),
        );
        if (!canRetryStaleTelegramTopic(config, destination)) {
          return telegramFailureResult(error, {
            projectKey: destination.projectKey,
            topicName: destination.topicName,
          });
        }
        continue;
      }

      if (!staleTopicError && !deliveryMismatchError) {
        await persistTelegramDestinationMappingBestEffort(
          config,
          payload,
          destination,
          destination?.messageThreadId,
        );
      }

      return telegramFailureResult(error);
    }
  }
}

async function sendTelegramMessageToDestination(
  config: TelegramNotificationConfig,
  payload: FullNotificationPayload,
  destination: TelegramResolvedDestination,
  deps: TelegramTopicResolutionDeps,
): Promise<TelegramDestinationSendResult> {
  const preparedMessage = prepareTelegramMessage(config, payload);
  const sendsRichPayload = Boolean(preparedMessage.parseMode)
    || preparedMessage.chunks.some((chunk) => chunk.entities?.length);

  try {
    return await sendPreparedTelegramChunks(
      config,
      preparedMessage,
      preparedMessage.chunks,
      destination,
      deps,
    );
  } catch (error) {
    if (!sendsRichPayload || !isTelegramRichPayloadError(error)) {
      throw error;
    }

    logTelegramRichFallbackIfEnabled(error, preparedMessage.rawFallbackChunks.length);
    return sendPreparedTelegramChunks(
      config,
      {},
      preparedMessage.rawFallbackChunks,
      destination,
      deps,
    );
  }
}

async function sendPreparedTelegramChunks(
  config: TelegramNotificationConfig,
  preparedMessage: Pick<TelegramPreparedMessage, "parseMode">,
  chunks: readonly TelegramPreparedMessageChunk[],
  destination: TelegramResolvedDestination,
  deps: TelegramTopicResolutionDeps,
): Promise<TelegramDestinationSendResult> {
  const chunkResults: TelegramSendMessageResult[] = [];

  for (const chunk of chunks) {
    const body = buildTelegramSendMessageBody(
      preparedMessage,
      chunk,
      destination,
    );
    try {
      const result = await sendTelegramMessageChunk(
        config,
        body,
        deps,
      );
      chunkResults.push(result);
    } catch (error) {
      const sentMessageIds = chunkResults
        .map((result) => result.message_id)
        .filter((messageId): messageId is number | string => messageId !== undefined);
      if (sentMessageIds.length > 0) {
        const cleanupSucceeded = await deleteTelegramMessagesBestEffort(
          config,
          destination,
          sentMessageIds,
          deps,
        );
        if (!cleanupSucceeded) {
          throw new Error(
            `Telegram partial chunk delivery cleanup failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      throw error;
    }
  }

  const firstResult = chunkResults[0] ?? {};
  return {
    ...firstResult,
    message_ids: chunkResults
      .map((result) => result.message_id)
      .filter((messageId): messageId is number | string => messageId !== undefined),
    chunkResults,
  };
}

function prepareTelegramMessage(
  config: TelegramNotificationConfig,
  payload: FullNotificationPayload,
): TelegramPreparedMessage {
  const transportOverride = getTransportOverride(payload, "telegram");
  const message = transportOverride?.message ?? payload.message;
  const entityOverridePresent = Object.prototype.hasOwnProperty.call(
    transportOverride ?? {},
    "entities",
  );
  const entities = transportOverride?.entities ?? [];
  const effectiveParseMode =
    entityOverridePresent
      ? undefined
      : Object.prototype.hasOwnProperty.call(transportOverride ?? {}, "parseMode")
        ? transportOverride?.parseMode
        : (config.parseMode ?? "Markdown");
  const parseModeMessageTooLong =
    Boolean(effectiveParseMode) && message.length > TELEGRAM_MESSAGE_MAX_LENGTH;
  const shouldSplit = entityOverridePresent || !effectiveParseMode || parseModeMessageTooLong;
  const chunks = shouldSplit
    ? splitTelegramRenderedMessage({
        text: message,
        entities: entityOverridePresent ? entities : [],
        warnings: [],
      }).map<TelegramPreparedMessageChunk>((chunk) => ({
        text: chunk.text,
        ...(chunk.entities.length > 0 ? { entities: chunk.entities } : {}),
      }))
    : [{ text: message }];
  const rawFallbackChunks = splitTelegramRenderedMessage({
    text: message,
    entities: [],
    warnings: [],
  }).map<TelegramPreparedMessageChunk>((chunk) => ({ text: chunk.text }));

  return {
    chunks,
    rawFallbackChunks,
    ...(effectiveParseMode && !parseModeMessageTooLong ? { parseMode: effectiveParseMode } : {}),
  };
}

function buildTelegramSendMessageBody(
  preparedMessage: Pick<TelegramPreparedMessage, "parseMode">,
  chunk: TelegramPreparedMessageChunk,
  destination: TelegramResolvedDestination,
): Record<string, unknown> {
  return {
    ...(chunk.entities?.length
      ? { entities: chunk.entities }
      : preparedMessage.parseMode
        ? { parse_mode: preparedMessage.parseMode }
        : {}),
    chat_id: destination.chatId,
    text: chunk.text,
    ...(destination.messageThreadId
        ? {
            message_thread_id: coerceTelegramMessageThreadId(
              destination.messageThreadId,
            ),
          }
        : {}),
  };
}

async function sendTelegramMessageChunk(
  config: TelegramNotificationConfig,
  body: Record<string, unknown>,
  deps: TelegramTopicResolutionDeps,
): Promise<TelegramSendMessageResult> {
  return (await performTelegramBotApiRequest<TelegramSendMessageResult>(
    config.botToken,
    "sendMessage",
    body,
    {
      ...(deps.httpsRequestImpl ? { httpsRequestImpl: deps.httpsRequestImpl } : {}),
      timeoutMs: deps.timeoutMs ?? SEND_TIMEOUT_MS,
    },
  )) ?? {};
}

function logTelegramRichFallbackIfEnabled(error: unknown, rawChunkCount: number): void {
  const debugValue = process.env[TELEGRAM_RENDER_DEBUG_ENV]?.trim().toLowerCase();
  const debugEnabled = debugValue === "1" || debugValue === "true" || debugValue === "yes";
  if (!debugEnabled) {
    return;
  }

  const classification = classifyTelegramBotApiError(error);
  console.warn("[notifications] telegram rich payload fallback", {
    category: classification.category,
    methodName: classification.methodName,
    statusCode: classification.statusCode,
    errorCode: classification.errorCode,
    rawChunkCount,
  });
}

async function deleteTelegramMessageBestEffort(
  config: TelegramNotificationConfig,
  destination: TelegramResolvedDestination,
  messageId: number | string | undefined,
  deps: TelegramTopicResolutionDeps,
): Promise<boolean> {
  if (messageId === undefined || messageId === null) {
    return false;
  }

  try {
    await performTelegramBotApiRequest<true>(
      config.botToken,
      "deleteMessage",
      {
        chat_id: destination.chatId,
        message_id: messageId,
      },
      {
        ...(deps.httpsRequestImpl ? { httpsRequestImpl: deps.httpsRequestImpl } : {}),
        timeoutMs: deps.timeoutMs ?? SEND_TIMEOUT_MS,
      },
    );
    return true;
  } catch {
    return false;
  }
}

async function deleteTelegramMessagesBestEffort(
  config: TelegramNotificationConfig,
  destination: TelegramResolvedDestination,
  messageIds: readonly (number | string)[],
  deps: TelegramTopicResolutionDeps,
): Promise<boolean> {
  if (messageIds.length === 0) {
    return false;
  }

  const results = await Promise.all(
    messageIds.map((messageId) => deleteTelegramMessageBestEffort(
      config,
      destination,
      messageId,
      deps,
    )),
  );
  return results.every(Boolean);
}

function normalizeTelegramThreadId(value: number | string | undefined): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.floor(value));
  }
  return typeof value === "string" ? value.trim() : "";
}

function isTelegramTopicDeliveryMismatch(
  destination: TelegramResolvedDestination,
  result: {
    message_thread_id?: number | string;
    is_topic_message?: boolean;
  },
): boolean {
  if (!destination.messageThreadId) {
    return false;
  }

  const expectedThreadId = normalizeTelegramThreadId(destination.messageThreadId);
  const actualThreadId = normalizeTelegramThreadId(result?.message_thread_id);
  return (
    !actualThreadId
    || actualThreadId !== expectedThreadId
    || result?.is_topic_message === false
  );
}

function findTelegramTopicDeliveryMismatch(
  destination: TelegramResolvedDestination,
  results: readonly TelegramSendMessageResult[],
): TelegramSendMessageResult | null {
  return results.find((result) => isTelegramTopicDeliveryMismatch(destination, result)) ?? null;
}

function shouldMarkStaleTelegramTopic(
  config: TelegramNotificationConfig,
  destination: TelegramResolvedDestination,
): boolean {
  return Boolean(
    config.projectTopics?.enabled === true
    && destination.sourceChatKey
    && destination.projectKey
    && destination.messageThreadId
    && !destination.usedFallback,
  );
}

function canRetryStaleTelegramTopic(
  config: TelegramNotificationConfig,
  destination: TelegramResolvedDestination,
): boolean {
  return Boolean(
    shouldMarkStaleTelegramTopic(config, destination)
    && config.projectTopics?.autoCreate !== false,
  );
}

function isUnsafeStaleTopicRetryDestination(
  destination: TelegramResolvedDestination,
): boolean {
  return Boolean(destination.usedFallback || !destination.messageThreadId);
}

async function markTelegramTopicDestinationStaleBestEffort(
  payload: FullNotificationPayload,
  destination: TelegramResolvedDestination,
  failureCode: "topic-stale" | "topic-delivery-mismatch",
  failureMessage: string,
): Promise<void> {
  if (!destination.sourceChatKey || !destination.projectKey) {
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
        createdAt: record?.createdAt,
        lastUsedAt: record?.lastUsedAt,
        lastCreateAttemptAt: record?.lastCreateAttemptAt,
        lastCreateFailureAt: nowIso,
        lastCreateFailureCode: failureCode,
        lastCreateFailureMessage: failureMessage,
        createFailureCooldownUntil: undefined,
        messageThreadId: undefined,
      }),
    );
  } catch (error) {
    console.warn("[notifications] telegram topic registry persistence warning", {
      warningCode: "topic-registry-stale-mark-failed",
      sourceChatKey: destination.sourceChatKey,
      projectKey: destination.projectKey,
      canonicalProjectPath: identity.canonicalProjectPath,
      messageThreadId: destination.messageThreadId,
      error: error instanceof Error ? error.message : String(error),
    });
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
        statusCode: response.status,
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
        statusCode: response.status,
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
