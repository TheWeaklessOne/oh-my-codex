import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TELEGRAM_MESSAGE_MAX_LENGTH } from "./telegram-entities.js";
import type {
  TelegramInlineKeyboardMarkup,
  TelegramMessageEntity,
  TelegramProgressConfig,
  TelegramProgressFullTraceDelivery,
  TelegramProgressMode,
  TelegramProgressTransport,
} from "./types.js";

export const TELEGRAM_PROGRESS_CALLBACK_PREFIX = "omx:pg:";
export const TELEGRAM_PROGRESS_SHOW_BUTTON_TEXT = "Показать ход";
export const TELEGRAM_PROGRESS_HIDE_BUTTON_TEXT = "Скрыть ход";
export const TELEGRAM_PROGRESS_SEPARATOR = "─────";
export const TELEGRAM_PROGRESS_DEFAULT_MIN_UPDATE_INTERVAL_MS = 1_000;
export const TELEGRAM_PROGRESS_MIN_UPDATE_INTERVAL_MS = 800;
export const TELEGRAM_PROGRESS_DEFAULT_MAX_DRAFT_CHARS = 3_900;
export const TELEGRAM_PROGRESS_DEFAULT_MAX_STORED_ENTRIES = 200;
export const TELEGRAM_PROGRESS_MAX_STORED_ENTRIES = 1_000;
const DEFAULT_MAX_ENTRY_CHARS = 1_200;
const DEFAULT_MAX_TOTAL_CHARS = 200_000;
const SAFE_SEGMENT_FALLBACK = "unknown";

export type ProgressTraceEntryKind =
  | "commentary"
  | "tool-start"
  | "tool-finish"
  | "task-start"
  | "task-complete";

export interface ProgressTraceEntry {
  id?: string;
  kind: ProgressTraceEntryKind;
  text: string;
  timestamp?: string;
  toolName?: string;
  status?: string;
}

export interface TelegramProgressTraceState {
  version: 1;
  sessionId: string;
  turnId: string;
  entries: ProgressTraceEntry[];
  createdAt: string;
  updatedAt: string;
  lastDraftText?: string;
  lastDraftAt?: string;
  draftFailureUntil?: string;
}

export interface TelegramProgressFinalState {
  version: 1;
  token: string;
  projectPath: string;
  sessionId: string;
  turnId: string;
  chatId: string;
  messageId: string;
  messageThreadId?: string;
  finalText: string;
  finalEntities?: TelegramMessageEntity[];
  finalParseMode?: "Markdown" | "HTML" | null;
  fullTraceDelivery?: TelegramProgressFullTraceDelivery;
  shown: boolean;
  createdAt: string;
  updatedAt: string;
  fallbackSentAt?: string;
}

export interface AppendTelegramProgressEntryOptions {
  maxEntries?: number;
  maxEntryChars?: number;
  maxTotalChars?: number;
  now?: Date;
}

export interface TelegramProgressDraftRenderOptions {
  maxChars?: number;
  now?: Date;
  title?: string;
}

export interface TelegramCollapsedTraceRenderOptions {
  maxChars?: number;
  traceTitle?: string;
}

export interface TelegramCollapsedTraceRenderResult {
  fits: boolean;
  text: string;
  entities: TelegramMessageEntity[];
  traceText: string;
}

export function clampTelegramProgressInteger(
  value: unknown,
  fallback: number,
  min: number,
  max?: number,
): number {
  const parsed = typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : typeof value === "string" && value.trim() !== ""
      ? Number.parseInt(value.trim(), 10)
      : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) return min;
  if (max !== undefined && parsed > max) return max;
  return parsed;
}

function parseTelegramProgressBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function parseTelegramProgressMode(value: unknown, fallback: TelegramProgressMode): TelegramProgressMode {
  return value === "off" || value === "peek" || value === "archive" ? value : fallback;
}

function parseTelegramProgressTransport(
  value: unknown,
  fallback: TelegramProgressTransport,
): TelegramProgressTransport {
  return value === "draft" || value === "none" ? value : fallback;
}

function parseTelegramProgressFullTraceDelivery(
  value: unknown,
  fallback: TelegramProgressFullTraceDelivery,
): TelegramProgressFullTraceDelivery {
  return value === "message" || value === "document" || value === "none" ? value : fallback;
}

