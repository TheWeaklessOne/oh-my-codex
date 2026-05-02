import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startMode, updateModeState } from '../modes/base.js';
import { readApprovedExecutionLaunchHint, type ApprovedExecutionLaunchHint } from '../planning/artifacts.js';
import { ensureCanonicalRalphArtifacts } from '../ralph/persistence.js';
import {
  buildFollowupStaffingPlan,
  resolveAvailableAgentTypes,
} from '../team/followup-planner.js';
import {
  deriveMissionHardeningGatePolicy,
  missionHardeningArtifactPaths,
} from '../mission/hardening.js';
import type { MissionHardeningGatePolicy } from '../mission/contracts.js';

export const RALPH_HELP = `omx ralph - Launch Codex with ralph persistence mode active

Usage:
  omx ralph [task text...]
  omx ralph --prd "<task text>"
  omx ralph [ralph-options] [codex-args...] [task text...]

Options:
  --help, -h           Show this help message
  --prd <task text>    PRD mode shortcut: mark the task text explicitly
  --prd=<task text>    Same as --prd "<task text>"
  --no-deslop         Skip the final ai-slop-cleaner pass unless a Mission hardening gate marks deslop as required

PRD mode:
  Ralph initializes persistence artifacts in .omx/ so PRD and progress
  state can survive across Codex sessions. Provide task text either as
  positional words or with --prd.
  Prompt-side \`$ralph\` activation is separate from this CLI entrypoint and
  does not imply \`--prd\` or the PRD.json startup gate.

Common patterns:
  omx ralph "Fix flaky notify-hook tests"
  omx ralph --prd "Ship release checklist automation"
  omx ralph --model gpt-5 "Refactor state hydration"
  omx ralph -- --task-with-leading-dash
`;

const VALUE_TAKING_FLAGS = new Set(['--model', '--provider', '--config', '-c', '-i', '--images-dir']);
const RALPH_OMX_FLAGS = new Set(['--prd', '--no-deslop']);
const RALPH_APPEND_ENV = 'OMX_RALPH_APPEND_INSTRUCTIONS_FILE';
const REQUIRED_RALPH_PRD_JSON_PATH = '.omx/prd.json';
const COMPLETED_RALPH_STORY_STATUSES = new Set(['passed', 'complete', 'completed']);
const APPROVED_RALPH_ARCHITECT_VERDICTS = new Set(['approve', 'approved']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isStoryMarkedPassedOrCompleted(story: Record<string, unknown>): boolean {
  if (story.passes === true) return true;
  if (typeof story.status !== 'string') return false;
  return COMPLETED_RALPH_STORY_STATUSES.has(story.status.trim().toLowerCase());
}

function hasApprovedArchitectValidation(story: Record<string, unknown>): boolean {
  const candidates = [story.architect_validation, story.architectValidation, story.architect_review, story.architectReview];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    if (candidate.approved === true) return true;
    if (typeof candidate.verdict === 'string' && APPROVED_RALPH_ARCHITECT_VERDICTS.has(candidate.verdict.trim().toLowerCase())) {
      return true;
    }
    if (typeof candidate.status === 'string' && APPROVED_RALPH_ARCHITECT_VERDICTS.has(candidate.status.trim().toLowerCase())) {
      return true;
    }
  }
  return false;
}

function describeStory(story: Record<string, unknown>, index: number): string {
  const id = typeof story.id === 'string' && story.id.trim() !== '' ? story.id.trim() : null;
  const title = typeof story.title === 'string' && story.title.trim() !== '' ? story.title.trim() : null;
  if (id && title) return `${id} (${title})`;
  if (id) return id;
  if (title) return title;
  return `story #${index + 1}`;
}

