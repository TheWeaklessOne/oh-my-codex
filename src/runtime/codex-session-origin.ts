import { existsSync } from "fs";
import { readFile, readdir, stat } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import {
  resolveTurnOrigin,
  type TurnOrigin,
  type TurnOriginKind,
} from "./turn-origin.js";
import {
  actorAudienceFromKind,
  lookupActorByIds,
  quarantineUnknownActor,
  readSessionActors,
  type ActorEvidence,
  type SessionActorAudience,
} from "./session-actors.js";
import {
  isOwnerClaimDeliverable,
  isOwnerClaimReplaceable,
  isSupersededOwner,
} from "./session-ownership.js";

export type TurnAudience = SessionActorAudience;
export type ExternalDeliveryDecision = "allow" | "suppress";
export type OriginEvidence = ActorEvidence;

export interface CurrentSessionStateLike {
  session_id?: string;
  native_session_id?: string;
  cwd?: string;
}

export interface NotificationOriginResolution {
  origin: TurnOrigin;
  audience: TurnAudience;
  delivery: ExternalDeliveryDecision;
  reason: string;
  evidence: OriginEvidence[];
  sessionMeta?: Record<string, unknown>;
  actorId?: string;
  ownerActorId?: string;
  actorLifecycleStatus?: string;
  actorClaimStrength?: string;
  ownerLifecycleStatus?: string;
  ownerClaimStrength?: string;
  replaceableOwner?: boolean;
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

function payloadThreadId(payload: Record<string, unknown>): string {
  return firstString(payload["thread-id"], payload.thread_id, payload.threadId, payload.id);
}

function payloadSessionId(payload: Record<string, unknown>): string {
  return firstString(payload.session_id, payload.sessionId, payload["session-id"], payload.native_session_id, payload.nativeSessionId);
}

function payloadTranscriptPath(payload: Record<string, unknown>): string {
  return firstString(payload.transcript_path, payload.transcriptPath, payload["transcript-path"]);
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
  return baseOrigin;
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(line) as unknown);
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
  return {
    threadId,
    sessionMeta: payload,
    origin,
    audience: actorAudienceFromKind(origin.kind),
    evidence: [{ source: "rollout-session-meta", detail: `thread_id=${threadId}` }],
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
      for (const entry of exact.evidence) appendEvidence(input.evidence, input.seenEvidence, entry.source, entry.detail);
      return { origin: exact.origin, sessionMeta: exact.sessionMeta };
    }
    appendEvidence(input.evidence, input.seenEvidence, "transcript-path", "no_matching_session_meta");
  }

  const files = await discoverRecentCodexRolloutFiles({ env: input.env, now: input.now });
  appendEvidence(input.evidence, input.seenEvidence, "rollout-scan", `candidate_files=${files.length}`);
  for (const path of files) {
    const found = await readRolloutSessionMetaFromPath(path, {
      cwd: input.cwd,
      threadId: input.threadId,
      env: input.env,
    });
    if (!found) continue;
    for (const entry of found.evidence) appendEvidence(input.evidence, input.seenEvidence, entry.source, entry.detail);
    return { origin: found.origin, sessionMeta: found.sessionMeta };
  }
  return null;
}

function hasKnownCurrentOwner(input: ResolveTurnOriginForNotificationInput): boolean {
  return Boolean(firstString(input.currentOmxSessionId, input.currentSessionState?.session_id, input.currentSessionState?.native_session_id));
}

