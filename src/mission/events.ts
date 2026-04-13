import { existsSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MissionLaneType, MissionStatus } from "./contracts.js";
import type { MissionState } from "./kernel.js";
import type {
	MissionOrchestrationArtifactPaths,
	MissionOrchestrationArtifactUpdate,
} from "./orchestration.js";
import type { MissionWatchdogDecision } from "./telemetry.js";

export const MISSION_EVENT_TYPES = [
	"mission_bootstrapped",
	"source_pack_prepared",
	"mission_brief_prepared",
	"acceptance_contract_prepared",
	"execution_plan_prepared",
	"planning_transaction_recorded",
	"workflow_stage_entered",
	"lane_summary_recorded",
	"iteration_committed",
	"mission_cancel_requested",
	"watchdog_decision_recorded",
	"read_models_recovered",
	"closeout_generated",
] as const;
export type MissionEventType = (typeof MISSION_EVENT_TYPES)[number];

interface MissionEventBase<T extends MissionEventType, P> {
	schema_version: 1;
	event_type: T;
	mission_id: string;
	slug: string;
	recorded_at: string;
	payload: P;
}

export type MissionEvent =
	| MissionEventBase<
			"mission_bootstrapped",
			{
				mission_root: string;
				started_at: string;
				target_fingerprint: string;
			}
	  >
	| MissionEventBase<
			"source_pack_prepared",
			{
				status: "prepared" | "updated";
				path: string;
				source_count: number;
				ambiguity: "low" | "medium" | "high";
			}
	  >
	| MissionEventBase<
			"mission_brief_prepared",
			{
				status: "prepared" | "updated";
				path: string;
				brief_id: string;
			}
	  >
	| MissionEventBase<
			"acceptance_contract_prepared",
			{
				status: "prepared" | "updated";
				path: string;
				contract_id: string;
				contract_revision: number;
			}
	  >
	| MissionEventBase<
			"execution_plan_prepared",
			{
				status: "prepared" | "updated";
				path: string;
				plan_id: string;
				plan_revision: number;
				previous_plan_id: string | null;
				planning_mode: string;
				handoff_surface: string;
				strategy_key: string;
				plan_status: "approved" | "blocked";
				blocking_reason: string | null;
			}
	  >
	| MissionEventBase<
			"planning_transaction_recorded",
			{
				path: string;
				plan_run_id: string;
				plan_id: string;
				plan_revision: number;
				status: string;
				approval_mode: string;
				approved_at: string | null;
				approved_by: string | null;
				previous_plan_run_id: string | null;
				superseded_by: string | null;
				replan_reason: string | null;
				strategy_key: string;
			}
	  >
	| MissionEventBase<
			"workflow_stage_entered",
			{
				stage: string;
				detail: string;
				blocked_reason: string | null;
				iteration: number | null;
				lane_type: MissionLaneType | null;
			}
	  >
	| MissionEventBase<
			"lane_summary_recorded",
			{
				iteration: number;
				lane_type: MissionLaneType;
				verdict: string;
				confidence: string;
				summary_path: string;
			}
	  >
	| MissionEventBase<
			"iteration_committed",
			{
				iteration: number;
				status: MissionStatus;
				strategy_changed: boolean;
				latest_summary_path: string | null;
				delta_path: string | null;
				final_reason: string | null;
			}
	  >
	| MissionEventBase<
			"mission_cancel_requested",
			{
				status: MissionStatus;
				reason: string | null;
			}
	  >
	| MissionEventBase<
			"watchdog_decision_recorded",
			{
				path: string;
				decision: string;
				reasons: string[];
			}
	  >
	| MissionEventBase<
			"read_models_recovered",
			{
				workflow_drift: boolean;
				telemetry_drift: boolean;
				closeout_drift: boolean;
			}
	  >
	| MissionEventBase<
			"closeout_generated",
			{
				status: MissionStatus;
				closeout_path: string;
				closeout_state_path: string;
			}
	  >;

function nowIso(): string {
	return new Date().toISOString();
}

export function missionEventsPath(missionRoot: string): string {
	return join(missionRoot, "events.ndjson");
}

