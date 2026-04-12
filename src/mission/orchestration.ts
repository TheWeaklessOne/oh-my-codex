import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type {
  MissionConfidence,
  MissionLaneSummary,
  MissionLaneType,
  MissionVerdict,
} from './contracts.js';
import type { MissionDelta, MissionLatestSnapshot, MissionState } from './kernel.js';
import { writeAtomic } from '../team/state/io.js';

export const MISSION_V2_ARTIFACT_VERSION = 1 as const;

export const MISSION_SOURCE_KINDS = [
  'prompt',
  'issue',
  'doc',
  'spec',
  'repo_evidence',
  'test_failure',
  'incident',
  'runbook',
  'other',
] as const;
export type MissionSourceKind = (typeof MISSION_SOURCE_KINDS)[number];

export const MISSION_PLANNING_MODES = ['direct', 'ralplan', 'blocked'] as const;
export type MissionPlanningMode = (typeof MISSION_PLANNING_MODES)[number];

export interface MissionRequirementSourceInput {
  kind?: string;
  title?: string;
  content: string;
  refs?: string[];
  metadata?: Record<string, string>;
  adapter?: string;
  origin?: 'prompt' | 'internal' | 'external';
}

export interface MissionSourcePackInput {
  task: string;
  desiredOutcome?: string;
  requirementSources?: MissionRequirementSourceInput[];
  constraints?: string[];
  unknowns?: string[];
  assumptions?: string[];
  projectTouchpoints?: string[];
  repoContext?: Record<string, string>;
  ambiguity?: 'low' | 'medium' | 'high';
}

export interface MissionNormalizedSource {
  source_id: string;
  kind: MissionSourceKind;
  adapter_key: string;
  title: string;
  summary: string;
  content: string;
  refs: string[];
  metadata: Record<string, string>;
  origin: 'prompt' | 'internal' | 'external';
}

export interface MissionSourcePack {
  schema_version: 1;
  generated_at: string;
  task_statement: string;
  desired_outcome: string;
  sources: MissionNormalizedSource[];
  constraints: string[];
  unknowns: string[];
  assumptions: string[];
  project_touchpoints: string[];
  repo_context: Record<string, string>;
  ambiguity: 'low' | 'medium' | 'high';
}

export interface MissionBrief {
  schema_version: 1;
  generated_at: string;
  brief_id: string;
  task_statement: string;
  problem_statement: string;
  target_outcome: string;
  non_goals: string[];
  constraints: string[];
  open_questions: string[];
  evidence_refs: string[];
  project_touchpoints: string[];
  source_ids: string[];
  ambiguity: 'low' | 'medium' | 'high';
}

export interface MissionAcceptanceContractInput {
  acceptanceCriteria?: string[];
  invariants?: string[];
  requiredTestEvidence?: string[];
  requiredOperationalEvidence?: string[];
  residualClassificationRules?: string[];
  verifierGuidance?: string[];
}

export interface MissionAcceptanceContract {
  schema_version: 1;
  generated_at: string;
  contract_id: string;
  contract_revision: number;
  brief_id: string;
  status_rules: Record<MissionVerdict, string[]>;
  acceptance_criteria: string[];
  invariants: string[];
  required_test_evidence: string[];
  required_operational_evidence: string[];
  residual_classification_rules: string[];
  verifier_guidance: string[];
}

export interface MissionExecutionPlanOptions {
  planningMode?: MissionPlanningMode;
  highRisk?: boolean;
}

export interface MissionExecutionPlan {
  schema_version: 1;
  generated_at: string;
  plan_id: string;
  plan_revision: number;
  previous_plan_id: string | null;
  strategy_key: string;
  planning_mode: MissionPlanningMode;
  handoff_surface: 'plan' | 'ralplan' | 'deep-interview';
  status: 'approved' | 'blocked';
  blocking_reason: string | null;
  approval_basis: string;
  approved_at: string | null;
  summary: string;
  execution_order: string[];
  lane_expectations: string[];
  verification_checkpoints: string[];
  strategy_change_triggers: string[];
  optional_hardening_rules: string[];
}

