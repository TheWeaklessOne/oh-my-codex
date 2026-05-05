import { existsSync } from "fs";
import { appendFile, mkdir, readFile, rm } from "fs/promises";
import { join } from "path";
import { resolveTurnOrigin, type TurnOrigin, type TurnOriginKind } from "./turn-origin.js";
import { updateLockedJsonState } from "./locked-json-state.js";
import { omxLogsDir, omxStateDir } from "../utils/paths.js";
import {
  isOwnerClaimReplaceable,
  resolveOwnerSessionStartPolicy,
  type ActorLifecycleStatus,
  type ActorTurnLifecycleStatus,
  type OwnerClaimStrength,
} from "./session-ownership.js";
import {
  readCodexTranscriptLifecycle,
  type CodexTranscriptLifecycleSummary,
} from "./codex-transcript-lifecycle.js";

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
  lifecycleStatus?: ActorLifecycleStatus;
  claimStrength?: OwnerClaimStrength;
  startedTurnCount?: number;
  completedTurnCount?: number;
  abortedTurnCount?: number;
  lastTurnStatus?: ActorTurnLifecycleStatus;
  lastLifecycleEventAt?: string;
  supersededByActorId?: string;
  supersededReason?: string;
  transcriptPath?: string;
  contextCwd?: string;
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
  contextCwd?: string;
  managedSessionId?: string;
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

function normalizeLifecycleStatus(value: unknown): ActorLifecycleStatus | undefined {
  const normalized = safeString(value).toLowerCase();
  if (
    normalized === "candidate"
    || normalized === "active"
    || normalized === "aborted"
    || normalized === "completed"
    || normalized === "closed"
    || normalized === "superseded"
    || normalized === "quarantined"
  ) {
    return normalized;
  }
  return undefined;
}

function normalizeClaimStrength(value: unknown): OwnerClaimStrength | undefined {
  const normalized = safeString(value).toLowerCase();
  if (
    normalized === "placeholder"
    || normalized === "native-start"
    || normalized === "turn-started"
    || normalized === "completion-validated"
  ) {
    return normalized;
  }
  return undefined;
}