function readAndValidateRequiredRalphPrdJson(cwd: string): void {
  const requiredPath = join(cwd, REQUIRED_RALPH_PRD_JSON_PATH);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(requiredPath, 'utf-8'));
  } catch (error) {
    throw new Error(`[ralph] Invalid PRD.json at ${REQUIRED_RALPH_PRD_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!isRecord(parsed)) {
    throw new Error(`[ralph] Invalid PRD.json at ${REQUIRED_RALPH_PRD_JSON_PATH}: expected a JSON object.`);
  }

  if (parsed.userStories == null) return;
  if (!Array.isArray(parsed.userStories)) {
    throw new Error(`[ralph] Invalid PRD.json at ${REQUIRED_RALPH_PRD_JSON_PATH}: userStories must be an array when present.`);
  }

  for (const [index, story] of parsed.userStories.entries()) {
    if (!isRecord(story)) continue;
    if (!isStoryMarkedPassedOrCompleted(story)) continue;
    if (hasApprovedArchitectValidation(story)) continue;
    throw new Error(`[ralph] PRD.json ${describeStory(story, index)} is marked passed/completed without architect approval. Record architect_validation.verdict="approved" (or architect_review.verdict="approve") before running Ralph.`);
  }
}

export function isRalphPrdMode(args: readonly string[]): boolean {
  return args.some((arg) => arg === '--prd' || arg.startsWith('--prd='));
}

export function assertRequiredRalphPrdJson(cwd: string, args: readonly string[]): void {
  if (!isRalphPrdMode(args)) return;

  const requiredPath = join(cwd, REQUIRED_RALPH_PRD_JSON_PATH);
  if (!existsSync(requiredPath)) {
    throw new Error(`[ralph] Missing required PRD.json at ${REQUIRED_RALPH_PRD_JSON_PATH}. Create the file before running \`omx ralph --prd ...\`.`);
  }

  readAndValidateRequiredRalphPrdJson(cwd);
}

export function extractRalphTaskDescription(args: readonly string[], fallbackTask?: string): string {
  const words: string[] = [];
  let i = 0;
  while (i < args.length) {
    const token = args[i];
    if (token === '--') {
      for (let j = i + 1; j < args.length; j++) words.push(args[j]);
      break;
    }
    if (token.startsWith('--') && token.includes('=')) { i++; continue; }
    if (token.startsWith('-') && VALUE_TAKING_FLAGS.has(token)) { i += 2; continue; }
    if (token.startsWith('-')) { i++; continue; }
    words.push(token);
    i++;
  }
  return words.join(' ') || fallbackTask || 'ralph-cli-launch';
}

export function resolveApprovedRalphExecutionHint(
  candidate: ApprovedExecutionLaunchHint | null,
  explicitTask: string,
): ApprovedExecutionLaunchHint | null {
  if (!candidate) return null;
  if (explicitTask === 'ralph-cli-launch') {
    return candidate;
  }
  return candidate.task.trim() === explicitTask.trim() ? candidate : null;
}

export function readMatchedApprovedRalphExecutionHint(
  cwd: string,
  explicitTask: string,
): ApprovedExecutionLaunchHint | null {
  return resolveApprovedRalphExecutionHint(
    readApprovedExecutionLaunchHint(
      cwd,
      'ralph',
      explicitTask === 'ralph-cli-launch' ? {} : { task: explicitTask },
    ),
    explicitTask,
  );
}

function buildRalphApprovedContextLines(approvedHint: ApprovedExecutionLaunchHint | null): string[] {
  if (!approvedHint) return [];
  const lines = [
    'Approved planning handoff context:',
    `- approved plan: ${approvedHint.sourcePath}`,
  ];
  if (approvedHint.testSpecPaths.length > 0) {
    lines.push(`- test specs: ${approvedHint.testSpecPaths.join(', ')}`);
  }
  if (approvedHint.deepInterviewSpecPaths.length > 0) {
    lines.push(`- deep-interview specs: ${approvedHint.deepInterviewSpecPaths.join(', ')}`);
    lines.push('- Carry forward the approved deep-interview requirements and constraints during Ralph execution and final verification.');
  }
  if (approvedHint.repositoryContextSummary) {
    lines.push(`- approved repository context summary: ${approvedHint.repositoryContextSummary.sourcePath}${approvedHint.repositoryContextSummary.truncated ? ' (bounded/truncated)' : ''}`);
    lines.push('Approved repository context summary (bounded, inspectable):');
    lines.push(approvedHint.repositoryContextSummary.content);
  }
  return lines;
}

