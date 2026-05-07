/**
 * Notification System - Public API
 *
 * Multi-platform notifications for oh-my-codex.
 * Sends notifications to Discord, Telegram, Slack, and generic webhooks
 * for lifecycle events and semantic turn-complete events.
 *
 * Usage:
 *   import { notifyLifecycle } from '../notifications/index.js';
 *   await notifyLifecycle('session-start', { sessionId, projectPath, ... });
 */

export type {
  NotificationEvent,
  NotificationPlatform,
  FullNotificationConfig,
  FullNotificationPayload,
  NotificationTransportOverride,
  NotificationTransportOverrides,
  NotificationResult,
  DispatchResult,
  NonStandardNotificationResult,
  DiscordNotificationConfig,
  DiscordBotNotificationConfig,
  TelegramNotificationConfig,
  TelegramRichRepliesConfig,
  TelegramProjectTopicsConfig,
  TelegramProjectTopicNaming,
  RichContentFileSource,
  RichContentKind,
  RichContentPart,
  RichNotificationContent,
  SlackNotificationConfig,
  WebhookNotificationConfig,
  EventNotificationConfig,
  CompletedTurnRenderMode,
  CompletedTurnPresentationConfig,
  CompletedTurnPlatformPresentationConfig,
  ReplyConfig,
  NotificationProfilesConfig,
  NotificationsBlock,
  VerbosityLevel,
} from "./types.js";
export {
  buildCompletedTurnDeliveryEnvelope,
  hasDeliverableContent,
  hasRichMediaContent,
  mimeTypeForPath,
} from "./rich-content.js";
export type { CompletedTurnDeliveryEnvelope } from "./rich-content.js";
export {
  buildCompletedTurnHookFingerprint,
  buildCompletedTurnTransportOverrides,
  planCompletedTurnNotification,
  renderCompletedTurnMessage,
} from "./completed-turn.js";
export type {
  CompletedTurnHookMetadata,
  CompletedTurnNotificationDecision,
  CompletedTurnReplyOrigin,
  CompletedTurnTransportRenderPolicy,
  ReplyOriginPlatform,
} from "./completed-turn.js";

export {
  dispatchNotifications,
  getEffectivePlatformConfig,
  sendDiscord,
  sendDiscordBot,
  sendTelegram,
  sendTelegramMessageDraft,
  sendSlack,
  sendWebhook,
} from "./dispatcher.js";
export {
  buildProjectTopicName,
  coerceTelegramMessageThreadId,
  createForumTopic,
  ensureProjectTopic,
  normalizeTelegramProjectIdentity,
  performTelegramBotApiRequest,
  resolveTelegramDestination,
  TelegramBotApiError,
} from "./telegram-topics.js";
export {
  buildTelegramTopicRegistryKey,
  getTelegramTopicRegistryPath,
  getTelegramTopicRegistryRecord,
  listTelegramTopicRegistryRecords,
  touchTelegramTopicRegistryRecord,
  updateTelegramTopicRegistryRecord,
  upsertTelegramTopicRegistryRecord,
  withTelegramTopicProjectLock,
} from "./telegram-topic-registry.js";
export type { TelegramTopicRegistryRecord } from "./telegram-topic-registry.js";
export {
  formatNotification,
  formatSessionStart,
  formatSessionStop,
  formatSessionEnd,
  formatSessionIdle,
  formatResultReady,
  formatAskUserQuestion,
} from "./formatter.js";
export {
  getCurrentTmuxSession,
  getCurrentTmuxPaneId,
  getTeamTmuxSessions,
  formatTmuxInfo,
  captureTmuxPane,
  sanitizeTmuxAlertText,
} from "./tmux.js";
export {
  getNotificationConfig,
  isEventEnabled,
  getEnabledPlatforms,
  getReplyConfig,
  getReplyListenerPlatformConfig,
  resolveProfileConfig,
  listProfiles,
  getActiveProfileName,
  getVerbosity,
  isEventAllowedByVerbosity,
  shouldIncludeTmuxTail,
} from "./config.js";
export {
  registerMessage,
  loadAllMappings,
  lookupByMessageId,
  lookupBySourceMessage,
  removeSession,
  removeMessagesByPane,
  pruneStale,
} from "./session-registry.js";
export type { SessionMapping } from "./session-registry.js";
export {
  startReplyListener,
  stopReplyListener,
  getReplyListenerStatus,
  isDaemonRunning,
  sanitizeReplyInput,
} from "./reply-listener.js";

