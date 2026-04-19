import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { MissionLaneSummaryInput } from "../contracts.js";
import { loadMissionEvents } from "../events.js";
import { loadMission } from "../kernel.js";
import {
	cancelMissionRuntime,
	commitMissionRuntimeIteration,
	prepareMissionRuntime,
	recordMissionRuntimeLaneSummary,
} from "../runtime.js";
import { loadMissionWorkflow } from "../workflow.js";

async function initRepo(): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), "omx-mission-runtime-"));
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
	laneType: "audit" | "re_audit",
	iteration: number,
	verdict: "PASS" | "PARTIAL",
	runToken?: string,
): MissionLaneSummaryInput {
	return {
		verdict,
		confidence: "high",
		residuals:
			verdict === "PASS"
				? []
				: [
						{
							title: "Residual remains",
							summary: "Residual remains",
							severity: "medium",
							target_path: "src/mission/kernel.ts",
							symbol: "commitIteration",
						},
					],
		evidence_refs: ["logs/runtime.txt"],
		recommended_next_action:
			verdict === "PASS" ? "close mission" : "keep iterating",
		provenance: {
			lane_id: `${laneType}-lane-${iteration}`,
			session_id: `${laneType}-session-${iteration}`,
			lane_type: laneType,
			runner_type: "direct",
			adapter_version: "mission-adapter/v1",
			started_at: "2026-04-11T17:00:00.000Z",
			finished_at: "2026-04-11T17:05:00.000Z",
			parent_iteration: iteration,
			trigger_reason: `${laneType} stage`,
			read_only: true,
			run_token: runToken,
		},
	};
}

function verifierRunToken(
	runtime: Awaited<ReturnType<typeof prepareMissionRuntime>>,
	laneType: "audit" | "re_audit",
): string {
	const token =
		runtime.lanePlans[laneType]?.executionEnvelope.provenance_binding_token;
	if (!token) throw new Error(`missing verifier token for ${laneType}`);
	return token;
}