export function normalizeTelegramProgressConfig(value: unknown): TelegramProgressConfig {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const rawEnabled = parseTelegramProgressBoolean(raw.enabled);
  const modeProvided = raw.mode !== undefined;
  const requestedMode = parseTelegramProgressMode(raw.mode, rawEnabled === true ? "peek" : "off");
  const enabled = requestedMode === "off"
    ? false
    : rawEnabled ?? modeProvided;
  const mode = enabled ? requestedMode : "off";
  const transport = parseTelegramProgressTransport(raw.transport, enabled ? "draft" : "none");

  return {
    enabled: enabled && mode !== "off",
    mode,
    transport: enabled && mode !== "off" ? transport : "none",
    minUpdateIntervalMs: clampTelegramProgressInteger(
      raw.minUpdateIntervalMs,
      TELEGRAM_PROGRESS_DEFAULT_MIN_UPDATE_INTERVAL_MS,
      TELEGRAM_PROGRESS_MIN_UPDATE_INTERVAL_MS,
    ),
    maxDraftChars: clampTelegramProgressInteger(
      raw.maxDraftChars,
      TELEGRAM_PROGRESS_DEFAULT_MAX_DRAFT_CHARS,
      1,
      TELEGRAM_MESSAGE_MAX_LENGTH,
    ),
    maxStoredEntries: clampTelegramProgressInteger(
      raw.maxStoredEntries,
      TELEGRAM_PROGRESS_DEFAULT_MAX_STORED_ENTRIES,
      1,
      TELEGRAM_PROGRESS_MAX_STORED_ENTRIES,
    ),
    showButton: parseTelegramProgressBoolean(raw.showButton) ?? true,
    fullTraceDelivery: parseTelegramProgressFullTraceDelivery(raw.fullTraceDelivery, "message"),
  };
}

export function isTelegramProgressUxEnabled(config: TelegramProgressConfig | undefined): boolean {
  return Boolean(config?.enabled && config.mode !== "off");
}

export function isTelegramProgressButtonEnabled(config: TelegramProgressConfig | undefined): boolean {
  return isTelegramProgressUxEnabled(config) && config?.showButton !== false;
}

export function isTelegramProgressDraftEnabled(config: TelegramProgressConfig | undefined): boolean {
  return isTelegramProgressUxEnabled(config) && config?.transport === "draft";
}

function safePathSegment(value: string | undefined): string {
  const normalized = (value ?? "").trim().replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
  return normalized || SAFE_SEGMENT_FALLBACK;
}

export function getTelegramProgressDir(projectPath: string, sessionId: string): string {
  return join(projectPath, ".omx", "state", "sessions", safePathSegment(sessionId), "telegram-progress");
}

export function getTelegramProgressTracePath(
  projectPath: string,
  sessionId: string,
  turnId: string,
): string {
  return join(getTelegramProgressDir(projectPath, sessionId), `${safePathSegment(turnId)}.json`);
}

export function getTelegramProgressCallbackPath(
  projectPath: string,
  sessionId: string,
  token: string,
): string {
  return join(getTelegramProgressDir(projectPath, sessionId), "callbacks", `${safePathSegment(token)}.json`);
}

function nowIso(now: Date | undefined): string {
  return (now ?? new Date()).toISOString();
}

function normalizeTraceState(
  value: unknown,
  sessionId: string,
  turnId: string,
  now: string,
): TelegramProgressTraceState {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<TelegramProgressTraceState>
    : {};
  const entries = Array.isArray(raw.entries)
    ? raw.entries
        .map((entry) => sanitizeProgressEntry(entry as ProgressTraceEntry))
        .filter((entry): entry is ProgressTraceEntry => entry !== null)
    : [];
  return {
    version: 1,
    sessionId: typeof raw.sessionId === "string" && raw.sessionId ? raw.sessionId : sessionId,
    turnId: typeof raw.turnId === "string" && raw.turnId ? raw.turnId : turnId,
    entries,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : now,
    ...(typeof raw.lastDraftText === "string" ? { lastDraftText: raw.lastDraftText } : {}),
    ...(typeof raw.lastDraftAt === "string" ? { lastDraftAt: raw.lastDraftAt } : {}),
    ...(typeof raw.draftFailureUntil === "string" ? { draftFailureUntil: raw.draftFailureUntil } : {}),
  };
}

export async function loadTelegramProgressTrace(
  projectPath: string,
  sessionId: string,
  turnId: string,
): Promise<TelegramProgressTraceState | null> {
  const path = getTelegramProgressTracePath(projectPath, sessionId, turnId);
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as unknown;
    return normalizeTraceState(parsed, sessionId, turnId, new Date().toISOString());
  } catch {
    return null;
  }
}

