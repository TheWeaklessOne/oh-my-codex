import { createHash } from "node:crypto";
import type { FullNotificationPayload, TelegramNotificationConfig } from "./types.js";
import { sendTelegramMessageDraft } from "./dispatcher.js";
import {
  appendTelegramProgressEntry,
  isTelegramProgressDraftEnabled,
  renderTelegramProgressDraft,
  writeTelegramProgressTrace,
  type AppendTelegramProgressEntryOptions,
  type ProgressTraceEntry,
  type TelegramProgressTraceState,
} from "./telegram-progress.js";
import type { TelegramTopicResolutionDeps } from "./telegram-topics.js";

export interface TelegramProgressRuntimeLogEntry {
  type: string;
  [key: string]: unknown;
}

export interface RecordTelegramProgressRuntimeOptions {
  projectPath: string;
  sessionId: string;
  turnId: string;
  telegramConfig: TelegramNotificationConfig;
  entry: Partial<ProgressTraceEntry>;
  payload?: Partial<FullNotificationPayload>;
  appendOptions?: AppendTelegramProgressEntryOptions;
  deps?: TelegramTopicResolutionDeps;
  now?: Date;
  log?: (entry: TelegramProgressRuntimeLogEntry) => void | Promise<void>;
}

export function deriveTelegramProgressDraftId(sessionId: string, turnId: string): number {
  const digest = createHash("sha256").update(`${sessionId}:${turnId}`).digest();
  const value = digest.readUInt32BE(0) & 0x7fffffff;
  return value === 0 ? 1 : value;
}

function parseIsoMs(value: string | undefined): number {
  if (!value) return Number.NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

async function logProgress(
  options: Pick<RecordTelegramProgressRuntimeOptions, "log">,
  entry: TelegramProgressRuntimeLogEntry,
): Promise<void> {
  await options.log?.(entry);
}

function buildDraftPayload(options: RecordTelegramProgressRuntimeOptions): FullNotificationPayload {
  return {
    event: "result-ready",
    sessionId: options.sessionId,
    message: "",
    timestamp: (options.now ?? new Date()).toISOString(),
    projectPath: options.projectPath,
    ...(options.payload ?? {}),
  };
}

async function updateDraftState(
  projectPath: string,
  state: TelegramProgressTraceState,
  patch: Partial<Pick<TelegramProgressTraceState, "lastDraftText" | "lastDraftAt" | "draftFailureUntil">>,
): Promise<void> {
  await writeTelegramProgressTrace(projectPath, {
    ...state,
    ...patch,
    updatedAt: new Date().toISOString(),
  });
}

export async function recordTelegramProgressEntryAndMaybeDraft(
  options: RecordTelegramProgressRuntimeOptions,
): Promise<{ appended: boolean; draftSent: boolean; state: TelegramProgressTraceState }> {
  const now = options.now ?? new Date();
  const { appended, state } = await appendTelegramProgressEntry(
    options.projectPath,
    options.sessionId,
    options.turnId,
    options.entry,
    {
      ...options.appendOptions,
      now,
      maxEntries: options.appendOptions?.maxEntries ?? options.telegramConfig.progress?.maxStoredEntries,
    },
  );

  if (!appended) {
    await logProgress(options, {
      type: "telegram_progress_entry_deduped",
      session_id: options.sessionId,
      turn_id: options.turnId,
    });
    return { appended: false, draftSent: false, state };
  }

  await logProgress(options, {
    type: "telegram_progress_entry_recorded",
    kind: options.entry.kind,
    session_id: options.sessionId,
    turn_id: options.turnId,
  });

  const progressConfig = options.telegramConfig.progress;
  if (!isTelegramProgressDraftEnabled(progressConfig)) {
    await logProgress(options, {
      type: "telegram_progress_draft_suppressed",
      reason: "disabled",
      session_id: options.sessionId,
      turn_id: options.turnId,
    });
    return { appended: true, draftSent: false, state };
  }

  const failureUntilMs = parseIsoMs(state.draftFailureUntil);
  if (Number.isFinite(failureUntilMs) && failureUntilMs > now.getTime()) {
    await logProgress(options, {
      type: "telegram_progress_draft_suppressed",
      reason: "failure-cache",
      session_id: options.sessionId,
      turn_id: options.turnId,
    });
    return { appended: true, draftSent: false, state };
  }

  const minIntervalMs = progressConfig?.minUpdateIntervalMs ?? 1_000;
  const lastDraftAtMs = parseIsoMs(state.lastDraftAt);
  if (Number.isFinite(lastDraftAtMs) && now.getTime() - lastDraftAtMs < minIntervalMs) {
    await logProgress(options, {
      type: "telegram_progress_draft_suppressed",
      reason: "throttled",
      session_id: options.sessionId,
      turn_id: options.turnId,
    });
    return { appended: true, draftSent: false, state };
  }

  const text = renderTelegramProgressDraft(state, {
    maxChars: progressConfig?.maxDraftChars,
    now,
  });
  if (!text || text === state.lastDraftText) {
    await logProgress(options, {
      type: "telegram_progress_draft_suppressed",
      reason: text ? "unchanged" : "empty",
      session_id: options.sessionId,
      turn_id: options.turnId,
    });
    return { appended: true, draftSent: false, state };
  }

  const result = await sendTelegramMessageDraft(
    options.telegramConfig,
    buildDraftPayload(options),
    {
      draftId: deriveTelegramProgressDraftId(options.sessionId, options.turnId),
      text,
    },
    options.deps ?? {},
  );

  if (result.sent) {
    await updateDraftState(options.projectPath, state, {
      lastDraftText: text,
      lastDraftAt: now.toISOString(),
    });
    await logProgress(options, {
      type: "telegram_progress_draft_sent",
      session_id: options.sessionId,
      turn_id: options.turnId,
      chars: text.length,
    });
    return { appended: true, draftSent: true, state };
  }

  const failurePatch = result.error
    ? { draftFailureUntil: new Date(now.getTime() + 10 * 60_000).toISOString() }
    : {};
  if (Object.keys(failurePatch).length > 0) {
    await updateDraftState(options.projectPath, state, failurePatch);
  }
  await logProgress(options, {
    type: "telegram_progress_draft_suppressed",
    reason: result.suppressedReason ?? "send-failed",
    error: result.error,
    session_id: options.sessionId,
    turn_id: options.turnId,
  });
  return { appended: true, draftSent: false, state };
}
