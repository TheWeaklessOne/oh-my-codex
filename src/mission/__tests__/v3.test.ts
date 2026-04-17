import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import type { MissionLaneSummaryInput } from "../contracts.js";
import { loadMission } from "../kernel.js";
import {
	commitMissionRuntimeIteration,
	prepareMissionRuntime,
	recordMissionRuntimeLaneSummary,
} from "../runtime.js";
import {
	assertMissionV3ExecutionAllowed,
	appendMissionV3ContractAmendment,
	createMissionV3Candidate,
	createMissionV3Waiver,
	hybridizeMissionV3Candidates,
	promoteMissionV3Candidate,
	recordMissionV3LearningHeldOutEval,
	recordMissionV3LearningShadowEval,
	recordMissionV3ReleaseAction,
	rescindMissionV3CandidateSelection,
	selectMissionV3Candidate,
	syncMissionV3AfterCommit,
	transitionMissionV3LearningProposalState,
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
	const canonicalize = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
		if (value && typeof value === "object") {
			return Object.keys(value as Record<string, unknown>)
				.sort((left, right) => left.localeCompare(right))
				.reduce<Record<string, unknown>>((result, key) => {
					const entry = (value as Record<string, unknown>)[key];
					if (entry !== undefined) {
						result[key] = canonicalize(entry);
					}
					return result;
				}, {});
		}
		return value;
	};
	return `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(event))).digest("hex")}`;
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
			) as
				| {
						event_id: string;
						payload?: { cwd?: string };
				  }
				| undefined;
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
			assert.equal(
				auditAttestation.payload?.cwd?.endsWith("summary.json"),
				false,
			);
			assert.deepEqual(auditEvidence.payload?.command_attestation_refs, [
				auditAttestation.event_id,
			]);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("fails closed for policy path, network, secret-scope, command-binding, and source-trust violations", async () => {
		const repo = await initRepo();
		try {
			const runtime = await prepareMissionRuntime({
				repoRoot: repo,
				slug: "gate-demo",
				targetFingerprint: "repo:gate-demo",
				task: "Exercise Mission V3 execution guardrails",
			});
			const mission = await loadMission(repo, "gate-demo");
			const candidate = JSON.parse(
				await readFile(runtime.v3Paths.activeCandidateStatePath, "utf-8"),
			) as { candidate_id: string; workspace_root: string };
			const proofProgram = JSON.parse(
				await readFile(runtime.v3Paths.proofProgramPath, "utf-8"),
			) as { bindings: Array<{ proof_lane: string; command_refs: string[] }> };
			const checkerLock = JSON.parse(
				await readFile(runtime.v3Paths.checkerLockPath, "utf-8"),
			) as { checkers: Array<{ checker_id: string }> };
			const environmentContract = JSON.parse(
				await readFile(runtime.v3Paths.environmentContractPath, "utf-8"),
			) as {
				declared_secret_scopes: string[];
				declared_environment_hash: string;
				setup_network_allowlist: string[];
				runtime_network_allowlist: string[];
			};
			const policySnapshot = JSON.parse(
				await readFile(runtime.v3Paths.policySnapshotPath, "utf-8"),
			) as { source_trust_summary: Record<string, number> };
			const validWriteScope = relative(
				repo,
				join(candidate.workspace_root, "iterations", "001", "audit"),
			);

			await assert.rejects(
				assertMissionV3ExecutionAllowed({
					mission,
					paths: runtime.v3Paths,
					candidate: candidate as never,
					proofProgram: proofProgram as never,
					checkerLock: checkerLock as never,
					environmentContract: environmentContract as never,
					sourceTrustSummary: policySnapshot.source_trust_summary as never,
					laneType: "audit",
					proofLane: "reproduction",
					commandRef: "lane-summary:audit",
					writeScope: "../outside",
					networkMode: "repo-local",
					secretScopes: ["verifier:read-only"],
					actorPrincipal: "test-guardrails",
					idempotencyKey: "path-block",
				}),
				/mission_v3_policy_path_blocked:audit:\.\.\/outside/,
			);

			await assert.rejects(
				assertMissionV3ExecutionAllowed({
					mission,
					paths: runtime.v3Paths,
					candidate: candidate as never,
					proofProgram: proofProgram as never,
					checkerLock: checkerLock as never,
					environmentContract: environmentContract as never,
					sourceTrustSummary: policySnapshot.source_trust_summary as never,
					laneType: "audit",
					proofLane: "reproduction",
					commandRef: "lane-summary:audit",
					writeScope: validWriteScope,
					networkMode: "https://forbidden.example",
					secretScopes: ["verifier:read-only"],
					actorPrincipal: "test-guardrails",
					idempotencyKey: "network-block",
				}),
				/mission_v3_policy_network_blocked:audit:https:\/\/forbidden\.example/,
			);

			await assert.rejects(
				assertMissionV3ExecutionAllowed({
					mission,
					paths: runtime.v3Paths,
					candidate: candidate as never,
					proofProgram: proofProgram as never,
					checkerLock: checkerLock as never,
					environmentContract: environmentContract as never,
					sourceTrustSummary: policySnapshot.source_trust_summary as never,
					laneType: "audit",
					proofLane: "reproduction",
					commandRef: "lane-summary:audit",
					writeScope: validWriteScope,
					networkMode: "repo-local",
					secretScopes: ["undeclared:scope"],
					actorPrincipal: "test-guardrails",
					idempotencyKey: "secret-block",
				}),
				/mission_v3_secret_scope_undeclared:audit:undeclared:scope/,
			);

			await assert.rejects(
				assertMissionV3ExecutionAllowed({
					mission,
					paths: runtime.v3Paths,
					candidate: candidate as never,
					proofProgram: proofProgram as never,
					checkerLock: checkerLock as never,
					environmentContract: environmentContract as never,
					sourceTrustSummary: policySnapshot.source_trust_summary as never,
					laneType: "audit",
					proofLane: "reproduction",
					commandRef: "policy:security",
					writeScope: validWriteScope,
					networkMode: "repo-local",
					secretScopes: ["verifier:read-only"],
					actorPrincipal: "test-guardrails",
					idempotencyKey: "command-block",
				}),
				/mission_v3_proof_command_ref_mismatch:reproduction:policy:security/,
			);

			const lowTrustRepo = await initRepo();
			try {
				const lowTrustRuntime = await prepareMissionRuntime({
					repoRoot: lowTrustRepo,
					slug: "source-trust-demo",
					targetFingerprint: "repo:source-trust-demo",
					task: "Exercise source trust rejection",
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
				const lowTrustMission = await loadMission(lowTrustRepo, "source-trust-demo");
				const lowTrustCandidate = JSON.parse(
					await readFile(
						lowTrustRuntime.v3Paths.activeCandidateStatePath,
						"utf-8",
					),
				) as { workspace_root: string };
				const lowTrustProofProgram = JSON.parse(
					await readFile(lowTrustRuntime.v3Paths.proofProgramPath, "utf-8"),
				);
				const lowTrustCheckerLock = JSON.parse(
					await readFile(lowTrustRuntime.v3Paths.checkerLockPath, "utf-8"),
				);
				const lowTrustEnvironmentContract = JSON.parse(
					await readFile(
						lowTrustRuntime.v3Paths.environmentContractPath,
						"utf-8",
					),
				);
				const lowTrustPolicySnapshot = JSON.parse(
					await readFile(lowTrustRuntime.v3Paths.policySnapshotPath, "utf-8"),
				) as { source_trust_summary: Record<string, number> };
				await assert.rejects(
					assertMissionV3ExecutionAllowed({
						mission: lowTrustMission,
						paths: lowTrustRuntime.v3Paths,
						candidate: lowTrustCandidate as never,
						proofProgram: lowTrustProofProgram as never,
						checkerLock: lowTrustCheckerLock as never,
						environmentContract: lowTrustEnvironmentContract as never,
						sourceTrustSummary:
							lowTrustPolicySnapshot.source_trust_summary as never,
						laneType: "audit",
						proofLane: "reproduction",
						commandRef: "lane-summary:audit",
						writeScope: relative(
							lowTrustRepo,
							join(lowTrustCandidate.workspace_root, "iterations", "001", "audit"),
						),
						networkMode: "repo-local",
						secretScopes: ["verifier:read-only"],
						actorPrincipal: "test-guardrails",
						idempotencyKey: "source-trust-block",
					}),
					/mission_v3_source_trust_forbidden:reproduction:execution_forbidden/,
				);
			} finally {
				await rm(lowTrustRepo, { recursive: true, force: true });
			}
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
			const policyDecisions = await readNdjson<{
				payload?: {
					clause_id?: string;
					outcome?: string;
					source_trust_summary?: Record<string, number>;
				};
			}>(runtime.v3Paths.policyDecisionsPath);
			assert.equal(
				policyDecisions.some(
					(event) =>
						event.payload?.clause_id === "policy:promotion-governor" &&
						event.payload?.outcome === "require_revalidation",
				),
				true,
			);
			assert.equal(
				typeof policyDecisions.find(
					(event) => event.payload?.clause_id === "policy:promotion-governor",
				)?.payload?.source_trust_summary,
				"object",
			);
			const staleContextSnapshot = JSON.parse(
				await readFile(runtime.v3Paths.currentContextSnapshotPath, "utf-8"),
			) as {
				stale_fact_markers?: { stale_obligation_ids?: string[] };
			};
			assert.equal(
				(staleContextSnapshot.stale_fact_markers?.stale_obligation_ids
					?.length ?? 0) > 0,
				true,
			);
			const staleLearningProposal = JSON.parse(
				await readFile(
					join(runtime.v3Paths.learningProposalsDir, "current.json"),
					"utf-8",
				),
			) as {
				state?: string;
				rollout_path?: {
					current_state?: string;
					next_allowed_states?: string[];
				};
			};
			assert.equal(staleLearningProposal.state, "captured");
			assert.equal(
				staleLearningProposal.rollout_path?.current_state,
				"captured",
			);
			assert.deepEqual(
				staleLearningProposal.rollout_path?.next_allowed_states,
				["shadow_evaluated", "rejected"],
			);
			const compactionEventsBeforeReplay = await readNdjson<{
				payload?: {
					snapshot_hash?: string;
					stale_fact_markers?: { stale_obligation_ids?: string[] };
				};
			}>(runtime.v3Paths.compactionEventsPath);
			const compactionCountBeforeReplay = compactionEventsBeforeReplay.length;
			assert.equal(
				(compactionEventsBeforeReplay.at(-1)?.payload?.stale_fact_markers
					?.stale_obligation_ids?.length ?? 0) > 0,
				true,
			);
			await syncMissionV3AfterCommit({
				mission: committed.mission,
				artifacts: runtime.artifacts,
				artifactPaths: runtime.artifactPaths,
				safetyBaseline: {
					iteration_commit_succeeded: true,
					no_unreconciled_lane_errors: true,
					focused_checks_green: true,
				},
				iteration: 1,
				strategyChanged: false,
			});
			const policyDecisionsAfterReplay = await readNdjson(
				runtime.v3Paths.policyDecisionsPath,
			);
			const compactionEventsAfterReplay = await readNdjson(
				runtime.v3Paths.compactionEventsPath,
			);
			assert.equal(policyDecisionsAfterReplay.length, policyDecisions.length);
			assert.equal(
				compactionEventsAfterReplay.length,
				compactionCountBeforeReplay,
			);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	it("fails closed when setup runs are missing or runtime observations contradict environment parity", async () => {
		const repo = await initRepo();
		try {
			const runtime = await prepareMissionRuntime({
				repoRoot: repo,
				slug: "environment-demo",
				targetFingerprint: "repo:environment-demo",
				task: "Exercise Mission V3 environment parity failure branches",
			});

			await recordMissionRuntimeLaneSummary(
				repo,
				"environment-demo",
				"audit",
				verifierSummary("audit", 1, "PASS", verifierToken(runtime, "audit")),
			);
			await recordMissionRuntimeLaneSummary(
				repo,
				"environment-demo",
				"remediation",
				workSummary("remediation", 1),
			);
			await recordMissionRuntimeLaneSummary(
				repo,
				"environment-demo",
				"execution",
				workSummary("execution", 1),
			);
			await recordMissionRuntimeLaneSummary(
				repo,
				"environment-demo",
				"re_audit",
				verifierSummary(
					"re_audit",
					1,
					"PASS",
					verifierToken(runtime, "re_audit"),
				),
			);
			const originalSetupRuns = await readFile(
				runtime.v3Paths.setupRunsPath,
				"utf-8",
			);
			await writeFile(runtime.v3Paths.setupRunsPath, "", "utf-8");

			const committed = await commitMissionRuntimeIteration(repo, "environment-demo", {
				iteration_commit_succeeded: true,
				no_unreconciled_lane_errors: true,
				focused_checks_green: true,
			});
			assert.equal(committed.mission.lifecycle_state, "assuring");
			assert.equal(
				committed.mission.kernel_blockers.includes(
					"environment:missing successful environment setup run",
				),
				true,
			);
			await writeFile(runtime.v3Paths.setupRunsPath, originalSetupRuns, "utf-8");

			const observationEvents = await readNdjson<Array<Record<string, unknown>>>(
				runtime.v3Paths.runtimeObservationsPath,
			);
			const lastObservation = observationEvents.at(-1) as
				| {
						event_id: string;
						sequence: number;
						journal_type: string;
						recorded_at: string;
						mission_id: string;
						candidate_id?: string;
						lane_id?: string;
						actor_principal: string;
						causation_ref?: string | null;
						correlation_ref?: string | null;
						idempotency_key: string;
						payload_hash: string;
						payload: Record<string, unknown>;
				  }
				| undefined;
			assert.ok(lastObservation);
			const contradictoryPayload = {
				...(lastObservation?.payload ?? {}),
				env_hash: "sha256:contradictory",
			};
			const canonicalize = (value: unknown): unknown => {
				if (Array.isArray(value))
					return value.map((entry) => canonicalize(entry));
				if (value && typeof value === "object") {
					return Object.keys(value as Record<string, unknown>)
						.sort((left, right) => left.localeCompare(right))
						.reduce<Record<string, unknown>>((result, key) => {
							const entry = (value as Record<string, unknown>)[key];
							if (entry !== undefined) result[key] = canonicalize(entry);
							return result;
						}, {});
				}
				return value;
			};
			const payloadHash = `sha256:${createHash("sha256")
				.update(JSON.stringify(canonicalize(contradictoryPayload)))
				.digest("hex")}`;
			const contradictoryObservation = {
				...lastObservation,
				event_id: "runtime-observations:contradictory",
				sequence: Number(lastObservation?.sequence ?? 0) + 1,
				recorded_at: "2026-04-16T00:10:00.000Z",
				idempotency_key: "runtime-observation:contradictory",
				prev_event_hash: journalEventHash(lastObservation),
				payload_hash: payloadHash,
				payload: contradictoryPayload,
			};
			await writeFile(
				runtime.v3Paths.runtimeObservationsPath,
				`${(await readFile(runtime.v3Paths.runtimeObservationsPath, "utf-8")).trim()}\n${JSON.stringify(contradictoryObservation)}\n`,
				"utf-8",
			);

			const amended = await appendMissionV3ContractAmendment({
				repoRoot: repo,
				slug: "environment-demo",
				targetContract: "proof-program",
				authority: "test-amendment-authority",
				rationale: "Force a rebuild after environment contradiction.",
				scope: "environment-contradiction",
				affectedObligationIds: ["obl:reproduction"],
			});
			assert.equal(amended.target_contract, "proof-program");
			const refreshed = await loadMission(repo, "environment-demo");
			assert.equal(refreshed.lifecycle_state, "assuring");
			assert.equal(
				refreshed.kernel_blockers.some((value) =>
					value.startsWith(
						"environment:runtime observation contradicted environment parity",
					),
				),
				true,
			);
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

	it("rejects late lane writes after candidate switching and refreshes envelopes for the new active candidate", async () => {
		const repo = await initRepo();
		try {
			const runtime = await prepareMissionRuntime({
				repoRoot: repo,
				slug: "candidate-switch-demo",
				targetFingerprint: "repo:candidate-switch-demo",
				task: "Reject stale candidate writes after selection changes.",
				highRisk: true,
			});
			const candidate2 = await createMissionV3Candidate({
				repoRoot: repo,
				slug: "candidate-switch-demo",
				rationale: "Promote an alternate candidate before old audit output lands.",
				trigger: "ambiguity",
			});
			await selectMissionV3Candidate({
				repoRoot: repo,
				slug: "candidate-switch-demo",
				candidateId: candidate2.candidate_id,
				reason: "Candidate 002 is now the active execution branch.",
			});
			await assert.rejects(
				recordMissionRuntimeLaneSummary(
					repo,
					"candidate-switch-demo",
					"audit",
					verifierSummary(
						"audit",
						1,
						"PASS",
						verifierToken(runtime, "audit"),
					),
				),
				/lane_candidate_envelope_stale/i,
			);
			const refreshed = await prepareMissionRuntime({
				repoRoot: repo,
				slug: "candidate-switch-demo",
				targetFingerprint: "repo:candidate-switch-demo",
				task: "Resume after candidate switch.",
				highRisk: true,
			});
			assert.equal(
				refreshed.lanePlans.audit?.executionEnvelope.candidate_id,
				"candidate-002",
			);
			await recordMissionRuntimeLaneSummary(
				repo,
				"candidate-switch-demo",
				"audit",
				verifierSummary(
					"audit",
					1,
					"PASS",
					verifierToken(refreshed, "audit"),
				),
			);
			assert.equal(
				existsSync(
					join(
						repo,
						".omx",
						"missions",
						"candidate-switch-demo",
						"candidates",
						"candidate-002",
						"iterations",
						"001",
						"audit",
						"summary.json",
					),
				),
				true,
			);
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
				highRisk: true,
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
			await writeFile(runtime.v3Paths.adjudicationPath, "{}", "utf-8");
			await rm(runtime.v3Paths.releaseNotesPath, { force: true });
			await assert.rejects(
				promoteMissionV3Candidate({
					repoRoot: repo,
					slug: "promotion-artifacts-demo",
					actor: "test-release-bot",
					summary: "Attempt to promote with missing release notes.",
				}),
				/mission_v3_promote_missing_artifacts:release-notes\.md/,
			);
			await writeFile(runtime.v3Paths.releaseNotesPath, "# Release Notes\n", "utf-8");
			await rm(runtime.v3Paths.rollbackPlanPath, { force: true });
			await assert.rejects(
				promoteMissionV3Candidate({
					repoRoot: repo,
					slug: "promotion-artifacts-demo",
					actor: "test-release-bot",
					summary: "Attempt to promote with missing rollback plan.",
				}),
				/mission_v3_promote_missing_artifacts:rollback-plan\.md/,
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
				authority: "mission-auto-policy",
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
				authority: "mission-auto-policy",
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
				authority: "mission-auto-policy",
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
			const contextSnapshot = JSON.parse(
				await readFile(runtime.v3Paths.currentContextSnapshotPath, "utf-8"),
			) as {
				authoritative_refs?: { mission_state?: string };
				derived_refs?: { trace_bundle?: string };
				stale_fact_markers?: { stale_obligation_ids?: string[] };
			};
			assert.equal(
				contextSnapshot.authoritative_refs?.mission_state,
				"mission.json",
			);
			assert.equal(
				contextSnapshot.derived_refs?.trace_bundle,
				"traces/trace-bundle.json",
			);
			assert.deepEqual(
				contextSnapshot.stale_fact_markers?.stale_obligation_ids ?? [],
				[],
			);
			const learningProposal = JSON.parse(
				await readFile(
					join(runtime.v3Paths.learningProposalsDir, "current.json"),
					"utf-8",
				),
			) as {
				state?: string;
				rollout_path?: {
					current_state?: string;
					valid_states?: string[];
					audit_trail_refs?: string[];
				};
				source_trace_ref?: string;
				source_eval_ref?: string;
			};
			assert.equal(learningProposal.state, "captured");
			assert.equal(
				learningProposal.rollout_path?.current_state,
				"captured",
			);
			assert.deepEqual(learningProposal.rollout_path?.valid_states, [
				"captured",
				"shadow_evaluated",
				"approved_for_rollout",
				"rejected",
				"superseded",
			]);
			assert.equal(
				learningProposal.source_trace_ref,
				"traces/trace-bundle.json",
			);
			assert.equal(learningProposal.source_eval_ref, "traces/eval-bundle.json");
			assert.deepEqual(learningProposal.rollout_path?.audit_trail_refs, [
				"traces/trace-bundle.json",
				"traces/eval-bundle.json",
			]);
			const compactionEvents = await readNdjson<{
				payload?: {
					snapshot_hash?: string;
					source_ranges_summarized?: string[];
				};
			}>(runtime.v3Paths.compactionEventsPath);
			assert.equal(
				typeof compactionEvents.at(-1)?.payload?.snapshot_hash,
				"string",
			);
			assert.equal(
				compactionEvents
					.at(-1)
					?.payload?.source_ranges_summarized?.includes("mission.json"),
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
				authority: "mission-auto-policy",
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
				authority: "mission-auto-policy",
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
					scope: "wrong authority",
					authority: "test-waiver-authority",
					rationale: "Authority must match the obligation contract.",
					obligationIds: ["obl:static-analysis"],
				}),
				/mission_v3_waiver_authority_mismatch:obl:static-analysis:mission-auto-policy/,
			);
			await assert.rejects(
				createMissionV3Waiver({
					repoRoot: repo,
					slug: "waiver-demo",
					scope: "forbidden adjudication waiver",
					authority: "mission-auto-policy",
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
					authority: "mission-auto-policy",
					rationale:
						"Only waive third-party incorporation review for this test.",
					policyClauseIds: ["policy:third-party-incorporation"],
				});
				await assert.rejects(
					createMissionV3Waiver({
						repoRoot: policyRepo,
						slug: "policy-waiver-demo",
						scope: "wrong policy authority",
						authority: "test-waiver-authority",
						rationale: "Policy waivers must use the profile authority.",
						policyClauseIds: ["policy:third-party-incorporation"],
					}),
					/mission_v3_policy_waiver_authority_mismatch:mission-auto-policy/,
				);
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

	it("records learning shadow and held-out evaluations with gated state transitions", async () => {
		const repo = await initRepo();
		try {
			const runtime = await prepareMissionRuntime({
				repoRoot: repo,
				slug: "learning-demo",
				targetFingerprint: "repo:learning-demo",
				task: "Exercise Mission V3 learning proposal transitions",
			});
			await assert.rejects(
				recordMissionV3LearningHeldOutEval({
					repoRoot: repo,
					slug: "learning-demo",
					actor: "test-learning-bot",
					summary: "Held-out should not run before shadow evaluation.",
					approved: false,
				}),
				/mission_v3_learning_held_out_invalid_state:captured/,
			);
			const shadow = await recordMissionV3LearningShadowEval({
				repoRoot: repo,
				slug: "learning-demo",
				actor: "test-learning-bot",
				summary: "Shadow evaluation found reusable improvement signals.",
				findings: ["shadow-pass"],
			});
			assert.equal(shadow.state, "shadow_evaluated");
			assert.equal(existsSync(runtime.v3Paths.shadowEvalPath), true);
			const refreshedShadow = await recordMissionV3LearningShadowEval({
				repoRoot: repo,
				slug: "learning-demo",
				actor: "test-learning-bot",
				summary: "Shadow evaluation refreshed after new evidence.",
				findings: ["shadow-refresh"],
			});
			assert.equal(refreshedShadow.state, "shadow_evaluated");
			assert.equal(refreshedShadow.latest_shadow_eval_ref, runtime.v3Paths.shadowEvalPath);

			const approved = await recordMissionV3LearningHeldOutEval({
				repoRoot: repo,
				slug: "learning-demo",
				actor: "test-learning-bot",
				summary: "Held-out evaluation approved the rollout candidate.",
				findings: ["held-out-pass"],
				approved: true,
			});
			assert.equal(approved.state, "approved_for_rollout");
			assert.equal(existsSync(runtime.v3Paths.heldOutEvalPath), true);

			const superseded = await transitionMissionV3LearningProposalState({
				repoRoot: repo,
				slug: "learning-demo",
				actor: "test-learning-bot",
				nextState: "superseded",
				note: "A fresher proposal replaced this rollout candidate.",
			});
			assert.equal(superseded.state, "superseded");
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});
});
