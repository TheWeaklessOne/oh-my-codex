import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RALPH_HELP,
  assertRequiredRalphPrdJson,
  buildRalphAppendInstructions,
  buildRalphChangedFilesSeedContents,
  extractRalphTaskDescription,
  filterRalphCodexArgs,
  isRalphPrdMode,
  normalizeRalphCliArgs,
  ralphCommand,
} from '../ralph.js';
import type { ApprovedExecutionLaunchHint } from '../../planning/artifacts.js';

describe('extractRalphTaskDescription', () => {
  it('returns plain task text from positional args', () => {
    assert.equal(extractRalphTaskDescription(['fix', 'the', 'bug']), 'fix the bug');
  });
  it('returns default when args are empty', () => {
    assert.equal(extractRalphTaskDescription([]), 'ralph-cli-launch');
  });
  it('reuses approved launch hint task when no explicit task is supplied', () => {
    assert.equal(extractRalphTaskDescription([], 'Execute approved issue 1072 plan'), 'Execute approved issue 1072 plan');
  });
  it('excludes --model value from task text', () => {
    assert.equal(extractRalphTaskDescription(['--model', 'gpt-5', 'fix', 'the', 'bug']), 'fix the bug');
  });
  it('supports -- separator', () => {
    assert.equal(extractRalphTaskDescription(['--model', 'gpt-5', '--', 'fix', '--weird-name']), 'fix --weird-name');
  });
});

describe('isRalphPrdMode', () => {
  it('detects --prd flag usage', () => {
    assert.equal(isRalphPrdMode(['--prd', 'ship release checklist']), true);
  });

  it('detects --prd=value usage', () => {
    assert.equal(isRalphPrdMode(['--prd=ship release checklist']), true);
  });

  it('ignores non-prd Ralph runs', () => {
    assert.equal(isRalphPrdMode(['fix', 'the', 'bug']), false);
  });
});

describe('RALPH_HELP', () => {
  it('clarifies that prompt-side $ralph activation is separate from CLI --prd mode', () => {
    assert.match(RALPH_HELP, /Prompt-side `\$ralph` activation is separate from this CLI entrypoint/i);
    assert.match(RALPH_HELP, /does not imply `--prd` or the PRD\.json startup gate/i);
    assert.match(RALPH_HELP, /unless a Mission hardening gate marks deslop as required/i);
  });
});

describe('normalizeRalphCliArgs', () => {
  it('converts --prd value into positional task text', () => {
    assert.deepEqual(normalizeRalphCliArgs(['--prd', 'ship release checklist']), ['ship release checklist']);
  });
  it('converts --prd=value into positional task text', () => {
    assert.deepEqual(normalizeRalphCliArgs(['--prd=fix the bug']), ['fix the bug']);
  });
  it('preserves other flags and args', () => {
    assert.deepEqual(normalizeRalphCliArgs(['--model', 'gpt-5', '--prd', 'fix it']), ['--model', 'gpt-5', 'fix it']);
  });
});

describe('filterRalphCodexArgs', () => {
  it('consumes --prd so it is not forwarded to codex', () => {
    assert.deepEqual(filterRalphCodexArgs(['--prd', 'build', 'todo', 'app']), ['build', 'todo', 'app']);
  });
  it('consumes --PRD case-insensitively', () => {
    assert.deepEqual(filterRalphCodexArgs(['--PRD', '--model', 'gpt-5']), ['--model', 'gpt-5']);
  });
  it('preserves non-omx flags', () => {
    assert.deepEqual(filterRalphCodexArgs(['--model', 'gpt-5', '--yolo', 'fix', 'it']), ['--model', 'gpt-5', '--yolo', 'fix', 'it']);
  });
});


const approvedHint: ApprovedExecutionLaunchHint = {
  mode: 'ralph',
  command: 'omx ralph "Execute approved issue 1072 plan"',
  task: 'Execute approved issue 1072 plan',
  sourcePath: '.omx/plans/prd-issue-1072.md',
  testSpecPaths: ['.omx/plans/test-spec-issue-1072.md'],
  deepInterviewSpecPaths: ['.omx/specs/deep-interview-issue-1072.md'],
};

