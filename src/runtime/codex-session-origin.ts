import { existsSync } from "fs";
import { mkdir, readFile, readdir, stat, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { homedir } from "os";
import {
  resolveTurnOrigin,
  type TurnOrigin,
  type TurnOriginKind,
} from "../notifications/turn-origin.js";
import { readSubagentTrackingState } from "../subagents/tracker.js";

export type TurnAudience =
  | "external-owner"
  | "child"
  | "team-worker"
  | "internal-helper"
  | "unknown-non-owner";

export type ExternalDeliveryDecision = "allow" | "suppress";

export interface OriginEvidence {
  source: string;
  detail: string;
}

export interface CurrentSessionStateLike {
  session_id?: string;
  native_session_id?: string;
  cwd?: string;
}

export interface CodexSessionOriginIndexEntry {
  thread_id: string;
  origin_kind: TurnOriginKind;
  audience: TurnAudience;
  parent_thread_id?: string;
  native_session_id?: string;
  agent_nickname?: string;
  agent_role?: string;
  cwd?: string;
  first_seen_at: string;
  last_seen_at: string;
  evidence: string[];
}

export interface CodexSessionOriginIndex {
  schemaVersion: 1;
  sessions: Record<string, CodexSessionOriginIndexEntry>;
}

export interface SessionStartOriginResolution {
  origin: TurnOrigin;
  audience: TurnAudience;
  ownerKind: TurnAudience;
  reason: string;
  evidence: OriginEvidence[];
}

export interface NotificationOriginResolution {
  origin: TurnOrigin;
  audience: TurnAudience;
  delivery: ExternalDeliveryDecision;
  reason: string;
  evidence: OriginEvidence[];
  sessionMeta?: Record<string, unknown>;
}

export interface ResolveTurnOriginForNotificationInput {
  cwd: string;
  stateDir?: string;
  payload: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  currentSessionState?: CurrentSessionStateLike | null;
  currentOmxSessionId?: string;
}

export interface DiscoverRecentCodexRolloutFilesInput {
  env?: NodeJS.ProcessEnv;
  now?: Date;
  startedAt?: number;
  fileWindowMs?: number;
}

const INDEX_FILE = "codex-session-origin-index.json";
const MAX_INDEX_ENTRIES = 500;
const INDEX_ENTRY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ROLLOUT_SCAN_LIMIT = 240;
const ROLLOUT_META_LINE_LIMIT = 80;

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

function appendEvidence(
  evidence: OriginEvidence[],
  seen: Set<string>,
  source: string,
  detail: string,
): void {
  const normalizedSource = source.trim();
  const normalizedDetail = detail.trim();
  if (!normalizedSource || !normalizedDetail) return;
  const key = `${normalizedSource}:${normalizedDetail}`;
  if (seen.has(key)) return;
  seen.add(key);
  evidence.push({ source: normalizedSource, detail: normalizedDetail });
}

function sanitizeEvidenceDetail(source: string, detail: string): string {
  if (source === "rollout-path") {
    return `basename=${detail.split(/[\\/]/).pop() || "rollout"}`;
  }
  return detail;
}

function evidenceSources(evidence: OriginEvidence[]): string[] {
  return Array.from(new Set(evidence.map((entry) => entry.source).filter(Boolean)));
}

function payloadThreadId(payload: Record<string, unknown>): string {
  return firstString(
    payload["thread-id"],
    payload.thread_id,
    payload.threadId,
    payload.id,
  );
}

function payloadSessionId(payload: Record<string, unknown>): string {
  return firstString(
    payload.session_id,
    payload.sessionId,
    payload["session-id"],
    payload.native_session_id,
    payload.nativeSessionId,
  );
}

function payloadTranscriptPath(payload: Record<string, unknown>): string {
  return firstString(
    payload.transcript_path,
    payload.transcriptPath,
    payload["transcript-path"],
  );
}

function originThreadId(origin: TurnOrigin): string {
  return firstString(origin.threadId, origin.nativeSessionId);
}

function originIndexPath(cwd: string, stateDir?: string): string {
  return join(stateDir || join(cwd, ".omx", "state"), INDEX_FILE);
}

function stateRootFromStateDir(cwd: string, stateDir?: string): string {
  const normalizedStateDir = safeString(stateDir);
  if (normalizedStateDir) {
    return dirname(dirname(normalizedStateDir));
  }
  return cwd;
}

function createEmptyIndex(): CodexSessionOriginIndex {
  return {
    schemaVersion: 1,
    sessions: {},
  };
}

function normalizeOriginKind(value: unknown): TurnOriginKind {
  const normalized = safeString(value).toLowerCase();
  if (normalized === "leader") return "leader";
  if (normalized === "native-subagent") return "native-subagent";
  if (normalized === "team-worker") return "team-worker";
  if (normalized === "internal-helper") return "internal-helper";
  return "unknown";
}

function normalizeAudience(value: unknown): TurnAudience {
  const normalized = safeString(value).toLowerCase();
  if (normalized === "external-owner") return "external-owner";
  if (normalized === "child") return "child";
  if (normalized === "team-worker") return "team-worker";
  if (normalized === "internal-helper") return "internal-helper";
  return "unknown-non-owner";
}

function normalizeIndexEntry(
  key: string,
  value: unknown,
): CodexSessionOriginIndexEntry | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const threadId = firstString(raw.thread_id, raw.threadId, key);
  if (!threadId) return null;
  const firstSeenAt = firstString(raw.first_seen_at, raw.firstSeenAt, raw.last_seen_at, raw.lastSeenAt)
    || new Date(0).toISOString();
  const lastSeenAt = firstString(raw.last_seen_at, raw.lastSeenAt, firstSeenAt);
  const rawEvidence = Array.isArray(raw.evidence)
    ? raw.evidence.map((entry) => safeString(entry)).filter(Boolean)
    : [];

  return {
    thread_id: threadId,
    origin_kind: normalizeOriginKind(raw.origin_kind ?? raw.originKind),
    audience: normalizeAudience(raw.audience),
    ...(firstString(raw.parent_thread_id, raw.parentThreadId)
      ? { parent_thread_id: firstString(raw.parent_thread_id, raw.parentThreadId) }
      : {}),
    ...(firstString(raw.native_session_id, raw.nativeSessionId)
      ? { native_session_id: firstString(raw.native_session_id, raw.nativeSessionId) }
      : {}),
    ...(firstString(raw.agent_nickname, raw.agentNickname)
      ? { agent_nickname: firstString(raw.agent_nickname, raw.agentNickname) }
      : {}),
    ...(firstString(raw.agent_role, raw.agentRole)
      ? { agent_role: firstString(raw.agent_role, raw.agentRole) }
      : {}),
    ...(firstString(raw.cwd) ? { cwd: firstString(raw.cwd) } : {}),
    first_seen_at: firstSeenAt,
    last_seen_at: lastSeenAt,
    evidence: rawEvidence,
  };
}

