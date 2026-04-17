import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
	appendFile,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { MissionLaneSummaryInput } from "../contracts.js";
import { loadMissionEvents } from "../events.js";
import { loadMission } from "../kernel.js";
import { missionOrchestrationArtifactPaths } from "../orchestration.js";
import { recoverMissionReadModels } from "../recovery.js";
import {
	commitMissionRuntimeIteration,
	prepareMissionRuntime,
	recordMissionRuntimeLaneSummary,
} from "../runtime.js";
import { missionWorkflowPath } from "../workflow.js";

async function initRepo(): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), "omx-mission-recovery-"));
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

function verifierSummary(
	runtime: Awaited<ReturnType<typeof prepareMissionRuntime>>,
	laneType: "audit" | "re_audit",
	iteration: number,
	verdict: "PASS" | "PARTIAL",
): MissionLaneSummaryInput {
	return {
		verdict,
		confidence: "high",
		residuals:
			verdict === "PASS"
				? []
				: [{ summary: "Residual remains", severity: "medium" }],
		evidence_refs: ["logs/recovery.txt"],
		recommended_next_action: verdict === "PASS" ? "close mission" : "continue",
		provenance: {
			lane_id: `${laneType}-lane-${iteration}`,
			session_id: `${laneType}-session-${iteration}`,
			lane_type: laneType,
			runner_type: "direct",
			adapter_version: "mission-adapter/v1",
			started_at: "2026-04-13T00:00:00.000Z",
			finished_at: "2026-04-13T00:05:00.000Z",
			parent_iteration: iteration,
			trigger_reason: `${laneType} stage`,
			read_only: true,
			run_token:
				runtime.lanePlans[laneType]?.executionEnvelope.provenance_binding_token,
		},
	};
}

