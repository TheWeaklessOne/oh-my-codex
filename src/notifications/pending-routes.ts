import { createHash } from "crypto";
import { appendFile, mkdir } from "fs/promises";
import { join } from "path";
import type { CompletedTurnReplyOrigin, ReplyOriginPlatform } from "./completed-turn.js";
import type { TelegramMessageReferenceTarget } from "./types.js";
import { updateLockedJsonState } from "../runtime/locked-json-state.js";
import { readSessionActors } from "../runtime/session-actors.js";
import { omxLogsDir, omxStateDir } from "../utils/paths.js";

export type PendingRouteStatus = "pending" | "waiting-for-owner" | "dispatching";
export type PendingRouteTerminalStatus = "completed" | "failed" | "expired" | "delivery_unknown";

export interface PendingRoute {
  routeId: string;
  sessionId: string;
  ownerActorId: string;
  inputHash: string;
  inputPreview: string;
  injectedInput: string;
  platform: ReplyOriginPlatform;
  telegramAck?: TelegramMessageReferenceTarget;
  telegramReplyTo?: TelegramMessageReferenceTarget;
  status: PendingRouteStatus;
  lastNonTerminalStatus?: "suppressed-non-terminal";
  lastNonTerminalReason?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}

export interface PendingRouteTerminalRecord extends Omit<PendingRoute, "status"> {
  status: PendingRouteTerminalStatus;
  terminalReason?: string;
  terminalAt: string;
}

export interface PendingRoutesState {
  schemaVersion: 1;
  sessionId: string;
  routes: PendingRoute[];
  terminal: PendingRouteTerminalRecord[];
}

const PENDING_ROUTES_FILE = "pending-routes.json";
const SESSION_ID_SAFE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/;
const MAX_PENDING_ROUTES = 64;
const MAX_TERMINAL_ROUTES = 128;
const DEFAULT_ROUTE_TTL_MS = 12 * 60 * 60 * 1000;

function safeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isSafeSessionId(sessionId: string | undefined): sessionId is string {
  return !!sessionId && SESSION_ID_SAFE_PATTERN.test(sessionId);
}

function normalizeTelegramMessageReference(value: unknown): TelegramMessageReferenceTarget | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const chatId = safeString(raw.chatId);
  const messageId = safeString(raw.messageId);
  if (!chatId || !messageId) return undefined;
  const messageThreadId = safeString(raw.messageThreadId);
  return {
    chatId,
    messageId,
    ...(messageThreadId ? { messageThreadId } : {}),
  };
}

function normalizePlatform(value: unknown): ReplyOriginPlatform | "" {
  return value === "telegram" || value === "discord" ? value : "";
}

export function normalizeRouteInput(input: string): string {
  return input.trim();
}

export function hashRouteInput(input: string): string {
  return `sha256:${createHash("sha256").update(normalizeRouteInput(input)).digest("hex")}`;
}

function buildRouteId(platform: ReplyOriginPlatform, sessionId: string, inputHash: string, createdAt: string, ordinal: number): string {
  return `${platform}:${sessionId}:${inputHash.slice("sha256:".length, "sha256:".length + 16)}:${Date.parse(createdAt) || Date.now()}:${ordinal}`;
}

export function pendingRoutesStatePath(projectPath: string, sessionId: string): string {
  return join(omxStateDir(projectPath), "sessions", sessionId, PENDING_ROUTES_FILE);
}

function createEmptyPendingRoutesState(sessionId: string): PendingRoutesState {
  return {
    schemaVersion: 1,
    sessionId,
    routes: [],
    terminal: [],
  };
}

