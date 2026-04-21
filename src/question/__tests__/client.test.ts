import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  OmxQuestionError,
  runOmxQuestion,
  type OmxQuestionProcessRunner,
} from '../client.js';

function makeRunner(stdout: unknown, code = 0, stderr = ''): OmxQuestionProcessRunner {
  return async () => ({
    code,
    stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout),
    stderr,
  });
}

describe('runOmxQuestion', () => {
  it('parses a successful blocking stdout payload', async () => {
    const result = await runOmxQuestion(
      {
        question: 'What next?',
        options: [{ label: 'Launch', value: 'launch' }],
        allow_other: true,
        source: 'deep-interview',
      },
      {
        cwd: '/repo',
        argv1: '/repo/dist/cli/omx.js',
        runner: makeRunner({
          ok: true,
          question_id: 'q-1',
          session_id: 'sess-1',
          prompt: {
            question: 'What next?',
            options: [{ label: 'Launch', value: 'launch' }],
            allow_other: true,
            other_label: 'Other',
            type: 'single-answerable',
            multi_select: false,
            source: 'deep-interview',
          },
          answer: {
            kind: 'option',
            value: 'launch',
            selected_labels: ['Launch'],
            selected_values: ['launch'],
          },
        }),
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.answer.value, 'launch');
    assert.equal(result.prompt.source, 'deep-interview');
    assert.equal(result.prompt.type, 'single-answerable');
  });

  it('throws explicit question errors from stdout payloads', async () => {
    await assert.rejects(
      runOmxQuestion(
        {
          question: 'What next?',
          options: [{ label: 'Launch', value: 'launch' }],
          allow_other: false,
        },
        {
          cwd: '/repo',
          argv1: '/repo/dist/cli/omx.js',
          runner: makeRunner({
            ok: false,
            error: {
              code: 'team_blocked',
              message: 'omx question is unavailable while this session owns active team mode.',
            },
          }, 1),
        },
      ),
      (error) => {
        assert.ok(error instanceof OmxQuestionError);
        assert.equal(error.code, 'team_blocked');
        assert.match(error.message, /team_blocked/);
        return true;
      },
    );
  });

  it('throws when omx question emits no stdout', async () => {
    await assert.rejects(
      runOmxQuestion(
        {
          question: 'What next?',
          options: [{ label: 'Launch', value: 'launch' }],
          allow_other: false,
        },
        {
          cwd: '/repo',
          argv1: '/repo/dist/cli/omx.js',
          runner: makeRunner('', 1, 'stderr'),
        },
      ),
      (error) => {
        assert.ok(error instanceof OmxQuestionError);
        assert.equal(error.code, 'question_no_stdout');
        return true;
      },
    );
  });

  it('throws when omx question emits invalid stdout JSON', async () => {
    await assert.rejects(
      runOmxQuestion(
        {
          question: 'What next?',
          options: [{ label: 'Launch', value: 'launch' }],
          allow_other: false,
        },
        {
          cwd: '/repo',
          argv1: '/repo/dist/cli/omx.js',
          runner: makeRunner('not-json', 1, 'stderr'),
        },
      ),
      (error) => {
        assert.ok(error instanceof OmxQuestionError);
        assert.equal(error.code, 'question_invalid_stdout');
        return true;
      },
    );
  });

  it('throws when omx question returns a success payload but exits non-zero', async () => {
    await assert.rejects(
      runOmxQuestion(
        {
          question: 'What next?',
          options: [{ label: 'Launch', value: 'launch' }],
          allow_other: false,
        },
        {
          cwd: '/repo',
          argv1: '/repo/dist/cli/omx.js',
          runner: makeRunner({
            ok: true,
            question_id: 'q-2',
            session_id: 'sess-2',
            prompt: {
              question: 'What next?',
              options: [{ label: 'Launch', value: 'launch' }],
              allow_other: false,
              other_label: 'Other',
              type: 'single-answerable',
              multi_select: false,
            },
            answer: {
              kind: 'option',
              value: 'launch',
              selected_labels: ['Launch'],
              selected_values: ['launch'],
            },
          }, 3),
        },
      ),
      (error) => {
        assert.ok(error instanceof OmxQuestionError);
        assert.equal(error.code, 'question_nonzero_exit');
        return true;
      },
    );
  });
});