function deliveryForAudience(audience: TurnAudience, reason: string): {
  delivery: ExternalDeliveryDecision;
  reason: string;
} {
  return audience === "external-owner"
    ? { delivery: "allow", reason }
    : { delivery: "suppress", reason };
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
      origin = { ...origin, ...rollout.origin };
      sessionMeta = rollout.sessionMeta;
    }
  }

  const effectiveSessionId = firstString(
    input.currentOmxSessionId,
    input.currentSessionState?.session_id,
    payloadSession,
    origin.nativeSessionId,
  );
  const registry = effectiveSessionId
    ? await readSessionActors(input.cwd, effectiveSessionId).catch(() => null)
    : null;
  const ownerActorId = registry?.ownerActorId;
  const ownerActor = ownerActorId ? registry?.actors[ownerActorId] : undefined;
  const ownerLifecycleFields = {
    ...(ownerActor?.lifecycleStatus ? { ownerLifecycleStatus: ownerActor.lifecycleStatus } : {}),
    ...(ownerActor?.claimStrength ? { ownerClaimStrength: ownerActor.claimStrength } : {}),
    ...(ownerActor ? { replaceableOwner: isOwnerClaimReplaceable(ownerActor) } : {}),
  };
  if (registry) {
    appendEvidence(evidence, seenEvidence, "actor-registry", `owner_actor_id=${ownerActorId || "none"}`);
    if (ownerActor?.lifecycleStatus) {
      appendEvidence(evidence, seenEvidence, "actor-registry", `owner_lifecycle=${ownerActor.lifecycleStatus}`);
    }
    if (ownerActor?.claimStrength) {
      appendEvidence(evidence, seenEvidence, "actor-registry", `owner_claim=${ownerActor.claimStrength}`);
    }
  }

  const originAudience = actorAudienceFromKind(origin.kind);
  const primaryActor = registry
    ? lookupActorByIds(registry, [payloadThread, origin.threadId])
    : null;
  const sessionActor = registry
    ? lookupActorByIds(registry, [payloadSession, origin.nativeSessionId])
    : null;
  const actor = primaryActor
    ?? (
      originAudience === "external-owner"
      || (!payloadThread && originAudience === "unknown-non-owner")
        ? sessionActor
        : null
    );
  if (actor) {
    appendEvidence(evidence, seenEvidence, "actor-registry", `actor_id=${actor.actorId}`);
    const resolvedOrigin: TurnOrigin = {
      ...origin,
      kind: actor.kind as TurnOriginKind,
      threadId: actor.threadId || origin.threadId || payloadThread,
      nativeSessionId: actor.nativeSessionId || origin.nativeSessionId || payloadSession,
      ...(actor.parentThreadId ? { parentThreadId: actor.parentThreadId } : {}),
      ...(actor.agentNickname ? { agentNickname: actor.agentNickname } : {}),
      ...(actor.agentRole ? { agentRole: actor.agentRole } : {}),
      source: actor.source,
    };
    const actorLifecycleFields = {
      ...(actor.lifecycleStatus ? { actorLifecycleStatus: actor.lifecycleStatus } : {}),
      ...(actor.claimStrength ? { actorClaimStrength: actor.claimStrength } : {}),
      ...ownerLifecycleFields,
    };
    if (isSupersededOwner(actor)) {
      return {
        origin: resolvedOrigin,
        audience: "unknown-non-owner",
        delivery: "suppress",
        reason: "superseded_owner_actor",
        evidence,
        actorId: actor.actorId,
        ...(ownerActorId ? { ownerActorId } : {}),
        ...(sessionMeta ? { sessionMeta } : {}),
        ...actorLifecycleFields,
      };
    }
    if (originAudience !== "unknown-non-owner" && originAudience !== "external-owner") {
      return {
        origin: {
          ...resolvedOrigin,
          kind: origin.kind,
          ...(origin.parentThreadId ? { parentThreadId: origin.parentThreadId } : {}),
          ...(origin.agentNickname ? { agentNickname: origin.agentNickname } : {}),
          ...(origin.agentRole ? { agentRole: origin.agentRole } : {}),
          source: origin.source || resolvedOrigin.source,
        },
        audience: originAudience,
        delivery: "suppress",
        reason: "non_owner_actor",
        evidence,
        actorId: actor.actorId,
        ...(ownerActorId ? { ownerActorId } : {}),
        ...(sessionMeta ? { sessionMeta } : {}),
        ...actorLifecycleFields,
      };
    }
    if (
      actor.actorId === ownerActorId
      && actor.kind === "leader"
      && actor.audience === "external-owner"
      && isOwnerClaimDeliverable(actor)
    ) {
      return {
        origin: resolvedOrigin,
        audience: "external-owner",
        delivery: "allow",
        reason: "owner_actor_completed",
        evidence,
        actorId: actor.actorId,
        ownerActorId,
        ...(sessionMeta ? { sessionMeta } : {}),
        ...actorLifecycleFields,
      };
    }
    if (actor.actorId === ownerActorId && actor.kind === "leader" && actor.audience === "external-owner") {
      return {
        origin: resolvedOrigin,
        audience: "unknown-non-owner",
        delivery: "suppress",
        reason: "owner_actor_lifecycle_not_deliverable",
        evidence,
        actorId: actor.actorId,
        ownerActorId,
        ...(sessionMeta ? { sessionMeta } : {}),
        ...actorLifecycleFields,
      };
    }
    return {
      origin: resolvedOrigin,
      audience: actor.audience === "external-owner" ? "unknown-non-owner" : actor.audience,
      delivery: "suppress",
      reason: actor.quarantined ? actor.quarantineReason || "actor_quarantined" : "non_owner_actor",
      evidence,
      actorId: actor.actorId,
      ...(ownerActorId ? { ownerActorId } : {}),
      ...(sessionMeta ? { sessionMeta } : {}),
      ...actorLifecycleFields,
    };
  }

  if (originAudience !== "unknown-non-owner" && originAudience !== "external-owner") {
    return {
      origin,
      audience: originAudience,
      ...deliveryForAudience(originAudience, "non_owner_actor"),
      evidence,
      ...(ownerActorId ? { ownerActorId } : {}),
      ...(sessionMeta ? { sessionMeta } : {}),
      ...ownerLifecycleFields,
    };
  }

  if (registry?.ownerActorId) {
    appendEvidence(evidence, seenEvidence, "actor-registry", "unknown_actor_with_owner");
    await quarantineUnknownActor({
      cwd: input.cwd,
      sessionId: registry.sessionId,
      origin: {
        ...origin,
        threadId: origin.threadId || payloadThread,
        nativeSessionId: origin.nativeSessionId || payloadSession,
        kind: "unknown",
      },
      reason: "unknown_actor_with_owner",
      now,
    }).catch(() => null);
    return {
      origin: { ...origin, kind: "unknown" },
      audience: "unknown-non-owner",
      delivery: "suppress",
      reason: "unknown_actor_with_owner",
      evidence,
      ownerActorId: registry.ownerActorId,
      ...(sessionMeta ? { sessionMeta } : {}),
      ...ownerLifecycleFields,
    };
  }

  if (!hasKnownCurrentOwner(input)) {
    appendEvidence(evidence, seenEvidence, "actor-registry", "no_owner_actor");
    return {
      origin,
      audience: "unknown-non-owner",
      delivery: "suppress",
      reason: "unknown_without_current_owner_fail_closed",
      evidence,
      ...(sessionMeta ? { sessionMeta } : {}),
      ...ownerLifecycleFields,
    };
  }

  appendEvidence(evidence, seenEvidence, "actor-registry", "missing_registry_owner");
  return {
    origin: { ...origin, kind: "unknown" },
    audience: "unknown-non-owner",
    delivery: "suppress",
    reason: "missing_actor_registry_owner",
    evidence,
    ...(sessionMeta ? { sessionMeta } : {}),
    ...ownerLifecycleFields,
  };
}
