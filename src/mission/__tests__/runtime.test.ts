import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { MissionLaneSummaryInput } from '../contracts.js';
import { loadMission } from '../kernel.js';
import {
  commitMissionRuntimeIteration,
  prepareMissionRuntime,
  recordMissionRuntimeLaneSummary,
} from '../runtime.js';

async function initRepo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-mission-runtime-'));
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd, stdio: 'ignore' });
  await writeFile(join(cwd, 'README.md'), 'hello\n', 'utf-8');
  execFileSync('git', ['add', 'README.md'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'ignore' });
  return cwd;
}

function laneSummary(
  laneType: 'audit' | 're_audit',
  iteration: number,
  verdict: 'PASS' | 'PARTIAL',
): MissionLaneSummaryInput {
  return {
    verdict,
    confidence: 'high',
    residuals: verdict === 'PASS'
      ? []
      : [{
          title: 'Residual remains',
          summary: 'Residual remains',
          severity: 'medium',
          target_path: 'src/mission/kernel.ts',
          symbol: 'commitIteration',
        }],
    evidence_refs: ['logs/runtime.txt'],
    recommended_next_action: verdict === 'PASS' ? 'close mission' : 'keep iterating',
    provenance: {
      lane_id: `${laneType}-lane-${iteration}`,
      session_id: `${laneType}-session-${iteration}`,
      lane_type: laneType,
      runner_type: 'direct',
      adapter_version: 'mission-adapter/v1',
      started_at: '2026-04-11T17:00:00.000Z',
      finished_at: '2026-04-11T17:05:00.000Z',
      parent_iteration: iteration,
      trigger_reason: `${laneType} stage`,
      read_only: true,
    },
  };
}

describe('mission runtime', () => {
  it('prepares the mission runtime with lane routing and authoritative artifact paths', async () => {
    const repo = await initRepo();
    try {
      const runtime = await prepareMissionRuntime({
        repoRoot: repo,
        slug: 'demo',
        targetFingerprint: 'repo:demo',
      });

      assert.equal(runtime.mission.slug, 'demo');
      assert.equal(runtime.iteration.iteration, 1);
      assert.equal(runtime.lanePlans.execution.runnerType, 'team');
      assert.equal(runtime.lanePlans.hardening.runnerType, 'ralph');
      assert.equal(runtime.lanePlans.audit.readOnly, true);
      assert.equal(runtime.lanePlans.re_audit.freshSession, true);
      assert.equal(existsSync(runtime.missionFile), true);
      assert.equal(runtime.latestFile.endsWith('latest.json'), true);
      assert.equal(runtime.deltaFile.endsWith('delta.json'), true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('resumes the current mission and reuses the active iteration when no delta was committed', async () => {
    const repo = await initRepo();
    try {
      const first = await prepareMissionRuntime({
        repoRoot: repo,
        slug: 'demo',
        targetFingerprint: 'repo:demo',
      });
      const second = await prepareMissionRuntime({
        repoRoot: repo,
        slug: 'demo',
        targetFingerprint: 'repo:demo',
      });

      assert.equal(second.mission.mission_id, first.mission.mission_id);
      assert.equal(second.iteration.iteration, first.iteration.iteration);
      assert.equal(second.iteration.resumed, true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('records lane summaries through the runtime bridge and commits latest.json after success', async () => {
    const repo = await initRepo();
    try {
      const runtime = await prepareMissionRuntime({
        repoRoot: repo,
        slug: 'demo',
        targetFingerprint: 'repo:demo',
      });

      const written = await recordMissionRuntimeLaneSummary(repo, 'demo', 'audit', laneSummary('audit', 1, 'PARTIAL'));
      assert.equal(written.status, 'written');

      await recordMissionRuntimeLaneSummary(repo, 'demo', 're_audit', laneSummary('re_audit', 1, 'PASS'));
      const committed = await commitMissionRuntimeIteration(repo, 'demo', {
        iteration_commit_succeeded: true,
        no_unreconciled_lane_errors: true,
        focused_checks_green: true,
      });

      assert.equal(committed.mission.status, 'complete');
      const mission = await loadMission(repo, 'demo');
      assert.equal(mission.latest_summary_path, runtime.lanePlans.re_audit.summaryPath);
      assert.equal(existsSync(runtime.latestFile), true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
