import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  createAudioTranscriptionProvider,
  fingerprintAudioTranscriptionModel,
} from '../transcription/registry.js';
import type {
  AudioTranscriptionProvider,
  AudioTranscriptionResult,
  TelegramVoiceTranscriptionConfig,
} from '../transcription/types.js';
import { sanitizeTelegramFilePart } from './media-handlers.js';
import {
  DEFAULT_TELEGRAM_ATTACHMENT_ROOT,
  TELEGRAM_ATTACHMENT_DIR_ENV,
  TELEGRAM_ATTACHMENT_DIR_MODE,
  TELEGRAM_ATTACHMENT_FILE_MODE,
} from './storage.js';
import type {
  SavedTelegramMedia,
  SavedTelegramMediaTranscription,
  SavedTelegramMediaTranscriptionFailure,
  SavedTelegramMediaTranscriptionSuccess,
  TelegramInboundMessage,
} from './types.js';

interface TelegramTranscriptionCacheRecord {
  version: 1;
  createdAt: string;
  cacheKeyHash: string;
  cacheKey: TelegramTranscriptionCacheKey;
  result: SavedTelegramMediaTranscriptionSuccess;
}

interface TelegramTranscriptionCacheKey {
  mediaFingerprint: string;
  providerId: string;
  modelFingerprint: string;
  language: string;
  promptHash: string;
  preprocessMode: string;
  transcriptionOptionsHash: string;
}

export interface AttachTelegramTranscriptionsDeps {
  provider?: AudioTranscriptionProvider;
  cacheRoot?: string;
  readFileImpl?: typeof readFile;
  writeFileImpl?: typeof writeFile;
  mkdirImpl?: typeof mkdir;
  logImpl?: (message: string) => void;
  now?: () => Date;
}

