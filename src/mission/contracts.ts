import { createHash } from 'node:crypto';

export const MISSION_SCHEMA_VERSION = 1 as const;

export const MISSION_VERDICTS = ['PASS', 'PARTIAL', 'FAIL', 'AMBIGUOUS'] as const;
export type MissionVerdict = (typeof MISSION_VERDICTS)[number];

export const MISSION_CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;
export type MissionConfidence = (typeof MISSION_CONFIDENCE_LEVELS)[number];

export const MISSION_LANE_TYPES = ['audit', 'remediation', 'execution', 'hardening', 're_audit'] as const;
export type MissionLaneType = (typeof MISSION_LANE_TYPES)[number];
export const MISSION_REQUIRED_LANE_TYPES = ['audit', 'remediation', 'execution', 're_audit'] as const;

export const MISSION_STATUSES = ['running', 'cancelling', 'cancelled', 'complete', 'plateau', 'failed'] as const;
export type MissionStatus = (typeof MISSION_STATUSES)[number];

export const MISSION_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type MissionSeverity = (typeof MISSION_SEVERITIES)[number];

export type ResidualIdentitySource = 'stable_id' | 'canonical_key' | 'structural_key' | 'lineage' | 'matcher' | 'fallback_hash';
export type ResidualIdentityConfidence = 'high' | 'medium' | 'low';

export interface MissionResidualLineageInput {
  kind: 'split' | 'merge';
  related_residual_ids: string[];
}

export interface MissionResidualLineage {
  kind: 'split' | 'merge';
  related_residual_ids: string[];
  lineage_key: string;
}

export interface MissionResidualInput {
  stable_id?: string;
  canonical_key?: string;
  title?: string;
  summary: string;
  severity?: MissionSeverity | string;
  category?: string;
  closure_condition?: string;
  identity_version?: string;
  low_confidence_marker?: boolean;
  target_path?: string;
  symbol?: string;
  source_anchor?: string;
  evidence_refs?: string[];
  lineage?: MissionResidualLineageInput;
}

export interface MissionResidual {
  stable_id: string;
  canonical_key?: string;
  title: string;
  normalized_title: string;
  summary: string;
  severity: MissionSeverity;
  category: string;
  closure_condition: string;
  identity_version: string;
  low_confidence_marker: boolean;
  target_path?: string;
  symbol?: string;
  source_anchor?: string;
  evidence_refs: string[];
  structural_key?: string;
  matcher_key: string;
  fallback_key: string;
  token_signature: string[];
  identity_source: ResidualIdentitySource;
  identity_confidence: ResidualIdentityConfidence;
  lineage?: MissionResidualLineage;
}

export interface MissionLaneProvenance {
  lane_id: string;
  session_id: string;
  lane_type: MissionLaneType;
  candidate_id?: string;
  runner_type: 'team' | 'ralph' | 'direct';
  adapter_version: string;
  started_at: string;
  finished_at: string;
  parent_iteration: number;
  trigger_reason: string;
  read_only?: boolean;
  run_token?: string;
}

export interface MissionLaneSummaryInput {
  verdict?: MissionVerdict | string;
  confidence?: MissionConfidence | string;
  residuals?: MissionResidualInput[];
  evidence_refs?: string[];
  recommended_next_action?: string;
  provenance: MissionLaneProvenance;
}

export interface MissionLaneSummary {
  verdict: MissionVerdict;
  confidence: MissionConfidence;
  residuals: MissionResidual[];
  evidence_refs: string[];
  recommended_next_action: string;
  provenance: MissionLaneProvenance;
  normalization_errors?: string[];
}

export interface ResidualIdentityMatchResult {
  matched: boolean;
  confidence: ResidualIdentityConfidence;
  reason: 'stable_id' | 'canonical_key' | 'structural_key' | 'lineage' | 'matcher' | 'fallback_hash' | 'no_match';
}

export interface MissionClosurePolicy {
  require_fresh_verifier: boolean;
  allowed_completion_confidence: MissionConfidence[];
  require_safety_baseline: boolean;
  regression_outcome: 'iterate' | 'failed';
  ambiguous_outcome: 'iterate' | 'failed';
}

export interface MissionPlateauPolicy {
  max_unchanged_iterations: number;
  require_strategy_change_before_plateau: boolean;
  oscillation_window: number;
  max_ambiguous_iterations: number;
}

