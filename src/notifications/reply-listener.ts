/**
 * Reply Listener Daemon
 *
 * Background daemon that polls Discord and Telegram for replies to notification messages,
 * sanitizes input, verifies the target pane, and injects reply text via sendToPane().
 *
 * Security considerations:
 * - State/PID/log files use restrictive permissions (0600)
 * - Bot tokens stored in state file, NOT in environment variables
 * - Two-layer input sanitization (sanitizeReplyInput + newline stripping in buildSendPaneArgvs)
 * - Pane verification via analyzePaneContent before every injection
 * - Authorization: only configured user IDs (Discord) / sender IDs plus chat boundary (Telegram) can inject
 * - Rate limiting to prevent spam/abuse
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, chmodSync, statSync, appendFileSync, renameSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { spawn, spawnSync } from 'child_process';
import { request as httpsRequest } from 'https';
import {
  capturePaneContent,
  analyzePaneContent,
  sendToPane,
  isTmuxAvailable,
} from './tmux-detector.js';
import {
  lookupBySourceMessage,
  removeMessagesByPane,
  pruneStale,
} from './session-registry.js';
import {
  buildDiscordReplySource,
  buildTelegramReplySource,
  type ReplySourceDescriptor,
} from './reply-source.js';
import {
  NO_TRACKED_SESSION_MESSAGE,
  buildDiscordSessionStatusReply,
  isDiscordStatusCommand,
} from './session-status.js';
import { parseMentionAllowedMentions } from './config.js';
import { parseTmuxTail } from './formatter.js';
import { spawnPlatformCommandSync } from '../utils/platform-command.js';
import type {
  ReplyAcknowledgementMode,
  ReplyConfig,
  TelegramStartupBacklogPolicy,
} from './types.js';

const __filename = fileURLToPath(import.meta.url);

const SECURE_FILE_MODE = 0o600;
const MAX_LOG_SIZE_BYTES = 1 * 1024 * 1024;

const DAEMON_ENV_ALLOWLIST = [
  'PATH', 'HOME', 'USERPROFILE',
  'USER', 'USERNAME', 'LOGNAME',
  'LANG', 'LC_ALL', 'LC_CTYPE',
  'TERM', 'TMUX', 'TMUX_PANE',
  'TMPDIR', 'TMP', 'TEMP',
  'XDG_RUNTIME_DIR', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME',
  'SHELL',
  'NODE_ENV',
  'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy',
  'SystemRoot', 'SYSTEMROOT', 'windir', 'COMSPEC',
] as const;

const DEFAULT_STATE_DIR = join(homedir(), '.omx', 'state');
const PID_FILE_PATH = join(DEFAULT_STATE_DIR, 'reply-listener.pid');
const STATE_FILE_PATH = join(DEFAULT_STATE_DIR, 'reply-listener-state.json');
const LOG_FILE_PATH = join(DEFAULT_STATE_DIR, 'reply-listener.log');
const MIN_REPLY_POLL_INTERVAL_MS = 500;
const MAX_REPLY_POLL_INTERVAL_MS = 60_000;
const DEFAULT_REPLY_POLL_INTERVAL_MS = 3_000;
const MIN_REPLY_RATE_LIMIT_PER_MINUTE = 1;
const DEFAULT_REPLY_RATE_LIMIT_PER_MINUTE = 10;
const MIN_REPLY_MAX_MESSAGE_LENGTH = 1;
const MAX_REPLY_MAX_MESSAGE_LENGTH = 4_000;
const DEFAULT_REPLY_MAX_MESSAGE_LENGTH = 500;
const MIN_TELEGRAM_POLL_TIMEOUT_SECONDS = 1;
const MAX_TELEGRAM_POLL_TIMEOUT_SECONDS = 60;
const DEFAULT_TELEGRAM_POLL_TIMEOUT_SECONDS = 30;
const DEFAULT_TELEGRAM_ALLOWED_UPDATES = ['message'];
const DEFAULT_REPLY_ACK_MODE: ReplyAcknowledgementMode = 'minimal';
const DEFAULT_TELEGRAM_STARTUP_BACKLOG_POLICY: TelegramStartupBacklogPolicy = 'resume';
const REPLY_ACK_CAPTURE_LINES = 200;
const REPLY_ACK_SUMMARY_MAX_CHARS = 700;
const REPLY_ACK_PREFIX = 'Injected into Codex CLI session.';
const REPLY_ACK_FALLBACK = 'Recent output summary unavailable.';

export interface ReplyListenerState {
  isRunning: boolean;
  pid: number | null;
  startedAt: string | null;
  lastPollAt: string | null;
  telegramLastUpdateId: number | null;
  discordLastMessageId: string | null;
  telegramStartupPolicyApplied: boolean;
  sourceStates: Record<string, ReplyListenerSourceState>;
  messagesInjected: number;
  errors: number;
  lastError?: string;
}

export interface ReplyListenerSourceState {
  sourceKey: string;
  platform: 'telegram' | 'discord-bot';
  label: string;
  telegramLastUpdateId?: number | null;
  discordLastMessageId?: string | null;
  telegramStartupPolicyApplied?: boolean;
  lastPollAt?: string | null;
  lastIngestAt?: string | null;
}

export interface ReplyListenerDaemonConfig extends ReplyConfig {
  telegramEnabled?: boolean;
  telegramBotToken?: string;
  telegramChatId?: string;
  discordEnabled?: boolean;
  discordBotToken?: string;
  discordChannelId?: string;
  discordMention?: string;
}

export interface DaemonResponse {
  success: boolean;
  message: string;
  state?: ReplyListenerState;
  error?: string;
}

type ReplyProcessingDisposition = 'success' | 'terminal-ignore' | 'retryable-failure';

export interface ReplyInjectionResult {
  outcome: ReplyProcessingDisposition;
  reason?: string;
}

type InjectReplyLikeResult = ReplyInjectionResult | boolean;

type DiscordMessage = {
  id: string;
  author: { id: string };
  content: string;
  message_reference?: { message_id: string };
};

type TelegramUpdate = {
  update_id?: number;
  message?: {
    message_id?: number;
    chat?: { id?: number | string };
    from?: { id?: number | string };
    text?: string;
    reply_to_message?: { message_id?: number | string };
  };
};

const DEFAULT_REPLY_LISTENER_STATE: ReplyListenerState = {
  isRunning: false,
  pid: null,
  startedAt: null,
  lastPollAt: null,
  telegramLastUpdateId: null,
  discordLastMessageId: null,
  telegramStartupPolicyApplied: false,
  sourceStates: {},
  messagesInjected: 0,
  errors: 0,
};

function createMinimalDaemonEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of DAEMON_ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  return env;
}

function ensureStateDir(): void {
  if (!existsSync(DEFAULT_STATE_DIR)) {
    mkdirSync(DEFAULT_STATE_DIR, { recursive: true, mode: 0o700 });
  }
}

function writeSecureFile(filePath: string, content: string): void {
  ensureStateDir();
  writeFileSync(filePath, content, { mode: SECURE_FILE_MODE });
  try {
    chmodSync(filePath, SECURE_FILE_MODE);
  } catch {
    // Ignore permission errors
  }
}

function rotateLogIfNeeded(logPath: string): void {
  try {
    if (!existsSync(logPath)) return;
    const stats = statSync(logPath);
    if (stats.size > MAX_LOG_SIZE_BYTES) {
      const backupPath = `${logPath}.old`;
      if (existsSync(backupPath)) {
        unlinkSync(backupPath);
      }
      renameSync(logPath, backupPath);
    }
  } catch {
    // Ignore rotation errors
  }
}

function log(message: string): void {
  try {
    ensureStateDir();
    rotateLogIfNeeded(LOG_FILE_PATH);
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] ${message}\n`;
    appendFileSync(LOG_FILE_PATH, logLine, { mode: SECURE_FILE_MODE });
  } catch {
    // Ignore log write errors
  }
}

function normalizeInteger(
  value: unknown,
  fallback: number,
  min: number,
  max?: number,
): number {
  const numeric = typeof value === 'number'
    ? Math.trunc(value)
    : (typeof value === 'string' && value.trim()
        ? Number.parseInt(value, 10)
        : Number.NaN);
  if (!Number.isFinite(numeric)) return fallback;
  if (numeric < min) return min;
  if (max !== undefined && numeric > max) return max;
  return numeric;
}

function normalizeStringList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  const normalized = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return normalized.length > 0 ? normalized : [...fallback];
}

function normalizeAckMode(value: unknown): ReplyAcknowledgementMode {
  return value === 'off' || value === 'summary' || value === 'minimal'
    ? value
    : DEFAULT_REPLY_ACK_MODE;
}

function normalizeTelegramStartupBacklogPolicy(value: unknown): TelegramStartupBacklogPolicy {
  return value === 'drop_pending' || value === 'replay_once' || value === 'resume'
    ? value
    : DEFAULT_TELEGRAM_STARTUP_BACKLOG_POLICY;
}

function normalizeReplyListenerState(state: Partial<ReplyListenerState>): ReplyListenerState {
  const rawSourceStates = state.sourceStates && typeof state.sourceStates === 'object'
    ? state.sourceStates
    : {};
  const sourceStates = Object.fromEntries(
    Object.entries(rawSourceStates).map(([sourceKey, sourceState]) => {
      const normalizedSourceState = sourceState as Partial<ReplyListenerSourceState>;
      return [
        sourceKey,
        {
          sourceKey,
          platform: normalizedSourceState.platform === 'telegram' ? 'telegram' : 'discord-bot',
          label: typeof normalizedSourceState.label === 'string' && normalizedSourceState.label.trim()
            ? normalizedSourceState.label
            : sourceKey,
          telegramLastUpdateId:
            typeof normalizedSourceState.telegramLastUpdateId === 'number'
              ? normalizedSourceState.telegramLastUpdateId
              : normalizedSourceState.telegramLastUpdateId === null
                ? null
                : undefined,
          discordLastMessageId:
            typeof normalizedSourceState.discordLastMessageId === 'string'
              ? normalizedSourceState.discordLastMessageId
              : normalizedSourceState.discordLastMessageId === null
                ? null
                : undefined,
          telegramStartupPolicyApplied: normalizedSourceState.telegramStartupPolicyApplied === true,
          lastPollAt: typeof normalizedSourceState.lastPollAt === 'string'
            ? normalizedSourceState.lastPollAt
            : null,
          lastIngestAt: typeof normalizedSourceState.lastIngestAt === 'string'
            ? normalizedSourceState.lastIngestAt
            : null,
        } satisfies ReplyListenerSourceState,
      ];
    }),
  );

  return {
    ...DEFAULT_REPLY_LISTENER_STATE,
    ...state,
    telegramStartupPolicyApplied: state.telegramStartupPolicyApplied === true,
    sourceStates,
  };
}

function getTelegramReplySource(config: ReplyListenerDaemonConfig): ReplySourceDescriptor | null {
  if (!config.telegramEnabled || !config.telegramBotToken || !config.telegramChatId) {
    return null;
  }
  return buildTelegramReplySource(config.telegramBotToken, config.telegramChatId);
}

function getDiscordReplySource(config: ReplyListenerDaemonConfig): ReplySourceDescriptor | null {
  if (!config.discordEnabled || !config.discordBotToken || !config.discordChannelId) {
    return null;
  }
  return buildDiscordReplySource(config.discordBotToken, config.discordChannelId);
}

function listActiveReplySources(config: ReplyListenerDaemonConfig): ReplySourceDescriptor[] {
  return [
    getDiscordReplySource(config),
    getTelegramReplySource(config),
  ].filter((source): source is ReplySourceDescriptor => source !== null);
}

function ensureSourceState(
  state: ReplyListenerState,
  source: ReplySourceDescriptor,
  options: {
    seedFromLegacy?: boolean;
  } = {},
): ReplyListenerSourceState {
  const existing = state.sourceStates[source.key];
  if (existing) {
    return existing;
  }

  const seedFromLegacy = options.seedFromLegacy !== false;

  const created: ReplyListenerSourceState = {
    sourceKey: source.key,
    platform: source.platform,
    label: source.label,
    telegramLastUpdateId: source.platform === 'telegram'
      ? (seedFromLegacy ? state.telegramLastUpdateId : null)
      : undefined,
    discordLastMessageId: source.platform === 'discord-bot'
      ? (seedFromLegacy ? state.discordLastMessageId : null)
      : undefined,
    telegramStartupPolicyApplied: source.platform === 'telegram'
      ? (seedFromLegacy ? state.telegramStartupPolicyApplied : false)
      : false,
    lastPollAt: null,
    lastIngestAt: null,
  };
  state.sourceStates[source.key] = created;
  return created;
}

function syncLegacyStateMirrors(
  state: ReplyListenerState,
  config: ReplyListenerDaemonConfig,
): void {
  const telegramSource = getTelegramReplySource(config);
  const telegramState = telegramSource ? ensureSourceState(state, telegramSource) : null;
  state.telegramLastUpdateId = telegramState?.telegramLastUpdateId ?? null;
  state.telegramStartupPolicyApplied = telegramState?.telegramStartupPolicyApplied === true;

  const discordSource = getDiscordReplySource(config);
  const discordState = discordSource ? ensureSourceState(state, discordSource) : null;
  state.discordLastMessageId = discordState?.discordLastMessageId ?? null;
}

export function normalizeReplyListenerConfig(config: ReplyListenerDaemonConfig): ReplyListenerDaemonConfig {
  const discordEnabled = config.discordEnabled ?? !!(config.discordBotToken && config.discordChannelId);
  const telegramEnabled = config.telegramEnabled ?? !!(config.telegramBotToken && config.telegramChatId);

  return {
    ...config,
    discordEnabled,
    telegramEnabled,
    pollIntervalMs: normalizeInteger(
      config.pollIntervalMs,
      DEFAULT_REPLY_POLL_INTERVAL_MS,
      MIN_REPLY_POLL_INTERVAL_MS,
      MAX_REPLY_POLL_INTERVAL_MS,
    ),
    rateLimitPerMinute: normalizeInteger(
      config.rateLimitPerMinute,
      DEFAULT_REPLY_RATE_LIMIT_PER_MINUTE,
      MIN_REPLY_RATE_LIMIT_PER_MINUTE,
    ),
    maxMessageLength: normalizeInteger(
      config.maxMessageLength,
      DEFAULT_REPLY_MAX_MESSAGE_LENGTH,
      MIN_REPLY_MAX_MESSAGE_LENGTH,
      MAX_REPLY_MAX_MESSAGE_LENGTH,
    ),
    includePrefix: config.includePrefix !== false,
    ackMode: normalizeAckMode(config.ackMode),
    authorizedDiscordUserIds: Array.isArray(config.authorizedDiscordUserIds)
      ? config.authorizedDiscordUserIds.filter((id): id is string => typeof id === 'string' && id.trim() !== '')
      : [],
    authorizedTelegramUserIds: Array.isArray(config.authorizedTelegramUserIds)
      ? config.authorizedTelegramUserIds.filter((id): id is string => typeof id === 'string' && id.trim() !== '')
      : [],
    telegramPollTimeoutSeconds: normalizeInteger(
      config.telegramPollTimeoutSeconds,
      DEFAULT_TELEGRAM_POLL_TIMEOUT_SECONDS,
      MIN_TELEGRAM_POLL_TIMEOUT_SECONDS,
      MAX_TELEGRAM_POLL_TIMEOUT_SECONDS,
    ),
    telegramAllowedUpdates: normalizeStringList(
      config.telegramAllowedUpdates,
      DEFAULT_TELEGRAM_ALLOWED_UPDATES,
    ),
    telegramStartupBacklogPolicy: normalizeTelegramStartupBacklogPolicy(
      config.telegramStartupBacklogPolicy,
    ),
  };
}

function getTelegramSourceIdentity(config: ReplyListenerDaemonConfig): string | null {
  return getTelegramReplySource(config)?.key ?? null;
}

function getDiscordSourceIdentity(config: ReplyListenerDaemonConfig): string | null {
  return getDiscordReplySource(config)?.key ?? null;
}

function reconcileReplyListenerStateWithConfigChange(
  previousConfig: ReplyListenerDaemonConfig,
  nextConfig: ReplyListenerDaemonConfig,
  currentState: ReplyListenerState,
): ReplyListenerState {
  const nextState = { ...currentState };
  const previousTelegramKey = getTelegramSourceIdentity(previousConfig);
  const nextTelegramSource = getTelegramReplySource(nextConfig);
  if (nextTelegramSource && previousTelegramKey !== nextTelegramSource.key) {
    ensureSourceState(nextState, nextTelegramSource, { seedFromLegacy: false });
  }

  const previousDiscordKey = getDiscordSourceIdentity(previousConfig);
  const nextDiscordSource = getDiscordReplySource(nextConfig);
  if (nextDiscordSource && previousDiscordKey !== nextDiscordSource.key) {
    ensureSourceState(nextState, nextDiscordSource, { seedFromLegacy: false });
  }

  listActiveReplySources(nextConfig).forEach((source) => {
    ensureSourceState(nextState, source);
  });
  syncLegacyStateMirrors(nextState, nextConfig);
  return nextState;
}

function readDaemonState(): ReplyListenerState | null {
  try {
    if (!existsSync(STATE_FILE_PATH)) return null;
    const content = readFileSync(STATE_FILE_PATH, 'utf-8');
    return normalizeReplyListenerState(JSON.parse(content) as Partial<ReplyListenerState>);
  } catch {
    return null;
  }
}

function writeDaemonState(state: ReplyListenerState): void {
  writeSecureFile(
    STATE_FILE_PATH,
    JSON.stringify(normalizeReplyListenerState(state), null, 2),
  );
}

function normalizeInjectReplyResult(result: InjectReplyLikeResult): ReplyInjectionResult {
  if (typeof result === 'boolean') {
    return result
      ? { outcome: 'success' }
      : { outcome: 'retryable-failure', reason: 'injection failed' };
  }
  return result;
}

function commitDiscordCursor(
  state: ReplyListenerState,
  config: ReplyListenerDaemonConfig,
  source: ReplySourceDescriptor,
  messageId: string,
  writeDaemonStateImpl: typeof writeDaemonState,
): void {
  const sourceState = ensureSourceState(state, source);
  sourceState.discordLastMessageId = messageId;
  sourceState.lastIngestAt = new Date().toISOString();
  syncLegacyStateMirrors(state, config);
  writeDaemonStateImpl(state);
}

function commitTelegramCursor(
  state: ReplyListenerState,
  config: ReplyListenerDaemonConfig,
  source: ReplySourceDescriptor,
  updateId: number,
  writeDaemonStateImpl: typeof writeDaemonState,
): void {
  const sourceState = ensureSourceState(state, source);
  sourceState.telegramLastUpdateId = updateId;
  sourceState.lastIngestAt = new Date().toISOString();
  syncLegacyStateMirrors(state, config);
  writeDaemonStateImpl(state);
}

function buildTelegramGetUpdatesPath(
  config: ReplyListenerDaemonConfig,
  sourceState: ReplyListenerSourceState,
  options: {
    timeoutSeconds?: number;
    offset?: number;
  } = {},
): string {
  const offset = options.offset ?? (sourceState.telegramLastUpdateId !== null && sourceState.telegramLastUpdateId !== undefined
    ? sourceState.telegramLastUpdateId + 1
    : 0);
  const timeoutSeconds = options.timeoutSeconds ?? config.telegramPollTimeoutSeconds;
  const params = new URLSearchParams();
  params.set('offset', String(offset));
  params.set('timeout', String(timeoutSeconds));
  params.set('allowed_updates', JSON.stringify(config.telegramAllowedUpdates));
  return `/bot${config.telegramBotToken}/getUpdates?${params.toString()}`;
}

function getTelegramRequestTimeoutMs(timeoutSeconds: number): number {
  return Math.max(5_000, (timeoutSeconds + 5) * 1_000);
}

function readDaemonConfig(): ReplyListenerDaemonConfig | null {
  try {
    const configPath = join(DEFAULT_STATE_DIR, 'reply-listener-config.json');
    if (!existsSync(configPath)) return null;
    const content = readFileSync(configPath, 'utf-8');
    return JSON.parse(content) as ReplyListenerDaemonConfig;
  } catch {
    return null;
  }
}

function writeDaemonConfig(config: ReplyListenerDaemonConfig): void {
  const configPath = join(DEFAULT_STATE_DIR, 'reply-listener-config.json');
  writeSecureFile(configPath, JSON.stringify(config, null, 2));
}

function readPidFile(): number | null {
  try {
    if (!existsSync(PID_FILE_PATH)) return null;
    const content = readFileSync(PID_FILE_PATH, 'utf-8');
    const pid = parseInt(content.trim(), 10);
    if (isNaN(pid)) return null;
    return pid;
  } catch {
    return null;
  }
}

function writePidFile(pid: number): void {
  writeSecureFile(PID_FILE_PATH, String(pid));
}

function removePidFile(): void {
  if (existsSync(PID_FILE_PATH)) {
    unlinkSync(PID_FILE_PATH);
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

// Unique token embedded in the daemon's `-e` script; absent from unrelated processes.
const DAEMON_IDENTITY_MARKER = 'pollLoop';

/**
 * Verify that the process with the given PID is our reply listener daemon by
 * inspecting its command line for the daemon identity marker. Returns false if
 * the process cannot be positively identified (safe default).
 */
