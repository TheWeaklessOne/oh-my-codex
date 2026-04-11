import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { MissionLaneSummaryInput } from '../contracts.js';
import {
  cancelMission,
  commitIteration,
  createMission,
  loadMission,
  recordLaneSummary,
  startIteration,
} from '../kernel.js';

async function initRepo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-mission-kernel-'));
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd, stdio: 'ignore' });
  await writeFile(join(cwd, 'README.md'), 'hello\n', 'utf-8');
  execFileSync('git', ['add', 'README.md'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'ignore' });
  return cwd;
}

function laneSummary(
  laneType: 'audit' | 'remediation' | 'execution' | 'hardening' | 're_audit',
  iteration: number,
  overrides: Partial<{
    verdict: 'PASS' | 'PARTIAL' | 'FAIL' | 'AMBIGUOUS';
    confidence: 'high' | 'medium' | 'low';
    summary: string;
    severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
    readOnly: boolean;
  }> = {},
): MissionLaneSummaryInput {
  return {
    verdict: overrides.verdict ?? 'PASS',
    confidence: overrides.confidence ?? 'high',
    residuals: overrides.verdict === 'PASS'
      ? []
      : [{
          title: 'Residual task remains',
          summary: overrides.summary ?? 'Residual task remains',
          severity: overrides.severity ?? 'medium',
          target_path: 'src/mission/kernel.ts',
          symbol: 'commitIteration',
        }],
    evidence_refs: ['logs/e2e.txt'],
    recommended_next_action: overrides.verdict === 'PASS' ? 'close mission' : 'keep iterating',
    provenance: {
      lane_id: `${laneType}-lane-${iteration}`,
      session_id: `${laneType}-session-${iteration}`,
      lane_type: laneType,
      runner_type: laneType === 'execution' ? 'team' : laneType === 'hardening' ? 'ralph' : 'direct',
      adapter_version: 'mission-adapter/v1',
      started_at: '2026-04-11T17:00:00.000Z',
      finished_at: '2026-04-11T17:05:00.000Z',
      parent_iteration: iteration,
      trigger_reason: `${laneType} stage`,
      ...(overrides.readOnly === true ? { read_only: true } : {}),
    },
  };
}

