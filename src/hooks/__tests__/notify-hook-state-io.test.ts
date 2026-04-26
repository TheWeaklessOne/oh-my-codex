import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'fs';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  LockedJsonStateWriteError,
  updateLockedJsonState,
  writeJsonObjectAtomically,
} from '../../scripts/notify-hook/state-io.js';

describe('notify-hook/state-io locked JSON state', () => {
  it('recovers a stale lock and writes JSON state atomically', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-io-stale-lock-'));
    try {
      const statePath = join(wd, 'state.json');
      const lockPath = join(wd, 'state.lock');
      await writeFile(lockPath, 'stale-lock');
      const oldDate = new Date(Date.now() - 60_000);
      await utimes(lockPath, oldDate, oldDate);

      const result = await updateLockedJsonState(
        statePath,
        async (raw) => ({
          result: raw === null ? 'created' : 'updated',
          nextState: { ok: true },
          write: true,
        }),
        { lockPath, staleMs: 1, timeoutMs: 1000, retryMs: 5 },
      );

      assert.equal(result, 'created');
      assert.deepEqual(JSON.parse(await readFile(statePath, 'utf-8')), { ok: true });
      assert.equal(existsSync(lockPath), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('recovers a stale cleanup lock when no active lock exists', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-io-stale-cleanup-lock-'));
    try {
      const statePath = join(wd, 'state.json');
      const lockPath = join(wd, 'state.lock');
      const cleanupLockPath = `${lockPath}.cleanup`;
      await writeFile(cleanupLockPath, 'stale-cleanup-lock');
      const oldDate = new Date(Date.now() - 60_000);
      await utimes(cleanupLockPath, oldDate, oldDate);

      const result = await updateLockedJsonState(
        statePath,
        async () => ({
          result: 'created',
          nextState: { ok: true },
          write: true,
        }),
        { lockPath, staleMs: 1, timeoutMs: 1000, retryMs: 5 },
      );

      assert.equal(result, 'created');
      assert.deepEqual(JSON.parse(await readFile(statePath, 'utf-8')), { ok: true });
      assert.equal(existsSync(cleanupLockPath), false);
      assert.equal(existsSync(lockPath), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('times out behind a fresh cleanup lock without writing state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-io-fresh-cleanup-lock-'));
    try {
      const statePath = join(wd, 'state.json');
      const lockPath = join(wd, 'state.lock');
      const cleanupLockPath = `${lockPath}.cleanup`;
      await writeFile(cleanupLockPath, 'fresh-cleanup-lock');

      await assert.rejects(
        updateLockedJsonState(
          statePath,
          async () => ({
            result: 'created',
            nextState: { ok: true },
            write: true,
          }),
          { lockPath, staleMs: 60_000, timeoutMs: 30, retryMs: 5 },
        ),
        /state file lock timeout/,
      );
      assert.equal(existsSync(statePath), false);
      assert.equal(await readFile(cleanupLockPath, 'utf-8'), 'fresh-cleanup-lock');
      assert.equal(existsSync(lockPath), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('recovers a stale non-regular lock without reading its contents', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-io-stale-directory-lock-'));
    try {
      const statePath = join(wd, 'state.json');
      const lockPath = join(wd, 'state.lock');
      await mkdir(lockPath);
      const oldDate = new Date(Date.now() - 60_000);
      await utimes(lockPath, oldDate, oldDate);

      const result = await updateLockedJsonState(
        statePath,
        async () => ({
          result: 'created',
          nextState: { ok: true },
          write: true,
        }),
        { lockPath, staleMs: 1, timeoutMs: 1000, retryMs: 5 },
      );

      assert.equal(result, 'created');
      assert.deepEqual(JSON.parse(await readFile(statePath, 'utf-8')), { ok: true });
      assert.equal(existsSync(lockPath), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('times out on a fresh lock without deleting it', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-io-fresh-lock-'));
    try {
      const statePath = join(wd, 'state.json');
      const lockPath = join(wd, 'state.lock');
      await writeFile(lockPath, 'fresh-lock');

      await assert.rejects(
        updateLockedJsonState(
          statePath,
          async () => ({ result: 'blocked', nextState: { ok: true }, write: true }),
          { lockPath, staleMs: 60_000, timeoutMs: 30, retryMs: 5 },
        ),
        /state file lock timeout/,
      );
      assert.equal(await readFile(lockPath, 'utf-8'), 'fresh-lock');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('releases the lock when the updater throws', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-io-updater-throw-'));
    try {
      const statePath = join(wd, 'state.json');
      const lockPath = join(wd, 'state.lock');

      await assert.rejects(
        updateLockedJsonState(
          statePath,
          async () => {
            throw new Error('updater failed');
          },
          { lockPath },
        ),
        /updater failed/,
      );
      assert.equal(existsSync(lockPath), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not remove a replacement lock during release', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-io-replaced-lock-'));
    try {
      const statePath = join(wd, 'state.json');
      const lockPath = join(wd, 'state.lock');

      const result = await updateLockedJsonState(
        statePath,
        async () => {
          await writeFile(lockPath, 'replacement-lock');
          return { result: 'ok', nextState: { ok: true }, write: true };
        },
        { lockPath },
      );

      assert.equal(result, 'ok');
      assert.deepEqual(JSON.parse(await readFile(statePath, 'utf-8')), { ok: true });
      assert.equal(await readFile(lockPath, 'utf-8'), 'replacement-lock');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('surfaces malformed JSON instead of overwriting it as empty state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-io-malformed-'));
    try {
      const statePath = join(wd, 'state.json');
      const lockPath = join(wd, 'state.lock');
      await writeFile(statePath, '{not-json');

      await assert.rejects(
        updateLockedJsonState(
          statePath,
          async () => ({ result: 'rewritten', nextState: { ok: true }, write: true }),
          { lockPath },
        ),
        SyntaxError,
      );
      assert.equal(await readFile(statePath, 'utf-8'), '{not-json');
      assert.equal(existsSync(lockPath), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('carries the computed result when the atomic write fails', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-io-write-fail-'));
    try {
      const statePath = join(wd, 'state.json');
      const lockPath = join(wd, 'state.lock');

      await assert.rejects(
        updateLockedJsonState(
          statePath,
          async () => {
            await mkdir(statePath);
            return {
              result: { suppressExternalDelivery: true },
              nextState: { ok: true },
              write: true,
            };
          },
          { lockPath },
        ),
        (error) =>
          error instanceof LockedJsonStateWriteError
          && (error.result as { suppressExternalDelivery?: boolean }).suppressExternalDelivery === true,
      );
      assert.equal(existsSync(lockPath), false);
      const leftovers = (await readdir(wd)).filter((name) => name.startsWith('state.json.'));
      assert.deepEqual(leftovers, []);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('removes temp files when an atomic rename fails', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-io-rename-fail-'));
    try {
      const targetDir = join(wd, 'target-state');
      await mkdir(targetDir);

      await assert.rejects(
        writeJsonObjectAtomically(targetDir, { ok: true }),
      );

      const leftovers = (await readdir(wd)).filter((name) => name.startsWith('target-state.'));
      assert.deepEqual(leftovers, []);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
