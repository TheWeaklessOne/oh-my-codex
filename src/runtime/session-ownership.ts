import type {
  ActorClassification,
  SessionActorRecord,
  SessionActorRegistry,
} from "./session-actors.js";

export type ActorLifecycleStatus =
  | "candidate"
  | "active"
  | "aborted"
  | "completed"
  | "closed"
  | "superseded"
  | "quarantined";

export type OwnerClaimStrength =
  | "placeholder"
  | "native-start"
  | "turn-started"
  | "completion-validated";

export type ActorTurnLifecycleStatus =
  | "started"
  | "aborted"
  | "completed"
  | "stopped";

export type OwnerSessionStartPolicyAction =
  | "keep-owner"
  | "register-owner"
  | "rebind-owner"
  | "register-child"
  | "quarantine";

export interface OwnerSessionStartPolicyDecision {
  action: OwnerSessionStartPolicyAction;
  reason: string;
  previousOwnerId?: string;
  newOwnerId?: string;
  evidence: string[];
}

export interface OwnerSessionStartPolicyInput {
  registry: SessionActorRegistry;
  classification: ActorClassification;
  cwd: string;
  sessionId: string;
  replacementPid?: number;
  replacementHasAuthoritativeStartEvidence?: boolean;
}

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

function normalizePathForCompare(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = normalizePathForCompare(left);
  const normalizedRight = normalizePathForCompare(right);
  if (process.platform === "win32") {
    return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
  }
  return normalizedLeft === normalizedRight;
}

function actorIdForClassification(classification: ActorClassification): string {
  return firstString(
    classification.actorId,
    classification.threadId,
    classification.nativeSessionId,
  );
}

