import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	collectMissionHardeningArtifactRefs,
	deriveMissionHardeningGatePolicy,
	missionHardeningArtifactPaths,
	validateMissionHardeningReport,
	type MissionHardeningReport,
} from "../hardening.js";

function report(
	overrides: Partial<MissionHardeningReport> = {},
): MissionHardeningReport {
	return {
		schema_version: 1,
		generated_at: "2026-04-18T18:00:00.000Z",
		gate_policy: deriveMissionHardeningGatePolicy({
			policyProfile: {
				risk_class: "security-sensitive",
				assurance_profile: "max-quality",
			},
		}),
		status: "passed",
		failure_reason: null,
		changed_files_ref: ".omx/ralph/changed-files.txt",
		review_cycles: [
			{
				cycle_number: 1,
				review_engine: "codex-parallel-review",
				review_report_ref: "review-cycle-1.md",
				blocking_findings: 0,
				verification: {
					status: "pass",
					command_refs: ["npm run build"],
					evidence_refs: ["logs/build.txt"],
					completed_at: "2026-04-18T18:03:00.000Z",
				},
				completed_at: "2026-04-18T18:03:00.000Z",
			},
		],
		deslop_report_ref: "deslop-report.md",
		post_deslop_verification: {
			status: "pass",
			command_refs: ["npm run lint"],
			evidence_refs: ["logs/lint.txt"],
			completed_at: "2026-04-18T18:04:00.000Z",
		},
		final_review: {
			review_engine: "codex-parallel-review",
			review_report_ref: "final-review.json",
			blocking_findings: 0,
			status: "pass",
			completed_at: "2026-04-18T18:05:00.000Z",
		},
		blocking_findings_remaining: 0,
		completed_at: "2026-04-18T18:05:00.000Z",
		artifact_refs: ["review-cycle-1.json", "deslop-report.md", "final-review.json"],
		...overrides,
	};
}

describe("mission hardening helpers", () => {
	it("resolves artifact paths under both lane roots and candidate mirrors", () => {
		const laneRoot = "/repo/.omx/missions/demo/iterations/001/hardening";
		const candidateRoot =
			"/repo/.omx/missions/demo/candidates/candidate-007/iterations/001/hardening";
		const lanePaths = missionHardeningArtifactPaths(laneRoot);
		const candidatePaths = missionHardeningArtifactPaths(candidateRoot);

		assert.equal(lanePaths.gateResultPath, `${laneRoot}/gate-result.json`);
		assert.equal(lanePaths.reviewCyclePath(2), `${laneRoot}/review-cycle-2.json`);
		assert.equal(
			candidatePaths.finalReviewPath,
			`${candidateRoot}/final-review.json`,
		);
		assert.equal(
			candidatePaths.summaryPath,
			`${candidateRoot}/summary.json`,
		);
	});

	it("derives optional vs required hardening from mission policy profiles", () => {
		assert.equal(
			deriveMissionHardeningGatePolicy({
				policyProfile: {
					risk_class: "low-risk-local",
					assurance_profile: "balanced",
				},
			}).mode,
			"optional",
		);
		assert.equal(
			deriveMissionHardeningGatePolicy({
				policyProfile: {
					risk_class: "cross-cutting-refactor",
					assurance_profile: "high",
				},
			}).mode,
			"required",
		);
		assert.equal(
			deriveMissionHardeningGatePolicy({
				policyProfile: {
					risk_class: "security-sensitive",
					assurance_profile: "max-quality",
				},
			}).mode,
			"required",
		);
	});

	it("validates hardening reports for final review, post-deslop verification, and blocking findings", () => {
		assert.deepEqual(validateMissionHardeningReport(report()), []);
		assert.deepEqual(
			validateMissionHardeningReport(
				report({
					final_review: null,
				}),
			),
			["hardening_report_final_review_missing"],
		);
		assert.deepEqual(
			validateMissionHardeningReport(
				report({
					post_deslop_verification: null,
				}),
			),
			["hardening_report_post_deslop_verification_missing"],
		);
		assert.deepEqual(
			validateMissionHardeningReport(
				report({
					blocking_findings_remaining: 2,
				}),
			),
			["hardening_report_blocking_findings_remaining:2"],
		);
		assert.deepEqual(
			validateMissionHardeningReport(
				report({
					review_cycles: [
						report().review_cycles[0]!,
						{
							...report().review_cycles[0]!,
							cycle_number: 2,
						},
						{
							...report().review_cycles[0]!,
							cycle_number: 3,
						},
					],
				}),
			),
			["hardening_report_cycle_limit_exceeded:3:2"],
		);
	});

	it("collects existing hardening artifact refs relative to the repo root", async () => {
		const repo = await mkdtemp(join(tmpdir(), "omx-mission-hardening-"));
		try {
			const laneRoot = join(
				repo,
				".omx",
				"missions",
				"demo",
				"candidates",
				"candidate-001",
				"iterations",
				"001",
				"hardening",
			);
			const paths = missionHardeningArtifactPaths(laneRoot);
			await mkdir(laneRoot, { recursive: true });
			await writeFile(paths.gateResultPath, JSON.stringify(report(), null, 2));
			await writeFile(paths.finalReviewPath, JSON.stringify({ ok: true }, null, 2));
			await writeFile(paths.deslopReportPath, "# deslop\n");
			await writeFile(paths.reviewCyclePath(1), JSON.stringify({ ok: true }, null, 2));

			assert.deepEqual(collectMissionHardeningArtifactRefs(repo, laneRoot, report()), [
				".omx/missions/demo/candidates/candidate-001/iterations/001/hardening/gate-result.json",
				".omx/missions/demo/candidates/candidate-001/iterations/001/hardening/final-review.json",
				".omx/missions/demo/candidates/candidate-001/iterations/001/hardening/deslop-report.md",
				".omx/missions/demo/candidates/candidate-001/iterations/001/hardening/review-cycle-1.json",
			]);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});
});
