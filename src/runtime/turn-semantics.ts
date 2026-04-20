import type { NotificationEvent } from "../notifications/types.js";

const PERMISSION_SEEKING_PATTERNS = [
  "if you want",
  "would you like",
  "shall i",
  "should i",
  "do you want me to",
  "do you want",
  "want me to",
  "let me know if",
  "let me know",
  "just let me know",
  "i can also",
  "i could also",
  "next i can",
  "whenever you",
  "say go",
  "say yes",
  "type continue",
  "proceed from here",
];

const PLANNING_ONLY_PATTERNS = [
  "continue with the plan",
  "continue with the design",
  "continue with the spec",
  "continue with the proposal",
  "continue with the options",
  "plan from here",
  "planning from here",
  "ready to proceed",
  "next step",
  "next steps",
];

export type CompletedTurnSemanticKind =
  | "noise"
  | "progress"
  | "result-ready"
  | "input-needed"
  | "failed";

export interface CompletedTurnSemanticOutcome {
  kind: CompletedTurnSemanticKind;
  summary: string;
  question?: string;
  notificationEvent?: NotificationEvent;
}

const SUMMARY_MAX_LENGTH = 240;
const QUESTION_PREFIX_RE =
  /^(?:would|shall|should|do|can|could|please confirm|confirm|approve|which|what|how|who|when|where)\b/i;
const FAILURE_PATTERNS = [
  /\berror\b/i,
  /\bfailed\b/i,
  /\bexception\b/i,
  /\binvalid\b/i,
  /\btimeout\b/i,
  /\btimed out\b/i,
];
const STRONG_RESULT_PATTERNS = [
  /\ball tests pass(?:ed)?\b/i,
  /\btests? pass(?:ed)?\b/i,
  /\btests? (?:are|look) green\b/i,
  /\bbuild succeeded\b/i,
  /\blint passed\b/i,
  /\btypecheck passed\b/i,
  /\bverification (?:passed|complete|completed)\b/i,
  /\bfinal summary\b/i,
  /\bsummary ready\b/i,
  /\bready for review\b/i,
  /\bcommitted\b/i,
  /\bcreated commit\b/i,
  /\bchanges committed\b/i,
];
const ACTION_RESULT_PATTERNS = [
  /\bimplemented\b/i,
  /\bfixed\b/i,
  /\bupdated\b/i,
  /\brefactored\b/i,
  /\badded\b/i,
  /\bremoved\b/i,
  /\bcreated\b/i,
];
const VERIFICATION_PATTERNS = [
  /\btests?\b/i,
  /\bbuild\b/i,
  /\blint\b/i,
  /\btypecheck\b/i,
  /\bverified\b/i,
  /\bverification\b/i,
];
const CLOSURE_PATTERNS = [
  /\bcomplete(?:d)?\b/i,
  /\bdone\b/i,
  /\bsummary\b/i,
  /\bready\b/i,
];
const PROGRESS_PATTERNS = [
  /\bverify(?:ing|ication)?\b/i,
  /\breview(?:ed|ing)?\b/i,
  /\bdiagnostic\b/i,
  /\btypecheck\b/i,
  /\btest(?:ing)?\b/i,
  /\bimplement(?:ed|ing)?\b/i,
  /\bapply patch\b/i,
  /\bchange(?:d|s)?\b/i,
  /\bfix(?:ed|ing)?\b/i,
  /\bupdate(?:d|ing)?\b/i,
  /\brefactor(?:ed|ing)?\b/i,
  /\bresume(?:d)?\b/i,
  /\bprogress\b/i,
  /\bcontinue(?:d|ing)?\b/i,
  /\bnext step\b/i,
  /\bplanning\b/i,
];

export function coerceSemanticText(text: unknown): string {
  return typeof text === "string" ? text : text == null ? "" : String(text);
}