async function appendMissionEvent(
	missionRoot: string,
	event: MissionEvent,
): Promise<void> {
	await appendFile(
		missionEventsPath(missionRoot),
		`${JSON.stringify(event)}\n`,
		"utf-8",
	);
}

export async function loadMissionEvents(
	missionRoot: string,
): Promise<MissionEvent[]> {
	const filePath = missionEventsPath(missionRoot);
	if (!existsSync(filePath)) return [];
	const content = await readFile(filePath, "utf-8");
	return content
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => JSON.parse(line) as MissionEvent);
}

export async function ensureMissionBootstrapEvent(
	mission: MissionState,
): Promise<boolean> {
	if (existsSync(missionEventsPath(mission.mission_root))) return false;
	await appendMissionEvent(mission.mission_root, {
		schema_version: 1,
		event_type: "mission_bootstrapped",
		mission_id: mission.mission_id,
		slug: mission.slug,
		recorded_at: nowIso(),
		payload: {
			mission_root: mission.mission_root,
			started_at: mission.started_at,
			target_fingerprint: mission.target_fingerprint,
		},
	});
	return true;
}

export async function appendMissionOrchestrationEvents(
	mission: MissionState,
	update: MissionOrchestrationArtifactUpdate,
	options?: {
		forceAll?: boolean;
	},
): Promise<void> {
	const { artifacts, paths, changed } = update;
	const forceAll = options?.forceAll === true;
	const prefix = {
		schema_version: 1 as const,
		mission_id: mission.mission_id,
		slug: mission.slug,
		recorded_at: nowIso(),
	};
	if (forceAll || changed.sourcePack) {
		await appendMissionEvent(mission.mission_root, {
			...prefix,
			event_type: "source_pack_prepared",
			payload: {
				status: forceAll ? "updated" : "prepared",
				path: paths.sourcePackPath,
				source_count: artifacts.sourcePack.sources.length,
				ambiguity: artifacts.sourcePack.ambiguity,
			},
		});
	}
	if (forceAll || changed.brief) {
		await appendMissionEvent(mission.mission_root, {
			...prefix,
			event_type: "mission_brief_prepared",
			payload: {
				status: forceAll ? "updated" : "prepared",
				path: paths.missionBriefPath,
				brief_id: artifacts.brief.brief_id,
			},
		});
	}
	if (forceAll || changed.acceptanceContract) {
		await appendMissionEvent(mission.mission_root, {
			...prefix,
			event_type: "acceptance_contract_prepared",
			payload: {
				status:
					artifacts.acceptanceContract.contract_revision > 1
						? "updated"
						: "prepared",
				path: paths.acceptanceContractPath,
				contract_id: artifacts.acceptanceContract.contract_id,
				contract_revision: artifacts.acceptanceContract.contract_revision,
			},
		});
	}
	if (forceAll || changed.executionPlan) {
		await appendMissionEvent(mission.mission_root, {
			...prefix,
			event_type: "execution_plan_prepared",
			payload: {
				status:
					artifacts.executionPlan.plan_revision > 1 ? "updated" : "prepared",
				path: paths.executionPlanPath,
				plan_id: artifacts.executionPlan.plan_id,
				plan_revision: artifacts.executionPlan.plan_revision,
				previous_plan_id: artifacts.executionPlan.previous_plan_id,
				planning_mode: artifacts.executionPlan.planning_mode,
				handoff_surface: artifacts.executionPlan.handoff_surface,
				strategy_key: artifacts.executionPlan.strategy_key,
				plan_status: artifacts.executionPlan.status,
				blocking_reason: artifacts.executionPlan.blocking_reason,
			},
		});
		await appendMissionEvent(mission.mission_root, {
			...prefix,
			event_type: "planning_transaction_recorded",
			payload: {
				path: paths.planningTransactionPath,
				plan_run_id: artifacts.planningTransaction.plan_run_id,
				plan_id: artifacts.planningTransaction.plan_id,
				plan_revision: artifacts.planningTransaction.plan_revision,
				status: artifacts.planningTransaction.status,
				approval_mode: artifacts.planningTransaction.approval_mode,
				approved_at: artifacts.planningTransaction.approved_at,
				approved_by: artifacts.planningTransaction.approved_by,
				previous_plan_run_id:
					artifacts.planningTransaction.previous_plan_run_id,
				superseded_by: artifacts.planningTransaction.superseded_by,
				replan_reason: artifacts.planningTransaction.replan_reason,
				strategy_key: artifacts.planningTransaction.strategy_key,
			},
		});
	}
}