export function isReplyListenerProcess(
  pid: number,
  options: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    existsImpl?: typeof existsSync;
    spawnImpl?: typeof spawnSync;
  } = {},
): boolean {
  try {
    const platform = options.platform ?? process.platform;
    if (platform === 'linux') {
      // NUL-separated argv available without spawning a subprocess
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
      return cmdline.includes(DAEMON_IDENTITY_MARKER);
    }
    if (process.platform === 'win32') return false;
    // macOS and other POSIX systems
    const { result } = spawnPlatformCommandSync(
      'ps',
      ['-p', String(pid), '-o', 'args='],
      {
        encoding: 'utf-8',
        timeout: 3000,
      },
      platform,
      options.env,
      options.existsImpl,
      options.spawnImpl,
    );
    if (result.status !== 0 || result.error) return false;
    return (result.stdout ?? '').includes(DAEMON_IDENTITY_MARKER);
  } catch {
    return false;
  }
}

export function isDaemonRunning(): boolean {
  const pid = readPidFile();
  if (pid === null) return false;

  if (!isProcessRunning(pid)) {
    removePidFile();
    return false;
  }

  if (!isReplyListenerProcess(pid)) {
    removePidFile();
    return false;
  }

  return true;
}

// ============================================================================
// Input Sanitization
// ============================================================================