function normalizeRoute(value: unknown, fallbackSessionId: string): PendingRoute | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const platform = normalizePlatform(raw.platform);
  const injectedInput = safeString(raw.injectedInput);
  const ownerActorId = safeString(raw.ownerActorId);
  const sessionId = safeString(raw.sessionId) || fallbackSessionId;
  const routeId = safeString(raw.routeId);
  if (!platform || !injectedInput || !ownerActorId || !sessionId || !routeId) return null;
  const inputHash = safeString(raw.inputHash) || hashRouteInput(injectedInput);
  const status = raw.status === "waiting-for-owner"
    ? "waiting-for-owner"
    : raw.status === "dispatching"
      ? "dispatching"
      : "pending";
  const createdAt = safeString(raw.createdAt) || new Date(0).toISOString();
  const updatedAt = safeString(raw.updatedAt) || createdAt;
  const lastNonTerminalStatus = raw.lastNonTerminalStatus === "suppressed-non-terminal"
    ? "suppressed-non-terminal"
    : undefined;
  return {
    routeId,
    sessionId,
    ownerActorId,
    inputHash,
    inputPreview: safeString(raw.inputPreview) || injectedInput.slice(0, 160),
    injectedInput,
    platform,
    ...(normalizeTelegramMessageReference(raw.telegramAck) ? { telegramAck: normalizeTelegramMessageReference(raw.telegramAck) } : {}),
    ...(normalizeTelegramMessageReference(raw.telegramReplyTo) ? { telegramReplyTo: normalizeTelegramMessageReference(raw.telegramReplyTo) } : {}),
    status,
    ...(lastNonTerminalStatus ? { lastNonTerminalStatus } : {}),
    ...(safeString(raw.lastNonTerminalReason) ? { lastNonTerminalReason: safeString(raw.lastNonTerminalReason) } : {}),
    createdAt,
    updatedAt,
    ...(safeString(raw.expiresAt) ? { expiresAt: safeString(raw.expiresAt) } : {}),
  };
}

function normalizeTerminalRoute(value: unknown, fallbackSessionId: string): PendingRouteTerminalRecord | null {
  const route = normalizeRoute({
    ...(asRecord(value) ?? {}),
    status: "pending",
  }, fallbackSessionId);
  const raw = asRecord(value);
  if (!route || !raw) return null;
  const status = raw.status === "failed"
    || raw.status === "expired"
    || raw.status === "delivery_unknown"
    ? raw.status
    : "completed";
  const terminalAt = safeString(raw.terminalAt) || route.updatedAt;
  return {
    ...route,
    status,
    terminalAt,
    ...(safeString(raw.terminalReason) ? { terminalReason: safeString(raw.terminalReason) } : {}),
  };
}

function normalizePendingRoutesState(raw: unknown, sessionId: string): PendingRoutesState {
  const parsed = asRecord(raw);
  if (!parsed) return createEmptyPendingRoutesState(sessionId);
  return {
    schemaVersion: 1,
    sessionId: safeString(parsed.sessionId) || sessionId,
    routes: Array.isArray(parsed.routes)
      ? parsed.routes.map((entry) => normalizeRoute(entry, sessionId)).filter((entry): entry is PendingRoute => entry !== null)
      : [],
    terminal: Array.isArray(parsed.terminal)
      ? parsed.terminal.map((entry) => normalizeTerminalRoute(entry, sessionId)).filter((entry): entry is PendingRouteTerminalRecord => entry !== null)
      : [],
  };
}

function prunePendingRoutesState(state: PendingRoutesState): PendingRoutesState {
  return {
    schemaVersion: 1,
    sessionId: state.sessionId,
    routes: state.routes.slice(-MAX_PENDING_ROUTES),
    terminal: state.terminal.slice(-MAX_TERMINAL_ROUTES),
  };
}

async function updatePendingRoutes<TResult>(
  projectPath: string,
  sessionId: string,
  update: (state: PendingRoutesState) => Promise<{
    result: TResult;
    write: boolean;
  }>,
): Promise<TResult> {
  const path = pendingRoutesStatePath(projectPath, sessionId);
  return await updateLockedJsonState(path, async (raw) => {
    const state = normalizePendingRoutesState(raw, sessionId);
    const mutation = await update(state);
    return {
      result: mutation.result,
      nextState: prunePendingRoutesState(state),
      write: mutation.write,
    };
  });
}