function normalizeTurnLifecycleStatus(value: unknown): ActorTurnLifecycleStatus | undefined {
  const normalized = safeString(value).toLowerCase();
  if (
    normalized === "started"
    || normalized === "aborted"
    || normalized === "completed"
    || normalized === "stopped"
  ) {
    return normalized;
  }
  return undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
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
  const lifecycleStatus = normalizeLifecycleStatus(raw.lifecycleStatus ?? raw.lifecycle_status);
  const claimStrength = normalizeClaimStrength(raw.claimStrength ?? raw.claim_strength);
  const lastTurnStatus = normalizeTurnLifecycleStatus(raw.lastTurnStatus ?? raw.last_turn_status);
  const defaultLifecycleStatus: ActorLifecycleStatus | undefined = lifecycleStatus
    ?? (
      kind === "leader" && audience === "external-owner"
        ? normalizedActorId.startsWith("owner:") ? "candidate" : "active"
        : undefined
    );

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
    ...(defaultLifecycleStatus ? { lifecycleStatus: defaultLifecycleStatus } : {}),
    ...(claimStrength ? { claimStrength } : {}),
    ...(nonNegativeInteger(raw.startedTurnCount ?? raw.started_turn_count) != null ? { startedTurnCount: nonNegativeInteger(raw.startedTurnCount ?? raw.started_turn_count) } : {}),
    ...(nonNegativeInteger(raw.completedTurnCount ?? raw.completed_turn_count) != null ? { completedTurnCount: nonNegativeInteger(raw.completedTurnCount ?? raw.completed_turn_count) } : {}),
    ...(nonNegativeInteger(raw.abortedTurnCount ?? raw.aborted_turn_count) != null ? { abortedTurnCount: nonNegativeInteger(raw.abortedTurnCount ?? raw.aborted_turn_count) } : {}),
    ...(lastTurnStatus ? { lastTurnStatus } : {}),
    ...(firstString(raw.lastLifecycleEventAt, raw.last_lifecycle_event_at) ? { lastLifecycleEventAt: firstString(raw.lastLifecycleEventAt, raw.last_lifecycle_event_at) } : {}),
    ...(firstString(raw.supersededByActorId, raw.superseded_by_actor_id) ? { supersededByActorId: firstString(raw.supersededByActorId, raw.superseded_by_actor_id) } : {}),
    ...(firstString(raw.supersededReason, raw.superseded_reason) ? { supersededReason: firstString(raw.supersededReason, raw.superseded_reason) } : {}),
    ...(firstString(raw.transcriptPath, raw.transcript_path) ? { transcriptPath: firstString(raw.transcriptPath, raw.transcript_path) } : {}),
    ...(firstString(raw.contextCwd, raw.context_cwd) ? { contextCwd: firstString(raw.contextCwd, raw.context_cwd) } : {}),
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

function mergeLifecycleSummary(
  actor: SessionActorRecord,
  lifecycle: CodexTranscriptLifecycleSummary | undefined | null,
  nowIso: string,
): SessionActorRecord {
  if (!lifecycle) return actor;
  const startedTurnCount = Math.max(actor.startedTurnCount ?? 0, lifecycle.startedTurnCount);
  const completedTurnCount = Math.max(actor.completedTurnCount ?? 0, lifecycle.completedTurnCount);
  const abortedTurnCount = Math.max(actor.abortedTurnCount ?? 0, lifecycle.abortedTurnCount);
  const lastTurnStatus = lifecycle.lastTurnStatus ?? actor.lastTurnStatus;
  const claimStrength: OwnerClaimStrength = actor.claimStrength === "completion-validated"
    ? "completion-validated"
    : startedTurnCount > 0
      ? "turn-started"
      : actor.claimStrength ?? "native-start";
  const lifecycleStatus: ActorLifecycleStatus = completedTurnCount > 0
    ? "completed"
    : abortedTurnCount > 0 && lastTurnStatus === "aborted"
      ? "aborted"
      : startedTurnCount > 0
        ? "active"
        : actor.lifecycleStatus ?? "candidate";

  return {
    ...actor,
    lifecycleStatus,
    claimStrength,
    ...(startedTurnCount > 0 ? { startedTurnCount } : {}),
    ...(completedTurnCount > 0 ? { completedTurnCount } : {}),
    ...(abortedTurnCount > 0 ? { abortedTurnCount } : {}),
    ...(lastTurnStatus ? { lastTurnStatus } : {}),
    ...(lifecycle.lastTurnId ? { lastTurnId: lifecycle.lastTurnId } : {}),
    lastLifecycleEventAt: lifecycle.lastLifecycleEventAt ?? nowIso,
    ...(lifecycle.contextCwd ? { contextCwd: lifecycle.contextCwd } : {}),
  };
}

function hasAuthoritativeReplacementStartEvidence(input: {
  actorId: string;
  threadId?: string;
  nativeSessionId?: string;
  lifecycle?: CodexTranscriptLifecycleSummary | null;
}): boolean {
  if (!input.lifecycle || input.lifecycle.startedTurnCount <= 0) return false;
  const sessionMeta = input.lifecycle.sessionMeta;
  const lifecycleActorId = firstString(sessionMeta?.id, sessionMeta?.thread_id, sessionMeta?.threadId);
  if (!lifecycleActorId) return false;
  return uniqueStrings([input.actorId, input.threadId, input.nativeSessionId]).includes(lifecycleActorId);
}

async function refreshOwnerLifecycleFromTranscript(
  registry: SessionActorRegistry,
  nowIso: string,
): Promise<void> {
  const owner = registry.ownerActorId ? registry.actors[registry.ownerActorId] : undefined;
  if (!owner?.transcriptPath) return;
  const lifecycle = await readCodexTranscriptLifecycle(owner.transcriptPath).catch(() => null);
  if (!lifecycle) return;
  registry.actors[owner.actorId] = mergeLifecycleSummary(owner, lifecycle, nowIso);
}

function buildOwnerActor(input: {
  previous?: SessionActorRecord;
  actorId: string;
  threadId?: string;
  nativeSessionId?: string;
  pid?: number;
  source: string;
  nowIso: string;
  evidence?: ActorEvidence[];
  transcriptPath?: string;
  lifecycle?: CodexTranscriptLifecycleSummary | null;
  contextCwd?: string;
}): SessionActorRecord {
  const actorIdAlias = input.actorId.startsWith("owner:") ? undefined : input.actorId;
  const actor: SessionActorRecord = {
    actorId: input.actorId,
    kind: "leader",
    audience: "external-owner",
    ...(firstString(input.previous?.threadId, input.threadId, input.nativeSessionId, actorIdAlias) ? { threadId: firstString(input.previous?.threadId, input.threadId, input.nativeSessionId, actorIdAlias) } : {}),
    ...(firstString(input.previous?.nativeSessionId, input.nativeSessionId, input.threadId, actorIdAlias) ? { nativeSessionId: firstString(input.previous?.nativeSessionId, input.nativeSessionId, input.threadId, actorIdAlias) } : {}),
    source: input.source,
    firstSeenAt: input.previous?.firstSeenAt ?? input.nowIso,
    lastSeenAt: input.nowIso,
    lifecycleStatus: input.previous?.lifecycleStatus ?? (input.actorId.startsWith("owner:") ? "candidate" : "active"),
    claimStrength: input.previous?.claimStrength ?? (input.actorId.startsWith("owner:") ? "placeholder" : "native-start"),
    ...(typeof input.pid === "number" && Number.isInteger(input.pid) && input.pid > 0 ? { pid: input.pid } : input.previous?.pid ? { pid: input.previous.pid } : {}),
    ...(mergeEvidence(input.previous?.evidence, input.evidence) ? { evidence: mergeEvidence(input.previous?.evidence, input.evidence) } : {}),
    ...(input.previous?.turnCount ? { turnCount: input.previous.turnCount } : {}),
    ...(input.previous?.lastTurnId ? { lastTurnId: input.previous.lastTurnId } : {}),
    ...(input.previous?.mode ? { mode: input.previous.mode } : {}),
    ...(input.previous?.startedTurnCount ? { startedTurnCount: input.previous.startedTurnCount } : {}),
    ...(input.previous?.completedTurnCount ? { completedTurnCount: input.previous.completedTurnCount } : {}),
    ...(input.previous?.abortedTurnCount ? { abortedTurnCount: input.previous.abortedTurnCount } : {}),
    ...(input.previous?.lastTurnStatus ? { lastTurnStatus: input.previous.lastTurnStatus } : {}),
    ...(input.previous?.lastLifecycleEventAt ? { lastLifecycleEventAt: input.previous.lastLifecycleEventAt } : {}),
    ...(input.transcriptPath || input.previous?.transcriptPath ? { transcriptPath: input.transcriptPath || input.previous?.transcriptPath } : {}),
    ...(input.contextCwd || input.previous?.contextCwd ? { contextCwd: input.contextCwd || input.previous?.contextCwd } : {}),
  };
  return mergeLifecycleSummary(actor, input.lifecycle, input.nowIso);
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
  transcriptPath?: string;
  lifecycle?: CodexTranscriptLifecycleSummary | null;
  contextCwd?: string;
}): Promise<ActorRegistrationResult> {
  const nowIso = (input.now ?? new Date()).toISOString();
  const explicitActorId = firstString(input.threadId, input.nativeSessionId);
  const result = await updateSessionActors(input.cwd, input.sessionId, async (registry) => {
    await refreshOwnerLifecycleFromTranscript(registry, nowIso);
    let ownerActorId = registry.ownerActorId;
    let existingOwner = ownerActorId ? registry.actors[ownerActorId] : undefined;

    if (
      existingOwner
      && existingOwner.actorId.startsWith("owner:")
      && explicitActorId
      && (!existingOwner.threadId || existingOwner.threadId === existingOwner.actorId)
      && (!existingOwner.nativeSessionId || existingOwner.nativeSessionId === existingOwner.actorId)
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
        const classification: ActorClassification = {
          kind: "leader",
          audience: "external-owner",
          origin: {
            kind: "leader",
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
          ...(input.contextCwd ? { contextCwd: input.contextCwd } : {}),
          managedSessionId: input.sessionId,
        };
        const policy = resolveOwnerSessionStartPolicy({
          registry,
          classification,
          cwd: input.cwd,
          sessionId: input.sessionId,
          replacementPid: input.pid,
          replacementHasAuthoritativeStartEvidence: hasAuthoritativeReplacementStartEvidence({
            actorId: explicitActorId,
            threadId: input.threadId,
            nativeSessionId: input.nativeSessionId,
            lifecycle: input.lifecycle,
          }),
        });
        if (policy.action === "rebind-owner") {
          registry.actors[existingOwner.actorId] = {
            ...existingOwner,
            lifecycleStatus: "superseded",
            supersededByActorId: explicitActorId,
            supersededReason: policy.reason,
            lastLifecycleEventAt: nowIso,
          };
          ownerActorId = explicitActorId;
          existingOwner = undefined;
        } else {
          return {
            result: applyQuarantinedActor({
              registry,
              classification: {
                ...classification,
                evidence: [
                  ...classification.evidence,
                  ...policy.evidence.map((detail) => evidence("session-ownership", detail)),
                ],
              },
              reason: policy.reason,
              nowIso,
            }),
            write: true,
          };
        }
      }
    }

    if (!ownerActorId) {
      ownerActorId = explicitActorId || ownerPlaceholderActorId(input.sessionId);
    }

    const previous = registry.actors[ownerActorId];
    const actor = buildOwnerActor({
      previous,
      actorId: ownerActorId,
      threadId: input.threadId,
      nativeSessionId: input.nativeSessionId,
      pid: input.pid,
      source: input.source,
      nowIso,
      evidence: input.evidence,
      transcriptPath: input.transcriptPath,
      lifecycle: input.lifecycle,
      contextCwd: input.contextCwd,
    });

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
  const contextCwd = firstString(input.transcriptSessionMeta?.cwd, payload.cwd);
  const managedSessionId = firstString(payload.omx_session_id, payload.omxSessionId, payload.managed_session_id, payload.managedSessionId);

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
      ...(contextCwd ? [evidence(selected.source, "context_cwd_present")] : []),
    ],
    ...(contextCwd ? { contextCwd } : {}),
    ...(managedSessionId ? { managedSessionId } : {}),
  };
}

