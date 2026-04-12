import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildMissionExecutionPlan,
  buildMissionSourcePack,
  compileMissionAcceptanceContract,
  compileMissionBrief,
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
    assert.deepEqual(
      sourcePack.sources.map((source) => source.source_id),
      ['source-01', 'source-02'],
    );
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
      assert.equal(second.artifacts.acceptanceContract.contract_revision, 2);
      assert.equal(second.artifacts.executionPlan.plan_revision, 2);
      assert.equal(second.artifacts.executionPlan.previous_plan_id, first.artifacts.executionPlan.plan_id);
      assert.equal(second.changed.acceptanceContract, true);
      assert.equal(second.changed.executionPlan, true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
