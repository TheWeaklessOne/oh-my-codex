import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, resolve, sep } from "node:path";
import type {
  RichContentFileSource,
  RichContentKind,
  RichContentPart,
  RichNotificationContent,
  TelegramRichRepliesConfig,
} from "./types.js";

const DELIVERY_MANIFEST_BLOCK_RE = /```\s*omx-delivery\s*\n?([\s\S]*?)```/gi;
const GENERATED_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const DEFAULT_MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export interface BuildCompletedTurnDeliveryEnvelopeInput {
  assistantText: string;
  projectPath?: string;
  threadId?: string;
  turnId?: string;
  sessionId?: string;
  transcriptPath?: string;
  env?: NodeJS.ProcessEnv;
  telegramRichRepliesConfig?: TelegramRichRepliesConfig | null;
}

export interface CompletedTurnDeliveryEnvelope extends RichNotificationContent {
  parts: RichContentPart[];
  visibleText: string;
  warnings: string[];
}

interface NormalizedLocalFile {
  path: string;
  size: number;
  extension: string;
}

interface ManifestExtractionResult {
  visibleText: string;
  rawManifests: string[];
  warnings: string[];
}

function safeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function unique(values: readonly string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function richRepliesEnabled(config: TelegramRichRepliesConfig | null | undefined): boolean {
  return config?.enabled !== false;
}

function autoDetectGeneratedImagesEnabled(config: TelegramRichRepliesConfig | null | undefined): boolean {
  return richRepliesEnabled(config) && config?.autoDetectGeneratedImages !== false;
}

function resolveMaxPhotoBytes(config: TelegramRichRepliesConfig | null | undefined): number {
  const configured = config?.maxPhotoBytes;
  return typeof configured === "number" && Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_MAX_PHOTO_BYTES;
}

function resolveMaxUploadBytes(config: TelegramRichRepliesConfig | null | undefined): number {
  const configured = config?.maxUploadBytes;
  return typeof configured === "number" && Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_MAX_UPLOAD_BYTES;
}

function isMediaKind(kind: string): kind is Exclude<RichContentKind, "text"> {
  return kind === "photo"
    || kind === "document"
    || kind === "audio"
    || kind === "voice"
    || kind === "sticker"
    || kind === "video"
    || kind === "animation"
    || kind === "video_note";
}

function extractDeliveryManifests(assistantText: string): ManifestExtractionResult {
  const rawManifests: string[] = [];
  const warnings: string[] = [];
  const visibleText = assistantText.replace(DELIVERY_MANIFEST_BLOCK_RE, (_match, rawManifest: string) => {
    const manifest = safeString(rawManifest);
    if (manifest) {
      rawManifests.push(manifest);
    } else {
      warnings.push("empty-delivery-manifest-dropped");
    }
    return "";
  }).trim();

  return { visibleText, rawManifests, warnings };
}

function parseManifestJson(rawManifest: string, warnings: string[]): unknown | null {
  try {
    return JSON.parse(rawManifest) as unknown;
  } catch {
    warnings.push("invalid-delivery-manifest-json");
    return null;
  }
}

function parseTranscriptJsonLine(line: string): unknown | null {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return null;
  }
}

function manifestParts(manifest: unknown): unknown[] {
  const raw = asRecord(manifest);
  if (!raw) return [];
  if (Array.isArray(raw.parts)) return raw.parts;
  if (safeString(raw.kind)) return [raw];
  return [];
}

function codexHomeRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = safeString(env.HOME) || homedir();
  return unique([
    safeString(env.CODEX_HOME),
    home ? join(home, ".codex") : "",
    join(homedir(), ".codex"),
  ]);
}

function generatedImageRoots(input: BuildCompletedTurnDeliveryEnvelopeInput): string[] {
  const ids = unique([
    safeString(input.threadId),
    safeString(input.sessionId),
  ]);
  const codexRoots = codexHomeRoots(input.env).flatMap((root) =>
    ids.map((id) => join(root, "generated_images", id))
  );
  const projectArtifactRoots = input.projectPath
    ? ids.map((id) => join(input.projectPath!, ".omx", "artifacts", id))
    : [];
  return unique([...codexRoots, ...projectArtifactRoots]);
}

function explicitArtifactRoots(input: BuildCompletedTurnDeliveryEnvelopeInput): string[] {
  const configured = input.telegramRichRepliesConfig?.allowedArtifactRoots ?? [];
  const configuredRoots = configured.map((entry) =>
    isAbsolute(entry)
      ? entry
      : input.projectPath
        ? join(input.projectPath, entry)
        : ""
  );
  return unique([
    ...generatedImageRoots(input),
    ...(input.projectPath ? [join(input.projectPath, ".omx", "artifacts")] : []),
    ...configuredRoots,
  ]);
}

