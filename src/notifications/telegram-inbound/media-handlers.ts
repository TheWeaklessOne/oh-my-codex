import { basename, extname } from 'path';
import type { TelegramMediaKind, TelegramMediaPart } from './types.js';

export interface TelegramMediaDescriptor {
  kind: TelegramMediaKind;
  extension: string;
  fileNameStem: string;
  mimeType?: string;
  originalFileName?: string;
  fileSize?: number;
  width?: number;
  height?: number;
  durationSeconds?: number;
  title?: string;
  performer?: string;
}

export interface TelegramMediaHandler {
  kind: TelegramMediaKind;
  inferExtension(part: TelegramMediaPart, telegramFilePath?: string): string;
  inferFileNameStem(part: TelegramMediaPart): string;
  describe(part: TelegramMediaPart, telegramFilePath?: string): TelegramMediaDescriptor;
}

const MIME_EXTENSION_MAP: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/oga': 'oga',
  'audio/opus': 'opus',
};

const DEFAULT_EXTENSION_BY_KIND: Record<TelegramMediaKind, string> = {
  photo: 'jpg',
  document: 'bin',
  audio: 'mp3',
  voice: 'ogg',
};

export function sanitizeTelegramFilePart(value: string | undefined, fallback: string): string {
  const cleaned = (value ?? '')
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 96);
  return cleaned || fallback;
}

function normalizeExtension(value: string | undefined): string | undefined {
  const cleaned = (value ?? '').replace(/^\./, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return cleaned || undefined;
}

function extensionFromPath(value: string | undefined): string | undefined {
  return normalizeExtension(extname(value ?? ''));
}

function extensionFromMime(mimeType: string | undefined): string | undefined {
  return mimeType ? MIME_EXTENSION_MAP[mimeType.toLowerCase()] : undefined;
}

function inferExtension(part: TelegramMediaPart, telegramFilePath: string | undefined): string {
  return extensionFromPath(part.fileName)
    ?? extensionFromPath(telegramFilePath)
    ?? extensionFromMime(part.mimeType)
    ?? DEFAULT_EXTENSION_BY_KIND[part.mediaKind];
}

function inferFileNameStem(part: TelegramMediaPart): string {
  const stem = part.fileName ? basename(part.fileName, extname(part.fileName)) : undefined;
  return sanitizeTelegramFilePart(stem, `${part.mediaKind}-${part.index}`);
}

function describe(part: TelegramMediaPart, telegramFilePath?: string): TelegramMediaDescriptor {
  return {
    kind: part.mediaKind,
    extension: inferExtension(part, telegramFilePath),
    fileNameStem: inferFileNameStem(part),
    ...(part.mimeType ? { mimeType: part.mimeType } : {}),
    ...(part.fileName ? { originalFileName: part.fileName } : {}),
    ...(part.fileSize !== undefined ? { fileSize: part.fileSize } : {}),
    ...(part.width !== undefined ? { width: part.width } : {}),
    ...(part.height !== undefined ? { height: part.height } : {}),
    ...(part.durationSeconds !== undefined ? { durationSeconds: part.durationSeconds } : {}),
    ...(part.title ? { title: part.title } : {}),
    ...(part.performer ? { performer: part.performer } : {}),
  };
}

function createHandler(kind: TelegramMediaKind): TelegramMediaHandler {
  return {
    kind,
    inferExtension,
    inferFileNameStem,
    describe,
  };
}

export const telegramMediaHandlers: Record<TelegramMediaKind, TelegramMediaHandler> = {
  photo: createHandler('photo'),
  document: createHandler('document'),
  audio: createHandler('audio'),
  voice: createHandler('voice'),
};

export function getTelegramMediaHandler(kind: TelegramMediaKind): TelegramMediaHandler {
  return telegramMediaHandlers[kind];
}

export function describeTelegramMediaPart(
  part: TelegramMediaPart,
  telegramFilePath?: string,
): TelegramMediaDescriptor {
  return getTelegramMediaHandler(part.mediaKind).describe(part, telegramFilePath);
}