export interface MissionClosureMatrixRow {
  verdict: MissionVerdict;
  confidence: MissionConfidence;
  safety_baseline: 'green' | 'red';
  outcome: 'complete' | 'iterate' | 'failed';
  reason: string;
}

export interface MissionLifecycleTransition {
  from: MissionStatus | 'BOOTSTRAP';
  to: MissionStatus;
  owner: 'kernel';
  required_evidence: string[];
}

export interface MissionLanePolicy {
  runnerType: MissionLaneProvenance['runner_type'];
  freshSession: boolean;
  readOnly: boolean;
  rationale: string;
}

export type MissionHardeningGateMode = "off" | "optional" | "required";
export type MissionHardeningDeslopPolicy =
	| "disabled"
	| "changed-files-final-pass";
export type MissionHardeningFinalSanityReviewMode =
	| "disabled"
	| "required";

export interface MissionHardeningGatePolicy {
	mode: MissionHardeningGateMode;
	review_engine: string;
	fallback_review_engines: string[];
	max_review_fix_cycles: number;
	deslop_policy: MissionHardeningDeslopPolicy;
	final_sanity_review: MissionHardeningFinalSanityReviewMode;
}

export const MISSION_LANE_POLICIES: Record<MissionLaneType, MissionLanePolicy> = {
  audit: {
    runnerType: 'direct',
    freshSession: true,
    readOnly: true,
    rationale: 'Audit must run in a fresh read-only lane before remediation begins.',
  },
  remediation: {
    runnerType: 'direct',
    freshSession: false,
    readOnly: false,
    rationale: 'Remediation shaping stays direct and bounded unless later escalation needs coordinated execution.',
  },
  execution: {
    runnerType: 'team',
    freshSession: true,
    readOnly: false,
    rationale: 'Execution defaults to team as the coordinated executor.',
  },
  hardening: {
    runnerType: 'ralph',
    freshSession: true,
    readOnly: false,
    rationale: 'Hardening uses a bounded Ralph follow-up only when a narrow stubborn slice remains.',
  },
  re_audit: {
    runnerType: 'direct',
    freshSession: true,
    readOnly: true,
    rationale: 'Re-audit must run in a fresh read-only lane instead of reusing execution context.',
  },
};

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'be',
  'for',
  'has',
  'have',
  'in',
  'is',
  'of',
  'on',
  'or',
  'the',
  'this',
  'to',
  'with',
]);

const SEVERITY_RANK: Record<MissionSeverity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

export const DEFAULT_MISSION_CLOSURE_POLICY: MissionClosurePolicy = {
  require_fresh_verifier: true,
  allowed_completion_confidence: ['high', 'medium'],
  require_safety_baseline: true,
  regression_outcome: 'iterate',
  ambiguous_outcome: 'iterate',
};

export const DEFAULT_MISSION_PLATEAU_POLICY: MissionPlateauPolicy = {
  max_unchanged_iterations: 2,
  require_strategy_change_before_plateau: true,
  oscillation_window: 2,
  max_ambiguous_iterations: 2,
};

