import { mkdir, readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  DEFAULT_MISSION_CLOSURE_POLICY,
  DEFAULT_MISSION_PLATEAU_POLICY,
  MISSION_LANE_POLICIES,
  MISSION_LANE_TYPES,
  closureMatrixDecision,
  computeResidualSetFingerprint,
  canTransitionMissionStatus,
  isResidualStableMatch,
  normalizeLaneSummary,
  type MissionClosurePolicy,
  type MissionResidual,
  type MissionLaneSummary,
  type MissionLaneSummaryInput,
  type MissionLaneType,
  type MissionPlateauPolicy,
  type MissionStatus,
  type MissionVerdict,
  severityRank,
} from './contracts.js';
import { writeAtomic } from '../team/state/io.js';

export interface MissionState {
  schema_version: 1;
  mission_id: string;
  slug: string;
  repo_root: string;
  mission_root: string;
  target_fingerprint: string;
  status: MissionStatus;
  started_at: string;
  updated_at: string;
  current_iteration: number;
  current_stage: MissionLaneType | 'idle' | 'judging';
  active_lanes: Array<{
    lane_id: string;
    session_id: string;
    lane_type: MissionLaneType;
    runner_type: 'team' | 'ralph' | 'direct';
    finished_at: string;
  }>;
  closure_policy: MissionClosurePolicy;
  plateau_policy: MissionPlateauPolicy;
  latest_verdict: MissionVerdict;
  latest_summary_path: string | null;
  latest_lane_provenance: Array<{
    lane_id: string;
    session_id: string;
    lane_type: MissionLaneType;
    runner_type: 'team' | 'ralph' | 'direct';
    finished_at: string;
  }>;
  unchanged_iterations: number;
  ambiguous_iterations: number;
  oscillation_count: number;
  last_residual_fingerprint: string | null;
  last_strategy_key: string | null;
  final_reason: string | null;
}

export interface MissionLatestSnapshot {
  mission_id: string;
  current_iteration: number;
  latest_lane: MissionLaneType;
  latest_verdict: MissionVerdict;
  latest_summary_path: string;
  updated_at: string;
}

export interface MissionDelta {
  previous_iteration: number | null;
  current_iteration: number;
  previous_verdict: MissionVerdict | null;
  current_verdict: MissionVerdict;
  improved_residual_ids: string[];
  unchanged_residual_ids: string[];
  regressed_residual_ids: string[];
  resolved_residual_ids: string[];
  introduced_residual_ids: string[];
  oscillating_residual_ids: string[];
  lineage_split_residual_ids: string[];
  lineage_merge_residual_ids: string[];
  low_confidence_residual_ids: string[];
  severity_rollup: {
    improved: number;
    unchanged: number;
    regressed: number;
    resolved: number;
    introduced: number;
  };
}

export interface MissionCreateOptions {
  repoRoot: string;
  slug: string;
  targetFingerprint?: string;
  startedAt?: string;
  closurePolicy?: Partial<MissionClosurePolicy>;
  plateauPolicy?: Partial<MissionPlateauPolicy>;
}

export interface MissionIterationHandle {
  iteration: number;
  resumed: boolean;
  iterationDir: string;
  laneDirs: Record<MissionLaneType, string>;
}

export interface MissionRecordLaneResult {
  status: 'written' | 'duplicate' | 'ignored';
  summaryPath: string;
  summary?: MissionLaneSummary;
  reason?: 'terminal' | 'superseded' | 'future' | 'duplicate' | 'cancelled';
}

export interface MissionSafetyBaseline {
  iteration_commit_succeeded: boolean;
  no_unreconciled_lane_errors: boolean;
  focused_checks_green: boolean;
}

export interface MissionJudgement {
  nextStatus: MissionStatus;
  reason: string;
  closureDecision: 'complete' | 'iterate' | 'failed';
}

export interface CommitIterationResult {
  mission: MissionState;
  delta: MissionDelta;
  latest: MissionLatestSnapshot;
  judgement: MissionJudgement;
}

function nowIso(): string {
  return new Date().toISOString();
}

function missionRoot(repoRoot: string, slug: string): string {
  return join(repoRoot, '.omx', 'missions', slug);
}

function missionPath(repoRoot: string, slug: string): string {
  return join(missionRoot(repoRoot, slug), 'mission.json');
}

function latestPath(repoRoot: string, slug: string): string {
  return join(missionRoot(repoRoot, slug), 'latest.json');
}

