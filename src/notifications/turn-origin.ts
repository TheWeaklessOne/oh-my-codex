export type TurnOriginKind =
  | "leader"
  | "native-subagent"
  | "team-worker"
  | "internal-helper"
  | "unknown";

export interface TurnOrigin {
  kind: TurnOriginKind;
  threadId?: string;
  parentThreadId?: string;
  teamName?: string;
  workerName?: string;
  nativeSessionId?: string;
  agentNickname?: string;
  agentRole?: string;
  source?: string;
}

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

function parseTeamWorkerEnv(rawValue: unknown): Pick<TurnOrigin, "teamName" | "workerName"> | null {
  const raw = safeString(rawValue);
  const match = /^([a-z0-9][a-z0-9-]{0,29})\/(worker-\d+)$/.exec(raw);
  if (!match) return null;
  return {
    teamName: match[1],
    workerName: match[2],
  };
}

function normalizeExplicitKind(value: unknown): TurnOriginKind | "" {
  const normalized = safeString(value).toLowerCase();
  if (normalized === "leader") return "leader";
  if (
    normalized === "native-subagent"
    || normalized === "native_subagent"
    || normalized === "subagent"
  ) {
    return "native-subagent";
  }
  if (
    normalized === "team-worker"
    || normalized === "team_worker"
    || normalized === "worker"
  ) {
    return "team-worker";
  }
  if (
    normalized === "internal-helper"
    || normalized === "internal_helper"
    || normalized === "helper"
    || normalized === "omx-helper"
    || normalized === "omx_helper"
  ) {
    return "internal-helper";
  }
  if (normalized === "unknown") return "unknown";
  return "";
}

function buildOriginFromExplicit(
  rawOrigin: Record<string, unknown>,
  fallback: TurnOrigin,
): TurnOrigin | null {
  const kind = normalizeExplicitKind(rawOrigin.kind || rawOrigin.type || rawOrigin.origin);
  if (!kind) return null;

  const parentThreadId = firstString(
    rawOrigin.parentThreadId,
    rawOrigin.parent_thread_id,
    rawOrigin.leaderThreadId,
    rawOrigin.leader_thread_id,
  );

  return {
    ...fallback,
    kind,
    threadId: firstString(rawOrigin.threadId, rawOrigin.thread_id, fallback.threadId),
    ...(parentThreadId ? { parentThreadId } : {}),
    teamName: firstString(rawOrigin.teamName, rawOrigin.team_name, fallback.teamName),
    workerName: firstString(rawOrigin.workerName, rawOrigin.worker_name, fallback.workerName),
    nativeSessionId: firstString(rawOrigin.nativeSessionId, rawOrigin.native_session_id, fallback.nativeSessionId),
    agentNickname: firstString(rawOrigin.agentNickname, rawOrigin.agent_nickname, fallback.agentNickname),
    agentRole: firstString(rawOrigin.agentRole, rawOrigin.agent_role, fallback.agentRole),
    source: firstString(rawOrigin.source, fallback.source),
  };
}

function extractSubagentSourceOrigin(
  source: Record<string, unknown>,
  fallback: TurnOrigin,
): TurnOrigin | null {
  const sourceKind = normalizeExplicitKind(source.kind || source.type || source.origin);
  const subagent = asRecord(source.subagent);
  const threadSpawn = asRecord(subagent?.thread_spawn) ?? asRecord(subagent?.threadSpawn);
  const parentThreadId = firstString(
    threadSpawn?.parent_thread_id,
    threadSpawn?.parentThreadId,
    subagent?.parent_thread_id,
    subagent?.parentThreadId,
    source.parent_thread_id,
    source.parentThreadId,
    source.leader_thread_id,
    source.leaderThreadId,
  );

  if (subagent || sourceKind === "native-subagent" || parentThreadId) {
    return {
      ...fallback,
      kind: "native-subagent",
      ...(parentThreadId ? { parentThreadId } : {}),
      agentNickname: firstString(
        subagent?.agent_nickname,
        subagent?.agentNickname,
        source.agent_nickname,
        source.agentNickname,
        fallback.agentNickname,
      ),
      agentRole: firstString(
        subagent?.agent_role,
        subagent?.agentRole,
        source.agent_role,
        source.agentRole,
        fallback.agentRole,
      ),
      source: firstString(source.source, sourceKind, fallback.source),
    };
  }

  if (sourceKind === "leader" || sourceKind === "team-worker" || sourceKind === "internal-helper") {
    return {
      ...fallback,
      kind: sourceKind,
      source: firstString(source.source, sourceKind, fallback.source),
    };
  }

  return null;
}

