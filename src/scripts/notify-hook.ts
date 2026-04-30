#!/usr/bin/env node

/**
 * oh-my-codex Notification Hook
 * Codex CLI fires this after each agent turn via the `notify` config.
 * Receives JSON payload as the last argv argument.
 *
 * Responsibilities are split into sub-modules under scripts/notify-hook/:
 *   utils.js           – pure helpers (asNumber, safeString, …)
 *   payload-parser.js  – payload field extraction
 *   state-io.js        – state file I/O and normalization
 *   process-runner.js  – child-process helper
 *   log.js             – structured event logging
 *   auto-nudge.js      – stall-pattern detection and auto-nudge
 *   tmux-injection.js  – tmux prompt injection
 *   team-dispatch.js   – durable team dispatch queue consumer
 *   team-leader-nudge.js – leader mailbox nudge
 *   team-worker.js     – worker heartbeat and idle notification
 */

import { writeFile, appendFile, mkdir, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';

import { safeString, asNumber } from './notify-hook/utils.js';
import {
  getSessionTokenUsage,
  getQuotaUsage,
  normalizeInputMessages,
} from './notify-hook/payload-parser.js';
import {
  getScopedStatePath,
  readScopedJsonIfExists,
  readCurrentSessionId,
  getScopedStateDirsForCurrentSession,
  resolveScopedStateDir,
  normalizeNotifyState,
  pruneRecentTurns,
  readdir,
  LockedJsonStateWriteError,
  updateLockedJsonState,
} from './notify-hook/state-io.js';
import { isLeaderStale, resolveLeaderStalenessThresholdMs, maybeNudgeTeamLeader } from './notify-hook/team-leader-nudge.js';
import { drainPendingTeamDispatch } from './notify-hook/team-dispatch.js';
import { handleTmuxInjection } from './notify-hook/tmux-injection.js';
import {
  maybeAutoNudge,
  resolveNudgePaneTarget,
  isDeepInterviewStateActive,
  isDeepInterviewInputLockActive,
  syncSkillStateFromTurn,
} from './notify-hook/auto-nudge.js';
import { isManagedOmxSession } from './notify-hook/managed-tmux.js';
import { logNotifyHookEvent } from './notify-hook/log.js';
import { reconcileRalphSessionResume } from './notify-hook/ralph-session-resume.js';
import { sendPaneInput } from './notify-hook/team-tmux-guard.js';
import {
  buildOperationalContext,
  deriveAssistantSignalEvents,
  readRepositoryMetadata,
  resolveOperationalSessionName,
} from './notify-hook/operational-events.js';
import {
  classifyCompletedTurn,
} from '../runtime/turn-semantics.js';
import {
  buildCompletedTurnHookFingerprint,
  planCompletedTurnNotification,
} from '../notifications/completed-turn.js';
import { resolveTurnOriginForNotification } from '../runtime/codex-session-origin.js';
import { consumePendingReplyOrigin } from '../notifications/reply-origin-state.js';
import {
  expirePendingRoutes,
  markPendingRouteTerminalFailure,
  markPendingRoutesWaitingForOwner,
} from '../notifications/pending-routes.js';
import { deleteTelegramAcceptedAckBestEffort } from '../notifications/telegram-inbound/ack.js';
import { readUsableSessionState } from '../hooks/session.js';
import {
  parseTeamWorkerEnv,
  resolveTeamStateDirForWorker,
  updateWorkerHeartbeat,
  maybeNotifyLeaderAllWorkersIdle,
  maybeNotifyLeaderWorkerIdle,
} from './notify-hook/team-worker.js';
import { DEFAULT_MARKER } from './tmux-hook-engine.js';

const NOTIFY_HOOK_STATE_FILE = 'notify-hook-state.json';
const NOTIFY_HOOK_TURN_DEDUPE_FILE = 'notify-hook-turn-dedupe.json';
const NOTIFY_HOOK_TURN_DEDUPE_LOCK_FILE = 'notify-hook-turn-dedupe.lock';
const PROJECT_TURN_PENDING_RECOVERY_TTL_MS = 5 * 60_000;
const PROJECT_TURN_DISPATCHING_RECOVERY_TTL_MS = 60_000;

const RALPH_ACTIVE_PROGRESS_PHASES = new Set([
  'start',
  'started',
  'starting',
  'execute',
  'execution',
  'executing',
  'verify',
  'verification',
  'verifying',
  'fix',
  'fixing',
]);

function isTurnCompletePayload(payload: Record<string, unknown>): boolean {
  const type = safeString(payload.type || '').trim().toLowerCase();
  return type === '' || type === 'agent-turn-complete' || type === 'turn-complete';
}

type ProjectTurnDelivery = 'allow' | 'suppress';
type ProjectTurnSourceKind = 'native' | 'fallback';
type ProjectTurnDeliveryStatus = 'pending' | 'dispatching' | 'sent' | 'committed' | 'delivery_unknown';

interface ProjectTurnClaim {
  timestamp: number;
  delivery: ProjectTurnDelivery;
  delivery_status?: ProjectTurnDeliveryStatus;
  delivery_status_at?: number;
  source_kind: ProjectTurnSourceKind;
  source: string;
  session_id: string;
  audience: string;
  reason: string;
}

interface ProjectTurnDedupeKeyDetails {
  key: string;
  threadId: string;
  turnId: string;
  eventType: string;
  sessionId: string;
  source: string;
  expectedClaim?: ProjectTurnClaim;
}

interface ProjectTurnDedupeState {
  recent_turns: Record<string, number>;
  turn_claims: Record<string, ProjectTurnClaim>;
  last_event_at: string;
}

interface ProjectTurnDedupeDecision {
  shouldContinue: boolean;
  suppressExternalDelivery: boolean;
  reason: string;
  persistenceFailed?: boolean;
  existingClaim?: ProjectTurnClaim;
  currentClaim: ProjectTurnClaim;
}

interface PendingProjectFallbackOwnerUpgrade {
  key: string;
  expectedClaim: ProjectTurnClaim;
  nextClaim: ProjectTurnClaim;
  primaryRollback?: {
    expectedClaim: ProjectTurnClaim;
    replacementClaim?: ProjectTurnClaim;
  };
  threadId: string;
  turnId: string;
  eventType: string;
  sessionId: string;
  source: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeTurnDedupeEventType(rawType: unknown): string {
  const type = safeString(rawType || '').trim().toLowerCase();
  if (!type || type === 'agent-turn-complete' || type === 'turn-complete') {
    return 'agent-turn-complete';
  }
  return type;
}

function normalizeProjectTurnSourceKind(source: string): ProjectTurnSourceKind {
  return source.trim().toLowerCase().startsWith('notify-fallback')
    ? 'fallback'
    : 'native';
}

function normalizeProjectTurnDelivery(value: string): ProjectTurnDelivery {
  return value === 'allow' ? 'allow' : 'suppress';
}

function normalizeProjectTurnDeliveryStatus(
  value: unknown,
): ProjectTurnDeliveryStatus | undefined {
  const status = safeString(value).trim().toLowerCase();
  if (
    status === 'pending'
    || status === 'dispatching'
    || status === 'sent'
    || status === 'committed'
    || status === 'delivery_unknown'
  ) {
    return status;
  }
  return undefined;
}

function normalizeProjectTurnClaim(
  value: unknown,
  fallbackTimestamp: number | null,
): ProjectTurnClaim | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const timestamp = asNumber(raw.timestamp) ?? fallbackTimestamp;
  if (timestamp === null) return null;
  const source = safeString(raw.source);
  const sourceKind = safeString(raw.source_kind) === 'fallback' ? 'fallback' : 'native';
  const delivery = normalizeProjectTurnDelivery(safeString(raw.delivery));
  return {
    timestamp,
    delivery,
    ...(delivery === 'allow'
      ? {
        delivery_status: normalizeProjectTurnDeliveryStatus(raw.delivery_status),
        delivery_status_at: asNumber(raw.delivery_status_at) ?? timestamp,
      }
      : { delivery_status: 'committed' as const }),
    source_kind: sourceKind,
    source,
    session_id: safeString(raw.session_id),
    audience: safeString(raw.audience),
    reason: safeString(raw.reason),
  };
}

function normalizeProjectTurnDedupeState(raw: unknown, now: number): ProjectTurnDedupeState {
  const base = normalizeNotifyState(raw);
  const recentTurns = pruneRecentTurns(base.recent_turns, now);
  const rawClaims = asRecord(asRecord(raw)?.turn_claims);
  const minTimestamp = now - (24 * 60 * 60 * 1000);
  const turnClaims: Record<string, ProjectTurnClaim> = {};
  for (const [key, value] of Object.entries(rawClaims || {})) {
    const claim = normalizeProjectTurnClaim(value, asNumber(recentTurns[key]));
    if (!claim || claim.timestamp < minTimestamp) continue;
    turnClaims[key] = claim;
    recentTurns[key] = claim.timestamp;
  }
  return {
    recent_turns: recentTurns,
    turn_claims: turnClaims,
    last_event_at: base.last_event_at,
  };
}

function createProjectTurnClaim(
  now: number,
  details: {
    sessionId: string;
    source: string;
    audience: string;
    delivery: ProjectTurnDelivery;
    reason: string;
  },
): ProjectTurnClaim {
  return {
    timestamp: now,
    delivery: details.delivery,
    delivery_status: details.delivery === 'allow' ? 'pending' : 'committed',
    delivery_status_at: now,
    source_kind: normalizeProjectTurnSourceKind(details.source),
    source: details.source,
    session_id: details.sessionId,
    audience: details.audience,
    reason: details.reason,
  };
}

function legacyProjectTurnClaim(timestamp: number): ProjectTurnClaim {
  return {
    timestamp,
    delivery: 'allow',
    delivery_status: undefined,
    delivery_status_at: timestamp,
    source_kind: 'native',
    source: 'legacy',
    session_id: '',
    audience: '',
    reason: 'legacy_project_turn_dedupe',
  };
}

function shouldUpgradeProjectTurnClaim(
  existingClaim: ProjectTurnClaim,
  currentClaim: ProjectTurnClaim,
): boolean {
  if (existingClaim.delivery === 'allow' && isProjectAllowClaimDeliveryClosed(existingClaim)) {
    return false;
  }
  if (currentClaim.delivery === 'allow' && existingClaim.delivery === 'suppress') {
    return true;
  }
  return currentClaim.delivery === 'allow'
    && currentClaim.source_kind === 'native'
    && existingClaim.source_kind === 'fallback';
}

function isProjectTurnDedupeDecision(value: unknown): value is ProjectTurnDedupeDecision {
  const raw = asRecord(value);
  return Boolean(
    raw
    && typeof raw.shouldContinue === 'boolean'
    && typeof raw.suppressExternalDelivery === 'boolean'
    && typeof raw.reason === 'string',
  );
}

function projectPrimaryRollbackForPreDelivery(
  decision: ProjectTurnDedupeDecision | null,
): PendingProjectFallbackOwnerUpgrade['primaryRollback'] | undefined {
  if (!decision?.shouldContinue) return undefined;
  if (decision.reason === 'first') {
    return { expectedClaim: decision.currentClaim };
  }
  if (
    decision.reason === 'owner_upgrade'
    && decision.existingClaim
    && !decision.suppressExternalDelivery
  ) {
    return {
      expectedClaim: decision.currentClaim,
      replacementClaim: decision.existingClaim,
    };
  }
  return undefined;
}

function isStateFileLockTimeout(error: unknown): boolean {
  return error instanceof Error && error.message.includes('state file lock timeout');
}

function isMalformedJsonStateError(error: unknown): boolean {
  return error instanceof SyntaxError;
}

function shouldFailClosedOnPrimaryReplayError(error: unknown): boolean {
  if (isStateFileLockTimeout(error) || isMalformedJsonStateError(error)) {
    return true;
  }
  const code = error && typeof error === 'object'
    ? safeString((error as NodeJS.ErrnoException).code)
    : '';
  return code === 'EACCES'
    || code === 'EPERM'
    || code === 'EMFILE'
    || code === 'ENFILE'
    || code === 'EBUSY';
}

function fallbackDedupeStateExists(stateDir: string): boolean {
  return existsSync(join(stateDir, NOTIFY_HOOK_STATE_FILE))
    || existsSync(join(stateDir, `${NOTIFY_HOOK_STATE_FILE}.lock`));
}


interface CompletedTurnLogEvidence {
  deliveryAllowed: boolean;
  deliverySent: boolean;
  definitivePreDeliveryRecoveryFailure: boolean;
  latestDefinitivePreDeliveryRecoveryFailureAt: number | null;
  ambiguousPreDeliveryFailure: boolean;
  latestAmbiguousPreDeliveryFailureAt: number | null;
}

function isSameTurnLogEntry(
  entry: Record<string, unknown>,
  details: { threadId: string; turnId: string },
): boolean {
  if (safeString(entry.turn_id) !== details.turnId) return false;
  const entryThreadId = safeString(entry.thread_id);
  return !details.threadId || !entryThreadId || entryThreadId === details.threadId;
}

function isPreDeliveryRecoveryFailureLogEntry(entry: Record<string, unknown>): boolean {
  const type = safeString(entry.type);
  if (
    type === 'project_turn_dedupe_delivery_status_failed'
    && safeString(entry.delivery_status) === 'dispatching'
  ) {
    return safeString(entry.reason) !== 'claim_changed_before_dispatch';
  }
  if (type === 'project_fallback_turn_dedupe_upgrade_failed') return true;
  if (type === 'project_fallback_turn_dedupe_upgraded') return entry.upgraded === false;
  if (type === 'project_turn_dedupe_rollback_failed') return true;
  if (type === 'session_turn_dedupe_rollback_failed') return true;
  if (type === 'project_turn_dedupe_rolled_back') return entry.rolled_back === false;
  if (type === 'project_fallback_turn_dedupe_rolled_back') return entry.rolled_back === false;
  if (type === 'completed_turn_delivery_failed') {
    return !isAmbiguousCompletedTurnDeliveryFailure(entry);
  }
  return false;
}

function isAmbiguousNotificationError(value: unknown): boolean {
  const error = safeString(value).trim().toLowerCase();
  return Boolean(error && (
    error.includes('dispatch timeout')
    || error.includes('request timeout')
    || error.includes('aborterror')
    || error.includes('aborted')
    || error.includes('signal timed out')
    || error.includes('killed by signal')
    || error.includes('sigterm')
    || error.includes('timeout')
    || error.includes('telegram partial chunk delivery cleanup failed')
    || error.includes('telegram topic delivery mismatch cleanup failed')
  ));
}

function isAmbiguousNotificationResult(value: unknown): boolean {
  const result = asRecord(value);
  const statusCode = asNumber(result?.statusCode) ?? asNumber(result?.status_code);
  const httpErrorStatus = safeString(result?.error).match(/\bHTTP\s+(\d{3})\b/i);
  const errorStatusCode = httpErrorStatus ? Number(httpErrorStatus[1]) : null;
  const effectiveStatusCode = statusCode ?? errorStatusCode;
  return Boolean(
    result
    && !result.success
    && (
      isAmbiguousNotificationError(result.error)
      || effectiveStatusCode === 408
      || effectiveStatusCode === 504
      || effectiveStatusCode === 524
    ),
  );
}

function isAmbiguousCompletedTurnDeliveryFailure(entry: Record<string, unknown>): boolean {
  if (safeString(entry.delivery_failure_kind) === 'ambiguous_timeout') return true;
  const notificationResults = Array.isArray(entry.notification_results)
    ? entry.notification_results
    : [];
  return isAmbiguousNotificationError(entry.error)
    || notificationResults.some(isAmbiguousNotificationResult);
}

function summarizeNotificationResultsForLog(results: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(results)) return [];
  const summarized: Array<Record<string, unknown>> = [];
  for (const result of results) {
    const raw = asRecord(result);
    if (!raw) continue;
    summarized.push({
      platform: safeString(raw.platform || raw.transport),
      success: raw.success === true,
      ...(raw.error ? { error: safeString(raw.error) } : {}),
      ...(raw.gateway ? { gateway: safeString(raw.gateway) } : {}),
      ...(asNumber(raw.statusCode) !== null ? { status_code: asNumber(raw.statusCode) } : {}),
      ...(asNumber(raw.status_code) !== null ? { status_code: asNumber(raw.status_code) } : {}),
    });
  }
  return summarized;
}