function iterationsRoot(repoRoot: string, slug: string): string {
  return join(missionRoot(repoRoot, slug), 'iterations');
}

function iterationId(iteration: number): string {
  return String(iteration).padStart(3, '0');
}

function iterationRoot(repoRoot: string, slug: string, iteration: number): string {
  return join(iterationsRoot(repoRoot, slug), iterationId(iteration));
}

function laneSummaryPath(repoRoot: string, slug: string, iteration: number, laneType: MissionLaneType): string {
  return join(iterationRoot(repoRoot, slug, iteration), laneType, 'summary.json');
}

function deltaPath(repoRoot: string, slug: string, iteration: number): string {
  return join(iterationRoot(repoRoot, slug, iteration), 'delta.json');
}

function expectedLatestSummaryPath(repoRoot: string, slug: string, iteration: number): string {
  return laneSummaryPath(repoRoot, slug, iteration, 're_audit');
}

function hashValue(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

function resolveTargetFingerprint(options: MissionCreateOptions): string {
  const raw = String(options.targetFingerprint || '').trim();
  if (raw) return raw;
  return `repo:${hashValue(options.repoRoot)}:slug:${hashValue(options.slug)}`;
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf-8')) as T;
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await writeAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function listMissionJsonFiles(repoRoot: string): Promise<string[]> {
  const root = join(repoRoot, '.omx', 'missions');
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name, 'mission.json'))
    .filter((filePath) => existsSync(filePath));
}

function isTerminalStatus(status: MissionStatus): boolean {
  return status === 'cancelled' || status === 'complete' || status === 'plateau' || status === 'failed';
}

export async function createMission(options: MissionCreateOptions): Promise<MissionState> {
  const target = resolveTargetFingerprint(options);
  const startedAt = options.startedAt ?? nowIso();
  const root = missionRoot(options.repoRoot, options.slug);

  for (const filePath of await listMissionJsonFiles(options.repoRoot)) {
    const existing = await readJsonFile<MissionState>(filePath);
    if (
      existing.target_fingerprint === target
      && !isTerminalStatus(existing.status)
      && basename(root) !== basename(existing.mission_root)
    ) {
      throw new Error(`mission_target_collision:${existing.slug}`);
    }
  }

  await mkdir(iterationsRoot(options.repoRoot, options.slug), { recursive: true });
  const missionId = `${options.slug}-${startedAt.replace(/[^0-9]/g, '').slice(0, 14)}-${hashValue(target)}`;
  const state: MissionState = {
    schema_version: 1,
    mission_id: missionId,
    slug: options.slug,
    repo_root: options.repoRoot,
    mission_root: root,
    target_fingerprint: target,
    status: 'running',
    started_at: startedAt,
    updated_at: startedAt,
    current_iteration: 1,
    current_stage: 'idle',
    active_lanes: [],
    closure_policy: { ...DEFAULT_MISSION_CLOSURE_POLICY, ...(options.closurePolicy ?? {}) },
    plateau_policy: { ...DEFAULT_MISSION_PLATEAU_POLICY, ...(options.plateauPolicy ?? {}) },
    latest_verdict: 'AMBIGUOUS',
    latest_summary_path: null,
    latest_lane_provenance: [],
    unchanged_iterations: 0,
    ambiguous_iterations: 0,
    oscillation_count: 0,
    last_residual_fingerprint: null,
    last_strategy_key: null,
    final_reason: null,
  };
  await writeJsonFile(missionPath(options.repoRoot, options.slug), state);
  return state;
}

export async function loadMission(repoRoot: string, slug: string): Promise<MissionState> {
  return readJsonFile<MissionState>(missionPath(repoRoot, slug));
}

export async function resumeMission(repoRoot: string, slug: string): Promise<MissionState> {
  return loadMission(repoRoot, slug);
}

function buildActiveLaneEntry(iteration: number, laneType: MissionLaneType): MissionState['active_lanes'][number] {
  const key = `${laneType}-${iteration}`;
  return {
    lane_id: `pending:${key}`,
    session_id: `pending:${key}`,
    lane_type: laneType,
    runner_type: MISSION_LANE_POLICIES[laneType].runnerType,
    finished_at: '',
  };
}

