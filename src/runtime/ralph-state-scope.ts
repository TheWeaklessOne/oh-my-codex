import { existsSync } from "fs";
import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { dirname, join } from "path";

import { omxStateDir } from "../utils/paths.js";

const RALPH_TERMINAL_PHASES = new Set([
  "blocked_on_user",
  "complete",
  "failed",
  "cancelled",
]);
const SESSION_ID_SAFE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function safeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const normalized = safeString(value);
    if (normalized) return normalized;
  }
  return "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function readJsonRecord(path: string): Promise<Record<string, unknown> | null> {
  try {
    return asRecord(JSON.parse(await readFile(path, "utf-8")));
  } catch {
    return null;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(tempPath, JSON.stringify(value, null, 2));
  await rename(tempPath, path);
}

export function isTerminalRalphState(state: Record<string, unknown> | null): boolean {
  if (!state) return false;
  const phase = safeString(state.current_phase).toLowerCase();
  const runOutcome = safeString(state.run_outcome).toLowerCase();
  return state.active === false
    && (
      RALPH_TERMINAL_PHASES.has(phase)
      || runOutcome === "finish"
      || runOutcome === "failed"
      || runOutcome === "cancelled"
      || runOutcome === "blocked_on_user"
    );
}

function isActiveNonTerminalRalphState(state: Record<string, unknown> | null): boolean {
  if (!state) return false;
  return state.active === true && !isTerminalRalphState(state);
}

function stateSessionAffinity(state: Record<string, unknown> | null): string {
  if (!state) return "";
  return firstString(
    state.owner_omx_session_id,
    state.session_id,
    state.omx_session_id,
  );
}

export async function reconcileRalphTerminalStateScope(
  cwd: string,
  sessionId: string | undefined,
): Promise<{
  reconciled: boolean;
  reason: string;
  rootPath?: string;
  sessionPath?: string;
}> {
  const normalizedSessionId = safeString(sessionId);
  if (!normalizedSessionId) {
    return { reconciled: false, reason: "session_id_missing" };
  }
  if (!SESSION_ID_SAFE_PATTERN.test(normalizedSessionId)) {
    return { reconciled: false, reason: "session_id_invalid" };
  }

  const stateDir = omxStateDir(cwd);
  const rootPath = join(stateDir, "ralph-state.json");
  const sessionPath = join(stateDir, "sessions", normalizedSessionId, "ralph-state.json");
  if (!existsSync(rootPath) || !existsSync(sessionPath)) {
    return { reconciled: false, reason: "ralph_state_pair_missing", rootPath, sessionPath };
  }

  const rootState = await readJsonRecord(rootPath);
  const sessionState = await readJsonRecord(sessionPath);
  if (!isTerminalRalphState(rootState)) {
    return { reconciled: false, reason: "root_ralph_not_terminal", rootPath, sessionPath };
  }
  const rootAffinity = stateSessionAffinity(rootState);
  if (!rootAffinity) {
    return { reconciled: false, reason: "root_ralph_session_affinity_missing", rootPath, sessionPath };
  }
  if (rootAffinity && rootAffinity !== normalizedSessionId) {
    return { reconciled: false, reason: "root_ralph_session_affinity_mismatch", rootPath, sessionPath };
  }
  const sessionAffinity = stateSessionAffinity(sessionState);
  if (sessionAffinity && sessionAffinity !== normalizedSessionId) {
    return { reconciled: false, reason: "session_ralph_session_affinity_mismatch", rootPath, sessionPath };
  }
  if (!isActiveNonTerminalRalphState(sessionState)) {
    return { reconciled: false, reason: "session_ralph_not_active_nonterminal", rootPath, sessionPath };
  }

  const nowIso = new Date().toISOString();
  await writeJsonAtomic(sessionPath, {
    ...sessionState,
    ...rootState,
    owner_omx_session_id: normalizedSessionId,
    session_scope_reconciled_from: "root-terminal",
    session_scope_reconciled_at: nowIso,
    updated_at: nowIso,
  });

  return {
    reconciled: true,
    reason: "session_scope_terminal_synced_from_root",
    rootPath,
    sessionPath,
  };
}
