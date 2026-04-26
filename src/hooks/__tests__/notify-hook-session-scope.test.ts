import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { VISUAL_NEXT_ACTIONS_LIMIT } from '../../visual/constants.js';
import { sanitizeLiveNotificationEnv } from '../../utils/test-env.js';

function ensureDisabledNotificationConfig(codexHome: string): void {
  mkdirSync(codexHome, { recursive: true });
  const configPath = join(codexHome, '.omx-config.json');
  if (existsSync(configPath)) return;
  writeFileSync(configPath, JSON.stringify({
    notifications: { enabled: false },
  }));
}

function resolveTestCodexHome(payload: Record<string, unknown>, envOverrides: Record<string, string>): string {
  const codexHome = envOverrides.CODEX_HOME
    || (typeof payload.cwd === 'string' && payload.cwd
      ? join(payload.cwd, '.omx', 'test-codex-home')
      : join(tmpdir(), 'omx-notify-session-scope-codex-home'));
  ensureDisabledNotificationConfig(codexHome);
  return codexHome;
}

function runNotifyHook(
  payload: Record<string, unknown>,
  envOverrides: Record<string, string> = {},
) {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, '..', '..', '..');
  const codexHome = resolveTestCodexHome(payload, envOverrides);
  return spawnSync(process.execPath, ['dist/scripts/notify-hook.js', JSON.stringify(payload)], {
    cwd: repoRoot,
    encoding: 'utf-8',
    env: {
      ...sanitizeLiveNotificationEnv(process.env),
      CODEX_HOME: codexHome,
      OMX_TEAM_WORKER: '',
      TMUX: '',
      TMUX_PANE: '',
      ...envOverrides,
    },
  });
}

function runNotifyHookAsync(
  payload: Record<string, unknown>,
  envOverrides: Record<string, string> = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, '..', '..', '..');
  const codexHome = resolveTestCodexHome(payload, envOverrides);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/scripts/notify-hook.js', JSON.stringify(payload)], {
      cwd: repoRoot,
      env: {
        ...sanitizeLiveNotificationEnv(process.env),
        CODEX_HOME: codexHome,
        OMX_TEAM_WORKER: '',
        TMUX: '',
        TMUX_PANE: '',
        ...envOverrides,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

async function readJsonLines(path: string): Promise<Array<Record<string, unknown>>> {
  const content = await readFile(path, 'utf-8').catch(() => '');
  return content
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function readJsonLogFiles(
  logsDir: string,
  prefix: string,
): Promise<Array<Record<string, unknown>>> {
  const names = (await readdir(logsDir).catch(() => []))
    .filter((name) => name.startsWith(prefix) && name.endsWith('.jsonl'))
    .sort();
  const entries: Array<Record<string, unknown>> = [];
  for (const name of names) {
    entries.push(...await readJsonLines(join(logsDir, name)));
  }
  return entries;
}

function replaceFifoWithDirectoryAfterRead(
  t: TestContext,
  fifoPath: string,
  content: unknown,
  extraDirectoryPath?: string,
  afterReadJsonPath?: string,
  afterReadJsonContent?: unknown,
): Promise<void> | null {
  const mkfifo = spawnSync('mkfifo', [fifoPath], { encoding: 'utf-8' });
  if (mkfifo.error) {
    const code = (mkfifo.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      t.skip('mkfifo is not available in this environment');
      return null;
    }
    throw mkfifo.error;
  }
  if (mkfifo.status !== 0 && /not found|No such file|Operation not permitted/i.test(mkfifo.stderr || '')) {
    t.skip(`mkfifo is not available in this environment: ${mkfifo.stderr || mkfifo.stdout}`);
    return null;
  }
  assert.equal(mkfifo.status, 0, mkfifo.stderr || mkfifo.stdout);

  const script = `
    const fs = require('fs');
    const target = process.argv[1];
    const content = process.argv[2];
    const extraDirectory = process.argv[3];
    const afterReadJsonPath = process.argv[4];
    const afterReadJsonContent = process.argv[5];
    const fd = fs.openSync(target, 'w');
    try {
      fs.writeSync(fd, content);
      fs.rmSync(target, { force: true });
      fs.mkdirSync(target);
      if (extraDirectory) {
        fs.mkdirSync(extraDirectory);
      }
      if (afterReadJsonPath) {
        fs.rmSync(afterReadJsonPath, { recursive: true, force: true });
        fs.mkdirSync(require('path').dirname(afterReadJsonPath), { recursive: true });
        fs.writeFileSync(afterReadJsonPath, afterReadJsonContent);
      }
    } finally {
      fs.closeSync(fd);
    }
  `;
  const child = spawn(process.execPath, [
    '-e',
    script,
    fifoPath,
    JSON.stringify(content),
    extraDirectoryPath || '',
    afterReadJsonPath || '',
    afterReadJsonPath ? JSON.stringify(afterReadJsonContent) : '',
  ], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf-8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out replacing FIFO ${fifoPath}`));
    }, 5000);
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (status) => {
      clearTimeout(timeout);
      if (status === 0) {
        resolve();
        return;
      }
      reject(new Error(`FIFO replacement failed with status ${status}: ${stderr}`));
    });
  });
}

function replaceFifoWithMissingAfterRead(
  t: TestContext,
  fifoPath: string,
  content: unknown,
  afterReadJsonPath?: string,
  afterReadJsonContent?: unknown,
): Promise<void> | null {
  const mkfifo = spawnSync('mkfifo', [fifoPath], { encoding: 'utf-8' });
  if (mkfifo.error) {
    const code = (mkfifo.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      t.skip('mkfifo is not available in this environment');
      return null;
    }
    throw mkfifo.error;
  }
  if (mkfifo.status !== 0 && /not found|No such file|Operation not permitted/i.test(mkfifo.stderr || '')) {
    t.skip(`mkfifo is not available in this environment: ${mkfifo.stderr || mkfifo.stdout}`);
    return null;
  }
  assert.equal(mkfifo.status, 0, mkfifo.stderr || mkfifo.stdout);

  const script = `
    const fs = require('fs');
    const path = require('path');
    const target = process.argv[1];
    const content = process.argv[2];
    const afterReadJsonPath = process.argv[3];
    const afterReadJsonContent = process.argv[4];
    const fd = fs.openSync(target, 'w');
    try {
      fs.writeSync(fd, content);
      fs.rmSync(target, { force: true });
      if (afterReadJsonPath) {
        fs.rmSync(afterReadJsonPath, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(afterReadJsonPath), { recursive: true });
        fs.writeFileSync(afterReadJsonPath, afterReadJsonContent);
      }
    } finally {
      fs.closeSync(fd);
    }
  `;
  const child = spawn(process.execPath, [
    '-e',
    script,
    fifoPath,
    JSON.stringify(content),
    afterReadJsonPath || '',
    afterReadJsonPath ? JSON.stringify(afterReadJsonContent) : '',
  ], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf-8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out replacing FIFO ${fifoPath}`));
    }, 5000);
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (status) => {
      clearTimeout(timeout);
      if (status === 0) {
        resolve();
        return;
      }
      reject(new Error(`FIFO replacement failed with status ${status}: ${stderr}`));
    });
  });
}

function replacePrimaryFifoWithDirectoryThenFallbackFifoCreatesPrimary(
  t: TestContext,
  projectPath: string,
  projectReadContent: unknown,
  fallbackPath: string,
  fallbackReadContent: unknown,
  primaryStateAfterFallbackRead: unknown,
): Promise<void> | null {
  const mkfifo = spawnSync('mkfifo', [projectPath], { encoding: 'utf-8' });
  if (mkfifo.error) {
    const code = (mkfifo.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      t.skip('mkfifo is not available in this environment');
      return null;
    }
    throw mkfifo.error;
  }
  if (mkfifo.status !== 0 && /not found|No such file|Operation not permitted/i.test(mkfifo.stderr || '')) {
    t.skip(`mkfifo is not available in this environment: ${mkfifo.stderr || mkfifo.stdout}`);
    return null;
  }
  assert.equal(mkfifo.status, 0, mkfifo.stderr || mkfifo.stdout);

  const script = `
    const fs = require('fs');
    const { spawnSync } = require('child_process');
    const projectPath = process.argv[1];
    const projectReadContent = process.argv[2];
    const fallbackPath = process.argv[3];
    const fallbackReadContent = process.argv[4];
    const primaryStateAfterFallbackRead = process.argv[5];

    const projectFd = fs.openSync(projectPath, 'w');
    try {
      fs.writeSync(projectFd, projectReadContent);
      fs.rmSync(projectPath, { force: true });
      fs.mkdirSync(projectPath);
      const mkfifo = spawnSync('mkfifo', [fallbackPath], { encoding: 'utf-8' });
      if (mkfifo.status !== 0) {
        throw new Error(mkfifo.stderr || mkfifo.stdout || 'mkfifo fallback failed');
      }
    } finally {
      fs.closeSync(projectFd);
    }

    const fallbackFd = fs.openSync(fallbackPath, 'w');
    try {
      fs.writeSync(fallbackFd, fallbackReadContent);
      fs.rmSync(fallbackPath, { force: true });
      fs.rmSync(projectPath, { recursive: true, force: true });
      fs.writeFileSync(projectPath, primaryStateAfterFallbackRead);
    } finally {
      fs.closeSync(fallbackFd);
    }
  `;
  const child = spawn(process.execPath, [
    '-e',
    script,
    projectPath,
    JSON.stringify(projectReadContent),
    fallbackPath,
    JSON.stringify(fallbackReadContent),
    JSON.stringify(primaryStateAfterFallbackRead),
  ], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf-8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out orchestrating primary/fallback FIFO race ${projectPath}`));
    }, 5000);
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (status) => {
      clearTimeout(timeout);
      if (status === 0) {
        resolve();
        return;
      }
      reject(new Error(`primary/fallback FIFO orchestration failed with status ${status}: ${stderr}`));
    });
  });
}

function replacePrimaryFifoWithDirectoryThenFallbackFifoBecomesDirectoryAfterRead(
  t: TestContext,
  projectPath: string,
  projectReadContent: unknown,
  fallbackPath: string,
  fallbackReadContent: unknown,
): Promise<void> | null {
  const mkfifo = spawnSync('mkfifo', [projectPath], { encoding: 'utf-8' });
  if (mkfifo.error) {
    const code = (mkfifo.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      t.skip('mkfifo is not available in this environment');
      return null;
    }
    throw mkfifo.error;
  }
  if (mkfifo.status !== 0 && /not found|No such file|Operation not permitted/i.test(mkfifo.stderr || '')) {
    t.skip(`mkfifo is not available in this environment: ${mkfifo.stderr || mkfifo.stdout}`);
    return null;
  }
  assert.equal(mkfifo.status, 0, mkfifo.stderr || mkfifo.stdout);

  const script = `
    const fs = require('fs');
    const { spawnSync } = require('child_process');
    const projectPath = process.argv[1];
    const projectReadContent = process.argv[2];
    const fallbackPath = process.argv[3];
    const fallbackReadContent = process.argv[4];

    const projectFd = fs.openSync(projectPath, 'w');
    try {
      fs.writeSync(projectFd, projectReadContent);
      fs.rmSync(projectPath, { force: true });
      fs.mkdirSync(projectPath);
      const mkfifo = spawnSync('mkfifo', [fallbackPath], { encoding: 'utf-8' });
      if (mkfifo.status !== 0) {
        throw new Error(mkfifo.stderr || mkfifo.stdout || 'mkfifo fallback failed');
      }
    } finally {
      fs.closeSync(projectFd);
    }

    const fallbackFd = fs.openSync(fallbackPath, 'w');
    try {
      fs.writeSync(fallbackFd, fallbackReadContent);
      fs.rmSync(fallbackPath, { force: true });
      fs.mkdirSync(fallbackPath);
    } finally {
      fs.closeSync(fallbackFd);
    }
  `;
  const child = spawn(process.execPath, [
    '-e',
    script,
    projectPath,
    JSON.stringify(projectReadContent),
    fallbackPath,
    JSON.stringify(fallbackReadContent),
  ], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf-8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out orchestrating fallback write failure ${projectPath}`));
    }, 5000);
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (status) => {
      clearTimeout(timeout);
      if (status === 0) {
        resolve();
        return;
      }
      reject(new Error(`fallback write failure orchestration failed with status ${status}: ${stderr}`));
    });
  });
}

function replacePrimaryFifoWithDirectoryThenFallbackFifoCreatesPrimaryFifoAndFallbackLockAfterReplay(
  t: TestContext,
  projectPath: string,
  projectReadContent: unknown,
  fallbackPath: string,
  fallbackReadContent: unknown,
  primaryReplayContent: unknown,
  fallbackLockPath: string,
): Promise<void> | null {
  const mkfifo = spawnSync('mkfifo', [projectPath], { encoding: 'utf-8' });
  if (mkfifo.error) {
    const code = (mkfifo.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      t.skip('mkfifo is not available in this environment');
      return null;
    }
    throw mkfifo.error;
  }
  if (mkfifo.status !== 0 && /not found|No such file|Operation not permitted/i.test(mkfifo.stderr || '')) {
    t.skip(`mkfifo is not available in this environment: ${mkfifo.stderr || mkfifo.stdout}`);
    return null;
  }
  assert.equal(mkfifo.status, 0, mkfifo.stderr || mkfifo.stdout);

  const script = `
    const fs = require('fs');
    const { spawnSync } = require('child_process');
    const projectPath = process.argv[1];
    const projectReadContent = process.argv[2];
    const fallbackPath = process.argv[3];
    const fallbackReadContent = process.argv[4];
    const primaryReplayContent = process.argv[5];
    const fallbackLockPath = process.argv[6];

    const projectFd = fs.openSync(projectPath, 'w');
    try {
      fs.writeSync(projectFd, projectReadContent);
      fs.rmSync(projectPath, { force: true });
      fs.mkdirSync(projectPath);
      const mkfifo = spawnSync('mkfifo', [fallbackPath], { encoding: 'utf-8' });
      if (mkfifo.status !== 0) {
        throw new Error(mkfifo.stderr || mkfifo.stdout || 'mkfifo fallback failed');
      }
    } finally {
      fs.closeSync(projectFd);
    }

    const fallbackFd = fs.openSync(fallbackPath, 'w');
    try {
      fs.writeSync(fallbackFd, fallbackReadContent);
      fs.rmSync(fallbackPath, { force: true });
      fs.writeFileSync(fallbackPath, fallbackReadContent);
      fs.rmSync(projectPath, { recursive: true, force: true });
      const mkfifo = spawnSync('mkfifo', [projectPath], { encoding: 'utf-8' });
      if (mkfifo.status !== 0) {
        throw new Error(mkfifo.stderr || mkfifo.stdout || 'mkfifo primary replay failed');
      }
    } finally {
      fs.closeSync(fallbackFd);
    }

    const primaryReplayFd = fs.openSync(projectPath, 'w');
    try {
      fs.writeSync(primaryReplayFd, primaryReplayContent);
      fs.rmSync(projectPath, { force: true });
      fs.writeFileSync(fallbackLockPath, 'fresh-fallback-finalize-lock');
    } finally {
      fs.closeSync(primaryReplayFd);
    }
  `;
  const child = spawn(process.execPath, [
    '-e',
    script,
    projectPath,
    JSON.stringify(projectReadContent),
    fallbackPath,
    JSON.stringify(fallbackReadContent),
    JSON.stringify(primaryReplayContent),
    fallbackLockPath,
  ], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf-8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out orchestrating fallback finalize lock race ${projectPath}`));
    }, 5000);
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (status) => {
      clearTimeout(timeout);
      if (status === 0) {
        resolve();
        return;
      }
      reject(new Error(`fallback finalize lock orchestration failed with status ${status}: ${stderr}`));
    });
  });
}

function replacePrimaryFifoWithDirectoryThenFallbackFifoCreatesPrimaryLock(
  t: TestContext,
  projectPath: string,
  projectReadContent: unknown,
  fallbackPath: string,
  fallbackReadContent: unknown,
  primaryLockPath: string,
  primaryLockContent = 'fresh-primary-replay-lock',
  fallbackStateAfterRead?: unknown,
): Promise<void> | null {
  const mkfifo = spawnSync('mkfifo', [projectPath], { encoding: 'utf-8' });
  if (mkfifo.error) {
    const code = (mkfifo.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      t.skip('mkfifo is not available in this environment');
      return null;
    }
    throw mkfifo.error;
  }
  if (mkfifo.status !== 0 && /not found|No such file|Operation not permitted/i.test(mkfifo.stderr || '')) {
    t.skip(`mkfifo is not available in this environment: ${mkfifo.stderr || mkfifo.stdout}`);
    return null;
  }
  assert.equal(mkfifo.status, 0, mkfifo.stderr || mkfifo.stdout);

  const script = `
    const fs = require('fs');
    const { spawnSync } = require('child_process');
    const projectPath = process.argv[1];
    const projectReadContent = process.argv[2];
    const fallbackPath = process.argv[3];
    const fallbackReadContent = process.argv[4];
    const primaryLockPath = process.argv[5];
    const primaryLockContent = process.argv[6];
    const fallbackStateAfterRead = process.argv[7];

    const projectFd = fs.openSync(projectPath, 'w');
    try {
      fs.writeSync(projectFd, projectReadContent);
      fs.rmSync(projectPath, { force: true });
      fs.mkdirSync(projectPath);
      const mkfifo = spawnSync('mkfifo', [fallbackPath], { encoding: 'utf-8' });
      if (mkfifo.status !== 0) {
        throw new Error(mkfifo.stderr || mkfifo.stdout || 'mkfifo fallback failed');
      }
    } finally {
      fs.closeSync(projectFd);
    }

    const fallbackFd = fs.openSync(fallbackPath, 'w');
    try {
      fs.writeSync(fallbackFd, fallbackReadContent);
      fs.rmSync(fallbackPath, { force: true });
      if (fallbackStateAfterRead) {
        fs.writeFileSync(fallbackPath, fallbackStateAfterRead);
      }
      fs.writeFileSync(primaryLockPath, primaryLockContent);
    } finally {
      fs.closeSync(fallbackFd);
    }
  `;
  const child = spawn(process.execPath, [
    '-e',
    script,
    projectPath,
    JSON.stringify(projectReadContent),
    fallbackPath,
    JSON.stringify(fallbackReadContent),
    primaryLockPath,
    primaryLockContent,
    fallbackStateAfterRead === undefined ? '' : JSON.stringify(fallbackStateAfterRead),
  ], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf-8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out orchestrating primary/fallback lock race ${projectPath}`));
    }, 5000);
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (status) => {
      clearTimeout(timeout);
      if (status === 0) {
        resolve();
        return;
      }
      reject(new Error(`primary/fallback lock orchestration failed with status ${status}: ${stderr}`));
    });
  });
}

