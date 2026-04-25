import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { renderMarkdownToTelegramEntities } from '../telegram-markdown-renderer.js';
import type { TelegramMessageEntity, TelegramRenderWarningCode } from '../types.js';

interface TelegramRenderingFixture {
  name: string;
  markdown: string;
  expectedText: string;
  expectedEntities?: TelegramMessageEntity[];
  expectedWarningCodes?: TelegramRenderWarningCode[];
}

const fixtures: TelegramRenderingFixture[] = [
  {
    name: 'inline code command',
    markdown: 'Run `npm run build`.',
    expectedText: 'Run npm run build.',
    expectedEntities: [
      { type: 'code', offset: 'Run '.length, length: 'npm run build'.length },
    ],
  },
  {
    name: 'fenced code with language',
    markdown: '```ts\nconst ok = true;\n```',
    expectedText: 'const ok = true;',
    expectedEntities: [
      { type: 'pre', offset: 0, length: 'const ok = true;'.length, language: 'ts' },
    ],
  },
  {
    name: 'heading',
    markdown: '## Ship it',
    expectedText: 'Ship it',
    expectedEntities: [{ type: 'bold', offset: 0, length: 'Ship it'.length }],
  },
  {
    name: 'strong emphasis strikethrough',
    markdown: '**bold** _em_ ~~gone~~',
    expectedText: 'bold em gone',
    expectedEntities: [
      { type: 'bold', offset: 0, length: 4 },
      { type: 'italic', offset: 5, length: 2 },
      { type: 'strikethrough', offset: 8, length: 4 },
    ],
  },
  {
    name: 'safe unsafe and reference links',
    markdown: '[docs](https://example.com/docs) [bad](javascript:alert(1)) [ref][r]\n\n[r]: https://example.com/ref',
    expectedText: 'docs bad ref',
    expectedEntities: [
      { type: 'text_link', offset: 0, length: 4, url: 'https://example.com/docs' },
      { type: 'text_link', offset: 'docs bad '.length, length: 3, url: 'https://example.com/ref' },
    ],
    expectedWarningCodes: ['unsafe-url-dropped'],
  },
  {
    name: 'blockquote with nested bold',
    markdown: '> quoted **text**',
    expectedText: 'quoted text',
    expectedEntities: [
      { type: 'blockquote', offset: 0, length: 'quoted text'.length },
      { type: 'bold', offset: 'quoted '.length, length: 'text'.length },
    ],
  },
  {
    name: 'narrow table',
    markdown: '| Name | Value |\n| --- | --- |\n| Build | Pass |',
    expectedText: 'Name  | Value\nBuild | Pass',
    expectedEntities: [
      { type: 'pre', offset: 0, length: 'Name  | Value\nBuild | Pass'.length },
    ],
  },
  {
    name: 'wide table cards',
    markdown: '| Feature | Result | Owner | Notes | Extra |\n| --- | --- | --- | --- | --- |\n| entities | pass | bot | handles cards | 🚀 |',
    expectedText: 'Feature: entities\nResult: pass\nOwner: bot\nNotes: handles cards\nExtra: 🚀',
    expectedWarningCodes: ['table-rendered-as-cards'],
  },
  {
    name: 'task and nested lists',
    markdown: '- [x] done\n- item\n  - child',
    expectedText: '- ☑ done\n- item\n  - child',
  },
  {
    name: 'Cyrillic emoji UTF-16',
    markdown: 'Привет **мир 😀**',
    expectedText: 'Привет мир 😀',
    expectedEntities: [
      { type: 'bold', offset: 'Привет '.length, length: 'мир 😀'.length },
    ],
  },
  {
    name: 'malformed markdown remains safe text',
    markdown: '**unterminated [link](https://example.com',
    expectedText: '**unterminated [link](https://example.com',
    expectedEntities: [
      {
        type: 'text_link',
        offset: '**unterminated [link]('.length,
        length: 'https://example.com'.length,
        url: 'https://example.com',
      },
    ],
  },
  {
    name: 'raw HTML and image degrade',
    markdown: '<b>bold</b> ![diagram](https://example.com/diagram.png)',
    expectedText: 'bold diagram',
    expectedWarningCodes: ['raw-html-degraded', 'raw-html-degraded', 'image-degraded'],
  },
  {
    name: 'spoiler syntax',
    markdown: 'Visible ||secret||',
    expectedText: 'Visible secret',
    expectedEntities: [
      { type: 'spoiler', offset: 'Visible '.length, length: 'secret'.length },
    ],
  },
  {
    name: 'underline graceful degradation',
    markdown: '<u>under</u>',
    expectedText: 'under',
    expectedWarningCodes: ['raw-html-degraded', 'raw-html-degraded'],
  },
  {
    name: 'expandable blockquote syntax',
    markdown: '> [!EXPANDABLE]\n> hidden quote',
    expectedText: 'hidden quote',
    expectedEntities: [
      { type: 'expandable_blockquote', offset: 0, length: 'hidden quote'.length },
    ],
  },
  {
    name: 'tg links denied',
    markdown: '[user](tg://user?id=123)',
    expectedText: 'user',
    expectedWarningCodes: ['unsafe-url-dropped'],
  },
  {
    name: 'unsupported GFM footnotes degrade visibly',
    markdown: 'text [^1]\n\n[^1]: footnote',
    expectedText: 'text [1]\n\nfootnote',
    expectedWarningCodes: ['unsupported-node-degraded', 'unsupported-node-degraded'],
  },
];

describe('Telegram Markdown rendering golden fixtures', () => {
  for (const fixture of fixtures) {
    it(fixture.name, () => {
      const rendered = renderMarkdownToTelegramEntities(fixture.markdown);

      assert.equal(rendered.text, fixture.expectedText);
      assert.deepEqual(rendered.entities, fixture.expectedEntities ?? []);
      assert.deepEqual(
        rendered.structuredWarnings?.map((warning) => warning.code) ?? [],
        fixture.expectedWarningCodes ?? [],
      );
    });
  }
});
