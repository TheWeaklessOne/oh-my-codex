import { join } from 'node:path';
import type { MissionLaneSummaryInput, MissionLaneType } from './contracts.js';
import {
  cancelMission,
  commitIteration,
  createMission,
  loadMission,
  recordLaneSummary,
  startIteration,
  type CommitIterationResult,
  type MissionCreateOptions,
  type MissionIterationHandle,
  type MissionRecordLaneResult,
  type MissionSafetyBaseline,
  type MissionState,
} from './kernel.js';

export interface MissionLaneRuntimePlan {
  laneType: MissionLaneType;
  runnerType: 'team' | 'ralph' | 'direct';
  freshSession: boolean;
  readOnly: boolean;
  laneDir: string;
  summaryPath: string;
  rationale: string;
}

export interface PreparedMissionRuntime {
  mission: MissionState;
  iteration: MissionIterationHandle;
  missionRoot: string;
  missionFile: string;
  latestFile: string;
  deltaFile: string;
  lanePlans: Record<MissionLaneType, MissionLaneRuntimePlan>;
}

export interface PrepareMissionRuntimeOptions extends MissionCreateOptions {
  strategyKey?: string | null;
}

const MISSION_LANE_ROUTING: Record<
  MissionLaneType,
  Pick<MissionLaneRuntimePlan, 'runnerType' | 'freshSession' | 'readOnly' | 'rationale'>
> = {
  audit: {
    runnerType: 'direct',
    freshSession: true,
    readOnly: true,
    rationale: 'Audit must run in a fresh read-only lane before remediation begins.',
  },
  remediation: {
    runnerType: 'direct',
    freshSession: false,
    readOnly: false,
    rationale: 'Remediation shaping stays direct and bounded unless later escalation needs coordinated execution.',
  },
  execution: {
    runnerType: 'team',
    freshSession: true,
    readOnly: false,
    rationale: 'Execution defaults to team as the coordinated executor.',
  },
  hardening: {
    runnerType: 'ralph',
    freshSession: true,
    readOnly: false,
    rationale: 'Hardening uses a bounded Ralph follow-up only when a narrow stubborn slice remains.',
  },
  re_audit: {
    runnerType: 'direct',
    freshSession: true,
    readOnly: true,
    rationale: 'Re-audit must run in a fresh read-only lane instead of reusing execution context.',
  },
};

function missionFile(missionRoot: string): string {
  return join(missionRoot, 'mission.json');
}

function latestFile(missionRoot: string): string {
  return join(missionRoot, 'latest.json');
}

function deltaFile(iterationDir: string): string {
  return join(iterationDir, 'delta.json');
}

function laneSummaryPath(laneDir: string): string {
  return join(laneDir, 'summary.json');
}

async function ensureMissionState(options: MissionCreateOptions): Promise<MissionState> {
  try {
    return await loadMission(options.repoRoot, options.slug);
  } catch {
    return createMission(options);
  }
}

function buildLanePlans(iteration: MissionIterationHandle): Record<MissionLaneType, MissionLaneRuntimePlan> {
  return {
    audit: {
      laneType: 'audit',
      laneDir: iteration.laneDirs.audit,
      summaryPath: laneSummaryPath(iteration.laneDirs.audit),
      ...MISSION_LANE_ROUTING.audit,
    },
    remediation: {
      laneType: 'remediation',
      laneDir: iteration.laneDirs.remediation,
      summaryPath: laneSummaryPath(iteration.laneDirs.remediation),
      ...MISSION_LANE_ROUTING.remediation,
    },
    execution: {
      laneType: 'execution',
      laneDir: iteration.laneDirs.execution,
      summaryPath: laneSummaryPath(iteration.laneDirs.execution),
      ...MISSION_LANE_ROUTING.execution,
    },
    hardening: {
      laneType: 'hardening',
      laneDir: iteration.laneDirs.hardening,
      summaryPath: laneSummaryPath(iteration.laneDirs.hardening),
      ...MISSION_LANE_ROUTING.hardening,
    },
    re_audit: {
      laneType: 're_audit',
      laneDir: iteration.laneDirs.re_audit,
      summaryPath: laneSummaryPath(iteration.laneDirs.re_audit),
      ...MISSION_LANE_ROUTING.re_audit,
    },
  };
}

export async function prepareMissionRuntime(options: PrepareMissionRuntimeOptions): Promise<PreparedMissionRuntime> {
  await ensureMissionState(options);
  const iteration = await startIteration(options.repoRoot, options.slug, options.strategyKey ?? null);
  const currentMission = await loadMission(options.repoRoot, options.slug);
  return {
    mission: currentMission,
    iteration,
    missionRoot: currentMission.mission_root,
    missionFile: missionFile(currentMission.mission_root),
    latestFile: latestFile(currentMission.mission_root),
    deltaFile: deltaFile(iteration.iterationDir),
    lanePlans: buildLanePlans(iteration),
  };
}

export async function recordMissionRuntimeLaneSummary(
  repoRoot: string,
  slug: string,
  laneType: MissionLaneType,
  summaryInput: MissionLaneSummaryInput,
  iteration?: number,
): Promise<MissionRecordLaneResult> {
  const mission = await loadMission(repoRoot, slug);
  return recordLaneSummary(repoRoot, slug, iteration ?? mission.current_iteration, laneType, summaryInput);
}

export async function commitMissionRuntimeIteration(
  repoRoot: string,
  slug: string,
  safetyBaseline: MissionSafetyBaseline,
  strategyChanged = false,
  iteration?: number,
): Promise<CommitIterationResult> {
  const mission = await loadMission(repoRoot, slug);
  return commitIteration(repoRoot, slug, iteration ?? mission.current_iteration, safetyBaseline, strategyChanged);
}

export async function cancelMissionRuntime(
  repoRoot: string,
  slug: string,
  reason?: string,
): Promise<MissionState> {
  return cancelMission(repoRoot, slug, reason);
}
