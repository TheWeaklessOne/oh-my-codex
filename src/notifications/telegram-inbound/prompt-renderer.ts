import type {
  FailedTelegramMedia,
  SavedTelegramMedia,
  SavedTelegramMediaTranscriptionFailure,
  SavedTelegramMediaTranscriptionSuccess,
  TelegramPromptInput,
} from './types.js';
import type {
  TelegramVoiceTranscriptionFallbackMode,
  TelegramVoiceTranscriptionInjectMode,
} from '../transcription/types.js';

const DEFAULT_TRANSCRIPTION_INJECT_MODE: TelegramVoiceTranscriptionInjectMode = 'transcript-only';
const DEFAULT_TRANSCRIPTION_FALLBACK_MODE: TelegramVoiceTranscriptionFallbackMode = 'attachment-with-diagnostic';
const DEFAULT_MAX_TRANSCRIPT_CHARS = 3_500;
const PROMPT_TRUNCATION_MARKER = '… [Telegram prompt truncated to fit limit]';

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

function shouldRenderSavedMediaPath(
  media: SavedTelegramMedia,
  injectMode: TelegramVoiceTranscriptionInjectMode,
): boolean {
  if (media.transcription?.status !== 'success') {
    return true;
  }
  return injectMode === 'transcript-with-attachment';
}

function truncateTranscript(text: string, maxTranscriptChars: number): string {
  const normalizedMax = Math.max(24, maxTranscriptChars);
  if (text.length <= normalizedMax) {
    return text;
  }
  const marker = `… [transcript truncated; original ${text.length} chars]`;
  const sliceLength = Math.max(1, normalizedMax - marker.length);
  return `${text.slice(0, sliceLength).trimEnd()}${marker}`;
}

function formatTranscriptLine(
  media: SavedTelegramMedia,
  transcription: SavedTelegramMediaTranscriptionSuccess,
  maxTranscriptChars: number,
): string {
  return `- ${media.kind}#${media.index}: ${truncateTranscript(transcription.transcript, maxTranscriptChars)}`;
}

function formatTranscriptionFailureLine(
  media: SavedTelegramMedia,
  transcription: SavedTelegramMediaTranscriptionFailure,
): string {
  const normalized = transcription.message.replace(/\s+/g, ' ').trim();
  return `- ${media.kind}#${media.index}: ${normalized || transcription.code}`;
}

