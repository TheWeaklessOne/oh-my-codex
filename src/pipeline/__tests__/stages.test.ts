import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync } from 'fs';
import type { StageContext } from '../types.js';
import { createRalplanStage } from '../stages/ralplan.js';
import { createTeamExecStage, buildTeamInstruction } from '../stages/team-exec.js';
import { createRalphVerifyStage, createRalphStage, buildRalphInstruction } from '../stages/ralph-verify.js';
import { createCodeReviewStage, buildCodeReviewInstruction } from '../stages/code-review.js';
import { buildFollowupStaffingPlan } from '../../team/followup-planner.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;

function makeCtx(overrides: Partial<StageContext> = {}): StageContext {
  return {
    task: 'test task',
    artifacts: {},
    cwd: tempDir,
    ...overrides,
  };
}

async function setup(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), 'omx-stages-test-'));
  return tempDir;
}

async function cleanup(): Promise<void> {
  if (tempDir && existsSync(tempDir)) {
    await rm(tempDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// RALPLAN stage tests
// ---------------------------------------------------------------------------

describe('RALPLAN Stage', () => {
  beforeEach(async () => { await setup(); });
  afterEach(async () => { await cleanup(); });

  it('creates a stage with the correct name', () => {
    const stage = createRalplanStage();
    assert.equal(stage.name, 'ralplan');
  });

  it('runs successfully and produces artifacts', async () => {
    const stage = createRalplanStage();
    const result = await stage.run(makeCtx());

    assert.equal(result.status, 'completed');
    assert.equal((result.artifacts as Record<string, unknown>).stage, 'ralplan');
    assert.ok((result.artifacts as Record<string, unknown>).instruction);
  });

  it('canSkip returns false when no plans directory exists', () => {
    const stage = createRalplanStage();
    assert.equal(stage.canSkip!(makeCtx()), false);
  });

  it('canSkip returns false when plans directory is empty', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });

    const stage = createRalplanStage();
    assert.equal(stage.canSkip!(makeCtx()), false);
  });

  it('canSkip returns false when only a prd- plan file exists', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, 'prd-my-feature.md'), '# Plan\n');

    const stage = createRalplanStage();
    assert.equal(stage.canSkip!(makeCtx()), false);
  });

  it('canSkip returns true when both prd and test spec plan files exist', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, 'prd-my-feature.md'), '# Plan\n');
    await writeFile(join(plansDir, 'test-spec-my-feature.md'), '# Test Spec\n');

    const stage = createRalplanStage();
    assert.equal(stage.canSkip!(makeCtx()), true);
  });

  it('canSkip returns false after non-clean code-review loopback even when plans exist', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, 'prd-my-feature.md'), '# Plan\n');
    await writeFile(join(plansDir, 'test-spec-my-feature.md'), '# Test Spec\n');

    const stage = createRalplanStage();
    assert.equal(stage.canSkip!(makeCtx({
      artifacts: {
        return_to_ralplan_reason: 'Review requested a plan update.',
        review_verdict: { recommendation: 'REQUEST CHANGES', architectural_status: 'CLEAR', clean: false },
      },
    })), false);
  });

  it('canSkip returns false when nested code-review artifacts are non-clean', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, 'prd-my-feature.md'), '# Plan\n');
    await writeFile(join(plansDir, 'test-spec-my-feature.md'), '# Test Spec\n');

    const stage = createRalplanStage();
    assert.equal(stage.canSkip!(makeCtx({
      artifacts: {
        'code-review': {
          review_verdict: { recommendation: 'COMMENT', architectural_status: 'CLEAR', clean: true },
          return_to_ralplan_reason: null,
        },
      },
    })), false);
  });

  it('surfaces deep-interview specs in ralplan artifacts for downstream traceability', async () => {
    const specsDir = join(tempDir, '.omx', 'specs');
    await mkdir(specsDir, { recursive: true });
    await writeFile(join(specsDir, 'deep-interview-my-feature.md'), '# Deep Interview Spec\n');

    const stage = createRalplanStage();
    const result = await stage.run(makeCtx());
    const artifacts = result.artifacts as Record<string, unknown>;

    assert.deepEqual(artifacts.deepInterviewSpecPaths, [join(specsDir, 'deep-interview-my-feature.md')]);
    assert.equal(artifacts.planningComplete, false);
  });

  it('can execute a real ralplan runtime when an executor is provided', async () => {
    const stage = createRalplanStage({
      executor: {
        async draft() {
          const plansDir = join(tempDir, '.omx', 'plans');
          await mkdir(plansDir, { recursive: true });
          const prdPath = join(plansDir, 'prd-runtime.md');
          await writeFile(prdPath, '# Runtime Plan\n');
          await writeFile(join(plansDir, 'test-spec-runtime.md'), '# Runtime Tests\n');
          return { summary: 'drafted', planPath: prdPath, artifacts: { runtimeDrafted: true } };
        },
        async architectReview() {
          return { verdict: 'approve', summary: 'architect ok' };
        },
        async criticReview() {
          return { verdict: 'approve', summary: 'critic ok' };
        },
      },
    });

    const result = await stage.run(makeCtx({ task: 'live ralplan run' }));
    const artifacts = result.artifacts as Record<string, unknown>;

    assert.equal(result.status, 'completed');
    assert.equal(artifacts.runtime, true);
    assert.equal(artifacts.planningComplete, true);
    assert.equal(artifacts.iteration, 1);
    assert.equal(artifacts.runtimeDrafted, true);
  });

  it('canSkip returns false for non-prd plan files', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, 'autopilot-spec.md'), '# Spec\n');

    const stage = createRalplanStage();
    assert.equal(stage.canSkip!(makeCtx()), false);
  });
});

