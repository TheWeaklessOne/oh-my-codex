import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { prepareMissionRuntime, recordMissionRuntimeLaneSummary } from "../runtime.js";
import type { MissionLaneSummaryInput } from "../contracts.js";

async function initRepo(): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), "omx-mission-isolation-"));
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
	laneType: "audit" | "re_audit",
	iteration: number,
	runToken?: string,
): MissionLaneSummaryInput {
	return {
		verdict: "PASS",
		confidence: "high",
		residuals: [],
		evidence_refs: ["logs/verify.txt"],
		recommended_next_action: "close mission",
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
			run_token: runToken,
		},
	};
}

describe("mission verifier isolation", () => {
	it("creates detached verifier workspaces and shared execution workspaces", async () => {
		const repo = await initRepo();
		try {
			const runtime = await prepareMissionRuntime({
				repoRoot: repo,
				slug: "demo",
				targetFingerprint: "repo:demo",
				task: "Prepare mission lane isolation envelopes",
			});

			const auditEnvelope = runtime.lanePlans.audit?.executionEnvelope;
			const reAuditEnvelope = runtime.lanePlans.re_audit?.executionEnvelope;
			const executionEnvelope = runtime.lanePlans.execution?.executionEnvelope;

			assert.equal(existsSync(runtime.lanePlans.audit?.executionEnvelopePath || ""), true);
			assert.equal(existsSync(runtime.lanePlans.re_audit?.executionEnvelopePath || ""), true);
			assert.equal(auditEnvelope?.isolation_kind, "detached_worktree");
			assert.equal(reAuditEnvelope?.isolation_kind, "detached_worktree");
			assert.equal(executionEnvelope?.isolation_kind, "shared_repo");
			assert.equal(auditEnvelope?.write_policy, "read_only");
			assert.equal(reAuditEnvelope?.write_policy, "read_only");
			assert.equal(executionEnvelope?.write_policy, "read_write");
			assert.notEqual(auditEnvelope?.workspace_path, repo);
			assert.notEqual(reAuditEnvelope?.workspace_path, repo);
			assert.notEqual(auditEnvelope?.workspace_path, reAuditEnvelope?.workspace_path);
			assert.equal(auditEnvelope?.read_only_enforced, true);
			assert.equal(reAuditEnvelope?.read_only_enforced, true);
			assert.equal(executionEnvelope?.read_only_enforced, false);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("rejects verifier summaries that do not carry the expected provenance binding token", async () => {
		const repo = await initRepo();
		try {
			const runtime = await prepareMissionRuntime({
				repoRoot: repo,
				slug: "demo",
				targetFingerprint: "repo:demo",
				task: "Enforce verifier provenance tokens",
			});

			await assert.rejects(
				() =>
					recordMissionRuntimeLaneSummary(
						repo,
						"demo",
						"audit",
						verifierSummary("audit", 1, "lane-token:wrong"),
					),
				/lane_provenance_token_mismatch/i,
			);

			const ok = await recordMissionRuntimeLaneSummary(
				repo,
				"demo",
				"audit",
				verifierSummary(
					"audit",
					1,
					runtime.lanePlans.audit?.executionEnvelope.provenance_binding_token,
				),
			);
			assert.equal(ok.status, "written");
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("falls back to a readable isolated snapshot when the verifier worktree is unavailable", async () => {
		const repo = await initRepo();
		try {
			const first = await prepareMissionRuntime({
				repoRoot: repo,
				slug: "demo",
				targetFingerprint: "repo:demo",
				task: "Prepare mission verifier fallback isolation",
			});

			const auditWorkspace = first.lanePlans.audit?.executionEnvelope.workspace_path;
			// Dirty the detached worktree so the next prepare must fall back.
			await writeFile(join(auditWorkspace || repo, "DIRTY.txt"), "dirty\n", "utf-8");

			const resumed = await prepareMissionRuntime({
				repoRoot: repo,
				slug: "demo",
				targetFingerprint: "repo:demo",
				task: "Prepare mission verifier fallback isolation",
			});

			const auditEnvelope = resumed.lanePlans.audit?.executionEnvelope;
			assert.equal(auditEnvelope?.isolation_kind, "isolated_snapshot");
			assert.equal(existsSync(join(auditEnvelope?.workspace_path || "", "README.md")), true);
			assert.equal(existsSync(join(auditEnvelope?.workspace_path || "", ".git")), false);
			const readme = await readFile(
				join(auditEnvelope?.workspace_path || "", "README.md"),
				"utf-8",
			);
			assert.match(readme, /hello/);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});
});