async function isPathInsideRoot(path: string, root: string): Promise<boolean> {
  if (!path || !root || !existsSync(root)) return false;
  try {
    const [realFile, realRoot] = await Promise.all([
      realpath(path),
      realpath(root),
    ]);
    return realFile === realRoot || realFile.startsWith(`${realRoot}${sep}`);
  } catch {
    return false;
  }
}

async function normalizeTrustedLocalFile(
  path: string,
  roots: readonly string[],
  warnings: string[],
): Promise<NormalizedLocalFile | null> {
  const normalizedPath = resolve(path);
  const withinTrustedRoot = (await Promise.all(
    roots.map((root) => isPathInsideRoot(normalizedPath, root)),
  )).some(Boolean);
  if (!withinTrustedRoot) {
    warnings.push("local-path-outside-trusted-artifact-roots");
    return null;
  }

  const lst = await lstat(normalizedPath).catch(() => null);
  if (!lst || !lst.isFile() || lst.isSymbolicLink()) {
    warnings.push("local-path-not-regular-file");
    return null;
  }
  const st = await stat(normalizedPath).catch(() => null);
  if (!st?.isFile()) {
    warnings.push("local-path-not-regular-file");
    return null;
  }

  return {
    path: normalizedPath,
    size: st.size,
    extension: extname(normalizedPath).toLowerCase(),
  };
}

function localPathFromManifestPart(raw: Record<string, unknown>, projectPath: string | undefined): string {
  const directPath = safeString(raw.path);
  if (directPath) return isAbsolute(directPath) ? directPath : resolve(projectPath || process.cwd(), directPath);
  const source = asRecord(raw.source);
  if (source?.type === "local_path") {
    const sourcePath = safeString(source.path);
    if (sourcePath) return isAbsolute(sourcePath) ? sourcePath : resolve(projectPath || process.cwd(), sourcePath);
  }
  return "";
}

function sourceFromManifestPart(
  raw: Record<string, unknown>,
  localFile: NormalizedLocalFile | null,
): RichContentFileSource | null {
  const source = asRecord(raw.source);
  const fileId = safeString(raw.fileId) || safeString(raw.file_id) || safeString(source?.fileId) || safeString(source?.file_id);
  if (fileId) return { type: "telegram_file_id", fileId };

  const url = safeString(raw.url) || safeString(source?.url);
  if (url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "https:"
        ? { type: "https_url", url, trust: "explicit" }
        : null;
    } catch {
      return null;
    }
  }

  if (localFile) {
    return { type: "local_path", path: localFile.path, trust: "manifest" };
  }

  return null;
}

function withCaption<T extends RichContentPart>(part: T, raw: Record<string, unknown>): T {
  const caption = safeString(raw.caption);
  return caption ? { ...part, caption } as T : part;
}

function autoFallbackPhotoKind(
  requestedKind: Exclude<RichContentKind, "text">,
  localFile: NormalizedLocalFile | null,
  config: TelegramRichRepliesConfig | null | undefined,
  warnings: string[],
): Exclude<RichContentKind, "text"> {
  if (requestedKind !== "photo" || !localFile) return requestedKind;
  if (localFile.size > resolveMaxPhotoBytes(config)) {
    warnings.push("photo-too-large-fell-back-to-document");
    return "document";
  }
  if (!GENERATED_IMAGE_EXTENSIONS.has(localFile.extension)) {
    warnings.push("photo-extension-unsupported-fell-back-to-document");
    return "document";
  }
  return "photo";
}