// Re-export the legacy notifier for backward compatibility
export { notify, loadNotificationConfig } from "./notifier.js";
export type { NotificationConfig, NotificationPayload } from "./notifier.js";

// Dispatch cooldown exports
export {
  getDispatchNotificationCooldownSeconds,
  shouldSendDispatchNotification,
  recordDispatchNotificationSent,
} from "./dispatch-cooldown.js";

// Idle cooldown exports (for backward compatibility)
export {
  getIdleNotificationCooldownSeconds,
  shouldSendIdleNotification,
  recordIdleNotificationSent,
  shouldSendCompletedTurnNotification,
  recordCompletedTurnNotificationSent,
} from "./idle-cooldown.js";

// Template engine exports
export {
  interpolateTemplate,
  validateTemplate,
  computeTemplateVariables,
  getDefaultTemplate,
} from "./template-engine.js";

// Hook config exports
export {
  getHookConfig,
  resetHookConfigCache,
  resolveEventTemplate,
  mergeHookConfigIntoNotificationConfig,
} from "./hook-config.js";
export type {
  HookNotificationConfig,
  HookEventConfig,
  PlatformTemplateOverride,
  TemplateVariable,
} from "./hook-config-types.js";

import type {
  NotificationEvent,
  FullNotificationConfig,
  FullNotificationPayload,
  DispatchResult,
  NonStandardNotificationResult,
  RichNotificationContent,
  TelegramNotificationConfig,
  TelegramMessageEntity,
} from "./types.js";
import {
  getNotificationConfig,
  getEnabledPlatforms,
  getReplyConfig,
  getReplyListenerPlatformConfig,
  isEventEnabled,
  getVerbosity,
  shouldIncludeTmuxTail,
  getActiveProfileName,
} from "./config.js";
import {
  getSelectedOpenClawGatewayNames,
  isOpenClawSelectedInTempContract,
  readNotifyTempContractFromEnv,
  type NotifyTempContract,
} from "./temp-contract.js";
import { formatNotification } from "./formatter.js";
import {
  dispatchNotifications,
  getEffectivePlatformConfig,
} from "./dispatcher.js";
import { getCurrentTmuxSession, sanitizeTmuxAlertText } from "./tmux.js";
import { startReplyListener, stopReplyListener } from "./reply-listener.js";
import {
  buildCompletedTurnTransportOverrides,
  renderCompletedTurnMessage,
  type CompletedTurnNotificationDecision,
  type CompletedTurnTransportRenderPolicy,
} from "./completed-turn.js";
import { basename } from "path";
import { omxStateDir } from "../utils/paths.js";
import {
  claimLifecycleNotificationPendingToken,
  clearLifecycleNotificationPending,
  shouldSendLifecycleNotification,
  recordLifecycleNotificationSentLocked,
} from "./lifecycle-dedupe.js";
import type { OpenClawHookEvent, OpenClawResult } from "../openclaw/types.js";
import { parseTmuxTail } from "./formatter.js";
import {
  shouldIncludeSessionIdleTmuxTail,
  recordSessionIdleTmuxTailSent,
} from "./idle-cooldown.js";
import {
  buildTelegramProgressToggleMarkup,
  createTelegramProgressToken,
  isTelegramProgressButtonEnabled,
  loadTelegramProgressTrace,
  registerTelegramProgressFinalMessage,
  renderCollapsedTrace,
} from "./telegram-progress.js";
import { renderMarkdownToTelegramEntities } from "./telegram-markdown-renderer.js";

// Suppress unused import — used by callers via re-export
void getActiveProfileName;

/**
 * Map a NotificationEvent to an OpenClawHookEvent.
 * Returns null for semantic notification events that have no OpenClaw equivalent.
 */
function toOpenClawEvent(event: NotificationEvent): OpenClawHookEvent | null {
  switch (event) {
    case "session-start": return "session-start";
    case "session-end": return "session-end";
    case "session-idle": return "session-idle";
    case "ask-user-question": return "ask-user-question";
    case "session-stop": return "stop";
    default: return null;
  }
}

const AUTO_CAPTURE_TMUX_TAIL_EVENTS = new Set<NotificationEvent>([
  "session-idle",
  "result-ready",
  "ask-user-question",
]);

interface EnsureReplyListenerDeps {
  getReplyConfigImpl?: typeof getReplyConfig;
  getReplyListenerPlatformConfigImpl?: typeof getReplyListenerPlatformConfig;
  startReplyListenerImpl?: typeof startReplyListener;
  stopReplyListenerImpl?: typeof stopReplyListener;
}

