import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('reply-listener README contract', () => {
  it('documents the hardened reply-listener knobs and operator status surface', () => {
    const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf-8');

    assert.match(readme, /authorizedTelegramUserIds/);
    assert.match(readme, /ackMode/);
    assert.match(readme, /telegramStartupBacklogPolicy/);
    assert.match(readme, /telegramPollTimeoutSeconds/);
    assert.match(readme, /Webhooks are intentionally out of scope/i);
    assert.match(readme, /omx status/i);
    assert.match(readme, /reply-listener source diagnostics/i);
  });
});
