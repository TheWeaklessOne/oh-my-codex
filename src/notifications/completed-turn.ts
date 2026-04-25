import { formatNotification } from "./formatter.js";
import { renderMarkdownToTelegramEntities } from "./telegram-markdown-renderer.js";
import type {
  CompletedTurnPresentationConfig,
  CompletedTurnRenderMode,
  FullNotificationPayload,
  FullNotificationConfig,
  NotificationEvent,
  NotificationPlatform,
  NotificationTransportOverrides,
  TelegramCompletedTurnFormat,
  TelegramMessageEntity,
} from "./types.js";
import type {
  CompletedTurnSemanticKind,
  CompletedTurnSemanticOutcome,
} from "../runtime/turn-semantics.js";

export type ReplyOriginPlatform = "telegram" | "discord";

export interface CompletedTurnReplyOrigin {
  platform: ReplyOriginPlatform;
  injectedInput: string;
  createdAt: string;
}

export interface CompletedTurnTransportRenderPolicy {
  mode: CompletedTurnRenderMode;
  parseMode?: "Markdown" | "HTML" | null;
  telegramFormat?: TelegramCompletedTurnFormat;
}

export interface CompletedTurnHookMetadata {
  semanticPhase: CompletedTurnSemanticKind;
  semanticSummary: string | null;
  semanticQuestion: string | null;
  semanticNotificationEvent: Extract<
    NotificationEvent,
    "result-ready" | "ask-user-question"
  >;
  semanticClassifierEvent: NotificationEvent | null;
  replyOriginPlatform: ReplyOriginPlatform | null;
}

export interface CompletedTurnNotificationDecision {
  effectiveEvent: Extract<
    NotificationEvent,
    "result-ready" | "ask-user-question"
  >;
  effectiveFingerprint: string;
  hookMetadata: CompletedTurnHookMetadata;
  semanticOutcome: CompletedTurnSemanticOutcome;
  replyOrigin: CompletedTurnReplyOrigin | null;
  transportPolicy: {
    default: CompletedTurnTransportRenderPolicy;
    overrides?: Partial<
      Record<NotificationPlatform, CompletedTurnTransportRenderPolicy>
    >;
  };
}

type CompletedTurnEffectiveEvent = Extract<
  NotificationEvent,
  "result-ready" | "ask-user-question"
>;

const DEFAULT_TELEGRAM_COMPLETED_TURN_FORMAT: TelegramCompletedTurnFormat =
  "entities";

function shouldFallbackToFormattedNotification(
  policy: CompletedTurnTransportRenderPolicy,
  assistantText: string,
): boolean {
  if (policy.mode !== "raw-assistant-text") {
    return false;
  }

  if (assistantText.trim().length === 0) {
    return true;
  }

  return false;
}

function resolveCompletedTurnRenderedMessage(
  policy: CompletedTurnTransportRenderPolicy,
  payload: FullNotificationPayload,
  assistantText: string,
  platform?: NotificationPlatform,
): {
  message: string;
  parseMode?: "Markdown" | "HTML" | null;
  entities?: TelegramMessageEntity[];
} {
  if (
    policy.mode === "raw-assistant-text"
    && !shouldFallbackToFormattedNotification(policy, assistantText)
  ) {
    if (
      platform === "telegram"
      && (policy.telegramFormat ?? DEFAULT_TELEGRAM_COMPLETED_TURN_FORMAT) === "entities"
    ) {
      const rendered = renderMarkdownToTelegramEntities(assistantText);
      return {
        message: rendered.text,
        parseMode: null,
        ...(rendered.entities.length > 0 ? { entities: rendered.entities } : {}),
      };
    }

    return {
      message: assistantText,
      ...(Object.prototype.hasOwnProperty.call(policy, "parseMode")
        ? { parseMode: policy.parseMode }
        : {}),
    };
  }

  return {
    message: formatNotification(payload),
  };
}

function resolveCompletedTurnRenderMode(
  event: CompletedTurnEffectiveEvent,
  config?: CompletedTurnPresentationConfig | null,
  platform?: NotificationPlatform,
): CompletedTurnRenderMode {
  const platformOverride = platform
    ? config?.platformOverrides?.[platform]
    : undefined;
  if (event === "result-ready") {
    return platformOverride?.resultReadyMode ?? config?.resultReadyMode ?? "raw-assistant-text";
  }
  return (
    platformOverride?.askUserQuestionMode
    ?? config?.askUserQuestionMode
    ?? "raw-assistant-text"
  );
}

