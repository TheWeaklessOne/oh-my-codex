import type { RichContentPart } from "../types.js";

export type TelegramOutboundMethod =
  | "sendMessage"
  | "sendPhoto"
  | "sendDocument"
  | "sendAudio"
  | "sendVoice"
  | "sendSticker"
  | "sendVideo"
  | "sendAnimation"
  | "sendVideoNote";

export type TelegramChatAction =
  | "typing"
  | "upload_photo"
  | "upload_document"
  | "record_voice"
  | "upload_voice"
  | "upload_video"
  | "upload_video_note"
  | "choose_sticker";

export interface TelegramLocalFileUpload {
  fieldName: string;
  path: string;
  filename?: string;
  contentType?: string;
}

export interface TelegramMediaRequest {
  methodName: TelegramOutboundMethod;
  body: Record<string, unknown>;
  part: Exclude<RichContentPart, { kind: "text" }>;
  chatAction?: TelegramChatAction;
  localFile?: TelegramLocalFileUpload;
}
