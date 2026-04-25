import { formatNotification } from "./formatter.js";
import type {
  CompletedTurnPresentationConfig,
  CompletedTurnRenderMode,
  FullNotificationPayload,
  FullNotificationConfig,
  NotificationEvent,
  NotificationPlatform,
  NotificationTransportOverrides,
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

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

function shouldFallbackToFormattedNotification(
  policy: CompletedTurnTransportRenderPolicy,
  assistantText: string,
  platform?: NotificationPlatform,
): boolean {
  if (policy.mode !== "raw-assistant-text") {
    return false;
  }

  if (assistantText.trim().length === 0) {
    return true;
  }

  return (
    platform === "telegram"
    && Array.from(assistantText).length > TELEGRAM_MAX_MESSAGE_LENGTH
  );
}

function resolveCompletedTurnRenderedMessage(
  policy: CompletedTurnTransportRenderPolicy,
  payload: FullNotificationPayload,
  assistantText: string,
  platform?: NotificationPlatform,
): { message: string; parseMode?: "Markdown" | "HTML" | null } {
  if (
    policy.mode === "raw-assistant-text"
    && !shouldFallbackToFormattedNotification(policy, assistantText, platform)
  ) {
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

function buildTransportRenderPolicy(
  mode: CompletedTurnRenderMode,
  platform?: NotificationPlatform,
): CompletedTurnTransportRenderPolicy {
  return {
    mode,
    ...(platform === "telegram" && mode === "raw-assistant-text"
      ? { parseMode: null }
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
      );
      if (
        platformPolicy.mode !== defaultPolicy.mode
        || Object.prototype.hasOwnProperty.call(platformPolicy, "parseMode")
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
): NotificationTransportOverrides | undefined {
  if (!decision.transportPolicy.overrides) {
    return undefined;
  }

  const overrides = Object.entries(decision.transportPolicy.overrides).reduce<
    NotificationTransportOverrides
  >((acc, [platform, policy]) => {
    if (!policy) {
      return acc;
    }

    const rendered = resolveCompletedTurnRenderedMessage(
      policy,
      payload,
      assistantText,
      platform as NotificationPlatform,
    );
    acc[platform as NotificationPlatform] = {
      message: rendered.message,
      ...(Object.prototype.hasOwnProperty.call(rendered, "parseMode")
        ? { parseMode: rendered.parseMode }
        : {}),
    };
    return acc;
  }, {});

  return Object.keys(overrides).length > 0 ? overrides : undefined;
}
