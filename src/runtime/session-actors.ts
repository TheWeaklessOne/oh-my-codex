import { existsSync } from "fs";
import { appendFile, mkdir, readFile, rm } from "fs/promises";
import { join } from "path";
import { resolveTurnOrigin, type TurnOrigin, type TurnOriginKind } from "./turn-origin.js";
import { updateLockedJsonState } from "./locked-json-state.js";
import { omxLogsDir, omxStateDir } from "../utils/paths.js";

export type SessionActorKind =
  | "leader"
  | "native-subagent"
  | "team-worker"
  | "internal-helper"
  | "unknown";

export type SessionActorAudience =
  | "external-owner"
  | "child"
  | "team-worker"
  | "internal-helper"
  | "unknown-non-owner";

export interface ActorEvidence {
  source: string;
  detail: string;
}

export interface SessionActorRecord {
  actorId: string;
  kind: SessionActorKind;
  audience: SessionActorAudience;
  threadId?: string;
  nativeSessionId?: string;
  parentActorId?: string;
  parentThreadId?: string;
  agentNickname?: string;
  agentRole?: string;
  source: string;
  firstSeenAt: string;
  lastSeenAt: string;
  pid?: number;
  quarantined?: boolean;
  quarantineReason?: string;
  turnCount?: number;
  lastTurnId?: string;
  mode?: string;
  evidence?: string[];
}

export interface SessionActorRegistry {
  schemaVersion: 1;
  sessionId: string;
  cwd: string;
  ownerActorId?: string;
  actors: Record<string, SessionActorRecord>;
  aliases: Record<string, string>;
  updatedAt?: string;
}

export interface ActorClassification {
  kind: SessionActorKind;
  audience: SessionActorAudience;
  origin: TurnOrigin;
  actorId: string;
  threadId?: string;
  nativeSessionId?: string;
  parentThreadId?: string;
  agentNickname?: string;
  agentRole?: string;
  source: string;
  reason: string;
  evidence: ActorEvidence[];
}

export interface ActorRegistrationResult {
  registry: SessionActorRegistry;
  actor: SessionActorRecord;
  outcome: "owner-registered" | "actor-registered" | "actor-quarantined";
  reason: string;
}

const ACTORS_FILE = "actors.json";
const SESSION_ID_SAFE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/;

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

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.map((value) => safeString(value)).filter(Boolean)));
}

function isSafeSessionId(sessionId: string): boolean {
  return SESSION_ID_SAFE_PATTERN.test(sessionId);
}

function ownerPlaceholderActorId(sessionId: string): string {
  return `owner:${sessionId}`;
}

function normalizeKind(value: unknown): SessionActorKind {
  const normalized = safeString(value).toLowerCase();
  if (normalized === "leader") return "leader";
  if (normalized === "native-subagent" || normalized === "subagent") return "native-subagent";
  if (normalized === "team-worker") return "team-worker";
  if (normalized === "internal-helper") return "internal-helper";
  return "unknown";
}

function normalizeAudience(value: unknown, kind: SessionActorKind): SessionActorAudience {
  const normalized = safeString(value).toLowerCase();
  if (normalized === "external-owner") return "external-owner";
  if (normalized === "child") return "child";
  if (normalized === "team-worker") return "team-worker";
  if (normalized === "internal-helper") return "internal-helper";
  if (normalized === "unknown-non-owner") return "unknown-non-owner";
  return actorAudienceFromKind(kind);
}

export function actorAudienceFromKind(kind: TurnOriginKind | SessionActorKind): SessionActorAudience {
  if (kind === "leader") return "external-owner";
  if (kind === "native-subagent") return "child";
  if (kind === "team-worker") return "team-worker";
  if (kind === "internal-helper") return "internal-helper";
  return "unknown-non-owner";
}

export function sessionActorsPath(cwd: string, sessionId: string): string {
  return join(omxStateDir(cwd), "sessions", sessionId, ACTORS_FILE);
}

export function createEmptySessionActorRegistry(
  cwd: string,
  sessionId: string,
): SessionActorRegistry {
  return {
    schemaVersion: 1,
    sessionId,
    cwd,
    actors: {},
    aliases: {},
  };
}

