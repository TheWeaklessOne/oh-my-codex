/**
 * Team execution stage adapter for pipeline orchestrator.
 *
 * Wraps the existing team mode (tmux-based Codex CLI workers) into a
 * PipelineStage. The execution backend is always teams — this is the
 * canonical OMX execution surface.
 */

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, normalize, relative, resolve } from 'node:path';
import type { PipelineStage, StageContext, StageResult } from '../types.js';
import {
  buildFollowupStaffingPlan,
  resolveAvailableAgentTypes,
} from '../../team/followup-planner.js';
import { readLatestPlanningArtifacts, readPlanningArtifacts, type PlanningArtifacts } from '../../planning/artifacts.js';
import { sameFilePath } from '../../utils/paths.js';

export interface TeamExecStageOptions {
  /** Number of Codex CLI workers to launch. Defaults to 2. */
  workerCount?: number;

  /** Agent type/role for workers. Defaults to 'executor'. */
  agentType?: string;

  /** Whether to use git worktrees for worker isolation. */
  useWorktrees?: boolean;

  /** Additional environment variables for worker launch. */
  extraEnv?: Record<string, string>;
}

const APPROVED_TEAM_LAUNCH_PATTERN = /(?<command>(?:omx\s+team|\$team)\s+(?<ralph>ralph\s+)?(?<count>\d+)(?::(?<role>[a-z][a-z0-9-]*))?\s+(?<task>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'))/gi;

function decodeQuotedValue(raw: string): string | null {
  const normalized = raw.trim();
  if (!normalized) return null;

  try {
    return JSON.parse(normalized) as string;
  } catch {
    if (normalized.startsWith('"') && normalized.endsWith('"')) {
      return normalized.slice(1, -1);
    }
    if (normalized.startsWith("'") && normalized.endsWith("'")) {
      return normalized.slice(1, -1).replace(/\\'/g, "'");
    }
    return null;
  }
}

function resolveRequestedTask(ctx: StageContext, ralplanArtifacts?: Record<string, unknown>): string {
  const ralplanTask = typeof ralplanArtifacts?.task === 'string' ? ralplanArtifacts.task.trim() : '';
  return ralplanTask || ctx.task;
}

function normalizePlanningRelativePath(rawPath: string): string {
  const trimmed = rawPath.trim().replace(/^`|`$/g, '').replace(/\\/g, '/');
  const withoutDotPrefix = trimmed.startsWith('./') ? trimmed.slice(2) : trimmed;
  return normalize(withoutDotPrefix).replace(/\\/g, '/');
}

function resolvePlanningPrdPath(
  artifacts: PlanningArtifacts,
  cwd: string,
  rawPath: string,
): { matchedPath: string | null; fallbackPath: string } {
  const normalizedRawPath = rawPath.trim();
  if (isAbsolute(normalizedRawPath)) {
    const resolvedPath = resolve(normalizedRawPath);
    const matchedPath = artifacts.prdPaths.find((candidatePath) => sameFilePath(candidatePath, resolvedPath)) ?? null;
    return { matchedPath, fallbackPath: resolvedPath };
  }

  const repoRoot = dirname(dirname(artifacts.plansDir));
  const normalizedPath = normalizePlanningRelativePath(normalizedRawPath);
  const matchedPath = artifacts.prdPaths.find((candidatePath) => {
    const artifactPath = normalizePlanningRelativePath(candidatePath);
    const repoRelativePath = normalizePlanningRelativePath(relative(repoRoot, candidatePath));
    const plansRelativePath = normalizePlanningRelativePath(relative(artifacts.plansDir, candidatePath));
    return normalizedPath === artifactPath
      || normalizedPath === repoRelativePath
      || normalizedPath === plansRelativePath;
  }) ?? null;
  return {
    matchedPath,
    fallbackPath: resolve(cwd, normalizedPath),
  };
}

function resolveApprovedTeamPlanPath(cwd: string, latestPlanPath: string): string {
  const artifacts = readPlanningArtifacts(cwd);
  const resolvedLatestPlanPath = resolvePlanningPrdPath(artifacts, cwd, latestPlanPath);
  const selection = readLatestPlanningArtifacts(cwd);
  const selectedPrdPath = selection.prdPath
    ? resolvePlanningPrdPath(artifacts, cwd, selection.prdPath).matchedPath
    : null;

  if (!selectedPrdPath || selection.testSpecPaths.length === 0 || !resolvedLatestPlanPath.matchedPath) {
    throw new Error(`team_exec_approved_handoff_missing:${resolvedLatestPlanPath.fallbackPath}`);
  }
  if (selectedPrdPath !== resolvedLatestPlanPath.matchedPath) {
    throw new Error(`team_exec_approved_handoff_stale:${resolvedLatestPlanPath.matchedPath}:${selectedPrdPath}`);
  }

  return selectedPrdPath;
}

function resolveApprovedTeamTaskFromPlanPath(cwd: string, latestPlanPath: string): string {
  const approvedPlanPath = resolveApprovedTeamPlanPath(cwd, latestPlanPath);
  let content = '';
  try {
    content = readFileSync(approvedPlanPath, 'utf-8');
  } catch {
    throw new Error(`team_exec_approved_handoff_missing:${approvedPlanPath}`);
  }

  const matches = [...content.matchAll(APPROVED_TEAM_LAUNCH_PATTERN)];
  if (matches.length === 0) {
    throw new Error(`team_exec_approved_handoff_missing:${approvedPlanPath}`);
  }
  if (matches.length > 1) {
    throw new Error(`team_exec_approved_handoff_ambiguous:${approvedPlanPath}`);
  }

  const task = matches[0]?.groups?.task ? decodeQuotedValue(matches[0].groups.task) : null;
  if (!task) {
    throw new Error(`team_exec_approved_handoff_missing:${approvedPlanPath}`);
  }
  return task;
}

function resolveTeamExecTask(ctx: StageContext, ralplanArtifacts?: Record<string, unknown>): string {
  const requestedTask = resolveRequestedTask(ctx, ralplanArtifacts);
  const latestPlanPath = typeof ralplanArtifacts?.latestPlanPath === 'string'
    ? ralplanArtifacts.latestPlanPath.trim()
    : '';
  if (!latestPlanPath) {
    return requestedTask;
  }
  return resolveApprovedTeamTaskFromPlanPath(ctx.cwd, latestPlanPath);
}

/**
 * Create a team-exec pipeline stage.
 *
 * This stage delegates to the existing `omx team` infrastructure, which
 * starts real Codex CLI workers in tmux panes. When RALPLAN names a
 * concrete approved PRD handoff, team-exec reuses that exact task text;
 * otherwise it stays on the generic request-task path.
 */
export function createTeamExecStage(options: TeamExecStageOptions = {}): PipelineStage {
  const workerCount = options.workerCount ?? 2;
  const agentType = options.agentType ?? 'executor';

  return {
    name: 'team-exec',

    async run(ctx: StageContext): Promise<StageResult> {
      const startTime = Date.now();

      try {
        const ralplanArtifacts = typeof ctx.artifacts['ralplan'] === 'object' && ctx.artifacts['ralplan'] !== null
          ? ctx.artifacts['ralplan'] as Record<string, unknown>
          : undefined;
        const task = resolveTeamExecTask(ctx, ralplanArtifacts);
        const availableAgentTypes = await resolveAvailableAgentTypes(ctx.cwd);
        const staffingPlan = buildFollowupStaffingPlan('team', task, availableAgentTypes, {
          workerCount,
          fallbackRole: agentType,
        });

        // Build team execution descriptor
        const teamDescriptor: TeamExecDescriptor = {
          task,
          workerCount,
          agentType,
          availableAgentTypes,
          staffingPlan,
          useWorktrees: options.useWorktrees ?? false,
          cwd: ctx.cwd,
          extraEnv: options.extraEnv,
        };

        return {
          status: 'completed',
          artifacts: {
            teamDescriptor,
            workerCount,
            agentType,
            availableAgentTypes,
            staffingPlan,
            stage: 'team-exec',
            instruction: buildTeamInstruction(teamDescriptor),
          },
          duration_ms: Date.now() - startTime,
        };
      } catch (err) {
        return {
          status: 'failed',
          artifacts: {},
          duration_ms: Date.now() - startTime,
          error: `Team execution stage failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Team execution descriptor
// ---------------------------------------------------------------------------

/**
 * Descriptor for a team execution run, consumed by the team runtime.
 */
export interface TeamExecDescriptor {
  task: string;
  workerCount: number;
  agentType: string;
  availableAgentTypes: string[];
  staffingPlan: ReturnType<typeof buildFollowupStaffingPlan>;
  useWorktrees: boolean;
  cwd: string;
  extraEnv?: Record<string, string>;
}

/**
 * Build the `omx team` CLI instruction from a descriptor.
 */
export function buildTeamInstruction(descriptor: TeamExecDescriptor): string {
  const launchCommand = `omx team ${descriptor.workerCount}:${descriptor.agentType} ${JSON.stringify(descriptor.task)}`;
  return `${launchCommand} # staffing=${descriptor.staffingPlan.staffingSummary} # verify=${descriptor.staffingPlan.verificationPlan.summary}`;
}