export function normalizeSemanticText(text: unknown): string {
  return coerceSemanticText(text)
    .replace(/\r\n?/g, "\n")
    .toLowerCase()
    .replace(/[’‘`]/g, "'");
}

function normalizePatternList(patterns: string[]): string[] {
  return patterns.map((pattern) => normalizeSemanticText(pattern).replace(/\s+/g, " ").trim()).filter(Boolean);
}

function matchesRecentTextPatterns(text: string, patterns: string[]): boolean {
  if (!text || patterns.length === 0) return false;
  const tail = text.slice(-800);
  const lines = tail.split("\n").filter((line) => line.trim());
  const hotZone = lines.slice(-3).join("\n");
  if (patterns.some((pattern) => hotZone.includes(pattern))) return true;
  return patterns.some((pattern) => tail.includes(pattern));
}

const NORMALIZED_PERMISSION_SEEKING_PATTERNS = normalizePatternList(PERMISSION_SEEKING_PATTERNS);
const NORMALIZED_PLANNING_ONLY_PATTERNS = normalizePatternList(PLANNING_ONLY_PATTERNS);

export function looksLikePermissionSeekingText(text: unknown): boolean {
  return matchesRecentTextPatterns(normalizeSemanticText(text), NORMALIZED_PERMISSION_SEEKING_PATTERNS);
}

export function looksLikePlanningOnlyText(text: unknown): boolean {
  return matchesRecentTextPatterns(normalizeSemanticText(text), NORMALIZED_PLANNING_ONLY_PATTERNS);
}

function normalizeDisplayLine(line: string, maxLength = SUMMARY_MAX_LENGTH): string {
  const normalized = line.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 1)}…`
    : normalized;
}

function listMeaningfulLines(text: unknown): string[] {
  return coerceSemanticText(text)
    .split("\n")
    .map((line) => normalizeDisplayLine(line))
    .filter(Boolean);
}

function extractQuestionLine(lines: string[]): string {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line) continue;
    if (line.includes("?")) return line;
    if (QUESTION_PREFIX_RE.test(line)) return line;
  }
  return "";
}

function findLastMatchingLine(lines: string[], patterns: RegExp[]): string {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (patterns.some((pattern) => pattern.test(line))) return line;
  }
  return "";
}

function countPatternMatches(text: string, patterns: RegExp[]): number {
  return patterns.some((pattern) => pattern.test(text)) ? 1 : 0;
}

export function summarizeCompletedTurnText(text: unknown, maxLength = SUMMARY_MAX_LENGTH): string {
  const lines = listMeaningfulLines(text);
  if (lines.length === 0) return "";
  const preferred =
    findLastMatchingLine(lines, STRONG_RESULT_PATTERNS)
    || findLastMatchingLine(lines, FAILURE_PATTERNS)
    || lines.at(-1)
    || "";
  return normalizeDisplayLine(preferred, maxLength);
}

export function buildCompletedTurnFingerprint(outcome: CompletedTurnSemanticOutcome): string {
  return JSON.stringify({
    kind: outcome.kind,
    summary: outcome.summary || "",
    question: outcome.question || "",
  });
}

export function classifyCompletedTurn(text: unknown): CompletedTurnSemanticOutcome {
  const lines = listMeaningfulLines(text);
  if (lines.length === 0) {
    return { kind: "noise", summary: "" };
  }

  const normalized = normalizeSemanticText(text);
  const summary = summarizeCompletedTurnText(text);
  const question = extractQuestionLine(lines);
  const permissionSeeking = looksLikePermissionSeekingText(normalized);
  const planningOnly = looksLikePlanningOnlyText(normalized);

  if (question) {
    return {
      kind: "input-needed",
      summary: question,
      question,
      notificationEvent: "ask-user-question",
    };
  }

  if (permissionSeeking && !planningOnly) {
    const prompt = lines.at(-1) || summary || "User input is required to continue.";
    return {
      kind: "input-needed",
      summary: prompt,
      question: prompt,
      notificationEvent: "ask-user-question",
    };
  }

  if (FAILURE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { kind: "failed", summary };
  }

  const resultScore =
    countPatternMatches(normalized, ACTION_RESULT_PATTERNS)
    + countPatternMatches(normalized, VERIFICATION_PATTERNS)
    + countPatternMatches(normalized, CLOSURE_PATTERNS);
  if (
    STRONG_RESULT_PATTERNS.some((pattern) => pattern.test(normalized))
    || resultScore >= 2
  ) {
    return {
      kind: "result-ready",
      summary: summary || lines.at(-1) || "",
      notificationEvent: "result-ready",
    };
  }

  if (PROGRESS_PATTERNS.some((pattern) => pattern.test(normalized)) || planningOnly) {
    return { kind: "progress", summary };
  }

  return { kind: "noise", summary };
}
