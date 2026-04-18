import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
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
	loadMissionEvents,
} from "./events.js";
import {
	loadMissionLaneExecutionEnvelope,
	type MissionLaneExecutionEnvelope,
	missionLaneExecutionEnvelopePath,
	prepareMissionLaneExecutionEnvelopes,
} from "./isolation.js";
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
	resolveTargetFingerprint,
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
import { syncMissionTelemetry } from "./telemetry.js";
import {
	type MissionV3ArtifactPaths,
	missionV3ArtifactPaths,
	recordMissionV3LaneSummary,
	syncMissionV3AfterCancel,
	syncMissionV3AfterCommit,
	syncMissionV3Bootstrap,
} from "./v3.js";
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
	executionEnvelopePath: string;
	executionEnvelope: MissionLaneExecutionEnvelope;
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
	v3Paths: MissionV3ArtifactPaths;
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
): Promise<{ mission: MissionState; created: boolean }> {
	const stateFile = missionFile(
		join(options.repoRoot, ".omx", "missions", options.slug),
	);
	if (!existsSync(stateFile)) {
		return {
			mission: await createMission(options),
			created: true,
		};
	}
	const mission = await loadMission(options.repoRoot, options.slug);
	const requestedFingerprint = resolveTargetFingerprint(options);
	if (mission.target_fingerprint !== requestedFingerprint) {
		throw new Error(`mission_target_mismatch:${options.slug}`);
	}
	return { mission, created: false };
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
	throw new Error(`mission_orchestration_artifacts_missing:${mission.slug}`);
}

function hasBootstrapInputs(options: PrepareMissionRuntimeOptions): boolean {
	return Boolean(
		options.task ||
			options.desiredOutcome ||
			options.requirementSources?.length ||
			options.constraints?.length ||
			options.unknowns?.length ||
			options.assumptions?.length ||
			options.nonGoals?.length ||
			options.projectTouchpoints?.length ||
			options.acceptanceCriteria?.length ||
			options.invariants?.length ||
			options.requiredTestEvidence?.length ||
			options.requiredOperationalEvidence?.length ||
			options.residualClassificationRules?.length ||
			options.verifierGuidance?.length ||
			options.highRisk ||
			options.planningMode ||
			options.ambiguity ||
			(options.repoContext && Object.keys(options.repoContext).length > 0),
	);
}

function buildLanePlans(
	missionRoot: string,
	iteration: MissionIterationHandle,
	artifactPaths: MissionOrchestrationArtifactPaths,
	envelopes: Record<MissionLaneType, MissionLaneExecutionEnvelope>,
): Record<MissionLaneType, MissionLaneRuntimePlan> {
	return Object.fromEntries(
		MISSION_LANE_TYPES.map((laneType) => [
			laneType,
			{
				laneType,
				laneDir: envelopes[laneType].lane_root,
				summaryPath: envelopes[laneType].lane_summary_path,
				briefingPath: missionLaneBriefingPath(envelopes[laneType].lane_root),
				missionBriefPath: artifactPaths.missionBriefPath,
				acceptanceContractPath: artifactPaths.acceptanceContractPath,
				executionPlanPath: artifactPaths.executionPlanPath,
				executionEnvelopePath: join(
					envelopes[laneType].lane_root,
					"execution-envelope.json",
				),
				executionEnvelope: envelopes[laneType],
				...MISSION_LANE_POLICIES[laneType],
			},
		]),
	) as Record<MissionLaneType, MissionLaneRuntimePlan>;
}