function normalizeIndex(raw: unknown, nowMs = Date.now()): CodexSessionOriginIndex {
  const parsed = asRecord(raw);
  if (!parsed) return createEmptyIndex();
  const rawSessions = asRecord(parsed.sessions);
  if (!rawSessions) return createEmptyIndex();

  const minLastSeenAt = nowMs - INDEX_ENTRY_TTL_MS;
  const entries = Object.entries(rawSessions)
    .map(([key, value]) => [key, normalizeIndexEntry(key, value)] as const)
    .filter((entry): entry is readonly [string, CodexSessionOriginIndexEntry] => {
      const normalized = entry[1];
      if (!normalized) return false;
      const lastSeenMs = Date.parse(normalized.last_seen_at);
      return !Number.isFinite(lastSeenMs) || lastSeenMs >= minLastSeenAt;
    })
    .sort((left, right) =>
      Date.parse(right[1].last_seen_at) - Date.parse(left[1].last_seen_at),
    )
    .slice(0, MAX_INDEX_ENTRIES);

  return {
    schemaVersion: 1,
    sessions: Object.fromEntries(entries),
  };
}

export async function readCodexSessionOriginIndex(
  cwd: string,
  stateDir?: string,
): Promise<CodexSessionOriginIndex> {
  const path = originIndexPath(cwd, stateDir);
  const content = await readFile(path, "utf-8").catch(() => "");
  if (!content) return createEmptyIndex();
  try {
    return normalizeIndex(JSON.parse(content) as unknown);
  } catch {
    return createEmptyIndex();
  }
}

