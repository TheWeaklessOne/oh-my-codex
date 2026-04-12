import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadMission } from '../kernel.js';
import { prepareMissionRuntime, recordMissionRuntimeLaneSummary, commitMissionRuntimeIteration } from '../runtime.js';
import { loadMissionWorkflow, missionWorkflowPath } from '../workflow.js';
import type { MissionLaneSummaryInput } from '../contracts.js';

async function initRepo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-mission-workflow-'));
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
    residuals: verdict === 'PASS' ? [] : [{
      summary: 'Residual remains',
      severity: 'medium',
      target_path: 'src/mission/runtime.ts',
      symbol: 'prepareMissionRuntime',
    }],
    evidence_refs: ['logs/workflow.txt'],
    recommended_next_action: verdict === 'PASS' ? 'close mission' : 'continue',
    provenance: {
      lane_id: `${laneType}-lane-${iteration}`,
      session_id: `${laneType}-session-${iteration}`,
      lane_type: laneType,
      runner_type: 'direct',
      adapter_version: 'mission-adapter/v1',
      started_at: '2026-04-12T00:00:00.000Z',
      finished_at: '2026-04-12T00:05:00.000Z',
      parent_iteration: iteration,
      trigger_reason: `${laneType} stage`,
      read_only: true,
    },
  };
}

describe('mission workflow state', () => {
  it('tracks Mission V2 stages from planning through closeout without overriding kernel judgment', async () => {
    const repo = await initRepo();
    try {
      const runtime = await prepareMissionRuntime({
        repoRoot: repo,
        slug: 'demo',
        targetFingerprint: 'repo:demo',
        task: 'Implement Mission V2 workflow state',
        acceptanceCriteria: ['workflow.json persists stage transitions'],
      });

      assert.equal(existsSync(missionWorkflowPath(runtime.missionRoot)), true);
      let workflow = await loadMissionWorkflow(runtime.missionRoot);
      assert.equal(workflow?.current_stage, 'audit');

      await recordMissionRuntimeLaneSummary(repo, 'demo', 'audit', laneSummary('audit', 1, 'PARTIAL'));
      workflow = await loadMissionWorkflow(runtime.missionRoot);
      assert.equal(workflow?.current_stage, 'execution-loop');
      assert.equal(workflow?.current_lane, 'audit');

      await recordMissionRuntimeLaneSummary(repo, 'demo', 'remediation', {
        verdict: 'PASS',
        confidence: 'high',
        residuals: [],
        evidence_refs: ['logs/remediation.txt'],
        recommended_next_action: 'execute',
        provenance: {
          lane_id: 'remediation-lane-1',
          session_id: 'remediation-session-1',
          lane_type: 'remediation',
          runner_type: 'direct',
          adapter_version: 'mission-adapter/v1',
          started_at: '2026-04-12T00:00:00.000Z',
          finished_at: '2026-04-12T00:05:00.000Z',
          parent_iteration: 1,
          trigger_reason: 'remediation stage',
        },
      });
      await recordMissionRuntimeLaneSummary(repo, 'demo', 'execution', {
        verdict: 'PASS',
        confidence: 'high',
        residuals: [],
        evidence_refs: ['logs/execution.txt'],
        recommended_next_action: 're-audit',
        provenance: {
          lane_id: 'execution-lane-1',
          session_id: 'execution-session-1',
          lane_type: 'execution',
          runner_type: 'team',
          adapter_version: 'mission-adapter/v1',
          started_at: '2026-04-12T00:00:00.000Z',
          finished_at: '2026-04-12T00:05:00.000Z',
          parent_iteration: 1,
          trigger_reason: 'execution stage',
        },
      });
      await recordMissionRuntimeLaneSummary(repo, 'demo', 're_audit', laneSummary('re_audit', 1, 'PASS'));
      const committed = await commitMissionRuntimeIteration(repo, 'demo', {
        iteration_commit_succeeded: true,
        no_unreconciled_lane_errors: true,
        focused_checks_green: true,
      });

      const mission = await loadMission(repo, 'demo');
      workflow = await loadMissionWorkflow(runtime.missionRoot);
      assert.equal(mission.status, 'complete');
      assert.equal(workflow?.current_stage, 'closeout');
      assert.equal(workflow?.closeout_status, 'complete');
      assert.equal(workflow?.artifact_refs.closeout?.endsWith('closeout.md'), true);
      assert.equal(workflow?.stage_history.some((entry) => entry.stage === 'intake'), true);
      assert.equal(workflow?.stage_history.some((entry) => entry.stage === 'source-grounding'), true);
      assert.equal(workflow?.stage_history.some((entry) => entry.stage === 'contract-build'), true);
      assert.equal(workflow?.stage_history.some((entry) => entry.stage === 'planning'), true);
      assert.equal(workflow?.stage_history.some((entry) => entry.stage === 'audit'), true);
      assert.equal(workflow?.stage_history.some((entry) => entry.stage === 'execution-loop'), true);
      assert.equal(workflow?.stage_history.some((entry) => entry.stage === 'closeout'), true);
      assert.equal(workflow?.strategy_key, committed.mission.last_strategy_key);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
