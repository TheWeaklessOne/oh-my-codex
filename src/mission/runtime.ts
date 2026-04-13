import { join } from "node:path";
import {
	MISSION_LANE_POLICIES,
	MISSION_LANE_TYPES,
	type MissionLaneSummaryInput,
	type MissionLaneType,
} from "./contracts.js";
import {
	appendMissionCancelRequestedEvent,
	appendMissionCloseoutEvent,
	appendMissionIterationCommittedEvent,
	appendMissionLaneSummaryEvent,
	appendMissionOrchestrationEvents,
	ensureMissionBootstrapEvent,
} from "./events.js";
import {
	type CommitIterationResult,
	cancelMission,
	commitIteration,
	createMission,
	loadMission,
	type MissionCreateOptions,
	type MissionIterationHandle,
	type MissionRecordLaneResult,
	type MissionSafetyBaseline,
	type MissionState,
	recordLaneSummary,
	startIteration,
} from "./kernel.js";
import {
	loadMissionOrchestrationArtifacts,
	type MissionOrchestrationArtifactPaths,
	type MissionOrchestrationArtifacts,
	type MissionPlanningMode,
	type MissionRequirementSourceInput,
	missionLaneBriefingPath,
	missionOrchestrationArtifactPaths,
	prepareMissionOrchestrationArtifacts,
	syncMissionCloseout,
	writeMissionLaneBriefings,
} from "./orchestration.js";
import { reconcileMissionWorkflow, syncMissionWorkflow } from "./workflow.js";

export interface MissionLaneRuntimePlan {
	laneType: MissionLaneType;
	runnerType: "team" | "ralph" | "direct";
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
		planRunId: string;
		mode: MissionPlanningMode;
		handoffSurface: "plan" | "ralplan" | "deep-interview";
		status: "approved" | "blocked";
		blockingReason: string | null;
		approvalMode: string;
		approvedBy: string | null;
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
	ambiguity?: "low" | "medium" | "high";
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
	return join(missionRoot, "mission.json");
}

function latestFile(missionRoot: string): string {
	return join(missionRoot, "latest.json");
}

function deltaFile(iterationDir: string): string {
	return join(iterationDir, "delta.json");
}

function laneSummaryPath(laneDir: string): string {
	return join(laneDir, "summary.json");
}

async function ensureMissionState(
	options: MissionCreateOptions,
): Promise<MissionState> {
	try {
		return await loadMission(options.repoRoot, options.slug);
	} catch {
		return createMission(options);
	}
}