export async function writeTelegramProgressTrace(
  projectPath: string,
  state: TelegramProgressTraceState,
): Promise<void> {
  const path = getTelegramProgressTracePath(projectPath, state.sessionId, state.turnId);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2), "utf-8");
}

function redactProgressText(text: string): string {
  return text
    .replace(/(["']?authorization["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:bearer|basic|token)\s+[^\s,;]+|[^\s,;]+)/gi, "$1[REDACTED]")
    .replace(/(["']?(?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi, "$1[REDACTED]")
    .replace(/(?:sk-(?:proj-|live-|test-)?|ghp_|gho_|ghs_|ghu_|github_pat_|xox[bpsar]-|glpat-|AKIA[A-Z0-9])\S+/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]");
}

export function sanitizeProgressText(value: unknown, maxChars = DEFAULT_MAX_ENTRY_CHARS): string {
  if (typeof value !== "string") return "";
  const trimmed = value.replace(/\r\n/g, "\n").trim();
  if (!trimmed) return "";
  if (/encrypted_content|response_item\.reasoning|"type"\s*:\s*"reasoning"|\bchain[- ]of[- ]thought\b/i.test(trimmed)) {
    return "";
  }
  const collapsed = redactProgressText(trimmed).replace(/\n{3,}/g, "\n\n");
  return ellipsizeMiddleByUtf16(collapsed, maxChars);
}

export function sanitizeProgressEntry(
  entry: Partial<ProgressTraceEntry> | null | undefined,
  maxChars = DEFAULT_MAX_ENTRY_CHARS,
): ProgressTraceEntry | null {
  if (!entry) return null;
  const kind = entry.kind;
  if (
    kind !== "commentary"
    && kind !== "tool-start"
    && kind !== "tool-finish"
    && kind !== "task-start"
    && kind !== "task-complete"
  ) {
    return null;
  }
  const text = sanitizeProgressText(entry.text, maxChars);
  if (!text) return null;
  const toolName = sanitizeProgressText(entry.toolName, 80).replace(/\s+/g, " ");
  const status = sanitizeProgressText(entry.status, 80).replace(/\s+/g, " ");
  return {
    ...(typeof entry.id === "string" && entry.id ? { id: entry.id } : {}),
    kind,
    text,
    ...(typeof entry.timestamp === "string" && entry.timestamp ? { timestamp: entry.timestamp } : {}),
    ...(toolName ? { toolName } : {}),
    ...(status ? { status } : {}),
  };
}

function entriesEqual(left: ProgressTraceEntry | undefined, right: ProgressTraceEntry): boolean {
  return Boolean(
    left
    && left.kind === right.kind
    && left.text === right.text
    && (left.toolName ?? "") === (right.toolName ?? "")
    && (left.status ?? "") === (right.status ?? ""),
  );
}

function trimTraceState(
  state: TelegramProgressTraceState,
  options: Required<Pick<AppendTelegramProgressEntryOptions, "maxEntries" | "maxTotalChars">>,
): TelegramProgressTraceState {
  let entries = state.entries.slice(-options.maxEntries);
  let total = entries.reduce((sum, entry) => sum + entry.text.length, 0);
  while (entries.length > 1 && total > options.maxTotalChars) {
    const [removed, ...rest] = entries;
    total -= removed?.text.length ?? 0;
    entries = rest;
  }
  return { ...state, entries };
}

export async function appendTelegramProgressEntry(
  projectPath: string,
  sessionId: string,
  turnId: string,
  entry: Partial<ProgressTraceEntry>,
  options: AppendTelegramProgressEntryOptions = {},
): Promise<{ appended: boolean; state: TelegramProgressTraceState }> {
  const timestamp = nowIso(options.now);
  const sanitized = sanitizeProgressEntry(
    {
      ...entry,
      timestamp: entry.timestamp ?? timestamp,
    },
    options.maxEntryChars ?? DEFAULT_MAX_ENTRY_CHARS,
  );
  const existing = await loadTelegramProgressTrace(projectPath, sessionId, turnId);
  const state = existing ?? {
    version: 1 as const,
    sessionId,
    turnId,
    entries: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  if (!sanitized || entriesEqual(state.entries.at(-1), sanitized)) {
    return { appended: false, state };
  }

  const next = trimTraceState(
    {
      ...state,
      entries: [...state.entries, sanitized],
      updatedAt: timestamp,
    },
    {
      maxEntries: options.maxEntries ?? TELEGRAM_PROGRESS_DEFAULT_MAX_STORED_ENTRIES,
      maxTotalChars: options.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS,
    },
  );
  await writeTelegramProgressTrace(projectPath, next);
  return { appended: true, state: next };
}

export function ellipsizeMiddleByUtf16(text: string, budget: number): string {
  const normalizedBudget = Math.max(0, Math.trunc(budget));
  if (text.length <= normalizedBudget) return text;
  if (normalizedBudget === 0) return "";
  if (normalizedBudget === 1) return "…";

  const omitted = text.length - normalizedBudget;
  const marker = `… [обрезано ${omitted} символов] …`;
  if (marker.length >= normalizedBudget) {
    const keep = Math.max(1, normalizedBudget - 1);
    return `${text.slice(0, keep)}…`.slice(0, normalizedBudget);
  }

  const remaining = normalizedBudget - marker.length;
  const head = Math.ceil(remaining / 2);
  const tail = Math.floor(remaining / 2);
  return `${text.slice(0, head)}${marker}${text.slice(text.length - tail)}`;
}

function progressEntryIcon(kind: ProgressTraceEntryKind): string {
  switch (kind) {
    case "tool-start":
      return "🔧";
    case "tool-finish":
      return "✅";
    case "task-start":
      return "▶️";
    case "task-complete":
      return "🏁";
    case "commentary":
      return "•";
  }
}

export function formatProgressEntry(entry: ProgressTraceEntry): string {
  const prefix = progressEntryIcon(entry.kind);
  const tool = entry.toolName ? `${entry.toolName}: ` : "";
  const status = entry.status ? ` (${entry.status})` : "";
  return `${prefix} ${tool}${entry.text}${status}`;
}

function pluralSteps(count: number): string {
  return `${count} ${count === 1 ? "шаг" : count >= 2 && count <= 4 ? "шага" : "шагов"}`;
}

function composeDraftText(
  totalEntries: number,
  currentText: string,
  visibleLines: readonly string[],
  hiddenCount: number,
  title: string,
): string {
  const parts = [
    `🧠 ${title} · ${pluralSteps(totalEntries)}`,
    "",
    "Сейчас:",
    currentText || "Обновляю ход выполнения…",
    "",
    "Ход:",
    ...visibleLines,
  ];
  if (hiddenCount > 0) {
    parts.push(`… ещё ${pluralSteps(hiddenCount)} скрыто`);
  }
  return parts.join("\n").trim();
}

export function renderTelegramProgressDraft(
  trace: Pick<TelegramProgressTraceState, "entries">,
  options: TelegramProgressDraftRenderOptions = {},
): string {
  const maxChars = Math.max(1, Math.min(options.maxChars ?? TELEGRAM_PROGRESS_DEFAULT_MAX_DRAFT_CHARS, TELEGRAM_MESSAGE_MAX_LENGTH));
  const entries = trace.entries.filter((entry) => sanitizeProgressEntry(entry) !== null);
  if (entries.length === 0) return "";

  const title = options.title ?? "Codex работает";
  const current = ellipsizeMiddleByUtf16(formatProgressEntry(entries.at(-1)!), Math.max(32, Math.floor(maxChars / 4)));
  const allLines = entries.map((entry, index) => `${index + 1}. ${formatProgressEntry(entry)}`);
  const visible: string[] = [];
  let hiddenCount = allLines.length;

  for (let index = allLines.length - 1; index >= 0; index -= 1) {
    const line = allLines[index]!;
    const candidateVisible = [line, ...visible];
    const candidateHidden = index;
    const candidate = composeDraftText(entries.length, current, candidateVisible, candidateHidden, title);
    if (candidate.length <= maxChars) {
      visible.unshift(line);
      hiddenCount = candidateHidden;
      continue;
    }

    if (visible.length === 0) {
      const withoutLine = composeDraftText(entries.length, current, [], allLines.length, title);
      const available = Math.max(1, maxChars - withoutLine.length - 1);
      const shortened = ellipsizeMiddleByUtf16(line, available);
      const shortenedCandidate = composeDraftText(entries.length, current, [shortened], index, title);
      if (shortenedCandidate.length <= maxChars) {
        visible.unshift(shortened);
        hiddenCount = index;
      }
    }
    break;
  }

  let rendered = composeDraftText(entries.length, current, visible, hiddenCount, title);
  if (rendered.length > maxChars) {
    rendered = ellipsizeMiddleByUtf16(rendered, maxChars);
  }
  return rendered;
}

function buildTraceLines(entries: readonly ProgressTraceEntry[]): string[] {
  return entries.map((entry, index) => `${index + 1}. ${formatProgressEntry(entry)}`);
}

function renderTraceTextForBudget(
  entries: readonly ProgressTraceEntry[],
  budget: number,
  title: string,
): string {
  const maxChars = Math.max(1, budget);
  const lines = buildTraceLines(entries);
  if (lines.length === 0) return title.slice(0, maxChars);
  const visible: string[] = [];
  let hiddenCount = lines.length;
  const compose = () => [
    title,
    ...visible,
    ...(hiddenCount > 0 ? [`… ещё ${pluralSteps(hiddenCount)} скрыто`] : []),
  ].join("\n");

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    visible.unshift(line);
    hiddenCount = index;
    if (compose().length <= maxChars) continue;
    visible.shift();
    hiddenCount = index + 1;
    if (visible.length === 0) {
      const base = [title, `… ещё ${pluralSteps(index)} скрыто`].join("\n");
      const available = Math.max(1, maxChars - base.length - 1);
      visible.unshift(ellipsizeMiddleByUtf16(line, available));
      hiddenCount = index;
    }
    break;
  }

  const rendered = compose();
  return rendered.length <= maxChars ? rendered : ellipsizeMiddleByUtf16(rendered, maxChars);
}

export function renderTraceFallbackMessage(
  trace: Pick<TelegramProgressTraceState, "entries">,
  options: TelegramCollapsedTraceRenderOptions = {},
): string {
  const maxChars = Math.max(1, Math.min(options.maxChars ?? TELEGRAM_MESSAGE_MAX_LENGTH, TELEGRAM_MESSAGE_MAX_LENGTH));
  return renderTraceTextForBudget(trace.entries, maxChars, options.traceTitle ?? "Ход выполнения");
}

function shiftEntities(
  entities: readonly TelegramMessageEntity[] | undefined,
  offset: number,
): TelegramMessageEntity[] {
  return (entities ?? []).map((entity) => ({
    ...entity,
    offset: entity.offset + offset,
  }));
}

export function renderCollapsedTrace(
  trace: Pick<TelegramProgressTraceState, "entries">,
  finalText: string,
  options: TelegramCollapsedTraceRenderOptions & {
    finalEntities?: readonly TelegramMessageEntity[];
  } = {},
): TelegramCollapsedTraceRenderResult {
  const maxChars = Math.max(1, Math.min(options.maxChars ?? TELEGRAM_MESSAGE_MAX_LENGTH, TELEGRAM_MESSAGE_MAX_LENGTH));
  const separator = `\n\n${TELEGRAM_PROGRESS_SEPARATOR}\n\n`;
  const title = options.traceTitle ?? "Ход выполнения";
  const finalBudget = maxChars - separator.length - finalText.length;
  if (finalBudget < Math.max(8, title.length)) {
    return {
      fits: false,
      text: finalText.slice(0, maxChars),
      entities: shiftEntities(options.finalEntities, 0),
      traceText: "",
    };
  }

  const traceText = renderTraceTextForBudget(trace.entries, finalBudget, title);
  const text = `${traceText}${separator}${finalText}`;
  if (text.length > maxChars) {
    return {
      fits: false,
      text: finalText.slice(0, maxChars),
      entities: shiftEntities(options.finalEntities, 0),
      traceText,
    };
  }

  const finalOffset = traceText.length + separator.length;
  return {
    fits: true,
    text,
    entities: [
      { type: "expandable_blockquote", offset: 0, length: traceText.length },
      ...shiftEntities(options.finalEntities, finalOffset),
    ],
    traceText,
  };
}

export function createTelegramProgressToken(): string {
  return randomBytes(8).toString("hex");
}

export function buildTelegramProgressCallbackData(token: string): string {
  return `${TELEGRAM_PROGRESS_CALLBACK_PREFIX}${token}`.slice(0, 64);
}

export function parseTelegramProgressCallbackToken(data: string | undefined): string | null {
  if (!data?.startsWith(TELEGRAM_PROGRESS_CALLBACK_PREFIX)) return null;
  const token = data.slice(TELEGRAM_PROGRESS_CALLBACK_PREFIX.length).trim();
  return /^[A-Za-z0-9_.-]{1,48}$/.test(token) ? token : null;
}

export function buildTelegramProgressToggleMarkup(token: string, shown: boolean): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      {
        text: shown ? TELEGRAM_PROGRESS_HIDE_BUTTON_TEXT : TELEGRAM_PROGRESS_SHOW_BUTTON_TEXT,
        callback_data: buildTelegramProgressCallbackData(token),
      },
    ]],
  };
}

