import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
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

  it('ignores fenced git-status noise and keeps a descriptive result summary', () => {
    const outcome = classifyCompletedTurn([
      'Created the requested files:',
      '- `README.md` with a title and 3 short bullet points',
      '- `NOTES.md` with a 3-item checklist',
      '',
      'Ran `git status --short`:',
      '```text',
      '?? .gitignore',
      '?? AGENTS.md',
      '?? NOTES.md',
      '?? README.md',
      '?? TASK.md',
      '```',
      '',
      'Ready for review.',
    ].join('\n'));

    assert.equal(outcome.kind, 'result-ready');
    assert.equal(outcome.notificationEvent, 'result-ready');
    assert.match(outcome.summary, /Created the requested files/i);
    assert.match(outcome.summary, /README\.md/i);
    assert.match(outcome.summary, /NOTES\.md/i);
    assert.doesNotMatch(outcome.summary, /\?\? TASK\.md/i);
  });

  it('trims inline git-status verification chatter from the result summary', () => {
    const outcome = classifyCompletedTurn(
      'Created `README.md` with a title and 3 short bullet points, and created `NOTES.md` with a 3-item checklist. Ran `git status --short`; it shows untracked files: `.gitignore`, `AGENTS.md`, `NOTES.md`, `README.md`, and `TASK.md`.\n\nReady for review.',
    );

    assert.equal(outcome.kind, 'result-ready');
    assert.equal(outcome.notificationEvent, 'result-ready');
    assert.match(outcome.summary, /Created README\.md/i);
    assert.doesNotMatch(outcome.summary, /git status/i);
    assert.doesNotMatch(outcome.summary, /untracked files/i);
  });

  it('does not treat inline git-status porcelain output as a user question', () => {
    const outcome = classifyCompletedTurn([
      'Done in solo mode.',
      '',
      '- Created `README.md` with a title and 3 short bullet points.',
      '- Created `NOTES.md` with a 3-item checklist.',
      '- Kept both files intentionally small and simple.',
      '',
      'Verification:',
      '- Ran `git status --short` → ?? .gitignore, ?? AGENTS.md, ?? NOTES.md, ?? README.md, ?? TASK.md',
      '',
      'Ready for review.',
    ].join('\n'));

    assert.equal(outcome.kind, 'result-ready');
    assert.equal(outcome.notificationEvent, 'result-ready');
    assert.match(outcome.summary, /README\.md/i);
    assert.doesNotMatch(outcome.summary, /\?\? \.gitignore/i);
  });

  it('prefers changed-file bullets over trailing verification bullets in the result summary', () => {
    const outcome = classifyCompletedTurn([
      'Changed:',
      '- `README.md` — added a small title and 3 short bullet points for the Telegram smoke demo.',
      '- `NOTES.md` — added a 3-item checklist.',
      '',
      'Verification:',
      '- Confirmed both files contain the requested minimal content.',
      '- Ran `git status --short` successfully.',
      '',
      'Ready for review.',
    ].join('\n'));

    assert.equal(outcome.kind, 'result-ready');
    assert.equal(outcome.notificationEvent, 'result-ready');
    assert.match(outcome.summary, /README\.md/i);
    assert.match(outcome.summary, /NOTES\.md/i);
    assert.doesNotMatch(outcome.summary, /^Verification:/i);
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