async function appendPendingRouteLog(projectPath: string, entry: Record<string, unknown>): Promise<void> {
  try {
    const logsDir = omxLogsDir(projectPath);
    await mkdir(logsDir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    await appendFile(
      join(logsDir, `pending-routes-${date}.jsonl`),
      `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`,
    );
  } catch {
    // Route observability must never block transport intake/delivery.
  }
}

export async function recordPendingRoute(
  projectPath: string | undefined,
  sessionId: string | undefined,
  pending: Omit<CompletedTurnReplyOrigin, "createdAt"> & {
    createdAt?: string;
    ownerActorId?: string;
    ttlMs?: number;
  },
): Promise<boolean> {
  if (!projectPath || !isSafeSessionId(sessionId)) return false;
  const ownerActorId = safeString(pending.ownerActorId)
    || safeString((await readSessionActors(projectPath, sessionId)).ownerActorId);
  if (!ownerActorId) return false;

  const createdAt = pending.createdAt || new Date().toISOString();
  const ttlMs = typeof pending.ttlMs === "number" && Number.isFinite(pending.ttlMs) && pending.ttlMs > 0
    ? pending.ttlMs
    : DEFAULT_ROUTE_TTL_MS;
  const expiresAt = new Date(Date.parse(createdAt) + ttlMs).toISOString();
  const inputHash = hashRouteInput(pending.injectedInput);
  const route = await updatePendingRoutes(projectPath, sessionId, async (state) => {
    const route: PendingRoute = {
      routeId: buildRouteId(pending.platform, sessionId, inputHash, createdAt, state.routes.length + state.terminal.length),
      sessionId,
      ownerActorId,
      inputHash,
      inputPreview: normalizeRouteInput(pending.injectedInput).slice(0, 160),
      injectedInput: pending.injectedInput,
      platform: pending.platform,
      ...(pending.platform === "telegram" && pending.telegramAck ? { telegramAck: pending.telegramAck } : {}),
      ...(pending.platform === "telegram" && pending.telegramReplyTo ? { telegramReplyTo: pending.telegramReplyTo } : {}),
      status: "pending",
      createdAt,
      updatedAt: createdAt,
      expiresAt,
    };
    state.routes.push(route);
    return { result: route, write: true };
  });
  await appendPendingRouteLog(projectPath, {
    event: "pending_route_created",
    session_id: sessionId,
    route_id: route.routeId,
    owner_actor_id: ownerActorId,
    platform: route.platform,
  });
  return true;
}

function routeToReplyOrigin(route: PendingRoute): CompletedTurnReplyOrigin {
  return {
    routeId: route.routeId,
    platform: route.platform,
    injectedInput: route.injectedInput,
    createdAt: route.createdAt,
    ...(route.platform === "telegram" && route.telegramAck ? { telegramAck: route.telegramAck } : {}),
    ...(route.platform === "telegram" && route.telegramReplyTo ? { telegramReplyTo: route.telegramReplyTo } : {}),
  };
}

export async function markPendingRoutesWaitingForOwner(
  projectPath: string | undefined,
  sessionId: string | undefined,
  input: {
    ownerActorId?: string;
    reason: string;
    observedAt?: string;
  },
): Promise<number> {
  if (!projectPath || !isSafeSessionId(sessionId)) return 0;
  const ownerActorId = safeString(input.ownerActorId)
    || safeString((await readSessionActors(projectPath, sessionId)).ownerActorId);
  if (!ownerActorId) return 0;
  const observedAt = input.observedAt || new Date().toISOString();
  const placeholderOwnerActorId = `owner:${sessionId}`;
  const count = await updatePendingRoutes(projectPath, sessionId, async (state) => {
    let count = 0;
    state.routes = state.routes.map((route) => {
      if (route.ownerActorId !== ownerActorId && route.ownerActorId !== placeholderOwnerActorId) return route;
      count++;
      return {
        ...route,
        status: "waiting-for-owner",
        lastNonTerminalStatus: "suppressed-non-terminal",
        lastNonTerminalReason: input.reason,
        updatedAt: observedAt,
      };
    });
    return { result: count, write: count > 0 };
  });
  if (count > 0) {
    await appendPendingRouteLog(projectPath, {
      event: "pending_route_waiting_for_owner",
      session_id: sessionId,
      owner_actor_id: ownerActorId,
      waiting_routes: count,
      reason: input.reason,
    });
  }
  return count;
}

function expireRoutesInState(
  state: PendingRoutesState,
  now: Date,
): PendingRouteTerminalRecord[] {
  const nowMs = now.getTime();
  const expired: PendingRouteTerminalRecord[] = [];
  const remaining: PendingRoute[] = [];
  for (const route of state.routes) {
    const expiresAtMs = route.expiresAt ? Date.parse(route.expiresAt) : Number.NaN;
    if (Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs) {
      const terminalAt = now.toISOString();
      expired.push({
        ...route,
        status: "expired",
        terminalReason: "route_ttl_expired",
        terminalAt,
        updatedAt: terminalAt,
      });
    } else {
      remaining.push(route);
    }
  }
  if (expired.length > 0) {
    state.routes = remaining;
    state.terminal.push(...expired);
  }
  return expired;
}

async function logExpiredRoutes(
  projectPath: string,
  sessionId: string,
  expired: PendingRouteTerminalRecord[],
): Promise<void> {
  for (const route of expired) {
    await appendPendingRouteLog(projectPath, {
      event: "pending_route_expired",
      session_id: sessionId,
      route_id: route.routeId,
      owner_actor_id: route.ownerActorId,
      platform: route.platform,
    });
  }
}

export async function consumePendingRouteForOwnerCompletion(
  projectPath: string | undefined,
  sessionId: string | undefined,
  input: {
    ownerActorId: string | undefined;
    latestInput: string;
    completedAt?: string;
  },
): Promise<CompletedTurnReplyOrigin | null> {
  if (!projectPath || !isSafeSessionId(sessionId)) return null;
  const ownerActorId = safeString(input.ownerActorId);
  if (!ownerActorId) return null;
  const inputHash = hashRouteInput(input.latestInput);
  const placeholderOwnerActorId = `owner:${sessionId}`;
  const completedAt = input.completedAt || new Date().toISOString();
  const now = new Date(completedAt);
  type ConsumeMutationResult = {
    replyOrigin: CompletedTurnReplyOrigin | null;
    completedRoute: PendingRoute | null;
    expired: PendingRouteTerminalRecord[];
  };
  const mutation = await updatePendingRoutes<ConsumeMutationResult>(projectPath, sessionId, async (state) => {
    const expired = Number.isFinite(now.getTime()) ? expireRoutesInState(state, now) : [];
    const routeIndex = state.routes.findIndex((route) =>
      (route.ownerActorId === ownerActorId || route.ownerActorId === placeholderOwnerActorId)
      && route.inputHash === inputHash
      && route.status !== "dispatching"
    );
    if (routeIndex === -1) {
      return {
        result: { replyOrigin: null, completedRoute: null, expired },
        write: expired.length > 0,
      };
    }
    const [route] = state.routes.splice(routeIndex, 1);
    if (!route) {
      return {
        result: { replyOrigin: null, completedRoute: null, expired },
        write: expired.length > 0,
      };
    }
    const completedRoute = route.ownerActorId === placeholderOwnerActorId
      ? { ...route, ownerActorId }
      : route;
    state.terminal.push({
      ...completedRoute,
      status: "completed",
      updatedAt: completedAt,
      terminalAt: completedAt,
    });
    return {
      result: {
        replyOrigin: routeToReplyOrigin(completedRoute),
        completedRoute,
        expired,
      },
      write: true,
    };
  });
  if (mutation.expired.length > 0) {
    await logExpiredRoutes(projectPath, sessionId, mutation.expired);
  }
  if (!mutation.replyOrigin || !mutation.completedRoute) return null;
  await appendPendingRouteLog(projectPath, {
    event: "pending_route_completed",
    session_id: sessionId,
    route_id: mutation.completedRoute.routeId,
    owner_actor_id: mutation.completedRoute.ownerActorId,
    platform: mutation.completedRoute.platform,
  });
  return mutation.replyOrigin;
}

export async function claimPendingRouteForOwnerCompletion(
  projectPath: string | undefined,
  sessionId: string | undefined,
  input: {
    ownerActorId: string | undefined;
    latestInput: string;
    claimedAt?: string;
  },
): Promise<CompletedTurnReplyOrigin | null> {
  if (!projectPath || !isSafeSessionId(sessionId)) return null;
  const ownerActorId = safeString(input.ownerActorId);
  if (!ownerActorId) return null;
  const inputHash = hashRouteInput(input.latestInput);
  const placeholderOwnerActorId = `owner:${sessionId}`;
  const claimedAt = input.claimedAt || new Date().toISOString();
  const now = new Date(claimedAt);
  type ClaimMutationResult = {
    replyOrigin: CompletedTurnReplyOrigin | null;
    claimedRoute: PendingRoute | null;
    expired: PendingRouteTerminalRecord[];
  };
  const mutation = await updatePendingRoutes<ClaimMutationResult>(projectPath, sessionId, async (state) => {
    const expired = Number.isFinite(now.getTime()) ? expireRoutesInState(state, now) : [];
    const routeIndex = state.routes.findIndex((route) =>
      (route.ownerActorId === ownerActorId || route.ownerActorId === placeholderOwnerActorId)
      && route.inputHash === inputHash
      && route.status !== "dispatching"
    );
    if (routeIndex === -1) {
      return {
        result: { replyOrigin: null, claimedRoute: null, expired },
        write: expired.length > 0,
      };
    }
    const route = state.routes[routeIndex];
    if (!route) {
      return {
        result: { replyOrigin: null, claimedRoute: null, expired },
        write: expired.length > 0,
      };
    }
    const claimedRoute = {
      ...route,
      ownerActorId: route.ownerActorId === placeholderOwnerActorId ? ownerActorId : route.ownerActorId,
      status: "dispatching" as const,
      updatedAt: claimedAt,
    };
    state.routes[routeIndex] = claimedRoute;
    return {
      result: {
        replyOrigin: routeToReplyOrigin(claimedRoute),
        claimedRoute,
        expired,
      },
      write: true,
    };
  });
  if (mutation.expired.length > 0) {
    await logExpiredRoutes(projectPath, sessionId, mutation.expired);
  }
  if (!mutation.replyOrigin || !mutation.claimedRoute) return null;
  await appendPendingRouteLog(projectPath, {
    event: "pending_route_dispatching",
    session_id: sessionId,
    route_id: mutation.claimedRoute.routeId,
    owner_actor_id: mutation.claimedRoute.ownerActorId,
    platform: mutation.claimedRoute.platform,
  });
  return mutation.replyOrigin;
}

export async function markPendingRouteSent(
  projectPath: string | undefined,
  sessionId: string | undefined,
  routeId: string | undefined,
  input: {
    terminalAt?: string;
  } = {},
): Promise<boolean> {
  if (!projectPath || !isSafeSessionId(sessionId) || !safeString(routeId)) return false;
  const terminalAt = input.terminalAt || new Date().toISOString();
  const marked = await updatePendingRoutes(projectPath, sessionId, async (state) => {
    const existingTerminal = state.terminal.find((route) => route.routeId === routeId);
    if (existingTerminal?.status === "completed") return { result: true, write: false };
    const pendingIndex = state.routes.findIndex((route) => route.routeId === routeId);
    if (pendingIndex === -1) return { result: false, write: false };
    const [route] = state.routes.splice(pendingIndex, 1);
    if (!route) return { result: false, write: false };
    state.terminal.push({
      ...route,
      status: "completed",
      terminalAt,
      updatedAt: terminalAt,
    });
    return { result: true, write: true };
  });
  if (!marked) return false;
  await appendPendingRouteLog(projectPath, {
    event: "pending_route_sent",
    session_id: sessionId,
    route_id: routeId,
  });
  return true;
}

export async function markPendingRouteTerminalFailure(
  projectPath: string | undefined,
  sessionId: string | undefined,
  routeId: string | undefined,
  input: {
    status: "failed" | "expired" | "delivery_unknown";
    reason: string;
    terminalAt?: string;
  },
): Promise<boolean> {
  if (!projectPath || !isSafeSessionId(sessionId) || !safeString(routeId)) return false;
  const terminalAt = input.terminalAt || new Date().toISOString();
  const marked = await updatePendingRoutes(projectPath, sessionId, async (state) => {
    const existingTerminalIndex = state.terminal.findIndex((route) => route.routeId === routeId);
    if (existingTerminalIndex !== -1) {
      const existing = state.terminal[existingTerminalIndex]!;
      if (existing.status === "completed") return { result: false, write: false };
      state.terminal[existingTerminalIndex] = {
        ...existing,
        status: input.status,
        terminalReason: input.reason,
        terminalAt,
        updatedAt: terminalAt,
      };
      return { result: true, write: true };
    }
    const pendingIndex = state.routes.findIndex((route) => route.routeId === routeId);
    if (pendingIndex === -1) return { result: false, write: false };
    const [route] = state.routes.splice(pendingIndex, 1);
    if (!route) return { result: false, write: false };
    state.terminal.push({
      ...route,
      status: input.status,
      terminalReason: input.reason,
      terminalAt,
      updatedAt: terminalAt,
    });
    return { result: true, write: true };
  });
  if (!marked) return false;
  await appendPendingRouteLog(projectPath, {
    event: `pending_route_${input.status}`,
    session_id: sessionId,
    route_id: routeId,
    reason: input.reason,
  });
  return true;
}

export async function expirePendingRoutes(
  projectPath: string | undefined,
  sessionId: string | undefined,
  now: Date = new Date(),
): Promise<PendingRouteTerminalRecord[]> {
  if (!projectPath || !isSafeSessionId(sessionId)) return [];
  const expired = await updatePendingRoutes(projectPath, sessionId, async (state) => {
    const expired = expireRoutesInState(state, now);
    return { result: expired, write: expired.length > 0 };
  });
  await logExpiredRoutes(projectPath, sessionId, expired);
  return expired;
}
