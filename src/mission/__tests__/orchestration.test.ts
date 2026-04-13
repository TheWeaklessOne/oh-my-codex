import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildMissionPlanningTransaction,
  buildMissionExecutionPlan,
  buildMissionSourcePack,
  compileMissionAcceptanceContract,
  compileMissionBrief,
  missionOrchestrationArtifactPaths,
  isMissionSourceStale,
  prepareMissionOrchestrationArtifacts,
} from '../orchestration.js';
import { createMission, loadMission } from '../kernel.js';

async function initRepo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-mission-orchestration-'));
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd, stdio: 'ignore' });
  await writeFile(join(cwd, 'README.md'), 'hello\n', 'utf-8');
  execFileSync('git', ['add', 'README.md'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'ignore' });
  return cwd;
}

describe('mission orchestration artifacts', () => {
  it('builds a prompt-only source pack and mission brief for prompt-grounded runs', () => {
    const sourcePack = buildMissionSourcePack({
      task: 'Stabilize Mission V2 bootstrap',
      projectTouchpoints: ['src/mission/runtime.ts'],
    });
    const brief = compileMissionBrief(sourcePack);

    assert.equal(sourcePack.sources.length, 1);
    assert.equal(sourcePack.sources[0]?.kind, 'prompt');
    assert.equal(sourcePack.task_statement, 'Stabilize Mission V2 bootstrap');
    assert.equal(brief.task_statement, 'Stabilize Mission V2 bootstrap');
    assert.deepEqual(brief.project_touchpoints, ['src/mission/runtime.ts']);
  });

  it('normalizes external and internal requirement sources through the same adapter shape', () => {
    const sourcePack = buildMissionSourcePack({
      task: 'Close onboarding regression',
      requirementSources: [
        {
          kind: 'issue',
          title: 'Ticket',
          content: 'Users cannot complete onboarding.',
          refs: ['linear://issue/LIN-123'],
          adapter: 'tracker-adapter',
          origin: 'external',
        },
        {
          kind: 'spec',
          title: 'Acceptance spec',
          content: 'Onboarding should succeed and preserve existing mission kernel behavior.',
          refs: ['docs/specs/onboarding.md'],
          adapter: 'doc-adapter',
          origin: 'internal',
        },
      ],
      projectTouchpoints: ['src/mission/runtime.ts', 'src/mission/kernel.ts'],
    });

    assert.deepEqual(
      sourcePack.sources.map((source) => [source.kind, source.adapter_key, source.origin]),
      [
        ['issue', 'tracker-adapter', 'external'],
        ['spec', 'doc-adapter', 'internal'],
      ],
    );
    assert.equal(sourcePack.sources.every((source) => typeof source.source_uri === 'string' && source.source_uri.length > 0), true);
    assert.equal(sourcePack.sources.every((source) => source.snapshot_id.startsWith('snapshot:')), true);
    assert.equal(sourcePack.sources.every((source) => source.content_hash.startsWith('content:')), true);
    assert.deepEqual(
      sourcePack.sources.map((source) => source.source_id),
      ['source-01', 'source-02'],
    );
  });

  it('keeps snapshot identity stable for unchanged sources and detects stale freshness windows', () => {
    const first = buildMissionSourcePack({
      task: 'Replay stable source pack',
      requirementSources: [{
        kind: 'spec',
        title: 'Spec file',
        sourceUri: 'file:///repo/spec.md',
        content: 'Stable mission requirements',
        fetchedAt: '2026-04-13T10:00:00.000Z',
        freshnessTtlSeconds: 60,
      }],
    });
    const second = buildMissionSourcePack({
      task: 'Replay stable source pack',
      requirementSources: [{
        kind: 'spec',
        title: 'Spec file',
        sourceUri: 'file:///repo/spec.md',
        content: 'Stable mission requirements',
        fetchedAt: '2026-04-13T10:15:00.000Z',
        freshnessTtlSeconds: 60,
      }],
    });

    assert.equal(first.sources[0]?.snapshot_id, second.sources[0]?.snapshot_id);
    assert.equal(isMissionSourceStale(first.sources[0]!, new Date('2026-04-13T10:00:30.000Z')), false);
    assert.equal(isMissionSourceStale(first.sources[0]!, new Date('2026-04-13T10:02:00.000Z')), true);
  });

  it('compiles an acceptance contract with explicit verdict criteria and versioned identity', () => {
    const sourcePack = buildMissionSourcePack({ task: 'Ground Mission V2 verifier inputs' });
    const brief = compileMissionBrief(sourcePack);
    const contract = compileMissionAcceptanceContract(brief, {
      acceptanceCriteria: ['Mission writes acceptance-contract.json before audit.'],
      invariants: ['Kernel authority remains authoritative for lifecycle and deltas.'],
      requiredTestEvidence: ['npm test -- mission surface'],
      requiredOperationalEvidence: ['fresh re-audit summary'],
      residualClassificationRules: ['Classify missing verifier evidence as AMBIGUOUS.'],
    });

    assert.deepEqual(Object.keys(contract.status_rules).sort(), ['AMBIGUOUS', 'FAIL', 'PARTIAL', 'PASS']);
    assert.match(contract.contract_id, /^contract:/);
    assert.equal(contract.contract_revision, 1);
    assert.deepEqual(contract.acceptance_criteria, ['Mission writes acceptance-contract.json before audit.']);
    assert.deepEqual(contract.invariants, ['Kernel authority remains authoritative for lifecycle and deltas.']);
  });

  it('routes planning through direct, ralplan, or clarification-blocked handoffs', () => {
    const narrowSourcePack = buildMissionSourcePack({ task: 'Patch the mission runtime bootstrap' });
    const narrowBrief = compileMissionBrief(narrowSourcePack);
    const narrowContract = compileMissionAcceptanceContract(narrowBrief);
    const directPlan = buildMissionExecutionPlan(narrowSourcePack, narrowBrief, narrowContract);

    const broadSourcePack = buildMissionSourcePack({
      task: 'Introduce Mission V2 planning artifacts across multiple mission surfaces',
      requirementSources: [
        { kind: 'issue', content: 'Mission lacks pre-loop grounding.' },
        { kind: 'spec', content: 'Mission V2 needs acceptance contracts.' },
        { kind: 'doc', content: 'Mission must stay project-agnostic.' },
      ],
      projectTouchpoints: [
        'src/mission/runtime.ts',
        'src/mission/kernel.ts',
        'skills/mission/SKILL.md',
        'docs/contracts/mission-kernel-semantics-contract.md',
      ],
    });
    const broadBrief = compileMissionBrief(broadSourcePack);
    const broadContract = compileMissionAcceptanceContract(broadBrief);
    const ralplanPlan = buildMissionExecutionPlan(broadSourcePack, broadBrief, broadContract);

    const blockedSourcePack = buildMissionSourcePack({
      task: 'Ship Mission V2 without enough grounding',
      unknowns: ['Which acceptance contract should the verifier trust?'],
    });
    const blockedBrief = compileMissionBrief(blockedSourcePack);
    const blockedContract = compileMissionAcceptanceContract(blockedBrief);
    const blockedPlan = buildMissionExecutionPlan(blockedSourcePack, blockedBrief, blockedContract);

    assert.equal(directPlan.planning_mode, 'direct');
    assert.equal(directPlan.handoff_surface, 'plan');
    assert.equal(directPlan.status, 'approved');

    assert.equal(ralplanPlan.planning_mode, 'ralplan');
    assert.equal(ralplanPlan.handoff_surface, 'ralplan');
    assert.equal(ralplanPlan.status, 'approved');

    assert.equal(blockedPlan.planning_mode, 'blocked');
    assert.equal(blockedPlan.handoff_surface, 'deep-interview');
    assert.equal(blockedPlan.status, 'blocked');
    assert.match(blockedPlan.blocking_reason || '', /(clarif|unresolved questions)/i);

    const blockedTransaction = buildMissionPlanningTransaction(blockedPlan);
    assert.equal(blockedTransaction.status, 'blocked');
    assert.equal(blockedTransaction.approval_mode, 'needs_clarification');
  });

  it('versions acceptance contracts and execution plans when the mission requirements change', async () => {
    const repo = await initRepo();
    try {
      await createMission({ repoRoot: repo, slug: 'demo', targetFingerprint: 'repo:demo' });
      const mission = await loadMission(repo, 'demo');

      const first = await prepareMissionOrchestrationArtifacts(mission, {
        task: 'Implement Mission V2 workflow',
        acceptanceCriteria: ['Create acceptance-contract.json before audit.'],
        projectTouchpoints: ['src/mission/runtime.ts'],
      });
      const second = await prepareMissionOrchestrationArtifacts(mission, {
        task: 'Implement Mission V2 workflow',
        acceptanceCriteria: ['Create acceptance-contract.json before audit.', 'Emit workflow.json stage state.'],
        projectTouchpoints: ['src/mission/runtime.ts', 'src/mission/workflow.ts'],
        forceRebuild: true,
      });

      assert.equal(first.artifacts.acceptanceContract.contract_revision, 1);
      assert.equal(first.artifacts.executionPlan.plan_revision, 1);
      assert.equal(first.artifacts.planningTransaction.plan_revision, 1);
      assert.equal(first.artifacts.planningTransaction.status, 'approved');
      assert.equal(second.artifacts.acceptanceContract.contract_revision, 2);
      assert.equal(second.artifacts.executionPlan.plan_revision, 2);
      assert.equal(second.artifacts.planningTransaction.plan_revision, 2);
      assert.equal(second.artifacts.planningTransaction.previous_plan_run_id, first.artifacts.planningTransaction.plan_run_id);
      assert.equal(second.artifacts.planningTransaction.replan_reason, 'execution plan changed');
      assert.equal(second.artifacts.executionPlan.previous_plan_id, first.artifacts.executionPlan.plan_id);
      assert.equal(second.changed.acceptanceContract, true);
      assert.equal(second.changed.executionPlan, true);
      const paths = missionOrchestrationArtifactPaths(mission.mission_root);
      assert.equal(existsSync(join(paths.planningTransactionsDir, `${first.artifacts.planningTransaction.plan_run_id}.json`)), false);
      assert.equal(existsSync(join(paths.planningTransactionsArchiveDir, `${first.artifacts.planningTransaction.plan_run_id}.json`)), true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