function normalizeFinalState(value: unknown): TelegramProgressFinalState | null {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<TelegramProgressFinalState>
    : null;
  if (!raw || typeof raw.token !== "string" || typeof raw.projectPath !== "string") return null;
  if (typeof raw.sessionId !== "string" || typeof raw.turnId !== "string") return null;
  if (typeof raw.chatId !== "string" || typeof raw.messageId !== "string") return null;
  if (typeof raw.finalText !== "string") return null;
  const entities = Array.isArray(raw.finalEntities)
    ? raw.finalEntities.filter((entity): entity is TelegramMessageEntity => (
        entity
        && typeof entity === "object"
        && typeof (entity as TelegramMessageEntity).type === "string"
        && typeof (entity as TelegramMessageEntity).offset === "number"
        && typeof (entity as TelegramMessageEntity).length === "number"
      ))
    : undefined;
  return {
    version: 1,
    token: raw.token,
    projectPath: raw.projectPath,
    sessionId: raw.sessionId,
    turnId: raw.turnId,
    chatId: raw.chatId,
    messageId: raw.messageId,
    ...(typeof raw.messageThreadId === "string" ? { messageThreadId: raw.messageThreadId } : {}),
    finalText: raw.finalText,
    ...(entities && entities.length > 0 ? { finalEntities: entities } : {}),
    ...(raw.finalParseMode === "Markdown" || raw.finalParseMode === "HTML" || raw.finalParseMode === null
      ? { finalParseMode: raw.finalParseMode }
      : {}),
    ...(raw.fullTraceDelivery === "message" || raw.fullTraceDelivery === "document" || raw.fullTraceDelivery === "none"
      ? { fullTraceDelivery: raw.fullTraceDelivery }
      : {}),
    shown: raw.shown === true,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
    ...(typeof raw.fallbackSentAt === "string" ? { fallbackSentAt: raw.fallbackSentAt } : {}),
  };
}

