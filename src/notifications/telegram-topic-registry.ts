import { randomUUID, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';

const STATE_DIR = join(homedir(), '.omx', 'state');
const REGISTRY_PATH = join(STATE_DIR, 'telegram-topic-registry.json');
const REGISTRY_LOCK_DIR = join(STATE_DIR, 'telegram-topic-registry.lock');
const PROJECT_LOCKS_DIR = join(STATE_DIR, 'telegram-topic-registry-project-locks');
const SECURE_FILE_MODE = 0o600;
const SECURE_DIR_MODE = 0o700;
const REGISTRY_SCHEMA_VERSION = 1;
const REGISTRY_LOCK_TIMEOUT_MS = 5_000;
const REGISTRY_LOCK_STALE_MS = 10_000;
const PROJECT_LOCK_TIMEOUT_MS = 15_000;
const PROJECT_LOCK_STALE_MS = 60_000;
const INITIAL_LOCK_POLL_MS = 25;
const MAX_LOCK_POLL_MS = 250;

export interface TelegramTopicRegistryRecord {
  sourceChatKey: string;
  projectKey: string;
  canonicalProjectPath: string;
  displayName: string;
  topicName?: string;
  messageThreadId?: string;
  createdAt?: string;
  lastUsedAt?: string;
  lastCreateAttemptAt?: string;
  lastCreateFailureAt?: string;
  lastCreateFailureCode?: string;
  lastCreateFailureMessage?: string;
  createFailureCooldownUntil?: string;
}

interface TelegramTopicRegistryStore {
  version: number;
  records: TelegramTopicRegistryRecord[];
}

interface LockHandle {
  lockDir: string;
  ownerPath: string;
  ownerToken: string;
}

function emptyStore(): TelegramTopicRegistryStore {
  return {
    version: REGISTRY_SCHEMA_VERSION,
    records: [],
  };
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  return undefined;
}

function normalizeRecord(value: unknown): TelegramTopicRegistryRecord | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  const sourceChatKey = normalizeString(record.sourceChatKey);
  const projectKey = normalizeString(record.projectKey);
  const canonicalProjectPath = normalizeString(record.canonicalProjectPath);
  const displayName =
    normalizeString(record.displayName)
    ?? (canonicalProjectPath ? basename(canonicalProjectPath) : undefined);

  if (!sourceChatKey || !projectKey || !canonicalProjectPath || !displayName) {
    return null;
  }

  return {
    sourceChatKey,
    projectKey,
    canonicalProjectPath,
    displayName,
    topicName: normalizeString(record.topicName),
    messageThreadId: normalizeString(record.messageThreadId),
    createdAt: normalizeString(record.createdAt),
    lastUsedAt: normalizeString(record.lastUsedAt),
    lastCreateAttemptAt: normalizeString(record.lastCreateAttemptAt),
    lastCreateFailureAt: normalizeString(record.lastCreateFailureAt),
    lastCreateFailureCode: normalizeString(record.lastCreateFailureCode),
    lastCreateFailureMessage: normalizeString(record.lastCreateFailureMessage),
    createFailureCooldownUntil: normalizeString(record.createFailureCooldownUntil),
  };
}

function normalizeMessageThreadIdForLookup(messageThreadId: unknown): string | null {
  const normalized = normalizeString(messageThreadId);
  if (!normalized) {
    return null;
  }

  if (/^\d+$/.test(normalized)) {
    const parsed = Number(normalized);
    if (Number.isSafeInteger(parsed)) {
      return String(parsed);
    }
  }

  return normalized;
}

function normalizeStore(value: unknown): TelegramTopicRegistryStore | null {
  if (Array.isArray(value)) {
    return {
      version: REGISTRY_SCHEMA_VERSION,
      records: value.map(normalizeRecord).filter((record): record is TelegramTopicRegistryRecord => record !== null),
    };
  }

  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const recordsValue = Array.isArray(candidate.records)
    ? candidate.records
    : Array.isArray(candidate.mappings)
      ? candidate.mappings
      : null;

  if (!recordsValue) {
    return null;
  }

  const version = typeof candidate.version === 'number' && Number.isFinite(candidate.version)
    ? candidate.version
    : REGISTRY_SCHEMA_VERSION;

  return {
    version,
    records: recordsValue
      .map(normalizeRecord)
      .filter((record): record is TelegramTopicRegistryRecord => record !== null),
  };
}

async function ensureStateDir(): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true, mode: SECURE_DIR_MODE });
  await chmod(STATE_DIR, SECURE_DIR_MODE).catch(() => {});
  await mkdir(PROJECT_LOCKS_DIR, { recursive: true, mode: SECURE_DIR_MODE });
  await chmod(PROJECT_LOCKS_DIR, SECURE_DIR_MODE).catch(() => {});
}

