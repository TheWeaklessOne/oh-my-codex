import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { NotificationEvent, FullNotificationPayload } from './types.js';
import { updateLockedJsonState } from '../scripts/notify-hook/state-io.js';

const SESSION_ID_SAFE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/;
const LIFECYCLE_DEDUPE_FILE = 'lifecycle-notif-state.json';
const LIFECYCLE_DEDUPE_WINDOW_MS = 5_000;
const LIFECYCLE_PENDING_DEDUPE_WINDOW_MS = 10 * 60_000;
const DEDUPED_EVENTS = new Set<NotificationEvent>(['session-start', 'session-stop', 'session-end']);

interface LifecycleDedupeEntry {
  fingerprint?: string;
  sentAt?: string;
  status?: 'pending' | 'sent';
}

interface LifecycleDedupeState {
  events?: Record<string, LifecycleDedupeEntry>;
  hookEvents?: Record<string, LifecycleDedupeEntry>;
}

type LifecycleDedupeBucket = 'events' | 'hookEvents';

function normalizeFingerprint(payload: FullNotificationPayload): string {
  return JSON.stringify({
    event: payload.event,
    reason: payload.reason || '',
    activeMode: payload.activeMode || '',
    question: payload.question || '',
    incompleteTasks: payload.incompleteTasks || 0,
  });
}

function getStatePath(stateDir: string, sessionId: string): string {
  if (SESSION_ID_SAFE_PATTERN.test(sessionId)) {
    return join(stateDir, 'sessions', sessionId, LIFECYCLE_DEDUPE_FILE);
  }
  return join(stateDir, LIFECYCLE_DEDUPE_FILE);
}

function readState(path: string): LifecycleDedupeState {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as LifecycleDedupeState;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeState(raw: unknown): LifecycleDedupeState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const state = raw as LifecycleDedupeState;
  return {
    events: state.events && typeof state.events === 'object' ? state.events : undefined,
    hookEvents: state.hookEvents && typeof state.hookEvents === 'object' ? state.hookEvents : undefined,
  };
}

function writeState(path: string, state: LifecycleDedupeState): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state, null, 2));
  } catch {
    // best effort
  }
}

export function shouldDedupeLifecycleNotification(event: NotificationEvent): boolean {
  return DEDUPED_EVENTS.has(event);
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, nestedValue]) => nestedValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nestedValue]) => `${JSON.stringify(key)}:${stableSerialize(nestedValue)}`);
  return `{${entries.join(',')}}`;
}

function shouldSendFingerprint(
  previous: LifecycleDedupeEntry | undefined,
  fingerprint: string,
  nowMs: number,
): boolean {
  if (!previous || previous.fingerprint !== fingerprint) return true;
  if (!previous.sentAt) return false;

  const previousMs = Date.parse(previous.sentAt);
  if (!Number.isFinite(previousMs)) return false;
  const windowMs = previous.status === 'pending'
    ? LIFECYCLE_PENDING_DEDUPE_WINDOW_MS
    : LIFECYCLE_DEDUPE_WINDOW_MS;
  return nowMs - previousMs >= windowMs;
}

function shouldSendScopedLifecycleBroadcast(
  stateDir: string,
  sessionId: string | undefined,
  bucket: LifecycleDedupeBucket,
  eventKey: string,
  fingerprint: string,
  nowMs: number = Date.now(),
): boolean {
  if (!sessionId || !stateDir) return true;

  const path = getStatePath(stateDir, sessionId);
  const state = readState(path);
  const bucketState = state[bucket] && typeof state[bucket] === 'object'
    ? state[bucket]
    : {};
  return shouldSendFingerprint(bucketState?.[eventKey], fingerprint, nowMs);
}

function recordScopedLifecycleBroadcastSent(
  stateDir: string,
  sessionId: string | undefined,
  bucket: LifecycleDedupeBucket,
  eventKey: string,
  fingerprint: string,
  nowMs: number = Date.now(),
): void {
  if (!sessionId || !stateDir) return;

  const path = getStatePath(stateDir, sessionId);
  const state = readState(path);
  const bucketState = state[bucket] && typeof state[bucket] === 'object'
    ? state[bucket]
    : {};
  bucketState[eventKey] = {
    fingerprint,
    sentAt: new Date(nowMs).toISOString(),
    status: 'sent',
  };
  state[bucket] = bucketState;
  writeState(path, state);
}

async function updateScopedLifecycleBroadcast<TResult>(
  stateDir: string,
  sessionId: string | undefined,
  bucket: LifecycleDedupeBucket,
  eventKey: string,
  updateBucket: (bucketState: Record<string, LifecycleDedupeEntry>) => { result: TResult; write: boolean },
): Promise<TResult> {
  if (!sessionId || !stateDir) {
    return updateBucket({}).result;
  }

  const path = getStatePath(stateDir, sessionId);
  return updateLockedJsonState<TResult>(path, async (raw) => {
    const state = normalizeState(raw);
    const bucketState = state[bucket] && typeof state[bucket] === 'object'
      ? { ...state[bucket] }
      : {};
    const { result, write } = updateBucket(bucketState);
    if (!write) {
      return { result, write: false };
    }
    state[bucket] = bucketState;
    return {
      result,
      nextState: state,
      write: true,
    };
  });
}

