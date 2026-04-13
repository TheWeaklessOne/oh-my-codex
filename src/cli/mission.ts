import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadMission } from '../mission/kernel.js';
import {
  missionOrchestrationArtifactPaths,
  type MissionRequirementSourceInput,
} from '../mission/orchestration.js';
import { prepareMissionRuntime, type PreparedMissionRuntime } from '../mission/runtime.js';
import { loadMissionWorkflow } from '../mission/workflow.js';

export const MISSION_HELP = `omx mission - Launch Codex with mission supervisor mode active

Usage:
  omx mission [mission goal text...]
  omx mission [--source REF] [--source-file PATH] [--constraint TEXT] [--unknown TEXT] [--touchpoint PATH] [--desired-outcome TEXT] [--high-risk] [mission goal text...]
  omx mission inspect <slug>
  omx mission --help

Behavior:
  - starts the Mission workflow as a first-class OMX surface
  - bootstraps Mission V2 source grounding, brief, contract, workflow, and plan artifacts before launch
  - activates the shipped mission skill / kernel workflow in-session
  - keeps mission artifacts under .omx/missions/<slug>/
  - uses team as the default coordinated executor
  - uses Ralph only as a bounded fallback for later stubborn follow-up slices

Examples:
  omx mission "Audit the auth flow until a fresh re-audit reports PASS"
  omx mission --source-file docs/spec.md --touchpoint src/mission/runtime.ts "Close Mission V2 gaps"
  omx mission inspect demo
  omx mission "Close onboarding reliability gaps without adding new CLI surface area"
`;

const MISSION_APPEND_ENV = 'OMX_MISSION_APPEND_INSTRUCTIONS_FILE';
const VALUE_TAKING_FLAGS = new Set(['--model', '--provider', '--config', '-c', '-i', '--images-dir']);

export interface MissionCliParseResult {
  task: string;
  launchArgs: string[];
  bootstrap: {
    desiredOutcome?: string;
    sourceRefs: string[];
    sourceFiles: string[];
    constraints: string[];
    unknowns: string[];
    touchpoints: string[];
    highRisk: boolean;
  };
}

function slugifyMissionTask(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'mission';
}

function hashValue(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) - hash) + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16);
}

function inferSourceKind(ref: string): MissionRequirementSourceInput['kind'] {
  if (/\.md$/i.test(ref)) return /spec|prd|requirement/i.test(ref) ? 'spec' : 'doc';
  if (/issue|ticket|bug|incident|github\.com\/.+\/issues\/\d+/i.test(ref)) return 'issue';
  if (/runbook/i.test(ref)) return 'runbook';
  return 'other';
}

function tryResolveRepoRoot(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim() || cwd;
  } catch {
    return cwd;
  }
}

