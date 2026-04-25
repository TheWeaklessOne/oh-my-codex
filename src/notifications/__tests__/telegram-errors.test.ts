import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { classifyTelegramBotApiError } from '../telegram-errors.js';
import { TelegramBotApiError } from '../telegram-topics.js';

function botError(description: string, options: {
  statusCode?: number;
  errorCode?: number;
  methodName?: string;
} = {}): TelegramBotApiError {
  return new TelegramBotApiError({
    methodName: options.methodName ?? 'sendMessage',
    message: description,
    description,
    statusCode: options.statusCode ?? 400,
    errorCode: options.errorCode ?? 400,
  });
}

describe('classifyTelegramBotApiError', () => {
  it('classifies entity and rich payload wording variants', () => {
    for (const description of [
      "Bad Request: can't parse entities: invalid entity range",
      "Bad Request: can't find end of the entity starting at byte offset 42",
      'Bad Request: can\'t parse message text: Unsupported start tag "span" at byte offset 0',
      "Bad Request: can't parse message text: can't find end tag corresponding to start tag b",
      'Bad Request: entity start is out of range',
      'Bad Request: entity length is invalid',
    ]) {
      const classification = classifyTelegramBotApiError(botError(description));
      assert.equal(classification.category, 'entity-or-rich-payload', description);
      assert.equal(classification.retryable, false);
    }
  });

  it('classifies stale or missing topic wording without treating it as entity failure', () => {
    for (const description of [
      'Bad Request: message thread not found',
      'Bad Request: message thread not found or deleted',
      'Bad Request: topic not found',
    ]) {
      const classification = classifyTelegramBotApiError(botError(description));
      assert.equal(classification.category, 'stale-topic', description);
      assert.equal(classification.retryable, true);
    }
  });

  it('classifies forum topic delivery mismatch wording separately', () => {
    for (const description of [
      'Bad Request: message is not a forum topic message',
      'Bad Request: not a forum topic message',
      'Bad Request: topic mismatch for message thread',
    ]) {
      const classification = classifyTelegramBotApiError(botError(description));
      assert.equal(classification.category, 'delivery-topic-mismatch', description);
      assert.equal(classification.retryable, true);
    }
  });

  it('classifies auth/config and retryable network/API failures', () => {
    assert.equal(
      classifyTelegramBotApiError(botError('Unauthorized', { statusCode: 401, errorCode: 401 })).category,
      'auth-config-permanent',
    );
    assert.equal(
      classifyTelegramBotApiError(botError('Forbidden: bot was blocked by the user', { statusCode: 403, errorCode: 403 })).category,
      'auth-config-permanent',
    );
    assert.equal(
      classifyTelegramBotApiError(botError('Too Many Requests: retry after 1', { statusCode: 429, errorCode: 429 })).category,
      'retryable-network-or-api',
    );
    assert.equal(
      classifyTelegramBotApiError(botError('Internal Server Error', { statusCode: 500, errorCode: 500 })).category,
      'retryable-network-or-api',
    );
    assert.equal(
      classifyTelegramBotApiError(new Error('ECONNRESET')).category,
      'retryable-network-or-api',
    );
  });

  it('leaves generic 400 errors unknown so dispatch does not mask them as rich fallback', () => {
    const classification = classifyTelegramBotApiError(botError('Bad Request: chat not found'));

    assert.equal(classification.category, 'unknown');
    assert.equal(classification.retryable, false);
    assert.equal(classification.permanent, false);
  });
});
