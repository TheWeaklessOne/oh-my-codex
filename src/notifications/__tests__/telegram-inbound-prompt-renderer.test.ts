import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildInjectedReplyInput } from '../reply-listener.js';
import { renderTelegramPromptInput } from '../telegram-inbound/prompt-renderer.js';
import type { TelegramPromptInput } from '../telegram-inbound/types.js';

function input(overrides: Partial<TelegramPromptInput> = {}): TelegramPromptInput {
  return {
    message: {
      messageId: 333,
      chatId: 777,
      textPart: { kind: 'text', source: 'caption', text: 'caption first' },
      mediaParts: [],
      rawMessage: {},
    },
    savedMedia: [],
    failedMedia: [],
    ...overrides,
  };
}

describe('telegram inbound prompt renderer', () => {
  it('renders caption text before saved attachment paths and metadata', () => {
    const rendered = renderTelegramPromptInput(input({
      savedMedia: [{
        kind: 'photo',
        index: 1,
        path: '/tmp/photo.jpg',
        metadataPath: '/tmp/photo.jpg.metadata.json',
        bytes: 12,
        sourceKey: 'telegram-123456-777',
        mimeType: 'image/jpeg',
        width: 1170,
        height: 2532,
      }],
    }));

    assert.match(rendered, /^caption first\nTelegram attachment saved locally:/);
    assert.match(rendered, /\/tmp\/photo\.jpg \(photo, image\/jpeg, 1170x2532, 12 bytes\)/);
  });

  it('renders multiple media parts deterministically', () => {
    const rendered = renderTelegramPromptInput(input({
      savedMedia: [
        {
          kind: 'document',
          index: 1,
          path: '/tmp/doc.png',
          metadataPath: '/tmp/doc.png.metadata.json',
          bytes: 5,
          sourceKey: 'telegram',
          mimeType: 'image/png',
          fileName: 'doc.png',
        },
        {
          kind: 'audio',
          index: 2,
          path: '/tmp/audio.mp3',
          metadataPath: '/tmp/audio.mp3.metadata.json',
          bytes: 7,
          sourceKey: 'telegram',
          mimeType: 'audio/mpeg',
          durationSeconds: 42,
        },
      ],
    }));

    assert.match(rendered, /Telegram attachments saved locally:/);
    assert.ok(rendered.indexOf('/tmp/doc.png') < rendered.indexOf('/tmp/audio.mp3'));
    assert.match(rendered, /audio, audio\/mpeg, 42s, 7 bytes/);
  });

  it('includes failed-download diagnostics without dropping user text', () => {
    const rendered = renderTelegramPromptInput(input({
      failedMedia: [{
        part: { kind: 'media', mediaKind: 'voice', index: 1, fileId: 'voice-id' },
        reason: 'HTTP 500',
      }],
    }));

    assert.match(rendered, /^caption first/);
    assert.match(rendered, /Telegram attachment could not be saved:/);
    assert.match(rendered, /voice#1: HTTP 500/);
  });

  it('truncates long text before media so saved attachment paths survive prompt limits', () => {
    const rendered = renderTelegramPromptInput(
      input({
        message: {
          messageId: 333,
          chatId: 777,
          textPart: { kind: 'text', source: 'caption', text: 'x'.repeat(600) },
          mediaParts: [],
          rawMessage: {},
        },
        savedMedia: [{
          kind: 'photo',
          index: 1,
          path: '/tmp/telegram-attachment/photo.jpg',
          metadataPath: '/tmp/telegram-attachment/photo.jpg.metadata.json',
          bytes: 12,
          sourceKey: 'telegram',
          mimeType: 'image/jpeg',
        }],
      }),
      { maxPromptChars: 160 },
    );

    assert.ok(rendered.length <= 160);
    assert.match(rendered, /^x+…\nTelegram attachment saved locally:/);
    assert.match(rendered, /\/tmp\/telegram-attachment\/photo\.jpg/);
  });

  it('produces stable text compatible with buildInjectedReplyInput sanitization', () => {
    const rendered = renderTelegramPromptInput(input({
      message: {
        messageId: 333,
        chatId: 777,
        textPart: { kind: 'text', source: 'text', text: 'check $(whoami)\nthen file' },
        mediaParts: [],
        rawMessage: {},
      },
      savedMedia: [{
        kind: 'voice',
        index: 1,
        path: '/tmp/voice.ogg',
        metadataPath: '/tmp/voice.ogg.metadata.json',
        bytes: 3,
        sourceKey: 'telegram',
        mimeType: 'audio/ogg',
        durationSeconds: 5,
      }],
    }));
    const injected = buildInjectedReplyInput(rendered, 'telegram', {
      includePrefix: true,
      maxMessageLength: 1000,
    });

    assert.match(injected, /^\[reply:telegram\]/);
    assert.equal(injected.includes('\n'), false);
    assert.match(injected, /\\\$\(whoami\)/);
    assert.match(injected, /\/tmp\/voice\.ogg/);
  });

  it('renders successful voice transcription as transcript-only by default', () => {
    const rendered = renderTelegramPromptInput(input({
      message: {
        messageId: 333,
        chatId: 777,
        mediaParts: [],
        rawMessage: {},
      },
      savedMedia: [{
        kind: 'voice',
        index: 1,
        path: '/tmp/voice.ogg',
        metadataPath: '/tmp/voice.ogg.metadata.json',
        bytes: 3,
        sourceKey: 'telegram',
        mimeType: 'audio/ogg',
        transcription: {
          status: 'success',
          providerId: 'fake-local',
          transcript: 'transcribed speech',
        },
      }],
    }));

    assert.equal(rendered, 'transcribed speech');
    assert.doesNotMatch(rendered, /\/tmp\/voice\.ogg/);
  });

  it('renders caption before transcript block and can include the attachment path when requested', () => {
    const rendered = renderTelegramPromptInput(input({
      savedMedia: [{
        kind: 'voice',
        index: 1,
        path: '/tmp/voice.ogg',
        metadataPath: '/tmp/voice.ogg.metadata.json',
        bytes: 3,
        sourceKey: 'telegram',
        mimeType: 'audio/ogg',
        transcription: {
          status: 'success',
          providerId: 'fake-local',
          transcript: 'captioned speech',
        },
      }],
    }), {
      transcriptionInjectMode: 'transcript-with-attachment',
    });

    assert.match(rendered, /^caption first\n\nTelegram voice transcript:\n- voice#1: captioned speech/);
    assert.match(rendered, /Telegram attachment saved locally:/);
    assert.match(rendered, /\/tmp\/voice\.ogg/);
  });

  it('renders transcription failure as saved path plus bounded diagnostic', () => {
    const rendered = renderTelegramPromptInput(input({
      savedMedia: [{
        kind: 'voice',
        index: 1,
        path: '/tmp/voice.ogg',
        metadataPath: '/tmp/voice.ogg.metadata.json',
        bytes: 3,
        sourceKey: 'telegram',
        mimeType: 'audio/ogg',
        transcription: {
          status: 'failed',
          providerId: 'fake-local',
          code: 'process-failed',
          message: 'local binary failed',
        },
      }],
    }));

    assert.match(rendered, /Telegram attachment saved locally:/);
    assert.match(rendered, /\/tmp\/voice\.ogg/);
    assert.match(rendered, /Telegram voice transcription failed:/);
    assert.match(rendered, /voice#1: local binary failed/);
  });

  it('supports attachment-on-failure and attachment-only transcription rendering modes', () => {
    const success = renderTelegramPromptInput(input({
      savedMedia: [{
        kind: 'voice',
        index: 1,
        path: '/tmp/success.ogg',
        metadataPath: '/tmp/success.ogg.metadata.json',
        bytes: 3,
        sourceKey: 'telegram',
        mimeType: 'audio/ogg',
        transcription: {
          status: 'success',
          providerId: 'fake-local',
          transcript: 'success speech',
        },
      }],
    }), { transcriptionInjectMode: 'attachment-on-failure' });

    assert.match(success, /success speech/);
    assert.doesNotMatch(success, /\/tmp\/success\.ogg/);

    const failure = renderTelegramPromptInput(input({
      savedMedia: [{
        kind: 'voice',
        index: 1,
        path: '/tmp/failure.ogg',
        metadataPath: '/tmp/failure.ogg.metadata.json',
        bytes: 3,
        sourceKey: 'telegram',
        mimeType: 'audio/ogg',
        transcription: {
          status: 'failed',
          providerId: 'fake-local',
          code: 'process-failed',
          message: 'diagnostic should be hidden',
        },
      }],
    }), {
      transcriptionInjectMode: 'attachment-on-failure',
      transcriptionFallbackMode: 'attachment-only',
    });

    assert.match(failure, /\/tmp\/failure\.ogg/);
    assert.doesNotMatch(failure, /diagnostic should be hidden/);
    assert.doesNotMatch(failure, /Telegram voice transcription failed:/);
  });

  it('preserves failed transcription attachment and diagnostic when final prompt limiting is tight', () => {
    const rendered = renderTelegramPromptInput(input({
      message: {
        messageId: 333,
        chatId: 777,
        textPart: { kind: 'text', source: 'caption', text: 'x'.repeat(1000) },
        mediaParts: [],
        rawMessage: {},
      },
      savedMedia: [{
        kind: 'voice',
        index: 1,
        path: '/tmp/telegram-attachment/voice.ogg',
        metadataPath: '/tmp/telegram-attachment/voice.ogg.metadata.json',
        bytes: 3,
        sourceKey: 'telegram',
        mimeType: 'audio/ogg',
        transcription: {
          status: 'failed',
          providerId: 'fake-local',
          code: 'process-failed',
          message: 'local binary failed after timeout',
        },
      }],
    }), { maxPromptChars: 180 });

    assert.match(rendered, /\/tmp\/telegram-attachment\/voice\.ogg/);
    assert.match(rendered, /local binary failed after timeout/);
  });

  it('truncates long transcripts with a visible marker before final prompt limiting', () => {
    const rendered = renderTelegramPromptInput(input({
      message: {
        messageId: 333,
        chatId: 777,
        mediaParts: [],
        rawMessage: {},
      },
      savedMedia: [{
        kind: 'voice',
        index: 1,
        path: '/tmp/voice.ogg',
        metadataPath: '/tmp/voice.ogg.metadata.json',
        bytes: 3,
        sourceKey: 'telegram',
        mimeType: 'audio/ogg',
        transcription: {
          status: 'success',
          providerId: 'fake-local',
          transcript: 'x'.repeat(220),
        },
      }],
    }), { maxTranscriptChars: 120, maxPromptChars: 160 });

    assert.match(rendered, /\[transcript truncated; original 220 chars\]/);
    assert.ok(rendered.length <= 160);
  });
});
