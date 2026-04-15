import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	createMissionV3Candidate,
	selectMissionV3Candidate,
} from "../../mission/v3.js";
import { missionCommand, parseMissionCliArgs } from "../mission.js";

function runOmx(cwd: string, argv: string[]) {
	const testDir = dirname(fileURLToPath(import.meta.url));
	const repoRoot = join(testDir, "..", "..", "..");
	const omxBin = join(repoRoot, "dist", "cli", "omx.js");
	return spawnSync(process.execPath, [omxBin, ...argv], {
		cwd,
		encoding: "utf-8",
		env: {
			...process.env,
			OMX_AUTO_UPDATE: "0",
			OMX_NOTIFY_FALLBACK: "0",
			OMX_HOOK_DERIVED_SIGNALS: "0",
		},
	});
}

describe("omx mission", () => {
	it("separates launch flags from mission text while preserving passthrough task words", () => {
		const parsed = parseMissionCliArgs([
			"--model",
			"gpt-5.4",
			"--provider=openai",
			"--config",
			"custom.toml",
			"--source",
			"https://tracker.example/issues/123",
			"--constraint",
			"do not break kernel authority",
			"--touchpoint",
			"src/mission/runtime.ts",
			"--high-risk",
			"audit",
			"this",
			"--",
			"--task-with-leading-dash",
		]);

		assert.equal(parsed.task, "audit this --task-with-leading-dash");
		assert.deepEqual(parsed.launchArgs, [
			"--model",
			"gpt-5.4",
			"--provider=openai",
			"--config",
			"custom.toml",
		]);
		assert.deepEqual(parsed.bootstrap.sourceRefs, [
			"https://tracker.example/issues/123",
		]);
		assert.deepEqual(parsed.bootstrap.constraints, [
			"do not break kernel authority",
		]);
		assert.deepEqual(parsed.bootstrap.touchpoints, ["src/mission/runtime.ts"]);
		assert.equal(parsed.bootstrap.highRisk, true);
	});

	it("documents mission in top-level help", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "omx-mission-help-"));
		try {
			const result = runOmx(cwd, ["--help"]);
			assert.equal(result.status, 0, result.stderr || result.stdout);
			assert.match(
				result.stdout,
				/omx mission\s+Launch Codex with mission supervisor mode active/i,
			);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("routes mission --help to command-local help", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "omx-mission-local-help-"));
		try {
			const result = runOmx(cwd, ["mission", "--help"]);
			assert.equal(result.status, 0, result.stderr || result.stdout);
			assert.match(
				result.stdout,
				/omx mission - Launch Codex with mission supervisor mode active/i,
			);
			assert.match(result.stdout, /omx mission \[mission goal text\.\.\.\]/i);
			assert.match(
				result.stdout,
				/uses team as the default coordinated executor/i,
			);
			assert.match(result.stdout, /Ralph only as a bounded fallback/i);
			assert.doesNotMatch(
				result.stdout,
				/oh-my-codex \(omx\) - Multi-agent orchestration for Codex CLI/i,
			);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("forwards launch args to Codex and restores the appendix env after launch", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "omx-mission-launch-"));
		const originalCwd = process.cwd();
		const previousAppendix = process.env.OMX_MISSION_APPEND_INSTRUCTIONS_FILE;

		try {
			process.chdir(cwd);
			const launches: string[][] = [];

			await missionCommand(
				["--model", "gpt-5.4", "--provider=openai", "close", "the", "mission"],
				{
					async launchWithHud(args) {
						launches.push(args);
						const appendix = process.env.OMX_MISSION_APPEND_INSTRUCTIONS_FILE;
						assert.ok(
							typeof appendix === "string" &&
								appendix.endsWith(".omx/mission/session-instructions.md"),
						);
						assert.equal(existsSync(appendix), true);
						const appendixContent = await readFile(appendix, "utf-8");
						assert.match(appendixContent, /Mission brief:/);
						assert.match(appendixContent, /Acceptance contract:/);
						assert.match(appendixContent, /Execution plan:/);
					},
				},
			);

			assert.deepEqual(launches, [
				[
					"--model",
					"gpt-5.4",
					"--provider=openai",
					"$mission close the mission",
				],
			]);
			assert.equal(
				process.env.OMX_MISSION_APPEND_INSTRUCTIONS_FILE,
				previousAppendix,
			);
		} finally {
			process.chdir(originalCwd);
			if (typeof previousAppendix === "string")
				process.env.OMX_MISSION_APPEND_INSTRUCTIONS_FILE = previousAppendix;
			else delete process.env.OMX_MISSION_APPEND_INSTRUCTIONS_FILE;
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("bootstraps Mission V2 artifacts from source-file inputs before launch", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "omx-mission-source-file-"));
		const originalCwd = process.cwd();
		try {
			process.chdir(cwd);
			await writeFile(
				join(cwd, "requirements.md"),
				"# Mission\n\nUse file-backed requirements.\n",
				"utf-8",
			);

			await missionCommand(
				[
					"--source-file",
					"requirements.md",
					"--desired-outcome",
					"Ship Mission V2",
					"implement",
					"mission",
					"workflow",
				],
				{
					async launchWithHud() {
						const sourcePack = JSON.parse(
							await readFile(
								join(
									cwd,
									".omx",
									"missions",
									"implement-mission-workflow",
									"source-pack.json",
								),
								"utf-8",
							),
						) as {
							desired_outcome: string;
							sources: Array<{
								refs: string[];
								content: string;
								source_uri: string;
								snapshot_id: string;
								content_hash: string;
								retrieval_status: string;
								trust_level: string;
							}>;
						};
						const workflow = JSON.parse(
							await readFile(
								join(
									cwd,
									".omx",
									"missions",
									"implement-mission-workflow",
									"workflow.json",
								),
								"utf-8",
							),
						) as {
							current_stage: string;
							artifact_refs: { mission_brief: string; execution_plan: string };
						};

						assert.equal(sourcePack.desired_outcome, "Ship Mission V2");
						assert.equal(
							sourcePack.sources.some((source) =>
								source.refs.includes("requirements.md"),
							),
							true,
						);
						assert.equal(
							sourcePack.sources.some((source) =>
								/Use file-backed requirements/i.test(source.content),
							),
							true,
						);
						assert.equal(
							sourcePack.sources.some((source) =>
								source.source_uri.startsWith("file://"),
							),
							true,
						);
						assert.equal(
							sourcePack.sources.every((source) =>
								source.snapshot_id.startsWith("snapshot:"),
							),
							true,
						);
						assert.equal(
							sourcePack.sources.every((source) =>
								source.content_hash.startsWith("content:"),
							),
							true,
						);
						assert.equal(
							sourcePack.sources.some(
								(source) => source.retrieval_status === "captured",
							),
							true,
						);
						assert.equal(
							sourcePack.sources.some(
								(source) => source.trust_level === "high",
							),
							true,
						);
						assert.equal(workflow.current_stage, "audit");
						assert.match(
							workflow.artifact_refs.mission_brief,
							/mission-brief\.md$/,
						);
						assert.match(
							workflow.artifact_refs.execution_plan,
							/execution-plan\.md$/,
						);
					},
				},
			);
		} finally {
			process.chdir(originalCwd);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("records partial source failures instead of silently dropping missing files", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "omx-mission-missing-source-"));
		const originalCwd = process.cwd();
		try {
			process.chdir(cwd);
			await missionCommand(
				["--source-file", "missing-requirements.md", "bootstrap", "mission"],
				{
					async launchWithHud() {
						const sourcePack = JSON.parse(
							await readFile(
								join(
									cwd,
									".omx",
									"missions",
									"bootstrap-mission",
									"source-pack.json",
								),
								"utf-8",
							),
						) as {
							sources: Array<{
								refs: string[];
								retrieval_status: string;
								partial_failure_reason: string | null;
							}>;
						};

						assert.equal(
							sourcePack.sources.some((source) =>
								source.refs.includes("missing-requirements.md"),
							),
							true,
						);
						assert.equal(
							sourcePack.sources.some(
								(source) => source.retrieval_status === "partial_failure",
							),
							true,
						);
						assert.equal(
							sourcePack.sources.some((source) =>
								/not found at launch/i.test(
									source.partial_failure_reason || "",
								),
							),
							true,
						);
					},
				},
			);
		} finally {
			process.chdir(originalCwd);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("rejects source-file paths that escape the repo root", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "omx-mission-outside-source-"));
		const originalCwd = process.cwd();
		const secretPath = join(tmpdir(), `omx-outside-secret-${Date.now()}.txt`);
		try {
			process.chdir(cwd);
			await writeFile(secretPath, "TOP SECRET\n", "utf-8");
			await missionCommand(
				["--source-file", relative(cwd, secretPath), "bootstrap", "mission"],
				{
					async launchWithHud() {
						const sourcePack = JSON.parse(
							await readFile(
								join(
									cwd,
									".omx",
									"missions",
									"bootstrap-mission",
									"source-pack.json",
								),
								"utf-8",
							),
						) as {
							sources: Array<{
								content: string;
								retrieval_status: string;
								partial_failure_reason: string | null;
								trust_level: string;
							}>;
						};
						assert.equal(
							sourcePack.sources.some(
								(source) =>
									source.retrieval_status === "partial_failure" &&
									/(outside|escapes) repo root/i.test(
										source.partial_failure_reason || "",
									),
							),
							true,
						);
						assert.equal(
							sourcePack.sources.some((source) =>
								/TOP SECRET/.test(source.content),
							),
							false,
						);
						assert.equal(
							sourcePack.sources.some(
								(source) => source.trust_level === "high",
							),
							false,
						);
					},
				},
			);
		} finally {
			process.chdir(originalCwd);
			await rm(secretPath, { force: true });
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("rejects conflicting mission reruns instead of silently reusing stale artifacts", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "omx-mission-conflict-"));
		const originalCwd = process.cwd();
		try {
			process.chdir(cwd);
			await missionCommand(
				["--constraint", "keep kernel authority", "bootstrap", "mission"],
				{
					async launchWithHud() {
						// no-op
					},
				},
			);

			await assert.rejects(
				missionCommand(
					[
						"--constraint",
						"route through alternate kernel",
						"bootstrap",
						"mission",
					],
					{
						async launchWithHud() {
							// no-op
						},
					},
				),
				/mission_target_mismatch:bootstrap-mission/,
			);
		} finally {
			process.chdir(originalCwd);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("prints a compact mission inspection view with artifact roles", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "omx-mission-inspect-"));
		const originalCwd = process.cwd();
		try {
			process.chdir(cwd);
			const printed: string[] = [];
			await missionCommand(["bootstrap", "mission"], {
				async launchWithHud() {
					// no-op
				},
			});

			await missionCommand(["inspect", "bootstrap-mission"], {
				print(message) {
					printed.push(message);
				},
			});

			const output = printed.join("\n");
			assert.match(output, /Mission: bootstrap-mission/);
			assert.match(output, /Artifacts:/);
			assert.match(output, /\[authoritative\].*mission\.json/);
			assert.match(output, /\[append_only\].*events\.ndjson/);
			assert.match(output, /\[canonical\].*planning-transaction\.json/);
			assert.match(output, /\[derived\].*workflow\.json/);
			assert.match(output, /\[canonical\].*assurance-contract\.json/);
			assert.match(output, /\[canonical\].*proof-program\.json/);
			assert.match(output, /\[canonical\].*environment-contract\.json/);
			assert.match(output, /\[authoritative\].*candidate-state\.json/);
			assert.match(output, /\[derived\].*status-ledger\.md/);
			assert.match(output, /\[derived\].*trace-bundle\.json/);
			assert.match(output, /\[derived\].*eval-bundle\.json/);
		} finally {
			process.chdir(originalCwd);
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("prints V3 artifact roles for the currently active candidate instead of candidate-001", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "omx-mission-inspect-candidate-"));
		const originalCwd = process.cwd();
		try {
			process.chdir(cwd);
			const printed: string[] = [];
			await missionCommand(["bootstrap", "mission"], {
				async launchWithHud() {
					// no-op
				},
			});
			await createMissionV3Candidate({
				repoRoot: cwd,
				slug: "bootstrap-mission",
				rationale:
					"Investigate an alternate candidate branch for inspect coverage.",
				trigger: "ambiguity",
			});
			await selectMissionV3Candidate({
				repoRoot: cwd,
				slug: "bootstrap-mission",
				candidateId: "candidate-002",
				reason: "Force inspect to render the non-default active candidate.",
			});

			await missionCommand(["inspect", "bootstrap-mission"], {
				print(message) {
					printed.push(message);
				},
			});

			const output = printed.join("\n");
			assert.match(output, /candidate-002\/candidate-state\.json/);
			assert.doesNotMatch(output, /candidate-001\/candidate-state\.json/);
		} finally {
			process.chdir(originalCwd);
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
