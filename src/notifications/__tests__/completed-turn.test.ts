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
    assert.equal(decision.transportPolicy.overrides?.telegram?.telegramFormat, 'entities');
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

  it('treats non-empty assistant text as result-ready unless input is explicitly needed', () => {
    const decision = planCompletedTurnNotification({
      semanticOutcome: {
        kind: 'progress',
        summary: 'Готово — составил план исправления...',
      },
      assistantText: 'Готово — составил план исправления...',
      turnId: 'turn-russian-plan',
    });

    assert.ok(decision);
    assert.equal(decision.effectiveEvent, 'result-ready');
    assert.equal(decision.hookMetadata.semanticPhase, 'progress');
    assert.equal(decision.hookMetadata.semanticClassifierEvent, null);
    assert.match(decision.effectiveFingerprint, /"policy":"per-turn"/);
  });

  it('keeps explicit input-needed turns as ask-user-question even with non-empty assistant text', () => {
    const decision = planCompletedTurnNotification({
      semanticOutcome: {
        kind: 'input-needed',
        summary: 'Need approval to continue.',
        question: 'Should I continue?',
        notificationEvent: 'ask-user-question',
      },
      assistantText: 'Should I continue?',
      turnId: 'turn-question',
    });

    assert.ok(decision);
    assert.equal(decision.effectiveEvent, 'ask-user-question');
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

  it('builds Telegram entity overrides for raw completed-turn result markdown by default', () => {
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
        'Run `npm run build`',
      ),
    };
    const overrides = buildCompletedTurnTransportOverrides(
      decision,
      payload,
      'Run `npm run build`',
    );

    assert.equal(overrides?.telegram?.message, 'Run npm run build');
    assert.deepEqual(overrides?.telegram?.entities, [
      { type: 'code', offset: 'Run '.length, length: 'npm run build'.length },
    ]);
    assert.equal(overrides?.telegram?.parseMode, null);
  });

  it('does not append renderer warnings to Telegram message text or log by default', () => {
    const originalWarn = console.warn;
    const originalDebug = process.env.OMX_TELEGRAM_RENDER_DEBUG;
    const warnCalls: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnCalls.push(args);
    };
    delete process.env.OMX_TELEGRAM_RENDER_DEBUG;

    try {
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
          '[signed](https://example.com/file?token=secret)',
        ),
      };
      const overrides = buildCompletedTurnTransportOverrides(
        decision,
        payload,
        '[signed](https://example.com/file?token=secret)',
      );

      assert.equal(overrides?.telegram?.message, 'signed');
      assert.doesNotMatch(overrides?.telegram?.message ?? '', /warning|secret/i);
      assert.equal(warnCalls.length, 0);
    } finally {
      console.warn = originalWarn;
      if (originalDebug === undefined) delete process.env.OMX_TELEGRAM_RENDER_DEBUG;
      else process.env.OMX_TELEGRAM_RENDER_DEBUG = originalDebug;
    }
  });

  it('logs redacted renderer warning telemetry when Telegram render debug is enabled', () => {
    const originalWarn = console.warn;
    const originalDebug = process.env.OMX_TELEGRAM_RENDER_DEBUG;
    const warnCalls: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnCalls.push(args);
    };
    process.env.OMX_TELEGRAM_RENDER_DEBUG = '1';

    try {
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
          '[signed](https://example.com/file?token=secret)',
        ),
      };
      const overrides = buildCompletedTurnTransportOverrides(
        decision,
        payload,
        '[signed](https://example.com/file?token=secret)',
      );

      assert.equal(overrides?.telegram?.message, 'signed');
      assert.equal(warnCalls.length, 1);
      const telemetry = JSON.stringify(warnCalls[0]);
      assert.match(telemetry, /sensitive-url-dropped/);
      assert.doesNotMatch(telemetry, /secret/);
      assert.doesNotMatch(telemetry, /file\\?token=secret/);
    } finally {
      console.warn = originalWarn;
      if (originalDebug === undefined) delete process.env.OMX_TELEGRAM_RENDER_DEBUG;
      else process.env.OMX_TELEGRAM_RENDER_DEBUG = originalDebug;
    }
  });

  it('builds Telegram entity overrides for ask-user-question raw markdown by default', () => {
    const decision = planCompletedTurnNotification({
      semanticOutcome: {
        kind: 'input-needed',
        summary: 'Need a command.',
        question: 'Run `npm test`?',
        notificationEvent: 'ask-user-question',
      },
    });
    assert.ok(decision);

    const payload: FullNotificationPayload = {
      ...basePayload,
      event: 'ask-user-question',
      message: renderCompletedTurnMessage(
        decision.transportPolicy.default,
        { ...basePayload, event: 'ask-user-question' },
        'Run `npm test`?',
      ),
    };
    const overrides = buildCompletedTurnTransportOverrides(
      decision,
      payload,
      'Run `npm test`?',
    );

    assert.equal(overrides?.telegram?.message, 'Run npm test?');
    assert.deepEqual(overrides?.telegram?.entities, [
      { type: 'code', offset: 'Run '.length, length: 'npm test'.length },
    ]);
    assert.equal(overrides?.telegram?.parseMode, null);
  });

  it('keeps literal raw Telegram markdown when telegramFormat opts out', () => {
    const decision = planCompletedTurnNotification({
      semanticOutcome: {
        kind: 'result-ready',
        summary: 'All tests passed.',
        notificationEvent: 'result-ready',
      },
      notificationConfig: {
        completedTurn: {
          resultReadyMode: 'raw-assistant-text',
          askUserQuestionMode: 'raw-assistant-text',
          platformOverrides: {
            telegram: {
              telegramFormat: 'literal',
            },
          },
        },
      },
    });
    assert.ok(decision);

    const payload: FullNotificationPayload = {
      ...basePayload,
      message: renderCompletedTurnMessage(
        decision.transportPolicy.default,
        basePayload,
        'Run `npm run build`',
      ),
    };
    const overrides = buildCompletedTurnTransportOverrides(
      decision,
      payload,
      'Run `npm run build`',
    );

    assert.equal(overrides?.telegram?.message, 'Run `npm run build`');
    assert.equal(overrides?.telegram?.entities, undefined);
    assert.equal(overrides?.telegram?.parseMode, null);
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

  it('keeps long raw Telegram completed-turn text for dispatcher chunking', () => {
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
    assert.equal(overrides?.telegram?.message, 'x'.repeat(5000));
    assert.equal(overrides?.telegram?.entities, undefined);
    assert.equal(overrides?.telegram?.parseMode, null);
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
