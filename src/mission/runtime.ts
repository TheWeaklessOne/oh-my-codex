import { join } from 'node:path';
import {
  MISSION_LANE_POLICIES,
  MISSION_LANE_TYPES,
  type MissionLaneSummaryInput,
  type MissionLaneType,
} from './contracts.js';
import {
  missionLaneBriefingPath,
  prepareMissionOrchestrationArtifacts,
  syncMissionCloseout,
  writeMissionLaneBriefings,
  type MissionOrchestrationArtifactPaths,
  type MissionOrchestrationArtifacts,
  type MissionPlanningMode,
  type MissionRequirementSourceInput,
} from './orchestration.js';
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
  briefingPath: string;
  missionBriefPath: string;
  acceptanceContractPath: string;
  executionPlanPath: string;
  rationale: string;
}

export interface PreparedMissionRuntime {
  mission: MissionState;
  iteration: MissionIterationHandle | null;
  missionRoot: string;
  missionFile: string;
  latestFile: string;
  deltaFile: string | null;
  lanePlans: Partial<Record<MissionLaneType, MissionLaneRuntimePlan>>;
  artifacts: MissionOrchestrationArtifacts;
  artifactPaths: MissionOrchestrationArtifactPaths;
  planning: {
    mode: MissionPlanningMode;
    handoffSurface: 'plan' | 'ralplan' | 'deep-interview';
    status: 'approved' | 'blocked';
    blockingReason: string | null;
    strategyKey: string;
  };
}

export interface PrepareMissionRuntimeOptions extends MissionCreateOptions {
  strategyKey?: string | null;
  task?: string;
  desiredOutcome?: string;
  requirementSources?: MissionRequirementSourceInput[];
  constraints?: string[];
  unknowns?: string[];
  assumptions?: string[];
  nonGoals?: string[];
  projectTouchpoints?: string[];
  repoContext?: Record<string, string>;
  ambiguity?: 'low' | 'medium' | 'high';
  acceptanceCriteria?: string[];
  invariants?: string[];
  requiredTestEvidence?: string[];
  requiredOperationalEvidence?: string[];
  residualClassificationRules?: string[];
  verifierGuidance?: string[];
  planningMode?: MissionPlanningMode;
  highRisk?: boolean;
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

function buildLanePlans(
  iteration: MissionIterationHandle,
  artifactPaths: MissionOrchestrationArtifactPaths,
): Record<MissionLaneType, MissionLaneRuntimePlan> {
  return Object.fromEntries(
    MISSION_LANE_TYPES.map((laneType) => [
      laneType,
      {
        laneType,
        laneDir: iteration.laneDirs[laneType],
        summaryPath: laneSummaryPath(iteration.laneDirs[laneType]),
        briefingPath: missionLaneBriefingPath(iteration.laneDirs[laneType]),
        missionBriefPath: artifactPaths.missionBriefPath,
        acceptanceContractPath: artifactPaths.acceptanceContractPath,
        executionPlanPath: artifactPaths.executionPlanPath,
        ...MISSION_LANE_POLICIES[laneType],
      },
    ]),
  ) as Record<MissionLaneType, MissionLaneRuntimePlan>;
}

export async function prepareMissionRuntime(options: PrepareMissionRuntimeOptions): Promise<PreparedMissionRuntime> {
  await ensureMissionState(options);
  const currentMission = await loadMission(options.repoRoot, options.slug);
  const { artifacts, paths } = await prepareMissionOrchestrationArtifacts(currentMission, options);
  if (artifacts.executionPlan.status !== 'approved') {
    return {
      mission: currentMission,
      iteration: null,
      missionRoot: currentMission.mission_root,
      missionFile: missionFile(currentMission.mission_root),
      latestFile: latestFile(currentMission.mission_root),
      deltaFile: null,
      lanePlans: {},
      artifacts,
      artifactPaths: paths,
      planning: {
        mode: artifacts.executionPlan.planning_mode,
        handoffSurface: artifacts.executionPlan.handoff_surface,
        status: artifacts.executionPlan.status,
        blockingReason: artifacts.executionPlan.blocking_reason,
        strategyKey: artifacts.executionPlan.strategy_key,
      },
    };
  }
  const iteration = await startIteration(
    options.repoRoot,
    options.slug,
    options.strategyKey ?? artifacts.executionPlan.strategy_key,
  );
  const nextMission = await loadMission(options.repoRoot, options.slug);
  const lanePlans = buildLanePlans(iteration, paths);
  await writeMissionLaneBriefings(iteration.laneDirs, artifacts, paths);
  return {
    mission: nextMission,
    iteration,
    missionRoot: nextMission.mission_root,
    missionFile: missionFile(nextMission.mission_root),
    latestFile: latestFile(nextMission.mission_root),
    deltaFile: deltaFile(iteration.iterationDir),
    lanePlans,
    artifacts,
    artifactPaths: paths,
    planning: {
      mode: artifacts.executionPlan.planning_mode,
      handoffSurface: artifacts.executionPlan.handoff_surface,
      status: artifacts.executionPlan.status,
      blockingReason: artifacts.executionPlan.blocking_reason,
      strategyKey: artifacts.executionPlan.strategy_key,
    },
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
  const result = await recordLaneSummary(repoRoot, slug, iteration ?? mission.current_iteration, laneType, summaryInput);
  const nextMission = await loadMission(repoRoot, slug);
  await syncMissionCloseout(nextMission);
  return result;
}

export async function commitMissionRuntimeIteration(
  repoRoot: string,
  slug: string,
  safetyBaseline: MissionSafetyBaseline,
  strategyChanged = false,
  iteration?: number,
): Promise<CommitIterationResult> {
  const mission = await loadMission(repoRoot, slug);
  const result = await commitIteration(repoRoot, slug, iteration ?? mission.current_iteration, safetyBaseline, strategyChanged);
  await syncMissionCloseout(result.mission);
  return result;
}

export async function cancelMissionRuntime(
  repoRoot: string,
  slug: string,
  reason?: string,
): Promise<MissionState> {
  const mission = await cancelMission(repoRoot, slug, reason);
  await syncMissionCloseout(mission);
  return mission;
}