function summarizeNotificationFailureReason(results: Array<Record<string, unknown>>): string {
  const firstFailure = results.find((result) => result.success !== true);
  if (!firstFailure) return 'notification delivery failed without a successful transport';
  const platform = safeString(firstFailure.platform);
  const error = safeString(firstFailure.error);
  const statusCode = safeString(firstFailure.status_code);
  return [
    platform ? `${platform} delivery failed` : 'notification delivery failed',
    error,
    statusCode ? `status=${statusCode}` : '',
  ].filter(Boolean).join(': ');
}

function collectDispatchResultsForLog(result: unknown): unknown[] {
  const raw = asRecord(result);
  if (!raw) return [];
  return [
    ...(Array.isArray(raw.results) ? raw.results : []),
    ...(Array.isArray(raw.nonStandardResults) ? raw.nonStandardResults : []),
  ];
}

async function readCompletedTurnLogEvidence(
  logsDir: string,
  details: { threadId: string; turnId: string },
): Promise<CompletedTurnLogEvidence> {
  if (!details.turnId) {
    return {
      deliveryAllowed: false,
      deliverySent: false,
      definitivePreDeliveryRecoveryFailure: false,
      latestDefinitivePreDeliveryRecoveryFailureAt: null,
      ambiguousPreDeliveryFailure: false,
      latestAmbiguousPreDeliveryFailureAt: null,
    };
  }
  const evidence: CompletedTurnLogEvidence = {
    deliveryAllowed: false,
    deliverySent: false,
    definitivePreDeliveryRecoveryFailure: false,
    latestDefinitivePreDeliveryRecoveryFailureAt: null,
    ambiguousPreDeliveryFailure: false,
    latestAmbiguousPreDeliveryFailureAt: null,
  };
  const names = (await readdir(logsDir).catch(() => []))
    .filter((name) => name.startsWith('notify-hook-') && name.endsWith('.jsonl'))
    .sort();

  for (const name of names) {
    const content = await readFile(join(logsDir, name), 'utf-8').catch(() => '');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry: Record<string, unknown> | null = null;
      try {
        const parsed = JSON.parse(trimmed);
        entry = asRecord(parsed);
      } catch {
        entry = null;
      }
      if (!entry || !isSameTurnLogEntry(entry, details)) continue;
      if (safeString(entry.type) === 'completed_turn_delivery_allowed') {
        evidence.deliveryAllowed = true;
      }
      if (safeString(entry.type) === 'completed_turn_delivery_sent') {
        evidence.deliverySent = true;
      }
      if (
        safeString(entry.type) === 'completed_turn_delivery_failed'
        && isAmbiguousCompletedTurnDeliveryFailure(entry)
      ) {
        evidence.ambiguousPreDeliveryFailure = true;
        const failureAt = Date.parse(safeString(entry.timestamp));
        if (Number.isFinite(failureAt)) {
          evidence.latestAmbiguousPreDeliveryFailureAt = Math.max(
            evidence.latestAmbiguousPreDeliveryFailureAt ?? failureAt,
            failureAt,
          );
        }
      }
      if (isPreDeliveryRecoveryFailureLogEntry(entry)) {
        evidence.definitivePreDeliveryRecoveryFailure = true;
        const failureAt = Date.parse(safeString(entry.timestamp));
        if (Number.isFinite(failureAt)) {
          evidence.latestDefinitivePreDeliveryRecoveryFailureAt = Math.max(
            evidence.latestDefinitivePreDeliveryRecoveryFailureAt ?? failureAt,
            failureAt,
          );
        }
      }
      if (
        evidence.deliveryAllowed
        && evidence.deliverySent
        && evidence.definitivePreDeliveryRecoveryFailure
        && evidence.ambiguousPreDeliveryFailure
      ) {
        return evidence;
      }
    }
  }
  return evidence;
}

function isProjectAllowClaimDeliveryClosed(claim: ProjectTurnClaim): boolean {
  return claim.delivery === 'allow'
    && (
      claim.delivery_status === 'sent'
      || claim.delivery_status === 'committed'
      || claim.delivery_status === 'delivery_unknown'
    );
}

function projectTurnClaimStatusTimestamp(claim: ProjectTurnClaim): number {
  return claim.delivery_status_at ?? claim.timestamp;
}

function isProjectAllowClaimPendingExpired(claim: ProjectTurnClaim, now: number): boolean {
  return claim.delivery === 'allow'
    && claim.delivery_status === 'pending'
    && projectTurnClaimStatusTimestamp(claim) + PROJECT_TURN_PENDING_RECOVERY_TTL_MS <= now;
}

function isProjectAllowClaimDispatchingExpired(claim: ProjectTurnClaim, now: number): boolean {
  return claim.delivery === 'allow'
    && claim.delivery_status === 'dispatching'
    && projectTurnClaimStatusTimestamp(claim) + PROJECT_TURN_DISPATCHING_RECOVERY_TTL_MS <= now;
}

function closeLegacyAllowClaimForFallbackRepair(claim: ProjectTurnClaim): ProjectTurnClaim {
  if (claim.delivery !== 'allow' || claim.delivery_status) return claim;
  // Suppressed-helper repair copies an already-authoritative primary claim into
  // fallback state; do not later reinterpret that repair copy as a fresh
  // crash-before-delivery legacy claim.
  return {
    ...claim,
    delivery_status: 'committed',
  };
}

async function shouldRecoverUndeliveredAllowClaim(
  logsDir: string,
  details: { threadId: string; turnId: string },
  existingClaim: ProjectTurnClaim | undefined,
): Promise<boolean> {
  if (!existingClaim || existingClaim.delivery !== 'allow') return false;
  if (isProjectAllowClaimDeliveryClosed(existingClaim)) return false;

  const evidence = await readCompletedTurnLogEvidence(logsDir, details);
  if (evidence.deliverySent) return false;

  // Older state did not carry delivery_status, so an allow claim without a
  // sent marker is treated as recoverable. New claims start as "pending",
  // which lets concurrent writers fail closed while the original owner may
  // still be between the dedupe write and the notifier result.
  if (!existingClaim.delivery_status) {
    return true;
  }
  if (
    evidence.ambiguousPreDeliveryFailure
    && evidence.latestAmbiguousPreDeliveryFailureAt !== null
    && evidence.latestAmbiguousPreDeliveryFailureAt >= projectTurnClaimStatusTimestamp(existingClaim)
    && (
      evidence.latestDefinitivePreDeliveryRecoveryFailureAt === null
      || evidence.latestAmbiguousPreDeliveryFailureAt >= evidence.latestDefinitivePreDeliveryRecoveryFailureAt
    )
  ) {
    return false;
  }
  if (
    evidence.definitivePreDeliveryRecoveryFailure
    && evidence.latestDefinitivePreDeliveryRecoveryFailureAt !== null
    && evidence.latestDefinitivePreDeliveryRecoveryFailureAt >= projectTurnClaimStatusTimestamp(existingClaim)
  ) {
    return true;
  }
  const now = Date.now();
  if (isProjectAllowClaimPendingExpired(existingClaim, now)) {
    return true;
  }
  if (isProjectAllowClaimDispatchingExpired(existingClaim, now)) {
    return true;
  }
  return false;
}

function decideProjectTurnAgainstExistingClaim(
  existingClaim: ProjectTurnClaim,
  currentClaim: ProjectTurnClaim,
): ProjectTurnDedupeDecision {
  return shouldUpgradeProjectTurnClaim(existingClaim, currentClaim)
    ? {
      shouldContinue: true,
      suppressExternalDelivery: existingClaim.delivery === 'allow',
      reason: 'owner_upgrade',
      existingClaim,
      currentClaim,
    }
    : {
      shouldContinue: false,
      suppressExternalDelivery: false,
      reason: 'duplicate',
      existingClaim,
      currentClaim,
    };
}

async function readProjectTurnDedupeClaim(
  dedupePath: string,
  lockPath: string,
  key: string,
  now: number,
): Promise<ProjectTurnClaim | null> {
  return updateLockedJsonState<ProjectTurnClaim | null>(dedupePath, async (rawState) => {
    const dedupeState = normalizeProjectTurnDedupeState(rawState, now);
    const existingTimestamp = asNumber(dedupeState.recent_turns[key]);
    return {
      result: dedupeState.turn_claims[key]
        || (existingTimestamp !== null ? legacyProjectTurnClaim(existingTimestamp) : null),
      write: false,
    };
  }, { lockPath });
}

async function updateProjectTurnDedupeState(
  dedupePath: string,
  lockPath: string,
  key: string,
  currentClaim: ProjectTurnClaim,
  now: number,
  options: { deferOwnerUpgrade?: boolean } = {},
): Promise<ProjectTurnDedupeDecision> {
  return updateLockedJsonState<ProjectTurnDedupeDecision>(dedupePath, async (rawState) => {
    const dedupeState = normalizeProjectTurnDedupeState(
      rawState,
      now,
    );
    const existingTimestamp = asNumber(dedupeState.recent_turns[key]);
    const existingClaim = dedupeState.turn_claims[key]
      || (existingTimestamp !== null ? legacyProjectTurnClaim(existingTimestamp) : null);

    if (existingClaim && !shouldUpgradeProjectTurnClaim(existingClaim, currentClaim)) {
      return {
        result: {
          shouldContinue: false,
          suppressExternalDelivery: false,
          reason: 'duplicate',
          existingClaim,
          currentClaim,
        },
        write: false,
      };
    }

    if (existingClaim) {
      const result = {
        shouldContinue: true,
        suppressExternalDelivery: existingClaim.delivery === 'allow',
        reason: 'owner_upgrade',
        existingClaim,
        currentClaim,
      };
      if (options.deferOwnerUpgrade) {
        return {
          result,
          write: false,
        };
      }
      dedupeState.recent_turns[key] = now;
      dedupeState.turn_claims[key] = currentClaim;
      dedupeState.last_event_at = new Date().toISOString();
      return {
        result,
        nextState: dedupeState,
        write: true,
      };
    }

    dedupeState.recent_turns[key] = now;
    dedupeState.turn_claims[key] = currentClaim;
    dedupeState.last_event_at = new Date().toISOString();

    return {
      result: {
        shouldContinue: true,
        suppressExternalDelivery: false,
        reason: 'first',
        currentClaim,
      },
      nextState: dedupeState,
      write: true,
    };
  }, { lockPath });
}

async function recordProjectTurnDedupe(
  stateDir: string,
  logsDir: string,
  key: string,
  details: {
    threadId: string;
    turnId: string;
    eventType: string;
    sessionId: string;
    source: string;
    audience: string;
    delivery: ProjectTurnDelivery;
    reason: string;
  },
): Promise<ProjectTurnDedupeDecision> {
  const now = Date.now();
  const dedupePath = join(stateDir, NOTIFY_HOOK_TURN_DEDUPE_FILE);
  const dedupeLockPath = join(stateDir, NOTIFY_HOOK_TURN_DEDUPE_LOCK_FILE);
  const currentClaim = createProjectTurnClaim(now, details);
  let writeFailed = false;
  let decision: ProjectTurnDedupeDecision;
  try {
    decision = await updateProjectTurnDedupeState(dedupePath, dedupeLockPath, key, currentClaim, now);
  } catch (error) {
    if (
      error instanceof LockedJsonStateWriteError
      && isProjectTurnDedupeDecision(error.result)
    ) {
      writeFailed = true;
      decision = { ...error.result, persistenceFailed: true };
      await logNotifyHookEvent(logsDir, {
        timestamp: new Date().toISOString(),
        level: 'warn',
        type: 'project_turn_dedupe_write_failed',
        thread_id: details.threadId || null,
        turn_id: details.turnId || null,
        event_type: details.eventType,
        omx_session_id: details.sessionId || null,
        source: details.source || null,
        decision_reason: decision.reason,
        suppress_external_delivery: decision.suppressExternalDelivery,
        error: error.originalError instanceof Error
          ? error.originalError.message
          : String(error.originalError),
      });
    } else {
      throw error;
    }
  }

  if (!decision.shouldContinue) {
    await logNotifyHookEvent(logsDir, {
      timestamp: new Date().toISOString(),
      type: 'turn_duplicate_suppressed',
      scope: 'project',
      thread_id: details.threadId || null,
      turn_id: details.turnId || null,
      event_type: details.eventType,
      omx_session_id: details.sessionId || null,
      source: details.source || null,
      existing_source: decision.existingClaim?.source || null,
      existing_source_kind: decision.existingClaim?.source_kind || null,
      existing_delivery: decision.existingClaim?.delivery || null,
    });
    return decision;
  }

  if (decision.reason === 'owner_upgrade') {
    await logNotifyHookEvent(logsDir, {
      timestamp: new Date().toISOString(),
      type: 'turn_duplicate_owner_upgraded',
      scope: 'project',
      thread_id: details.threadId || null,
      turn_id: details.turnId || null,
      event_type: details.eventType,
      omx_session_id: details.sessionId || null,
      source: details.source || null,
      previous_source: decision.existingClaim?.source || null,
      previous_source_kind: decision.existingClaim?.source_kind || null,
      previous_delivery: decision.existingClaim?.delivery || null,
      suppress_external_delivery: decision.suppressExternalDelivery,
      write_failed: writeFailed,
    });
  }

  return decision;
}

async function recordProjectFallbackTurnDedupe(
  stateDir: string,
  logsDir: string,
  key: string,
  details: {
    threadId: string;
    turnId: string;
    eventType: string;
    sessionId: string;
    source: string;
    audience: string;
    delivery: ProjectTurnDelivery;
    reason: string;
  },
): Promise<ProjectTurnDedupeDecision> {
  const now = Date.now();
  const dedupePath = join(stateDir, NOTIFY_HOOK_STATE_FILE);
  const dedupeLockPath = `${dedupePath}.lock`;
  const currentClaim = createProjectTurnClaim(now, details);
  let writeFailed = false;
  let decision: ProjectTurnDedupeDecision;
  try {
    decision = await updateProjectTurnDedupeState(
      dedupePath,
      dedupeLockPath,
      key,
      currentClaim,
      now,
      { deferOwnerUpgrade: true },
    );
  } catch (error) {
    if (
      error instanceof LockedJsonStateWriteError
      && isProjectTurnDedupeDecision(error.result)
    ) {
      writeFailed = true;
      decision = { ...error.result, persistenceFailed: true };
      await logNotifyHookEvent(logsDir, {
        timestamp: new Date().toISOString(),
        level: 'warn',
        type: 'project_fallback_turn_dedupe_write_failed',
        thread_id: details.threadId || null,
        turn_id: details.turnId || null,
        event_type: details.eventType,
        omx_session_id: details.sessionId || null,
        source: details.source || null,
        decision_reason: decision.reason,
        suppress_external_delivery: decision.suppressExternalDelivery,
        error: error.originalError instanceof Error
          ? error.originalError.message
          : String(error.originalError),
      });
    } else {
      throw error;
    }
  }

  if (!decision.shouldContinue) {
    await logNotifyHookEvent(logsDir, {
      timestamp: new Date().toISOString(),
      type: 'turn_duplicate_suppressed',
      scope: 'project_fallback',
      thread_id: details.threadId || null,
      turn_id: details.turnId || null,
      event_type: details.eventType,
      omx_session_id: details.sessionId || null,
      source: details.source || null,
      existing_source: decision.existingClaim?.source || null,
      existing_source_kind: decision.existingClaim?.source_kind || null,
      existing_delivery: decision.existingClaim?.delivery || null,
    });
    return decision;
  }

  if (decision.reason === 'owner_upgrade') {
    await logNotifyHookEvent(logsDir, {
      timestamp: new Date().toISOString(),
      type: 'turn_duplicate_owner_upgraded',
      scope: 'project_fallback',
      thread_id: details.threadId || null,
      turn_id: details.turnId || null,
      event_type: details.eventType,
      omx_session_id: details.sessionId || null,
      source: details.source || null,
      previous_source: decision.existingClaim?.source || null,
      previous_source_kind: decision.existingClaim?.source_kind || null,
      previous_delivery: decision.existingClaim?.delivery || null,
      suppress_external_delivery: decision.suppressExternalDelivery,
      write_failed: writeFailed,
    });
  }

  return decision;
}

