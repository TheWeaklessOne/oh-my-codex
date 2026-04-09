import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { omxStateDir } from "../utils/paths.js";

const SECURE_FILE_MODE = 0o600;
const LOG_FILE_MODE = 0o600;
const MAX_LOG_SIZE_BYTES = 1 * 1024 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 5 * 60_000;
const MIN_POLL_INTERVAL_MS = 10_000;
const MAX_POLL_INTERVAL_MS = 60 * 60_000;
const DEFAULT_MAX_ISSUES_PER_RUN = 25;
const MIN_MAX_ISSUES_PER_RUN = 1;
const MAX_MAX_ISSUES_PER_RUN = 100;
const DAEMON_IDENTITY_MARKER = "runOmxDaemonLoop";
const DEFAULT_KNOWLEDGE_SINK = "docs/project-wiki";

export type GitHubCredentialSource = "config-token-ref" | "env" | "gh-auth";
export type QueueItemStatus = "queued" | "approved" | "rejected" | "published";
export type DaemonPriority = "high" | "medium" | "low";

export interface OmxDaemonConfig {
  repository?: string;
  pollIntervalMs?: number;
  maxIssuesPerRun?: number;
  knowledgeSink?: string;
  githubCredentialSource?: GitHubCredentialSource;
  githubTokenEnvVar?: string;
  applyGitHubLabelsOnApprove?: boolean;
}

export interface OmxDaemonQueueItem {
  id: string;
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  issueUpdatedAt: string;
  priority: DaemonPriority;
  recommendedLabels: string[];
  matchedRules: string[];
  status: QueueItemStatus;
  proposedAt: string;
  approvedAt?: string;
  publishedAt?: string;
  rejectedAt?: string;
  summary: string;
  draftPath: string;
  publicationPath: string;
  publicationReason: string;
  githubLabelMutationApplied?: boolean;
}

export interface OmxDaemonState {
  isRunning: boolean;
  pid: number | null;
  startedAt: string | null;
  lastPollAt: string | null;
  lastTriageAt: string | null;
  lastIssueScanAt: string | null;
  queueSize: number;
  proposalsCreated: number;
  publishedCount: number;
  rejectedCount: number;
  lastError?: string;
  credentialSource?: string | null;
  repository?: string | null;
  statusReason?: string;
  processedIssueKeys?: Record<string, string>;
}

export interface DaemonResponse {
  success: boolean;
  message: string;
  state?: OmxDaemonState;
  queue?: OmxDaemonQueueItem[];
  error?: string;
}

export interface ResolveGitHubTokenResult {
  token: string | null;
  source: "config-token-ref" | "GH_TOKEN" | "GITHUB_TOKEN" | "gh-auth" | "none";
  error?: string;
}

interface GitHubIssue {
  number: number;
  title: string;
  html_url: string;
  body?: string | null;
  updated_at: string;
  labels: Array<{ name?: string } | string>;
  comments?: number;
  pull_request?: unknown;
}

interface ParsedIssueGate {
  highPriorityKeywords: string[];
  mediumPriorityKeywords: string[];
  ignoreLabels: string[];
  escalateLabels: string[];
}

interface EvaluateIssueResult {
  priority: DaemonPriority;
  matchedRules: string[];
  recommendedLabels: string[];
  summary: string;
  skippedReason?: string;
}

interface DaemonPaths {
  projectRoot: string;
  governanceDir: string;
  issueGatePath: string;
  projectContextPath: string;
  rulesPath: string;
  configPath: string;
  runtimeDir: string;
  statePath: string;
  pidPath: string;
  logPath: string;
  queuePath: string;
  outboxDir: string;
  knowledgeSinkDir: string;
}

function daemonPaths(projectRoot = process.cwd()): DaemonPaths {
  const governanceDir = join(projectRoot, ".omx", "daemon");
  const runtimeDir = join(omxStateDir(projectRoot), "daemon");
  return {
    projectRoot,
    governanceDir,
    issueGatePath: join(governanceDir, "ISSUE_GATE.md"),
    projectContextPath: join(governanceDir, "PROJECT_CONTEXT.md"),
    rulesPath: join(governanceDir, "RULES.md"),
    configPath: join(governanceDir, "daemon.config.json"),
    runtimeDir,
    statePath: join(runtimeDir, "daemon-state.json"),
    pidPath: join(runtimeDir, "daemon.pid"),
    logPath: join(runtimeDir, "daemon.log"),
    queuePath: join(runtimeDir, "queue.json"),
    outboxDir: join(runtimeDir, "outbox"),
    knowledgeSinkDir: join(projectRoot, DEFAULT_KNOWLEDGE_SINK),
  };
}