export interface AttachTelegramTranscriptionsOptions {
  message: TelegramInboundMessage;
  savedMedia: SavedTelegramMedia[];
  config: TelegramVoiceTranscriptionConfig;
  deps?: AttachTelegramTranscriptionsDeps;
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sha256Buffer(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function resolveCacheRoot(rootDir?: string): string {
  return resolve(
    rootDir
      ?? process.env[TELEGRAM_ATTACHMENT_DIR_ENV]
      ?? DEFAULT_TELEGRAM_ATTACHMENT_ROOT,
    'transcripts',
  );
}

function transcriptionMetadataPath(media: SavedTelegramMedia): string {
  return `${media.path}.transcription.json`;
}

async function ensurePrivateDirectory(path: string, mkdirImpl: typeof mkdir): Promise<void> {
  await mkdirImpl(path, { recursive: true, mode: TELEGRAM_ATTACHMENT_DIR_MODE });
  try {
    chmodSync(path, TELEGRAM_ATTACHMENT_DIR_MODE);
  } catch {
    // chmod may be unsupported on some platforms/filesystems.
  }
}

function failureFromResult(
  result: Extract<AudioTranscriptionResult, { ok: false }>,
  metadataPath: string,
): SavedTelegramMediaTranscriptionFailure {
  return {
    status: 'failed',
    providerId: result.providerId,
    code: result.code,
    message: result.message,
    ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
    metadataPath,
  };
}

function successFromResult(
  result: Extract<AudioTranscriptionResult, { ok: true }>,
  metadataPath: string,
  cachePath: string,
  fromCache: boolean,
): SavedTelegramMediaTranscriptionSuccess {
  return {
    status: 'success',
    providerId: result.providerId,
    transcript: result.transcript,
    ...(result.language ? { language: result.language } : {}),
    ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
    fromCache,
    cachePath,
    metadataPath,
  };
}

async function writeTranscriptionMetadata(
  media: SavedTelegramMedia,
  transcription: SavedTelegramMediaTranscription,
  deps: Required<Pick<AttachTelegramTranscriptionsDeps, 'writeFileImpl' | 'mkdirImpl'>>,
): Promise<void> {
  const metadataPath = transcriptionMetadataPath(media);
  await ensurePrivateDirectory(dirname(metadataPath), deps.mkdirImpl);
  await deps.writeFileImpl(
    metadataPath,
    `${JSON.stringify({ ...transcription, savedPath: media.path }, null, 2)}\n`,
    { mode: TELEGRAM_ATTACHMENT_FILE_MODE },
  );
}

async function writeTranscriptionMetadataBestEffort(
  media: SavedTelegramMedia,
  transcription: SavedTelegramMediaTranscription,
  deps: Required<Pick<AttachTelegramTranscriptionsDeps, 'writeFileImpl' | 'mkdirImpl'>> & Pick<AttachTelegramTranscriptionsDeps, 'logImpl'>,
): Promise<void> {
  try {
    await writeTranscriptionMetadata(media, transcription, deps);
  } catch (error) {
    deps.logImpl?.(`WARN: Failed to write Telegram transcription metadata for ${media.path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function cachePathForKey(cacheRoot: string, sourceKey: string, cacheKey: TelegramTranscriptionCacheKey): { hash: string; path: string } {
  const hash = sha256Text(JSON.stringify(cacheKey));
  const safeSource = sanitizeTelegramFilePart(sourceKey, 'telegram');
  return {
    hash,
    path: join(cacheRoot, safeSource, hash.slice(0, 2), `${hash}.json`),
  };
}

async function buildMediaFingerprint(
  media: SavedTelegramMedia,
  readFileImpl: typeof readFile,
): Promise<string> {
  if (media.fileUniqueId) {
    return `telegram-file-unique-id:${media.fileUniqueId}`;
  }
  const bytes = await readFileImpl(media.path);
  return `sha256:${sha256Buffer(bytes)}`;
}

async function buildCacheKey(
  media: SavedTelegramMedia,
  provider: AudioTranscriptionProvider,
  config: TelegramVoiceTranscriptionConfig,
  readFileImpl: typeof readFile,
): Promise<TelegramTranscriptionCacheKey> {
  return {
    mediaFingerprint: await buildMediaFingerprint(media, readFileImpl),
    providerId: provider.id,
    modelFingerprint: await fingerprintAudioTranscriptionModel(config),
    language: config.language,
    promptHash: sha256Text(config.prompt ?? ''),
    preprocessMode: config.preprocess.mode,
    transcriptionOptionsHash: sha256Text(JSON.stringify({
      preprocess: {
        mode: config.preprocess.mode,
        binaryPath: config.preprocess.binaryPath,
      },
      whisperCpp: {
        binaryPath: config.whisperCpp.binaryPath,
        threads: config.whisperCpp.threads ?? 0,
        processors: config.whisperCpp.processors ?? 1,
        temperature: config.whisperCpp.temperature ?? 0,
        outputJsonFull: config.whisperCpp.outputJsonFull,
      },
    })),
  };
}

function boundedDiagnostic(message: string): string {
  const normalized = message.replace(/\s+/g, ' ').trim();
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 237).trimEnd()}…`;
}

async function readCache(
  cachePath: string,
  cacheKeyHash: string,
  readFileImpl: typeof readFile,
): Promise<SavedTelegramMediaTranscriptionSuccess | null> {
  try {
    const raw = JSON.parse(await readFileImpl(cachePath, 'utf-8')) as Partial<TelegramTranscriptionCacheRecord>;
    if (
      raw.version !== 1
      || raw.cacheKeyHash !== cacheKeyHash
      || raw.result?.status !== 'success'
      || typeof raw.result.providerId !== 'string'
      || typeof raw.result.transcript !== 'string'
      || raw.result.transcript.trim() === ''
      || (raw.result.language !== undefined && typeof raw.result.language !== 'string')
      || (raw.result.durationMs !== undefined && typeof raw.result.durationMs !== 'number')
    ) {
      return null;
    }
    return {
      ...raw.result,
      fromCache: true,
      cachePath,
    };
  } catch {
    return null;
  }
}

async function writeCache(
  cachePath: string,
  record: TelegramTranscriptionCacheRecord,
  deps: Required<Pick<AttachTelegramTranscriptionsDeps, 'writeFileImpl' | 'mkdirImpl'>>,
): Promise<void> {
  await ensurePrivateDirectory(dirname(cachePath), deps.mkdirImpl);
  await deps.writeFileImpl(cachePath, `${JSON.stringify(record, null, 2)}\n`, { mode: TELEGRAM_ATTACHMENT_FILE_MODE });
}

async function writeCacheBestEffort(
  cachePath: string,
  record: TelegramTranscriptionCacheRecord,
  deps: Required<Pick<AttachTelegramTranscriptionsDeps, 'writeFileImpl' | 'mkdirImpl'>> & Pick<AttachTelegramTranscriptionsDeps, 'logImpl'>,
): Promise<void> {
  try {
    await writeCache(cachePath, record, deps);
  } catch (error) {
    deps.logImpl?.(`WARN: Failed to write Telegram transcription cache ${cachePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function transcribeOneSavedMedia(
  message: TelegramInboundMessage,
  media: SavedTelegramMedia,
  config: TelegramVoiceTranscriptionConfig,
  provider: AudioTranscriptionProvider,
  deps: Required<Pick<AttachTelegramTranscriptionsDeps, 'readFileImpl' | 'writeFileImpl' | 'mkdirImpl' | 'now'>> & Pick<AttachTelegramTranscriptionsDeps, 'logImpl' | 'cacheRoot'>,
): Promise<SavedTelegramMedia> {
  const metadataPath = transcriptionMetadataPath(media);

  if (media.durationSeconds !== undefined && media.durationSeconds > config.maxDurationSeconds) {
    const transcription: SavedTelegramMediaTranscriptionFailure = {
      status: 'failed',
      providerId: provider.id,
      code: 'max-duration-exceeded',
      message: `Telegram ${media.kind} duration ${media.durationSeconds}s exceeds configured transcription max ${config.maxDurationSeconds}s`,
      metadataPath,
    };
    await writeTranscriptionMetadataBestEffort(media, transcription, deps);
    return { ...media, transcription };
  }

  const cacheRoot = resolveCacheRoot(deps.cacheRoot);
  const cacheKey = await buildCacheKey(media, provider, config, deps.readFileImpl);
  const cachePath = cachePathForKey(cacheRoot, media.sourceKey, cacheKey);
  const cached = await readCache(cachePath.path, cachePath.hash, deps.readFileImpl);
  if (cached) {
    const transcription = { ...cached, metadataPath };
    await writeTranscriptionMetadataBestEffort(media, transcription, deps);
    return { ...media, transcription };
  }

  const result = await provider.transcribe({
    audioPath: media.path,
    sourceId: `${String(message.chatId ?? 'chat')}:${String(message.messageId ?? 'message')}:${media.kind}#${media.index}`,
    ...(media.mimeType ? { mimeType: media.mimeType } : {}),
    ...(media.durationSeconds !== undefined ? { durationSeconds: media.durationSeconds } : {}),
    timeoutMs: config.timeoutMs,
  });

  if (!result.ok) {
    const transcription = failureFromResult({ ...result, message: boundedDiagnostic(result.message) }, metadataPath);
    await writeTranscriptionMetadataBestEffort(media, transcription, deps);
    return { ...media, transcription };
  }

  const transcription = successFromResult(result, metadataPath, cachePath.path, false);
  await writeCacheBestEffort(cachePath.path, {
    version: 1,
    createdAt: deps.now().toISOString(),
    cacheKeyHash: cachePath.hash,
    cacheKey,
    result: transcription,
  }, deps);
  await writeTranscriptionMetadataBestEffort(media, transcription, deps);
  return { ...media, transcription };
}

export async function attachTelegramTranscriptions(
  options: AttachTelegramTranscriptionsOptions,
): Promise<SavedTelegramMedia[]> {
  const { config, message } = options;
  if (!config.enabled) {
    return options.savedMedia;
  }

  const deps = {
    provider: options.deps?.provider,
    cacheRoot: options.deps?.cacheRoot,
    readFileImpl: options.deps?.readFileImpl ?? readFile,
    writeFileImpl: options.deps?.writeFileImpl ?? writeFile,
    mkdirImpl: options.deps?.mkdirImpl ?? mkdir,
    logImpl: options.deps?.logImpl,
    now: options.deps?.now ?? (() => new Date()),
  };

  for (const warning of config.warnings ?? []) {
    deps.logImpl?.(`WARN: Telegram voice transcription configuration warning: ${warning}`);
  }

  const provider = deps.provider ?? createAudioTranscriptionProvider(config);
  const eligibleKinds = new Set(config.mediaKinds);
  const result: SavedTelegramMedia[] = [];

  for (const media of options.savedMedia) {
    if (!eligibleKinds.has(media.kind)) {
      result.push(media);
      continue;
    }

    try {
      result.push(await transcribeOneSavedMedia(message, media, config, provider, deps));
    } catch (error) {
      const metadataPath = transcriptionMetadataPath(media);
      const transcription: SavedTelegramMediaTranscriptionFailure = {
        status: 'failed',
        providerId: provider.id,
        code: 'cache-error',
        message: boundedDiagnostic(error instanceof Error ? error.message : String(error)),
        metadataPath,
      };
      await writeTranscriptionMetadataBestEffort(media, transcription, deps);
      result.push({ ...media, transcription });
    }
  }

  return result;
}