async function deriveActiveLanes(repoRoot: string, slug: string, iteration: number): Promise<MissionState['active_lanes']> {
  return MISSION_LANE_TYPES
    .filter((laneType) => !existsSync(laneSummaryPath(repoRoot, slug, iteration, laneType)))
    .map((laneType) => buildActiveLaneEntry(iteration, laneType));
}

function nextStageFromActiveLanes(activeLanes: MissionState['active_lanes']): MissionState['current_stage'] {
  return activeLanes[0]?.lane_type ?? 'judging';
}

async function isIterationCommitted(repoRoot: string, slug: string, mission: MissionState, iteration: number): Promise<boolean> {
  if (!existsSync(deltaPath(repoRoot, slug, iteration))) return false;
  const expectedSummaryPath = expectedLatestSummaryPath(repoRoot, slug, iteration);
  if (mission.latest_summary_path !== expectedSummaryPath) return false;
  if (!existsSync(latestPath(repoRoot, slug))) return false;
  const latest = await readJsonFile<MissionLatestSnapshot>(latestPath(repoRoot, slug));
  return latest.current_iteration === iteration && latest.latest_summary_path === expectedSummaryPath;
}

function removeActiveLane(
  mission: MissionState,
  laneType: MissionLaneType,
  laneSummary?: MissionLaneSummary,
): MissionState {
  const remaining = mission.active_lanes.filter((entry) => entry.lane_type !== laneType);
  const latestLaneProvenance = laneSummary
    ? [
        ...mission.latest_lane_provenance.filter((entry) => entry.lane_type !== laneType),
        {
          lane_id: laneSummary.provenance.lane_id,
          session_id: laneSummary.provenance.session_id,
          lane_type: laneSummary.provenance.lane_type,
          runner_type: laneSummary.provenance.runner_type,
          finished_at: laneSummary.provenance.finished_at,
        },
      ]
    : mission.latest_lane_provenance;

  const status =
    mission.status === 'cancelling' && remaining.length === 0
      ? 'cancelled'
      : mission.status;

  return {
    ...mission,
    status,
    updated_at: nowIso(),
    current_stage:
      status === 'cancelled'
        ? 'idle'
        : nextStageFromActiveLanes(remaining),
    active_lanes: remaining,
    latest_lane_provenance: latestLaneProvenance,
  };
}

export async function startIteration(repoRoot: string, slug: string, strategyKey?: string | null): Promise<MissionIterationHandle> {
  const mission = await loadMission(repoRoot, slug);
  if (isTerminalStatus(mission.status)) {
    throw new Error(`mission_terminal:${mission.status}`);
  }

  let iteration = mission.current_iteration;
  let resumed = existsSync(iterationRoot(repoRoot, slug, iteration));

  if (await isIterationCommitted(repoRoot, slug, mission, iteration)) {
    iteration += 1;
    resumed = false;
  }

  const baseDir = iterationRoot(repoRoot, slug, iteration);
  const laneDirs = Object.fromEntries(MISSION_LANE_TYPES.map((lane) => [lane, join(baseDir, lane)])) as Record<MissionLaneType, string>;
  await mkdir(baseDir, { recursive: true });
  for (const laneType of MISSION_LANE_TYPES) {
    await mkdir(laneDirs[laneType], { recursive: true });
  }

  const activeLanes = await deriveActiveLanes(repoRoot, slug, iteration);

  const nextMission: MissionState = {
    ...mission,
    current_iteration: iteration,
    current_stage: nextStageFromActiveLanes(activeLanes),
    updated_at: nowIso(),
    last_strategy_key: strategyKey ?? mission.last_strategy_key ?? null,
    active_lanes: activeLanes,
  };
  await writeJsonFile(missionPath(repoRoot, slug), nextMission);

  return {
    iteration,
    resumed,
    iterationDir: baseDir,
    laneDirs,
  };
}

function validateLaneIteration(mission: MissionState, iteration: number): MissionRecordLaneResult['reason'] | null {
  if (isTerminalStatus(mission.status)) return mission.status === 'cancelled' ? 'cancelled' : 'terminal';
  if (iteration < mission.current_iteration) return 'superseded';
  if (iteration > mission.current_iteration) return 'future';
  return null;
}