export const DEFAULT_MISSION_CLOSURE_MATRIX: MissionClosureMatrixRow[] = [
  { verdict: 'PASS', confidence: 'high', safety_baseline: 'green', outcome: 'complete', reason: 'fresh verifier closure with green baseline' },
  { verdict: 'PASS', confidence: 'medium', safety_baseline: 'green', outcome: 'complete', reason: 'fresh verifier closure with acceptable confidence and green baseline' },
  { verdict: 'PASS', confidence: 'low', safety_baseline: 'green', outcome: 'iterate', reason: 'low-confidence oracle output cannot close directly' },
  { verdict: 'PARTIAL', confidence: 'high', safety_baseline: 'green', outcome: 'iterate', reason: 'residual work remains' },
  { verdict: 'PARTIAL', confidence: 'medium', safety_baseline: 'green', outcome: 'iterate', reason: 'residual work remains' },
  { verdict: 'PARTIAL', confidence: 'low', safety_baseline: 'green', outcome: 'iterate', reason: 'low-confidence partial result requires another pass' },
  { verdict: 'FAIL', confidence: 'high', safety_baseline: 'green', outcome: 'iterate', reason: 'failure requires remediation' },
  { verdict: 'FAIL', confidence: 'medium', safety_baseline: 'green', outcome: 'iterate', reason: 'failure requires remediation' },
  { verdict: 'FAIL', confidence: 'low', safety_baseline: 'green', outcome: 'iterate', reason: 'low-confidence failure cannot terminate the mission' },
  { verdict: 'AMBIGUOUS', confidence: 'high', safety_baseline: 'green', outcome: 'iterate', reason: 'ambiguous verifier output cannot close' },
  { verdict: 'AMBIGUOUS', confidence: 'medium', safety_baseline: 'green', outcome: 'iterate', reason: 'ambiguous verifier output cannot close' },
  { verdict: 'AMBIGUOUS', confidence: 'low', safety_baseline: 'green', outcome: 'iterate', reason: 'ambiguous verifier output cannot close' },
  { verdict: 'PASS', confidence: 'high', safety_baseline: 'red', outcome: 'iterate', reason: 'green oracle without green local safety baseline cannot close' },
  { verdict: 'PASS', confidence: 'medium', safety_baseline: 'red', outcome: 'iterate', reason: 'green oracle without green local safety baseline cannot close' },
  { verdict: 'PASS', confidence: 'low', safety_baseline: 'red', outcome: 'iterate', reason: 'low-confidence oracle without green safety baseline cannot close' },
  { verdict: 'PARTIAL', confidence: 'high', safety_baseline: 'red', outcome: 'iterate', reason: 'partial oracle with red safety baseline must iterate' },
  { verdict: 'PARTIAL', confidence: 'medium', safety_baseline: 'red', outcome: 'iterate', reason: 'partial oracle with red safety baseline must iterate' },
  { verdict: 'PARTIAL', confidence: 'low', safety_baseline: 'red', outcome: 'iterate', reason: 'low-confidence partial oracle with red safety baseline must iterate' },
  { verdict: 'FAIL', confidence: 'high', safety_baseline: 'red', outcome: 'failed', reason: 'verifier failure plus red safety baseline is terminal for MVP' },
  { verdict: 'FAIL', confidence: 'medium', safety_baseline: 'red', outcome: 'failed', reason: 'verifier failure plus red safety baseline is terminal for MVP' },
  { verdict: 'FAIL', confidence: 'low', safety_baseline: 'red', outcome: 'iterate', reason: 'low-confidence failure with red safety baseline remains non-closing' },
  { verdict: 'AMBIGUOUS', confidence: 'high', safety_baseline: 'red', outcome: 'iterate', reason: 'ambiguous verifier output with red baseline remains non-closing' },
  { verdict: 'AMBIGUOUS', confidence: 'medium', safety_baseline: 'red', outcome: 'iterate', reason: 'ambiguous verifier output with red baseline remains non-closing' },
  { verdict: 'AMBIGUOUS', confidence: 'low', safety_baseline: 'red', outcome: 'iterate', reason: 'ambiguous verifier output with red baseline remains non-closing' },
];

export const MISSION_LIFECYCLE_TABLE: MissionLifecycleTransition[] = [
  { from: 'BOOTSTRAP', to: 'running', owner: 'kernel', required_evidence: ['mission.json initialized'] },
  { from: 'running', to: 'running', owner: 'kernel', required_evidence: ['iteration committed'] },
  { from: 'running', to: 'cancelling', owner: 'kernel', required_evidence: ['cancel requested while lanes active'] },
  { from: 'running', to: 'cancelled', owner: 'kernel', required_evidence: ['cancel requested with no active lanes'] },
  { from: 'cancelling', to: 'cancelled', owner: 'kernel', required_evidence: ['all active lanes reconciled'] },
  { from: 'running', to: 'complete', owner: 'kernel', required_evidence: ['fresh verifier PASS', 'green safety baseline'] },
  { from: 'running', to: 'plateau', owner: 'kernel', required_evidence: ['unchanged or oscillating residuals exceeded plateau policy'] },
  { from: 'running', to: 'failed', owner: 'kernel', required_evidence: ['closure matrix mapped verdict to failed'] },
];

function normalizeWhitespace(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_/\\.-]+/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeIdentity(value: string): string[] {
  return normalizeWhitespace(value)
    .split(' ')
    .filter(Boolean)
    .filter((token) => !STOP_WORDS.has(token))
    .sort();
}

