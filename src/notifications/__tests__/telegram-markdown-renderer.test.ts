import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { renderMarkdownToTelegramEntities } from '../telegram-markdown-renderer.js';
import {
  splitTelegramRenderedMessage,
  TELEGRAM_MESSAGE_MAX_LENGTH,
} from '../telegram-entities.js';

describe('renderMarkdownToTelegramEntities', () => {
  it('renders inline commands as code entities without backticks', () => {
    const rendered = renderMarkdownToTelegramEntities('Run `npm run build` now.');

    assert.equal(rendered.text, 'Run npm run build now.');
    assert.deepEqual(rendered.entities, [
      { type: 'code', offset: 'Run '.length, length: 'npm run build'.length },
    ]);
  });

  it('renders fenced code blocks as pre entities with safe language', () => {
    const rendered = renderMarkdownToTelegramEntities('```sh\nnpm test\n```');

    assert.equal(rendered.text, 'npm test');
    assert.deepEqual(rendered.entities, [
      { type: 'pre', offset: 0, length: 'npm test'.length, language: 'sh' },
    ]);
  });

  it('sanitizes unsafe fenced code language tokens with structured warnings', () => {
    const rendered = renderMarkdownToTelegramEntities('```../bad\nnpm test\n```');

    assert.equal(rendered.text, 'npm test');
    assert.deepEqual(rendered.entities, [
      { type: 'pre', offset: 0, length: 'npm test'.length },
    ]);
    assert.equal(rendered.structuredWarnings?.[0]?.code, 'pre-language-sanitized');
  });

  it('renders headings as bold text without literal heading markers', () => {
    const rendered = renderMarkdownToTelegramEntities('# Build ✅');

    assert.equal(rendered.text, 'Build ✅');
    assert.deepEqual(rendered.entities, [
      { type: 'bold', offset: 0, length: 'Build ✅'.length },
    ]);
  });

  it('renders strong, emphasis, and strikethrough entities', () => {
    const rendered = renderMarkdownToTelegramEntities('**bold** _em_ ~~gone~~');

    assert.equal(rendered.text, 'bold em gone');
    assert.deepEqual(rendered.entities, [
      { type: 'bold', offset: 0, length: 4 },
      { type: 'italic', offset: 5, length: 2 },
      { type: 'strikethrough', offset: 8, length: 4 },
    ]);
  });

  it('renders unordered, ordered, nested, and task lists readably', () => {
    const rendered = renderMarkdownToTelegramEntities([
      '- item',
      '  - child',
      '- [x] done',
      '- [ ] todo',
      '',
      '3. third',
    ].join('\n'));

    assert.match(rendered.text, /- item\n  - child/);
    assert.match(rendered.text, /- ☑ done/);
    assert.match(rendered.text, /- ☐ todo/);
    assert.match(rendered.text, /3\. third/);
  });

  it('renders safe links as text_link and unsafe links as plain text', () => {
    const rendered = renderMarkdownToTelegramEntities('[docs](https://example.com/docs) [bad](javascript:alert(1))');

    assert.equal(rendered.text, 'docs bad');
    assert.deepEqual(rendered.entities, [
      {
        type: 'text_link',
        offset: 0,
        length: 'docs'.length,
        url: 'https://example.com/docs',
      },
    ]);
    assert.equal(rendered.structuredWarnings?.[0]?.code, 'unsafe-url-dropped');
  });

  it('rejects hidden text links to local or token-bearing URLs', () => {
    const rendered = renderMarkdownToTelegramEntities([
      '[local](https://127.0.0.1:8443/)',
      '[signed](https://example.com/file?X-Amz-Signature=secret)',
    ].join(' '));

    assert.equal(
      rendered.text,
      'local signed',
    );
    assert.deepEqual(rendered.entities, []);
    assert.deepEqual(
      rendered.structuredWarnings?.map((warning) => warning.code),
      ['local-url-dropped', 'sensitive-url-dropped'],
    );
    assert.doesNotMatch(JSON.stringify(rendered.structuredWarnings), /secret/);
  });

  it('does not leak unsafe URLs from empty link labels', () => {
    const rendered = renderMarkdownToTelegramEntities('[](https://127.0.0.1:8443/?token=secret)');

    assert.equal(rendered.text, 'link');
    assert.deepEqual(rendered.entities, []);
    assert.equal(rendered.structuredWarnings?.[0]?.code, 'local-url-dropped');
    assert.doesNotMatch(JSON.stringify(rendered.structuredWarnings), /secret/);
  });

  it('resolves reference-style links and hides definition metadata', () => {
    const rendered = renderMarkdownToTelegramEntities('[docs][d]\n\n[d]: https://example.com/docs');

    assert.equal(rendered.text, 'docs');
    assert.deepEqual(rendered.entities, [
      { type: 'text_link', offset: 0, length: 'docs'.length, url: 'https://example.com/docs' },
    ]);
  });

  it('keeps unsafe reference-style link definitions hidden', () => {
    const rendered = renderMarkdownToTelegramEntities('[local][d]\n\n[d]: https://[::1]/build');

    assert.equal(rendered.text, 'local');
    assert.deepEqual(rendered.entities, []);
  });

  it('degrades images and image references to plain text without link entities', () => {
    const rendered = renderMarkdownToTelegramEntities([
      '![diagram](https://example.com/diagram.png)',
      '![logo][img]',
      '![](https://example.com/hidden.png)',
      '![][hidden]',
      '',
      '[img]: https://example.com/logo.png',
      '[hidden]: https://example.com/hidden-ref.png',
    ].join('\n'));

    assert.equal(rendered.text, 'diagram\nlogo\nimage\nhidden');
    assert.deepEqual(rendered.entities, []);
    assert.ok(rendered.structuredWarnings?.every((warning) => warning.code === 'image-degraded'));
  });

  it('renders blockquotes with legal nested inline formatting', () => {
    const rendered = renderMarkdownToTelegramEntities('> quoted **text**');

    assert.equal(rendered.text, 'quoted text');
    assert.deepEqual(rendered.entities, [
      { type: 'blockquote', offset: 0, length: 'quoted text'.length },
      { type: 'bold', offset: 'quoted '.length, length: 'text'.length },
    ]);
  });

  it('renders GFM tables as readable pre text', () => {
    const rendered = renderMarkdownToTelegramEntities('| Name | Value |\n| --- | --- |\n| Build | Pass |');

    assert.match(rendered.text, /Name\s+\| Value/);
    assert.match(rendered.text, /Build\s+\| Pass/);
    assert.deepEqual(rendered.entities, [
      { type: 'pre', offset: 0, length: rendered.text.length },
    ]);
  });

  it('renders wide GFM tables as mobile-friendly cards instead of pre text', () => {
    const rendered = renderMarkdownToTelegramEntities([
      '| Feature | Result | Owner | Notes | Extra |',
      '| --- | --- | --- | --- | --- |',
      '| entities | pass | bot | handles **bold** | 🚀 |',
      '| fallback | pass | bot | strips unsafe links | 🛡️ |',
    ].join('\n'));

    assert.match(rendered.text, /^Feature: entities\nResult: pass\nOwner: bot/m);
    assert.match(rendered.text, /\n---\nFeature: fallback\nResult: pass/m);
    assert.deepEqual(rendered.entities, []);
    assert.equal(rendered.structuredWarnings?.[0]?.code, 'table-rendered-as-cards');
  });

  it('renders tables with empty Cyrillic and emoji cells readably', () => {
    const rendered = renderMarkdownToTelegramEntities([
      '| Фича | Итог | Emoji | Notes | Extra |',
      '| --- | --- | --- | --- | --- |',
      '| сущности | пройдены | 😀 |  | 🚀 |',
    ].join('\n'));

    assert.match(rendered.text, /Фича: сущности/);
    assert.match(rendered.text, /Notes: —/);
    assert.match(rendered.text, /Emoji: 😀/);
  });

  it('does not break neighboring entities around a wide table', () => {
    const rendered = renderMarkdownToTelegramEntities([
      '**Before**',
      '',
      '| Feature | Result | Owner | Notes | Extra |',
      '| --- | --- | --- | --- | --- |',
      '| entities | pass | bot | handles cards | 🚀 |',
      '',
      '`After`',
    ].join('\n'));

    assert.match(rendered.text, /^Before\n\nFeature: entities/m);
    assert.match(rendered.text, /🚀\n\nAfter$/m);
    assert.deepEqual(rendered.entities, [
      { type: 'bold', offset: 0, length: 'Before'.length },
      {
        type: 'code',
        offset: rendered.text.length - 'After'.length,
        length: 'After'.length,
      },
    ]);
  });

  it('allows long card table output to chunk safely downstream', () => {
    const rows = Array.from({ length: 180 }, (_unused, index) => (
      `| feature-${index} | pass | bot | ${'note '.repeat(8)} | 🚀 |`
    ));
    const rendered = renderMarkdownToTelegramEntities([
      '| Feature | Result | Owner | Notes | Extra |',
      '| --- | --- | --- | --- | --- |',
      ...rows,
    ].join('\n'));
    const chunks = splitTelegramRenderedMessage(rendered);

    assert.equal(rendered.structuredWarnings?.[0]?.code, 'table-rendered-as-cards');
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((chunk) => chunk.text.length <= TELEGRAM_MESSAGE_MAX_LENGTH));
  });

  it('degrades table cell images and raw HTML without leaking unsafe URLs or tags', () => {
    const rendered = renderMarkdownToTelegramEntities([
      '| A | B | C | D | E |',
      '| --- | --- | --- | --- | --- |',
      '| [safe](https://example.com) | [bad](https://127.0.0.1:8443/?token=secret) | ![](https://127.0.0.1/p.png) | <script>alert(1)</script> | text |',
    ].join('\n'));

    assert.equal(
      rendered.text,
      [
        'A: safe',
        'B: bad',
        'C: image',
        'D: alert(1)',
        'E: text',
      ].join('\n'),
    );
    assert.doesNotMatch(rendered.text, /127\.0\.0\.1|token=secret|<script>/);
    assert.deepEqual(rendered.entities, []);
    assert.deepEqual(
      rendered.structuredWarnings?.map((warning) => warning.code),
      [
        'local-url-dropped',
        'image-degraded',
        'raw-html-degraded',
        'raw-html-degraded',
        'table-rendered-as-cards',
      ],
    );
  });

  it('renders explicit spoiler delimiters as Telegram spoiler entities', () => {
    const rendered = renderMarkdownToTelegramEntities('Visible ||secret 😀|| done');

    assert.equal(rendered.text, 'Visible secret 😀 done');
    assert.deepEqual(rendered.entities, [
      { type: 'spoiler', offset: 'Visible '.length, length: 'secret 😀'.length },
    ]);
  });

  it('keeps underline unsupported via raw HTML graceful degradation', () => {
    const rendered = renderMarkdownToTelegramEntities('<u>under</u>');

    assert.equal(rendered.text, 'under');
    assert.deepEqual(rendered.entities, []);
    assert.ok(rendered.structuredWarnings?.some((warning) => warning.code === 'raw-html-degraded'));
  });

  it('renders explicit expandable blockquote marker as Telegram expandable blockquote', () => {
    const rendered = renderMarkdownToTelegramEntities('> [!EXPANDABLE]\n> hidden **quote**');

    assert.equal(rendered.text, 'hidden quote');
    assert.deepEqual(rendered.entities, [
      { type: 'expandable_blockquote', offset: 0, length: 'hidden quote'.length },
      { type: 'bold', offset: 'hidden '.length, length: 'quote'.length },
    ]);
  });

  it('denies tg links by default', () => {
    const rendered = renderMarkdownToTelegramEntities('[user](tg://user?id=123)');

    assert.equal(rendered.text, 'user');
    assert.deepEqual(rendered.entities, []);
    assert.equal(rendered.structuredWarnings?.[0]?.code, 'unsafe-url-dropped');
  });

  it('degrades unsupported GFM footnote nodes to visible safe text with warnings', () => {
    const rendered = renderMarkdownToTelegramEntities('text [^1]\n\n[^1]: footnote');

    assert.equal(rendered.text, 'text [1]\n\nfootnote');
    assert.deepEqual(rendered.entities, []);
    assert.deepEqual(
      rendered.structuredWarnings?.map((warning) => warning.code),
      ['unsupported-node-degraded', 'unsupported-node-degraded'],
    );
    assert.doesNotMatch(rendered.text, /\[\^1\]/u);
  });

  it('handles malformed Markdown without throwing', () => {
    const rendered = renderMarkdownToTelegramEntities('**unterminated [link](https://example.com');

    assert.ok(rendered.text.length > 0);
    assert.ok(Array.isArray(rendered.entities));
  });

  it('strips raw HTML to safe plain text', () => {
    const rendered = renderMarkdownToTelegramEntities('<b>bold</b><script>alert(1)</script>');

    assert.equal(rendered.text, 'boldalert(1)');
    assert.deepEqual(rendered.entities, []);
    assert.ok(rendered.structuredWarnings?.some((warning) => warning.code === 'raw-html-degraded'));
  });

  it('keeps UTF-16 offsets correct for mixed Cyrillic and emoji text', () => {
    const rendered = renderMarkdownToTelegramEntities('Привет **мир 😀**');

    assert.equal(rendered.text, 'Привет мир 😀');
    assert.deepEqual(rendered.entities, [
      { type: 'bold', offset: 'Привет '.length, length: 'мир 😀'.length },
    ]);
  });
});