async function seedProjectTurnDedupeFromFallback(
  stateDir: string,
  key: string,
  fallbackClaim: ProjectTurnClaim,
): Promise<void> {
  const now = Date.now();
  const dedupePath = join(stateDir, NOTIFY_HOOK_TURN_DEDUPE_FILE);
  const dedupeLockPath = join(stateDir, NOTIFY_HOOK_TURN_DEDUPE_LOCK_FILE);
  await updateLockedJsonState<boolean>(dedupePath, async (rawState) => {
    const dedupeState = normalizeProjectTurnDedupeState(rawState, now);
    const existingTimestamp = asNumber(dedupeState.recent_turns[key]);
    const existingClaim = dedupeState.turn_claims[key]
      || (existingTimestamp !== null ? legacyProjectTurnClaim(existingTimestamp) : null);
    if (existingClaim) {
      return { result: false, write: false };
    }

    dedupeState.recent_turns[key] = fallbackClaim.timestamp;
    dedupeState.turn_claims[key] = fallbackClaim;
    dedupeState.last_event_at = new Date().toISOString();
    return {
      result: true,
      nextState: dedupeState,
      write: true,
    };
  }, { lockPath: dedupeLockPath });
}

function sameProjectTurnClaim(left: ProjectTurnClaim, right: ProjectTurnClaim): boolean {
  return left.timestamp === right.timestamp
    && left.delivery === right.delivery
    && left.delivery_status === right.delivery_status
    && projectTurnClaimStatusTimestamp(left) === projectTurnClaimStatusTimestamp(right)
    && left.source_kind === right.source_kind
    && left.source === right.source
    && left.session_id === right.session_id
    && left.audience === right.audience
    && left.reason === right.reason;
}

function sameProjectTurnClaimIdentity(left: ProjectTurnClaim, right: ProjectTurnClaim): boolean {
  return left.timestamp === right.timestamp
    && left.delivery === right.delivery
    && left.source_kind === right.source_kind
    && left.source === right.source
    && left.session_id === right.session_id
    && left.audience === right.audience
    && left.reason === right.reason;
}

async function removeProjectTurnDedupeClaimIfCurrent(
  stateDir: string,
  key: string,
  expectedClaim: ProjectTurnClaim,
): Promise<boolean> {
  const now = Date.now();
  const dedupePath = join(stateDir, NOTIFY_HOOK_TURN_DEDUPE_FILE);
  const dedupeLockPath = join(stateDir, NOTIFY_HOOK_TURN_DEDUPE_LOCK_FILE);
  return updateLockedJsonState<boolean>(dedupePath, async (rawState) => {
    const dedupeState = normalizeProjectTurnDedupeState(rawState, now);
    const existingClaim = dedupeState.turn_claims[key];
    if (!existingClaim || !sameProjectTurnClaim(existingClaim, expectedClaim)) {
      return { result: false, write: false };
    }
    delete dedupeState.recent_turns[key];
    delete dedupeState.turn_claims[key];
    dedupeState.last_event_at = new Date().toISOString();
    return {
      result: true,
      nextState: dedupeState,
      write: true,
    };
  }, { lockPath: dedupeLockPath });
}

async function replaceProjectTurnDedupeClaimIfCurrent(
  stateDir: string,
  key: string,
  expectedClaim: ProjectTurnClaim,
  replacementClaim: ProjectTurnClaim,
): Promise<boolean> {
  const now = Date.now();
  const dedupePath = join(stateDir, NOTIFY_HOOK_TURN_DEDUPE_FILE);
  const dedupeLockPath = join(stateDir, NOTIFY_HOOK_TURN_DEDUPE_LOCK_FILE);
  return updateLockedJsonState<boolean>(dedupePath, async (rawState) => {
    const dedupeState = normalizeProjectTurnDedupeState(rawState, now);
    const existingClaim = dedupeState.turn_claims[key];
    if (!existingClaim || !sameProjectTurnClaim(existingClaim, expectedClaim)) {
      return { result: false, write: false };
    }
    dedupeState.recent_turns[key] = replacementClaim.timestamp;
    dedupeState.turn_claims[key] = replacementClaim;
    dedupeState.last_event_at = new Date().toISOString();
    return {
      result: true,
      nextState: dedupeState,
      write: true,
    };
  }, { lockPath: dedupeLockPath });
}

async function claimProjectTurnRecoveryIfCurrent(
  stateDir: string,
  key: string,
  expectedClaim: ProjectTurnClaim,
  recoveryClaim: ProjectTurnClaim,
): Promise<boolean> {
  const now = Date.now();
  const dedupePath = join(stateDir, NOTIFY_HOOK_TURN_DEDUPE_FILE);
  const dedupeLockPath = join(stateDir, NOTIFY_HOOK_TURN_DEDUPE_LOCK_FILE);
  return updateLockedJsonState<boolean>(dedupePath, async (rawState) => {
    const dedupeState = normalizeProjectTurnDedupeState(rawState, now);
    const existingTimestamp = asNumber(dedupeState.recent_turns[key]);
    const existingClaim = dedupeState.turn_claims[key]
      || (existingTimestamp !== null ? legacyProjectTurnClaim(existingTimestamp) : null);
    if (!existingClaim || !sameProjectTurnClaim(existingClaim, expectedClaim)) {
      return { result: false, write: false };
    }
    dedupeState.recent_turns[key] = recoveryClaim.timestamp;
    dedupeState.turn_claims[key] = recoveryClaim;
    dedupeState.last_event_at = new Date().toISOString();
    return {
      result: true,
      nextState: dedupeState,
      write: true,
    };
  }, { lockPath: dedupeLockPath });
}

async function markProjectTurnDedupeClaimDeliveryStatus(
  dedupePath: string,
  lockPath: string,
  key: string,
  status: ProjectTurnDeliveryStatus,
  expectedClaim?: ProjectTurnClaim,
): Promise<boolean> {
  const now = Date.now();
  return updateLockedJsonState<boolean>(dedupePath, async (rawState) => {
    const dedupeState = normalizeProjectTurnDedupeState(rawState, now);
    const existingTimestamp = asNumber(dedupeState.recent_turns[key]);
    const existingClaim = dedupeState.turn_claims[key]
      || (existingTimestamp !== null ? legacyProjectTurnClaim(existingTimestamp) : null);
    if (!existingClaim || existingClaim.delivery !== 'allow') {
      return { result: false, write: false };
    }
    if (expectedClaim && !sameProjectTurnClaimIdentity(existingClaim, expectedClaim)) {
      return { result: false, write: false };
    }
    if (existingClaim.delivery_status === status) {
      return { result: true, write: false };
    }
    dedupeState.recent_turns[key] = existingClaim.timestamp;
    dedupeState.turn_claims[key] = {
      ...existingClaim,
      delivery_status: status,
      delivery_status_at: now,
    };
    dedupeState.last_event_at = new Date().toISOString();
    return {
      result: true,
      nextState: dedupeState,
      write: true,
    };
  }, { lockPath });
}

