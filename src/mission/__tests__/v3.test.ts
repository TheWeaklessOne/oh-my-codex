import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { MissionLaneSummaryInput } from "../contracts.js";
import { loadMission } from "../kernel.js";
import {
	commitMissionRuntimeIteration,
	prepareMissionRuntime,
	recordMissionRuntimeLaneSummary,
} from "../runtime.js";
import {
	createMissionV3Candidate,
	hybridizeMissionV3Candidates,
	recordMissionV3ReleaseAction,
	rescindMissionV3CandidateSelection,
	selectMissionV3Candidate,
} from "../v3.js";

async function initRepo(): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), "omx-mission-v3-"));
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

function verifierToken(
	runtime: Awaited<ReturnType<typeof prepareMissionRuntime>>,
	laneType: "audit" | "re_audit",
): string {
	const token =
		runtime.lanePlans[laneType]?.executionEnvelope.provenance_binding_token;
	if (!token) throw new Error(`missing verifier token for ${laneType}`);
	return token;
}

function verifierSummary(
	laneType: "audit" | "re_audit",
	iteration: number,
	verdict: "PASS" | "PARTIAL",
	runToken: string,
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
							target_path: "src/mission/runtime.ts",
							symbol: "prepareMissionRuntime",
						},
					],
		evidence_refs: [`logs/${laneType}.txt`],
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

function workSummary(
	laneType: "remediation" | "execution" | "hardening",
	iteration: number,
): MissionLaneSummaryInput {
	return {
		verdict: laneType === "execution" ? "PASS" : "PARTIAL",
		confidence: "high",
		residuals:
			laneType === "execution"
				? []
				: [
						{
							title: `${laneType} follow-up`,
							summary: `${laneType} follow-up`,
							severity: "medium",
							target_path: `src/mission/${laneType}.ts`,
						},
					],
		evidence_refs: [`logs/${laneType}.txt`],
		recommended_next_action:
			laneType === "execution" ? "handoff to verifier" : "continue execution",
		provenance: {
			lane_id: `${laneType}-lane-${iteration}`,
			session_id: `${laneType}-session-${iteration}`,
			lane_type: laneType,
			runner_type:
				laneType === "hardening"
					? "ralph"
					: laneType === "execution"
						? "team"
						: "direct",
			adapter_version: "mission-adapter/v1",
			started_at: "2026-04-11T17:01:00.000Z",
			finished_at: "2026-04-11T17:04:00.000Z",
			parent_iteration: iteration,
			trigger_reason: `${laneType} stage`,
		},
	};
}

async function readNdjson<T>(filePath: string): Promise<T[]> {
	const content = await readFile(filePath, "utf-8");
	return content
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => JSON.parse(line) as T);
}