// ---------------------------------------------------------------------------
// Team exec stage tests
// ---------------------------------------------------------------------------

describe('Team Exec Stage', () => {
  beforeEach(async () => { await setup(); });
  afterEach(async () => { await cleanup(); });

  it('creates a stage with the correct name', () => {
    const stage = createTeamExecStage();
    assert.equal(stage.name, 'team-exec');
  });

  it('uses default worker count and agent type', async () => {
    const stage = createTeamExecStage();
    const result = await stage.run(makeCtx());

    assert.equal(result.status, 'completed');
    const arts = result.artifacts as Record<string, unknown>;
    assert.equal(arts.workerCount, 2);
    assert.equal(arts.agentType, 'executor');
    assert.equal(arts.residual_followup_required, false);
  });

  it('respects custom worker count and agent type', async () => {
    const stage = createTeamExecStage({ workerCount: 4, agentType: 'architect' });
    const result = await stage.run(makeCtx());

    const arts = result.artifacts as Record<string, unknown>;
    assert.equal(arts.workerCount, 4);
    assert.equal(arts.agentType, 'architect');
  });

  it('includes ralplan artifacts in team task when available', async () => {
    const stage = createTeamExecStage();
    const ctx = makeCtx({
      artifacts: {
        ralplan: { data: 'plan-content', stage: 'ralplan' },
      },
    });
    const result = await stage.run(ctx);

    const descriptor = (result.artifacts as Record<string, unknown>).teamDescriptor as Record<string, unknown>;
    assert.ok((descriptor.task as string).includes('plan-content'));
    assert.ok(Array.isArray(descriptor.availableAgentTypes));
    assert.ok((descriptor.availableAgentTypes as unknown[]).length > 0);
    assert.equal(typeof (descriptor.staffingPlan as Record<string, unknown>).staffingSummary, 'string');
  });

  it('falls back to raw task when no ralplan artifacts exist', async () => {
    const stage = createTeamExecStage();
    const result = await stage.run(makeCtx({ task: 'raw task description' }));

    const descriptor = (result.artifacts as Record<string, unknown>).teamDescriptor as Record<string, unknown>;
    assert.equal(descriptor.task, 'raw task description');
    assert.equal(typeof (descriptor.staffingPlan as Record<string, unknown>).staffingSummary, 'string');
  });

  it('lets callers explicitly opt out of the Ralph fallback request', async () => {
    const stage = createTeamExecStage({ residualFollowupRequired: false });
    const result = await stage.run(makeCtx());

    const arts = result.artifacts as Record<string, unknown>;
    assert.equal(arts.residual_followup_required, false);
  });

  describe('buildTeamInstruction', () => {
    it('builds correct CLI instruction', () => {
      const staffingPlan = buildFollowupStaffingPlan('team', 'implement feature', ['executor', 'test-engineer'], {
        workerCount: 3,
      });
      const instruction = buildTeamInstruction({
        task: 'implement feature',
        workerCount: 3,
        agentType: 'executor',
        roleContract: 'shared-agent-type',
        availableAgentTypes: ['executor', 'test-engineer'],
        staffingPlan,
        useWorktrees: false,
        cwd: '/tmp/test',
      });

      assert.match(instruction, /^omx team 3:executor /);
      assert.match(instruction, /policy=coordinated-default/);
      assert.match(instruction, /role_contract=shared-agent-type/);
      assert.match(instruction, /hardening=bounded/);
      assert.match(instruction, /implement feature/);
      assert.match(instruction, /staffing=/);
      assert.match(instruction, /verify=/);
    });

    it('still emits a launch instruction for long task descriptions', () => {
      const longTask = 'a'.repeat(1000);
      const staffingPlan = buildFollowupStaffingPlan('team', longTask, ['executor', 'test-engineer'], {
        workerCount: 1,
      });
      const instruction = buildTeamInstruction({
        task: longTask,
        workerCount: 1,
        agentType: 'executor',
        roleContract: 'shared-agent-type',
        availableAgentTypes: ['executor', 'test-engineer'],
        staffingPlan,
        useWorktrees: false,
        cwd: '/tmp',
      });

      assert.match(instruction, /^omx team 1:executor /);
      assert.match(instruction, /policy=coordinated-default/);
      assert.match(instruction, /role_contract=shared-agent-type/);
      assert.match(instruction, /staffing=/);
    });
  });
});

