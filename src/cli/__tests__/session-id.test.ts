import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateOmxSessionId, resolveOmxSessionId } from '../session-id.js';

describe('session-id helpers', () => {
  it('generates OMX session ids with the canonical prefix', () => {
    const sessionId = generateOmxSessionId(() => 1_777_000_000_000, () => 0.123456789);
    assert.match(sessionId, /^omx-1777000000000-[a-z0-9]{6}$/);
  });

  it('reuses a valid pre-seeded OMX session id from the environment', () => {
    assert.equal(
      resolveOmxSessionId({ OMX_SESSION_ID: 'omx-preseeded-session-1' }),
      'omx-preseeded-session-1',
    );
  });

  it('falls back to generating a new session id when the provided value is invalid', () => {
    const sessionId = resolveOmxSessionId(
      { OMX_SESSION_ID: 'not a valid id' },
      () => 1_777_000_000_001,
      () => 0.987654321,
    );
    assert.match(sessionId, /^omx-1777000000001-[a-z0-9]{6}$/);
  });
});