describe("mission runtime", () => {
	it("prepares the mission runtime with lane routing and authoritative artifact paths", async () => {
		const repo = await initRepo();
		try {
			const runtime = await prepareMissionRuntime({
				repoRoot: repo,
				slug: "demo",
				targetFingerprint: "repo:demo",
				task: "Implement Mission V2 bootstrap artifacts",
				projectTouchpoints: ["src/mission/runtime.ts"],
			});

			assert.equal(runtime.mission.slug, "demo");
			assert.equal(runtime.iteration?.iteration, 1);
			assert.equal(runtime.planning.mode, "direct");
			assert.equal(runtime.lanePlans.execution?.runnerType, "team");
			assert.equal(runtime.lanePlans.hardening?.runnerType, "ralph");
			assert.equal(runtime.artifacts.executionPlan.hardening_gate.mode, "optional");
			assert.equal(runtime.lanePlans.audit?.readOnly, true);
			assert.equal(runtime.lanePlans.re_audit?.freshSession, true);
			assert.equal(existsSync(runtime.missionFile), true);
			assert.equal(runtime.latestFile.endsWith("latest.json"), true);
			assert.equal(runtime.deltaFile?.endsWith("delta.json"), true);
			assert.equal(existsSync(runtime.artifactPaths.sourcePackPath), true);
			assert.equal(existsSync(runtime.artifactPaths.missionBriefPath), true);
			assert.equal(
				existsSync(runtime.artifactPaths.acceptanceContractPath),
				true,
			);
			assert.equal(existsSync(runtime.artifactPaths.executionPlanPath), true);
			assert.equal(
				existsSync(runtime.lanePlans.audit?.briefingPath || ""),
				true,
			);

			const auditBriefing = await readFile(
				runtime.lanePlans.audit?.briefingPath || "",
				"utf-8",
			);
			assert.match(auditBriefing, /acceptance-contract\.json/i);
			assert.match(auditBriefing, /PASS/i);
			const executionPlanMarkdown = await readFile(
				runtime.artifactPaths.executionPlanPath,
				"utf-8",
			);
			assert.match(executionPlanMarkdown, /## Hardening gate/i);
			const hardeningBriefing = await readFile(
				runtime.lanePlans.hardening?.briefingPath || "",
				"utf-8",
			);
			assert.match(hardeningBriefing, /Hardening coordinator protocol/i);
			assert.match(hardeningBriefing, /skills\/mission-hardening\/SKILL\.md/i);

			const mission = await loadMission(repo, "demo");
			assert.equal(mission.last_strategy_key, runtime.planning.strategyKey);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("resumes the current mission and reuses the active iteration when no delta was committed", async () => {
		const repo = await initRepo();
		try {
			const first = await prepareMissionRuntime({
				repoRoot: repo,
				slug: "demo",
				targetFingerprint: "repo:demo",
			});
			const second = await prepareMissionRuntime({
				repoRoot: repo,
				slug: "demo",
				targetFingerprint: "repo:demo",
				task: "Implement Mission V2 bootstrap artifacts",
			});

			assert.equal(second.mission.mission_id, first.mission.mission_id);
			assert.equal(second.iteration?.iteration, first.iteration?.iteration);
			assert.equal(second.iteration?.resumed, true);
			assert.equal(
				second.artifacts.executionPlan.plan_id,
				first.artifacts.executionPlan.plan_id,
			);

			const events = await loadMissionEvents(first.missionRoot);
			assert.equal(
				events.filter((event) => event.event_type === "workflow_stage_entered")
					.length,
				5,
			);
			const workflow = await loadMissionWorkflow(first.missionRoot);
			assert.equal(workflow?.stage_history.length, 5);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("derives legacy execution-plan hardening policy from the mission profile on resume", async () => {
		const repo = await initRepo();
		try {
			const runtime = await prepareMissionRuntime({
				repoRoot: repo,
				slug: "demo",
				targetFingerprint: "repo:demo",
				task: "Implement Mission V2 bootstrap artifacts",
				highRisk: true,
			});
			const legacyExecutionPlan = JSON.parse(
				await readFile(runtime.artifactPaths.executionPlanStatePath, "utf-8"),
			) as Record<string, unknown>;
			delete legacyExecutionPlan.hardening_gate;
			await writeFile(
				runtime.artifactPaths.executionPlanStatePath,
				`${JSON.stringify(legacyExecutionPlan, null, 2)}\n`,
				"utf-8",
			);
			const missionState = JSON.parse(
				await readFile(runtime.missionFile, "utf-8"),
			) as Record<string, unknown>;
			await writeFile(
				runtime.missionFile,
				`${JSON.stringify(
					{
						...missionState,
						policy_profile: {
							risk_class: "security-sensitive",
							assurance_profile: "max-quality",
							autonomy_profile: "semi-auto",
						},
					},
					null,
					2,
				)}\n`,
				"utf-8",
			);

			const resumed = await prepareMissionRuntime({
				repoRoot: repo,
				slug: "demo",
				targetFingerprint: "repo:demo",
				task: "Resume hardening-gated mission",
			});

			assert.equal(
				resumed.artifacts.executionPlan.hardening_gate.mode,
				"required",
			);
			const hardeningBriefing = await readFile(
				resumed.lanePlans.hardening?.briefingPath || "",
				"utf-8",
			);
			assert.match(hardeningBriefing, /Mission hardening gate mode: required/i);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("requires fresh bootstrap inputs before recreating missing Mission V2 artifacts on resume", async () => {
		const repo = await initRepo();
		try {
			const runtime = await prepareMissionRuntime({
				repoRoot: repo,
				slug: "demo",
				targetFingerprint: "repo:demo",
				task: "Implement Mission V2 bootstrap artifacts",
			});

			await rm(runtime.artifactPaths.sourcePackPath, { force: true });

			await assert.rejects(
				prepareMissionRuntime({
					repoRoot: repo,
					slug: "demo",
					targetFingerprint: "repo:demo",
				}),
				/mission_orchestration_bootstrap_required:demo/,
			);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("blocks execution iteration 1 until clarification when source grounding remains ambiguous", async () => {
		const repo = await initRepo();
		try {
			const runtime = await prepareMissionRuntime({
				repoRoot: repo,
				slug: "demo",
				targetFingerprint: "repo:demo",
				task: "Implement Mission V2 from partial notes only",
				unknowns: ["Need a clarified acceptance contract before planning."],
			});

			assert.equal(runtime.iteration, null);
			assert.equal(runtime.planning.mode, "blocked");
			assert.equal(runtime.planning.handoffSurface, "deep-interview");
			assert.equal(existsSync(runtime.artifactPaths.executionPlanPath), true);
			assert.equal(
				existsSync(join(repo, ".omx", "missions", "demo", "iterations", "001")),
				false,
			);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("marks high-risk or broad missions for ralplan handoff before kernel-managed execution", async () => {
		const repo = await initRepo();
		try {
			const runtime = await prepareMissionRuntime({
				repoRoot: repo,
				slug: "demo",
				targetFingerprint: "repo:demo",
				task: "Roll out Mission V2 orchestration across runtime, docs, and tests",
				highRisk: true,
				requirementSources: [
					{ kind: "issue", content: "Mission lacks source grounding." },
					{ kind: "spec", content: "Mission needs acceptance contracts." },
					{ kind: "doc", content: "Mission must remain project-agnostic." },
				],
				projectTouchpoints: [
					"src/mission/runtime.ts",
					"src/mission/kernel.ts",
					"skills/mission/SKILL.md",
					"docs/contracts/mission-kernel-semantics-contract.md",
				],
			});

			assert.equal(runtime.planning.mode, "ralplan");
			assert.equal(runtime.planning.handoffSurface, "ralplan");
			assert.equal(runtime.iteration?.iteration, 1);
			assert.match(runtime.artifacts.executionPlan.summary, /ralplan/i);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("records lane summaries through the runtime bridge and commits latest.json after success", async () => {
		const repo = await initRepo();
		try {
			const runtime = await prepareMissionRuntime({
				repoRoot: repo,
				slug: "demo",
				targetFingerprint: "repo:demo",
			});

			const written = await recordMissionRuntimeLaneSummary(
				repo,
				"demo",
				"audit",
				laneSummary("audit", 1, "PARTIAL", verifierRunToken(runtime, "audit")),
			);
			assert.equal(written.status, "written");

			await recordMissionRuntimeLaneSummary(repo, "demo", "remediation", {
				verdict: "PASS",
				confidence: "high",
				residuals: [],
				evidence_refs: ["logs/remediation.txt"],
				recommended_next_action: "execute fix",
				provenance: {
					lane_id: "remediation-lane-1",
					session_id: "remediation-session-1",
					lane_type: "remediation",
					runner_type: "direct",
					adapter_version: "mission-adapter/v1",
					started_at: "2026-04-11T17:00:00.000Z",
					finished_at: "2026-04-11T17:05:00.000Z",
					parent_iteration: 1,
					trigger_reason: "remediation stage",
				},
			});
			await recordMissionRuntimeLaneSummary(repo, "demo", "execution", {
				verdict: "PASS",
				confidence: "high",
				residuals: [],
				evidence_refs: ["logs/execution.txt"],
				recommended_next_action: "re-audit",
				provenance: {
					lane_id: "execution-lane-1",
					session_id: "execution-session-1",
					lane_type: "execution",
					runner_type: "team",
					adapter_version: "mission-adapter/v1",
					started_at: "2026-04-11T17:00:00.000Z",
					finished_at: "2026-04-11T17:05:00.000Z",
					parent_iteration: 1,
					trigger_reason: "execution stage",
				},
			});
			await recordMissionRuntimeLaneSummary(
				repo,
				"demo",
				"re_audit",
				laneSummary(
					"re_audit",
					1,
					"PASS",
					verifierRunToken(runtime, "re_audit"),
				),
			);
			const committed = await commitMissionRuntimeIteration(repo, "demo", {
				iteration_commit_succeeded: true,
				no_unreconciled_lane_errors: true,
				focused_checks_green: true,
			});

			assert.equal(committed.mission.status, "complete");
			const mission = await loadMission(repo, "demo");
			assert.equal(
				mission.latest_summary_path,
				runtime.lanePlans.re_audit?.summaryPath,
			);
			assert.equal(existsSync(runtime.latestFile), true);
			assert.equal(existsSync(runtime.artifactPaths.closeoutPath), true);
			const closeout = await readFile(
				runtime.artifactPaths.closeoutPath,
				"utf-8",
			);
			assert.match(closeout, /Mission Closeout/);
			assert.match(closeout, /Final verdict: `PASS`/);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("keeps the mission running when the re-audit lane reuses execution provenance", async () => {
		const repo = await initRepo();
		try {
			const runtime = await prepareMissionRuntime({
				repoRoot: repo,
				slug: "demo",
				targetFingerprint: "repo:demo",
			});

			await recordMissionRuntimeLaneSummary(
				repo,
				"demo",
				"audit",
				laneSummary("audit", 1, "PASS", verifierRunToken(runtime, "audit")),
			);
			await recordMissionRuntimeLaneSummary(repo, "demo", "remediation", {
				verdict: "PASS",
				confidence: "high",
				residuals: [],
				evidence_refs: ["logs/remediation.txt"],
				recommended_next_action: "execute fix",
				provenance: {
					lane_id: "remediation-lane-1",
					session_id: "remediation-session-1",
					lane_type: "remediation",
					runner_type: "direct",
					adapter_version: "mission-adapter/v1",
					started_at: "2026-04-11T17:00:00.000Z",
					finished_at: "2026-04-11T17:05:00.000Z",
					parent_iteration: 1,
					trigger_reason: "remediation stage",
				},
			});
			await recordMissionRuntimeLaneSummary(repo, "demo", "execution", {
				verdict: "PASS",
				confidence: "high",
				residuals: [],
				evidence_refs: ["logs/execution.txt"],
				recommended_next_action: "re-audit",
				provenance: {
					lane_id: "execution-lane-1",
					session_id: "execution-session-1",
					lane_type: "execution",
					runner_type: "team",
					adapter_version: "mission-adapter/v1",
					started_at: "2026-04-11T17:00:00.000Z",
					finished_at: "2026-04-11T17:05:00.000Z",
					parent_iteration: 1,
					trigger_reason: "execution stage",
				},
			});
			await recordMissionRuntimeLaneSummary(repo, "demo", "re_audit", {
				...laneSummary(
					"re_audit",
					1,
					"PASS",
					verifierRunToken(runtime, "re_audit"),
				),
				provenance: {
					...laneSummary(
						"re_audit",
						1,
						"PASS",
						verifierRunToken(runtime, "re_audit"),
					).provenance,
					session_id: "execution-session-1",
					lane_id: "execution-lane-1",
				},
			});

			const committed = await commitMissionRuntimeIteration(repo, "demo", {
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

	it("keeps audit and re-audit isolated from execution lane provenance", async () => {
		const repo = await initRepo();
		try {
			const runtime = await prepareMissionRuntime({
				repoRoot: repo,
				slug: "demo",
				targetFingerprint: "repo:demo",
			});

			await recordMissionRuntimeLaneSummary(repo, "demo", "audit", {
				...laneSummary(
					"audit",
					1,
					"PARTIAL",
					verifierRunToken(runtime, "audit"),
				),
				provenance: {
					...laneSummary(
						"audit",
						1,
						"PARTIAL",
						verifierRunToken(runtime, "audit"),
					).provenance,
					session_id: "audit-session-fresh",
					lane_id: "audit-lane-fresh",
				},
			});
			await recordMissionRuntimeLaneSummary(repo, "demo", "execution", {
				verdict: "PASS",
				confidence: "high",
				residuals: [],
				evidence_refs: ["logs/exec.txt"],
				recommended_next_action: "handoff to hardening",
				provenance: {
					lane_id: "execution-lane-1",
					session_id: "execution-session-1",
					lane_type: "execution",
					runner_type: "team",
					adapter_version: "mission-adapter/v1",
					started_at: "2026-04-11T17:00:00.000Z",
					finished_at: "2026-04-11T17:05:00.000Z",
					parent_iteration: 1,
					trigger_reason: "execution stage",
				},
			});
			await recordMissionRuntimeLaneSummary(repo, "demo", "re_audit", {
				...laneSummary(
					"re_audit",
					1,
					"PASS",
					verifierRunToken(runtime, "re_audit"),
				),
				provenance: {
					...laneSummary(
						"re_audit",
						1,
						"PASS",
						verifierRunToken(runtime, "re_audit"),
					).provenance,
					session_id: "re-audit-session-fresh",
					lane_id: "re-audit-lane-fresh",
				},
			});

			const auditSummary = JSON.parse(
				await readFile(runtime.lanePlans.audit?.summaryPath || "", "utf-8"),
			) as {
				provenance: {
					session_id: string;
					lane_id: string;
					read_only?: boolean;
				};
			};
			const reAuditSummary = JSON.parse(
				await readFile(runtime.lanePlans.re_audit?.summaryPath || "", "utf-8"),
			) as {
				provenance: {
					session_id: string;
					lane_id: string;
					read_only?: boolean;
				};
			};
			const executionSummary = JSON.parse(
				await readFile(runtime.lanePlans.execution?.summaryPath || "", "utf-8"),
			) as {
				provenance: { session_id: string; lane_id: string };
			};

			assert.notEqual(
				auditSummary.provenance.session_id,
				executionSummary.provenance.session_id,
			);
			assert.notEqual(
				reAuditSummary.provenance.session_id,
				executionSummary.provenance.session_id,
			);
			assert.notEqual(
				auditSummary.provenance.lane_id,
				executionSummary.provenance.lane_id,
			);
			assert.notEqual(
				reAuditSummary.provenance.lane_id,
				executionSummary.provenance.lane_id,
			);
			assert.equal(auditSummary.provenance.read_only, true);
			assert.equal(reAuditSummary.provenance.read_only, true);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("ignores duplicate or late lane summaries after runtime cancellation", async () => {
		const repo = await initRepo();
		try {
			const runtime = await prepareMissionRuntime({
				repoRoot: repo,
				slug: "demo",
				targetFingerprint: "repo:demo",
			});

			const first = await recordMissionRuntimeLaneSummary(
				repo,
				"demo",
				"audit",
				laneSummary("audit", 1, "PARTIAL", verifierRunToken(runtime, "audit")),
			);
			const duplicate = await recordMissionRuntimeLaneSummary(
				repo,
				"demo",
				"audit",
				laneSummary("audit", 1, "PARTIAL", verifierRunToken(runtime, "audit")),
			);
			assert.equal(first.status, "written");
			assert.equal(duplicate.status, "duplicate");
			let events = await loadMissionEvents(runtime.missionRoot);
			assert.equal(
				events.filter((event) => event.event_type === "lane_summary_recorded")
					.length,
				1,
			);

			const cancelled = await cancelMissionRuntime(
				repo,
				"demo",
				"operator requested cancellation",
			);
			assert.equal(cancelled.status, "cancelling");

			const late = await recordMissionRuntimeLaneSummary(
				repo,
				"demo",
				"re_audit",
				laneSummary(
					"re_audit",
					1,
					"PASS",
					verifierRunToken(runtime, "re_audit"),
				),
			);
			assert.equal(late.status, "ignored");
			assert.equal(late.reason, "cancelled");

			await recordMissionRuntimeLaneSummary(repo, "demo", "remediation", {
				verdict: "PASS",
				confidence: "high",
				residuals: [],
				evidence_refs: ["logs/remediation.txt"],
				recommended_next_action: "cancelled",
				provenance: {
					lane_id: "remediation-lane-1",
					session_id: "remediation-session-1",
					lane_type: "remediation",
					runner_type: "direct",
					adapter_version: "mission-adapter/v1",
					started_at: "2026-04-11T17:00:00.000Z",
					finished_at: "2026-04-11T17:05:00.000Z",
					parent_iteration: 1,
					trigger_reason: "late remediation",
				},
			});
			await recordMissionRuntimeLaneSummary(repo, "demo", "execution", {
				verdict: "PASS",
				confidence: "high",
				residuals: [],
				evidence_refs: ["logs/execution.txt"],
				recommended_next_action: "cancelled",
				provenance: {
					lane_id: "execution-lane-1",
					session_id: "execution-session-1",
					lane_type: "execution",
					runner_type: "team",
					adapter_version: "mission-adapter/v1",
					started_at: "2026-04-11T17:00:00.000Z",
					finished_at: "2026-04-11T17:05:00.000Z",
					parent_iteration: 1,
					trigger_reason: "late execution",
				},
			});
			await recordMissionRuntimeLaneSummary(repo, "demo", "hardening", {
				verdict: "PASS",
				confidence: "high",
				residuals: [],
				evidence_refs: ["logs/hardening.txt"],
				recommended_next_action: "cancelled",
				provenance: {
					lane_id: "hardening-lane-1",
					session_id: "hardening-session-1",
					lane_type: "hardening",
					runner_type: "ralph",
					adapter_version: "mission-adapter/v1",
					started_at: "2026-04-11T17:00:00.000Z",
					finished_at: "2026-04-11T17:05:00.000Z",
					parent_iteration: 1,
					trigger_reason: "late hardening",
				},
			});
			const reconciled = await loadMission(repo, "demo");
			assert.equal(reconciled.status, "cancelled");
			events = await loadMissionEvents(runtime.missionRoot);
			assert.equal(
				events
					.filter((event) => event.event_type === "lane_summary_recorded")
					.map((event) => event.payload.lane_type)
					.join(","),
				"audit",
			);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("does not advance to a new iteration when only delta.json exists after a torn commit", async () => {
		const repo = await initRepo();
		try {
			const runtime = await prepareMissionRuntime({
				repoRoot: repo,
				slug: "demo",
				targetFingerprint: "repo:demo",
			});
			if (!runtime.deltaFile)
				throw new Error("expected deltaFile for active iteration");
			await writeFile(
				runtime.deltaFile,
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

			const resumed = await prepareMissionRuntime({
				repoRoot: repo,
				slug: "demo",
				targetFingerprint: "repo:demo",
			});
			if (!resumed.iteration) throw new Error("expected resumed iteration");
			assert.equal(resumed.iteration.iteration, 1);
			assert.equal(resumed.iteration.resumed, true);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("records hardening sidecar artifact refs without inflating summary structure", async () => {
		const repo = await initRepo();
		try {
			const runtime = await prepareMissionRuntime({
				repoRoot: repo,
				slug: "demo",
				targetFingerprint: "repo:demo",
				task: "Record Mission hardening sidecar refs",
				highRisk: true,
			});
			const laneDir = runtime.lanePlans.hardening?.laneDir;
			if (!laneDir) throw new Error("expected hardening lane dir");
			await writeFile(
				join(laneDir, "review-cycle-1.json"),
				JSON.stringify({ cycle: 1 }, null, 2),
				"utf-8",
			);
			await writeFile(join(laneDir, "deslop-report.md"), "# deslop\n", "utf-8");
			await writeFile(
				join(laneDir, "final-review.json"),
				JSON.stringify({ status: "pass" }, null, 2),
				"utf-8",
			);
			await writeFile(
				join(laneDir, "gate-result.json"),
				JSON.stringify(
					{
						schema_version: 1,
						generated_at: "2026-04-18T18:00:00.000Z",
						gate_policy: runtime.artifacts.executionPlan.hardening_gate,
						status: "passed",
						failure_reason: null,
						changed_files_ref: ".omx/ralph/changed-files.txt",
						review_cycles: [
							{
								cycle_number: 1,
								review_engine: "codex-parallel-review",
								review_report_ref: "review-cycle-1.json",
								blocking_findings: 0,
								verification: {
									status: "pass",
									command_refs: ["npm run build"],
									evidence_refs: ["logs/build.txt"],
									completed_at: "2026-04-18T18:02:00.000Z",
								},
								completed_at: "2026-04-18T18:02:00.000Z",
							},
						],
						deslop_report_ref: "deslop-report.md",
						post_deslop_verification: {
							status: "pass",
							command_refs: ["npm run lint"],
							evidence_refs: ["logs/lint.txt"],
							completed_at: "2026-04-18T18:03:00.000Z",
						},
						final_review: {
							review_engine: "codex-parallel-review",
							review_report_ref: "final-review.json",
							blocking_findings: 0,
							status: "pass",
							completed_at: "2026-04-18T18:04:00.000Z",
						},
						blocking_findings_remaining: 0,
						completed_at: "2026-04-18T18:04:00.000Z",
						artifact_refs: [
							"review-cycle-1.json",
							"deslop-report.md",
							"final-review.json",
						],
					},
					null,
					2,
				),
				"utf-8",
			);
			await recordMissionRuntimeLaneSummary(repo, "demo", "hardening", {
				verdict: "PASS",
				confidence: "high",
				residuals: [],
				evidence_refs: ["logs/hardening.txt"],
				recommended_next_action: "handoff to fresh re-audit",
				provenance: {
					lane_id: "hardening-lane-1",
					session_id: "hardening-session-1",
					lane_type: "hardening",
					runner_type: "ralph",
					adapter_version: "mission-adapter/v1",
					started_at: "2026-04-18T18:01:00.000Z",
					finished_at: "2026-04-18T18:04:00.000Z",
					parent_iteration: 1,
					trigger_reason: "required hardening gate",
				},
			});
			const summary = JSON.parse(
				await readFile(runtime.lanePlans.hardening?.summaryPath || "", "utf-8"),
			) as { evidence_refs: string[] };
			assert.equal(
				summary.evidence_refs.includes(
					".omx/missions/demo/candidates/candidate-001/iterations/001/hardening/gate-result.json",
				),
				true,
			);
			assert.equal(
				summary.evidence_refs.includes(
					".omx/missions/demo/candidates/candidate-001/iterations/001/hardening/final-review.json",
				),
				true,
			);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("carries hardening sidecar evidence into the terminal closeout package", async () => {
		const repo = await initRepo();
		try {
			const runtime = await prepareMissionRuntime({
				repoRoot: repo,
				slug: "demo",
				targetFingerprint: "repo:demo",
				task: "Close out a mission with required hardening evidence",
				highRisk: true,
			});
			const laneDir = runtime.lanePlans.hardening?.laneDir;
			if (!laneDir) throw new Error("expected hardening lane dir");
			await writeFile(
				join(laneDir, "review-cycle-1.json"),
				JSON.stringify({ cycle: 1 }, null, 2),
				"utf-8",
			);
			await writeFile(join(laneDir, "deslop-report.md"), "# deslop\n", "utf-8");
			await writeFile(
				join(laneDir, "final-review.json"),
				JSON.stringify({ status: "pass" }, null, 2),
				"utf-8",
			);
			await writeFile(
				join(laneDir, "gate-result.json"),
				JSON.stringify(
					{
						schema_version: 1,
						generated_at: "2026-04-11T17:00:00.000Z",
						gate_policy: runtime.artifacts.executionPlan.hardening_gate,
						status: "passed",
						failure_reason: null,
						changed_files_ref: ".omx/ralph/changed-files.txt",
						review_cycles: [
							{
								cycle_number: 1,
								review_engine: "codex-parallel-review",
								review_report_ref: "review-cycle-1.json",
								blocking_findings: 0,
								verification: {
									status: "pass",
									command_refs: ["npm run build"],
									evidence_refs: ["logs/build.txt"],
									completed_at: "2026-04-11T17:02:00.000Z",
								},
								completed_at: "2026-04-11T17:02:00.000Z",
							},
						],
						deslop_report_ref: "deslop-report.md",
						post_deslop_verification: {
							status: "pass",
							command_refs: ["npm run lint"],
							evidence_refs: ["logs/lint.txt"],
							completed_at: "2026-04-11T17:03:00.000Z",
						},
						final_review: {
							review_engine: "codex-parallel-review",
							review_report_ref: "final-review.json",
							blocking_findings: 0,
							status: "pass",
							completed_at: "2026-04-11T17:04:00.000Z",
						},
						blocking_findings_remaining: 0,
						completed_at: "2026-04-11T17:04:00.000Z",
						artifact_refs: [
							"review-cycle-1.json",
							"deslop-report.md",
							"final-review.json",
						],
					},
					null,
					2,
				),
				"utf-8",
			);
			await recordMissionRuntimeLaneSummary(repo, "demo", "audit", laneSummary("audit", 1, "PASS", verifierRunToken(runtime, "audit")));
			await recordMissionRuntimeLaneSummary(repo, "demo", "remediation", {
				verdict: "PASS",
				confidence: "high",
				residuals: [],
				evidence_refs: ["logs/remediation.txt"],
				recommended_next_action: "handoff to execution",
				provenance: {
					lane_id: "remediation-lane-1",
					session_id: "remediation-session-1",
					lane_type: "remediation",
					runner_type: "direct",
					adapter_version: "mission-adapter/v1",
					started_at: "2026-04-11T17:00:00.000Z",
					finished_at: "2026-04-11T17:01:00.000Z",
					parent_iteration: 1,
					trigger_reason: "remediation stage",
				},
			});
			await recordMissionRuntimeLaneSummary(repo, "demo", "execution", {
				verdict: "PASS",
				confidence: "high",
				residuals: [],
				evidence_refs: ["logs/execution.txt"],
				recommended_next_action: "handoff to hardening",
				provenance: {
					lane_id: "execution-lane-1",
					session_id: "execution-session-1",
					lane_type: "execution",
					runner_type: "team",
					adapter_version: "mission-adapter/v1",
					started_at: "2026-04-11T17:01:00.000Z",
					finished_at: "2026-04-11T17:02:00.000Z",
					parent_iteration: 1,
					trigger_reason: "execution stage",
				},
			});
			await recordMissionRuntimeLaneSummary(repo, "demo", "hardening", {
				verdict: "PASS",
				confidence: "high",
				residuals: [],
				evidence_refs: ["logs/hardening.txt"],
				recommended_next_action: "handoff to fresh re-audit",
				provenance: {
					lane_id: "hardening-lane-1",
					session_id: "hardening-session-1",
					lane_type: "hardening",
					runner_type: "ralph",
					adapter_version: "mission-adapter/v1",
					started_at: "2026-04-11T17:02:00.000Z",
					finished_at: "2026-04-11T17:04:00.000Z",
					parent_iteration: 1,
					trigger_reason: "required hardening gate",
				},
			});
			await recordMissionRuntimeLaneSummary(repo, "demo", "re_audit", {
				...laneSummary("re_audit", 1, "PASS", verifierRunToken(runtime, "re_audit")),
				provenance: {
					...laneSummary("re_audit", 1, "PASS", verifierRunToken(runtime, "re_audit")).provenance,
					finished_at: "2026-04-11T17:05:00.000Z",
				},
			});

			await commitMissionRuntimeIteration(repo, "demo", {
				iteration_commit_succeeded: true,
				no_unreconciled_lane_errors: true,
				focused_checks_green: true,
			});
			const closeoutState = JSON.parse(
				await readFile(runtime.artifactPaths.closeoutStatePath, "utf-8"),
			) as { evidence_index: string[] };
			assert.equal(
				closeoutState.evidence_index.includes(
					".omx/missions/demo/candidates/candidate-001/iterations/001/hardening/gate-result.json",
				),
				true,
			);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});
});