async function writeSecureFileAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: SECURE_DIR_MODE });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, content, { encoding: 'utf-8', mode: SECURE_FILE_MODE });
  await chmod(tmpPath, SECURE_FILE_MODE).catch(() => {});
  try {
    await rename(tmpPath, path);
    await chmod(path, SECURE_FILE_MODE).catch(() => {});
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}

function buildOwnerPayload(ownerToken: string): string {
  return JSON.stringify({
    pid: process.pid,
    ownerToken,
    acquiredAt: new Date().toISOString(),
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireLock(
  lockDir: string,
  options: { timeoutMs: number; staleMs: number },
): Promise<LockHandle> {
  await mkdir(dirname(lockDir), { recursive: true, mode: SECURE_DIR_MODE });

  const ownerPath = join(lockDir, 'owner.json');
  const ownerToken = `${process.pid}.${Date.now()}.${randomUUID()}`;
  const deadline = Date.now() + options.timeoutMs;
  let pollMs = INITIAL_LOCK_POLL_MS;

  while (true) {
    try {
      await mkdir(lockDir, { recursive: false, mode: SECURE_DIR_MODE });
      await chmod(lockDir, SECURE_DIR_MODE).catch(() => {});
      await writeSecureFileAtomic(ownerPath, buildOwnerPayload(ownerToken));
      return { lockDir, ownerPath, ownerToken };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') {
        throw error;
      }

      try {
        const info = await stat(lockDir);
        if (Date.now() - info.mtimeMs > options.staleMs) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Best effort: lock may have been released between checks.
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring lock: ${lockDir}`);
      }

      const jitter = 0.5 + Math.random() * 0.5;
      await sleep(Math.floor(pollMs * jitter));
      pollMs = Math.min(pollMs * 2, MAX_LOCK_POLL_MS);
    }
  }
}

async function releaseLock(handle: LockHandle): Promise<void> {
  try {
    const currentOwnerRaw = await readFile(handle.ownerPath, 'utf-8');
    const currentOwner = JSON.parse(currentOwnerRaw) as { ownerToken?: unknown };
    if (currentOwner.ownerToken !== handle.ownerToken) {
      return;
    }
  } catch {
    return;
  }

  await rm(handle.lockDir, { recursive: true, force: true }).catch(() => {});
}

async function withLock<T>(
  lockDir: string,
  options: { timeoutMs: number; staleMs: number },
  fn: () => Promise<T>,
): Promise<T> {
  const handle = await acquireLock(lockDir, options);
  try {
    return await fn();
  } finally {
    await releaseLock(handle);
  }
}

async function backupCorruptRegistryFile(): Promise<void> {
  if (!existsSync(REGISTRY_PATH)) {
    return;
  }

  const backupPath = `${REGISTRY_PATH}.corrupt.${Date.now()}.${process.pid}.bak`;
  await rename(REGISTRY_PATH, backupPath).catch(() => {});
}

async function readRegistryUnsafe(): Promise<TelegramTopicRegistryStore> {
  if (!existsSync(REGISTRY_PATH)) {
    return emptyStore();
  }

  try {
    const raw = await readFile(REGISTRY_PATH, 'utf-8');
    if (raw.trim() === '') {
      return emptyStore();
    }

    const parsed = JSON.parse(raw) as unknown;
    const normalized = normalizeStore(parsed);
    if (normalized) {
      return normalized;
    }
  } catch {
    // Fall through to tolerant recovery below.
  }

  await backupCorruptRegistryFile();
  return emptyStore();
}

async function writeRegistryUnsafe(store: TelegramTopicRegistryStore): Promise<void> {
  const normalized: TelegramTopicRegistryStore = {
    version: REGISTRY_SCHEMA_VERSION,
    records: [...store.records].sort((left, right) => {
      const leftKey = buildTelegramTopicRegistryKey(left.sourceChatKey, left.projectKey);
      const rightKey = buildTelegramTopicRegistryKey(right.sourceChatKey, right.projectKey);
      return leftKey.localeCompare(rightKey);
    }),
  };

  await writeSecureFileAtomic(REGISTRY_PATH, `${JSON.stringify(normalized, null, 2)}\n`);
}

async function withRegistryLock<T>(fn: () => Promise<T>): Promise<T> {
  await ensureStateDir();
  return withLock(
    REGISTRY_LOCK_DIR,
    {
      timeoutMs: REGISTRY_LOCK_TIMEOUT_MS,
      staleMs: REGISTRY_LOCK_STALE_MS,
    },
    fn,
  );
}

function findRecordIndex(
  store: TelegramTopicRegistryStore,
  sourceChatKey: string,
  projectKey: string,
): number {
  return store.records.findIndex(
    (record) => record.sourceChatKey === sourceChatKey && record.projectKey === projectKey,
  );
}

export function buildTelegramTopicRegistryKey(
  sourceChatKey: string,
  projectKey: string,
): string {
  return `${sourceChatKey}::${projectKey}`;
}

function normalizeUpdatedRecord(record: TelegramTopicRegistryRecord): TelegramTopicRegistryRecord {
  const normalized = normalizeRecord(record);
  if (!normalized) {
    throw new Error('Invalid Telegram topic registry record');
  }
  return normalized;
}

export async function getTelegramTopicRegistryRecord(
  sourceChatKey: string,
  projectKey: string,
): Promise<TelegramTopicRegistryRecord | null> {
  return await withRegistryLock(async () => {
    const store = await readRegistryUnsafe();
    const index = findRecordIndex(store, sourceChatKey, projectKey);
    return index >= 0 ? store.records[index] : null;
  });
}

export async function listTelegramTopicRegistryRecords(
  sourceChatKey: string,
): Promise<TelegramTopicRegistryRecord[]> {
  return await withRegistryLock(async () => {
    const store = await readRegistryUnsafe();
    return store.records.filter((record) => record.sourceChatKey === sourceChatKey);
  });
}

export async function findTelegramTopicRegistryRecordByThreadId(
  sourceChatKey: string,
  messageThreadId: string | number | undefined,
): Promise<TelegramTopicRegistryRecord | null> {
  const normalizedThreadId = normalizeMessageThreadIdForLookup(messageThreadId);
  if (!normalizedThreadId) {
    return null;
  }

  return await withRegistryLock(async () => {
    const store = await readRegistryUnsafe();
    return store.records.find((record) => (
      record.sourceChatKey === sourceChatKey
      && normalizeMessageThreadIdForLookup(record.messageThreadId) === normalizedThreadId
    )) ?? null;
  });
}

export async function updateTelegramTopicRegistryRecord(
  sourceChatKey: string,
  projectKey: string,
  updater: (current: TelegramTopicRegistryRecord | null) => TelegramTopicRegistryRecord | null,
): Promise<TelegramTopicRegistryRecord | null> {
  return await withRegistryLock(async () => {
    const store = await readRegistryUnsafe();
    const index = findRecordIndex(store, sourceChatKey, projectKey);
    const current = index >= 0 ? store.records[index] : null;
    const next = updater(current ? { ...current } : null);

    if (next === null) {
      if (index >= 0) {
        store.records.splice(index, 1);
        await writeRegistryUnsafe(store);
      }
      return null;
    }

    const normalized = normalizeUpdatedRecord(next);
    if (index >= 0) {
      store.records[index] = normalized;
    } else {
      store.records.push(normalized);
    }

    await writeRegistryUnsafe(store);
    return normalized;
  });
}

export async function upsertTelegramTopicRegistryRecord(
  record: TelegramTopicRegistryRecord,
): Promise<TelegramTopicRegistryRecord> {
  const updated = await updateTelegramTopicRegistryRecord(
    record.sourceChatKey,
    record.projectKey,
    (current) => ({
      ...current,
      ...record,
    }),
  );

  if (!updated) {
    throw new Error('Failed to upsert Telegram topic registry record');
  }

  return updated;
}

export async function touchTelegramTopicRegistryRecord(
  sourceChatKey: string,
  projectKey: string,
  fields: {
    canonicalProjectPath?: string;
    displayName?: string;
    lastUsedAt?: string;
  },
): Promise<TelegramTopicRegistryRecord | null> {
  return await updateTelegramTopicRegistryRecord(sourceChatKey, projectKey, (current) => {
    if (!current) {
      return null;
    }

    return {
      ...current,
      ...(fields.canonicalProjectPath ? { canonicalProjectPath: fields.canonicalProjectPath } : {}),
      ...(fields.displayName ? { displayName: fields.displayName } : {}),
      ...(fields.lastUsedAt ? { lastUsedAt: fields.lastUsedAt } : {}),
    };
  });
}

export async function withTelegramTopicProjectLock<T>(
  sourceChatKey: string,
  projectKey: string,
  fn: () => Promise<T>,
): Promise<T> {
  await ensureStateDir();
  const lockName = createHash('sha256')
    .update(buildTelegramTopicRegistryKey(sourceChatKey, projectKey))
    .digest('hex');
  return await withLock(
    join(PROJECT_LOCKS_DIR, lockName),
    {
      timeoutMs: PROJECT_LOCK_TIMEOUT_MS,
      staleMs: PROJECT_LOCK_STALE_MS,
    },
    fn,
  );
}

export function getTelegramTopicRegistryPath(): string {
  return REGISTRY_PATH;
}