describe("mission recovery", () => {
	it("keeps legacy Mission V2 recovery on the non-V3 path", async () => {
		const repo = await initRepo();
		try {
			const missionRoot = join(repo, ".omx", "missions", "legacy-demo");
			await mkdir(missionRoot, { recursive: true });
			await writeFile(
				join(missionRoot, "mission.json"),
				JSON.stringify(
					{
						schema_version: 1,
						mission_id: "legacy-demo",
						slug: "legacy-demo",
						repo_root: repo,
						mission_root: missionRoot,
						target_fingerprint: "repo:legacy-demo",
						status: "running",
						started_at: "2026-04-13T00:00:00.000Z",
						updated_at: "2026-04-13T00:00:00.000Z",
						current_iteration: 1,
						current_stage: "idle",
						active_lanes: [],
						closure_policy: {},
						plateau_policy: {},
						latest_verdict: "AMBIGUOUS",
						latest_summary_path: null,
						latest_lane_provenance: [],
						unchanged_iterations: 0,
						ambiguous_iterations: 0,
						oscillation_count: 0,
						last_residual_fingerprint: null,
						last_strategy_key: null,
						final_reason: null,
					},
					null,
					2,
				),
				"utf-8",
			);

			const recovered = await recoverMissionReadModels(repo, "legacy-demo");
			assert.equal(recovered.v3, null);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("rebuilds workflow and telemetry after snapshot drift during an active mission", async () => {
		const repo = await initRepo();
		try {
			const runtime = await prepareMissionRuntime({
				repoRoot: repo,
				slug: "demo",
				targetFingerprint: "repo:demo",
				task: "Recover Mission V2 read models",
			});
			await recordMissionRuntimeLaneSummary(
				repo,
				"demo",
				"audit",
				verifierSummary(runtime, "audit", 1, "PARTIAL"),
			);

			const artifactPaths = missionOrchestrationArtifactPaths(
				runtime.missionRoot,
			);
			await writeFile(
				missionWorkflowPath(runtime.missionRoot),
				JSON.stringify({ drifted: true }, null, 2),
			);
			await writeFile(
				artifactPaths.runMetricsPath,
				JSON.stringify({ drifted: true }, null, 2),
			);
			await writeFile(
				artifactPaths.watchdogPath,
				JSON.stringify({ drifted: true }, null, 2),
			);

			const recovered = await recoverMissionReadModels(repo, "demo");
			assert.equal(recovered.driftDetected, true);
			assert.equal(recovered.workflow.rebuilt.current_stage, "execution-loop");
			assert.equal(recovered.telemetry.metrics.lane_summary_counts.audit, 1);
			const events = await loadMissionEvents(runtime.missionRoot);
			assert.equal(
				events.some((event) => event.event_type === "read_models_recovered"),
				true,
			);
			assert.equal(
				recovered.workflow.rebuilt.updated_at,
				events.at(-1)?.recorded_at,
			);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("rebuilds closeout, latest.json, and telemetry after a simulated post-commit crash window", async () => {
		const repo = await initRepo();
		try {
			const runtime = await prepareMissionRuntime({
				repoRoot: repo,
				slug: "demo",
				targetFingerprint: "repo:demo",
				task: "Recover terminal Mission V2 read models",
			});
			await recordMissionRuntimeLaneSummary(
				repo,
				"demo",
				"audit",
				verifierSummary(runtime, "audit", 1, "PASS"),
			);
			await recordMissionRuntimeLaneSummary(repo, "demo", "remediation", {
				verdict: "PASS",
				confidence: "high",
				residuals: [],
				evidence_refs: ["logs/remediation.txt"],
				recommended_next_action: "execute",
				provenance: {
					lane_id: "remediation-lane-1",
					session_id: "remediation-session-1",
					lane_type: "remediation",
					runner_type: "direct",
					adapter_version: "mission-adapter/v1",
					started_at: "2026-04-13T00:00:00.000Z",
					finished_at: "2026-04-13T00:05:00.000Z",
					parent_iteration: 1,
					trigger_reason: "remediation",
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
					started_at: "2026-04-13T00:00:00.000Z",
					finished_at: "2026-04-13T00:05:00.000Z",
					parent_iteration: 1,
					trigger_reason: "execution",
				},
			});
			await recordMissionRuntimeLaneSummary(
				repo,
				"demo",
				"re_audit",
				verifierSummary(runtime, "re_audit", 1, "PASS"),
			);
			await commitMissionRuntimeIteration(repo, "demo", {
				iteration_commit_succeeded: true,
				no_unreconciled_lane_errors: true,
				focused_checks_green: true,
			});

			const mission = await loadMission(repo, "demo");
			const artifactPaths = missionOrchestrationArtifactPaths(
				runtime.missionRoot,
			);
			await unlink(artifactPaths.closeoutStatePath);
			await unlink(artifactPaths.closeoutPath);
			await unlink(artifactPaths.runMetricsPath);
			await unlink(artifactPaths.watchdogPath);
			await unlink(join(runtime.missionRoot, "latest.json"));

			const recovered = await recoverMissionReadModels(repo, "demo");
			assert.equal(recovered.driftDetected, true);
			assert.equal(recovered.closeout.closeout?.status, "complete");
			assert.equal(existsSync(artifactPaths.closeoutPath), true);
			assert.equal(existsSync(artifactPaths.runMetricsPath), true);
			assert.equal(existsSync(artifactPaths.watchdogPath), true);
			assert.equal(existsSync(join(runtime.missionRoot, "latest.json")), true);
			assert.equal(
				recovered.latest.latest?.latest_summary_path,
				mission.latest_summary_path,
			);
			assert.equal(mission.status, "complete");

			const second = await recoverMissionReadModels(repo, "demo");
			assert.equal(second.driftDetected, false);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("repairs a malformed event-log tail before appending recovery events", async () => {
		const repo = await initRepo();
		try {
			const runtime = await prepareMissionRuntime({
				repoRoot: repo,
				slug: "demo",
				targetFingerprint: "repo:demo",
				task: "Repair a torn Mission V2 event tail",
			});
			await recordMissionRuntimeLaneSummary(
				repo,
				"demo",
				"audit",
				verifierSummary(runtime, "audit", 1, "PARTIAL"),
			);

			const artifactPaths = missionOrchestrationArtifactPaths(
				runtime.missionRoot,
			);
			await writeFile(
				missionWorkflowPath(runtime.missionRoot),
				JSON.stringify({ drifted: true }, null, 2),
			);
			await appendFile(
				join(runtime.missionRoot, "events.ndjson"),
				'{"broken":',
				"utf-8",
			);

			const recovered = await recoverMissionReadModels(repo, "demo");
			assert.equal(recovered.driftDetected, true);
			assert.equal(recovered.workflow.rebuilt.current_stage, "execution-loop");

			const repairedLog = await readFile(
				join(runtime.missionRoot, "events.ndjson"),
				"utf-8",
			);
			assert.equal(repairedLog.includes('{"broken":'), false);

			const events = await loadMissionEvents(runtime.missionRoot);
			const recoveryEvent = [...events]
				.reverse()
				.find((event) => event.event_type === "read_models_recovered");
			assert.equal(recoveryEvent?.event_type, "read_models_recovered");
			if (
				!recoveryEvent ||
				recoveryEvent.event_type !== "read_models_recovered"
			) {
				throw new Error("missing read_models_recovered event");
			}
			assert.equal(recoveryEvent.payload.workflow_drift, true);
			assert.equal(recoveryEvent.payload.latest_drift, false);
			assert.equal(existsSync(artifactPaths.runMetricsPath), true);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("rebuilds missing Mission V3 derived artifacts during recovery", async () => {
		const repo = await initRepo();
		try {
			const runtime = await prepareMissionRuntime({
				repoRoot: repo,
				slug: "v3-recovery-demo",
				targetFingerprint: "repo:v3-recovery-demo",
				task: "Recover missing Mission V3 derived artifacts",
			});
			await recordMissionRuntimeLaneSummary(
				repo,
				"v3-recovery-demo",
				"audit",
				verifierSummary(runtime, "audit", 1, "PASS"),
			);
			await recordMissionRuntimeLaneSummary(repo, "v3-recovery-demo", "remediation", {
				verdict: "PASS",
				confidence: "high",
				residuals: [],
				evidence_refs: ["logs/remediation.txt"],
				recommended_next_action: "execute",
				provenance: {
					lane_id: "remediation-lane-1",
					session_id: "remediation-session-1",
					lane_type: "remediation",
					runner_type: "direct",
					adapter_version: "mission-adapter/v1",
					started_at: "2026-04-13T00:00:00.000Z",
					finished_at: "2026-04-13T00:05:00.000Z",
					parent_iteration: 1,
					trigger_reason: "remediation",
				},
			});
			await recordMissionRuntimeLaneSummary(repo, "v3-recovery-demo", "execution", {
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
					started_at: "2026-04-13T00:00:00.000Z",
					finished_at: "2026-04-13T00:05:00.000Z",
					parent_iteration: 1,
					trigger_reason: "execution",
				},
			});
			await recordMissionRuntimeLaneSummary(
				repo,
				"v3-recovery-demo",
				"re_audit",
				verifierSummary(runtime, "re_audit", 1, "PASS"),
			);
			await commitMissionRuntimeIteration(repo, "v3-recovery-demo", {
				iteration_commit_succeeded: true,
				no_unreconciled_lane_errors: true,
				focused_checks_green: true,
			});

			await unlink(runtime.v3Paths.evidenceGraphPath);
			await unlink(runtime.v3Paths.promotionDecisionPath);
			await unlink(runtime.v3Paths.learningCurrentPath);
			await unlink(
				join(
					repo,
					".omx",
					"missions",
					"v3-recovery-demo",
					"candidates",
					"candidate-001",
					"assurance",
					"adjudication.json",
				),
			);

			const recovered = await recoverMissionReadModels(repo, "v3-recovery-demo");
			assert.equal(recovered.driftDetected, true);
			assert.equal(recovered.v3?.driftDetected, true);
			assert.equal(existsSync(runtime.v3Paths.evidenceGraphPath), true);
			assert.equal(existsSync(runtime.v3Paths.promotionDecisionPath), true);
			assert.equal(existsSync(runtime.v3Paths.learningCurrentPath), false);
			assert.equal(
				existsSync(
					join(
						repo,
						".omx",
						"missions",
						"v3-recovery-demo",
						"candidates",
						"candidate-001",
						"assurance",
						"adjudication.json",
					),
				),
				true,
			);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});
});
