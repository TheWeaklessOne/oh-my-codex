/**
 * State file I/O helpers for notify-hook modules.
 */

import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { existsSync } from 'fs';
import { readUsableSessionState } from '../../hooks/session.js';
import { asNumber, safeString } from './utils.js';

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_LOCK_TIMEOUT_MS = 1500;
const DEFAULT_LOCK_STALE_MS = 10_000;
const DEFAULT_LOCK_RETRY_MS = 25;

let atomicJsonWriteCounter = 0;

export { readdir };

export class LockedJsonStateWriteError extends Error {
  readonly path: string;
  readonly originalError: unknown;
  readonly result: unknown;

  constructor(path: string, originalError: unknown, result: unknown) {
    const message = originalError instanceof Error
      ? originalError.message
      : String(originalError);
    super(`locked JSON state write failed for ${path}: ${message}`);
    this.name = 'LockedJsonStateWriteError';
    this.path = path;
    this.originalError = originalError;
    this.result = result;
  }
}

export function readJsonIfExists(path: string, fallback: any): Promise<any> {
  return readFile(path, 'utf-8')
    .then(content => JSON.parse(content))
    .catch(() => fallback);
}

function isSafeStateFileName(fileName: string): boolean {
  return fileName.length > 0
    && !fileName.includes('..')
    && !fileName.includes('/')
    && !fileName.includes('\\');
}

function readSessionIdFromEnvironment(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates = [env.OMX_SESSION_ID, env.CODEX_SESSION_ID, env.SESSION_ID];
  for (const candidate of candidates) {
    const sessionId = safeString(candidate).trim();
    if (!SESSION_ID_PATTERN.test(sessionId)) continue;
    return sessionId;
  }
  return undefined;
}

export async function readCurrentSessionId(baseStateDir: string): Promise<string | undefined> {
  const envSessionId = readSessionIdFromEnvironment();
  if (envSessionId) {
    const envScopedDir = join(baseStateDir, 'sessions', envSessionId);
    if (existsSync(envScopedDir)) return envSessionId;
  }

  const cwd = resolve(baseStateDir, '..', '..');
  const session = await readUsableSessionState(cwd);
  const sessionId = safeString(session?.session_id);
  return SESSION_ID_PATTERN.test(sessionId) ? sessionId : undefined;
}

export async function resolveScopedStateDir(
  baseStateDir: string,
  explicitSessionId?: string,
): Promise<string> {
  const currentSessionId = await readCurrentSessionId(baseStateDir);
  if (currentSessionId) {
    return join(baseStateDir, 'sessions', currentSessionId);
  }

  const normalizedExplicit = safeString(explicitSessionId).trim();
  if (SESSION_ID_PATTERN.test(normalizedExplicit)) {
    const explicitDir = join(baseStateDir, 'sessions', normalizedExplicit);
    if (existsSync(explicitDir)) {
      return explicitDir;
    }
  }
  return baseStateDir;
}

export async function getScopedStateDirsForCurrentSession(
  baseStateDir: string,
  explicitSessionId?: string,
  options: { includeRootFallback?: boolean } = {},
): Promise<string[]> {
  const scopedDir = await resolveScopedStateDir(baseStateDir, explicitSessionId);
  if (scopedDir === baseStateDir || options.includeRootFallback !== true) {
    return [scopedDir];
  }
  return [scopedDir, baseStateDir];
}

export async function getScopedStatePath(
  baseStateDir: string,
  fileName: string,
  explicitSessionId?: string,
): Promise<string> {
  if (!isSafeStateFileName(fileName)) {
    throw new Error(`unsafe state file name: ${fileName}`);
  }
  return join(await resolveScopedStateDir(baseStateDir, explicitSessionId), fileName);
}

export async function readScopedJsonIfExists(
  baseStateDir: string,
  fileName: string,
  explicitSessionId: string | undefined,
  fallback: any,
  options: { includeRootFallback?: boolean } = {},
): Promise<any> {
  if (!isSafeStateFileName(fileName)) {
    throw new Error(`unsafe state file name: ${fileName}`);
  }
  const candidateDirs = await getScopedStateDirsForCurrentSession(
    baseStateDir,
    explicitSessionId,
    options,
  );
  for (const dir of candidateDirs) {
    const value = await readJsonIfExists(join(dir, fileName), fallback);
    if (value !== fallback) return value;
  }
  return fallback;
}