describe("mission v3 surfaces", () => {
	it("bootstraps Mission V3 contracts, journals, and candidate state alongside the runtime", async () => {
		const repo = await initRepo();
		try {
			const runtime = await prepareMissionRuntime({
				repoRoot: repo,
				slug: "demo",
				targetFingerprint: "repo:demo",
				task: "Implement Mission V3 runtime surfaces",
				projectTouchpoints: ["src/mission/runtime.ts", "src/cli/mission.ts"],
				highRisk: true,
			});

			assert.equal(runtime.mission.mission_version, 3);
			assert.equal(runtime.mission.active_candidate_id, "candidate-001");
			assert.equal(runtime.mission.selected_candidate_id, "candidate-001");
			assert.equal(runtime.mission.lifecycle_state, "executing");
			assert.equal(existsSync(runtime.v3Paths.assuranceContractPath), true);
			assert.equal(existsSync(runtime.v3Paths.proofProgramPath), true);
			assert.equal(existsSync(runtime.v3Paths.checkerLockPath), true);
			assert.equal(existsSync(runtime.v3Paths.environmentContractPath), true);
			assert.equal(
				existsSync(runtime.v3Paths.environmentAttestationsPath),
				true,
			);
			assert.equal(existsSync(runtime.v3Paths.policySnapshotPath), true);
			assert.equal(existsSync(runtime.v3Paths.statusLedgerPath), true);
			assert.equal(existsSync(runtime.v3Paths.activeCandidateStatePath), true);

			const assurance = JSON.parse(
				await readFile(runtime.v3Paths.assuranceContractPath, "utf-8"),
			) as { obligations: Array<{ obligation_id: string }> };
			assert.equal(
				assurance.obligations.some(
					(obligation) => obligation.obligation_id === "obl:reproduction",
				),
				true,
			);
			assert.equal(
				assurance.obligations.some(
					(obligation) => obligation.obligation_id === "obl:static-analysis",
				),
				true,
			);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("records lane-run, command-attestation, and evidence journal entries for verifier lanes", async () => {
		const repo = await initRepo();
		try {
			const runtime = await prepareMissionRuntime({
				repoRoot: repo,
				slug: "demo",
				targetFingerprint: "repo:demo",
				task: "Record Mission V3 verifier evidence",
			});
			await recordMissionRuntimeLaneSummary(
				repo,
				"demo",
				"audit",
				verifierSummary("audit", 1, "PARTIAL", verifierToken(runtime, "audit")),
			);

			const laneRuns = await readNdjson<Array<Record<string, unknown>>>(
				runtime.v3Paths.laneRunsPath,
			);
			const attestations = await readNdjson<Array<Record<string, unknown>>>(
				runtime.v3Paths.commandAttestationsPath,
			);
			const evidence = await readNdjson<Array<Record<string, unknown>>>(
				runtime.v3Paths.evidenceEventsPath,
			);

			assert.equal(laneRuns.length >= 1, true);
			assert.equal(attestations.length >= 1, true);
			assert.equal(evidence.length >= 1, true);
			assert.equal(
				laneRuns.some(
					(event) =>
						String(
							(event as { payload?: { source_lane_type?: string } }).payload
								?.source_lane_type,
						) === "audit",
				),
				true,
			);
			assert.equal(
				evidence.some(
					(event) =>
						String(
							(event as { payload?: { evidence_kind?: string } }).payload
								?.evidence_kind,
						) === "lane_summary",
				),
				true,
			);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("fails closed on stale environment attestations even when the V2 kernel would otherwise close", async () => {
		const repo = await initRepo();
		try {
			const runtime = await prepareMissionRuntime({
				repoRoot: repo,
				slug: "demo",
				targetFingerprint: "repo:demo",
				task: "Gate Mission V3 closure on fresh environment parity",
			});

			await recordMissionRuntimeLaneSummary(
				repo,
				"demo",
				"audit",
				verifierSummary("audit", 1, "PASS", verifierToken(runtime, "audit")),
			);
			await recordMissionRuntimeLaneSummary(
				repo,
				"demo",
				"remediation",
				workSummary("remediation", 1),
			);
			await recordMissionRuntimeLaneSummary(
				repo,
				"demo",
				"execution",
				workSummary("execution", 1),
			);
			await recordMissionRuntimeLaneSummary(
				repo,
				"demo",
				"re_audit",
				verifierSummary(
					"re_audit",
					1,
					"PASS",
					verifierToken(runtime, "re_audit"),
				),
			);

			const attestationLines = (
				await readFile(runtime.v3Paths.environmentAttestationsPath, "utf-8")
			)
				.trim()
				.split(/\r?\n/)
				.filter(Boolean);
			const latestAttestation = JSON.parse(attestationLines.at(-1) || "{}") as {
				payload: { expires_at?: string };
			};
			latestAttestation.payload.expires_at = "2020-01-01T00:00:00.000Z";
			attestationLines[attestationLines.length - 1] =
				JSON.stringify(latestAttestation);
			await writeFile(
				runtime.v3Paths.environmentAttestationsPath,
				`${attestationLines.join("\n")}\n`,
				"utf-8",
			);

			const committed = await commitMissionRuntimeIteration(repo, "demo", {
				iteration_commit_succeeded: true,
				no_unreconciled_lane_errors: true,
				focused_checks_green: true,
			});

			assert.equal(committed.mission.status, "running");
			assert.equal(committed.mission.lifecycle_state, "assuring");
			assert.equal(committed.mission.promotion_state.status, "blocked");
			assert.equal(
				committed.mission.verification_state.stale_obligation_ids.length > 0,
				true,
			);
			const refreshed = await loadMission(repo, "demo");
			assert.equal(refreshed.status, "running");
			assert.equal(refreshed.lifecycle_state, "assuring");
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("supports multi-candidate portfolio operations with selection, rescission, and hybrid lineage", async () => {
		const repo = await initRepo();
		try {
			const runtime = await prepareMissionRuntime({
				repoRoot: repo,
				slug: "demo",
				targetFingerprint: "repo:demo",
				task: "Drive Mission V3 candidate portfolio",
				highRisk: true,
			});

			const candidate2 = await createMissionV3Candidate({
				repoRoot: repo,
				slug: "demo",
				rationale: "Explore an ambiguity-driven alternate remediation branch.",
				trigger: "ambiguity",
			});
			const candidate3 = await hybridizeMissionV3Candidates({
				repoRoot: repo,
				slug: "demo",
				rationale:
					"Synthesize the strongest parts of the first two candidate branches.",
				trigger: "hybrid",
				parentCandidateIds: ["candidate-001", candidate2.candidate_id],
			});
			assert.equal(candidate2.candidate_id, "candidate-002");
			assert.equal(candidate3.candidate_id, "candidate-003");

			const selected = await selectMissionV3Candidate({
				repoRoot: repo,
				slug: "demo",
				candidateId: candidate2.candidate_id,
				reason: "Candidate 002 has the best portfolio signal so far.",
			});
			assert.equal(selected.active_candidate_id, "candidate-002");
			assert.equal(selected.selected_candidate_id, "candidate-002");

			const rescinded = await rescindMissionV3CandidateSelection({
				repoRoot: repo,
				slug: "demo",
				candidateId: candidate2.candidate_id,
				reason:
					"Fresh contradictions invalidated candidate 002 before release.",
			});
			assert.equal(rescinded.active_candidate_id, "candidate-001");
			assert.equal(rescinded.selected_candidate_id, null);
			assert.equal(
				rescinded.kernel_blockers.includes("selection_rescinded:candidate-002"),
				true,
			);
			assert.equal(rescinded.lifecycle_state, "executing");

			await recordMissionRuntimeLaneSummary(
				repo,
				"demo",
				"audit",
				verifierSummary("audit", 1, "PARTIAL", verifierToken(runtime, "audit")),
			);
			const laneRuns = await readNdjson<Array<Record<string, unknown>>>(
				runtime.v3Paths.laneRunsPath,
			);
			const latestLaneRun = laneRuns.at(-1) as
				| { candidate_id?: string; payload?: { candidate_id?: string } }
				| undefined;
			assert.equal(
				latestLaneRun?.candidate_id ??
					latestLaneRun?.payload?.candidate_id ??
					null,
				"candidate-001",
			);
			const candidate2State = JSON.parse(
				await readFile(
					join(
						repo,
						".omx",
						"missions",
						"demo",
						"candidates",
						"candidate-002",
						"candidate-state.json",
					),
					"utf-8",
				),
			) as { state: string };
			assert.equal(candidate2State.state, "blocked");

			await assert.rejects(
				createMissionV3Candidate({
					repoRoot: repo,
					slug: "demo",
					rationale: "Attempt to exceed the portfolio cap.",
					trigger: "high_value",
				}),
				/mission_v3_candidate_cap_exceeded/,
			);

			const tournament = JSON.parse(
				await readFile(
					join(repo, ".omx", "missions", "demo", "candidate-tournament.json"),
					"utf-8",
				),
			) as { candidates: Array<{ candidate_id: string }> };
			assert.equal(tournament.candidates.length, 3);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("keeps promotion, release, handoff, and learning artifacts distinct", async () => {
		const repo = await initRepo();
		try {
			const runtime = await prepareMissionRuntime({
				repoRoot: repo,
				slug: "demo",
				targetFingerprint: "repo:demo",
				task: "Separate Mission V3 promotion and release semantics",
			});
			await assert.rejects(
				recordMissionV3ReleaseAction({
					repoRoot: repo,
					slug: "demo",
					action: "released",
					actor: "test-release-bot",
					summary: "Attempt to release before promotion readiness.",
				}),
				/mission_v3_release_requires_promotion_ready:executing/,
			);

			await recordMissionRuntimeLaneSummary(
				repo,
				"demo",
				"audit",
				verifierSummary("audit", 1, "PASS", verifierToken(runtime, "audit")),
			);
			await recordMissionRuntimeLaneSummary(
				repo,
				"demo",
				"remediation",
				workSummary("remediation", 1),
			);
			await recordMissionRuntimeLaneSummary(
				repo,
				"demo",
				"execution",
				workSummary("execution", 1),
			);
			await recordMissionRuntimeLaneSummary(
				repo,
				"demo",
				"re_audit",
				verifierSummary(
					"re_audit",
					1,
					"PASS",
					verifierToken(runtime, "re_audit"),
				),
			);

			const committed = await commitMissionRuntimeIteration(repo, "demo", {
				iteration_commit_succeeded: true,
				no_unreconciled_lane_errors: true,
				focused_checks_green: true,
			});
			assert.equal(committed.mission.lifecycle_state, "promotion_ready");
			assert.equal(committed.mission.status, "complete");
			assert.equal(existsSync(runtime.v3Paths.traceBundlePath), true);
			assert.equal(existsSync(runtime.v3Paths.evalBundlePath), true);
			assert.equal(existsSync(runtime.v3Paths.postmortemPath), true);
			assert.equal(
				existsSync(join(runtime.v3Paths.learningProposalsDir, "current.json")),
				true,
			);
			await createMissionV3Candidate({
				repoRoot: repo,
				slug: "demo",
				rationale: "Create a second candidate before rescission coverage.",
				trigger: "ambiguity",
			});
			await selectMissionV3Candidate({
				repoRoot: repo,
				slug: "demo",
				candidateId: "candidate-002",
				reason:
					"Move selection so rescission can invalidate release eligibility.",
			});
			await rescindMissionV3CandidateSelection({
				repoRoot: repo,
				slug: "demo",
				candidateId: "candidate-002",
				reason:
					"Invalidate the current selected candidate before a new release action.",
			});
			await assert.rejects(
				recordMissionV3ReleaseAction({
					repoRoot: repo,
					slug: "demo",
					action: "handed_off",
					actor: "test-review-bot",
					summary: "Attempt handoff after rescission.",
				}),
				/mission_v3_release_requires_promotion_ready:assuring/,
			);

			const secondRepo = await initRepo();
			try {
				const secondRuntime = await prepareMissionRuntime({
					repoRoot: secondRepo,
					slug: "release-demo",
					targetFingerprint: "repo:release-demo",
					task: "Separate Mission V3 release semantics",
				});
				await recordMissionRuntimeLaneSummary(
					secondRepo,
					"release-demo",
					"audit",
					verifierSummary(
						"audit",
						1,
						"PASS",
						verifierToken(secondRuntime, "audit"),
					),
				);
				await recordMissionRuntimeLaneSummary(
					secondRepo,
					"release-demo",
					"remediation",
					workSummary("remediation", 1),
				);
				await recordMissionRuntimeLaneSummary(
					secondRepo,
					"release-demo",
					"execution",
					workSummary("execution", 1),
				);
				await recordMissionRuntimeLaneSummary(
					secondRepo,
					"release-demo",
					"re_audit",
					verifierSummary(
						"re_audit",
						1,
						"PASS",
						verifierToken(secondRuntime, "re_audit"),
					),
				);
				await commitMissionRuntimeIteration(secondRepo, "release-demo", {
					iteration_commit_succeeded: true,
					no_unreconciled_lane_errors: true,
					focused_checks_green: true,
				});
				const released = await recordMissionV3ReleaseAction({
					repoRoot: secondRepo,
					slug: "release-demo",
					action: "released",
					actor: "test-release-bot",
					summary: "Released the verified candidate after promotion approval.",
					destination: "local-release-channel",
				});
				assert.equal(released.lifecycle_state, "released");
				assert.equal(released.status, "complete");
				assert.equal(existsSync(secondRuntime.v3Paths.releaseRecordPath), true);
			} finally {
				await rm(secondRepo, { recursive: true, force: true });
			}

			const thirdRepo = await initRepo();
			try {
				const thirdRuntime = await prepareMissionRuntime({
					repoRoot: thirdRepo,
					slug: "handoff-demo",
					targetFingerprint: "repo:handoff-demo",
					task: "Separate Mission V3 handoff semantics",
				});
				await recordMissionRuntimeLaneSummary(
					thirdRepo,
					"handoff-demo",
					"audit",
					verifierSummary(
						"audit",
						1,
						"PASS",
						verifierToken(thirdRuntime, "audit"),
					),
				);
				await recordMissionRuntimeLaneSummary(
					thirdRepo,
					"handoff-demo",
					"remediation",
					workSummary("remediation", 1),
				);
				await recordMissionRuntimeLaneSummary(
					thirdRepo,
					"handoff-demo",
					"execution",
					workSummary("execution", 1),
				);
				await recordMissionRuntimeLaneSummary(
					thirdRepo,
					"handoff-demo",
					"re_audit",
					verifierSummary(
						"re_audit",
						1,
						"PASS",
						verifierToken(thirdRuntime, "re_audit"),
					),
				);
				await commitMissionRuntimeIteration(thirdRepo, "handoff-demo", {
					iteration_commit_succeeded: true,
					no_unreconciled_lane_errors: true,
					focused_checks_green: true,
				});
				const handedOff = await recordMissionV3ReleaseAction({
					repoRoot: thirdRepo,
					slug: "handoff-demo",
					action: "handed_off",
					actor: "test-review-bot",
					summary:
						"Handed off the promotion-ready candidate for manual review.",
					destination: "review-queue",
				});
				assert.equal(handedOff.lifecycle_state, "handed_off");
				assert.equal(existsSync(thirdRuntime.v3Paths.handoffRecordPath), true);
			} finally {
				await rm(thirdRepo, { recursive: true, force: true });
			}
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});
});
