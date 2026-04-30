/**
 * Ralph bounded follow-up and strict Autopilot stage adapter for the pipeline orchestrator.
 *
 * Wraps the Ralph persistence loop into a PipelineStage for either the
 * strict Autopilot execution/verification phase or a bounded legacy follow-up
 * after coordinated team execution.
 */

import type { PipelineStage, StageContext, StageResult } from '../types.js';
import {
  buildFollowupStaffingPlan,
  resolveAvailableAgentTypes,
} from '../../team/followup-planner.js';

export interface RalphVerifyStageOptions {
  /** Stage name. Strict Autopilot uses 'ralph'; legacy pipeline adapters use 'ralph-verify'. */
  stageName?: string;

  /**
   * Ordered artifact keys used as Ralph execution input.
   * Legacy ralph-verify keeps reading prior ralph/team-exec output; strict Autopilot
   * Ralph reads ralplan first so implementation starts from approved planning.
   */
  executionArtifactKeys?: readonly string[];

  /**
   * Maximum number of ralph verification iterations.
   * Defaults to 10.
   */
  maxIterations?: number;

  /**
   * Optional override for determining whether the bounded Ralph follow-up
   * should run.
   */
  shouldRun?: (ctx: StageContext) => boolean;
}

function shouldRunRalphFollowup(
  ctx: StageContext,
  options: RalphVerifyStageOptions,
): boolean {
  if (options.shouldRun) return options.shouldRun(ctx);
  const teamArtifacts = ctx.artifacts['team-exec'] as Record<string, unknown> | undefined;
  return teamArtifacts?.residual_followup_required === true;
}

/**
 * Create a ralph-verify pipeline stage.
 *
 * This stage wraps the Ralph persistence loop as a bounded fallback for
 * legacy/coordinated team pipelines. Strict Autopilot uses `createRalphStage()`
 * for the primary implementation/verification phase before code-review.
 *
 * The iteration count is configurable, addressing issue #396 requirement
 * for configurable ralph iteration count.
 */
export function createRalphVerifyStage(options: RalphVerifyStageOptions = {}): PipelineStage {
  const maxIterations = options.maxIterations ?? 10;
  const stageName = options.stageName ?? 'ralph-verify';
  const useFollowupGate = stageName === 'ralph-verify' || typeof options.shouldRun === 'function';

  const stage: PipelineStage = {
    name: stageName,

    async run(ctx: StageContext): Promise<StageResult> {
      const startTime = Date.now();

      try {
        if (useFollowupGate && !shouldRunRalphFollowup(ctx, options)) {
          return {
            status: 'skipped',
            artifacts: {
              stage: stageName,
              reason: 'no residual follow-up requested after team execution',
            },
            duration_ms: Date.now() - startTime,
          };
        }

        // Extract execution context from previous stage.
        const executionArtifactKeys = options.executionArtifactKeys ?? ['ralph', 'team-exec'];
        const executionArtifacts = pickFirstArtifact(ctx.artifacts, executionArtifactKeys);
        const availableAgentTypes = await resolveAvailableAgentTypes(ctx.cwd);
        const staffingPlan = buildFollowupStaffingPlan('ralph', ctx.task, availableAgentTypes, {
          workerCount: Math.min(maxIterations, 3),
        });

        // Build bounded Ralph follow-up descriptor
        const verifyDescriptor: RalphVerifyDescriptor = {
          task: ctx.task,
          maxIterations,
          cwd: ctx.cwd,
          sessionId: ctx.sessionId,
          availableAgentTypes,
          staffingPlan,
          executionArtifacts: executionArtifacts ?? {},
        };

        return {
          status: 'completed',
          artifacts: {
            verifyDescriptor,
            maxIterations,
            availableAgentTypes,
            staffingPlan,
            stage: stageName,
            instruction: buildRalphInstruction(verifyDescriptor),
          },
          duration_ms: Date.now() - startTime,
        };
      } catch (err) {
        return {
          status: 'failed',
          artifacts: {},
          duration_ms: Date.now() - startTime,
          error: `Ralph verification stage failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };

  if (useFollowupGate) {
    stage.canSkip = (ctx) => !shouldRunRalphFollowup(ctx, options);
  }

  return stage;
}

// ---------------------------------------------------------------------------
// Ralph verification descriptor
// ---------------------------------------------------------------------------

/**
 * Descriptor for a ralph verification run, consumed by the ralph runtime.
 */
export interface RalphVerifyDescriptor {
  task: string;
  maxIterations: number;
  cwd: string;
  sessionId?: string;
  availableAgentTypes: string[];
  staffingPlan: ReturnType<typeof buildFollowupStaffingPlan>;
  executionArtifacts: Record<string, unknown>;
}

/**
 * Build the ralph CLI instruction from a descriptor.
 */
export function buildRalphInstruction(descriptor: RalphVerifyDescriptor): string {
  return `${descriptor.staffingPlan.launchHints.shellCommand} # policy=${descriptor.staffingPlan.constraints.policy} # hardening=${descriptor.staffingPlan.constraints.hardening} # max_iterations=${descriptor.maxIterations} # staffing=${descriptor.staffingPlan.staffingSummary} # verify=${descriptor.staffingPlan.verificationPlan.summary}`;
}

function pickFirstArtifact(
  artifacts: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  for (const key of keys) {
    const artifact = artifacts[key];
    if (artifact && typeof artifact === 'object') {
      return artifact as Record<string, unknown>;
    }
  }
  return undefined;
}

/** Create the strict Autopilot Ralph phase adapter. */
export function createRalphStage(options: RalphVerifyStageOptions = {}): PipelineStage {
  return createRalphVerifyStage({
    ...options,
    stageName: 'ralph',
    executionArtifactKeys: options.executionArtifactKeys ?? ['ralplan', 'team-exec'],
  });
}
