import { formatNotification } from "./formatter.js";
import type {
  FullNotificationPayload,
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

export type CompletedTurnRenderMode =
  | "formatted-notification"
  | "raw-assistant-text";

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

function buildCompletedTurnFingerprint(
  decision: Pick<
    CompletedTurnNotificationDecision,
    "effectiveEvent" | "semanticOutcome" | "replyOrigin"
  > & {
    turnId?: string;
  },
): string {
  if (decision.replyOrigin && decision.turnId) {
    return JSON.stringify({
      scope: "completed-turn",
      policy: "reply-origin-per-turn",
      effectiveEvent: decision.effectiveEvent,
      replyOriginPlatform: decision.replyOrigin.platform,
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
}): CompletedTurnNotificationDecision | null {
  const { semanticOutcome } = input;
  const replyOrigin = input.replyOrigin ?? null;
  const semanticEvent =
    semanticOutcome.notificationEvent === "result-ready"
    || semanticOutcome.notificationEvent === "ask-user-question"
      ? semanticOutcome.notificationEvent
      : undefined;
  const canPromoteReplyOriginTurn = replyOrigin
    && (semanticOutcome.kind === "noise" || semanticOutcome.kind === "progress");
  const effectiveEvent: CompletedTurnEffectiveEvent | undefined =
    semanticEvent
    ?? (canPromoteReplyOriginTurn ? "result-ready" : undefined);

  if (!effectiveEvent) {
    return null;
  }

  const transportPolicy: CompletedTurnNotificationDecision["transportPolicy"] = {
    default: { mode: "formatted-notification" },
  };

  if (replyOrigin?.platform === "telegram" && effectiveEvent === "result-ready") {
    transportPolicy.overrides = {
      telegram: {
        mode: "raw-assistant-text",
        parseMode: null,
      },
    };
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
    transportPolicy,
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
  if (policy.mode === "raw-assistant-text") {
    return assistantText;
  }

  return formatNotification(payload);
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

    acc[platform as NotificationPlatform] = {
      message: renderCompletedTurnMessage(policy, payload, assistantText),
      ...(Object.prototype.hasOwnProperty.call(policy, "parseMode")
        ? { parseMode: policy.parseMode }
        : {}),
    };
    return acc;
  }, {});

  return Object.keys(overrides).length > 0 ? overrides : undefined;
}