export function normalizeRalphCliArgs(args: readonly string[]): string[] {
  const normalized: string[] = [];
  let i = 0;
  while (i < args.length) {
    const token = args[i];
    if (token === '--prd') {
      const next = args[i + 1];
      if (next && next !== '--' && !next.startsWith('-')) {
        normalized.push(next);
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (token.startsWith('--prd=')) {
      const value = token.slice('--prd='.length);
      if (value.length > 0) normalized.push(value);
      i++;
      continue;
    }
    normalized.push(token);
    i++;
  }
  return normalized;
}

export function filterRalphCodexArgs(args: readonly string[]): string[] {
  const filtered: string[] = [];
  for (const token of args) {
    if (RALPH_OMX_FLAGS.has(token.toLowerCase())) continue;
    filtered.push(token);
  }
  return filtered;
}

interface RalphSessionFiles {
  instructionsPath: string;
  changedFilesPath: string;
}

interface RalphHardeningContext {
  gateMode: "off" | "optional" | "required";
  reviewEngine: string;
  maxReviewFixCycles: number;
  changedFilesPath: string;
  reportPaths: string[];
  requireDeslop?: boolean;
}

interface RalphMissionLike {
  mission_root: string;
  status: string;
  current_iteration: number;
  current_stage: string;
  updated_at?: string | null;
  active_candidate_id?: string | null;
  active_lanes?: Array<{ lane_type?: string | null }>;
  policy_profile?: {
    risk_class?: string | null;
    assurance_profile?: string | null;
    autonomy_profile?: string | null;
  } | null;
}

const TERMINAL_MISSION_STATUSES = new Set(['complete', 'failed', 'plateau', 'cancelled']);

export function buildRalphChangedFilesSeedContents(): string {
  return [
    '# Ralph changed files for the mandatory final ai-slop-cleaner pass',
    '# Add one repo-relative path per line as Ralph edits files during the session.',
    '# Step 7.5 must keep ai-slop-cleaner strictly scoped to the paths listed here.',
  ].join('\n');
}

export function buildRalphAppendInstructions(
  task: string,
  options: {
    changedFilesPath: string;
    noDeslop: boolean;
    approvedHint?: ApprovedExecutionLaunchHint | null;
    hardening?: RalphHardeningContext | null;
  },
): string {
  const noDeslopDisabledByHardening =
    options.noDeslop && options.hardening?.requireDeslop === true;
  return [
    '<ralph_native_subagents>',
    'You are in OMX Ralph persistence mode.',
    `Primary task: ${task}`,
    'Parallelism guidance:',
    '- Prefer Codex native subagents for independent parallel subtasks.',
    '- Treat `.omx/state/sessions/<sessionId>/actors.json` as the native actor activity registry for this session.',
    '- Do not declare the task complete, and do not transition into final verification/completion, while active native subagent threads are still running.',
    '- Before closing a verification wave, confirm that active native subagent threads have drained.',
    ...buildRalphApprovedContextLines(options.approvedHint ?? null),
    ...(options.hardening
      ? [
          "Mission hardening context:",
          `- hardening gate mode: ${options.hardening.gateMode}`,
          `- review engine: ${options.hardening.reviewEngine}`,
          `- max review/fix cycles: ${options.hardening.maxReviewFixCycles}`,
          `- changed-files scope seed: \`${options.hardening.changedFilesPath}\``,
          `- report artifacts: ${options.hardening.reportPaths.join(", ")}`,
          "- Treat this Ralph lane as the hardening coordinator: run the bounded review -> fix -> verify loop, then one ai-slop-cleaner pass, then post-deslop verification, then one final review sanity pass.",
          "- If the required review engine is unavailable and no explicit fallback policy exists, fail fast with a hardening error instead of silently skipping review.",
        ]
      : []),
    'Final deslop guidance:',
    noDeslopDisabledByHardening
      ? '- `--no-deslop` was requested, but this Mission hardening gate requires the deslop pass; ignore the opt-out and run the mandatory changed-files ai-slop-cleaner pass.'
      : options.noDeslop
      ? '- `--no-deslop` is active for this Ralph run, so skip the mandatory ai-slop-cleaner final pass and use the latest successful pre-deslop verification evidence.'
      : `- Step 7.5 must run oh-my-codex:ai-slop-cleaner in standard mode on changed files only, using the repo-relative paths listed in \`${options.changedFilesPath}\`.`,
    noDeslopDisabledByHardening
      ? '- Do not disable the hardening deslop pass; the Mission hardening gate requires it before final review completion.'
      : options.noDeslop
      ? '- Do not run ai-slop-cleaner unless the user explicitly re-enables the deslop pass.'
      : '- Keep the cleaner scope bounded to that file list; do not widen the pass to the full codebase or unrelated files.',
    noDeslopDisabledByHardening
      ? '- Step 7.6 must rerun tests/build/lint after the mandatory hardening deslop pass; if regression fails, fix or roll back and retry before the final review sanity pass.'
      : options.noDeslop
      ? '- Step 7.6 stays satisfied by the latest successful pre-deslop verification evidence because this run opted out of the deslop pass.'
      : '- Step 7.6 must rerun the current tests/build/lint verification after ai-slop-cleaner; if regression fails, roll back cleaner changes or fix and retry before completion.',
    '</ralph_native_subagents>',
  ].join('\n');
}

function taskSuggestsMissionHardening(
  task: string,
  approvedHint?: ApprovedExecutionLaunchHint | null,
): boolean {
  const haystack = [
    task,
    approvedHint?.task ?? "",
    approvedHint?.sourcePath ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes("hardening");
}

function missionHardeningLaneRoot(mission: RalphMissionLike): string {
  const iterationId = String(mission.current_iteration).padStart(3, "0");
  if (mission.active_candidate_id && mission.active_candidate_id.trim() !== "") {
    return join(
      mission.mission_root,
      "candidates",
      mission.active_candidate_id,
      "iterations",
      iterationId,
      "hardening",
    );
  }
  return join(mission.mission_root, "iterations", iterationId, "hardening");
}

async function resolveMissionHardeningContext(
  cwd: string,
  task: string,
  changedFilesPath: string,
  approvedHint?: ApprovedExecutionLaunchHint | null,
): Promise<RalphHardeningContext | null> {
  const missionsDir = join(cwd, ".omx", "missions");
  if (!existsSync(missionsDir)) return null;
  const hintedHardening = taskSuggestsMissionHardening(task, approvedHint);
  const entries = await readdir(missionsDir, { withFileTypes: true }).catch(() => []);
  const candidates: Array<{
    mission: RalphMissionLike;
    gate: MissionHardeningGatePolicy;
    score: number;
  }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const missionPath = join(missionsDir, entry.name, "mission.json");
    if (!existsSync(missionPath)) continue;
    try {
      const mission = JSON.parse(await readFile(missionPath, "utf-8")) as RalphMissionLike;
      if (TERMINAL_MISSION_STATUSES.has(String(mission.status ?? "").toLowerCase())) {
        continue;
      }
      const gate = deriveMissionHardeningGatePolicy({
        policyProfile: mission.policy_profile ?? null,
      });
      if (gate.mode === "off") continue;
      const activeHardening =
        mission.current_stage === "hardening" ||
        Array.isArray(mission.active_lanes) &&
          mission.active_lanes.some((lane) => lane?.lane_type === "hardening");
      if (!activeHardening && !hintedHardening) continue;
      let score = 0;
      if (activeHardening) score += 4;
      if (hintedHardening) score += 2;
      if (gate.mode === "required") score += 1;
      candidates.push({ mission, gate, score });
    } catch {
      continue;
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return String(right.mission.updated_at ?? "").localeCompare(
      String(left.mission.updated_at ?? ""),
    );
  });
  const selected = candidates[0]!;
  const laneRoot = missionHardeningLaneRoot(selected.mission);
  const artifactPaths = missionHardeningArtifactPaths(laneRoot);
  const reportPaths = [
    ...Array.from({ length: selected.gate.max_review_fix_cycles }, (_, index) =>
      artifactPaths.reviewCyclePath(index + 1),
    ),
    artifactPaths.deslopReportPath,
    artifactPaths.finalReviewPath,
    artifactPaths.gateResultPath,
    artifactPaths.summaryPath,
  ].map((path) => path.replace(`${cwd}/`, ""));
  return {
    gateMode: selected.gate.mode,
    reviewEngine: selected.gate.review_engine,
    maxReviewFixCycles: selected.gate.max_review_fix_cycles,
    changedFilesPath,
    reportPaths,
    requireDeslop: selected.gate.deslop_policy !== "disabled",
  };
}

async function writeRalphSessionFiles(
  cwd: string,
  task: string,
  options: {
    noDeslop: boolean;
    approvedHint?: ApprovedExecutionLaunchHint | null;
    hardening?: RalphHardeningContext | null;
  },
): Promise<RalphSessionFiles> {
  const dir = join(cwd, '.omx', 'ralph');
  await mkdir(dir, { recursive: true });
  const instructionsPath = join(dir, 'session-instructions.md');
  const changedFilesPath = join(dir, 'changed-files.txt');
  await writeFile(changedFilesPath, `${buildRalphChangedFilesSeedContents()}\n`);
  await writeFile(
    instructionsPath,
    `${buildRalphAppendInstructions(task, {
      changedFilesPath: '.omx/ralph/changed-files.txt',
      noDeslop: options.noDeslop,
      approvedHint: options.approvedHint ?? null,
      hardening: options.hardening ?? null,
    })}\n`,
  );
  return { instructionsPath, changedFilesPath: '.omx/ralph/changed-files.txt' };
}

interface RalphCommandDependencies {
  launchWithHud?: (args: string[]) => Promise<void>;
}

export async function ralphCommand(
  args: string[],
  dependencies: RalphCommandDependencies = {},
): Promise<void> {
  const normalizedArgs = normalizeRalphCliArgs(args);
  const cwd = process.cwd();
  if (normalizedArgs[0] === '--help' || normalizedArgs[0] === '-h') {
    console.log(RALPH_HELP);
    return;
  }
  assertRequiredRalphPrdJson(cwd, args);
  const artifacts = await ensureCanonicalRalphArtifacts(cwd);
  const explicitTask = extractRalphTaskDescription(normalizedArgs);
  const approvedHint = readMatchedApprovedRalphExecutionHint(cwd, explicitTask);
  const task = explicitTask === 'ralph-cli-launch' ? approvedHint?.task ?? explicitTask : explicitTask;
  const noDeslop = normalizedArgs.some((arg) => arg.toLowerCase() === '--no-deslop');
  const availableAgentTypes = await resolveAvailableAgentTypes(cwd);
  const staffingPlan = buildFollowupStaffingPlan('ralph', task, availableAgentTypes);
  await startMode('ralph', task, 50);
  const hardeningContext = await resolveMissionHardeningContext(
    cwd,
    task,
    '.omx/ralph/changed-files.txt',
    approvedHint,
  );
  const sessionFiles = await writeRalphSessionFiles(cwd, task, {
    noDeslop,
    approvedHint,
    hardening: hardeningContext,
  });
  await updateModeState('ralph', {
    current_phase: 'starting',
    canonical_progress_path: artifacts.canonicalProgressPath,
    available_agent_types: availableAgentTypes,
    staffing_summary: staffingPlan.staffingSummary,
    staffing_allocations: staffingPlan.allocations,
    native_subagents_enabled: true,
    native_subagent_tracking_path: '.omx/state/sessions/<sessionId>/actors.json',
    native_subagent_policy: 'Parallel Codex subagents are allowed for independent work, but phase completion must wait for active native subagent threads to finish.',
    deslop_enabled: !noDeslop,
    deslop_opt_out: noDeslop,
    deslop_changed_files_path: sessionFiles.changedFilesPath,
    deslop_scope: 'changed-files-only',
    approved_plan_path: approvedHint?.sourcePath,
    approved_test_spec_paths: approvedHint?.testSpecPaths ?? [],
    approved_deep_interview_spec_paths: approvedHint?.deepInterviewSpecPaths ?? [],
    hardening_gate_mode: hardeningContext?.gateMode ?? null,
    hardening_review_engine: hardeningContext?.reviewEngine ?? null,
    hardening_report_paths: hardeningContext?.reportPaths ?? [],
    hardening_deslop_required: hardeningContext?.requireDeslop === true,
    ...(artifacts.canonicalPrdPath ? { canonical_prd_path: artifacts.canonicalPrdPath } : {}),
  });
  if (artifacts.migratedPrd) {
    console.log('[ralph] Migrated legacy PRD -> ' + artifacts.canonicalPrdPath);
  }
  if (artifacts.migratedProgress) {
    console.log('[ralph] Migrated legacy progress -> ' + artifacts.canonicalProgressPath);
  }
  console.log('[ralph] Ralph persistence mode active. Launching Codex...');
  console.log(`[ralph] available_agent_types: ${staffingPlan.rosterSummary}`);
  console.log(`[ralph] staffing_plan: ${staffingPlan.staffingSummary}`);
  const launchWithHud =
    dependencies.launchWithHud ?? (await import('./index.js')).launchWithHud;
  const codexArgsBase = filterRalphCodexArgs(normalizedArgs);
  const codexArgs = explicitTask === 'ralph-cli-launch' && approvedHint?.task
    ? [...codexArgsBase, approvedHint.task]
    : codexArgsBase;
  const appendixPath = sessionFiles.instructionsPath;
  const previousAppendixEnv = process.env[RALPH_APPEND_ENV];
  process.env[RALPH_APPEND_ENV] = appendixPath;
  try {
    await launchWithHud(codexArgs);
  } finally {
    if (typeof previousAppendixEnv === 'string') process.env[RALPH_APPEND_ENV] = previousAppendixEnv;
    else delete process.env[RALPH_APPEND_ENV];
  }
}