async function writeCodexSessionOriginIndex(
  cwd: string,
  index: CodexSessionOriginIndex,
  stateDir?: string,
): Promise<void> {
  const path = originIndexPath(cwd, stateDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(normalizeIndex(index), null, 2));
}

function indexEntryToOrigin(entry: CodexSessionOriginIndexEntry): TurnOrigin {
  return {
    kind: entry.origin_kind,
    threadId: entry.thread_id,
    ...(entry.parent_thread_id ? { parentThreadId: entry.parent_thread_id } : {}),
    ...(entry.native_session_id ? { nativeSessionId: entry.native_session_id } : {}),
    ...(entry.agent_nickname ? { agentNickname: entry.agent_nickname } : {}),
    ...(entry.agent_role ? { agentRole: entry.agent_role } : {}),
    source: "codex-session-origin-index",
  };
}

function lookupIndexEntry(
  index: CodexSessionOriginIndex,
  ids: string[],
  cwd: string,
): CodexSessionOriginIndexEntry | null {
  for (const id of ids.map((value) => value.trim()).filter(Boolean)) {
    const entry = index.sessions[id];
    if (!entry) continue;
    if (entry.cwd && entry.cwd !== cwd) continue;
    return entry;
  }
  return null;
}

function originIndexLookupIds(input: {
  payloadThreadId: string;
  payloadSessionId: string;
  origin: TurnOrigin;
}): string[] {
  const threadIds = [
    input.payloadThreadId,
    input.origin.threadId ?? "",
  ].map((value) => value.trim()).filter(Boolean);
  if (threadIds.length > 0) {
    return Array.from(new Set(threadIds));
  }
  return Array.from(new Set([
    input.payloadSessionId,
    input.origin.nativeSessionId ?? "",
  ].map((value) => value.trim()).filter(Boolean)));
}

function audienceFromOriginKind(kind: TurnOriginKind): TurnAudience | "" {
  if (kind === "native-subagent") return "child";
  if (kind === "team-worker") return "team-worker";
  if (kind === "internal-helper") return "internal-helper";
  if (kind === "leader") return "external-owner";
  return "";
}

function originKindCanRepresentCurrentOwner(kind: TurnOriginKind): boolean {
  return kind === "leader" || kind === "unknown";
}

function isOmxExploreSessionMetaPayload(payload: Record<string, unknown>): boolean {
  const originator = safeString(payload.originator).toLowerCase();
  const source = safeString(payload.source).toLowerCase();
  const baseInstructions = asRecord(payload.base_instructions);
  const baseInstructionsText = safeString(baseInstructions?.text || payload.base_instructions);
  return originator === "codex_exec"
    && source === "exec"
    && (
      baseInstructionsText.includes("OMX Explore Lightweight Instructions")
      || baseInstructionsText.includes("executing the `omx explore` command path")
    );
}

function originFromSessionMeta(
  sessionMeta: Record<string, unknown>,
  threadId: string,
  env: NodeJS.ProcessEnv,
): TurnOrigin {
  const parsedOrigin = resolveTurnOrigin({
    session_meta: sessionMeta,
    thread_id: threadId,
  }, env);
  const baseOrigin: TurnOrigin = {
    ...parsedOrigin,
    threadId: parsedOrigin.threadId || threadId,
  };
  if (!isOmxExploreSessionMetaPayload(sessionMeta)) return baseOrigin;
  return {
    ...baseOrigin,
    kind: "internal-helper",
    source: "omx-explore",
  };
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return asRecord(parsed);
  } catch {
    return null;
  }
}