function normalizeActorRecord(
  actorId: string,
  value: unknown,
): SessionActorRecord | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const normalizedActorId = firstString(raw.actorId, raw.actor_id, actorId);
  if (!normalizedActorId) return null;
  const kind = normalizeKind(raw.kind);
  const audience = normalizeAudience(raw.audience, kind);
  const firstSeenAt = firstString(raw.firstSeenAt, raw.first_seen_at, raw.lastSeenAt, raw.last_seen_at)
    || new Date(0).toISOString();
  const lastSeenAt = firstString(raw.lastSeenAt, raw.last_seen_at, firstSeenAt);
  const evidence = Array.isArray(raw.evidence)
    ? raw.evidence.map((entry) => safeString(entry)).filter(Boolean)
    : undefined;

  return {
    actorId: normalizedActorId,
    kind,
    audience,
    ...(firstString(raw.threadId, raw.thread_id) ? { threadId: firstString(raw.threadId, raw.thread_id) } : {}),
    ...(firstString(raw.nativeSessionId, raw.native_session_id) ? { nativeSessionId: firstString(raw.nativeSessionId, raw.native_session_id) } : {}),
    ...(firstString(raw.parentActorId, raw.parent_actor_id) ? { parentActorId: firstString(raw.parentActorId, raw.parent_actor_id) } : {}),
    ...(firstString(raw.parentThreadId, raw.parent_thread_id) ? { parentThreadId: firstString(raw.parentThreadId, raw.parent_thread_id) } : {}),
    ...(firstString(raw.agentNickname, raw.agent_nickname) ? { agentNickname: firstString(raw.agentNickname, raw.agent_nickname) } : {}),
    ...(firstString(raw.agentRole, raw.agent_role) ? { agentRole: firstString(raw.agentRole, raw.agent_role) } : {}),
    source: firstString(raw.source) || "unknown",
    firstSeenAt,
    lastSeenAt,
    ...(typeof raw.pid === "number" && Number.isInteger(raw.pid) && raw.pid > 0 ? { pid: raw.pid } : {}),
    ...(raw.quarantined === true ? { quarantined: true } : {}),
    ...(firstString(raw.quarantineReason, raw.quarantine_reason) ? { quarantineReason: firstString(raw.quarantineReason, raw.quarantine_reason) } : {}),
    ...(typeof raw.turnCount === "number" && Number.isFinite(raw.turnCount) && raw.turnCount >= 0 ? { turnCount: raw.turnCount } : {}),
    ...(firstString(raw.lastTurnId, raw.last_turn_id) ? { lastTurnId: firstString(raw.lastTurnId, raw.last_turn_id) } : {}),
    ...(firstString(raw.mode) ? { mode: firstString(raw.mode) } : {}),
    ...(evidence && evidence.length > 0 ? { evidence } : {}),
  };
}

function actorAliasIds(actor: SessionActorRecord): string[] {
  return uniqueStrings([
    actor.threadId,
    actor.nativeSessionId,
    actor.actorId.startsWith("owner:") ? undefined : actor.actorId,
  ]);
}

function rebuildAliases(actors: Record<string, SessionActorRecord>): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const actor of Object.values(actors)) {
    for (const id of actorAliasIds(actor)) {
      aliases[id] = actor.actorId;
    }
  }
  return aliases;
}

export function normalizeSessionActorRegistry(
  input: unknown,
  cwd: string,
  sessionId: string,
): SessionActorRegistry {
  const raw = asRecord(input);
  if (!raw) return createEmptySessionActorRegistry(cwd, sessionId);
  const actors: Record<string, SessionActorRecord> = {};
  const rawActors = asRecord(raw.actors);
  if (rawActors) {
    for (const [actorId, value] of Object.entries(rawActors)) {
      const actor = normalizeActorRecord(actorId, value);
      if (actor) actors[actor.actorId] = actor;
    }
  }
  const ownerActorId = firstString(raw.ownerActorId, raw.owner_actor_id);
  return {
    schemaVersion: 1,
    sessionId: firstString(raw.sessionId, raw.session_id) || sessionId,
    cwd: firstString(raw.cwd) || cwd,
    ...(ownerActorId && actors[ownerActorId] ? { ownerActorId } : {}),
    actors,
    aliases: rebuildAliases(actors),
    ...(firstString(raw.updatedAt, raw.updated_at) ? { updatedAt: firstString(raw.updatedAt, raw.updated_at) } : {}),
  };
}