export async function prepareMissionRuntime(
	options: PrepareMissionRuntimeOptions,
): Promise<PreparedMissionRuntime> {
	const { mission: currentMission, created } =
		await ensureMissionState(options);
	const hadWorkflowStageEvents = (
		await loadMissionEvents(currentMission.mission_root)
	).some((event) => event.event_type === "workflow_stage_entered");
	const existingArtifacts = await loadMissionOrchestrationArtifacts(
		currentMission.mission_root,
	);
	if (!created && !existingArtifacts && !hasBootstrapInputs(options)) {
		throw new Error(
			`mission_orchestration_bootstrap_required:${currentMission.slug}`,
		);
	}
	const bootstrapCreated = await ensureMissionBootstrapEvent(currentMission);
	const prepared = await prepareMissionOrchestrationArtifacts(
		currentMission,
		options,
	);
	const { artifacts, paths } = prepared;
	const changedArtifacts = Object.values(prepared.changed).some(Boolean);
	const orchestrationEventsBackfilled = await appendMissionOrchestrationEvents(
		currentMission,
		prepared,
		{
			forceAll: bootstrapCreated,
		},
	);
	const lifecycleSeedNeeded =
		bootstrapCreated ||
		changedArtifacts ||
		(orchestrationEventsBackfilled && !hadWorkflowStageEvents);
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
		const v3Result = await syncMissionV3Bootstrap({
			mission: currentMission,
			artifacts,
			artifactPaths: paths,
			highRisk: options.highRisk,
			iteration: null,
		});
		if (!lifecycleSeedNeeded) {
			await reconcileMissionWorkflow(v3Result.mission);
		}
		await syncMissionTelemetry(v3Result.mission, paths);
		return {
			mission: v3Result.mission,
			iteration: null,
			missionRoot: v3Result.mission.mission_root,
			missionFile: missionFile(v3Result.mission.mission_root),
			latestFile: latestFile(v3Result.mission.mission_root),
			deltaFile: null,
			lanePlans: {},
			artifacts,
			artifactPaths: paths,
			v3Paths: v3Result.paths,
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
	const envelopes = await prepareMissionLaneExecutionEnvelopes(
		nextMission,
		iteration.iteration,
	);
	const lanePlans = buildLanePlans(
		nextMission.mission_root,
		iteration,
		paths,
		envelopes,
	);
	await writeMissionLaneBriefings(
		Object.fromEntries(
			Object.entries(lanePlans).map(([laneType, plan]) => [laneType, plan.laneDir]),
		) as Record<MissionLaneType, string>,
		artifacts,
		paths,
	);
	const v3Result = await syncMissionV3Bootstrap({
		mission: nextMission,
		artifacts,
		artifactPaths: paths,
		highRisk: options.highRisk,
		iteration: iteration.iteration,
	});
	if (lifecycleSeedNeeded || !iteration.resumed) {
		await syncMissionWorkflow({
			mission: v3Result.mission,
			artifacts,
			artifactPaths: paths,
			stage: "audit",
			detail:
				"Initial audit is ready to start from the approved Mission V2 plan.",
			iteration: iteration.iteration,
			laneType: "audit",
		});
	} else {
		await reconcileMissionWorkflow(v3Result.mission);
	}
	await syncMissionTelemetry(v3Result.mission, paths);
	return {
		mission: v3Result.mission,
		iteration,
		missionRoot: v3Result.mission.mission_root,
		missionFile: missionFile(v3Result.mission.mission_root),
		latestFile: latestFile(v3Result.mission.mission_root),
		deltaFile: deltaFile(iteration.iterationDir),
		lanePlans,
		artifacts,
		artifactPaths: paths,
		v3Paths: v3Result.paths,
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
	const expectedIteration = iteration ?? mission.current_iteration;
	const envelope = await loadMissionLaneExecutionEnvelope(
		mission.mission_root,
		expectedIteration,
		laneType,
	);
	const expectedCandidateId = mission.active_candidate_id ?? envelope.candidate_id;
	if (envelope.candidate_id !== expectedCandidateId) {
		throw new Error(
			`lane_candidate_envelope_stale:${laneType}:${expectedIteration}:${envelope.candidate_id}:${expectedCandidateId}`,
		);
	}
	const provenanceCandidateId = String(
		summaryInput.provenance.candidate_id ?? envelope.candidate_id,
	).trim();
	if (!provenanceCandidateId) {
		throw new Error(
			`lane_candidate_id_required:${laneType}:${expectedIteration}`,
		);
	}
	if (provenanceCandidateId !== envelope.candidate_id) {
		throw new Error(
			`lane_candidate_mismatch:${laneType}:${expectedIteration}:${provenanceCandidateId}:${envelope.candidate_id}`,
		);
	}
	if (
		envelope.read_only_enforced &&
		`sha256:${createHash("sha256")
			.update(String(summaryInput.provenance.run_token ?? ""))
			.digest("hex")}` !== envelope.provenance_binding_token_hash
	) {
		throw new Error(
			`lane_provenance_token_mismatch:${laneType}:${expectedIteration}`,
		);
	}
	const result = await recordLaneSummary(
		repoRoot,
		slug,
		expectedIteration,
		laneType,
		{
			...summaryInput,
			provenance: {
				...summaryInput.provenance,
				candidate_id: provenanceCandidateId,
			},
		},
	);
	const nextMission = await loadMission(repoRoot, slug);
	if (result.status === "written" && result.summary) {
		await appendMissionLaneSummaryEvent(
			nextMission,
			expectedIteration,
			laneType,
			envelope.lane_summary_path,
			result.summary.verdict,
			result.summary.confidence,
		);
		await recordMissionV3LaneSummary({
			mission: nextMission,
			artifacts: artifacts.artifacts,
			artifactPaths: artifacts.paths,
			laneType,
			summaryPath: envelope.lane_summary_path,
			summary: result.summary,
			iteration: expectedIteration,
		});
	}
	const reconciledMission = await loadMission(repoRoot, slug);
	const closeout = await syncMissionCloseout(reconciledMission);
	if (closeout) {
		await appendMissionCloseoutEvent(reconciledMission, artifacts.paths);
	}
	await syncMissionWorkflow({
		mission: reconciledMission,
		artifacts: artifacts.artifacts,
		artifactPaths: artifacts.paths,
		stage: "execution-loop",
		detail: `Recorded ${laneType} lane summary for Mission V2.`,
		iteration: expectedIteration,
		laneType,
	});
	await syncMissionTelemetry(reconciledMission, artifacts.paths);
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
	const v3Result = await syncMissionV3AfterCommit({
		mission: result.mission,
		artifacts: artifacts.artifacts,
		artifactPaths: artifacts.paths,
		safetyBaseline,
		iteration: iteration ?? mission.current_iteration,
		strategyChanged,
		kernelJudgement: result.judgement,
	});
	const closeout = await syncMissionCloseout(v3Result.mission);
	if (closeout) {
		await appendMissionCloseoutEvent(v3Result.mission, artifacts.paths);
	}
	await syncMissionWorkflow({
		mission: v3Result.mission,
		artifacts: artifacts.artifacts,
		artifactPaths: artifacts.paths,
		stage: ["complete", "plateau", "failed", "cancelled"].includes(
			v3Result.mission.status,
		)
			? "closeout"
			: "execution-loop",
		detail: ["complete", "plateau", "failed", "cancelled"].includes(
			v3Result.mission.status,
		)
			? `Kernel reached terminal or promotion-ready compatibility status: ${v3Result.mission.status}.`
			: strategyChanged
				? "Kernel committed the latest iteration after an explicit strategy change."
				: "Kernel committed the latest iteration and the mission remains in the execution loop.",
		iteration: iteration ?? mission.current_iteration,
		laneType: "re_audit",
	});
	await syncMissionTelemetry(v3Result.mission, artifacts.paths);
	return {
		...result,
		mission: v3Result.mission,
	};
}

export async function cancelMissionRuntime(
	repoRoot: string,
	slug: string,
	reason?: string,
): Promise<MissionState> {
	const mission = await cancelMission(repoRoot, slug, reason);
	await appendMissionCancelRequestedEvent(mission, reason ?? null);
	const artifacts = await loadArtifactsForMission(mission);
	const v3Result = await syncMissionV3AfterCancel({
		mission,
		artifacts: artifacts.artifacts,
		artifactPaths: artifacts.paths,
	});
	const closeout = await syncMissionCloseout(v3Result.mission);
	if (closeout) {
		await appendMissionCloseoutEvent(v3Result.mission, artifacts.paths);
	}
	await syncMissionWorkflow({
		mission: v3Result.mission,
		artifacts: artifacts.artifacts,
		artifactPaths: artifacts.paths,
		stage:
			v3Result.mission.status === "cancelled" ? "closeout" : "execution-loop",
		detail:
			v3Result.mission.status === "cancelled"
				? "Mission cancelled with all active lanes reconciled."
				: "Mission cancellation requested; awaiting lane reconciliation.",
		laneType: null,
	});
	await syncMissionTelemetry(v3Result.mission, artifacts.paths);
	return v3Result.mission;
}
