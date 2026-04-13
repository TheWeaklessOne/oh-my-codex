import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { MissionLaneType, MissionStatus } from "./contracts.js";
import {
	appendMissionWatchdogDecisionEvent,
	loadMissionEvents,
	type MissionEvent,
} from "./events.js";
import type { MissionState } from "./kernel.js";
import {
	missionOrchestrationArtifactPaths,
	type MissionOrchestrationArtifactPaths,
} from "./orchestration.js";
import {
	loadMissionWorkflow,
	type MissionWorkflowState,
	type MissionWorkflowStage,
} from "./workflow.js";
import { writeAtomic } from "../team/state/io.js";

export interface MissionBudgetPolicy {
	schema_version: 1;
	max_wall_clock_minutes: number;
	max_stage_duration_minutes: number;
	max_stage_retries: number;
	max_ambiguous_iterations: number;
}

export interface MissionStageMetric {
	enter_count: number;
	last_entered_at: string | null;
	current_duration_ms: number | null;
}

export interface MissionRunMetrics {
	schema_version: 1;
	updated_at: string;
	mission_id: string;
	status: MissionStatus;
	current_stage: MissionWorkflowStage;
	current_iteration: number | null;
	wall_clock_ms: number;
	ambiguous_iterations: number;
	lane_summary_counts: Record<MissionLaneType, number>;
	stage_metrics: Record<MissionWorkflowStage, MissionStageMetric>;
}

export interface MissionWatchdogDecision {
	schema_version: 1;
	evaluated_at: string;
	decision: "continue" | "warn" | "escalate";
	reasons: string[];
	policy: MissionBudgetPolicy;
}

export const DEFAULT_MISSION_BUDGET_POLICY: MissionBudgetPolicy = {
	schema_version: 1,
	max_wall_clock_minutes: 180,
	max_stage_duration_minutes: 45,
	max_stage_retries: 3,
	max_ambiguous_iterations: 2,
};

