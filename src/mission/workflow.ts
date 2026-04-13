import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MissionLaneType } from './contracts.js';
import {
  appendMissionWorkflowStageEvent,
  loadMissionEvents,
  type MissionEvent,
} from './events.js';
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

function emptyWorkflowFromMission(mission: MissionState): MissionWorkflowState {
  return {
    schema_version: 1,
    mission_id: mission.mission_id,
    slug: mission.slug,
    mission_root: mission.mission_root,
    updated_at: nowIso(),
    current_stage: 'intake',
    blocked_reason: null,
    current_iteration: null,
    current_lane: null,
    brief_id: '',
    contract_id: '',
    contract_revision: 0,
    plan_id: '',
    plan_revision: 0,
    planning_mode: 'direct',
    handoff_surface: 'plan',
    strategy_key: '',
    closeout_status: null,
    closeout_path: null,
    artifact_refs: {
      source_pack: '',
      mission_brief: '',
      acceptance_contract: '',
      execution_plan: '',
      closeout: null,
    },
    stage_history: [],
    strategy_history: [],
  };
}

function reduceMissionWorkflowEvent(
  state: MissionWorkflowState,
  event: MissionEvent,
): MissionWorkflowState {
  switch (event.event_type) {
    case 'source_pack_prepared':
      return {
        ...state,
        updated_at: event.recorded_at,
        artifact_refs: {
          ...state.artifact_refs,
          source_pack: event.payload.path,
        },
      };
    case 'mission_brief_prepared':
      return {
        ...state,
        updated_at: event.recorded_at,
        brief_id: event.payload.brief_id,
        artifact_refs: {
          ...state.artifact_refs,
          mission_brief: event.payload.path,
        },
      };
    case 'acceptance_contract_prepared':
      return {
        ...state,
        updated_at: event.recorded_at,
        contract_id: event.payload.contract_id,
        contract_revision: event.payload.contract_revision,
        artifact_refs: {
          ...state.artifact_refs,
          acceptance_contract: event.payload.path,
        },
      };
    case 'execution_plan_prepared': {
      const nextState = {
        ...state,
        updated_at: event.recorded_at,
        plan_id: event.payload.plan_id,
        plan_revision: event.payload.plan_revision,
        planning_mode: event.payload.planning_mode as MissionPlanningMode,
        handoff_surface: event.payload.handoff_surface as 'plan' | 'ralplan' | 'deep-interview',
        strategy_key: event.payload.strategy_key,
        blocked_reason: event.payload.plan_status === 'blocked' ? event.payload.blocking_reason : null,
        artifact_refs: {
          ...state.artifact_refs,
          execution_plan: event.payload.path,
        },
      };
      const last = nextState.strategy_history.at(-1);
      if (
        last
        && last.strategy_key === event.payload.strategy_key
        && last.plan_revision === event.payload.plan_revision
      ) {
        return nextState;
      }
      return {
        ...nextState,
        strategy_history: [
          ...nextState.strategy_history,
          {
            strategy_key: event.payload.strategy_key,
            plan_id: event.payload.plan_id,
            plan_revision: event.payload.plan_revision,
            recorded_at: event.recorded_at,
            reason: event.payload.previous_plan_id ? 'execution plan updated' : 'initial execution plan approved',
            iteration: null,
          },
        ],
      };
    }
    case 'workflow_stage_entered':
      return {
        ...state,
        updated_at: event.recorded_at,
        current_stage: event.payload.stage as MissionWorkflowStage,
        blocked_reason: event.payload.blocked_reason,
        current_iteration: event.payload.iteration,
        current_lane: event.payload.lane_type,
        stage_history: upsertStageHistory(
          state.stage_history,
          event.payload.stage as MissionWorkflowStage,
          event.payload.detail,
          event.payload.iteration,
          event.payload.lane_type,
        ),
      };
    case 'lane_summary_recorded':
      return {
        ...state,
        updated_at: event.recorded_at,
        current_iteration: event.payload.iteration,
        current_lane: event.payload.lane_type,
      };
    case 'iteration_committed':
      return {
        ...state,
        updated_at: event.recorded_at,
        current_iteration: event.payload.iteration,
        closeout_status: ['complete', 'plateau', 'failed', 'cancelled'].includes(event.payload.status)
          ? event.payload.status
          : state.closeout_status,
      };
    case 'mission_cancel_requested':
      return {
        ...state,
        updated_at: event.recorded_at,
        blocked_reason: event.payload.reason,
      };
    case 'closeout_generated':
      return {
        ...state,
        updated_at: event.recorded_at,
        closeout_status: event.payload.status,
        closeout_path: event.payload.closeout_path,
        artifact_refs: {
          ...state.artifact_refs,
          closeout: event.payload.closeout_path,
        },
      };
    case 'mission_bootstrapped':
    default:
      return {
        ...state,
        updated_at: event.recorded_at,
      };
  }
}

export async function rebuildMissionWorkflowFromEvents(
  mission: MissionState,
): Promise<MissionWorkflowState> {
  const events = await loadMissionEvents(mission.mission_root);
  let state = emptyWorkflowFromMission(mission);
  for (const event of events) {
    state = reduceMissionWorkflowEvent(state, event);
  }
  return state;
}

export async function reconcileMissionWorkflow(mission: MissionState): Promise<{
  rebuilt: MissionWorkflowState;
  driftDetected: boolean;
}> {
  const rebuilt = await rebuildMissionWorkflowFromEvents(mission);
  const current = await loadMissionWorkflow(mission.mission_root);
  const driftDetected = JSON.stringify(current ?? null) !== JSON.stringify(rebuilt);
  if (driftDetected) {
    await writeJson(missionWorkflowPath(mission.mission_root), rebuilt);
  }
  return { rebuilt, driftDetected };
}

export async function syncMissionWorkflow(options: SyncMissionWorkflowOptions): Promise<MissionWorkflowState> {
  await appendMissionWorkflowStageEvent(
    options.mission,
    options.stage,
    options.detail,
    options.blockedReason ?? null,
    options.iteration ?? null,
    options.laneType ?? null,
  );
  const workflow = await rebuildMissionWorkflowFromEvents(options.mission);
  await writeJson(missionWorkflowPath(options.mission.mission_root), workflow);
  return workflow;
}
