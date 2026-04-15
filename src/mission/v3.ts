import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { basename, extname, join, relative } from "node:path";
import { writeAtomic } from "../team/state/io.js";
import type { MissionLaneSummary, MissionLaneType } from "./contracts.js";
import { MISSION_LANE_TYPES } from "./contracts.js";
import type { MissionSafetyBaseline, MissionState } from "./kernel.js";
import type {
	MissionNormalizedSource,
	MissionOrchestrationArtifactPaths,
	MissionOrchestrationArtifacts,
	MissionSourcePack,
} from "./orchestration.js";

export const MISSION_V3_ARTIFACT_VERSION = 1 as const;

export const MISSION_V3_LIFECYCLE_STATES = [
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
] as const;
export type MissionV3LifecycleState =
	(typeof MISSION_V3_LIFECYCLE_STATES)[number];

export const MISSION_V3_RISK_CLASSES = [
	"low-risk-local",
	"cross-cutting-refactor",
	"security-sensitive",
	"ui-critical",
	"migration-sensitive",
	"release-blocking",
] as const;
export type MissionV3RiskClass = (typeof MISSION_V3_RISK_CLASSES)[number];

export const MISSION_V3_ASSURANCE_PROFILES = [
	"balanced",
	"high",
	"max-quality",
] as const;
export type MissionV3AssuranceProfile =
	(typeof MISSION_V3_ASSURANCE_PROFILES)[number];

export const MISSION_V3_AUTONOMY_PROFILES = [
	"guarded",
	"semi-auto",
	"max-auto",
] as const;
export type MissionV3AutonomyProfile =
	(typeof MISSION_V3_AUTONOMY_PROFILES)[number];

export const MISSION_V3_SOURCE_TRUST_CLASSES = [
	"trusted",
	"semi_trusted",
	"untrusted",
	"quote_only",
	"execution_forbidden",
] as const;
export type MissionV3SourceTrustClass =
	(typeof MISSION_V3_SOURCE_TRUST_CLASSES)[number];

export const MISSION_V3_OBLIGATION_STATES = [
	"planned",
	"running",
	"satisfied",
	"contradicted",
	"waived",
	"deferred",
	"not_applicable",
	"stale",
] as const;
export type MissionV3ObligationState =
	(typeof MISSION_V3_OBLIGATION_STATES)[number];

export const MISSION_V3_POLICY_OUTCOMES = [
	"allow",
	"allow_with_attestation",
	"deny",
	"require_review",
	"require_waiver",
	"require_revalidation",
] as const;
export type MissionV3PolicyOutcome =
	(typeof MISSION_V3_POLICY_OUTCOMES)[number];

export const MISSION_V3_CANDIDATE_STATES = [
	"proposed",
	"approved",
	"running",
	"blocked",
	"stalled",
	"superseded",
	"rejected",
	"selected",
	"archived",
] as const;
export type MissionV3CandidateStateValue =
	(typeof MISSION_V3_CANDIDATE_STATES)[number];

export const MISSION_V3_PROOF_LANES = [
	"reproduction",
	"targeted-regression",
	"impacted-tests",
	"full-suite",
	"static-analysis",
	"security",
	"performance",
	"ui-vision",
	"migration",
	"release-smoke",
	"property-checks",
	"adjudication",
] as const;
export type MissionV3ProofLane = (typeof MISSION_V3_PROOF_LANES)[number];

export interface MissionV3PolicyProfile {
	risk_class: MissionV3RiskClass;
	assurance_profile: MissionV3AssuranceProfile;
	autonomy_profile: MissionV3AutonomyProfile;
}

export interface MissionV3ArtifactPaths {
	assuranceContractPath: string;
	proofProgramPath: string;
	checkerLockPath: string;
	contractAmendmentsPath: string;
	environmentContractPath: string;
	environmentAttestationsPath: string;
	runtimeObservationsPath: string;
	environmentCurrentPath: string;
	policyDecisionsPath: string;
	policySnapshotPath: string;
	qualityWatchdogPath: string;
	evidenceEventsPath: string;
	laneRunsPath: string;
	commandAttestationsPath: string;
	impactMapPath: string;
	evidenceGraphPath: string;
	promotionEventsPath: string;
	promotionDecisionPath: string;
	decisionLogPath: string;
	uncertaintyEventsPath: string;
	uncertaintyRegisterPath: string;
	compactionEventsPath: string;
	contextSnapshotsDir: string;
	currentContextSnapshotPath: string;
	statusLedgerPath: string;
	candidateTournamentPath: string;
	adjudicationPath: string;
	releaseRecordPath: string;
	handoffRecordPath: string;
	tracesDir: string;
	traceBundlePath: string;
	evalBundlePath: string;
	postmortemPath: string;
	learningProposalsDir: string;
	candidatesDir: string;
	activeCandidateDir: string;
	activeCandidateStatePath: string;
	activeCandidateEventsPath: string;
	activeCandidateExecutionPlanPath: string;
}

export interface MissionV3Obligation {
	obligation_id: string;
	class:
		| "functional"
		| "regression"
		| "invariant"
		| "security"
		| "performance"
		| "migration"
		| "operability"
		| "release";
	description: string;
	blocking_severity: "blocking" | "advisory";
	required_evidence_kinds: string[];
	waiver_allowed: boolean;
	waiver_authority: string;
	freshness_ttl_seconds: number;
	required_env_profile: string;
	required_lane: MissionV3ProofLane;
	not_applicable_reason?: string | null;
}

export interface MissionV3AssuranceContract {
	schema_version: 1;
	generated_at: string;
	assurance_contract_id: string;
	revision: number;
	mission_id: string;
	source_pack_ref: string;
	brief_ref: string;
	profile: MissionV3PolicyProfile;
	obligations: MissionV3Obligation[];
}

export interface MissionV3CheckerLockEntry {
	checker_id: string;
	checker_version: string;
	runner_class: string;
	expected_output_schema: string;
	allowed_command_templates: string[];
	required_capabilities: string[];
	required_env_profile: string;
	allowed_source_trust_inputs: MissionV3SourceTrustClass[];
}

export interface MissionV3CheckerLock {
	schema_version: 1;
	generated_at: string;
	checker_lock_id: string;
	mission_id: string;
	revision: number;
	profile: MissionV3PolicyProfile;
	checkers: MissionV3CheckerLockEntry[];
}

export interface MissionV3ProofBinding {
	binding_id: string;
	obligation_id: string;
	proof_lane: MissionV3ProofLane;
	checker_refs: string[];
	command_refs: string[];
	flake_reruns: number;
	fail_closed: boolean;
	admissible_evidence_kinds: string[];
	freshness_ttl_seconds: number;
	required_matrix_target: string;
	required_env_hash_class: string;
}

export interface MissionV3ProofProgram {
	schema_version: 1;
	generated_at: string;
	proof_program_id: string;
	assurance_contract_id: string;
	checker_lock_id: string;
	environment_contract_id: string;
	mission_id: string;
	profile: MissionV3PolicyProfile;
	mandatory_lanes: MissionV3ProofLane[];
	bindings: MissionV3ProofBinding[];
	fail_closed_rules: string[];
}

export interface MissionV3EnvironmentContract {
	schema_version: 1;
	generated_at: string;
	env_contract_id: string;
	revision: number;
	mission_id: string;
	runtime_base_id: string;
	toolchain_versions: Record<string, string>;
	lockfile_hashes: Record<string, string>;
	service_inventory: Array<{ name: string; version: string }>;
	setup_network_allowlist: string[];
	runtime_network_allowlist: string[];
	declared_secret_scopes: string[];
	matrix_targets: Array<{
		matrix_target_id: string;
		os: string;
		arch: string;
		node_version: string;
	}>;
	declared_environment_hash: string;
}

export interface MissionV3EnvironmentCurrent {
	schema_version: 1;
	generated_at: string;
	mission_id: string;
	env_contract_id: string;
	current_attestation_ref: string | null;
	declared_hash: string;
	achieved_hash: string | null;
	parity: "valid" | "stale" | "broken";
	blocker_reason: string | null;
	observation_refs: string[];
	matrix_targets: string[];
}

export interface MissionV3CandidateState {
	schema_version: 1;
	generated_at: string;
	candidate_id: string;
	mission_id: string;
	state: MissionV3CandidateStateValue;
	rationale: string;
	workspace_root: string;
	proof_program_ref: string;
	environment_contract_ref: string;
	execution_plan_ref: string;
	parent_candidate_ids: string[];
	latest_lane_run_refs: string[];
	latest_evidence_refs: string[];
	superseded_by: string | null;
	selected_at: string | null;
	updated_at: string;
}

export interface MissionV3Adjudication {
	schema_version: 1;
	generated_at: string;
	mission_id: string;
	candidate_id: string | null;
	obligation_status_table: Array<{
		obligation_id: string;
		state: MissionV3ObligationState;
		blocking: boolean;
		reason: string;
		evidence_refs: string[];
	}>;
	blocking_contradictions: string[];
	waiver_summary: string[];
	stale_evidence_summary: string[];
	residual_risk_summary: string[];
	recommended_next_state: MissionV3LifecycleState;
	proof_ready: boolean;
}

export interface MissionV3PromotionDecision {
	schema_version: 1;
	generated_at: string;
	mission_id: string;
	candidate_id: string | null;
	decision: "allow" | "block";
	reasons: string[];
	lifecycle_state: MissionV3LifecycleState;
	required_artifacts: string[];
	policy_blockers: string[];
}

export interface MissionV3SyncResult {
	mission: MissionState;
	paths: MissionV3ArtifactPaths;
	adjudication: MissionV3Adjudication;
	promotionDecision: MissionV3PromotionDecision;
}

export interface MissionV3CreateCandidateOptions {
	repoRoot: string;
	slug: string;
	rationale: string;
	trigger:
		| "ambiguity"
		| "plateau"
		| "high_value"
		| "architecture_fork"
		| "hybrid";
	parentCandidateIds?: string[];
	requestedCapabilities?: string[];
}

export interface MissionV3SelectionOptions {
	repoRoot: string;
	slug: string;
	candidateId: string;
	reason: string;
}

export interface MissionV3ReleaseOptions {
	repoRoot: string;
	slug: string;
	action: "released" | "handed_off";
	actor: string;
	summary: string;
	destination?: string;
}

interface MissionV3JournalEvent<T = Record<string, unknown>> {
	event_id: string;
	schema_version: 1;
	journal_type: string;
	sequence: number;
	recorded_at: string;
	mission_id: string;
	candidate_id?: string;
	lane_id?: string;
	actor_principal: string;
	causation_ref: string | null;
	correlation_ref: string | null;
	idempotency_key: string;
	prev_event_hash: string | null;
	payload_hash: string;
	recovery_generated?: boolean;
	payload: T;
}

function nowIso(): string {
	return new Date().toISOString();
}

function hashValue(input: string): string {
	return createHash("sha256").update(input).digest("hex");
}

function shortHash(input: string): string {
	return hashValue(input).slice(0, 16);
}

function stableJson(value: unknown): string {
	return JSON.stringify(value);
}

function missionStatePath(missionRoot: string): string {
	return join(missionRoot, "mission.json");
}

