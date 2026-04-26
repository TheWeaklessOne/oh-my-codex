import { stdin as defaultInput, stdout as defaultOutput } from 'node:process';
import { emitKeypressEvents } from 'node:readline';

export interface SelectUiInput {
  isTTY?: boolean;
  on(event: 'keypress', listener: (str: string, key: KeyLike) => void): this;
  off(event: 'keypress', listener: (str: string, key: KeyLike) => void): this;
  resume?(): void;
  pause?(): void;
  setRawMode?(mode: boolean): void;
}

export interface SelectUiOutput {
  isTTY?: boolean;
  write(chunk: string): boolean;
}

export interface SelectUiDeps {
  input?: SelectUiInput;
  output?: SelectUiOutput;
}

export interface InteractiveSelectionState {
  cursorIndex: number;
  selectedIndices: number[];
  error?: string;
}

export interface SelectionUpdate {
  state: InteractiveSelectionState;
  submit: boolean;
  cancel?: boolean;
}

export interface KeyLike {
  name?: string;
  ctrl?: boolean;
  sequence?: string;
}

export interface InteractiveSelectionKeyOptions {
  itemCount: number;
  multiSelect?: boolean;
  allowQuit?: boolean;
  emptySelectionError?: string;
}

export interface SelectFrameOptions {
  header?: string;
  question: string;
  labels: string[];
  multiSelect?: boolean;
  singleSelectInstructions?: string;
  multiSelectInstructions?: string;
}

export interface SelectPromptOptions extends SelectFrameOptions {
  renderFrame?: (state: InteractiveSelectionState) => string;
  allowQuit?: boolean;
  cancelMessage?: string;
  emptySelectionError?: string;
}

export function supportsInteractiveSelectUi(input: SelectUiInput, output: SelectUiOutput): boolean {
  return Boolean(input.isTTY && output.isTTY && typeof input.setRawMode === 'function');
}

function toggleSelection(selectedIndices: number[], index: number): number[] {
  return selectedIndices.includes(index)
    ? selectedIndices.filter((value) => value !== index)
    : [...selectedIndices, index].sort((left, right) => left - right);
}

export function createInitialInteractiveSelectionState(): InteractiveSelectionState {
  return {
    cursorIndex: 0,
    selectedIndices: [],
  };
}

export function applyInteractiveSelectionKey(
  options: InteractiveSelectionKeyOptions,
  state: InteractiveSelectionState,
  key: KeyLike,
): SelectionUpdate {
  const itemCount = options.itemCount;
  const multiSelect = options.multiSelect === true;
  if (itemCount === 0) throw new Error('Interactive selection UI requires at least one selectable item.');

  const moveCursor = (delta: number): SelectionUpdate => ({
    submit: false,
    state: {
      ...state,
      cursorIndex: (state.cursorIndex + delta + itemCount) % itemCount,
      error: undefined,
    },
  });

  if (key.name === 'up') return moveCursor(-1);
  if (key.name === 'down') return moveCursor(1);

  if (options.allowQuit && (key.name === 'q' || key.sequence === 'q')) {
    return {
      submit: false,
      cancel: true,
      state: {
        ...state,
        error: undefined,
      },
    };
  }

  if (key.sequence && /^[1-9]$/.test(key.sequence)) {
    const explicitIndex = Number.parseInt(key.sequence, 10) - 1;
    if (explicitIndex < itemCount) {
      return {
        submit: !multiSelect,
        state: {
          ...state,
          cursorIndex: explicitIndex,
          selectedIndices: multiSelect ? toggleSelection(state.selectedIndices, explicitIndex) : state.selectedIndices,
          error: undefined,
        },
      };
    }
  }

  if (key.name === 'space') {
    if (!multiSelect) {
      return {
        submit: true,
        state: {
          ...state,
          error: undefined,
        },
      };
    }
    return {
      submit: false,
      state: {
        ...state,
        selectedIndices: toggleSelection(state.selectedIndices, state.cursorIndex),
        error: undefined,
      },
    };
  }

  if (key.name === 'return' || key.name === 'enter') {
    if (!multiSelect) {
      return {
        submit: true,
        state: {
          ...state,
          error: undefined,
        },
      };
    }
    if (state.selectedIndices.length > 0) {
      return {
        submit: true,
        state: {
          ...state,
          error: undefined,
        },
      };
    }
    return {
      submit: false,
      state: {
        ...state,
        error: options.emptySelectionError ?? 'Select one or more options with Space before pressing Enter.',
      },
    };
  }

  return { submit: false, state };
}

