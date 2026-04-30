import { readFile } from "fs/promises";

import type { ActorTurnLifecycleStatus } from "./session-ownership.js";

export interface CodexTranscriptLifecycleSummary {
  sessionMeta?: Record<string, unknown>;
  contextCwd?: string;
  startedTurnCount: number;
  completedTurnCount: number;
  abortedTurnCount: number;
  lastTurnStatus?: ActorTurnLifecycleStatus;
  lastTurnId?: string;
  lastLifecycleEventAt?: string;
}

const TRANSCRIPT_LIFECYCLE_LINE_LIMIT = 2_000;

function safeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const normalized = safeString(value);
    if (normalized) return normalized;
  }
  return "";
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(line) as unknown);
  } catch {
    return null;
  }
}

function readTurnId(record: Record<string, unknown>): string {
  const payload = asRecord(record.payload);
  return firstString(
    record.turn_id,
    record.turnId,
    payload?.turn_id,
    payload?.turnId,
    payload?.id,
  );
}

export async function readCodexTranscriptLifecycle(
  transcriptPath: string | undefined,
): Promise<CodexTranscriptLifecycleSummary | null> {
  const normalizedPath = safeString(transcriptPath);
  if (!normalizedPath) return null;
  const content = await readFile(normalizedPath, "utf-8").catch(() => "");
  if (!content) return null;

  const summary: CodexTranscriptLifecycleSummary = {
    startedTurnCount: 0,
    completedTurnCount: 0,
    abortedTurnCount: 0,
  };

  const lines = content.split(/\r?\n/).slice(0, TRANSCRIPT_LIFECYCLE_LINE_LIMIT);
  for (const line of lines) {
    if (!line.trim()) continue;
    const record = parseJsonLine(line);
    if (!record) continue;
    const outerType = safeString(record.type);
    const lifecycleRecord = outerType === "event_msg"
      ? asRecord(record.payload) ?? record
      : record;
    const type = safeString(lifecycleRecord.type);
    const timestamp = firstString(
      lifecycleRecord.timestamp,
      lifecycleRecord.time,
      lifecycleRecord.created_at,
      record.timestamp,
      record.time,
      record.created_at,
    );
    if (type === "session_meta") {
      const payload = asRecord(lifecycleRecord.payload);
      if (payload) {
        summary.sessionMeta = payload;
        const cwd = firstString(payload.cwd);
        if (cwd) summary.contextCwd = cwd;
      }
      continue;
    }

    if (type === "task_started") {
      summary.startedTurnCount += 1;
      summary.lastTurnStatus = "started";
      const turnId = readTurnId(lifecycleRecord);
      if (turnId) summary.lastTurnId = turnId;
      if (timestamp) summary.lastLifecycleEventAt = timestamp;
      continue;
    }

    if (type === "turn_aborted") {
      summary.abortedTurnCount += 1;
      summary.lastTurnStatus = "aborted";
      const turnId = readTurnId(lifecycleRecord);
      if (turnId) summary.lastTurnId = turnId;
      if (timestamp) summary.lastLifecycleEventAt = timestamp;
      continue;
    }

    if (type === "task_complete") {
      summary.completedTurnCount += 1;
      summary.lastTurnStatus = "completed";
      const turnId = readTurnId(lifecycleRecord);
      if (turnId) summary.lastTurnId = turnId;
      if (timestamp) summary.lastLifecycleEventAt = timestamp;
    }
  }

  if (
    !summary.sessionMeta
    && summary.startedTurnCount === 0
    && summary.completedTurnCount === 0
    && summary.abortedTurnCount === 0
  ) {
    return null;
  }

  return summary;
}
