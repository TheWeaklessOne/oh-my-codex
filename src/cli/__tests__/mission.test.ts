import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { missionCommand, parseMissionCliArgs } from '../mission.js';

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
  it('separates launch flags from mission text while preserving passthrough task words', () => {
    const parsed = parseMissionCliArgs([
      '--model', 'gpt-5.4',
      '--provider=openai',
      '--config', 'custom.toml',
      'audit', 'this',
      '--',
      '--task-with-leading-dash',
    ]);

    assert.equal(parsed.task, 'audit this --task-with-leading-dash');
    assert.deepEqual(parsed.launchArgs, [
      '--model', 'gpt-5.4',
      '--provider=openai',
      '--config', 'custom.toml',
    ]);
  });

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

  it('forwards launch args to Codex and restores the appendix env after launch', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-mission-launch-'));
    const originalCwd = process.cwd();
    const previousAppendix = process.env.OMX_MISSION_APPEND_INSTRUCTIONS_FILE;

    try {
      process.chdir(cwd);
      const launches: string[][] = [];

      await missionCommand(
        ['--model', 'gpt-5.4', '--provider=openai', 'close', 'the', 'mission'],
        {
          async launchWithHud(args) {
            launches.push(args);
            const appendix = process.env.OMX_MISSION_APPEND_INSTRUCTIONS_FILE;
            assert.ok(typeof appendix === 'string' && appendix.endsWith('.omx/mission/session-instructions.md'));
            assert.equal(existsSync(appendix), true);
          },
        },
      );

      assert.deepEqual(launches, [['--model', 'gpt-5.4', '--provider=openai', '$mission close the mission']]);
      assert.equal(process.env.OMX_MISSION_APPEND_INSTRUCTIONS_FILE, previousAppendix);
    } finally {
      process.chdir(originalCwd);
      if (typeof previousAppendix === 'string') process.env.OMX_MISSION_APPEND_INSTRUCTIONS_FILE = previousAppendix;
      else delete process.env.OMX_MISSION_APPEND_INSTRUCTIONS_FILE;
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
