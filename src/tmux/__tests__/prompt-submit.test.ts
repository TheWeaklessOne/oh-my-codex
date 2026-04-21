import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectCodexBlockingPanePrompt,
  submitPromptToCodexPane,
  waitForCodexPaneReady,
} from '../prompt-submit.js';

describe('waitForCodexPaneReady', () => {
  it('dismisses trust prompts and then accepts the first ready frame', () => {
    const commands: string[][] = [];
    let visibleReads = 0;

    const ready = waitForCodexPaneReady('%42', 1_000, {
      runTmuxSyncImpl: (argv) => {
        commands.push(argv);
        if (argv[0] === 'send-keys') {
          return { ok: true, stdout: '', stderr: '' };
        }
        if (argv.includes('-p') && !argv.includes('-S')) {
          visibleReads += 1;
          if (visibleReads === 1) {
            return {
              ok: true,
              stdout: 'Do you trust the contents of this directory?\nYes, continue\nNo, quit\nPress enter to continue',
              stderr: '',
            };
          }
          return { ok: true, stdout: 'OpenAI Codex\nDirectory: /repo\n› ', stderr: '' };
        }
        return { ok: true, stdout: '', stderr: '' };
      },
      sleepSyncImpl: () => {},
      autoAcceptTrustPrompt: true,
    });

    assert.equal(ready, true);
    assert.ok(commands.some((argv) => argv.join(' ') === 'send-keys -t %42 C-m'));
  });

  it('does not auto-accept trust prompts unless explicitly enabled', () => {
    const commands: string[][] = [];

    const ready = waitForCodexPaneReady('%42', 1_000, {
      runTmuxSyncImpl: (argv) => {
        commands.push(argv);
        return {
          ok: true,
          stdout: 'Do you trust the contents of this directory?\nYes, continue\nNo, quit\nPress enter to continue',
          stderr: '',
        };
      },
      sleepSyncImpl: () => {},
    });

    assert.equal(ready, false);
    assert.equal(commands.some((argv) => argv[0] === 'send-keys'), false);
  });
});

describe('submitPromptToCodexPane', () => {
  it('submits the first prompt and returns success once the pane starts working', async () => {
    const commands: string[][] = [];
    let captureReads = 0;
    let visibleReads = 0;

    const submitted = await submitPromptToCodexPane('pane-1', 'Investigate issue 742', {
      runTmuxSyncImpl: (argv) => {
        commands.push(argv);
        if (argv[0] === 'send-keys') {
          return { ok: true, stdout: '', stderr: '' };
        }
        if (argv[0] === 'capture-pane' && argv.includes('-S')) {
          captureReads += 1;
          return captureReads === 1
            ? { ok: true, stdout: 'OpenAI Codex\n› Investigate issue 742', stderr: '' }
            : { ok: true, stdout: '• Thinking… (esc to interrupt)', stderr: '' };
        }
        if (argv[0] === 'capture-pane') {
          visibleReads += 1;
          return visibleReads === 1
            ? { ok: true, stdout: 'OpenAI Codex\n› Investigate issue 742', stderr: '' }
            : { ok: true, stdout: '• Thinking… (esc to interrupt)', stderr: '' };
        }
        return { ok: true, stdout: '', stderr: '' };
      },
      sleepImpl: async () => {},
      sleepSyncImpl: () => {},
    });

    assert.equal(submitted, true);
    assert.ok(
      commands.some((argv) => argv.join(' ') === 'send-keys -t pane-1 -l -- Investigate issue 742'),
    );
  });

  it('does not submit prompt text while a bypass-permissions prompt is still blocking the pane', async () => {
    const commands: string[][] = [];

    const submitted = await submitPromptToCodexPane('pane-1', 'Investigate issue 742', {
      runTmuxSyncImpl: (argv) => {
        commands.push(argv);
        return {
          ok: true,
          stdout: 'Bypass Permissions mode\nNo, exit\nYes, I accept\nEnter to confirm',
          stderr: '',
        };
      },
      sleepImpl: async () => {},
      sleepSyncImpl: () => {},
    });

    assert.equal(submitted, false);
    assert.equal(
      commands.some((argv) => argv.join(' ') === 'send-keys -t pane-1 -l -- Investigate issue 742'),
      false,
    );
  });
});

describe('detectCodexBlockingPanePrompt', () => {
  it('reports trust prompts from the visible pane capture', () => {
    const prompt = detectCodexBlockingPanePrompt('%42', {
      runTmuxSyncImpl: () => ({
        ok: true,
        stdout: 'Do you trust the contents of this directory?\nYes, continue\nNo, quit\nPress enter to continue',
        stderr: '',
      }),
    });

    assert.equal(prompt, 'trust');
  });

  it('falls back to scrollback when the visible pane does not show the blocking prompt', () => {
    let callCount = 0;
    const prompt = detectCodexBlockingPanePrompt('%42', {
      runTmuxSyncImpl: () => {
        callCount += 1;
        if (callCount === 1) {
          return { ok: true, stdout: 'OpenAI Codex\n› ', stderr: '' };
        }
        return {
          ok: true,
          stdout: 'Bypass Permissions mode\nNo, exit\nYes, I accept\nEnter to confirm',
          stderr: '',
        };
      },
    });

    assert.equal(prompt, 'bypass');
  });
});
