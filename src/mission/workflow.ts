import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MissionLaneType } from './contracts.js';
import type { MissionState } from './kernel.js';
import type {
  MissionOrchestrationArtifacts,
  MissionOrchestrationArtifactPaths,
  MissionPlanningMode,
} from './orchestration.js';
import { writeAtomic } from '../team/state/io.js';

export const MISSION_WORKFLOW_STAGES = [
  'intake',
  'source-grounding',
  'contract-build',
  'planning',
  'audit',
  'execution-loop',
  'closeout',
] as const;
export type MissionWorkflowStage = (typeof MISSION_WORKFLOW_STAGES)[number];

export interface MissionWorkflowStageRecord {
  stage: MissionWorkflowStage;
  entered_at: string;
  detail: string;
  iteration: number | null;
  lane_type: MissionLaneType | null;
}

export interface MissionStrategyHistoryRecord {
  strategy_key: string;
  plan_id: string;
  plan_revision: number;
  recorded_at: string;
  reason: string;
  iteration: number | null;
}

export interface MissionWorkflowState {
  schema_version: 1;
  mission_id: string;
  slug: string;
  mission_root: string;
  updated_at: string;
  current_stage: MissionWorkflowStage;
  blocked_reason: string | null;
  current_iteration: number | null;
  current_lane: MissionLaneType | null;
  brief_id: string;
  contract_id: string;
  contract_revision: number;
  plan_id: string;
  plan_revision: number;
  planning_mode: MissionPlanningMode;
  handoff_surface: 'plan' | 'ralplan' | 'deep-interview';
  strategy_key: string;
  closeout_status: MissionState['status'] | null;
  closeout_path: string | null;
  artifact_refs: {
    source_pack: string;
    mission_brief: string;
    acceptance_contract: string;
    execution_plan: string;
    closeout: string | null;
  };
  stage_history: MissionWorkflowStageRecord[];
  strategy_history: MissionStrategyHistoryRecord[];
}

export interface SyncMissionWorkflowOptions {
  mission: MissionState;
  artifacts: MissionOrchestrationArtifacts;
  artifactPaths: MissionOrchestrationArtifactPaths;
  stage: MissionWorkflowStage;
  detail: string;
  iteration?: number | null;
  laneType?: MissionLaneType | null;
  blockedReason?: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function missionWorkflowPath(missionRoot: string): string {
  return join(missionRoot, 'workflow.json');
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf-8')) as T;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function loadMissionWorkflow(missionRoot: string): Promise<MissionWorkflowState | null> {
  const filePath = missionWorkflowPath(missionRoot);
  if (!existsSync(filePath)) return null;
  return readJson<MissionWorkflowState>(filePath);
}

function upsertStageHistory(
  history: MissionWorkflowStageRecord[],
  stage: MissionWorkflowStage,
  detail: string,
  iteration: number | null,
  laneType: MissionLaneType | null,
): MissionWorkflowStageRecord[] {
  const last = history.at(-1);
  if (
    last
    && last.stage === stage
    && last.detail === detail
    && last.iteration === iteration
    && last.lane_type === laneType
  ) {
    return history;
  }
  return [
    ...history,
    {
      stage,
      entered_at: nowIso(),
      detail,
      iteration,
      lane_type: laneType,
    },
  ];
}

function nextStrategyHistory(
  previous: MissionWorkflowState | null,
  artifacts: MissionOrchestrationArtifacts,
  iteration: number | null,
): MissionStrategyHistoryRecord[] {
  const history = previous?.strategy_history ?? [];
  const last = history.at(-1);
  if (
    last
    && last.strategy_key === artifacts.executionPlan.strategy_key
    && last.plan_revision === artifacts.executionPlan.plan_revision
  ) {
    return history;
  }
  return [
    ...history,
    {
      strategy_key: artifacts.executionPlan.strategy_key,
      plan_id: artifacts.executionPlan.plan_id,
      plan_revision: artifacts.executionPlan.plan_revision,
      recorded_at: nowIso(),
      reason: artifacts.executionPlan.previous_plan_id
        ? 'execution plan updated'
        : 'initial execution plan approved',
      iteration,
    },
  ];
}

export async function syncMissionWorkflow(options: SyncMissionWorkflowOptions): Promise<MissionWorkflowState> {
  const previous = await loadMissionWorkflow(options.mission.mission_root);
  const stageHistory = upsertStageHistory(
    previous?.stage_history ?? [],
    options.stage,
    options.detail,
    options.iteration ?? null,
    options.laneType ?? null,
  );
  const workflow: MissionWorkflowState = {
    schema_version: 1,
    mission_id: options.mission.mission_id,
    slug: options.mission.slug,
    mission_root: options.mission.mission_root,
    updated_at: nowIso(),
    current_stage: options.stage,
    blocked_reason: options.blockedReason ?? null,
    current_iteration: options.iteration ?? previous?.current_iteration ?? null,
    current_lane: options.laneType ?? null,
    brief_id: options.artifacts.brief.brief_id,
    contract_id: options.artifacts.acceptanceContract.contract_id,
    contract_revision: options.artifacts.acceptanceContract.contract_revision,
    plan_id: options.artifacts.executionPlan.plan_id,
    plan_revision: options.artifacts.executionPlan.plan_revision,
    planning_mode: options.artifacts.executionPlan.planning_mode,
    handoff_surface: options.artifacts.executionPlan.handoff_surface,
    strategy_key: options.artifacts.executionPlan.strategy_key,
    closeout_status: options.stage === 'closeout' ? options.mission.status : previous?.closeout_status ?? null,
    closeout_path: options.stage === 'closeout' ? options.artifactPaths.closeoutPath : previous?.closeout_path ?? null,
    artifact_refs: {
      source_pack: options.artifactPaths.sourcePackPath,
      mission_brief: options.artifactPaths.missionBriefPath,
      acceptance_contract: options.artifactPaths.acceptanceContractPath,
      execution_plan: options.artifactPaths.executionPlanPath,
      closeout: options.stage === 'closeout'
        ? options.artifactPaths.closeoutPath
        : previous?.artifact_refs.closeout ?? null,
    },
    stage_history: stageHistory,
    strategy_history: nextStrategyHistory(previous, options.artifacts, options.iteration ?? null),
  };
  await writeJson(missionWorkflowPath(options.mission.mission_root), workflow);
  return workflow;
}
