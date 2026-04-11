import { join } from 'node:path';
import {
  MISSION_LANE_POLICIES,
  MISSION_LANE_TYPES,
  type MissionLaneSummaryInput,
  type MissionLaneType,
} from './contracts.js';
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
  return Object.fromEntries(
    MISSION_LANE_TYPES.map((laneType) => [
      laneType,
      {
        laneType,
        laneDir: iteration.laneDirs[laneType],
        summaryPath: laneSummaryPath(iteration.laneDirs[laneType]),
        ...MISSION_LANE_POLICIES[laneType],
      },
    ]),
  ) as Record<MissionLaneType, MissionLaneRuntimePlan>;
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
