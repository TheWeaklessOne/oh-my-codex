import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import {
  applyInteractiveSelectionKey,
  createInitialInteractiveSelectionState,
  promptForSelectionsWithArrows,
  renderInteractiveSelectFrame,
} from '../select.js';

class FakeTtyInput extends EventEmitter {
  isTTY = true;
  rawMode = false;

  setRawMode(mode: boolean): void {
    this.rawMode = mode;
  }

  resume(): void {}
  pause(): void {}
}

class FakeTtyOutput {
  isTTY = true;
  chunks: string[] = [];

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  toString(): string {
    return this.chunks.join('');
  }
}

describe('generic interactive selector', () => {
  it('wraps cursor movement with up/down keys', () => {
    let state = createInitialInteractiveSelectionState();
    state = applyInteractiveSelectionKey({ itemCount: 3 }, state, { name: 'up' }).state;
    assert.equal(state.cursorIndex, 2);

    state = applyInteractiveSelectionKey({ itemCount: 3 }, state, { name: 'down' }).state;
    assert.equal(state.cursorIndex, 0);
  });

  it('submits single-select numeric choices directly', () => {
    const update = applyInteractiveSelectionKey(
      { itemCount: 3 },
      createInitialInteractiveSelectionState(),
      { sequence: '2' },
    );
    assert.equal(update.submit, true);
    assert.equal(update.state.cursorIndex, 1);
  });

  it('toggles multi-select choices and validates Enter', () => {
    let state = createInitialInteractiveSelectionState();
    let update = applyInteractiveSelectionKey({ itemCount: 2, multiSelect: true }, state, { name: 'enter' });
    assert.equal(update.submit, false);
    assert.match(update.state.error ?? '', /Select one or more/);

    state = applyInteractiveSelectionKey({ itemCount: 2, multiSelect: true }, update.state, { name: 'space' }).state;
    assert.deepEqual(state.selectedIndices, [0]);

    update = applyInteractiveSelectionKey({ itemCount: 2, multiSelect: true }, state, { name: 'enter' });
    assert.equal(update.submit, true);
    assert.deepEqual(update.state.selectedIndices, [0]);
  });

  it('supports q cancellation when enabled', () => {
    const update = applyInteractiveSelectionKey(
      { itemCount: 2, allowQuit: true },
      createInitialInteractiveSelectionState(),
      { sequence: 'q', name: 'q' },
    );
    assert.equal(update.cancel, true);
    assert.equal(update.submit, false);
  });

  it('renders a reusable checkbox frame', () => {
    const frame = renderInteractiveSelectFrame(
      {
        question: 'Choose',
        labels: ['1. Alpha', '2. Beta'],
        multiSelect: true,
      },
      { cursorIndex: 1, selectedIndices: [0] },
    );

    assert.match(frame, /Use ↑\/↓ to move, Space to toggle, Enter to submit\./);
    assert.match(frame, /\[x\] 1\. Alpha/);
    assert.match(frame, /› \[ \] 2\. Beta/);
  });

  it('cleans up raw mode after arrow selection', async () => {
    const input = new FakeTtyInput();
    const output = new FakeTtyOutput();
    const promise = promptForSelectionsWithArrows({ question: 'Pick', labels: ['A', 'B'] }, { input, output });

    queueMicrotask(() => {
      input.emit('keypress', '', { name: 'down' });
      input.emit('keypress', '', { name: 'enter' });
    });

    assert.deepEqual(await promise, [2]);
    assert.equal(input.rawMode, false);
    assert.match(output.toString(), /Use ↑\/↓ to move, Enter to select\./);
  });

  it('cleans up raw mode after q cancellation', async () => {
    const input = new FakeTtyInput();
    const output = new FakeTtyOutput();
    const promise = promptForSelectionsWithArrows(
      { question: 'Pick', labels: ['A', 'B'], allowQuit: true },
      { input, output },
    );

    queueMicrotask(() => {
      input.emit('keypress', 'q', { name: 'q', sequence: 'q' });
    });

    assert.equal(await promise, null);
    assert.equal(input.rawMode, false);
    assert.equal(input.listenerCount('keypress'), 0);
  });

  it('cleans up raw mode after Ctrl-C cancellation', async () => {
    const input = new FakeTtyInput();
    const output = new FakeTtyOutput();
    const promise = promptForSelectionsWithArrows({ question: 'Pick', labels: ['A', 'B'] }, { input, output });

    queueMicrotask(() => {
      input.emit('keypress', '', { name: 'c', ctrl: true });
    });

    await assert.rejects(promise, /cancelled/i);
    assert.equal(input.rawMode, false);
    assert.equal(input.listenerCount('keypress'), 0);
  });

  it('cleans up raw mode when rendering fails after setup', async () => {
    const input = new FakeTtyInput();
    const output = new FakeTtyOutput();
    const promise = promptForSelectionsWithArrows(
      {
        question: 'Pick',
        labels: ['A', 'B'],
        renderFrame: () => {
          throw new Error('render boom');
        },
      },
      { input, output },
    );

    await assert.rejects(promise, /render boom/);
    assert.equal(input.rawMode, false);
    assert.equal(input.listenerCount('keypress'), 0);
  });
});