async function collectMissionRequirementSources(
  cwd: string,
  bootstrap: MissionCliParseResult['bootstrap'],
): Promise<MissionRequirementSourceInput[]> {
  const sources: MissionRequirementSourceInput[] = [];
  const collectedAt = new Date().toISOString();
  const repoRoot = tryResolveRepoRoot(cwd);

  for (const ref of bootstrap.sourceRefs) {
    const content = `Mission source reference: ${ref}`;
    sources.push({
      kind: inferSourceKind(ref),
      title: `External source: ${ref}`,
      content,
      refs: [ref],
      origin: 'external',
      adapter: 'cli-ref',
      sourceUri: ref,
      fetchedAt: collectedAt,
      contentHash: `content:${hashValue(content)}`,
      retrievalStatus: 'captured',
      freshnessTtlSeconds: 3600,
      trustLevel: 'medium',
    });
  }

  for (const file of bootstrap.sourceFiles) {
    const filePath = join(cwd, file);
    if (!existsSync(filePath)) {
      const content = `Mission source file unavailable: ${file}`;
      sources.push({
        kind: inferSourceKind(file),
        title: `File source: ${file}`,
        content,
        refs: [file],
        origin: 'internal',
        adapter: 'cli-file',
        sourceUri: `file://${filePath}`,
        fetchedAt: collectedAt,
        contentHash: `content:${hashValue(content)}`,
        retrievalStatus: 'partial_failure',
        freshnessTtlSeconds: 300,
        trustLevel: 'low',
        partialFailureReason: `Source file not found at launch: ${file}`,
      });
      continue;
    }
    const content = await readFile(filePath, 'utf-8');
    sources.push({
      kind: inferSourceKind(file),
      title: `File source: ${file}`,
      content,
      refs: [file],
      origin: 'internal',
      adapter: 'cli-file',
      sourceUri: `file://${filePath}`,
      fetchedAt: collectedAt,
      contentHash: `content:${hashValue(content)}`,
      retrievalStatus: 'captured',
      freshnessTtlSeconds: 300,
      trustLevel: 'high',
    });
  }

  try {
    const branch = execFileSync('git', ['branch', '--show-current'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim();
    const status = execFileSync('git', ['status', '--short', '--branch'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim();
    sources.push({
      kind: 'repo_evidence',
      title: 'Repository context',
      content: `Branch: ${branch || '(detached)'}\n${status || 'clean working tree'}`,
      refs: [],
      origin: 'internal',
      adapter: 'repo-evidence',
      sourceUri: `repo://${repoRoot || cwd}`,
      fetchedAt: collectedAt,
      contentHash: `content:${hashValue(`Branch: ${branch || '(detached)'}\n${status || 'clean working tree'}`)}`,
      retrievalStatus: 'captured',
      freshnessTtlSeconds: 120,
      trustLevel: 'high',
    });
  } catch {
    // Ignore non-git directories; prompt/task sources still bootstrap the mission.
  }

  return sources;
}

export function parseMissionCliArgs(args: readonly string[]): MissionCliParseResult {
  const words: string[] = [];
  const launchArgs: string[] = [];
  const bootstrap: MissionCliParseResult['bootstrap'] = {
    sourceRefs: [],
    sourceFiles: [],
    constraints: [],
    unknowns: [],
    touchpoints: [],
    highRisk: false,
  };
  let i = 0;
  while (i < args.length) {
    const token = args[i];
    if (token === '--') {
      for (let j = i + 1; j < args.length; j += 1) words.push(args[j]!);
      break;
    }
    if (token === '--desired-outcome') {
      bootstrap.desiredOutcome = args[i + 1]?.trim() || '';
      i += 2;
      continue;
    }
    if (token === '--source') {
      if (args[i + 1]) bootstrap.sourceRefs.push(args[i + 1]!);
      i += 2;
      continue;
    }
    if (token === '--source-file') {
      if (args[i + 1]) bootstrap.sourceFiles.push(args[i + 1]!);
      i += 2;
      continue;
    }
    if (token === '--constraint') {
      if (args[i + 1]) bootstrap.constraints.push(args[i + 1]!);
      i += 2;
      continue;
    }
    if (token === '--unknown') {
      if (args[i + 1]) bootstrap.unknowns.push(args[i + 1]!);
      i += 2;
      continue;
    }
    if (token === '--touchpoint') {
      if (args[i + 1]) bootstrap.touchpoints.push(args[i + 1]!);
      i += 2;
      continue;
    }
    if (token === '--high-risk') {
      bootstrap.highRisk = true;
      i += 1;
      continue;
    }
    if (token.startsWith('--') && token.includes('=')) {
      launchArgs.push(token);
      i += 1;
      continue;
    }
    if (token.startsWith('-') && VALUE_TAKING_FLAGS.has(token)) {
      launchArgs.push(token);
      if (i + 1 < args.length) {
        launchArgs.push(args[i + 1]!);
      }
      i += 2;
      continue;
    }
    if (token.startsWith('-')) {
      launchArgs.push(token);
      i += 1;
      continue;
    }
    words.push(token);
    i += 1;
  }
  return {
    task: words.join(' ').trim() || 'mission-cli-launch',
    launchArgs,
    bootstrap,
  };
}

function buildMissionAppendInstructions(task: string, runtime: PreparedMissionRuntime | null): string {
  return [
    '<mission_cli_mode>',
    'You are in OMX Mission mode.',
    `Primary mission: ${task}`,
    'Use the shipped `mission` skill as the operator-facing mission entrypoint.',
    'Treat the mission kernel/runtime (`src/mission/kernel.ts`, `src/mission/runtime.ts`) as the authoritative state machine.',
    'Persist authoritative mission artifacts under `.omx/missions/<slug>/`.',
    runtime ? `Mission root: ${runtime.missionRoot}` : null,
    runtime ? `Mission brief: ${runtime.artifactPaths.missionBriefPath}` : null,
    runtime ? `Acceptance contract: ${runtime.artifactPaths.acceptanceContractPath}` : null,
    runtime ? `Execution plan: ${runtime.artifactPaths.executionPlanPath}` : null,
    runtime ? `Planning status: ${runtime.planning.status} via ${runtime.planning.handoffSurface}` : null,
    runtime?.planning.blockingReason ? `Blocking reason: ${runtime.planning.blockingReason}` : null,
    'Execution policy: team is the default coordinated executor; Ralph is a bounded fallback only when a later stubborn narrow follow-up remains.',
    'If the user did not provide a concrete mission goal yet, clarify it before doing mission work.',
    '</mission_cli_mode>',
  ].filter(Boolean).join('\n');
}

async function bootstrapMissionCliLaunch(cwd: string, parsed: MissionCliParseResult): Promise<PreparedMissionRuntime> {
  const repoRoot = tryResolveRepoRoot(cwd);
  const requirementSources = await collectMissionRequirementSources(cwd, parsed.bootstrap);
  const slug = slugifyMissionTask(parsed.task);
  const targetFingerprint = `mission-cli:${hashValue(JSON.stringify({
    task: parsed.task,
    desiredOutcome: parsed.bootstrap.desiredOutcome ?? '',
    sources: parsed.bootstrap.sourceRefs,
    sourceFiles: parsed.bootstrap.sourceFiles,
  }))}`;
  return prepareMissionRuntime({
    repoRoot,
    slug,
    targetFingerprint,
    task: parsed.task,
    desiredOutcome: parsed.bootstrap.desiredOutcome,
    requirementSources,
    constraints: parsed.bootstrap.constraints,
    unknowns: parsed.bootstrap.unknowns,
    projectTouchpoints: parsed.bootstrap.touchpoints,
    highRisk: parsed.bootstrap.highRisk,
    repoContext: { launch_surface: 'omx mission' },
  });
}

async function writeMissionAppendixFile(cwd: string, task: string, runtime: PreparedMissionRuntime | null): Promise<string> {
  const dir = join(cwd, '.omx', 'mission');
  await mkdir(dir, { recursive: true });
  const appendixPath = join(dir, 'session-instructions.md');
  await writeFile(appendixPath, `${buildMissionAppendInstructions(task, runtime)}\n`, 'utf-8');
  return appendixPath;
}

interface MissionCommandDependencies {
  launchWithHud?: (args: string[]) => Promise<void>;
  writeAppendixFile?: (cwd: string, task: string, runtime: PreparedMissionRuntime | null) => Promise<string>;
  bootstrapMission?: (cwd: string, parsed: MissionCliParseResult) => Promise<PreparedMissionRuntime>;
  print?: (message: string) => void;
}

interface MissionInspectView {
  slug: string;
  status: string;
  currentIteration: number;
  latestVerdict: string;
  currentStage: string | null;
  planId: string | null;
  planRunId: string | null;
  artifactRoles: Array<{ path: string; role: 'authoritative' | 'append_only' | 'canonical' | 'derived' }>;
}

function formatMissionInspectView(view: MissionInspectView): string {
  const lines = [
    `Mission: ${view.slug}`,
    `Status: ${view.status}`,
    `Current iteration: ${view.currentIteration}`,
    `Latest verdict: ${view.latestVerdict}`,
    `Current stage: ${view.currentStage ?? '(none)'}`,
    `Plan ID: ${view.planId ?? '(none)'}`,
    `Plan run: ${view.planRunId ?? '(none)'}`,
    '',
    'Artifacts:',
    ...view.artifactRoles.map((artifact) => `- [${artifact.role}] ${artifact.path}`),
  ];
  return lines.join('\n');
}

async function buildMissionInspectView(cwd: string, slug: string): Promise<MissionInspectView> {
  const repoRoot = tryResolveRepoRoot(cwd);
  const mission = await loadMission(repoRoot, slug);
  const artifactPaths = missionOrchestrationArtifactPaths(mission.mission_root);
  const workflow = await loadMissionWorkflow(mission.mission_root);
  return {
    slug: mission.slug,
    status: mission.status,
    currentIteration: mission.current_iteration,
    latestVerdict: mission.latest_verdict,
    currentStage: workflow?.current_stage ?? null,
    planId: workflow?.plan_id ?? null,
    planRunId: workflow?.plan_run_id ?? null,
    artifactRoles: [
      { path: join(mission.mission_root, 'mission.json'), role: 'authoritative' },
      { path: join(mission.mission_root, 'latest.json'), role: 'derived' },
      { path: join(mission.mission_root, 'events.ndjson'), role: 'append_only' },
      { path: artifactPaths.planningTransactionPath, role: 'canonical' },
      { path: join(mission.mission_root, 'workflow.json'), role: 'derived' },
      { path: artifactPaths.runMetricsPath, role: 'derived' },
      { path: artifactPaths.watchdogPath, role: 'derived' },
      { path: artifactPaths.closeoutStatePath, role: 'derived' },
    ],
  };
}

export async function missionCommand(
  args: string[],
  dependencies: MissionCommandDependencies = {},
): Promise<void> {
  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    console.log(MISSION_HELP);
    return;
  }
  if (args[0] === 'inspect') {
    const slug = args[1]?.trim();
    if (!slug) {
      throw new Error(`mission inspect requires <slug>.\n${MISSION_HELP}`);
    }
    const view = await buildMissionInspectView(process.cwd(), slug);
    (dependencies.print ?? console.log)(formatMissionInspectView(view));
    return;
  }

  const cwd = process.cwd();
  const parsed = parseMissionCliArgs(args);
  const task = parsed.task;
  const runtime = await (dependencies.bootstrapMission ?? bootstrapMissionCliLaunch)(cwd, parsed);

  const previousAppendix = process.env[MISSION_APPEND_ENV];
  const appendixPath = await (dependencies.writeAppendixFile ?? writeMissionAppendixFile)(cwd, task, runtime);
  process.env[MISSION_APPEND_ENV] = appendixPath;

  try {
    const launchWithHud = dependencies.launchWithHud
      ?? (await import('./index.js')).launchWithHud;
    const missionPrompt = task === 'mission-cli-launch' ? '$mission' : `$mission ${task}`;
    await launchWithHud([...parsed.launchArgs, missionPrompt]);
  } finally {
    if (typeof previousAppendix === 'string') process.env[MISSION_APPEND_ENV] = previousAppendix;
    else delete process.env[MISSION_APPEND_ENV];
  }
}
