import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function runOmx(cwd: string, argv: string[]) {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, '..', '..', '..');
  const omxBin = join(repoRoot, 'dist', 'cli', 'omx.js');
  return spawnSync(process.execPath, [omxBin, ...argv], {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      OMX_AUTO_UPDATE: '0',
      OMX_NOTIFY_FALLBACK: '0',
      OMX_HOOK_DERIVED_SIGNALS: '0',
    },
  });
}

describe('omx mission', () => {
  it('documents mission in top-level help', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-mission-help-'));
    try {
      const result = runOmx(cwd, ['--help']);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /omx mission\s+Launch Codex with mission supervisor mode active/i);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('routes mission --help to command-local help', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-mission-local-help-'));
    try {
      const result = runOmx(cwd, ['mission', '--help']);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /omx mission - Launch Codex with mission supervisor mode active/i);
      assert.match(result.stdout, /omx mission \[mission goal text\.\.\.\]/i);
      assert.match(result.stdout, /uses team as the default coordinated executor/i);
      assert.match(result.stdout, /Ralph only as a bounded fallback/i);
      assert.doesNotMatch(result.stdout, /oh-my-codex \(omx\) - Multi-agent orchestration for Codex CLI/i);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