export function renderInteractiveSelectFrame(
  options: SelectFrameOptions,
  state: InteractiveSelectionState,
): string {
  const lines: string[] = [];
  const multiSelect = options.multiSelect === true;

  if (options.header) lines.push(options.header);
  lines.push(options.question, '');

  options.labels.forEach((label, index) => {
    const isActive = state.cursorIndex === index;
    const isChecked = multiSelect ? state.selectedIndices.includes(index) : isActive;
    lines.push(`${isActive ? '›' : ' '} [${isChecked ? 'x' : ' '}] ${label}`);
  });

  lines.push('');
  lines.push(
    multiSelect
      ? options.multiSelectInstructions ?? 'Use ↑/↓ to move, Space to toggle, Enter to submit.'
      : options.singleSelectInstructions ?? 'Use ↑/↓ to move, Enter to select.',
  );

  if (state.error) lines.push(state.error);
  return `${lines.join('\n')}\n`;
}

export async function promptForSelectionsWithArrows(
  options: SelectPromptOptions,
  deps: SelectUiDeps = {},
): Promise<number[] | null> {
  const input = deps.input ?? defaultInput;
  const output = deps.output ?? defaultOutput;
  if (!supportsInteractiveSelectUi(input, output)) {
    throw new Error('Interactive arrow UI requires TTY stdin/stdout with raw-mode support.');
  }
  if (options.labels.length === 0) throw new Error('Interactive selection UI requires at least one selectable item.');

  return new Promise<number[] | null>((resolve, reject) => {
    let state = createInitialInteractiveSelectionState();
    let finished = false;

    const safeWrite = (chunk: string) => {
      try {
        output.write(chunk);
      } catch {
        // Best-effort terminal cleanup must not prevent raw-mode restoration.
      }
    };

    const cleanup = () => {
      input.off('keypress', onKeypress);
      input.setRawMode?.(false);
      input.pause?.();
      safeWrite('\u001b[?25h');
    };

    const finish = (selections: number[] | null) => {
      if (finished) return;
      finished = true;
      cleanup();
      safeWrite('\n');
      resolve(selections);
    };

    const fail = (error: Error) => {
      if (finished) return;
      finished = true;
      cleanup();
      safeWrite('\n');
      reject(error);
    };

    const render = (): boolean => {
      try {
        output.write('\u001b[H\u001b[J');
        output.write('\u001b[?25l');
        output.write(options.renderFrame ? options.renderFrame(state) : renderInteractiveSelectFrame(options, state));
        return true;
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
        return false;
      }
    };

    const onKeypress = (_: string, key: KeyLike) => {
      if (key.ctrl && key.name === 'c') {
        fail(new Error(options.cancelMessage ?? 'Interactive selection cancelled by user.'));
        return;
      }

      const update = applyInteractiveSelectionKey(
        {
          itemCount: options.labels.length,
          multiSelect: options.multiSelect,
          allowQuit: options.allowQuit,
          emptySelectionError: options.emptySelectionError,
        },
        state,
        key,
      );
      state = update.state;
      if (update.cancel) {
        finish(null);
        return;
      }
      if (!render()) return;
      if (!update.submit) return;

      if (options.multiSelect) {
        finish(state.selectedIndices.map((index) => index + 1));
        return;
      }
      finish([state.cursorIndex + 1]);
    };

    emitKeypressEvents(input as NodeJS.ReadableStream);
    input.setRawMode?.(true);
    input.resume?.();
    input.on('keypress', onKeypress);
    render();
  });
}
