import type {
  TelegramInboundCallbackQuery,
  TelegramInboundMessage,
  TelegramMediaPart,
  TelegramRawMessage,
  TelegramRawPhotoSize,
  TelegramRawUpdate,
  TelegramTextPart,
} from './types.js';

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

function normalizeTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

export function getTelegramInboundText(message: TelegramInboundMessage | null | undefined): string {
  return message?.textPart?.text ?? '';
}

export function hasTelegramInboundContent(message: TelegramInboundMessage | null | undefined): boolean {
  return !!message && (getTelegramInboundText(message).trim() !== '' || message.mediaParts.length > 0);
}

function photoArea(photo: TelegramRawPhotoSize): number {
  const width = normalizePositiveInteger(photo.width);
  const height = normalizePositiveInteger(photo.height);
  return width !== undefined && height !== undefined ? width * height : -1;
}

export function selectBestTelegramPhotoVariant(
  photos: TelegramRawPhotoSize[] | undefined,
): TelegramRawPhotoSize | null {
  const candidates = (photos ?? [])
    .filter((photo) => normalizeTrimmedString(photo.file_id) !== undefined);
  if (candidates.length === 0) {
    return null;
  }

  return candidates.reduce((best, candidate) => {
    const bestFileSize = normalizePositiveInteger(best.file_size) ?? -1;
    const candidateFileSize = normalizePositiveInteger(candidate.file_size) ?? -1;
    if (bestFileSize !== candidateFileSize) {
      return candidateFileSize > bestFileSize ? candidate : best;
    }

    const bestArea = photoArea(best);
    const candidateArea = photoArea(candidate);
    if (bestArea !== candidateArea) {
      return candidateArea > bestArea ? candidate : best;
    }

    const bestId = normalizeTrimmedString(best.file_id) ?? '';
    const candidateId = normalizeTrimmedString(candidate.file_id) ?? '';
    return candidateId > bestId ? candidate : best;
  });
}

function buildTextPart(message: TelegramRawMessage): TelegramTextPart | undefined {
  if (typeof message.text === 'string') {
    return { kind: 'text', source: 'text', text: message.text };
  }
  if (typeof message.caption === 'string') {
    return { kind: 'text', source: 'caption', text: message.caption };
  }
  return undefined;
}

function buildMediaParts(message: TelegramRawMessage): TelegramMediaPart[] {
  const parts: TelegramMediaPart[] = [];
  let index = 0;

  const photo = selectBestTelegramPhotoVariant(message.photo);
  const photoFileId = normalizeTrimmedString(photo?.file_id);
  if (photo && photoFileId) {
    index += 1;
    parts.push({
      kind: 'media',
      mediaKind: 'photo',
      index,
      fileId: photoFileId,
      ...(normalizeTrimmedString(photo.file_unique_id) ? { fileUniqueId: normalizeTrimmedString(photo.file_unique_id) } : {}),
      ...(normalizePositiveInteger(photo.file_size) !== undefined ? { fileSize: normalizePositiveInteger(photo.file_size) } : {}),
      ...(normalizePositiveInteger(photo.width) !== undefined ? { width: normalizePositiveInteger(photo.width) } : {}),
      ...(normalizePositiveInteger(photo.height) !== undefined ? { height: normalizePositiveInteger(photo.height) } : {}),
    });
  }

  const documentFileId = normalizeTrimmedString(message.document?.file_id);
  if (message.document && documentFileId) {
    index += 1;
    parts.push({
      kind: 'media',
      mediaKind: 'document',
      index,
      fileId: documentFileId,
      ...(normalizeTrimmedString(message.document.file_unique_id) ? { fileUniqueId: normalizeTrimmedString(message.document.file_unique_id) } : {}),
      ...(normalizeTrimmedString(message.document.file_name) ? { fileName: normalizeTrimmedString(message.document.file_name) } : {}),
      ...(normalizeTrimmedString(message.document.mime_type) ? { mimeType: normalizeTrimmedString(message.document.mime_type) } : {}),
      ...(normalizePositiveInteger(message.document.file_size) !== undefined ? { fileSize: normalizePositiveInteger(message.document.file_size) } : {}),
    });
  }

  const audioFileId = normalizeTrimmedString(message.audio?.file_id);
  if (message.audio && audioFileId) {
    index += 1;
    parts.push({
      kind: 'media',
      mediaKind: 'audio',
      index,
      fileId: audioFileId,
      ...(normalizeTrimmedString(message.audio.file_unique_id) ? { fileUniqueId: normalizeTrimmedString(message.audio.file_unique_id) } : {}),
      ...(normalizeTrimmedString(message.audio.file_name) ? { fileName: normalizeTrimmedString(message.audio.file_name) } : {}),
      ...(normalizeTrimmedString(message.audio.mime_type) ? { mimeType: normalizeTrimmedString(message.audio.mime_type) } : {}),
      ...(normalizePositiveInteger(message.audio.file_size) !== undefined ? { fileSize: normalizePositiveInteger(message.audio.file_size) } : {}),
      ...(normalizePositiveInteger(message.audio.duration) !== undefined ? { durationSeconds: normalizePositiveInteger(message.audio.duration) } : {}),
      ...(normalizeTrimmedString(message.audio.title) ? { title: normalizeTrimmedString(message.audio.title) } : {}),
      ...(normalizeTrimmedString(message.audio.performer) ? { performer: normalizeTrimmedString(message.audio.performer) } : {}),
    });
  }

  const voiceFileId = normalizeTrimmedString(message.voice?.file_id);
  if (message.voice && voiceFileId) {
    index += 1;
    parts.push({
      kind: 'media',
      mediaKind: 'voice',
      index,
      fileId: voiceFileId,
      ...(normalizeTrimmedString(message.voice.file_unique_id) ? { fileUniqueId: normalizeTrimmedString(message.voice.file_unique_id) } : {}),
      ...(normalizeTrimmedString(message.voice.mime_type) ? { mimeType: normalizeTrimmedString(message.voice.mime_type) } : {}),
      ...(normalizePositiveInteger(message.voice.file_size) !== undefined ? { fileSize: normalizePositiveInteger(message.voice.file_size) } : {}),
      ...(normalizePositiveInteger(message.voice.duration) !== undefined ? { durationSeconds: normalizePositiveInteger(message.voice.duration) } : {}),
    });
  }

  return parts;
}

