import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { MissionLaneType } from "./contracts.js";
import type { MissionState } from "./kernel.js";
import { writeAtomic } from "../team/state/io.js";

export type MissionLaneIsolationKind =
	| "shared_repo"
	| "detached_worktree"
	| "isolated_snapshot";
export type MissionLaneWritePolicy = "read_only" | "read_write";
export type MissionLaneCapabilityClass =
	| "verifier_read_only"
	| "direct_executor"
	| "team_executor"
	| "hardening_executor";

export interface MissionLaneExecutionEnvelope {
	schema_version: 2;
	mission_id: string;
	slug: string;
	iteration: number;
	lane_type: MissionLaneType;
	candidate_id: string;
	candidate_workspace_root: string;
	lane_root: string;
	lane_summary_path: string;
	workspace_path: string;
	isolation_kind: MissionLaneIsolationKind;
	write_policy: MissionLaneWritePolicy;
	capability_class: MissionLaneCapabilityClass;
	base_ref: string;
	provenance_binding_token?: string;
	provenance_binding_token_hash: string;
	provenance_binding_token_path: string | null;
	read_only_enforced: boolean;
}

function readGit(repoRoot: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd: repoRoot,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	}).trim();
}

function sanitize(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "") || "mission";
}

function hashValue(input: string): string {
	return createHash("sha256").update(input).digest("hex");
}

function verifierWorktreePath(repoRoot: string, mission: MissionState, iteration: number, laneType: MissionLaneType): string {
	const parent = dirname(repoRoot);
	const bucket = `${basename(repoRoot)}.omx-mission-worktrees`;
	return join(parent, bucket, sanitize(mission.slug), `${String(iteration).padStart(3, "0")}-${laneType}`);
}

function verifierSnapshotPath(
	mission: MissionState,
	iteration: number,
	laneType: MissionLaneType,
): string {
	return join(
		mission.mission_root,
		"iterations",
		String(iteration).padStart(3, "0"),
		laneType,
		"isolated-workspace",
	);
}

function candidateWorkspaceRoot(
	mission: MissionState,
	candidateId: string,
): string {
	return join(mission.mission_root, "candidates", candidateId);
}

function candidateIterationRoot(
	mission: MissionState,
	candidateId: string,
	iteration: number,
): string {
	return join(
		candidateWorkspaceRoot(mission, candidateId),
		"iterations",
		String(iteration).padStart(3, "0"),
	);
}

function candidateLaneRoot(
	mission: MissionState,
	candidateId: string,
	iteration: number,
	laneType: MissionLaneType,
): string {
	return join(candidateIterationRoot(mission, candidateId, iteration), laneType);
}

function provenanceBindingTokenPath(
	workspacePath: string,
	laneType: MissionLaneType,
	iteration: number,
): string {
	return join(
		workspacePath,
		`.omx-mission-${laneType}-${String(iteration).padStart(3, "0")}.token`,
	);
}

function ensureDetachedWorktree(repoRoot: string, worktreePath: string, baseRef: string): string {
	if (existsSync(worktreePath)) {
		const status = spawnSync("git", ["status", "--porcelain"], {
			cwd: worktreePath,
			encoding: "utf-8",
			windowsHide: true,
		});
		if (status.status !== 0) {
			throw new Error((status.stderr || "").trim() || `worktree_status_failed:${worktreePath}`);
		}
		if ((status.stdout || "").trim() !== "") {
			throw new Error(`verifier_worktree_dirty:${worktreePath}`);
		}
		return resolve(worktreePath);
	}

	mkdirSync(dirname(worktreePath), { recursive: true });
	const result = spawnSync("git", ["worktree", "add", "--detach", worktreePath, baseRef], {
		cwd: repoRoot,
		encoding: "utf-8",
		windowsHide: true,
	});
	if (result.status !== 0) {
		throw new Error((result.stderr || "").trim() || `git worktree add failed for ${worktreePath}`);
	}
	return resolve(worktreePath);
}

function materializeVerifierSnapshot(
	repoRoot: string,
	snapshotPath: string,
	baseRef: string,
): string {
	rmSync(snapshotPath, { recursive: true, force: true });
	mkdirSync(snapshotPath, { recursive: true });
	if (baseRef === "non-git") {
		for (const entry of readdirSync(repoRoot, { withFileTypes: true })) {
			if (entry.name === ".omx") continue;
			cpSync(join(repoRoot, entry.name), join(snapshotPath, entry.name), {
				recursive: true,
			});
		}
		return resolve(snapshotPath);
	}
	const archive = spawnSync("git", ["archive", "--format=tar", baseRef], {
		cwd: repoRoot,
		windowsHide: true,
	});
	if (archive.status !== 0 || !archive.stdout) {
		throw new Error(
			(archive.stderr || "").toString().trim()
				|| `git archive failed for ${baseRef}`,
		);
	}
	const extract = spawnSync("tar", ["-xf", "-", "-C", snapshotPath], {
		input: archive.stdout,
		windowsHide: true,
	});
	if (extract.status !== 0) {
		throw new Error(
			(extract.stderr || "").toString().trim()
				|| `tar extract failed for ${snapshotPath}`,
		);
	}
	return resolve(snapshotPath);
}

function envelopeFilePath(missionRoot: string, iteration: number, laneType: MissionLaneType): string {
	return join(
		missionRoot,
		"iterations",
		String(iteration).padStart(3, "0"),
		laneType,
		"execution-envelope.json",
	);
}

function candidateEnvelopeFilePath(
	mission: MissionState,
	candidateId: string,
	iteration: number,
	laneType: MissionLaneType,
): string {
	return join(
		candidateLaneRoot(mission, candidateId, iteration, laneType),
		"execution-envelope.json",
	);
}

