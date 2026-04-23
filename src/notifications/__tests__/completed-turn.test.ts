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
  it('promotes reply-origin telegram noise turns into result-ready with the raw-by-default policy', () => {
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
    assert.equal(decision.transportPolicy.default.mode, 'raw-assistant-text');
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

  it('uses the raw default for ordinary result-ready turns without reply-origin metadata', () => {
    const decision = planCompletedTurnNotification({
      semanticOutcome: {
        kind: 'result-ready',
        summary: 'All tests passed.',
        notificationEvent: 'result-ready',
      },
    });

    assert.ok(decision);
    assert.equal(decision.effectiveEvent, 'result-ready');
    assert.equal(decision.transportPolicy.default.mode, 'raw-assistant-text');
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

  it('uses the raw default for ask-user-question too', () => {
    const decision = planCompletedTurnNotification({
      semanticOutcome: {
        kind: 'input-needed',
        summary: 'Need approval to continue.',
        question: 'Should I continue with the cleanup?',
        notificationEvent: 'ask-user-question',
      },
    });

    assert.ok(decision);
    assert.equal(decision.effectiveEvent, 'ask-user-question');
    assert.equal(decision.transportPolicy.default.mode, 'raw-assistant-text');
  });
});

describe('completed-turn rendering', () => {
  it('uses raw assistant text by default for result-ready notifications', () => {
    const message = renderCompletedTurnMessage(
      { mode: 'raw-assistant-text' },
      basePayload,
      'raw assistant text',
    );

    assert.equal(message, 'raw assistant text');
  });

  it('falls back to formatted output when raw assistant text is empty', () => {
    const message = renderCompletedTurnMessage(
      { mode: 'raw-assistant-text' },
      basePayload,
      '   ',
    );

    assert.match(message, /# Result Ready/);
    assert.match(message, /All tests passed\./);
  });

  it('supports opting result-ready back into formatter mode via config', () => {
    const decision = planCompletedTurnNotification({
      semanticOutcome: {
        kind: 'result-ready',
        summary: 'All tests passed.',
        notificationEvent: 'result-ready',
      },
      notificationConfig: {
        completedTurn: {
          resultReadyMode: 'formatted-notification',
          askUserQuestionMode: 'formatted-notification',
        },
      },
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

    assert.equal(overrides, undefined);
    assert.match(payload.message, /# Result Ready/);
    assert.match(payload.message, /All tests passed\./);
  });

  it('supports per-platform formatter overrides without changing the raw default', () => {
    const decision = planCompletedTurnNotification({
      semanticOutcome: {
        kind: 'result-ready',
        summary: 'All tests passed.',
        notificationEvent: 'result-ready',
      },
      notificationConfig: {
        completedTurn: {
          resultReadyMode: 'raw-assistant-text',
          askUserQuestionMode: 'formatted-notification',
          platformOverrides: {
            telegram: {
              resultReadyMode: 'formatted-notification',
            },
          },
        },
      },
    });

    assert.ok(decision);
    assert.equal(decision.transportPolicy.default.mode, 'raw-assistant-text');
    const payload: FullNotificationPayload = {
      ...basePayload,
      message: renderCompletedTurnMessage(
        decision.transportPolicy.default,
        basePayload,
        'raw assistant text',
      ),
    };
    const overrides = buildCompletedTurnTransportOverrides(
      decision,
      payload,
      'raw assistant text',
    );

    assert.equal(payload.message, 'raw assistant text');
    assert.ok(overrides?.telegram?.message);
    assert.match(overrides?.telegram?.message || '', /# Result Ready/);
    assert.equal(overrides?.telegram?.parseMode, undefined);
  });

  it('falls back to formatted telegram delivery when raw assistant text exceeds Telegram limits', () => {
    const decision = planCompletedTurnNotification({
      semanticOutcome: {
        kind: 'result-ready',
        summary: 'All tests passed.',
        notificationEvent: 'result-ready',
      },
    });

    assert.ok(decision);
    const payload: FullNotificationPayload = {
      ...basePayload,
      message: renderCompletedTurnMessage(
        decision.transportPolicy.default,
        basePayload,
        'x'.repeat(5000),
      ),
    };
    const overrides = buildCompletedTurnTransportOverrides(
      decision,
      payload,
      'x'.repeat(5000),
    );

    assert.equal(payload.message, 'x'.repeat(5000));
    assert.ok(overrides?.telegram?.message);
    assert.match(overrides?.telegram?.message || '', /# Result Ready/);
    assert.equal(overrides?.telegram?.parseMode, undefined);
  });

  it('supports opting ask-user-question back into formatter mode via config', () => {
    const decision = planCompletedTurnNotification({
      semanticOutcome: {
        kind: 'input-needed',
        summary: 'Need approval to continue.',
        question: 'Should I continue with the cleanup?',
        notificationEvent: 'ask-user-question',
      },
      notificationConfig: {
        completedTurn: {
          resultReadyMode: 'raw-assistant-text',
          askUserQuestionMode: 'formatted-notification',
        },
      },
    });

    assert.ok(decision);
    const message = renderCompletedTurnMessage(
      decision.transportPolicy.default,
      {
        ...basePayload,
        event: 'ask-user-question',
        question: 'Should I continue with the cleanup?',
      },
      'Should I continue with the cleanup?',
    );

    assert.match(message, /# Input Needed/);
    assert.match(message, /Should I continue with the cleanup\?/);
  });
});