export function normalizeTelegramUpdate(update: TelegramRawUpdate): TelegramInboundMessage | null {
  const message = update.message;
  if (!message) {
    return null;
  }

  const chatType = normalizeTrimmedString(message.chat?.type);
  const mediaGroupId = normalizeTrimmedString(message.media_group_id);
  const textPart = buildTextPart(message);

  return {
    ...(typeof update.update_id === 'number' ? { updateId: update.update_id } : {}),
    ...(message.message_id !== undefined ? { messageId: message.message_id } : {}),
    ...(message.message_thread_id !== undefined ? { messageThreadId: message.message_thread_id } : {}),
    ...(message.chat?.id !== undefined ? { chatId: message.chat.id } : {}),
    ...(chatType ? { chatType } : {}),
    ...(message.from?.id !== undefined ? { senderId: message.from.id } : {}),
    ...(message.reply_to_message?.message_id !== undefined ? { replyToMessageId: message.reply_to_message.message_id } : {}),
    ...(message.reply_to_message?.message_thread_id !== undefined ? { replyToThreadId: message.reply_to_message.message_thread_id } : {}),
    ...(mediaGroupId ? { mediaGroupId } : {}),
    ...(textPart ? { textPart } : {}),
    mediaParts: buildMediaParts(message),
    rawMessage: message,
  };
}

export function normalizeTelegramCallbackQuery(update: TelegramRawUpdate): TelegramInboundCallbackQuery | null {
  const callbackQuery = update.callback_query;
  if (!callbackQuery || typeof callbackQuery.id !== 'string' || callbackQuery.id.trim() === '') {
    return null;
  }

  const message = callbackQuery.message;
  const chatType = normalizeTrimmedString(message?.chat?.type);
  return {
    ...(typeof update.update_id === 'number' ? { updateId: update.update_id } : {}),
    id: callbackQuery.id.trim(),
    ...(callbackQuery.from?.id !== undefined ? { senderId: callbackQuery.from.id } : {}),
    ...(message?.chat?.id !== undefined ? { chatId: message.chat.id } : {}),
    ...(chatType ? { chatType } : {}),
    ...(message?.message_id !== undefined ? { messageId: message.message_id } : {}),
    ...(message?.message_thread_id !== undefined ? { messageThreadId: message.message_thread_id } : {}),
    ...(typeof callbackQuery.data === 'string' ? { data: callbackQuery.data } : {}),
    rawCallbackQuery: callbackQuery,
  };
}