export function parseRolloutSessionMetaLine(
  line: string,
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
  },
): {
  threadId: string;
  sessionMeta: Record<string, unknown>;
  origin: TurnOrigin;
  audience: TurnAudience;
  evidence: OriginEvidence[];
} | null {
  const record = parseJsonLine(line);
  if (!record || record.type !== "session_meta") return null;
  const payload = asRecord(record.payload);
  if (!payload) return null;
  if (safeString(payload.cwd) !== options.cwd) return null;
  const threadId = firstString(payload.id, payload.thread_id, payload.threadId);
  if (!threadId) return null;
  const origin = originFromSessionMeta(payload, threadId, options.env ?? process.env);
  const audience = audienceFromOriginKind(origin.kind) || "unknown-non-owner";
  return {
    threadId,
    sessionMeta: payload,
    origin,
    audience,
    evidence: [{
      source: "rollout-session-meta",
      detail: `thread_id=${threadId}`,
    }],
  };
}

function datePartsUtc(date: Date): string[] {
  return [
    String(date.getUTCFullYear()),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ];
}

function datePartsLocal(date: Date): string[] {
  return [
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ];
}

function addDateDirParts(target: string[][], seen: Set<string>, date: Date): void {
  for (const parts of [datePartsLocal(date), datePartsUtc(date)]) {
    const key = parts.join("-");
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(parts);
  }
}

function candidateDates(now: Date, eventDate?: Date): string[][] {
  const parts: string[][] = [];
  const seen = new Set<string>();
  const seeds = [
    eventDate && Number.isFinite(eventDate.getTime()) ? eventDate : null,
    now,
  ].filter((date): date is Date => !!date);
  for (const seed of seeds) {
    addDateDirParts(parts, seen, seed);
    addDateDirParts(parts, seen, new Date(seed.getTime() - 24 * 60 * 60 * 1000));
    addDateDirParts(parts, seen, new Date(seed.getTime() + 24 * 60 * 60 * 1000));
  }
  return parts;
}

export function codexSessionRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = [
    safeString(env.CODEX_HOME),
    join(safeString(env.HOME) || homedir(), ".codex"),
    join(homedir(), ".codex"),
  ].filter(Boolean);
  return Array.from(new Set(roots));
}

export function codexSessionDateDirs(options: {
  env?: NodeJS.ProcessEnv;
  now?: Date;
  eventDate?: Date;
} = {}): string[] {
  const now = options.now ?? new Date();
  const dateParts = candidateDates(now, options.eventDate);
  return Array.from(new Set(codexSessionRoots(options.env).flatMap((root) =>
    dateParts.map((parts) => join(root, "sessions", ...parts)),
  )));
}

export async function discoverRecentCodexRolloutFiles(
  input: DiscoverRecentCodexRolloutFilesInput = {},
): Promise<string[]> {
  const now = input.now ?? new Date();
  const startedAt = input.startedAt ?? 0;
  const fileWindowMs = input.fileWindowMs ?? 0;
  const eventDate = startedAt > 0 ? new Date(startedAt) : undefined;
  const discovered: Array<{ path: string; mtimeMs: number }> = [];
  for (const dir of codexSessionDateDirs({ env: input.env, now, eventDate })) {
    if (!existsSync(dir)) continue;
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      const st = await stat(path).catch(() => null);
      if (!st) continue;
      if (fileWindowMs > 0 && startedAt > 0 && st.mtimeMs < startedAt - fileWindowMs) continue;
      discovered.push({ path, mtimeMs: st.mtimeMs });
    }
  }
  return discovered
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path))
    .slice(0, ROLLOUT_SCAN_LIMIT)
    .map((entry) => entry.path);
}