function classificationHasChildEvidence(classification: ActorClassification): boolean {
  return classification.kind === "native-subagent"
    || classification.kind === "team-worker"
    || classification.kind === "internal-helper"
    || classification.audience === "child"
    || classification.audience === "team-worker"
    || classification.audience === "internal-helper"
    || Boolean(safeString(classification.parentThreadId));
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function sessionStartContextMismatch(
  input: OwnerSessionStartPolicyInput,
  owner: SessionActorRecord | undefined,
): boolean {
  const contextCwd = safeString(input.classification.contextCwd);
  if (contextCwd && !samePath(contextCwd, input.cwd)) return true;
  const registryCwd = safeString(input.registry.cwd);
  if (registryCwd && !samePath(registryCwd, input.cwd)) return true;
  const managedSessionId = safeString(input.classification.managedSessionId);
  if (managedSessionId && managedSessionId !== input.sessionId) return true;
  const ownerPid = positiveInteger(owner?.pid);
  const replacementPid = positiveInteger(input.replacementPid);
  return Boolean(ownerPid && replacementPid && ownerPid !== replacementPid);
}

export function isSupersededOwner(actor: SessionActorRecord | undefined | null): boolean {
  return actor?.lifecycleStatus === "superseded";
}

export function isOwnerClaimCompleted(actor: SessionActorRecord | undefined | null): boolean {
  if (!actor) return false;
  return (actor.completedTurnCount ?? 0) > 0
    || actor.claimStrength === "completion-validated"
    || actor.lifecycleStatus === "completed";
}

export function isOwnerClaimReplaceable(actor: SessionActorRecord | undefined | null): boolean {
  if (!actor) return false;
  if (actor.quarantined === true) return false;
  if (actor.lifecycleStatus === "superseded" || actor.lifecycleStatus === "closed") return false;
  if (isOwnerClaimCompleted(actor)) return false;

  const weakClaim = actor.claimStrength == null
    || actor.claimStrength === "placeholder"
    || actor.claimStrength === "native-start"
    || actor.claimStrength === "turn-started";
  const startedTurnCount = actor.startedTurnCount ?? 0;
  const abortedTurnCount = actor.abortedTurnCount ?? 0;
  const hasAbortEvidence = abortedTurnCount > 0
    || actor.lastTurnStatus === "aborted"
    || actor.lifecycleStatus === "aborted";
  const abortIsTerminal = actor.lastTurnStatus === "aborted" || actor.lifecycleStatus === "aborted";
  const abortOnly = startedTurnCount === 0 || abortedTurnCount >= startedTurnCount;

  return weakClaim && hasAbortEvidence && abortIsTerminal && abortOnly;
}

export function isOwnerClaimDeliverable(actor: SessionActorRecord | undefined | null): boolean {
  if (!actor) return false;
  if (actor.quarantined === true) return false;
  if (actor.lifecycleStatus === "superseded" || actor.lifecycleStatus === "closed") return false;
  if (actor.kind !== "leader" || actor.audience !== "external-owner") return false;
  if (isOwnerClaimCompleted(actor)) return true;
  if (actor.lifecycleStatus === "active") return true;
  if ((actor.startedTurnCount ?? 0) > 0 && actor.lastTurnStatus !== "aborted") return true;
  return actor.claimStrength === "turn-started" && actor.lastTurnStatus !== "aborted";
}

export function resolveOwnerSessionStartPolicy(
  input: OwnerSessionStartPolicyInput,
): OwnerSessionStartPolicyDecision {
  const actorId = actorIdForClassification(input.classification);
  const ownerId = input.registry.ownerActorId;
  const owner = ownerId ? input.registry.actors[ownerId] : undefined;
  const evidence = [
    `actor_id=${actorId || "unknown"}`,
    `classification_kind=${input.classification.kind}`,
    `classification_audience=${input.classification.audience}`,
    `owner_actor_id=${ownerId || "none"}`,
    ...(owner?.lifecycleStatus ? [`owner_lifecycle=${owner.lifecycleStatus}`] : []),
    ...(owner?.claimStrength ? [`owner_claim=${owner.claimStrength}`] : []),
    ...(owner?.pid ? [`owner_pid=${owner.pid}`] : []),
    ...(input.replacementPid ? [`replacement_pid=${input.replacementPid}`] : []),
    `replacement_authoritative_start=${input.replacementHasAuthoritativeStartEvidence === true ? "true" : "false"}`,
  ];

  if (classificationHasChildEvidence(input.classification)) {
    return {
      action: owner ? "register-child" : "quarantine",
      reason: owner ? "session_start_child_actor" : "non_owner_without_owner",
      evidence: [...evidence, "child_evidence=true"],
    };
  }

  if (!actorId || actorId === "unknown") {
    return {
      action: "quarantine",
      reason: "session_start_actor_id_missing",
      evidence,
    };
  }

  if (actorId === input.sessionId) {
    return {
      action: "quarantine",
      reason: "owner_rebind_denied_context_mismatch",
      evidence: [...evidence, "actor_id_matches_managed_session_id"],
    };
  }

  if (!owner && input.classification.audience === "external-owner") {
    return {
      action: "register-owner",
      reason: "session_start_external_owner",
      newOwnerId: actorId,
      evidence,
    };
  }

  if (!owner) {
    return {
      action: "quarantine",
      reason: "non_owner_without_owner",
      newOwnerId: actorId,
      evidence,
    };
  }

  if (owner.actorId === actorId) {
    return {
      action: "keep-owner",
      reason: "owner_session_start_same_actor",
      previousOwnerId: owner.actorId,
      newOwnerId: actorId,
      evidence,
    };
  }

  if (sessionStartContextMismatch(input, owner)) {
    return {
      action: "quarantine",
      reason: "owner_rebind_denied_context_mismatch",
      previousOwnerId: owner.actorId,
      newOwnerId: actorId,
      evidence: [...evidence, "context_mismatch=true"],
    };
  }

  if (isOwnerClaimReplaceable(owner) && input.replacementHasAuthoritativeStartEvidence === true) {
    return {
      action: "rebind-owner",
      reason: "owner_rebound_after_aborted_candidate",
      previousOwnerId: owner.actorId,
      newOwnerId: actorId,
      evidence: [...evidence, "replaceable_owner=true"],
    };
  }

  if (isOwnerClaimReplaceable(owner)) {
    return {
      action: "quarantine",
      reason: "owner_rebind_denied_missing_replacement_evidence",
      previousOwnerId: owner.actorId,
      newOwnerId: actorId,
      evidence: [...evidence, "replaceable_owner=true"],
    };
  }

  if (isOwnerClaimCompleted(owner)) {
    return {
      action: "quarantine",
      reason: "owner_rebind_denied_completed_owner",
      previousOwnerId: owner.actorId,
      newOwnerId: actorId,
      evidence: [...evidence, "replaceable_owner=false"],
    };
  }

  return {
    action: "quarantine",
    reason: input.classification.reason === "external_owner_mismatch_with_active_owner"
      ? "external_owner_mismatch_with_active_owner"
      : input.classification.kind === "unknown"
      ? "unknown_actor_with_owner"
      : "owner_rebind_denied_active_owner",
    previousOwnerId: owner.actorId,
    newOwnerId: actorId,
    evidence: [...evidence, "replaceable_owner=false"],
  };
}