export async function readSessionActors(
  cwd: string,
  sessionId: string | undefined,
): Promise<SessionActorRegistry> {
  const normalizedSessionId = safeString(sessionId);
  if (!isSafeSessionId(normalizedSessionId)) {
    return createEmptySessionActorRegistry(cwd, normalizedSessionId || "unknown");
  }
  const path = sessionActorsPath(cwd, normalizedSessionId);
  if (!existsSync(path)) return createEmptySessionActorRegistry(cwd, normalizedSessionId);
  try {
    return normalizeSessionActorRegistry(JSON.parse(await readFile(path, "utf-8")), cwd, normalizedSessionId);
  } catch {
    return createEmptySessionActorRegistry(cwd, normalizedSessionId);
  }
}

export async function writeSessionActors(
  cwd: string,
  registry: SessionActorRegistry,
): Promise<void> {
  const normalized = normalizeSessionActorRegistry(registry, cwd, registry.sessionId);
  normalized.updatedAt = new Date().toISOString();
  if (!isSafeSessionId(normalized.sessionId)) return;
  const path = sessionActorsPath(cwd, normalized.sessionId);
  await updateLockedJsonState(path, async () => ({
    result: undefined,
    nextState: normalized,
    write: true,
  }));
}

async function updateSessionActors<TResult>(
  cwd: string,
  sessionId: string,
  update: (registry: SessionActorRegistry) => Promise<{
    result: TResult;
    write: boolean;
  }>,
): Promise<TResult> {
  const normalizedSessionId = safeString(sessionId);
  if (!isSafeSessionId(normalizedSessionId)) {
    const registry = createEmptySessionActorRegistry(cwd, normalizedSessionId || "unknown");
    return (await update(registry)).result;
  }
  const path = sessionActorsPath(cwd, normalizedSessionId);
  return await updateLockedJsonState(path, async (raw) => {
    const registry = normalizeSessionActorRegistry(raw, cwd, normalizedSessionId);
    const mutation = await update(registry);
    registry.updatedAt = new Date().toISOString();
    registry.aliases = rebuildAliases(registry.actors);
    return {
      result: mutation.result,
      nextState: registry,
      write: mutation.write,
    };
  });
}