// ---------------------------------------------------------------------------
// Ralph verify stage tests
// ---------------------------------------------------------------------------

describe('Ralph Verify Stage', () => {
  beforeEach(async () => { await setup(); });
  afterEach(async () => { await cleanup(); });

  it('creates a stage with the correct name', () => {
    const stage = createRalphVerifyStage();
    assert.equal(stage.name, 'ralph-verify');
  });

  it('uses default max iterations of 10', async () => {
    const stage = createRalphVerifyStage();
    const result = await stage.run(makeCtx({
      artifacts: {
        'team-exec': { residual_followup_required: true },
      },
    }));

    assert.equal(result.status, 'completed');
    const arts = result.artifacts as Record<string, unknown>;
    assert.equal(arts.maxIterations, 10);
  });

  it('respects custom max iterations', async () => {
    const stage = createRalphVerifyStage({ maxIterations: 25 });
    const result = await stage.run(makeCtx({
      artifacts: {
        'team-exec': { residual_followup_required: true },
      },
    }));

    const arts = result.artifacts as Record<string, unknown>;
    assert.equal(arts.maxIterations, 25);
  });

  it('includes team-exec artifacts in verification context', async () => {
    const stage = createRalphVerifyStage();
    const ctx = makeCtx({
      artifacts: {
        'team-exec': { teamDescriptor: { task: 'completed work' }, residual_followup_required: true },
      },
    });
    const result = await stage.run(ctx);

    const descriptor = (result.artifacts as Record<string, unknown>).verifyDescriptor as Record<string, unknown>;
    const execArtifacts = descriptor.executionArtifacts as Record<string, unknown>;
    assert.ok(execArtifacts.teamDescriptor);
    assert.ok(Array.isArray(descriptor.availableAgentTypes));
    assert.equal(typeof (descriptor.staffingPlan as Record<string, unknown>).staffingSummary, 'string');
  });

  it('skips Ralph follow-up when team execution did not request a residual fallback', async () => {
    const stage = createRalphVerifyStage();
    const result = await stage.run(makeCtx({
      artifacts: {
        'team-exec': { residual_followup_required: false },
      },
    }));

    assert.equal(result.status, 'skipped');
    assert.equal((result.artifacts as Record<string, unknown>).reason, 'no residual follow-up requested after team execution');
    assert.equal(stage.canSkip?.(makeCtx({
      artifacts: {
        'team-exec': { residual_followup_required: false },
      },
    })), true);
  });

  it('preserves legacy verification context precedence over ralplan artifacts', async () => {
    const stage = createRalphVerifyStage();
    const result = await stage.run(makeCtx({
      artifacts: {
        ralplan: { plan: 'approved plan' },
        'team-exec': { teamDescriptor: { task: 'completed work' }, residual_followup_required: true },
      },
    }));

    const descriptor = (result.artifacts as Record<string, unknown>).verifyDescriptor as Record<string, unknown>;
    assert.deepEqual(descriptor.executionArtifacts, { teamDescriptor: { task: 'completed work' }, residual_followup_required: true });
  });

  describe('buildRalphInstruction', () => {
    it('includes max iterations in instruction', () => {
      const staffingPlan = buildFollowupStaffingPlan('ralph', 'verify feature', ['architect', 'executor', 'test-engineer']);
      const instruction = buildRalphInstruction({
        task: 'verify feature',
        maxIterations: 15,
        cwd: '/tmp',
        availableAgentTypes: ['architect', 'executor', 'test-engineer'],
        staffingPlan,
        executionArtifacts: {},
      });

      assert.match(instruction, /max_iterations=15/);
      assert.match(instruction, /policy=bounded-fallback/);
      assert.match(instruction, /hardening=bounded/);
      assert.match(instruction, /^omx ralph /);
      assert.match(instruction, /verify feature/);
      assert.match(instruction, /staffing=/);
      assert.match(instruction, /verify=/);
    });

    it('still emits a launch instruction for long task descriptions', () => {
      const longTask = 'b'.repeat(500);
      const staffingPlan = buildFollowupStaffingPlan('ralph', longTask, ['architect', 'executor', 'test-engineer']);
      const instruction = buildRalphInstruction({
        task: longTask,
        maxIterations: 10,
        cwd: '/tmp',
        availableAgentTypes: ['architect', 'executor', 'test-engineer'],
        staffingPlan,
        executionArtifacts: {},
      });

      assert.match(instruction, /^omx ralph /);
      assert.match(instruction, /policy=bounded-fallback/);
      assert.match(instruction, /staffing=/);
    });
  });
});


