import { basename } from "node:path";
import { coerceTelegramMessageThreadId, type TelegramResolvedDestination } from "../telegram-topics.js";
import type { RichContentPart } from "../types.js";
import { mimeTypeForPath } from "../rich-content.js";
import type { TelegramChatAction, TelegramMediaRequest, TelegramOutboundMethod } from "./types.js";

const TELEGRAM_CAPTION_MAX_LENGTH = 1024;

function truncateCaption(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.length > TELEGRAM_CAPTION_MAX_LENGTH
    ? `${value.slice(0, TELEGRAM_CAPTION_MAX_LENGTH - 1)}…`
    : value;
}

function mediaMethod(kind: Exclude<RichContentPart["kind"], "text">): TelegramOutboundMethod {
  switch (kind) {
    case "photo": return "sendPhoto";
    case "document": return "sendDocument";
    case "audio": return "sendAudio";
    case "voice": return "sendVoice";
    case "sticker": return "sendSticker";
    case "video": return "sendVideo";
    case "animation": return "sendAnimation";
    case "video_note": return "sendVideoNote";
  }
}

function mediaFieldName(kind: Exclude<RichContentPart["kind"], "text">): string {
  switch (kind) {
    case "photo": return "photo";
    case "document": return "document";
    case "audio": return "audio";
    case "voice": return "voice";
    case "sticker": return "sticker";
    case "video": return "video";
    case "animation": return "animation";
    case "video_note": return "video_note";
  }
}

function uploadChatAction(kind: Exclude<RichContentPart["kind"], "text">): TelegramChatAction {
  switch (kind) {
    case "photo": return "upload_photo";
    case "voice": return "upload_voice";
    case "sticker": return "choose_sticker";
    case "video_note": return "upload_video_note";
    case "video":
    case "animation": return "upload_video";
    case "document":
    case "audio": return "upload_document";
  }
}

function sourceValue(part: Exclude<RichContentPart, { kind: "text" }>): string | null {
  if (part.source.type === "telegram_file_id") return part.source.fileId;
  if (part.source.type === "https_url") return part.source.url;
  return null;
}

function addCommonFields(
  body: Record<string, unknown>,
  destination: TelegramResolvedDestination,
  replyToMessageId: string | number | undefined,
): void {
  body.chat_id = destination.chatId;
  if (replyToMessageId !== undefined) {
    body.reply_to_message_id = replyToMessageId;
  }
  if (destination.messageThreadId) {
    body.message_thread_id = coerceTelegramMessageThreadId(destination.messageThreadId);
  }
}

function addOptionalMediaFields(body: Record<string, unknown>, part: Exclude<RichContentPart, { kind: "text" }>): void {
  if ("caption" in part) {
    const caption = truncateCaption(part.caption);
    if (caption) body.caption = caption;
  }
  if (part.kind === "document") {
    if (part.filename) body.disable_content_type_detection = false;
  }
  if (part.kind === "audio") {
    if (part.title) body.title = part.title;
    if (part.performer) body.performer = part.performer;
  }
  if (part.kind === "voice" && part.durationSeconds) {
    body.duration = part.durationSeconds;
  }
}

export function buildTelegramMediaRequest(
  part: Exclude<RichContentPart, { kind: "text" }>,
  destination: TelegramResolvedDestination,
  replyToMessageId: string | number | undefined,
): TelegramMediaRequest {
  const methodName = mediaMethod(part.kind);
  const fieldName = mediaFieldName(part.kind);
  const body: Record<string, unknown> = {};
  addCommonFields(body, destination, replyToMessageId);
  addOptionalMediaFields(body, part);

  const remoteValue = sourceValue(part);
  if (remoteValue) {
    body[fieldName] = remoteValue;
    return {
      methodName,
      body,
      part,
    };
  }

  if (part.source.type !== "local_path") {
    throw new Error(`Unsupported Telegram media source for ${part.kind}`);
  }

  const filename = part.kind === "document" && part.filename
    ? part.filename
    : basename(part.source.path);
  return {
    methodName,
    body,
    part,
    chatAction: uploadChatAction(part.kind),
    localFile: {
      fieldName,
      path: part.source.path,
      filename,
      contentType: part.kind === "document" && part.mimeType
        ? part.mimeType
        : mimeTypeForPath(part.source.path),
    },
  };
}