async function readJson<T>(filePath: string): Promise<T> {
	return JSON.parse(await readFile(filePath, "utf-8")) as T;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
	await writeAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(filePath: string, value: string): Promise<void> {
	await writeAtomic(filePath, value.endsWith("\n") ? value : `${value}\n`);
}

async function ensureTextFile(filePath: string): Promise<void> {
	if (!existsSync(filePath)) {
		await writeText(filePath, "");
	}
}

function addSeconds(timestamp: string, seconds: number): string {
	const value = new Date(timestamp).getTime();
	return new Date(value + seconds * 1000).toISOString();
}

async function hashFile(filePath: string): Promise<string | null> {
	if (!existsSync(filePath)) return null;
	return `sha256:${hashValue(await readFile(filePath, "utf-8"))}`;
}

function eventHash(event: MissionV3JournalEvent): string {
	return `sha256:${hashValue(stableJson(event))}`;
}

function parseJournal<T>(content: string): {
	events: MissionV3JournalEvent<T>[];
	truncatedTail: boolean;
} {
	const lines = content
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	const events: MissionV3JournalEvent<T>[] = [];
	for (const [index, line] of lines.entries()) {
		try {
			events.push(JSON.parse(line) as MissionV3JournalEvent<T>);
		} catch (error) {
			if (index === lines.length - 1) {
				return { events, truncatedTail: true };
			}
			throw error;
		}
	}
	return { events, truncatedTail: false };
}

function serializeJournal<T>(events: MissionV3JournalEvent<T>[]): string {
	return (
		events.map((event) => JSON.stringify(event)).join("\n") +
		(events.length > 0 ? "\n" : "")
	);
}

async function loadJournal<T>(
	filePath: string,
): Promise<MissionV3JournalEvent<T>[]> {
	if (!existsSync(filePath)) return [];
	return parseJournal<T>(await readFile(filePath, "utf-8")).events;
}

async function appendJournalEvent<T extends Record<string, unknown>>(
	filePath: string,
	input: {
		journalType: string;
		missionId: string;
		candidateId?: string | null;
		laneId?: string | null;
		actorPrincipal: string;
		causationRef?: string | null;
		correlationRef?: string | null;
		idempotencyKey: string;
		payload: T;
		recordedAt?: string;
		recoveryGenerated?: boolean;
	},
): Promise<MissionV3JournalEvent<T>> {
	if (existsSync(filePath)) {
		const parsed = parseJournal<T>(await readFile(filePath, "utf-8"));
		const duplicate = parsed.events.find(
			(event) => event.idempotency_key === input.idempotencyKey,
		);
		if (duplicate) return duplicate;
		if (parsed.truncatedTail) {
			await writeText(filePath, serializeJournal(parsed.events));
		}
	}
	const existing = await loadJournal<T>(filePath);
	const previous = existing.at(-1);
	const recordedAt = input.recordedAt ?? nowIso();
	const payloadHash = `sha256:${hashValue(stableJson(input.payload))}`;
	const next: MissionV3JournalEvent<T> = {
		event_id: `${input.journalType}:${shortHash(`${input.missionId}:${input.idempotencyKey}:${existing.length + 1}`)}`,
		schema_version: 1,
		journal_type: input.journalType,
		sequence: (previous?.sequence ?? 0) + 1,
		recorded_at: recordedAt,
		mission_id: input.missionId,
		candidate_id: input.candidateId ?? undefined,
		lane_id: input.laneId ?? undefined,
		actor_principal: input.actorPrincipal,
		causation_ref: input.causationRef ?? null,
		correlation_ref: input.correlationRef ?? null,
		idempotency_key: input.idempotencyKey,
		prev_event_hash: previous
			? eventHash(previous as MissionV3JournalEvent)
			: null,
		payload_hash: payloadHash,
		recovery_generated: input.recoveryGenerated,
		payload: input.payload,
	};
	await appendFile(filePath, `${JSON.stringify(next)}\n`, "utf-8");
	return next;
}

async function collectRepoTestFiles(root: string): Promise<string[]> {
	const results: string[] = [];
	const queue = [root];
	while (queue.length > 0) {
		const current = queue.pop()!;
		const entries = await readdir(current, { withFileTypes: true });
		for (const entry of entries) {
			if (
				entry.name === ".git" ||
				entry.name === "node_modules" ||
				entry.name === "dist"
			) {
				continue;
			}
			const fullPath = join(current, entry.name);
			if (entry.isDirectory()) {
				queue.push(fullPath);
				continue;
			}
			if (/\.test\.[cm]?[jt]sx?$/i.test(entry.name)) {
				results.push(fullPath);
			}
		}
	}
	return results.sort();
}

function normalizeSourceTrust(
	source: MissionNormalizedSource,
): MissionV3SourceTrustClass {
	if (source.retrieval_status !== "captured") return "quote_only";
	if (source.origin === "prompt") return "trusted";
	if (source.origin === "internal" && source.trust_level === "high") {
		return "trusted";
	}
	if (source.origin === "internal" || source.trust_level === "medium") {
		return "semi_trusted";
	}
	if (source.origin === "external" && source.trust_level === "low") {
		return "execution_forbidden";
	}
	return "untrusted";
}

function deriveProfiles(
	sourcePack: MissionSourcePack,
	highRisk: boolean,
): MissionV3PolicyProfile {
	const touchpoints = sourcePack.project_touchpoints;
	const lowerTouchpoints = touchpoints.map((value) => value.toLowerCase());
	let riskClass: MissionV3RiskClass = "low-risk-local";
	if (highRisk) {
		riskClass = "release-blocking";
	} else if (
		lowerTouchpoints.some((value) => /migrat|schema|sql|db/.test(value))
	) {
		riskClass = "migration-sensitive";
	} else if (
		lowerTouchpoints.some((value) => /auth|security|secret/.test(value))
	) {
		riskClass = "security-sensitive";
	} else if (
		lowerTouchpoints.some((value) =>
			/ui|view|page|component|styles?/.test(value),
		)
	) {
		riskClass = "ui-critical";
	} else if (
		touchpoints.length >= 4 ||
		sourcePack.sources.length >= 3 ||
		sourcePack.ambiguity !== "low"
	) {
		riskClass = "cross-cutting-refactor";
	}

	const assuranceProfile: MissionV3AssuranceProfile =
		highRisk ||
		riskClass === "release-blocking" ||
		riskClass === "security-sensitive"
			? "max-quality"
			: riskClass === "low-risk-local"
				? "balanced"
				: "high";

	const autonomyProfile: MissionV3AutonomyProfile =
		sourcePack.ambiguity === "high"
			? "guarded"
			: assuranceProfile === "max-quality"
				? "semi-auto"
				: riskClass === "low-risk-local"
					? "max-auto"
					: "semi-auto";

	return {
		risk_class: riskClass,
		assurance_profile: assuranceProfile,
		autonomy_profile: autonomyProfile,
	};
}

function requiredProofLanes(
	profile: MissionV3PolicyProfile,
): MissionV3ProofLane[] {
	const lanes: MissionV3ProofLane[] = [
		"reproduction",
		"targeted-regression",
		"static-analysis",
		"adjudication",
	];
	if (profile.risk_class === "cross-cutting-refactor")
		lanes.push("impacted-tests");
	if (profile.risk_class === "security-sensitive") lanes.push("security");
	if (profile.risk_class === "ui-critical") lanes.push("ui-vision");
	if (profile.risk_class === "migration-sensitive") lanes.push("migration");
	if (profile.risk_class === "release-blocking") lanes.push("release-smoke");
	if (profile.assurance_profile === "max-quality")
		lanes.push("property-checks");
	return Array.from(new Set(lanes));
}

function buildAssuranceContract(
	mission: MissionState,
	artifacts: MissionOrchestrationArtifacts,
	profile: MissionV3PolicyProfile,
	v3Paths: MissionV3ArtifactPaths,
): MissionV3AssuranceContract {
	const obligations: MissionV3Obligation[] = requiredProofLanes(profile).map(
		(lane) => {
			const base = {
				freshness_ttl_seconds:
					lane === "release-smoke" ? 600 : lane === "adjudication" ? 300 : 900,
				required_env_profile: "mission-default",
				waiver_allowed: lane !== "adjudication",
				waiver_authority:
					profile.autonomy_profile === "max-auto"
						? "mission-auto-policy"
						: "operator-review",
				blocking_severity: "blocking" as const,
			};
			const obligationId = `obl:${lane}`;
			switch (lane) {
				case "reproduction":
					return {
						obligation_id: obligationId,
						class: "functional",
						description:
							"Fresh reproduction evidence must be captured from the verifier lane.",
						required_evidence_kinds: [
							"lane_summary",
							"lane_run",
							"environment_attestation",
						],
						required_lane: lane,
						...base,
					};
				case "targeted-regression":
					return {
						obligation_id: obligationId,
						class: "regression",
						description:
							"Fresh targeted regression evidence must confirm the selected candidate under the latest verifier pass.",
						required_evidence_kinds: [
							"lane_summary",
							"focused_checks",
							"lane_run",
						],
						required_lane: lane,
						...base,
					};
				case "static-analysis":
					return {
						obligation_id: obligationId,
						class: "invariant",
						description:
							"Static-analysis or focused checks must pass under the attested environment.",
						required_evidence_kinds: ["focused_checks", "command_attestation"],
						required_lane: lane,
						...base,
					};
				case "impacted-tests":
					return {
						obligation_id: obligationId,
						class: "regression",
						description:
							"Impact-mapped tests must cover touched surfaces for cross-cutting changes.",
						required_evidence_kinds: ["impact_map", "lane_run"],
						required_lane: lane,
						...base,
					};
				case "security":
					return {
						obligation_id: obligationId,
						class: "security",
						description:
							"Security-sensitive missions require explicit security evidence and no unresolved policy denials.",
						required_evidence_kinds: ["policy_decision", "lane_run"],
						required_lane: lane,
						...base,
					};
				case "ui-vision":
					return {
						obligation_id: obligationId,
						class: "functional",
						description:
							"UI-critical missions require visual or UI validation coverage.",
						required_evidence_kinds: ["impact_map", "lane_run"],
						required_lane: lane,
						...base,
					};
				case "migration":
					return {
						obligation_id: obligationId,
						class: "migration",
						description:
							"Migration-sensitive missions require explicit migration safety evidence.",
						required_evidence_kinds: ["lane_run", "environment_attestation"],
						required_lane: lane,
						...base,
					};
				case "release-smoke":
					return {
						obligation_id: obligationId,
						class: "release",
						description:
							"Release-blocking missions require release-smoke coverage before promotion.",
						required_evidence_kinds: ["lane_run", "promotion_decision"],
						required_lane: lane,
						...base,
					};
				case "property-checks":
					return {
						obligation_id: obligationId,
						class: "invariant",
						description:
							"Max-quality missions require explicit property or invariant coverage when available.",
						required_evidence_kinds: ["lane_run", "evidence_graph"],
						required_lane: lane,
						...base,
					};
				case "adjudication":
					return {
						obligation_id: obligationId,
						class: "operability",
						description:
							"Structured adjudication must confirm that blocking proof obligations are satisfied and fresh.",
						required_evidence_kinds: ["adjudication", "evidence_graph"],
						required_lane: lane,
						waiver_allowed: false,
						waiver_authority: "none",
						blocking_severity: "blocking",
						freshness_ttl_seconds: 300,
						required_env_profile: "mission-default",
					};
				default:
					return {
						obligation_id: obligationId,
						class: "operability",
						description: `Coverage for ${lane}`,
						required_evidence_kinds: ["lane_run"],
						required_lane: lane,
						...base,
					};
			}
		},
	);
	const assuranceContractId = `assurance:${shortHash(
		stableJson({
			mission_id: mission.mission_id,
			profile,
			obligations,
			brief: artifacts.brief.brief_id,
		}),
	)}`;
	return {
		schema_version: 1,
		generated_at: nowIso(),
		assurance_contract_id: assuranceContractId,
		revision: 1,
		mission_id: mission.mission_id,
		source_pack_ref: "source-pack.json",
		brief_ref: artifacts.brief.brief_id,
		profile,
		obligations,
	};
}

function buildCheckerLock(
	mission: MissionState,
	profile: MissionV3PolicyProfile,
	proofLanes: MissionV3ProofLane[],
): MissionV3CheckerLock {
	const sourceTrustInputs: MissionV3SourceTrustClass[] = [
		"trusted",
		"semi_trusted",
	];
	const laneCheckers: Record<MissionV3ProofLane, MissionV3CheckerLockEntry[]> =
		{
			reproduction: [
				{
					checker_id: "checker:mission-reproduction",
					checker_version: "1",
					runner_class: "verifier-lane-summary",
					expected_output_schema: "mission-lane-summary/v1",
					allowed_command_templates: ["lane-summary:audit"],
					required_capabilities: ["fresh-session", "read-only"],
					required_env_profile: "mission-default",
					allowed_source_trust_inputs: sourceTrustInputs,
				},
			],
			"targeted-regression": [
				{
					checker_id: "checker:mission-targeted-regression",
					checker_version: "1",
					runner_class: "verifier-lane-summary",
					expected_output_schema: "mission-lane-summary/v1",
					allowed_command_templates: ["lane-summary:re_audit"],
					required_capabilities: ["fresh-session", "read-only"],
					required_env_profile: "mission-default",
					allowed_source_trust_inputs: sourceTrustInputs,
				},
			],
			"impacted-tests": [
				{
					checker_id: "checker:mission-impacted-tests",
					checker_version: "1",
					runner_class: "impact-analysis",
					expected_output_schema: "impact-map/v1",
					allowed_command_templates: ["impact-map:derive"],
					required_capabilities: ["repo-read"],
					required_env_profile: "mission-default",
					allowed_source_trust_inputs: sourceTrustInputs,
				},
			],
			"full-suite": [],
			"static-analysis": [
				{
					checker_id: "checker:mission-static-analysis",
					checker_version: "1",
					runner_class: "command-attestation",
					expected_output_schema: "mission-command-attestation/v1",
					allowed_command_templates: ["focused-checks:green"],
					required_capabilities: ["repo-checks"],
					required_env_profile: "mission-default",
					allowed_source_trust_inputs: ["trusted"],
				},
			],
			security: [
				{
					checker_id: "checker:mission-security-policy",
					checker_version: "1",
					runner_class: "policy-evaluator",
					expected_output_schema: "policy-snapshot/v1",
					allowed_command_templates: ["policy:security"],
					required_capabilities: ["policy-read"],
					required_env_profile: "mission-default",
					allowed_source_trust_inputs: sourceTrustInputs,
				},
			],
			performance: [],
			"ui-vision": [
				{
					checker_id: "checker:mission-ui-vision",
					checker_version: "1",
					runner_class: "impact-analysis",
					expected_output_schema: "impact-map/v1",
					allowed_command_templates: ["impact-map:ui"],
					required_capabilities: ["repo-read"],
					required_env_profile: "mission-default",
					allowed_source_trust_inputs: sourceTrustInputs,
				},
			],
			migration: [
				{
					checker_id: "checker:mission-migration",
					checker_version: "1",
					runner_class: "environment-attestation",
					expected_output_schema: "environment-current/v1",
					allowed_command_templates: ["environment:migration"],
					required_capabilities: ["env-read"],
					required_env_profile: "mission-default",
					allowed_source_trust_inputs: sourceTrustInputs,
				},
			],
			"release-smoke": [
				{
					checker_id: "checker:mission-release-smoke",
					checker_version: "1",
					runner_class: "promotion-gate",
					expected_output_schema: "promotion-decision/v1",
					allowed_command_templates: ["promotion:release-smoke"],
					required_capabilities: ["promotion-read"],
					required_env_profile: "mission-default",
					allowed_source_trust_inputs: sourceTrustInputs,
				},
			],
			"property-checks": [
				{
					checker_id: "checker:mission-property-checks",
					checker_version: "1",
					runner_class: "derived-assurance",
					expected_output_schema: "evidence-graph/v1",
					allowed_command_templates: ["evidence:property-checks"],
					required_capabilities: ["repo-read"],
					required_env_profile: "mission-default",
					allowed_source_trust_inputs: sourceTrustInputs,
				},
			],
			adjudication: [
				{
					checker_id: "checker:mission-adjudicator",
					checker_version: "1",
					runner_class: "derived-adjudicator",
					expected_output_schema: "mission-adjudication/v1",
					allowed_command_templates: ["adjudication:derive"],
					required_capabilities: ["structured-output", "read-only"],
					required_env_profile: "mission-default",
					allowed_source_trust_inputs: sourceTrustInputs,
				},
			],
		};
	const checkers = proofLanes.flatMap((lane) => laneCheckers[lane]);
	return {
		schema_version: 1,
		generated_at: nowIso(),
		checker_lock_id: `checker-lock:${shortHash(stableJson({ mission: mission.mission_id, profile, checkers }))}`,
		mission_id: mission.mission_id,
		revision: 1,
		profile,
		checkers,
	};
}

async function buildEnvironmentContract(
	mission: MissionState,
	profile: MissionV3PolicyProfile,
): Promise<MissionV3EnvironmentContract> {
	const lockfileNames = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"];
	const lockfile_hashes = Object.fromEntries(
		(
			await Promise.all(
				lockfileNames.map(
					async (name) =>
						[name, await hashFile(join(mission.repo_root, name))] as const,
				),
			)
		).filter((entry): entry is readonly [string, string] => Boolean(entry[1])),
	);
	const toolchain_versions: Record<string, string> = {
		node: process.versions.node,
		platform: platform(),
		arch: arch(),
		release: release(),
	};
	const runtime_base_id = `local:${platform()}:${release()}:${arch()}`;
	const setup_network_allowlist =
		profile.autonomy_profile === "guarded"
			? ["registry.npmjs.org", "github.com"]
			: ["registry.npmjs.org"];
	const runtime_network_allowlist =
		profile.autonomy_profile === "max-auto" ? ["repo-local"] : [];
	const declared_secret_scopes = [
		"setup:toolchain",
		"runtime:mission",
		"verifier:read-only",
	];
	const matrix_targets = [
		{
			matrix_target_id: "matrix:local-node",
			os: platform(),
			arch: arch(),
			node_version: process.versions.node,
		},
	];
	const envSeed = {
		runtime_base_id,
		toolchain_versions,
		lockfile_hashes,
		service_inventory: [],
		setup_network_allowlist,
		runtime_network_allowlist,
		declared_secret_scopes,
		matrix_targets,
	};
	return {
		schema_version: 1,
		generated_at: nowIso(),
		env_contract_id: `env:${shortHash(stableJson({ mission: mission.mission_id, envSeed }))}`,
		revision: 1,
		mission_id: mission.mission_id,
		runtime_base_id,
		toolchain_versions,
		lockfile_hashes,
		service_inventory: [],
		setup_network_allowlist,
		runtime_network_allowlist,
		declared_secret_scopes,
		matrix_targets,
		declared_environment_hash: `sha256:${hashValue(stableJson(envSeed))}`,
	};
}

function buildProofProgram(
	mission: MissionState,
	assuranceContract: MissionV3AssuranceContract,
	checkerLock: MissionV3CheckerLock,
	environmentContract: MissionV3EnvironmentContract,
): MissionV3ProofProgram {
	const checkerByLane = new Map<MissionV3ProofLane, string[]>(
		requiredProofLanes(assuranceContract.profile).map((lane) => [
			lane,
			checkerLock.checkers
				.filter((checker) =>
					checker.allowed_command_templates.some(
						(template) =>
							template.includes(lane) ||
							(template.includes("adjudication") && lane === "adjudication"),
					),
				)
				.map((checker) => checker.checker_id),
		]),
	);
	const bindings = assuranceContract.obligations.map((obligation) => ({
		binding_id: `binding:${shortHash(`${obligation.obligation_id}:${environmentContract.declared_environment_hash}`)}`,
		obligation_id: obligation.obligation_id,
		proof_lane: obligation.required_lane,
		checker_refs: checkerByLane.get(obligation.required_lane) ?? [],
		command_refs: [`command:${obligation.required_lane}`],
		flake_reruns: obligation.required_lane === "targeted-regression" ? 1 : 0,
		fail_closed: obligation.blocking_severity === "blocking",
		admissible_evidence_kinds: obligation.required_evidence_kinds,
		freshness_ttl_seconds: obligation.freshness_ttl_seconds,
		required_matrix_target:
			environmentContract.matrix_targets[0]?.matrix_target_id ??
			"matrix:local-node",
		required_env_hash_class: environmentContract.declared_environment_hash,
	}));
	return {
		schema_version: 1,
		generated_at: nowIso(),
		proof_program_id: `proof:${shortHash(stableJson({ mission: mission.mission_id, bindings }))}`,
		assurance_contract_id: assuranceContract.assurance_contract_id,
		checker_lock_id: checkerLock.checker_lock_id,
		environment_contract_id: environmentContract.env_contract_id,
		mission_id: mission.mission_id,
		profile: assuranceContract.profile,
		mandatory_lanes: Array.from(
			new Set(
				assuranceContract.obligations.map(
					(obligation) => obligation.required_lane,
				),
			),
		),
		bindings,
		fail_closed_rules: [
			"blocking obligations fail closed when evidence is stale or contradicted",
			"environment parity must remain valid for counted proofs",
			"promotion remains blocked while any kernel-consumable blocker is active",
		],
	};
}

function missionV3CandidateId(): string {
	return "candidate-001";
}

export function missionV3ArtifactPaths(
	missionRoot: string,
	candidateId = missionV3CandidateId(),
): MissionV3ArtifactPaths {
	const candidatesDir = join(missionRoot, "candidates");
	const activeCandidateDir = join(candidatesDir, candidateId);
	const tracesDir = join(missionRoot, "traces");
	const learningProposalsDir = join(tracesDir, "learning-proposals");
	return {
		assuranceContractPath: join(missionRoot, "assurance-contract.json"),
		proofProgramPath: join(missionRoot, "proof-program.json"),
		checkerLockPath: join(missionRoot, "checker-lock.json"),
		contractAmendmentsPath: join(missionRoot, "contract-amendments.ndjson"),
		environmentContractPath: join(missionRoot, "environment-contract.json"),
		environmentAttestationsPath: join(
			missionRoot,
			"environment-attestations.ndjson",
		),
		runtimeObservationsPath: join(missionRoot, "runtime-observations.ndjson"),
		environmentCurrentPath: join(missionRoot, "environment-current.json"),
		policyDecisionsPath: join(missionRoot, "policy-decisions.ndjson"),
		policySnapshotPath: join(missionRoot, "policy-snapshot.json"),
		qualityWatchdogPath: join(missionRoot, "quality-watchdog.json"),
		evidenceEventsPath: join(missionRoot, "evidence-events.ndjson"),
		laneRunsPath: join(missionRoot, "lane-runs.ndjson"),
		commandAttestationsPath: join(missionRoot, "command-attestations.ndjson"),
		impactMapPath: join(missionRoot, "impact-map.json"),
		evidenceGraphPath: join(missionRoot, "evidence-graph.json"),
		promotionEventsPath: join(missionRoot, "promotion-events.ndjson"),
		promotionDecisionPath: join(missionRoot, "promotion-decision.json"),
		decisionLogPath: join(missionRoot, "decision-log.ndjson"),
		uncertaintyEventsPath: join(missionRoot, "uncertainty-events.ndjson"),
		uncertaintyRegisterPath: join(missionRoot, "uncertainty-register.json"),
		compactionEventsPath: join(missionRoot, "compaction-events.ndjson"),
		contextSnapshotsDir: join(missionRoot, "context-snapshots"),
		currentContextSnapshotPath: join(
			missionRoot,
			"context-snapshots",
			"current.json",
		),
		statusLedgerPath: join(missionRoot, "status-ledger.md"),
		candidateTournamentPath: join(missionRoot, "candidate-tournament.json"),
		adjudicationPath: join(missionRoot, "adjudication.json"),
		releaseRecordPath: join(missionRoot, "release-record.json"),
		handoffRecordPath: join(missionRoot, "handoff-record.json"),
		tracesDir,
		traceBundlePath: join(tracesDir, "trace-bundle.json"),
		evalBundlePath: join(tracesDir, "eval-bundle.json"),
		postmortemPath: join(tracesDir, "postmortem.md"),
		learningProposalsDir,
		candidatesDir,
		activeCandidateDir,
		activeCandidateStatePath: join(activeCandidateDir, "candidate-state.json"),
		activeCandidateEventsPath: join(
			activeCandidateDir,
			"candidate-events.ndjson",
		),
		activeCandidateExecutionPlanPath: join(
			activeCandidateDir,
			"execution-plan.md",
		),
	};
}

async function ensureV3Layout(paths: MissionV3ArtifactPaths): Promise<void> {
	await mkdir(paths.candidatesDir, { recursive: true });
	await mkdir(paths.activeCandidateDir, { recursive: true });
	await mkdir(paths.contextSnapshotsDir, { recursive: true });
	await mkdir(paths.tracesDir, { recursive: true });
	await mkdir(paths.learningProposalsDir, { recursive: true });
	for (const filePath of [
		paths.contractAmendmentsPath,
		paths.environmentAttestationsPath,
		paths.runtimeObservationsPath,
		paths.policyDecisionsPath,
		paths.evidenceEventsPath,
		paths.laneRunsPath,
		paths.commandAttestationsPath,
		paths.promotionEventsPath,
		paths.decisionLogPath,
		paths.uncertaintyEventsPath,
		paths.compactionEventsPath,
		paths.activeCandidateEventsPath,
	]) {
		await ensureTextFile(filePath);
	}
}

async function ensureCandidateState(
	mission: MissionState,
	artifactPaths: MissionOrchestrationArtifactPaths,
	paths: MissionV3ArtifactPaths,
	proofProgram: MissionV3ProofProgram,
	environmentContract: MissionV3EnvironmentContract,
): Promise<MissionV3CandidateState> {
	if (existsSync(paths.activeCandidateStatePath)) {
		return readJson<MissionV3CandidateState>(paths.activeCandidateStatePath);
	}
	const generatedAt = nowIso();
	await mkdir(join(paths.activeCandidateDir, "iterations"), {
		recursive: true,
	});
	await mkdir(join(paths.activeCandidateDir, "assurance", "lane-results"), {
		recursive: true,
	});
	await mkdir(join(paths.activeCandidateDir, "assurance", "evidence"), {
		recursive: true,
	});
	const candidate: MissionV3CandidateState = {
		schema_version: 1,
		generated_at: generatedAt,
		candidate_id: missionV3CandidateId(),
		mission_id: mission.mission_id,
		state: "running",
		rationale: "default single-candidate Mission V3 umbrella execution path",
		workspace_root: mission.mission_root,
		proof_program_ref: relative(
			paths.activeCandidateDir,
			paths.proofProgramPath,
		),
		environment_contract_ref: relative(
			paths.activeCandidateDir,
			paths.environmentContractPath,
		),
		execution_plan_ref: relative(
			paths.activeCandidateDir,
			artifactPaths.executionPlanPath,
		),
		parent_candidate_ids: [],
		latest_lane_run_refs: [],
		latest_evidence_refs: [],
		superseded_by: null,
		selected_at: generatedAt,
		updated_at: generatedAt,
	};
	await writeJson(paths.activeCandidateStatePath, candidate);
	await writeText(
		paths.activeCandidateExecutionPlanPath,
		[
			"# Mission V3 Candidate Execution Plan",
			"",
			`- Candidate ID: \`${candidate.candidate_id}\``,
			`- Mission ID: \`${candidate.mission_id}\``,
			`- Parent plan: \`${relative(paths.activeCandidateDir, artifactPaths.executionPlanPath)}\``,
			`- Proof program: \`${relative(paths.activeCandidateDir, paths.proofProgramPath)}\``,
			`- Environment contract: \`${relative(paths.activeCandidateDir, paths.environmentContractPath)}\``,
			"",
			"This candidate inherits the umbrella Mission V2 execution order while Mission V3 adds assurance, policy, and evidence obligations around it.",
		].join("\n"),
	);
	await appendJournalEvent(paths.activeCandidateEventsPath, {
		journalType: "candidate-events",
		missionId: mission.mission_id,
		candidateId: candidate.candidate_id,
		actorPrincipal: "mission-v3-bootstrap",
		idempotencyKey: `candidate-bootstrap:${candidate.candidate_id}`,
		payload: {
			candidate_id: candidate.candidate_id,
			state: candidate.state,
			proof_program_id: proofProgram.proof_program_id,
			environment_contract_id: environmentContract.env_contract_id,
			rationale: candidate.rationale,
		},
	});
	return candidate;
}

async function loadMissionV3CandidateStates(
	paths: MissionV3ArtifactPaths,
): Promise<MissionV3CandidateState[]> {
	if (!existsSync(paths.candidatesDir)) return [];
	const entries = await readdir(paths.candidatesDir, { withFileTypes: true });
	const candidates: MissionV3CandidateState[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const statePath = join(
			paths.candidatesDir,
			entry.name,
			"candidate-state.json",
		);
		if (!existsSync(statePath)) continue;
		candidates.push(await readJson<MissionV3CandidateState>(statePath));
	}
	return candidates.sort((left, right) =>
		left.candidate_id.localeCompare(right.candidate_id),
	);
}

function nextMissionV3CandidateId(
	candidates: MissionV3CandidateState[],
): string {
	const max = candidates.reduce((best, candidate) => {
		const match = /candidate-(\d+)/.exec(candidate.candidate_id);
		return Math.max(best, match ? Number.parseInt(match[1] ?? "0", 10) : 0);
	}, 0);
	return `candidate-${String(max + 1).padStart(3, "0")}`;
}

function missionV3CandidateCap(profile: MissionV3PolicyProfile): number {
	return profile.assurance_profile === "max-quality" ? 3 : 2;
}

function candidateSpawnTriggerAllowed(
	trigger: MissionV3CreateCandidateOptions["trigger"],
): boolean {
	return [
		"ambiguity",
		"plateau",
		"high_value",
		"architecture_fork",
		"hybrid",
	].includes(trigger);
}

function staleCandidateStates(): MissionV3CandidateStateValue[] {
	return ["superseded", "rejected", "archived"];
}

function candidateCanReceiveActiveWrites(
	candidate: MissionV3CandidateState,
): boolean {
	return (
		!staleCandidateStates().includes(candidate.state) &&
		candidate.state !== "blocked"
	);
}

function resolveSelectedCandidateId(
	mission: MissionState,
	candidates: MissionV3CandidateState[],
	fallbackCandidateId: string,
): string | null {
	const existingSelected = mission.selected_candidate_id
		? candidates.find(
				(candidate) =>
					candidate.candidate_id === mission.selected_candidate_id &&
					candidate.state !== "blocked" &&
					!staleCandidateStates().includes(candidate.state),
			)
		: null;
	if (existingSelected) return existingSelected.candidate_id;
	if (mission.selected_candidate_id === null && candidates.length === 1) {
		return fallbackCandidateId;
	}
	return null;
}

function resolveActiveCandidateId(
	mission: MissionState,
	candidates: MissionV3CandidateState[],
	selectedCandidateId: string | null,
	fallbackCandidateId: string,
): string | null {
	const existingActive = mission.active_candidate_id
		? candidates.find(
				(candidate) =>
					candidate.candidate_id === mission.active_candidate_id &&
					candidateCanReceiveActiveWrites(candidate),
			)
		: null;
	if (existingActive) return existingActive.candidate_id;
	if (selectedCandidateId) return selectedCandidateId;
	const firstWritable =
		candidates.find(candidateCanReceiveActiveWrites)?.candidate_id ?? null;
	return firstWritable ?? fallbackCandidateId;
}

export async function assertMissionV3CandidateWritable(
	repoRoot: string,
	slug: string,
	candidateId: string,
): Promise<MissionV3CandidateState> {
	const { candidates } = await loadMissionV3Prerequisites(repoRoot, slug);
	const candidate = candidates.find(
		(entry) => entry.candidate_id === candidateId,
	);
	if (!candidate) {
		throw new Error(`mission_v3_candidate_missing:${candidateId}`);
	}
	if (staleCandidateStates().includes(candidate.state)) {
		throw new Error(`mission_v3_candidate_stale:${candidate.state}`);
	}
	return candidate;
}

async function buildPolicySnapshot(
	mission: MissionState,
	sourcePack: MissionSourcePack,
	profile: MissionV3PolicyProfile,
	environmentCurrent: MissionV3EnvironmentCurrent,
): Promise<{
	snapshot: {
		schema_version: 1;
		generated_at: string;
		mission_id: string;
		profile: MissionV3PolicyProfile;
		source_trust_summary: Record<MissionV3SourceTrustClass, number>;
		guardrails: Record<string, string[]>;
		clauses: Array<{
			clause_id: string;
			category: string;
			outcome: MissionV3PolicyOutcome;
			rationale: string;
		}>;
	};
	blockers: string[];
}> {
	const trustSummary = Object.fromEntries(
		MISSION_V3_SOURCE_TRUST_CLASSES.map((key) => [key, 0]),
	) as Record<MissionV3SourceTrustClass, number>;
	for (const source of sourcePack.sources) {
		trustSummary[normalizeSourceTrust(source)] += 1;
	}
	const clauses: Array<{
		clause_id: string;
		category: string;
		outcome: MissionV3PolicyOutcome;
		rationale: string;
	}> = [
		{
			clause_id: "policy:setup-network",
			category: "network",
			outcome: "allow_with_attestation",
			rationale:
				"Setup is allowed only through the attested environment contract allowlist.",
		},
		{
			clause_id: "policy:runtime-network",
			category: "network",
			outcome:
				profile.autonomy_profile === "max-auto"
					? "allow_with_attestation"
					: "allow",
			rationale:
				"Runtime network usage must match the resolved runtime allowlist.",
		},
		{
			clause_id: "policy:path-protection",
			category: "write-scope",
			outcome: "allow_with_attestation",
			rationale: "Writes must remain inside repo-approved mission workspaces.",
		},
		{
			clause_id: "policy:source-trust",
			category: "source-trust",
			outcome:
				trustSummary.execution_forbidden > 0
					? "require_review"
					: "allow_with_attestation",
			rationale:
				"External or low-trust material may not silently mutate contracts, commands, or policy.",
		},
		{
			clause_id: "policy:third-party-incorporation",
			category: "third-party",
			outcome:
				trustSummary.execution_forbidden > 0 || trustSummary.untrusted > 0
					? "require_review"
					: "allow",
			rationale:
				"Third-party content requires explicit review or provenance-safe incorporation.",
		},
		{
			clause_id: "policy:promotion-governor",
			category: "promotion",
			outcome:
				environmentCurrent.parity === "valid"
					? "allow_with_attestation"
					: "require_revalidation",
			rationale:
				"Promotion requires valid environment parity and fresh adjudication.",
		},
	];
	const blockers = clauses
		.filter((clause) =>
			[
				"deny",
				"require_review",
				"require_waiver",
				"require_revalidation",
			].includes(clause.outcome),
		)
		.map((clause) => `${clause.clause_id}:${clause.outcome}`);
	return {
		snapshot: {
			schema_version: 1,
			generated_at: nowIso(),
			mission_id: mission.mission_id,
			profile,
			source_trust_summary: trustSummary,
			guardrails: {
				command_rules: [
					"prefer checker IDs and locked command refs over free-form shell",
					"reject unsafe writes outside mission-approved scopes",
				],
				path_protections: [
					".omx/missions/<slug>/ is authoritative mission state",
					"candidate workspaces remain isolated under the mission root",
				],
				source_trust_rules: [
					"untrusted or execution_forbidden sources cannot generate command refs",
					"quote_only sources may inform summaries but not mutate contracts",
				],
				promotion_checks: [
					"promotion requires verified obligations and a non-blocked governor decision",
				],
			},
			clauses,
		},
		blockers,
	};
}

function policyDecisionPayload(
	snapshot: Awaited<ReturnType<typeof buildPolicySnapshot>>["snapshot"],
) {
	return snapshot.clauses.map((clause) => ({
		clause_id: clause.clause_id,
		category: clause.category,
		outcome: clause.outcome,
		rationale: clause.rationale,
		profile: snapshot.profile,
	}));
}

async function buildEnvironmentCurrent(
	mission: MissionState,
	paths: MissionV3ArtifactPaths,
	environmentContract: MissionV3EnvironmentContract,
): Promise<MissionV3EnvironmentCurrent> {
	const attestations = await loadJournal<Record<string, unknown>>(
		paths.environmentAttestationsPath,
	);
	const observations = await loadJournal<Record<string, unknown>>(
		paths.runtimeObservationsPath,
	);
	const latestAttestation = attestations.at(-1);
	const attestationPayload = latestAttestation?.payload as
		| {
				declared_hash?: string;
				achieved_hash?: string;
				expires_at?: string;
		  }
		| undefined;
	let parity: MissionV3EnvironmentCurrent["parity"] = "valid";
	let blockerReason: string | null = null;
	if (!latestAttestation || !attestationPayload) {
		parity = "broken";
		blockerReason = "missing environment attestation";
	} else if (
		attestationPayload.achieved_hash !==
		environmentContract.declared_environment_hash
	) {
		parity = "broken";
		blockerReason = "environment attestation hash mismatch";
	} else if (
		attestationPayload.expires_at &&
		new Date(attestationPayload.expires_at).getTime() <= Date.now()
	) {
		parity = "stale";
		blockerReason = "environment attestation expired";
	} else if (
		observations.some((event) => {
			const payload = event.payload as { env_hash?: string };
			return (
				payload.env_hash &&
				payload.env_hash !== environmentContract.declared_environment_hash
			);
		})
	) {
		parity = "broken";
		blockerReason = "runtime observation contradicted environment parity";
	}
	return {
		schema_version: 1,
		generated_at: nowIso(),
		mission_id: mission.mission_id,
		env_contract_id: environmentContract.env_contract_id,
		current_attestation_ref: latestAttestation?.event_id ?? null,
		declared_hash: environmentContract.declared_environment_hash,
		achieved_hash: attestationPayload?.achieved_hash ?? null,
		parity,
		blocker_reason: blockerReason,
		observation_refs: observations.map((event) => event.event_id),
		matrix_targets: environmentContract.matrix_targets.map(
			(target) => target.matrix_target_id,
		),
	};
}

function obligationIdsForLane(
	proofProgram: MissionV3ProofProgram,
	lane: MissionV3ProofLane,
): string[] {
	return proofProgram.bindings
		.filter((binding) => binding.proof_lane === lane)
		.map((binding) => binding.obligation_id);
}

function missionLaneToProofLane(
	laneType: MissionLaneType,
): MissionV3ProofLane | null {
	switch (laneType) {
		case "audit":
			return "reproduction";
		case "re_audit":
			return "targeted-regression";
		default:
			return null;
	}
}

async function writeMissionState(mission: MissionState): Promise<void> {
	await writeJson(missionStatePath(mission.mission_root), mission);
}

function compatibilityStatusForLifecycle(
	lifecycleState: MissionV3LifecycleState,
	currentStatus: MissionState["status"],
): MissionState["status"] {
	if (lifecycleState === "failed") return "failed";
	if (lifecycleState === "plateau") return "plateau";
	if (lifecycleState === "cancelled") return "cancelled";
	if (
		["verified", "promotion_ready", "released", "handed_off"].includes(
			lifecycleState,
		)
	) {
		return "complete";
	}
	return currentStatus === "cancelling" ? "cancelling" : "running";
}

async function latestSummary(
	mission: MissionState,
): Promise<MissionLaneSummary | null> {
	if (
		!mission.latest_summary_path ||
		!existsSync(mission.latest_summary_path)
	) {
		return null;
	}
	return readJson<MissionLaneSummary>(mission.latest_summary_path);
}

async function buildImpactMap(
	mission: MissionState,
	sourcePack: MissionSourcePack,
	latestVerifierSummary: MissionLaneSummary | null,
): Promise<{
	schema_version: 1;
	generated_at: string;
	mission_id: string;
	changed_surfaces: string[];
	mapped_tests: Array<{
		touchpoint: string;
		test_refs: string[];
		confidence: "high" | "medium";
	}>;
	required_regression_slice: string[];
	unresolved_blind_spots: string[];
}> {
	const changedSurfaces = Array.from(
		new Set([
			...sourcePack.project_touchpoints,
			...(latestVerifierSummary?.residuals
				.map(
					(residual: MissionLaneSummary["residuals"][number]) =>
						residual.target_path,
				)
				.filter((value: string | undefined): value is string =>
					Boolean(value),
				) ?? []),
		]),
	).sort();
	const tests = await collectRepoTestFiles(mission.repo_root);
	const mappedTests: Array<{
		touchpoint: string;
		test_refs: string[];
		confidence: "high" | "medium";
	}> = changedSurfaces.map((touchpoint) => {
		const stem = basename(touchpoint, extname(touchpoint)).toLowerCase();
		const matches = tests.filter((testPath) => {
			const normalized = testPath.toLowerCase();
			return (
				normalized.includes(stem) ||
				normalized.includes(stem.replace(/\.(test|spec)$/, ""))
			);
		});
		return {
			touchpoint,
			test_refs: matches.map((testPath) =>
				relative(mission.repo_root, testPath),
			),
			confidence: matches.length > 0 ? "high" : "medium",
		};
	});
	return {
		schema_version: 1,
		generated_at: nowIso(),
		mission_id: mission.mission_id,
		changed_surfaces: changedSurfaces,
		mapped_tests: mappedTests.filter((entry) => entry.test_refs.length > 0),
		required_regression_slice: mappedTests.flatMap((entry) => entry.test_refs),
		unresolved_blind_spots: mappedTests
			.filter((entry) => entry.test_refs.length === 0)
			.map((entry) => entry.touchpoint),
	};
}

function evidenceForObligation(
	evidenceEvents: MissionV3JournalEvent<Record<string, unknown>>[],
	obligationId: string,
) {
	return evidenceEvents.filter((event) => {
		const payload = event.payload as { obligation_ids?: string[] };
		return payload.obligation_ids?.includes(obligationId) === true;
	});
}

function evaluateObligations(
	assuranceContract: MissionV3AssuranceContract,
	proofProgram: MissionV3ProofProgram,
	environmentCurrent: MissionV3EnvironmentCurrent,
	evidenceEvents: MissionV3JournalEvent<Record<string, unknown>>[],
	policyBlockers: string[],
): {
	obligations: Array<{
		obligation_id: string;
		state: MissionV3ObligationState;
		reason: string;
		evidence_refs: string[];
		blocking: boolean;
	}>;
	allBlockingSatisfied: boolean;
	contradictions: string[];
	stale: string[];
	blockingIds: string[];
} {
	const adjudicationObligation = assuranceContract.obligations.find(
		(obligation) => obligation.required_lane === "adjudication",
	);
	const results: Array<{
		obligation_id: string;
		state: MissionV3ObligationState;
		reason: string;
		evidence_refs: string[];
		blocking: boolean;
	}> = assuranceContract.obligations
		.filter((obligation) => obligation.required_lane !== "adjudication")
		.map((obligation) => {
			const evidence = evidenceForObligation(
				evidenceEvents,
				obligation.obligation_id,
			);
			const support = evidence.filter(
				(event) =>
					(event.payload as { verdict?: string }).verdict === "supporting",
			);
			const contradictions = evidence.filter(
				(event) =>
					(event.payload as { verdict?: string }).verdict === "contradicting",
			);
			if (obligation.not_applicable_reason) {
				return {
					obligation_id: obligation.obligation_id,
					state: "not_applicable" as const,
					reason: obligation.not_applicable_reason,
					evidence_refs: [],
					blocking: obligation.blocking_severity === "blocking",
				};
			}
			if (contradictions.length > 0) {
				return {
					obligation_id: obligation.obligation_id,
					state: "contradicted" as const,
					reason: "contradictory evidence is present",
					evidence_refs: contradictions.map((event) => event.event_id),
					blocking: obligation.blocking_severity === "blocking",
				};
			}
			if (support.length === 0) {
				return {
					obligation_id: obligation.obligation_id,
					state: (proofProgram.bindings.some(
						(binding) => binding.obligation_id === obligation.obligation_id,
					)
						? "planned"
						: "deferred") as MissionV3ObligationState,
					reason:
						"required proof lane has not produced admissible evidence yet",
					evidence_refs: [],
					blocking: obligation.blocking_severity === "blocking",
				};
			}
			const latest = support.at(-1)!;
			const freshnessExpiresAt = (
				latest.payload as { freshness_expires_at?: string }
			).freshness_expires_at;
			if (environmentCurrent.parity !== "valid") {
				return {
					obligation_id: obligation.obligation_id,
					state: "stale" as const,
					reason:
						environmentCurrent.blocker_reason ??
						"environment parity is not valid",
					evidence_refs: [latest.event_id],
					blocking: obligation.blocking_severity === "blocking",
				};
			}
			if (
				freshnessExpiresAt &&
				new Date(freshnessExpiresAt).getTime() <= Date.now()
			) {
				return {
					obligation_id: obligation.obligation_id,
					state: "stale" as const,
					reason: "freshness TTL expired",
					evidence_refs: [latest.event_id],
					blocking: obligation.blocking_severity === "blocking",
				};
			}
			return {
				obligation_id: obligation.obligation_id,
				state: "satisfied" as const,
				reason:
					"fresh supporting evidence present under valid environment parity",
				evidence_refs: support.map((event) => event.event_id),
				blocking: obligation.blocking_severity === "blocking",
			};
		});
	if (adjudicationObligation) {
		const unresolvedBlocking = results.filter(
			(result) =>
				result.blocking &&
				!["satisfied", "waived", "not_applicable"].includes(result.state),
		);
		results.push({
			obligation_id: adjudicationObligation.obligation_id,
			state:
				environmentCurrent.parity !== "valid"
					? "stale"
					: unresolvedBlocking.length === 0 && policyBlockers.length === 0
						? "satisfied"
						: unresolvedBlocking.some(
									(result) => result.state === "contradicted",
								)
							? "contradicted"
							: "planned",
			reason:
				environmentCurrent.parity !== "valid"
					? (environmentCurrent.blocker_reason ??
						"environment parity is not valid")
					: unresolvedBlocking.length === 0 && policyBlockers.length === 0
						? "structured adjudication confirms all blocking obligations are satisfied"
						: "structured adjudication is waiting for remaining blocking obligations or policy blockers to clear",
			evidence_refs: [],
			blocking: adjudicationObligation.blocking_severity === "blocking",
		});
	}
	const contradictions = results
		.filter((result) => result.state === "contradicted" && result.blocking)
		.map((result) => result.obligation_id);
	const stale = results
		.filter((result) => result.state === "stale" && result.blocking)
		.map((result) => result.obligation_id);
	const blockingIds = results
		.filter(
			(result) =>
				result.blocking &&
				!["satisfied", "waived", "not_applicable"].includes(result.state),
		)
		.map((result) => result.obligation_id);
	const allBlockingSatisfied =
		blockingIds.length === 0 && policyBlockers.length === 0;
	return {
		obligations: results,
		allBlockingSatisfied,
		contradictions,
		stale,
		blockingIds,
	};
}

async function buildEvidenceGraph(
	mission: MissionState,
	assuranceContract: MissionV3AssuranceContract,
	evaluation: ReturnType<typeof evaluateObligations>,
	impactMap: Awaited<ReturnType<typeof buildImpactMap>>,
): Promise<{
	schema_version: 1;
	generated_at: string;
	mission_id: string;
	claims: Array<{
		claim_id: string;
		obligation_id: string;
		state: MissionV3ObligationState;
		evidence_refs: string[];
		reason: string;
	}>;
	unresolved_blind_spots: string[];
}> {
	return {
		schema_version: 1,
		generated_at: nowIso(),
		mission_id: mission.mission_id,
		claims: assuranceContract.obligations.map((obligation) => {
			const evaluated = evaluation.obligations.find(
				(result) => result.obligation_id === obligation.obligation_id,
			)!;
			return {
				claim_id: `claim:${obligation.obligation_id}`,
				obligation_id: obligation.obligation_id,
				state: evaluated.state,
				evidence_refs: evaluated.evidence_refs,
				reason: evaluated.reason,
			};
		}),
		unresolved_blind_spots: impactMap.unresolved_blind_spots,
	};
}

function buildAdjudication(
	mission: MissionState,
	candidateId: string | null,
	evaluation: ReturnType<typeof evaluateObligations>,
	policyBlockers: string[],
): MissionV3Adjudication {
	const proofReady =
		candidateId !== null &&
		evaluation.allBlockingSatisfied &&
		policyBlockers.length === 0;
	let recommendedNextState: MissionV3LifecycleState = "assuring";
	if (mission.status === "failed") recommendedNextState = "failed";
	else if (mission.status === "plateau") recommendedNextState = "plateau";
	else if (mission.status === "cancelled") recommendedNextState = "cancelled";
	else if (proofReady) recommendedNextState = "verified";
	return {
		schema_version: 1,
		generated_at: nowIso(),
		mission_id: mission.mission_id,
		candidate_id: candidateId,
		obligation_status_table: evaluation.obligations.map((result) => ({
			obligation_id: result.obligation_id,
			state: result.state,
			blocking: result.blocking,
			reason: result.reason,
			evidence_refs: result.evidence_refs,
		})),
		blocking_contradictions: evaluation.contradictions,
		waiver_summary: [],
		stale_evidence_summary: evaluation.stale,
		residual_risk_summary: policyBlockers,
		recommended_next_state: recommendedNextState,
		proof_ready: proofReady,
	};
}

function buildPromotionDecision(
	mission: MissionState,
	candidateId: string | null,
	adjudication: MissionV3Adjudication,
	policyBlockers: string[],
): MissionV3PromotionDecision {
	const requiredArtifacts = [
		"assurance-contract.json",
		"proof-program.json",
		"checker-lock.json",
		"environment-contract.json",
		"adjudication.json",
	];
	const reasons = [
		...policyBlockers,
		...(candidateId === null
			? ["no selected candidate is available for promotion"]
			: []),
		...(adjudication.proof_ready
			? []
			: ["blocking proof obligations are not yet fully satisfied"]),
	];
	return {
		schema_version: 1,
		generated_at: nowIso(),
		mission_id: mission.mission_id,
		candidate_id: candidateId,
		decision: reasons.length === 0 ? "allow" : "block",
		reasons,
		lifecycle_state: adjudication.proof_ready ? "verified" : "assuring",
		required_artifacts: requiredArtifacts,
		policy_blockers: policyBlockers,
	};
}

function buildQualityWatchdog(
	mission: MissionState,
	evaluation: ReturnType<typeof evaluateObligations>,
	policyBlockers: string[],
	impactMap: Awaited<ReturnType<typeof buildImpactMap>>,
	uncertaintyRegister: {
		open_uncertainties: Array<{ uncertainty_id: string }>;
	},
	promotionDecision: MissionV3PromotionDecision,
) {
	const contradictionCount = evaluation.contradictions.length;
	const staleCount = evaluation.stale.length;
	const unresolvedBlocking = evaluation.blockingIds.length;
	const validatedSurfaceCount = evaluation.obligations.filter(
		(result) => result.state === "satisfied",
	).length;
	const metrics = {
		unresolved_blocking_obligations: unresolvedBlocking,
		stale_evidence_count: staleCount,
		contradiction_count: contradictionCount,
		impacted_surface_count: impactMap.changed_surfaces.length,
		validated_surface_count: validatedSurfaceCount,
		waiver_count: 0,
		uncertainty_burden: uncertaintyRegister.open_uncertainties.length,
		policy_exception_count: policyBlockers.length,
		candidate_spread: mission.candidate_ids.length,
	};
	let decision:
		| "continue"
		| "warn"
		| "escalate"
		| "force_assurance"
		| "require_strategy_mutation"
		| "block_promotion" = "continue";
	const reasons: string[] = [];
	if (
		promotionDecision.decision === "block" &&
		mission.lifecycle_state === "verified"
	) {
		decision = "block_promotion";
		reasons.push(...promotionDecision.reasons);
	} else if (contradictionCount > 0 || staleCount > 0) {
		decision = "force_assurance";
		reasons.push("blocking contradictions or stale evidence remain");
	} else if (
		impactMap.unresolved_blind_spots.length > 0 &&
		mission.status === "plateau"
	) {
		decision = "require_strategy_mutation";
		reasons.push(
			"plateau reached with unresolved blind spots in the impact map",
		);
	} else if (unresolvedBlocking > 0 || policyBlockers.length > 0) {
		decision = "warn";
		reasons.push("blocking proof or policy conditions remain unresolved");
	}
	return {
		schema_version: 1 as const,
		generated_at: nowIso(),
		mission_id: mission.mission_id,
		metrics,
		decision,
		reasons,
	};
}

async function buildUncertaintyRegister(paths: MissionV3ArtifactPaths) {
	const events = await loadJournal<Record<string, unknown>>(
		paths.uncertaintyEventsPath,
	);
	const byId = new Map<
		string,
		{
			uncertainty_id: string;
			statement: string;
			status: string;
			blocking_for: string[];
			owner: string;
			last_reviewed_at: string;
			resolution_strategy: string;
		}
	>();
	for (const event of events) {
		const payload = event.payload as {
			uncertainty_id: string;
			statement: string;
			status: string;
			blocking_for?: string[];
			owner?: string;
			resolution_strategy?: string;
		};
		byId.set(payload.uncertainty_id, {
			uncertainty_id: payload.uncertainty_id,
			statement: payload.statement,
			status: payload.status,
			blocking_for: payload.blocking_for ?? [],
			owner: payload.owner ?? "mission-v3",
			last_reviewed_at: event.recorded_at,
			resolution_strategy:
				payload.resolution_strategy ??
				"clarify via next planning or verifier pass",
		});
	}
	const uncertainties = Array.from(byId.values());
	return {
		schema_version: 1 as const,
		generated_at: nowIso(),
		open_uncertainties: uncertainties.filter((item) => item.status === "open"),
		resolved_uncertainties: uncertainties.filter(
			(item) => item.status !== "open",
		),
	};
}

function buildCandidateTournament(
	mission: MissionState,
	candidates: MissionV3CandidateState[],
	adjudication: MissionV3Adjudication,
	promotionDecision: MissionV3PromotionDecision,
) {
	const selectedCandidateId =
		mission.selected_candidate_id ??
		candidates.find((candidate) => candidate.state === "selected")
			?.candidate_id ??
		candidates[0]?.candidate_id ??
		null;
	const unresolvedRisk =
		adjudication.blocking_contradictions.length +
		adjudication.stale_evidence_summary.length +
		adjudication.residual_risk_summary.length;
	return {
		schema_version: 1 as const,
		generated_at: nowIso(),
		mission_id: mission.mission_id,
		selected_candidate_id: selectedCandidateId,
		candidates: candidates.map((candidate) => ({
			candidate_id: candidate.candidate_id,
			state: candidate.state,
			parent_candidate_ids: candidate.parent_candidate_ids,
			hard_vetoes:
				candidate.candidate_id === selectedCandidateId
					? adjudication.blocking_contradictions
					: staleCandidateStates().includes(candidate.state)
						? ["candidate not writable"]
						: [],
			comparison_vector: {
				proof_completeness:
					candidate.candidate_id === selectedCandidateId &&
					adjudication.proof_ready
						? 1
						: 0,
				regression_safety:
					candidate.candidate_id === selectedCandidateId &&
					adjudication.blocking_contradictions.length === 0
						? 1
						: 0,
				release_readiness:
					candidate.candidate_id === selectedCandidateId &&
					promotionDecision.decision === "allow"
						? 1
						: 0,
				residual_uncertainty:
					candidate.candidate_id === selectedCandidateId ? unresolvedRisk : 1,
			},
		})),
		selection_strategy:
			candidates.length > 1
				? "structured-hard-veto-then-lexicographic"
				: "single-candidate-default",
		tie_break:
			candidates.length > 1
				? "require explicit selection or hybridization"
				: null,
	};
}

function buildStatusLedger(
	mission: MissionState,
	candidates: MissionV3CandidateState[],
	adjudication: MissionV3Adjudication,
	promotionDecision: MissionV3PromotionDecision,
	qualityWatchdog: ReturnType<typeof buildQualityWatchdog>,
	uncertaintyRegister: Awaited<ReturnType<typeof buildUncertaintyRegister>>,
	environmentCurrent: MissionV3EnvironmentCurrent,
) {
	const activeCandidate =
		candidates.find(
			(candidate) => candidate.candidate_id === mission.active_candidate_id,
		) ?? candidates[0];
	return [
		"# Mission V3 Status Ledger",
		"",
		`- Mission ID: \`${mission.mission_id}\``,
		`- Compatibility status: \`${mission.status}\``,
		`- V3 lifecycle: \`${mission.lifecycle_state}\``,
		`- Active candidate: \`${activeCandidate?.candidate_id ?? "(none)"}\``,
		`- Selected candidate: \`${mission.selected_candidate_id ?? "(none)"}\``,
		`- Candidate state: \`${activeCandidate?.state ?? "(none)"}\``,
		`- Candidate spread: ${candidates.map((candidate) => `${candidate.candidate_id}:${candidate.state}`).join(", ") || "(none)"}`,
		`- Environment parity: \`${environmentCurrent.parity}\``,
		`- Promotion decision: \`${promotionDecision.decision}\``,
		`- Quality watchdog: \`${qualityWatchdog.decision}\``,
		"",
		"## Blocking contradictions",
		adjudication.blocking_contradictions.length > 0
			? adjudication.blocking_contradictions
					.map((item) => `- ${item}`)
					.join("\n")
			: "- None",
		"",
		"## Stale evidence",
		adjudication.stale_evidence_summary.length > 0
			? adjudication.stale_evidence_summary
					.map((item) => `- ${item}`)
					.join("\n")
			: "- None",
		"",
		"## Open uncertainties",
		uncertaintyRegister.open_uncertainties.length > 0
			? uncertaintyRegister.open_uncertainties
					.map((item) => `- ${item.uncertainty_id}: ${item.statement}`)
					.join("\n")
			: "- None",
		"",
		"## Recommended next state",
		adjudication.recommended_next_state,
	].join("\n");
}

function buildContextSnapshot(
	mission: MissionState,
	candidates: MissionV3CandidateState[],
	adjudication: MissionV3Adjudication,
	promotionDecision: MissionV3PromotionDecision,
	uncertaintyRegister: Awaited<ReturnType<typeof buildUncertaintyRegister>>,
	evidenceGraph: Awaited<ReturnType<typeof buildEvidenceGraph>>,
) {
	return {
		schema_version: 1 as const,
		generated_at: nowIso(),
		mission_id: mission.mission_id,
		lifecycle_state: mission.lifecycle_state,
		compatibility_status: mission.status,
		active_candidate_id: mission.active_candidate_id,
		selected_candidate_id: mission.selected_candidate_id,
		candidate_ids: candidates.map((candidate) => candidate.candidate_id),
		latest_adjudication_ref: mission.latest_authoritative_adjudication_ref,
		latest_validated_evidence_refs: evidenceGraph.claims
			.filter((claim) => claim.state === "satisfied")
			.flatMap((claim) => claim.evidence_refs),
		active_uncertainty_ids: uncertaintyRegister.open_uncertainties.map(
			(item) => item.uncertainty_id,
		),
		promotion_decision: promotionDecision.decision,
	};
}

async function buildTraceBundle(params: {
	mission: MissionState;
	paths: MissionV3ArtifactPaths;
	candidates: MissionV3CandidateState[];
	evidenceGraph: Awaited<ReturnType<typeof buildEvidenceGraph>>;
}) {
	const laneRuns = await loadJournal<Record<string, unknown>>(
		params.paths.laneRunsPath,
	);
	const commandAttestations = await loadJournal<Record<string, unknown>>(
		params.paths.commandAttestationsPath,
	);
	const policyDecisions = await loadJournal<Record<string, unknown>>(
		params.paths.policyDecisionsPath,
	);
	return {
		schema_version: 1 as const,
		generated_at: nowIso(),
		mission_id: params.mission.mission_id,
		prompt_context_bundle_hash: `sha256:${shortHash(
			stableJson({
				mission_id: params.mission.mission_id,
				candidate_ids: params.candidates.map(
					(candidate) => candidate.candidate_id,
				),
				evidence_claims: params.evidenceGraph.claims.length,
			}),
		)}`,
		candidate_ids: params.candidates.map((candidate) => candidate.candidate_id),
		lane_ids: laneRuns
			.map((event) =>
				String((event.payload as { lane_run_id?: string }).lane_run_id ?? ""),
			)
			.filter(Boolean),
		tool_call_refs: commandAttestations.map((event) => event.event_id),
		command_attestation_refs: commandAttestations.map(
			(event) => event.event_id,
		),
		env_hashes: Array.from(
			new Set(
				commandAttestations
					.map((event) => (event.payload as { env_hash?: string }).env_hash)
					.filter((value): value is string => Boolean(value)),
			),
		),
		artifact_hashes: [
			...params.evidenceGraph.claims.flatMap((claim) => claim.evidence_refs),
			...commandAttestations.map((event) => event.payload_hash),
		],
		verdicts: params.evidenceGraph.claims.map((claim) => ({
			claim_id: claim.claim_id,
			state: claim.state,
		})),
		timings: {
			lane_run_count: laneRuns.length,
			command_attestation_count: commandAttestations.length,
			policy_decision_count: policyDecisions.length,
		},
		supersession_links: params.candidates
			.filter((candidate) => candidate.superseded_by)
			.map((candidate) => ({
				candidate_id: candidate.candidate_id,
				superseded_by: candidate.superseded_by,
			})),
	};
}

function buildEvalBundle(params: {
	mission: MissionState;
	candidates: MissionV3CandidateState[];
	adjudication: MissionV3Adjudication;
	uncertaintyRegister: Awaited<ReturnType<typeof buildUncertaintyRegister>>;
	evidenceGraph: Awaited<ReturnType<typeof buildEvidenceGraph>>;
}) {
	const failingClaims = params.evidenceGraph.claims.filter(
		(claim) => claim.state !== "satisfied",
	);
	return {
		schema_version: 1 as const,
		generated_at: nowIso(),
		mission_id: params.mission.mission_id,
		failing_prompts_or_fragments: failingClaims.map((claim) => ({
			claim_id: claim.claim_id,
			reason: claim.reason,
		})),
		grader_inputs_outputs: {
			recommended_next_state: params.adjudication.recommended_next_state,
			proof_ready: params.adjudication.proof_ready,
		},
		counterexamples: params.adjudication.blocking_contradictions,
		residual_patterns: params.adjudication.residual_risk_summary,
		lessons: [
			"Keep candidate selection under authoritative umbrella mission state.",
			"Block promotion when proof freshness or policy parity weakens.",
			"Carry unresolved uncertainty forward into context snapshots.",
		],
		held_out_eval_refs: [
			"held-out:real-mission-failure-corpus",
			"held-out:mutation-regression-suite",
		],
		benchmark_hygiene: {
			public_benchmarks_sufficient: false,
			priorities: [
				"held-out internal tasks",
				"mutated prompt corpora",
				"real mission regression corpora",
				"contamination checks for any public benchmark",
			],
		},
		open_uncertainty_ids: params.uncertaintyRegister.open_uncertainties.map(
			(item) => item.uncertainty_id,
		),
		candidate_ids: params.candidates.map((candidate) => candidate.candidate_id),
	};
}

function buildLearningProposal(params: {
	mission: MissionState;
	adjudication: MissionV3Adjudication;
	evalBundle: ReturnType<typeof buildEvalBundle>;
}) {
	return {
		schema_version: 1 as const,
		generated_at: nowIso(),
		proposal_id: `learning:${shortHash(
			stableJson({
				mission: params.mission.mission_id,
				state: params.adjudication.recommended_next_state,
				failures: params.evalBundle.counterexamples,
			}),
		)}`,
		mission_id: params.mission.mission_id,
		state: params.adjudication.proof_ready ? "shadow_evaluated" : "captured",
		target_surface: "mission-v3-policy-and-assurance",
		rationale:
			params.adjudication.blocking_contradictions.length > 0
				? "Contradictions captured from the adjudicator should seed follow-up shadow evaluation."
				: "Trace and eval bundle captured for future shadow evaluation.",
		shadow_eval_required: true,
		held_out_eval_required: true,
		approval_required: true,
		source_trace_ref: "trace-bundle.json",
		source_eval_ref: "eval-bundle.json",
	};
}

function buildPostmortem(params: {
	mission: MissionState;
	adjudication: MissionV3Adjudication;
	promotionDecision: MissionV3PromotionDecision;
}) {
	return [
		"# Mission V3 Postmortem",
		"",
		`- Mission ID: \`${params.mission.mission_id}\``,
		`- Lifecycle: \`${params.mission.lifecycle_state}\``,
		`- Compatibility status: \`${params.mission.status}\``,
		`- Proof ready: \`${params.adjudication.proof_ready}\``,
		`- Promotion decision: \`${params.promotionDecision.decision}\``,
		"",
		"## Blocking contradictions",
		params.adjudication.blocking_contradictions.length > 0
			? params.adjudication.blocking_contradictions
					.map((item) => `- ${item}`)
					.join("\n")
			: "- None",
		"",
		"## Residual risk summary",
		params.adjudication.residual_risk_summary.length > 0
			? params.adjudication.residual_risk_summary
					.map((item) => `- ${item}`)
					.join("\n")
			: "- None",
		"",
		"## Promotion blockers",
		params.promotionDecision.reasons.length > 0
			? params.promotionDecision.reasons.map((item) => `- ${item}`).join("\n")
			: "- None",
	].join("\n");
}

async function writeDerivedViews(params: {
	mission: MissionState;
	candidates: MissionV3CandidateState[];
	paths: MissionV3ArtifactPaths;
	environmentCurrent: MissionV3EnvironmentCurrent;
	policySnapshot: Awaited<ReturnType<typeof buildPolicySnapshot>>["snapshot"];
	impactMap: Awaited<ReturnType<typeof buildImpactMap>>;
	evidenceGraph: Awaited<ReturnType<typeof buildEvidenceGraph>>;
	adjudication: MissionV3Adjudication;
	promotionDecision: MissionV3PromotionDecision;
	qualityWatchdog: ReturnType<typeof buildQualityWatchdog>;
	uncertaintyRegister: Awaited<ReturnType<typeof buildUncertaintyRegister>>;
}) {
	await writeJson(
		params.paths.environmentCurrentPath,
		params.environmentCurrent,
	);
	await writeJson(params.paths.policySnapshotPath, params.policySnapshot);
	await writeJson(params.paths.impactMapPath, params.impactMap);
	await writeJson(params.paths.evidenceGraphPath, params.evidenceGraph);
	await writeJson(params.paths.adjudicationPath, params.adjudication);
	await writeJson(params.paths.promotionDecisionPath, params.promotionDecision);
	await writeJson(params.paths.qualityWatchdogPath, params.qualityWatchdog);
	await writeJson(
		params.paths.uncertaintyRegisterPath,
		params.uncertaintyRegister,
	);
	const traceBundle = await buildTraceBundle({
		mission: params.mission,
		paths: params.paths,
		candidates: params.candidates,
		evidenceGraph: params.evidenceGraph,
	});
	const evalBundle = buildEvalBundle({
		mission: params.mission,
		candidates: params.candidates,
		adjudication: params.adjudication,
		uncertaintyRegister: params.uncertaintyRegister,
		evidenceGraph: params.evidenceGraph,
	});
	const learningProposal = buildLearningProposal({
		mission: params.mission,
		adjudication: params.adjudication,
		evalBundle,
	});
	const tournament = buildCandidateTournament(
		params.mission,
		params.candidates,
		params.adjudication,
		params.promotionDecision,
	);
	await writeJson(params.paths.candidateTournamentPath, tournament);
	const snapshot = buildContextSnapshot(
		params.mission,
		params.candidates,
		params.adjudication,
		params.promotionDecision,
		params.uncertaintyRegister,
		params.evidenceGraph,
	);
	await writeJson(params.paths.currentContextSnapshotPath, snapshot);
	await writeJson(params.paths.traceBundlePath, traceBundle);
	await writeJson(params.paths.evalBundlePath, evalBundle);
	await writeJson(
		join(params.paths.learningProposalsDir, "current.json"),
		learningProposal,
	);
	await writeText(
		params.paths.postmortemPath,
		buildPostmortem({
			mission: params.mission,
			adjudication: params.adjudication,
			promotionDecision: params.promotionDecision,
		}),
	);
	await writeText(
		params.paths.statusLedgerPath,
		buildStatusLedger(
			params.mission,
			params.candidates,
			params.adjudication,
			params.promotionDecision,
			params.qualityWatchdog,
			params.uncertaintyRegister,
			params.environmentCurrent,
		),
	);
}

async function updateMissionV3State(
	mission: MissionState,
	update: Partial<MissionState>,
): Promise<MissionState> {
	const next = {
		...mission,
		...update,
		updated_at: nowIso(),
	} satisfies MissionState;
	await writeMissionState(next);
	return next;
}

async function rebuildMissionV3DerivedState(params: {
	mission: MissionState;
	artifacts: MissionOrchestrationArtifacts;
	artifactPaths: MissionOrchestrationArtifactPaths;
	paths: MissionV3ArtifactPaths;
	profile: MissionV3PolicyProfile;
	candidate: MissionV3CandidateState;
	assuranceContract: MissionV3AssuranceContract;
	proofProgram: MissionV3ProofProgram;
	environmentContract: MissionV3EnvironmentContract;
	preferredLifecycle?: MissionV3LifecycleState;
}): Promise<MissionV3SyncResult> {
	const {
		mission,
		artifacts,
		paths,
		profile,
		candidate,
		assuranceContract,
		proofProgram,
		environmentContract,
		preferredLifecycle,
	} = params;
	const environmentCurrent = await buildEnvironmentCurrent(
		mission,
		paths,
		environmentContract,
	);
	const policy = await buildPolicySnapshot(
		mission,
		artifacts.sourcePack,
		profile,
		environmentCurrent,
	);
	const evidenceEvents = await loadJournal<Record<string, unknown>>(
		paths.evidenceEventsPath,
	);
	const impactMap = await buildImpactMap(
		mission,
		artifacts.sourcePack,
		await latestSummary(mission),
	);
	const evaluation = evaluateObligations(
		assuranceContract,
		proofProgram,
		environmentCurrent,
		evidenceEvents,
		policy.blockers,
	);
	const candidateMap = new Map(
		(await loadMissionV3CandidateStates(paths)).map((entry) => [
			entry.candidate_id,
			entry,
		]),
	);
	candidateMap.set(candidate.candidate_id, candidate);
	const knownCandidates = Array.from(candidateMap.values()).sort(
		(left, right) => left.candidate_id.localeCompare(right.candidate_id),
	);
	const selectedCandidateId = resolveSelectedCandidateId(
		mission,
		knownCandidates,
		candidate.candidate_id,
	);
	const activeCandidateId = resolveActiveCandidateId(
		mission,
		knownCandidates,
		selectedCandidateId,
		candidate.candidate_id,
	);
	const evidenceGraph = await buildEvidenceGraph(
		mission,
		assuranceContract,
		evaluation,
		impactMap,
	);
	const adjudication = buildAdjudication(
		mission,
		selectedCandidateId,
		evaluation,
		policy.blockers,
	);
	const promotionDecision = buildPromotionDecision(
		mission,
		selectedCandidateId,
		adjudication,
		policy.blockers,
	);
	const uncertaintyRegister = await buildUncertaintyRegister(paths);
	const qualityWatchdog = buildQualityWatchdog(
		mission,
		evaluation,
		policy.blockers,
		impactMap,
		uncertaintyRegister,
		promotionDecision,
	);
	let lifecycleState: MissionV3LifecycleState =
		preferredLifecycle ?? mission.lifecycle_state;
	if (mission.status === "failed") lifecycleState = "failed";
	else if (mission.status === "plateau") lifecycleState = "plateau";
	else if (mission.status === "cancelled") lifecycleState = "cancelled";
	else if (
		selectedCandidateId !== null &&
		mission.status === "complete" &&
		promotionDecision.decision === "allow"
	)
		lifecycleState = "promotion_ready";
	else if (
		selectedCandidateId !== null &&
		mission.status === "complete" &&
		adjudication.proof_ready
	)
		lifecycleState = "verified";
	else if (preferredLifecycle) lifecycleState = preferredLifecycle;
	else lifecycleState = mission.current_iteration > 0 ? "assuring" : "planning";
	const compatStatus = compatibilityStatusForLifecycle(
		lifecycleState,
		mission.status,
	);
	const nextMission = await updateMissionV3State(mission, {
		status: compatStatus,
		lifecycle_state: lifecycleState,
		active_candidate_id: activeCandidateId,
		selected_candidate_id: selectedCandidateId,
		candidate_ids: Array.from(
			new Set([
				...(mission.candidate_ids ?? []),
				...knownCandidates.map((entry) => entry.candidate_id),
			]),
		),
		assurance_contract_id: assuranceContract.assurance_contract_id,
		proof_program_id: proofProgram.proof_program_id,
		checker_lock_id: params.proofProgram.checker_lock_id,
		environment_contract_id: environmentContract.env_contract_id,
		policy_profile: profile,
		verification_state: {
			status: adjudication.proof_ready
				? "verified"
				: evaluation.blockingIds.length > 0
					? "blocked"
					: "pending",
			blocking_obligation_ids: evaluation.blockingIds,
			satisfied_obligation_ids: evaluation.obligations
				.filter((result) => result.state === "satisfied")
				.map((result) => result.obligation_id),
			contradicted_obligation_ids: evaluation.contradictions,
			stale_obligation_ids: evaluation.stale,
			adjudication_state: adjudication.proof_ready ? "verified" : "assuring",
			last_verified_at: adjudication.proof_ready ? nowIso() : null,
		},
		promotion_state: {
			status: promotionDecision.decision === "allow" ? "ready" : "blocked",
			blocking_reasons: promotionDecision.reasons,
			last_decision_at: promotionDecision.generated_at,
			decision_ref: paths.promotionDecisionPath,
		},
		plateau_strategy_state: {
			strategy_key: artifacts.executionPlan.strategy_key,
			mutation_attempts:
				lifecycleState === "plateau"
					? Math.max(mission.plateau_strategy_state?.mutation_attempts ?? 0, 1)
					: (mission.plateau_strategy_state?.mutation_attempts ?? 0),
			candidate_expansions: Math.max(mission.candidate_ids?.length ?? 0, 1),
			exhausted: lifecycleState === "plateau",
		},
		kernel_blockers: Array.from(
			new Set([
				...policy.blockers,
				...evaluation.blockingIds.map(
					(obligationId) => `obligation:${obligationId}`,
				),
				...(environmentCurrent.blocker_reason
					? [`environment:${environmentCurrent.blocker_reason}`]
					: []),
			]),
		),
		latest_authoritative_iteration_ref:
			mission.latest_summary_path != null
				? `iteration:${mission.current_iteration}`
				: mission.latest_authoritative_iteration_ref,
		latest_authoritative_adjudication_ref: paths.adjudicationPath,
		final_reason:
			compatStatus === "running"
				? null
				: (mission.final_reason ??
					(lifecycleState === "promotion_ready"
						? "blocking proof obligations satisfied; promotion readiness earned"
						: adjudication.recommended_next_state)),
	});
	const refreshedCandidates = knownCandidates.map((entry) => {
		if (staleCandidateStates().includes(entry.state)) return entry;
		if (
			entry.state === "blocked" &&
			entry.candidate_id !== activeCandidateId &&
			entry.candidate_id !== selectedCandidateId
		) {
			return entry;
		}
		let nextState = entry.state;
		let selectedAt = entry.selected_at;
		if (entry.candidate_id === selectedCandidateId) {
			nextState = "selected";
			selectedAt = entry.selected_at ?? nextMission.updated_at;
		} else if (
			lifecycleState !== "released" &&
			lifecycleState !== "handed_off" &&
			entry.candidate_id === activeCandidateId
		) {
			nextState = mission.current_iteration > 0 ? "running" : "approved";
			selectedAt = null;
		} else if (entry.state === "selected") {
			nextState = "running";
			selectedAt = null;
		}
		if (["failed", "plateau", "cancelled"].includes(lifecycleState)) {
			nextState =
				entry.candidate_id === selectedCandidateId ? "selected" : entry.state;
		}
		return {
			...entry,
			state: nextState,
			selected_at: selectedAt,
			updated_at: nextMission.updated_at,
		};
	});
	for (const refreshedCandidate of refreshedCandidates) {
		await writeJson(
			join(refreshedCandidate.workspace_root, "candidate-state.json"),
			refreshedCandidate,
		);
	}
	await writeDerivedViews({
		mission: nextMission,
		candidates: refreshedCandidates,
		paths,
		environmentCurrent,
		policySnapshot: policy.snapshot,
		impactMap,
		evidenceGraph,
		adjudication,
		promotionDecision,
		qualityWatchdog,
		uncertaintyRegister,
	});
	return {
		mission: nextMission,
		paths,
		adjudication,
		promotionDecision,
	};
}

async function seedBootstrapJournals(params: {
	mission: MissionState;
	artifacts: MissionOrchestrationArtifacts;
	paths: MissionV3ArtifactPaths;
	profile: MissionV3PolicyProfile;
	environmentContract: MissionV3EnvironmentContract;
	proofProgram: MissionV3ProofProgram;
	candidate: MissionV3CandidateState;
}) {
	const {
		mission,
		artifacts,
		paths,
		profile,
		environmentContract,
		proofProgram,
		candidate,
	} = params;
	await appendJournalEvent(paths.environmentAttestationsPath, {
		journalType: "environment-attestations",
		missionId: mission.mission_id,
		candidateId: candidate.candidate_id,
		actorPrincipal: "environment-kernel",
		idempotencyKey: `environment-attestation:${environmentContract.env_contract_id}`,
		payload: {
			attestation_id: `env-attestation:${shortHash(environmentContract.env_contract_id)}`,
			candidate_id: candidate.candidate_id,
			lane_id: null,
			setup_run_id: "bootstrap",
			declared_hash: environmentContract.declared_environment_hash,
			achieved_hash: environmentContract.declared_environment_hash,
			base_image_digest: environmentContract.runtime_base_id,
			toolchain_digests: environmentContract.toolchain_versions,
			service_versions: environmentContract.service_inventory,
			secret_scope_fingerprints: environmentContract.declared_secret_scopes.map(
				(scope) => `sha256:${shortHash(scope)}`,
			),
			attested_at: nowIso(),
			expires_at: addSeconds(nowIso(), 3600),
			success: true,
			failure_reason: null,
		},
	});
	const policy = await buildPolicySnapshot(
		mission,
		artifacts.sourcePack,
		profile,
		await buildEnvironmentCurrent(mission, paths, environmentContract),
	);
	for (const clause of policyDecisionPayload(policy.snapshot)) {
		await appendJournalEvent(paths.policyDecisionsPath, {
			journalType: "policy-decisions",
			missionId: mission.mission_id,
			candidateId: candidate.candidate_id,
			actorPrincipal: "control-plane",
			idempotencyKey: `policy:${clause.clause_id}:${clause.outcome}`,
			payload: clause,
		});
	}
	await appendJournalEvent(paths.decisionLogPath, {
		journalType: "decision-log",
		missionId: mission.mission_id,
		candidateId: candidate.candidate_id,
		actorPrincipal: "mission-v3-bootstrap",
		idempotencyKey: `decision:candidate-selected:${candidate.candidate_id}`,
		payload: {
			decision: "candidate_selected",
			candidate_id: candidate.candidate_id,
			rationale: candidate.rationale,
			proof_program_id: proofProgram.proof_program_id,
		},
	});
	for (const [index, unknown] of artifacts.sourcePack.unknowns.entries()) {
		await appendJournalEvent(paths.uncertaintyEventsPath, {
			journalType: "uncertainty-events",
			missionId: mission.mission_id,
			candidateId: candidate.candidate_id,
			actorPrincipal: "mission-v3-bootstrap",
			idempotencyKey: `uncertainty:${index}:${shortHash(unknown)}`,
			payload: {
				uncertainty_id: `uncertainty:${index + 1}:${shortHash(unknown)}`,
				statement: unknown,
				class: "source-grounding",
				candidate_scope: candidate.candidate_id,
				blocking_for: ["planning", "assurance"],
				status: "open",
				owner: "mission-v3-bootstrap",
				resolution_strategy: "resolve via next planning or verifier pass",
			},
		});
	}
}

export async function syncMissionV3Bootstrap(params: {
	mission: MissionState;
	artifacts: MissionOrchestrationArtifacts;
	artifactPaths: MissionOrchestrationArtifactPaths;
	highRisk?: boolean;
	iteration?: number | null;
}): Promise<MissionV3SyncResult> {
	const { mission, artifacts, iteration } = params;
	const paths = missionV3ArtifactPaths(
		mission.mission_root,
		mission.active_candidate_id ?? missionV3CandidateId(),
	);
	await ensureV3Layout(paths);
	const profile = deriveProfiles(
		artifacts.sourcePack,
		params.highRisk === true,
	);
	const assuranceContract = buildAssuranceContract(
		mission,
		artifacts,
		profile,
		paths,
	);
	const checkerLock = buildCheckerLock(
		mission,
		profile,
		requiredProofLanes(profile),
	);
	const environmentContract = await buildEnvironmentContract(mission, profile);
	const proofProgram = buildProofProgram(
		mission,
		assuranceContract,
		checkerLock,
		environmentContract,
	);
	await writeJson(paths.assuranceContractPath, assuranceContract);
	await writeJson(paths.checkerLockPath, checkerLock);
	await writeJson(paths.environmentContractPath, environmentContract);
	await writeJson(paths.proofProgramPath, proofProgram);
	const candidate = await ensureCandidateState(
		mission,
		params.artifactPaths,
		paths,
		proofProgram,
		environmentContract,
	);
	await seedBootstrapJournals({
		mission,
		artifacts,
		paths,
		profile,
		environmentContract,
		proofProgram,
		candidate,
	});
	const preferredLifecycle: MissionV3LifecycleState =
		artifacts.executionPlan.status !== "approved"
			? "blocked_external"
			: iteration != null
				? "executing"
				: "planning";
	const result = await rebuildMissionV3DerivedState({
		mission,
		artifacts,
		artifactPaths: params.artifactPaths,
		paths,
		profile,
		candidate,
		assuranceContract,
		proofProgram,
		environmentContract,
		preferredLifecycle,
	});
	await appendJournalEvent(paths.compactionEventsPath, {
		journalType: "compaction-events",
		missionId: mission.mission_id,
		candidateId: candidate.candidate_id,
		actorPrincipal: "context-compiler",
		idempotencyKey: `context-snapshot:${result.mission.lifecycle_state}:${result.mission.current_iteration}`,
		payload: {
			snapshot_path: paths.currentContextSnapshotPath,
			lifecycle_state: result.mission.lifecycle_state,
			current_iteration: result.mission.current_iteration,
		},
	});
	return result;
}

export async function recordMissionV3LaneSummary(params: {
	mission: MissionState;
	artifacts: MissionOrchestrationArtifacts;
	artifactPaths: MissionOrchestrationArtifactPaths;
	laneType: MissionLaneType;
	summaryPath: string;
	summary: MissionLaneSummary;
	iteration: number;
}): Promise<MissionV3SyncResult> {
	const { mission, artifacts, laneType, summaryPath, summary, iteration } =
		params;
	const paths = missionV3ArtifactPaths(
		mission.mission_root,
		mission.active_candidate_id ?? missionV3CandidateId(),
	);
	await ensureV3Layout(paths);
	const profile = mission.policy_profile as MissionV3PolicyProfile;
	const assuranceContract = await readJson<MissionV3AssuranceContract>(
		paths.assuranceContractPath,
	);
	const proofProgram = await readJson<MissionV3ProofProgram>(
		paths.proofProgramPath,
	);
	const environmentContract = await readJson<MissionV3EnvironmentContract>(
		paths.environmentContractPath,
	);
	const candidate = await ensureCandidateState(
		mission,
		params.artifactPaths,
		paths,
		proofProgram,
		environmentContract,
	);
	const proofLane = missionLaneToProofLane(laneType);
	const obligationIds = proofLane
		? obligationIdsForLane(proofProgram, proofLane)
		: [];
	const evidenceRecordedAt = nowIso();
	const laneRun = await appendJournalEvent(paths.laneRunsPath, {
		journalType: "lane-runs",
		missionId: mission.mission_id,
		candidateId: candidate.candidate_id,
		laneId: `${laneType}:${iteration}`,
		actorPrincipal: `mission-lane:${laneType}`,
		idempotencyKey: `lane-run:${candidate.candidate_id}:${iteration}:${laneType}`,
		payload: {
			lane_run_id: `lane-run:${laneType}:${iteration}`,
			candidate_id: candidate.candidate_id,
			lane_type: proofLane ?? laneType,
			source_lane_type: laneType,
			proof_program_id: proofProgram.proof_program_id,
			attempt_index: 1,
			matrix_target: "matrix:local-node",
			env_attestation_ref:
				(await loadJournal(paths.environmentAttestationsPath)).at(-1)
					?.event_id ?? null,
			checker_refs: proofLane
				? proofProgram.bindings
						.filter((binding) => binding.proof_lane === proofLane)
						.flatMap((binding) => binding.checker_refs)
				: [],
			started_at: summary.provenance.started_at,
			completed_at: summary.provenance.finished_at,
			outcome: summary.verdict.toLowerCase(),
			exit_summary: `${summary.verdict}/${summary.confidence}`,
			produced_artifact_refs: [summaryPath],
			command_attestation_refs: [],
			obligation_ids: obligationIds,
		},
	});
	const command = await appendJournalEvent(paths.commandAttestationsPath, {
		journalType: "command-attestations",
		missionId: mission.mission_id,
		candidateId: candidate.candidate_id,
		laneId: `${laneType}:${iteration}`,
		actorPrincipal: `mission-lane:${laneType}`,
		idempotencyKey: `command-attestation:${candidate.candidate_id}:${iteration}:${laneType}`,
		payload: {
			command_attestation_id: `cmd:${laneType}:${iteration}`,
			lane_run_id: laneRun.event_id,
			checker_id: proofLane
				? (proofProgram.bindings.find(
						(binding) => binding.proof_lane === proofLane,
					)?.checker_refs[0] ?? null)
				: null,
			command_ref: `command:${proofLane ?? laneType}`,
			normalized_argv: [`lane-summary:${laneType}`],
			cwd: relative(mission.repo_root, summaryPath),
			env_hash: environmentContract.declared_environment_hash,
			network_mode: "repo-local",
			write_scope: relative(
				mission.repo_root,
				join(
					mission.mission_root,
					"iterations",
					String(iteration).padStart(3, "0"),
					laneType,
				),
			),
			started_at: summary.provenance.started_at,
			completed_at: summary.provenance.finished_at,
			exit_code:
				summary.verdict === "FAIL"
					? 1
					: summary.verdict === "AMBIGUOUS"
						? 2
						: 0,
			stdout_hash: `sha256:${shortHash(stableJson(summary))}`,
			stderr_hash: null,
			produced_artifact_hashes: [`sha256:${shortHash(stableJson(summary))}`],
		},
	});
	await appendJournalEvent(paths.runtimeObservationsPath, {
		journalType: "runtime-observations",
		missionId: mission.mission_id,
		candidateId: candidate.candidate_id,
		laneId: `${laneType}:${iteration}`,
		actorPrincipal: `mission-lane:${laneType}`,
		idempotencyKey: `runtime-observation:${candidate.candidate_id}:${iteration}:${laneType}`,
		payload: {
			candidate_id: candidate.candidate_id,
			lane_id: `${laneType}:${iteration}`,
			env_hash: environmentContract.declared_environment_hash,
			observed_toolchain: environmentContract.toolchain_versions,
			source_lane_type: laneType,
			observed_at: summary.provenance.finished_at,
		},
	});
	await appendJournalEvent(paths.evidenceEventsPath, {
		journalType: "evidence-events",
		missionId: mission.mission_id,
		candidateId: candidate.candidate_id,
		laneId: `${laneType}:${iteration}`,
		actorPrincipal: `mission-lane:${laneType}`,
		idempotencyKey: `evidence:${candidate.candidate_id}:${iteration}:${laneType}`,
		recordedAt: evidenceRecordedAt,
		payload: {
			evidence_id: `evidence:${laneType}:${iteration}`,
			candidate_id: candidate.candidate_id,
			lane_run_ref: laneRun.event_id,
			command_attestation_refs: [command.event_id],
			obligation_ids: obligationIds,
			evidence_kind: "lane_summary",
			verdict:
				proofLane === "reproduction"
					? "supporting"
					: summary.verdict === "PASS"
						? "supporting"
						: "contradicting",
			summary: `${laneType} lane recorded ${summary.verdict} (${summary.confidence})`,
			artifact_refs: [summaryPath, ...summary.evidence_refs],
			freshness_expires_at: proofLane
				? addSeconds(
						evidenceRecordedAt,
						proofProgram.bindings.find(
							(binding) => binding.proof_lane === proofLane,
						)?.freshness_ttl_seconds ?? 900,
					)
				: addSeconds(evidenceRecordedAt, 900),
		},
	});
	const nextMission = await updateMissionV3State(mission, {
		lifecycle_state: ["audit", "re_audit"].includes(laneType)
			? "assuring"
			: "executing",
	});
	return rebuildMissionV3DerivedState({
		mission: nextMission,
		artifacts,
		artifactPaths: params.artifactPaths,
		paths,
		profile,
		candidate,
		assuranceContract,
		proofProgram,
		environmentContract,
		preferredLifecycle: nextMission.lifecycle_state,
	});
}

export async function syncMissionV3AfterCommit(params: {
	mission: MissionState;
	artifacts: MissionOrchestrationArtifacts;
	artifactPaths: MissionOrchestrationArtifactPaths;
	safetyBaseline: MissionSafetyBaseline;
	iteration: number;
	strategyChanged: boolean;
}): Promise<MissionV3SyncResult> {
	const { mission, artifacts, safetyBaseline, iteration } = params;
	const paths = missionV3ArtifactPaths(
		mission.mission_root,
		mission.active_candidate_id ?? missionV3CandidateId(),
	);
	const profile = mission.policy_profile as MissionV3PolicyProfile;
	const assuranceContract = await readJson<MissionV3AssuranceContract>(
		paths.assuranceContractPath,
	);
	const proofProgram = await readJson<MissionV3ProofProgram>(
		paths.proofProgramPath,
	);
	const environmentContract = await readJson<MissionV3EnvironmentContract>(
		paths.environmentContractPath,
	);
	const candidate = await readJson<MissionV3CandidateState>(
		paths.activeCandidateStatePath,
	);
	const staticAnalysisObligationIds = obligationIdsForLane(
		proofProgram,
		"static-analysis",
	);
	const command = await appendJournalEvent(paths.commandAttestationsPath, {
		journalType: "command-attestations",
		missionId: mission.mission_id,
		candidateId: candidate.candidate_id,
		laneId: `static-analysis:${iteration}`,
		actorPrincipal: "mission-kernel",
		idempotencyKey: `static-analysis:${candidate.candidate_id}:${iteration}:${safetyBaseline.focused_checks_green}`,
		payload: {
			command_attestation_id: `cmd:static-analysis:${iteration}`,
			lane_run_id: null,
			checker_id:
				proofProgram.bindings.find(
					(binding) => binding.proof_lane === "static-analysis",
				)?.checker_refs[0] ?? "checker:mission-static-analysis",
			command_ref: "command:static-analysis",
			normalized_argv: ["focused-checks"],
			cwd: relative(mission.repo_root, mission.mission_root),
			env_hash: environmentContract.declared_environment_hash,
			network_mode: "repo-local",
			write_scope: relative(mission.repo_root, mission.mission_root),
			started_at: mission.updated_at,
			completed_at: nowIso(),
			exit_code: safetyBaseline.focused_checks_green ? 0 : 1,
			stdout_hash: `sha256:${shortHash(stableJson(safetyBaseline))}`,
			stderr_hash: null,
			produced_artifact_hashes: [],
		},
	});
	await appendJournalEvent(paths.evidenceEventsPath, {
		journalType: "evidence-events",
		missionId: mission.mission_id,
		candidateId: candidate.candidate_id,
		laneId: `static-analysis:${iteration}`,
		actorPrincipal: "mission-kernel",
		idempotencyKey: `evidence:static-analysis:${candidate.candidate_id}:${iteration}:${safetyBaseline.focused_checks_green}`,
		payload: {
			evidence_id: `evidence:static-analysis:${iteration}`,
			candidate_id: candidate.candidate_id,
			lane_run_ref: null,
			command_attestation_refs: [command.event_id],
			obligation_ids: staticAnalysisObligationIds,
			evidence_kind: "focused_checks",
			verdict: safetyBaseline.focused_checks_green
				? "supporting"
				: "contradicting",
			summary: safetyBaseline.focused_checks_green
				? "Focused checks passed under the latest iteration commit"
				: "Focused checks failed under the latest iteration commit",
			artifact_refs: [],
			freshness_expires_at: addSeconds(
				nowIso(),
				proofProgram.bindings.find(
					(binding) => binding.proof_lane === "static-analysis",
				)?.freshness_ttl_seconds ?? 900,
			),
		},
	});
	const preferredLifecycle: MissionV3LifecycleState = [
		"complete",
		"running",
	].includes(mission.status)
		? "assuring"
		: mission.lifecycle_state;
	const result = await rebuildMissionV3DerivedState({
		mission,
		artifacts,
		artifactPaths: params.artifactPaths,
		paths,
		profile,
		candidate,
		assuranceContract,
		proofProgram,
		environmentContract,
		preferredLifecycle,
	});
	await appendJournalEvent(paths.promotionEventsPath, {
		journalType: "promotion-events",
		missionId: mission.mission_id,
		candidateId: candidate.candidate_id,
		actorPrincipal: "promotion-governor",
		idempotencyKey: `promotion:${result.promotionDecision.decision}:${result.mission.current_iteration}:${result.mission.lifecycle_state}`,
		payload: {
			decision: result.promotionDecision.decision,
			reasons: result.promotionDecision.reasons,
			lifecycle_state: result.mission.lifecycle_state,
			iteration: result.mission.current_iteration,
		},
	});
	await appendJournalEvent(paths.decisionLogPath, {
		journalType: "decision-log",
		missionId: mission.mission_id,
		candidateId: candidate.candidate_id,
		actorPrincipal: "mission-kernel",
		idempotencyKey: `decision:lifecycle:${result.mission.lifecycle_state}:${result.mission.current_iteration}`,
		payload: {
			decision: "lifecycle_reconciled",
			lifecycle_state: result.mission.lifecycle_state,
			compatibility_status: result.mission.status,
			iteration: result.mission.current_iteration,
			strategy_changed: params.strategyChanged,
		},
	});
	return result;
}

export async function syncMissionV3AfterCancel(params: {
	mission: MissionState;
	artifacts: MissionOrchestrationArtifacts;
	artifactPaths: MissionOrchestrationArtifactPaths;
}): Promise<MissionV3SyncResult> {
	const { mission, artifacts } = params;
	const paths = missionV3ArtifactPaths(
		mission.mission_root,
		mission.active_candidate_id ?? missionV3CandidateId(),
	);
	const profile = mission.policy_profile as MissionV3PolicyProfile;
	const assuranceContract = await readJson<MissionV3AssuranceContract>(
		paths.assuranceContractPath,
	);
	const proofProgram = await readJson<MissionV3ProofProgram>(
		paths.proofProgramPath,
	);
	const environmentContract = await readJson<MissionV3EnvironmentContract>(
		paths.environmentContractPath,
	);
	const candidate = await readJson<MissionV3CandidateState>(
		paths.activeCandidateStatePath,
	);
	await appendJournalEvent(paths.decisionLogPath, {
		journalType: "decision-log",
		missionId: mission.mission_id,
		candidateId: candidate.candidate_id,
		actorPrincipal: "mission-kernel",
		idempotencyKey: `decision:cancel:${mission.status}:${mission.current_iteration}`,
		payload: {
			decision: "mission_cancelled",
			status: mission.status,
			iteration: mission.current_iteration,
			reason: mission.final_reason,
		},
	});
	return rebuildMissionV3DerivedState({
		mission,
		artifacts,
		artifactPaths: params.artifactPaths,
		paths,
		profile,
		candidate,
		assuranceContract,
		proofProgram,
		environmentContract,
		preferredLifecycle:
			mission.status === "cancelled" ? "cancelled" : mission.lifecycle_state,
	});
}

async function loadMissionV3Prerequisites(repoRoot: string, slug: string) {
	const mission = await readJson<MissionState>(
		missionStatePath(join(repoRoot, ".omx", "missions", slug)),
	);
	const artifactPaths = missionV3ArtifactPaths(
		mission.mission_root,
		mission.active_candidate_id ?? missionV3CandidateId(),
	);
	const assuranceContract = await readJson<MissionV3AssuranceContract>(
		artifactPaths.assuranceContractPath,
	);
	const proofProgram = await readJson<MissionV3ProofProgram>(
		artifactPaths.proofProgramPath,
	);
	const environmentContract = await readJson<MissionV3EnvironmentContract>(
		artifactPaths.environmentContractPath,
	);
	const candidates = await loadMissionV3CandidateStates(artifactPaths);
	return {
		mission,
		artifactPaths,
		assuranceContract,
		proofProgram,
		environmentContract,
		candidates,
	};
}

export async function createMissionV3Candidate(
	options: MissionV3CreateCandidateOptions,
): Promise<MissionV3CandidateState> {
	const {
		mission,
		artifactPaths,
		proofProgram,
		environmentContract,
		candidates,
	} = await loadMissionV3Prerequisites(options.repoRoot, options.slug);
	if (!candidateSpawnTriggerAllowed(options.trigger)) {
		throw new Error(`mission_v3_candidate_trigger_invalid:${options.trigger}`);
	}
	if (!options.rationale.trim()) {
		throw new Error("mission_v3_candidate_rationale_required");
	}
	if (
		candidates.length >=
		missionV3CandidateCap(mission.policy_profile as MissionV3PolicyProfile)
	) {
		throw new Error("mission_v3_candidate_cap_exceeded");
	}
	if (
		candidates.some(
			(candidate) =>
				candidate.rationale === options.rationale &&
				!staleCandidateStates().includes(candidate.state),
		)
	) {
		throw new Error("mission_v3_candidate_duplicate_rationale");
	}
	const candidateId = nextMissionV3CandidateId(candidates);
	const generatedAt = nowIso();
	const candidateDir = join(artifactPaths.candidatesDir, candidateId);
	await mkdir(candidateDir, { recursive: true });
	await mkdir(join(candidateDir, "iterations"), { recursive: true });
	await mkdir(join(candidateDir, "assurance", "lane-results"), {
		recursive: true,
	});
	await mkdir(join(candidateDir, "assurance", "evidence"), {
		recursive: true,
	});
	const candidate: MissionV3CandidateState = {
		schema_version: 1,
		generated_at: generatedAt,
		candidate_id: candidateId,
		mission_id: mission.mission_id,
		state: "approved",
		rationale: options.rationale,
		workspace_root: candidateDir,
		proof_program_ref: relative(candidateDir, artifactPaths.proofProgramPath),
		environment_contract_ref: relative(
			candidateDir,
			artifactPaths.environmentContractPath,
		),
		execution_plan_ref: relative(
			candidateDir,
			join(mission.mission_root, "execution-plan.md"),
		),
		parent_candidate_ids: options.parentCandidateIds ?? [],
		latest_lane_run_refs: [],
		latest_evidence_refs: [],
		superseded_by: null,
		selected_at: null,
		updated_at: generatedAt,
	};
	await writeJson(join(candidateDir, "candidate-state.json"), candidate);
	await writeText(
		join(candidateDir, "execution-plan.md"),
		[
			"# Mission V3 Candidate Execution Plan",
			"",
			`- Candidate ID: \`${candidate.candidate_id}\``,
			`- Trigger: \`${options.trigger}\``,
			`- Rationale: ${options.rationale}`,
			"",
			"## Milestones",
			"- Rebuild candidate-local context and contracts",
			"- Run scoped implementation or exploration strategy",
			"- Validate against proof-program obligations before selection",
		].join("\n"),
	);
	await appendJournalEvent(join(candidateDir, "candidate-events.ndjson"), {
		journalType: "candidate-events",
		missionId: mission.mission_id,
		candidateId,
		actorPrincipal: "mission-v3-portfolio",
		idempotencyKey: `candidate-created:${candidateId}`,
		payload: {
			candidate_id: candidateId,
			trigger: options.trigger,
			rationale: options.rationale,
			parent_candidate_ids: options.parentCandidateIds ?? [],
			proof_program_id: proofProgram.proof_program_id,
			environment_contract_id: environmentContract.env_contract_id,
			requested_capabilities: options.requestedCapabilities ?? [],
		},
	});
	await appendJournalEvent(artifactPaths.decisionLogPath, {
		journalType: "decision-log",
		missionId: mission.mission_id,
		candidateId,
		actorPrincipal: "mission-v3-portfolio",
		idempotencyKey: `decision:candidate-created:${candidateId}`,
		payload: {
			decision: "candidate_spawned",
			candidate_id: candidateId,
			trigger: options.trigger,
			rationale: options.rationale,
		},
	});
	const nextMission = await updateMissionV3State(mission, {
		candidate_ids: [...mission.candidate_ids, candidateId],
		plateau_strategy_state: {
			...mission.plateau_strategy_state,
			candidate_expansions:
				(mission.plateau_strategy_state?.candidate_expansions ??
					mission.candidate_ids.length) + 1,
		},
	});
	const tournament = buildCandidateTournament(
		nextMission,
		[...candidates, candidate],
		{
			schema_version: 1,
			generated_at: generatedAt,
			mission_id: mission.mission_id,
			candidate_id: mission.selected_candidate_id,
			obligation_status_table: [],
			blocking_contradictions: [],
			waiver_summary: [],
			stale_evidence_summary: [],
			residual_risk_summary: [],
			recommended_next_state: nextMission.lifecycle_state,
			proof_ready: false,
		},
		{
			schema_version: 1,
			generated_at: generatedAt,
			mission_id: mission.mission_id,
			candidate_id: mission.selected_candidate_id,
			decision: "block",
			reasons: [],
			lifecycle_state: nextMission.lifecycle_state,
			required_artifacts: [],
			policy_blockers: [],
		},
	);
	await writeJson(artifactPaths.candidateTournamentPath, tournament);
	return candidate;
}

export async function selectMissionV3Candidate(
	options: MissionV3SelectionOptions,
): Promise<MissionState> {
	const { mission, artifactPaths, candidates } =
		await loadMissionV3Prerequisites(options.repoRoot, options.slug);
	const selected = candidates.find(
		(candidate) => candidate.candidate_id === options.candidateId,
	);
	if (!selected) {
		throw new Error(`mission_v3_candidate_missing:${options.candidateId}`);
	}
	if (staleCandidateStates().includes(selected.state)) {
		throw new Error(`mission_v3_candidate_not_selectable:${selected.state}`);
	}
	for (const candidate of candidates) {
		if (candidate.candidate_id === selected.candidate_id) continue;
		if (candidate.state === "selected") {
			await writeJson(join(candidate.workspace_root, "candidate-state.json"), {
				...candidate,
				state: "running",
				selected_at: null,
				updated_at: nowIso(),
			});
		}
	}
	await writeJson(join(selected.workspace_root, "candidate-state.json"), {
		...selected,
		state: "selected",
		selected_at: nowIso(),
		updated_at: nowIso(),
	});
	await appendJournalEvent(artifactPaths.decisionLogPath, {
		journalType: "decision-log",
		missionId: mission.mission_id,
		candidateId: selected.candidate_id,
		actorPrincipal: "mission-v3-portfolio",
		idempotencyKey: `decision:candidate-selected:${selected.candidate_id}:${shortHash(options.reason)}`,
		payload: {
			decision: "candidate_selected",
			candidate_id: selected.candidate_id,
			reason: options.reason,
		},
	});
	return updateMissionV3State(mission, {
		active_candidate_id: selected.candidate_id,
		selected_candidate_id: selected.candidate_id,
	});
}

export async function rescindMissionV3CandidateSelection(
	options: MissionV3SelectionOptions,
): Promise<MissionState> {
	const { mission, artifactPaths, candidates } =
		await loadMissionV3Prerequisites(options.repoRoot, options.slug);
	if (["released", "handed_off"].includes(mission.lifecycle_state)) {
		throw new Error(
			`mission_v3_candidate_rescission_forbidden:${mission.lifecycle_state}`,
		);
	}
	const selected = candidates.find(
		(candidate) => candidate.candidate_id === options.candidateId,
	);
	if (!selected || selected.candidate_id !== mission.selected_candidate_id) {
		throw new Error(`mission_v3_candidate_not_selected:${options.candidateId}`);
	}
	await writeJson(join(selected.workspace_root, "candidate-state.json"), {
		...selected,
		state: "blocked",
		selected_at: null,
		updated_at: nowIso(),
	});
	await appendJournalEvent(artifactPaths.decisionLogPath, {
		journalType: "decision-log",
		missionId: mission.mission_id,
		candidateId: selected.candidate_id,
		actorPrincipal: "mission-v3-portfolio",
		idempotencyKey: `decision:candidate-rescinded:${selected.candidate_id}:${shortHash(options.reason)}`,
		payload: {
			decision: "candidate_rescinded",
			candidate_id: selected.candidate_id,
			reason: options.reason,
		},
	});
	const fallbackActiveCandidate = candidates.find(
		(candidate) =>
			candidate.candidate_id !== selected.candidate_id &&
			candidateCanReceiveActiveWrites(candidate),
	);
	return updateMissionV3State(mission, {
		active_candidate_id: fallbackActiveCandidate?.candidate_id ?? null,
		selected_candidate_id: null,
		lifecycle_state:
			mission.lifecycle_state === "promotion_ready" ||
			mission.lifecycle_state === "verified"
				? "assuring"
				: mission.lifecycle_state,
		promotion_state: {
			...mission.promotion_state,
			status: "blocked",
			blocking_reasons: Array.from(
				new Set([
					...(mission.promotion_state.blocking_reasons ?? []),
					`selection rescinded for ${selected.candidate_id}`,
				]),
			),
			last_decision_at: nowIso(),
		},
		kernel_blockers: Array.from(
			new Set([
				...mission.kernel_blockers,
				`selection_rescinded:${selected.candidate_id}`,
			]),
		),
	});
}

export async function hybridizeMissionV3Candidates(
	options: MissionV3CreateCandidateOptions,
): Promise<MissionV3CandidateState> {
	if ((options.parentCandidateIds?.length ?? 0) < 2) {
		throw new Error("mission_v3_hybrid_requires_multiple_parents");
	}
	return createMissionV3Candidate({
		...options,
		trigger: "hybrid",
	});
}

export async function recordMissionV3ReleaseAction(
	options: MissionV3ReleaseOptions,
): Promise<MissionState> {
	const { mission, artifactPaths } = await loadMissionV3Prerequisites(
		options.repoRoot,
		options.slug,
	);
	if (!["promotion_ready", "verified"].includes(mission.lifecycle_state)) {
		throw new Error(
			`mission_v3_release_requires_promotion_ready:${mission.lifecycle_state}`,
		);
	}
	if (!mission.selected_candidate_id) {
		throw new Error("mission_v3_release_requires_selected_candidate");
	}
	const actionPath =
		options.action === "released"
			? artifactPaths.releaseRecordPath
			: artifactPaths.handoffRecordPath;
	const generatedAt = nowIso();
	await writeJson(actionPath, {
		schema_version: 1,
		generated_at: generatedAt,
		mission_id: mission.mission_id,
		candidate_id: mission.selected_candidate_id,
		action: options.action,
		actor: options.actor,
		summary: options.summary,
		destination: options.destination ?? null,
	});
	await appendJournalEvent(artifactPaths.promotionEventsPath, {
		journalType: "promotion-events",
		missionId: mission.mission_id,
		candidateId: mission.selected_candidate_id,
		actorPrincipal: options.actor,
		idempotencyKey: `promotion-action:${options.action}:${shortHash(options.summary)}`,
		payload: {
			action: options.action,
			summary: options.summary,
			destination: options.destination ?? null,
			record_path: actionPath,
		},
	});
	await appendJournalEvent(artifactPaths.decisionLogPath, {
		journalType: "decision-log",
		missionId: mission.mission_id,
		candidateId: mission.selected_candidate_id,
		actorPrincipal: options.actor,
		idempotencyKey: `decision:${options.action}:${shortHash(options.summary)}`,
		payload: {
			decision: options.action,
			summary: options.summary,
			destination: options.destination ?? null,
		},
	});
	return updateMissionV3State(mission, {
		lifecycle_state: options.action,
		status: "complete",
		promotion_state: {
			...mission.promotion_state,
			status: options.action,
			last_decision_at: generatedAt,
			decision_ref: actionPath,
		},
		final_reason: options.summary,
	});
}

export async function loadMissionV3ArtifactRoles(
	missionRoot: string,
	candidateId = missionV3CandidateId(),
): Promise<
	Array<{
		path: string;
		role: "authoritative" | "append_only" | "canonical" | "derived";
	}>
> {
	const paths = missionV3ArtifactPaths(missionRoot, candidateId);
	return [
		{ path: paths.assuranceContractPath, role: "canonical" },
		{ path: paths.proofProgramPath, role: "canonical" },
		{ path: paths.checkerLockPath, role: "canonical" },
		{ path: paths.environmentContractPath, role: "canonical" },
		{ path: paths.activeCandidateStatePath, role: "authoritative" },
		{ path: paths.environmentAttestationsPath, role: "append_only" },
		{ path: paths.laneRunsPath, role: "append_only" },
		{ path: paths.commandAttestationsPath, role: "append_only" },
		{ path: paths.evidenceEventsPath, role: "append_only" },
		{ path: paths.policyDecisionsPath, role: "append_only" },
		{ path: paths.promotionEventsPath, role: "append_only" },
		{ path: paths.environmentCurrentPath, role: "derived" },
		{ path: paths.policySnapshotPath, role: "derived" },
		{ path: paths.impactMapPath, role: "derived" },
		{ path: paths.evidenceGraphPath, role: "derived" },
		{ path: paths.adjudicationPath, role: "derived" },
		{ path: paths.promotionDecisionPath, role: "derived" },
		{ path: paths.releaseRecordPath, role: "derived" },
		{ path: paths.handoffRecordPath, role: "derived" },
		{ path: paths.qualityWatchdogPath, role: "derived" },
		{ path: paths.uncertaintyRegisterPath, role: "derived" },
		{ path: paths.currentContextSnapshotPath, role: "derived" },
		{ path: paths.statusLedgerPath, role: "derived" },
		{ path: paths.candidateTournamentPath, role: "derived" },
		{ path: paths.traceBundlePath, role: "derived" },
		{ path: paths.evalBundlePath, role: "derived" },
		{ path: paths.postmortemPath, role: "derived" },
		{ path: join(paths.learningProposalsDir, "current.json"), role: "derived" },
	];
}