// ---------------------------------------------------------------------------
// Strict Autopilot stage tests
// ---------------------------------------------------------------------------

describe('Strict Autopilot Ralph Stage', () => {
  beforeEach(async () => { await setup(); });
  afterEach(async () => { await cleanup(); });

  it('uses the strict phase name ralph', () => {
    assert.equal(createRalphStage().name, 'ralph');
  });

  it('uses ralplan artifacts as the primary strict ralph execution input', async () => {
    const result = await createRalphStage().run(makeCtx({
      artifacts: {
        ralplan: { plan: 'approved plan' },
        'team-exec': { teamDescriptor: { task: 'legacy work' } },
      },
    }));

    const descriptor = (result.artifacts as Record<string, unknown>).verifyDescriptor as Record<string, unknown>;
    assert.deepEqual(descriptor.executionArtifacts, { plan: 'approved plan' });
  });
});

describe('Code Review Stage', () => {
  beforeEach(async () => { await setup(); });
  afterEach(async () => { await cleanup(); });

  it('creates a strict code-review stage that fails closed without review evidence', async () => {
    const stage = createCodeReviewStage();
    assert.equal(stage.name, 'code-review');
    const result = await stage.run(makeCtx({ artifacts: { ralph: { tests: 'passed' } } }));
    const artifacts = result.artifacts as Record<string, unknown>;
    const verdict = artifacts.review_verdict as Record<string, unknown>;
    assert.equal(result.status, 'completed');
    assert.equal(verdict.clean, false);
    assert.equal(verdict.recommendation, 'REQUEST CHANGES');
    assert.equal(verdict.architectural_status, 'BLOCK');
    assert.equal(artifacts.return_to_ralplan_reason, 'Code-review evidence missing; fail closed and return to ralplan.');
  });

  it('marks explicit approve and clear review evidence as clean', async () => {
    const stage = createCodeReviewStage({ recommendation: 'APPROVE', architecturalStatus: 'CLEAR' });
    const result = await stage.run(makeCtx({ artifacts: { ralph: { tests: 'passed' } } }));
    const artifacts = result.artifacts as Record<string, unknown>;
    const verdict = artifacts.review_verdict as Record<string, unknown>;
    assert.equal(verdict.clean, true);
    assert.equal(verdict.recommendation, 'APPROVE');
    assert.equal(verdict.architectural_status, 'CLEAR');
    assert.equal(artifacts.return_to_ralplan_reason, null);
  });

  it('marks non-clean review as return-to-ralplan input', async () => {
    const stage = createCodeReviewStage({ recommendation: 'REQUEST CHANGES', architecturalStatus: 'BLOCK', summary: 'fix review findings' });
    const result = await stage.run(makeCtx());
    const artifacts = result.artifacts as Record<string, unknown>;
    const verdict = artifacts.review_verdict as Record<string, unknown>;
    assert.equal(verdict.clean, false);
    assert.equal(artifacts.return_to_ralplan_reason, 'fix review findings');
  });

  it('builds a code-review instruction', () => {
    assert.match(buildCodeReviewInstruction('review me'), /^\$code-review /);
  });
});
