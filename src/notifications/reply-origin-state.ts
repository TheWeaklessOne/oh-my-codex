import type { CompletedTurnReplyOrigin } from "./completed-turn.js";
import {
  claimPendingRouteForOwnerCompletion,
  consumePendingRouteForOwnerCompletion,
  markPendingRouteSent,
  recordPendingRoute,
} from "./pending-routes.js";
import { readSessionActors } from "../runtime/session-actors.js";

export async function recordPendingReplyOrigin(
  projectPath: string | undefined,
  sessionId: string | undefined,
  pending: Omit<CompletedTurnReplyOrigin, "createdAt"> & {
    createdAt?: string;
  },
): Promise<boolean> {
  return await recordPendingRoute(projectPath, sessionId, pending);
}

export async function consumePendingReplyOrigin(
  projectPath: string | undefined,
  sessionId: string | undefined,
  latestInput: string,
  ownerActorId?: string,
): Promise<CompletedTurnReplyOrigin | null> {
  if (!projectPath || !sessionId) return null;
  const registry = await readSessionActors(projectPath, sessionId);
  return await consumePendingRouteForOwnerCompletion(projectPath, sessionId, {
    ownerActorId: ownerActorId || registry.ownerActorId,
    latestInput,
  });
}

export async function claimPendingReplyOrigin(
  projectPath: string | undefined,
  sessionId: string | undefined,
  latestInput: string,
  ownerActorId?: string,
): Promise<CompletedTurnReplyOrigin | null> {
  if (!projectPath || !sessionId) return null;
  const registry = await readSessionActors(projectPath, sessionId);
  return await claimPendingRouteForOwnerCompletion(projectPath, sessionId, {
    ownerActorId: ownerActorId || registry.ownerActorId,
    latestInput,
  });
}

export async function markPendingReplyOriginSent(
  projectPath: string | undefined,
  sessionId: string | undefined,
  routeId: string | undefined,
): Promise<boolean> {
  return await markPendingRouteSent(projectPath, sessionId, routeId);
}