function resolveKnowledgeSinkDir(projectRoot: string, config: OmxDaemonConfig | null): string {
  return join(projectRoot, normalizeConfig(config ?? {}).knowledgeSink);
}

function ensureDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  }
}

function ensureParentDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
}

function writeSecureText(filePath: string, content: string): void {
  ensureParentDir(filePath);
  writeFileSync(filePath, content, { mode: SECURE_FILE_MODE });
  try {
    chmodSync(filePath, SECURE_FILE_MODE);
  } catch {
    // ignore chmod failures
  }
}

function writeTrackedText(filePath: string, content: string): void {
  ensureParentDir(filePath);
  writeFileSync(filePath, content);
}

function rotateLogIfNeeded(logPath: string): void {
  try {
    if (!existsSync(logPath)) return;
    const stats = statSync(logPath);
    if (stats.size <= MAX_LOG_SIZE_BYTES) return;
    const backupPath = `${logPath}.old`;
    if (existsSync(backupPath)) unlinkSync(backupPath);
    renameSync(logPath, backupPath);
  } catch {
    // ignore rotation failures
  }
}

function logToFile(logPath: string, message: string): void {
  try {
    ensureParentDir(logPath);
    rotateLogIfNeeded(logPath);
    appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, { mode: LOG_FILE_MODE });
    try {
      chmodSync(logPath, LOG_FILE_MODE);
    } catch {
      // ignore chmod failures
    }
  } catch {
    // ignore logging failures
  }
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (!existsSync(filePath)) return fallback;
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath: string, value: unknown, secure = true): void {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (secure) {
    writeSecureText(filePath, content);
  } else {
    writeTrackedText(filePath, content);
  }
}

function normalizeInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === "number"
    ? Math.trunc(value)
    : (typeof value === "string" && value.trim() ? Number.parseInt(value, 10) : Number.NaN);
  if (!Number.isFinite(numeric)) return fallback;
  if (numeric < min) return min;
  if (numeric > max) return max;
  return numeric;
}

function defaultState(): OmxDaemonState {
  return {
    isRunning: false,
    pid: null,
    startedAt: null,
    lastPollAt: null,
    lastTriageAt: null,
    lastIssueScanAt: null,
    queueSize: 0,
    proposalsCreated: 0,
    publishedCount: 0,
    rejectedCount: 0,
    processedIssueKeys: {},
  };
}

function readDaemonState(projectRoot = process.cwd()): OmxDaemonState {
  const paths = daemonPaths(projectRoot);
  return {
    ...defaultState(),
    ...readJsonFile(paths.statePath, defaultState()),
  };
}

function writeDaemonState(projectRoot: string, state: OmxDaemonState): void {
  const paths = daemonPaths(projectRoot);
  ensureDir(paths.runtimeDir);
  writeJsonFile(paths.statePath, state);
}

function readQueue(projectRoot = process.cwd()): OmxDaemonQueueItem[] {
  const paths = daemonPaths(projectRoot);
  return readJsonFile(paths.queuePath, [] as OmxDaemonQueueItem[]);
}

function writeQueue(projectRoot: string, queue: OmxDaemonQueueItem[]): void {
  const paths = daemonPaths(projectRoot);
  ensureDir(paths.runtimeDir);
  writeJsonFile(paths.queuePath, queue);
}