export async function recordLaneSummary(
  repoRoot: string,
  slug: string,
  iteration: number,
  laneType: MissionLaneType,
  summaryInput: MissionLaneSummaryInput,
): Promise<MissionRecordLaneResult> {
  const mission = await loadMission(repoRoot, slug);
  const invalidReason = validateLaneIteration(mission, iteration);
  const summaryFile = laneSummaryPath(repoRoot, slug, iteration, laneType);
  if (invalidReason) {
    return { status: 'ignored', summaryPath: summaryFile, reason: invalidReason };
  }
  const summary = normalizeLaneSummary(summaryInput);

  if (mission.status === 'cancelling') {
    const nextMission = removeActiveLane(mission, laneType, summary);
    await writeJsonFile(missionPath(repoRoot, slug), nextMission);
    return { status: 'ignored', summaryPath: summaryFile, reason: 'cancelled', summary };
  }

  if (existsSync(summaryFile)) {
    return { status: 'duplicate', summaryPath: summaryFile, reason: 'duplicate', summary: await readJsonFile<MissionLaneSummary>(summaryFile) };
  }

  await mkdir(join(iterationRoot(repoRoot, slug, iteration), laneType), { recursive: true });
  await writeJsonFile(summaryFile, summary);
  const nextMission = removeActiveLane(mission, laneType, summary);
  await writeJsonFile(missionPath(repoRoot, slug), nextMission);
  return { status: 'written', summaryPath: summaryFile, summary };
}

function loadResidualHistory(deltaHistory: MissionDelta[]): Set<string> {
  return new Set(deltaHistory.flatMap((delta) => delta.oscillating_residual_ids));
}

function isMergeLineageResidual(residual: MissionResidual): boolean {
  return residual.lineage?.kind === 'merge' && residual.lineage.related_residual_ids.length > 1;
}

function compareResiduals(previous: MissionLaneSummary | null, current: MissionLaneSummary, deltaHistory: MissionDelta[] = []): MissionDelta {
  const previousResiduals = previous?.residuals ?? [];
  const currentResiduals = current.residuals;
  const improved = new Set<string>();
  const unchanged = new Set<string>();
  const regressed = new Set<string>();
  const resolved = new Set<string>();
  const introduced = new Set<string>();
  const oscillating = loadResidualHistory(deltaHistory);
  const matchedCurrent = new Set<string>();
  const lineageSplit = new Set<string>();
  const lineageMerge = new Set<string>();
  const lowConfidence = new Set<string>();

  for (const prior of previousResiduals) {
    const matches = currentResiduals
      .map((candidate) => ({ candidate, matched: isResidualStableMatch(prior, candidate) }))
      .filter((entry) => entry.matched)
      .map((entry) => entry.candidate);
    if (matches.length === 0) {
      resolved.add(prior.stable_id);
      continue;
    }
    for (const candidate of matches) {
      matchedCurrent.add(candidate.stable_id);
      if (candidate.low_confidence_marker || prior.low_confidence_marker) {
        lowConfidence.add(prior.stable_id);
        lowConfidence.add(candidate.stable_id);
      }
    }
    if (matches.length > 1 && matches.some((candidate) => candidate.lineage?.kind === 'split')) {
      lineageSplit.add(prior.stable_id);
    }
    const exact = matches.reduce((best, candidate) => (
      severityRank(candidate.severity) < severityRank(best.severity) ? candidate : best
    ));
    if (exact.severity === prior.severity) {
      unchanged.add(prior.stable_id);
    } else if (severityRank(exact.severity) < severityRank(prior.severity)) {
      improved.add(prior.stable_id);
    } else {
      regressed.add(prior.stable_id);
      if (deltaHistory.some((delta) => delta.improved_residual_ids.includes(prior.stable_id))) {
        oscillating.add(prior.stable_id);
      }
    }
  }

  for (const residual of currentResiduals) {
    if (isMergeLineageResidual(residual)) {
      lineageMerge.add(residual.stable_id);
    }
    if (matchedCurrent.has(residual.stable_id)) continue;
    introduced.add(residual.stable_id);
    regressed.add(residual.stable_id);
    if (residual.low_confidence_marker) {
      lowConfidence.add(residual.stable_id);
    }
    if (deltaHistory.some((delta) => delta.resolved_residual_ids.includes(residual.stable_id))) {
      oscillating.add(residual.stable_id);
    }
  }

  return {
    previous_iteration: previous?.provenance.parent_iteration ?? null,
    current_iteration: current.provenance.parent_iteration,
    previous_verdict: previous?.verdict ?? null,
    current_verdict: current.verdict,
    improved_residual_ids: Array.from(improved).sort(),
    unchanged_residual_ids: Array.from(unchanged).sort(),
    regressed_residual_ids: Array.from(regressed).sort(),
    resolved_residual_ids: Array.from(resolved).sort(),
    introduced_residual_ids: Array.from(introduced).sort(),
    oscillating_residual_ids: Array.from(oscillating).sort(),
    lineage_split_residual_ids: Array.from(lineageSplit).sort(),
    lineage_merge_residual_ids: Array.from(lineageMerge).sort(),
    low_confidence_residual_ids: Array.from(lowConfidence).sort(),
    severity_rollup: {
      improved: improved.size,
      unchanged: unchanged.size,
      regressed: regressed.size,
      resolved: resolved.size,
      introduced: introduced.size,
    },
  };
}