function resolveTelegramCompletedTurnFormat(
  config?: CompletedTurnPresentationConfig | null,
): TelegramCompletedTurnFormat {
  return (
    config?.platformOverrides?.telegram?.telegramFormat
    ?? DEFAULT_TELEGRAM_COMPLETED_TURN_FORMAT
  );
}

function buildTransportRenderPolicy(
  mode: CompletedTurnRenderMode,
  platform?: NotificationPlatform,
  telegramFormat?: TelegramCompletedTurnFormat,
): CompletedTurnTransportRenderPolicy {
  return {
    mode,
    ...(platform === "telegram" && mode === "raw-assistant-text"
      ? {
          parseMode: null,
          telegramFormat: telegramFormat ?? DEFAULT_TELEGRAM_COMPLETED_TURN_FORMAT,
        }
      : {}),
  };
}

function buildCompletedTurnTransportPolicy(
  event: CompletedTurnEffectiveEvent,
  notificationConfig?: Pick<FullNotificationConfig, "completedTurn"> | null,
): CompletedTurnNotificationDecision["transportPolicy"] {
  const completedTurnConfig = notificationConfig?.completedTurn;
  const platforms: NotificationPlatform[] = [
    "discord",
    "discord-bot",
    "telegram",
    "slack",
    "webhook",
  ];
  const defaultPolicy = buildTransportRenderPolicy(
    resolveCompletedTurnRenderMode(event, completedTurnConfig),
  );
  const overrides = platforms.reduce<NonNullable<
    CompletedTurnNotificationDecision["transportPolicy"]["overrides"]
  >>(
    (acc, platform) => {
      const platformPolicy = buildTransportRenderPolicy(
        resolveCompletedTurnRenderMode(event, completedTurnConfig, platform),
        platform,
        platform === "telegram"
          ? resolveTelegramCompletedTurnFormat(completedTurnConfig)
          : undefined,
      );
      if (
        platformPolicy.mode !== defaultPolicy.mode
        || Object.prototype.hasOwnProperty.call(platformPolicy, "parseMode")
        || platformPolicy.telegramFormat !== undefined
      ) {
        acc[platform] = platformPolicy;
      }
      return acc;
    },
    {},
  );

  return {
    default: defaultPolicy,
    ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
  };
}

function buildCompletedTurnFingerprint(
  decision: Pick<
    CompletedTurnNotificationDecision,
    "effectiveEvent" | "semanticOutcome" | "replyOrigin"
  > & {
    turnId?: string;
  },
): string {
  if (decision.turnId) {
    return JSON.stringify({
      scope: "completed-turn",
      policy: decision.replyOrigin ? "reply-origin-per-turn" : "per-turn",
      effectiveEvent: decision.effectiveEvent,
      replyOriginPlatform: decision.replyOrigin?.platform || "",
      turnId: decision.turnId,
    });
  }

  return JSON.stringify({
    scope: "completed-turn",
    policy: "semantic-summary",
    effectiveEvent: decision.effectiveEvent,
    semanticKind: decision.semanticOutcome.kind,
    summary: decision.semanticOutcome.summary || "",
    question: decision.semanticOutcome.question || "",
    replyOriginPlatform: decision.replyOrigin?.platform || "",
  });
}

export function buildCompletedTurnHookFingerprint(
  decision: CompletedTurnNotificationDecision | null,
  semanticOutcome: CompletedTurnSemanticOutcome,
): string {
  if (decision) {
    return JSON.stringify({
      scope: "completed-turn-hook",
      semanticPhase: decision.hookMetadata.semanticPhase,
      semanticSummary: decision.hookMetadata.semanticSummary || "",
      semanticQuestion: decision.hookMetadata.semanticQuestion || "",
      semanticNotificationEvent: decision.hookMetadata.semanticNotificationEvent,
      semanticClassifierEvent: decision.hookMetadata.semanticClassifierEvent || "",
      replyOriginPlatform: decision.hookMetadata.replyOriginPlatform || "",
    });
  }

  return JSON.stringify({
    scope: "completed-turn-hook",
    semanticKind: semanticOutcome.kind,
    summary: semanticOutcome.summary || "",
    question: semanticOutcome.question || "",
    classifierEvent: semanticOutcome.notificationEvent || "",
  });
}

