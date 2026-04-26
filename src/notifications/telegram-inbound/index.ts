export * from './types.js';
export * from './parse.js';
export * from './media-handlers.js';
export * from './files.js';
export * from './storage.js';
export * from './prompt-renderer.js';
export * from './ack.js';

import { TELEGRAM_BOT_API_MAX_DOWNLOAD_BYTES, fetchTelegramFile } from './files.js';
import { renderTelegramPromptInput } from './prompt-renderer.js';
import { saveTelegramMedia } from './storage.js';
import type {
  FailedTelegramMedia,
  SavedTelegramMedia,
  TelegramHttpsRequest,
  TelegramInboundMessage,
} from './types.js';

export interface BuildTelegramPromptInputOptions {
  botToken: string;
  sourceKey: string;
  httpsRequestImpl?: TelegramHttpsRequest;
  attachmentRoot?: string;
  maxDownloadBytes?: number;
  maxPromptChars?: number;
  logImpl?: (message: string) => void;
}

export async function buildTelegramPromptInput(
  message: TelegramInboundMessage,
  options: BuildTelegramPromptInputOptions,
): Promise<string> {
  const savedMedia: SavedTelegramMedia[] = [];
  const failedMedia: FailedTelegramMedia[] = [];

  const maxDownloadBytes = options.maxDownloadBytes ?? TELEGRAM_BOT_API_MAX_DOWNLOAD_BYTES;

  for (const part of message.mediaParts) {
    try {
      if (part.fileSize !== undefined && part.fileSize > maxDownloadBytes) {
        throw new Error('Telegram attachment exceeds the 20 MB download limit');
      }
      const downloaded = await fetchTelegramFile({
        botToken: options.botToken,
        fileId: part.fileId,
        ...(options.httpsRequestImpl ? { httpsRequestImpl: options.httpsRequestImpl } : {}),
        maxBytes: maxDownloadBytes,
      });
      savedMedia.push(await saveTelegramMedia({
        sourceKey: options.sourceKey,
        message,
        part,
        bytes: downloaded.bytes,
        telegramFilePath: downloaded.fileInfo.filePath,
        ...(options.attachmentRoot ? { rootDir: options.attachmentRoot } : {}),
      }));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failedMedia.push({ part, reason });
      options.logImpl?.(`WARN: Failed to save Telegram ${part.mediaKind} attachment from message ${String(message.messageId ?? 'unknown')}: ${reason}`);
    }
  }

  return renderTelegramPromptInput(
    { message, savedMedia, failedMedia },
    options.maxPromptChars !== undefined ? { maxPromptChars: options.maxPromptChars } : {},
  );
}