function readPid(projectRoot = process.cwd()): number | null {
  const paths = daemonPaths(projectRoot);
  try {
    if (!existsSync(paths.pidPath)) return null;
    const parsed = Number.parseInt(readFileSync(paths.pidPath, "utf-8").trim(), 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writePid(projectRoot: string, pid: number): void {
  const paths = daemonPaths(projectRoot);
  writeSecureText(paths.pidPath, `${pid}`);
}

function removePid(projectRoot: string): void {
  const paths = daemonPaths(projectRoot);
  try {
    if (existsSync(paths.pidPath)) unlinkSync(paths.pidPath);
  } catch {
    // ignore cleanup failures
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isDaemonProcess(pid: number): boolean {
  try {
    if (process.platform === "linux") {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf-8");
      return cmdline.includes(DAEMON_IDENTITY_MARKER);
    }
    if (process.platform === "win32") return false;
    const result = spawnSync("ps", ["-p", String(pid), "-o", "args="], {
      encoding: "utf-8",
      timeout: 3000,
    });
    if (result.status !== 0 || result.error) return false;
    return (result.stdout ?? "").includes(DAEMON_IDENTITY_MARKER);
  } catch {
    return false;
  }
}

export function isOmxDaemonRunning(projectRoot = process.cwd()): boolean {
  const pid = readPid(projectRoot);
  if (pid === null) return false;
  if (!isProcessRunning(pid)) {
    removePid(projectRoot);
    return false;
  }
  if (!isDaemonProcess(pid)) {
    removePid(projectRoot);
    return false;
  }
  return true;
}

function normalizeConfig(config: OmxDaemonConfig): Required<Pick<OmxDaemonConfig, "pollIntervalMs" | "maxIssuesPerRun" | "knowledgeSink" | "githubCredentialSource">> & OmxDaemonConfig {
  return {
    ...config,
    pollIntervalMs: normalizeInteger(config.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, MIN_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS),
    maxIssuesPerRun: normalizeInteger(config.maxIssuesPerRun, DEFAULT_MAX_ISSUES_PER_RUN, MIN_MAX_ISSUES_PER_RUN, MAX_MAX_ISSUES_PER_RUN),
    knowledgeSink: config.knowledgeSink?.trim() || DEFAULT_KNOWLEDGE_SINK,
    githubCredentialSource: config.githubCredentialSource ?? "env",
  };
}

export function readOmxDaemonConfig(projectRoot = process.cwd()): OmxDaemonConfig | null {
  const paths = daemonPaths(projectRoot);
  if (!existsSync(paths.configPath)) return null;
  return normalizeConfig(readJsonFile(paths.configPath, {} as OmxDaemonConfig));
}

export async function scaffoldOmxDaemonFiles(projectRoot = process.cwd()): Promise<string[]> {
  const paths = daemonPaths(projectRoot);
  ensureDir(paths.governanceDir);
  const changed: string[] = [];
  const templates: Array<[string, string]> = [
    [paths.issueGatePath, `# ISSUE_GATE\n\n## High Priority Keywords\n- security\n- outage\n- regression\n- urgent\n\n## Medium Priority Keywords\n- bug\n- flaky\n- docs\n- onboarding\n\n## Ignore Labels\n- duplicate\n- wontfix\n- invalid\n\n## Escalate Labels\n- bug\n- security\n- incident\n`],
    [paths.projectContextPath, `# PROJECT_CONTEXT\n\nDescribe the project goals, release posture, active milestones, and triage context the daemon should use when summarizing issues. This file is tracked governance input and is not auto-written by the daemon in v1.\n`],
    [paths.rulesPath, `# RULES\n\n- Do not mutate GitHub issues or publish docs without approval.\n- Treat .omx/daemon/*.md as tracked governance input.\n- Publish approved knowledge updates into docs/project-wiki/.\n`],
    [paths.configPath, `${JSON.stringify({
      githubCredentialSource: "env",
      githubTokenEnvVar: "GH_TOKEN",
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      maxIssuesPerRun: DEFAULT_MAX_ISSUES_PER_RUN,
      knowledgeSink: DEFAULT_KNOWLEDGE_SINK,
    }, null, 2)}\n`],
  ];

  for (const [filePath, content] of templates) {
    if (!existsSync(filePath)) {
      if (filePath.endsWith(".json")) {
        writeTrackedText(filePath, content);
      } else {
        writeTrackedText(filePath, content);
      }
      changed.push(relative(projectRoot, filePath));
    }
  }
  return changed;
}

function hasRequiredGovernanceFiles(projectRoot = process.cwd()): boolean {
  const paths = daemonPaths(projectRoot);
  return [paths.issueGatePath, paths.projectContextPath, paths.rulesPath, paths.configPath].every((filePath) => existsSync(filePath));
}

function parseMarkdownBulletSection(content: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current = "";
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("#")) {
      current = line.replace(/^#+\s*/, "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    if (line.startsWith("- ") && current) {
      const values = sections.get(current) ?? [];
      values.push(line.slice(2).trim().toLowerCase());
      sections.set(current, values);
    }
  }
  return sections;
}

function readIssueGate(projectRoot = process.cwd()): ParsedIssueGate {
  const paths = daemonPaths(projectRoot);
  const sections = parseMarkdownBulletSection(readFileSync(paths.issueGatePath, "utf-8"));
  return {
    highPriorityKeywords: sections.get("high-priority-keywords") ?? [],
    mediumPriorityKeywords: sections.get("medium-priority-keywords") ?? [],
    ignoreLabels: sections.get("ignore-labels") ?? [],
    escalateLabels: sections.get("escalate-labels") ?? [],
  };
}

function readContextSnippet(projectRoot = process.cwd()): { projectContext: string; rules: string } {
  const paths = daemonPaths(projectRoot);
  const projectContext = existsSync(paths.projectContextPath)
    ? readFileSync(paths.projectContextPath, "utf-8").trim().slice(0, 700)
    : "";
  const rules = existsSync(paths.rulesPath)
    ? readFileSync(paths.rulesPath, "utf-8").trim().slice(0, 500)
    : "";
  return { projectContext, rules };
}

function normalizeIssueLabels(issue: GitHubIssue): string[] {
  return issue.labels
    .map((label) => typeof label === "string" ? label : label?.name)
    .filter((value): value is string => typeof value === "string" && value.trim() !== "")
    .map((value) => value.toLowerCase());
}

function evaluateIssue(issue: GitHubIssue, gate: ParsedIssueGate, context: { projectContext: string; rules: string }): EvaluateIssueResult {
  const labels = normalizeIssueLabels(issue);
  const searchable = `${issue.title}\n${issue.body ?? ""}`.toLowerCase();
  const ignoredLabel = labels.find((label) => gate.ignoreLabels.includes(label));
  if (ignoredLabel) {
    return {
      priority: "low",
      matchedRules: [`ignored-label:${ignoredLabel}`],
      recommendedLabels: [],
      summary: `Skipped because label \"${ignoredLabel}\" is listed in Ignore Labels.`,
      skippedReason: "ignored-label",
    };
  }

  let score = 0;
  const matchedRules: string[] = [];
  for (const keyword of gate.highPriorityKeywords) {
    if (keyword && searchable.includes(keyword)) {
      score += 2;
      matchedRules.push(`high-keyword:${keyword}`);
    }
  }
  for (const keyword of gate.mediumPriorityKeywords) {
    if (keyword && searchable.includes(keyword)) {
      score += 1;
      matchedRules.push(`medium-keyword:${keyword}`);
    }
  }
  for (const label of gate.escalateLabels) {
    if (labels.includes(label)) {
      score += 2;
      matchedRules.push(`escalate-label:${label}`);
    }
  }
  if (labels.length === 0) {
    score += 1;
    matchedRules.push("unlabeled");
  }
  if ((issue.comments ?? 0) >= 5) {
    score += 1;
    matchedRules.push("high-comment-volume");
  }

  const priority: DaemonPriority = score >= 3 ? "high" : score >= 1 ? "medium" : "low";
  const recommendedLabels = ["needs-triage", priority === "high" ? "high-priority" : priority === "medium" ? "triage/soon" : "triage/backlog"];
  const contextLine = context.projectContext ? `\n\nProject context excerpt:\n${context.projectContext}` : "";
  const rulesLine = context.rules ? `\n\nRule excerpt:\n${context.rules}` : "";
  const summary = [
    `Priority: ${priority.toUpperCase()}`,
    matchedRules.length > 0 ? `Matched rules: ${matchedRules.join(", ")}` : "Matched rules: default-triage",
    `Recommended labels: ${recommendedLabels.join(", ")}`,
    contextLine,
    rulesLine,
  ].join("\n");

  return {
    priority,
    matchedRules: matchedRules.length > 0 ? matchedRules : ["default-triage"],
    recommendedLabels,
    summary,
  };
}

function queueSummary(queue: OmxDaemonQueueItem[]): string {
  const queued = queue.filter((item) => item.status === "queued").length;
  const published = queue.filter((item) => item.status === "published").length;
  return `queued=${queued}, published=${published}, total=${queue.length}`;
}

function createQueueItem(
  projectRoot: string,
  config: OmxDaemonConfig | null,
  issue: GitHubIssue,
  evaluation: EvaluateIssueResult,
): OmxDaemonQueueItem {
  const paths = daemonPaths(projectRoot);
  ensureDir(paths.outboxDir);
  const timestamp = new Date().toISOString();
  const issueKey = `${issue.number}-${issue.updated_at.replace(/[^0-9]/g, "")}`;
  const draftPath = join(paths.outboxDir, `issue-${issueKey}.md`);
  const publicationPath = join(resolveKnowledgeSinkDir(projectRoot, config), `issue-${issue.number}.md`);
  const draft = `# Issue ${issue.number}: ${issue.title}\n\n- URL: ${issue.html_url}\n- Updated: ${issue.updated_at}\n- Recommended labels: ${evaluation.recommendedLabels.join(", ")}\n- Priority: ${evaluation.priority}\n\n## Proposed triage summary\n${evaluation.summary}\n\n## Issue body\n${issue.body ?? "(no issue body provided)"}\n`;
  writeTrackedText(draftPath, draft);
  return {
    id: issueKey,
    issueNumber: issue.number,
    issueTitle: issue.title,
    issueUrl: issue.html_url,
    issueUpdatedAt: issue.updated_at,
    priority: evaluation.priority,
    recommendedLabels: evaluation.recommendedLabels,
    matchedRules: evaluation.matchedRules,
    status: "queued",
    proposedAt: timestamp,
    summary: evaluation.summary,
    draftPath,
    publicationPath,
    publicationReason: `Awaiting approval before publishing knowledge update or applying GitHub mutations for issue #${issue.number}.`,
  };
}

function createMinimalDaemonEnv(config: OmxDaemonConfig | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const allowlist = new Set([
    "PATH",
    "HOME",
    "USERPROFILE",
    "USER",
    "USERNAME",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SHELL",
    "NODE_ENV",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "http_proxy",
    "https_proxy",
    "NO_PROXY",
    "no_proxy",
    "GH_TOKEN",
    "GITHUB_TOKEN",
  ]);
  if (config?.githubTokenEnvVar) {
    allowlist.add(config.githubTokenEnvVar);
  }
  for (const key of allowlist) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  return env;
}

function parseGitHubRepository(raw: string): string | null {
  const normalized = raw.trim();
  if (!normalized) return null;
  const matchers = [
    /github\.com[:/](?<owner>[^/]+)\/(?<repo>[^/.]+)(?:\.git)?$/i,
    /^(?<owner>[^/]+)\/(?<repo>[^/.]+)$/,
  ];
  for (const matcher of matchers) {
    const match = normalized.match(matcher);
    if (match?.groups?.owner && match?.groups?.repo) {
      return `${match.groups.owner}/${match.groups.repo}`;
    }
  }
  return null;
}

function resolveRepository(projectRoot: string, config: OmxDaemonConfig | null): string | null {
  const fromConfig = parseGitHubRepository(config?.repository ?? "");
  if (fromConfig) return fromConfig;
  const remote = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd: projectRoot,
    encoding: "utf-8",
    timeout: 3000,
    windowsHide: true,
  });
  if (remote.status === 0 && remote.stdout) {
    return parseGitHubRepository(remote.stdout.trim());
  }
  return null;
}

export function resolveGitHubToken(
  config: OmxDaemonConfig | null,
  env: NodeJS.ProcessEnv = process.env,
  spawnSyncImpl: typeof spawnSync = spawnSync,
): ResolveGitHubTokenResult {
  if (config?.githubCredentialSource === "config-token-ref" && config.githubTokenEnvVar) {
    const token = env[config.githubTokenEnvVar]?.trim();
    if (token) return { token, source: "config-token-ref" };
  }
  const ghToken = env.GH_TOKEN?.trim();
  if (ghToken) return { token: ghToken, source: "GH_TOKEN" };
  const githubToken = env.GITHUB_TOKEN?.trim();
  if (githubToken) return { token: githubToken, source: "GITHUB_TOKEN" };
  const gh = spawnSyncImpl("gh", ["auth", "token"], {
    encoding: "utf-8",
    timeout: 3000,
    windowsHide: true,
  });
  if (gh.status === 0) {
    const token = gh.stdout?.trim();
    if (token) return { token, source: "gh-auth" };
  }
  return {
    token: null,
    source: "none",
    error: "No GitHub credential available (expected daemon config token ref, GH_TOKEN, GITHUB_TOKEN, or `gh auth token`).",
  };
}

async function fetchOpenIssues(repository: string, token: string, maxIssues: number): Promise<GitHubIssue[]> {
  const response = await fetch(`https://api.github.com/repos/${repository}/issues?state=open&per_page=${maxIssues}&sort=updated&direction=desc`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "oh-my-codex-omx-daemon",
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub issue fetch failed (${response.status}): ${body.slice(0, 300)}`);
  }
  const issues = await response.json() as GitHubIssue[];
  return issues.filter((issue) => !issue.pull_request);
}

async function applyApprovedGitHubLabels(repository: string, item: OmxDaemonQueueItem, token: string): Promise<void> {
  if (item.recommendedLabels.length === 0) return;
  const response = await fetch(`https://api.github.com/repos/${repository}/issues/${item.issueNumber}`, {
    method: "PATCH",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "oh-my-codex-omx-daemon",
    },
    body: JSON.stringify({ labels: item.recommendedLabels }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub label update failed (${response.status}): ${body.slice(0, 300)}`);
  }
}

export async function runOmxDaemonOnce(projectRoot = process.cwd()): Promise<DaemonResponse> {
  const paths = daemonPaths(projectRoot);
  if (!hasRequiredGovernanceFiles(projectRoot)) {
    return {
      success: false,
      message: "Daemon is not initialized for this worktree. Use $setup-omx-daemon (or scaffold the .omx/daemon files) first.",
      state: {
        ...readDaemonState(projectRoot),
        statusReason: "not-initialized",
      },
    };
  }

  ensureDir(paths.runtimeDir);
  ensureDir(paths.outboxDir);

  const config = readOmxDaemonConfig(projectRoot);
  const repository = resolveRepository(projectRoot, config);
  if (!repository) {
    const state = {
      ...readDaemonState(projectRoot),
      statusReason: "missing-repository",
      lastError: "Unable to resolve GitHub repository from daemon config or git remote origin.",
    };
    writeDaemonState(projectRoot, state);
    return {
      success: false,
      message: "Unable to resolve GitHub repository. Add `repository` to .omx/daemon/daemon.config.json or set git remote origin.",
      state,
      error: state.lastError,
    };
  }

  const tokenResult = resolveGitHubToken(config);
  if (!tokenResult.token) {
    const state = {
      ...readDaemonState(projectRoot),
      repository,
      credentialSource: tokenResult.source,
      statusReason: "missing-credentials",
      lastError: tokenResult.error,
    };
    writeDaemonState(projectRoot, state);
    return {
      success: false,
      message: "GitHub credentials are missing or insufficient. Check daemon.config.json and status guidance.",
      state,
      error: tokenResult.error,
    };
  }

  const gate = readIssueGate(projectRoot);
  const context = readContextSnippet(projectRoot);
  const queue = readQueue(projectRoot);
  const state = readDaemonState(projectRoot);
  const processedIssueKeys = { ...(state.processedIssueKeys ?? {}) };

  try {
    const issues = await fetchOpenIssues(repository, tokenResult.token, normalizeConfig(config ?? {}).maxIssuesPerRun);
    const queuedIssueIds = new Set(queue.filter((item) => item.status === "queued").map((item) => `${item.issueNumber}:${item.issueUpdatedAt}`));
    let created = 0;

    for (const issue of issues) {
      const issueVersionKey = `${issue.number}:${issue.updated_at}`;
      if (queuedIssueIds.has(issueVersionKey)) continue;
      if (processedIssueKeys[String(issue.number)] === issue.updated_at) continue;

      const evaluation = evaluateIssue(issue, gate, context);
      processedIssueKeys[String(issue.number)] = issue.updated_at;
      if (evaluation.skippedReason) continue;

      const queueItem = createQueueItem(projectRoot, config, issue, evaluation);
      queue.push(queueItem);
      queuedIssueIds.add(issueVersionKey);
      created += 1;
      logToFile(paths.logPath, `Queued issue #${issue.number} (${evaluation.priority}) with rules ${evaluation.matchedRules.join(", ")}`);
    }

    const nextState: OmxDaemonState = {
      ...state,
      repository,
      credentialSource: tokenResult.source,
      lastPollAt: new Date().toISOString(),
      lastIssueScanAt: new Date().toISOString(),
      lastTriageAt: created > 0 ? new Date().toISOString() : state.lastTriageAt,
      queueSize: queue.filter((item) => item.status === "queued").length,
      proposalsCreated: (state.proposalsCreated ?? 0) + created,
      statusReason: created > 0 ? "triage-updated" : "triage-noop",
      lastError: undefined,
      processedIssueKeys,
      isRunning: state.isRunning,
      pid: state.pid,
      startedAt: state.startedAt,
    };

    writeQueue(projectRoot, queue);
    writeDaemonState(projectRoot, nextState);
    return {
      success: true,
      message: created > 0
        ? `Queued ${created} issue proposal(s); ${queueSummary(queue)}`
        : `No new issue proposals created; ${queueSummary(queue)}`,
      state: nextState,
      queue,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const nextState: OmxDaemonState = {
      ...state,
      repository,
      credentialSource: tokenResult.source,
      lastPollAt: new Date().toISOString(),
      statusReason: "poll-failed",
      lastError: message,
      processedIssueKeys,
    };
    writeDaemonState(projectRoot, nextState);
    logToFile(paths.logPath, `ERROR ${message}`);
    return {
      success: false,
      message: "Daemon poll failed.",
      state: nextState,
      queue,
      error: message,
    };
  }
}

export async function approveOmxDaemonItem(projectRoot: string, itemId: string): Promise<DaemonResponse> {
  const paths = daemonPaths(projectRoot);
  const queue = readQueue(projectRoot);
  const item = queue.find((entry) => entry.id === itemId);
  const state = readDaemonState(projectRoot);
  if (!item) {
    return { success: false, message: `Queue item ${itemId} was not found.`, state, error: "queue_item_not_found" };
  }
  if (item.status !== "queued") {
    return { success: false, message: `Queue item ${itemId} is already ${item.status}.`, state, error: "queue_item_not_queued" };
  }

  const config = readOmxDaemonConfig(projectRoot);
  const repository = resolveRepository(projectRoot, config);
  const tokenResult = resolveGitHubToken(config);
  const approvedAt = new Date().toISOString();

  await mkdir(resolveKnowledgeSinkDir(projectRoot, config), { recursive: true });
  const draft = await readFile(item.draftPath, "utf-8");
  await writeFile(item.publicationPath, `${draft}\n\n---\nApproved at: ${approvedAt}\n`, "utf-8");

  let githubLabelMutationApplied = false;
  if (config?.applyGitHubLabelsOnApprove && repository && tokenResult.token) {
    await applyApprovedGitHubLabels(repository, item, tokenResult.token);
    githubLabelMutationApplied = true;
  }

  item.status = "published";
  item.approvedAt = approvedAt;
  item.publishedAt = approvedAt;
  item.githubLabelMutationApplied = githubLabelMutationApplied;

  const nextState: OmxDaemonState = {
    ...state,
    queueSize: queue.filter((entry) => entry.status === "queued").length,
    publishedCount: (state.publishedCount ?? 0) + 1,
    lastTriageAt: approvedAt,
    statusReason: "approved-published",
    lastError: undefined,
  };
  writeQueue(projectRoot, queue);
  writeDaemonState(projectRoot, nextState);
  logToFile(paths.logPath, `Published approved queue item ${itemId} -> ${item.publicationPath}`);
  return {
    success: true,
    message: `Approved ${itemId} and published to ${relative(projectRoot, item.publicationPath)}.`,
    state: nextState,
    queue,
  };
}

export function rejectOmxDaemonItem(projectRoot: string, itemId: string): DaemonResponse {
  const queue = readQueue(projectRoot);
  const item = queue.find((entry) => entry.id === itemId);
  const state = readDaemonState(projectRoot);
  if (!item) {
    return { success: false, message: `Queue item ${itemId} was not found.`, state, error: "queue_item_not_found" };
  }
  if (item.status !== "queued") {
    return { success: false, message: `Queue item ${itemId} is already ${item.status}.`, state, error: "queue_item_not_queued" };
  }
  item.status = "rejected";
  item.rejectedAt = new Date().toISOString();
  const nextState: OmxDaemonState = {
    ...state,
    queueSize: queue.filter((entry) => entry.status === "queued").length,
    rejectedCount: (state.rejectedCount ?? 0) + 1,
    statusReason: "rejected",
    lastError: undefined,
  };
  writeQueue(projectRoot, queue);
  writeDaemonState(projectRoot, nextState);
  logToFile(daemonPaths(projectRoot).logPath, `Rejected queue item ${itemId}`);
  return {
    success: true,
    message: `Rejected ${itemId}.`,
    state: nextState,
    queue,
  };
}

export function getOmxDaemonStatus(projectRoot = process.cwd()): DaemonResponse {
  const configured = hasRequiredGovernanceFiles(projectRoot);
  const state = readDaemonState(projectRoot);
  const queue = readQueue(projectRoot);
  if (!configured) {
    return {
      success: true,
      message: "Daemon is not initialized for this worktree. Use $setup-omx-daemon or scaffold .omx/daemon first.",
      state: {
        ...state,
        statusReason: "not-initialized",
      },
      queue,
    };
  }

  const config = readOmxDaemonConfig(projectRoot);
  const tokenResult = resolveGitHubToken(config);
  const repository = resolveRepository(projectRoot, config);
  const running = isOmxDaemonRunning(projectRoot);
  const statusReason = !tokenResult.token
    ? "missing-credentials"
    : running ? "running" : "stopped";
  return {
    success: true,
    message: !tokenResult.token
      ? `Daemon is configured but credentials are missing (${tokenResult.error}).`
      : running
        ? `Daemon is running for ${repository ?? "unknown-repo"}; ${queueSummary(queue)}.`
        : `Daemon is stopped for ${repository ?? "unknown-repo"}; ${queueSummary(queue)}.`,
    state: {
      ...state,
      isRunning: running,
      pid: running ? readPid(projectRoot) : null,
      credentialSource: tokenResult.source,
      repository,
      queueSize: queue.filter((item) => item.status === "queued").length,
      statusReason,
      lastError: !tokenResult.token ? tokenResult.error : state.lastError,
    },
    queue,
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runOmxDaemonLoop(projectRoot = process.cwd()): Promise<void> {
  const paths = daemonPaths(projectRoot);
  const config = readOmxDaemonConfig(projectRoot);
  if (!config) {
    logToFile(paths.logPath, "No daemon config found; exiting poll loop.");
    return;
  }
  let stopping = false;
  const stop = () => {
    stopping = true;
    const current = readDaemonState(projectRoot);
    writeDaemonState(projectRoot, {
      ...current,
      isRunning: false,
      pid: null,
      statusReason: "stopped",
    });
    removePid(projectRoot);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  logToFile(paths.logPath, `Starting daemon poll loop (${DAEMON_IDENTITY_MARKER})`);
  while (!stopping) {
    const result = await runOmxDaemonOnce(projectRoot);
    logToFile(paths.logPath, result.success ? result.message : `WARN ${result.error ?? result.message}`);
    if (stopping) break;
    await sleep(normalizeConfig(config).pollIntervalMs);
  }
  logToFile(paths.logPath, "Poll loop ended.");
}

export function startOmxDaemon(projectRoot = process.cwd()): DaemonResponse {
  if (!hasRequiredGovernanceFiles(projectRoot)) {
    return {
      success: false,
      message: "Daemon is not initialized for this worktree. Use $setup-omx-daemon or scaffold .omx/daemon first.",
      state: { ...readDaemonState(projectRoot), statusReason: "not-initialized" },
    };
  }
  if (isOmxDaemonRunning(projectRoot)) {
    const state = readDaemonState(projectRoot);
    return { success: true, message: "omx daemon is already running.", state };
  }

  const config = readOmxDaemonConfig(projectRoot);
  const tokenResult = resolveGitHubToken(config);
  if (!tokenResult.token) {
    const state = { ...readDaemonState(projectRoot), statusReason: "missing-credentials", lastError: tokenResult.error };
    writeDaemonState(projectRoot, state);
    return { success: false, message: "Cannot start daemon without GitHub credentials.", state, error: tokenResult.error };
  }

  const modulePath = import.meta.url;
  const child = spawn(process.execPath, ["-e", `import('${modulePath}').then((m) => m.runOmxDaemonLoop(${JSON.stringify(projectRoot)})).catch((err) => { console.error('${DAEMON_IDENTITY_MARKER}', err); process.exit(1); });`], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    cwd: projectRoot,
    env: createMinimalDaemonEnv(config),
  });
  child.unref();
  const pid = child.pid;
  if (!pid) {
    return { success: false, message: "Failed to start daemon process.", error: "missing_child_pid" };
  }
  writePid(projectRoot, pid);
  const state: OmxDaemonState = {
    ...readDaemonState(projectRoot),
    isRunning: true,
    pid,
    startedAt: new Date().toISOString(),
    credentialSource: tokenResult.source,
    statusReason: "running",
  };
  writeDaemonState(projectRoot, state);
  logToFile(daemonPaths(projectRoot).logPath, `Started omx daemon with PID ${pid}`);
  return { success: true, message: `omx daemon started with PID ${pid}.`, state };
}

export function stopOmxDaemon(projectRoot = process.cwd()): DaemonResponse {
  const pid = readPid(projectRoot);
  if (pid === null) {
    return { success: true, message: "omx daemon is not running.", state: { ...readDaemonState(projectRoot), isRunning: false, pid: null, statusReason: "stopped" } };
  }
  if (!isProcessRunning(pid)) {
    removePid(projectRoot);
    return { success: true, message: "omx daemon was not running (removed stale PID file).", state: { ...readDaemonState(projectRoot), isRunning: false, pid: null, statusReason: "stopped" } };
  }
  if (!isDaemonProcess(pid)) {
    removePid(projectRoot);
    return { success: false, message: `Refusing to kill PID ${pid}: process identity does not match omx daemon.`, error: "pid_identity_mismatch" };
  }
  try {
    process.kill(pid, "SIGTERM");
    removePid(projectRoot);
    const state = { ...readDaemonState(projectRoot), isRunning: false, pid: null, statusReason: "stopped" };
    writeDaemonState(projectRoot, state);
    logToFile(daemonPaths(projectRoot).logPath, `Stopped omx daemon PID ${pid}`);
    return { success: true, message: `omx daemon stopped (PID ${pid}).`, state };
  } catch (error) {
    return {
      success: false,
      message: "Failed to stop omx daemon.",
      error: error instanceof Error ? error.message : String(error),
      state: readDaemonState(projectRoot),
    };
  }
}