export function sanitizeReplyInput(text: string): string {
  return text
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')                  // Strip control chars (keep \n, \r, \t)
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')            // Strip bidi override characters
    .replace(/\r?\n/g, ' ')                                               // Newlines -> spaces
    .replace(/\\/g, '\\\\')                                               // Escape backslashes
    .replace(/`/g, '\\`')                                                 // Escape backticks
    .replace(/\$\(/g, '\\$(')                                             // Escape $()
    .replace(/\$\{/g, '\\${')                                             // Escape ${}
    .trim();
}

// ============================================================================
// Rate Limiting
// ============================================================================

export interface ReplyListenerRateLimiter {
  canProceed(): boolean;
  reset(): void;
}

export class RateLimiter implements ReplyListenerRateLimiter {
  private timestamps: number[] = [];
  private readonly windowMs = 60 * 1000;

  constructor(private readonly maxPerMinute: number) {}

  canProceed(): boolean {
    const now = Date.now();
    this.timestamps = this.timestamps.filter(t => now - t < this.windowMs);
    if (this.timestamps.length >= this.maxPerMinute) return false;
    this.timestamps.push(now);
    return true;
  }

  reset(): void {
    this.timestamps = [];
  }
}


// ============================================================================
// Injection
// ============================================================================

interface ReplyAcknowledgementDeps {
  capturePaneContentImpl?: typeof capturePaneContent;
  parseTmuxTailImpl?: typeof parseTmuxTail;
}

export interface ReplyListenerDiscordPollDeps {
  fetchImpl?: typeof fetch;
  lookupByMessageIdImpl?: (
    platform: string,
    messageId: string,
    sourceKey: string | null,
  ) => ReturnType<typeof lookupBySourceMessage>;
  injectReplyImpl?: (
    paneId: string,
    text: string,
    platform: string,
    config: ReplyListenerDaemonConfig,
  ) => InjectReplyLikeResult;
  captureReplyAcknowledgementSummaryImpl?: typeof captureReplyAcknowledgementSummary;
  formatReplyAcknowledgementImpl?: typeof formatReplyAcknowledgement;
  writeDaemonStateImpl?: typeof writeDaemonState;
  logImpl?: typeof log;
}

export interface ReplyListenerTelegramPollDeps {
  httpsRequestImpl?: typeof httpsRequest;
  lookupByMessageIdImpl?: (
    platform: string,
    messageId: string,
    sourceKey: string | null,
  ) => ReturnType<typeof lookupBySourceMessage>;
  injectReplyImpl?: (
    paneId: string,
    text: string,
    platform: string,
    config: ReplyListenerDaemonConfig,
  ) => InjectReplyLikeResult;
  captureReplyAcknowledgementSummaryImpl?: typeof captureReplyAcknowledgementSummary;
  formatReplyAcknowledgementImpl?: typeof formatReplyAcknowledgement;
  writeDaemonStateImpl?: typeof writeDaemonState;
  logImpl?: typeof log;
}

export interface ReplyListenerPollDeps {
  fetchImpl?: typeof fetch;
  httpsRequestImpl?: typeof httpsRequest;
  injectReplyImpl?: (
    paneId: string,
    text: string,
    platform: string,
    config: ReplyListenerDaemonConfig,
  ) => InjectReplyLikeResult;
  buildSessionStatusReplyImpl?: typeof buildDiscordSessionStatusReply;
  captureReplyAcknowledgementSummaryImpl?: typeof captureReplyAcknowledgementSummary;
  formatReplyAcknowledgementImpl?: typeof formatReplyAcknowledgement;
  lookupByMessageIdImpl?: (
    platform: string,
    messageId: string,
    sourceKey: string | null,
  ) => ReturnType<typeof lookupBySourceMessage>;
  writeDaemonStateImpl?: typeof writeDaemonState;
  parseMentionAllowedMentionsImpl?: typeof parseMentionAllowedMentions;
  logImpl?: typeof log;
}

interface ReplyListenerRuntimeRefreshDeps {
  readDaemonConfigImpl?: typeof readDaemonConfig;
}

const SENSITIVE_KEY_PATTERN = /(["']?(?:api[_-]?key|token|secret|password|credentials?|authorization)["']?\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\n]+)/gi;
const SENSITIVE_TOKEN_PATTERNS: RegExp[] = [
  /(?:sk-(?:proj-|live-|test-)?|ghp_|gho_|ghs_|ghu_|github_pat_|xox[bpsar]-|glpat-|AKIA[A-Z0-9])\S+/g,
];

export function redactSensitiveTokens(text: string): string {
  const withoutKeyedSecrets = text.replace(SENSITIVE_KEY_PATTERN, (match, prefix: string) => {
    const value = match.slice(prefix.length).trimStart();
    const quote = value.startsWith('"') ? '"' : value.startsWith('\'') ? '\'' : '';
    return `${prefix}${quote}[REDACTED]${quote}`;
  });
  return SENSITIVE_TOKEN_PATTERNS.reduce(
    (t, re) => t.replace(re, '[REDACTED]'),
    withoutKeyedSecrets,
  );
}

export function captureReplyAcknowledgementSummary(
  paneId: string,
  deps: ReplyAcknowledgementDeps = {},
): string | null {
  const capturePaneContentImpl = deps.capturePaneContentImpl ?? capturePaneContent;
  const parseTmuxTailImpl = deps.parseTmuxTailImpl ?? parseTmuxTail;
  const raw = capturePaneContentImpl(paneId, REPLY_ACK_CAPTURE_LINES);
  if (!raw) return null;

  const summary = redactSensitiveTokens(
    parseTmuxTailImpl(raw)
      .replace(/\r/g, '')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
      .trim(),
  );

  if (!summary) return null;
  if (summary.length <= REPLY_ACK_SUMMARY_MAX_CHARS) return summary;

  return `${summary.slice(0, REPLY_ACK_SUMMARY_MAX_CHARS - 1).trimEnd()}…`;
}

export function formatReplyAcknowledgement(
  summary: string | null,
  mode: ReplyAcknowledgementMode = DEFAULT_REPLY_ACK_MODE,
): string | null {
  if (mode === 'off') {
    return null;
  }
  if (mode === 'minimal') {
    return REPLY_ACK_PREFIX;
  }
  if (!summary) {
    return `${REPLY_ACK_PREFIX}\n\n${REPLY_ACK_FALLBACK}`;
  }

  return `${REPLY_ACK_PREFIX}\n\nRecent output:\n${summary}`;
}

function buildReplyAcknowledgement(
  paneId: string,
  config: ReplyListenerDaemonConfig,
  captureReplyAcknowledgementSummaryImpl: typeof captureReplyAcknowledgementSummary,
  formatReplyAcknowledgementImpl: typeof formatReplyAcknowledgement,
): string | null {
  const summary = config.ackMode === 'summary'
    ? captureReplyAcknowledgementSummaryImpl(paneId)
    : null;
  return formatReplyAcknowledgementImpl(summary, config.ackMode);
}

export function refreshReplyListenerRuntimeConfig(
  currentConfig: ReplyListenerDaemonConfig,
  currentRateLimiter: ReplyListenerRateLimiter,
  deps: ReplyListenerRuntimeRefreshDeps = {},
): {
  config: ReplyListenerDaemonConfig;
  rateLimiter: ReplyListenerRateLimiter;
  shouldStopDaemon: boolean;
} {
  const readDaemonConfigImpl = deps.readDaemonConfigImpl ?? readDaemonConfig;
  const nextConfig = readDaemonConfigImpl();
  if (!nextConfig) {
    return {
      config: currentConfig,
      rateLimiter: currentRateLimiter,
      shouldStopDaemon: false,
    };
  }

  const normalizedConfig = normalizeReplyListenerConfig(nextConfig);
  const shouldStopDaemon =
    !normalizedConfig.discordEnabled && !normalizedConfig.telegramEnabled;
  if (normalizedConfig.rateLimitPerMinute === currentConfig.rateLimitPerMinute) {
    return {
      config: normalizedConfig,
      rateLimiter: currentRateLimiter,
      shouldStopDaemon,
    };
  }

  return {
    config: normalizedConfig,
    rateLimiter: new RateLimiter(normalizedConfig.rateLimitPerMinute),
    shouldStopDaemon,
  };
}

export function reconcileSourceRateLimiters(
  config: ReplyListenerDaemonConfig,
  currentRateLimiters: Map<string, ReplyListenerRateLimiter>,
  previousConfig?: ReplyListenerDaemonConfig,
): Map<string, ReplyListenerRateLimiter> {
  const rateLimitChanged = previousConfig !== undefined
    && previousConfig.rateLimitPerMinute !== config.rateLimitPerMinute;
  const nextRateLimiters = new Map<string, ReplyListenerRateLimiter>();

  for (const source of listActiveReplySources(config)) {
    if (!rateLimitChanged && currentRateLimiters.has(source.key)) {
      nextRateLimiters.set(source.key, currentRateLimiters.get(source.key)!);
      continue;
    }

    nextRateLimiters.set(source.key, new RateLimiter(config.rateLimitPerMinute));
  }

  return nextRateLimiters;
}

function injectReply(
  paneId: string,
  text: string,
  platform: string,
  config: ReplyListenerDaemonConfig,
): ReplyInjectionResult {
  const content = capturePaneContent(paneId, 15);
  const analysis = analyzePaneContent(content);

  if (analysis.confidence < 0.4) {
    log(`WARN: Pane ${paneId} does not appear to be running Codex CLI (confidence: ${analysis.confidence}). Skipping injection, removing stale mapping.`);
    removeMessagesByPane(paneId);
    return {
      outcome: 'terminal-ignore',
      reason: `pane verification failed (${analysis.confidence.toFixed(2)})`,
    };
  }

  const prefix = config.includePrefix ? `[reply:${platform}] ` : '';
  const sanitized = sanitizeReplyInput(prefix + text);
  const truncated = sanitized.slice(0, config.maxMessageLength);
  const success = sendToPane(paneId, truncated, true);

  if (success) {
    log(`Injected reply from ${platform} into pane ${paneId}: "${truncated.slice(0, 50)}${truncated.length > 50 ? '...' : ''}"`);
  } else {
    log(`ERROR: Failed to inject reply into pane ${paneId}`);
  }

  return success
    ? { outcome: 'success' }
    : { outcome: 'retryable-failure', reason: 'tmux send failed' };
}

async function postDiscordReplyMessage(
  config: ReplyListenerDaemonConfig,
  replyToMessageId: string,
  content: string,
  deps: {
    fetchImpl: typeof fetch;
    logImpl: typeof log;
  },
): Promise<void> {
  try {
    const response = await deps.fetchImpl(
      `https://discord.com/api/v10/channels/${config.discordChannelId}/messages`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bot ${config.discordBotToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content,
          message_reference: { message_id: replyToMessageId },
          allowed_mentions: { parse: [] as string[] },
        }),
        signal: AbortSignal.timeout(5000),
      },
    );

    if (!response.ok) {
      deps.logImpl(`WARN: Failed to send Discord reply message: HTTP ${response.status}`);
    }
  } catch (error) {
    deps.logImpl(`WARN: Failed to send Discord reply message: ${error}`);
  }
}

// ============================================================================
// Discord Polling
// ============================================================================

let discordBackoffUntil = 0;

export function resetReplyListenerTransientState(): void {
  discordBackoffUntil = 0;
}

async function pollDiscord(
  config: ReplyListenerDaemonConfig,
  state: ReplyListenerState,
  rateLimiter: ReplyListenerRateLimiter,
): Promise<void> {
  return pollDiscordOnce(config, state, rateLimiter);
}

export async function pollDiscordOnce(
  config: ReplyListenerDaemonConfig,
  state: ReplyListenerState,
  rateLimiter: ReplyListenerRateLimiter,
  deps: ReplyListenerPollDeps = {},
): Promise<void> {
  if (config.discordEnabled === false) return;
  if (!config.discordBotToken || !config.discordChannelId) return;
  if (config.authorizedDiscordUserIds.length === 0) return;
  if (Date.now() < discordBackoffUntil) return;

  const source = getDiscordReplySource(config);
  if (!source) return;
  const sourceState = ensureSourceState(state, source);

  const fetchImpl = deps.fetchImpl ?? fetch;
  const injectReplyImpl = deps.injectReplyImpl ?? injectReply;
  const buildSessionStatusReplyImpl = deps.buildSessionStatusReplyImpl ?? buildDiscordSessionStatusReply;
  const captureReplyAcknowledgementSummaryImpl = deps.captureReplyAcknowledgementSummaryImpl ?? captureReplyAcknowledgementSummary;
  const formatReplyAcknowledgementImpl = deps.formatReplyAcknowledgementImpl ?? formatReplyAcknowledgement;
  const lookupByMessageIdImpl = deps.lookupByMessageIdImpl ?? lookupBySourceMessage;
  const writeDaemonStateImpl = deps.writeDaemonStateImpl ?? writeDaemonState;
  const parseMentionAllowedMentionsImpl = deps.parseMentionAllowedMentionsImpl ?? parseMentionAllowedMentions;
  const logImpl = deps.logImpl ?? log;

  try {
    const after = sourceState.discordLastMessageId ? `?after=${sourceState.discordLastMessageId}&limit=10` : '?limit=10';
    const url = `https://discord.com/api/v10/channels/${config.discordChannelId}/messages${after}`;

    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { 'Authorization': `Bot ${config.discordBotToken}` },
      signal: AbortSignal.timeout(10000),
    });

    const remaining = response.headers.get('x-ratelimit-remaining');
    const reset = response.headers.get('x-ratelimit-reset');
    if (remaining !== null && parseInt(remaining, 10) < 2) {
      const parsed = reset ? parseFloat(reset) : Number.NaN;
      const resetTime = Number.isFinite(parsed) ? parsed * 1000 : Date.now() + 10_000;
      discordBackoffUntil = resetTime;
      logImpl(`WARN: Discord rate limit low (remaining: ${remaining}), backing off until ${new Date(resetTime).toISOString()}`);
    }

    if (!response.ok) {
      logImpl(`Discord API error: HTTP ${response.status}`);
      return;
    }

    const messages = await response.json() as DiscordMessage[];

    if (!Array.isArray(messages) || messages.length === 0) return;

    sourceState.lastPollAt = new Date().toISOString();
    const sorted = [...messages].reverse();

    for (const msg of sorted) {
      const isStatusCommand = isDiscordStatusCommand(msg.content ?? '');

      if (!msg.message_reference?.message_id) {
        commitDiscordCursor(state, config, source, msg.id, writeDaemonStateImpl);
        continue;
      }

      if (!config.authorizedDiscordUserIds.includes(msg.author.id)) {
        commitDiscordCursor(state, config, source, msg.id, writeDaemonStateImpl);
        continue;
      }

      const mapping = lookupByMessageIdImpl('discord-bot', msg.message_reference.message_id, source.key);
      if (!mapping) {
        if (isStatusCommand) {
          await postDiscordReplyMessage(config, msg.id, NO_TRACKED_SESSION_MESSAGE, {
            fetchImpl,
            logImpl,
          });
        }
        commitDiscordCursor(state, config, source, msg.id, writeDaemonStateImpl);
        continue;
      }

      if (!rateLimiter.canProceed()) {
        logImpl(`WARN: Rate limit exceeded, deferring Discord message ${msg.id}`);
        state.errors++;
        break;
      }

      if (isStatusCommand) {
        const statusMessage = await buildSessionStatusReplyImpl(mapping);
        await postDiscordReplyMessage(config, msg.id, statusMessage, {
          fetchImpl,
          logImpl,
        });
        commitDiscordCursor(state, config, source, msg.id, writeDaemonStateImpl);
        continue;
      }

      const injectionResult = normalizeInjectReplyResult(
        injectReplyImpl(mapping.tmuxPaneId, msg.content, 'discord', config),
      );
      if (injectionResult.outcome === 'success') {
        state.messagesInjected++;
        commitDiscordCursor(state, config, source, msg.id, writeDaemonStateImpl);

        const acknowledgement = buildReplyAcknowledgement(
          mapping.tmuxPaneId,
          config,
          captureReplyAcknowledgementSummaryImpl,
          formatReplyAcknowledgementImpl,
        );
        if (acknowledgement !== null) {
          // Add ✅ reaction to the user's reply
          try {
            await fetchImpl(
              `https://discord.com/api/v10/channels/${config.discordChannelId}/messages/${msg.id}/reactions/%E2%9C%85/@me`,
              {
                method: 'PUT',
                headers: { 'Authorization': `Bot ${config.discordBotToken}` },
                signal: AbortSignal.timeout(5000),
              }
            );
          } catch (e) {
            logImpl(`WARN: Failed to add confirmation reaction: ${e}`);
          }

          // Send injection notification as a reply to the user's message (non-critical)
          try {
            const feedbackAllowedMentions = config.discordMention
              ? parseMentionAllowedMentionsImpl(config.discordMention)
              : { parse: [] as string[] };
            await fetchImpl(
              `https://discord.com/api/v10/channels/${config.discordChannelId}/messages`,
              {
                method: 'POST',
                headers: {
                  'Authorization': `Bot ${config.discordBotToken}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  content: acknowledgement,
                  message_reference: { message_id: msg.id },
                  allowed_mentions: feedbackAllowedMentions,
                }),
                signal: AbortSignal.timeout(5000),
              }
            );
          } catch (e) {
            logImpl(`WARN: Failed to send injection channel notification: ${e}`);
          }
        }
      } else if (injectionResult.outcome === 'terminal-ignore') {
        commitDiscordCursor(state, config, source, msg.id, writeDaemonStateImpl);
      } else {
        state.errors++;
        logImpl(`WARN: Deferring Discord message ${msg.id} after retryable intake failure${injectionResult.reason ? `: ${injectionResult.reason}` : ''}`);
        break;
      }
    }
  } catch (error) {
    state.errors++;
    state.lastError = error instanceof Error ? error.message : String(error);
    logImpl(`Discord polling error: ${state.lastError}`);
  }
}

// ============================================================================
// Telegram Polling
// ============================================================================

async function requestTelegramUpdates(
  config: ReplyListenerDaemonConfig,
  sourceState: ReplyListenerSourceState,
  httpsRequestImpl: typeof httpsRequest,
  options: {
    timeoutSeconds?: number;
    offset?: number;
  } = {},
): Promise<TelegramUpdate[]> {
  const timeoutSeconds = options.timeoutSeconds ?? config.telegramPollTimeoutSeconds;
  const path = buildTelegramGetUpdatesPath(config, sourceState, {
    timeoutSeconds,
    ...(options.offset !== undefined ? { offset: options.offset } : {}),
  });

  return await new Promise<TelegramUpdate[]>((resolve, reject) => {
    const req = httpsRequestImpl(
      {
        hostname: 'api.telegram.org',
        path,
        method: 'GET',
        family: 4,
        timeout: getTelegramRequestTimeoutMs(timeoutSeconds),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
              result?: TelegramUpdate[];
            };
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve(Array.isArray(body.result) ? body.result : []);
            } else {
              reject(new Error(`HTTP ${res.statusCode}`));
            }
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.end();
  });
}

async function sendTelegramReplyMessage(
  config: ReplyListenerDaemonConfig,
  httpsRequestImpl: typeof httpsRequest,
  body: Record<string, unknown>,
): Promise<void> {
  const replyBody = JSON.stringify(body);

  await new Promise<void>((resolve) => {
    const replyReq = httpsRequestImpl(
      {
        hostname: 'api.telegram.org',
        path: `/bot${config.telegramBotToken}/sendMessage`,
        method: 'POST',
        family: 4,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(replyBody),
        },
        timeout: 5000,
      },
      (res) => {
        res.resume();
        resolve();
      }
    );

    replyReq.on('error', () => resolve());
    replyReq.on('timeout', () => {
      replyReq.destroy();
      resolve();
    });

    replyReq.write(replyBody);
    replyReq.end();
  });
}

async function applyTelegramStartupBacklogPolicy(
  config: ReplyListenerDaemonConfig,
  state: ReplyListenerState,
  source: ReplySourceDescriptor,
  httpsRequestImpl: typeof httpsRequest,
  writeDaemonStateImpl: typeof writeDaemonState,
  logImpl: typeof log,
): Promise<boolean> {
  const sourceState = ensureSourceState(state, source);
  if (sourceState.telegramStartupPolicyApplied) {
    return false;
  }

  sourceState.telegramStartupPolicyApplied = true;
  syncLegacyStateMirrors(state, config);

  if (config.telegramStartupBacklogPolicy !== 'drop_pending') {
    writeDaemonStateImpl(state);
    return false;
  }

  const updates = await requestTelegramUpdates(config, sourceState, httpsRequestImpl, { timeoutSeconds: 0 });
  const lastUpdateId = updates
    .map((update) => update.update_id)
    .filter((updateId): updateId is number => typeof updateId === 'number')
    .at(-1);

  if (lastUpdateId !== undefined) {
    sourceState.telegramLastUpdateId = lastUpdateId;
    sourceState.lastIngestAt = new Date().toISOString();
    syncLegacyStateMirrors(state, config);
    logImpl(`INFO: Dropped ${updates.length} pending Telegram update(s) on startup`);
  }

  writeDaemonStateImpl(state);
  return true;
}

async function pollTelegram(
  config: ReplyListenerDaemonConfig,
  state: ReplyListenerState,
  rateLimiter: ReplyListenerRateLimiter,
): Promise<void> {
  return pollTelegramOnce(config, state, rateLimiter);
}

export async function pollTelegramOnce(
  config: ReplyListenerDaemonConfig,
  state: ReplyListenerState,
  rateLimiter: ReplyListenerRateLimiter,
  deps: ReplyListenerPollDeps = {},
): Promise<void> {
  if (config.telegramEnabled === false) return;
  if (!config.telegramBotToken || !config.telegramChatId) return;

  const source = getTelegramReplySource(config);
  if (!source) return;
  const sourceState = ensureSourceState(state, source);

  const httpsRequestImpl = deps.httpsRequestImpl ?? httpsRequest;
  const injectReplyImpl = deps.injectReplyImpl ?? injectReply;
  const captureReplyAcknowledgementSummaryImpl = deps.captureReplyAcknowledgementSummaryImpl ?? captureReplyAcknowledgementSummary;
  const formatReplyAcknowledgementImpl = deps.formatReplyAcknowledgementImpl ?? formatReplyAcknowledgement;
  const lookupByMessageIdImpl = deps.lookupByMessageIdImpl ?? lookupBySourceMessage;
  const writeDaemonStateImpl = deps.writeDaemonStateImpl ?? writeDaemonState;
  const logImpl = deps.logImpl ?? log;

  try {
    if (await applyTelegramStartupBacklogPolicy(
      config,
      state,
      source,
      httpsRequestImpl,
      writeDaemonStateImpl,
      logImpl,
    )) {
      return;
    }

    const updates = await requestTelegramUpdates(config, sourceState, httpsRequestImpl);
    sourceState.lastPollAt = new Date().toISOString();

    for (const update of updates) {
      const updateId = typeof update.update_id === 'number' ? update.update_id : null;
      if (updateId === null) {
        continue;
      }
      const msg = update.message;
      if (!msg) {
        commitTelegramCursor(state, config, source, updateId, writeDaemonStateImpl);
        continue;
      }

      if (!msg.reply_to_message?.message_id) {
        commitTelegramCursor(state, config, source, updateId, writeDaemonStateImpl);
        continue;
      }

      if (String(msg.chat?.id) !== config.telegramChatId) {
        commitTelegramCursor(state, config, source, updateId, writeDaemonStateImpl);
        continue;
      }

      const senderId = msg.from?.id !== undefined ? String(msg.from.id) : null;
      if (
        config.authorizedTelegramUserIds.length > 0
        && (!senderId || !config.authorizedTelegramUserIds.includes(senderId))
      ) {
        commitTelegramCursor(state, config, source, updateId, writeDaemonStateImpl);
        continue;
      }

      const mapping = lookupByMessageIdImpl('telegram', String(msg.reply_to_message.message_id), source.key);
      if (!mapping) {
        commitTelegramCursor(state, config, source, updateId, writeDaemonStateImpl);
        continue;
      }

      const text = msg.text || '';
      if (!text) {
        commitTelegramCursor(state, config, source, updateId, writeDaemonStateImpl);
        continue;
      }

      if (!rateLimiter.canProceed()) {
        logImpl(`WARN: Rate limit exceeded, deferring Telegram message ${msg.message_id}`);
        state.errors++;
        break;
      }

      const injectionResult = normalizeInjectReplyResult(
        injectReplyImpl(mapping.tmuxPaneId, text, 'telegram', config),
      );
      if (injectionResult.outcome === 'success') {
        state.messagesInjected++;
        commitTelegramCursor(state, config, source, updateId, writeDaemonStateImpl);

        const acknowledgement = buildReplyAcknowledgement(
          mapping.tmuxPaneId,
          config,
          captureReplyAcknowledgementSummaryImpl,
          formatReplyAcknowledgementImpl,
        );
        if (acknowledgement !== null) {
          try {
            await sendTelegramReplyMessage(config, httpsRequestImpl, {
              chat_id: config.telegramChatId,
              text: acknowledgement,
              reply_to_message_id: msg.message_id,
            });
          } catch (e) {
            logImpl(`WARN: Failed to send confirmation reply: ${e}`);
          }
        }
      } else if (injectionResult.outcome === 'terminal-ignore') {
        commitTelegramCursor(state, config, source, updateId, writeDaemonStateImpl);
      } else {
        state.errors++;
        logImpl(`WARN: Deferring Telegram update ${updateId} after retryable intake failure${injectionResult.reason ? `: ${injectionResult.reason}` : ''}`);
        break;
      }
    }
  } catch (error) {
    state.errors++;
    state.lastError = error instanceof Error ? error.message : String(error);
    logImpl(`Telegram polling error: ${state.lastError}`);
  }
}

// ============================================================================
// Main Daemon Loop
// ============================================================================

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

async function pollLoop(): Promise<void> {
  log('Reply listener daemon starting poll loop');

  const initialConfig = readDaemonConfig();
  if (!initialConfig) {
    log('ERROR: No daemon config found, exiting');
    process.exit(1);
  }
  let config = normalizeReplyListenerConfig(initialConfig);

  const state = readDaemonState() || normalizeReplyListenerState({
    isRunning: true,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });

  state.isRunning = true;
  state.pid = process.pid;

  let rateLimiter: ReplyListenerRateLimiter = new RateLimiter(config.rateLimitPerMinute);
  let sourceRateLimiters = reconcileSourceRateLimiters(config, new Map());
  let lastPruneAt = Date.now();

  const shutdown = () => {
    log('Shutdown signal received');
    state.isRunning = false;
    writeDaemonState(state);
    removePidFile();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  try {
    pruneStale();
    log('Pruned stale registry entries');
  } catch (e) {
    log(`WARN: Failed to prune stale entries: ${e}`);
  }

  while (state.isRunning) {
    try {
      const previousConfig = config;
      const refreshedRuntime = refreshReplyListenerRuntimeConfig(config, rateLimiter);
      config = refreshedRuntime.config;
      rateLimiter = refreshedRuntime.rateLimiter;
      sourceRateLimiters = reconcileSourceRateLimiters(config, sourceRateLimiters, previousConfig);
      const reconciledState = reconcileReplyListenerStateWithConfigChange(
        previousConfig,
        config,
        state,
      );
      state.telegramLastUpdateId = reconciledState.telegramLastUpdateId;
      state.discordLastMessageId = reconciledState.discordLastMessageId;
      state.telegramStartupPolicyApplied = reconciledState.telegramStartupPolicyApplied;
      state.sourceStates = reconciledState.sourceStates;
      if (refreshedRuntime.shouldStopDaemon) {
        log('Reply listener config disabled all reply platforms; shutting down daemon');
        state.isRunning = false;
        writeDaemonState(state);
        removePidFile();
        break;
      }
      state.lastPollAt = new Date().toISOString();
      syncLegacyStateMirrors(state, config);

      const discordSource = getDiscordReplySource(config);
      if (discordSource) {
        const discordRateLimiter = sourceRateLimiters.get(discordSource.key) ?? new RateLimiter(config.rateLimitPerMinute);
        sourceRateLimiters.set(discordSource.key, discordRateLimiter);
        await pollDiscord(config, state, discordRateLimiter);
      }

      const telegramSource = getTelegramReplySource(config);
      if (telegramSource) {
        const telegramRateLimiter = sourceRateLimiters.get(telegramSource.key) ?? new RateLimiter(config.rateLimitPerMinute);
        sourceRateLimiters.set(telegramSource.key, telegramRateLimiter);
        await pollTelegram(config, state, telegramRateLimiter);
      }

      if (Date.now() - lastPruneAt > PRUNE_INTERVAL_MS) {
        try {
          pruneStale();
          lastPruneAt = Date.now();
          log('Pruned stale registry entries');
        } catch (e) {
          log(`WARN: Prune failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      writeDaemonState(state);
      await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
    } catch (error) {
      state.errors++;
      state.lastError = error instanceof Error ? error.message : String(error);
      log(`Poll error: ${state.lastError}`);
      writeDaemonState(state);
      await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs * 2));
    }
  }

  log('Poll loop ended');
}

// ============================================================================
// Daemon Control
// ============================================================================

interface StartReplyListenerDeps {
  ensureStateDirImpl?: typeof ensureStateDir;
  isDaemonRunningImpl?: typeof isDaemonRunning;
  isTmuxAvailableImpl?: typeof isTmuxAvailable;
  readDaemonConfigImpl?: typeof readDaemonConfig;
  readDaemonStateImpl?: typeof readDaemonState;
  spawnImpl?: typeof spawn;
  writeDaemonConfigImpl?: typeof writeDaemonConfig;
  writeDaemonStateImpl?: typeof writeDaemonState;
  writePidFileImpl?: typeof writePidFile;
  logImpl?: typeof log;
}

export function startReplyListener(
  config: ReplyListenerDaemonConfig,
  deps: StartReplyListenerDeps = {},
): DaemonResponse {
  const ensureStateDirImpl = deps.ensureStateDirImpl ?? ensureStateDir;
  const isDaemonRunningImpl = deps.isDaemonRunningImpl ?? isDaemonRunning;
  const isTmuxAvailableImpl = deps.isTmuxAvailableImpl ?? isTmuxAvailable;
  const readDaemonConfigImpl = deps.readDaemonConfigImpl ?? readDaemonConfig;
  const readDaemonStateImpl = deps.readDaemonStateImpl ?? readDaemonState;
  const spawnImpl = deps.spawnImpl ?? spawn;
  const writeDaemonConfigImpl = deps.writeDaemonConfigImpl ?? writeDaemonConfig;
  const writeDaemonStateImpl = deps.writeDaemonStateImpl ?? writeDaemonState;
  const writePidFileImpl = deps.writePidFileImpl ?? writePidFile;
  const logImpl = deps.logImpl ?? log;

  const normalizedConfig = normalizeReplyListenerConfig(config);
  if (!normalizedConfig.discordEnabled && !normalizedConfig.telegramEnabled) {
    return {
      success: false,
      message: 'No enabled reply listener platforms configured',
    };
  }

  if (isDaemonRunningImpl()) {
    const previousConfig = normalizeReplyListenerConfig(
      readDaemonConfigImpl() ?? normalizedConfig,
    );
    const state = readDaemonStateImpl();
    const refreshedState = state
      ? reconcileReplyListenerStateWithConfigChange(
          previousConfig,
          normalizedConfig,
          state,
        )
      : null;
    ensureStateDirImpl();
    writeDaemonConfigImpl(normalizedConfig);
    if (refreshedState) {
      writeDaemonStateImpl(refreshedState);
    }
    return {
      success: true,
      message: 'Reply listener daemon is already running (config refreshed)',
      state: refreshedState ?? state ?? undefined,
    };
  }

  if (!isTmuxAvailableImpl()) {
    return {
      success: false,
      message: 'tmux not available - reply injection requires tmux',
    };
  }

  writeDaemonConfigImpl(normalizedConfig);
  ensureStateDirImpl();

  const modulePath = __filename.replace(/\.ts$/, '.js');
  const daemonScript = `
    import('${modulePath}').then(({ pollLoop }) => {
      return pollLoop();
    }).catch((err) => { console.error(err); process.exit(1); });
  `;

  try {
    const child = spawnImpl('node', ['-e', daemonScript], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: process.cwd(),
      env: createMinimalDaemonEnv(),
    });

    child.unref();

    const pid = child.pid;
    if (pid) {
      writePidFileImpl(pid);

      const state: ReplyListenerState = {
        ...normalizeReplyListenerState({
          isRunning: true,
          pid,
          startedAt: new Date().toISOString(),
        }),
      };
      writeDaemonStateImpl(state);
      logImpl(`Reply listener daemon started with PID ${pid}`);

      return {
        success: true,
        message: `Reply listener daemon started with PID ${pid}`,
        state,
      };
    }

    return {
      success: false,
      message: 'Failed to start daemon process',
    };
  } catch (error) {
    return {
      success: false,
      message: 'Failed to start daemon',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function stopReplyListener(): DaemonResponse {
  const pid = readPidFile();

  if (pid === null) {
    return {
      success: true,
      message: 'Reply listener daemon is not running',
    };
  }

  if (!isProcessRunning(pid)) {
    removePidFile();
    return {
      success: true,
      message: 'Reply listener daemon was not running (cleaned up stale PID file)',
    };
  }

  if (!isReplyListenerProcess(pid)) {
    removePidFile();
    return {
      success: false,
      message: `Refusing to kill PID ${pid}: process identity does not match the reply listener daemon (stale or reused PID - removed PID file)`,
    };
  }

  try {
    process.kill(pid, 'SIGTERM');
    removePidFile();

    const state = readDaemonState();
    if (state) {
      state.isRunning = false;
      state.pid = null;
      writeDaemonState(state);
    }

    log(`Reply listener daemon stopped (PID ${pid})`);

    return {
      success: true,
      message: `Reply listener daemon stopped (PID ${pid})`,
      state: state ?? undefined,
    };
  } catch (error) {
    return {
      success: false,
      message: 'Failed to stop daemon',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function getReplyListenerStatus(): DaemonResponse {
  const state = readDaemonState();
  const running = isDaemonRunning();

  if (!running && !state) {
    return {
      success: true,
      message: 'Reply listener daemon has never been started',
    };
  }

  if (!running && state) {
    return {
      success: true,
      message: 'Reply listener daemon is not running',
      state: { ...state, isRunning: false, pid: null },
    };
  }

  return {
    success: true,
    message: 'Reply listener daemon is running',
    state: state ?? undefined,
  };
}

export { pollLoop };