function extractOriginFromContainer(
  container: Record<string, unknown> | null,
  fallback: TurnOrigin,
): TurnOrigin | null {
  if (!container) return null;

  const explicitContainers = [
    asRecord(container.origin),
    asRecord(container.turn_origin),
    asRecord(container.turnOrigin),
  ];
  for (const rawOrigin of explicitContainers) {
    if (!rawOrigin) continue;
    const parsed = buildOriginFromExplicit(rawOrigin, fallback);
    if (parsed) return parsed;
  }

  const source = asRecord(container.source);
  if (source) {
    const parsed = extractSubagentSourceOrigin(source, fallback);
    if (parsed) return parsed;
  }

  return null;
}

export function resolveTurnOrigin(
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): TurnOrigin {
  const threadId = firstString(
    payload["thread-id"],
    payload.thread_id,
    payload.threadId,
    payload.id,
  );
  const nativeSessionId = firstString(
    payload.session_id,
    payload["session-id"],
    payload.native_session_id,
    payload.nativeSessionId,
  );
  const source = firstString(payload.source);
  const fallback: TurnOrigin = {
    kind: "unknown",
    ...(threadId ? { threadId } : {}),
    ...(nativeSessionId ? { nativeSessionId } : {}),
    ...(source ? { source } : {}),
  };

  const teamWorker = parseTeamWorkerEnv(env.OMX_TEAM_WORKER);
  if (teamWorker) {
    return {
      ...fallback,
      kind: "team-worker",
      ...teamWorker,
    };
  }

  if (env.OMX_SUPPRESS_COMPLETED_TURN === "1") {
    return {
      ...fallback,
      kind: "internal-helper",
      source: firstString(env.OMX_SUPPRESS_COMPLETED_TURN_REASON, fallback.source, "omx-internal-helper"),
    };
  }

  const topLevel = extractOriginFromContainer(payload, fallback);
  if (topLevel) return topLevel;

  const sessionMeta = asRecord(payload.session_meta)
    ?? asRecord(payload.sessionMeta)
    ?? asRecord(payload["session-meta"]);
  const sessionMetaPayload = asRecord(sessionMeta?.payload) ?? sessionMeta;
  const sessionMetaFallback: TurnOrigin = {
    ...fallback,
    threadId: firstString(sessionMetaPayload?.id, sessionMetaPayload?.thread_id, fallback.threadId),
    agentNickname: firstString(
      sessionMetaPayload?.agent_nickname,
      sessionMetaPayload?.agentNickname,
      fallback.agentNickname,
    ),
    agentRole: firstString(
      sessionMetaPayload?.agent_role,
      sessionMetaPayload?.agentRole,
      fallback.agentRole,
    ),
  };
  const fromSessionMeta = extractOriginFromContainer(sessionMetaPayload, sessionMetaFallback);
  if (fromSessionMeta) return fromSessionMeta;

  const metadata = asRecord(payload.metadata) ?? asRecord(payload.meta);
  const fromMetadata = extractOriginFromContainer(metadata, fallback);
  if (fromMetadata) return fromMetadata;

  return fallback;
}

export function isExternalCompletedTurnSuppressedOrigin(origin: TurnOrigin): boolean {
  return origin.kind === "native-subagent"
    || origin.kind === "team-worker"
    || origin.kind === "internal-helper";
}
