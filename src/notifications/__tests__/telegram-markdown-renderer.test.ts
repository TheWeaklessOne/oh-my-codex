import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { renderMarkdownToTelegramEntities } from '../telegram-markdown-renderer.js';

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

    assert.equal(rendered.text, 'docs bad (javascript:alert(1))');
    assert.deepEqual(rendered.entities, [
      {
        type: 'text_link',
        offset: 0,
        length: 'docs'.length,
        url: 'https://example.com/docs',
      },
    ]);
  });

  it('rejects hidden text links to local or token-bearing URLs', () => {
    const rendered = renderMarkdownToTelegramEntities([
      '[local](https://127.0.0.1:8443/)',
      '[signed](https://example.com/file?X-Amz-Signature=secret)',
    ].join(' '));

    assert.equal(
      rendered.text,
      'local (https://127.0.0.1:8443/) signed (https://example.com/file?X-Amz-Signature=secret)',
    );
    assert.deepEqual(rendered.entities, []);
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

  it('handles malformed Markdown without throwing', () => {
    const rendered = renderMarkdownToTelegramEntities('**unterminated [link](https://example.com');

    assert.ok(rendered.text.length > 0);
    assert.ok(Array.isArray(rendered.entities));
  });

  it('strips raw HTML to safe plain text', () => {
    const rendered = renderMarkdownToTelegramEntities('<b>bold</b><script>alert(1)</script>');

    assert.equal(rendered.text, 'boldalert(1)');
    assert.deepEqual(rendered.entities, []);
  });

  it('keeps UTF-16 offsets correct for mixed Cyrillic and emoji text', () => {
    const rendered = renderMarkdownToTelegramEntities('Привет **мир 😀**');

    assert.equal(rendered.text, 'Привет мир 😀');
    assert.deepEqual(rendered.entities, [
      { type: 'bold', offset: 'Привет '.length, length: 'мир 😀'.length },
    ]);
  });
});