export interface RenderTelegramPromptInputOptions {
  maxPromptChars?: number;
  maxTranscriptChars?: number;
  transcriptionInjectMode?: TelegramVoiceTranscriptionInjectMode;
  transcriptionFallbackMode?: TelegramVoiceTranscriptionFallbackMode;
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

function limitRenderedPrompt(
  rendered: string,
  maxPromptChars?: number,
  options: { preserveEdges?: boolean } = {},
): string {
  if (maxPromptChars === undefined || rendered.length <= maxPromptChars) {
    return rendered;
  }
  if (maxPromptChars <= PROMPT_TRUNCATION_MARKER.length + 1) {
    return PROMPT_TRUNCATION_MARKER.slice(0, maxPromptChars);
  }
  if (options.preserveEdges) {
    const budget = maxPromptChars - PROMPT_TRUNCATION_MARKER.length;
    const headChars = Math.ceil(budget / 2);
    const tailChars = Math.max(1, budget - headChars);
    return `${rendered.slice(0, headChars).trimEnd()}${PROMPT_TRUNCATION_MARKER}${rendered.slice(-tailChars).trimStart()}`;
  }
  return `${rendered.slice(0, maxPromptChars - PROMPT_TRUNCATION_MARKER.length).trimEnd()}${PROMPT_TRUNCATION_MARKER}`;
}

function buildSavedMediaLines(
  savedMedia: SavedTelegramMedia[],
  injectMode: TelegramVoiceTranscriptionInjectMode,
): string[] {
  const rendered = savedMedia.filter((media) => shouldRenderSavedMediaPath(media, injectMode));
  if (rendered.length === 0) {
    return [];
  }
  return [
    `Telegram attachment${rendered.length === 1 ? '' : 's'} saved locally:`,
    ...rendered.map(formatSavedMedia),
  ];
}

function buildFailedDownloadLines(failedMedia: FailedTelegramMedia[]): string[] {
  if (failedMedia.length === 0) {
    return [];
  }
  return [
    `Telegram attachment${failedMedia.length === 1 ? '' : 's'} could not be saved:`,
    ...failedMedia.map(formatFailedMedia),
  ];
}

function renderWithoutTranscription(
  text: string,
  savedMedia: SavedTelegramMedia[],
  failedMedia: FailedTelegramMedia[],
  maxPromptChars?: number,
): string {
  const mediaLines = [
    ...buildSavedMediaLines(savedMedia, 'transcript-with-attachment'),
    ...buildFailedDownloadLines(failedMedia),
  ];
  const renderedText = truncateTextBeforeMedia(text, mediaLines, maxPromptChars);
  const parts = renderedText ? [renderedText, ...mediaLines] : mediaLines;
  return parts.join('\n').trim();
}

export function renderTelegramPromptInput(
  input: TelegramPromptInput,
  options: RenderTelegramPromptInputOptions = {},
): string {
  const text = input.message.textPart?.text.trim() ?? '';
  const injectMode = options.transcriptionInjectMode ?? DEFAULT_TRANSCRIPTION_INJECT_MODE;
  const fallbackMode = options.transcriptionFallbackMode ?? DEFAULT_TRANSCRIPTION_FALLBACK_MODE;
  const maxTranscriptChars = options.maxTranscriptChars ?? DEFAULT_MAX_TRANSCRIPT_CHARS;
  const successfulTranscripts = input.savedMedia.filter((media) => media.transcription?.status === 'success');
  const failedTranscriptions = input.savedMedia.filter((media) => media.transcription?.status === 'failed');

  if (successfulTranscripts.length === 0 && failedTranscriptions.length === 0) {
    return renderWithoutTranscription(text, input.savedMedia, input.failedMedia, options.maxPromptChars);
  }

  const savedMediaLines = buildSavedMediaLines(input.savedMedia, injectMode);
  const failedDownloadLines = buildFailedDownloadLines(input.failedMedia);
  const transcriptLines = successfulTranscripts.map((media) => formatTranscriptLine(
    media,
    media.transcription as SavedTelegramMediaTranscriptionSuccess,
    maxTranscriptChars,
  ));
  const transcriptionFailureLines = fallbackMode === 'attachment-with-diagnostic'
    ? failedTranscriptions.map((media) => formatTranscriptionFailureLine(
        media,
        media.transcription as SavedTelegramMediaTranscriptionFailure,
      ))
    : [];

  if (
    !text
    && transcriptLines.length === 1
    && savedMediaLines.length === 0
    && failedDownloadLines.length === 0
    && transcriptionFailureLines.length === 0
  ) {
    return limitRenderedPrompt(transcriptLines[0].replace(/^- [^:]+: /, ''), options.maxPromptChars);
  }

  const blocks: string[] = [];
  const nonTextLines: string[] = [];

  if (transcriptLines.length > 0) {
    const transcriptBlock = [
      `Telegram voice transcript${transcriptLines.length === 1 ? '' : 's'}:`,
      ...transcriptLines,
    ].join('\n');
    blocks.push(transcriptBlock);
    nonTextLines.push(...transcriptBlock.split('\n'));
  }

  if (savedMediaLines.length > 0) {
    const savedBlock = savedMediaLines.join('\n');
    blocks.push(savedBlock);
    nonTextLines.push(...savedMediaLines);
  }

  if (transcriptionFailureLines.length > 0) {
    const failureBlock = [
      `Telegram voice transcription failed${transcriptionFailureLines.length === 1 ? '' : 's'}:`,
      ...transcriptionFailureLines,
    ].join('\n');
    blocks.push(failureBlock);
    nonTextLines.push(...failureBlock.split('\n'));
  }

  if (failedDownloadLines.length > 0) {
    const failedDownloadBlock = failedDownloadLines.join('\n');
    blocks.push(failedDownloadBlock);
    nonTextLines.push(...failedDownloadLines);
  }

  const renderedText = truncateTextBeforeMedia(text, nonTextLines, options.maxPromptChars);
  const rendered = (renderedText ? [renderedText, ...blocks] : blocks).join('\n\n').trim();
  if (
    options.maxPromptChars !== undefined
    && rendered.length > options.maxPromptChars
    && (savedMediaLines.length > 0 || transcriptionFailureLines.length > 0 || failedDownloadLines.length > 0)
  ) {
    return rendered;
  }
  return limitRenderedPrompt(rendered, options.maxPromptChars, { preserveEdges: nonTextLines.length > 0 });
}