function nowIso(): string {
	return new Date().toISOString();
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
	await writeAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson<T>(filePath: string): Promise<T> {
	return JSON.parse(await readFile(filePath, "utf-8")) as T;
}

function wallClockMs(startedAt: string, now = new Date()): number {
	const started = new Date(startedAt).getTime();
	if (Number.isNaN(started)) return 0;
	return Math.max(0, now.getTime() - started);
}

function computeLaneSummaryCounts(events: MissionEvent[]): Record<MissionLaneType, number> {
	const counts: Record<MissionLaneType, number> = {
		audit: 0,
		remediation: 0,
		execution: 0,
		hardening: 0,
		re_audit: 0,
	};
	for (const event of events) {
		if (event.event_type !== "lane_summary_recorded") continue;
		counts[event.payload.lane_type] += 1;
	}
	return counts;
}

function computeStageMetrics(
	workflow: MissionWorkflowState,
	now = new Date(),
): Record<MissionWorkflowStage, MissionStageMetric> {
	const metrics = Object.fromEntries(
		([
			"intake",
			"source-grounding",
			"contract-build",
			"planning",
			"audit",
			"execution-loop",
			"closeout",
		] as MissionWorkflowStage[]).map((stage) => [
			stage,
			{
				enter_count: 0,
				last_entered_at: null,
				current_duration_ms: null,
			},
		]),
	) as Record<MissionWorkflowStage, MissionStageMetric>;

	for (const entry of workflow.stage_history) {
		const metric = metrics[entry.stage];
		metric.enter_count += 1;
		metric.last_entered_at = entry.entered_at;
	}

	const current = metrics[workflow.current_stage];
	if (current?.last_entered_at) {
		const entered = new Date(current.last_entered_at).getTime();
		current.current_duration_ms = Number.isNaN(entered)
			? null
			: Math.max(0, now.getTime() - entered);
	}
	return metrics;
}

export function buildMissionRunMetrics(
	mission: MissionState,
	workflow: MissionWorkflowState,
	events: MissionEvent[],
	now = new Date(),
): MissionRunMetrics {
	return {
		schema_version: 1,
		updated_at: now.toISOString(),
		mission_id: mission.mission_id,
		status: mission.status,
		current_stage: workflow.current_stage,
		current_iteration: workflow.current_iteration,
		wall_clock_ms: wallClockMs(mission.started_at, now),
		ambiguous_iterations: mission.ambiguous_iterations,
		lane_summary_counts: computeLaneSummaryCounts(events),
		stage_metrics: computeStageMetrics(workflow, now),
	};
}

export function evaluateMissionWatchdog(
	metrics: MissionRunMetrics,
	policy: MissionBudgetPolicy = DEFAULT_MISSION_BUDGET_POLICY,
): MissionWatchdogDecision {
	const reasons: string[] = [];
	const currentStageMetric = metrics.stage_metrics[metrics.current_stage];
	if (metrics.wall_clock_ms > policy.max_wall_clock_minutes * 60_000) {
		reasons.push("max wall-clock runtime exceeded");
	}
	if (
		currentStageMetric.current_duration_ms !== null &&
		currentStageMetric.current_duration_ms >
			policy.max_stage_duration_minutes * 60_000
	) {
		reasons.push(`current stage ${metrics.current_stage} exceeded duration budget`);
	}
	if (currentStageMetric.enter_count > policy.max_stage_retries) {
		reasons.push(`current stage ${metrics.current_stage} exceeded retry budget`);
	}
	if (metrics.ambiguous_iterations >= policy.max_ambiguous_iterations) {
		reasons.push("ambiguous iteration budget exhausted");
	}

	const decision =
		reasons.length === 0
			? "continue"
			: reasons.some((reason) =>
					/ambiguous|wall-clock|duration/i.test(reason),
				)
				? "escalate"
				: "warn";

	return {
		schema_version: 1,
		evaluated_at: nowIso(),
		decision,
		reasons,
		policy,
	};
}

export async function syncMissionTelemetry(
	mission: MissionState,
	paths: MissionOrchestrationArtifactPaths = missionOrchestrationArtifactPaths(
		mission.mission_root,
	),
): Promise<{
	policy: MissionBudgetPolicy;
	metrics: MissionRunMetrics;
	watchdog: MissionWatchdogDecision;
}> {
	const policy = existsSync(paths.budgetPath)
		? await readJson<MissionBudgetPolicy>(paths.budgetPath)
		: DEFAULT_MISSION_BUDGET_POLICY;
	const workflow = (await loadMissionWorkflow(mission.mission_root)) ?? ({
		schema_version: 1,
		mission_id: mission.mission_id,
		slug: mission.slug,
		mission_root: mission.mission_root,
		updated_at: nowIso(),
		current_stage: "intake",
		blocked_reason: null,
		current_iteration: null,
		current_lane: null,
		brief_id: "",
		contract_id: "",
		contract_revision: 0,
		plan_id: "",
		plan_run_id: "",
		plan_revision: 0,
		planning_status: "draft",
		approval_mode: "auto_policy",
		approved_at: null,
		approved_by: null,
		replan_reason: null,
		planning_mode: "direct",
		handoff_surface: "plan",
		strategy_key: "",
		closeout_status: null,
		closeout_path: null,
		artifact_refs: {
			source_pack: "",
			mission_brief: "",
			acceptance_contract: "",
			execution_plan: "",
			closeout: null,
		},
		stage_history: [],
		strategy_history: [],
	}) as MissionWorkflowState;
	const events = await loadMissionEvents(mission.mission_root);
	const metrics = buildMissionRunMetrics(mission, workflow, events);
	const watchdog = evaluateMissionWatchdog(metrics, policy);

	await writeJson(paths.budgetPath, policy);
	await writeJson(paths.runMetricsPath, metrics);

	const previousWatchdog = existsSync(paths.watchdogPath)
		? await readJson<MissionWatchdogDecision>(paths.watchdogPath)
		: null;
	await writeJson(paths.watchdogPath, watchdog);

	if (
		!previousWatchdog ||
		previousWatchdog.decision !== watchdog.decision ||
		JSON.stringify(previousWatchdog.reasons) !== JSON.stringify(watchdog.reasons)
	) {
		await appendMissionWatchdogDecisionEvent(mission, watchdog, paths.watchdogPath);
	}

	return { policy, metrics, watchdog };
}