export async function registerTelegramProgressFinalMessage(
  state: Omit<TelegramProgressFinalState, "version" | "shown" | "createdAt" | "updatedAt"> & {
    shown?: boolean;
    createdAt?: string;
  },
): Promise<TelegramProgressFinalState> {
  const timestamp = state.createdAt ?? new Date().toISOString();
  const next: TelegramProgressFinalState = {
    version: 1,
    token: state.token,
    projectPath: state.projectPath,
    sessionId: state.sessionId,
    turnId: state.turnId,
    chatId: state.chatId,
    messageId: state.messageId,
    ...(state.messageThreadId ? { messageThreadId: state.messageThreadId } : {}),
    finalText: state.finalText,
    ...(state.finalEntities?.length ? { finalEntities: [...state.finalEntities] } : {}),
    ...(Object.prototype.hasOwnProperty.call(state, "finalParseMode") ? { finalParseMode: state.finalParseMode } : {}),
    ...(state.fullTraceDelivery ? { fullTraceDelivery: state.fullTraceDelivery } : {}),
    shown: state.shown === true,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...(state.fallbackSentAt ? { fallbackSentAt: state.fallbackSentAt } : {}),
  };
  const path = getTelegramProgressCallbackPath(next.projectPath, next.sessionId, next.token);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(next, null, 2), "utf-8");
  return next;
}

export async function loadTelegramProgressFinalState(
  projectPath: string,
  sessionId: string,
  token: string,
): Promise<TelegramProgressFinalState | null> {
  try {
    const parsed = JSON.parse(await readFile(getTelegramProgressCallbackPath(projectPath, sessionId, token), "utf-8")) as unknown;
    return normalizeFinalState(parsed);
  } catch {
    return null;
  }
}

export async function updateTelegramProgressFinalState(
  state: TelegramProgressFinalState,
): Promise<void> {
  const next = {
    ...state,
    updatedAt: new Date().toISOString(),
  } satisfies TelegramProgressFinalState;
  const path = getTelegramProgressCallbackPath(next.projectPath, next.sessionId, next.token);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(next, null, 2), "utf-8");
}
