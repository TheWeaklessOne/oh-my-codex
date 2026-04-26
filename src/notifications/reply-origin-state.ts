import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import type { CompletedTurnReplyOrigin } from "./completed-turn.js";
import { omxStateDir } from "../utils/paths.js";

const SESSION_ID_SAFE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/;
const REPLY_ORIGIN_STATE_FILE = "reply-origin.json";
const REPLY_ORIGIN_STATE_VERSION = 1;
const MAX_PENDING_REPLY_ORIGINS = 32;

function getReplyOriginStatePath(
  projectPath: string,
  sessionId: string,
): string {
  return join(
    omxStateDir(projectPath),
    "sessions",
    sessionId,
    REPLY_ORIGIN_STATE_FILE,
  );
}

function isSafeSessionId(sessionId: string | undefined): sessionId is string {
  return !!sessionId && SESSION_ID_SAFE_PATTERN.test(sessionId);
}

function normalizePendingReplyOrigin(
  value: unknown,
): CompletedTurnReplyOrigin | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const platform = raw.platform === "telegram" || raw.platform === "discord"
    ? raw.platform
    : null;
  const injectedInput = typeof raw.injectedInput === "string"
    ? raw.injectedInput
    : "";
  const createdAt = typeof raw.createdAt === "string"
    ? raw.createdAt
    : "";
  const rawTelegramAck =
    raw.telegramAck && typeof raw.telegramAck === "object" && !Array.isArray(raw.telegramAck)
      ? raw.telegramAck as Record<string, unknown>
      : null;
  const telegramAck =
    rawTelegramAck
    && typeof rawTelegramAck.chatId === "string"
    && rawTelegramAck.chatId.trim()
    && typeof rawTelegramAck.messageId === "string"
    && rawTelegramAck.messageId.trim()
      ? {
          chatId: rawTelegramAck.chatId,
          messageId: rawTelegramAck.messageId,
          ...(typeof rawTelegramAck.messageThreadId === "string" && rawTelegramAck.messageThreadId.trim()
            ? { messageThreadId: rawTelegramAck.messageThreadId }
            : {}),
        }
      : undefined;

  if (!platform || !injectedInput || !createdAt) {
    return null;
  }

  return {
    platform,
    injectedInput,
    createdAt,
    ...(platform === "telegram" && telegramAck ? { telegramAck } : {}),
  };
}

function normalizePendingReplyOrigins(value: unknown): CompletedTurnReplyOrigin[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const raw = value as Record<string, unknown>;
  if (Array.isArray(raw.pending)) {
    return raw.pending
      .map((entry) => normalizePendingReplyOrigin(entry))
      .filter((entry): entry is CompletedTurnReplyOrigin => entry !== null);
  }

  const legacyEntry = normalizePendingReplyOrigin(value);
  return legacyEntry ? [legacyEntry] : [];
}

async function readPendingReplyOrigins(
  targetPath: string,
): Promise<CompletedTurnReplyOrigin[]> {
  try {
    const raw = JSON.parse(await readFile(targetPath, "utf-8")) as unknown;
    return normalizePendingReplyOrigins(raw);
  } catch {
    return [];
  }
}

async function writePendingReplyOrigins(
  targetPath: string,
  pendingOrigins: CompletedTurnReplyOrigin[],
): Promise<void> {
  if (pendingOrigins.length === 0) {
    await rm(targetPath, { force: true }).catch(() => {});
    return;
  }

  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, JSON.stringify({
    version: REPLY_ORIGIN_STATE_VERSION,
    pending: pendingOrigins,
  }, null, 2));
}

export async function recordPendingReplyOrigin(
  projectPath: string | undefined,
  sessionId: string | undefined,
  pending: Omit<CompletedTurnReplyOrigin, "createdAt"> & {
    createdAt?: string;
  },
): Promise<void> {
  if (!projectPath || !isSafeSessionId(sessionId)) {
    return;
  }

  const targetPath = getReplyOriginStatePath(projectPath, sessionId);
  const pendingOrigins = await readPendingReplyOrigins(targetPath);
  pendingOrigins.push({
    platform: pending.platform,
    injectedInput: pending.injectedInput,
    createdAt: pending.createdAt || new Date().toISOString(),
    ...(pending.platform === "telegram" && pending.telegramAck
      ? { telegramAck: pending.telegramAck }
      : {}),
  });
  const nextPendingOrigins = pendingOrigins.slice(-MAX_PENDING_REPLY_ORIGINS);
  await writePendingReplyOrigins(targetPath, nextPendingOrigins);
}

export async function consumePendingReplyOrigin(
  projectPath: string | undefined,
  sessionId: string | undefined,
  latestInput: string,
): Promise<CompletedTurnReplyOrigin | null> {
  if (!projectPath || !isSafeSessionId(sessionId)) {
    return null;
  }

  const targetPath = getReplyOriginStatePath(projectPath, sessionId);
  const pendingOrigins = await readPendingReplyOrigins(targetPath);
  if (pendingOrigins.length === 0) {
    return null;
  }

  const matchIndex = pendingOrigins.findIndex(
    (pending) => pending.injectedInput.trim() === latestInput.trim(),
  );
  if (matchIndex === -1) {
    return null;
  }

  const [matchedPending] = pendingOrigins.splice(matchIndex, 1);
  await writePendingReplyOrigins(targetPath, pendingOrigins);
  return matchedPending ?? null;
}