export async function computeDelta(
  repoRoot: string,
  slug: string,
  iteration: number,
): Promise<MissionDelta> {
  const current = await readJsonFile<MissionLaneSummary>(laneSummaryPath(repoRoot, slug, iteration, 're_audit'));
  const previousLatestFile = latestPath(repoRoot, slug);
  let previousSummary: MissionLaneSummary | null = null;
  const history: MissionDelta[] = [];

  if (existsSync(previousLatestFile)) {
    const latest = await readJsonFile<MissionLatestSnapshot>(previousLatestFile);
    previousSummary = await readJsonFile<MissionLaneSummary>(latest.latest_summary_path);
    for (let idx = 1; idx < iteration; idx += 1) {
      const path = deltaPath(repoRoot, slug, idx);
      if (existsSync(path)) history.push(await readJsonFile<MissionDelta>(path));
    }
  }

  return compareResiduals(previousSummary, current, history);
}

async function readRequiredIterationSummaries(
  repoRoot: string,
  slug: string,
  iteration: number,
): Promise<Record<MissionLaneType, MissionLaneSummary>> {
  const summaries = {} as Record<MissionLaneType, MissionLaneSummary>;
  for (const laneType of MISSION_LANE_TYPES) {
    const summaryFile = laneSummaryPath(repoRoot, slug, iteration, laneType);
    if (!existsSync(summaryFile)) {
      throw new Error(`missing_iteration_lane_summary:${laneType}`);
    }
    summaries[laneType] = await readJsonFile<MissionLaneSummary>(summaryFile);
  }
  return summaries;
}

function isGreenSafetyBaseline(baseline: MissionSafetyBaseline): boolean {
  return baseline.iteration_commit_succeeded
    && baseline.no_unreconciled_lane_errors
    && baseline.focused_checks_green;
}

export function judgeMissionState(
  mission: MissionState,
  verifier: MissionLaneSummary,
  delta: MissionDelta,
  safetyBaseline: MissionSafetyBaseline,
  strategyChanged = false,
): MissionJudgement {
  const safety = isGreenSafetyBaseline(safetyBaseline) ? 'green' : 'red';
  const closure = closureMatrixDecision(verifier.verdict, verifier.confidence, safety);

  if (closure.outcome === 'complete') {
    return { nextStatus: 'complete', reason: closure.reason, closureDecision: closure.outcome };
  }
  if (closure.outcome === 'failed') {
    return { nextStatus: 'failed', reason: closure.reason, closureDecision: closure.outcome };
  }

  const onlyUnchanged =
    delta.severity_rollup.improved === 0
    && delta.severity_rollup.regressed === 0
    && delta.severity_rollup.resolved === 0
    && delta.severity_rollup.introduced === 0
    && delta.severity_rollup.unchanged > 0;
  if (
    onlyUnchanged
    && mission.unchanged_iterations + 1 >= mission.plateau_policy.max_unchanged_iterations
    && (!mission.plateau_policy.require_strategy_change_before_plateau || strategyChanged)
  ) {
    return {
      nextStatus: 'plateau',
      reason: 'unchanged residuals exceeded plateau policy',
      closureDecision: 'iterate',
    };
  }

  if (
    delta.oscillating_residual_ids.length >= mission.plateau_policy.oscillation_window
    && delta.oscillating_residual_ids.length > 0
  ) {
    return {
      nextStatus: 'plateau',
      reason: 'oscillating residuals exceeded plateau policy',
      closureDecision: 'iterate',
    };
  }

  if (
    verifier.verdict === 'AMBIGUOUS'
    && mission.ambiguous_iterations + 1 >= mission.plateau_policy.max_ambiguous_iterations
  ) {
    return {
      nextStatus: mission.closure_policy.ambiguous_outcome === 'failed' ? 'failed' : 'plateau',
      reason: 'ambiguous verifier retry budget exhausted',
      closureDecision: 'iterate',
    };
  }

  return {
    nextStatus: 'running',
    reason: closure.reason,
    closureDecision: closure.outcome,
  };
}