export interface MissionCloseout {
  schema_version: 1;
  generated_at: string;
  mission_id: string;
  status: MissionState['status'];
  final_verdict: MissionVerdict;
  final_confidence: MissionConfidence;
  closure_reason: string;
  residual_ids: string[];
  evidence_refs: string[];
  evidence_index: string[];
  artifact_refs: {
    source_pack: string;
    mission_brief: string;
    acceptance_contract: string;
    execution_plan: string;
  };
  delta_path: string | null;
  latest_summary_path: string | null;
  follow_ups: string[];
}

export interface MissionOrchestrationArtifacts {
  sourcePack: MissionSourcePack;
  brief: MissionBrief;
  acceptanceContract: MissionAcceptanceContract;
  executionPlan: MissionExecutionPlan;
}

export interface MissionOrchestrationArtifactUpdate {
  artifacts: MissionOrchestrationArtifacts;
  paths: MissionOrchestrationArtifactPaths;
  changed: {
    sourcePack: boolean;
    brief: boolean;
    acceptanceContract: boolean;
    executionPlan: boolean;
  };
}

export interface MissionOrchestrationArtifactPaths {
  sourcePackPath: string;
  missionBriefPath: string;
  missionBriefStatePath: string;
  acceptanceContractPath: string;
  executionPlanPath: string;
  executionPlanStatePath: string;
  closeoutPath: string;
  closeoutStatePath: string;
}