describe('assertRequiredRalphPrdJson', () => {
  it('throws when --prd mode starts without .omx/prd.json', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralph-prd-gate-'));
    try {
      assert.throws(
        () => assertRequiredRalphPrdJson(cwd, ['--prd', 'ship release checklist']),
        /Missing required PRD\.json at \.omx\/prd\.json/,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('still requires legacy .omx/prd.json even when canonical PRD markdown exists', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralph-prd-gate-'));
    try {
      await mkdir(join(cwd, '.omx', 'plans'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'plans', 'prd-existing.md'), '# Existing canonical PRD\n');

      assert.throws(
        () => assertRequiredRalphPrdJson(cwd, ['--prd', 'ship release checklist']),
        /Missing required PRD\.json at \.omx\/prd\.json/,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects completed stories without architect approval', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralph-prd-gate-'));
    try {
      await mkdir(join(cwd, '.omx'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'prd.json'), JSON.stringify({
        project: 'Issue 1555',
        userStories: [{
          id: 'US-001',
          title: 'Guard story completion',
          passes: true,
        }],
      }, null, 2));

      assert.throws(
        () => assertRequiredRalphPrdJson(cwd, ['--prd', 'ship release checklist']),
        /marked passed\/completed without architect approval/,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('allows completed stories with architect approval recorded', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralph-prd-gate-'));
    try {
      await mkdir(join(cwd, '.omx'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'prd.json'), JSON.stringify({
        project: 'Issue 1555',
        userStories: [{
          id: 'US-001',
          title: 'Guard story completion',
          status: 'completed',
          architect_review: { verdict: 'approve' },
        }],
      }, null, 2));

      assert.doesNotThrow(() => assertRequiredRalphPrdJson(cwd, ['--prd', 'ship release checklist']));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('allows --prd mode when .omx/prd.json exists', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralph-prd-gate-'));
    try {
      await mkdir(join(cwd, '.omx'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'prd.json'), JSON.stringify({
        project: 'Issue 1555',
        userStories: [],
      }, null, 2));

      assert.doesNotThrow(() => assertRequiredRalphPrdJson(cwd, ['--prd', 'ship release checklist']));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not gate non-prd Ralph runs', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralph-prd-gate-'));
    try {
      assert.doesNotThrow(() => assertRequiredRalphPrdJson(cwd, ['fix', 'the', 'bug']));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('ralph deslop launch wiring', () => {
  it('consumes --no-deslop so it is not forwarded to codex', () => {
    assert.deepEqual(filterRalphCodexArgs(['--no-deslop', '--model', 'gpt-5', 'fix', 'it']), ['--model', 'gpt-5', 'fix', 'it']);
  });

  it('documents changed-files-only deslop guidance by default', () => {
    const instructions = buildRalphAppendInstructions('fix issue 920', {
      changedFilesPath: '.omx/ralph/changed-files.txt',
      noDeslop: false,
      approvedHint: null,
    });
    assert.match(instructions, /ai-slop-cleaner/i);
    assert.match(instructions, /changed files only/i);
    assert.match(instructions, /\.omx\/ralph\/changed-files\.txt/);
    assert.match(instructions, /standard mode/i);
    assert.match(instructions, /rerun the current tests\/build\/lint verification/i);
  });

  it('documents the --no-deslop opt-out when enabled', () => {
    const instructions = buildRalphAppendInstructions('fix issue 920', {
      changedFilesPath: '.omx/ralph/changed-files.txt',
      noDeslop: true,
      approvedHint: null,
    });
    assert.match(instructions, /--no-deslop/);
    assert.match(instructions, /skip the mandatory ai-slop-cleaner final pass/i);
    assert.match(instructions, /latest successful pre-deslop verification evidence/i);
  });

  it('includes mission hardening review-loop context when provided', () => {
    const instructions = buildRalphAppendInstructions('run mission hardening', {
      changedFilesPath: '.omx/ralph/changed-files.txt',
      noDeslop: false,
      approvedHint: null,
      hardening: {
        gateMode: 'required',
        reviewEngine: 'codex-parallel-review',
        maxReviewFixCycles: 2,
        changedFilesPath: '.omx/ralph/changed-files.txt',
        reportPaths: ['review-cycle-1.json', 'final-review.json', 'gate-result.json'],
        requireDeslop: true,
      },
    });
    assert.match(instructions, /Mission hardening context/i);
    assert.match(instructions, /review engine: codex-parallel-review/i);
    assert.match(instructions, /max review\/fix cycles: 2/i);
    assert.match(instructions, /report artifacts: review-cycle-1\.json, final-review\.json, gate-result\.json/i);
    assert.match(instructions, /hardening coordinator/i);
  });

  it('disables --no-deslop when the mission hardening gate requires deslop', () => {
    const instructions = buildRalphAppendInstructions('run mission hardening', {
      changedFilesPath: '.omx/ralph/changed-files.txt',
      noDeslop: true,
      approvedHint: null,
      hardening: {
        gateMode: 'required',
        reviewEngine: 'codex-parallel-review',
        maxReviewFixCycles: 2,
        changedFilesPath: '.omx/ralph/changed-files.txt',
        reportPaths: ['gate-result.json'],
        requireDeslop: true,
      },
    });
    assert.match(instructions, /requires the deslop pass/i);
    assert.match(instructions, /ignore the opt-out/i);
    assert.match(instructions, /must rerun tests\/build\/lint after the mandatory hardening deslop pass/i);
  });



  it('includes approved plan and deep-interview handoff context when available', () => {
    const instructions = buildRalphAppendInstructions('Execute approved issue 1072 plan', {
      changedFilesPath: '.omx/ralph/changed-files.txt',
      noDeslop: false,
      approvedHint,
    });
    assert.match(instructions, /Approved planning handoff context/i);
    assert.match(instructions, /approved plan: \.omx\/plans\/prd-issue-1072\.md/i);
    assert.match(instructions, /test specs: \.omx\/plans\/test-spec-issue-1072\.md/i);
    assert.match(instructions, /deep-interview specs: \.omx\/specs\/deep-interview-issue-1072\.md/i);
    assert.match(instructions, /Carry forward the approved deep-interview requirements/i);
  });

  it('seeds the changed-files artifact with bounded-scope guidance', () => {
    const seed = buildRalphChangedFilesSeedContents();
    assert.match(seed, /mandatory final ai-slop-cleaner pass/i);
    assert.match(seed, /one repo-relative path per line/i);
    assert.match(seed, /strictly scoped/i);
  });

  it('wires mission hardening context into the real ralph launch appendix', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralph-hardening-launch-'));
    const previousCwd = process.cwd();
    const previousAppendix = process.env.OMX_RALPH_APPEND_INSTRUCTIONS_FILE;
    try {
      process.chdir(cwd);
      const missionRoot = join(cwd, '.omx', 'missions', 'demo');
      await mkdir(missionRoot, { recursive: true });
      await writeFile(
        join(missionRoot, 'mission.json'),
        `${JSON.stringify({
          schema_version: 1,
          mission_version: 3,
          mission_id: 'demo-20260418-hardening',
          slug: 'demo',
          repo_root: cwd,
          mission_root: missionRoot,
          target_fingerprint: 'repo:demo',
          status: 'running',
          lifecycle_state: 'executing',
          started_at: '2026-04-18T18:00:00.000Z',
          updated_at: '2026-04-18T18:00:00.000Z',
          current_iteration: 1,
          current_stage: 'hardening',
          active_lanes: [],
          closure_policy: {
            require_fresh_verifier: true,
            allowed_completion_confidence: ['high', 'medium'],
            require_safety_baseline: true,
            regression_outcome: 'iterate',
            ambiguous_outcome: 'iterate',
          },
          plateau_policy: {
            max_unchanged_iterations: 2,
            require_strategy_change_before_plateau: true,
            oscillation_window: 2,
            max_ambiguous_iterations: 2,
          },
          latest_verdict: 'AMBIGUOUS',
          latest_summary_path: null,
          latest_lane_provenance: [],
          unchanged_iterations: 0,
          ambiguous_iterations: 0,
          oscillation_count: 0,
          last_residual_fingerprint: null,
          last_strategy_key: null,
          final_reason: null,
          active_candidate_id: 'candidate-001',
          selected_candidate_id: 'candidate-001',
          candidate_ids: ['candidate-001'],
          assurance_contract_id: null,
          proof_program_id: null,
          checker_lock_id: null,
          environment_contract_id: null,
          policy_profile: {
            risk_class: 'security-sensitive',
            assurance_profile: 'max-quality',
            autonomy_profile: 'semi-auto',
          },
          verification_state: {
            status: 'pending',
            blocking_obligation_ids: [],
            satisfied_obligation_ids: [],
            contradicted_obligation_ids: [],
            stale_obligation_ids: [],
            adjudication_state: 'pending',
            last_verified_at: null,
          },
          promotion_state: {
            status: 'blocked',
            blocking_reasons: [],
            last_decision_at: null,
            decision_ref: null,
          },
          plateau_strategy_state: {
            strategy_key: null,
            mutation_attempts: 0,
            candidate_expansions: 0,
            exhausted: false,
          },
          kernel_blockers: [],
          latest_authoritative_iteration_ref: null,
          latest_authoritative_adjudication_ref: null,
        }, null, 2)}\n`,
      );
      await writeFile(
        join(missionRoot, 'execution-plan.json'),
        `${JSON.stringify({
          schema_version: 1,
          generated_at: '2026-04-18T18:00:00.000Z',
          plan_id: 'plan:demo',
          plan_revision: 1,
          previous_plan_id: null,
          strategy_key: 'strategy:demo',
          planning_mode: 'direct',
          handoff_surface: 'plan',
          status: 'approved',
          blocking_reason: null,
          approval_basis: 'test',
          approved_at: '2026-04-18T18:00:00.000Z',
          summary: 'demo',
          execution_order: [],
          lane_expectations: [],
          verification_checkpoints: [],
          strategy_change_triggers: [],
          hardening_gate: {
            mode: 'required',
            review_engine: 'codex-parallel-review',
            fallback_review_engines: [],
            max_review_fix_cycles: 2,
            deslop_policy: 'changed-files-final-pass',
            final_sanity_review: 'required',
          },
          optional_hardening_rules: [],
        }, null, 2)}\n`,
      );

      const launches: string[][] = [];
      await ralphCommand(['--no-deslop', 'run', 'mission', 'hardening'], {
        async launchWithHud(args) {
          launches.push(args);
          const appendixPath = process.env.OMX_RALPH_APPEND_INSTRUCTIONS_FILE;
          assert.ok(typeof appendixPath === 'string');
          const appendix = await readFile(appendixPath!, 'utf-8');
          assert.match(appendix, /Mission hardening context:/);
          assert.match(appendix, /hardening gate mode: required/i);
          assert.match(appendix, /review engine: codex-parallel-review/i);
          assert.match(appendix, /ignore the opt-out and run the mandatory changed-files ai-slop-cleaner pass/i);
          assert.match(appendix, /report artifacts: .*hardening\/gate-result\.json/i);
        },
      });
      assert.deepEqual(launches, [['run', 'mission', 'hardening']]);
    } finally {
      process.chdir(previousCwd);
      if (typeof previousAppendix === 'string') process.env.OMX_RALPH_APPEND_INSTRUCTIONS_FILE = previousAppendix;
      else delete process.env.OMX_RALPH_APPEND_INSTRUCTIONS_FILE;
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
