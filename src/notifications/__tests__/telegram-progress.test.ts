import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TELEGRAM_MESSAGE_MAX_LENGTH } from '../telegram-entities.js';
import {
  appendTelegramProgressEntry,
  ellipsizeMiddleByUtf16,
  normalizeTelegramProgressConfig,
  renderCollapsedTrace,
  renderTelegramProgressDraft,
  renderTraceFallbackMessage,
  sanitizeProgressEntry,
  type ProgressTraceEntry,
} from '../telegram-progress.js';

function entries(count: number, textPrefix = 'short step'): ProgressTraceEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: 'commentary',
    text: `${textPrefix} ${index + 1}`,
    timestamp: new Date(0).toISOString(),
  }));
}

describe('telegram progress config', () => {
  it('normalizes disabled defaults conservatively', () => {
    assert.deepEqual(normalizeTelegramProgressConfig(undefined), {
      enabled: false,
      mode: 'off',
      transport: 'none',
      minUpdateIntervalMs: 1000,
      maxDraftChars: 3900,
      maxStoredEntries: 200,
      showButton: true,
      fullTraceDelivery: 'message',
    });
  });

  it('normalizes explicit peek and clamps unsafe limits', () => {
    const config = normalizeTelegramProgressConfig({
      enabled: true,
      mode: 'peek',
      transport: 'draft',
      minUpdateIntervalMs: 10,
      maxDraftChars: 99_999,
      maxStoredEntries: 99_999,
      showButton: false,
      fullTraceDelivery: 'none',
    });

    assert.equal(config.enabled, true);
    assert.equal(config.mode, 'peek');
    assert.equal(config.transport, 'draft');
    assert.equal(config.minUpdateIntervalMs, 800);
    assert.equal(config.maxDraftChars, TELEGRAM_MESSAGE_MAX_LENGTH);
    assert.equal(config.maxStoredEntries, 1000);
    assert.equal(config.showButton, false);
    assert.equal(config.fullTraceDelivery, 'none');
  });
});

describe('telegram progress rendering', () => {
  it('uses a character budget rather than a fixed entry count for live drafts', () => {
    const rendered = renderTelegramProgressDraft({ entries: entries(30) }, { maxChars: 3900 });

    assert.equal(rendered.length <= 3900, true);
    assert.match(rendered, /30\. • short step 30/);
    assert.match(rendered, /1\. • short step 1/);
  });

  it('middle-ellipsizes one oversized entry while keeping the draft within budget', () => {
    const huge = 'A'.repeat(5000) + 'TAIL';
    const rendered = renderTelegramProgressDraft({
      entries: [{ kind: 'commentary', text: huge }],
    }, { maxChars: 512 });

    assert.equal(rendered.length <= 512, true);
    assert.match(rendered, /обрезано/);
    assert.match(rendered, /TAIL/);
  });

  it('shows hidden count when entries exceed the character budget', () => {
    const rendered = renderTelegramProgressDraft({ entries: entries(80, 'longish progress item with detail') }, { maxChars: 700 });

    assert.equal(rendered.length <= 700, true);
    assert.match(rendered, /ещё \d+ шаг/);
  });

  it('renders collapsed trace with expandable blockquote entities when it fits', () => {
    const rendered = renderCollapsedTrace({ entries: entries(3) }, 'Final answer', { maxChars: 1000 });

    assert.equal(rendered.fits, true);
    assert.match(rendered.text, /^Ход выполнения/);
    assert.match(rendered.text, /─────\n\nFinal answer$/);
    assert.equal(rendered.entities[0]?.type, 'expandable_blockquote');
    assert.equal(rendered.text.length <= 1000, true);
  });

  it('does not dirty the final answer when trace and final text cannot fit', () => {
    const finalText = 'F'.repeat(4090);
    const rendered = renderCollapsedTrace({ entries: entries(3) }, finalText);

    assert.equal(rendered.fits, false);
    assert.equal(rendered.text, finalText.slice(0, TELEGRAM_MESSAGE_MAX_LENGTH));
  });

  it('renders fallback trace under Telegram length limit', () => {
    const rendered = renderTraceFallbackMessage({ entries: entries(500, 'fallback trace item') });

    assert.equal(rendered.length <= TELEGRAM_MESSAGE_MAX_LENGTH, true);
    assert.match(rendered, /^Ход выполнения/);
  });

  it('sanitizes reasoning, encrypted markers, and secrets', () => {
    assert.equal(sanitizeProgressEntry({ kind: 'commentary', text: 'encrypted_content: abc' }), null);
    assert.equal(sanitizeProgressEntry({ kind: 'commentary', text: '{"type":"reasoning","text":"hidden"}' }), null);
    const sanitized = sanitizeProgressEntry({ kind: 'commentary', text: 'token=sk-proj-secret123 continue' });
    assert.ok(sanitized);
    assert.doesNotMatch(sanitized.text, /sk-proj-secret123/);
    assert.match(sanitized.text, /\[REDACTED\]/);
    const bearer = sanitizeProgressEntry({
      kind: 'commentary',
      text: 'Authorization: Bearer eyJabc.def.ghi continue',
    });
    assert.ok(bearer);
    assert.doesNotMatch(bearer.text, /Bearer|eyJabc\.def\.ghi/);
    assert.match(bearer.text, /Authorization: \[REDACTED\]/);

    const toolEntry = sanitizeProgressEntry({
      kind: 'tool-finish',
      text: 'Public status',
      toolName: 'exec_command\napi_key=sk-proj-secret123',
      status: 'done\ntoken=sk-proj-secret123',
    });
    assert.ok(toolEntry);
    assert.doesNotMatch(toolEntry.toolName ?? '', /sk-proj-secret123/);
    assert.doesNotMatch(toolEntry.status ?? '', /sk-proj-secret123/);
    assert.doesNotMatch(toolEntry.toolName ?? '', /\n/);
  });

  it('dedupes identical consecutive stored entries', async () => {
    const project = await mkdtemp(join(tmpdir(), 'omx-progress-state-'));
    try {
      const first = await appendTelegramProgressEntry(project, 'session-1', 'turn-1', {
        kind: 'commentary',
        text: 'same public update',
      });
      const second = await appendTelegramProgressEntry(project, 'session-1', 'turn-1', {
        kind: 'commentary',
        text: 'same public update',
      });

      assert.equal(first.appended, true);
      assert.equal(second.appended, false);
      assert.equal(second.state.entries.length, 1);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it('ellipsizeMiddleByUtf16 preserves the requested budget', () => {
    const rendered = ellipsizeMiddleByUtf16('abcdef'.repeat(50), 64);
    assert.equal(rendered.length <= 64, true);
    assert.match(rendered, /…/);
  });
});