export async function writeScopedJson(
  baseStateDir: string,
  fileName: string,
  explicitSessionId: string | undefined,
  value: unknown,
): Promise<void> {
  const targetPath = await getScopedStatePath(baseStateDir, fileName, explicitSessionId);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, JSON.stringify(value, null, 2));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function writeJsonObjectAtomically(path: string, value: unknown): Promise<void> {
  const tempPath = `${path}.${process.pid}.${Date.now()}.${++atomicJsonWriteCounter}.tmp`;
  const content = JSON.stringify(value, null, 2);
  if (typeof content !== 'string') {
    throw new Error(`state value is not JSON-serializable: ${path}`);
  }
  await mkdir(dirname(path), { recursive: true });
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(tempPath, 'w');
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(tempPath, path);
    await syncDirectoryBestEffort(path);
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function syncDirectoryBestEffort(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(dirname(path), 'r');
    await handle.sync();
  } catch {
    // Directory fsync is not supported on every platform/filesystem. The temp
    // file itself is fsynced before rename; directory sync is best-effort to
    // tighten crash durability where the OS supports it.
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
    }
  }
}

async function tryAcquireLockFile(
  lockPath: string,
  token: string,
): Promise<(() => Promise<void>) | null> {
  try {
    await mkdir(dirname(lockPath), { recursive: true });
    const handle = await open(lockPath, 'wx');
    let writeError: unknown = null;
    try {
      await handle.writeFile(token);
    } catch (error) {
      writeError = error;
    } finally {
      await handle.close().catch(() => {});
    }
    if (writeError) {
      await rm(lockPath, { force: true }).catch(() => {});
      throw writeError;
    }
    return async () => {
      const currentToken = await readFile(lockPath, 'utf-8').catch(() => '');
      if (currentToken === token) {
        await rm(lockPath, { force: true }).catch(() => {});
      }
    };
  } catch (error) {
    const code = error && typeof error === 'object'
      ? (error as NodeJS.ErrnoException).code
      : '';
    if (code === 'EEXIST') return null;
    throw error;
  }
}

async function acquireStateFileLock(
  lockPath: string,
  options: {
    timeoutMs?: number;
    staleMs?: number;
    retryMs?: number;
  } = {},
): Promise<() => Promise<void>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const retryMs = options.retryMs ?? DEFAULT_LOCK_RETRY_MS;
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const cleanupLockPath = `${lockPath}.cleanup`;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const cleanupSnapshot = await readLockSnapshot(cleanupLockPath);
    if (cleanupSnapshot && Date.now() - cleanupSnapshot.mtimeMs > staleMs) {
      const currentCleanupSnapshot = await readLockSnapshot(cleanupLockPath);
      if (
        sameLockSnapshot(cleanupSnapshot, currentCleanupSnapshot)
        && currentCleanupSnapshot
        && Date.now() - currentCleanupSnapshot.mtimeMs > staleMs
      ) {
        await rm(cleanupLockPath, { force: true, recursive: true });
      }
      continue;
    }

    if (!existsSync(cleanupLockPath)) {
      const release = await tryAcquireLockFile(lockPath, token);
      if (release) return release;
    }

    if (!existsSync(cleanupLockPath)) {
      const staleCandidate = await readLockSnapshot(lockPath);
      if (staleCandidate && Date.now() - staleCandidate.mtimeMs > staleMs) {
        const cleanupToken = `cleanup:${token}`;
        const releaseCleanup = await tryAcquireLockFile(cleanupLockPath, cleanupToken);
        if (releaseCleanup) {
          let releaseMain: (() => Promise<void>) | null = null;
          try {
            const currentSnapshot = await readLockSnapshot(lockPath);
            if (
              sameLockSnapshot(staleCandidate, currentSnapshot)
              && currentSnapshot
              && Date.now() - currentSnapshot.mtimeMs > staleMs
            ) {
              await rm(lockPath, { force: true, recursive: true });
              releaseMain = await tryAcquireLockFile(lockPath, token);
            }
          } finally {
            await releaseCleanup();
          }
          if (releaseMain) return releaseMain;
        }
        continue;
      }
    }

    if (Date.now() >= deadline) {
      throw new Error(`state file lock timeout: ${lockPath}`);
    }
    await sleep(retryMs);
  }
}

interface LockSnapshot {
  token: string;
  mtimeMs: number;
  ino: number | null;
  dev: number | null;
  size: number;
}

