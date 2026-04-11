import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { MissionLaneSummaryInput } from '../contracts.js';
import { loadMission } from '../kernel.js';
import {
  cancelMissionRuntime,
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

      await recordMissionRuntimeLaneSummary(repo, 'demo', 'remediation', {
        verdict: 'PASS',
        confidence: 'high',
        residuals: [],
        evidence_refs: ['logs/remediation.txt'],
        recommended_next_action: 'execute fix',
        provenance: {
          lane_id: 'remediation-lane-1',
          session_id: 'remediation-session-1',
          lane_type: 'remediation',
          runner_type: 'direct',
          adapter_version: 'mission-adapter/v1',
          started_at: '2026-04-11T17:00:00.000Z',
          finished_at: '2026-04-11T17:05:00.000Z',
          parent_iteration: 1,
          trigger_reason: 'remediation stage',
        },
      });
      await recordMissionRuntimeLaneSummary(repo, 'demo', 'execution', {
        verdict: 'PASS',
        confidence: 'high',
        residuals: [],
        evidence_refs: ['logs/execution.txt'],
        recommended_next_action: 'harden',
        provenance: {
          lane_id: 'execution-lane-1',
          session_id: 'execution-session-1',
          lane_type: 'execution',
          runner_type: 'team',
          adapter_version: 'mission-adapter/v1',
          started_at: '2026-04-11T17:00:00.000Z',
          finished_at: '2026-04-11T17:05:00.000Z',
          parent_iteration: 1,
          trigger_reason: 'execution stage',
        },
      });
      await recordMissionRuntimeLaneSummary(repo, 'demo', 'hardening', {
        verdict: 'PASS',
        confidence: 'high',
        residuals: [],
        evidence_refs: ['logs/hardening.txt'],
        recommended_next_action: 're-audit',
        provenance: {
          lane_id: 'hardening-lane-1',
          session_id: 'hardening-session-1',
          lane_type: 'hardening',
          runner_type: 'ralph',
          adapter_version: 'mission-adapter/v1',
          started_at: '2026-04-11T17:00:00.000Z',
          finished_at: '2026-04-11T17:05:00.000Z',
          parent_iteration: 1,
          trigger_reason: 'hardening stage',
        },
      });
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

  it('keeps audit and re-audit isolated from execution lane provenance', async () => {
    const repo = await initRepo();
    try {
      const runtime = await prepareMissionRuntime({
        repoRoot: repo,
        slug: 'demo',
        targetFingerprint: 'repo:demo',
      });

      await recordMissionRuntimeLaneSummary(repo, 'demo', 'audit', {
        ...laneSummary('audit', 1, 'PARTIAL'),
        provenance: {
          ...laneSummary('audit', 1, 'PARTIAL').provenance,
          session_id: 'audit-session-fresh',
          lane_id: 'audit-lane-fresh',
        },
      });
      await recordMissionRuntimeLaneSummary(repo, 'demo', 'execution', {
        verdict: 'PASS',
        confidence: 'high',
        residuals: [],
        evidence_refs: ['logs/exec.txt'],
        recommended_next_action: 'handoff to hardening',
        provenance: {
          lane_id: 'execution-lane-1',
          session_id: 'execution-session-1',
          lane_type: 'execution',
          runner_type: 'team',
          adapter_version: 'mission-adapter/v1',
          started_at: '2026-04-11T17:00:00.000Z',
          finished_at: '2026-04-11T17:05:00.000Z',
          parent_iteration: 1,
          trigger_reason: 'execution stage',
        },
      });
      await recordMissionRuntimeLaneSummary(repo, 'demo', 're_audit', {
        ...laneSummary('re_audit', 1, 'PASS'),
        provenance: {
          ...laneSummary('re_audit', 1, 'PASS').provenance,
          session_id: 're-audit-session-fresh',
          lane_id: 're-audit-lane-fresh',
        },
      });

      const auditSummary = JSON.parse(await readFile(runtime.lanePlans.audit.summaryPath, 'utf-8')) as {
        provenance: { session_id: string; lane_id: string; read_only?: boolean };
      };
      const reAuditSummary = JSON.parse(await readFile(runtime.lanePlans.re_audit.summaryPath, 'utf-8')) as {
        provenance: { session_id: string; lane_id: string; read_only?: boolean };
      };
      const executionSummary = JSON.parse(await readFile(runtime.lanePlans.execution.summaryPath, 'utf-8')) as {
        provenance: { session_id: string; lane_id: string };
      };

      assert.notEqual(auditSummary.provenance.session_id, executionSummary.provenance.session_id);
      assert.notEqual(reAuditSummary.provenance.session_id, executionSummary.provenance.session_id);
      assert.notEqual(auditSummary.provenance.lane_id, executionSummary.provenance.lane_id);
      assert.notEqual(reAuditSummary.provenance.lane_id, executionSummary.provenance.lane_id);
      assert.equal(auditSummary.provenance.read_only, true);
      assert.equal(reAuditSummary.provenance.read_only, true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('ignores duplicate or late lane summaries after runtime cancellation', async () => {
    const repo = await initRepo();
    try {
      await prepareMissionRuntime({
        repoRoot: repo,
        slug: 'demo',
        targetFingerprint: 'repo:demo',
      });

      const first = await recordMissionRuntimeLaneSummary(repo, 'demo', 'audit', laneSummary('audit', 1, 'PARTIAL'));
      const duplicate = await recordMissionRuntimeLaneSummary(repo, 'demo', 'audit', laneSummary('audit', 1, 'PARTIAL'));
      assert.equal(first.status, 'written');
      assert.equal(duplicate.status, 'duplicate');

      const cancelled = await cancelMissionRuntime(repo, 'demo', 'operator requested cancellation');
      assert.equal(cancelled.status, 'cancelling');

      const late = await recordMissionRuntimeLaneSummary(repo, 'demo', 're_audit', laneSummary('re_audit', 1, 'PASS'));
      assert.equal(late.status, 'ignored');
      assert.equal(late.reason, 'cancelled');

      await recordMissionRuntimeLaneSummary(repo, 'demo', 'remediation', {
        verdict: 'PASS',
        confidence: 'high',
        residuals: [],
        evidence_refs: ['logs/remediation.txt'],
        recommended_next_action: 'cancelled',
        provenance: {
          lane_id: 'remediation-lane-1',
          session_id: 'remediation-session-1',
          lane_type: 'remediation',
          runner_type: 'direct',
          adapter_version: 'mission-adapter/v1',
          started_at: '2026-04-11T17:00:00.000Z',
          finished_at: '2026-04-11T17:05:00.000Z',
          parent_iteration: 1,
          trigger_reason: 'late remediation',
        },
      });
      await recordMissionRuntimeLaneSummary(repo, 'demo', 'execution', {
        verdict: 'PASS',
        confidence: 'high',
        residuals: [],
        evidence_refs: ['logs/execution.txt'],
        recommended_next_action: 'cancelled',
        provenance: {
          lane_id: 'execution-lane-1',
          session_id: 'execution-session-1',
          lane_type: 'execution',
          runner_type: 'team',
          adapter_version: 'mission-adapter/v1',
          started_at: '2026-04-11T17:00:00.000Z',
          finished_at: '2026-04-11T17:05:00.000Z',
          parent_iteration: 1,
          trigger_reason: 'late execution',
        },
      });
      await recordMissionRuntimeLaneSummary(repo, 'demo', 'hardening', {
        verdict: 'PASS',
        confidence: 'high',
        residuals: [],
        evidence_refs: ['logs/hardening.txt'],
        recommended_next_action: 'cancelled',
        provenance: {
          lane_id: 'hardening-lane-1',
          session_id: 'hardening-session-1',
          lane_type: 'hardening',
          runner_type: 'ralph',
          adapter_version: 'mission-adapter/v1',
          started_at: '2026-04-11T17:00:00.000Z',
          finished_at: '2026-04-11T17:05:00.000Z',
          parent_iteration: 1,
          trigger_reason: 'late hardening',
        },
      });
      const reconciled = await loadMission(repo, 'demo');
      assert.equal(reconciled.status, 'cancelled');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('does not advance to a new iteration when only delta.json exists after a torn commit', async () => {
    const repo = await initRepo();
    try {
      const runtime = await prepareMissionRuntime({
        repoRoot: repo,
        slug: 'demo',
        targetFingerprint: 'repo:demo',
      });
      await writeFile(runtime.deltaFile, JSON.stringify({
        previous_iteration: null,
        current_iteration: 1,
        previous_verdict: null,
        current_verdict: 'PASS',
        improved_residual_ids: [],
        unchanged_residual_ids: [],
        regressed_residual_ids: [],
        resolved_residual_ids: [],
        introduced_residual_ids: [],
        oscillating_residual_ids: [],
        lineage_split_residual_ids: [],
        lineage_merge_residual_ids: [],
        low_confidence_residual_ids: [],
        severity_rollup: {
          improved: 0,
          unchanged: 0,
          regressed: 0,
          resolved: 0,
          introduced: 0,
        },
      }, null, 2));

      const resumed = await prepareMissionRuntime({
        repoRoot: repo,
        slug: 'demo',
        targetFingerprint: 'repo:demo',
      });
      assert.equal(resumed.iteration.iteration, 1);
      assert.equal(resumed.iteration.resumed, true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