describe('notify-hook session-scoped iteration updates', () => {
  it('does not mutate root active mode state when current session scope exists only in session.json', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-root-fallback-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'sess-current';
      await mkdir(stateDir, { recursive: true });

      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId }));
      await writeFile(join(stateDir, 'team-state.json'), JSON.stringify({
        active: true,
        iteration: 41,
        max_iterations: 100,
        current_phase: 'executing',
      }));

      const result = runNotifyHook({
        cwd: wd,
        type: 'agent-turn-complete',
        thread_id: 'th-root',
        turn_id: 'tu-root',
        input_messages: [],
        last_assistant_message: 'ok',
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const rootState = JSON.parse(await readFile(join(stateDir, 'team-state.json'), 'utf-8'));
      assert.equal(rootState.iteration, 41);
      assert.equal(rootState.last_turn_at, undefined);
      assert.equal(existsSync(join(stateDir, 'sessions', sessionId, 'team-state.json')), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('increments iteration for active session-scoped mode states', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-test-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'sess1';
      const sessionScopedDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionScopedDir, { recursive: true });

      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId }));
      await writeFile(join(sessionScopedDir, 'team-state.json'), JSON.stringify({ active: true, iteration: 0 }));

      const result = runNotifyHook({
        cwd: wd,
        type: 'agent-turn-complete',
        thread_id: 'th',
        turn_id: 'tu',
        input_messages: [],
        last_assistant_message: 'ok',
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const updated = JSON.parse(await readFile(join(sessionScopedDir, 'team-state.json'), 'utf-8'));
      assert.equal(updated.iteration, 1);
      assert.ok(typeof updated.last_turn_at === 'string' && updated.last_turn_at.length > 0);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('auto-expands active Ralph max_iterations by 10 when the run is still progressing', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-test-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'sess1';
      const sessionScopedDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionScopedDir, { recursive: true });

      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId }));
      await writeFile(join(sessionScopedDir, 'ralph-state.json'), JSON.stringify({
        active: true,
        iteration: 1,
        max_iterations: 2,
        current_phase: 'executing',
      }));

      const result = runNotifyHook({
        cwd: wd,
        type: 'agent-turn-complete',
        thread_id: 'th2',
        turn_id: 'tu2',
        input_messages: [],
        last_assistant_message: 'ok',
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const updated = JSON.parse(await readFile(join(sessionScopedDir, 'ralph-state.json'), 'utf-8'));
      assert.equal(updated.iteration, 2);
      assert.equal(updated.active, true);
      assert.equal(updated.current_phase, 'executing');
      assert.equal(updated.max_iterations, 12);
      assert.equal(updated.stop_reason, undefined);
      assert.equal(updated.completed_at, undefined);
      assert.equal(updated.max_iterations_auto_expand_count, 1);
      assert.ok(typeof updated.max_iterations_auto_expanded_at === 'string' && updated.max_iterations_auto_expanded_at.length > 0);
      assert.ok(typeof updated.last_turn_at === 'string' && updated.last_turn_at.length > 0);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('still marks non-Ralph modes complete when max_iterations is reached', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-test-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'sess1';
      const sessionScopedDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionScopedDir, { recursive: true });

      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId }));
      await writeFile(join(sessionScopedDir, 'team-state.json'), JSON.stringify({
        active: true,
        iteration: 1,
        max_iterations: 2,
        current_phase: 'executing',
      }));

      const result = runNotifyHook({
        cwd: wd,
        type: 'agent-turn-complete',
        thread_id: 'th2',
        turn_id: 'tu2',
        input_messages: [],
        last_assistant_message: 'ok',
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const updated = JSON.parse(await readFile(join(sessionScopedDir, 'team-state.json'), 'utf-8'));
      assert.equal(updated.iteration, 2);
      assert.equal(updated.active, false);
      assert.equal(updated.current_phase, 'complete');
      assert.equal(updated.stop_reason, 'max_iterations_reached');
      assert.ok(typeof updated.completed_at === 'string' && updated.completed_at.length > 0);
      assert.ok(typeof updated.last_turn_at === 'string' && updated.last_turn_at.length > 0);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('writes hud progress timestamps for leader turns', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-hud-progress-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      await mkdir(stateDir, { recursive: true });

      const result = runNotifyHook({
        cwd: wd,
        type: 'agent-turn-complete',
        thread_id: 'th-progress',
        turn_id: 'tu-progress',
        input_messages: [],
        last_assistant_message: 'ok',
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const hudState = JSON.parse(await readFile(join(stateDir, 'hud-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.ok(typeof hudState.last_turn_at === 'string' && hudState.last_turn_at.length > 0);
      assert.ok(typeof hudState.last_progress_at === 'string' && hudState.last_progress_at.length > 0);
      assert.equal(hudState.last_progress_at, hudState.last_turn_at);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('prefers the canonical OMX session scope over a different native payload session id for notify sidefiles', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-canonical-session-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const canonicalSessionId = 'omx-canonical-session';
      const nativeSessionId = 'codex-native-session';
      const canonicalDir = join(stateDir, 'sessions', canonicalSessionId);
      await mkdir(canonicalDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: canonicalSessionId,
        native_session_id: nativeSessionId,
        started_at: new Date().toISOString(),
        cwd: wd,
      }));

      const result = runNotifyHook({
        cwd: wd,
        session_id: nativeSessionId,
        type: 'agent-turn-complete',
        thread_id: 'th-canonical',
        turn_id: 'tu-canonical',
        input_messages: [],
        last_assistant_message: 'ok',
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      assert.equal(existsSync(join(canonicalDir, 'hud-state.json')), true);
      assert.equal(existsSync(join(canonicalDir, 'notify-hook-state.json')), true);
      assert.equal(existsSync(join(stateDir, 'sessions', nativeSessionId, 'hud-state.json')), false);
      assert.equal(existsSync(join(stateDir, 'sessions', nativeSessionId, 'notify-hook-state.json')), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });


  it('prefers the invocation OMX session id over the persisted canonical session for notify sidefiles when a fork scope exists', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-fork-session-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const canonicalSessionId = 'omx-canonical-session';
      const forkSessionId = 'omx-fork-session';
      const nativeSessionId = 'codex-native-session';
      const forkDir = join(stateDir, 'sessions', forkSessionId);
      await mkdir(forkDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: canonicalSessionId,
        native_session_id: nativeSessionId,
        started_at: new Date().toISOString(),
        cwd: wd,
      }));

      const result = spawnSync(process.execPath, ['dist/scripts/notify-hook.js', JSON.stringify({
        cwd: wd,
        session_id: nativeSessionId,
        type: 'agent-turn-complete',
        thread_id: 'th-fork',
        turn_id: 'tu-fork',
        input_messages: [],
        last_assistant_message: 'ok',
      })], {
        cwd: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'),
        encoding: 'utf-8',
        env: {
          ...process.env,
          OMX_SESSION_ID: forkSessionId,
          OMX_TEAM_WORKER: '',
          TMUX: '',
          TMUX_PANE: '',
        },
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      assert.equal(existsSync(join(forkDir, 'hud-state.json')), true);
      assert.equal(existsSync(join(forkDir, 'notify-hook-state.json')), true);
      assert.equal(existsSync(join(stateDir, 'sessions', canonicalSessionId, 'hud-state.json')), false);
      assert.equal(existsSync(join(stateDir, 'sessions', canonicalSessionId, 'notify-hook-state.json')), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('dedupes the same completed turn across event-type aliases and different OMX session scopes', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-cross-session-dedupe-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const firstSessionId = 'omx-first-session';
      const secondSessionId = 'omx-second-session';
      await mkdir(join(stateDir, 'sessions', firstSessionId), { recursive: true });
      await mkdir(join(stateDir, 'sessions', secondSessionId), { recursive: true });

      const payload = {
        cwd: wd,
        session_id: 'native-session-1',
        type: 'turn-complete',
        thread_id: 'native-thread-cross-session',
        turn_id: 'native-turn-cross-session',
        input_messages: ['hello'],
        last_assistant_message: 'cross-session duplicate output',
      };

      const first = runNotifyHook(payload, { OMX_SESSION_ID: firstSessionId });
      assert.equal(first.status, 0, first.stderr || first.stdout);
      const second = runNotifyHook(
        {
          ...payload,
          type: 'agent-turn-complete',
          input_messages: ['[notify-fallback] synthesized from rollout task_complete'],
          source: 'notify-fallback-watcher',
        },
        { OMX_SESSION_ID: secondSessionId },
      );
      assert.equal(second.status, 0, second.stderr || second.stdout);

      const turns = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'turns-');
      assert.equal(turns.length, 1);
      assert.equal(turns[0].turn_id, 'native-turn-cross-session');

      assert.equal(existsSync(join(stateDir, 'sessions', firstSessionId, 'notify-hook-state.json')), true);
      assert.equal(existsSync(join(stateDir, 'sessions', secondSessionId, 'notify-hook-state.json')), false);

      const dedupeState = JSON.parse(
        await readFile(join(stateDir, 'notify-hook-turn-dedupe.json'), 'utf-8'),
      ) as { recent_turns?: Record<string, number> };
      assert.equal(
        Boolean(dedupeState.recent_turns?.['native-thread-cross-session|native-turn-cross-session|agent-turn-complete']),
        true,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('suppresses native replay after a fallback delivery claims the project turn first', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-fallback-first-dedupe-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const canonicalSessionId = 'omx-canonical-owner';
      const fallbackSessionId = 'omx-fallback-session';
      const nativeThreadId = 'native-thread-fallback-first';
      const turnId = 'native-turn-fallback-first';
      await mkdir(join(stateDir, 'sessions', canonicalSessionId), { recursive: true });
      await mkdir(join(stateDir, 'sessions', fallbackSessionId), { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: canonicalSessionId,
        native_session_id: nativeThreadId,
        started_at: new Date().toISOString(),
        cwd: wd,
      }));

      const payload = {
        cwd: wd,
        session_id: 'native-session-fallback-first',
        type: 'agent-turn-complete',
        thread_id: nativeThreadId,
        turn_id: turnId,
        input_messages: ['hello'],
        last_assistant_message: 'fallback-first output',
      };

      const fallback = runNotifyHook(
        {
          ...payload,
          input_messages: ['[notify-fallback] synthesized from rollout task_complete'],
          source: 'notify-fallback-watcher',
        },
        { OMX_SESSION_ID: fallbackSessionId },
      );
      assert.equal(fallback.status, 0, fallback.stderr || fallback.stdout);

      const native = runNotifyHook(payload, { OMX_SESSION_ID: canonicalSessionId });
      assert.equal(native.status, 0, native.stderr || native.stdout);

      assert.equal(existsSync(join(stateDir, 'sessions', fallbackSessionId, 'notify-hook-state.json')), true);

      const notifyLog = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'notify-hook-');
      assert.equal(
        notifyLog.some((entry) =>
          entry.type === 'turn_duplicate_suppressed'
          && entry.scope === 'project'
          && entry.turn_id === turnId
        ),
        true,
      );
      assert.equal(
        notifyLog.filter((entry) => entry.type === 'completed_turn_delivery_allowed' && entry.turn_id === turnId).length,
        1,
      );
      assert.equal(
        notifyLog.some((entry) => entry.type === 'completed_turn_duplicate_suppressed' && entry.turn_id === turnId),
        false,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('atomically dedupes concurrent duplicate turn deliveries', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-concurrent-dedupe-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'omx-concurrent-session';
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });

      const payload = {
        cwd: wd,
        session_id: 'native-session-concurrent',
        type: 'agent-turn-complete',
        thread_id: 'native-thread-concurrent',
        turn_id: 'native-turn-concurrent',
        input_messages: ['hello'],
        last_assistant_message: 'concurrent duplicate output',
      };

      const results = await Promise.all(
        Array.from({ length: 8 }, (_, idx) =>
          runNotifyHookAsync(
            {
              ...payload,
              input_messages: [`hello ${idx}`],
            },
            { OMX_SESSION_ID: sessionId },
          )
        ),
      );
      for (const result of results) {
        assert.equal(result.status, 0, result.stderr || result.stdout);
      }

      const turns = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'turns-');
      assert.equal(turns.length, 1);
      assert.equal(turns[0].turn_id, 'native-turn-concurrent');

      const notifyLog = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'notify-hook-');
      assert.equal(
        notifyLog.some((entry) => entry.type === 'turn_duplicate_suppressed' && entry.scope === 'project'),
        true,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('falls back to project-wide dedupe state when project turn dedupe is unreadable', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-project-dedupe-unreadable-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'omx-project-dedupe-unreadable-session';
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      await mkdir(join(stateDir, 'notify-hook-turn-dedupe.json'));

      const result = runNotifyHook({
        cwd: wd,
        session_id: 'native-session-project-dedupe-unreadable',
        type: 'agent-turn-complete',
        thread_id: 'native-thread-project-dedupe-unreadable',
        turn_id: 'native-turn-project-dedupe-unreadable',
        input_messages: ['hello'],
        last_assistant_message: 'project dedupe unreadable output',
      }, { OMX_SESSION_ID: sessionId });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      assert.equal(existsSync(join(stateDir, 'notify-hook-state.json')), true);
      const notifyLog = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'notify-hook-');
      assert.equal(
        notifyLog.some((entry) =>
          entry.type === 'project_turn_dedupe_failed'
          && entry.turn_id === 'native-turn-project-dedupe-unreadable'
        ),
        true,
      );
      assert.equal(existsSync(join(stateDir, 'notify-hook-turn-dedupe.json')), true);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('serializes project-wide fallback dedupe when project turn dedupe is unreadable', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-project-dedupe-unreadable-concurrent-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'omx-project-dedupe-unreadable-concurrent';
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      await mkdir(join(stateDir, 'notify-hook-turn-dedupe.json'));

      const payload = {
        cwd: wd,
        session_id: 'native-session-project-dedupe-unreadable-concurrent',
        type: 'agent-turn-complete',
        thread_id: 'native-thread-project-dedupe-unreadable-concurrent',
        turn_id: 'native-turn-project-dedupe-unreadable-concurrent',
        input_messages: ['hello'],
        last_assistant_message: 'project dedupe unreadable concurrent output',
      };

      const results = await Promise.all(
        Array.from({ length: 4 }, (_, idx) =>
          runNotifyHookAsync(
            {
              ...payload,
              input_messages: [`hello ${idx}`],
            },
            { OMX_SESSION_ID: sessionId },
          )
        ),
      );
      for (const result of results) {
        assert.equal(result.status, 0, result.stderr || result.stdout);
      }

      const turns = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'turns-');
      assert.equal(turns.length, 1);
      assert.equal(turns[0].turn_id, 'native-turn-project-dedupe-unreadable-concurrent');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('dedupes cross-session duplicate turns through project-wide fallback state when project dedupe is unreadable', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-project-dedupe-unreadable-cross-session-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const firstSessionId = 'omx-project-unreadable-first';
      const secondSessionId = 'omx-project-unreadable-second';
      await mkdir(join(stateDir, 'sessions', firstSessionId), { recursive: true });
      await mkdir(join(stateDir, 'sessions', secondSessionId), { recursive: true });
      await mkdir(join(stateDir, 'notify-hook-turn-dedupe.json'));

      const payload = {
        cwd: wd,
        session_id: 'native-session-project-unreadable-cross-session',
        type: 'turn-complete',
        thread_id: 'native-thread-project-unreadable-cross-session',
        turn_id: 'native-turn-project-unreadable-cross-session',
        input_messages: ['hello'],
        last_assistant_message: 'project dedupe unreadable cross-session output',
      };

      const first = runNotifyHook(payload, { OMX_SESSION_ID: firstSessionId });
      assert.equal(first.status, 0, first.stderr || first.stdout);
      const second = runNotifyHook(
        {
          ...payload,
          type: 'agent-turn-complete',
          input_messages: ['[notify-fallback] synthesized from rollout task_complete'],
          source: 'notify-fallback-watcher',
        },
        { OMX_SESSION_ID: secondSessionId },
      );
      assert.equal(second.status, 0, second.stderr || second.stdout);

      const turns = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'turns-');
      assert.equal(turns.length, 1);
      assert.equal(turns[0].turn_id, 'native-turn-project-unreadable-cross-session');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('replays project-wide fallback state into recovered project dedupe', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-project-dedupe-recovered-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'omx-project-dedupe-recovered';
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      await mkdir(join(stateDir, 'notify-hook-turn-dedupe.json'));

      const payload = {
        cwd: wd,
        session_id: 'native-session-project-recovered',
        type: 'agent-turn-complete',
        thread_id: 'native-thread-project-recovered',
        turn_id: 'native-turn-project-recovered',
        input_messages: ['hello'],
        last_assistant_message: 'project fallback recovered output',
      };

      const first = runNotifyHook(payload, { OMX_SESSION_ID: sessionId });
      assert.equal(first.status, 0, first.stderr || first.stdout);
      await rm(join(stateDir, 'notify-hook-turn-dedupe.json'), { recursive: true, force: true });

      const second = runNotifyHook({
        ...payload,
        input_messages: ['hello again'],
      }, { OMX_SESSION_ID: sessionId });
      assert.equal(second.status, 0, second.stderr || second.stdout);

      const turns = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'turns-');
      assert.equal(turns.length, 1);
      assert.equal(turns[0].turn_id, 'native-turn-project-recovered');
      const notifyLog = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'notify-hook-');
      assert.equal(
        notifyLog.some((entry) =>
          entry.type === 'turn_duplicate_suppressed'
          && entry.scope === 'project_fallback'
          && entry.turn_id === 'native-turn-project-recovered'
        ),
        true,
      );
      const primaryState = JSON.parse(
        await readFile(join(stateDir, 'notify-hook-turn-dedupe.json'), 'utf-8'),
      ) as {
        recent_turns?: Record<string, unknown>;
        turn_claims?: Record<string, unknown>;
      };
      const key = 'native-thread-project-recovered|native-turn-project-recovered|agent-turn-complete';
      assert.equal(Boolean(primaryState.recent_turns?.[key]), true);
      assert.equal(Boolean(primaryState.turn_claims?.[key]), true);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('replays fallback-watcher claims without duplicate delivery after project dedupe recovers', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-project-fallback-recovered-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const fallbackSessionId = 'omx-project-fallback-recovered-fallback';
      const nativeSessionId = 'omx-project-fallback-recovered-native';
      const threadId = 'native-thread-project-fallback-recovered';
      const turnId = 'native-turn-project-fallback-recovered';
      const timestamp = Date.now();
      await mkdir(join(stateDir, 'sessions', fallbackSessionId), { recursive: true });
      await mkdir(join(stateDir, 'sessions', nativeSessionId), { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: nativeSessionId,
        native_session_id: threadId,
        started_at: new Date(timestamp).toISOString(),
        cwd: wd,
      }));
      await mkdir(join(stateDir, 'notify-hook-turn-dedupe.json'));

      const payload = {
        cwd: wd,
        session_id: 'native-session-project-fallback-recovered',
        origin: { kind: 'leader', thread_id: threadId },
        type: 'agent-turn-complete',
        thread_id: threadId,
        turn_id: turnId,
        input_messages: ['hello'],
        last_assistant_message: 'project fallback recovered output',
      };

      const fallback = runNotifyHook({
        ...payload,
        input_messages: ['[notify-fallback] synthesized from rollout task_complete'],
        source: 'notify-fallback-watcher',
      }, { OMX_SESSION_ID: fallbackSessionId });
      assert.equal(fallback.status, 0, fallback.stderr || fallback.stdout);
      await rm(join(stateDir, 'notify-hook-turn-dedupe.json'), { recursive: true, force: true });

      const native = runNotifyHook(payload, { OMX_SESSION_ID: nativeSessionId });
      assert.equal(native.status, 0, native.stderr || native.stdout);

      const turns = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'turns-');
      assert.equal(turns.length, 1);
      assert.equal(turns.every((entry) => entry.turn_id === turnId), true);
      const notifyLog = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'notify-hook-');
      assert.equal(
        notifyLog.some((entry) =>
          entry.type === 'turn_duplicate_suppressed'
          && entry.scope === 'project_fallback'
          && entry.turn_id === turnId
        ),
        true,
      );
      assert.equal(
        notifyLog.filter((entry) => entry.type === 'completed_turn_delivery_allowed' && entry.turn_id === turnId).length,
        1,
      );
      assert.equal(
        notifyLog.some((entry) => entry.type === 'completed_turn_duplicate_suppressed' && entry.turn_id === turnId),
        false,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('upgrades fallback replay claims so recovered primary loss cannot redeliver owner upgrades', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-project-fallback-upgrade-replay-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'omx-project-fallback-upgrade-replay';
      const threadId = 'native-thread-project-fallback-upgrade-replay';
      const turnId = 'native-turn-project-fallback-upgrade-replay';
      const key = `${threadId}|${turnId}|agent-turn-complete`;
      const timestamp = Date.now();
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        native_session_id: threadId,
        started_at: new Date(timestamp).toISOString(),
        cwd: wd,
      }));
      await writeFile(join(stateDir, 'notify-hook-state.json'), JSON.stringify({
        recent_turns: { [key]: timestamp },
        turn_claims: {
          [key]: {
            timestamp,
            delivery: 'suppress',
            source_kind: 'native',
            source: 'native-subagent',
            session_id: 'omx-suppressed-helper',
            audience: 'child',
            reason: 'tracked_subagent_lineage',
          },
        },
        last_event_at: new Date(timestamp).toISOString(),
      }));

      const payload = {
        cwd: wd,
        session_id: 'native-session-project-fallback-upgrade-replay',
        origin: { kind: 'leader', thread_id: threadId },
        type: 'agent-turn-complete',
        thread_id: threadId,
        turn_id: turnId,
        input_messages: ['hello'],
        last_assistant_message: 'project fallback upgrade replay output',
      };

      const firstOwner = runNotifyHook(payload, { OMX_SESSION_ID: sessionId });
      assert.equal(firstOwner.status, 0, firstOwner.stderr || firstOwner.stdout);
      await rm(join(stateDir, 'notify-hook-turn-dedupe.json'), { force: true });

      const secondOwner = runNotifyHook({
        ...payload,
        input_messages: ['hello again'],
      }, { OMX_SESSION_ID: sessionId });
      assert.equal(secondOwner.status, 0, secondOwner.stderr || secondOwner.stdout);

      const notifyLog = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'notify-hook-');
      assert.equal(
        notifyLog.filter((entry) =>
          entry.type === 'completed_turn_delivery_allowed'
          && entry.turn_id === turnId
        ).length,
        1,
      );
      assert.equal(
        notifyLog.filter((entry) =>
          entry.type === 'completed_turn_delivery_sent'
          && entry.turn_id === turnId
        ).length,
        0,
      );
      assert.equal(
        notifyLog.filter((entry) =>
          entry.type === 'turn_duplicate_owner_upgraded'
          && entry.scope === 'project_fallback'
          && entry.turn_id === turnId
        ).length,
        1,
      );
      assert.equal(
        notifyLog.some((entry) =>
          entry.type === 'turn_duplicate_suppressed'
          && entry.scope === 'project_fallback'
          && entry.turn_id === turnId
        ),
        true,
      );
      const fallbackState = JSON.parse(
        await readFile(join(stateDir, 'notify-hook-state.json'), 'utf-8'),
      ) as {
        turn_claims?: Record<string, { delivery?: string; source_kind?: string }>;
      };
      assert.equal(fallbackState.turn_claims?.[key]?.delivery, 'allow');
      assert.equal(fallbackState.turn_claims?.[key]?.source_kind, 'native');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not downgrade closed fallback claims from stale open primary repairs', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-project-fallback-closed-primary-open-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'omx-project-fallback-closed-primary-open';
      const threadId = 'native-thread-project-fallback-closed-primary-open';
      const turnId = 'native-turn-project-fallback-closed-primary-open';
      const key = `${threadId}|${turnId}|agent-turn-complete`;
      const timestamp = Date.now();
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        native_session_id: threadId,
        started_at: new Date(timestamp).toISOString(),
        cwd: wd,
      }));
      await writeFile(join(stateDir, 'notify-hook-turn-dedupe.json'), JSON.stringify({
        recent_turns: { [key]: timestamp + 1 },
        turn_claims: {
          [key]: {
            timestamp: timestamp + 1,
            delivery: 'allow',
            delivery_status: 'dispatching',
            source_kind: 'native',
            source: '',
            session_id: sessionId,
            audience: 'external-owner',
            reason: 'current_external_owner',
          },
        },
        last_event_at: new Date(timestamp).toISOString(),
      }));
      await writeFile(join(stateDir, 'notify-hook-state.json'), JSON.stringify({
        recent_turns: { [key]: timestamp },
        turn_claims: {
          [key]: {
            timestamp,
            delivery: 'allow',
            delivery_status: 'sent',
            source_kind: 'fallback',
            source: 'notify-fallback-watcher',
            session_id: 'omx-fallback-owner',
            audience: 'external-owner',
            reason: 'current_external_owner',
          },
        },
        last_event_at: new Date(timestamp).toISOString(),
      }));

      const result = runNotifyHook({
        cwd: wd,
        session_id: 'native-session-project-fallback-closed-primary-open',
        origin: { kind: 'leader', thread_id: threadId },
        type: 'agent-turn-complete',
        thread_id: threadId,
        turn_id: turnId,
        input_messages: ['hello'],
        last_assistant_message: 'closed fallback should stay closed',
      }, { OMX_SESSION_ID: sessionId });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const notifyLog = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'notify-hook-');
      assert.equal(
        notifyLog.some((entry) =>
          entry.type === 'project_fallback_turn_dedupe_upgraded'
          && entry.turn_id === turnId
        ),
        false,
      );
      assert.equal(
        notifyLog.some((entry) =>
          entry.type === 'completed_turn_delivery_allowed'
          && entry.turn_id === turnId
        ),
        false,
      );
      const fallbackState = JSON.parse(
        await readFile(join(stateDir, 'notify-hook-state.json'), 'utf-8'),
      ) as {
        turn_claims?: Record<string, { delivery_status?: string; source_kind?: string }>;
      };
      assert.equal(fallbackState.turn_claims?.[key]?.delivery_status, 'sent');
      assert.equal(fallbackState.turn_claims?.[key]?.source_kind, 'fallback');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not upgrade fallback owner claims when recovered primary seeding fails', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-project-fallback-upgrade-seed-fail-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'omx-project-fallback-upgrade-seed-fail';
      const threadId = 'native-thread-project-fallback-upgrade-seed-fail';
      const turnId = 'native-turn-project-fallback-upgrade-seed-fail';
      const key = `${threadId}|${turnId}|agent-turn-complete`;
      const timestamp = Date.now();
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        native_session_id: threadId,
        started_at: new Date(timestamp).toISOString(),
        cwd: wd,
      }));
      await writeFile(join(stateDir, 'notify-hook-state.json'), JSON.stringify({
        recent_turns: { [key]: timestamp },
        turn_claims: {
          [key]: {
            timestamp,
            delivery: 'suppress',
            source_kind: 'native',
            source: 'native-subagent',
            session_id: 'omx-suppressed-helper-seed-fail',
            audience: 'child',
            reason: 'tracked_subagent_lineage',
          },
        },
        last_event_at: new Date(timestamp).toISOString(),
      }));
      await mkdir(join(stateDir, 'notify-hook-turn-dedupe.json'));

      const result = runNotifyHook({
        cwd: wd,
        session_id: 'native-session-project-fallback-upgrade-seed-fail',
        origin: { kind: 'leader', thread_id: threadId },
        type: 'agent-turn-complete',
        thread_id: threadId,
        turn_id: turnId,
        input_messages: ['hello'],
        last_assistant_message: 'project fallback upgrade seed fail output',
      }, { OMX_SESSION_ID: sessionId });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      assert.deepEqual(await readJsonLogFiles(join(wd, '.omx', 'logs'), 'turns-'), []);
      const notifyLog = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'notify-hook-');
      assert.equal(
        notifyLog.some((entry) =>
          entry.type === 'project_fallback_turn_dedupe_seed_failed'
          && entry.turn_id === turnId
        ),
        true,
      );
      const fallbackState = JSON.parse(
        await readFile(join(stateDir, 'notify-hook-state.json'), 'utf-8'),
      ) as {
        turn_claims?: Record<string, { delivery?: string; source_kind?: string }>;
      };
      assert.equal(fallbackState.turn_claims?.[key]?.delivery, 'suppress');
      assert.equal(fallbackState.turn_claims?.[key]?.source_kind, 'native');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('repairs stale fallback suppress claims when primary already owns the delivered turn', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-project-fallback-stale-suppress-repair-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'omx-project-fallback-stale-suppress-repair';
      const threadId = 'native-thread-project-fallback-stale-suppress-repair';
      const turnId = 'native-turn-project-fallback-stale-suppress-repair';
      const key = `${threadId}|${turnId}|agent-turn-complete`;
      const timestamp = Date.now();
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        native_session_id: threadId,
        started_at: new Date(timestamp).toISOString(),
        cwd: wd,
      }));
      await writeFile(join(stateDir, 'notify-hook-turn-dedupe.json'), JSON.stringify({
        recent_turns: { [key]: timestamp },
        turn_claims: {
          [key]: {
            timestamp,
            delivery: 'allow',
            source_kind: 'native',
            source: 'native-notify',
            session_id: sessionId,
            audience: 'external-owner',
            reason: 'current_external_owner',
          },
        },
        last_event_at: new Date(timestamp).toISOString(),
      }));
      await writeFile(join(stateDir, 'notify-hook-state.json'), JSON.stringify({
        recent_turns: { [key]: timestamp },
        turn_claims: {
          [key]: {
            timestamp,
            delivery: 'suppress',
            source_kind: 'native',
            source: 'native-subagent',
            session_id: 'omx-stale-suppressed-fallback',
            audience: 'child',
            reason: 'tracked_subagent_lineage',
          },
        },
        last_event_at: new Date(timestamp).toISOString(),
      }));
      await mkdir(join(wd, '.omx', 'logs'), { recursive: true });
      await writeFile(join(wd, '.omx', 'logs', 'notify-hook-existing.jsonl'), `${JSON.stringify({
        timestamp: new Date(timestamp).toISOString(),
        type: 'completed_turn_delivery_sent',
        thread_id: threadId,
        turn_id: turnId,
        omx_session_id: sessionId,
      })}\n`);

      const payload = {
        cwd: wd,
        session_id: 'native-session-project-fallback-stale-suppress-repair',
        origin: { kind: 'leader', thread_id: threadId },
        type: 'agent-turn-complete',
        thread_id: threadId,
        turn_id: turnId,
        input_messages: ['hello'],
        last_assistant_message: 'project fallback stale suppress repair output',
      };
      const repair = runNotifyHook(payload, { OMX_SESSION_ID: sessionId });
      assert.equal(repair.status, 0, repair.stderr || repair.stdout);

      let fallbackState = JSON.parse(
        await readFile(join(stateDir, 'notify-hook-state.json'), 'utf-8'),
      ) as { turn_claims?: Record<string, { delivery?: string; source_kind?: string }> };
      assert.equal(fallbackState.turn_claims?.[key]?.delivery, 'allow');
      assert.equal(fallbackState.turn_claims?.[key]?.source_kind, 'native');

      await rm(join(stateDir, 'notify-hook-turn-dedupe.json'), { force: true });
      const retry = runNotifyHook({
        ...payload,
        input_messages: ['hello retry'],
      }, { OMX_SESSION_ID: sessionId });
      assert.equal(retry.status, 0, retry.stderr || retry.stdout);

      const notifyLog = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'notify-hook-');
      assert.equal(
        notifyLog.filter((entry) =>
          entry.type === 'completed_turn_delivery_allowed'
          && entry.turn_id === turnId
        ).length,
        0,
      );
      assert.equal(
        notifyLog.filter((entry) =>
          entry.type === 'completed_turn_delivery_sent'
          && entry.turn_id === turnId
        ).length,
        1,
      );
      assert.equal(
        notifyLog.some((entry) =>
          entry.type === 'turn_duplicate_suppressed'
          && entry.scope === 'project_fallback'
          && entry.turn_id === turnId
        ),
        true,
      );
      fallbackState = JSON.parse(
        await readFile(join(stateDir, 'notify-hook-state.json'), 'utf-8'),
      ) as { turn_claims?: Record<string, { delivery?: string }> };
      assert.equal(fallbackState.turn_claims?.[key]?.delivery, 'allow');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('recovers undelivered primary allow claims when fallback owner-upgrade repair is pending', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-project-fallback-undelivered-allow-repair-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'omx-project-fallback-undelivered-allow-repair';
      const threadId = 'native-thread-project-fallback-undelivered-allow-repair';
      const turnId = 'native-turn-project-fallback-undelivered-allow-repair';
      const key = `${threadId}|${turnId}|agent-turn-complete`;
      const timestamp = Date.now();
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        native_session_id: threadId,
        started_at: new Date(timestamp).toISOString(),
        cwd: wd,
      }));
      await writeFile(join(stateDir, 'notify-hook-turn-dedupe.json'), JSON.stringify({
        recent_turns: { [key]: timestamp },
        turn_claims: {
          [key]: {
            timestamp,
            delivery: 'allow',
            source_kind: 'native',
            source: 'native-notify',
            session_id: sessionId,
            audience: 'external-owner',
            reason: 'current_external_owner',
          },
        },
        last_event_at: new Date(timestamp).toISOString(),
      }));
      await writeFile(join(stateDir, 'notify-hook-state.json'), JSON.stringify({
        recent_turns: { [key]: timestamp },
        turn_claims: {
          [key]: {
            timestamp,
            delivery: 'suppress',
            source_kind: 'native',
            source: 'native-subagent',
            session_id: 'omx-undelivered-suppressed-fallback',
            audience: 'child',
            reason: 'tracked_subagent_lineage',
          },
        },
        last_event_at: new Date(timestamp).toISOString(),
      }));
      await mkdir(join(wd, '.omx', 'logs'), { recursive: true });
      await writeFile(join(wd, '.omx', 'logs', 'notify-hook-existing.jsonl'), `${JSON.stringify({
        timestamp: new Date(timestamp).toISOString(),
        type: 'completed_turn_delivery_allowed',
        thread_id: threadId,
        turn_id: turnId,
        omx_session_id: sessionId,
      })}\n`);

      const result = runNotifyHook({
        cwd: wd,
        session_id: 'native-session-project-fallback-undelivered-allow-repair',
        origin: { kind: 'leader', thread_id: threadId },
        type: 'agent-turn-complete',
        thread_id: threadId,
        turn_id: turnId,
        input_messages: ['hello'],
        last_assistant_message: 'project fallback undelivered allow repair output',
      }, { OMX_SESSION_ID: sessionId });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const notifyLog = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'notify-hook-');
      assert.equal(
        notifyLog.filter((entry) =>
          entry.type === 'completed_turn_delivery_allowed'
          && entry.turn_id === turnId
        ).length,
        2,
      );
      assert.equal(
        notifyLog.some((entry) =>
          entry.type === 'project_turn_dedupe_allow_claim_recovered_before_delivery'
          && entry.turn_id === turnId
          && entry.fallback_inconsistent === true
        ),
        true,
      );
      const fallbackState = JSON.parse(
        await readFile(join(stateDir, 'notify-hook-state.json'), 'utf-8'),
      ) as { turn_claims?: Record<string, { delivery?: string; source_kind?: string }> };
      assert.equal(fallbackState.turn_claims?.[key]?.delivery, 'allow');
      assert.equal(fallbackState.turn_claims?.[key]?.source_kind, 'native');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('repairs stale fallback suppress claims even when the current duplicate is suppressed', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-fallback-stale-suppress-helper-repair-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'omx-fallback-stale-suppress-helper-repair';
      const threadId = 'native-thread-fallback-stale-suppress-helper-repair';
      const turnId = 'native-turn-fallback-stale-suppress-helper-repair';
      const key = `${threadId}|${turnId}|agent-turn-complete`;
      const timestamp = Date.now();
      const projectDedupePath = join(stateDir, 'notify-hook-turn-dedupe.json');
      const fallbackDedupePath = join(stateDir, 'notify-hook-state.json');
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        native_session_id: threadId,
        started_at: new Date(timestamp).toISOString(),
        cwd: wd,
      }));
      await writeFile(projectDedupePath, JSON.stringify({
        recent_turns: { [key]: timestamp },
        turn_claims: {
          [key]: {
            timestamp,
            delivery: 'allow',
            source_kind: 'native',
            source: 'native-notify',
            session_id: sessionId,
            audience: 'external-owner',
            reason: 'current_external_owner',
          },
        },
        last_event_at: new Date(timestamp).toISOString(),
      }));
      await writeFile(fallbackDedupePath, JSON.stringify({
        recent_turns: { [key]: timestamp },
        turn_claims: {
          [key]: {
            timestamp,
            delivery: 'suppress',
            source_kind: 'native',
            source: 'native-subagent',
            session_id: 'omx-stale-suppressed-helper-fallback',
            audience: 'child',
            reason: 'tracked_subagent_lineage',
          },
        },
        last_event_at: new Date(timestamp).toISOString(),
      }));

      const suppressedDuplicate = runNotifyHook({
        cwd: wd,
        session_id: 'native-session-fallback-stale-suppress-helper-repair',
        origin: { kind: 'native-subagent', parent_thread_id: threadId },
        type: 'agent-turn-complete',
        thread_id: threadId,
        turn_id: turnId,
        input_messages: ['helper echo'],
        last_assistant_message: 'fallback stale suppress helper repair output',
      }, { OMX_SESSION_ID: sessionId });
      assert.equal(suppressedDuplicate.status, 0, suppressedDuplicate.stderr || suppressedDuplicate.stdout);

      let fallbackState = JSON.parse(
        await readFile(fallbackDedupePath, 'utf-8'),
      ) as { turn_claims?: Record<string, { delivery?: string; source_kind?: string }> };
      assert.equal(fallbackState.turn_claims?.[key]?.delivery, 'allow');
      assert.equal(fallbackState.turn_claims?.[key]?.source_kind, 'native');

      await rm(projectDedupePath, { force: true });
      const ownerRetry = runNotifyHook({
        cwd: wd,
        session_id: 'native-session-fallback-stale-suppress-helper-repair',
        origin: { kind: 'leader', thread_id: threadId },
        type: 'agent-turn-complete',
        thread_id: threadId,
        turn_id: turnId,
        input_messages: ['owner retry'],
        last_assistant_message: 'fallback stale suppress helper repair owner retry output',
      }, { OMX_SESSION_ID: sessionId });
      assert.equal(ownerRetry.status, 0, ownerRetry.stderr || ownerRetry.stdout);

      const notifyLog = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'notify-hook-');
      assert.equal(
        notifyLog.filter((entry) =>
          entry.type === 'completed_turn_delivery_allowed'
          && entry.turn_id === turnId
        ).length,
        0,
      );
      assert.equal(
        notifyLog.some((entry) =>
          entry.type === 'turn_duplicate_suppressed'
          && entry.scope === 'project_fallback'
          && entry.turn_id === turnId
        ),
        true,
      );
      fallbackState = JSON.parse(
        await readFile(fallbackDedupePath, 'utf-8'),
      ) as { turn_claims?: Record<string, { delivery?: string }> };
      assert.equal(fallbackState.turn_claims?.[key]?.delivery, 'allow');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not poison recovered project dedupe with suppressed replay claims', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-project-replay-suppressed-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const firstSessionId = 'omx-project-replay-suppressed-first';
      const secondSessionId = 'omx-project-replay-suppressed-second';
      const thirdSessionId = 'omx-project-replay-suppressed-third';
      const threadId = 'native-thread-project-replay-suppressed';
      const turnId = 'native-turn-project-replay-suppressed';
      const timestamp = Date.now();
      await mkdir(join(stateDir, 'sessions', firstSessionId), { recursive: true });
      await mkdir(join(stateDir, 'sessions', secondSessionId), { recursive: true });
      await mkdir(join(stateDir, 'sessions', thirdSessionId), { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: firstSessionId,
        native_session_id: threadId,
        started_at: new Date(timestamp).toISOString(),
        cwd: wd,
      }));
      await mkdir(join(stateDir, 'notify-hook-turn-dedupe.json'));

      const payload = {
        cwd: wd,
        session_id: 'native-session-project-replay-suppressed',
        origin: { kind: 'leader', thread_id: threadId },
        type: 'agent-turn-complete',
        thread_id: threadId,
        turn_id: turnId,
        input_messages: ['hello'],
        last_assistant_message: 'project replay suppressed output',
      };

      const first = runNotifyHook(payload, { OMX_SESSION_ID: firstSessionId });
      assert.equal(first.status, 0, first.stderr || first.stdout);
      await rm(join(stateDir, 'notify-hook-turn-dedupe.json'), { recursive: true, force: true });

      const suppressed = runNotifyHook({
        ...payload,
        origin: { kind: 'native-subagent', parent_thread_id: threadId },
        input_messages: ['helper echo'],
      }, { OMX_SESSION_ID: secondSessionId });
      assert.equal(suppressed.status, 0, suppressed.stderr || suppressed.stdout);

      const third = runNotifyHook({
        ...payload,
        input_messages: ['hello again'],
      }, { OMX_SESSION_ID: thirdSessionId });
      assert.equal(third.status, 0, third.stderr || third.stdout);

      const turns = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'turns-');
      assert.equal(turns.length, 1);
      assert.equal(turns[0].turn_id, turnId);
      const notifyLog = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'notify-hook-');
      assert.equal(
        notifyLog.filter((entry) =>
          entry.type === 'turn_duplicate_suppressed'
          && entry.scope === 'project_fallback'
          && entry.turn_id === turnId
        ).length,
        2,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not let same-session suppressed turns poison a later owner delivery', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-session-suppressed-owner-retry-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'omx-session-suppressed-owner-retry';
      const threadId = 'native-thread-session-suppressed-owner-retry';
      const turnId = 'native-turn-session-suppressed-owner-retry';
      const key = `${threadId}|${turnId}|agent-turn-complete`;
      const timestamp = Date.now();
      const projectDedupePath = join(stateDir, 'notify-hook-turn-dedupe.json');
      const sessionDedupePath = join(stateDir, 'sessions', sessionId, 'notify-hook-state.json');
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        native_session_id: threadId,
        started_at: new Date(timestamp).toISOString(),
        cwd: wd,
      }));

      const basePayload = {
        cwd: wd,
        session_id: 'native-session-session-suppressed-owner-retry',
        type: 'agent-turn-complete',
        thread_id: threadId,
        turn_id: turnId,
        last_assistant_message: 'session suppressed owner retry output',
      };
      const suppressed = runNotifyHook({
        ...basePayload,
        origin: { kind: 'native-subagent', parent_thread_id: threadId },
        input_messages: ['helper echo'],
      }, { OMX_SESSION_ID: sessionId });
      assert.equal(suppressed.status, 0, suppressed.stderr || suppressed.stdout);

      const owner = runNotifyHook({
        ...basePayload,
        origin: { kind: 'leader', thread_id: threadId },
        input_messages: ['owner retry after suppressed helper'],
      }, { OMX_SESSION_ID: sessionId });
      assert.equal(owner.status, 0, owner.stderr || owner.stdout);

      const notifyLog = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'notify-hook-');
      assert.equal(
        notifyLog.filter((entry) =>
          entry.type === 'completed_turn_delivery_allowed'
          && entry.turn_id === turnId
        ).length,
        1,
      );
      assert.equal(
        notifyLog.some((entry) =>
          entry.type === 'session_turn_dedupe_recovered_before_delivery'
          && entry.turn_id === turnId
          && entry.recovered === true
        ),
        true,
      );
      assert.equal(
        notifyLog.some((entry) =>
          entry.type === 'project_turn_dedupe_rolled_back'
          && entry.turn_id === turnId
          && entry.reason === 'session_turn_dedupe_duplicate_before_delivery'
        ),
        false,
      );
      const projectState = JSON.parse(
        await readFile(projectDedupePath, 'utf-8'),
      ) as { turn_claims?: Record<string, { delivery?: string }> };
      assert.equal(projectState.turn_claims?.[key]?.delivery, 'allow');
      const sessionState = JSON.parse(
        await readFile(sessionDedupePath, 'utf-8'),
      ) as { recent_turns?: Record<string, unknown> };
      assert.equal(Boolean(sessionState.recent_turns?.[key]), true);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('fails closed when recovered project dedupe cannot replay fallback state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-project-replay-locked-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const firstSessionId = 'omx-project-replay-locked-first';
      const secondSessionId = 'omx-project-replay-locked-second';
      await mkdir(join(stateDir, 'sessions', firstSessionId), { recursive: true });
      await mkdir(join(stateDir, 'sessions', secondSessionId), { recursive: true });
      await mkdir(join(stateDir, 'notify-hook-turn-dedupe.json'));

      const payload = {
        cwd: wd,
        session_id: 'native-session-project-replay-locked',
        type: 'agent-turn-complete',
        thread_id: 'native-thread-project-replay-locked',
        turn_id: 'native-turn-project-replay-locked',
        input_messages: ['hello'],
        last_assistant_message: 'project replay locked output',
      };

      const first = runNotifyHook(payload, { OMX_SESSION_ID: firstSessionId });
      assert.equal(first.status, 0, first.stderr || first.stdout);
      await rm(join(stateDir, 'notify-hook-turn-dedupe.json'), { recursive: true, force: true });
      await writeFile(join(stateDir, 'notify-hook-state.json.lock'), 'fresh-fallback-lock');

      const second = runNotifyHook({
        ...payload,
        input_messages: ['hello again'],
      }, { OMX_SESSION_ID: secondSessionId });
      assert.equal(second.status, 0, second.stderr || second.stdout);

      const turns = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'turns-');
      assert.equal(turns.length, 1);
      assert.equal(turns[0].turn_id, 'native-turn-project-replay-locked');
      const notifyLog = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'notify-hook-');
      assert.equal(
        notifyLog.some((entry) =>
          entry.type === 'project_fallback_turn_dedupe_replay_failed'
          && entry.turn_id === 'native-turn-project-replay-locked'
          && entry.fallback_state_exists === true
        ),
        true,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('continues with healthy primary dedupe when fallback replay state is malformed', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-project-fallback-malformed-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'omx-project-fallback-malformed';
      const threadId = 'native-thread-project-fallback-malformed';
      const turnId = 'native-turn-project-fallback-malformed';
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      await writeFile(join(stateDir, 'notify-hook-state.json'), '{not valid json');

      const result = runNotifyHook({
        cwd: wd,
        session_id: 'native-session-project-fallback-malformed',
        type: 'agent-turn-complete',
        thread_id: threadId,
        turn_id: turnId,
        input_messages: ['hello'],
        last_assistant_message: 'project fallback malformed output',
      }, { OMX_SESSION_ID: sessionId });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const turns = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'turns-');
      assert.equal(turns.length, 1);
      assert.equal(turns[0].turn_id, turnId);
      const notifyLog = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'notify-hook-');
      assert.equal(
        notifyLog.some((entry) =>
          entry.type === 'project_fallback_turn_dedupe_replay_failed'
          && entry.turn_id === turnId
          && entry.phase === 'before_project'
        ),
        true,
      );
      const projectState = JSON.parse(
        await readFile(join(stateDir, 'notify-hook-turn-dedupe.json'), 'utf-8'),
      ) as {
        recent_turns?: Record<string, unknown>;
        turn_claims?: Record<string, unknown>;
      };
      const key = `${threadId}|${turnId}|agent-turn-complete`;
      assert.equal(Boolean(projectState.recent_turns?.[key]), true);
      assert.equal(Boolean(projectState.turn_claims?.[key]), true);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('fails closed when only the primary project dedupe lock is active', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-project-dedupe-locked-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'omx-project-dedupe-locked-session';
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      await writeFile(join(stateDir, 'notify-hook-turn-dedupe.lock'), 'fresh-project-lock');

      const result = runNotifyHook({
        cwd: wd,
        session_id: 'native-session-project-dedupe-locked',
        type: 'agent-turn-complete',
        thread_id: 'native-thread-project-dedupe-locked',
        turn_id: 'native-turn-project-dedupe-locked',
        input_messages: ['hello'],
        last_assistant_message: 'project dedupe locked output',
      }, { OMX_SESSION_ID: sessionId });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const notifyLog = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'notify-hook-');
      assert.equal(
        notifyLog.some((entry) =>
          entry.type === 'project_turn_dedupe_failed'
          && entry.turn_id === 'native-turn-project-dedupe-locked'
          && String(entry.error || '').includes('state file lock timeout')
        ),
        true,
      );
      assert.deepEqual(await readJsonLogFiles(join(wd, '.omx', 'logs'), 'turns-'), []);
      assert.equal(existsSync(join(stateDir, 'notify-hook-state.json')), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('suppresses a primary writer when a fallback allow claim appears before the post-write check', async (t) => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-primary-post-fallback-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'omx-primary-post-fallback';
      const threadId = 'native-thread-primary-post-fallback';
      const turnId = 'native-turn-primary-post-fallback';
      const key = `${threadId}|${turnId}|agent-turn-complete`;
      const timestamp = Date.now();
      const projectDedupePath = join(stateDir, 'notify-hook-turn-dedupe.json');
      const fallbackDedupePath = join(stateDir, 'notify-hook-state.json');
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        native_session_id: threadId,
        started_at: new Date(timestamp).toISOString(),
        cwd: wd,
      }));

      const fallbackAppearsDuringPrimaryWrite = replaceFifoWithMissingAfterRead(
        t,
        projectDedupePath,
        {
          recent_turns: {},
          turn_claims: {},
          last_event_at: '',
        },
        fallbackDedupePath,
        {
          recent_turns: { [key]: timestamp },
          turn_claims: {
            [key]: {
              timestamp,
              delivery: 'allow',
              source_kind: 'fallback',
              source: 'notify-fallback-watcher',
              session_id: 'omx-earlier-primary-post-fallback',
              audience: 'external-owner',
              reason: 'test-post-primary-fallback-race',
            },
          },
          last_event_at: new Date(timestamp).toISOString(),
        },
      );
      if (!fallbackAppearsDuringPrimaryWrite) return;

      const result = runNotifyHook({
        cwd: wd,
        session_id: 'native-session-primary-post-fallback',
        origin: { kind: 'leader', thread_id: threadId },
        type: 'agent-turn-complete',
        thread_id: threadId,
        turn_id: turnId,
        input_messages: ['hello'],
        last_assistant_message: 'primary post fallback race output',
      }, { OMX_SESSION_ID: sessionId });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      await fallbackAppearsDuringPrimaryWrite;

      const notifyLog = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'notify-hook-');
      assert.equal(
        notifyLog.some((entry) =>
          entry.type === 'project_fallback_turn_dedupe_primary_won_race'
          && entry.turn_id === turnId
        ),
        true,
      );
      const turns = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'turns-');
      assert.equal(turns.length, 1);
      assert.equal(turns[0].turn_id, turnId);
      assert.equal(
        notifyLog.filter((entry) => entry.type === 'completed_turn_delivery_allowed' && entry.turn_id === turnId).length,
        1,
      );
      assert.equal(
        notifyLog.some((entry) =>
          entry.type === 'completed_turn_duplicate_suppressed'
          && entry.turn_id === turnId
        ),
        false,
      );
      assert.equal(
        notifyLog.some((entry) =>
          entry.type === 'project_fallback_turn_dedupe_allow_claim_recovered_before_delivery'
          && entry.turn_id === turnId
          && entry.phase === 'after_project'
        ),
        true,
      );
      const projectState = JSON.parse(
        await readFile(projectDedupePath, 'utf-8'),
      ) as { recent_turns?: Record<string, unknown> };
      assert.equal(Boolean(projectState.recent_turns?.[key]), true);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('suppresses a primary writer when a closed fallback claim appears before the post-write check', async (t) => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-primary-post-fallback-closed-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'omx-primary-post-fallback-closed';
      const threadId = 'native-thread-primary-post-fallback-closed';
      const turnId = 'native-turn-primary-post-fallback-closed';
      const key = `${threadId}|${turnId}|agent-turn-complete`;
      const timestamp = Date.now();
      const projectDedupePath = join(stateDir, 'notify-hook-turn-dedupe.json');
      const fallbackDedupePath = join(stateDir, 'notify-hook-state.json');
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        native_session_id: threadId,
        started_at: new Date(timestamp).toISOString(),
        cwd: wd,
      }));

      const fallbackAppearsDuringPrimaryWrite = replaceFifoWithMissingAfterRead(
        t,
        projectDedupePath,
        {
          recent_turns: {},
          turn_claims: {},
          last_event_at: '',
        },
        fallbackDedupePath,
        {
          recent_turns: { [key]: timestamp },
          turn_claims: {
            [key]: {
              timestamp,
              delivery: 'allow',
              delivery_status: 'sent',
              delivery_status_at: timestamp,
              source_kind: 'fallback',
              source: 'notify-fallback-watcher',
              session_id: 'omx-earlier-primary-post-fallback-closed',
              audience: 'external-owner',
              reason: 'test-post-primary-fallback-closed-race',
            },
          },
          last_event_at: new Date(timestamp).toISOString(),
        },
      );
      if (!fallbackAppearsDuringPrimaryWrite) return;

      const result = runNotifyHook({
        cwd: wd,
        session_id: 'native-session-primary-post-fallback-closed',
        origin: { kind: 'leader', thread_id: threadId },
        type: 'agent-turn-complete',
        thread_id: threadId,
        turn_id: turnId,
        input_messages: ['hello'],
        last_assistant_message: 'primary post closed fallback race output',
      }, { OMX_SESSION_ID: sessionId });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      await fallbackAppearsDuringPrimaryWrite;

      const notifyLog = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'notify-hook-');
      assert.equal(
        notifyLog.some((entry) =>
          entry.type === 'project_fallback_turn_dedupe_primary_won_race'
          && entry.turn_id === turnId
          && entry.fallback_delivery_closed === true
        ),
        true,
      );
      assert.equal(
        notifyLog.some((entry) =>
          entry.type === 'completed_turn_delivery_allowed'
          && entry.turn_id === turnId
        ),
        false,
      );
      assert.equal(
        notifyLog.some((entry) =>
          entry.type === 'completed_turn_duplicate_suppressed'
          && entry.turn_id === turnId
        ),
        true,
      );
      const fallbackState = JSON.parse(
        await readFile(fallbackDedupePath, 'utf-8'),
      ) as { turn_claims?: Record<string, { delivery_status?: string }> };
      assert.equal(fallbackState.turn_claims?.[key]?.delivery_status, 'sent');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('upgrades post-primary fallback suppress claims only after delivery is allowed', async (t) => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-primary-post-fallback-upgrade-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'omx-primary-post-fallback-upgrade';
      const threadId = 'native-thread-primary-post-fallback-upgrade';
      const turnId = 'native-turn-primary-post-fallback-upgrade';
      const key = `${threadId}|${turnId}|agent-turn-complete`;
      const timestamp = Date.now();
      const projectDedupePath = join(stateDir, 'notify-hook-turn-dedupe.json');
      const fallbackDedupePath = join(stateDir, 'notify-hook-state.json');
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        native_session_id: threadId,
        started_at: new Date(timestamp).toISOString(),
        cwd: wd,
      }));

      const fallbackState = {
        recent_turns: { [key]: timestamp },
        turn_claims: {
          [key]: {
            timestamp,
            delivery: 'suppress',
            source_kind: 'native',
            source: 'native-subagent',
            session_id: 'omx-suppressed-post-primary-fallback',
            audience: 'child',
            reason: 'tracked_subagent_lineage',
          },
        },
        last_event_at: new Date(timestamp).toISOString(),
      };
      const fallbackAppearsDuringPrimaryWrite = replaceFifoWithMissingAfterRead(
        t,
        projectDedupePath,
        {
          recent_turns: {},
          turn_claims: {},
          last_event_at: '',
        },
        fallbackDedupePath,
        fallbackState,
      );
      if (!fallbackAppearsDuringPrimaryWrite) return;

      const payload = {
        cwd: wd,
        session_id: 'native-session-primary-post-fallback-upgrade',
        origin: { kind: 'leader', thread_id: threadId },
        type: 'agent-turn-complete',
        thread_id: threadId,
        turn_id: turnId,
        input_messages: ['hello'],
        last_assistant_message: 'primary post fallback upgrade output',
      };
      const first = runNotifyHook(payload, { OMX_SESSION_ID: sessionId });
      assert.equal(first.status, 0, first.stderr || first.stdout);
      await fallbackAppearsDuringPrimaryWrite;

      const firstNotifyLog = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'notify-hook-');
      assert.equal(
        firstNotifyLog.filter((entry) =>
          entry.type === 'completed_turn_delivery_allowed'
          && entry.turn_id === turnId
        ).length,
        1,
      );
      assert.equal(
        firstNotifyLog.some((entry) =>
          entry.type === 'project_fallback_turn_dedupe_upgraded'
          && entry.turn_id === turnId
          && entry.upgraded === true
        ),
        true,
      );
      let fallbackStateAfterFirst = JSON.parse(
        await readFile(fallbackDedupePath, 'utf-8'),
      ) as { turn_claims?: Record<string, { delivery?: string; source_kind?: string }> };
      assert.equal(fallbackStateAfterFirst.turn_claims?.[key]?.delivery, 'allow');
      assert.equal(fallbackStateAfterFirst.turn_claims?.[key]?.source_kind, 'native');

      await rm(projectDedupePath, { recursive: true, force: true });
      const retry = runNotifyHook({
        ...payload,
        input_messages: ['hello retry'],
      }, { OMX_SESSION_ID: sessionId });
      assert.equal(retry.status, 0, retry.stderr || retry.stdout);

      const notifyLog = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'notify-hook-');
      assert.equal(
        notifyLog.filter((entry) =>
          entry.type === 'completed_turn_delivery_allowed'
          && entry.turn_id === turnId
        ).length,
        1,
      );
      assert.equal(
        notifyLog.some((entry) =>
          entry.type === 'turn_duplicate_suppressed'
          && entry.scope === 'project_fallback'
          && entry.turn_id === turnId
        ),
        true,
      );
      fallbackStateAfterFirst = JSON.parse(
        await readFile(fallbackDedupePath, 'utf-8'),
      ) as { turn_claims?: Record<string, { delivery?: string; source_kind?: string }> };
      assert.equal(fallbackStateAfterFirst.turn_claims?.[key]?.delivery, 'allow');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('suppresses a fallback writer when a primary claim appears before the degraded post-write check', async (t) => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-fallback-post-primary-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'omx-fallback-post-primary';
      const threadId = 'native-thread-fallback-post-primary';
      const turnId = 'native-turn-fallback-post-primary';
      const key = `${threadId}|${turnId}|agent-turn-complete`;
      const timestamp = Date.now();
      const projectDedupePath = join(stateDir, 'notify-hook-turn-dedupe.json');
      const fallbackDedupePath = join(stateDir, 'notify-hook-state.json');
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });

      const primaryAppearsDuringFallbackWrite = replacePrimaryFifoWithDirectoryThenFallbackFifoCreatesPrimary(
        t,
        projectDedupePath,
        {
          recent_turns: {},
          turn_claims: {},
          last_event_at: '',
        },
        fallbackDedupePath,
        {
          recent_turns: {},
          turn_claims: {},
          last_event_at: '',
        },
        {
          recent_turns: { [key]: timestamp },
          turn_claims: {
            [key]: {
              timestamp,
              delivery: 'allow',
              source_kind: 'native',
              source: 'native-notify',
              session_id: 'omx-earlier-fallback-post-primary',
              audience: 'external-owner',
              reason: 'test-post-fallback-primary-race',
            },
          },
          last_event_at: new Date(timestamp).toISOString(),
        },
      );
      if (!primaryAppearsDuringFallbackWrite) return;

      const result = runNotifyHook({
        cwd: wd,
        session_id: 'native-session-fallback-post-primary',
        type: 'agent-turn-complete',
        thread_id: threadId,
        turn_id: turnId,
        input_messages: ['hello'],
        last_assistant_message: 'fallback post primary race output',
      }, { OMX_SESSION_ID: sessionId });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      await primaryAppearsDuringFallbackWrite;

      const notifyLog = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'notify-hook-');
      assert.equal(
        notifyLog.some((entry) =>
          entry.type === 'project_turn_dedupe_write_failed'
          && entry.turn_id === turnId
          && entry.decision_reason === 'first'
        ),
        true,
      );
      assert.equal(
        notifyLog.some((entry) =>
          entry.type === 'turn_duplicate_suppressed'
          && entry.scope === 'project'
          && entry.turn_id === turnId
        ),
        true,
      );
      assert.deepEqual(await readJsonLogFiles(join(wd, '.omx', 'logs'), 'turns-'), []);
      const fallbackState = JSON.parse(
        await readFile(fallbackDedupePath, 'utf-8'),
      ) as { recent_turns?: Record<string, unknown> };
      assert.equal(Boolean(fallbackState.recent_turns?.[key]), true);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('repairs degraded fallback suppress claims when a primary allow claim wins the race', async (t) => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-fallback-suppress-post-primary-repair-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'omx-fallback-suppress-post-primary-repair';
      const threadId = 'native-thread-fallback-suppress-post-primary-repair';
      const turnId = 'native-turn-fallback-suppress-post-primary-repair';
      const key = `${threadId}|${turnId}|agent-turn-complete`;
      const timestamp = Date.now();
      const projectDedupePath = join(stateDir, 'notify-hook-turn-dedupe.json');
      const fallbackDedupePath = join(stateDir, 'notify-hook-state.json');
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        native_session_id: threadId,
        started_at: new Date(timestamp).toISOString(),
        cwd: wd,
      }));

      const primaryAppearsDuringFallbackWrite = replacePrimaryFifoWithDirectoryThenFallbackFifoCreatesPrimary(
        t,
        projectDedupePath,
        {
          recent_turns: {},
          turn_claims: {},
          last_event_at: '',
        },
        fallbackDedupePath,
        {
          recent_turns: {},
          turn_claims: {},
          last_event_at: '',
        },
        {
          recent_turns: { [key]: timestamp },
          turn_claims: {
            [key]: {
              timestamp,
              delivery: 'allow',
              source_kind: 'native',
              source: 'native-notify',
              session_id: 'omx-primary-allow-winner',
              audience: 'external-owner',
              reason: 'current_external_owner',
            },
          },
          last_event_at: new Date(timestamp).toISOString(),
        },
      );
      if (!primaryAppearsDuringFallbackWrite) return;

      const suppressed = runNotifyHook({
        cwd: wd,
        session_id: 'native-session-fallback-suppress-post-primary-repair',
        origin: { kind: 'native-subagent', parent_thread_id: threadId },
        type: 'agent-turn-complete',
        thread_id: threadId,
        turn_id: turnId,
        input_messages: ['helper echo'],
        last_assistant_message: 'fallback suppress post primary repair output',
      }, { OMX_SESSION_ID: sessionId });
      assert.equal(suppressed.status, 0, suppressed.stderr || suppressed.stdout);
      await primaryAppearsDuringFallbackWrite;

      let fallbackState = JSON.parse(
        await readFile(fallbackDedupePath, 'utf-8'),
      ) as { turn_claims?: Record<string, { delivery?: string; source_kind?: string }> };
      assert.equal(fallbackState.turn_claims?.[key]?.delivery, 'allow');
      assert.equal(fallbackState.turn_claims?.[key]?.source_kind, 'native');

      await rm(projectDedupePath, { recursive: true, force: true });
      const ownerRetry = runNotifyHook({
        cwd: wd,
        session_id: 'native-session-fallback-suppress-post-primary-repair',
        origin: { kind: 'leader', thread_id: threadId },
        type: 'agent-turn-complete',
        thread_id: threadId,
        turn_id: turnId,
        input_messages: ['owner retry'],
        last_assistant_message: 'fallback suppress post primary repair owner retry output',
      }, { OMX_SESSION_ID: sessionId });
      assert.equal(ownerRetry.status, 0, ownerRetry.stderr || ownerRetry.stdout);

      const notifyLog = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'notify-hook-');
      assert.equal(
        notifyLog.filter((entry) =>
          entry.type === 'completed_turn_delivery_allowed'
          && entry.turn_id === turnId
        ).length,
        0,
      );
      assert.equal(
        notifyLog.some((entry) =>
          entry.type === 'turn_duplicate_suppressed'
          && entry.scope === 'project_fallback'
          && entry.turn_id === turnId
        ),
        true,
      );
      fallbackState = JSON.parse(
        await readFile(fallbackDedupePath, 'utf-8'),
      ) as { turn_claims?: Record<string, { delivery?: string }> };
      assert.equal(fallbackState.turn_claims?.[key]?.delivery, 'allow');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves root project fallback turn claims when no session scope exists', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-root-fallback-turn-claims-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const existingKey = 'existing-thread|existing-turn|agent-turn-complete';
      const timestamp = Date.now();
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, 'notify-hook-state.json'), JSON.stringify({
        recent_turns: { [existingKey]: timestamp },
        turn_claims: {
          [existingKey]: {
            timestamp,
            delivery: 'allow',
            source_kind: 'fallback',
            source: 'notify-fallback-watcher',
            session_id: 'omx-existing-root-fallback',
            audience: 'external-owner',
            reason: 'preexisting-root-fallback-claim',
          },
        },
        last_event_at: new Date(timestamp).toISOString(),
      }));

      const result = runNotifyHook({
        cwd: wd,
        session_id: 'native-session-root-fallback-turn-claims',
        type: 'agent-turn-complete',
        thread_id: 'native-thread-root-fallback-turn-claims',
        turn_id: 'native-turn-root-fallback-turn-claims',
        input_messages: ['hello'],
        last_assistant_message: 'root fallback turn claims output',
      }, { OMX_SESSION_ID: 'missing-session-scope' });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const rootFallbackState = JSON.parse(
        await readFile(join(stateDir, 'notify-hook-state.json'), 'utf-8'),
      ) as {
        recent_turns?: Record<string, unknown>;
        turn_claims?: Record<string, unknown>;
      };
      assert.equal(Boolean(rootFallbackState.recent_turns?.[existingKey]), true);
      assert.equal(Boolean(rootFallbackState.turn_claims?.[existingKey]), true);
      assert.equal(
        Boolean(rootFallbackState.recent_turns?.[
          'native-thread-root-fallback-turn-claims|native-turn-root-fallback-turn-claims|agent-turn-complete'
        ]),
        false,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rolls back a first primary claim when fallback post-write check times out', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-primary-fallback-lock-rollback-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'omx-primary-fallback-lock-rollback';
      const threadId = 'native-thread-primary-fallback-lock-rollback';
      const turnId = 'native-turn-primary-fallback-lock-rollback';
      const key = `${threadId}|${turnId}|agent-turn-complete`;
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      await writeFile(join(stateDir, 'notify-hook-state.json.lock'), 'fresh-fallback-lock');

      const first = runNotifyHook({
        cwd: wd,
        session_id: 'native-session-primary-fallback-lock-rollback',
        type: 'agent-turn-complete',
        thread_id: threadId,
        turn_id: turnId,
        input_messages: ['hello'],
        last_assistant_message: 'primary fallback lock rollback output',
      }, { OMX_SESSION_ID: sessionId });
      assert.equal(first.status, 0, first.stderr || first.stdout);

      assert.deepEqual(await readJsonLogFiles(join(wd, '.omx', 'logs'), 'turns-'), []);
      const firstNotifyLog = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'notify-hook-');
      assert.equal(
        firstNotifyLog.some((entry) =>
          entry.type === 'project_turn_dedupe_rolled_back'
          && entry.turn_id === turnId
          && entry.rolled_back === true
        ),
        true,
      );
      const rolledBackProjectState = JSON.parse(
        await readFile(join(stateDir, 'notify-hook-turn-dedupe.json'), 'utf-8'),
      ) as { recent_turns?: Record<string, unknown>; turn_claims?: Record<string, unknown> };
      assert.equal(Boolean(rolledBackProjectState.recent_turns?.[key]), false);
      assert.equal(Boolean(rolledBackProjectState.turn_claims?.[key]), false);

      await rm(join(stateDir, 'notify-hook-state.json.lock'), { force: true });
      const retry = runNotifyHook({
        cwd: wd,
        session_id: 'native-session-primary-fallback-lock-rollback',
        type: 'agent-turn-complete',
        thread_id: threadId,
        turn_id: turnId,
        input_messages: ['hello retry'],
        last_assistant_message: 'primary fallback lock rollback output retry',
      }, { OMX_SESSION_ID: sessionId });
      assert.equal(retry.status, 0, retry.stderr || retry.stdout);

      const turns = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'turns-');
      assert.equal(turns.length, 1);
      assert.equal(turns[0].turn_id, turnId);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('restores a primary owner-upgrade when fallback post-write check times out', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-primary-owner-fallback-lock-rollback-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'omx-primary-owner-fallback-lock-rollback';
      const threadId = 'native-thread-primary-owner-fallback-lock-rollback';
      const turnId = 'native-turn-primary-owner-fallback-lock-rollback';
      const key = `${threadId}|${turnId}|agent-turn-complete`;
      const timestamp = Date.now();
      const projectDedupePath = join(stateDir, 'notify-hook-turn-dedupe.json');
      const fallbackLockPath = join(stateDir, 'notify-hook-state.json.lock');
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        native_session_id: threadId,
        started_at: new Date(timestamp).toISOString(),
        cwd: wd,
      }));
      await writeFile(projectDedupePath, JSON.stringify({
        recent_turns: { [key]: timestamp },
        turn_claims: {
          [key]: {
            timestamp,
            delivery: 'suppress',
            source_kind: 'native',
            source: 'native-subagent',
            session_id: 'omx-suppressed-primary-owner-fallback-lock',
            audience: 'child',
            reason: 'tracked_subagent_lineage',
          },
        },
        last_event_at: new Date(timestamp).toISOString(),
      }));
      await writeFile(fallbackLockPath, 'fresh-fallback-lock');

      const payload = {
        cwd: wd,
        session_id: 'native-session-primary-owner-fallback-lock-rollback',
        origin: { kind: 'leader', thread_id: threadId },
        type: 'agent-turn-complete',
        thread_id: threadId,
        turn_id: turnId,
        input_messages: ['hello'],
        last_assistant_message: 'primary owner fallback lock rollback output',
      };
      const first = runNotifyHook(payload, { OMX_SESSION_ID: sessionId });
      assert.equal(first.status, 0, first.stderr || first.stdout);

      assert.deepEqual(await readJsonLogFiles(join(wd, '.omx', 'logs'), 'turns-'), []);
      const firstNotifyLog = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'notify-hook-');
      assert.equal(
        firstNotifyLog.some((entry) =>
          entry.type === 'project_turn_dedupe_rolled_back'
          && entry.turn_id === turnId
          && entry.rollback_mode === 'restore_previous_claim'
          && entry.rolled_back === true
        ),
        true,
      );
      let projectState = JSON.parse(
        await readFile(projectDedupePath, 'utf-8'),
      ) as { turn_claims?: Record<string, { delivery?: string; source_kind?: string }> };
      assert.equal(projectState.turn_claims?.[key]?.delivery, 'suppress');
      assert.equal(projectState.turn_claims?.[key]?.source_kind, 'native');

      await rm(fallbackLockPath, { force: true });
      const retry = runNotifyHook({
        ...payload,
        input_messages: ['hello retry'],
      }, { OMX_SESSION_ID: sessionId });
      assert.equal(retry.status, 0, retry.stderr || retry.stdout);

      const turns = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'turns-');
      assert.equal(turns.length, 1);
      assert.equal(turns[0].turn_id, turnId);
      projectState = JSON.parse(
        await readFile(projectDedupePath, 'utf-8'),
      ) as { turn_claims?: Record<string, { delivery?: string; source_kind?: string }> };
      assert.equal(projectState.turn_claims?.[key]?.delivery, 'allow');
      assert.equal(projectState.turn_claims?.[key]?.source_kind, 'native');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rolls back a degraded fallback claim when primary replay times out before delivery', async (t) => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-fallback-primary-lock-rollback-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'omx-fallback-primary-lock-rollback';
      const threadId = 'native-thread-fallback-primary-lock-rollback';
      const turnId = 'native-turn-fallback-primary-lock-rollback';
      const key = `${threadId}|${turnId}|agent-turn-complete`;
      const projectDedupePath = join(stateDir, 'notify-hook-turn-dedupe.json');
      const fallbackDedupePath = join(stateDir, 'notify-hook-state.json');
      const primaryLockPath = join(stateDir, 'notify-hook-turn-dedupe.lock');
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });

      const primaryReplayFailure = replacePrimaryFifoWithDirectoryThenFallbackFifoCreatesPrimaryLock(
        t,
        projectDedupePath,
        {
          recent_turns: {},
          turn_claims: {},
          last_event_at: '',
        },
        fallbackDedupePath,
        {
          recent_turns: {},
          turn_claims: {},
          last_event_at: '',
        },
        primaryLockPath,
      );
      if (!primaryReplayFailure) return;

      const first = runNotifyHook({
        cwd: wd,
        session_id: 'native-session-fallback-primary-lock-rollback',
        type: 'agent-turn-complete',
        thread_id: threadId,
        turn_id: turnId,
        input_messages: ['hello'],
        last_assistant_message: 'fallback primary lock rollback output',
      }, { OMX_SESSION_ID: sessionId });
      assert.equal(first.status, 0, first.stderr || first.stdout);
      await primaryReplayFailure;

      assert.deepEqual(await readJsonLogFiles(join(wd, '.omx', 'logs'), 'turns-'), []);
      const firstNotifyLog = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'notify-hook-');
      assert.equal(
        firstNotifyLog.some((entry) =>
          entry.type === 'project_fallback_turn_dedupe_rolled_back'
          && entry.turn_id === turnId
          && entry.rolled_back === true
        ),
        true,
      );
      const rolledBackFallbackState = JSON.parse(
        await readFile(fallbackDedupePath, 'utf-8'),
      ) as { recent_turns?: Record<string, unknown>; turn_claims?: Record<string, unknown> };
      assert.equal(Boolean(rolledBackFallbackState.recent_turns?.[key]), false);
      assert.equal(Boolean(rolledBackFallbackState.turn_claims?.[key]), false);

      await rm(primaryLockPath, { force: true });
      await rm(projectDedupePath, { recursive: true, force: true });
      const retry = runNotifyHook({
        cwd: wd,
        session_id: 'native-session-fallback-primary-lock-rollback',
        type: 'agent-turn-complete',
        thread_id: threadId,
        turn_id: turnId,
        input_messages: ['hello retry'],
        last_assistant_message: 'fallback primary lock rollback output retry',
      }, { OMX_SESSION_ID: sessionId });
      assert.equal(retry.status, 0, retry.stderr || retry.stdout);

      const turns = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'turns-');
      assert.equal(turns.length, 1);
      assert.equal(turns[0].turn_id, turnId);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not persist degraded fallback owner-upgrades before primary replay succeeds', async (t) => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-fallback-owner-primary-lock-rollback-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'omx-fallback-owner-primary-lock-rollback';
      const threadId = 'native-thread-fallback-owner-primary-lock-rollback';
      const turnId = 'native-turn-fallback-owner-primary-lock-rollback';
      const key = `${threadId}|${turnId}|agent-turn-complete`;
      const timestamp = Date.now();
      const projectDedupePath = join(stateDir, 'notify-hook-turn-dedupe.json');
      const fallbackDedupePath = join(stateDir, 'notify-hook-state.json');
      const primaryLockPath = join(stateDir, 'notify-hook-turn-dedupe.lock');
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        native_session_id: threadId,
        started_at: new Date(timestamp).toISOString(),
        cwd: wd,
      }));
      const fallbackSuppressState = {
        recent_turns: { [key]: timestamp },
        turn_claims: {
          [key]: {
            timestamp,
            delivery: 'suppress',
            source_kind: 'native',
            source: 'native-subagent',
            session_id: 'omx-suppressed-fallback-owner-primary-lock',
            audience: 'child',
            reason: 'tracked_subagent_lineage',
          },
        },
        last_event_at: new Date(timestamp).toISOString(),
      };

      const primaryReplayFailure = replacePrimaryFifoWithDirectoryThenFallbackFifoCreatesPrimaryLock(
        t,
        projectDedupePath,
        {
          recent_turns: {},
          turn_claims: {},
          last_event_at: '',
        },
        fallbackDedupePath,
        fallbackSuppressState,
        primaryLockPath,
        'fresh-primary-replay-lock',
        fallbackSuppressState,
      );
      if (!primaryReplayFailure) return;

      const payload = {
        cwd: wd,
        session_id: 'native-session-fallback-owner-primary-lock-rollback',
        origin: { kind: 'leader', thread_id: threadId },
        type: 'agent-turn-complete',
        thread_id: threadId,
        turn_id: turnId,
        input_messages: ['hello'],
        last_assistant_message: 'fallback owner primary lock rollback output',
      };
      const first = runNotifyHook(payload, { OMX_SESSION_ID: sessionId });
      assert.equal(first.status, 0, first.stderr || first.stdout);
      await primaryReplayFailure;

      assert.deepEqual(await readJsonLogFiles(join(wd, '.omx', 'logs'), 'turns-'), []);
      const firstNotifyLog = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'notify-hook-');
      assert.equal(
        firstNotifyLog.some((entry) =>
          entry.type === 'turn_duplicate_owner_upgraded'
          && entry.scope === 'project_fallback'
          && entry.turn_id === turnId
          && entry.suppress_external_delivery === false
        ),
        true,
      );
      assert.equal(
        firstNotifyLog.some((entry) =>
          entry.type === 'project_fallback_turn_dedupe_upgraded'
          && entry.turn_id === turnId
        ),
        false,
      );
      let fallbackState = JSON.parse(
        await readFile(fallbackDedupePath, 'utf-8'),
      ) as { turn_claims?: Record<string, { delivery?: string; source_kind?: string }> };
      assert.equal(fallbackState.turn_claims?.[key]?.delivery, 'suppress');
      assert.equal(fallbackState.turn_claims?.[key]?.source_kind, 'native');

      await rm(primaryLockPath, { force: true });
      await rm(projectDedupePath, { recursive: true, force: true });
      const retry = runNotifyHook({
        ...payload,
        input_messages: ['hello retry'],
      }, { OMX_SESSION_ID: sessionId });
      assert.equal(retry.status, 0, retry.stderr || retry.stdout);

      const notifyLog = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'notify-hook-');
      assert.equal(
        notifyLog.filter((entry) =>
          entry.type === 'completed_turn_delivery_allowed'
          && entry.turn_id === turnId
        ).length,
        1,
      );
      fallbackState = JSON.parse(
        await readFile(fallbackDedupePath, 'utf-8'),
      ) as { turn_claims?: Record<string, { delivery?: string; source_kind?: string }> };
      assert.equal(fallbackState.turn_claims?.[key]?.delivery, 'allow');
      assert.equal(fallbackState.turn_claims?.[key]?.source_kind, 'native');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('finalizes degraded fallback owner-upgrades only after delivery is allowed', async (t) => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-fallback-owner-primary-write-fail-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'omx-fallback-owner-primary-write-fail';
      const threadId = 'native-thread-fallback-owner-primary-write-fail';
      const turnId = 'native-turn-fallback-owner-primary-write-fail';
      const key = `${threadId}|${turnId}|agent-turn-complete`;
      const timestamp = Date.now();
      const projectDedupePath = join(stateDir, 'notify-hook-turn-dedupe.json');
      const fallbackDedupePath = join(stateDir, 'notify-hook-state.json');
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        native_session_id: threadId,
        started_at: new Date(timestamp).toISOString(),
        cwd: wd,
      }));
      const fallbackSuppressState = {
        recent_turns: { [key]: timestamp },
        turn_claims: {
          [key]: {
            timestamp,
            delivery: 'suppress',
            source_kind: 'native',
            source: 'native-subagent',
            session_id: 'omx-suppressed-fallback-owner-primary-write',
            audience: 'child',
            reason: 'tracked_subagent_lineage',
          },
        },
        last_event_at: new Date(timestamp).toISOString(),
      };
      const projectWriteFailure = replaceFifoWithDirectoryAfterRead(
        t,
        projectDedupePath,
        {
          recent_turns: {},
          turn_claims: {},
          last_event_at: '',
        },
        undefined,
        fallbackDedupePath,
        fallbackSuppressState,
      );
      if (!projectWriteFailure) return;

      const result = runNotifyHook({
        cwd: wd,
        session_id: 'native-session-fallback-owner-primary-write-fail',
        origin: { kind: 'leader', thread_id: threadId },
        type: 'agent-turn-complete',
        thread_id: threadId,
        turn_id: turnId,
        input_messages: ['hello'],
        last_assistant_message: 'fallback owner primary write fail output',
      }, { OMX_SESSION_ID: sessionId });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      await projectWriteFailure;

      const notifyLog = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'notify-hook-');
      assert.equal(
        notifyLog.filter((entry) =>
          entry.type === 'completed_turn_delivery_allowed'
          && entry.turn_id === turnId
        ).length,
        1,
      );
      assert.equal(
        notifyLog.some((entry) =>
          entry.type === 'project_fallback_turn_dedupe_upgraded'
          && entry.turn_id === turnId
          && entry.upgraded === true
        ),
        true,
      );
      const fallbackState = JSON.parse(
        await readFile(fallbackDedupePath, 'utf-8'),
      ) as { turn_claims?: Record<string, { delivery?: string; source_kind?: string }> };
      assert.equal(fallbackState.turn_claims?.[key]?.delivery, 'allow');
      assert.equal(fallbackState.turn_claims?.[key]?.source_kind, 'native');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('fails closed when a degraded fallback owner-upgrade cannot be finalized', async (t) => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-fallback-owner-finalize-locked-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'omx-fallback-owner-finalize-locked';
      const threadId = 'native-thread-fallback-owner-finalize-locked';
      const turnId = 'native-turn-fallback-owner-finalize-locked';
      const key = `${threadId}|${turnId}|agent-turn-complete`;
      const timestamp = Date.now();
      const projectDedupePath = join(stateDir, 'notify-hook-turn-dedupe.json');
      const fallbackDedupePath = join(stateDir, 'notify-hook-state.json');
      const fallbackLockPath = join(stateDir, 'notify-hook-state.json.lock');
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        native_session_id: threadId,
        started_at: new Date(timestamp).toISOString(),
        cwd: wd,
      }));
      const fallbackSuppressState = {
        recent_turns: { [key]: timestamp },
        turn_claims: {
          [key]: {
            timestamp,
            delivery: 'suppress',
            source_kind: 'native',
            source: 'native-subagent',
            session_id: 'omx-suppressed-fallback-owner-finalize',
            audience: 'child',
            reason: 'tracked_subagent_lineage',
          },
        },
        last_event_at: new Date(timestamp).toISOString(),
      };
      const finalizeLockRace = replacePrimaryFifoWithDirectoryThenFallbackFifoCreatesPrimaryFifoAndFallbackLockAfterReplay(
        t,
        projectDedupePath,
        {
          recent_turns: {},
          turn_claims: {},
          last_event_at: '',
        },
        fallbackDedupePath,
        fallbackSuppressState,
        {
          recent_turns: {},
          turn_claims: {},
          last_event_at: '',
        },
        fallbackLockPath,
      );
      if (!finalizeLockRace) return;

      const payload = {
        cwd: wd,
        session_id: 'native-session-fallback-owner-finalize-locked',
        origin: { kind: 'leader', thread_id: threadId },
        type: 'agent-turn-complete',
        thread_id: threadId,
        turn_id: turnId,
        input_messages: ['hello'],
        last_assistant_message: 'fallback owner finalize locked output',
      };
      const first = runNotifyHook(payload, { OMX_SESSION_ID: sessionId });
      assert.equal(first.status, 0, first.stderr || first.stdout);
      await finalizeLockRace;

      assert.deepEqual(await readJsonLogFiles(join(wd, '.omx', 'logs'), 'turns-'), []);
      const firstNotifyLog = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'notify-hook-');
      assert.equal(
        firstNotifyLog.some((entry) =>
          entry.type === 'project_fallback_turn_dedupe_upgrade_failed'
          && entry.turn_id === turnId
          && String(entry.error || '').includes('state file lock timeout')
        ),
        true,
      );
      assert.equal(
        firstNotifyLog.some((entry) =>
          entry.type === 'project_fallback_turn_dedupe_upgraded'
          && entry.turn_id === turnId
          && entry.upgraded === false
        ),
        true,
      );
      let fallbackState = JSON.parse(
        await readFile(fallbackDedupePath, 'utf-8'),
      ) as { turn_claims?: Record<string, { delivery?: string }> };
      assert.equal(fallbackState.turn_claims?.[key]?.delivery, 'suppress');

      await rm(fallbackLockPath, { force: true });
      await rm(projectDedupePath, { recursive: true, force: true });
      const retry = runNotifyHook({
        ...payload,
        input_messages: ['hello retry'],
      }, { OMX_SESSION_ID: sessionId });
      assert.equal(retry.status, 0, retry.stderr || retry.stdout);

      const notifyLog = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'notify-hook-');
      assert.equal(
        notifyLog.filter((entry) =>
          entry.type === 'completed_turn_delivery_allowed'
          && entry.turn_id === turnId
        ).length,
        1,
      );
      fallbackState = JSON.parse(
        await readFile(fallbackDedupePath, 'utf-8'),
      ) as { turn_claims?: Record<string, { delivery?: string }> };
      assert.equal(fallbackState.turn_claims?.[key]?.delivery, 'allow');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('restores primary owner-upgrades when fallback finalization fails before delivery', async (t) => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-primary-owner-finalize-rollback-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'omx-primary-owner-finalize-rollback';
      const threadId = 'native-thread-primary-owner-finalize-rollback';
      const turnId = 'native-turn-primary-owner-finalize-rollback';
      const key = `${threadId}|${turnId}|agent-turn-complete`;
      const timestamp = Date.now();
      const projectDedupePath = join(stateDir, 'notify-hook-turn-dedupe.json');
      const fallbackDedupePath = join(stateDir, 'notify-hook-state.json');
      const fallbackLockPath = join(stateDir, 'notify-hook-state.json.lock');
      const sessionDedupePath = join(stateDir, 'sessions', sessionId, 'notify-hook-state.json');
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        native_session_id: threadId,
        started_at: new Date(timestamp).toISOString(),
        cwd: wd,
      }));
      const suppressClaim = {
        timestamp,
        delivery: 'suppress',
        source_kind: 'native',
        source: 'native-subagent',
        session_id: 'omx-suppressed-primary-owner-finalize',
        audience: 'child',
        reason: 'tracked_subagent_lineage',
      };
      const suppressState = {
        recent_turns: { [key]: timestamp },
        turn_claims: { [key]: suppressClaim },
        last_event_at: new Date(timestamp).toISOString(),
      };
      await writeFile(projectDedupePath, JSON.stringify(suppressState));
      await writeFile(fallbackDedupePath, JSON.stringify(suppressState));
      const sessionDedupeCreatesFallbackLock = replaceFifoWithMissingAfterRead(
        t,
        sessionDedupePath,
        {
          recent_turns: {},
          last_event_at: '',
        },
        fallbackLockPath,
        'fresh-fallback-finalize-lock',
      );
      if (!sessionDedupeCreatesFallbackLock) return;

      const payload = {
        cwd: wd,
        session_id: 'native-session-primary-owner-finalize-rollback',
        origin: { kind: 'leader', thread_id: threadId },
        type: 'agent-turn-complete',
        thread_id: threadId,
        turn_id: turnId,
        input_messages: ['hello'],
        last_assistant_message: 'primary owner finalize rollback output',
      };
      const first = runNotifyHook(payload, { OMX_SESSION_ID: sessionId });
      assert.equal(first.status, 0, first.stderr || first.stdout);
      await sessionDedupeCreatesFallbackLock;

      assert.deepEqual(await readJsonLogFiles(join(wd, '.omx', 'logs'), 'turns-'), []);
      const firstNotifyLog = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'notify-hook-');
      assert.equal(
        firstNotifyLog.some((entry) =>
          entry.type === 'project_fallback_turn_dedupe_upgrade_failed'
          && entry.turn_id === turnId
        ),
        true,
      );
      assert.equal(
        firstNotifyLog.some((entry) =>
          entry.type === 'project_turn_dedupe_rolled_back'
          && entry.turn_id === turnId
          && entry.reason === 'fallback_owner_upgrade_finalize_failed'
          && entry.rollback_mode === 'restore_previous_claim'
          && entry.rolled_back === true
        ),
        true,
      );
      let projectState = JSON.parse(
        await readFile(projectDedupePath, 'utf-8'),
      ) as { turn_claims?: Record<string, { delivery?: string }> };
      assert.equal(projectState.turn_claims?.[key]?.delivery, 'suppress');

      await rm(fallbackLockPath, { force: true });
      const retry = runNotifyHook({
        ...payload,
        input_messages: ['hello retry'],
      }, { OMX_SESSION_ID: sessionId });
      assert.equal(retry.status, 0, retry.stderr || retry.stdout);

      const notifyLog = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'notify-hook-');
      assert.equal(
        notifyLog.filter((entry) =>
          entry.type === 'completed_turn_delivery_allowed'
          && entry.turn_id === turnId
        ).length,
        1,
      );
      projectState = JSON.parse(
        await readFile(projectDedupePath, 'utf-8'),
      ) as { turn_claims?: Record<string, { delivery?: string }> };
      assert.equal(projectState.turn_claims?.[key]?.delivery, 'allow');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('fails closed when fallback replay times out before a non-timeout primary failure', async (t) => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-fallback-lock-primary-fail-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'omx-fallback-lock-primary-fail';
      const projectDedupePath = join(stateDir, 'notify-hook-turn-dedupe.json');
      const fallbackLockPath = join(stateDir, 'notify-hook-state.json.lock');
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      await writeFile(fallbackLockPath, 'fresh-fallback-lock');
      const projectWriteFailure = replaceFifoWithDirectoryAfterRead(
        t,
        projectDedupePath,
        {
          recent_turns: {},
          turn_claims: {},
          last_event_at: '',
        },
      );
      if (!projectWriteFailure) return;

      const result = runNotifyHook({
        cwd: wd,
        session_id: 'native-session-fallback-lock-primary-fail',
        type: 'agent-turn-complete',
        thread_id: 'native-thread-fallback-lock-primary-fail',
        turn_id: 'native-turn-fallback-lock-primary-fail',
        input_messages: ['hello'],
        last_assistant_message: 'fallback lock primary fail output',
      }, { OMX_SESSION_ID: sessionId });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      await projectWriteFailure;

      const notifyLog = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'notify-hook-');
      assert.equal(
        notifyLog.some((entry) =>
          entry.type === 'project_fallback_turn_dedupe_replay_failed'
          && entry.turn_id === 'native-turn-fallback-lock-primary-fail'
          && String(entry.error || '').includes('state file lock timeout')
        ),
        true,
      );
      assert.equal(
        notifyLog.some((entry) =>
          entry.type === 'project_fallback_turn_dedupe_failed'
          && entry.turn_id === 'native-turn-fallback-lock-primary-fail'
        ),
        false,
      );
      assert.deepEqual(await readJsonLogFiles(join(wd, '.omx', 'logs'), 'turns-'), []);
      assert.equal(existsSync(join(stateDir, 'notify-hook-state.json')), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('fails closed when project and fallback turn dedupe are locked', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-both-dedupe-locked-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'omx-both-dedupe-locked-session';
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      await writeFile(join(stateDir, 'notify-hook-turn-dedupe.lock'), 'fresh-project-lock');
      await writeFile(join(stateDir, 'notify-hook-state.json.lock'), 'fresh-fallback-lock');

      const result = runNotifyHook({
        cwd: wd,
        session_id: 'native-session-both-dedupe-locked',
        type: 'agent-turn-complete',
        thread_id: 'native-thread-both-dedupe-locked',
        turn_id: 'native-turn-both-dedupe-locked',
        input_messages: ['hello'],
        last_assistant_message: 'both dedupe locked output',
      }, { OMX_SESSION_ID: sessionId });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const notifyLog = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'notify-hook-');
      assert.equal(
        notifyLog.some((entry) =>
          entry.type === 'project_fallback_turn_dedupe_replay_failed'
          && entry.turn_id === 'native-turn-both-dedupe-locked'
          && entry.fallback_state_exists === true
        ),
        true,
      );
      assert.equal(
        notifyLog.some((entry) =>
          entry.type === 'project_fallback_turn_dedupe_failed'
          && entry.turn_id === 'native-turn-both-dedupe-locked'
        ),
        false,
      );
      assert.equal(
        notifyLog.some((entry) =>
          entry.type === 'session_turn_dedupe_failed'
          && entry.turn_id === 'native-turn-both-dedupe-locked'
        ),
        false,
      );
      assert.deepEqual(await readJsonLogFiles(join(wd, '.omx', 'logs'), 'turns-'), []);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('fails closed when project write fails and fallback dedupe fails', async (t) => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-project-write-session-locked-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'omx-project-write-session-locked';
      const sessionDir = join(stateDir, 'sessions', sessionId);
      const projectDedupePath = join(stateDir, 'notify-hook-turn-dedupe.json');
      const fallbackDedupePath = join(stateDir, 'notify-hook-state.json');
      await mkdir(sessionDir, { recursive: true });
      const projectWriteFailure = replaceFifoWithDirectoryAfterRead(
        t,
        projectDedupePath,
        {
          recent_turns: {},
          turn_claims: {},
          last_event_at: '',
        },
        fallbackDedupePath,
      );
      if (!projectWriteFailure) return;
      await writeFile(join(sessionDir, 'notify-hook-state.json.lock'), 'fresh-session-lock');

      const result = runNotifyHook({
        cwd: wd,
        session_id: 'native-session-project-write-session-locked',
        type: 'agent-turn-complete',
        thread_id: 'native-thread-project-write-session-locked',
        turn_id: 'native-turn-project-write-session-locked',
        input_messages: ['hello'],
        last_assistant_message: 'project write failure with session dedupe locked output',
      }, { OMX_SESSION_ID: sessionId });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      await projectWriteFailure;

      const notifyLog = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'notify-hook-');
      assert.equal(
        notifyLog.some((entry) =>
          entry.type === 'project_turn_dedupe_write_failed'
          && entry.turn_id === 'native-turn-project-write-session-locked'
          && entry.decision_reason === 'first'
        ),
        true,
      );
      assert.equal(
        notifyLog.some((entry) =>
          entry.type === 'project_fallback_turn_dedupe_failed'
          && entry.turn_id === 'native-turn-project-write-session-locked'
        ),
        true,
      );
      assert.equal(
        notifyLog.some((entry) =>
          entry.type === 'session_turn_dedupe_failed'
          && entry.turn_id === 'native-turn-project-write-session-locked'
        ),
        false,
      );
      assert.deepEqual(await readJsonLogFiles(join(wd, '.omx', 'logs'), 'turns-'), []);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rolls back fallback claims when session dedupe already processed a degraded retry', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-fallback-session-duplicate-rollback-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'omx-fallback-session-duplicate-rollback';
      const threadId = 'native-thread-fallback-session-duplicate-rollback';
      const turnId = 'native-turn-fallback-session-duplicate-rollback';
      const key = `${threadId}|${turnId}|agent-turn-complete`;
      const timestamp = Date.now();
      const projectDedupePath = join(stateDir, 'notify-hook-turn-dedupe.json');
      const fallbackDedupePath = join(stateDir, 'notify-hook-state.json');
      const sessionDedupePath = join(stateDir, 'sessions', sessionId, 'notify-hook-state.json');
      await mkdir(projectDedupePath, { recursive: true });
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        native_session_id: threadId,
        started_at: new Date(timestamp).toISOString(),
        cwd: wd,
      }));
      await writeFile(sessionDedupePath, JSON.stringify({
        recent_turns: { [key]: timestamp },
        last_event_at: new Date(timestamp).toISOString(),
      }));

      const result = runNotifyHook({
        cwd: wd,
        session_id: 'native-session-fallback-session-duplicate-rollback',
        origin: { kind: 'leader', thread_id: threadId },
        type: 'agent-turn-complete',
        thread_id: threadId,
        turn_id: turnId,
        input_messages: ['hello'],
        last_assistant_message: 'fallback session duplicate rollback output',
      }, { OMX_SESSION_ID: sessionId });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      assert.deepEqual(await readJsonLogFiles(join(wd, '.omx', 'logs'), 'turns-'), []);
      const notifyLog = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'notify-hook-');
      assert.equal(
        notifyLog.some((entry) =>
          entry.type === 'project_fallback_turn_dedupe_rolled_back'
          && entry.turn_id === turnId
          && entry.reason === 'session_turn_dedupe_duplicate_before_delivery'
          && entry.rolled_back === true
        ),
        true,
      );
      const fallbackState = JSON.parse(
        await readFile(fallbackDedupePath, 'utf-8'),
      ) as { recent_turns?: Record<string, unknown>; turn_claims?: Record<string, unknown> };
      assert.equal(Boolean(fallbackState.recent_turns?.[key]), false);
      assert.equal(Boolean(fallbackState.turn_claims?.[key]), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rolls back degraded fallback claims when session dedupe cannot be checked', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-fallback-session-lock-rollback-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'omx-fallback-session-lock-rollback';
      const threadId = 'native-thread-fallback-session-lock-rollback';
      const turnId = 'native-turn-fallback-session-lock-rollback';
      const key = `${threadId}|${turnId}|agent-turn-complete`;
      const timestamp = Date.now();
      const projectDedupePath = join(stateDir, 'notify-hook-turn-dedupe.json');
      const fallbackDedupePath = join(stateDir, 'notify-hook-state.json');
      const sessionLockPath = join(stateDir, 'sessions', sessionId, 'notify-hook-state.json.lock');
      await mkdir(projectDedupePath, { recursive: true });
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        native_session_id: threadId,
        started_at: new Date(timestamp).toISOString(),
        cwd: wd,
      }));
      await writeFile(sessionLockPath, 'fresh-session-dedupe-lock');

      const result = runNotifyHook({
        cwd: wd,
        session_id: 'native-session-fallback-session-lock-rollback',
        origin: { kind: 'leader', thread_id: threadId },
        type: 'agent-turn-complete',
        thread_id: threadId,
        turn_id: turnId,
        input_messages: ['hello'],
        last_assistant_message: 'fallback session lock rollback output',
      }, { OMX_SESSION_ID: sessionId });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      assert.deepEqual(await readJsonLogFiles(join(wd, '.omx', 'logs'), 'turns-'), []);
      const notifyLog = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'notify-hook-');
      assert.equal(
        notifyLog.some((entry) =>
          entry.type === 'session_turn_dedupe_failed'
          && entry.turn_id === turnId
          && String(entry.error || '').includes('state file lock timeout')
        ),
        true,
      );
      assert.equal(
        notifyLog.some((entry) =>
          entry.type === 'project_fallback_turn_dedupe_rolled_back'
          && entry.turn_id === turnId
          && entry.reason === 'session_turn_dedupe_failed'
          && entry.rolled_back === true
        ),
        true,
      );
      const fallbackState = JSON.parse(
        await readFile(fallbackDedupePath, 'utf-8'),
      ) as { recent_turns?: Record<string, unknown>; turn_claims?: Record<string, unknown> };
      assert.equal(Boolean(fallbackState.recent_turns?.[key]), false);
      assert.equal(Boolean(fallbackState.turn_claims?.[key]), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('fails closed when fallback dedupe computes a claim but atomic persistence fails', async (t) => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-fallback-write-failed-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'omx-fallback-write-failed';
      const threadId = 'native-thread-fallback-write-failed';
      const turnId = 'native-turn-fallback-write-failed';
      const projectDedupePath = join(stateDir, 'notify-hook-turn-dedupe.json');
      const fallbackDedupePath = join(stateDir, 'notify-hook-state.json');
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      const fallbackWriteFailure = replacePrimaryFifoWithDirectoryThenFallbackFifoBecomesDirectoryAfterRead(
        t,
        projectDedupePath,
        {
          recent_turns: {},
          turn_claims: {},
          last_event_at: '',
        },
        fallbackDedupePath,
        {
          recent_turns: {},
          turn_claims: {},
          last_event_at: '',
        },
      );
      if (!fallbackWriteFailure) return;

      const result = runNotifyHook({
        cwd: wd,
        session_id: 'native-session-fallback-write-failed',
        type: 'agent-turn-complete',
        thread_id: threadId,
        turn_id: turnId,
        input_messages: ['hello'],
        last_assistant_message: 'fallback write failed output',
      }, { OMX_SESSION_ID: sessionId });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      await fallbackWriteFailure;

      const notifyLog = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'notify-hook-');
      assert.equal(
        notifyLog.some((entry) =>
          entry.type === 'project_fallback_turn_dedupe_write_failed'
          && entry.turn_id === turnId
          && entry.decision_reason === 'first'
        ),
        true,
      );
      assert.equal(
        notifyLog.some((entry) =>
          entry.type === 'project_fallback_turn_dedupe_failed'
          && entry.turn_id === turnId
        ),
        false,
      );
      assert.deepEqual(await readJsonLogFiles(join(wd, '.omx', 'logs'), 'turns-'), []);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves owner-upgrade suppression when project dedupe write fails', async (t) => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-project-write-owner-upgrade-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'omx-project-write-owner-upgrade';
      const threadId = 'native-thread-project-write-owner-upgrade';
      const turnId = 'native-turn-project-write-owner-upgrade';
      const key = `${threadId}|${turnId}|agent-turn-complete`;
      const timestamp = Date.now();
      const projectDedupePath = join(stateDir, 'notify-hook-turn-dedupe.json');
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        native_session_id: threadId,
        started_at: new Date(timestamp).toISOString(),
        cwd: wd,
      }));
      const projectWriteFailure = replaceFifoWithDirectoryAfterRead(t, projectDedupePath, {
        recent_turns: { [key]: timestamp },
        turn_claims: {
          [key]: {
            timestamp,
            delivery: 'allow',
            source_kind: 'fallback',
            source: 'notify-fallback-watcher',
            session_id: 'omx-fallback-owner-upgrade',
            audience: 'external',
            reason: 'test_existing_fallback_delivery',
          },
        },
        last_event_at: new Date(timestamp).toISOString(),
      });
      if (!projectWriteFailure) return;

      const result = runNotifyHook({
        cwd: wd,
        session_id: 'native-session-project-write-owner-upgrade',
        origin: { kind: 'leader', thread_id: threadId },
        type: 'agent-turn-complete',
        thread_id: threadId,
        turn_id: turnId,
        input_messages: ['hello'],
        last_assistant_message: 'project write failure owner upgrade output',
      }, { OMX_SESSION_ID: sessionId });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      await projectWriteFailure;

      const notifyLog = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'notify-hook-');
      assert.equal(
        notifyLog.some((entry) =>
          entry.type === 'project_turn_dedupe_write_failed'
          && entry.turn_id === turnId
          && entry.decision_reason === 'owner_upgrade'
          && entry.suppress_external_delivery === true
        ),
        true,
      );
      assert.equal(
        notifyLog.some((entry) =>
          entry.type === 'turn_duplicate_owner_upgraded'
          && entry.turn_id === turnId
          && entry.write_failed === true
          && entry.suppress_external_delivery === true
        ),
        true,
      );
      assert.equal(
        notifyLog.some((entry) =>
          entry.type === 'completed_turn_duplicate_suppressed'
          && entry.turn_id === turnId
        ),
        true,
      );
      assert.equal(
        notifyLog.some((entry) =>
          entry.type === 'completed_turn_delivery_allowed'
          && entry.turn_id === turnId
        ),
        false,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('recovers legacy primary allow claims that have no sent delivery evidence', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-project-legacy-allow-recovery-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'omx-project-legacy-allow-recovery';
      const threadId = 'native-thread-project-legacy-allow-recovery';
      const turnId = 'native-turn-project-legacy-allow-recovery';
      const key = `${threadId}|${turnId}|agent-turn-complete`;
      const timestamp = Date.now();
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        native_session_id: threadId,
        started_at: new Date(timestamp).toISOString(),
        cwd: wd,
      }));
      await writeFile(join(stateDir, 'notify-hook-turn-dedupe.json'), JSON.stringify({
        recent_turns: { [key]: timestamp },
        turn_claims: {
          [key]: {
            timestamp,
            delivery: 'allow',
            source_kind: 'native',
            source: 'native-notify',
            session_id: sessionId,
            audience: 'external-owner',
            reason: 'current_external_owner',
          },
        },
        last_event_at: new Date(timestamp).toISOString(),
      }));

      const result = runNotifyHook({
        cwd: wd,
        session_id: 'native-session-project-legacy-allow-recovery',
        origin: { kind: 'leader', thread_id: threadId },
        type: 'agent-turn-complete',
        thread_id: threadId,
        turn_id: turnId,
        input_messages: ['hello'],
        last_assistant_message: 'legacy primary allow recovery output',
      }, {
        CODEX_HOME: join(wd, 'codex-home'),
        HOME: join(wd, 'home'),
        USERPROFILE: join(wd, 'home'),
        OMX_SESSION_ID: sessionId,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const notifyLog = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'notify-hook-');
      assert.equal(
        notifyLog.filter((entry) =>
          entry.type === 'completed_turn_delivery_allowed'
          && entry.turn_id === turnId
        ).length,
        1,
      );
      assert.equal(
        notifyLog.some((entry) =>
          entry.type === 'project_turn_dedupe_allow_claim_recovered_before_delivery'
          && entry.turn_id === turnId
        ),
        true,
      );
      const projectState = JSON.parse(
        await readFile(join(stateDir, 'notify-hook-turn-dedupe.json'), 'utf-8'),
      ) as { turn_claims?: Record<string, { delivery_status?: string }> };
      assert.equal(projectState.turn_claims?.[key]?.delivery_status, 'committed');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('recovers legacy primary allow claims even after a pre-send allowed log', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-project-legacy-allowed-log-recovery-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'omx-project-legacy-allowed-log-recovery';
      const threadId = 'native-thread-project-legacy-allowed-log-recovery';
      const turnId = 'native-turn-project-legacy-allowed-log-recovery';
      const key = `${threadId}|${turnId}|agent-turn-complete`;
      const timestamp = Date.now();
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        native_session_id: threadId,
        started_at: new Date(timestamp).toISOString(),
        cwd: wd,
      }));
      await writeFile(join(stateDir, 'notify-hook-turn-dedupe.json'), JSON.stringify({
        recent_turns: { [key]: timestamp },
        turn_claims: {
          [key]: {
            timestamp,
            delivery: 'allow',
            source_kind: 'native',
            source: 'native-notify',
            session_id: sessionId,
            audience: 'external-owner',
            reason: 'current_external_owner',
          },
        },
        last_event_at: new Date(timestamp).toISOString(),
      }));
      await mkdir(join(wd, '.omx', 'logs'), { recursive: true });
      await writeFile(join(wd, '.omx', 'logs', 'notify-hook-existing.jsonl'), `${JSON.stringify({
        timestamp: new Date(timestamp).toISOString(),
        type: 'completed_turn_delivery_allowed',
        thread_id: threadId,
        turn_id: turnId,
        omx_session_id: sessionId,
      })}\n`);

      const result = runNotifyHook({
        cwd: wd,
        session_id: 'native-session-project-legacy-allowed-log-recovery',
        origin: { kind: 'leader', thread_id: threadId },
        type: 'agent-turn-complete',
        thread_id: threadId,
        turn_id: turnId,
        input_messages: ['hello'],
        last_assistant_message: 'legacy primary allow recovery after allowed log output',
      }, {
        CODEX_HOME: join(wd, 'codex-home'),
        HOME: join(wd, 'home'),
        USERPROFILE: join(wd, 'home'),
        OMX_SESSION_ID: sessionId,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const notifyLog = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'notify-hook-');
      assert.equal(
        notifyLog.filter((entry) =>
          entry.type === 'completed_turn_delivery_allowed'
          && entry.turn_id === turnId
        ).length,
        2,
      );
      assert.equal(
        notifyLog.some((entry) =>
          entry.type === 'project_turn_dedupe_allow_claim_recovered_before_delivery'
          && entry.turn_id === turnId
        ),
        true,
      );
      const projectState = JSON.parse(
        await readFile(join(stateDir, 'notify-hook-turn-dedupe.json'), 'utf-8'),
      ) as { turn_claims?: Record<string, { delivery_status?: string }> };
      assert.equal(projectState.turn_claims?.[key]?.delivery_status, 'committed');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('serializes pending allow recovery after a failed delivery log', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-project-pending-failed-recovery-race-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'omx-project-pending-failed-recovery-race';
      const threadId = 'native-thread-project-pending-failed-recovery-race';
      const turnId = 'native-turn-project-pending-failed-recovery-race';
      const key = `${threadId}|${turnId}|agent-turn-complete`;
      const timestamp = Date.now() - 1_000;
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        native_session_id: threadId,
        started_at: new Date(timestamp).toISOString(),
        cwd: wd,
      }));
      await writeFile(join(stateDir, 'notify-hook-turn-dedupe.json'), JSON.stringify({
        recent_turns: { [key]: timestamp },
        turn_claims: {
          [key]: {
            timestamp,
            delivery: 'allow',
            delivery_status: 'pending',
            source_kind: 'native',
            source: 'native-notify',
            session_id: sessionId,
            audience: 'external-owner',
            reason: 'current_external_owner',
          },
        },
        last_event_at: new Date(timestamp).toISOString(),
      }));
      await mkdir(join(wd, '.omx', 'logs'), { recursive: true });
      await writeFile(join(wd, '.omx', 'logs', 'notify-hook-existing.jsonl'), `${JSON.stringify({
        timestamp: new Date(),
        type: 'completed_turn_delivery_failed',
        thread_id: threadId,
        turn_id: turnId,
        omx_session_id: sessionId,
      })}\n`);

      const payload = {
        cwd: wd,
        session_id: 'native-session-project-pending-failed-recovery-race',
        origin: { kind: 'leader', thread_id: threadId },
        type: 'agent-turn-complete',
        thread_id: threadId,
        turn_id: turnId,
        input_messages: ['hello'],
        last_assistant_message: 'pending failed recovery race output',
      };
      const results = await Promise.all([
        runNotifyHookAsync({ ...payload, input_messages: ['hello 1'] }, {
          CODEX_HOME: join(wd, 'codex-home'),
          HOME: join(wd, 'home'),
          USERPROFILE: join(wd, 'home'),
          OMX_SESSION_ID: sessionId,
        }),
        runNotifyHookAsync({ ...payload, input_messages: ['hello 2'] }, {
          CODEX_HOME: join(wd, 'codex-home'),
          HOME: join(wd, 'home'),
          USERPROFILE: join(wd, 'home'),
          OMX_SESSION_ID: sessionId,
        }),
      ]);
      for (const result of results) {
        assert.equal(result.status, 0, result.stderr || result.stdout);
      }

      const notifyLog = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'notify-hook-');
      assert.equal(
        notifyLog.filter((entry) =>
          entry.type === 'completed_turn_delivery_allowed'
          && entry.turn_id === turnId
        ).length,
        1,
      );
      assert.equal(
        notifyLog.filter((entry) =>
          entry.type === 'project_turn_dedupe_allow_claim_recovered_before_delivery'
          && entry.turn_id === turnId
        ).length,
        1,
      );
      const projectState = JSON.parse(
        await readFile(join(stateDir, 'notify-hook-turn-dedupe.json'), 'utf-8'),
      ) as { turn_claims?: Record<string, { delivery_status?: string }> };
      assert.equal(projectState.turn_claims?.[key]?.delivery_status, 'committed');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('fails closed on fresh pending fallback allow claims to avoid double delivery races', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-project-fresh-fallback-pending-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'omx-project-fresh-fallback-pending';
      const threadId = 'native-thread-project-fresh-fallback-pending';
      const turnId = 'native-turn-project-fresh-fallback-pending';
      const key = `${threadId}|${turnId}|agent-turn-complete`;
      const timestamp = Date.now();
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        native_session_id: threadId,
        started_at: new Date(timestamp).toISOString(),
        cwd: wd,
      }));
      await writeFile(join(stateDir, 'notify-hook-state.json'), JSON.stringify({
        recent_turns: { [key]: timestamp },
        turn_claims: {
          [key]: {
            timestamp,
            delivery: 'allow',
            delivery_status: 'pending',
            source_kind: 'fallback',
            source: 'notify-fallback-watch',
            session_id: sessionId,
            audience: 'external-owner',
            reason: 'fallback_external_owner',
          },
        },
        last_event_at: new Date(timestamp).toISOString(),
      }));

      const result = runNotifyHook({
        cwd: wd,
        session_id: 'native-session-project-fresh-fallback-pending',
        origin: { kind: 'leader', thread_id: threadId },
        type: 'agent-turn-complete',
        thread_id: threadId,
        turn_id: turnId,
        input_messages: ['hello'],
        last_assistant_message: 'fresh pending fallback allow output',
      }, {
        CODEX_HOME: join(wd, 'codex-home'),
        HOME: join(wd, 'home'),
        USERPROFILE: join(wd, 'home'),
        OMX_SESSION_ID: sessionId,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const notifyLog = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'notify-hook-');
      assert.equal(
        notifyLog.some((entry) =>
          entry.type === 'completed_turn_delivery_allowed'
          && entry.turn_id === turnId
        ),
        false,
      );
      assert.equal(
        notifyLog.some((entry) =>
          entry.type === 'completed_turn_duplicate_suppressed'
          && entry.turn_id === turnId
        ),
        true,
      );
      const projectState = JSON.parse(
        await readFile(join(stateDir, 'notify-hook-turn-dedupe.json'), 'utf-8'),
      ) as { turn_claims?: Record<string, { delivery_status?: string; source_kind?: string }> };
      assert.equal(projectState.turn_claims?.[key]?.delivery_status, 'pending');
      assert.equal(projectState.turn_claims?.[key]?.source_kind, 'fallback');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('recovers failed pending fallback allow claims before owner-upgrade suppression', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-project-stale-fallback-pending-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'omx-project-stale-fallback-pending';
      const threadId = 'native-thread-project-stale-fallback-pending';
      const turnId = 'native-turn-project-stale-fallback-pending';
      const key = `${threadId}|${turnId}|agent-turn-complete`;
      const timestamp = Date.now() - 1_000;
      await mkdir(join(stateDir, 'sessions', sessionId), { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        native_session_id: threadId,
        started_at: new Date(timestamp).toISOString(),
        cwd: wd,
      }));
      await writeFile(join(stateDir, 'notify-hook-state.json'), JSON.stringify({
        recent_turns: { [key]: timestamp },
        turn_claims: {
          [key]: {
            timestamp,
            delivery: 'allow',
            delivery_status: 'pending',
            source_kind: 'fallback',
            source: 'notify-fallback-watch',
            session_id: sessionId,
            audience: 'external-owner',
            reason: 'fallback_external_owner',
          },
        },
        last_event_at: new Date(timestamp).toISOString(),
      }));
      await mkdir(join(wd, '.omx', 'logs'), { recursive: true });
      await writeFile(join(wd, '.omx', 'logs', 'notify-hook-existing.jsonl'), `${JSON.stringify({
        timestamp: new Date().toISOString(),
        type: 'completed_turn_delivery_failed',
        thread_id: threadId,
        turn_id: turnId,
        omx_session_id: sessionId,
      })}\n`);

      const result = runNotifyHook({
        cwd: wd,
        session_id: 'native-session-project-failed-fallback-pending',
        origin: { kind: 'leader', thread_id: threadId },
        type: 'agent-turn-complete',
        thread_id: threadId,
        turn_id: turnId,
        input_messages: ['hello'],
        last_assistant_message: 'failed pending fallback allow output',
      }, {
        CODEX_HOME: join(wd, 'codex-home'),
        HOME: join(wd, 'home'),
        USERPROFILE: join(wd, 'home'),
        OMX_SESSION_ID: sessionId,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const notifyLog = await readJsonLogFiles(join(wd, '.omx', 'logs'), 'notify-hook-');
      assert.equal(
        notifyLog.filter((entry) =>
          entry.type === 'completed_turn_delivery_allowed'
          && entry.turn_id === turnId
        ).length,
        1,
      );
      assert.equal(
        notifyLog.some((entry) =>
          entry.type === 'project_fallback_turn_dedupe_allow_claim_recovered_before_delivery'
          && entry.phase === 'before_project_owner_upgrade'
          && entry.turn_id === turnId
        ),
        true,
      );
      const projectState = JSON.parse(
        await readFile(join(stateDir, 'notify-hook-turn-dedupe.json'), 'utf-8'),
      ) as { turn_claims?: Record<string, { delivery_status?: string }> };
      const fallbackState = JSON.parse(
        await readFile(join(stateDir, 'notify-hook-state.json'), 'utf-8'),
      ) as { turn_claims?: Record<string, { delivery_status?: string }> };
      assert.equal(projectState.turn_claims?.[key]?.delivery_status, 'committed');
      assert.equal(fallbackState.turn_claims?.[key]?.delivery_status, 'committed');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('persists visual-verdict feedback from runtime assistant output', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-visual-'));
    try {
      const sessionId = 'sessVisual';
      const result = runNotifyHook({
        cwd: wd,
        session_id: sessionId,
        type: 'agent-turn-complete',
        thread_id: 'th-visual',
        turn_id: 'tu-visual',
        input_messages: [],
        last_assistant_message: [
          'Visual verdict ready:',
          '```json',
          JSON.stringify({
            score: 84,
            verdict: 'revise',
            category_match: true,
            differences: [
              'Primary CTA is 3px too low',
              'Card corner radius is too round',
            ],
            suggestions: [
              'Move primary CTA up by 3px',
              'Set card border-radius to 8px',
            ],
            reasoning: 'Core layout is close, but CTA alignment and shape still differ.',
          }, null, 2),
          '```',
        ].join('\n'),
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);

      const progressPath = join(wd, '.omx', 'state', 'sessions', sessionId, 'ralph-progress.json');
      assert.equal(existsSync(progressPath), true);
      const progress = JSON.parse(await readFile(progressPath, 'utf-8')) as {
        visual_feedback?: Array<{
          score: number;
          verdict: string;
          qualitative_feedback?: { next_actions?: string[] };
        }>;
      };

      assert.equal(Array.isArray(progress.visual_feedback), true);
      assert.equal(progress.visual_feedback?.length, 1);
      assert.equal(progress.visual_feedback?.[0]?.score, 84);
      assert.equal(progress.visual_feedback?.[0]?.verdict, 'revise');
      assert.equal(
        (progress.visual_feedback?.[0]?.qualitative_feedback?.next_actions?.length || 0) <= VISUAL_NEXT_ACTIONS_LIMIT,
        true,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
