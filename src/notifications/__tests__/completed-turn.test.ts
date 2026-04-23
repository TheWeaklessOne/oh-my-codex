import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCompletedTurnHookFingerprint,
  buildCompletedTurnTransportOverrides,
  planCompletedTurnNotification,
  renderCompletedTurnMessage,
} from '../completed-turn.js';
import type { FullNotificationPayload } from '../types.js';

const basePayload: FullNotificationPayload = {
  event: 'result-ready',
  sessionId: 'sess-completed-turn',
  message: '',
  timestamp: new Date('2026-04-23T12:00:00Z').toISOString(),
  projectPath: '/tmp/project',
  projectName: 'project',
  contextSummary: 'All tests passed.',
};

describe('planCompletedTurnNotification', () => {
  it('forces reply-origin telegram noise turns into result-ready with a telegram raw-text override', () => {
    const decision = planCompletedTurnNotification({
      semanticOutcome: {
        kind: 'noise',
        summary: '',
      },
      replyOrigin: {
        platform: 'telegram',
        injectedInput: 'Which time is it ?',
        createdAt: new Date('2026-04-23T12:00:00Z').toISOString(),
      },
      turnId: 'turn-1',
    });

    assert.ok(decision);
    assert.equal(decision.effectiveEvent, 'result-ready');
    assert.equal(decision.hookMetadata.semanticNotificationEvent, 'result-ready');
    assert.equal(decision.hookMetadata.replyOriginPlatform, 'telegram');
    assert.equal(decision.transportPolicy.default.mode, 'formatted-notification');
    assert.equal(decision.transportPolicy.overrides?.telegram?.mode, 'raw-assistant-text');
    assert.equal(decision.transportPolicy.overrides?.telegram?.parseMode, null);
  });

  it('uses per-turn fingerprints for reply-origin follow-ups', () => {
    const first = planCompletedTurnNotification({
      semanticOutcome: {
        kind: 'noise',
        summary: '',
      },
      replyOrigin: {
        platform: 'telegram',
        injectedInput: 'Which time is it ?',
        createdAt: new Date('2026-04-23T12:00:00Z').toISOString(),
      },
      turnId: 'turn-1',
    });
    const second = planCompletedTurnNotification({
      semanticOutcome: {
        kind: 'noise',
        summary: '',
      },
      replyOrigin: {
        platform: 'telegram',
        injectedInput: 'Which time is it ?',
        createdAt: new Date('2026-04-23T12:00:00Z').toISOString(),
      },
      turnId: 'turn-2',
    });

    assert.ok(first);
    assert.ok(second);
    assert.notEqual(first.effectiveFingerprint, second.effectiveFingerprint);
  });

  it('does not promote failed reply-origin turns to result-ready', () => {
    const decision = planCompletedTurnNotification({
      semanticOutcome: {
        kind: 'failed',
        summary: 'Build failed: timeout while running npm test.',
      },
      replyOrigin: {
        platform: 'telegram',
        injectedInput: 'Run the tests again',
        createdAt: new Date('2026-04-23T12:00:00Z').toISOString(),
      },
      turnId: 'turn-failed',
    });

    assert.equal(decision, null);
  });

  it('keeps hook fingerprints stable across repeated identical reply-origin turns', () => {
    const first = planCompletedTurnNotification({
      semanticOutcome: {
        kind: 'noise',
        summary: '',
      },
      replyOrigin: {
        platform: 'telegram',
        injectedInput: 'Which time is it ?',
        createdAt: new Date('2026-04-23T12:00:00Z').toISOString(),
      },
      turnId: 'turn-1',
    });
    const second = planCompletedTurnNotification({
      semanticOutcome: {
        kind: 'noise',
        summary: '',
      },
      replyOrigin: {
        platform: 'telegram',
        injectedInput: 'Which time is it ?',
        createdAt: new Date('2026-04-23T12:00:00Z').toISOString(),
      },
      turnId: 'turn-2',
    });

    assert.ok(first);
    assert.ok(second);
    assert.equal(
      buildCompletedTurnHookFingerprint(first, first.semanticOutcome),
      buildCompletedTurnHookFingerprint(second, second.semanticOutcome),
    );
  });
});

describe('completed-turn rendering', () => {
  it('keeps the default completed-turn render path formatter-based', () => {
    const message = renderCompletedTurnMessage(
      { mode: 'formatted-notification' },
      basePayload,
      'raw assistant text',
    );

    assert.match(message, /# Result Ready/);
    assert.match(message, /All tests passed\./);
  });

  it('builds transport overrides so telegram can receive raw assistant text without global bypass', () => {
    const decision = planCompletedTurnNotification({
      semanticOutcome: {
        kind: 'noise',
        summary: '',
      },
      replyOrigin: {
        platform: 'telegram',
        injectedInput: 'Which time is it ?',
        createdAt: new Date('2026-04-23T12:00:00Z').toISOString(),
      },
      turnId: 'turn-1',
    });

    assert.ok(decision);
    const payload: FullNotificationPayload = {
      ...basePayload,
      message: renderCompletedTurnMessage(
        decision.transportPolicy.default,
        basePayload,
        'It’s 11:47 PM on April 22, 2026 in Europe/Moscow (UTC+03:00).',
      ),
    };
    const overrides = buildCompletedTurnTransportOverrides(
      decision,
      payload,
      'It’s 11:47 PM on April 22, 2026 in Europe/Moscow (UTC+03:00).',
    );

    assert.ok(overrides?.telegram);
    assert.equal(
      overrides.telegram?.message,
      'It’s 11:47 PM on April 22, 2026 in Europe/Moscow (UTC+03:00).',
    );
    assert.equal(overrides.telegram?.parseMode, null);
    assert.match(payload.message, /# Result Ready/);
  });
});