async function readRolloutSessionMetaFromPath(
  path: string,
  input: {
    cwd: string;
    threadId?: string;
    env: NodeJS.ProcessEnv;
  },
): Promise<{
  sessionMeta: Record<string, unknown>;
  origin: TurnOrigin;
  evidence: OriginEvidence[];
} | null> {
  const content = await readFile(path, "utf-8").catch(() => "");
  if (!content) return null;
  const normalizedThreadId = safeString(input.threadId);
  if (normalizedThreadId && !content.includes(normalizedThreadId)) return null;
  const lines = content.split("\n").slice(0, ROLLOUT_META_LINE_LIMIT);
  for (const line of lines) {
    if (!line.trim()) continue;
    const parsed = parseRolloutSessionMetaLine(line, {
      cwd: input.cwd,
      env: input.env,
    });
    if (!parsed) continue;
    if (normalizedThreadId && parsed.threadId !== normalizedThreadId) continue;
    return {
      sessionMeta: parsed.sessionMeta,
      origin: parsed.origin,
      evidence: [
        ...parsed.evidence,
        { source: "rollout-path", detail: sanitizeEvidenceDetail("rollout-path", path) },
      ],
    };
  }
  return null;
}

async function resolveOriginFromRollouts(input: {
  cwd: string;
  threadId: string;
  transcriptPath?: string;
  env: NodeJS.ProcessEnv;
  now: Date;
  evidence: OriginEvidence[];
  seenEvidence: Set<string>;
}): Promise<{
  origin: TurnOrigin;
  sessionMeta: Record<string, unknown>;
} | null> {
  const exactPath = safeString(input.transcriptPath);
  if (exactPath) {
    const exact = await readRolloutSessionMetaFromPath(exactPath, {
      cwd: input.cwd,
      threadId: input.threadId,
      env: input.env,
    });
    if (exact) {
      for (const entry of exact.evidence) {
        appendEvidence(input.evidence, input.seenEvidence, entry.source, entry.detail);
      }
      return { origin: exact.origin, sessionMeta: exact.sessionMeta };
    }
    appendEvidence(input.evidence, input.seenEvidence, "transcript-path", "no_matching_session_meta");
  }

  const files = await discoverRecentCodexRolloutFiles({
    env: input.env,
    now: input.now,
  });
  appendEvidence(input.evidence, input.seenEvidence, "rollout-scan", `candidate_files=${files.length}`);
  for (const path of files) {
    const found = await readRolloutSessionMetaFromPath(path, {
      cwd: input.cwd,
      threadId: input.threadId,
      env: input.env,
    });
    if (!found) continue;
    for (const entry of found.evidence) {
      appendEvidence(input.evidence, input.seenEvidence, entry.source, entry.detail);
    }
    return { origin: found.origin, sessionMeta: found.sessionMeta };
  }
  return null;
}

function currentOwnerThreadMatches(input: {
  currentSessionState?: CurrentSessionStateLike | null;
  payloadThreadId: string;
  origin: TurnOrigin;
}): boolean {
  const currentNativeSessionId = safeString(input.currentSessionState?.native_session_id);
  const originThread = originThreadId(input.origin);
  const trustedThreadIds = Array.from(new Set([
    input.payloadThreadId,
    originThread,
  ].map((value) => value.trim()).filter(Boolean)));

  if (currentNativeSessionId && trustedThreadIds.includes(currentNativeSessionId)) {
    return true;
  }
  return false;
}

function payloadSessionOnlyMatchesCurrentOwner(input: {
  currentSessionState?: CurrentSessionStateLike | null;
  currentOmxSessionId?: string;
  payloadSessionId: string;
  origin: TurnOrigin;
}): boolean {
  const currentSessionId = firstString(input.currentOmxSessionId, input.currentSessionState?.session_id);
  const currentNativeSessionId = safeString(input.currentSessionState?.native_session_id);
  const originNative = safeString(input.origin.nativeSessionId);
  const sessionIds = Array.from(new Set([
    input.payloadSessionId,
    originNative,
  ].map((value) => value.trim()).filter(Boolean)));
  return Boolean(
    (currentSessionId && sessionIds.includes(currentSessionId))
    || (currentNativeSessionId && sessionIds.includes(currentNativeSessionId)),
  );
}

