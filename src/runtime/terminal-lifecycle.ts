import { normalizeRunOutcome, type RunOutcome } from './run-outcome.js';

export const TERMINAL_LIFECYCLE_OUTCOMES = [
  'finished',
  'blocked',
  'failed',
  'userinterlude',
  'askuserQuestion',
] as const;

export type TerminalLifecycleOutcome = (typeof TERMINAL_LIFECYCLE_OUTCOMES)[number];

export interface TerminalLifecycleNormalizationResult {
  outcome?: TerminalLifecycleOutcome;
  warning?: string;
  error?: string;
}

const TERMINAL_LIFECYCLE_OUTCOME_SET = new Set<string>(TERMINAL_LIFECYCLE_OUTCOMES);

const TERMINAL_LIFECYCLE_ALIASES: Readonly<Record<string, TerminalLifecycleOutcome>> = {
  finished: 'finished',
  finish: 'finished',
  complete: 'finished',
  completed: 'finished',
  done: 'finished',
  blocked: 'blocked',
  blocked_on_user: 'blocked',
  'blocked-on-user': 'blocked',
  failed: 'failed',
  fail: 'failed',
  error: 'failed',
  userinterlude: 'userinterlude',
  'user-interlude': 'userinterlude',
  interrupted: 'userinterlude',
  cancelled: 'userinterlude',
  canceled: 'userinterlude',
  cancel: 'userinterlude',
  aborted: 'userinterlude',
  abort: 'userinterlude',
  askuserquestion: 'askuserQuestion',
  'ask-user-question': 'askuserQuestion',
  ask_user_question: 'askuserQuestion',
  question: 'askuserQuestion',
  omxquestion: 'askuserQuestion',
  'omx-question': 'askuserQuestion',
} as const;

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeTerminalLifecycleOutcome(value: unknown): TerminalLifecycleNormalizationResult {
  const normalized = normalizeString(value);
  if (!normalized) return {};
  if (TERMINAL_LIFECYCLE_OUTCOME_SET.has(normalized)) {
    return { outcome: normalized as TerminalLifecycleOutcome };
  }
  const alias = TERMINAL_LIFECYCLE_ALIASES[normalized.toLowerCase()];
  if (alias) {
    return {
      outcome: alias,
      warning: `normalized legacy lifecycle outcome "${value}" -> "${alias}"`,
    };
  }
  return {
    error: `lifecycle_outcome must be one of: ${TERMINAL_LIFECYCLE_OUTCOMES.join(', ')}`,
  };
}

export function inferTerminalLifecycleOutcome(candidate: {
  lifecycle_outcome?: unknown;
  run_outcome?: unknown;
}): TerminalLifecycleNormalizationResult {
  const explicit = normalizeTerminalLifecycleOutcome(candidate.lifecycle_outcome);
  if (explicit.outcome || explicit.error) return explicit;

  const runOutcome = normalizeRunOutcome(candidate.run_outcome);
  if (runOutcome.error) return { error: runOutcome.error };
  switch (runOutcome.outcome) {
    case 'finish':
      return { outcome: 'finished' };
    case 'blocked_on_user':
      return { outcome: 'blocked' };
    case 'failed':
      return { outcome: 'failed' };
    case 'cancelled':
      return {
        outcome: 'userinterlude',
        warning: 'normalized legacy run outcome "cancelled" -> "userinterlude"',
      };
    default:
      return {};
  }
}

export function preferredRunOutcomeForLifecycleOutcome(
  outcome: TerminalLifecycleOutcome,
): RunOutcome {
  switch (outcome) {
    case 'finished':
      return 'finish';
    case 'blocked':
      return 'blocked_on_user';
    case 'failed':
      return 'failed';
    case 'userinterlude':
      return 'cancelled';
    case 'askuserQuestion':
      return 'blocked_on_user';
  }
}
