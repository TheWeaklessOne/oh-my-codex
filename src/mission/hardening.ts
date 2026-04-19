import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type {
	MissionHardeningGatePolicy,
} from "./contracts.js";

export interface MissionHardeningVerificationResult {
	status: "pass" | "fail" | "skipped";
	command_refs: string[];
	evidence_refs: string[];
	completed_at: string | null;
}

export interface MissionHardeningReviewCycle {
	cycle_number: number;
	review_engine: string;
	review_report_ref: string | null;
	blocking_findings: number;
	verification: MissionHardeningVerificationResult | null;
	completed_at: string | null;
}

export interface MissionHardeningFinalReview {
	review_engine: string;
	review_report_ref: string | null;
	blocking_findings: number;
	status: "pass" | "fail" | "missing";
	completed_at: string | null;
}

export interface MissionHardeningReport {
	schema_version: 1;
	generated_at: string;
	gate_policy: MissionHardeningGatePolicy;
	status: "passed" | "failed" | "skipped";
	failure_reason: string | null;
	changed_files_ref: string | null;
	review_cycles: MissionHardeningReviewCycle[];
	deslop_report_ref: string | null;
	post_deslop_verification: MissionHardeningVerificationResult | null;
	final_review: MissionHardeningFinalReview | null;
	blocking_findings_remaining: number;
	completed_at: string | null;
	artifact_refs: string[];
}

export interface MissionHardeningArtifactPaths {
	lane_root: string;
	summaryPath: string;
	gateResultPath: string;
	deslopReportPath: string;
	finalReviewPath: string;
	reviewCyclePath: (cycle: number) => string;
}

export interface MissionPolicyProfileLike {
	risk_class?: string | null;
	assurance_profile?: string | null;
}

function normalizeRefList(values: readonly string[]): string[] {
	return Array.from(
		new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean)),
	);
}

export function missionHardeningArtifactPaths(
	laneRoot: string,
): MissionHardeningArtifactPaths {
	return {
		lane_root: laneRoot,
		summaryPath: join(laneRoot, "summary.json"),
		gateResultPath: join(laneRoot, "gate-result.json"),
		deslopReportPath: join(laneRoot, "deslop-report.md"),
		finalReviewPath: join(laneRoot, "final-review.json"),
		reviewCyclePath: (cycle: number) =>
			join(laneRoot, `review-cycle-${cycle}.json`),
	};
}

export function deriveMissionHardeningGatePolicy(params: {
	policyProfile?: MissionPolicyProfileLike | null;
	highRisk?: boolean;
} = {}): MissionHardeningGatePolicy {
	const assuranceProfile = String(
		params.policyProfile?.assurance_profile ?? "",
	)
		.trim()
		.toLowerCase();
	const riskClass = String(params.policyProfile?.risk_class ?? "")
		.trim()
		.toLowerCase();
	const required =
		params.highRisk === true ||
		assuranceProfile === "high" ||
		assuranceProfile === "max-quality" ||
		riskClass === "security-sensitive" ||
		riskClass === "release-blocking";
	return {
		mode: required ? "required" : "optional",
		review_engine: "codex-parallel-review",
		fallback_review_engines: [],
		max_review_fix_cycles: 2,
		deslop_policy: "changed-files-final-pass",
		final_sanity_review: "required",
	};
}

export function missionHardeningGateIsRequired(
	policy: MissionHardeningGatePolicy | null | undefined,
): boolean {
	return policy?.mode === "required";
}

export function collectMissionHardeningArtifactRefs(
	repoRoot: string,
	laneRoot: string,
	report?: MissionHardeningReport | null,
): string[] {
	const paths = missionHardeningArtifactPaths(laneRoot);
	const refs = [
		paths.gateResultPath,
		paths.finalReviewPath,
		paths.deslopReportPath,
		...(report?.review_cycles ?? []).map((cycle) =>
			paths.reviewCyclePath(cycle.cycle_number),
		),
		...(report?.artifact_refs ?? []).map((value) =>
			join(laneRoot, value),
		),
	];
	return normalizeRefList(
		refs
			.filter((artifactPath) => existsSync(artifactPath))
			.map((artifactPath) => relative(repoRoot, artifactPath)),
	);
}

export async function readMissionHardeningReport(
	filePath: string,
): Promise<MissionHardeningReport | null> {
	if (!existsSync(filePath)) return null;
	return JSON.parse(
		await readFile(filePath, "utf-8"),
	) as MissionHardeningReport;
}

export async function readMissionHardeningReportFromLaneRoot(
	laneRoot: string,
): Promise<MissionHardeningReport | null> {
	return readMissionHardeningReport(
		missionHardeningArtifactPaths(laneRoot).gateResultPath,
	);
}

export function validateMissionHardeningReport(
	report: MissionHardeningReport,
	policy: MissionHardeningGatePolicy = report.gate_policy,
): string[] {
	const errors: string[] = [];
	if (report.review_cycles.length > policy.max_review_fix_cycles) {
		errors.push(
			`hardening_report_cycle_limit_exceeded:${report.review_cycles.length}:${policy.max_review_fix_cycles}`,
		);
	}
	if (!report.final_review || report.final_review.status === "missing") {
		errors.push("hardening_report_final_review_missing");
	} else if (report.final_review.status !== "pass") {
		errors.push(
			`hardening_report_final_review_not_green:${report.final_review.status}`,
		);
	}
	if (policy.deslop_policy !== "disabled") {
		if (!report.post_deslop_verification) {
			errors.push("hardening_report_post_deslop_verification_missing");
		} else if (report.post_deslop_verification.status !== "pass") {
			errors.push(
				`hardening_report_post_deslop_verification_not_green:${report.post_deslop_verification.status}`,
			);
		}
	}
	if (report.blocking_findings_remaining > 0) {
		errors.push(
			`hardening_report_blocking_findings_remaining:${report.blocking_findings_remaining}`,
		);
	}
	if (report.status === "passed" && !report.completed_at) {
		errors.push("hardening_report_completed_at_missing");
	}
	return errors;
}