function payloadThreadMatchesCurrentOwner(input: {
  currentSessionState?: CurrentSessionStateLike | null;
  payloadThreadId: string;
  origin: TurnOrigin;
}): boolean {
  const currentNativeSessionId = safeString(input.currentSessionState?.native_session_id);
  const payloadThreadId = safeString(input.payloadThreadId);
  const originThread = originThreadId(input.origin);
  return Boolean(payloadThreadId && (
    payloadThreadId === currentNativeSessionId
    || originThread === currentNativeSessionId
  ));
}

function hasKnownCurrentOwner(input: {
  currentSessionState?: CurrentSessionStateLike | null;
  currentOmxSessionId?: string;
}): boolean {
  return Boolean(firstString(input.currentOmxSessionId, input.currentSessionState?.session_id, input.currentSessionState?.native_session_id));
}

async function readTrackedThreadKind(input: {
  cwd: string;
  sessionId: string;
  threadId: string;
}): Promise<"leader" | "subagent" | ""> {
  const sessionId = safeString(input.sessionId);
  const threadId = safeString(input.threadId);
  if (!sessionId || !threadId) return "";
  const trackingState = await readSubagentTrackingState(input.cwd).catch(() => null);
  return trackingState?.sessions[sessionId]?.threads[threadId]?.kind ?? "";
}

function deliveryForAudience(audience: TurnAudience, reason: string): {
  delivery: ExternalDeliveryDecision;
  reason: string;
} {
  if (audience === "external-owner") {
    return {
      delivery: "allow",
      reason,
    };
  }
  return {
    delivery: "suppress",
    reason,
  };
}

export function resolveSessionStartOrigin(
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): SessionStartOriginResolution {
  const evidence: OriginEvidence[] = [];
  const seenEvidence = new Set<string>();
  const parsedOrigin = resolveTurnOrigin(payload, env);
  let origin = parsedOrigin;
  const threadId = payloadThreadId(payload) || payloadSessionId(payload) || origin.threadId || origin.nativeSessionId || "";
  if (threadId && !origin.threadId) {
    origin = { ...origin, threadId };
  }
  const audience = audienceFromOriginKind(origin.kind) || "external-owner";
  appendEvidence(evidence, seenEvidence, "session-start-payload", `origin_kind=${origin.kind}`);
  if (origin.parentThreadId) {
    appendEvidence(evidence, seenEvidence, "session-start-payload", `parent_thread_id=${origin.parentThreadId}`);
  }
  return {
    origin,
    audience,
    ownerKind: audience,
    reason: audience === "external-owner" ? "session_start_external_owner" : `session_start_${audience}`,
    evidence,
  };
}

export async function recordCodexSessionOrigin(input: {
  cwd: string;
  stateDir?: string;
  origin: TurnOrigin;
  audience: TurnAudience;
  evidence?: OriginEvidence[];
  now?: Date;
}): Promise<CodexSessionOriginIndexEntry | null> {
  const threadId = originThreadId(input.origin);
  if (!threadId) return null;
  const nowIso = (input.now ?? new Date()).toISOString();
  const index = await readCodexSessionOriginIndex(input.cwd, input.stateDir);
  const previous = index.sessions[threadId];
  const evidence = Array.from(new Set([
    ...(previous?.evidence ?? []),
    ...evidenceSources(input.evidence ?? []),
  ]));
  const entry: CodexSessionOriginIndexEntry = {
    thread_id: threadId,
    origin_kind: input.origin.kind,
    audience: input.audience,
    ...(input.origin.parentThreadId ? { parent_thread_id: input.origin.parentThreadId } : {}),
    ...(input.origin.nativeSessionId ? { native_session_id: input.origin.nativeSessionId } : {}),
    ...(input.origin.agentNickname ? { agent_nickname: input.origin.agentNickname } : {}),
    ...(input.origin.agentRole ? { agent_role: input.origin.agentRole } : {}),
    cwd: input.cwd,
    first_seen_at: previous?.first_seen_at ?? nowIso,
    last_seen_at: nowIso,
    evidence,
  };
  index.sessions[threadId] = entry;
  if (input.origin.nativeSessionId && input.origin.nativeSessionId !== threadId) {
    index.sessions[input.origin.nativeSessionId] = {
      ...entry,
      thread_id: input.origin.nativeSessionId,
    };
  }
  await writeCodexSessionOriginIndex(input.cwd, index, input.stateDir);
  return entry;
}