async function claimScopedLifecycleBroadcastPendingToken(
  stateDir: string,
  sessionId: string | undefined,
  bucket: LifecycleDedupeBucket,
  eventKey: string,
  fingerprint: string,
  nowMs: number = Date.now(),
): Promise<string | null> {
  const pendingAt = new Date(nowMs).toISOString();
  return updateScopedLifecycleBroadcast(
    stateDir,
    sessionId,
    bucket,
    eventKey,
    (bucketState) => {
      if (!shouldSendFingerprint(bucketState[eventKey], fingerprint, nowMs)) {
        return { result: null, write: false };
      }
      bucketState[eventKey] = {
        fingerprint,
        sentAt: pendingAt,
        status: 'pending',
      };
      return { result: pendingAt, write: true };
    },
  );
}

async function recordScopedLifecycleBroadcastSentLocked(
  stateDir: string,
  sessionId: string | undefined,
  bucket: LifecycleDedupeBucket,
  eventKey: string,
  fingerprint: string,
  nowMs: number = Date.now(),
  expectedPendingAt?: string,
): Promise<void> {
  await updateScopedLifecycleBroadcast(
    stateDir,
    sessionId,
    bucket,
    eventKey,
    (bucketState) => {
      const previous = bucketState[eventKey];
      if (expectedPendingAt !== undefined) {
        if (
          previous?.fingerprint !== fingerprint
          || previous.status !== 'pending'
          || previous.sentAt !== expectedPendingAt
        ) {
          return { result: undefined, write: false };
        }
      }
      if (previous?.fingerprint && previous.fingerprint !== fingerprint) {
        return { result: undefined, write: false };
      }
      bucketState[eventKey] = {
        fingerprint,
        sentAt: new Date(nowMs).toISOString(),
        status: 'sent',
      };
      return { result: undefined, write: true };
    },
  );
}

async function clearScopedLifecycleBroadcastPending(
  stateDir: string,
  sessionId: string | undefined,
  bucket: LifecycleDedupeBucket,
  eventKey: string,
  fingerprint: string,
  expectedPendingAt?: string,
): Promise<void> {
  await updateScopedLifecycleBroadcast(
    stateDir,
    sessionId,
    bucket,
    eventKey,
    (bucketState) => {
      const previous = bucketState[eventKey];
      if (
        previous?.fingerprint !== fingerprint
        || previous.status !== 'pending'
        || (expectedPendingAt !== undefined && previous.sentAt !== expectedPendingAt)
      ) {
        return { result: undefined, write: false };
      }
      delete bucketState[eventKey];
      return { result: undefined, write: true };
    },
  );
}

export function createLifecycleBroadcastFingerprint(value: unknown): string {
  return stableSerialize(value);
}

export function shouldSendLifecycleNotification(
  stateDir: string,
  payload: FullNotificationPayload,
  nowMs: number = Date.now(),
): boolean {
  if (!shouldDedupeLifecycleNotification(payload.event)) return true;
  return shouldSendScopedLifecycleBroadcast(
    stateDir,
    payload.sessionId,
    'events',
    payload.event,
    normalizeFingerprint(payload),
    nowMs,
  );
}

export function claimLifecycleNotificationPending(
  stateDir: string,
  payload: FullNotificationPayload,
  nowMs: number = Date.now(),
): Promise<boolean> {
  return claimLifecycleNotificationPendingToken(stateDir, payload, nowMs)
    .then((token) => token !== null);
}

export function claimLifecycleNotificationPendingToken(
  stateDir: string,
  payload: FullNotificationPayload,
  nowMs: number = Date.now(),
): Promise<string | null> {
  if (!shouldDedupeLifecycleNotification(payload.event)) return Promise.resolve('');
  return claimScopedLifecycleBroadcastPendingToken(
    stateDir,
    payload.sessionId,
    'events',
    payload.event,
    normalizeFingerprint(payload),
    nowMs,
  );
}

export function recordLifecycleNotificationSent(
  stateDir: string,
  payload: FullNotificationPayload,
  nowMs: number = Date.now(),
): void {
  if (!shouldDedupeLifecycleNotification(payload.event)) return;
  recordScopedLifecycleBroadcastSent(
    stateDir,
    payload.sessionId,
    'events',
    payload.event,
    normalizeFingerprint(payload),
    nowMs,
  );
}

export function recordLifecycleNotificationSentLocked(
  stateDir: string,
  payload: FullNotificationPayload,
  nowMs: number = Date.now(),
  expectedPendingAt?: string,
): Promise<void> {
  if (!shouldDedupeLifecycleNotification(payload.event)) return Promise.resolve();
  return recordScopedLifecycleBroadcastSentLocked(
    stateDir,
    payload.sessionId,
    'events',
    payload.event,
    normalizeFingerprint(payload),
    nowMs,
    expectedPendingAt,
  );
}

export function clearLifecycleNotificationPending(
  stateDir: string,
  payload: FullNotificationPayload,
  expectedPendingAt?: string,
): Promise<void> {
  if (!shouldDedupeLifecycleNotification(payload.event)) return Promise.resolve();
  return clearScopedLifecycleBroadcastPending(
    stateDir,
    payload.sessionId,
    'events',
    payload.event,
    normalizeFingerprint(payload),
    expectedPendingAt,
  );
}

export function shouldSendLifecycleHookBroadcast(
  stateDir: string,
  sessionId: string | undefined,
  eventKey: string,
  fingerprint: string,
  nowMs: number = Date.now(),
): boolean {
  return shouldSendScopedLifecycleBroadcast(
    stateDir,
    sessionId,
    'hookEvents',
    eventKey,
    fingerprint,
    nowMs,
  );
}

export function recordLifecycleHookBroadcastSent(
  stateDir: string,
  sessionId: string | undefined,
  eventKey: string,
  fingerprint: string,
  nowMs: number = Date.now(),
): void {
  recordScopedLifecycleBroadcastSent(
    stateDir,
    sessionId,
    'hookEvents',
    eventKey,
    fingerprint,
    nowMs,
  );
}
