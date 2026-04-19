import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { writeAtomic } from "../team/state/io.js";
import {
	canTransitionMissionStatus,
	closureMatrixDecision,
	computeResidualSetFingerprint,
	DEFAULT_MISSION_CLOSURE_POLICY,
	DEFAULT_MISSION_PLATEAU_POLICY,
	isResidualStableMatch,
	MISSION_LANE_POLICIES,
	MISSION_LANE_TYPES,
	MISSION_REQUIRED_LANE_TYPES,
	MISSION_STATUSES,
	type MissionClosurePolicy,
	type MissionHardeningGatePolicy,
	type MissionLaneSummary,
	type MissionLaneSummaryInput,
	type MissionLaneType,
	type MissionPlateauPolicy,
	type MissionResidual,
	type MissionStatus,
	type MissionVerdict,
	normalizeLaneSummary,
	severityRank,
} from "./contracts.js";
import {
	collectMissionHardeningArtifactRefs,
	deriveMissionHardeningGatePolicy,
	missionHardeningArtifactPaths,
	missionHardeningGateIsRequired,
	readMissionHardeningReportFromLaneRoot,
	validateMissionHardeningReport,
} from "./hardening.js";
import { loadMissionLaneExecutionEnvelope } from "./isolation.js";

export interface MissionState {
	schema_version: 1;
	mission_version: 2 | 3;
	mission_id: string;
	slug: string;
	repo_root: string;
	mission_root: string;
	target_fingerprint: string;
	status: MissionStatus;
	lifecycle_state:
		| "bootstrapping"
		| "planning"
		| "blocked_external"
		| "executing"
		| "assuring"
		| "verified"
		| "promotion_ready"
		| "released"
		| "handed_off"
		| "plateau"
		| "failed"
		| "cancelled";
	started_at: string;
	updated_at: string;
	current_iteration: number;
	current_stage: MissionLaneType | "idle" | "judging";
	active_lanes: Array<{
		lane_id: string;
		session_id: string;
		lane_type: MissionLaneType;
		runner_type: "team" | "ralph" | "direct";
		finished_at: string;
	}>;
	closure_policy: MissionClosurePolicy;
	plateau_policy: MissionPlateauPolicy;
	latest_verdict: MissionVerdict;
	latest_summary_path: string | null;
	latest_lane_provenance: Array<{
		lane_id: string;
		session_id: string;
		lane_type: MissionLaneType;
		runner_type: "team" | "ralph" | "direct";
		finished_at: string;
	}>;
	unchanged_iterations: number;
	ambiguous_iterations: number;
	oscillation_count: number;
	last_residual_fingerprint: string | null;
	last_strategy_key: string | null;
	final_reason: string | null;
	active_candidate_id: string | null;
	selected_candidate_id: string | null;
	candidate_ids: string[];
	assurance_contract_id: string | null;
	proof_program_id: string | null;
	checker_lock_id: string | null;
	environment_contract_id: string | null;
	policy_profile: {
		risk_class: string;
		assurance_profile: string;
		autonomy_profile: string;
	};
	verification_state: {
		status: string;
		blocking_obligation_ids: string[];
		satisfied_obligation_ids: string[];
		contradicted_obligation_ids: string[];
		stale_obligation_ids: string[];
		adjudication_state: string;
		last_verified_at: string | null;
	};
	promotion_state: {
		status: string;
		blocking_reasons: string[];
		last_decision_at: string | null;
		decision_ref: string | null;
	};
	plateau_strategy_state: {
		strategy_key: string | null;
		mutation_attempts: number;
		candidate_expansions: number;
		exhausted: boolean;
	};
	kernel_blockers: string[];
	latest_authoritative_iteration_ref: string | null;
	latest_authoritative_adjudication_ref: string | null;
}

export interface MissionLatestSnapshot {
	mission_id: string;
	current_iteration: number;
	latest_lane: MissionLaneType;
	latest_verdict: MissionVerdict;
	latest_summary_path: string;
	updated_at: string;
}

export interface MissionDelta {
	previous_iteration: number | null;
	current_iteration: number;
	previous_verdict: MissionVerdict | null;
	current_verdict: MissionVerdict;
	improved_residual_ids: string[];
	unchanged_residual_ids: string[];
	regressed_residual_ids: string[];
	resolved_residual_ids: string[];
	introduced_residual_ids: string[];
	oscillating_residual_ids: string[];
	lineage_split_residual_ids: string[];
	lineage_merge_residual_ids: string[];
	low_confidence_residual_ids: string[];
	severity_rollup: {
		improved: number;
		unchanged: number;
		regressed: number;
		resolved: number;
		introduced: number;
	};
}

export interface MissionCreateOptions {
	repoRoot: string;
	slug: string;
	targetFingerprint?: string;
	startedAt?: string;
	closurePolicy?: Partial<MissionClosurePolicy>;
	plateauPolicy?: Partial<MissionPlateauPolicy>;
}

export interface MissionIterationHandle {
	iteration: number;
	resumed: boolean;
	iterationDir: string;
	laneDirs: Record<MissionLaneType, string>;
}

export interface MissionRecordLaneResult {
	status: "written" | "duplicate" | "ignored";
	summaryPath: string;
	summary?: MissionLaneSummary;
	reason?: "terminal" | "superseded" | "future" | "duplicate" | "cancelled";
}

export interface MissionSafetyBaseline {
	iteration_commit_succeeded: boolean;
	no_unreconciled_lane_errors: boolean;
	focused_checks_green: boolean;
}

export interface MissionJudgement {
	nextStatus: MissionStatus;
	reason: string;
	closureDecision: "complete" | "iterate" | "failed";
}

interface MissionIterationSummaries {
	audit: MissionLaneSummary;
	remediation: MissionLaneSummary;
	execution: MissionLaneSummary;
	hardening: MissionLaneSummary | null;
	re_audit: MissionLaneSummary;
}

export interface CommitIterationResult {
	mission: MissionState;
	delta: MissionDelta;
	latest: MissionLatestSnapshot;
	judgement: MissionJudgement;
}

function nowIso(): string {
	return new Date().toISOString();
}

function missionRoot(repoRoot: string, slug: string): string {
	return join(repoRoot, ".omx", "missions", slug);
}

