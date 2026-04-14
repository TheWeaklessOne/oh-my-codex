import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	MISSION_LANE_POLICIES,
	type MissionLaneSummaryInput,
} from "../contracts.js";
import { prepareMissionLaneExecutionEnvelopes } from "../isolation.js";
import {
	cancelMission,
	commitIteration,
	computeDelta,
	createMission,
	loadMission,
	recordLaneSummary,
	startIteration,
} from "../kernel.js";

async function initRepo(): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), "omx-mission-kernel-"));
	execFileSync("git", ["init"], { cwd, stdio: "ignore" });
	execFileSync("git", ["config", "user.email", "test@example.com"], {
		cwd,
		stdio: "ignore",
	});
	execFileSync("git", ["config", "user.name", "Test User"], {
		cwd,
		stdio: "ignore",
	});
	await writeFile(join(cwd, "README.md"), "hello\n", "utf-8");
	execFileSync("git", ["add", "README.md"], { cwd, stdio: "ignore" });
	execFileSync("git", ["commit", "-m", "init"], { cwd, stdio: "ignore" });
	return cwd;
}

function laneSummary(
	laneType: "audit" | "remediation" | "execution" | "hardening" | "re_audit",
	iteration: number,
	overrides: Partial<{
		verdict: "PASS" | "PARTIAL" | "FAIL" | "AMBIGUOUS";
		confidence: "high" | "medium" | "low";
		summary: string;
		severity: "critical" | "high" | "medium" | "low" | "info";
		readOnly: boolean;
		runToken: string;
	}> = {},
): MissionLaneSummaryInput {
	return {
		verdict: overrides.verdict ?? "PASS",
		confidence: overrides.confidence ?? "high",
		residuals:
			overrides.verdict === "PASS"
				? []
				: [
						{
							title: "Residual task remains",
							summary: overrides.summary ?? "Residual task remains",
							severity: overrides.severity ?? "medium",
							target_path: "src/mission/kernel.ts",
							symbol: "commitIteration",
						},
					],
		evidence_refs: ["logs/e2e.txt"],
		recommended_next_action:
			overrides.verdict === "PASS" ? "close mission" : "keep iterating",
		provenance: {
			lane_id: `${laneType}-lane-${iteration}`,
			session_id: `${laneType}-session-${iteration}`,
			lane_type: laneType,
			runner_type: MISSION_LANE_POLICIES[laneType].runnerType,
			adapter_version: "mission-adapter/v1",
			started_at: "2026-04-11T17:00:00.000Z",
			finished_at: "2026-04-11T17:05:00.000Z",
			parent_iteration: iteration,
			trigger_reason: `${laneType} stage`,
			...(overrides.readOnly === true ? { read_only: true } : {}),
			...(overrides.runToken ? { run_token: overrides.runToken } : {}),
		},
	};
}

async function recordRequiredLaneSummaries(
	repo: string,
	slug: string,
	iteration: number,
	reAuditInput: MissionLaneSummaryInput,
	options: { includeHardening?: boolean } = {},
): Promise<void> {
	await recordLaneSummary(
		repo,
		slug,
		iteration,
		"audit",
		laneSummary("audit", iteration, { verdict: "PASS", readOnly: true }),
	);
	await recordLaneSummary(
		repo,
		slug,
		iteration,
		"remediation",
		laneSummary("remediation", iteration, { verdict: "PASS" }),
	);
	await recordLaneSummary(
		repo,
		slug,
		iteration,
		"execution",
		laneSummary("execution", iteration, { verdict: "PASS" }),
	);
	if (options.includeHardening === true) {
		await recordLaneSummary(
			repo,
			slug,
			iteration,
			"hardening",
			laneSummary("hardening", iteration, { verdict: "PASS" }),
		);
	}
	await recordLaneSummary(repo, slug, iteration, "re_audit", reAuditInput);
}