export function ensureReplyListenerForConfig(
  config: FullNotificationConfig | null,
  deps: EnsureReplyListenerDeps = {},
): void {
  const getReplyConfigImpl = deps.getReplyConfigImpl ?? getReplyConfig;
  const getReplyListenerPlatformConfigImpl =
    deps.getReplyListenerPlatformConfigImpl ?? getReplyListenerPlatformConfig;
  const startReplyListenerImpl = deps.startReplyListenerImpl ?? startReplyListener;
  const stopReplyListenerImpl = deps.stopReplyListenerImpl ?? stopReplyListener;

  if (!config?.enabled) {
    stopReplyListenerImpl();
    return;
  }

  const replyConfig = getReplyConfigImpl(config);
  if (!replyConfig?.enabled) {
    stopReplyListenerImpl();
    return;
  }

  const platformConfig = getReplyListenerPlatformConfigImpl(config);
  if (!platformConfig.discordEnabled && !platformConfig.telegramEnabled) {
    stopReplyListenerImpl();
    return;
  }

  startReplyListenerImpl({
    ...replyConfig,
    ...platformConfig,
  });
}

interface NotifyLifecycleDeps {
  getNotificationConfigImpl?: typeof getNotificationConfig;
  isEventEnabledImpl?: typeof isEventEnabled;
  ensureReplyListenerForConfigImpl?: typeof ensureReplyListenerForConfig;
  dispatchNotificationsImpl?: typeof dispatchNotifications;
}

interface NotifyCompletedTurnDeps extends NotifyLifecycleDeps {}

function resolveTelegramProgressFinalRender(
  telegramConfig: TelegramNotificationConfig,
  payload: FullNotificationPayload,
): {
  text: string;
  entities?: TelegramMessageEntity[];
  parseMode?: "Markdown" | "HTML" | null;
} {
  const override = payload.transportOverrides?.telegram;
  const text = override?.message ?? payload.message;
  const hasEntityOverride = Object.prototype.hasOwnProperty.call(
    override ?? {},
    "entities",
  );
  const hasParseModeOverride = Object.prototype.hasOwnProperty.call(
    override ?? {},
    "parseMode",
  );
  return {
    text,
    ...(hasEntityOverride && override?.entities ? { entities: override.entities } : {}),
    ...(hasParseModeOverride
      ? { parseMode: override?.parseMode }
      : hasEntityOverride
        ? { parseMode: null }
        : { parseMode: telegramConfig.parseMode ?? "Markdown" }),
  };
}

function hasTelegramTextAnchor(payload: FullNotificationPayload): boolean {
  const richParts = payload.richContent?.parts ?? [];
  if (richParts.length === 0) {
    return payload.message.trim().length > 0;
  }

  const firstDeliverablePart = richParts.find((part) => (
    part.kind !== "text" || part.text.trim().length > 0
  ));
  return firstDeliverablePart?.kind === "text";
}

function canInlineTelegramProgressIntoFinalPayload(payload: FullNotificationPayload): boolean {
  return !(payload.richContent?.parts ?? []).some((part) => part.kind !== "text");
}

function renderTelegramProgressFinalForInline(
  finalRender: {
    text: string;
    entities?: TelegramMessageEntity[];
    parseMode?: "Markdown" | "HTML" | null;
  },
): {
  text: string;
  entities?: TelegramMessageEntity[];
  canInline: boolean;
} {
  if (finalRender.entities?.length) {
    return {
      text: finalRender.text,
      entities: finalRender.entities,
      canInline: true,
    };
  }
  if (finalRender.parseMode === "Markdown") {
    const rendered = renderMarkdownToTelegramEntities(finalRender.text);
    return {
      text: rendered.text,
      entities: rendered.entities,
      canInline: true,
    };
  }
  if (finalRender.parseMode === "HTML") {
    return {
      text: finalRender.text,
      canInline: false,
    };
  }
  return {
    text: finalRender.text,
    canInline: true,
  };
}