async function readLockSnapshot(lockPath: string): Promise<LockSnapshot | null> {
  const lockStat = await stat(lockPath).catch(() => null);
  if (!lockStat) return null;
  if (!lockStat.isFile()) {
    return {
      token: '',
      mtimeMs: lockStat.mtimeMs,
      ino: Number.isFinite(lockStat.ino) ? lockStat.ino : null,
      dev: Number.isFinite(lockStat.dev) ? lockStat.dev : null,
      size: lockStat.size,
    };
  }
  const token = await readFile(lockPath, 'utf-8').catch(() => '');
  return {
    token,
    mtimeMs: lockStat.mtimeMs,
    ino: Number.isFinite(lockStat.ino) ? lockStat.ino : null,
    dev: Number.isFinite(lockStat.dev) ? lockStat.dev : null,
    size: lockStat.size,
  };
}

function sameLockSnapshot(left: LockSnapshot, right: LockSnapshot | null): boolean {
  return Boolean(
    right
    && left.token === right.token
    && left.mtimeMs === right.mtimeMs
    && left.size === right.size
    && left.ino === right.ino
    && left.dev === right.dev,
  );
}

async function readLockedJsonRaw(path: string): Promise<unknown> {
  try {
    const content = await readFile(path, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    const code = error && typeof error === 'object'
      ? (error as NodeJS.ErrnoException).code
      : '';
    if (code === 'ENOENT') return null;
    throw error;
  }
}

export async function updateLockedJsonState<TResult>(
  path: string,
  update: (raw: unknown) => Promise<{
    result: TResult;
    nextState?: unknown;
    write: boolean;
  }>,
  options: {
    lockPath?: string;
    timeoutMs?: number;
    staleMs?: number;
    retryMs?: number;
  } = {},
): Promise<TResult> {
  const lockPath = options.lockPath ?? `${path}.lock`;
  const release = await acquireStateFileLock(lockPath, options);
  try {
    const raw = await readLockedJsonRaw(path);
    const { result, nextState, write } = await update(raw);
    if (write) {
      try {
        await writeJsonObjectAtomically(path, nextState);
      } catch (error) {
        throw new LockedJsonStateWriteError(path, error, result);
      }
    }
    return result;
  } finally {
    await release();
  }
}

export function normalizeTmuxState(raw: any): any {
  if (!raw || typeof raw !== 'object') {
    return {
      total_injections: 0,
      pane_counts: {},
      session_counts: {},
      recent_keys: {},
      last_injection_ts: 0,
      last_reason: 'init',
      last_event_at: '',
    };
  }
  return {
    total_injections: asNumber(raw.total_injections) ?? 0,
    pane_counts: raw.pane_counts && typeof raw.pane_counts === 'object' ? raw.pane_counts : {},
    session_counts: raw.session_counts && typeof raw.session_counts === 'object' ? raw.session_counts : {},
    recent_keys: raw.recent_keys && typeof raw.recent_keys === 'object' ? raw.recent_keys : {},
    last_injection_ts: asNumber(raw.last_injection_ts) ?? 0,
    last_reason: safeString(raw.last_reason),
    last_event_at: safeString(raw.last_event_at),
  };
}

export function normalizeNotifyState(raw: any): any {
  if (!raw || typeof raw !== 'object') {
    return {
      recent_turns: {},
      last_event_at: '',
    };
  }
  return {
    recent_turns: raw.recent_turns && typeof raw.recent_turns === 'object' ? raw.recent_turns : {},
    last_event_at: safeString(raw.last_event_at),
  };
}

export function pruneRecentTurns(recentTurns: any, now: number): Record<string, number> {
  const pruned: Record<string, number> = {};
  const minTs = now - (24 * 60 * 60 * 1000);
  const entries = Object.entries(recentTurns || {}).slice(-2000);
  for (const [key, value] of entries) {
    const ts = asNumber(value);
    if (ts !== null && ts >= minTs) pruned[key] = ts;
  }
  return pruned;
}

export function pruneRecentKeys(recentKeys: any, now: number): Record<string, number> {
  const pruned: Record<string, number> = {};
  const minTs = now - (24 * 60 * 60 * 1000);
  const entries = Object.entries(recentKeys || {}).slice(-1000);
  for (const [key, value] of entries) {
    const ts = asNumber(value);
    if (ts !== null && ts >= minTs) pruned[key] = ts;
  }
  return pruned;
}