function missionPath(repoRoot: string, slug: string): string {
	return join(missionRoot(repoRoot, slug), "mission.json");
}

function latestPath(repoRoot: string, slug: string): string {
	return join(missionRoot(repoRoot, slug), "latest.json");
}

function executionPlanStatePathForMission(mission: MissionState): string {
	return join(mission.mission_root, "execution-plan.json");
}

function buildMissionLatestSnapshot(
	mission: MissionState,
): MissionLatestSnapshot | null {
	if (!mission.latest_summary_path) return null;
	const latestVerifierFinishedAt =
		[...mission.latest_lane_provenance]
			.reverse()
			.find((entry) => entry.lane_type === "re_audit")?.finished_at ??
		mission.updated_at;
	return {
		mission_id: mission.mission_id,
		current_iteration: mission.current_iteration,
		latest_lane: "re_audit",
		latest_verdict: mission.latest_verdict,
		latest_summary_path: mission.latest_summary_path,
		updated_at: latestVerifierFinishedAt,
	};
}

function candidateIterationRoot(
	repoRoot: string,
	slug: string,
	candidateId: string,
	iteration: number,
): string {
	return join(
		missionRoot(repoRoot, slug),
		"candidates",
		candidateId,
		"iterations",
		iterationId(iteration),
	);
}

function resolveIterationRoot(
	repoRoot: string,
	slug: string,
	iteration: number,
	candidateId?: string | null,
): string {
	if (candidateId) {
		return candidateIterationRoot(repoRoot, slug, candidateId, iteration);
	}
	return iterationRoot(repoRoot, slug, iteration);
}

function iterationsRoot(repoRoot: string, slug: string): string {
	return join(missionRoot(repoRoot, slug), "iterations");
}

function iterationId(iteration: number): string {
	return String(iteration).padStart(3, "0");
}

function iterationRoot(
	repoRoot: string,
	slug: string,
	iteration: number,
): string {
	return join(iterationsRoot(repoRoot, slug), iterationId(iteration));
}

function laneSummaryPath(
	repoRoot: string,
	slug: string,
	iteration: number,
	laneType: MissionLaneType,
	candidateId?: string | null,
): string {
	return join(
		resolveIterationRoot(repoRoot, slug, iteration, candidateId),
		laneType,
		"summary.json",
	);
}

function deltaPath(repoRoot: string, slug: string, iteration: number): string {
	return join(iterationRoot(repoRoot, slug, iteration), "delta.json");
}

function expectedLatestSummaryPath(
	mission: MissionState,
	iteration: number,
): string {
	return laneSummaryPath(
		mission.repo_root,
		mission.slug,
		iteration,
		"re_audit",
		mission.active_candidate_id,
	);
}