async function loadArtifactsForMission(mission: MissionState): Promise<{
	artifacts: MissionOrchestrationArtifacts;
	paths: MissionOrchestrationArtifactPaths;
}> {
	const existing = await loadMissionOrchestrationArtifacts(
		mission.mission_root,
	);
	if (existing) {
		return {
			artifacts: existing,
			paths: missionOrchestrationArtifactPaths(mission.mission_root),
		};
	}
	const prepared = await prepareMissionOrchestrationArtifacts(mission, {});
	return {
		artifacts: prepared.artifacts,
		paths: prepared.paths,
	};
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

export async function prepareMissionRuntime(
	options: PrepareMissionRuntimeOptions,
): Promise<PreparedMissionRuntime> {
	await ensureMissionState(options);
	const currentMission = await loadMission(options.repoRoot, options.slug);
	const bootstrapCreated = await ensureMissionBootstrapEvent(currentMission);
	const prepared = await prepareMissionOrchestrationArtifacts(
		currentMission,
		options,
	);
	const { artifacts, paths } = prepared;
	const lifecycleSeedNeeded =
		bootstrapCreated || Object.values(prepared.changed).some(Boolean);
	await appendMissionOrchestrationEvents(currentMission, prepared, {
		forceAll: bootstrapCreated,
	});
	if (lifecycleSeedNeeded) {
		await syncMissionWorkflow({
			mission: currentMission,
			artifacts,
			artifactPaths: paths,
			stage: "intake",
			detail: `Mission intake captured task: ${artifacts.sourcePack.task_statement}`,
			blockedReason: null,
		});
		await syncMissionWorkflow({
			mission: currentMission,
			artifacts,
			artifactPaths: paths,
			stage: "source-grounding",
			detail: `Mission source grounding compiled ${artifacts.sourcePack.sources.length} normalized sources.`,
			blockedReason: null,
		});
		await syncMissionWorkflow({
			mission: currentMission,
			artifacts,
			artifactPaths: paths,
			stage: "contract-build",
			detail: `Acceptance contract revision ${artifacts.acceptanceContract.contract_revision} prepared for verifier lanes.`,
			blockedReason: null,
		});
		await syncMissionWorkflow({
			mission: currentMission,
			artifacts,
			artifactPaths: paths,
			stage: "planning",
			detail:
				artifacts.executionPlan.status === "approved"
					? `Mission V2 artifacts prepared via ${artifacts.executionPlan.handoff_surface}`
					: (artifacts.executionPlan.blocking_reason ??
						"Mission planning is blocked"),
			blockedReason:
				artifacts.executionPlan.status === "approved"
					? null
					: artifacts.executionPlan.blocking_reason,
		});
	}
	if (artifacts.executionPlan.status !== "approved") {
		if (!lifecycleSeedNeeded) {
			await reconcileMissionWorkflow(currentMission);
		}
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
				planRunId: artifacts.planningTransaction.plan_run_id,
				mode: artifacts.executionPlan.planning_mode,
				handoffSurface: artifacts.executionPlan.handoff_surface,
				status: artifacts.executionPlan.status,
				blockingReason: artifacts.executionPlan.blocking_reason,
				approvalMode: artifacts.planningTransaction.approval_mode,
				approvedBy: artifacts.planningTransaction.approved_by,
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
	if (lifecycleSeedNeeded || !iteration.resumed) {
		await syncMissionWorkflow({
			mission: nextMission,
			artifacts,
			artifactPaths: paths,
			stage: "audit",
			detail:
				"Initial audit is ready to start from the approved Mission V2 plan.",
			iteration: iteration.iteration,
			laneType: "audit",
		});
	} else {
		await reconcileMissionWorkflow(nextMission);
	}
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
			planRunId: artifacts.planningTransaction.plan_run_id,
			mode: artifacts.executionPlan.planning_mode,
			handoffSurface: artifacts.executionPlan.handoff_surface,
			status: artifacts.executionPlan.status,
			blockingReason: artifacts.executionPlan.blocking_reason,
			approvalMode: artifacts.planningTransaction.approval_mode,
			approvedBy: artifacts.planningTransaction.approved_by,
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
	const artifacts = await loadArtifactsForMission(mission);
	const result = await recordLaneSummary(
		repoRoot,
		slug,
		iteration ?? mission.current_iteration,
		laneType,
		summaryInput,
	);
	const nextMission = await loadMission(repoRoot, slug);
	if (result.summary) {
		await appendMissionLaneSummaryEvent(
			nextMission,
			iteration ?? mission.current_iteration,
			laneType,
			result.summaryPath,
			result.summary.verdict,
			result.summary.confidence,
		);
	}
	const closeout = await syncMissionCloseout(nextMission);
	if (closeout) {
		await appendMissionCloseoutEvent(nextMission, artifacts.paths);
	}
	await syncMissionWorkflow({
		mission: nextMission,
		artifacts: artifacts.artifacts,
		artifactPaths: artifacts.paths,
		stage: "execution-loop",
		detail: `Recorded ${laneType} lane summary for Mission V2.`,
		iteration: iteration ?? mission.current_iteration,
		laneType,
	});
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
	const artifacts = await loadArtifactsForMission(mission);
	const result = await commitIteration(
		repoRoot,
		slug,
		iteration ?? mission.current_iteration,
		safetyBaseline,
		strategyChanged,
	);
	await appendMissionIterationCommittedEvent(
		result.mission,
		iteration ?? mission.current_iteration,
		strategyChanged,
	);
	const closeout = await syncMissionCloseout(result.mission);
	if (closeout) {
		await appendMissionCloseoutEvent(result.mission, artifacts.paths);
	}
	await syncMissionWorkflow({
		mission: result.mission,
		artifacts: artifacts.artifacts,
		artifactPaths: artifacts.paths,
		stage: ["complete", "plateau", "failed", "cancelled"].includes(
			result.mission.status,
		)
			? "closeout"
			: "execution-loop",
		detail: ["complete", "plateau", "failed", "cancelled"].includes(
			result.mission.status,
		)
			? `Kernel reached terminal status: ${result.mission.status}.`
			: strategyChanged
				? "Kernel committed the latest iteration after an explicit strategy change."
				: "Kernel committed the latest iteration and the mission remains in the execution loop.",
		iteration: iteration ?? mission.current_iteration,
		laneType: "re_audit",
	});
	return result;
}

export async function cancelMissionRuntime(
	repoRoot: string,
	slug: string,
	reason?: string,
): Promise<MissionState> {
	const mission = await cancelMission(repoRoot, slug, reason);
	await appendMissionCancelRequestedEvent(mission, reason ?? null);
	const artifacts = await loadArtifactsForMission(mission);
	const closeout = await syncMissionCloseout(mission);
	if (closeout) {
		await appendMissionCloseoutEvent(mission, artifacts.paths);
	}
	await syncMissionWorkflow({
		mission,
		artifacts: artifacts.artifacts,
		artifactPaths: artifacts.paths,
		stage: mission.status === "cancelled" ? "closeout" : "execution-loop",
		detail:
			mission.status === "cancelled"
				? "Mission cancelled with all active lanes reconciled."
				: "Mission cancellation requested; awaiting lane reconciliation.",
		laneType: null,
	});
	return mission;
}