function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function normalizeSeverity(raw: MissionResidualInput['severity']): MissionSeverity {
  if (typeof raw !== 'string') return 'medium';
  const normalized = raw.trim().toLowerCase();
  return MISSION_SEVERITIES.includes(normalized as MissionSeverity)
    ? normalized as MissionSeverity
    : 'medium';
}

function normalizeCategory(raw: MissionResidualInput['category']): string {
  const value = normalizeWhitespace(String(raw || ''));
  return value || 'general';
}

function normalizeClosureCondition(raw: MissionResidualInput['closure_condition']): string {
  const value = normalizeWhitespace(String(raw || ''));
  return value || 're audit pass';
}

function normalizeIdentityVersion(raw: MissionResidualInput['identity_version']): string {
  const value = String(raw || '').trim().toLowerCase();
  return value || 'v1';
}

function normalizeConfidence(raw: MissionLaneSummaryInput['confidence']): MissionConfidence {
  if (typeof raw !== 'string') return 'low';
  const normalized = raw.trim().toLowerCase();
  return MISSION_CONFIDENCE_LEVELS.includes(normalized as MissionConfidence)
    ? normalized as MissionConfidence
    : 'low';
}

function normalizeVerdict(raw: MissionLaneSummaryInput['verdict']): MissionVerdict {
  if (typeof raw !== 'string') return 'AMBIGUOUS';
  const normalized = raw.trim().toUpperCase();
  return MISSION_VERDICTS.includes(normalized as MissionVerdict)
    ? normalized as MissionVerdict
    : 'AMBIGUOUS';
}

function cleanEvidenceRefs(raw: string[] | undefined): string[] {
  return Array.from(new Set((raw ?? [])
    .map((value) => String(value || '').trim())
    .filter(Boolean)));
}

function normalizeLineage(raw: MissionResidualLineageInput | undefined): MissionResidualLineage | undefined {
  if (!raw) return undefined;
  const related = Array.from(new Set((raw.related_residual_ids ?? [])
    .map((value) => normalizeStableId(value))
    .filter((value): value is string => Boolean(value))))
    .sort();
  if (!related.length) return undefined;
  return {
    kind: raw.kind,
    related_residual_ids: related,
    lineage_key: `${raw.kind}:${related.join('|')}`,
  };
}

