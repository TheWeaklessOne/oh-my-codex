import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
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
	schema_version: 1;
	mission_id: string;
	slug: string;
	iteration: number;
	lane_type: MissionLaneType;
	workspace_path: string;
	isolation_kind: MissionLaneIsolationKind;
	write_policy: MissionLaneWritePolicy;
	capability_class: MissionLaneCapabilityClass;
	base_ref: string;
	provenance_binding_token: string;
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
	let hash = 0;
	for (let i = 0; i < input.length; i += 1) {
		hash = ((hash << 5) - hash) + input.charCodeAt(i);
		hash |= 0;
	}
	return Math.abs(hash).toString(16);
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

function envelopeFilePath(missionRoot: string, iteration: number, laneType: MissionLaneType): string {
	return join(
		missionRoot,
		"iterations",
		String(iteration).padStart(3, "0"),
		laneType,
		"execution-envelope.json",
	);
}

function buildLaneEnvelope(
	mission: MissionState,
	repoRoot: string,
	iteration: number,
	laneType: MissionLaneType,
	baseRef: string,
): MissionLaneExecutionEnvelope {
	const verifierLane = laneType === "audit" || laneType === "re_audit";
	const sharedExecutionLane = laneType === "execution";
	let workspacePath = resolve(repoRoot);
	let isolationKind: MissionLaneIsolationKind = "shared_repo";
	let effectiveBaseRef = baseRef;
	if (verifierLane) {
		try {
			workspacePath = ensureDetachedWorktree(
				repoRoot,
				verifierWorktreePath(repoRoot, mission, iteration, laneType),
				baseRef,
			);
			isolationKind = "detached_worktree";
		} catch {
			workspacePath = resolve(
				verifierSnapshotPath(mission, iteration, laneType),
			);
			mkdirSync(workspacePath, { recursive: true });
			isolationKind = "isolated_snapshot";
			effectiveBaseRef = "non-git";
		}
	}
	return {
		schema_version: 1,
		mission_id: mission.mission_id,
		slug: mission.slug,
		iteration,
		lane_type: laneType,
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
		base_ref: effectiveBaseRef,
		provenance_binding_token: `lane-token:${hashValue(`${mission.mission_id}:${iteration}:${laneType}:${workspacePath}`)}`,
		read_only_enforced: verifierLane,
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
	const envelopes = Object.fromEntries(
		laneTypes.map((laneType) => [
			laneType,
			buildLaneEnvelope(mission, repoRoot, iteration, laneType, baseRef),
		]),
	) as Record<MissionLaneType, MissionLaneExecutionEnvelope>;
	for (const [laneType, envelope] of Object.entries(envelopes) as Array<[MissionLaneType, MissionLaneExecutionEnvelope]>) {
		await writeAtomic(
			envelopeFilePath(mission.mission_root, iteration, laneType),
			`${JSON.stringify(envelope, null, 2)}\n`,
		);
	}
	return envelopes;
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