describe("mission kernel", () => {
	it("bootstraps mission state and rejects same-target collisions", async () => {
		const repo = await initRepo();
		try {
			const mission = await createMission({
				repoRoot: repo,
				slug: "demo",
				targetFingerprint: "repo:demo",
			});
			assert.equal(mission.status, "running");
			assert.equal(mission.current_iteration, 1);
			assert.equal(
				existsSync(join(repo, ".omx", "missions", "demo", "mission.json")),
				true,
			);

			await assert.rejects(
				() =>
					createMission({
						repoRoot: repo,
						slug: "demo-copy",
						targetFingerprint: "repo:demo",
					}),
				/mission_target_collision/i,
			);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("creates the mission iteration layout and keeps latest.json absent until commit", async () => {
		const repo = await initRepo();
		try {
			await createMission({
				repoRoot: repo,
				slug: "demo",
				targetFingerprint: "repo:demo",
			});
			const handle = await startIteration(repo, "demo", "initial");
			assert.equal(handle.iteration, 1);
			assert.equal(
				existsSync(join(handle.iterationDir, "audit", "summary.json")),
				false,
			);
			assert.equal(
				existsSync(join(repo, ".omx", "missions", "demo", "latest.json")),
				false,
			);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("seeds active lanes with the canonical runner mapping for a fresh iteration", async () => {
		const repo = await initRepo();
		try {
			await createMission({
				repoRoot: repo,
				slug: "demo",
				targetFingerprint: "repo:demo",
			});
			await startIteration(repo, "demo", "initial");

			const mission = await loadMission(repo, "demo");
			assert.equal(mission.current_stage, "audit");
			assert.deepEqual(
				Object.fromEntries(
					mission.active_lanes.map((lane) => [
						lane.lane_type,
						lane.runner_type,
					]),
				),
				{
					audit: "direct",
					remediation: "direct",
					execution: "team",
					re_audit: "direct",
				},
			);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("writes lane summaries once and ignores superseded or cancelled writes deterministically", async () => {
		const repo = await initRepo();
		try {
			await createMission({
				repoRoot: repo,
				slug: "demo",
				targetFingerprint: "repo:demo",
			});
			await startIteration(repo, "demo", "initial");
			const first = await recordLaneSummary(
				repo,
				"demo",
				1,
				"audit",
				laneSummary("audit", 1, { verdict: "PARTIAL", readOnly: true }),
			);
			const duplicate = await recordLaneSummary(
				repo,
				"demo",
				1,
				"audit",
				laneSummary("audit", 1, { verdict: "PARTIAL", readOnly: true }),
			);
			assert.equal(first.status, "written");
			assert.equal(duplicate.status, "duplicate");

			const cancelled = await cancelMission(repo, "demo");
			assert.equal(cancelled.status, "cancelling");
			const late = await recordLaneSummary(
				repo,
				"demo",
				1,
				"re_audit",
				laneSummary("re_audit", 1, { verdict: "PASS", readOnly: true }),
			);
			assert.equal(late.status, "ignored");
			assert.equal(late.reason, "cancelled");

			for (const lane of ["remediation", "execution"] as const) {
				await recordLaneSummary(
					repo,
					"demo",
					1,
					lane,
					laneSummary(lane, 1, { verdict: "PASS" }),
				);
			}
			const reconciled = await loadMission(repo, "demo");
			assert.equal(reconciled.status, "cancelled");
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("commits a full iteration, writes delta/latest, and closes only on fresh PASS plus green safety baseline", async () => {
		const repo = await initRepo();
		try {
			await createMission({
				repoRoot: repo,
				slug: "demo",
				targetFingerprint: "repo:demo",
			});
			await startIteration(repo, "demo", "initial");
			await recordRequiredLaneSummaries(
				repo,
				"demo",
				1,
				laneSummary("re_audit", 1, {
					verdict: "PASS",
					confidence: "high",
					readOnly: true,
				}),
			);

			const committed = await commitIteration(repo, "demo", 1, {
				iteration_commit_succeeded: true,
				no_unreconciled_lane_errors: true,
				focused_checks_green: true,
			});

			assert.equal(committed.mission.status, "complete");
			assert.equal(
				existsSync(join(repo, ".omx", "missions", "demo", "latest.json")),
				true,
			);
			assert.equal(
				existsSync(
					join(
						repo,
						".omx",
						"missions",
						"demo",
						"iterations",
						"001",
						"delta.json",
					),
				),
				true,
			);

			const latest = JSON.parse(
				await readFile(
					join(repo, ".omx", "missions", "demo", "latest.json"),
					"utf-8",
				),
			) as { latest_verdict: string };
			assert.equal(latest.latest_verdict, "PASS");
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("allows commitIteration to succeed without a hardening summary when the fallback was not needed", async () => {
		const repo = await initRepo();
		try {
			await createMission({
				repoRoot: repo,
				slug: "demo",
				targetFingerprint: "repo:demo",
			});
			await startIteration(repo, "demo", "initial");
			await recordRequiredLaneSummaries(
				repo,
				"demo",
				1,
				laneSummary("re_audit", 1, {
					verdict: "PASS",
					confidence: "high",
					readOnly: true,
				}),
			);

			const committed = await commitIteration(repo, "demo", 1, {
				iteration_commit_succeeded: true,
				no_unreconciled_lane_errors: true,
				focused_checks_green: true,
			});

			assert.equal(committed.mission.status, "complete");
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("refuses to close the mission when re-audit reuses execution provenance", async () => {
		const repo = await initRepo();
		try {
			await createMission({
				repoRoot: repo,
				slug: "demo",
				targetFingerprint: "repo:demo",
			});
			await startIteration(repo, "demo", "initial");
			await recordLaneSummary(
				repo,
				"demo",
				1,
				"audit",
				laneSummary("audit", 1, { verdict: "PASS", readOnly: true }),
			);
			await recordLaneSummary(
				repo,
				"demo",
				1,
				"remediation",
				laneSummary("remediation", 1, { verdict: "PASS" }),
			);
			await recordLaneSummary(
				repo,
				"demo",
				1,
				"execution",
				laneSummary("execution", 1, { verdict: "PASS" }),
			);
			await recordLaneSummary(repo, "demo", 1, "re_audit", {
				...laneSummary("re_audit", 1, { verdict: "PASS", readOnly: true }),
				provenance: {
					...laneSummary("re_audit", 1, { verdict: "PASS", readOnly: true })
						.provenance,
					session_id: "execution-session-1",
					lane_id: "execution-lane-1",
				},
			});

			const committed = await commitIteration(repo, "demo", 1, {
				iteration_commit_succeeded: true,
				no_unreconciled_lane_errors: true,
				focused_checks_green: true,
			});

			assert.equal(committed.mission.status, "running");
			assert.match(
				committed.judgement.reason,
				/re-audit lane must not reuse execution lane identity/i,
			);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("refuses to close the mission when verifier summaries do not match the verifier envelope tokens", async () => {
		const repo = await initRepo();
		try {
			await createMission({
				repoRoot: repo,
				slug: "demo",
				targetFingerprint: "repo:demo",
			});
			await startIteration(repo, "demo", "initial");
			const mission = await loadMission(repo, "demo");
			const envelopes = await prepareMissionLaneExecutionEnvelopes(mission, 1);

			await recordLaneSummary(
				repo,
				"demo",
				1,
				"audit",
				laneSummary("audit", 1, {
					verdict: "PASS",
					readOnly: true,
					runToken: envelopes.audit.provenance_binding_token,
				}),
			);
			await recordLaneSummary(
				repo,
				"demo",
				1,
				"remediation",
				laneSummary("remediation", 1, { verdict: "PASS" }),
			);
			await recordLaneSummary(
				repo,
				"demo",
				1,
				"execution",
				laneSummary("execution", 1, { verdict: "PASS" }),
			);
			await recordLaneSummary(
				repo,
				"demo",
				1,
				"re_audit",
				laneSummary("re_audit", 1, {
					verdict: "PASS",
					readOnly: true,
					runToken: "lane-token:forged",
				}),
			);

			const result = await commitIteration(repo, "demo", 1, {
				iteration_commit_succeeded: true,
				no_unreconciled_lane_errors: true,
				focused_checks_green: true,
			});

			assert.equal(result.mission.status, "running");
			assert.match(
				result.judgement.reason,
				/re-audit lane must match the verifier execution envelope binding token/i,
			);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("plateaus deterministically after repeated unchanged residuals once strategy changes", async () => {
		const repo = await initRepo();
		try {
			await createMission({
				repoRoot: repo,
				slug: "demo",
				targetFingerprint: "repo:demo",
				plateauPolicy: { max_unchanged_iterations: 1 },
			});

			await startIteration(repo, "demo", "strategy-a");
			await recordRequiredLaneSummaries(
				repo,
				"demo",
				1,
				laneSummary("re_audit", 1, {
					verdict: "PARTIAL",
					confidence: "high",
					summary: "Residual wording drift remains",
					readOnly: true,
				}),
			);
			const firstCommit = await commitIteration(
				repo,
				"demo",
				1,
				{
					iteration_commit_succeeded: true,
					no_unreconciled_lane_errors: true,
					focused_checks_green: true,
				},
				false,
			);
			assert.equal(firstCommit.mission.status, "running");

			await startIteration(repo, "demo", "strategy-b");
			await recordRequiredLaneSummaries(
				repo,
				"demo",
				2,
				laneSummary("re_audit", 2, {
					verdict: "PARTIAL",
					confidence: "high",
					summary: "Wording drift still remains",
					readOnly: true,
				}),
			);
			const secondCommit = await commitIteration(
				repo,
				"demo",
				2,
				{
					iteration_commit_succeeded: true,
					no_unreconciled_lane_errors: true,
					focused_checks_green: true,
				},
				true,
			);

			assert.equal(secondCommit.mission.status, "plateau");
			assert.match(secondCommit.judgement.reason, /plateau/i);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("resumes the current iteration without duplicating directories and keeps latest readable after partial progress", async () => {
		const repo = await initRepo();
		try {
			await createMission({
				repoRoot: repo,
				slug: "demo",
				targetFingerprint: "repo:demo",
			});
			const first = await startIteration(repo, "demo", "initial");
			await recordLaneSummary(
				repo,
				"demo",
				1,
				"audit",
				laneSummary("audit", 1, { verdict: "PARTIAL", readOnly: true }),
			);
			const resumed = await startIteration(repo, "demo", "initial");

			assert.equal(resumed.iteration, first.iteration);
			assert.equal(resumed.resumed, true);

			const mission = await loadMission(repo, "demo");
			assert.equal(mission.current_iteration, 1);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("does not complete on low-confidence or ambiguous oracle output even with a green baseline", async () => {
		const repo = await initRepo();
		try {
			await createMission({
				repoRoot: repo,
				slug: "demo",
				targetFingerprint: "repo:demo",
				plateauPolicy: { max_ambiguous_iterations: 1 },
			});

			await startIteration(repo, "demo", "initial");
			await recordRequiredLaneSummaries(repo, "demo", 1, {
				verdict: "PASS",
				confidence: "low",
				residuals: [],
				evidence_refs: ["logs/low-confidence.txt"],
				recommended_next_action: "re-run verifier with stronger evidence",
				provenance: {
					lane_id: "re-audit-low-confidence",
					session_id: "re-audit-low-confidence",
					lane_type: "re_audit",
					runner_type: "direct",
					adapter_version: "mission-adapter/v1",
					started_at: "2026-04-11T17:00:00.000Z",
					finished_at: "2026-04-11T17:05:00.000Z",
					parent_iteration: 1,
					trigger_reason: "low-confidence re-audit",
					read_only: true,
				},
			});

			const lowConfidenceCommit = await commitIteration(repo, "demo", 1, {
				iteration_commit_succeeded: true,
				no_unreconciled_lane_errors: true,
				focused_checks_green: true,
			});
			assert.equal(lowConfidenceCommit.mission.status, "running");

			await startIteration(repo, "demo", "ambiguous-follow-up");
			await recordRequiredLaneSummaries(repo, "demo", 2, {
				verdict: "AMBIGUOUS",
				confidence: "low",
				residuals: [
					{
						summary: "Verifier could not decide whether the mission is closed.",
						severity: "medium",
						low_confidence_marker: true,
					},
				],
				evidence_refs: ["logs/ambiguous.txt"],
				recommended_next_action: "retry oracle",
				provenance: {
					lane_id: "re-audit-ambiguous",
					session_id: "re-audit-ambiguous",
					lane_type: "re_audit",
					runner_type: "direct",
					adapter_version: "mission-adapter/v1",
					started_at: "2026-04-11T17:06:00.000Z",
					finished_at: "2026-04-11T17:10:00.000Z",
					parent_iteration: 2,
					trigger_reason: "ambiguous re-audit",
					read_only: true,
				},
			});

			const ambiguousCommit = await commitIteration(repo, "demo", 2, {
				iteration_commit_succeeded: true,
				no_unreconciled_lane_errors: true,
				focused_checks_green: true,
			});
			assert.equal(ambiguousCommit.mission.status, "plateau");
			assert.match(ambiguousCommit.judgement.reason, /ambiguous/i);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("tracks split lineage and low-confidence markers during kernel delta comparison", async () => {
		const repo = await initRepo();
		try {
			await createMission({
				repoRoot: repo,
				slug: "demo",
				targetFingerprint: "repo:demo",
			});
			await startIteration(repo, "demo", "initial");
			await recordRequiredLaneSummaries(repo, "demo", 1, {
				verdict: "PARTIAL",
				confidence: "high",
				residuals: [
					{
						stable_id: "residual:shared-parent",
						title: "Execution lane leaked into audit lane",
						summary: "Audit lane reused execution context.",
						severity: "high",
						category: "fresh-lane-isolation",
						closure_condition: "audit and execution provenance must differ",
						target_path: "src/mission/kernel.ts",
						symbol: "computeDelta",
					},
				],
				evidence_refs: ["logs/iter-1.txt"],
				recommended_next_action: "split residuals by failing lane pair",
				provenance: {
					lane_id: "re-audit-lane-1",
					session_id: "re-audit-session-1",
					lane_type: "re_audit",
					runner_type: "direct",
					adapter_version: "mission-adapter/v1",
					started_at: "2026-04-11T17:00:00.000Z",
					finished_at: "2026-04-11T17:05:00.000Z",
					parent_iteration: 1,
					trigger_reason: "initial re-audit",
					read_only: true,
				},
			});
			await commitIteration(repo, "demo", 1, {
				iteration_commit_succeeded: true,
				no_unreconciled_lane_errors: true,
				focused_checks_green: true,
			});

			await startIteration(repo, "demo", "lineage-follow-up");
			await recordRequiredLaneSummaries(repo, "demo", 2, {
				verdict: "PARTIAL",
				confidence: "low",
				residuals: [
					{
						title: "Audit lane reused execution session",
						summary: "Audit lane session still overlaps execution.",
						severity: "medium",
						category: "fresh-lane-isolation",
						closure_condition: "audit and execution provenance must differ",
						target_path: "src/mission/kernel.ts",
						symbol: "computeDelta",
						lineage: {
							kind: "split",
							related_residual_ids: ["residual:shared-parent"],
						},
					},
					{
						title: "Re-audit lane reused hardening session",
						summary: "Re-audit still overlaps a hardening lane.",
						severity: "medium",
						category: "fresh-lane-isolation",
						closure_condition: "re audit and hardening provenance must differ",
						target_path: "src/mission/kernel.ts",
						symbol: "computeDelta",
						lineage: {
							kind: "split",
							related_residual_ids: ["residual:shared-parent"],
						},
						low_confidence_marker: true,
					},
				],
				evidence_refs: ["logs/iter-2.txt"],
				recommended_next_action: "keep separate provenance fixes",
				provenance: {
					lane_id: "re-audit-lane-2",
					session_id: "re-audit-session-2",
					lane_type: "re_audit",
					runner_type: "direct",
					adapter_version: "mission-adapter/v1",
					started_at: "2026-04-11T17:06:00.000Z",
					finished_at: "2026-04-11T17:10:00.000Z",
					parent_iteration: 2,
					trigger_reason: "follow-up re-audit",
					read_only: true,
				},
			});

			const delta = await computeDelta(repo, "demo", 2);
			assert.deepEqual(delta.lineage_split_residual_ids, [
				"residual:shared-parent",
			]);
			assert.equal(delta.introduced_residual_ids.length, 0);
			assert.equal(delta.low_confidence_residual_ids.length > 0, true);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("preserves merge lineage when a merged residual still matches prior residual history", async () => {
		const repo = await initRepo();
		try {
			await createMission({
				repoRoot: repo,
				slug: "demo",
				targetFingerprint: "repo:demo",
			});
			await startIteration(repo, "demo", "initial");
			await recordRequiredLaneSummaries(repo, "demo", 1, {
				verdict: "PARTIAL",
				confidence: "high",
				residuals: [
					{
						stable_id: "residual:left-parent",
						title: "Audit lane reused execution session",
						summary: "Audit reused execution state.",
						severity: "medium",
						category: "fresh-lane-isolation",
						closure_condition: "audit provenance must be isolated",
						target_path: "src/mission/kernel.ts",
						symbol: "computeDelta",
					},
					{
						stable_id: "residual:right-parent",
						title: "Hardening lane reused execution session",
						summary: "Hardening reused execution state.",
						severity: "medium",
						category: "fresh-lane-isolation",
						closure_condition: "hardening provenance must be isolated",
						target_path: "src/mission/kernel.ts",
						symbol: "computeDelta",
					},
				],
				evidence_refs: ["logs/iter-1.txt"],
				recommended_next_action: "merge the duplicated provenance finding",
				provenance: {
					lane_id: "re-audit-lane-1",
					session_id: "re-audit-session-1",
					lane_type: "re_audit",
					runner_type: "direct",
					adapter_version: "mission-adapter/v1",
					started_at: "2026-04-11T17:00:00.000Z",
					finished_at: "2026-04-11T17:05:00.000Z",
					parent_iteration: 1,
					trigger_reason: "initial re-audit",
					read_only: true,
				},
			});
			await commitIteration(repo, "demo", 1, {
				iteration_commit_succeeded: true,
				no_unreconciled_lane_errors: true,
				focused_checks_green: true,
			});

			await startIteration(repo, "demo", "merge-follow-up");
			await recordRequiredLaneSummaries(repo, "demo", 2, {
				verdict: "PARTIAL",
				confidence: "high",
				residuals: [
					{
						title: "Execution provenance still leaks across mission lanes",
						summary: "Audit and hardening still overlap execution provenance.",
						severity: "medium",
						category: "fresh-lane-isolation",
						closure_condition:
							"audit and hardening provenance must be isolated",
						target_path: "src/mission/kernel.ts",
						symbol: "computeDelta",
						lineage: {
							kind: "merge",
							related_residual_ids: [
								"residual:left-parent",
								"residual:right-parent",
							],
						},
					},
				],
				evidence_refs: ["logs/iter-2.txt"],
				recommended_next_action:
					"keep the merged finding tracked until both lanes isolate cleanly",
				provenance: {
					lane_id: "re-audit-lane-2",
					session_id: "re-audit-session-2",
					lane_type: "re_audit",
					runner_type: "direct",
					adapter_version: "mission-adapter/v1",
					started_at: "2026-04-11T17:06:00.000Z",
					finished_at: "2026-04-11T17:10:00.000Z",
					parent_iteration: 2,
					trigger_reason: "merged follow-up re-audit",
					read_only: true,
				},
			});

			const delta = await computeDelta(repo, "demo", 2);
			assert.equal(delta.introduced_residual_ids.length, 0);
			assert.equal(delta.lineage_merge_residual_ids.length, 1);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("surfaces oscillating residual behavior instead of treating it as unchanged", async () => {
		const repo = await initRepo();
		try {
			await createMission({
				repoRoot: repo,
				slug: "demo",
				targetFingerprint: "repo:demo",
				plateauPolicy: { oscillation_window: 1 },
			});

			await startIteration(repo, "demo", "first-pass");
			await recordRequiredLaneSummaries(repo, "demo", 1, {
				verdict: "PARTIAL",
				confidence: "high",
				residuals: [
					{
						stable_id: "residual:oscillating-finding",
						summary: "Residual remains at high severity.",
						severity: "high",
						category: "oracle-consistency",
						closure_condition: "verifier must stop oscillating",
					},
				],
				evidence_refs: ["logs/iter-1.txt"],
				recommended_next_action: "reduce severity",
				provenance: {
					lane_id: "re-audit-osc-1",
					session_id: "re-audit-osc-1",
					lane_type: "re_audit",
					runner_type: "direct",
					adapter_version: "mission-adapter/v1",
					started_at: "2026-04-11T17:00:00.000Z",
					finished_at: "2026-04-11T17:05:00.000Z",
					parent_iteration: 1,
					trigger_reason: "first oscillation sample",
					read_only: true,
				},
			});
			await commitIteration(repo, "demo", 1, {
				iteration_commit_succeeded: true,
				no_unreconciled_lane_errors: true,
				focused_checks_green: true,
			});

			await startIteration(repo, "demo", "second-pass");
			await recordRequiredLaneSummaries(repo, "demo", 2, {
				verdict: "PARTIAL",
				confidence: "high",
				residuals: [
					{
						stable_id: "residual:oscillating-finding",
						summary: "Residual improved to medium severity.",
						severity: "medium",
						category: "oracle-consistency",
						closure_condition: "verifier must stop oscillating",
					},
				],
				evidence_refs: ["logs/iter-2.txt"],
				recommended_next_action: "keep improving",
				provenance: {
					lane_id: "re-audit-osc-2",
					session_id: "re-audit-osc-2",
					lane_type: "re_audit",
					runner_type: "direct",
					adapter_version: "mission-adapter/v1",
					started_at: "2026-04-11T17:06:00.000Z",
					finished_at: "2026-04-11T17:10:00.000Z",
					parent_iteration: 2,
					trigger_reason: "improved oscillation sample",
					read_only: true,
				},
			});
			await commitIteration(repo, "demo", 2, {
				iteration_commit_succeeded: true,
				no_unreconciled_lane_errors: true,
				focused_checks_green: true,
			});

			await startIteration(repo, "demo", "third-pass");
			await recordRequiredLaneSummaries(repo, "demo", 3, {
				verdict: "PARTIAL",
				confidence: "high",
				residuals: [
					{
						stable_id: "residual:oscillating-finding",
						summary: "Residual regressed back to high severity.",
						severity: "high",
						category: "oracle-consistency",
						closure_condition: "verifier must stop oscillating",
					},
				],
				evidence_refs: ["logs/iter-3.txt"],
				recommended_next_action: "stop oscillation",
				provenance: {
					lane_id: "re-audit-osc-3",
					session_id: "re-audit-osc-3",
					lane_type: "re_audit",
					runner_type: "direct",
					adapter_version: "mission-adapter/v1",
					started_at: "2026-04-11T17:11:00.000Z",
					finished_at: "2026-04-11T17:15:00.000Z",
					parent_iteration: 3,
					trigger_reason: "regressed oscillation sample",
					read_only: true,
				},
			});

			const delta = await computeDelta(repo, "demo", 3);
			assert.deepEqual(delta.oscillating_residual_ids, [
				"residual:oscillating-finding",
			]);

			const committed = await commitIteration(repo, "demo", 3, {
				iteration_commit_succeeded: true,
				no_unreconciled_lane_errors: true,
				focused_checks_green: true,
			});
			assert.equal(committed.mission.status, "plateau");
			assert.match(committed.judgement.reason, /oscillating/i);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("rejects future iteration summaries so stale workers cannot poison the next iteration", async () => {
		const repo = await initRepo();
		try {
			await createMission({
				repoRoot: repo,
				slug: "demo",
				targetFingerprint: "repo:demo",
			});
			await startIteration(repo, "demo", "initial");

			const future = await recordLaneSummary(
				repo,
				"demo",
				2,
				"audit",
				laneSummary("audit", 2, { verdict: "PASS", readOnly: true }),
			);
			assert.equal(future.status, "ignored");
			assert.equal(future.reason, "future");
			assert.equal(
				existsSync(
					join(
						repo,
						".omx",
						"missions",
						"demo",
						"iterations",
						"002",
						"audit",
						"summary.json",
					),
				),
				false,
			);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("rejects committing an iteration when required lane summaries are missing", async () => {
		const repo = await initRepo();
		try {
			await createMission({
				repoRoot: repo,
				slug: "demo",
				targetFingerprint: "repo:demo",
			});
			await startIteration(repo, "demo", "initial");
			await recordLaneSummary(
				repo,
				"demo",
				1,
				"re_audit",
				laneSummary("re_audit", 1, { verdict: "PASS", readOnly: true }),
			);

			await assert.rejects(
				() =>
					commitIteration(repo, "demo", 1, {
						iteration_commit_succeeded: true,
						no_unreconciled_lane_errors: true,
						focused_checks_green: true,
					}),
				/missing_iteration_lane_summary:audit/i,
			);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("does not advance to the next iteration when only delta.json exists from a torn commit", async () => {
		const repo = await initRepo();
		try {
			await createMission({
				repoRoot: repo,
				slug: "demo",
				targetFingerprint: "repo:demo",
			});
			const handle = await startIteration(repo, "demo", "initial");
			await writeFile(
				join(handle.iterationDir, "delta.json"),
				JSON.stringify(
					{
						previous_iteration: null,
						current_iteration: 1,
						previous_verdict: null,
						current_verdict: "PASS",
						improved_residual_ids: [],
						unchanged_residual_ids: [],
						regressed_residual_ids: [],
						resolved_residual_ids: [],
						introduced_residual_ids: [],
						oscillating_residual_ids: [],
						lineage_split_residual_ids: [],
						lineage_merge_residual_ids: [],
						low_confidence_residual_ids: [],
						severity_rollup: {
							improved: 0,
							unchanged: 0,
							regressed: 0,
							resolved: 0,
							introduced: 0,
						},
					},
					null,
					2,
				),
			);

			const resumed = await startIteration(repo, "demo", "initial");
			assert.equal(resumed.iteration, 1);
			assert.equal(resumed.resumed, true);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});
});
