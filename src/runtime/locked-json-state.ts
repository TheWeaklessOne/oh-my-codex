import { existsSync } from "fs";
import { mkdir, open, readFile, rename, rm, stat } from "fs/promises";
import { dirname } from "path";

const DEFAULT_LOCK_TIMEOUT_MS = 1500;
const DEFAULT_LOCK_STALE_MS = 10_000;
const DEFAULT_LOCK_RETRY_MS = 25;

let atomicJsonWriteCounter = 0;

export class LockedJsonStateWriteError extends Error {
  readonly path: string;
  readonly originalError: unknown;
  readonly result: unknown;

  constructor(path: string, originalError: unknown, result: unknown) {
    const message = originalError instanceof Error
      ? originalError.message
      : String(originalError);
    super(`locked JSON state write failed for ${path}: ${message}`);
    this.name = "LockedJsonStateWriteError";
    this.path = path;
    this.originalError = originalError;
    this.result = result;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function syncDirectoryBestEffort(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(dirname(path), "r");
    await handle.sync();
  } catch {
    // Directory fsync is not available on every platform/filesystem. The temp
    // file is fsynced before rename; this only tightens durability where it can.
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
    }
  }
}

export async function writeJsonObjectAtomically(path: string, value: unknown): Promise<void> {
  const tempPath = `${path}.${process.pid}.${Date.now()}.${++atomicJsonWriteCounter}.tmp`;
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await mkdir(dirname(path), { recursive: true });
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(tempPath, "w");
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

async function tryAcquireLockFile(
  lockPath: string,
  token: string,
): Promise<(() => Promise<void>) | null> {
  try {
    await mkdir(dirname(lockPath), { recursive: true });
    const handle = await open(lockPath, "wx");
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
      const currentToken = await readFile(lockPath, "utf-8").catch(() => "");
      if (currentToken === token) {
        await rm(lockPath, { force: true }).catch(() => {});
      }
    };
  } catch (error) {
    const code = error && typeof error === "object"
      ? (error as NodeJS.ErrnoException).code
      : "";
    if (code === "EEXIST") return null;
    throw error;
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
      token: "",
      mtimeMs: lockStat.mtimeMs,
      ino: Number.isFinite(lockStat.ino) ? lockStat.ino : null,
      dev: Number.isFinite(lockStat.dev) ? lockStat.dev : null,
      size: lockStat.size,
    };
  }
  const token = await readFile(lockPath, "utf-8").catch(() => "");
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

async function acquireJsonStateLock(
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

async function readLockedJsonRaw(path: string): Promise<unknown> {
  try {
    const content = await readFile(path, "utf-8");
    return JSON.parse(content);
  } catch (error) {
    const code = error && typeof error === "object"
      ? (error as NodeJS.ErrnoException).code
      : "";
    if (code === "ENOENT") return null;
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
  const release = await acquireJsonStateLock(options.lockPath ?? `${path}.lock`, options);
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
