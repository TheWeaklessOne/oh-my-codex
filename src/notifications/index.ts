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
  TelegramProjectTopicsConfig,
  TelegramProjectTopicNaming,
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
  sendDiscord,
  sendDiscordBot,
  sendTelegram,
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
import { dispatchNotifications } from "./dispatcher.js";
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
  claimLifecycleNotificationPending,
  clearLifecycleNotificationPending,
  shouldSendLifecycleNotification,
  recordLifecycleNotificationSent,
} from "./lifecycle-dedupe.js";
import type { OpenClawHookEvent, OpenClawResult } from "../openclaw/types.js";
import { parseTmuxTail } from "./formatter.js";
import {
  shouldIncludeSessionIdleTmuxTail,
  recordSessionIdleTmuxTailSent,
} from "./idle-cooldown.js";

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
    for (const r of result.results) {
      if (
        r.success &&
        r.messageId &&
        (r.platform === "discord-bot" || r.platform === "telegram")
      ) {
        const source = r.platform === "discord-bot"
          ? (config["discord-bot"]?.enabled && config["discord-bot"]?.botToken && config["discord-bot"]?.channelId
              ? buildDiscordReplySource(config["discord-bot"].botToken, config["discord-bot"].channelId)
              : undefined)
          : (config.telegram?.enabled && config.telegram?.botToken && config.telegram?.chatId
              ? buildTelegramReplySource(config.telegram.botToken, config.telegram.chatId)
              : undefined);
        registerMessage({
          platform: r.platform,
          messageId: r.messageId,
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

    const openClawEvent = toOpenClawEvent(event);
    const dispatchOpenClawLater = await buildOpenClawDispatch(event, payload);
    let nonStandardDispatchResult: Promise<NonStandardNotificationResult | null> | null = null;

    if (openClawEvent !== "ask-user-question" && dispatchOpenClawLater) {
      if (!claimLifecycleNotificationPending(lifecycleStateDir, payload)) {
        return {
          event,
          anySuccess: true,
          results: [],
        };
      }
      // Let the non-blocking OpenClaw eligibility/import path overlap the primary
      // platform dispatch so session-start does not wait on background wake work.
      nonStandardDispatchResult = dispatchOpenClawLater();
      void nonStandardDispatchResult
        .then((nonStandardResult) => {
          if (!nonStandardResult?.success) {
            clearLifecycleNotificationPending(lifecycleStateDir, payload);
            return;
          }
          recordLifecycleNotificationSent(lifecycleStateDir, payload);
          if (event === "session-idle" && sessionIdleTmuxTailAllowed) {
            recordSessionIdleTmuxTailSent(lifecycleStateDir, payload.sessionId, normalizedIdleTmuxTail);
          }
        })
        .catch(() => {
          clearLifecycleNotificationPending(lifecycleStateDir, payload);
        });
    }

    const result = await dispatchNotificationsImpl(config, event, payload);
    if (openClawEvent === "ask-user-question" && dispatchOpenClawLater) {
      nonStandardDispatchResult = dispatchOpenClawLater();
    }
    if (openClawEvent === "ask-user-question" && nonStandardDispatchResult) {
      appendNonStandardResult(result, await nonStandardDispatchResult);
    }

    if (result.anySuccess) {
      recordLifecycleNotificationSent(lifecycleStateDir, payload);
      if (event === "session-idle" && sessionIdleTmuxTailAllowed) {
        recordSessionIdleTmuxTailSent(lifecycleStateDir, payload.sessionId, normalizedIdleTmuxTail);
      }
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
