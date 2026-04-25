import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  isSafeTelegramLinkUrl,
  normalizeTelegramEntities,
  splitTelegramRenderedMessage,
  TELEGRAM_CONTINUATION_PREFIX,
  TELEGRAM_CONTINUATION_SUFFIX,
  TELEGRAM_MESSAGE_MAX_CHUNKS,
  TELEGRAM_MESSAGE_MAX_LENGTH,
  TelegramTextBuilder,
  utf16Length,
} from '../telegram-entities.js';
import type { TelegramMessageEntity } from '../types.js';

describe('telegram entity UTF-16 helpers', () => {
  it('counts UTF-16 code units for ASCII, Cyrillic, and emoji', () => {
    assert.equal(utf16Length('abc'), 3);
    assert.equal(utf16Length('Привет'), 6);
    assert.equal(utf16Length('😀'), 2);
    assert.equal(utf16Length('A😀Б'), 4);
  });

  it('builds text and entity ranges using UTF-16 offsets', () => {
    const builder = new TelegramTextBuilder();
    builder.append('Привет 😀 ');
    builder.withEntity('code', () => builder.append('npm run build'));

    const rendered = builder.toRenderedMessage();
    assert.equal(rendered.text, 'Привет 😀 npm run build');
    assert.deepEqual(rendered.entities, [
      { type: 'code', offset: 'Привет 😀 '.length, length: 'npm run build'.length },
    ]);
  });
});

describe('normalizeTelegramEntities', () => {
  it('trims trailing whitespace from entity ranges without shifting following offsets', () => {
    const normalized = normalizeTelegramEntities('bold  after', [
      { type: 'bold', offset: 0, length: 6 },
      { type: 'italic', offset: 6, length: 5 },
    ]);

    assert.deepEqual(normalized.entities, [
      { type: 'bold', offset: 0, length: 4 },
      { type: 'italic', offset: 6, length: 5 },
    ]);
    assert.equal(normalized.structuredWarnings?.[0]?.code, 'entity-trimmed');
  });

  it('drops empty entities after trimming', () => {
    const normalized = normalizeTelegramEntities('   x', [
      { type: 'bold', offset: 0, length: 3 },
    ]);

    assert.deepEqual(normalized.entities, []);
    assert.match(normalized.warnings.join('\n'), /after trailing whitespace trim/);
    assert.equal(normalized.structuredWarnings?.[0]?.code, 'entity-empty-after-trim-dropped');
  });

  it('sorts entities by offset and descending length for stable nesting', () => {
    const normalized = normalizeTelegramEntities('abcd', [
      { type: 'italic', offset: 0, length: 2 },
      { type: 'bold', offset: 0, length: 4 },
    ]);

    assert.deepEqual(normalized.entities, [
      { type: 'bold', offset: 0, length: 4 },
      { type: 'italic', offset: 0, length: 2 },
    ]);
  });

  it('drops illegal partial overlaps', () => {
    const normalized = normalizeTelegramEntities('abcdef', [
      { type: 'bold', offset: 0, length: 4 },
      { type: 'italic', offset: 2, length: 4 },
    ]);

    assert.deepEqual(normalized.entities, [
      { type: 'bold', offset: 0, length: 4 },
    ]);
    assert.match(normalized.warnings.join('\n'), /partial overlap/);
    assert.equal(normalized.structuredWarnings?.[0]?.code, 'partial-overlap-dropped');
  });

  it('keeps code/pre ranges and drops overlapping formatting', () => {
    const normalized = normalizeTelegramEntities('abcdef', [
      { type: 'bold', offset: 0, length: 6 },
      { type: 'code', offset: 2, length: 2 },
    ]);

    assert.deepEqual(normalized.entities, [
      { type: 'code', offset: 2, length: 2 },
    ]);
    assert.match(normalized.warnings.join('\n'), /overlapping code\/pre/);
    assert.equal(normalized.structuredWarnings?.[0]?.code, 'code-formatting-dropped');
  });

  it('drops nested blockquotes', () => {
    const normalized = normalizeTelegramEntities('quoted', [
      { type: 'blockquote', offset: 0, length: 6 },
      { type: 'blockquote', offset: 1, length: 3 },
    ]);

    assert.deepEqual(normalized.entities, [
      { type: 'blockquote', offset: 0, length: 6 },
    ]);
    assert.match(normalized.warnings.join('\n'), /nested Telegram blockquote/);
    assert.equal(normalized.structuredWarnings?.[0]?.code, 'nested-blockquote-dropped');
  });

  it('sanitizes text links and pre languages', () => {
    const entities: TelegramMessageEntity[] = [
      { type: 'text_link', offset: 0, length: 4, url: 'https://example.com' },
      { type: 'text_link', offset: 5, length: 4, url: 'javascript:alert(1)' },
      { type: 'pre', offset: 10, length: 4, language: 'ts' },
      { type: 'pre', offset: 15, length: 4, language: '../bad' },
    ];
    const normalized = normalizeTelegramEntities('safe bad  code code', entities);

    assert.deepEqual(normalized.entities, [
      { type: 'text_link', offset: 0, length: 4, url: 'https://example.com' },
      { type: 'pre', offset: 10, length: 4, language: 'ts' },
      { type: 'pre', offset: 15, length: 4 },
    ]);
    assert.match(normalized.warnings.join('\n'), /unsafe or invalid URL/);
    assert.match(normalized.warnings.join('\n'), /unsafe Telegram pre language/);
    assert.deepEqual(
      normalized.structuredWarnings.map((warning) => warning.code),
      ['unsafe-url-dropped', 'pre-language-sanitized'],
    );
  });

  it('rejects private, credentialed, and token-bearing text links', () => {
    for (const url of [
      'https://localhost/build',
      'https://127.0.0.1:8443/build',
      'https://10.0.0.5/build',
      'https://[::1]/build',
      'https://[fc00::1]/build',
      'https://[::ffff:127.0.0.1]/build',
      'https://127.0.0.1.nip.io/build',
      'https://127-0-0-1.sslip.io/build',
      'https://example.xip.io/build',
      'https://foo.lvh.me/build',
      'https://foo.localtest.me/build',
      'https://user:pass@example.com/build',
      'https://example.com/download?X-Amz-Signature=secret',
      'https://example.com/callback?access_token=secret',
    ]) {
      assert.equal(isSafeTelegramLinkUrl(url), false, url);
    }

    assert.equal(isSafeTelegramLinkUrl('https://example.com/docs'), true);
  });
});