describe('mission kernel', () => {
  it('bootstraps mission state and rejects same-target collisions', async () => {
    const repo = await initRepo();
    try {
      const mission = await createMission({ repoRoot: repo, slug: 'demo', targetFingerprint: 'repo:demo' });
      assert.equal(mission.status, 'running');
      assert.equal(mission.current_iteration, 1);
      assert.equal(existsSync(join(repo, '.omx', 'missions', 'demo', 'mission.json')), true);

      await assert.rejects(
        () => createMission({ repoRoot: repo, slug: 'demo-copy', targetFingerprint: 'repo:demo' }),
        /mission_target_collision/i,
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('creates the mission iteration layout and keeps latest.json absent until commit', async () => {
    const repo = await initRepo();
    try {
      await createMission({ repoRoot: repo, slug: 'demo', targetFingerprint: 'repo:demo' });
      const handle = await startIteration(repo, 'demo', 'initial');
      assert.equal(handle.iteration, 1);
      assert.equal(existsSync(join(handle.iterationDir, 'audit', 'summary.json')), false);
      assert.equal(existsSync(join(repo, '.omx', 'missions', 'demo', 'latest.json')), false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('writes lane summaries once and ignores superseded or cancelled writes deterministically', async () => {
    const repo = await initRepo();
    try {
      await createMission({ repoRoot: repo, slug: 'demo', targetFingerprint: 'repo:demo' });
      await startIteration(repo, 'demo', 'initial');
      const first = await recordLaneSummary(repo, 'demo', 1, 'audit', laneSummary('audit', 1, { verdict: 'PARTIAL', readOnly: true }));
      const duplicate = await recordLaneSummary(repo, 'demo', 1, 'audit', laneSummary('audit', 1, { verdict: 'PARTIAL', readOnly: true }));
      assert.equal(first.status, 'written');
      assert.equal(duplicate.status, 'duplicate');

      const cancelled = await cancelMission(repo, 'demo');
      assert.equal(cancelled.status, 'cancelled');
      const late = await recordLaneSummary(repo, 'demo', 1, 're_audit', laneSummary('re_audit', 1, { verdict: 'PASS', readOnly: true }));
      assert.equal(late.status, 'ignored');
      assert.equal(late.reason, 'cancelled');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('commits a full iteration, writes delta/latest, and closes only on fresh PASS plus green safety baseline', async () => {
    const repo = await initRepo();
    try {
      await createMission({ repoRoot: repo, slug: 'demo', targetFingerprint: 'repo:demo' });
      await startIteration(repo, 'demo', 'initial');
      await recordLaneSummary(repo, 'demo', 1, 'audit', laneSummary('audit', 1, { verdict: 'PARTIAL', confidence: 'high', readOnly: true }));
      await recordLaneSummary(repo, 'demo', 1, 'remediation', laneSummary('remediation', 1, { verdict: 'PASS' }));
      await recordLaneSummary(repo, 'demo', 1, 'execution', laneSummary('execution', 1, { verdict: 'PASS' }));
      await recordLaneSummary(repo, 'demo', 1, 'hardening', laneSummary('hardening', 1, { verdict: 'PASS' }));
      await recordLaneSummary(repo, 'demo', 1, 're_audit', laneSummary('re_audit', 1, { verdict: 'PASS', confidence: 'high', readOnly: true }));

      const committed = await commitIteration(
        repo,
        'demo',
        1,
        {
          iteration_commit_succeeded: true,
          no_unreconciled_lane_errors: true,
          focused_checks_green: true,
        },
      );

      assert.equal(committed.mission.status, 'complete');
      assert.equal(existsSync(join(repo, '.omx', 'missions', 'demo', 'latest.json')), true);
      assert.equal(existsSync(join(repo, '.omx', 'missions', 'demo', 'iterations', '001', 'delta.json')), true);

      const latest = JSON.parse(await readFile(join(repo, '.omx', 'missions', 'demo', 'latest.json'), 'utf-8')) as { latest_verdict: string };
      assert.equal(latest.latest_verdict, 'PASS');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('plateaus deterministically after repeated unchanged residuals once strategy changes', async () => {
    const repo = await initRepo();
    try {
      await createMission({
        repoRoot: repo,
        slug: 'demo',
        targetFingerprint: 'repo:demo',
        plateauPolicy: { max_unchanged_iterations: 1 },
      });

      await startIteration(repo, 'demo', 'strategy-a');
      await recordLaneSummary(repo, 'demo', 1, 're_audit', laneSummary('re_audit', 1, {
        verdict: 'PARTIAL',
        confidence: 'high',
        summary: 'Residual wording drift remains',
        readOnly: true,
      }));
      const firstCommit = await commitIteration(
        repo,
        'demo',
        1,
        {
          iteration_commit_succeeded: true,
          no_unreconciled_lane_errors: true,
          focused_checks_green: true,
        },
        false,
      );
      assert.equal(firstCommit.mission.status, 'running');

      await startIteration(repo, 'demo', 'strategy-b');
      await recordLaneSummary(repo, 'demo', 2, 're_audit', laneSummary('re_audit', 2, {
        verdict: 'PARTIAL',
        confidence: 'high',
        summary: 'Wording drift still remains',
        readOnly: true,
      }));
      const secondCommit = await commitIteration(
        repo,
        'demo',
        2,
        {
          iteration_commit_succeeded: true,
          no_unreconciled_lane_errors: true,
          focused_checks_green: true,
        },
        true,
      );

      assert.equal(secondCommit.mission.status, 'plateau');
      assert.match(secondCommit.judgement.reason, /plateau/i);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('resumes the current iteration without duplicating directories and keeps latest readable after partial progress', async () => {
    const repo = await initRepo();
    try {
      await createMission({ repoRoot: repo, slug: 'demo', targetFingerprint: 'repo:demo' });
      const first = await startIteration(repo, 'demo', 'initial');
      await recordLaneSummary(repo, 'demo', 1, 'audit', laneSummary('audit', 1, { verdict: 'PARTIAL', readOnly: true }));
      const resumed = await startIteration(repo, 'demo', 'initial');

      assert.equal(resumed.iteration, first.iteration);
      assert.equal(resumed.resumed, true);

      const mission = await loadMission(repo, 'demo');
      assert.equal(mission.current_iteration, 1);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