async function buildPartFromManifestEntry(
  entry: unknown,
  input: BuildCompletedTurnDeliveryEnvelopeInput,
  warnings: string[],
): Promise<RichContentPart | null> {
  const raw = asRecord(entry);
  if (!raw) {
    warnings.push("delivery-manifest-part-not-object");
    return null;
  }
  const kind = safeString(raw.kind).toLowerCase();
  if (kind === "text") {
    const text = safeString(raw.text);
    if (!text) return null;
    return { kind: "text", text, format: raw.format === "plain" ? "plain" : "markdown" };
  }
  if (!isMediaKind(kind)) {
    warnings.push("delivery-manifest-part-kind-unsupported");
    return null;
  }

  const localPath = localPathFromManifestPart(raw, input.projectPath);
  const localFile = localPath
    ? await normalizeTrustedLocalFile(localPath, explicitArtifactRoots(input), warnings)
    : null;
  if (localFile && localFile.size > resolveMaxUploadBytes(input.telegramRichRepliesConfig)) {
    warnings.push("local-path-exceeds-max-upload-bytes");
    return null;
  }
  const source = sourceFromManifestPart(raw, localFile);
  if (!source) {
    warnings.push("delivery-manifest-part-source-invalid");
    return null;
  }

  const effectiveKind = autoFallbackPhotoKind(kind, localFile, input.telegramRichRepliesConfig, warnings);
  if (effectiveKind === "document") {
    return withCaption({
      kind: "document",
      source,
      ...(safeString(raw.filename) ? { filename: safeString(raw.filename) } : {}),
      ...(safeString(raw.mimeType) || safeString(raw.mime_type)
        ? { mimeType: safeString(raw.mimeType) || safeString(raw.mime_type) }
        : {}),
    }, raw);
  }
  if (effectiveKind === "photo") {
    return withCaption({
      kind: "photo",
      source,
      ...(safeString(raw.alt) ? { alt: safeString(raw.alt) } : {}),
    }, raw);
  }
  if (effectiveKind === "audio") {
    return withCaption({
      kind: "audio",
      source,
      ...(safeString(raw.title) ? { title: safeString(raw.title) } : {}),
      ...(safeString(raw.performer) ? { performer: safeString(raw.performer) } : {}),
    }, raw);
  }
  if (effectiveKind === "voice") {
    const durationSeconds = Number(raw.durationSeconds ?? raw.duration_seconds);
    return withCaption({
      kind: "voice",
      source,
      ...(Number.isFinite(durationSeconds) && durationSeconds > 0
        ? { durationSeconds: Math.floor(durationSeconds) }
        : {}),
    }, raw);
  }
  if (effectiveKind === "sticker") {
    return {
      kind: "sticker",
      source,
      ...(safeString(raw.emoji) ? { emoji: safeString(raw.emoji) } : {}),
    };
  }
  return withCaption({ kind: effectiveKind, source }, raw) as RichContentPart;
}

async function parseExplicitManifestParts(
  rawManifests: readonly string[],
  input: BuildCompletedTurnDeliveryEnvelopeInput,
  warnings: string[],
): Promise<RichContentPart[]> {
  const parts: RichContentPart[] = [];
  for (const rawManifest of rawManifests) {
    const manifest = parseManifestJson(rawManifest, warnings);
    for (const entry of manifestParts(manifest)) {
      const part = await buildPartFromManifestEntry(entry, input, warnings);
      if (part) parts.push(part);
    }
  }
  return parts;
}

function generatedImagePathFromCallId(callId: string, roots: readonly string[]): string[] {
  if (!callId) return [];
  return roots
    .map((root) => join(root, `${callId}.png`))
    .filter((path) => existsSync(path));
}

function transcriptPayload(record: unknown): {
  recordType: string;
  payload: Record<string, unknown> | null;
  payloadType: string;
  payloadTurnId: string;
} {
  const raw = asRecord(record);
  const payload = asRecord(raw?.payload);
  return {
    recordType: safeString(raw?.type),
    payload,
    payloadType: safeString(payload?.type),
    payloadTurnId: safeString(payload?.turn_id ?? payload?.turnId),
  };
}

async function generatedImageCandidatesFromCurrentTurnTranscript(
  input: BuildCompletedTurnDeliveryEnvelopeInput,
  roots: readonly string[],
  warnings: string[],
): Promise<string[]> {
  const transcriptPath = safeString(input.transcriptPath);
  const turnId = safeString(input.turnId);
  if (!transcriptPath || !turnId) {
    warnings.push("generated-artifact-current-turn-metadata-missing");
    return [];
  }

  const rawTranscript = await readFile(transcriptPath, "utf-8").catch(() => null);
  if (rawTranscript === null) {
    warnings.push("generated-artifact-transcript-unreadable");
    return [];
  }

  const candidates: string[] = [];
  let inCurrentTurn = false;
  let sawCurrentTurn = false;

  for (const line of rawTranscript.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const record = parseTranscriptJsonLine(line);
    if (!record) {
      warnings.push("generated-artifact-transcript-line-invalid-json");
      continue;
    }
    const { recordType, payload, payloadType, payloadTurnId } = transcriptPayload(record);
    const startsTurn = recordType === "turn_context" || payloadType === "task_started";
    if (startsTurn && payloadTurnId) {
      if (payloadTurnId === turnId) {
        inCurrentTurn = true;
        sawCurrentTurn = true;
        continue;
      }
      if (inCurrentTurn) break;
    }

    if (!inCurrentTurn || !payload) continue;

    if (payloadType === "image_generation_end") {
      const savedPath = safeString(payload.saved_path ?? payload.savedPath);
      if (savedPath && GENERATED_IMAGE_EXTENSIONS.has(extname(savedPath).toLowerCase())) {
        candidates.push(savedPath);
      }
      candidates.push(...generatedImagePathFromCallId(
        safeString(payload.call_id ?? payload.callId),
        roots,
      ));
    } else if (payloadType === "image_generation_call") {
      candidates.push(...generatedImagePathFromCallId(
        safeString(payload.id ?? payload.call_id ?? payload.callId),
        roots,
      ));
    }

    if (payloadType === "task_complete" && payloadTurnId === turnId) break;
  }

  if (!sawCurrentTurn) warnings.push("generated-artifact-turn-not-found-in-transcript");
  return unique(candidates);
}