export function planCompletedTurnNotification(input: {
  semanticOutcome: CompletedTurnSemanticOutcome;
  replyOrigin?: CompletedTurnReplyOrigin | null;
  turnId?: string;
  assistantText?: string;
  notificationConfig?: Pick<FullNotificationConfig, "completedTurn"> | null;
}): CompletedTurnNotificationDecision | null {
  const { semanticOutcome } = input;
  const replyOrigin = input.replyOrigin ?? null;
  const hasAssistantText =
    typeof input.assistantText === "string"
    && input.assistantText.trim().length > 0;
  const semanticEvent = semanticOutcome.notificationEvent === "result-ready"
    || semanticOutcome.notificationEvent === "ask-user-question"
    ? semanticOutcome.notificationEvent
    : undefined;
  const explicitInputNeeded =
    semanticOutcome.kind === "input-needed"
    && semanticOutcome.notificationEvent === "ask-user-question";
  const canPromoteReplyOriginTurn = replyOrigin
    && (semanticOutcome.kind === "noise" || semanticOutcome.kind === "progress");
  const effectiveEvent: CompletedTurnEffectiveEvent | undefined =
    explicitInputNeeded
      ? "ask-user-question"
      : hasAssistantText
        ? "result-ready"
        : semanticEvent
          ?? (canPromoteReplyOriginTurn ? "result-ready" : undefined);

  if (!effectiveEvent) {
    return null;
  }

  const decision: CompletedTurnNotificationDecision = {
    effectiveEvent,
    effectiveFingerprint: "",
    hookMetadata: {
      semanticPhase: semanticOutcome.kind,
      semanticSummary: semanticOutcome.summary || null,
      semanticQuestion: semanticOutcome.question || null,
      semanticNotificationEvent: effectiveEvent,
      semanticClassifierEvent: semanticOutcome.notificationEvent || null,
      replyOriginPlatform: replyOrigin?.platform || null,
    },
    semanticOutcome,
    replyOrigin,
    transportPolicy: buildCompletedTurnTransportPolicy(
      effectiveEvent,
      input.notificationConfig,
    ),
  };

  decision.effectiveFingerprint = buildCompletedTurnFingerprint({
    effectiveEvent: decision.effectiveEvent,
    semanticOutcome: decision.semanticOutcome,
    replyOrigin: decision.replyOrigin,
    turnId: input.turnId,
  });

  return decision;
}

export function renderCompletedTurnMessage(
  policy: CompletedTurnTransportRenderPolicy,
  payload: FullNotificationPayload,
  assistantText: string,
): string {
  return resolveCompletedTurnRenderedMessage(
    policy,
    payload,
    assistantText,
  ).message;
}

export function buildCompletedTurnTransportOverrides(
  decision: CompletedTurnNotificationDecision,
  payload: FullNotificationPayload,
  assistantText: string,
  enabledPlatforms?: readonly NotificationPlatform[],
): NotificationTransportOverrides | undefined {
  if (!decision.transportPolicy.overrides) {
    return undefined;
  }

  const enabledPlatformSet = enabledPlatforms
    ? new Set<NotificationPlatform>(enabledPlatforms)
    : null;
  const overrides = Object.entries(decision.transportPolicy.overrides).reduce<
    NotificationTransportOverrides
  >((acc, [platform, policy]) => {
    const notificationPlatform = platform as NotificationPlatform;
    if (!policy || (enabledPlatformSet && !enabledPlatformSet.has(notificationPlatform))) {
      return acc;
    }

    const rendered = resolveCompletedTurnRenderedMessage(
      policy,
      payload,
      assistantText,
      notificationPlatform,
    );
    acc[notificationPlatform] = {
      message: rendered.message,
      ...(Object.prototype.hasOwnProperty.call(rendered, "parseMode")
        ? { parseMode: rendered.parseMode }
        : {}),
      ...(rendered.entities ? { entities: rendered.entities } : {}),
    };
    return acc;
  }, {});

  return Object.keys(overrides).length > 0 ? overrides : undefined;
}