export interface PrepareMissionOrchestrationOptions extends Omit<MissionSourcePackInput, 'task'>, MissionAcceptanceContractInput, MissionExecutionPlanOptions {
  task?: string;
  nonGoals?: string[];
  forceRebuild?: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

function hashValue(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeList(values: readonly string[] | undefined): string[] {
  return Array.from(
    new Set(
      (values ?? [])
        .map((value) => normalizeWhitespace(String(value ?? '')))
        .filter(Boolean),
    ),
  );
}

function normalizeSourceKind(kind: string | undefined): MissionSourceKind {
  const normalized = normalizeWhitespace(String(kind ?? '').toLowerCase()).replace(/[\s-]+/g, '_');
  if (MISSION_SOURCE_KINDS.includes(normalized as MissionSourceKind)) return normalized as MissionSourceKind;
  return 'other';
}

function summarizeContent(content: string): string {
  const normalized = normalizeWhitespace(content);
  if (normalized.length <= 220) return normalized;
  return `${normalized.slice(0, 217)}…`;
}

function markdownList(items: readonly string[], empty = '- None recorded'): string {
  if (items.length === 0) return empty;
  return items.map((item) => `- ${item}`).join('\n');
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function writeJson(filePath: string, value: unknown): Promise<void> {
  return writeAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf-8')) as T;
}

function missionIterationDir(missionRoot: string, iteration: number): string {
  return join(missionRoot, 'iterations', String(iteration).padStart(3, '0'));
}

function missionDeltaPath(missionRoot: string, iteration: number): string {
  return join(missionIterationDir(missionRoot, iteration), 'delta.json');
}

export function missionOrchestrationArtifactPaths(missionRoot: string): MissionOrchestrationArtifactPaths {
  return {
    sourcePackPath: join(missionRoot, 'source-pack.json'),
    missionBriefPath: join(missionRoot, 'mission-brief.md'),
    missionBriefStatePath: join(missionRoot, 'mission-brief.json'),
    acceptanceContractPath: join(missionRoot, 'acceptance-contract.json'),
    executionPlanPath: join(missionRoot, 'execution-plan.md'),
    executionPlanStatePath: join(missionRoot, 'execution-plan.json'),
    closeoutPath: join(missionRoot, 'closeout.md'),
    closeoutStatePath: join(missionRoot, 'closeout.json'),
  };
}

export function missionLaneBriefingPath(laneDir: string): string {
  return join(laneDir, 'briefing.md');
}

export function buildMissionSourcePack(input: MissionSourcePackInput): MissionSourcePack {
  const task = normalizeWhitespace(input.task || 'mission');
  const desiredOutcome = normalizeWhitespace(input.desiredOutcome || task);
  const sourcesInput = input.requirementSources?.length
    ? input.requirementSources
    : [{ kind: 'prompt', title: 'Prompt task', content: task, origin: 'prompt' as const }];
  const sources = sourcesInput.map((source, index) => {
    const kind = normalizeSourceKind(source.kind);
    const content = normalizeWhitespace(source.content || task);
    return {
      source_id: `source-${String(index + 1).padStart(2, '0')}`,
      kind,
      adapter_key: normalizeWhitespace(source.adapter || kind),
      title: normalizeWhitespace(source.title || `${kind.replace(/_/g, ' ')} source ${index + 1}`),
      summary: summarizeContent(content),
      content,
      refs: normalizeList(source.refs),
      metadata: source.metadata ?? {},
      origin: source.origin ?? (kind === 'prompt' ? 'prompt' : 'external'),
    };
  });
  const unknowns = normalizeList(input.unknowns);
  const touchpoints = normalizeList(input.projectTouchpoints);
  const ambiguity = input.ambiguity
    ?? (unknowns.length > 0 ? 'high' : sources.length >= 3 || touchpoints.length >= 4 ? 'medium' : 'low');
  return {
    schema_version: MISSION_V2_ARTIFACT_VERSION,
    generated_at: nowIso(),
    task_statement: task,
    desired_outcome: desiredOutcome,
    sources,
    constraints: normalizeList(input.constraints),
    unknowns,
    assumptions: normalizeList(input.assumptions),
    project_touchpoints: touchpoints,
    repo_context: input.repoContext ?? {},
    ambiguity,
  };
}

export function compileMissionBrief(sourcePack: MissionSourcePack, nonGoals: readonly string[] = []): MissionBrief {
  const evidenceRefs = normalizeList(sourcePack.sources.flatMap((source) => source.refs));
  const primarySource = sourcePack.sources[0];
  const problemStatement = normalizeWhitespace(primarySource?.summary || sourcePack.task_statement);
  const seed = JSON.stringify({
    task: sourcePack.task_statement,
    desired_outcome: sourcePack.desired_outcome,
    evidenceRefs,
    touchpoints: sourcePack.project_touchpoints,
  });
  return {
    schema_version: MISSION_V2_ARTIFACT_VERSION,
    generated_at: nowIso(),
    brief_id: `brief:${hashValue(seed)}`,
    task_statement: sourcePack.task_statement,
    problem_statement: problemStatement,
    target_outcome: sourcePack.desired_outcome,
    non_goals: normalizeList(nonGoals),
    constraints: normalizeList(sourcePack.constraints),
    open_questions: normalizeList(sourcePack.unknowns),
    evidence_refs: evidenceRefs,
    project_touchpoints: normalizeList(sourcePack.project_touchpoints),
    source_ids: sourcePack.sources.map((source) => source.source_id),
    ambiguity: sourcePack.ambiguity,
  };
}

export function compileMissionAcceptanceContract(
  brief: MissionBrief,
  input: MissionAcceptanceContractInput = {},
  previous?: MissionAcceptanceContract | null,
): MissionAcceptanceContract {
  const acceptanceCriteria = normalizeList(input.acceptanceCriteria);
  const invariants = normalizeList(input.invariants);
  const requiredTestEvidence = normalizeList(input.requiredTestEvidence);
  const requiredOperationalEvidence = normalizeList(input.requiredOperationalEvidence);
  const residualClassificationRules = normalizeList(input.residualClassificationRules);
  const verifierGuidance = normalizeList(input.verifierGuidance);
  const contractSeed = JSON.stringify({
    brief_id: brief.brief_id,
    acceptanceCriteria,
    invariants,
    requiredTestEvidence,
    requiredOperationalEvidence,
    residualClassificationRules,
  });
  const next: MissionAcceptanceContract = {
    schema_version: MISSION_V2_ARTIFACT_VERSION,
    generated_at: nowIso(),
    contract_id: `contract:${hashValue(contractSeed)}`,
    contract_revision: 1,
    brief_id: brief.brief_id,
    status_rules: {
      PASS: [
        'All required acceptance criteria are satisfied.',
        'No must-not-break invariant regressed.',
        'Required evidence is present and points to the final implementation state.',
      ],
      PARTIAL: [
        'Material progress exists, but one or more acceptance criteria remain open.',
        'Residual work is concrete enough to continue with another iteration.',
      ],
      FAIL: [
        'The latest iteration regressed a must-not-break invariant or failed a required checkpoint.',
        'Residuals show the task is not in a releasable state.',
      ],
      AMBIGUOUS: [
        'The verifier could not determine closure from the available evidence.',
        'The mission needs clarification, stronger evidence, or a refreshed verifier pass.',
      ],
    },
    acceptance_criteria: acceptanceCriteria.length > 0
      ? acceptanceCriteria
      : [
          `Reach the target outcome: ${brief.target_outcome}`,
          'Keep the mission artifacts aligned with the latest implementation state.',
        ],
    invariants: invariants.length > 0
      ? invariants
      : [
          'Kernel lifecycle, delta, plateau, and closure remain authoritative.',
          'Mission stays project-agnostic and does not hardcode provider-specific sources.',
        ],
    required_test_evidence: requiredTestEvidence.length > 0
      ? requiredTestEvidence
      : ['Relevant tests or checks proving the touched surface still passes.'],
    required_operational_evidence: requiredOperationalEvidence.length > 0
      ? requiredOperationalEvidence
      : ['Fresh audit/re-audit evidence tied to mission artifacts and residuals.'],
    residual_classification_rules: residualClassificationRules.length > 0
      ? residualClassificationRules
      : [
          'Classify unresolved work as PARTIAL when it is concrete and actionable.',
          'Classify regressions or broken invariants as FAIL.',
          'Classify missing or conflicting evidence as AMBIGUOUS.',
        ],
    verifier_guidance: verifierGuidance.length > 0
      ? verifierGuidance
      : [
          'Judge against the acceptance criteria and invariants before suggesting additional work.',
          'Prefer residuals with stable identities and evidence references.',
        ],
  };
  if (!previous) return next;

  const previousComparable = {
    brief_id: previous.brief_id,
    status_rules: previous.status_rules,
    acceptance_criteria: previous.acceptance_criteria,
    invariants: previous.invariants,
    required_test_evidence: previous.required_test_evidence,
    required_operational_evidence: previous.required_operational_evidence,
    residual_classification_rules: previous.residual_classification_rules,
    verifier_guidance: previous.verifier_guidance,
  };
  const nextComparable = {
    brief_id: next.brief_id,
    status_rules: next.status_rules,
    acceptance_criteria: next.acceptance_criteria,
    invariants: next.invariants,
    required_test_evidence: next.required_test_evidence,
    required_operational_evidence: next.required_operational_evidence,
    residual_classification_rules: next.residual_classification_rules,
    verifier_guidance: next.verifier_guidance,
  };
  if (stableJson(previousComparable) === stableJson(nextComparable)) {
    return previous;
  }
  return {
    ...next,
    contract_revision: previous.contract_revision + 1,
  };
}

export function buildMissionExecutionPlan(
  sourcePack: MissionSourcePack,
  brief: MissionBrief,
  contract: MissionAcceptanceContract,
  options: MissionExecutionPlanOptions = {},
  previous?: MissionExecutionPlan | null,
): MissionExecutionPlan {
  const planningMode = options.planningMode
    ?? (brief.ambiguity === 'high'
      ? 'blocked'
      : options.highRisk === true || sourcePack.sources.length >= 3 || brief.project_touchpoints.length >= 4
        ? 'ralplan'
        : 'direct');
  const handoffSurface = planningMode === 'ralplan'
    ? 'ralplan'
    : planningMode === 'blocked'
      ? 'deep-interview'
      : 'plan';
  const isBlocked = planningMode === 'blocked';
  const planSeed = JSON.stringify({
    brief_id: brief.brief_id,
    contract_id: contract.contract_id,
    planningMode,
    touchpoints: brief.project_touchpoints,
  });
  const planId = `plan:${hashValue(planSeed)}`;
  const next: MissionExecutionPlan = {
    schema_version: MISSION_V2_ARTIFACT_VERSION,
    generated_at: nowIso(),
    plan_id: planId,
    plan_revision: 1,
    previous_plan_id: null,
    strategy_key: `strategy:${hashValue(`${planId}:${contract.contract_id}:${planningMode}`)}`,
    planning_mode: planningMode,
    handoff_surface: handoffSurface,
    status: isBlocked ? 'blocked' : 'approved',
    blocking_reason: isBlocked
      ? 'Mission source grounding still has unresolved questions; route through deep-interview before iteration 1.'
      : null,
    approval_basis: isBlocked
      ? 'source grounding requires clarification'
      : 'mission brief + acceptance contract compiled successfully',
    approved_at: isBlocked ? null : nowIso(),
    summary: isBlocked
      ? 'Mission execution is blocked until the source pack is clarified.'
      : `Use ${handoffSurface} semantics to ground execution before the first kernel-managed iteration.`,
    execution_order: [
      'Use the mission brief and acceptance contract as the pre-loop source of truth.',
      'Run the initial audit before broad execution.',
      'Shape remediation and execute the approved plan.',
      'Only request hardening when residuals justify a bounded stubborn follow-up.',
      'Run a fresh re-audit and let the kernel decide closure, plateau, failure, or continuation.',
    ],
    lane_expectations: [
      'audit/re_audit remain fresh read-only verifier lanes grounded in the acceptance contract',
      'execution follows the approved plan and emits evidence references for the verifier',
      'hardening stays optional and only applies to bounded stubborn residuals',
    ],
    verification_checkpoints: [
      ...contract.acceptance_criteria,
      ...contract.required_test_evidence,
      ...contract.required_operational_evidence,
    ],
    strategy_change_triggers: [
      'Residual set stays unchanged across iterations after a meaningful plan update.',
      'Audit or re-audit exposes a missing acceptance criterion or invariant.',
      'Optional hardening is no longer warranted by the residual shape.',
    ],
    optional_hardening_rules: [
      'Skip hardening when audit + execution + re-audit already satisfy the contract.',
      'Use hardening only for narrow stubborn residuals that benefit from a bounded Ralph follow-up.',
    ],
  };
  if (!previous) return next;

  const previousComparable = {
    planning_mode: previous.planning_mode,
    handoff_surface: previous.handoff_surface,
    status: previous.status,
    blocking_reason: previous.blocking_reason,
    approval_basis: previous.approval_basis,
    summary: previous.summary,
    execution_order: previous.execution_order,
    lane_expectations: previous.lane_expectations,
    verification_checkpoints: previous.verification_checkpoints,
    strategy_change_triggers: previous.strategy_change_triggers,
    optional_hardening_rules: previous.optional_hardening_rules,
  };
  const nextComparable = {
    planning_mode: next.planning_mode,
    handoff_surface: next.handoff_surface,
    status: next.status,
    blocking_reason: next.blocking_reason,
    approval_basis: next.approval_basis,
    summary: next.summary,
    execution_order: next.execution_order,
    lane_expectations: next.lane_expectations,
    verification_checkpoints: next.verification_checkpoints,
    strategy_change_triggers: next.strategy_change_triggers,
    optional_hardening_rules: next.optional_hardening_rules,
  };
  if (stableJson(previousComparable) === stableJson(nextComparable)) {
    return previous;
  }
  return {
    ...next,
    plan_revision: previous.plan_revision + 1,
    previous_plan_id: previous.plan_id,
  };
}

function formatMissionBriefMarkdown(brief: MissionBrief): string {
  return [
    '# Mission Brief',
    '',
    `- Brief ID: \`${brief.brief_id}\``,
    `- Generated: ${brief.generated_at}`,
    `- Ambiguity: ${brief.ambiguity}`,
    '',
    '## Problem statement',
    brief.problem_statement,
    '',
    '## Target outcome',
    brief.target_outcome,
    '',
    '## Non-goals',
    markdownList(brief.non_goals),
    '',
    '## Constraints',
    markdownList(brief.constraints),
    '',
    '## Open questions',
    markdownList(brief.open_questions),
    '',
    '## Evidence references',
    markdownList(brief.evidence_refs),
    '',
    '## Project touchpoints',
    markdownList(brief.project_touchpoints),
    '',
    '## Source IDs',
    markdownList(brief.source_ids),
    '',
  ].join('\n');
}

function formatMissionExecutionPlanMarkdown(plan: MissionExecutionPlan): string {
  return [
    '# Mission Execution Plan',
    '',
    `- Plan ID: \`${plan.plan_id}\``,
    `- Plan revision: ${plan.plan_revision}`,
    plan.previous_plan_id ? `- Previous plan ID: \`${plan.previous_plan_id}\`` : null,
    `- Strategy key: \`${plan.strategy_key}\``,
    `- Planning mode: \`${plan.planning_mode}\``,
    `- Handoff surface: \`${plan.handoff_surface}\``,
    `- Status: \`${plan.status}\``,
    plan.blocking_reason ? `- Blocking reason: ${plan.blocking_reason}` : null,
    `- Approval basis: ${plan.approval_basis}`,
    plan.approved_at ? `- Approved at: ${plan.approved_at}` : null,
    '',
    '## Summary',
    plan.summary,
    '',
    '## Execution order',
    markdownList(plan.execution_order),
    '',
    '## Lane expectations',
    markdownList(plan.lane_expectations),
    '',
    '## Verification checkpoints',
    markdownList(plan.verification_checkpoints),
    '',
    '## Strategy-change triggers',
    markdownList(plan.strategy_change_triggers),
    '',
    '## Optional hardening rules',
    markdownList(plan.optional_hardening_rules),
    '',
  ].filter(Boolean).join('\n');
}

function formatMissionCloseoutMarkdown(closeout: MissionCloseout): string {
  return [
    '# Mission Closeout',
    '',
    `- Mission ID: \`${closeout.mission_id}\``,
    `- Status: \`${closeout.status}\``,
    `- Final verdict: \`${closeout.final_verdict}\``,
    `- Final confidence: \`${closeout.final_confidence}\``,
    `- Generated: ${closeout.generated_at}`,
    '',
    '## Closure reason',
    closeout.closure_reason,
    '',
    '## Residual IDs',
    markdownList(closeout.residual_ids),
    '',
    '## Evidence refs',
    markdownList(closeout.evidence_refs),
    '',
    '## Evidence index',
    markdownList(closeout.evidence_index),
    '',
    '## Follow-ups',
    markdownList(closeout.follow_ups),
    '',
  ].join('\n');
}

async function writeMissionOrchestrationArtifacts(
  missionRoot: string,
  artifacts: MissionOrchestrationArtifacts,
): Promise<MissionOrchestrationArtifactPaths> {
  const paths = missionOrchestrationArtifactPaths(missionRoot);
  await mkdir(missionRoot, { recursive: true });
  await writeJson(paths.sourcePackPath, artifacts.sourcePack);
  await writeJson(paths.missionBriefStatePath, artifacts.brief);
  await writeAtomic(paths.missionBriefPath, `${formatMissionBriefMarkdown(artifacts.brief)}\n`);
  await writeJson(paths.acceptanceContractPath, artifacts.acceptanceContract);
  await writeJson(paths.executionPlanStatePath, artifacts.executionPlan);
  await writeAtomic(paths.executionPlanPath, `${formatMissionExecutionPlanMarkdown(artifacts.executionPlan)}\n`);
  return paths;
}

export async function loadMissionOrchestrationArtifacts(
  missionRoot: string,
): Promise<MissionOrchestrationArtifacts | null> {
  const paths = missionOrchestrationArtifactPaths(missionRoot);
  if (
    !existsSync(paths.sourcePackPath)
    || !existsSync(paths.missionBriefStatePath)
    || !existsSync(paths.acceptanceContractPath)
    || !existsSync(paths.executionPlanStatePath)
  ) {
    return null;
  }

  return {
    sourcePack: await readJson<MissionSourcePack>(paths.sourcePackPath),
    brief: await readJson<MissionBrief>(paths.missionBriefStatePath),
    acceptanceContract: await readJson<MissionAcceptanceContract>(paths.acceptanceContractPath),
    executionPlan: await readJson<MissionExecutionPlan>(paths.executionPlanStatePath),
  };
}

export async function prepareMissionOrchestrationArtifacts(
  mission: MissionState,
  options: PrepareMissionOrchestrationOptions,
): Promise<MissionOrchestrationArtifactUpdate> {
  const existing = await loadMissionOrchestrationArtifacts(mission.mission_root);
  if (existing && options.forceRebuild !== true) {
    return {
      artifacts: existing,
      paths: missionOrchestrationArtifactPaths(mission.mission_root),
      changed: {
        sourcePack: false,
        brief: false,
        acceptanceContract: false,
        executionPlan: false,
      },
    };
  }
  const sourcePack = buildMissionSourcePack({
    task: options.task || mission.slug,
    desiredOutcome: options.desiredOutcome,
    requirementSources: options.requirementSources,
    constraints: options.constraints,
    unknowns: options.unknowns,
    assumptions: options.assumptions,
    projectTouchpoints: options.projectTouchpoints,
    repoContext: options.repoContext,
    ambiguity: options.ambiguity,
  });
  const brief = compileMissionBrief(sourcePack, options.nonGoals);
  const acceptanceContract = compileMissionAcceptanceContract(
    brief,
    options,
    existing?.acceptanceContract ?? null,
  );
  const executionPlan = buildMissionExecutionPlan(
    sourcePack,
    brief,
    acceptanceContract,
    options,
    existing?.executionPlan ?? null,
  );
  const artifacts = {
    sourcePack,
    brief,
    acceptanceContract,
    executionPlan,
  };
  const paths = await writeMissionOrchestrationArtifacts(mission.mission_root, artifacts);
  return {
    artifacts,
    paths,
    changed: {
      sourcePack: stableJson(existing?.sourcePack ?? null) !== stableJson(sourcePack),
      brief: stableJson(existing?.brief ?? null) !== stableJson(brief),
      acceptanceContract: stableJson(existing?.acceptanceContract ?? null) !== stableJson(acceptanceContract),
      executionPlan: stableJson(existing?.executionPlan ?? null) !== stableJson(executionPlan),
    },
  };
}

export async function writeMissionLaneBriefings(
  laneDirs: Record<MissionLaneType, string>,
  artifacts: MissionOrchestrationArtifacts,
  artifactPaths: MissionOrchestrationArtifactPaths,
): Promise<Record<MissionLaneType, string>> {
  const result = {} as Record<MissionLaneType, string>;
  const verdictRules = (Object.entries(artifacts.acceptanceContract.status_rules) as Array<[MissionVerdict, string[]]>)
    .map(([verdict, rules]) => `### ${verdict}\n${markdownList(rules)}`)
    .join('\n\n');
  for (const [laneType, laneDir] of Object.entries(laneDirs) as Array<[MissionLaneType, string]>) {
    const briefingPath = missionLaneBriefingPath(laneDir);
    const briefRef = relative(laneDir, artifactPaths.missionBriefPath);
    const contractRef = relative(laneDir, artifactPaths.acceptanceContractPath);
    const planRef = relative(laneDir, artifactPaths.executionPlanPath);
    const laneSpecificSection = laneType === 'audit' || laneType === 're_audit'
      ? [
          '## Verifier rubric',
          verdictRules,
          '',
          '## Contract-derived checks',
          markdownList([
            ...artifacts.acceptanceContract.acceptance_criteria,
            ...artifacts.acceptanceContract.invariants,
            ...artifacts.acceptanceContract.required_test_evidence,
            ...artifacts.acceptanceContract.required_operational_evidence,
          ]),
        ].join('\n')
      : [
          '## Plan-guided execution',
          markdownList([
            ...artifacts.executionPlan.execution_order,
            ...artifacts.executionPlan.verification_checkpoints,
          ]),
          '',
          '## Strategy-change triggers',
          markdownList(artifacts.executionPlan.strategy_change_triggers),
          '',
          '## Optional hardening rules',
          markdownList(artifacts.executionPlan.optional_hardening_rules),
        ].join('\n');
    const content = [
      `# Mission ${laneType} briefing`,
      '',
      `- Mission brief: \`${briefRef}\``,
      `- Acceptance contract: \`${contractRef}\``,
      `- Execution plan: \`${planRef}\``,
      `- Contract ID: \`${artifacts.acceptanceContract.contract_id}\``,
      `- Plan ID: \`${artifacts.executionPlan.plan_id}\``,
      '',
      '## Mission summary',
      artifacts.brief.problem_statement,
      '',
      laneSpecificSection,
      '',
    ].join('\n');
    await mkdir(laneDir, { recursive: true });
    await writeAtomic(briefingPath, `${content}\n`);
    result[laneType] = briefingPath;
  }
  return result;
}

function missionLatestPath(missionRoot: string): string {
  return join(missionRoot, 'latest.json');
}

async function readLatestSummary(mission: MissionState): Promise<MissionLaneSummary | null> {
  if (!mission.latest_summary_path || !existsSync(mission.latest_summary_path)) return null;
  return readJson<MissionLaneSummary>(mission.latest_summary_path);
}

export async function buildMissionCloseout(mission: MissionState): Promise<MissionCloseout> {
  const artifactPaths = missionOrchestrationArtifactPaths(mission.mission_root);
  const latestSummary = await readLatestSummary(mission);
  const latestSnapshot = existsSync(missionLatestPath(mission.mission_root))
    ? await readJson<MissionLatestSnapshot>(missionLatestPath(mission.mission_root))
    : null;
  const delta = existsSync(missionDeltaPath(mission.mission_root, mission.current_iteration))
    ? await readJson<MissionDelta>(missionDeltaPath(mission.mission_root, mission.current_iteration))
    : null;
  const evidenceRefs = normalizeList(latestSummary?.evidence_refs ?? []);
  const residualIds = latestSummary?.residuals.map((residual) => residual.stable_id) ?? [];
  const followUps =
    mission.status === 'complete'
      ? ['Mission closed cleanly. Preserve the closeout package for future resume or audit context.']
      : normalizeList([
          mission.final_reason ?? '',
          latestSummary?.recommended_next_action ?? '',
          residualIds.length > 0 ? `Outstanding residuals remain: ${residualIds.join(', ')}` : '',
        ]);
  return {
    schema_version: MISSION_V2_ARTIFACT_VERSION,
    generated_at: nowIso(),
    mission_id: mission.mission_id,
    status: mission.status,
    final_verdict: latestSummary?.verdict ?? mission.latest_verdict,
    final_confidence: latestSummary?.confidence ?? 'low',
    closure_reason: mission.final_reason ?? 'mission closeout generated from current authoritative kernel state',
    residual_ids: residualIds,
    evidence_refs: evidenceRefs,
    evidence_index: normalizeList([
      ...evidenceRefs,
      latestSnapshot?.latest_summary_path ?? mission.latest_summary_path ?? '',
      delta ? missionDeltaPath(mission.mission_root, mission.current_iteration) : '',
    ]),
    artifact_refs: {
      source_pack: artifactPaths.sourcePackPath,
      mission_brief: artifactPaths.missionBriefPath,
      acceptance_contract: artifactPaths.acceptanceContractPath,
      execution_plan: artifactPaths.executionPlanPath,
    },
    delta_path: delta ? missionDeltaPath(mission.mission_root, mission.current_iteration) : null,
    latest_summary_path: latestSnapshot?.latest_summary_path ?? mission.latest_summary_path,
    follow_ups: followUps,
  };
}

export async function syncMissionCloseout(mission: MissionState): Promise<MissionCloseout | null> {
  if (!['complete', 'plateau', 'failed', 'cancelled'].includes(mission.status)) return null;
  const closeout = await buildMissionCloseout(mission);
  const paths = missionOrchestrationArtifactPaths(mission.mission_root);
  await writeJson(paths.closeoutStatePath, closeout);
  await writeAtomic(paths.closeoutPath, `${formatMissionCloseoutMarkdown(closeout)}\n`);
  return closeout;
}