function ownerIsUnboundPlaceholder(registry: SessionActorRegistry): boolean {
  const owner = registry.ownerActorId ? registry.actors[registry.ownerActorId] : undefined;
  return Boolean(
    owner
    && owner.actorId.startsWith("owner:")
    && (!owner.threadId || owner.threadId === owner.actorId)
    && (!owner.nativeSessionId || owner.nativeSessionId === owner.actorId),
  );
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
    lifecycleStatus: "quarantined",
    ...(mergeEvidence(previous?.evidence, input.classification.evidence) ? { evidence: mergeEvidence(previous?.evidence, input.classification.evidence) } : {}),
    ...(input.classification.contextCwd ? { contextCwd: input.classification.contextCwd } : previous?.contextCwd ? { contextCwd: previous.contextCwd } : {}),
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
    reason: result.reason,
    ...(result.actor.lifecycleStatus ? { lifecycle_status: result.actor.lifecycleStatus } : {}),
    ...(result.actor.claimStrength ? { claim_strength: result.actor.claimStrength } : {}),
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
  transcriptPath?: string;
  lifecycle?: CodexTranscriptLifecycleSummary | null;
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
      transcriptPath: input.transcriptPath,
      lifecycle: input.lifecycle,
      contextCwd: classification.contextCwd,
    });
  }

  const result = await updateSessionActors(input.cwd, input.sessionId, async (registry) => {
    await refreshOwnerLifecycleFromTranscript(registry, nowIso);
    const policy = resolveOwnerSessionStartPolicy({
      registry,
      classification: {
        ...classification,
        managedSessionId: classification.managedSessionId || input.sessionId,
      },
      cwd: input.cwd,
      sessionId: input.sessionId,
      replacementPid: input.pid,
      replacementHasAuthoritativeStartEvidence: hasAuthoritativeReplacementStartEvidence({
        actorId: firstString(classification.actorId, classification.threadId, classification.nativeSessionId),
        threadId: classification.threadId,
        nativeSessionId: classification.nativeSessionId,
        lifecycle: input.lifecycle,
      }),
    });

    if (policy.action === "register-owner" || policy.action === "rebind-owner" || policy.action === "keep-owner") {
      const actorId = firstString(classification.actorId, classification.threadId, classification.nativeSessionId);
      const previousOwner = registry.ownerActorId ? registry.actors[registry.ownerActorId] : undefined;
      if (policy.action === "rebind-owner" && previousOwner) {
        registry.actors[previousOwner.actorId] = {
          ...previousOwner,
          lifecycleStatus: "superseded",
          supersededByActorId: actorId,
          supersededReason: policy.reason,
          lastLifecycleEventAt: nowIso,
        };
      }
      const previous = registry.actors[actorId];
      const actor = buildOwnerActor({
        previous,
        actorId,
        threadId: classification.threadId,
        nativeSessionId: classification.nativeSessionId,
        pid: input.pid,
        source: classification.source,
        nowIso,
        evidence: [
          ...classification.evidence,
          ...policy.evidence.map((detail) => evidence("session-ownership", detail)),
        ],
        transcriptPath: input.transcriptPath,
        lifecycle: input.lifecycle,
        contextCwd: classification.contextCwd,
      });
      registry.ownerActorId = actor.actorId;
      registry.actors[actor.actorId] = actor;
      registry.aliases = rebuildAliases(registry.actors);
      return {
        result: {
          registry,
          actor,
          outcome: "owner-registered" as const,
          reason: policy.reason,
        },
        write: true,
      };
    }

    if (policy.action === "quarantine") {
      return {
        result: applyQuarantinedActor({
          registry,
          classification: {
            ...classification,
            evidence: [
              ...classification.evidence,
              ...policy.evidence.map((detail) => evidence("session-ownership", detail)),
            ],
          },
          reason: policy.reason,
          nowIso,
        }),
        write: true,
      };
    }

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
      ...(input.transcriptPath || previous?.transcriptPath ? { transcriptPath: input.transcriptPath || previous?.transcriptPath } : {}),
      ...(classification.contextCwd || previous?.contextCwd ? { contextCwd: classification.contextCwd || previous?.contextCwd } : {}),
    };
    const mergedActor = mergeLifecycleSummary(actor, input.lifecycle, nowIso);
    registry.actors[actor.actorId] = mergedActor;
    registry.aliases = rebuildAliases(registry.actors);
    return {
      result: { registry, actor: mergedActor, outcome: "actor-registered" as const, reason: "actor_registered" },
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

export async function recordActorLifecycleEvent(input: {
  cwd: string;
  sessionId: string;
  actorIds: Array<string | undefined>;
  event: "task_started" | "turn_aborted" | "task_complete" | "completed_turn_delivered" | "turn_stopped";
  turnId?: string;
  timestamp?: string;
  source?: string;
}): Promise<SessionActorRegistry> {
  return await updateSessionActors(input.cwd, input.sessionId, async (registry) => {
    const actor = lookupActorByIds(registry, input.actorIds);
    if (!actor) return { result: registry, write: false };
    const timestamp = input.timestamp || new Date().toISOString();
    const next: SessionActorRecord = {
      ...actor,
      lastSeenAt: timestamp,
      lastLifecycleEventAt: timestamp,
      ...(input.turnId ? { lastTurnId: input.turnId } : {}),
      ...(mergeEvidence(actor.evidence, input.source ? [evidence(input.source, input.event)] : undefined)
        ? { evidence: mergeEvidence(actor.evidence, input.source ? [evidence(input.source, input.event)] : undefined) }
        : {}),
    };

    if (input.event === "task_started") {
      next.startedTurnCount = (actor.startedTurnCount ?? 0) + 1;
      next.lastTurnStatus = "started";
      next.lifecycleStatus = "active";
      if (next.claimStrength !== "completion-validated") next.claimStrength = "turn-started";
    } else if (input.event === "turn_aborted") {
      next.abortedTurnCount = (actor.abortedTurnCount ?? 0) + 1;
      next.lastTurnStatus = "aborted";
      if ((next.completedTurnCount ?? 0) === 0 && next.claimStrength !== "completion-validated") {
        next.lifecycleStatus = "aborted";
        next.claimStrength = next.startedTurnCount ? "turn-started" : next.claimStrength ?? "native-start";
      }
    } else if (input.event === "task_complete") {
      next.completedTurnCount = (actor.completedTurnCount ?? 0) + 1;
      next.lastTurnStatus = "completed";
      next.lifecycleStatus = "completed";
      if (next.claimStrength !== "completion-validated") {
        next.claimStrength = next.startedTurnCount ? "turn-started" : next.claimStrength ?? "native-start";
      }
    } else if (input.event === "completed_turn_delivered") {
      next.completedTurnCount = Math.max((actor.completedTurnCount ?? 0) + 1, 1);
      next.lastTurnStatus = "completed";
      next.lifecycleStatus = "completed";
      next.claimStrength = "completion-validated";
    } else if (input.event === "turn_stopped") {
      next.lastTurnStatus = "stopped";
      next.lifecycleStatus = "closed";
    }

    registry.actors[actor.actorId] = next;
    registry.aliases = rebuildAliases(registry.actors);
    return { result: registry, write: true };
  });
}

export async function markOwnerCompleted(input: {
  cwd: string;
  sessionId: string;
  actorId?: string;
  turnId?: string;
  timestamp?: string;
  source?: string;
}): Promise<SessionActorRegistry> {
  const registry = await readSessionActors(input.cwd, input.sessionId);
  const ownerActorId = input.actorId || registry.ownerActorId;
  return await recordActorLifecycleEvent({
    cwd: input.cwd,
    sessionId: input.sessionId,
    actorIds: [ownerActorId],
    event: "completed_turn_delivered",
    turnId: input.turnId,
    timestamp: input.timestamp,
    source: input.source ?? "completed-turn",
  });
}

export async function recordActorTranscriptLifecycle(input: {
  cwd: string;
  sessionId: string;
  actorIds: Array<string | undefined>;
  transcriptPath?: string;
  lifecycle?: CodexTranscriptLifecycleSummary | null;
  timestamp?: string;
}): Promise<SessionActorRegistry> {
  const lifecycle = input.lifecycle
    ?? await readCodexTranscriptLifecycle(input.transcriptPath).catch(() => null);
  if (!lifecycle) return await readSessionActors(input.cwd, input.sessionId);
  return await updateSessionActors(input.cwd, input.sessionId, async (registry) => {
    const actor = lookupActorByIds(registry, input.actorIds);
    if (!actor) return { result: registry, write: false };
    registry.actors[actor.actorId] = mergeLifecycleSummary(
      {
        ...actor,
        ...(input.transcriptPath || actor.transcriptPath ? { transcriptPath: input.transcriptPath || actor.transcriptPath } : {}),
      },
      lifecycle,
      input.timestamp || new Date().toISOString(),
    );
    registry.aliases = rebuildAliases(registry.actors);
    return { result: registry, write: true };
  });
}

export { isOwnerClaimReplaceable };

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
  const latestActorTimestamp = (candidates: readonly string[]): string | undefined => (
    candidates
      .filter((value) => Number.isFinite(Date.parse(value)))
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0]
  );
  const subagentUpdatedAt = latestActorTimestamp(subagents.map((actor) => actor.lastSeenAt));
  return {
    sessionId: registry.sessionId,
    leaderThreadId: owner?.threadId ?? owner?.nativeSessionId,
    allThreadIds,
    allSubagentThreadIds,
    activeSubagentThreadIds,
    updatedAt: subagentUpdatedAt ?? owner?.lastSeenAt ?? registry.updatedAt,
  };
}

export async function removeSessionActors(cwd: string, sessionId: string): Promise<void> {
  if (!isSafeSessionId(sessionId)) return;
  await rm(sessionActorsPath(cwd, sessionId), { force: true }).catch(() => {});
}
