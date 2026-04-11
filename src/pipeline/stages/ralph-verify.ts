/**
 * Ralph bounded follow-up stage adapter for pipeline orchestrator.
 *
 * Wraps the Ralph persistence loop into a PipelineStage only for
 * narrow stubborn follow-up slices after the main execution path.
 * Uses configurable iteration count.
 */

import type { PipelineStage, StageContext, StageResult } from '../types.js';
import {
  buildFollowupStaffingPlan,
  resolveAvailableAgentTypes,
} from '../../team/followup-planner.js';

export interface RalphVerifyStageOptions {
  /**
   * Maximum number of ralph verification iterations.
   * Defaults to 10.
   */
  maxIterations?: number;
}

/**
 * Create a ralph-verify pipeline stage.
 *
 * This stage wraps the Ralph persistence loop only as a bounded fallback
 * after the coordinated execution path. It takes the execution results
 * from team-exec and emits a constrained follow-up descriptor instead of
 * treating Ralph as the primary execution owner.
 *
 * The iteration count is configurable, addressing issue #396 requirement
 * for configurable ralph iteration count.
 */
export function createRalphVerifyStage(options: RalphVerifyStageOptions = {}): PipelineStage {
  const maxIterations = options.maxIterations ?? 10;

  return {
    name: 'ralph-verify',

    async run(ctx: StageContext): Promise<StageResult> {
      const startTime = Date.now();

      try {
        // Extract execution context from previous stage
        const teamArtifacts = ctx.artifacts['team-exec'] as Record<string, unknown> | undefined;
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
          executionArtifacts: teamArtifacts ?? {},
        };

        return {
          status: 'completed',
          artifacts: {
            verifyDescriptor,
            maxIterations,
            availableAgentTypes,
            staffingPlan,
            stage: 'ralph-verify',
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