export async function resolveTurnOriginForNotification(
  input: ResolveTurnOriginForNotificationInput,
): Promise<NotificationOriginResolution> {
  const env = input.env ?? process.env;
  const now = input.now ?? new Date();
  const evidence: OriginEvidence[] = [];
  const seenEvidence = new Set<string>();
  const payloadThread = payloadThreadId(input.payload);
  const payloadSession = payloadSessionId(input.payload);
  const transcriptPath = payloadTranscriptPath(input.payload);
  let origin = resolveTurnOrigin(input.payload, env);
  let sessionMeta: Record<string, unknown> | undefined;

  appendEvidence(evidence, seenEvidence, "payload", `origin_kind=${origin.kind}`);
  if (payloadThread) appendEvidence(evidence, seenEvidence, "payload", `thread_id=${payloadThread}`);
  if (payloadSession) appendEvidence(evidence, seenEvidence, "payload", `session_id=${payloadSession}`);

  const index = await readCodexSessionOriginIndex(input.cwd, input.stateDir);
  const indexEntry = lookupIndexEntry(index, originIndexLookupIds({
    payloadThreadId: payloadThread,
    payloadSessionId: payloadSession,
    origin,
  }), input.cwd);
  if (indexEntry) {
    appendEvidence(evidence, seenEvidence, "codex-session-origin-index", `thread_id=${indexEntry.thread_id}`);
    if (origin.kind === "unknown" || origin.kind === "leader") {
      origin = {
        ...origin,
        ...indexEntryToOrigin(indexEntry),
      };
    }
  }

  const threadForRollout = firstString(payloadThread, origin.threadId, payloadSession, origin.nativeSessionId);
  if ((origin.kind === "unknown" || origin.kind === "leader") && threadForRollout) {
    const rollout = await resolveOriginFromRollouts({
      cwd: input.cwd,
      threadId: threadForRollout,
      transcriptPath,
      env,
      now,
      evidence,
      seenEvidence,
    }).catch(() => null);
    if (rollout && rollout.origin.kind !== "unknown") {
      origin = {
        ...origin,
        ...rollout.origin,
      };
      sessionMeta = rollout.sessionMeta;
    }
  }

  const hasCurrentOwner = hasKnownCurrentOwner(input);
  const effectiveSessionId = firstString(
    input.currentOmxSessionId,
    input.currentSessionState?.session_id,
    hasCurrentOwner ? "" : payloadSession,
  );
  const trackedKind = await readTrackedThreadKind({
    cwd: stateRootFromStateDir(input.cwd, input.stateDir),
    sessionId: effectiveSessionId,
    threadId: payloadThread,
  });
  if (trackedKind) {
    appendEvidence(evidence, seenEvidence, "subagent-tracking", `kind=${trackedKind}`);
  }

  if (
    trackedKind === "subagent"
    && !payloadThreadMatchesCurrentOwner({
      currentSessionState: input.currentSessionState,
      payloadThreadId: payloadThread,
      origin,
    })
  ) {
    origin = {
      ...origin,
      kind: "native-subagent",
    };
    const decision = deliveryForAudience("child", "tracked_child");
    return {
      origin,
      audience: "child",
      ...decision,
      evidence,
      ...(sessionMeta ? { sessionMeta } : {}),
    };
  }

  const ownerMatch = currentOwnerThreadMatches({
    currentSessionState: input.currentSessionState,
    payloadThreadId: payloadThread,
    origin,
  });
  if (ownerMatch && originKindCanRepresentCurrentOwner(origin.kind)) {
    appendEvidence(evidence, seenEvidence, "current-session-owner", "matched_payload_or_origin_id");
    return {
      origin,
      audience: "external-owner",
      delivery: "allow",
      reason: "current_external_owner",
      evidence,
      ...(sessionMeta ? { sessionMeta } : {}),
    };
  }
  if (hasCurrentOwner && payloadSessionOnlyMatchesCurrentOwner({
    currentSessionState: input.currentSessionState,
    currentOmxSessionId: input.currentOmxSessionId,
    payloadSessionId: payloadSession,
    origin,
  })) {
    appendEvidence(evidence, seenEvidence, "current-session-owner", "session_id_match_without_owner_thread_ignored");
  }

  const explicitNonOwnerAudience = audienceFromOriginKind(origin.kind);
  if (explicitNonOwnerAudience && explicitNonOwnerAudience !== "external-owner") {
    const decision = deliveryForAudience(explicitNonOwnerAudience, `origin_${origin.kind}`);
    return {
      origin,
      audience: explicitNonOwnerAudience,
      ...decision,
      evidence,
      ...(sessionMeta ? { sessionMeta } : {}),
    };
  }

  if (trackedKind === "leader") {
    if (hasCurrentOwner) {
      appendEvidence(evidence, seenEvidence, "owner-state", "current_owner_mismatch");
      return {
        origin,
        audience: "unknown-non-owner",
        delivery: "suppress",
        reason: "tracked_leader_owner_mismatch_fail_closed",
        evidence,
        ...(sessionMeta ? { sessionMeta } : {}),
      };
    }
    origin = {
      ...origin,
      kind: "leader",
    };
    const decision = deliveryForAudience("external-owner", "tracked_leader");
    return {
      origin,
      audience: "external-owner",
      ...decision,
      evidence,
      ...(sessionMeta ? { sessionMeta } : {}),
    };
  }

  if (trackedKind === "subagent") {
    origin = {
      ...origin,
      kind: "native-subagent",
    };
    const decision = deliveryForAudience("child", "tracked_child");
    return {
      origin,
      audience: "child",
      ...decision,
      evidence,
      ...(sessionMeta ? { sessionMeta } : {}),
    };
  }

  const indexedAudience = indexEntry?.audience;
  if (indexedAudience) {
    if (indexedAudience === "external-owner" && hasCurrentOwner) {
      appendEvidence(evidence, seenEvidence, "owner-state", "current_owner_mismatch");
      return {
        origin,
        audience: "unknown-non-owner",
        delivery: "suppress",
        reason: "indexed_external_owner_mismatch_fail_closed",
        evidence,
        ...(sessionMeta ? { sessionMeta } : {}),
      };
    }
    const decision = deliveryForAudience(indexedAudience, `indexed_${indexedAudience}`);
    return {
      origin,
      audience: indexedAudience,
      ...decision,
      evidence,
      ...(sessionMeta ? { sessionMeta } : {}),
    };
  }

  const originAudience = audienceFromOriginKind(origin.kind);
  if (originAudience) {
    if (originAudience === "external-owner" && hasCurrentOwner) {
      appendEvidence(evidence, seenEvidence, "owner-state", "current_owner_mismatch");
      return {
        origin,
        audience: "unknown-non-owner",
        delivery: "suppress",
        reason: "origin_external_owner_mismatch_fail_closed",
        evidence,
        ...(sessionMeta ? { sessionMeta } : {}),
      };
    }
    const decision = deliveryForAudience(originAudience, `origin_${origin.kind}`);
    return {
      origin,
      audience: originAudience,
      ...decision,
      evidence,
      ...(sessionMeta ? { sessionMeta } : {}),
    };
  }

  if (!hasCurrentOwner) {
    appendEvidence(evidence, seenEvidence, "owner-state", "no_current_owner_state");
    return {
      origin,
      audience: "unknown-non-owner",
      delivery: "suppress",
      reason: "unknown_without_current_owner_fail_closed",
      evidence,
      ...(sessionMeta ? { sessionMeta } : {}),
    };
  }

  appendEvidence(evidence, seenEvidence, "owner-state", "current_owner_mismatch");
  return {
    origin,
    audience: "unknown-non-owner",
    delivery: "suppress",
    reason: "unknown_non_owner_fail_closed",
    evidence,
    ...(sessionMeta ? { sessionMeta } : {}),
  };
}
