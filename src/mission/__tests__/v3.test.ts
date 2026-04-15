import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
	appendMissionV3ContractAmendment,
	createMissionV3Candidate,
	createMissionV3Waiver,
	hybridizeMissionV3Candidates,
	promoteMissionV3Candidate,
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

function journalEventHash(event: unknown): string {
	return `sha256:${createHash("sha256").update(JSON.stringify(event)).digest("hex")}`;
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
			const defaultCandidate = JSON.parse(
				await readFile(runtime.v3Paths.activeCandidateStatePath, "utf-8"),
			) as { workspace_root: string };
			assert.equal(
				defaultCandidate.workspace_root,
				join(repo, ".omx", "missions", "demo", "candidates", "candidate-001"),
			);
			assert.equal(
				existsSync(
					join(repo, ".omx", "missions", "demo", "candidate-state.json"),
				),
				false,
			);

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
			const auditLaneRun = laneRuns.find(
				(event) =>
					String(
						(event as { payload?: { source_lane_type?: string } }).payload
							?.source_lane_type,
					) === "audit",
			) as
				| {
						event_id: string;
						payload?: {
							lane_run_id?: string;
							command_attestation_refs?: string[];
						};
				  }
				| undefined;
			assert.ok(auditLaneRun);
			const auditAttestation = attestations.find(
				(event) =>
					String(
						(event as { payload?: { lane_run_id?: string } }).payload
							?.lane_run_id,
					) === auditLaneRun.payload?.lane_run_id,
			) as { event_id: string } | undefined;
			assert.ok(auditAttestation);
			const auditEvidence = evidence.find(
				(event) =>
					String(
						(event as { payload?: { lane_run_ref?: string } }).payload
							?.lane_run_ref,
					) === auditLaneRun.event_id,
			) as { payload?: { command_attestation_refs?: string[] } } | undefined;
			assert.ok(auditEvidence);
			assert.deepEqual(auditLaneRun.payload?.command_attestation_refs, [
				auditAttestation.event_id,
			]);
			assert.deepEqual(auditEvidence.payload?.command_attestation_refs, [
				auditAttestation.event_id,
			]);
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
			const selectedTournament = JSON.parse(
				await readFile(
					join(repo, ".omx", "missions", "demo", "candidate-tournament.json"),
					"utf-8",
				),
			) as {
				selected_candidate_id: string | null;
				candidates: Array<{ candidate_id: string; state: string }>;
			};
			assert.equal(selectedTournament.selected_candidate_id, "candidate-002");
			assert.equal(
				selectedTournament.candidates.some(
					(candidate) =>
						candidate.candidate_id === "candidate-002" &&
						candidate.state === "selected",
				),
				true,
			);

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
			const rescindedTournament = JSON.parse(
				await readFile(
					join(repo, ".omx", "missions", "demo", "candidate-tournament.json"),
					"utf-8",
				),
			) as {
				selected_candidate_id: string | null;
				candidates: Array<{ candidate_id: string; state: string }>;
			};
			assert.equal(rescindedTournament.selected_candidate_id, null);
			assert.equal(
				rescindedTournament.candidates.some(
					(candidate) =>
						candidate.candidate_id === "candidate-002" &&
						candidate.state === "blocked",
				),
				true,
			);

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
			const candidate2Events = await readNdjson<{
				payload?: { transition?: string };
			}>(
				join(
					repo,
					".omx",
					"missions",
					"demo",
					"candidates",
					"candidate-002",
					"candidate-events.ndjson",
				),
			);
			assert.equal(
				candidate2Events.some(
					(event) => event.payload?.transition === "candidate_selected",
				),
				true,
			);
			assert.equal(
				candidate2Events.some(
					(event) => event.payload?.transition === "candidate_rescinded",
				),
				true,
			);
			const candidate1Events = await readNdjson<{
				payload?: { transition?: string };
			}>(
				join(
					repo,
					".omx",
					"missions",
					"demo",
					"candidates",
					"candidate-001",
					"candidate-events.ndjson",
				),
			);
			assert.equal(
				candidate1Events.some(
					(event) => event.payload?.transition === "selection_cleared",
				),
				true,
			);

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

	it("records static-analysis lane runs during commit and blocks promotion when required artifacts disappear", async () => {
		const repo = await initRepo();
		try {
			const runtime = await prepareMissionRuntime({
				repoRoot: repo,
				slug: "promotion-artifacts-demo",
				targetFingerprint: "repo:promotion-artifacts-demo",
				task: "Keep Mission V3 promotion artifact checks strict",
			});
			await recordMissionRuntimeLaneSummary(
				repo,
				"promotion-artifacts-demo",
				"audit",
				verifierSummary("audit", 1, "PASS", verifierToken(runtime, "audit")),
			);
			await recordMissionRuntimeLaneSummary(
				repo,
				"promotion-artifacts-demo",
				"remediation",
				workSummary("remediation", 1),
			);
			await recordMissionRuntimeLaneSummary(
				repo,
				"promotion-artifacts-demo",
				"execution",
				workSummary("execution", 1),
			);
			await recordMissionRuntimeLaneSummary(
				repo,
				"promotion-artifacts-demo",
				"re_audit",
				verifierSummary(
					"re_audit",
					1,
					"PASS",
					verifierToken(runtime, "re_audit"),
				),
			);
			const committed = await commitMissionRuntimeIteration(
				repo,
				"promotion-artifacts-demo",
				{
					iteration_commit_succeeded: true,
					no_unreconciled_lane_errors: true,
					focused_checks_green: true,
				},
			);
			assert.equal(committed.mission.lifecycle_state, "verified");

			const laneRuns = await readNdjson<{
				event_id: string;
				payload?: {
					lane_type?: string;
					lane_run_id?: string;
					command_attestation_refs?: string[];
				};
			}>(runtime.v3Paths.laneRunsPath);
			const staticAnalysisLaneRun = laneRuns.find(
				(event) => event.payload?.lane_type === "static-analysis",
			);
			assert.ok(staticAnalysisLaneRun);
			const commandAttestations = await readNdjson<{
				event_id: string;
				payload?: { lane_run_id?: string };
			}>(runtime.v3Paths.commandAttestationsPath);
			const staticAnalysisCommand = commandAttestations.find(
				(event) =>
					event.payload?.lane_run_id ===
					staticAnalysisLaneRun?.payload?.lane_run_id,
			);
			assert.ok(staticAnalysisCommand);
			const evidenceEvents = await readNdjson<{
				payload?: {
					evidence_kind?: string;
					lane_run_ref?: string | null;
					command_attestation_refs?: string[];
				};
			}>(runtime.v3Paths.evidenceEventsPath);
			const staticAnalysisEvidence = evidenceEvents.find(
				(event) => event.payload?.evidence_kind === "focused_checks",
			);
			assert.equal(
				staticAnalysisEvidence?.payload?.lane_run_ref,
				staticAnalysisLaneRun?.event_id,
			);
			assert.deepEqual(
				staticAnalysisLaneRun?.payload?.command_attestation_refs,
				[staticAnalysisCommand?.event_id],
			);

			await rm(runtime.v3Paths.adjudicationPath, { force: true });
			await assert.rejects(
				promoteMissionV3Candidate({
					repoRoot: repo,
					slug: "promotion-artifacts-demo",
					actor: "test-release-bot",
					summary: "Attempt to promote with a missing adjudication artifact.",
				}),
				/mission_v3_promote_missing_artifacts:adjudication\.json/,
			);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("repairs truncated journal tails during idempotent replay and preserves the decision-log hash chain", async () => {
		const repo = await initRepo();
		try {
			const runtime = await prepareMissionRuntime({
				repoRoot: repo,
				slug: "journal-recovery-demo",
				targetFingerprint: "repo:journal-recovery-demo",
				task: "Exercise Mission V3 journal recovery semantics",
			});
			const firstWaiver = await createMissionV3Waiver({
				repoRoot: repo,
				slug: "journal-recovery-demo",
				scope: "temporary static-analysis exception",
				authority: "test-waiver-authority",
				rationale: "Use a deterministic waiver to test replay safety.",
				obligationIds: ["obl:static-analysis"],
			});
			const sentinel = '{"truncated_tail":';
			await writeFile(
				runtime.v3Paths.decisionLogPath,
				(await readFile(runtime.v3Paths.decisionLogPath, "utf-8")) + sentinel,
				"utf-8",
			);
			const replayedWaiver = await createMissionV3Waiver({
				repoRoot: repo,
				slug: "journal-recovery-demo",
				scope: "temporary static-analysis exception",
				authority: "test-waiver-authority",
				rationale: "Use a deterministic waiver to test replay safety.",
				obligationIds: ["obl:static-analysis"],
			});
			assert.equal(replayedWaiver.waiver_id, firstWaiver.waiver_id);
			const repairedDecisionLog = await readFile(
				runtime.v3Paths.decisionLogPath,
				"utf-8",
			);
			assert.equal(repairedDecisionLog.includes(sentinel), false);
			const afterReplayEvents = await readNdjson<{
				event_id: string;
				payload?: {
					decision?: string;
					waiver?: { waiver_id?: string };
				};
				sequence: number;
				prev_event_hash: string | null;
			}>(runtime.v3Paths.decisionLogPath);
			assert.equal(
				afterReplayEvents.filter(
					(event) =>
						event.payload?.decision === "waiver_created" &&
						event.payload?.waiver?.waiver_id === firstWaiver.waiver_id,
				).length,
				1,
			);
			await createMissionV3Waiver({
				repoRoot: repo,
				slug: "journal-recovery-demo",
				scope: "secondary reproduction exception",
				authority: "test-waiver-authority",
				rationale: "Append another decision after replay repair.",
				obligationIds: ["obl:reproduction"],
			});
			const finalEvents = await readNdjson<{
				event_id: string;
				payload?: { decision?: string };
				sequence: number;
				prev_event_hash: string | null;
			}>(runtime.v3Paths.decisionLogPath);
			const previous = finalEvents.at(-2);
			const latest = finalEvents.at(-1);
			assert.ok(previous);
			assert.ok(latest);
			assert.equal(latest.sequence, previous.sequence + 1);
			assert.equal(latest.prev_event_hash, journalEventHash(previous));
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("fails closed when the selected candidate state record is missing during promotion or release", async () => {
		const promoteRepo = await initRepo();
		try {
			const runtime = await prepareMissionRuntime({
				repoRoot: promoteRepo,
				slug: "selected-candidate-missing-promote",
				targetFingerprint: "repo:selected-candidate-missing-promote",
				task: "Fail closed when the selected candidate record disappears.",
			});
			await createMissionV3Candidate({
				repoRoot: promoteRepo,
				slug: "selected-candidate-missing-promote",
				rationale:
					"Keep another candidate around to prove there is no fallback.",
				trigger: "ambiguity",
			});
			await recordMissionRuntimeLaneSummary(
				promoteRepo,
				"selected-candidate-missing-promote",
				"audit",
				verifierSummary("audit", 1, "PASS", verifierToken(runtime, "audit")),
			);
			await recordMissionRuntimeLaneSummary(
				promoteRepo,
				"selected-candidate-missing-promote",
				"remediation",
				workSummary("remediation", 1),
			);
			await recordMissionRuntimeLaneSummary(
				promoteRepo,
				"selected-candidate-missing-promote",
				"execution",
				workSummary("execution", 1),
			);
			await recordMissionRuntimeLaneSummary(
				promoteRepo,
				"selected-candidate-missing-promote",
				"re_audit",
				verifierSummary(
					"re_audit",
					1,
					"PASS",
					verifierToken(runtime, "re_audit"),
				),
			);
			await commitMissionRuntimeIteration(
				promoteRepo,
				"selected-candidate-missing-promote",
				{
					iteration_commit_succeeded: true,
					no_unreconciled_lane_errors: true,
					focused_checks_green: true,
				},
			);
			await rm(runtime.v3Paths.activeCandidateStatePath, { force: true });
			await assert.rejects(
				promoteMissionV3Candidate({
					repoRoot: promoteRepo,
					slug: "selected-candidate-missing-promote",
					actor: "test-release-bot",
					summary:
						"Attempt to promote with the selected candidate record missing.",
				}),
				/mission_v3_selected_candidate_state_missing:candidate-001/,
			);
		} finally {
			await rm(promoteRepo, { recursive: true, force: true });
		}

		const releaseRepo = await initRepo();
		try {
			const runtime = await prepareMissionRuntime({
				repoRoot: releaseRepo,
				slug: "selected-candidate-missing-release",
				targetFingerprint: "repo:selected-candidate-missing-release",
				task: "Fail closed on release when the selected candidate record disappears.",
			});
			await createMissionV3Candidate({
				repoRoot: releaseRepo,
				slug: "selected-candidate-missing-release",
				rationale:
					"Keep another candidate around to prove there is no fallback.",
				trigger: "ambiguity",
			});
			await recordMissionRuntimeLaneSummary(
				releaseRepo,
				"selected-candidate-missing-release",
				"audit",
				verifierSummary("audit", 1, "PASS", verifierToken(runtime, "audit")),
			);
			await recordMissionRuntimeLaneSummary(
				releaseRepo,
				"selected-candidate-missing-release",
				"remediation",
				workSummary("remediation", 1),
			);
			await recordMissionRuntimeLaneSummary(
				releaseRepo,
				"selected-candidate-missing-release",
				"execution",
				workSummary("execution", 1),
			);
			await recordMissionRuntimeLaneSummary(
				releaseRepo,
				"selected-candidate-missing-release",
				"re_audit",
				verifierSummary(
					"re_audit",
					1,
					"PASS",
					verifierToken(runtime, "re_audit"),
				),
			);
			await commitMissionRuntimeIteration(
				releaseRepo,
				"selected-candidate-missing-release",
				{
					iteration_commit_succeeded: true,
					no_unreconciled_lane_errors: true,
					focused_checks_green: true,
				},
			);
			await promoteMissionV3Candidate({
				repoRoot: releaseRepo,
				slug: "selected-candidate-missing-release",
				actor: "test-review-bot",
				summary: "Promote before deleting the selected candidate record.",
			});
			await rm(runtime.v3Paths.activeCandidateStatePath, { force: true });
			await assert.rejects(
				recordMissionV3ReleaseAction({
					repoRoot: releaseRepo,
					slug: "selected-candidate-missing-release",
					action: "released",
					actor: "test-review-bot",
					summary:
						"Attempt to release with the selected candidate record missing.",
				}),
				/mission_v3_selected_candidate_state_missing:candidate-001/,
			);
		} finally {
			await rm(releaseRepo, { recursive: true, force: true });
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
			assert.equal(committed.mission.lifecycle_state, "verified");
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
				await assert.rejects(
					recordMissionV3ReleaseAction({
						repoRoot: secondRepo,
						slug: "release-demo",
						action: "released",
						actor: "test-release-bot",
						summary: "Attempt direct release from verified.",
					}),
					/mission_v3_release_requires_promotion_ready:verified/,
				);
				const promotionReady = await promoteMissionV3Candidate({
					repoRoot: secondRepo,
					slug: "release-demo",
					actor: "test-release-bot",
					summary:
						"Promote the verified candidate into the release-ready state.",
				});
				assert.equal(promotionReady.lifecycle_state, "promotion_ready");
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
				const releaseCandidateEvents = await readNdjson<{
					payload?: { transition?: string };
				}>(
					join(
						secondRepo,
						".omx",
						"missions",
						"release-demo",
						"candidates",
						"candidate-001",
						"candidate-events.ndjson",
					),
				);
				assert.equal(
					releaseCandidateEvents.some(
						(event) => event.payload?.transition === "promotion_ready",
					),
					true,
				);
				assert.equal(
					releaseCandidateEvents.some(
						(event) => event.payload?.transition === "released",
					),
					true,
				);
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
				await promoteMissionV3Candidate({
					repoRoot: thirdRepo,
					slug: "handoff-demo",
					actor: "test-review-bot",
					summary:
						"Promote the verified candidate into the handoff-ready state.",
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
				const handoffCandidateEvents = await readNdjson<{
					payload?: { transition?: string };
				}>(
					join(
						thirdRepo,
						".omx",
						"missions",
						"handoff-demo",
						"candidates",
						"candidate-001",
						"candidate-events.ndjson",
					),
				);
				assert.equal(
					handoffCandidateEvents.some(
						(event) => event.payload?.transition === "promotion_ready",
					),
					true,
				);
				assert.equal(
					handoffCandidateEvents.some(
						(event) => event.payload?.transition === "handed_off",
					),
					true,
				);
			} finally {
				await rm(thirdRepo, { recursive: true, force: true });
			}
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("supports waiver-driven verification and stale-proof demotion after contract amendments", async () => {
		const repo = await initRepo();
		try {
			const runtime = await prepareMissionRuntime({
				repoRoot: repo,
				slug: "waiver-demo",
				targetFingerprint: "repo:waiver-demo",
				task: "Exercise Mission V3 waiver and amendment semantics",
			});
			await recordMissionRuntimeLaneSummary(
				repo,
				"waiver-demo",
				"audit",
				verifierSummary("audit", 1, "PASS", verifierToken(runtime, "audit")),
			);
			await recordMissionRuntimeLaneSummary(
				repo,
				"waiver-demo",
				"remediation",
				workSummary("remediation", 1),
			);
			await recordMissionRuntimeLaneSummary(
				repo,
				"waiver-demo",
				"execution",
				workSummary("execution", 1),
			);
			await recordMissionRuntimeLaneSummary(
				repo,
				"waiver-demo",
				"re_audit",
				verifierSummary(
					"re_audit",
					1,
					"PASS",
					verifierToken(runtime, "re_audit"),
				),
			);

			const blocked = await commitMissionRuntimeIteration(repo, "waiver-demo", {
				iteration_commit_succeeded: true,
				no_unreconciled_lane_errors: true,
				focused_checks_green: false,
			});
			assert.equal(blocked.mission.lifecycle_state, "assuring");
			assert.equal(
				blocked.mission.verification_state.blocking_obligation_ids.includes(
					"obl:static-analysis",
				),
				true,
			);

			const expiredWaiver = await createMissionV3Waiver({
				repoRoot: repo,
				slug: "waiver-demo",
				scope: "expired static-analysis waiver",
				authority: "test-waiver-authority",
				rationale:
					"This waiver is already expired and must not unblock proofs.",
				obligationIds: ["obl:static-analysis"],
				expiresAt: "2020-01-01T00:00:00.000Z",
			});
			assert.equal(expiredWaiver.obligation_ids[0], "obl:static-analysis");
			const stillBlocked = await loadMission(repo, "waiver-demo");
			assert.equal(stillBlocked.lifecycle_state, "assuring");
			assert.equal(
				stillBlocked.verification_state.blocking_obligation_ids.includes(
					"obl:static-analysis",
				),
				true,
			);

			const waiver = await createMissionV3Waiver({
				repoRoot: repo,
				slug: "waiver-demo",
				scope: "temporary static-analysis exception",
				authority: "test-waiver-authority",
				rationale:
					"Demonstrate first-class waiver handling for a blocking obligation.",
				obligationIds: ["obl:static-analysis"],
				compensatingControls: ["manual reviewer sign-off"],
				evidenceRefs: ["manual-review.md"],
			});
			assert.equal(waiver.obligation_ids.includes("obl:static-analysis"), true);
			await assert.rejects(
				createMissionV3Waiver({
					repoRoot: repo,
					slug: "waiver-demo",
					scope: "forbidden adjudication waiver",
					authority: "test-waiver-authority",
					rationale: "Adjudication is not waivable.",
					obligationIds: ["obl:adjudication"],
				}),
				/mission_v3_waiver_forbidden:obl:adjudication/,
			);

			const verified = await loadMission(repo, "waiver-demo");
			assert.equal(verified.lifecycle_state, "verified");
			assert.equal(
				verified.verification_state.satisfied_obligation_ids.includes(
					"obl:adjudication",
				),
				true,
			);

			const policyRepo = await initRepo();
			try {
				const policyRuntime = await prepareMissionRuntime({
					repoRoot: policyRepo,
					slug: "policy-waiver-demo",
					targetFingerprint: "repo:policy-waiver-demo",
					task: "Exercise Mission V3 policy waiver scoping",
					requirementSources: [
						{
							content: "External low-trust material",
							origin: "external",
							retrievalStatus: "captured",
							trustLevel: "low",
							title: "external-note",
						},
					],
				});
				assert.equal(policyRuntime.mission.kernel_blockers.length > 0, true);
				await createMissionV3Waiver({
					repoRoot: policyRepo,
					slug: "policy-waiver-demo",
					scope: "clear one policy blocker only",
					authority: "test-waiver-authority",
					rationale:
						"Only waive third-party incorporation review for this test.",
					policyClauseIds: ["policy:third-party-incorporation"],
				});
				const policyMission = await loadMission(
					policyRepo,
					"policy-waiver-demo",
				);
				assert.equal(
					policyMission.kernel_blockers.includes(
						"policy:source-trust:require_review",
					),
					true,
				);
				assert.equal(
					policyMission.kernel_blockers.includes(
						"policy:third-party-incorporation:require_review",
					),
					false,
				);
			} finally {
				await rm(policyRepo, { recursive: true, force: true });
			}

			const unrelatedAmendment = await appendMissionV3ContractAmendment({
				repoRoot: repo,
				slug: "waiver-demo",
				targetContract: "proof-program",
				authority: "test-amendment-authority",
				rationale: "Change an unrelated proof-program binding.",
				scope: "unrelated-proof-program-refresh",
				affectedObligationIds: ["obl:release-smoke"],
			});
			assert.equal(unrelatedAmendment.target_contract, "proof-program");
			const stillVerified = await loadMission(repo, "waiver-demo");
			assert.equal(stillVerified.lifecycle_state, "verified");
			const amendment = await appendMissionV3ContractAmendment({
				repoRoot: repo,
				slug: "waiver-demo",
				targetContract: "proof-program",
				authority: "test-amendment-authority",
				rationale:
					"Invalidate prior proof freshness after a proof-program change.",
				scope: "test-proof-program-refresh",
				affectedObligationIds: ["obl:reproduction", "obl:targeted-regression"],
			});
			assert.equal(amendment.target_contract, "proof-program");
			const beforeRetryContract = JSON.parse(
				await readFile(runtime.v3Paths.proofProgramPath, "utf-8"),
			) as { revision?: number };
			assert.equal(
				existsSync(
					join(
						repo,
						".omx",
						"missions",
						"waiver-demo",
						"contract-revisions",
						"proof-program",
						"revision-001.json",
					),
				),
				true,
			);
			const retriedAmendment = await appendMissionV3ContractAmendment({
				repoRoot: repo,
				slug: "waiver-demo",
				targetContract: "proof-program",
				authority: "test-amendment-authority",
				rationale:
					"Invalidate prior proof freshness after a proof-program change.",
				scope: "test-proof-program-refresh",
				affectedObligationIds: ["obl:reproduction", "obl:targeted-regression"],
			});
			const afterRetryContract = JSON.parse(
				await readFile(runtime.v3Paths.proofProgramPath, "utf-8"),
			) as { revision?: number };
			assert.equal(retriedAmendment.amendment_id, amendment.amendment_id);
			assert.equal(afterRetryContract.revision, beforeRetryContract.revision);
			assert.equal(
				existsSync(
					join(
						repo,
						".omx",
						"missions",
						"waiver-demo",
						"contract-revisions",
						"proof-program",
						`revision-${String(beforeRetryContract.revision ?? 0).padStart(3, "0")}.json`,
					),
				),
				true,
			);
			const amendmentEvents = await readNdjson<{
				payload?: { amendment_id?: string };
			}>(runtime.v3Paths.contractAmendmentsPath);
			assert.equal(
				amendmentEvents.filter(
					(event) => event.payload?.amendment_id === amendment.amendment_id,
				).length,
				1,
			);

			const demoted = await loadMission(repo, "waiver-demo");
			assert.equal(demoted.lifecycle_state, "assuring");
			assert.equal(
				demoted.verification_state.stale_obligation_ids.length > 0,
				true,
			);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});
});
