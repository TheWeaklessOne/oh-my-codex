import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
      '--source', 'https://tracker.example/issues/123',
      '--constraint', 'do not break kernel authority',
      '--touchpoint', 'src/mission/runtime.ts',
      '--high-risk',
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
    assert.deepEqual(parsed.bootstrap.sourceRefs, ['https://tracker.example/issues/123']);
    assert.deepEqual(parsed.bootstrap.constraints, ['do not break kernel authority']);
    assert.deepEqual(parsed.bootstrap.touchpoints, ['src/mission/runtime.ts']);
    assert.equal(parsed.bootstrap.highRisk, true);
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
            const appendixContent = await readFile(appendix, 'utf-8');
            assert.match(appendixContent, /Mission brief:/);
            assert.match(appendixContent, /Acceptance contract:/);
            assert.match(appendixContent, /Execution plan:/);
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

  it('bootstraps Mission V2 artifacts from source-file inputs before launch', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-mission-source-file-'));
    const originalCwd = process.cwd();
    try {
      process.chdir(cwd);
      await writeFile(join(cwd, 'requirements.md'), '# Mission\n\nUse file-backed requirements.\n', 'utf-8');

      await missionCommand(
        ['--source-file', 'requirements.md', '--desired-outcome', 'Ship Mission V2', 'implement', 'mission', 'workflow'],
        {
          async launchWithHud() {
            const sourcePack = JSON.parse(await readFile(join(cwd, '.omx', 'missions', 'implement-mission-workflow', 'source-pack.json'), 'utf-8')) as {
              desired_outcome: string;
              sources: Array<{ refs: string[]; content: string }>;
            };
            const workflow = JSON.parse(await readFile(join(cwd, '.omx', 'missions', 'implement-mission-workflow', 'workflow.json'), 'utf-8')) as {
              current_stage: string;
              artifact_refs: { mission_brief: string; execution_plan: string };
            };

            assert.equal(sourcePack.desired_outcome, 'Ship Mission V2');
            assert.equal(sourcePack.sources.some((source) => source.refs.includes('requirements.md')), true);
            assert.equal(sourcePack.sources.some((source) => /Use file-backed requirements/i.test(source.content)), true);
            assert.equal(workflow.current_stage, 'audit');
            assert.match(workflow.artifact_refs.mission_brief, /mission-brief\.md$/);
            assert.match(workflow.artifact_refs.execution_plan, /execution-plan\.md$/);
          },
        },
      );
    } finally {
      process.chdir(originalCwd);
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