export async function appendMissionWorkflowStageEvent(
	mission: MissionState,
	stage: string,
	detail: string,
	blockedReason: string | null,
	iteration: number | null,
	laneType: MissionLaneType | null,
): Promise<void> {
	await appendMissionEvent(mission.mission_root, {
		schema_version: 1,
		event_type: "workflow_stage_entered",
		mission_id: mission.mission_id,
		slug: mission.slug,
		recorded_at: nowIso(),
		payload: {
			stage,
			detail,
			blocked_reason: blockedReason,
			iteration,
			lane_type: laneType,
		},
	});
}

export async function appendMissionLaneSummaryEvent(
	mission: MissionState,
	iteration: number,
	laneType: MissionLaneType,
	summaryPath: string,
	verdict: string,
	confidence: string,
): Promise<void> {
	await appendMissionEvent(mission.mission_root, {
		schema_version: 1,
		event_type: "lane_summary_recorded",
		mission_id: mission.mission_id,
		slug: mission.slug,
		recorded_at: nowIso(),
		payload: {
			iteration,
			lane_type: laneType,
			verdict,
			confidence,
			summary_path: summaryPath,
		},
	});
}

export async function appendMissionIterationCommittedEvent(
	mission: MissionState,
	iteration: number,
	strategyChanged: boolean,
): Promise<void> {
	await appendMissionEvent(mission.mission_root, {
		schema_version: 1,
		event_type: "iteration_committed",
		mission_id: mission.mission_id,
		slug: mission.slug,
		recorded_at: nowIso(),
		payload: {
			iteration,
			status: mission.status,
			strategy_changed: strategyChanged,
			latest_summary_path: mission.latest_summary_path,
			delta_path:
				mission.current_iteration === iteration
					? join(
							mission.mission_root,
							"iterations",
							String(iteration).padStart(3, "0"),
							"delta.json",
						)
					: null,
			final_reason: mission.final_reason,
		},
	});
}

export async function appendMissionCancelRequestedEvent(
	mission: MissionState,
	reason: string | null,
): Promise<void> {
	await appendMissionEvent(mission.mission_root, {
		schema_version: 1,
		event_type: "mission_cancel_requested",
		mission_id: mission.mission_id,
		slug: mission.slug,
		recorded_at: nowIso(),
		payload: {
			status: mission.status,
			reason,
		},
	});
}

export async function appendMissionCloseoutEvent(
	mission: MissionState,
	artifactPaths: MissionOrchestrationArtifactPaths,
): Promise<void> {
	await appendMissionEvent(mission.mission_root, {
		schema_version: 1,
		event_type: "closeout_generated",
		mission_id: mission.mission_id,
		slug: mission.slug,
		recorded_at: nowIso(),
		payload: {
			status: mission.status,
			closeout_path: artifactPaths.closeoutPath,
			closeout_state_path: artifactPaths.closeoutStatePath,
		},
	});
}

export async function appendMissionWatchdogDecisionEvent(
	mission: MissionState,
	watchdog: MissionWatchdogDecision,
	watchdogPath: string,
): Promise<void> {
	await appendMissionEvent(mission.mission_root, {
		schema_version: 1,
		event_type: "watchdog_decision_recorded",
		mission_id: mission.mission_id,
		slug: mission.slug,
		recorded_at: nowIso(),
		payload: {
			path: watchdogPath,
			decision: watchdog.decision,
			reasons: watchdog.reasons,
		},
	});
}

export async function appendMissionReadModelsRecoveredEvent(
	mission: MissionState,
	drift: {
		workflow: boolean;
		telemetry: boolean;
		closeout: boolean;
	},
): Promise<void> {
	await appendMissionEvent(mission.mission_root, {
		schema_version: 1,
		event_type: "read_models_recovered",
		mission_id: mission.mission_id,
		slug: mission.slug,
		recorded_at: nowIso(),
		payload: {
			workflow_drift: drift.workflow,
			telemetry_drift: drift.telemetry,
			closeout_drift: drift.closeout,
		},
	});
}