describe('splitTelegramRenderedMessage', () => {
  it('does not split inside surrogate pairs', () => {
    const chunks = splitTelegramRenderedMessage({
      text: 'A😀B',
      entities: [],
      warnings: [],
    }, 2);

    assert.deepEqual(chunks.map((chunk) => chunk.text), ['A', '😀', 'B']);
  });

  it('remaps entity offsets per chunk', () => {
    const chunks = splitTelegramRenderedMessage({
      text: 'hello world',
      entities: [{ type: 'bold', offset: 6, length: 5 }],
      warnings: [],
    }, 6);

    assert.deepEqual(chunks.map((chunk) => chunk.text), ['hello ', 'world']);
    assert.deepEqual(chunks[1].entities, [
      { type: 'bold', offset: 0, length: 5 },
    ]);
  });

  it('splits oversized pre blocks into valid per-chunk pre entities', () => {
    const chunks = splitTelegramRenderedMessage({
      text: 'abcdef',
      entities: [{ type: 'pre', offset: 0, length: 6, language: 'ts' }],
      warnings: [],
    }, 3);

    assert.deepEqual(chunks.map((chunk) => chunk.text), ['abc', 'def']);
    assert.deepEqual(chunks.map((chunk) => chunk.entities), [
      [{ type: 'pre', offset: 0, length: 3, language: 'ts' }],
      [{ type: 'pre', offset: 0, length: 3, language: 'ts' }],
    ]);
  });

  it('caps untrusted long messages to a bounded number of chunks', () => {
    const chunks = splitTelegramRenderedMessage({
      text: 'x'.repeat((TELEGRAM_MESSAGE_MAX_CHUNKS + 2) * TELEGRAM_MESSAGE_MAX_LENGTH),
      entities: [],
      warnings: [],
    });

    assert.equal(chunks.length, TELEGRAM_MESSAGE_MAX_CHUNKS);
    assert.match(chunks[chunks.length - 1].text, /Telegram notification truncated/);
    assert.ok(chunks.every((chunk) => chunk.text.length <= TELEGRAM_MESSAGE_MAX_LENGTH));
    assert.match(chunks[0].text, /…continued$/);
    assert.ok(chunks[0].structuredWarnings?.some((warning) => warning.code === 'message-truncated'));
    assert.equal(
      chunks
        .slice(1)
        .some((chunk) => chunk.structuredWarnings?.some((warning) => warning.code === 'message-truncated')),
      false,
    );
  });

  it('adds continuation markers to multi-chunk messages without exceeding Telegram limits', () => {
    const chunks = splitTelegramRenderedMessage({
      text: `${'a'.repeat(TELEGRAM_MESSAGE_MAX_LENGTH)}tail`,
      entities: [],
      warnings: [],
    });

    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].text.endsWith(TELEGRAM_CONTINUATION_SUFFIX), true);
    assert.equal(chunks[1].text.startsWith(TELEGRAM_CONTINUATION_PREFIX), true);
    assert.ok(chunks.every((chunk) => chunk.text.length <= TELEGRAM_MESSAGE_MAX_LENGTH));
  });

  it('does not add continuation markers to single-chunk messages', () => {
    const chunks = splitTelegramRenderedMessage({
      text: 'short message',
      entities: [],
      warnings: [],
    });

    assert.deepEqual(chunks.map((chunk) => chunk.text), ['short message']);
  });

  it('remaps entity offsets after a continuation prefix', () => {
    const chunks = splitTelegramRenderedMessage({
      text: `${'a'.repeat(TELEGRAM_MESSAGE_MAX_LENGTH)}code`,
      entities: [{ type: 'code', offset: TELEGRAM_MESSAGE_MAX_LENGTH, length: 4 }],
      warnings: [],
    });

    assert.equal(chunks.length, 2);
    assert.equal(chunks[1].text.startsWith(TELEGRAM_CONTINUATION_PREFIX), true);
    assert.deepEqual(chunks[1].entities, [
      {
        type: 'code',
        offset: TELEGRAM_CONTINUATION_PREFIX.length
          + TELEGRAM_CONTINUATION_SUFFIX.length,
        length: 4,
      },
    ]);
  });

  it('keeps marker splits UTF-16 safe for surrogate pairs', () => {
    const contentBudget = TELEGRAM_MESSAGE_MAX_LENGTH - TELEGRAM_CONTINUATION_SUFFIX.length;
    const chunks = splitTelegramRenderedMessage({
      text: `${'a'.repeat(contentBudget - 1)}😀${'tail'.repeat(8)}`,
      entities: [],
      warnings: [],
    });

    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].text.endsWith(TELEGRAM_CONTINUATION_SUFFIX), true);
    assert.doesNotMatch(chunks[0].text, /\ud83d$/u);
    assert.doesNotMatch(chunks[1].text, /^\ude00/u);
  });
});
