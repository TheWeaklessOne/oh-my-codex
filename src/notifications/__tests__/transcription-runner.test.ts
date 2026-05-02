import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createChildProcessRunner } from '../transcription/runner.js';

function nodeEval(source: string): string[] {
  return ['-e', source];
}

async function waitForDead(pid: number, timeoutMs = 1500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

describe('transcription child-process runner', () => {
  it('runs commands with a minimal environment that excludes notification secrets', async () => {
    const runner = createChildProcessRunner();
    const result = await runner({
      command: process.execPath,
      args: nodeEval('process.stdout.write(JSON.stringify({ token: process.env.OMX_TELEGRAM_BOT_TOKEN ?? null, hasPath: Boolean(process.env.PATH) }))'),
      env: {
        PATH: process.env.PATH ?? '/usr/bin',
        OMX_TELEGRAM_BOT_TOKEN: 'secret-token',
      },
    });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), { token: null, hasPath: true });
  });

  it('captures process failures and bounded output', async () => {
    const runner = createChildProcessRunner();
    const result = await runner({
      command: process.execPath,
      args: nodeEval('process.stdout.write("x".repeat(200)); process.stderr.write("bad"); process.exit(3)'),
      maxStdoutBytes: 32,
    });

    assert.equal(result.exitCode, 3);
    assert.match(result.stdout, /\[truncated\]/);
    assert.equal(result.stderr, 'bad');
  });

  it('returns spawn errors without throwing', async () => {
    const runner = createChildProcessRunner();
    const result = await runner({
      command: '/definitely/not/a/real/omx-transcription-binary',
      args: [],
    });

    assert.equal(result.exitCode, null);
    assert.ok(result.error);
  });

  it('times out slow commands', async () => {
    const runner = createChildProcessRunner();
    const result = await runner({
      command: process.execPath,
      args: nodeEval('setInterval(() => {}, 1000)'),
      timeoutMs: 20,
    });

    assert.equal(result.timedOut, true);
    assert.ok(result.error);
  });

  it('kills descendants in the timed-out process group on POSIX', async (t) => {
    if (process.platform === 'win32') {
      t.skip('process-group signalling is POSIX-only');
      return;
    }

    const root = await mkdtemp(join(tmpdir(), 'omx-runner-process-tree-'));
    const childPidPath = join(root, 'child.pid');
    const wrapperPath = join(root, 'wrapper.mjs');
    await writeFile(wrapperPath, `
      import { spawn } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));
      setInterval(() => {}, 1000);
    `);

    try {
      const runner = createChildProcessRunner();
      const result = await runner({
        command: process.execPath,
        args: [wrapperPath],
        timeoutMs: 50,
      });
      assert.equal(result.timedOut, true);

      const childPid = Number(await readFile(childPidPath, 'utf-8'));
      assert.ok(Number.isInteger(childPid));
      assert.equal(await waitForDead(childPid), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
