import { mkdir, writeFile } from 'fs/promises';
import { chmodSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve, sep } from 'path';
import { describeTelegramMediaPart, sanitizeTelegramFilePart } from './media-handlers.js';
import type { SavedTelegramMedia, TelegramInboundMessage, TelegramMediaPart } from './types.js';

export const TELEGRAM_ATTACHMENT_DIR_ENV = 'OMX_TELEGRAM_ATTACHMENT_DIR';
export const DEFAULT_TELEGRAM_ATTACHMENT_ROOT = join(homedir(), '.omx', 'state', 'telegram-attachments');
export const TELEGRAM_ATTACHMENT_DIR_MODE = 0o700;
export const TELEGRAM_ATTACHMENT_FILE_MODE = 0o600;

export interface SaveTelegramMediaOptions {
  rootDir?: string;
  sourceKey: string;
  message: TelegramInboundMessage;
  part: TelegramMediaPart;
  bytes: Buffer;
  telegramFilePath?: string;
  createdAt?: Date;
}

function resolveAttachmentRoot(rootDir?: string): string {
  return resolve(rootDir ?? process.env[TELEGRAM_ATTACHMENT_DIR_ENV] ?? DEFAULT_TELEGRAM_ATTACHMENT_ROOT);
}

function assertInsideRoot(root: string, target: string): void {
  const normalizedRoot = root.endsWith(sep) ? root : `${root}${sep}`;
  if (target !== root && !target.startsWith(normalizedRoot)) {
    throw new Error('Refusing to write Telegram attachment outside attachment root');
  }
}

function safeId(value: unknown, fallback: string): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(Math.floor(value));
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return sanitizeTelegramFilePart(value.trim(), fallback);
  }
  return fallback;
}

function buildTargetPath(options: SaveTelegramMediaOptions): string {
  const root = resolveAttachmentRoot(options.rootDir);
  const sourceDir = sanitizeTelegramFilePart(options.sourceKey, 'telegram');
  const dateDir = (options.createdAt ?? new Date()).toISOString().slice(0, 10);
  const descriptor = describeTelegramMediaPart(options.part, options.telegramFilePath);
  const chatId = safeId(options.message.chatId, 'chat');
  const messageId = safeId(options.message.messageId, 'message');
  const filename = `${chatId}-${messageId}-${options.part.index}-${options.part.mediaKind}.${descriptor.extension}`;
  const target = resolve(root, sourceDir, dateDir, filename);
  assertInsideRoot(root, target);
  return target;
}

export async function saveTelegramMedia(options: SaveTelegramMediaOptions): Promise<SavedTelegramMedia> {
  const createdAtDate = options.createdAt ?? new Date();
  const targetPath = buildTargetPath({ ...options, createdAt: createdAtDate });
  const metadataPath = `${targetPath}.metadata.json`;
  const descriptor = describeTelegramMediaPart(options.part, options.telegramFilePath);
  const createdAt = createdAtDate.toISOString();
  const directory = dirname(targetPath);

  await mkdir(directory, { recursive: true, mode: TELEGRAM_ATTACHMENT_DIR_MODE });
  try {
    chmodSync(directory, TELEGRAM_ATTACHMENT_DIR_MODE);
  } catch {
    // chmod may be unsupported on some platforms/filesystems; write still proceeds.
  }

  const saved: SavedTelegramMedia = {
    kind: options.part.mediaKind,
    index: options.part.index,
    path: targetPath,
    metadataPath,
    bytes: options.bytes.length,
    sourceKey: options.sourceKey,
    ...(options.part.fileUniqueId ? { fileUniqueId: options.part.fileUniqueId } : {}),
    ...(options.message.messageId !== undefined ? { messageId: options.message.messageId } : {}),
    ...(options.message.chatId !== undefined ? { chatId: options.message.chatId } : {}),
    ...(options.message.messageThreadId !== undefined ? { messageThreadId: options.message.messageThreadId } : {}),
    ...(options.part.fileName ? { fileName: options.part.fileName } : {}),
    ...(descriptor.mimeType ? { mimeType: descriptor.mimeType } : {}),
    ...(descriptor.width !== undefined ? { width: descriptor.width } : {}),
    ...(descriptor.height !== undefined ? { height: descriptor.height } : {}),
    ...(descriptor.durationSeconds !== undefined ? { durationSeconds: descriptor.durationSeconds } : {}),
    ...(descriptor.title ? { title: descriptor.title } : {}),
    ...(descriptor.performer ? { performer: descriptor.performer } : {}),
    ...(options.telegramFilePath ? { telegramFilePath: options.telegramFilePath } : {}),
  };

  const metadata = {
    createdAt,
    sourceKey: options.sourceKey,
    messageId: options.message.messageId,
    messageThreadId: options.message.messageThreadId,
    chatId: options.message.chatId,
    senderId: options.message.senderId,
    replyToMessageId: options.message.replyToMessageId,
    mediaGroupId: options.message.mediaGroupId,
    partIndex: options.part.index,
    kind: options.part.mediaKind,
    mimeType: descriptor.mimeType,
    durationSeconds: descriptor.durationSeconds,
    width: descriptor.width,
    height: descriptor.height,
    title: descriptor.title,
    performer: descriptor.performer,
    originalFileName: descriptor.originalFileName,
    telegramFileUniqueId: options.part.fileUniqueId,
    telegramFilePath: options.telegramFilePath,
    fileSizeBytes: options.bytes.length,
    savedPath: targetPath,
  };

  await writeFile(targetPath, options.bytes, { mode: TELEGRAM_ATTACHMENT_FILE_MODE });
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: TELEGRAM_ATTACHMENT_FILE_MODE });
  return saved;
}