export async function commitIteration(
  repoRoot: string,
  slug: string,
  iteration: number,
  safetyBaseline: MissionSafetyBaseline,
  strategyChanged = false,
): Promise<CommitIterationResult> {
  const mission = await loadMission(repoRoot, slug);
  const laneSummaries = await readRequiredIterationSummaries(repoRoot, slug, iteration);
  const verifier = laneSummaries.re_audit;
  const delta = await computeDelta(repoRoot, slug, iteration);

  const judgement = judgeMissionState(mission, verifier, delta, safetyBaseline, strategyChanged);
  if (!canTransitionMissionStatus(mission.status, judgement.nextStatus)) {
    throw new Error(`invalid_mission_transition:${mission.status}->${judgement.nextStatus}`);
  }

  const residualFingerprint = computeResidualSetFingerprint(verifier.residuals);
  const nextMission: MissionState = {
    ...mission,
    status: judgement.nextStatus,
    updated_at: nowIso(),
    current_stage: judgement.nextStatus === 'running' ? 'judging' : 'idle',
    latest_verdict: verifier.verdict,
    latest_summary_path: laneSummaryPath(repoRoot, slug, iteration, 're_audit'),
    unchanged_iterations:
      delta.severity_rollup.unchanged > 0
      && delta.severity_rollup.improved === 0
      && delta.severity_rollup.regressed === 0
      && delta.severity_rollup.resolved === 0
      && delta.severity_rollup.introduced === 0
        ? mission.unchanged_iterations + 1
        : 0,
    ambiguous_iterations: verifier.verdict === 'AMBIGUOUS' ? mission.ambiguous_iterations + 1 : 0,
    oscillation_count: delta.oscillating_residual_ids.length > 0 ? mission.oscillation_count + 1 : 0,
    last_residual_fingerprint: residualFingerprint,
    final_reason: judgement.nextStatus === 'running' ? null : judgement.reason,
    active_lanes: [],
  };
  const latest: MissionLatestSnapshot = {
    mission_id: mission.mission_id,
    current_iteration: iteration,
    latest_lane: 're_audit',
    latest_verdict: verifier.verdict,
    latest_summary_path: laneSummaryPath(repoRoot, slug, iteration, 're_audit'),
    updated_at: nextMission.updated_at,
  };

  await writeJsonFile(missionPath(repoRoot, slug), nextMission);
  await writeJsonFile(latestPath(repoRoot, slug), latest);
  await writeJsonFile(deltaPath(repoRoot, slug, iteration), delta);
  return { mission: nextMission, delta, latest, judgement };
}

export async function cancelMission(repoRoot: string, slug: string, reason = 'cancel requested'): Promise<MissionState> {
  const mission = await loadMission(repoRoot, slug);
  const nextStatus: MissionStatus = mission.active_lanes.length > 0 ? 'cancelling' : 'cancelled';
  if (!canTransitionMissionStatus(mission.status, nextStatus)) {
    throw new Error(`invalid_mission_transition:${mission.status}->${nextStatus}`);
  }
  const nextMission: MissionState = {
    ...mission,
    status: nextStatus,
    updated_at: nowIso(),
    final_reason: reason,
  };
  await writeJsonFile(missionPath(repoRoot, slug), nextMission);
  return nextMission;
}

export async function finalizeMission(repoRoot: string, slug: string, status: Extract<MissionStatus, 'complete' | 'plateau' | 'failed' | 'cancelled'>, reason: string): Promise<MissionState> {
  const mission = await loadMission(repoRoot, slug);
  if (!canTransitionMissionStatus(mission.status, status)) {
    throw new Error(`invalid_mission_transition:${mission.status}->${status}`);
  }
  const nextMission: MissionState = {
    ...mission,
    status,
    updated_at: nowIso(),
    current_stage: 'idle',
    final_reason: reason,
    active_lanes: [],
  };
  await writeJsonFile(missionPath(repoRoot, slug), nextMission);
  return nextMission;
}