function hashValue(input: string): string {
	return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export function resolveTargetFingerprint(
	options: MissionCreateOptions,
): string {
	const raw = String(options.targetFingerprint || "").trim();
	if (raw) return raw;
	return `repo:${hashValue(options.repoRoot)}:slug:${hashValue(options.slug)}`;
}

async function readJsonFile<T>(filePath: string): Promise<T> {
	return JSON.parse(await readFile(filePath, "utf-8")) as T;
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
	await writeAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function normalizeLifecycleState(
	status: MissionStatus,
	currentIteration: number,
	raw: unknown,
): MissionState["lifecycle_state"] {
	if (
		typeof raw === "string" &&
		[
			"bootstrapping",
			"planning",
			"blocked_external",
			"executing",
			"assuring",
			"verified",
			"promotion_ready",
			"released",
			"handed_off",
			"plateau",
			"failed",
			"cancelled",
		].includes(raw)
	) {
		return raw as MissionState["lifecycle_state"];
	}
	if (status === "failed") return "failed";
	if (status === "plateau") return "plateau";
	if (status === "cancelled") return "cancelled";
	if (status === "complete") return "verified";
	return currentIteration > 0 ? "executing" : "planning";
}

function defaultVerificationState(
	raw: Partial<MissionState["verification_state"]> | undefined,
): MissionState["verification_state"] {
	return {
		status: String(raw?.status ?? "pending"),
		blocking_obligation_ids: Array.isArray(raw?.blocking_obligation_ids)
			? raw!.blocking_obligation_ids.filter(Boolean)
			: [],
		satisfied_obligation_ids: Array.isArray(raw?.satisfied_obligation_ids)
			? raw!.satisfied_obligation_ids.filter(Boolean)
			: [],
		contradicted_obligation_ids: Array.isArray(raw?.contradicted_obligation_ids)
			? raw!.contradicted_obligation_ids.filter(Boolean)
			: [],
		stale_obligation_ids: Array.isArray(raw?.stale_obligation_ids)
			? raw!.stale_obligation_ids.filter(Boolean)
			: [],
		adjudication_state: String(raw?.adjudication_state ?? "pending"),
		last_verified_at:
			typeof raw?.last_verified_at === "string" ? raw.last_verified_at : null,
	};
}

function defaultPromotionState(
	raw: Partial<MissionState["promotion_state"]> | undefined,
): MissionState["promotion_state"] {
	return {
		status: String(raw?.status ?? "blocked"),
		blocking_reasons: Array.isArray(raw?.blocking_reasons)
			? raw!.blocking_reasons.filter(Boolean)
			: ["mission not yet verified"],
		last_decision_at:
			typeof raw?.last_decision_at === "string" ? raw.last_decision_at : null,
		decision_ref:
			typeof raw?.decision_ref === "string" ? raw.decision_ref : null,
	};
}

function defaultPlateauStrategyState(
	raw: Partial<MissionState["plateau_strategy_state"]> | undefined,
	candidateIds: string[],
	lastStrategyKey: string | null,
): MissionState["plateau_strategy_state"] {
	return {
		strategy_key:
			typeof raw?.strategy_key === "string"
				? raw.strategy_key
				: lastStrategyKey,
		mutation_attempts:
			typeof raw?.mutation_attempts === "number" ? raw.mutation_attempts : 0,
		candidate_expansions:
			typeof raw?.candidate_expansions === "number"
				? raw.candidate_expansions
				: candidateIds.length,
		exhausted: raw?.exhausted === true,
	};
}

export function normalizeMissionState(
	repoRoot: string,
	slug: string,
	raw: Partial<MissionState>,
): MissionState {
	const root = missionRoot(repoRoot, slug);
	const targetFingerprint =
		typeof raw.target_fingerprint === "string" && raw.target_fingerprint.trim()
			? raw.target_fingerprint
			: resolveTargetFingerprint({ repoRoot, slug });
	const startedAt =
		typeof raw.started_at === "string" && raw.started_at.trim()
			? raw.started_at
			: nowIso();
	const updatedAt =
		typeof raw.updated_at === "string" && raw.updated_at.trim()
			? raw.updated_at
			: startedAt;
	const currentIteration =
		typeof raw.current_iteration === "number" && raw.current_iteration > 0
			? raw.current_iteration
			: 1;
	const status: MissionStatus =
		typeof raw.status === "string" && MISSION_STATUSES.includes(raw.status as MissionStatus)
			? (raw.status as MissionStatus)
			: "running";
	const candidateIds = Array.from(
		new Set((raw.candidate_ids ?? []).filter(Boolean)),
	);
	const missionVersion =
		raw.mission_version === 2 ||
		(raw.mission_version !== 3 &&
			!raw.active_candidate_id &&
			!raw.selected_candidate_id &&
			candidateIds.length === 0 &&
			!raw.assurance_contract_id &&
			!raw.proof_program_id &&
			!raw.checker_lock_id &&
			!raw.environment_contract_id)
			? 2
			: 3;
	const lastStrategyKey =
		typeof raw.last_strategy_key === "string" ? raw.last_strategy_key : null;
	return {
		schema_version: 1,
		mission_version: missionVersion,
		mission_id:
			typeof raw.mission_id === "string" && raw.mission_id.trim()
				? raw.mission_id
				: `${slug}-${startedAt.replace(/[^0-9]/g, "").slice(0, 14)}-${hashValue(targetFingerprint)}`,
		slug,
		repo_root: repoRoot,
		mission_root:
			typeof raw.mission_root === "string" && raw.mission_root.trim()
				? raw.mission_root
				: root,
		target_fingerprint: targetFingerprint,
		status,
		lifecycle_state: normalizeLifecycleState(
			status,
			currentIteration,
			raw.lifecycle_state,
		),
		started_at: startedAt,
		updated_at: updatedAt,
		current_iteration: currentIteration,
		current_stage:
			raw.current_stage === "idle" ||
			raw.current_stage === "judging" ||
			MISSION_LANE_TYPES.includes(raw.current_stage as MissionLaneType)
				? (raw.current_stage as MissionState["current_stage"])
				: "idle",
		active_lanes: Array.isArray(raw.active_lanes) ? raw.active_lanes : [],
		closure_policy: {
			...DEFAULT_MISSION_CLOSURE_POLICY,
			...(raw.closure_policy ?? {}),
		},
		plateau_policy: {
			...DEFAULT_MISSION_PLATEAU_POLICY,
			...(raw.plateau_policy ?? {}),
		},
		latest_verdict:
			typeof raw.latest_verdict === "string"
			&& ["PASS", "PARTIAL", "FAIL", "AMBIGUOUS"].includes(raw.latest_verdict)
				? (raw.latest_verdict as MissionVerdict)
				: "AMBIGUOUS",
		latest_summary_path:
			typeof raw.latest_summary_path === "string" ? raw.latest_summary_path : null,
		latest_lane_provenance: Array.isArray(raw.latest_lane_provenance)
			? raw.latest_lane_provenance
			: [],
		unchanged_iterations:
			typeof raw.unchanged_iterations === "number"
				? raw.unchanged_iterations
				: 0,
		ambiguous_iterations:
			typeof raw.ambiguous_iterations === "number"
				? raw.ambiguous_iterations
				: 0,
		oscillation_count:
			typeof raw.oscillation_count === "number" ? raw.oscillation_count : 0,
		last_residual_fingerprint:
			typeof raw.last_residual_fingerprint === "string"
				? raw.last_residual_fingerprint
				: null,
		last_strategy_key: lastStrategyKey,
		final_reason:
			typeof raw.final_reason === "string" ? raw.final_reason : null,
		active_candidate_id:
			typeof raw.active_candidate_id === "string" ? raw.active_candidate_id : null,
		selected_candidate_id:
			typeof raw.selected_candidate_id === "string"
				? raw.selected_candidate_id
				: null,
		candidate_ids: candidateIds,
		assurance_contract_id:
			typeof raw.assurance_contract_id === "string"
				? raw.assurance_contract_id
				: null,
		proof_program_id:
			typeof raw.proof_program_id === "string" ? raw.proof_program_id : null,
		checker_lock_id:
			typeof raw.checker_lock_id === "string" ? raw.checker_lock_id : null,
		environment_contract_id:
			typeof raw.environment_contract_id === "string"
				? raw.environment_contract_id
				: null,
		policy_profile: {
			risk_class: String(raw.policy_profile?.risk_class ?? "low-risk-local"),
			assurance_profile: String(
				raw.policy_profile?.assurance_profile ?? "balanced",
			),
			autonomy_profile: String(raw.policy_profile?.autonomy_profile ?? "guarded"),
		},
		verification_state: defaultVerificationState(raw.verification_state),
		promotion_state: defaultPromotionState(raw.promotion_state),
		plateau_strategy_state: defaultPlateauStrategyState(
			raw.plateau_strategy_state,
			candidateIds,
			lastStrategyKey,
		),
		kernel_blockers: Array.isArray(raw.kernel_blockers)
			? raw.kernel_blockers.filter(Boolean)
			: [],
		latest_authoritative_iteration_ref:
			typeof raw.latest_authoritative_iteration_ref === "string"
				? raw.latest_authoritative_iteration_ref
				: null,
		latest_authoritative_adjudication_ref:
			typeof raw.latest_authoritative_adjudication_ref === "string"
				? raw.latest_authoritative_adjudication_ref
				: null,
	};
}

async function listMissionJsonFiles(repoRoot: string): Promise<string[]> {
	const root = join(repoRoot, ".omx", "missions");
	if (!existsSync(root)) return [];
	const entries = await readdir(root, { withFileTypes: true });
	return entries
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(root, entry.name, "mission.json"))
		.filter((filePath) => existsSync(filePath));
}

function isTerminalStatus(status: MissionStatus): boolean {
	return (
		status === "cancelled" ||
		status === "complete" ||
		status === "plateau" ||
		status === "failed"
	);
}

export async function createMission(
	options: MissionCreateOptions,
): Promise<MissionState> {
	const target = resolveTargetFingerprint(options);
	const startedAt = options.startedAt ?? nowIso();
	const root = missionRoot(options.repoRoot, options.slug);

	for (const filePath of await listMissionJsonFiles(options.repoRoot)) {
		const existing = await readJsonFile<MissionState>(filePath);
		if (
			existing.target_fingerprint === target &&
			!isTerminalStatus(existing.status) &&
			basename(root) !== basename(existing.mission_root)
		) {
			throw new Error(`mission_target_collision:${existing.slug}`);
		}
	}

	await mkdir(iterationsRoot(options.repoRoot, options.slug), {
		recursive: true,
	});
	const missionId = `${options.slug}-${startedAt.replace(/[^0-9]/g, "").slice(0, 14)}-${hashValue(target)}`;
	const state: MissionState = {
		schema_version: 1,
		mission_version: 3,
		mission_id: missionId,
		slug: options.slug,
		repo_root: options.repoRoot,
		mission_root: root,
		target_fingerprint: target,
		status: "running",
		lifecycle_state: "bootstrapping",
		started_at: startedAt,
		updated_at: startedAt,
		current_iteration: 1,
		current_stage: "idle",
		active_lanes: [],
		closure_policy: {
			...DEFAULT_MISSION_CLOSURE_POLICY,
			...(options.closurePolicy ?? {}),
		},
		plateau_policy: {
			...DEFAULT_MISSION_PLATEAU_POLICY,
			...(options.plateauPolicy ?? {}),
		},
		latest_verdict: "AMBIGUOUS",
		latest_summary_path: null,
		latest_lane_provenance: [],
		unchanged_iterations: 0,
		ambiguous_iterations: 0,
		oscillation_count: 0,
		last_residual_fingerprint: null,
		last_strategy_key: null,
		final_reason: null,
		active_candidate_id: null,
		selected_candidate_id: null,
		candidate_ids: [],
		assurance_contract_id: null,
		proof_program_id: null,
		checker_lock_id: null,
		environment_contract_id: null,
		policy_profile: {
			risk_class: "low-risk-local",
			assurance_profile: "balanced",
			autonomy_profile: "guarded",
		},
		verification_state: {
			status: "pending",
			blocking_obligation_ids: [],
			satisfied_obligation_ids: [],
			contradicted_obligation_ids: [],
			stale_obligation_ids: [],
			adjudication_state: "pending",
			last_verified_at: null,
		},
		promotion_state: {
			status: "blocked",
			blocking_reasons: ["mission not yet verified"],
			last_decision_at: null,
			decision_ref: null,
		},
		plateau_strategy_state: {
			strategy_key: null,
			mutation_attempts: 0,
			candidate_expansions: 0,
			exhausted: false,
		},
		kernel_blockers: [],
		latest_authoritative_iteration_ref: null,
		latest_authoritative_adjudication_ref: null,
	};
	await writeJsonFile(missionPath(options.repoRoot, options.slug), state);
	return state;
}

export async function loadMission(
	repoRoot: string,
	slug: string,
): Promise<MissionState> {
	const filePath = missionPath(repoRoot, slug);
	const raw = await readJsonFile<Partial<MissionState>>(filePath);
	return normalizeMissionState(repoRoot, slug, raw);
}

export async function resumeMission(
	repoRoot: string,
	slug: string,
): Promise<MissionState> {
	return loadMission(repoRoot, slug);
}

function buildActiveLaneEntry(
	iteration: number,
	laneType: MissionLaneType,
): MissionState["active_lanes"][number] {
	const key = `${laneType}-${iteration}`;
	return {
		lane_id: `pending:${key}`,
		session_id: `pending:${key}`,
		lane_type: laneType,
		runner_type: MISSION_LANE_POLICIES[laneType].runnerType,
		finished_at: "",
	};
}

async function deriveActiveLanes(
	repoRoot: string,
	slug: string,
	iteration: number,
	candidateId?: string | null,
): Promise<MissionState["active_lanes"]> {
	return MISSION_REQUIRED_LANE_TYPES.filter(
		(laneType) =>
			!existsSync(
				laneSummaryPath(repoRoot, slug, iteration, laneType, candidateId),
			),
	).map((laneType) => buildActiveLaneEntry(iteration, laneType));
}

function nextStageFromActiveLanes(
	activeLanes: MissionState["active_lanes"],
): MissionState["current_stage"] {
	return activeLanes[0]?.lane_type ?? "judging";
}

async function isIterationCommitted(
	repoRoot: string,
	slug: string,
	mission: MissionState,
	iteration: number,
): Promise<boolean> {
	if (!existsSync(deltaPath(repoRoot, slug, iteration))) return false;
	const expectedSummaryPath = expectedLatestSummaryPath(
		mission,
		iteration,
	);
	if (mission.latest_summary_path !== expectedSummaryPath) return false;
	if (!existsSync(latestPath(repoRoot, slug))) return false;
	const latest = await readJsonFile<MissionLatestSnapshot>(
		latestPath(repoRoot, slug),
	);
	return (
		latest.current_iteration === iteration &&
		latest.latest_summary_path === expectedSummaryPath
	);
}

function removeActiveLane(
	mission: MissionState,
	laneType: MissionLaneType,
	laneSummary?: MissionLaneSummary,
): MissionState {
	const remaining = mission.active_lanes.filter(
		(entry) => entry.lane_type !== laneType,
	);
	const latestLaneProvenance = laneSummary
		? [
				...mission.latest_lane_provenance.filter(
					(entry) => entry.lane_type !== laneType,
				),
				{
					lane_id: laneSummary.provenance.lane_id,
					session_id: laneSummary.provenance.session_id,
					lane_type: laneSummary.provenance.lane_type,
					runner_type: laneSummary.provenance.runner_type,
					finished_at: laneSummary.provenance.finished_at,
				},
			]
		: mission.latest_lane_provenance;

	const status =
		mission.status === "cancelling" && remaining.length === 0
			? "cancelled"
			: mission.status;

	return {
		...mission,
		status,
		updated_at: nowIso(),
		current_stage:
			status === "cancelled" ? "idle" : nextStageFromActiveLanes(remaining),
		active_lanes: remaining,
		latest_lane_provenance: latestLaneProvenance,
	};
}

export async function startIteration(
	repoRoot: string,
	slug: string,
	strategyKey?: string | null,
): Promise<MissionIterationHandle> {
	const mission = await loadMission(repoRoot, slug);
	if (isTerminalStatus(mission.status)) {
		throw new Error(`mission_terminal:${mission.status}`);
	}

	let iteration = mission.current_iteration;
	let resumed = existsSync(iterationRoot(repoRoot, slug, iteration));

	if (await isIterationCommitted(repoRoot, slug, mission, iteration)) {
		iteration += 1;
		resumed = false;
	}

	const baseDir = iterationRoot(repoRoot, slug, iteration);
	const laneDirs = Object.fromEntries(
		MISSION_LANE_TYPES.map((lane) => [lane, join(baseDir, lane)]),
	) as Record<MissionLaneType, string>;
	await mkdir(baseDir, { recursive: true });
	for (const laneType of MISSION_LANE_TYPES) {
		await mkdir(laneDirs[laneType], { recursive: true });
	}

	const activeLanes = await deriveActiveLanes(repoRoot, slug, iteration);
	const candidateActiveLanes = await deriveActiveLanes(
		repoRoot,
		slug,
		iteration,
		mission.active_candidate_id,
	);

	const nextMission: MissionState = {
		...mission,
		current_iteration: iteration,
		current_stage: nextStageFromActiveLanes(activeLanes),
		updated_at: nowIso(),
		last_strategy_key: strategyKey ?? mission.last_strategy_key ?? null,
		active_lanes:
			mission.active_candidate_id == null ? activeLanes : candidateActiveLanes,
	};
	await writeJsonFile(missionPath(repoRoot, slug), nextMission);

	return {
		iteration,
		resumed,
		iterationDir: baseDir,
		laneDirs,
	};
}

function validateLaneIteration(
	mission: MissionState,
	iteration: number,
): MissionRecordLaneResult["reason"] | null {
	if (isTerminalStatus(mission.status))
		return mission.status === "cancelled" ? "cancelled" : "terminal";
	if (iteration < mission.current_iteration) return "superseded";
	if (iteration > mission.current_iteration) return "future";
	return null;
}

export async function recordLaneSummary(
	repoRoot: string,
	slug: string,
	iteration: number,
	laneType: MissionLaneType,
	summaryInput: MissionLaneSummaryInput,
): Promise<MissionRecordLaneResult> {
	const mission = await loadMission(repoRoot, slug);
	const invalidReason = validateLaneIteration(mission, iteration);
	const candidateSummaryFile = laneSummaryPath(
		repoRoot,
		slug,
		iteration,
		laneType,
		mission.active_candidate_id,
	);
	if (invalidReason) {
		return {
			status: "ignored",
			summaryPath: candidateSummaryFile,
			reason: invalidReason,
		};
	}
	let nextSummaryInput = summaryInput;
	if (laneType === "hardening") {
		const laneRoot = dirname(candidateSummaryFile);
		const report = await readMissionHardeningReportFromLaneRoot(laneRoot);
		const hardeningRefs = collectMissionHardeningArtifactRefs(
			repoRoot,
			laneRoot,
			report,
		);
		if (hardeningRefs.length > 0) {
			nextSummaryInput = {
				...summaryInput,
				evidence_refs: Array.from(
					new Set([...(summaryInput.evidence_refs ?? []), ...hardeningRefs]),
				),
			};
		}
	}
	const summary = normalizeLaneSummary(nextSummaryInput);

	if (mission.status === "cancelling") {
		const nextMission = removeActiveLane(mission, laneType, summary);
		await writeJsonFile(missionPath(repoRoot, slug), nextMission);
		return {
			status: "ignored",
			summaryPath: candidateSummaryFile,
			reason: "cancelled",
			summary,
		};
	}

	if (existsSync(candidateSummaryFile)) {
		return {
			status: "duplicate",
			summaryPath: candidateSummaryFile,
			reason: "duplicate",
			summary: await readJsonFile<MissionLaneSummary>(candidateSummaryFile),
		};
	}

	await mkdir(dirname(candidateSummaryFile), {
		recursive: true,
	});
	await writeJsonFile(candidateSummaryFile, summary);
	const nextMission = removeActiveLane(mission, laneType, summary);
	await writeJsonFile(missionPath(repoRoot, slug), nextMission);
	return { status: "written", summaryPath: candidateSummaryFile, summary };
}

function loadResidualHistory(deltaHistory: MissionDelta[]): Set<string> {
	return new Set(
		deltaHistory.flatMap((delta) => delta.oscillating_residual_ids),
	);
}

function isMergeLineageResidual(residual: MissionResidual): boolean {
	return (
		residual.lineage?.kind === "merge" &&
		residual.lineage.related_residual_ids.length > 1
	);
}

function isVerifierLane(
	summary: MissionLaneSummary,
	laneType: "audit" | "re_audit",
): boolean {
	const policy = MISSION_LANE_POLICIES[laneType];
	return (
		summary.provenance.runner_type === policy.runnerType &&
		summary.provenance.read_only === true
	);
}

function sharesLaneIdentity(
	left: MissionLaneSummary,
	right: MissionLaneSummary | null,
): boolean {
	if (!right) return false;
	return (
		left.provenance.session_id === right.provenance.session_id ||
		left.provenance.lane_id === right.provenance.lane_id
	);
}

async function verifierRunTokenMatchesEnvelope(
	repoRoot: string,
	slug: string,
	iteration: number,
	laneType: "audit" | "re_audit",
	summary: MissionLaneSummary,
): Promise<boolean> {
	const missionRootPath = missionRoot(repoRoot, slug);
	const envelopePath = join(
		missionRootPath,
		"iterations",
		iterationId(iteration),
		laneType,
		"execution-envelope.json",
	);
	if (!existsSync(envelopePath)) return true;
	const envelope = await loadMissionLaneExecutionEnvelope(
		missionRootPath,
		iteration,
		laneType,
	);
	return (
		`sha256:${createHash("sha256")
			.update(String(summary.provenance.run_token ?? ""))
			.digest("hex")}` === envelope.provenance_binding_token_hash
	);
}

async function validateFreshVerifierProvenance(
	repoRoot: string,
	slug: string,
	iteration: number,
	laneSummaries: MissionIterationSummaries,
): Promise<string | null> {
	if (!isVerifierLane(laneSummaries.audit, "audit")) {
		return "audit lane must use fresh read-only verifier provenance";
	}
	if (!isVerifierLane(laneSummaries.re_audit, "re_audit")) {
		return "re-audit lane must use fresh read-only verifier provenance";
	}
	if (
		!(await verifierRunTokenMatchesEnvelope(
			repoRoot,
			slug,
			iteration,
			"audit",
			laneSummaries.audit,
		))
	) {
		return "audit lane must match the verifier execution envelope binding token";
	}
	if (
		!(await verifierRunTokenMatchesEnvelope(
			repoRoot,
			slug,
			iteration,
			"re_audit",
			laneSummaries.re_audit,
		))
	) {
		return "re-audit lane must match the verifier execution envelope binding token";
	}

	const verifierComparisons: Array<[string, MissionLaneSummary | null]> = [
		["remediation", laneSummaries.remediation],
		["execution", laneSummaries.execution],
		["hardening", laneSummaries.hardening],
	];

	for (const [laneName, summary] of verifierComparisons) {
		if (sharesLaneIdentity(laneSummaries.audit, summary)) {
			return `audit lane must not reuse ${laneName} lane identity`;
		}
		if (sharesLaneIdentity(laneSummaries.re_audit, summary)) {
			return `re-audit lane must not reuse ${laneName} lane identity`;
		}
	}

	if (sharesLaneIdentity(laneSummaries.audit, laneSummaries.re_audit)) {
		return "audit and re-audit lanes must use distinct lane identities";
	}

	return null;
}

function compareResiduals(
	previous: MissionLaneSummary | null,
	current: MissionLaneSummary,
	deltaHistory: MissionDelta[] = [],
): MissionDelta {
	const previousResiduals = previous?.residuals ?? [];
	const currentResiduals = current.residuals;
	const improved = new Set<string>();
	const unchanged = new Set<string>();
	const regressed = new Set<string>();
	const resolved = new Set<string>();
	const introduced = new Set<string>();
	const oscillating = loadResidualHistory(deltaHistory);
	const matchedCurrent = new Set<string>();
	const lineageSplit = new Set<string>();
	const lineageMerge = new Set<string>();
	const lowConfidence = new Set<string>();

	for (const prior of previousResiduals) {
		const matches = currentResiduals
			.map((candidate) => ({
				candidate,
				matched: isResidualStableMatch(prior, candidate),
			}))
			.filter((entry) => entry.matched)
			.map((entry) => entry.candidate);
		if (matches.length === 0) {
			resolved.add(prior.stable_id);
			continue;
		}
		for (const candidate of matches) {
			matchedCurrent.add(candidate.stable_id);
			if (candidate.low_confidence_marker || prior.low_confidence_marker) {
				lowConfidence.add(prior.stable_id);
				lowConfidence.add(candidate.stable_id);
			}
		}
		if (
			matches.length > 1 &&
			matches.some((candidate) => candidate.lineage?.kind === "split")
		) {
			lineageSplit.add(prior.stable_id);
		}
		const exact = matches.reduce((best, candidate) =>
			severityRank(candidate.severity) < severityRank(best.severity)
				? candidate
				: best,
		);
		if (exact.severity === prior.severity) {
			unchanged.add(prior.stable_id);
		} else if (severityRank(exact.severity) < severityRank(prior.severity)) {
			improved.add(prior.stable_id);
		} else {
			regressed.add(prior.stable_id);
			if (
				deltaHistory.some((delta) =>
					delta.improved_residual_ids.includes(prior.stable_id),
				)
			) {
				oscillating.add(prior.stable_id);
			}
		}
	}

	for (const residual of currentResiduals) {
		if (isMergeLineageResidual(residual)) {
			lineageMerge.add(residual.stable_id);
		}
		if (matchedCurrent.has(residual.stable_id)) continue;
		introduced.add(residual.stable_id);
		regressed.add(residual.stable_id);
		if (residual.low_confidence_marker) {
			lowConfidence.add(residual.stable_id);
		}
		if (
			deltaHistory.some((delta) =>
				delta.resolved_residual_ids.includes(residual.stable_id),
			)
		) {
			oscillating.add(residual.stable_id);
		}
	}

	return {
		previous_iteration: previous?.provenance.parent_iteration ?? null,
		current_iteration: current.provenance.parent_iteration,
		previous_verdict: previous?.verdict ?? null,
		current_verdict: current.verdict,
		improved_residual_ids: Array.from(improved).sort(),
		unchanged_residual_ids: Array.from(unchanged).sort(),
		regressed_residual_ids: Array.from(regressed).sort(),
		resolved_residual_ids: Array.from(resolved).sort(),
		introduced_residual_ids: Array.from(introduced).sort(),
		oscillating_residual_ids: Array.from(oscillating).sort(),
		lineage_split_residual_ids: Array.from(lineageSplit).sort(),
		lineage_merge_residual_ids: Array.from(lineageMerge).sort(),
		low_confidence_residual_ids: Array.from(lowConfidence).sort(),
		severity_rollup: {
			improved: improved.size,
			unchanged: unchanged.size,
			regressed: regressed.size,
			resolved: resolved.size,
			introduced: introduced.size,
		},
	};
}

export async function computeDelta(
	repoRoot: string,
	slug: string,
	iteration: number,
): Promise<MissionDelta> {
	const mission = await loadMission(repoRoot, slug);
	const current = await readJsonFile<MissionLaneSummary>(
		laneSummaryPath(
			repoRoot,
			slug,
			iteration,
			"re_audit",
			mission.active_candidate_id,
		),
	);
	const previousLatestFile = latestPath(repoRoot, slug);
	let previousSummary: MissionLaneSummary | null = null;
	const history: MissionDelta[] = [];

	if (existsSync(previousLatestFile)) {
		const latest =
			await readJsonFile<MissionLatestSnapshot>(previousLatestFile);
		previousSummary = await readJsonFile<MissionLaneSummary>(
			latest.latest_summary_path,
		);
		for (let idx = 1; idx < iteration; idx += 1) {
			const path = deltaPath(repoRoot, slug, idx);
			if (existsSync(path))
				history.push(await readJsonFile<MissionDelta>(path));
		}
	}

	return compareResiduals(previousSummary, current, history);
}

async function readRequiredIterationSummaries(
	repoRoot: string,
	slug: string,
	iteration: number,
	candidateId?: string | null,
): Promise<MissionIterationSummaries> {
	const summaries = {
		hardening: null,
	} as MissionIterationSummaries;

	for (const laneType of MISSION_REQUIRED_LANE_TYPES) {
		const candidateSummaryFile = laneSummaryPath(
			repoRoot,
			slug,
			iteration,
			laneType,
			candidateId,
		);
		if (!existsSync(candidateSummaryFile)) {
			throw new Error(`missing_iteration_lane_summary:${laneType}`);
		}
		summaries[laneType] = (await readJsonFile<MissionLaneSummary>(
			candidateSummaryFile,
		)) as MissionIterationSummaries[typeof laneType];
	}

	const hardeningSummaryFile = laneSummaryPath(
		repoRoot,
		slug,
		iteration,
		"hardening",
		candidateId,
	);
	if (existsSync(hardeningSummaryFile)) {
		summaries.hardening =
			await readJsonFile<MissionLaneSummary>(hardeningSummaryFile);
	}

	return summaries;
}

async function readMissionHardeningGatePolicy(
	mission: MissionState,
): Promise<MissionHardeningGatePolicy> {
	const filePath = executionPlanStatePathForMission(mission);
	if (existsSync(filePath)) {
		const raw = await readJsonFile<{
			hardening_gate?: MissionHardeningGatePolicy;
		}>(filePath);
		if (raw.hardening_gate) {
			return raw.hardening_gate;
		}
	}
	return deriveMissionHardeningGatePolicy({
		policyProfile: mission.policy_profile,
	});
}

async function validateHardeningGate(
	repoRoot: string,
	slug: string,
	iteration: number,
	mission: MissionState,
	laneSummaries: MissionIterationSummaries,
): Promise<string | null> {
	const policy = await readMissionHardeningGatePolicy(mission);
	if (!missionHardeningGateIsRequired(policy)) {
		return null;
	}
	if (!laneSummaries.hardening) {
		return "hardening_gate_incomplete:summary_missing";
	}
	const laneRoot = dirname(
		laneSummaryPath(
			repoRoot,
			slug,
			iteration,
			"hardening",
			mission.active_candidate_id,
		),
	);
	const report = await readMissionHardeningReportFromLaneRoot(laneRoot);
	if (!report) {
		return "hardening_gate_incomplete:gate_result_missing";
	}
	if (
		laneSummaries.hardening.provenance.runner_type !==
			MISSION_LANE_POLICIES.hardening.runnerType
	) {
		return "hardening_gate_runner_invalid";
	}
	if (report.status !== "passed") {
		return `hardening_gate_failed:${report.failure_reason ?? report.status}`;
	}
	const validationErrors = validateMissionHardeningReport(report, policy);
	if (validationErrors.length > 0) {
		if (
			validationErrors.some((error) =>
				error.startsWith("hardening_report_blocking_findings_remaining"),
			)
		) {
			return "hardening_gate_blocking_findings";
		}
		if (
			validationErrors.some((error) =>
				error.startsWith("hardening_report_post_deslop_verification"),
			)
		) {
			return "hardening_gate_verification_missing";
		}
		if (
			validationErrors.some((error) =>
				error.startsWith("hardening_report_final_review"),
			)
		) {
			return "hardening_gate_incomplete:final_review";
		}
		return validationErrors[0] ?? "hardening_gate_incomplete";
	}
	const hardeningCompletedAt = [
		laneSummaries.hardening.provenance.finished_at,
		report.completed_at,
	]
		.filter(Boolean)
		.sort()
		.at(-1);
	if (
		hardeningCompletedAt &&
		new Date(laneSummaries.re_audit.provenance.finished_at).getTime() <=
			new Date(hardeningCompletedAt).getTime()
	) {
		return "hardening_gate_order_invalid";
	}
	return null;
}

function isGreenSafetyBaseline(baseline: MissionSafetyBaseline): boolean {
	return (
		baseline.iteration_commit_succeeded &&
		baseline.no_unreconciled_lane_errors &&
		baseline.focused_checks_green
	);
}

export function judgeMissionState(
	mission: MissionState,
	verifier: MissionLaneSummary,
	delta: MissionDelta,
	safetyBaseline: MissionSafetyBaseline,
	closureGateError: string | null,
	strategyChanged = false,
): MissionJudgement {
	if (closureGateError) {
		return {
			nextStatus: "running",
			reason: closureGateError,
			closureDecision: "iterate",
		};
	}
	const safety = isGreenSafetyBaseline(safetyBaseline) ? "green" : "red";
	const closure = closureMatrixDecision(
		verifier.verdict,
		verifier.confidence,
		safety,
	);

	if (closure.outcome === "complete") {
		return {
			nextStatus: "complete",
			reason: closure.reason,
			closureDecision: closure.outcome,
		};
	}
	if (closure.outcome === "failed") {
		return {
			nextStatus: "failed",
			reason: closure.reason,
			closureDecision: closure.outcome,
		};
	}

	const onlyUnchanged =
		delta.severity_rollup.improved === 0 &&
		delta.severity_rollup.regressed === 0 &&
		delta.severity_rollup.resolved === 0 &&
		delta.severity_rollup.introduced === 0 &&
		delta.severity_rollup.unchanged > 0;
	if (
		onlyUnchanged &&
		mission.unchanged_iterations + 1 >=
			mission.plateau_policy.max_unchanged_iterations &&
		(!mission.plateau_policy.require_strategy_change_before_plateau ||
			strategyChanged)
	) {
		return {
			nextStatus: "plateau",
			reason: "unchanged residuals exceeded plateau policy",
			closureDecision: "iterate",
		};
	}

	if (
		delta.oscillating_residual_ids.length >=
			mission.plateau_policy.oscillation_window &&
		delta.oscillating_residual_ids.length > 0
	) {
		return {
			nextStatus: "plateau",
			reason: "oscillating residuals exceeded plateau policy",
			closureDecision: "iterate",
		};
	}

	if (
		verifier.verdict === "AMBIGUOUS" &&
		mission.ambiguous_iterations + 1 >=
			mission.plateau_policy.max_ambiguous_iterations
	) {
		return {
			nextStatus:
				mission.closure_policy.ambiguous_outcome === "failed"
					? "failed"
					: "plateau",
			reason: "ambiguous verifier retry budget exhausted",
			closureDecision: "iterate",
		};
	}

	return {
		nextStatus: "running",
		reason: closure.reason,
		closureDecision: closure.outcome,
	};
}

export async function commitIteration(
	repoRoot: string,
	slug: string,
	iteration: number,
	safetyBaseline: MissionSafetyBaseline,
	strategyChanged = false,
): Promise<CommitIterationResult> {
	const mission = await loadMission(repoRoot, slug);
	const laneSummaries = await readRequiredIterationSummaries(
		repoRoot,
		slug,
		iteration,
		mission.active_candidate_id,
	);
	const verifier = laneSummaries.re_audit;
	const delta = await computeDelta(repoRoot, slug, iteration);
	const verifierFreshnessError = await validateFreshVerifierProvenance(
		repoRoot,
		slug,
		iteration,
		laneSummaries,
	);
	const hardeningGateError = await validateHardeningGate(
		repoRoot,
		slug,
		iteration,
		mission,
		laneSummaries,
	);

	const judgement = judgeMissionState(
		mission,
		verifier,
		delta,
		safetyBaseline,
		hardeningGateError ?? verifierFreshnessError,
		strategyChanged,
	);
	if (!canTransitionMissionStatus(mission.status, judgement.nextStatus)) {
		throw new Error(
			`invalid_mission_transition:${mission.status}->${judgement.nextStatus}`,
		);
	}

	const residualFingerprint = computeResidualSetFingerprint(verifier.residuals);
	const nextMission: MissionState = {
		...mission,
		status: judgement.nextStatus,
		updated_at: nowIso(),
		current_stage: judgement.nextStatus === "running" ? "judging" : "idle",
		latest_verdict: verifier.verdict,
		latest_summary_path: laneSummaryPath(
			repoRoot,
			slug,
			iteration,
			"re_audit",
			mission.active_candidate_id,
		),
		unchanged_iterations:
			delta.severity_rollup.unchanged > 0 &&
			delta.severity_rollup.improved === 0 &&
			delta.severity_rollup.regressed === 0 &&
			delta.severity_rollup.resolved === 0 &&
			delta.severity_rollup.introduced === 0
				? mission.unchanged_iterations + 1
				: 0,
		ambiguous_iterations:
			verifier.verdict === "AMBIGUOUS" ? mission.ambiguous_iterations + 1 : 0,
		oscillation_count:
			delta.oscillating_residual_ids.length > 0
				? mission.oscillation_count + 1
				: 0,
		last_residual_fingerprint: residualFingerprint,
		final_reason: judgement.nextStatus === "running" ? null : judgement.reason,
		active_lanes: [],
	};
	const latest: MissionLatestSnapshot = {
		mission_id: mission.mission_id,
		current_iteration: iteration,
		latest_lane: "re_audit",
		latest_verdict: verifier.verdict,
		latest_summary_path: laneSummaryPath(
			repoRoot,
			slug,
			iteration,
			"re_audit",
			mission.active_candidate_id,
		),
		updated_at: nextMission.updated_at,
	};

	await writeJsonFile(missionPath(repoRoot, slug), nextMission);
	await writeJsonFile(deltaPath(repoRoot, slug, iteration), delta);
	await writeJsonFile(latestPath(repoRoot, slug), latest);
	return { mission: nextMission, delta, latest, judgement };
}

export async function cancelMission(
	repoRoot: string,
	slug: string,
	reason = "cancel requested",
): Promise<MissionState> {
	const mission = await loadMission(repoRoot, slug);
	const nextStatus: MissionStatus =
		mission.active_lanes.length > 0 ? "cancelling" : "cancelled";
	if (!canTransitionMissionStatus(mission.status, nextStatus)) {
		throw new Error(
			`invalid_mission_transition:${mission.status}->${nextStatus}`,
		);
	}
	const nextMission: MissionState = {
		...mission,
		status: nextStatus,
		updated_at: nowIso(),
		final_reason: reason,
	};
	await writeJsonFile(missionPath(repoRoot, slug), nextMission);
	return nextMission;
}

export async function reconcileMissionLatestSnapshot(
	repoRoot: string,
	slug: string,
): Promise<{
	latest: MissionLatestSnapshot | null;
	driftDetected: boolean;
}> {
	const mission = await loadMission(repoRoot, slug);
	const expected = buildMissionLatestSnapshot(mission);
	const latestFile = latestPath(repoRoot, slug);
	const existing = existsSync(latestFile)
		? await readJsonFile<MissionLatestSnapshot>(latestFile)
		: null;
	const driftDetected =
		JSON.stringify(existing ?? null) !== JSON.stringify(expected ?? null);
	if (expected) {
		await writeJsonFile(latestFile, expected);
	} else if (existsSync(latestFile)) {
		await rm(latestFile, { force: true });
	}
	return {
		latest: expected,
		driftDetected,
	};
}

export async function finalizeMission(
	repoRoot: string,
	slug: string,
	status: Extract<
		MissionStatus,
		"complete" | "plateau" | "failed" | "cancelled"
	>,
	reason: string,
): Promise<MissionState> {
	const mission = await loadMission(repoRoot, slug);
	if (!canTransitionMissionStatus(mission.status, status)) {
		throw new Error(`invalid_mission_transition:${mission.status}->${status}`);
	}
	const nextMission: MissionState = {
		...mission,
		status,
		updated_at: nowIso(),
		current_stage: "idle",
		final_reason: reason,
		active_lanes: [],
	};
	await writeJsonFile(missionPath(repoRoot, slug), nextMission);
	return nextMission;
}