async function buildGeneratedImageParts(
  input: BuildCompletedTurnDeliveryEnvelopeInput,
  warnings: string[],
): Promise<RichContentPart[]> {
  if (!autoDetectGeneratedImagesEnabled(input.telegramRichRepliesConfig)) return [];
  const roots = generatedImageRoots(input);
  if (roots.length === 0) return [];

  const candidates = await generatedImageCandidatesFromCurrentTurnTranscript(
    input,
    roots,
    warnings,
  );
  const parts: RichContentPart[] = [];
  for (const candidate of candidates) {
    const localFile = await normalizeTrustedLocalFile(candidate, roots, warnings);
    if (!localFile) continue;
    if (localFile.size > resolveMaxUploadBytes(input.telegramRichRepliesConfig)) {
      warnings.push("generated-image-exceeds-max-upload-bytes");
      continue;
    }
    const source: RichContentFileSource = {
      type: "local_path",
      path: localFile.path,
      trust: "turn-artifact",
    };
    const kind = localFile.size <= resolveMaxPhotoBytes(input.telegramRichRepliesConfig)
      ? "photo"
      : "document";
    parts.push(kind === "photo"
      ? { kind, source, alt: basename(localFile.path) }
      : { kind, source, filename: basename(localFile.path), mimeType: mimeTypeForPath(localFile.path) });
  }
  return parts;
}

function dedupeParts(parts: readonly RichContentPart[]): RichContentPart[] {
  const seen = new Set<string>();
  const deduped: RichContentPart[] = [];
  for (const part of parts) {
    const key = part.kind === "text"
      ? `text:${part.text}`
      : part.source.type === "local_path"
        ? `local:${part.source.path}`
        : part.source.type === "https_url"
          ? `url:${part.source.url}`
          : `telegram:${part.source.fileId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(part);
  }
  return deduped;
}

export function mimeTypeForPath(path: string): string | undefined {
  switch (extname(path).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    case ".pdf": return "application/pdf";
    case ".mp3": return "audio/mpeg";
    case ".m4a": return "audio/mp4";
    case ".ogg":
    case ".oga": return "audio/ogg";
    case ".wav": return "audio/wav";
    case ".mp4": return "video/mp4";
    default: return undefined;
  }
}

export async function buildCompletedTurnDeliveryEnvelope(
  input: BuildCompletedTurnDeliveryEnvelopeInput,
): Promise<CompletedTurnDeliveryEnvelope> {
  const extracted = extractDeliveryManifests(input.assistantText);
  const warnings = [...extracted.warnings];
  const visibleText = extracted.visibleText;
  const textParts: RichContentPart[] = visibleText.trim().length > 0
    ? [{ kind: "text", text: visibleText, format: "markdown" }]
    : [];

  if (!richRepliesEnabled(input.telegramRichRepliesConfig)) {
    return {
      parts: textParts,
      visibleText,
      warnings,
    };
  }

  const explicitParts = await parseExplicitManifestParts(extracted.rawManifests, input, warnings);
  const generatedImageParts = await buildGeneratedImageParts(input, warnings);
  return {
    parts: dedupeParts([...textParts, ...explicitParts, ...generatedImageParts]),
    visibleText,
    warnings,
  };
}

export function hasDeliverableContent(content: RichNotificationContent | null | undefined): boolean {
  return (content?.parts ?? []).some((part) =>
    part.kind === "text" ? part.text.trim().length > 0 : true
  );
}

export function hasRichMediaContent(content: RichNotificationContent | null | undefined): boolean {
  return (content?.parts ?? []).some((part) => part.kind !== "text");
}
