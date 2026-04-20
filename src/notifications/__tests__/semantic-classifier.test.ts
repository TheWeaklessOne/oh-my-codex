import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCompletedTurnFingerprint,
  classifyCompletedTurn,
} from '../../runtime/turn-semantics.js';

describe('classifyCompletedTurn', () => {
  it('classifies commit and tests-passed summaries as result-ready', () => {
    const outcome = classifyCompletedTurn([
      'Implemented meaningful Telegram notifications.',
      'Created commit abc123 and all tests passed.',
    ].join('\n'));

    assert.equal(outcome.kind, 'result-ready');
    assert.equal(outcome.notificationEvent, 'result-ready');
    assert.match(outcome.summary, /tests passed/i);
  });

  it('classifies explicit approval questions as input-needed', () => {
    const outcome = classifyCompletedTurn('Would you like me to continue with the cleanup?');

    assert.equal(outcome.kind, 'input-needed');
    assert.equal(outcome.notificationEvent, 'ask-user-question');
    assert.equal(outcome.question, 'Would you like me to continue with the cleanup?');
  });

  it('keeps ready-for-review completions as result-ready', () => {
    const outcome = classifyCompletedTurn('Ready for review.');
    assert.equal(outcome.kind, 'result-ready');
    assert.equal(outcome.notificationEvent, 'result-ready');
  });

  it('keeps completed summaries that mention review work as result-ready', () => {
    const outcome = classifyCompletedTurn('Implemented review flow and all tests passed.');
    assert.equal(outcome.kind, 'result-ready');
    assert.equal(outcome.notificationEvent, 'result-ready');
  });

  it('prefers input-needed when a completed summary ends with a real approval question', () => {
    const outcome = classifyCompletedTurn([
      'Implemented meaningful Telegram notifications and all tests passed.',
      'Should I open the PR now?',
    ].join('\n'));

    assert.equal(outcome.kind, 'input-needed');
    assert.equal(outcome.notificationEvent, 'ask-user-question');
    assert.equal(outcome.question, 'Should I open the PR now?');
  });

  it('classifies direct user questions as input-needed even during planning', () => {
    const outcome = classifyCompletedTurn([
      'Round 2 | Target: Decision boundary',
      'Should ZenX fail loudly so the stale attribute is removed, or should it ignore the attribute and continue?',
    ].join('\n'));

    assert.equal(outcome.kind, 'input-needed');
    assert.equal(outcome.notificationEvent, 'ask-user-question');
    assert.match(outcome.question || '', /Should ZenX fail loudly/i);
  });

  it('suppresses planning-only continuation chatter', () => {
    const outcome = classifyCompletedTurn('I can continue with the plan from here.');
    assert.equal(outcome.kind, 'progress');
    assert.equal(outcome.notificationEvent, undefined);
  });

  it('classifies failure summaries separately', () => {
    const outcome = classifyCompletedTurn('Build failed: timeout while running npm test.');
    assert.equal(outcome.kind, 'failed');
    assert.equal(outcome.notificationEvent, undefined);
  });
});

describe('buildCompletedTurnFingerprint', () => {
  it('includes the semantic kind and summary', () => {
    const fingerprint = buildCompletedTurnFingerprint({
      kind: 'result-ready',
      summary: 'Created commit abc123.',
      notificationEvent: 'result-ready',
    });
    assert.match(fingerprint, /result-ready/);
    assert.match(fingerprint, /Created commit abc123/);
  });
});