function normalizeStableId(raw: string | undefined): string | undefined {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return undefined;
  const normalized = value.replace(/[^a-z0-9:_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return normalized || undefined;
}

export function severityRank(severity: MissionSeverity): number {
  return SEVERITY_RANK[severity];
}

export function normalizeResidualIdentity(input: MissionResidualInput): MissionResidual {
  const summary = String(input.summary || '').trim();
  const title = String(input.title || summary || 'Unnamed residual').trim();
  const normalizedTitle = normalizeWhitespace(title || summary || 'unnamed residual');
  const severity = normalizeSeverity(input.severity);
  const category = normalizeCategory(input.category);
  const closureCondition = normalizeClosureCondition(input.closure_condition);
  const identityVersion = normalizeIdentityVersion(input.identity_version);
  const lowConfidenceMarker = input.low_confidence_marker === true;
  const canonicalKey = normalizeStableId(input.canonical_key);
  const explicitStableId = normalizeStableId(input.stable_id);
  const lineage = normalizeLineage(input.lineage);
  const tokenSignature = tokenizeIdentity([
    title || summary,
    input.target_path ?? '',
    input.symbol ?? '',
  ].join(' '));

  const matcherSeed = [
    severity,
    input.target_path?.trim().toLowerCase() ?? '',
    input.symbol?.trim().toLowerCase() ?? '',
    tokenSignature.join('.'),
  ].join('|');
  const structuralSeed = [
    identityVersion,
    category,
    closureCondition,
    input.target_path?.trim().toLowerCase() ?? '',
    input.symbol?.trim().toLowerCase() ?? '',
    tokenSignature.join('.'),
  ].join('|');
  const structuralKey = structuralSeed.replace(/\|+/g, '|');
  const matcherKey = matcherSeed.replace(/\|+/g, '|');
  const fallbackKey = `fallback:${hashValue([severity, normalizedTitle, normalizeWhitespace(summary)].join('|'))}`;
  const hasStructuralIdentity =
    Boolean(input.category)
    || Boolean(input.closure_condition)
    || Boolean(input.target_path)
    || Boolean(input.symbol)
    || tokenSignature.length > 0;
  const hasMatcherIdentity = tokenSignature.length > 0 || Boolean(input.target_path) || Boolean(input.symbol);

  let stableId: string;
  let identitySource: ResidualIdentitySource;
  let identityConfidence: ResidualIdentityConfidence;

  if (explicitStableId) {
    stableId = explicitStableId;
    identitySource = 'stable_id';
    identityConfidence = 'high';
  } else if (canonicalKey) {
    stableId = `residual:${canonicalKey}`;
    identitySource = 'canonical_key';
    identityConfidence = 'high';
  } else if (lineage) {
    stableId = `residual:${hashValue([lineage.lineage_key, matcherKey].join('|'))}`;
    identitySource = 'lineage';
    identityConfidence = lowConfidenceMarker ? 'low' : (lineage.related_residual_ids.length > 1 ? 'medium' : 'high');
  } else if (hasStructuralIdentity) {
    stableId = `residual:${hashValue(structuralKey)}`;
    identitySource = 'structural_key';
    identityConfidence = lowConfidenceMarker ? 'low' : (tokenSignature.length >= 3 ? 'high' : 'medium');
  } else if (hasMatcherIdentity) {
    stableId = `residual:${hashValue(matcherKey)}`;
    identitySource = 'matcher';
    identityConfidence = lowConfidenceMarker ? 'low' : (tokenSignature.length >= 3 ? 'high' : 'medium');
  } else {
    stableId = `residual:${hashValue(fallbackKey)}`;
    identitySource = 'fallback_hash';
    identityConfidence = 'low';
  }

  return {
    stable_id: stableId,
    ...(canonicalKey ? { canonical_key: canonicalKey } : {}),
    title,
    normalized_title: normalizedTitle,
    summary,
    severity,
    category,
    closure_condition: closureCondition,
    identity_version: identityVersion,
    low_confidence_marker: lowConfidenceMarker,
    ...(input.target_path ? { target_path: input.target_path } : {}),
    ...(input.symbol ? { symbol: input.symbol } : {}),
    ...(input.source_anchor ? { source_anchor: input.source_anchor } : {}),
    evidence_refs: cleanEvidenceRefs(input.evidence_refs),
    ...(identitySource === 'structural_key' ? { structural_key: structuralKey } : {}),
    matcher_key: matcherKey,
    fallback_key: fallbackKey,
    token_signature: tokenSignature,
    identity_source: identitySource,
    identity_confidence: identityConfidence,
    ...(lineage ? { lineage } : {}),
  };
}

export function normalizeLaneSummary(input: MissionLaneSummaryInput): MissionLaneSummary {
  const normalizationErrors: string[] = [];
  const verdict = normalizeVerdict(input.verdict);
  const confidence = normalizeConfidence(input.confidence);
  if (verdict === 'AMBIGUOUS' && typeof input.verdict === 'string' && input.verdict.trim().toUpperCase() !== 'AMBIGUOUS') {
    normalizationErrors.push('unsupported_verdict');
  }
  if (confidence === 'low' && typeof input.confidence === 'string' && input.confidence.trim().toLowerCase() !== 'low') {
    normalizationErrors.push('unsupported_confidence');
  }

  const residuals = Array.isArray(input.residuals)
    ? input.residuals.map(normalizeResidualIdentity)
    : [];
  return {
    verdict,
    confidence,
    residuals,
    evidence_refs: cleanEvidenceRefs(input.evidence_refs),
    recommended_next_action: String(input.recommended_next_action || '').trim(),
    provenance: {
      ...input.provenance,
      lane_id: String(input.provenance.lane_id || '').trim(),
      session_id: String(input.provenance.session_id || '').trim(),
      lane_type: input.provenance.lane_type,
      ...(input.provenance.candidate_id
        ? { candidate_id: String(input.provenance.candidate_id).trim() }
        : {}),
      runner_type: input.provenance.runner_type,
      adapter_version: String(input.provenance.adapter_version || '').trim(),
      started_at: String(input.provenance.started_at || '').trim(),
      finished_at: String(input.provenance.finished_at || '').trim(),
      parent_iteration: input.provenance.parent_iteration,
      trigger_reason: String(input.provenance.trigger_reason || '').trim(),
      ...(input.provenance.read_only === true ? { read_only: true } : {}),
      ...(input.provenance.run_token ? { run_token: String(input.provenance.run_token).trim() } : {}),
    },
    ...(normalizationErrors.length > 0 ? { normalization_errors: normalizationErrors } : {}),
  };
}

export function normalizeVerifierArtifact(
  input: Partial<MissionLaneSummaryInput>,
  provenance: MissionLaneProvenance,
): MissionLaneSummary {
  return normalizeLaneSummary({
    verdict: input.verdict,
    confidence: input.confidence,
    residuals: input.residuals,
    evidence_refs: input.evidence_refs,
    recommended_next_action: input.recommended_next_action,
    provenance,
  });
}

export function computeResidualSetFingerprint(residuals: MissionResidual[]): string {
  return hashValue(residuals
    .map((residual) => `${residual.stable_id}:${residual.severity}`)
    .sort()
    .join('|'));
}

export function isResidualStableMatch(previous: MissionResidual, next: MissionResidual): boolean {
  return matchResidualIdentity(previous, next).matched;
}

export function matchResidualIdentity(previous: MissionResidual, next: MissionResidual): ResidualIdentityMatchResult {
  if (previous.stable_id === next.stable_id) {
    return {
      matched: true,
      confidence: previous.low_confidence_marker || next.low_confidence_marker ? 'low' : 'high',
      reason: 'stable_id',
    };
  }
  if (previous.canonical_key && next.canonical_key && previous.canonical_key === next.canonical_key) {
    return { matched: true, confidence: 'high', reason: 'canonical_key' };
  }
  if (previous.structural_key && next.structural_key && previous.structural_key === next.structural_key) {
    return {
      matched: true,
      confidence:
        previous.low_confidence_marker || next.low_confidence_marker
          ? 'low'
          : previous.identity_confidence === 'high' && next.identity_confidence === 'high'
            ? 'high'
            : 'medium',
      reason: 'structural_key',
    };
  }
  const previousLineage = previous.lineage?.related_residual_ids ?? [];
  const nextLineage = next.lineage?.related_residual_ids ?? [];
  if (previous.lineage && next.lineage && previous.lineage.lineage_key === next.lineage.lineage_key) {
    return { matched: true, confidence: 'medium', reason: 'lineage' };
  }
  if (nextLineage.includes(previous.stable_id) || previousLineage.includes(next.stable_id)) {
    return { matched: true, confidence: 'low', reason: 'lineage' };
  }
  if (previousLineage.some((related) => nextLineage.includes(related))) {
    return { matched: true, confidence: 'low', reason: 'lineage' };
  }
  if (previous.matcher_key && next.matcher_key && previous.matcher_key === next.matcher_key) {
    return {
      matched: true,
      confidence:
        previous.low_confidence_marker || next.low_confidence_marker
          ? 'low'
          : previous.identity_confidence === 'high' && next.identity_confidence === 'high'
            ? 'high'
            : 'medium',
      reason: 'matcher',
    };
  }
  if (previous.fallback_key === next.fallback_key) {
    return { matched: true, confidence: 'low', reason: 'fallback_hash' };
  }
  return { matched: false, confidence: 'low', reason: 'no_match' };
}

export function closureMatrixDecision(
  verdict: MissionVerdict,
  confidence: MissionConfidence,
  safetyBaseline: 'green' | 'red',
  matrix: MissionClosureMatrixRow[] = DEFAULT_MISSION_CLOSURE_MATRIX,
): MissionClosureMatrixRow {
  const row = matrix.find((entry) =>
    entry.verdict === verdict
    && entry.confidence === confidence
    && entry.safety_baseline === safetyBaseline,
  );
  if (row) return row;
  return {
    verdict,
    confidence,
    safety_baseline: safetyBaseline,
    outcome: 'iterate',
    reason: 'no explicit closure matrix row matched; defaulting to iterate',
  };
}

export function canTransitionMissionStatus(from: MissionStatus | 'BOOTSTRAP', to: MissionStatus): boolean {
  return MISSION_LIFECYCLE_TABLE.some((transition) => transition.from === from && transition.to === to);
}
