import type { FailedTelegramMedia, SavedTelegramMedia, TelegramPromptInput } from './types.js';

function formatMetadata(media: SavedTelegramMedia): string {
  const details = [
    media.kind,
    media.mimeType,
    media.width !== undefined && media.height !== undefined ? `${media.width}x${media.height}` : '',
    media.durationSeconds !== undefined ? `${media.durationSeconds}s` : '',
    media.bytes !== undefined ? `${media.bytes} bytes` : '',
    media.fileName ? `name=${media.fileName}` : '',
    media.title ? `title=${media.title}` : '',
    media.performer ? `performer=${media.performer}` : '',
  ].filter(Boolean);
  return details.length > 0 ? ` (${details.join(', ')})` : '';
}

function formatSavedMedia(media: SavedTelegramMedia): string {
  return `- ${media.path}${formatMetadata(media)}`;
}

function formatFailedMedia(failed: FailedTelegramMedia): string {
  return `- ${failed.part.mediaKind}#${failed.part.index}: ${failed.reason}`;
}

export interface RenderTelegramPromptInputOptions {
  maxPromptChars?: number;
}

function truncateTextBeforeMedia(
  text: string,
  mediaLines: string[],
  maxPromptChars?: number,
): string {
  if (!text || mediaLines.length === 0 || maxPromptChars === undefined) {
    return text;
  }

  const mediaBlockChars = mediaLines.join('\n').length;
  const separatorChars = 1;
  const maxTextChars = maxPromptChars - mediaBlockChars - separatorChars;
  if (text.length <= maxTextChars) {
    return text;
  }
  if (maxTextChars < 1) {
    const fallbackSnippetChars = 80;
    return text.length <= fallbackSnippetChars
      ? text
      : `${text.slice(0, fallbackSnippetChars - 1).trimEnd()}…`;
  }
  if (maxTextChars === 1) {
    return '…';
  }
  return `${text.slice(0, maxTextChars - 1).trimEnd()}…`;
}

export function renderTelegramPromptInput(
  input: TelegramPromptInput,
  options: RenderTelegramPromptInputOptions = {},
): string {
  const text = input.message.textPart?.text.trim() ?? '';
  const mediaLines: string[] = [];

  if (input.savedMedia.length > 0) {
    mediaLines.push(
      `Telegram attachment${input.savedMedia.length === 1 ? '' : 's'} saved locally:`,
      ...input.savedMedia.map(formatSavedMedia),
    );
  }

  if (input.failedMedia.length > 0) {
    mediaLines.push(
      `Telegram attachment${input.failedMedia.length === 1 ? '' : 's'} could not be saved:`,
      ...input.failedMedia.map(formatFailedMedia),
    );
  }

  const renderedText = truncateTextBeforeMedia(text, mediaLines, options.maxPromptChars);
  const parts = renderedText ? [renderedText, ...mediaLines] : mediaLines;

  return parts.join('\n').trim();
}