async function appendActorLog(cwd: string, entry: Record<string, unknown>): Promise<void> {
  try {
    const logsDir = omxLogsDir(cwd);
    await mkdir(logsDir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    await appendFile(
      join(logsDir, `session-actors-${date}.jsonl`),
      `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`,
    );
  } catch {
    // Observability must not block hooks.
  }
}

function mergeEvidence(
  existing: string[] | undefined,
  evidence: ActorEvidence[] | undefined,
): string[] | undefined {
  const merged = Array.from(new Set([
    ...(existing ?? []),
    ...(evidence ?? []).map((entry) => entry.source).filter(Boolean),
  ]));
  return merged.length > 0 ? merged : undefined;
}

export function lookupActorByIds(
  registry: SessionActorRegistry,
  ids: Array<string | undefined>,
): SessionActorRecord | null {
  for (const id of uniqueStrings(ids)) {
    const actorId = registry.aliases[id];
    if (actorId && registry.actors[actorId]) return registry.actors[actorId];
    if (registry.actors[id]) return registry.actors[id];
  }
  return null;
}

function removeActorAndAliases(registry: SessionActorRegistry, actorId: string): void {
  delete registry.actors[actorId];
  registry.aliases = rebuildAliases(registry.actors);
}

export async function registerExternalOwnerActor(input: {
  cwd: string;
  sessionId: string;
  threadId?: string;
  nativeSessionId?: string;
  pid?: number;
  source: string;
  now?: Date;
  evidence?: ActorEvidence[];
}): Promise<ActorRegistrationResult> {
  const nowIso = (input.now ?? new Date()).toISOString();
  const explicitActorId = firstString(input.threadId, input.nativeSessionId);
  const result = await updateSessionActors(input.cwd, input.sessionId, async (registry) => {
    let ownerActorId = registry.ownerActorId;
    let existingOwner = ownerActorId ? registry.actors[ownerActorId] : undefined;

    if (
      existingOwner
      && existingOwner.actorId.startsWith("owner:")
      && explicitActorId
      && !existingOwner.threadId
      && !existingOwner.nativeSessionId
    ) {
      removeActorAndAliases(registry, existingOwner.actorId);
      ownerActorId = explicitActorId;
      existingOwner = undefined;
    }

    if (existingOwner && explicitActorId) {
      const explicitMatchesOwner = lookupActorByIds(registry, [
        explicitActorId,
        input.threadId,
        input.nativeSessionId,
      ])?.actorId === existingOwner.actorId;
      if (!explicitMatchesOwner) {
        return {
          result: applyQuarantinedActor({
            registry,
            classification: {
              kind: "unknown",
              audience: "unknown-non-owner",
              origin: {
                kind: "unknown",
                threadId: firstString(input.threadId, explicitActorId),
                nativeSessionId: firstString(input.nativeSessionId, explicitActorId),
                source: input.source,
              },
              actorId: explicitActorId,
              ...(input.threadId ? { threadId: input.threadId } : {}),
              ...(input.nativeSessionId ? { nativeSessionId: input.nativeSessionId } : {}),
              source: input.source,
              reason: "external_owner_mismatch_with_active_owner",
              evidence: input.evidence ?? [evidence(input.source, "external_owner_mismatch_with_active_owner")],
            },
            reason: "external_owner_mismatch_with_active_owner",
            nowIso,
          }),
          write: true,
        };
      }
    }

    if (!ownerActorId) {
      ownerActorId = explicitActorId || ownerPlaceholderActorId(input.sessionId);
    }

    const previous = registry.actors[ownerActorId];
    const actor: SessionActorRecord = {
      actorId: ownerActorId,
      kind: "leader",
      audience: "external-owner",
      ...(firstString(previous?.threadId, input.threadId, input.nativeSessionId) ? { threadId: firstString(previous?.threadId, input.threadId, input.nativeSessionId) } : {}),
      ...(firstString(previous?.nativeSessionId, input.nativeSessionId, input.threadId) ? { nativeSessionId: firstString(previous?.nativeSessionId, input.nativeSessionId, input.threadId) } : {}),
      source: input.source,
      firstSeenAt: previous?.firstSeenAt ?? nowIso,
      lastSeenAt: nowIso,
      ...(typeof input.pid === "number" && Number.isInteger(input.pid) && input.pid > 0 ? { pid: input.pid } : previous?.pid ? { pid: previous.pid } : {}),
      ...(mergeEvidence(previous?.evidence, input.evidence) ? { evidence: mergeEvidence(previous?.evidence, input.evidence) } : {}),
      ...(previous?.turnCount ? { turnCount: previous.turnCount } : {}),
      ...(previous?.lastTurnId ? { lastTurnId: previous.lastTurnId } : {}),
      ...(previous?.mode ? { mode: previous.mode } : {}),
    };

    registry.ownerActorId = actor.actorId;
    registry.actors[actor.actorId] = actor;
    registry.aliases = rebuildAliases(registry.actors);
    return {
      result: { registry, actor, outcome: "owner-registered" as const, reason: "external_owner_registered" },
      write: true,
    };
  });
  await logActorRegistration(input.cwd, result);
  return result;
}

function originThreadId(origin: TurnOrigin): string {
  return firstString(origin.threadId, origin.nativeSessionId);
}

function evidence(source: string, detail: string): ActorEvidence {
  return { source, detail };
}

function classifyOriginCandidate(
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  source: string,
): { origin: TurnOrigin; source: string } {
  return {
    origin: resolveTurnOrigin(payload, env),
    source,
  };
}

export function classifySessionStartActor(input: {
  payload: Record<string, unknown>;
  transcriptSessionMeta?: Record<string, unknown> | null;
  env?: NodeJS.ProcessEnv;
  hasCurrentOwner?: boolean;
}): ActorClassification {
  const env = input.env ?? process.env;
  const payload = input.payload;
  const payloadThreadId = firstString(payload["thread-id"], payload.thread_id, payload.threadId);
  const payloadSessionId = firstString(payload.session_id, payload.sessionId, payload["session-id"], payload.native_session_id, payload.nativeSessionId);
  const transcriptThreadId = firstString(input.transcriptSessionMeta?.id, input.transcriptSessionMeta?.thread_id, input.transcriptSessionMeta?.threadId);

  const payloadOrigin = classifyOriginCandidate({
    ...payload,
    thread_id: payloadThreadId || payloadSessionId,
  }, env, "session-start-payload");
  const candidates = [payloadOrigin];

  const payloadSessionMeta = asRecord(payload.session_meta)
    ?? asRecord(payload.sessionMeta)
    ?? asRecord(payload["session-meta"]);
  if (payloadSessionMeta) {
    candidates.push(classifyOriginCandidate({
      session_meta: payloadSessionMeta,
      thread_id: firstString(payloadThreadId, payloadSessionId, payloadSessionMeta.id, payloadSessionMeta.thread_id),
    }, env, "payload-session-meta"));
  }

  if (input.transcriptSessionMeta) {
    candidates.push(classifyOriginCandidate({
      session_meta: input.transcriptSessionMeta,
      thread_id: firstString(transcriptThreadId, payloadThreadId, payloadSessionId),
    }, env, "rollout-session-meta"));
  }

  const selected = candidates.find((candidate) => candidate.origin.kind !== "unknown")
    ?? payloadOrigin;
  let kind = normalizeKind(selected.origin.kind);
  const threadId = firstString(
    selected.origin.threadId,
    payloadThreadId,
    transcriptThreadId,
    payloadSessionId,
  );
  const nativeSessionId = firstString(
    selected.origin.nativeSessionId,
    payloadSessionId,
    threadId,
  );
  const parentThreadId = firstString(selected.origin.parentThreadId);
  const hasCurrentOwner = input.hasCurrentOwner === true;

  if (kind === "unknown" && !hasCurrentOwner) {
    kind = "leader";
  }

  const audience = actorAudienceFromKind(kind);
  const actorId = firstString(threadId, nativeSessionId, payloadSessionId);
  return {
    kind,
    audience,
    origin: {
      ...selected.origin,
      kind,
      ...(threadId ? { threadId } : {}),
      ...(nativeSessionId ? { nativeSessionId } : {}),
      ...(parentThreadId ? { parentThreadId } : {}),
    },
    actorId: actorId || "unknown",
    ...(threadId ? { threadId } : {}),
    ...(nativeSessionId ? { nativeSessionId } : {}),
    ...(parentThreadId ? { parentThreadId } : {}),
    ...(firstString(selected.origin.agentNickname) ? { agentNickname: firstString(selected.origin.agentNickname) } : {}),
    ...(firstString(selected.origin.agentRole) ? { agentRole: firstString(selected.origin.agentRole) } : {}),
    source: selected.source,
    reason: audience === "external-owner" ? "session_start_external_owner" : `session_start_${audience}`,
    evidence: [
      evidence(selected.source, `origin_kind=${selected.origin.kind}`),
      ...(parentThreadId ? [evidence(selected.source, `parent_thread_id=${parentThreadId}`)] : []),
    ],
  };
}

function ownerIsUnboundPlaceholder(registry: SessionActorRegistry): boolean {
  const owner = registry.ownerActorId ? registry.actors[registry.ownerActorId] : undefined;
  return Boolean(owner && owner.actorId.startsWith("owner:") && !owner.threadId && !owner.nativeSessionId);
}

function applyQuarantinedActor(input: {
  registry: SessionActorRegistry;
  classification: ActorClassification;
  reason: string;
  nowIso: string;
}): ActorRegistrationResult {
  const actorId = input.classification.actorId || `unknown:${input.nowIso}`;
  const previous = input.registry.actors[actorId];
  const actor: SessionActorRecord = {
    actorId,
    kind: input.classification.kind,
    audience: "unknown-non-owner",
    ...(input.classification.threadId ? { threadId: input.classification.threadId } : {}),
    ...(input.classification.nativeSessionId ? { nativeSessionId: input.classification.nativeSessionId } : {}),
    ...(input.classification.parentThreadId ? { parentThreadId: input.classification.parentThreadId } : {}),
    ...(input.classification.agentNickname ? { agentNickname: input.classification.agentNickname } : {}),
    ...(input.classification.agentRole ? { agentRole: input.classification.agentRole } : {}),
    source: input.classification.source,
    firstSeenAt: previous?.firstSeenAt ?? input.nowIso,
    lastSeenAt: input.nowIso,
    quarantined: true,
    quarantineReason: input.reason,
    ...(mergeEvidence(previous?.evidence, input.classification.evidence) ? { evidence: mergeEvidence(previous?.evidence, input.classification.evidence) } : {}),
  };
  input.registry.actors[actor.actorId] = actor;
  input.registry.aliases = rebuildAliases(input.registry.actors);
  return { registry: input.registry, actor, outcome: "actor-quarantined", reason: input.reason };
}

async function logActorRegistration(cwd: string, result: ActorRegistrationResult): Promise<void> {
  if (result.outcome === "actor-quarantined") {
    await appendActorLog(cwd, {
      event: "actor_quarantined",
      session_id: result.registry.sessionId,
      actor_id: result.actor.actorId,
      kind: result.actor.kind,
      reason: result.reason,
      owner_actor_id: result.registry.ownerActorId ?? null,
    });
    return;
  }
  await appendActorLog(cwd, {
    event: "actor_registered",
    session_id: result.registry.sessionId,
    actor_id: result.actor.actorId,
    kind: result.actor.kind,
    audience: result.actor.audience,
    ...(result.actor.parentActorId ? { parent_actor_id: result.actor.parentActorId } : {}),
    source: result.actor.source,
  });
}

export async function registerActorSessionStart(input: {
  cwd: string;
  sessionId: string;
  classification: ActorClassification;
  pid?: number;
  now?: Date;
}): Promise<ActorRegistrationResult> {
  const nowIso = (input.now ?? new Date()).toISOString();
  const classification = input.classification;

  if (classification.audience === "external-owner") {
    return await registerExternalOwnerActor({
      cwd: input.cwd,
      sessionId: input.sessionId,
      threadId: classification.threadId,
      nativeSessionId: classification.nativeSessionId,
      pid: input.pid,
      source: classification.source,
      evidence: classification.evidence,
      now: input.now,
    });
  }

  const result = await updateSessionActors(input.cwd, input.sessionId, async (registry) => {
    if (ownerIsUnboundPlaceholder(registry)) {
      return {
        result: applyQuarantinedActor({
          registry,
          classification,
          reason: "non_owner_cannot_replace_owner",
          nowIso,
        }),
        write: true,
      };
    }

    if (!registry.ownerActorId) {
      return {
        result: applyQuarantinedActor({
          registry,
          classification,
          reason: "non_owner_without_owner",
          nowIso,
        }),
        write: true,
      };
    }

    if (classification.kind === "unknown") {
      return {
        result: applyQuarantinedActor({
          registry,
          classification,
          reason: "unknown_actor_with_owner",
          nowIso,
        }),
        write: true,
      };
    }

    const parent = classification.parentThreadId
      ? lookupActorByIds(registry, [classification.parentThreadId])
      : null;
    if (classification.kind === "native-subagent" && !parent) {
      return {
        result: applyQuarantinedActor({
          registry,
          classification,
          reason: "unknown_parent_actor",
          nowIso,
        }),
        write: true,
      };
    }

    const actorId = firstString(classification.actorId, classification.threadId, classification.nativeSessionId);
    const previous = registry.actors[actorId];
    const actor: SessionActorRecord = {
      actorId,
      kind: classification.kind,
      audience: classification.audience,
      ...(classification.threadId ? { threadId: classification.threadId } : {}),
      ...(classification.nativeSessionId ? { nativeSessionId: classification.nativeSessionId } : {}),
      ...(parent ? { parentActorId: parent.actorId } : {}),
      ...(classification.parentThreadId ? { parentThreadId: classification.parentThreadId } : {}),
      ...(classification.agentNickname ? { agentNickname: classification.agentNickname } : {}),
      ...(classification.agentRole ? { agentRole: classification.agentRole } : {}),
      source: classification.source,
      firstSeenAt: previous?.firstSeenAt ?? nowIso,
      lastSeenAt: nowIso,
      ...(typeof input.pid === "number" && Number.isInteger(input.pid) && input.pid > 0 ? { pid: input.pid } : previous?.pid ? { pid: previous.pid } : {}),
      ...(mergeEvidence(previous?.evidence, classification.evidence) ? { evidence: mergeEvidence(previous?.evidence, classification.evidence) } : {}),
      ...(previous?.turnCount ? { turnCount: previous.turnCount } : {}),
      ...(previous?.lastTurnId ? { lastTurnId: previous.lastTurnId } : {}),
      ...(previous?.mode ? { mode: previous.mode } : classification.agentRole ? { mode: classification.agentRole } : {}),
    };
    registry.actors[actor.actorId] = actor;
    registry.aliases = rebuildAliases(registry.actors);
    return {
      result: { registry, actor, outcome: "actor-registered" as const, reason: "actor_registered" },
      write: true,
    };
  });
  await logActorRegistration(input.cwd, result);
  return result;
}

export async function quarantineUnknownActor(input: {
  cwd: string;
  sessionId: string;
  origin: TurnOrigin;
  reason: string;
  now?: Date;
}): Promise<ActorRegistrationResult | null> {
  const actorId = firstString(originThreadId(input.origin), input.origin.nativeSessionId);
  if (!actorId) return null;
  const classification: ActorClassification = {
    kind: normalizeKind(input.origin.kind),
    audience: "unknown-non-owner",
    origin: input.origin,
    actorId,
    ...(input.origin.threadId ? { threadId: input.origin.threadId } : {}),
    ...(input.origin.nativeSessionId ? { nativeSessionId: input.origin.nativeSessionId } : {}),
    ...(input.origin.parentThreadId ? { parentThreadId: input.origin.parentThreadId } : {}),
    ...(input.origin.agentNickname ? { agentNickname: input.origin.agentNickname } : {}),
    ...(input.origin.agentRole ? { agentRole: input.origin.agentRole } : {}),
    source: input.origin.source || "completed-turn",
    reason: input.reason,
    evidence: [evidence("completed-turn", input.reason)],
  };
  const result = await updateSessionActors(input.cwd, input.sessionId, async (registry) => ({
    result: applyQuarantinedActor({
      registry,
      classification,
      reason: input.reason,
      nowIso: (input.now ?? new Date()).toISOString(),
    }),
    write: true,
  }));
  await logActorRegistration(input.cwd, result);
  return result;
}

export async function recordActorTurnActivity(input: {
  cwd: string;
  sessionId: string;
  actorIds: Array<string | undefined>;
  turnId?: string;
  mode?: string;
  timestamp?: string;
}): Promise<SessionActorRegistry> {
  return await updateSessionActors(input.cwd, input.sessionId, async (registry) => {
    const actor = lookupActorByIds(registry, input.actorIds);
    if (!actor) return { result: registry, write: false };
    const timestamp = input.timestamp || new Date().toISOString();
    registry.actors[actor.actorId] = {
      ...actor,
      lastSeenAt: timestamp,
      turnCount: (actor.turnCount ?? 0) + 1,
      ...(input.turnId ? { lastTurnId: input.turnId } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
    };
    registry.aliases = rebuildAliases(registry.actors);
    return { result: registry, write: true };
  });
}

export interface SessionActorSummary {
  sessionId: string;
  leaderThreadId?: string;
  allThreadIds: string[];
  allSubagentThreadIds: string[];
  activeSubagentThreadIds: string[];
  updatedAt?: string;
}

export function summarizeSessionActors(
  registry: SessionActorRegistry,
  options: { now?: string | Date; activeWindowMs?: number } = {},
): SessionActorSummary | null {
  if (!registry.ownerActorId && Object.keys(registry.actors).length === 0) return null;
  const activeWindowMs = options.activeWindowMs ?? 120_000;
  const nowMs = typeof options.now === "string"
    ? Date.parse(options.now)
    : options.now instanceof Date
      ? options.now.getTime()
      : Date.now();
  const actors = Object.values(registry.actors);
  const owner = registry.ownerActorId ? registry.actors[registry.ownerActorId] : undefined;
  const allThreadIds = uniqueStrings(actors.flatMap((actor) => [actor.threadId, actor.nativeSessionId])).sort();
  const subagents = actors.filter((actor) => actor.kind === "native-subagent" && actor.quarantined !== true);
  const allSubagentThreadIds = uniqueStrings(subagents.flatMap((actor) => [actor.threadId, actor.nativeSessionId])).sort();
  const activeSubagentThreadIds = uniqueStrings(subagents.filter((actor) => {
    const lastSeen = Date.parse(actor.lastSeenAt);
    return Number.isFinite(lastSeen) && nowMs - lastSeen <= activeWindowMs;
  }).flatMap((actor) => [actor.threadId, actor.nativeSessionId])).sort();
  return {
    sessionId: registry.sessionId,
    leaderThreadId: owner?.threadId ?? owner?.nativeSessionId,
    allThreadIds,
    allSubagentThreadIds,
    activeSubagentThreadIds,
    updatedAt: registry.updatedAt,
  };
}

export async function removeSessionActors(cwd: string, sessionId: string): Promise<void> {
  if (!isSafeSessionId(sessionId)) return;
  await rm(sessionActorsPath(cwd, sessionId), { force: true }).catch(() => {});
}