async function maybeAttachTelegramProgressButton(
  config: FullNotificationConfig,
  decision: CompletedTurnNotificationDecision,
  payload: FullNotificationPayload,
): Promise<void> {
  if (!payload.projectPath || !payload.tmuxPaneId || !decision.turnId || !hasTelegramTextAnchor(payload)) {
    return;
  }
  const telegramConfig = getEffectivePlatformConfig<TelegramNotificationConfig>(
    "telegram",
    config,
    decision.effectiveEvent,
  );
  if (!telegramConfig?.enabled || !isTelegramProgressButtonEnabled(telegramConfig.progress)) {
    return;
  }
  const replyTelegramConfig = getReplyListenerPlatformConfig(config);
  if (
    !replyTelegramConfig.telegramEnabled
    || replyTelegramConfig.telegramBotToken !== telegramConfig.botToken
    || replyTelegramConfig.telegramChatId !== telegramConfig.chatId
  ) {
    return;
  }
  const trace = await loadTelegramProgressTrace(
    payload.projectPath,
    payload.sessionId,
    decision.turnId,
  );
  if (!trace || trace.entries.length === 0) {
    return;
  }

  const token = createTelegramProgressToken();
  const telegramOverride = payload.transportOverrides?.telegram ?? {};
  const finalRender = resolveTelegramProgressFinalRender(telegramConfig, payload);
  const inlineFinalRender = renderTelegramProgressFinalForInline(finalRender);
  const inlineTrace = inlineFinalRender.canInline && canInlineTelegramProgressIntoFinalPayload(payload)
    ? renderCollapsedTrace(trace, inlineFinalRender.text, {
        ...(inlineFinalRender.entities?.length ? { finalEntities: inlineFinalRender.entities } : {}),
      })
    : null;
  const shown = inlineTrace?.fits === true;
  const persistedFinalRender = shown
    ? {
        text: inlineFinalRender.text,
        ...(inlineFinalRender.entities?.length ? { entities: inlineFinalRender.entities } : {}),
        parseMode: null,
      }
    : finalRender;
  payload.transportOverrides = {
    ...(payload.transportOverrides ?? {}),
    telegram: {
      ...telegramOverride,
      ...(shown
        ? {
            message: inlineTrace.text,
            entities: inlineTrace.entities,
            parseMode: null,
          }
        : {}),
      replyMarkup: buildTelegramProgressToggleMarkup(token, shown),
    },
  };
  payload.telegramProgressFinal = {
    token,
    turnId: decision.turnId,
    finalText: persistedFinalRender.text,
    ...(persistedFinalRender.entities?.length ? { finalEntities: persistedFinalRender.entities } : {}),
    ...(Object.prototype.hasOwnProperty.call(persistedFinalRender, "parseMode")
      ? { finalParseMode: persistedFinalRender.parseMode }
      : {}),
    ...(telegramConfig.progress?.fullTraceDelivery
      ? { fullTraceDelivery: telegramConfig.progress.fullTraceDelivery }
      : {}),
    shown,
  };
}

async function maybeRegisterReplyMappings(
  config: FullNotificationConfig,
  payload: FullNotificationPayload,
  result: DispatchResult,
): Promise<void> {
  if (!result.anySuccess || !payload.tmuxPaneId) {
    return;
  }

  try {
    const { registerMessage } = await import("./session-registry.js");
    const {
      buildDiscordReplySource,
      buildTelegramReplySource,
    } = await import("./reply-source.js");
    const telegramConfig = getEffectivePlatformConfig<TelegramNotificationConfig>(
      "telegram",
      config,
      payload.event,
    );
    for (const r of result.results) {
      if (
        r.success &&
        r.messageId &&
        (r.platform === "discord-bot" || r.platform === "telegram")
      ) {
        const messageIds = Array.from(new Set(
          (r.platform === "telegram" ? [r.messageId, ...(r.messageIds ?? [])] : [r.messageId])
            .map((messageId) => messageId.trim())
            .filter(Boolean),
        ));
        const source = r.platform === "discord-bot"
          ? (config["discord-bot"]?.enabled && config["discord-bot"]?.botToken && config["discord-bot"]?.channelId
              ? buildDiscordReplySource(config["discord-bot"].botToken, config["discord-bot"].channelId)
              : undefined)
          : (config.telegram?.enabled && config.telegram?.botToken && config.telegram?.chatId
              ? buildTelegramReplySource(config.telegram.botToken, config.telegram.chatId)
              : undefined);
        for (const messageId of messageIds) {
          registerMessage({
            platform: r.platform,
            messageId,
            ...(source ? { source } : {}),
            sessionId: payload.sessionId,
            tmuxPaneId: payload.tmuxPaneId,
            tmuxSessionName: payload.tmuxSession || "",
            event: payload.event,
            createdAt: new Date().toISOString(),
            projectPath: payload.projectPath,
            projectKey: r.projectKey,
            messageThreadId: r.messageThreadId,
            topicName: r.topicName,
          });
        }
      }
      if (
        r.success
        && r.platform === "telegram"
        && r.messageId
        && payload.telegramProgressFinal
        && payload.projectPath
        && telegramConfig?.chatId
      ) {
        await registerTelegramProgressFinalMessage({
          token: payload.telegramProgressFinal.token,
          projectPath: payload.projectPath,
          sessionId: payload.sessionId,
          turnId: payload.telegramProgressFinal.turnId,
          chatId: telegramConfig.chatId,
          messageId: r.messageId,
          ...(r.messageThreadId ? { messageThreadId: r.messageThreadId } : {}),
          finalText: payload.telegramProgressFinal.finalText,
          ...(payload.telegramProgressFinal.finalEntities?.length
            ? { finalEntities: payload.telegramProgressFinal.finalEntities }
            : {}),
          ...(Object.prototype.hasOwnProperty.call(payload.telegramProgressFinal, "finalParseMode")
            ? { finalParseMode: payload.telegramProgressFinal.finalParseMode }
            : {}),
          ...(payload.telegramProgressFinal.fullTraceDelivery
            ? { fullTraceDelivery: payload.telegramProgressFinal.fullTraceDelivery }
            : {}),
          shown: payload.telegramProgressFinal.shown === true,
        });
      }
    }
  } catch {
    // Non-fatal: reply correlation is best-effort
  }
}