interface PreparedMissionLaneEnvelope {
	envelope: MissionLaneExecutionEnvelope;
	provenanceToken: string | null;
}

function buildLaneEnvelope(
	mission: MissionState,
	repoRoot: string,
	iteration: number,
	laneType: MissionLaneType,
	baseRef: string,
): PreparedMissionLaneEnvelope {
	const candidateId = mission.active_candidate_id ?? "candidate-001";
	const laneRoot = candidateLaneRoot(mission, candidateId, iteration, laneType);
	const verifierLane = laneType === "audit" || laneType === "re_audit";
	const sharedExecutionLane = laneType === "execution";
	let workspacePath = resolve(repoRoot);
	let isolationKind: MissionLaneIsolationKind = "shared_repo";
	if (verifierLane) {
		try {
			workspacePath = ensureDetachedWorktree(
				repoRoot,
				verifierWorktreePath(repoRoot, mission, iteration, laneType),
				baseRef,
			);
			isolationKind = "detached_worktree";
		} catch {
			workspacePath = materializeVerifierSnapshot(
				repoRoot,
				verifierSnapshotPath(mission, iteration, laneType),
				baseRef,
			);
			isolationKind = "isolated_snapshot";
		}
	}
	const provenanceToken = verifierLane
		? randomBytes(24).toString("hex")
		: null;
	const tokenPath = verifierLane
		? provenanceBindingTokenPath(workspacePath, laneType, iteration)
		: null;
	return {
		envelope: {
			schema_version: 2,
			mission_id: mission.mission_id,
			slug: mission.slug,
			iteration,
			lane_type: laneType,
			candidate_id: candidateId,
			candidate_workspace_root: candidateWorkspaceRoot(mission, candidateId),
			lane_root: laneRoot,
			lane_summary_path: join(laneRoot, "summary.json"),
			workspace_path: workspacePath,
			isolation_kind: isolationKind,
			write_policy: verifierLane ? "read_only" : "read_write",
			capability_class: verifierLane
				? "verifier_read_only"
				: sharedExecutionLane
					? "team_executor"
					: laneType === "hardening"
						? "hardening_executor"
						: "direct_executor",
			base_ref: baseRef,
			...(provenanceToken != null
				? { provenance_binding_token: provenanceToken }
				: {}),
			provenance_binding_token_hash:
				provenanceToken != null ? `sha256:${hashValue(provenanceToken)}` : "",
			provenance_binding_token_path: tokenPath,
			read_only_enforced: verifierLane,
		},
		provenanceToken,
	};
}

export async function prepareMissionLaneExecutionEnvelopes(
	mission: MissionState,
	iteration: number,
): Promise<Record<MissionLaneType, MissionLaneExecutionEnvelope>> {
	const repoRoot = mission.repo_root;
	let baseRef = "non-git";
	try {
		baseRef = readGit(repoRoot, ["rev-parse", "HEAD"]);
	} catch {
		baseRef = "non-git";
	}
	const laneTypes: MissionLaneType[] = [
		"audit",
		"remediation",
		"execution",
		"hardening",
		"re_audit",
	];
	const preparedEnvelopes = Object.fromEntries(
		laneTypes.map((laneType) => [
			laneType,
			buildLaneEnvelope(mission, repoRoot, iteration, laneType, baseRef),
		]),
	) as Record<MissionLaneType, PreparedMissionLaneEnvelope>;
	for (const [laneType, prepared] of Object.entries(preparedEnvelopes) as Array<[MissionLaneType, PreparedMissionLaneEnvelope]>) {
		const { envelope, provenanceToken } = prepared;
		const persistedEnvelope = {
			...envelope,
			provenance_binding_token: undefined,
		};
		mkdirSync(dirname(candidateEnvelopeFilePath(mission, envelope.candidate_id, iteration, laneType)), {
			recursive: true,
		});
		await writeAtomic(
			envelopeFilePath(mission.mission_root, iteration, laneType),
			`${JSON.stringify(persistedEnvelope, null, 2)}\n`,
		);
		await writeAtomic(
			candidateEnvelopeFilePath(
				mission,
			envelope.candidate_id,
			iteration,
			laneType,
			),
			`${JSON.stringify(persistedEnvelope, null, 2)}\n`,
		);
		if (
			envelope.read_only_enforced &&
			envelope.provenance_binding_token_path &&
			provenanceToken != null
		) {
			await writeFile(
				envelope.provenance_binding_token_path,
				`${provenanceToken}\n`,
			);
		}
	}
	return Object.fromEntries(
		Object.entries(preparedEnvelopes).map(([laneType, prepared]) => [
			laneType,
			prepared.envelope,
		]),
	) as Record<MissionLaneType, MissionLaneExecutionEnvelope>;
}

export async function loadMissionLaneProvenanceToken(
	envelope: MissionLaneExecutionEnvelope,
): Promise<string | null> {
	if (!envelope.provenance_binding_token_path) return null;
	if (!existsSync(envelope.provenance_binding_token_path)) return null;
	return (await readFile(envelope.provenance_binding_token_path, "utf-8")).trim();
}

export async function loadMissionLaneExecutionEnvelope(
	missionRoot: string,
	iteration: number,
	laneType: MissionLaneType,
): Promise<MissionLaneExecutionEnvelope> {
	return JSON.parse(
		await readFile(envelopeFilePath(missionRoot, iteration, laneType), "utf-8"),
	) as MissionLaneExecutionEnvelope;
}

export function missionLaneExecutionEnvelopePath(
	missionRoot: string,
	iteration: number,
	laneType: MissionLaneType,
): string {
	return envelopeFilePath(missionRoot, iteration, laneType);
}