async function markProjectTurnDeliveryStatus(
  stateDir: string,
  logsDir: string,
  details: ProjectTurnDedupeKeyDetails,
  status: ProjectTurnDeliveryStatus,
): Promise<{ project: boolean; project_fallback: boolean }> {
  const stores = [
    {
      scope: 'project',
      path: join(stateDir, NOTIFY_HOOK_TURN_DEDUPE_FILE),
      lockPath: join(stateDir, NOTIFY_HOOK_TURN_DEDUPE_LOCK_FILE),
    },
    {
      scope: 'project_fallback',
      path: join(stateDir, NOTIFY_HOOK_STATE_FILE),
      lockPath: join(stateDir, `${NOTIFY_HOOK_STATE_FILE}.lock`),
    },
  ] as const;
  const results = {
    project: false,
    project_fallback: false,
  };

  for (const store of stores) {
    const updated = await markProjectTurnDedupeClaimDeliveryStatus(
      store.path,
      store.lockPath,
      details.key,
      status,
      details.expectedClaim,
    ).catch(async (error) => {
      await logNotifyHookEvent(logsDir, {
        timestamp: new Date().toISOString(),
        level: 'warn',
        type: 'project_turn_dedupe_delivery_status_failed',
        scope: store.scope,
        delivery_status: status,
        thread_id: details.threadId || null,
        turn_id: details.turnId || null,
        event_type: details.eventType,
        omx_session_id: details.sessionId || null,
        source: details.source || null,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    });
    results[store.scope] = updated;
  }
  return results;
}

async function updateProjectFallbackTurnDedupeClaimIfCurrent(
  stateDir: string,
  key: string,
  expectedClaim: ProjectTurnClaim,
  nextClaim: ProjectTurnClaim,
): Promise<boolean> {
  const now = Date.now();
  const dedupePath = join(stateDir, NOTIFY_HOOK_STATE_FILE);
  const dedupeLockPath = `${dedupePath}.lock`;
  return updateLockedJsonState<boolean>(dedupePath, async (rawState) => {
    const dedupeState = normalizeProjectTurnDedupeState(rawState, now);
    const existingClaim = dedupeState.turn_claims[key];
    if (!existingClaim || !sameProjectTurnClaim(existingClaim, expectedClaim)) {
      return { result: false, write: false };
    }
    dedupeState.recent_turns[key] = nextClaim.timestamp;
    dedupeState.turn_claims[key] = nextClaim;
    dedupeState.last_event_at = new Date().toISOString();
    return {
      result: true,
      nextState: dedupeState,
      write: true,
    };
  }, { lockPath: dedupeLockPath });
}

async function removeProjectFallbackTurnDedupeClaimIfCurrent(
  stateDir: string,
  key: string,
  expectedClaim: ProjectTurnClaim,
): Promise<boolean> {
  const now = Date.now();
  const dedupePath = join(stateDir, NOTIFY_HOOK_STATE_FILE);
  const dedupeLockPath = `${dedupePath}.lock`;
  return updateLockedJsonState<boolean>(dedupePath, async (rawState) => {
    const dedupeState = normalizeProjectTurnDedupeState(rawState, now);
    const existingClaim = dedupeState.turn_claims[key];
    if (!existingClaim || !sameProjectTurnClaim(existingClaim, expectedClaim)) {
      return { result: false, write: false };
    }
    delete dedupeState.recent_turns[key];
    delete dedupeState.turn_claims[key];
    dedupeState.last_event_at = new Date().toISOString();
    return {
      result: true,
      nextState: dedupeState,
      write: true,
    };
  }, { lockPath: dedupeLockPath });
}

async function finalizeProjectFallbackOwnerUpgrade(
  stateDir: string,
  logsDir: string,
  upgrade: PendingProjectFallbackOwnerUpgrade,
): Promise<boolean> {
  let fallbackUpgradeSucceeded = await updateProjectFallbackTurnDedupeClaimIfCurrent(
    stateDir,
    upgrade.key,
    upgrade.expectedClaim,
    upgrade.nextClaim,
  ).catch(async (error) => {
    await logNotifyHookEvent(logsDir, {
      timestamp: new Date().toISOString(),
      level: 'warn',
      type: 'project_fallback_turn_dedupe_upgrade_failed',
      thread_id: upgrade.threadId || null,
      turn_id: upgrade.turnId || null,
      event_type: upgrade.eventType,
      omx_session_id: upgrade.sessionId || null,
      source: upgrade.source || null,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  });
  let alreadyCurrent = false;
  if (!fallbackUpgradeSucceeded) {
    const dedupePath = join(stateDir, NOTIFY_HOOK_STATE_FILE);
    const currentClaim = await readProjectTurnDedupeClaim(
      dedupePath,
      `${dedupePath}.lock`,
      upgrade.key,
      Date.now(),
    ).catch(async (error) => {
      await logNotifyHookEvent(logsDir, {
        timestamp: new Date().toISOString(),
        level: 'warn',
        type: 'project_fallback_turn_dedupe_upgrade_recheck_failed',
        thread_id: upgrade.threadId || null,
        turn_id: upgrade.turnId || null,
        event_type: upgrade.eventType,
        omx_session_id: upgrade.sessionId || null,
        source: upgrade.source || null,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
    alreadyCurrent = Boolean(currentClaim && sameProjectTurnClaim(currentClaim, upgrade.nextClaim));
    fallbackUpgradeSucceeded = alreadyCurrent;
  }
  await logNotifyHookEvent(logsDir, {
    timestamp: new Date().toISOString(),
    type: 'project_fallback_turn_dedupe_upgraded',
    thread_id: upgrade.threadId || null,
    turn_id: upgrade.turnId || null,
    event_type: upgrade.eventType,
    omx_session_id: upgrade.sessionId || null,
    source: upgrade.source || null,
    upgraded: fallbackUpgradeSucceeded,
    already_current: alreadyCurrent,
  });
  return fallbackUpgradeSucceeded;
}

async function rollbackPendingPrimaryClaim(
  stateDir: string,
  logsDir: string,
  upgrade: PendingProjectFallbackOwnerUpgrade,
  reason: string,
): Promise<boolean> {
  if (!upgrade.primaryRollback) return false;
  const rollback = upgrade.primaryRollback;
  const rolledBack = rollback.replacementClaim
    ? await replaceProjectTurnDedupeClaimIfCurrent(
      stateDir,
      upgrade.key,
      rollback.expectedClaim,
      rollback.replacementClaim,
    ).catch(async (error) => {
      await logNotifyHookEvent(logsDir, {
        timestamp: new Date().toISOString(),
        level: 'warn',
        type: 'project_turn_dedupe_rollback_failed',
        thread_id: upgrade.threadId || null,
        turn_id: upgrade.turnId || null,
        event_type: upgrade.eventType,
        omx_session_id: upgrade.sessionId || null,
        reason,
        rollback_mode: 'restore_previous_claim',
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    })
    : await removeProjectTurnDedupeClaimIfCurrent(
      stateDir,
      upgrade.key,
      rollback.expectedClaim,
    ).catch(async (error) => {
      await logNotifyHookEvent(logsDir, {
        timestamp: new Date().toISOString(),
        level: 'warn',
        type: 'project_turn_dedupe_rollback_failed',
        thread_id: upgrade.threadId || null,
        turn_id: upgrade.turnId || null,
        event_type: upgrade.eventType,
        omx_session_id: upgrade.sessionId || null,
        reason,
        rollback_mode: 'remove_first_claim',
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    });
  await logNotifyHookEvent(logsDir, {
    timestamp: new Date().toISOString(),
    level: 'warn',
    type: 'project_turn_dedupe_rolled_back',
    thread_id: upgrade.threadId || null,
    turn_id: upgrade.turnId || null,
    event_type: upgrade.eventType,
    omx_session_id: upgrade.sessionId || null,
    reason,
    rollback_mode: rollback.replacementClaim
      ? 'restore_previous_claim'
      : 'remove_first_claim',
    rolled_back: rolledBack,
  });
  return rolledBack;
}

async function removeSessionTurnDedupeKeyIfCurrent(
  statePath: string,
  key: string,
): Promise<boolean> {
  return updateLockedJsonState<boolean>(statePath, async (rawState) => {
    const dedupeState = normalizeNotifyState(rawState);
    if (!dedupeState.recent_turns[key]) {
      return { result: false, write: false };
    }
    delete dedupeState.recent_turns[key];
    dedupeState.last_event_at = new Date().toISOString();
    return {
      result: true,
      nextState: dedupeState,
      write: true,
    };
  });
}

async function replayProjectFallbackTurnDedupe(
  stateDir: string,
  logsDir: string,
  key: string,
  details: {
    threadId: string;
    turnId: string;
    eventType: string;
    sessionId: string;
    source: string;
    audience: string;
    delivery: ProjectTurnDelivery;
    reason: string;
  },
): Promise<ProjectTurnDedupeDecision | null> {
  const now = Date.now();
  const dedupePath = join(stateDir, NOTIFY_HOOK_STATE_FILE);
  const dedupeLockPath = `${dedupePath}.lock`;
  const currentClaim = createProjectTurnClaim(now, details);
  const existingClaim = await readProjectTurnDedupeClaim(dedupePath, dedupeLockPath, key, now);

  if (!existingClaim) return null;

  let persistenceFailed = false;
  await seedProjectTurnDedupeFromFallback(stateDir, key, existingClaim).catch(async (error) => {
    persistenceFailed = true;
    await logNotifyHookEvent(logsDir, {
      timestamp: new Date().toISOString(),
      level: 'warn',
      type: 'project_fallback_turn_dedupe_seed_failed',
      thread_id: details.threadId || null,
      turn_id: details.turnId || null,
      event_type: details.eventType,
      omx_session_id: details.sessionId || null,
      source: details.source || null,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  const decision = {
    ...decideProjectTurnAgainstExistingClaim(existingClaim, currentClaim),
    persistenceFailed,
  };

  if (!decision.shouldContinue) {
    await logNotifyHookEvent(logsDir, {
      timestamp: new Date().toISOString(),
      type: 'turn_duplicate_suppressed',
      scope: 'project_fallback',
      thread_id: details.threadId || null,
      turn_id: details.turnId || null,
      event_type: details.eventType,
      omx_session_id: details.sessionId || null,
      source: details.source || null,
      existing_source: decision.existingClaim?.source || null,
      existing_source_kind: decision.existingClaim?.source_kind || null,
      existing_delivery: decision.existingClaim?.delivery || null,
    });
    return decision;
  }

  if (decision.reason === 'owner_upgrade') {
    await logNotifyHookEvent(logsDir, {
      timestamp: new Date().toISOString(),
      type: 'turn_duplicate_owner_upgraded',
      scope: 'project_fallback',
      thread_id: details.threadId || null,
      turn_id: details.turnId || null,
      event_type: details.eventType,
      omx_session_id: details.sessionId || null,
      source: details.source || null,
      previous_source: decision.existingClaim?.source || null,
      previous_source_kind: decision.existingClaim?.source_kind || null,
      previous_delivery: decision.existingClaim?.delivery || null,
      suppress_external_delivery: decision.suppressExternalDelivery,
      write_failed: false,
    });
  }

  return decision;
}

async function replayPrimaryProjectTurnDedupe(
  stateDir: string,
  logsDir: string,
  key: string,
  details: {
    threadId: string;
    turnId: string;
    eventType: string;
    sessionId: string;
    source: string;
    audience: string;
    delivery: ProjectTurnDelivery;
    reason: string;
  },
): Promise<ProjectTurnDedupeDecision | null> {
  const now = Date.now();
  const dedupePath = join(stateDir, NOTIFY_HOOK_TURN_DEDUPE_FILE);
  const dedupeLockPath = join(stateDir, NOTIFY_HOOK_TURN_DEDUPE_LOCK_FILE);
  const currentClaim = createProjectTurnClaim(now, details);
  const existingClaim = await readProjectTurnDedupeClaim(dedupePath, dedupeLockPath, key, now);

  if (!existingClaim) return null;

  const decision = decideProjectTurnAgainstExistingClaim(existingClaim, currentClaim);
  if (!decision.shouldContinue) {
    await logNotifyHookEvent(logsDir, {
      timestamp: new Date().toISOString(),
      type: 'turn_duplicate_suppressed',
      scope: 'project',
      thread_id: details.threadId || null,
      turn_id: details.turnId || null,
      event_type: details.eventType,
      omx_session_id: details.sessionId || null,
      source: details.source || null,
      existing_source: decision.existingClaim?.source || null,
      existing_source_kind: decision.existingClaim?.source_kind || null,
      existing_delivery: decision.existingClaim?.delivery || null,
    });
    return decision;
  }

  if (decision.reason === 'owner_upgrade') {
    await logNotifyHookEvent(logsDir, {
      timestamp: new Date().toISOString(),
      type: 'turn_duplicate_owner_upgraded',
      scope: 'project',
      thread_id: details.threadId || null,
      turn_id: details.turnId || null,
      event_type: details.eventType,
      omx_session_id: details.sessionId || null,
      source: details.source || null,
      previous_source: decision.existingClaim?.source || null,
      previous_source_kind: decision.existingClaim?.source_kind || null,
      previous_delivery: decision.existingClaim?.delivery || null,
      suppress_external_delivery: decision.suppressExternalDelivery,
      write_failed: false,
    });
  }

  return decision;
}

interface ProjectFallbackReplayAttempt {
  decision: ProjectTurnDedupeDecision | null;
  failed: boolean;
  lockTimedOut: boolean;
}

async function attemptProjectFallbackTurnDedupeReplay(
  stateDir: string,
  logsDir: string,
  key: string,
  details: {
    threadId: string;
    turnId: string;
    eventType: string;
    sessionId: string;
    source: string;
    audience: string;
    delivery: ProjectTurnDelivery;
    reason: string;
  },
  phase: 'before_project' | 'after_project',
): Promise<ProjectFallbackReplayAttempt> {
  if (phase === 'before_project' && !fallbackDedupeStateExists(stateDir)) {
    return { decision: null, failed: false, lockTimedOut: false };
  }

  try {
    return {
      decision: await replayProjectFallbackTurnDedupe(stateDir, logsDir, key, details),
      failed: false,
      lockTimedOut: false,
    };
  } catch (error) {
    await logNotifyHookEvent(logsDir, {
      timestamp: new Date().toISOString(),
      level: 'warn',
      type: 'project_fallback_turn_dedupe_replay_failed',
      phase,
      thread_id: details.threadId || null,
      turn_id: details.turnId || null,
      event_type: details.eventType,
      omx_session_id: details.sessionId || null,
      fallback_state_exists: true,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      decision: null,
      failed: true,
      lockTimedOut: isStateFileLockTimeout(error),
    };
  }
}

async function main() {
  const rawPayload = process.argv[process.argv.length - 1];
  if (!rawPayload || rawPayload.startsWith('-')) {
    process.exit(0);
  }

  let payload;
  try {
    payload = JSON.parse(rawPayload);
  } catch {
    process.exit(0);
  }

  const cwd = payload.cwd || payload['cwd'] || process.cwd();
  const payloadSessionId = safeString(payload.session_id || payload['session-id'] || '');
  const payloadThreadId = safeString(payload['thread-id'] || payload.thread_id || '');
  const inputMessages = normalizeInputMessages(payload);
  const latestUserInput = safeString(inputMessages.length > 0 ? inputMessages[inputMessages.length - 1] : '');
  const isTurnComplete = isTurnCompletePayload(payload);

  // Team worker detection via environment variable
  const teamWorkerEnv = process.env.OMX_TEAM_WORKER; // e.g., "fix-ts/worker-1"
  const parsedTeamWorker = parseTeamWorkerEnv(teamWorkerEnv);
  const isTeamWorker = !!parsedTeamWorker;

  const resolvedWorkerStateDir = (isTeamWorker && parsedTeamWorker)
    ? await resolveTeamStateDirForWorker(cwd, parsedTeamWorker)
    : null;
  const workerStateRootResolved = !isTeamWorker || !!resolvedWorkerStateDir;
  const stateDir = resolvedWorkerStateDir || join(cwd, '.omx', 'state');
  const logsDir = join(cwd, '.omx', 'logs');
  const omxDir = join(cwd, '.omx');
  let currentOmxSessionId = '';
  const getEffectiveSessionId = () => currentOmxSessionId || payloadSessionId;

  // Ensure directories exist
  await mkdir(logsDir, { recursive: true }).catch(() => {});
  if (workerStateRootResolved) {
    await mkdir(stateDir, { recursive: true }).catch(() => {});
    currentOmxSessionId = await readCurrentSessionId(stateDir).catch(() => '') || '';
  }

  const currentSessionState = isTeamWorker
    ? null
    : await readUsableSessionState(cwd).catch(() => null);
  const originResolution = await resolveTurnOriginForNotification({
    cwd,
    stateDir,
    payload,
    env: process.env,
    currentSessionState,
    currentOmxSessionId,
  }).catch(async (error) => {
    await logNotifyHookEvent(logsDir, {
      timestamp: new Date().toISOString(),
      level: 'warn',
      type: 'turn_origin_resolution_failed',
      thread_id: payloadThreadId || null,
      native_session_id: payloadSessionId || null,
      error: error instanceof Error ? error.message : String(error),
    });
    return resolveTurnOriginForNotification({
      cwd,
      stateDir,
      payload,
      env: process.env,
      currentSessionState: null,
      currentOmxSessionId: '',
    });
  });
  let turnOrigin = originResolution.origin;
  const suppressExternalCompletedTurn = originResolution.delivery === 'suppress';
  let suppressProjectCompletedTurnDelivery = false;
  let pendingProjectFallbackOwnerUpgrade: PendingProjectFallbackOwnerUpgrade | null = null;
  let completedTurnDedupeForDeliveryStatus: ProjectTurnDedupeKeyDetails | null = null;
  await logNotifyHookEvent(logsDir, {
    timestamp: new Date().toISOString(),
    type: 'turn_origin_resolved',
    thread_id: payloadThreadId || turnOrigin.threadId || null,
    turn_id: safeString(payload['turn-id'] || payload.turn_id || '') || null,
    native_session_id: payloadSessionId || turnOrigin.nativeSessionId || null,
    omx_session_id: getEffectiveSessionId() || null,
    origin_kind: turnOrigin.kind,
    audience: originResolution.audience,
    delivery: originResolution.delivery,
    reason: originResolution.reason,
    actor_id: originResolution.actorId || null,
    owner_actor_id: originResolution.ownerActorId || null,
    origin_evidence: originResolution.evidence,
    evidence_sources: originResolution.evidence.map((entry) => entry.source),
  });

  // Turn-level dedupe prevents double-processing when native notify and fallback
  // watcher both emit the same completed turn.
  try {
    if (!workerStateRootResolved) throw new Error('worker_state_root_unresolved');
    const turnId = safeString(payload['turn-id'] || payload.turn_id || '');
    if (turnId) {
      const now = Date.now();
      const threadId = safeString(payload['thread-id'] || payload.thread_id || '');
      const eventType = normalizeTurnDedupeEventType(payload.type);
      const key = `${threadId || 'no-thread'}|${turnId}|${eventType}`;
      const dedupeSessionId = getEffectiveSessionId();
      const projectDedupeDetails = {
        threadId,
        turnId,
        eventType,
        sessionId: dedupeSessionId,
        source: safeString(payload.source || ''),
        audience: originResolution.audience,
        delivery: normalizeProjectTurnDelivery(originResolution.delivery),
        reason: originResolution.reason,
      };
      if (projectDedupeDetails.delivery === 'allow') {
        completedTurnDedupeForDeliveryStatus = {
          key,
          threadId,
          turnId,
          eventType,
          sessionId: dedupeSessionId,
          source: projectDedupeDetails.source,
        };
      }
      const beforeProjectFallbackReplay = await attemptProjectFallbackTurnDedupeReplay(
        stateDir,
        logsDir,
        key,
        projectDedupeDetails,
        'before_project',
      );
      if (beforeProjectFallbackReplay.failed && !beforeProjectFallbackReplay.lockTimedOut) {
        process.exit(0);
      }
      let recoveredBeforeProjectFallbackAllowClaim = false;
      if (beforeProjectFallbackReplay.decision && !beforeProjectFallbackReplay.decision.shouldContinue) {
        const shouldRecoverFallbackAllowClaim = beforeProjectFallbackReplay.decision.currentClaim.delivery === 'allow'
          && beforeProjectFallbackReplay.decision.existingClaim?.delivery === 'allow'
          && await shouldRecoverUndeliveredAllowClaim(
            logsDir,
            { threadId, turnId },
            beforeProjectFallbackReplay.decision.existingClaim,
          );
        if (beforeProjectFallbackReplay.decision.existingClaim) {
          const primaryClaim = await readProjectTurnDedupeClaim(
            join(stateDir, NOTIFY_HOOK_TURN_DEDUPE_FILE),
            join(stateDir, NOTIFY_HOOK_TURN_DEDUPE_LOCK_FILE),
            key,
            Date.now(),
          ).catch(async (error) => {
            await logNotifyHookEvent(logsDir, {
              timestamp: new Date().toISOString(),
              level: 'warn',
              type: 'project_turn_dedupe_repair_read_failed',
              thread_id: threadId || null,
              turn_id: turnId || null,
              event_type: eventType,
              omx_session_id: dedupeSessionId || null,
              reason: 'fallback_duplicate_before_project',
              error: error instanceof Error ? error.message : String(error),
            });
            return null;
          });
          const primaryRepairClaim = primaryClaim?.delivery === 'allow'
            ? closeLegacyAllowClaimForFallbackRepair(primaryClaim)
            : null;
          if (
            primaryRepairClaim
            && isProjectAllowClaimDeliveryClosed(primaryRepairClaim)
            && !sameProjectTurnClaim(primaryRepairClaim, beforeProjectFallbackReplay.decision.existingClaim)
          ) {
            await finalizeProjectFallbackOwnerUpgrade(stateDir, logsDir, {
              key,
              expectedClaim: beforeProjectFallbackReplay.decision.existingClaim,
              nextClaim: primaryRepairClaim,
              threadId,
              turnId,
              eventType,
              sessionId: dedupeSessionId,
              source: projectDedupeDetails.source,
            });
          }
        }
        if (!shouldRecoverFallbackAllowClaim) {
          process.exit(0);
        }
        recoveredBeforeProjectFallbackAllowClaim = true;
        await logNotifyHookEvent(logsDir, {
          timestamp: new Date().toISOString(),
          level: 'warn',
          type: 'project_fallback_turn_dedupe_allow_claim_recovered_before_delivery',
          thread_id: threadId || null,
          turn_id: turnId || null,
          event_type: eventType,
          omx_session_id: dedupeSessionId || null,
          source: projectDedupeDetails.source || null,
          existing_source: beforeProjectFallbackReplay.decision.existingClaim?.source || null,
          existing_source_kind: beforeProjectFallbackReplay.decision.existingClaim?.source_kind || null,
        });
      }
      if (beforeProjectFallbackReplay.decision?.persistenceFailed) {
        process.exit(0);
      }
      if (beforeProjectFallbackReplay.decision) {
        if (
          beforeProjectFallbackReplay.decision.shouldContinue
          && beforeProjectFallbackReplay.decision.suppressExternalDelivery
          && beforeProjectFallbackReplay.decision.existingClaim?.delivery === 'allow'
        ) {
          recoveredBeforeProjectFallbackAllowClaim = await shouldRecoverUndeliveredAllowClaim(
            logsDir,
            { threadId, turnId },
            beforeProjectFallbackReplay.decision.existingClaim,
          );
          if (recoveredBeforeProjectFallbackAllowClaim) {
            await logNotifyHookEvent(logsDir, {
              timestamp: new Date().toISOString(),
              level: 'warn',
              type: 'project_fallback_turn_dedupe_allow_claim_recovered_before_delivery',
              phase: 'before_project_owner_upgrade',
              thread_id: threadId || null,
              turn_id: turnId || null,
              event_type: eventType,
              omx_session_id: dedupeSessionId || null,
              source: projectDedupeDetails.source || null,
              existing_source: beforeProjectFallbackReplay.decision.existingClaim.source || null,
              existing_source_kind: beforeProjectFallbackReplay.decision.existingClaim.source_kind || null,
            });
          }
          if (!recoveredBeforeProjectFallbackAllowClaim) {
            await logNotifyHookEvent(logsDir, {
              timestamp: new Date().toISOString(),
              type: 'completed_turn_duplicate_suppressed',
              origin_kind: turnOrigin.kind,
              audience: originResolution.audience,
              delivery: 'suppress',
              reason: 'project_duplicate_previous_delivery',
              thread_id: threadId || null,
              turn_id: turnId || null,
              native_session_id: payloadSessionId || turnOrigin.nativeSessionId || null,
              omx_session_id: dedupeSessionId || null,
              parent_thread_id: turnOrigin.parentThreadId || null,
              agent_nickname: turnOrigin.agentNickname || null,
              agent_role: turnOrigin.agentRole || null,
              origin_evidence: originResolution.evidence,
              evidence_sources: originResolution.evidence.map((entry) => entry.source),
              existing_source: beforeProjectFallbackReplay.decision.existingClaim.source || null,
              existing_source_kind: beforeProjectFallbackReplay.decision.existingClaim.source_kind || null,
              existing_delivery_status: beforeProjectFallbackReplay.decision.existingClaim.delivery_status || null,
            });
            process.exit(0);
          }
        }
        if (!recoveredBeforeProjectFallbackAllowClaim) {
          suppressProjectCompletedTurnDelivery ||= beforeProjectFallbackReplay.decision.suppressExternalDelivery;
        }
        if (
          beforeProjectFallbackReplay.decision.reason === 'owner_upgrade'
          && beforeProjectFallbackReplay.decision.existingClaim
        ) {
          pendingProjectFallbackOwnerUpgrade = {
            key,
            expectedClaim: beforeProjectFallbackReplay.decision.existingClaim,
            nextClaim: beforeProjectFallbackReplay.decision.currentClaim,
            threadId,
            turnId,
            eventType,
            sessionId: dedupeSessionId,
            source: projectDedupeDetails.source,
          };
        }
      }
      let projectDedupeFailed = false;
      let projectDedupe: ProjectTurnDedupeDecision | null = null;
      let recoveringUndeliveredProjectAllowClaim = false;
      let pendingProjectPrimaryRollback: PendingProjectFallbackOwnerUpgrade['primaryRollback'] | undefined;
      try {
        projectDedupe = await recordProjectTurnDedupe(
          stateDir,
          logsDir,
          key,
          projectDedupeDetails,
        );
        if (
          recoveredBeforeProjectFallbackAllowClaim
          && projectDedupe.shouldContinue
          && projectDedupe.reason === 'owner_upgrade'
          && projectDedupe.existingClaim?.delivery === 'allow'
          && projectDedupe.suppressExternalDelivery
        ) {
          recoveringUndeliveredProjectAllowClaim = true;
          projectDedupe = {
            ...projectDedupe,
            suppressExternalDelivery: false,
          };
        }
        if (!projectDedupe.shouldContinue) {
          const shouldRecoverAllowClaim = projectDedupe.currentClaim.delivery === 'allow'
            && projectDedupe.existingClaim?.delivery === 'allow'
            && await shouldRecoverUndeliveredAllowClaim(
              logsDir,
              { threadId, turnId },
              projectDedupe.existingClaim,
          );
          if (!shouldRecoverAllowClaim) {
            if (pendingProjectFallbackOwnerUpgrade) {
              const closedRepairClaim = projectDedupe.existingClaim?.delivery === 'allow'
                ? closeLegacyAllowClaimForFallbackRepair(projectDedupe.existingClaim)
                : null;
              if (closedRepairClaim && isProjectAllowClaimDeliveryClosed(closedRepairClaim)) {
                await finalizeProjectFallbackOwnerUpgrade(
                  stateDir,
                  logsDir,
                  {
                    ...pendingProjectFallbackOwnerUpgrade,
                    nextClaim: closedRepairClaim,
                  },
                );
              }
              pendingProjectFallbackOwnerUpgrade = null;
            }
            process.exit(0);
          }
          const recoveryClaimed = projectDedupe.existingClaim
            ? await claimProjectTurnRecoveryIfCurrent(
              stateDir,
              key,
              projectDedupe.existingClaim,
              projectDedupe.currentClaim,
            ).catch(async (error) => {
              await logNotifyHookEvent(logsDir, {
                timestamp: new Date().toISOString(),
                level: 'warn',
                type: 'project_turn_dedupe_recovery_claim_failed',
                thread_id: threadId || null,
                turn_id: turnId || null,
                event_type: eventType,
                omx_session_id: dedupeSessionId || null,
                source: projectDedupeDetails.source || null,
                error: error instanceof Error ? error.message : String(error),
              });
              return false;
            })
            : false;
          if (!recoveryClaimed) {
            await logNotifyHookEvent(logsDir, {
              timestamp: new Date().toISOString(),
              level: 'warn',
              type: 'project_turn_dedupe_recovery_claim_failed',
              thread_id: threadId || null,
              turn_id: turnId || null,
              event_type: eventType,
              omx_session_id: dedupeSessionId || null,
              source: projectDedupeDetails.source || null,
              existing_source: projectDedupe.existingClaim?.source || null,
              existing_source_kind: projectDedupe.existingClaim?.source_kind || null,
              reason: 'claim_changed_before_recovery',
            });
            process.exit(0);
          }
          recoveringUndeliveredProjectAllowClaim = true;
          suppressProjectCompletedTurnDelivery = false;
          await logNotifyHookEvent(logsDir, {
            timestamp: new Date().toISOString(),
            level: 'warn',
            type: 'project_turn_dedupe_allow_claim_recovered_before_delivery',
            thread_id: threadId || null,
            turn_id: turnId || null,
            event_type: eventType,
            omx_session_id: dedupeSessionId || null,
            source: projectDedupeDetails.source || null,
            existing_source: projectDedupe.existingClaim?.source || null,
            existing_source_kind: projectDedupe.existingClaim?.source_kind || null,
            fallback_inconsistent: Boolean(pendingProjectFallbackOwnerUpgrade),
          });
          projectDedupe = {
            ...projectDedupe,
            shouldContinue: true,
            suppressExternalDelivery: false,
            reason: 'allow_claim_recovered_before_delivery',
          };
        }
        projectDedupeFailed = projectDedupe.persistenceFailed === true;
        suppressProjectCompletedTurnDelivery ||= projectDedupe.suppressExternalDelivery;
        pendingProjectPrimaryRollback = projectPrimaryRollbackForPreDelivery(projectDedupe);
        if (pendingProjectFallbackOwnerUpgrade && projectDedupe.shouldContinue) {
          pendingProjectFallbackOwnerUpgrade = {
            ...pendingProjectFallbackOwnerUpgrade,
            nextClaim: projectDedupe.currentClaim,
            ...(pendingProjectPrimaryRollback
              ? { primaryRollback: pendingProjectPrimaryRollback }
              : {}),
          };
        }
        if (
          completedTurnDedupeForDeliveryStatus
          && projectDedupe.shouldContinue
          && projectDedupe.currentClaim.delivery === 'allow'
          && !projectDedupe.suppressExternalDelivery
        ) {
          completedTurnDedupeForDeliveryStatus = {
            ...completedTurnDedupeForDeliveryStatus,
            expectedClaim: projectDedupe.currentClaim,
          };
        }
      } catch (error) {
        projectDedupeFailed = true;
        await logNotifyHookEvent(logsDir, {
          timestamp: new Date().toISOString(),
          level: 'warn',
          type: 'project_turn_dedupe_failed',
          thread_id: threadId || null,
          turn_id: turnId || null,
          event_type: eventType,
          omx_session_id: dedupeSessionId || null,
          error: error instanceof Error ? error.message : String(error),
        });
        if (isStateFileLockTimeout(error)) {
          process.exit(0);
        }
      }

      let projectFallbackDedupeFailed = false;
      let pendingProjectFallbackRollback: ProjectTurnClaim | null = null;
      if (!projectDedupeFailed && projectDedupe?.shouldContinue && !beforeProjectFallbackReplay.decision) {
        // Lock and read the fallback store even when it does not exist yet.
        // This orders normal primary writers against degraded fallback writers:
        // whichever store writes first is visible to the other's post-write check.
        const afterProjectFallbackReplay = await attemptProjectFallbackTurnDedupeReplay(
          stateDir,
          logsDir,
          key,
          projectDedupeDetails,
          'after_project',
        );
        if (afterProjectFallbackReplay.decision) {
          const afterProjectFallbackClosedAllow = Boolean(
            afterProjectFallbackReplay.decision.existingClaim
            && isProjectAllowClaimDeliveryClosed(afterProjectFallbackReplay.decision.existingClaim),
          );
          await logNotifyHookEvent(logsDir, {
            timestamp: new Date().toISOString(),
            type: 'project_fallback_turn_dedupe_primary_won_race',
            thread_id: threadId || null,
            turn_id: turnId || null,
            event_type: eventType,
            omx_session_id: dedupeSessionId || null,
            decision_reason: afterProjectFallbackReplay.decision.reason,
            fallback_delivery: afterProjectFallbackReplay.decision.existingClaim?.delivery || null,
            fallback_source: afterProjectFallbackReplay.decision.existingClaim?.source || null,
            fallback_source_kind: afterProjectFallbackReplay.decision.existingClaim?.source_kind || null,
            suppress_external_delivery: afterProjectFallbackReplay.decision.suppressExternalDelivery,
            fallback_delivery_closed: afterProjectFallbackClosedAllow,
          });
          const shouldCheckFallbackAllowRecovery = afterProjectFallbackReplay.decision.existingClaim?.delivery === 'allow'
            && (
              afterProjectFallbackReplay.decision.suppressExternalDelivery
              || !afterProjectFallbackClosedAllow
            );
          const recoverFallbackAllowClaim = shouldCheckFallbackAllowRecovery
            && await shouldRecoverUndeliveredAllowClaim(
              logsDir,
              { threadId, turnId },
              afterProjectFallbackReplay.decision.existingClaim,
            );
          if (recoverFallbackAllowClaim) {
            await logNotifyHookEvent(logsDir, {
              timestamp: new Date().toISOString(),
              level: 'warn',
              type: 'project_fallback_turn_dedupe_allow_claim_recovered_before_delivery',
              phase: 'after_project',
              thread_id: threadId || null,
              turn_id: turnId || null,
              event_type: eventType,
              omx_session_id: dedupeSessionId || null,
              source: projectDedupeDetails.source || null,
              existing_source: afterProjectFallbackReplay.decision.existingClaim?.source || null,
              existing_source_kind: afterProjectFallbackReplay.decision.existingClaim?.source_kind || null,
            });
          } else {
            const fallbackExistingAllowClaim = afterProjectFallbackReplay.decision.existingClaim?.delivery === 'allow'
              ? afterProjectFallbackReplay.decision.existingClaim
              : null;
            if (fallbackExistingAllowClaim && projectDedupe.currentClaim.delivery === 'allow') {
              const replacementClaim = closeLegacyAllowClaimForFallbackRepair(fallbackExistingAllowClaim);
              const mirrored = await replaceProjectTurnDedupeClaimIfCurrent(
                stateDir,
                key,
                projectDedupe.currentClaim,
                replacementClaim,
              ).catch(async (error) => {
                await logNotifyHookEvent(logsDir, {
                  timestamp: new Date().toISOString(),
                  level: 'warn',
                  type: 'project_turn_dedupe_rollback_failed',
                  thread_id: threadId || null,
                  turn_id: turnId || null,
                  event_type: eventType,
                  omx_session_id: dedupeSessionId || null,
                  reason: 'fallback_replay_existing_claim_suppressed',
                  rollback_mode: 'mirror_fallback_claim',
                  error: error instanceof Error ? error.message : String(error),
                });
                return false;
              });
              await logNotifyHookEvent(logsDir, {
                timestamp: new Date().toISOString(),
                level: 'warn',
                type: 'project_turn_dedupe_rolled_back',
                thread_id: threadId || null,
                turn_id: turnId || null,
                event_type: eventType,
                omx_session_id: dedupeSessionId || null,
                reason: 'fallback_replay_existing_claim_suppressed',
                rollback_mode: 'mirror_fallback_claim',
                rolled_back: mirrored,
                replacement_source: replacementClaim.source || null,
                replacement_source_kind: replacementClaim.source_kind,
                replacement_delivery_status: replacementClaim.delivery_status || null,
              });
            }
            suppressProjectCompletedTurnDelivery ||=
              afterProjectFallbackReplay.decision.suppressExternalDelivery
              || afterProjectFallbackClosedAllow
              || (afterProjectFallbackReplay.decision.existingClaim?.delivery === 'allow');
          }
        }
        if (afterProjectFallbackReplay.decision?.persistenceFailed) {
          const rolledBack = pendingProjectPrimaryRollback
            ? await rollbackPendingPrimaryClaim(
              stateDir,
              logsDir,
              {
                key,
                expectedClaim: projectDedupe.currentClaim,
                nextClaim: projectDedupe.currentClaim,
                primaryRollback: pendingProjectPrimaryRollback,
                threadId,
                turnId,
                eventType,
                sessionId: dedupeSessionId,
                source: projectDedupeDetails.source,
              },
              'fallback_replay_persistence_failed',
            )
            : false;
          if (rolledBack || suppressExternalCompletedTurn || suppressProjectCompletedTurnDelivery) {
            process.exit(0);
          }
        }
        if (afterProjectFallbackReplay.failed) {
          const fallbackReplayFailureReason = afterProjectFallbackReplay.lockTimedOut
            ? 'fallback_replay_lock_timeout'
            : 'fallback_replay_failed';
          const shouldRestorePreviousPrimaryClaim =
            Boolean(projectDedupe.existingClaim)
            && (
              recoveringUndeliveredProjectAllowClaim
              || (
                projectDedupe.reason === 'owner_upgrade'
                && !projectDedupe.suppressExternalDelivery
              )
            );
          const shouldFailClosedAfterPrimaryReplayFailure =
            projectDedupe.reason === 'first' || shouldRestorePreviousPrimaryClaim;
          if (shouldFailClosedAfterPrimaryReplayFailure) {
            const rollbackSucceeded = shouldRestorePreviousPrimaryClaim && projectDedupe.existingClaim
              ? await replaceProjectTurnDedupeClaimIfCurrent(
                stateDir,
                key,
                projectDedupe.currentClaim,
                projectDedupe.existingClaim,
              ).catch(async (error) => {
                await logNotifyHookEvent(logsDir, {
                  timestamp: new Date().toISOString(),
                  level: 'warn',
                  type: 'project_turn_dedupe_rollback_failed',
                  thread_id: threadId || null,
                  turn_id: turnId || null,
                  event_type: eventType,
                  omx_session_id: dedupeSessionId || null,
                  reason: fallbackReplayFailureReason,
                  rollback_mode: 'restore_previous_claim',
                  error: error instanceof Error ? error.message : String(error),
                });
                return false;
              })
              : await removeProjectTurnDedupeClaimIfCurrent(
                stateDir,
                key,
                projectDedupe.currentClaim,
              ).catch(async (error) => {
                await logNotifyHookEvent(logsDir, {
                  timestamp: new Date().toISOString(),
                  level: 'warn',
                  type: 'project_turn_dedupe_rollback_failed',
                  thread_id: threadId || null,
                  turn_id: turnId || null,
                  event_type: eventType,
                  omx_session_id: dedupeSessionId || null,
                  reason: fallbackReplayFailureReason,
                  rollback_mode: 'remove_first_claim',
                  error: error instanceof Error ? error.message : String(error),
                });
                return false;
              });
            await logNotifyHookEvent(logsDir, {
              timestamp: new Date().toISOString(),
              level: 'warn',
              type: 'project_turn_dedupe_rolled_back',
              thread_id: threadId || null,
              turn_id: turnId || null,
              event_type: eventType,
              omx_session_id: dedupeSessionId || null,
              reason: fallbackReplayFailureReason,
              rollback_mode: shouldRestorePreviousPrimaryClaim
                ? 'restore_previous_claim'
                : 'remove_first_claim',
              rolled_back: rollbackSucceeded,
            });
            process.exit(0);
          }
        }
        if (
          afterProjectFallbackReplay.decision?.reason === 'owner_upgrade'
          && afterProjectFallbackReplay.decision.existingClaim
        ) {
          pendingProjectFallbackOwnerUpgrade = {
            key,
            expectedClaim: afterProjectFallbackReplay.decision.existingClaim,
            nextClaim: afterProjectFallbackReplay.decision.currentClaim,
            primaryRollback: pendingProjectPrimaryRollback,
            threadId,
            turnId,
            eventType,
            sessionId: dedupeSessionId,
            source: projectDedupeDetails.source,
          };
        }
      } else if (projectDedupeFailed) {
        if (beforeProjectFallbackReplay.failed && beforeProjectFallbackReplay.lockTimedOut) {
          process.exit(0);
        }
        try {
          const fallbackProjectDedupe = await recordProjectFallbackTurnDedupe(
            stateDir,
            logsDir,
            key,
            projectDedupeDetails,
          );
          if (!fallbackProjectDedupe.shouldContinue) {
            process.exit(0);
          }
          if (fallbackProjectDedupe.persistenceFailed) {
            process.exit(0);
          }
          if (fallbackProjectDedupe.reason === 'first') {
            pendingProjectFallbackRollback = fallbackProjectDedupe.currentClaim;
          }
          if (
            completedTurnDedupeForDeliveryStatus
            && fallbackProjectDedupe.shouldContinue
            && fallbackProjectDedupe.currentClaim.delivery === 'allow'
            && !fallbackProjectDedupe.suppressExternalDelivery
          ) {
            completedTurnDedupeForDeliveryStatus = {
              ...completedTurnDedupeForDeliveryStatus,
              expectedClaim: fallbackProjectDedupe.currentClaim,
            };
          }
          // Mirror the post-primary fallback check in the degraded direction so
          // a fallback writer suppresses itself if a healthy primary writer won.
          const primaryReplay = await replayPrimaryProjectTurnDedupe(
            stateDir,
            logsDir,
            key,
            projectDedupeDetails,
          ).catch(async (error) => {
            await logNotifyHookEvent(logsDir, {
              timestamp: new Date().toISOString(),
              level: 'warn',
              type: 'project_turn_dedupe_replay_failed',
              thread_id: threadId || null,
              turn_id: turnId || null,
              event_type: eventType,
              omx_session_id: dedupeSessionId || null,
              error: error instanceof Error ? error.message : String(error),
            });
            if (!shouldFailClosedOnPrimaryReplayError(error)) {
              return null;
            }
            const rollbackReason = isStateFileLockTimeout(error)
              ? 'primary_replay_lock_timeout'
              : 'primary_replay_failed';
            let rollbackSucceeded = false;
            if (fallbackProjectDedupe.reason === 'first') {
              rollbackSucceeded = await removeProjectFallbackTurnDedupeClaimIfCurrent(
                stateDir,
                key,
                fallbackProjectDedupe.currentClaim,
              ).catch(async (rollbackError) => {
                await logNotifyHookEvent(logsDir, {
                  timestamp: new Date().toISOString(),
                  level: 'warn',
                  type: 'project_fallback_turn_dedupe_rollback_failed',
                  thread_id: threadId || null,
                  turn_id: turnId || null,
                  event_type: eventType,
                  omx_session_id: dedupeSessionId || null,
                  reason: rollbackReason,
                  error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
                });
                return false;
              });
            } else if (fallbackProjectDedupe.reason === 'owner_upgrade' && fallbackProjectDedupe.existingClaim) {
              rollbackSucceeded = await updateProjectFallbackTurnDedupeClaimIfCurrent(
                stateDir,
                key,
                fallbackProjectDedupe.currentClaim,
                fallbackProjectDedupe.existingClaim,
              ).catch(async (rollbackError) => {
                await logNotifyHookEvent(logsDir, {
                  timestamp: new Date().toISOString(),
                  level: 'warn',
                  type: 'project_fallback_turn_dedupe_rollback_failed',
                  thread_id: threadId || null,
                  turn_id: turnId || null,
                  event_type: eventType,
                  omx_session_id: dedupeSessionId || null,
                  reason: rollbackReason,
                  error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
                });
                return false;
              });
            }
            if (fallbackProjectDedupe.reason === 'first' || fallbackProjectDedupe.reason === 'owner_upgrade') {
              await logNotifyHookEvent(logsDir, {
                timestamp: new Date().toISOString(),
                level: 'warn',
                type: 'project_fallback_turn_dedupe_rolled_back',
                thread_id: threadId || null,
                turn_id: turnId || null,
                event_type: eventType,
                omx_session_id: dedupeSessionId || null,
                reason: rollbackReason,
                rolled_back: rollbackSucceeded,
              });
            }
            projectFallbackDedupeFailed = true;
            return null;
          });
          if (primaryReplay && !primaryReplay.shouldContinue) {
            if (primaryReplay.existingClaim?.delivery === 'allow') {
              await finalizeProjectFallbackOwnerUpgrade(stateDir, logsDir, {
                key,
                expectedClaim: fallbackProjectDedupe.reason === 'owner_upgrade' && fallbackProjectDedupe.existingClaim
                  ? fallbackProjectDedupe.existingClaim
                  : fallbackProjectDedupe.currentClaim,
                nextClaim: closeLegacyAllowClaimForFallbackRepair(primaryReplay.existingClaim),
                threadId,
                turnId,
                eventType,
                sessionId: dedupeSessionId,
                source: projectDedupeDetails.source,
              });
            }
            process.exit(0);
          }
          if (primaryReplay?.persistenceFailed) {
            process.exit(0);
          }
          if (primaryReplay) {
            suppressProjectCompletedTurnDelivery ||= primaryReplay.suppressExternalDelivery;
          }
          if (fallbackProjectDedupe.reason === 'owner_upgrade' && fallbackProjectDedupe.existingClaim) {
            pendingProjectFallbackOwnerUpgrade = {
              key,
              expectedClaim: fallbackProjectDedupe.existingClaim,
              nextClaim: fallbackProjectDedupe.currentClaim,
              threadId,
              turnId,
              eventType,
              sessionId: dedupeSessionId,
              source: projectDedupeDetails.source,
            };
          }
          suppressProjectCompletedTurnDelivery ||= fallbackProjectDedupe.suppressExternalDelivery;
        } catch (error) {
          projectFallbackDedupeFailed = true;
          await logNotifyHookEvent(logsDir, {
            timestamp: new Date().toISOString(),
            level: 'warn',
            type: 'project_fallback_turn_dedupe_failed',
            thread_id: threadId || null,
            turn_id: turnId || null,
            event_type: eventType,
            omx_session_id: dedupeSessionId || null,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (projectDedupeFailed && projectFallbackDedupeFailed) {
        process.exit(0);
      }

      const scopedDedupeDir = await resolveScopedStateDir(stateDir, dedupeSessionId);
      const sessionDedupeStatePath = scopedDedupeDir === stateDir
        ? null
        : join(scopedDedupeDir, NOTIFY_HOOK_STATE_FILE);
      let fallbackFirst = true;
      try {
        if (!sessionDedupeStatePath) {
          fallbackFirst = true;
        } else {
          fallbackFirst = await updateLockedJsonState<boolean>(sessionDedupeStatePath, async (rawState) => {
            const dedupeState = normalizeNotifyState(rawState);
            dedupeState.recent_turns = pruneRecentTurns(dedupeState.recent_turns, now);
            if (dedupeState.recent_turns[key]) {
              return { result: false, write: false };
            }
            dedupeState.recent_turns[key] = now;
            dedupeState.last_event_at = new Date().toISOString();
            return {
              result: true,
              nextState: dedupeState,
              write: true,
            };
          });
        }
      } catch (error) {
        await logNotifyHookEvent(logsDir, {
          timestamp: new Date().toISOString(),
          level: 'warn',
          type: 'session_turn_dedupe_failed',
          scope: 'session',
          thread_id: threadId || null,
          turn_id: turnId || null,
          event_type: eventType,
          omx_session_id: dedupeSessionId || null,
          project_dedupe_failed: projectDedupeFailed,
          project_fallback_dedupe_failed: projectFallbackDedupeFailed,
          error: error instanceof Error ? error.message : String(error),
        });
        if (pendingProjectFallbackRollback) {
          const fallbackRolledBack = await removeProjectFallbackTurnDedupeClaimIfCurrent(
            stateDir,
            key,
            pendingProjectFallbackRollback,
          ).catch(async (rollbackError) => {
            await logNotifyHookEvent(logsDir, {
              timestamp: new Date().toISOString(),
              level: 'warn',
              type: 'project_fallback_turn_dedupe_rollback_failed',
              thread_id: threadId || null,
              turn_id: turnId || null,
              event_type: eventType,
              omx_session_id: dedupeSessionId || null,
              reason: 'session_turn_dedupe_failed',
              error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
            });
            return false;
          });
          await logNotifyHookEvent(logsDir, {
            timestamp: new Date().toISOString(),
            level: 'warn',
            type: 'project_fallback_turn_dedupe_rolled_back',
            thread_id: threadId || null,
            turn_id: turnId || null,
            event_type: eventType,
            omx_session_id: dedupeSessionId || null,
            reason: 'session_turn_dedupe_failed',
            rolled_back: fallbackRolledBack,
          });
          process.exit(0);
        }
        if (projectDedupeFailed) {
          process.exit(0);
        }
        if (projectDedupeFailed && projectFallbackDedupeFailed) {
          process.exit(0);
        }
      }
      if (!fallbackFirst) {
        const shouldRecoverSessionDuplicate = recoveringUndeliveredProjectAllowClaim
          || (
            projectDedupe?.reason === 'owner_upgrade'
            && projectDedupe.currentClaim.delivery === 'allow'
            && projectDedupe.existingClaim?.delivery === 'suppress'
            && !projectDedupe.suppressExternalDelivery
          );
        let recoveredSessionDuplicate = false;
        if (shouldRecoverSessionDuplicate) {
          recoveredSessionDuplicate = true;
          await logNotifyHookEvent(logsDir, {
            timestamp: new Date().toISOString(),
            level: 'warn',
            type: 'session_turn_dedupe_recovered_before_delivery',
            scope: 'session',
            thread_id: threadId || null,
            turn_id: turnId || null,
            event_type: eventType,
            omx_session_id: dedupeSessionId || null,
            recovered: true,
          });
        }
        const rolledBack = !recoveredSessionDuplicate && pendingProjectPrimaryRollback
          ? await rollbackPendingPrimaryClaim(
            stateDir,
            logsDir,
            {
              key,
              expectedClaim: pendingProjectPrimaryRollback.expectedClaim,
              nextClaim: pendingProjectPrimaryRollback.expectedClaim,
              primaryRollback: pendingProjectPrimaryRollback,
              threadId,
              turnId,
              eventType,
              sessionId: dedupeSessionId,
              source: projectDedupeDetails.source,
            },
            'session_turn_dedupe_duplicate_before_delivery',
          )
          : false;
        if (pendingProjectFallbackRollback) {
          const fallbackRolledBack = await removeProjectFallbackTurnDedupeClaimIfCurrent(
            stateDir,
            key,
            pendingProjectFallbackRollback,
          ).catch(async (error) => {
            await logNotifyHookEvent(logsDir, {
              timestamp: new Date().toISOString(),
              level: 'warn',
              type: 'project_fallback_turn_dedupe_rollback_failed',
              thread_id: threadId || null,
              turn_id: turnId || null,
              event_type: eventType,
              omx_session_id: dedupeSessionId || null,
              reason: 'session_turn_dedupe_duplicate_before_delivery',
              error: error instanceof Error ? error.message : String(error),
            });
            return false;
          });
          await logNotifyHookEvent(logsDir, {
            timestamp: new Date().toISOString(),
            level: 'warn',
            type: 'project_fallback_turn_dedupe_rolled_back',
            thread_id: threadId || null,
            turn_id: turnId || null,
            event_type: eventType,
            omx_session_id: dedupeSessionId || null,
            reason: 'session_turn_dedupe_duplicate_before_delivery',
            rolled_back: fallbackRolledBack,
          });
        }
        if (rolledBack && pendingProjectPrimaryRollback?.replacementClaim && sessionDedupeStatePath) {
          await removeSessionTurnDedupeKeyIfCurrent(
            sessionDedupeStatePath,
            key,
          ).catch(async (error) => {
            await logNotifyHookEvent(logsDir, {
              timestamp: new Date().toISOString(),
              level: 'warn',
              type: 'session_turn_dedupe_rollback_failed',
              scope: 'session',
              thread_id: threadId || null,
              turn_id: turnId || null,
              event_type: eventType,
              omx_session_id: dedupeSessionId || null,
              reason: 'session_turn_dedupe_duplicate_before_delivery',
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
        if (
          !recoveredSessionDuplicate
          && (
            rolledBack
            || pendingProjectFallbackRollback
            || !pendingProjectPrimaryRollback?.replacementClaim
            || suppressExternalCompletedTurn
            || suppressProjectCompletedTurnDelivery
          )
        ) {
          process.exit(0);
        }
      }
      if (
        pendingProjectFallbackOwnerUpgrade
        && !suppressExternalCompletedTurn
        && !suppressProjectCompletedTurnDelivery
      ) {
        const fallbackUpgradeSucceeded = await finalizeProjectFallbackOwnerUpgrade(
          stateDir,
          logsDir,
          pendingProjectFallbackOwnerUpgrade,
        );
        const failedUpgrade = pendingProjectFallbackOwnerUpgrade;
        pendingProjectFallbackOwnerUpgrade = null;
        if (!fallbackUpgradeSucceeded) {
          const rolledBack = await rollbackPendingPrimaryClaim(
            stateDir,
            logsDir,
            failedUpgrade,
            'fallback_owner_upgrade_finalize_failed',
          );
          if ((rolledBack || !failedUpgrade.primaryRollback) && sessionDedupeStatePath) {
            await removeSessionTurnDedupeKeyIfCurrent(
              sessionDedupeStatePath,
              key,
            ).catch(async (error) => {
              await logNotifyHookEvent(logsDir, {
                timestamp: new Date().toISOString(),
                level: 'warn',
                type: 'session_turn_dedupe_rollback_failed',
                scope: 'session',
                thread_id: threadId || null,
                turn_id: turnId || null,
                event_type: eventType,
                omx_session_id: dedupeSessionId || null,
                reason: 'fallback_owner_upgrade_finalize_failed',
                error: error instanceof Error ? error.message : String(error),
              });
            });
          }
          process.exit(0);
        }
      }
    }
  } catch {
    // Non-critical
  }

  // 0.5. Track leader + native subagent thread activity (lead session only)
  if (!isTeamWorker) {
    try {
      const threadId = safeString(payload['thread-id'] || payload.thread_id || '');
      const turnId = safeString(payload['turn-id'] || payload.turn_id || '');
      if (
        getEffectiveSessionId()
        && threadId
        && (originResolution.audience === 'external-owner' || originResolution.audience === 'child')
      ) {
        const { recordSubagentTurnForSession } = await import('../subagents/tracker.js');
        const trackingKind = originResolution.audience === 'external-owner'
          ? 'leader'
          : 'subagent';
        await recordSubagentTurnForSession(cwd, {
          sessionId: getEffectiveSessionId(),
          threadId,
          ...(turnId ? { turnId } : {}),
          timestamp: new Date().toISOString(),
          mode: safeString(payload.mode || ''),
          ...(trackingKind ? { kind: trackingKind } : {}),
          ...(turnOrigin.parentThreadId ? { parentThreadId: turnOrigin.parentThreadId } : {}),
        });
      }
    } catch {
      // Non-critical: tracking must never block the hook
    }
  }

  // 1. Log the turn
  const normalizedInputMessages = normalizeInputMessages(payload);
  const latestInputPreview = safeString(
    normalizedInputMessages.length > 0
      ? normalizedInputMessages[normalizedInputMessages.length - 1]
      : '',
  ).slice(0, 200);
  const rawOutput = safeString(payload['last-assistant-message'] || payload.last_assistant_message || '');
  const logEntry = {
    timestamp: new Date().toISOString(),
    type: payload.type || 'agent-turn-complete',
    thread_id: payload['thread-id'] || payload.thread_id,
    turn_id: payload['turn-id'] || payload.turn_id,
    origin_kind: turnOrigin.kind,
    origin_parent_thread_id: turnOrigin.parentThreadId,
    input_preview: suppressExternalCompletedTurn ? '' : latestInputPreview,
    input_message_count: normalizedInputMessages.length,
    output_preview: suppressExternalCompletedTurn ? '' : rawOutput.slice(0, 200),
    ...(suppressExternalCompletedTurn
      ? {
        output_redacted: true,
        output_length: rawOutput.length,
        suppression_reason: originResolution.reason,
        audience: originResolution.audience,
      }
      : {}),
  };

  const logFile = join(logsDir, `turns-${new Date().toISOString().split('T')[0]}.jsonl`);
  await appendFile(logFile, JSON.stringify(logEntry) + '\n').catch(() => {});

  if (!isTurnComplete) {
    return;
  }

  if (isTeamWorker && !workerStateRootResolved) {
    await logNotifyHookEvent(logsDir, {
      timestamp: new Date().toISOString(),
      level: 'warn',
      type: 'team_worker_state_root_unresolved',
      team_worker: teamWorkerEnv || null,
      reason: 'skip_team_worker_state_mutations',
    }).catch(() => {});

    // Keep the fail-closed worker state-root behavior for normal team-worker
    // mutations, but allow the narrow auto-nudge path to use an explicitly
    // supplied, already-existing worker state root. Auto-nudge only needs the
    // worker-scoped state files/pane anchor and should not fall back to creating
    // local `.omx/state` when identity resolution failed.
    const explicitWorkerStateRoot = safeString(process.env.OMX_TEAM_STATE_ROOT || '').trim();
    const autoNudgeStateDir = explicitWorkerStateRoot ? resolve(cwd, explicitWorkerStateRoot) : '';
    if (autoNudgeStateDir && existsSync(autoNudgeStateDir)) {
      try {
        await maybeAutoNudge({ cwd, stateDir: autoNudgeStateDir, logsDir, payload });
      } catch {
        // Non-critical
      }
    }
    return;
  }

  // Reconcile Ralph ownership for same-Codex-session continuation before
  // lifecycle counters or injection read the active scope.
  if (!isTeamWorker) {
    try {
      const resumeResult = await reconcileRalphSessionResume({
        stateDir,
        payloadSessionId,
        payloadThreadId,
      });
      currentOmxSessionId = resumeResult.currentOmxSessionId;
      if (resumeResult.resumed || resumeResult.updatedCurrentOwner) {
        await logNotifyHookEvent(logsDir, {
          timestamp: new Date().toISOString(),
          type: 'ralph_session_resume',
          reason: resumeResult.reason,
          current_omx_session_id: resumeResult.currentOmxSessionId || null,
          payload_codex_session_id: payloadSessionId || null,
          source_path: resumeResult.sourcePath || null,
          target_path: resumeResult.targetPath || null,
          owner_updated: resumeResult.updatedCurrentOwner,
          resumed: resumeResult.resumed,
        });
      }
    } catch (error) {
      await logNotifyHookEvent(logsDir, {
        timestamp: new Date().toISOString(),
        level: 'warn',
        type: 'ralph_session_resume_failure',
        payload_codex_session_id: payloadSessionId || null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // 2. Update active mode state (increment iteration)
  // GUARD: Skip when running inside a team worker to prevent state corruption
  if (!isTeamWorker) {
    try {
      const scopedDirs = await getScopedStateDirsForCurrentSession(stateDir);
      for (const scopedDir of scopedDirs) {
        const stateFiles = await readdir(scopedDir).catch(() => []);
        for (const f of stateFiles) {
          if (!f.endsWith('-state.json')) continue;
          const statePath = join(scopedDir, f);
          const state = JSON.parse(await readFile(statePath, 'utf-8'));
          if (state.active) {
            const nowIso = new Date().toISOString();
            const nextIteration = (state.iteration || 0) + 1;
            state.iteration = nextIteration;
            state.last_turn_at = nowIso;

            const maxIterations = asNumber(state.max_iterations);
            if (maxIterations !== null && maxIterations > 0 && nextIteration >= maxIterations) {
              const currentPhase = typeof state.current_phase === 'string'
                ? state.current_phase.trim().toLowerCase()
                : '';
              const isActiveRalphProgress = (
                (f === 'ralph-state.json' || state.mode === 'ralph')
                && RALPH_ACTIVE_PROGRESS_PHASES.has(currentPhase)
              );

              if (isActiveRalphProgress) {
                state.max_iterations = maxIterations + 10;
                state.max_iterations_auto_expand_count = (asNumber(state.max_iterations_auto_expand_count) || 0) + 1;
                state.max_iterations_auto_expanded_at = nowIso;
                delete state.completed_at;
                delete state.stop_reason;
              } else {
                state.active = false;
                if (typeof state.current_phase !== 'string' || !state.current_phase.trim()) {
                  state.current_phase = 'complete';
                } else if (!['cancelled', 'failed', 'complete'].includes(state.current_phase)) {
                  state.current_phase = 'complete';
                }
                if (typeof state.completed_at !== 'string' || !state.completed_at) {
                  state.completed_at = nowIso;
                }
                if (typeof state.stop_reason !== 'string' || !state.stop_reason) {
                  state.stop_reason = 'max_iterations_reached';
                }
              }
            }

            await writeFile(statePath, JSON.stringify(state, null, 2));
          }
        }
      }
    } catch {
      // Non-critical
    }
  }


  // 3. Track subagent metrics (lead session only)
  if (!isTeamWorker) {
    const metricsPath = join(omxDir, 'metrics.json');
    try {
      let metrics = {
        total_turns: 0,
        session_turns: 0,
        last_activity: '',
        session_input_tokens: 0,
        session_output_tokens: 0,
        session_total_tokens: 0,
      };
      if (existsSync(metricsPath)) {
        metrics = { ...metrics, ...JSON.parse(await readFile(metricsPath, 'utf-8')) };
      }

      const tokenUsage = getSessionTokenUsage(payload);
      const quotaUsage = getQuotaUsage(payload);

      metrics.total_turns++;
      metrics.session_turns++;
      metrics.last_activity = new Date().toISOString();

      if (tokenUsage) {
        if (tokenUsage.input !== null) {
          if (tokenUsage.inputCumulative) {
            metrics.session_input_tokens = tokenUsage.input;
          } else {
            metrics.session_input_tokens = (metrics.session_input_tokens || 0) + tokenUsage.input;
          }
        }
        if (tokenUsage.output !== null) {
          if (tokenUsage.outputCumulative) {
            metrics.session_output_tokens = tokenUsage.output;
          } else {
            metrics.session_output_tokens = (metrics.session_output_tokens || 0) + tokenUsage.output;
          }
        }
        if (tokenUsage.total !== null) {
          if (tokenUsage.totalCumulative) {
            metrics.session_total_tokens = tokenUsage.total;
          } else {
            metrics.session_total_tokens = (metrics.session_total_tokens || 0) + tokenUsage.total;
          }
        } else {
          metrics.session_total_tokens = (metrics.session_input_tokens || 0) + (metrics.session_output_tokens || 0);
        }
      } else {
        metrics.session_total_tokens = (metrics.session_input_tokens || 0) + (metrics.session_output_tokens || 0);
      }

      if (quotaUsage) {
        if (quotaUsage.fiveHourLimitPct !== null) (metrics as any).five_hour_limit_pct = quotaUsage.fiveHourLimitPct;
        if (quotaUsage.weeklyLimitPct !== null) (metrics as any).weekly_limit_pct = quotaUsage.weeklyLimitPct;
      }

      await writeFile(metricsPath, JSON.stringify(metrics, null, 2));
    } catch {
      // Non-critical
    }
  }

  // 3.5. Pre-compute leader staleness BEFORE updating HUD state (used by nudge in step 6)
  let preComputedLeaderStale = false;
  if (!isTeamWorker) {
    try {
      const stalenessMs = resolveLeaderStalenessThresholdMs();
      preComputedLeaderStale = await isLeaderStale(stateDir, stalenessMs, Date.now());
    } catch {
      // Non-critical
    }
  }

  // 4. Write HUD state summary for `omx hud` (lead session only)
  if (!isTeamWorker) {
    try {
      const scopedSessionId = getEffectiveSessionId();
      const hudStatePath = await getScopedStatePath(stateDir, 'hud-state.json', scopedSessionId);
      let hudState = await readScopedJsonIfExists(stateDir, 'hud-state.json', scopedSessionId, {
        last_turn_at: '',
        turn_count: 0,
      });
      const nowIso = new Date().toISOString();
      hudState.last_turn_at = nowIso;
      (hudState as any).last_progress_at = nowIso;
      hudState.turn_count = (hudState.turn_count || 0) + 1;
      const hudAssistantOutput = safeString(payload['last-assistant-message'] || payload.last_assistant_message || '');
      if (suppressExternalCompletedTurn) {
        (hudState as any).last_agent_output = '';
        (hudState as any).last_agent_output_redacted = true;
        (hudState as any).last_agent_output_length = hudAssistantOutput.length;
        (hudState as any).last_agent_output_suppression_reason = originResolution.reason;
        (hudState as any).last_agent_output_audience = originResolution.audience;
      } else {
        (hudState as any).last_agent_output = hudAssistantOutput.slice(0, 100);
        delete (hudState as any).last_agent_output_redacted;
        delete (hudState as any).last_agent_output_length;
        delete (hudState as any).last_agent_output_suppression_reason;
        delete (hudState as any).last_agent_output_audience;
      }
      await mkdir(dirname(hudStatePath), { recursive: true }).catch(() => {});
      await writeFile(hudStatePath, JSON.stringify(hudState, null, 2));
    } catch {
      // Non-critical
    }
  }

  // 4.5. Update team worker heartbeat (if applicable)
  if (isTeamWorker) {
    try {
      if (parsedTeamWorker) {
        const { teamName: twTeamName, workerName: twWorkerName } = parsedTeamWorker;
        await updateWorkerHeartbeat(stateDir, twTeamName, twWorkerName);
      }
    } catch {
      // Non-critical: heartbeat write failure should never block the hook
    }
  }

  // 4.45. Skill activation tracking: update skill-active-state.json before any nudge logic.
  try {
    const { recordSkillActivation } = await import('../hooks/keyword-detector.js');
    if (latestUserInput) {
        await recordSkillActivation({
          stateDir,
          text: latestUserInput,
          sessionId: getEffectiveSessionId(),
          threadId: payloadThreadId,
          turnId: safeString(payload['turn-id'] || payload.turn_id || ''),
        });
    }
  } catch {
    // Non-fatal: keyword detector module may not be built yet
  }

  try {
    await syncSkillStateFromTurn(stateDir, payload);
  } catch {
    // Non-fatal: lifecycle sync should not block the hook
  }

  const deepInterviewStateActive = await isDeepInterviewStateActive(stateDir, getEffectiveSessionId());
  const deepInterviewInputLockActive = await isDeepInterviewInputLockActive(stateDir, getEffectiveSessionId());

  // 4.55. Notify leader when individual worker transitions to idle (worker session only)
  if (isTeamWorker && parsedTeamWorker && !deepInterviewStateActive) {
    try {
      await maybeNotifyLeaderWorkerIdle({ cwd, stateDir, logsDir, parsedTeamWorker });
    } catch {
      // Non-critical
    }
  }

  // 4.6. Notify leader when all workers are idle (worker session only)
  if (isTeamWorker && parsedTeamWorker && !deepInterviewStateActive) {
    try {
      await maybeNotifyLeaderAllWorkersIdle({ cwd, stateDir, logsDir, parsedTeamWorker });
    } catch {
      // Non-critical
    }
  }

  // 5. Optional tmux prompt injection workaround (non-fatal, opt-in)
  // Skip for team workers - only the lead should inject prompts
  if (!isTeamWorker) {
    try {
      await handleTmuxInjection({ payload, cwd, stateDir, logsDir });
    } catch {
      // Non-critical
    }
  }

  // 5.5. Opportunistic team dispatch drain (leader session only).
  if (!isTeamWorker) {
    try {
      await drainPendingTeamDispatch({ cwd, stateDir, logsDir, maxPerTick: 5 } as any);
    } catch {
      // Non-critical
    }
  }

  // 6. Team leader nudge (lead session only): remind the leader to check teammate/mailbox state.
  if (!isTeamWorker && !deepInterviewStateActive) {
    try {
      await maybeNudgeTeamLeader({ cwd, stateDir, logsDir, preComputedLeaderStale });
    } catch {
      // Non-critical
    }
  }

  const suppressCompletedTurnDelivery = suppressExternalCompletedTurn || suppressProjectCompletedTurnDelivery;
  const completedTurnDeliverySuppressionReason = suppressExternalCompletedTurn
    ? originResolution.reason
    : 'project_duplicate_previous_delivery';

  // 7. Dispatch native turn-complete hook event (best effort, post-dedupe).
  // Non-leader/internal-helper turns may contain private helper/subagent output,
  // so suppress extensibility hooks with the same policy as human-facing
  // completed-turn notifications.
  if (suppressCompletedTurnDelivery) {
    await logNotifyHookEvent(logsDir, {
      timestamp: new Date().toISOString(),
      type: suppressExternalCompletedTurn
        ? 'turn_complete_hooks_suppressed_non_leader'
        : 'turn_complete_hooks_suppressed_duplicate',
      origin_kind: turnOrigin.kind,
      audience: originResolution.audience,
      delivery_reason: completedTurnDeliverySuppressionReason,
      thread_id: safeString(payload['thread-id'] || payload.thread_id || ''),
      parent_thread_id: turnOrigin.parentThreadId || null,
      agent_nickname: turnOrigin.agentNickname || null,
      agent_role: turnOrigin.agentRole || null,
      origin_evidence: originResolution.evidence,
    });
  } else {
    try {
      const { buildNativeHookEvent, buildDerivedHookEvent } = await import('../hooks/extensibility/events.js');
      const { dispatchHookEvent } = await import('../hooks/extensibility/dispatcher.js');
      const sessionIdForHooks = getEffectiveSessionId();
      const threadIdForHooks = safeString(payload['thread-id'] || payload.thread_id || '');
      const turnIdForHooks = safeString(payload['turn-id'] || payload.turn_id || '');
      const modeForHooks = safeString(payload.mode || '');
      const outputPreview = safeString(payload['last-assistant-message'] || payload.last_assistant_message || '').slice(0, 400);
      const event = buildNativeHookEvent('turn-complete', {
        source: safeString(payload.source || 'native'),
        type: safeString(payload.type || 'agent-turn-complete'),
        input_messages: normalizeInputMessages(payload),
        output_preview: outputPreview,
        native_session_id: payloadSessionId || null,
        omx_session_id: sessionIdForHooks || null,
        ...readRepositoryMetadata(cwd),
        session_name: resolveOperationalSessionName(cwd, sessionIdForHooks),
        project_path: cwd,
        project_name: safeString(payload.project_name || ''),
      }, {
        session_id: sessionIdForHooks,
        thread_id: threadIdForHooks,
        turn_id: turnIdForHooks,
        mode: modeForHooks,
      });
      await dispatchHookEvent(event, { cwd });

      for (const signal of deriveAssistantSignalEvents(outputPreview)) {
        const derivedEvent = buildDerivedHookEvent(signal.event, buildOperationalContext({
          cwd,
          normalizedEvent: signal.normalized_event,
          sessionId: sessionIdForHooks,
          text: outputPreview,
          status: signal.normalized_event,
          errorSummary: signal.error_summary,
          extra: {
            native_session_id: payloadSessionId || null,
            omx_session_id: sessionIdForHooks || null,
            source_event: safeString(payload.type || 'agent-turn-complete'),
          },
        }), {
          session_id: sessionIdForHooks,
          thread_id: threadIdForHooks,
          turn_id: turnIdForHooks,
          mode: modeForHooks,
          confidence: signal.confidence,
          parser_reason: signal.parser_reason,
        });
        await dispatchHookEvent(derivedEvent, { cwd });
      }
    } catch {
      // Non-fatal: extensibility modules may not be built yet
    }
  }

  // 8. Dispatch semantic human-facing notifications while preserving the
  //    coarse internal session-idle hook path (lead session only, best effort).
  if (!isTeamWorker) {
    try {
      const { notifyCompletedTurn } = await import('../notifications/index.js');
      const { getNotificationConfig, isEventEnabled } = await import('../notifications/config.js');
      const {
        shouldSendCompletedTurnNotification,
        recordCompletedTurnNotificationSent,
        shouldSendSessionIdleHookEvent,
        recordSessionIdleHookEventSent,
      } = await import('../notifications/idle-cooldown.js');
      const notifySessionId = getEffectiveSessionId();
      const lastAssistantMessage = safeString(payload['last-assistant-message'] || payload.last_assistant_message || '');
      const hasAssistantText = lastAssistantMessage.trim().length > 0;
      if (suppressCompletedTurnDelivery && hasAssistantText) {
        if (suppressExternalCompletedTurn && notifySessionId) {
          const waitingRoutes = await markPendingRoutesWaitingForOwner(cwd, notifySessionId, {
            ownerActorId: originResolution.ownerActorId,
            reason: completedTurnDeliverySuppressionReason,
          }).catch(() => 0);
          if (waitingRoutes > 0) {
            await logNotifyHookEvent(logsDir, {
              timestamp: new Date().toISOString(),
              type: 'pending_route_waiting_for_owner',
              omx_session_id: notifySessionId,
              owner_actor_id: originResolution.ownerActorId || null,
              waiting_routes: waitingRoutes,
              reason: completedTurnDeliverySuppressionReason,
            });
          }
        }
        const suppressionBase = {
          timestamp: new Date().toISOString(),
          origin_kind: turnOrigin.kind,
          audience: originResolution.audience,
          delivery: 'suppress',
          reason: completedTurnDeliverySuppressionReason,
          thread_id: safeString(payload['thread-id'] || payload.thread_id || ''),
          turn_id: safeString(payload['turn-id'] || payload.turn_id || ''),
          native_session_id: payloadSessionId || turnOrigin.nativeSessionId || null,
          omx_session_id: notifySessionId || null,
          actor_id: originResolution.actorId || null,
          owner_actor_id: originResolution.ownerActorId || null,
          parent_thread_id: turnOrigin.parentThreadId || null,
          agent_nickname: turnOrigin.agentNickname || null,
          agent_role: turnOrigin.agentRole || null,
          origin_evidence: originResolution.evidence,
          evidence_sources: originResolution.evidence.map((entry) => entry.source),
        };
        if (suppressExternalCompletedTurn) {
          await logNotifyHookEvent(logsDir, {
            ...suppressionBase,
            type: 'completed_turn_suppressed_non_leader',
          });
        }
        if (suppressProjectCompletedTurnDelivery) {
          await logNotifyHookEvent(logsDir, {
            ...suppressionBase,
            type: 'completed_turn_duplicate_suppressed',
          });
        }
        await logNotifyHookEvent(logsDir, {
          ...suppressionBase,
          type: 'completed_turn_delivery_suppressed',
        });
      }
      const semanticOutcome = classifyCompletedTurn(lastAssistantMessage);
      let canNotifyExternalCompletedTurn = Boolean(
        notifySessionId
        && hasAssistantText
        && !suppressCompletedTurnDelivery,
      );
      if (
        canNotifyExternalCompletedTurn
        && completedTurnDedupeForDeliveryStatus?.expectedClaim
      ) {
        const dispatchingResults = await markProjectTurnDeliveryStatus(
          stateDir,
          logsDir,
          completedTurnDedupeForDeliveryStatus,
          'dispatching',
        );
        if (dispatchingResults.project || dispatchingResults.project_fallback) {
          completedTurnDedupeForDeliveryStatus = {
            ...completedTurnDedupeForDeliveryStatus,
            expectedClaim: {
              ...completedTurnDedupeForDeliveryStatus.expectedClaim,
              delivery_status: 'dispatching',
            },
          };
        } else {
          const deliveryStatusSource = completedTurnDedupeForDeliveryStatus.source;
          canNotifyExternalCompletedTurn = false;
          completedTurnDedupeForDeliveryStatus = null;
          await logNotifyHookEvent(logsDir, {
            timestamp: new Date().toISOString(),
            level: 'warn',
            type: 'project_turn_dedupe_delivery_status_failed',
            delivery_status: 'dispatching',
            thread_id: safeString(payload['thread-id'] || payload.thread_id || ''),
            turn_id: safeString(payload['turn-id'] || payload.turn_id || ''),
            omx_session_id: notifySessionId || null,
            source: deliveryStatusSource || null,
            reason: 'claim_changed_before_dispatch',
          });
        }
      }
      if (canNotifyExternalCompletedTurn) {
        await logNotifyHookEvent(logsDir, {
          timestamp: new Date().toISOString(),
          type: 'completed_turn_delivery_allowed',
          origin_kind: turnOrigin.kind,
          audience: originResolution.audience,
          delivery: originResolution.delivery,
          reason: originResolution.reason,
          thread_id: safeString(payload['thread-id'] || payload.thread_id || ''),
          turn_id: safeString(payload['turn-id'] || payload.turn_id || ''),
          native_session_id: payloadSessionId || turnOrigin.nativeSessionId || null,
          omx_session_id: notifySessionId || null,
          actor_id: originResolution.actorId || null,
          owner_actor_id: originResolution.ownerActorId || null,
          parent_thread_id: turnOrigin.parentThreadId || null,
          agent_nickname: turnOrigin.agentNickname || null,
          agent_role: turnOrigin.agentRole || null,
          origin_evidence: originResolution.evidence,
          evidence_sources: originResolution.evidence.map((entry) => entry.source),
        });
      }
      const replyOrigin = canNotifyExternalCompletedTurn && notifySessionId
        ? await consumePendingReplyOrigin(cwd, notifySessionId, latestUserInput, originResolution.ownerActorId)
        : null;
      if (replyOrigin?.routeId && notifySessionId) {
        await logNotifyHookEvent(logsDir, {
          timestamp: new Date().toISOString(),
          type: 'pending_route_completed',
          omx_session_id: notifySessionId,
          route_id: replyOrigin.routeId,
          owner_actor_id: originResolution.ownerActorId || null,
          platform: replyOrigin.platform,
        });
      }
      const notificationConfig = getNotificationConfig();
      if (notifySessionId) {
        const expiredRoutes = await expirePendingRoutes(cwd, notifySessionId).catch(() => []);
        for (const route of expiredRoutes) {
          let telegramAckCleanupSucceeded: boolean | null = null;
          if (
            route.platform === 'telegram'
            && route.telegramAck
            && notificationConfig?.telegram?.enabled
            && notificationConfig.telegram.botToken
          ) {
            telegramAckCleanupSucceeded = await deleteTelegramAcceptedAckBestEffort(
              { botToken: notificationConfig.telegram.botToken },
              route.telegramAck,
            ).catch(() => false);
          }
          await logNotifyHookEvent(logsDir, {
            timestamp: new Date().toISOString(),
            type: 'pending_route_expired',
            omx_session_id: notifySessionId,
            route_id: route.routeId,
            owner_actor_id: route.ownerActorId,
            platform: route.platform,
            ...(telegramAckCleanupSucceeded !== null
              ? { telegram_ack_cleanup_succeeded: telegramAckCleanupSucceeded }
              : {}),
          });
        }
      }
      const decision = planCompletedTurnNotification({
        semanticOutcome,
        replyOrigin,
        turnId: safeString(payload['turn-id'] || payload.turn_id || ''),
        assistantText: lastAssistantMessage,
        notificationConfig,
      });
      const notificationEventEnabled = Boolean(
        notificationConfig
        && decision
        && isEventEnabled(notificationConfig, decision.effectiveEvent),
      );
      const completedTurnHookFingerprint = buildCompletedTurnHookFingerprint(
        decision,
        semanticOutcome,
      );

      const shouldNotifyCompletedTurn = canNotifyExternalCompletedTurn
        && notifySessionId
        && decision
        && shouldSendCompletedTurnNotification(
          stateDir,
          notifySessionId,
          decision.effectiveFingerprint,
        );
      const shouldDispatchSessionIdleHookEvent = canNotifyExternalCompletedTurn
        && notifySessionId
        && shouldSendSessionIdleHookEvent(
          stateDir,
          notifySessionId,
          completedTurnHookFingerprint,
        );
      let completedTurnDeliveryStatus: ProjectTurnDeliveryStatus | null = null;
      let completedTurnNotificationFailed = false;

      if (shouldNotifyCompletedTurn || shouldDispatchSessionIdleHookEvent) {
        if (shouldNotifyCompletedTurn) {
          const completedTurnResult = await notifyCompletedTurn(decision!, {
            sessionId: notifySessionId,
            projectPath: cwd,
            contextSummary: semanticOutcome.summary || undefined,
            question:
              semanticOutcome.kind === 'input-needed'
                ? (semanticOutcome.question || semanticOutcome.summary || 'Input is needed to continue.')
                : undefined,
            assistantText: lastAssistantMessage,
          }, undefined, {
            getNotificationConfigImpl: () => notificationConfig,
          })
            .catch(async (error) => {
              const deliveryFailureKind = isAmbiguousNotificationError(error instanceof Error ? error.message : error)
                ? 'ambiguous_timeout'
                : 'definitive';
              completedTurnNotificationFailed = true;
              if (deliveryFailureKind === 'ambiguous_timeout') {
                completedTurnDeliveryStatus = 'delivery_unknown';
              }
              if (decision?.replyOrigin?.routeId) {
                await markPendingRouteTerminalFailure(cwd, notifySessionId, decision.replyOrigin.routeId, {
                  status: 'failed',
                  reason: error instanceof Error ? error.message : String(error),
                }).catch(() => false);
              }
              await logNotifyHookEvent(logsDir, {
                timestamp: new Date().toISOString(),
                level: 'warn',
                type: 'completed_turn_delivery_failed',
                origin_kind: turnOrigin.kind,
                audience: originResolution.audience,
                delivery: originResolution.delivery,
                reason: originResolution.reason,
                thread_id: safeString(payload['thread-id'] || payload.thread_id || ''),
                turn_id: safeString(payload['turn-id'] || payload.turn_id || ''),
                native_session_id: payloadSessionId || turnOrigin.nativeSessionId || null,
                omx_session_id: notifySessionId || null,
                parent_thread_id: turnOrigin.parentThreadId || null,
                agent_nickname: turnOrigin.agentNickname || null,
                agent_role: turnOrigin.agentRole || null,
                origin_evidence: originResolution.evidence,
                evidence_sources: originResolution.evidence.map((entry) => entry.source),
                notification_event: decision!.effectiveEvent,
                error: error instanceof Error ? error.message : String(error),
                delivery_failure_kind: deliveryFailureKind,
              });
              return null;
            });
          const completedTurnRecord = asRecord(completedTurnResult);
          const nonStandardAnySuccess = completedTurnRecord?.nonStandardAnySuccess === true;
          const notificationResults = summarizeNotificationResultsForLog(
            collectDispatchResultsForLog(completedTurnResult),
          );
          if (completedTurnResult && (completedTurnResult.anySuccess || nonStandardAnySuccess)) {
            recordCompletedTurnNotificationSent(
              stateDir,
              notifySessionId,
              decision!.effectiveFingerprint,
            );
            completedTurnDeliveryStatus = 'sent';
            await logNotifyHookEvent(logsDir, {
              timestamp: new Date().toISOString(),
              type: 'completed_turn_delivery_sent',
              origin_kind: turnOrigin.kind,
              audience: originResolution.audience,
              delivery: originResolution.delivery,
              reason: originResolution.reason,
              thread_id: safeString(payload['thread-id'] || payload.thread_id || ''),
              turn_id: safeString(payload['turn-id'] || payload.turn_id || ''),
              native_session_id: payloadSessionId || turnOrigin.nativeSessionId || null,
              omx_session_id: notifySessionId || null,
              parent_thread_id: turnOrigin.parentThreadId || null,
              agent_nickname: turnOrigin.agentNickname || null,
              agent_role: turnOrigin.agentRole || null,
              origin_evidence: originResolution.evidence,
              evidence_sources: originResolution.evidence.map((entry) => entry.source),
              notification_event: decision!.effectiveEvent,
              any_success: completedTurnResult.anySuccess,
              non_standard_any_success: nonStandardAnySuccess,
              ...(notificationResults.length ? { notification_results: notificationResults } : {}),
            });
          } else if (notificationEventEnabled && !completedTurnNotificationFailed) {
            completedTurnNotificationFailed = true;
            const deliveryFailureKind = notificationResults.some(isAmbiguousNotificationResult)
              ? 'ambiguous_timeout'
              : 'definitive';
            if (deliveryFailureKind === 'ambiguous_timeout') {
              completedTurnDeliveryStatus = 'delivery_unknown';
            }
            if (decision?.replyOrigin?.routeId) {
              await markPendingRouteTerminalFailure(cwd, notifySessionId, decision.replyOrigin.routeId, {
                status: 'failed',
                reason: summarizeNotificationFailureReason(notificationResults),
              }).catch(() => false);
            }
            await logNotifyHookEvent(logsDir, {
              timestamp: new Date().toISOString(),
              level: 'warn',
              type: 'completed_turn_delivery_failed',
              origin_kind: turnOrigin.kind,
              audience: originResolution.audience,
              delivery: originResolution.delivery,
              reason: originResolution.reason,
              thread_id: safeString(payload['thread-id'] || payload.thread_id || ''),
              turn_id: safeString(payload['turn-id'] || payload.turn_id || ''),
              native_session_id: payloadSessionId || turnOrigin.nativeSessionId || null,
              omx_session_id: notifySessionId || null,
              parent_thread_id: turnOrigin.parentThreadId || null,
              agent_nickname: turnOrigin.agentNickname || null,
              agent_role: turnOrigin.agentRole || null,
              origin_evidence: originResolution.evidence,
              evidence_sources: originResolution.evidence.map((entry) => entry.source),
              notification_event: decision!.effectiveEvent,
              any_success: completedTurnResult?.anySuccess ?? false,
              delivery_failure_kind: deliveryFailureKind,
              notification_results: notificationResults,
            });
          }
        }

        if (shouldDispatchSessionIdleHookEvent) {
          try {
            const { buildNativeHookEvent } = await import('../hooks/extensibility/events.js');
            const { dispatchHookEvent } = await import('../hooks/extensibility/dispatcher.js');
            const event = buildNativeHookEvent('session-idle', {
              ...buildOperationalContext({
                cwd,
                normalizedEvent: 'blocked',
                sessionId: notifySessionId,
                status: 'blocked',
                extra: {
                  project_path: cwd,
                  reason: 'post_turn_idle_notification',
                  semantic_phase: decision?.hookMetadata.semanticPhase || semanticOutcome.kind,
                  semantic_summary: decision?.hookMetadata.semanticSummary || semanticOutcome.summary || null,
                  semantic_question: decision?.hookMetadata.semanticQuestion || semanticOutcome.question || null,
                  semantic_notification_event: decision?.hookMetadata.semanticNotificationEvent || null,
                  semantic_classifier_event: decision?.hookMetadata.semanticClassifierEvent || semanticOutcome.notificationEvent || null,
                  reply_origin_platform: decision?.hookMetadata.replyOriginPlatform || null,
                },
              }),
            }, {
              session_id: notifySessionId,
              thread_id: safeString(payload['thread-id'] || payload.thread_id || ''),
              turn_id: safeString(payload['turn-id'] || payload.turn_id || ''),
              mode: safeString(payload.mode || ''),
            });
            const hookDispatchResult = await dispatchHookEvent(event, { cwd });
            if (hookDispatchResult.results.some((result) => result.ok)) {
              recordSessionIdleHookEventSent(
                stateDir,
                notifySessionId,
                completedTurnHookFingerprint,
              );
            }
          } catch {
            // Non-fatal
          }
        }
      }
      if (
        !completedTurnDeliveryStatus
        && completedTurnDedupeForDeliveryStatus
        && !suppressCompletedTurnDelivery
        && !completedTurnNotificationFailed
        && (
          !canNotifyExternalCompletedTurn
          || !decision
          || !notificationEventEnabled
          || !shouldNotifyCompletedTurn
        )
      ) {
        completedTurnDeliveryStatus = 'committed';
      }
      if (completedTurnDeliveryStatus && completedTurnDedupeForDeliveryStatus) {
        await markProjectTurnDeliveryStatus(
          stateDir,
          logsDir,
          completedTurnDedupeForDeliveryStatus,
          completedTurnDeliveryStatus,
        );
      }
    } catch {
      // Non-fatal: notification module may not be built or config may not exist
    }
  }

  // 9. Auto-nudge: detect Codex stall patterns and automatically send a continuation prompt.
  //    Works for both leader and worker contexts.
  if (!deepInterviewStateActive || deepInterviewInputLockActive) {
    try {
      await maybeAutoNudge({ cwd, stateDir, logsDir, payload });
    } catch {
      // Non-critical
    }
  }

  // 10.5. Visual verdict persistence (non-fatal, observable – issue #421)
  if (!isTeamWorker) {
    try {
      const { maybePersistVisualVerdict } = await import('./notify-hook/visual-verdict.js');
      await maybePersistVisualVerdict({
        cwd,
        payload,
        stateDir,
        logsDir,
        sessionId: getEffectiveSessionId(),
        turnId: safeString(payload['turn-id'] || payload.turn_id || ''),
      });
    } catch (err) {
      // Structured warning for module import failure (issue #421)
      const warnEntry = JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'warn',
        type: 'visual_verdict_import_failure',
        error: (err as any)?.message || String(err),
        session_id: getEffectiveSessionId(),
        turn_id: safeString(payload['turn-id'] || payload.turn_id || ''),
      });
      const warnFile = join(logsDir, `notify-hook-${new Date().toISOString().split('T')[0]}.jsonl`);
      await appendFile(warnFile, warnEntry + '\n').catch(() => {});
    }
  }

  // 10. Code simplifier: delegate recently modified files for simplification.
  //     Opt-in via ~/.omx/config.json: { "codeSimplifier": { "enabled": true } }
  if (!isTeamWorker) {
    try {
      const { processCodeSimplifier } = await import('../hooks/code-simplifier/index.js');
      const csResult = processCodeSimplifier(cwd, stateDir);
      if (csResult.triggered) {
        const managedSession = await isManagedOmxSession(cwd, payload, { allowTeamWorker: false });
        if (!managedSession) {
          const { logTmuxHookEvent } = await import('./notify-hook/log.js');
          await logTmuxHookEvent(logsDir, {
            timestamp: new Date().toISOString(),
            type: 'code_simplifier_skipped',
            reason: 'unmanaged_session',
          });
        } else {
          const csPaneId = await resolveNudgePaneTarget(stateDir, cwd, payload);
          if (csPaneId) {
            const csText = `${csResult.message} ${DEFAULT_MARKER}`;
            const sendResult = await sendPaneInput({
              paneTarget: csPaneId,
              prompt: csText,
              submitKeyPresses: 2,
              submitDelayMs: 100,
            });
            if (!sendResult.ok) {
              throw new Error(sendResult.error || sendResult.reason || 'send_failed');
            }

            const { logTmuxHookEvent } = await import('./notify-hook/log.js');
            await logTmuxHookEvent(logsDir, {
              timestamp: new Date().toISOString(),
              type: 'code_simplifier_triggered',
              pane_id: csPaneId,
              file_count: csResult.message.split('\n').filter(l => l.trimStart().startsWith('- ')).length,
            });
          }
        }
      }
    } catch {
      // Non-critical: code-simplifier module may not be built yet
    }
  }
}

main().catch((err) => {
  process.exitCode = 1;
  // eslint-disable-next-line no-console
  console.error('[notify-hook] fatal error:', err);
});