function buildOpenClawContext(payload: FullNotificationPayload): {
  sessionId: string;
  projectPath?: string;
  tmuxSession?: string;
  contextSummary?: string;
  reason?: string;
  question?: string;
  tmuxTail?: string;
} {
  return {
    sessionId: payload.sessionId,
    projectPath: payload.projectPath,
    tmuxSession: payload.tmuxSession,
    contextSummary: payload.contextSummary,
    reason: payload.reason,
    question: payload.question,
    tmuxTail: payload.tmuxTail,
  };
}

async function buildOpenClawDispatch(
  event: NotificationEvent,
  payload: FullNotificationPayload,
): Promise<(() => Promise<NonStandardNotificationResult | null>) | null> {
  const openClawEvent = toOpenClawEvent(event);
  if (openClawEvent === null) {
    return null;
  }

  const tempContract = readNotifyTempContractFromEnv(process.env);
  const openClawContext = buildOpenClawContext(payload);
  return async (): Promise<NonStandardNotificationResult | null> => {
    try {
      const openClawAllowed = await shouldDispatchOpenClaw(
        openClawEvent,
        tempContract,
        process.env,
      );
      if (!openClawAllowed) return null;

      const { wakeOpenClaw } = await import("../openclaw/index.js");
      return normalizeOpenClawResult(await wakeOpenClaw(openClawEvent, openClawContext));
    } catch (error) {
      // OpenClaw failures must never affect notification dispatch
      return {
        transport: "openclaw",
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

function normalizeOpenClawResult(result: OpenClawResult | null): NonStandardNotificationResult {
  if (!result) {
    return {
      transport: "openclaw",
      success: false,
      error: "OpenClaw gateway unavailable",
    };
  }
  return {
    transport: "openclaw",
    success: result.success,
    gateway: result.gateway,
    ...(result.error ? { error: result.error } : {}),
    ...(result.statusCode !== undefined ? { statusCode: result.statusCode } : {}),
  };
}

function appendNonStandardResult(
  result: DispatchResult,
  nonStandardResult: NonStandardNotificationResult | null,
): void {
  if (!nonStandardResult) return;
  result.nonStandardResults = [
    ...(result.nonStandardResults || []),
    nonStandardResult,
  ];
  if (nonStandardResult.success) {
    result.nonStandardAnySuccess = true;
    result.anySuccess = true;
  }
}

function isAmbiguousNotificationError(value: unknown): boolean {
  const error = String(value ?? "").trim().toLowerCase();
  return Boolean(error && (
    error.includes("dispatch timeout")
    || error.includes("request timeout")
    || error.includes("aborterror")
    || error.includes("aborted")
    || error.includes("signal timed out")
    || error.includes("killed by signal")
    || error.includes("sigterm")
    || error.includes("timeout")
    || error.includes("telegram partial chunk delivery cleanup failed")
    || error.includes("telegram topic delivery mismatch cleanup failed")
  ));
}

function isAmbiguousFailedResult(result: { success: boolean; error?: string; statusCode?: number }): boolean {
  return !result.success
    && (
      isAmbiguousNotificationError(result.error)
      || result.statusCode === 408
      || result.statusCode === 504
      || result.statusCode === 524
    );
}

function hasAmbiguousDispatchFailure(result: DispatchResult): boolean {
  return result.results.some(isAmbiguousFailedResult)
    || result.nonStandardResults?.some(isAmbiguousFailedResult) === true;
}

export async function shouldDispatchOpenClaw(
  event: OpenClawHookEvent,
  tempContract: NotifyTempContract | null,
  env: NodeJS.ProcessEnv = process.env,
) : Promise<boolean> {
  if (env.OMX_OPENCLAW !== "1") return false;
  if (!tempContract?.active) return true;
  if (!isOpenClawSelectedInTempContract(tempContract)) return false;

  const selectedGatewayNames = getSelectedOpenClawGatewayNames(tempContract);
  if (selectedGatewayNames.size === 0) return false;

  try {
    const { getOpenClawConfig, resolveGateway } = await import("../openclaw/config.js");
    const config = getOpenClawConfig();
    if (!config) return false;
    const resolved = resolveGateway(config, event);
    if (!resolved) return false;
    return selectedGatewayNames.has(resolved.gatewayName.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * High-level notification function for lifecycle events.
 *
 * Reads config, checks if the event is enabled, formats the message,
 * and dispatches to all configured platforms. Non-blocking, swallows errors.
 */
export async function notifyLifecycle(
  event: NotificationEvent,
  data: Partial<FullNotificationPayload> & { sessionId: string },
  profileName?: string,
  deps: NotifyLifecycleDeps = {},
): Promise<DispatchResult | null> {
  try {
    const getNotificationConfigImpl =
      deps.getNotificationConfigImpl ?? getNotificationConfig;
    const isEventEnabledImpl = deps.isEventEnabledImpl ?? isEventEnabled;
    const ensureReplyListenerForConfigImpl =
      deps.ensureReplyListenerForConfigImpl ?? ensureReplyListenerForConfig;
    const dispatchNotificationsImpl =
      deps.dispatchNotificationsImpl ?? dispatchNotifications;

    const config = getNotificationConfigImpl(profileName);
    ensureReplyListenerForConfigImpl(config);

    if (!config || !isEventEnabledImpl(config, event)) {
      return null;
    }

    const { getCurrentTmuxPaneId } = await import("./tmux.js");

    const payload: FullNotificationPayload = {
      event,
      sessionId: data.sessionId,
      message: "",
      timestamp: data.timestamp || new Date().toISOString(),
      tmuxSession: data.tmuxSession ?? getCurrentTmuxSession() ?? undefined,
      tmuxPaneId: data.tmuxPaneId ?? getCurrentTmuxPaneId() ?? undefined,
      projectPath: data.projectPath,
      projectName:
        data.projectName ||
        (data.projectPath ? basename(data.projectPath) : undefined),
      modesUsed: data.modesUsed,
      contextSummary: data.contextSummary,
      durationMs: data.durationMs,
      agentsSpawned: data.agentsSpawned,
      agentsCompleted: data.agentsCompleted,
      reason: data.reason,
      activeMode: data.activeMode,
      iteration: data.iteration,
      maxIterations: data.maxIterations,
      question: data.question,
      incompleteTasks: data.incompleteTasks,
    };
    // Auto-capture tmux tail only for live turn-facing notifications. Stop/end
    // lifecycle dispatches happen after the relevant session is stopping or has
    // already completed, so blind capture-pane reads can replay historical pane
    // lines into follow-up alerts. Explicitly supplied tmuxTail still passes
    // through unchanged.
    const verbosity = getVerbosity(config);
    if (
      shouldIncludeTmuxTail(verbosity)
      && !data.tmuxTail
      && AUTO_CAPTURE_TMUX_TAIL_EVENTS.has(event)
    ) {
      const { captureTmuxPaneWithLiveness } = await import("./tmux.js");
      const tmuxCapture = captureTmuxPaneWithLiveness(payload.tmuxPaneId);
      payload.tmuxTail = sanitizeTmuxAlertText(tmuxCapture.content);
      payload.tmuxTailLive = tmuxCapture.live;
    } else {
      payload.tmuxTail = sanitizeTmuxAlertText(data.tmuxTail);
      payload.tmuxTailLive = data.tmuxTailLive;
    }

    const lifecycleStateDir = payload.projectPath ? omxStateDir(payload.projectPath) : "";
    const normalizedIdleTmuxTail = event === "session-idle" ? parseTmuxTail(payload.tmuxTail || "") : "";
    const sessionIdleTmuxTailAllowed = event !== "session-idle"
      || shouldIncludeSessionIdleTmuxTail(lifecycleStateDir, payload.sessionId, normalizedIdleTmuxTail);

    if (
      event === "session-idle"
      && !sessionIdleTmuxTailAllowed
    ) {
      payload.tmuxTail = undefined;
      payload.tmuxTailLive = undefined;
    }

    payload.message = data.message || formatNotification(payload);

    if (!shouldSendLifecycleNotification(lifecycleStateDir, payload)) {
      return {
        event,
        anySuccess: true,
        results: [],
      };
    }
    const lifecycleClaimToken = await claimLifecycleNotificationPendingToken(lifecycleStateDir, payload);
    if (lifecycleClaimToken === null) {
      return {
        event,
        anySuccess: true,
        results: [],
      };
    }

    const openClawEvent = toOpenClawEvent(event);
    const dispatchOpenClawLater = await buildOpenClawDispatch(event, payload);
    let nonStandardDispatchResult: Promise<NonStandardNotificationResult | null> | null = null;

    if (openClawEvent !== "ask-user-question" && dispatchOpenClawLater) {
      // Let the non-blocking OpenClaw eligibility/import path overlap the primary
      // platform dispatch so session-start does not wait on background wake work.
      nonStandardDispatchResult = dispatchOpenClawLater();
    }

    const result = await dispatchNotificationsImpl(config, event, payload);
    if (openClawEvent === "ask-user-question" && dispatchOpenClawLater) {
      nonStandardDispatchResult = dispatchOpenClawLater();
    }
    if (openClawEvent === "ask-user-question" && nonStandardDispatchResult) {
      appendNonStandardResult(result, await nonStandardDispatchResult);
    }

    const ambiguousDispatchFailure = hasAmbiguousDispatchFailure(result);
    if (result.anySuccess) {
      await recordLifecycleNotificationSentLocked(lifecycleStateDir, payload, Date.now(), lifecycleClaimToken);
      if (event === "session-idle" && sessionIdleTmuxTailAllowed) {
        recordSessionIdleTmuxTailSent(lifecycleStateDir, payload.sessionId, normalizedIdleTmuxTail);
      }
    } else if (openClawEvent !== "ask-user-question" && nonStandardDispatchResult) {
      void nonStandardDispatchResult
        .then(async (nonStandardResult) => {
          if (!nonStandardResult?.success) {
            if (ambiguousDispatchFailure || (nonStandardResult && isAmbiguousFailedResult(nonStandardResult))) {
              return;
            }
            await clearLifecycleNotificationPending(lifecycleStateDir, payload, lifecycleClaimToken)
              .catch(() => {
                // If state persistence fails after a definitive transport failure,
                // leave the pending claim in place so a duplicate lifecycle hook
                // fails closed until stale recovery instead of risking a replay.
              });
            return;
          }
          await recordLifecycleNotificationSentLocked(lifecycleStateDir, payload, Date.now(), lifecycleClaimToken)
            .catch(() => {
              // The OpenClaw/custom send already succeeded. If we cannot commit
              // the sent marker, keep the pending claim rather than clearing it
              // through the transport-error path below.
            });
          if (event === "session-idle" && sessionIdleTmuxTailAllowed) {
            recordSessionIdleTmuxTailSent(lifecycleStateDir, payload.sessionId, normalizedIdleTmuxTail);
          }
        })
        .catch(async (error) => {
          if (ambiguousDispatchFailure || isAmbiguousNotificationError(error)) {
            return;
          }
          await clearLifecycleNotificationPending(lifecycleStateDir, payload, lifecycleClaimToken);
        });
    } else if (!ambiguousDispatchFailure) {
      await clearLifecycleNotificationPending(lifecycleStateDir, payload, lifecycleClaimToken);
    }

    await maybeRegisterReplyMappings(config, payload, result);

    return result;
  } catch (error) {
    console.error(
      "[notifications] Error:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

export async function notifyCompletedTurn(
  decision: CompletedTurnNotificationDecision,
  data: Partial<FullNotificationPayload> & {
    sessionId: string;
    assistantText: string;
    richContent?: RichNotificationContent;
  },
  profileName?: string,
  deps: NotifyCompletedTurnDeps = {},
): Promise<DispatchResult | null> {
  try {
    const getNotificationConfigImpl =
      deps.getNotificationConfigImpl ?? getNotificationConfig;
    const isEventEnabledImpl = deps.isEventEnabledImpl ?? isEventEnabled;
    const ensureReplyListenerForConfigImpl =
      deps.ensureReplyListenerForConfigImpl ?? ensureReplyListenerForConfig;
    const dispatchNotificationsImpl =
      deps.dispatchNotificationsImpl ?? dispatchNotifications;

    const config = getNotificationConfigImpl(profileName);
    ensureReplyListenerForConfigImpl(config);

    if (!config || !isEventEnabledImpl(config, decision.effectiveEvent)) {
      return null;
    }

    const { getCurrentTmuxPaneId } = await import("./tmux.js");
    const payload: FullNotificationPayload = {
      event: decision.effectiveEvent,
      sessionId: data.sessionId,
      message: "",
      timestamp: data.timestamp || new Date().toISOString(),
      tmuxSession: data.tmuxSession ?? getCurrentTmuxSession() ?? undefined,
      tmuxPaneId: data.tmuxPaneId ?? getCurrentTmuxPaneId() ?? undefined,
      projectPath: data.projectPath,
      projectName:
        data.projectName ||
        (data.projectPath ? basename(data.projectPath) : undefined),
      modesUsed: data.modesUsed,
      contextSummary: data.contextSummary,
      durationMs: data.durationMs,
      agentsSpawned: data.agentsSpawned,
      agentsCompleted: data.agentsCompleted,
      reason: data.reason,
      activeMode: data.activeMode,
      iteration: data.iteration,
      maxIterations: data.maxIterations,
      question: data.question,
      incompleteTasks: data.incompleteTasks,
      ...(decision.replyOrigin?.platform === "telegram" && decision.replyOrigin.telegramAck
        ? { telegramAcceptedAck: decision.replyOrigin.telegramAck }
        : {}),
      ...(decision.replyOrigin?.platform === "telegram" && decision.replyOrigin.telegramReplyTo
        ? { telegramReplyTo: decision.replyOrigin.telegramReplyTo }
        : {}),
      ...(data.richContent ? { richContent: data.richContent } : {}),
    };

    const verbosity = getVerbosity(config);
    if (
      shouldIncludeTmuxTail(verbosity)
      && !data.tmuxTail
      && AUTO_CAPTURE_TMUX_TAIL_EVENTS.has(decision.effectiveEvent)
    ) {
      const { captureTmuxPaneWithLiveness } = await import("./tmux.js");
      const tmuxCapture = captureTmuxPaneWithLiveness(payload.tmuxPaneId);
      payload.tmuxTail = sanitizeTmuxAlertText(tmuxCapture.content);
      payload.tmuxTailLive = tmuxCapture.live;
    } else {
      payload.tmuxTail = sanitizeTmuxAlertText(data.tmuxTail);
      payload.tmuxTailLive = data.tmuxTailLive;
    }

    const defaultPolicy: CompletedTurnTransportRenderPolicy =
      decision.transportPolicy.default;
    payload.message = renderCompletedTurnMessage(
      defaultPolicy,
      payload,
      data.assistantText,
    );
    payload.transportOverrides = buildCompletedTurnTransportOverrides(
      decision,
      payload,
      data.assistantText,
      getEnabledPlatforms(config, decision.effectiveEvent),
    );
    await maybeAttachTelegramProgressButton(config, decision, payload);

    const openClawEvent = toOpenClawEvent(decision.effectiveEvent);
    const dispatchOpenClawLater = await buildOpenClawDispatch(
      decision.effectiveEvent,
      payload,
    );
    let nonStandardDispatchResult: Promise<NonStandardNotificationResult | null> | null = null;

    if (openClawEvent !== "ask-user-question" && dispatchOpenClawLater) {
      void dispatchOpenClawLater();
    }

    const result = await dispatchNotificationsImpl(
      config,
      decision.effectiveEvent,
      payload,
    );

    if (openClawEvent === "ask-user-question" && dispatchOpenClawLater) {
      nonStandardDispatchResult = dispatchOpenClawLater();
    }
    if (nonStandardDispatchResult) {
      appendNonStandardResult(result, await nonStandardDispatchResult);
    }

    await maybeRegisterReplyMappings(config, payload, result);
    return result;
  } catch (error) {
    console.error(
      "[notifications] Error:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}
