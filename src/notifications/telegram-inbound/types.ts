import type { request as httpsRequest } from 'https';

export type TelegramMediaKind = 'photo' | 'document' | 'audio' | 'voice';

export interface TelegramRawUpdate {
  update_id?: number;
  message?: TelegramRawMessage;
}

export interface TelegramRawMessage {
  message_id?: number | string;
  message_thread_id?: number | string;
  media_group_id?: string;
  chat?: {
    id?: number | string;
    type?: string;
  };
  from?: {
    id?: number | string;
  };
  text?: string;
  caption?: string;
  photo?: TelegramRawPhotoSize[];
  document?: TelegramRawDocument;
  audio?: TelegramRawAudio;
  voice?: TelegramRawVoice;
  reply_to_message?: {
    message_id?: number | string;
    message_thread_id?: number | string;
  };
}

export interface TelegramRawPhotoSize {
  file_id?: string;
  file_unique_id?: string;
  width?: number;
  height?: number;
  file_size?: number;
}

export interface TelegramRawDocument {
  file_id?: string;
  file_unique_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramRawAudio {
  file_id?: string;
  file_unique_id?: string;
  duration?: number;
  performer?: string;
  title?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramRawVoice {
  file_id?: string;
  file_unique_id?: string;
  duration?: number;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramTextPart {
  kind: 'text';
  source: 'text' | 'caption';
  text: string;
}

export interface TelegramMediaPart {
  kind: 'media';
  mediaKind: TelegramMediaKind;
  index: number;
  fileId: string;
  fileUniqueId?: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  width?: number;
  height?: number;
  durationSeconds?: number;
  title?: string;
  performer?: string;
}

export interface TelegramInboundMessage {
  updateId?: number;
  messageId?: number | string;
  messageThreadId?: number | string;
  chatId?: number | string;
  chatType?: string;
  senderId?: number | string;
  replyToMessageId?: number | string;
  replyToThreadId?: number | string;
  mediaGroupId?: string;
  textPart?: TelegramTextPart;
  mediaParts: TelegramMediaPart[];
  rawMessage: TelegramRawMessage;
}

export interface TelegramFileInfo {
  filePath: string;
  fileSize?: number;
}

export interface TelegramDownloadedFile {
  fileInfo: TelegramFileInfo;
  bytes: Buffer;
}

export interface SavedTelegramMedia {
  kind: TelegramMediaKind;
  index: number;
  path: string;
  metadataPath: string;
  bytes: number;
  sourceKey: string;
  fileUniqueId?: string;
  messageId?: number | string;
  chatId?: number | string;
  messageThreadId?: number | string;
  fileName?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  title?: string;
  performer?: string;
  telegramFilePath?: string;
  transcription?: SavedTelegramMediaTranscription;
}

export interface FailedTelegramMedia {
  part: TelegramMediaPart;
  reason: string;
}

export interface SavedTelegramMediaTranscriptionSuccess {
  status: 'success';
  providerId: string;
  transcript: string;
  language?: string;
  durationMs?: number;
  fromCache?: boolean;
  cachePath?: string;
  metadataPath?: string;
}

export interface SavedTelegramMediaTranscriptionFailure {
  status: 'failed';
  providerId: string;
  code: string;
  message: string;
  durationMs?: number;
  cachePath?: string;
  metadataPath?: string;
}

export type SavedTelegramMediaTranscription =
  | SavedTelegramMediaTranscriptionSuccess
  | SavedTelegramMediaTranscriptionFailure;

export interface TelegramPromptInput {
  message: TelegramInboundMessage;
  savedMedia: SavedTelegramMedia[];
  failedMedia: FailedTelegramMedia[];
}

export type TelegramHttpsRequest = typeof httpsRequest;
