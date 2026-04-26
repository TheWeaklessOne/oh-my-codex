import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeTelegramMediaPart,
  getTelegramMediaHandler,
  sanitizeTelegramFilePart,
} from '../telegram-inbound/media-handlers.js';
import type { TelegramMediaPart } from '../telegram-inbound/types.js';

function part(overrides: Partial<TelegramMediaPart>): TelegramMediaPart {
  return {
    kind: 'media',
    mediaKind: 'document',
    index: 1,
    fileId: 'file-id',
    ...overrides,
  };
}

describe('telegram inbound media handlers', () => {
  it('infers photo extension from Telegram file path before MIME fallback', () => {
    const descriptor = describeTelegramMediaPart(part({ mediaKind: 'photo', mimeType: 'image/png' }), 'photos/file_1.webp');
    assert.equal(descriptor.extension, 'webp');
    assert.equal(descriptor.kind, 'photo');
  });

  it('infers document extension and safe stem from original filename', () => {
    const descriptor = describeTelegramMediaPart(part({ fileName: '../screenshots/failure.PNG', mimeType: 'image/png' }));
    assert.equal(descriptor.extension, 'png');
    assert.equal(descriptor.fileNameStem, 'failure');
    assert.equal(descriptor.originalFileName, '../screenshots/failure.PNG');
  });

  it('preserves audio metadata and infers extension from filename', () => {
    const descriptor = describeTelegramMediaPart(part({
      mediaKind: 'audio',
      fileName: 'episode.m4a',
      mimeType: 'audio/mpeg',
      durationSeconds: 321,
      title: 'Episode',
      performer: 'Host',
    }));
    assert.equal(descriptor.extension, 'm4a');
    assert.equal(descriptor.durationSeconds, 321);
    assert.equal(descriptor.title, 'Episode');
    assert.equal(descriptor.performer, 'Host');
  });

  it('infers voice extension from MIME and tolerates missing optional metadata', () => {
    const descriptor = getTelegramMediaHandler('voice').describe(part({ mediaKind: 'voice', mimeType: 'audio/ogg' }));
    assert.equal(descriptor.extension, 'ogg');
    assert.equal(descriptor.fileNameStem, 'voice-1');
  });

  it('sanitizes filenames and source-like keys', () => {
    assert.equal(sanitizeTelegramFilePart('../../bad name?.png', 'fallback'), 'bad-name-.png');
    assert.equal(sanitizeTelegramFilePart('   ', 'fallback'), 'fallback');
  });
});
