import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { MissionRunMetrics } from "../telemetry.js";
import {
	DEFAULT_MISSION_BUDGET_POLICY,
	evaluateMissionWatchdog,
	syncMissionTelemetry,
} from "../telemetry.js";
import { loadMissionEvents } from "../events.js";
import { loadMission } from "../kernel.js";
import {
	prepareMissionRuntime,
	recordMissionRuntimeLaneSummary,
} from "../runtime.js";
import type { MissionLaneSummaryInput } from "../contracts.js";

async function initRepo(): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), "omx-mission-telemetry-"));
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

function auditSummary(iteration: number): MissionLaneSummaryInput {
	return {
		verdict: "PARTIAL",
		confidence: "high",
		residuals: [
			{
				summary: "Residual remains",
				severity: "medium",
				target_path: "src/mission/runtime.ts",
			},
		],
		evidence_refs: ["logs/audit.txt"],
		recommended_next_action: "continue",
		provenance: {
			lane_id: `audit-lane-${iteration}`,
			session_id: `audit-session-${iteration}`,
			lane_type: "audit",
			runner_type: "direct",
			adapter_version: "mission-adapter/v1",
			started_at: "2026-04-13T00:00:00.000Z",
			finished_at: "2026-04-13T00:05:00.000Z",
			parent_iteration: iteration,
			trigger_reason: "audit stage",
			read_only: true,
		},
	};
}

describe("mission telemetry", () => {
	it("evaluates watchdog thresholds for wall-clock, stage duration, retries, and ambiguous iterations", () => {
		const metrics: MissionRunMetrics = {
			schema_version: 1,
			updated_at: "2026-04-13T00:00:00.000Z",
			mission_id: "mission-1",
			status: "running",
			current_stage: "execution-loop",
			current_iteration: 2,
			wall_clock_ms: 4 * 60 * 60 * 1000,
			ambiguous_iterations: 3,
			lane_summary_counts: {
				audit: 1,
				remediation: 1,
				execution: 1,
				hardening: 0,
				re_audit: 1,
			},
			stage_metrics: {
				intake: { enter_count: 1, last_entered_at: "2026-04-13T00:00:00.000Z", current_duration_ms: null },
				"source-grounding": { enter_count: 1, last_entered_at: "2026-04-13T00:01:00.000Z", current_duration_ms: null },
				"contract-build": { enter_count: 1, last_entered_at: "2026-04-13T00:02:00.000Z", current_duration_ms: null },
				planning: { enter_count: 1, last_entered_at: "2026-04-13T00:03:00.000Z", current_duration_ms: null },
				audit: { enter_count: 1, last_entered_at: "2026-04-13T00:04:00.000Z", current_duration_ms: null },
				"execution-loop": { enter_count: 5, last_entered_at: "2026-04-13T00:05:00.000Z", current_duration_ms: 60 * 60 * 1000 },
				closeout: { enter_count: 0, last_entered_at: null, current_duration_ms: null },
			},
		};

		const watchdog = evaluateMissionWatchdog(metrics, {
			...DEFAULT_MISSION_BUDGET_POLICY,
			max_wall_clock_minutes: 120,
			max_stage_duration_minutes: 30,
			max_stage_retries: 3,
			max_ambiguous_iterations: 2,
		});

		assert.equal(watchdog.decision, "escalate");
		assert.equal(
			watchdog.reasons.some((reason) => /wall-clock/i.test(reason)),
			true,
		);
		assert.equal(
			watchdog.reasons.some((reason) => /retry budget/i.test(reason)),
			true,
		);
		assert.equal(
			watchdog.reasons.some((reason) => /ambiguous/i.test(reason)),
			true,
		);
	});

	it("writes run-metrics, budget, and watchdog artifacts and records watchdog events", async () => {
		const repo = await initRepo();
		try {
			const runtime = await prepareMissionRuntime({
				repoRoot: repo,
				slug: "demo",
				targetFingerprint: "repo:demo",
				task: "Collect telemetry for Mission V2",
			});

			await recordMissionRuntimeLaneSummary(
				repo,
				"demo",
				"audit",
				auditSummary(1),
			);

			const mission = await loadMission(repo, "demo");
			const telemetry = await syncMissionTelemetry(mission, runtime.artifactPaths);
			const events = await loadMissionEvents(runtime.missionRoot);

			assert.equal(existsSync(runtime.artifactPaths.budgetPath), true);
			assert.equal(existsSync(runtime.artifactPaths.runMetricsPath), true);
			assert.equal(existsSync(runtime.artifactPaths.watchdogPath), true);
			assert.equal(
				events.some((event) => event.event_type === "watchdog_decision_recorded"),
				true,
			);
			assert.equal(telemetry.metrics.lane_summary_counts.audit, 1);
			const persistedWatchdog = JSON.parse(
				await readFile(runtime.artifactPaths.watchdogPath, "utf-8"),
			) as { decision: string };
			assert.equal(persistedWatchdog.decision, telemetry.watchdog.decision);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});
});
