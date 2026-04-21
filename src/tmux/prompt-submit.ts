import { buildSendPaneArgvs } from '../notifications/tmux-detector.js';
import {
  buildCapturePaneArgv,
  buildVisibleCapturePaneArgv,
  normalizeTmuxCapture,
  paneHasActiveTask,
  paneLooksReady,
  paneShowsCodexViewport,
} from '../scripts/tmux-hook-engine.js';
import { sleep, sleepSync } from '../utils/sleep.js';
import { resolveTmuxBinaryForPlatform, spawnPlatformCommandSync } from '../utils/platform-command.js';

interface TmuxCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export type CodexBlockingPrompt = 'trust' | 'bypass';

interface RunTmuxDeps {
  runTmuxSyncImpl?: (argv: string[]) => TmuxCommandResult;
  sleepImpl?: (ms: number) => Promise<void>;
  sleepSyncImpl?: (ms: number) => void;
  autoAcceptTrustPrompt?: boolean;
  autoAcceptBypassPrompt?: boolean;
}

function defaultRunTmuxSync(argv: string[]): TmuxCommandResult {
  const execution = spawnPlatformCommandSync(
    resolveTmuxBinaryForPlatform() || 'tmux',
    argv,
    {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 3_000,
    },
  );

  return {
    ok: !execution.result.error && execution.result.status === 0,
    stdout: execution.result.stdout ?? '',
    stderr: execution.result.stderr ?? '',
  };
}

export function paneHasTrustPrompt(captured: string): boolean {
  const lines = captured
    .split('\n')
    .map((line) => line.replace(/\r/g, '').trim())
    .filter((line) => line.length > 0);
  const tail = lines.slice(-12);
  const hasQuestion = tail.some((line) => /Do you trust the contents of this directory\?/i.test(line));
  const hasActiveChoices = tail.some((line) => /Yes,\s*continue|No,\s*quit|Press enter to continue/i.test(line));
  return hasQuestion && hasActiveChoices;
}

export function paneHasClaudeBypassPermissionsPrompt(captured: string): boolean {
  const lines = captured
    .split('\n')
    .map((line) => line.replace(/\r/g, '').trim())
    .filter((line) => line.length > 0);
  const tail = lines.slice(-20);
  const hasWarning = tail.some((line) => /Bypass Permissions mode/i.test(line));
  const hasChoices = tail.some((line) => /No,\s*exit/i.test(line))
    && tail.some((line) => /Yes,\s*I\s*accept/i.test(line))
    && tail.some((line) => /Enter\s*to\s*confirm/i.test(line));
  return hasWarning && hasChoices;
}

export function inspectCodexBlockingPrompt(captured: string): CodexBlockingPrompt | null {
  if (paneHasClaudeBypassPermissionsPrompt(captured)) return 'bypass';
  if (paneHasTrustPrompt(captured)) return 'trust';
  return null;
}

export function detectCodexBlockingPanePrompt(
  paneId: string,
  deps: RunTmuxDeps = {},
): CodexBlockingPrompt | null {
  const runTmuxSyncImpl = deps.runTmuxSyncImpl ?? defaultRunTmuxSync;
  const visibleResult = runTmuxSyncImpl(buildVisibleCapturePaneArgv(paneId));
  if (visibleResult.ok) {
    const visiblePrompt = inspectCodexBlockingPrompt(visibleResult.stdout);
    if (visiblePrompt) {
      return visiblePrompt;
    }
  }

  const scrollbackResult = runTmuxSyncImpl(buildCapturePaneArgv(paneId, 80));
  if (!scrollbackResult.ok) {
    return null;
  }
  return inspectCodexBlockingPrompt(scrollbackResult.stdout);
}

function sendKeySync(target: string, key: string, runTmuxSyncImpl: (argv: string[]) => TmuxCommandResult): boolean {
  return runTmuxSyncImpl(['send-keys', '-t', target, key]).ok;
}

function sendRobustEnter(target: string, runTmuxSyncImpl: (argv: string[]) => TmuxCommandResult, sleepSyncImpl: (ms: number) => void): void {
  sendKeySync(target, 'C-m', runTmuxSyncImpl);
  sleepSyncImpl(120);
  sendKeySync(target, 'C-m', runTmuxSyncImpl);
}

function acceptClaudeBypassPermissionsPrompt(
  target: string,
  runTmuxSyncImpl: (argv: string[]) => TmuxCommandResult,
  sleepSyncImpl: (ms: number) => void,
): void {
  runTmuxSyncImpl(['send-keys', '-t', target, '-l', '--', '2']);
  sleepSyncImpl(120);
  sendKeySync(target, 'C-m', runTmuxSyncImpl);
}

function dismissClaudeBypassPermissionsPromptIfPresent(
  target: string,
  captured: string,
  runTmuxSyncImpl: (argv: string[]) => TmuxCommandResult,
  sleepSyncImpl: (ms: number) => void,
  autoAcceptBypassPrompt: boolean,
): boolean {
  if (!autoAcceptBypassPrompt) return false;
  if (!paneHasClaudeBypassPermissionsPrompt(captured)) return false;
  acceptClaudeBypassPermissionsPrompt(target, runTmuxSyncImpl, sleepSyncImpl);
  return true;
}

function paneHasQueuedCodexSubmission(captured: string | null | undefined): boolean {
  const normalized = normalizeTmuxCapture(captured ?? '');
  if (normalized === '') return false;
  return /messages to be submitted after next tool call/i.test(normalized)
    || /press esc to interrupt and send immediately/i.test(normalized);
}

async function attemptSubmitRounds(
  target: string,
  text: string,
  rounds: number,
  submitKeyPressesPerRound: number,
  deps: Required<RunTmuxDeps>,
): Promise<boolean> {
  const presses = Math.max(1, Math.floor(submitKeyPressesPerRound));
  for (let round = 0; round < rounds; round += 1) {
    await deps.sleepImpl(100);
    for (let press = 0; press < presses; press += 1) {
      sendKeySync(target, 'C-m', deps.runTmuxSyncImpl);
      if (press < presses - 1) {
        await deps.sleepImpl(200);
      }
    }
    await deps.sleepImpl(140);
    const captured = deps.runTmuxSyncImpl(buildCapturePaneArgv(target, 80));
    const visibleCapture = deps.runTmuxSyncImpl(buildVisibleCapturePaneArgv(target));
    if (
      !normalizeTmuxCapture(captured.stdout).includes(normalizeTmuxCapture(text))
      && !paneHasQueuedCodexSubmission(visibleCapture.stdout)
    ) {
      return true;
    }
    await deps.sleepImpl(140);
  }
  return false;
}

export function waitForCodexPaneReady(
  paneId: string,
  timeoutMs: number = 30_000,
  deps: RunTmuxDeps = {},
): boolean {
  const runTmuxSyncImpl = deps.runTmuxSyncImpl ?? defaultRunTmuxSync;
  const sleepSyncImpl = deps.sleepSyncImpl ?? sleepSync;
  const resolvedDeps: Required<RunTmuxDeps> = {
    runTmuxSyncImpl,
    sleepImpl: deps.sleepImpl ?? sleep,
    sleepSyncImpl,
    autoAcceptTrustPrompt: deps.autoAcceptTrustPrompt ?? false,
    autoAcceptBypassPrompt: deps.autoAcceptBypassPrompt ?? false,
  };

  const initialBackoffMs = 150;
  const maxBackoffMs = 8_000;
  const startedAt = Date.now();
  let blockedByTrustPrompt = false;
  let blockedByBypassPrompt = false;
  let promptDismissed = false;

  const check = (): boolean => {
    const result = resolvedDeps.runTmuxSyncImpl(buildVisibleCapturePaneArgv(paneId));
    if (!result.ok) return false;
    if (dismissClaudeBypassPermissionsPromptIfPresent(
      paneId,
      result.stdout,
      resolvedDeps.runTmuxSyncImpl,
      resolvedDeps.sleepSyncImpl,
      resolvedDeps.autoAcceptBypassPrompt,
    )) {
      promptDismissed = true;
      return false;
    }
    if (paneHasClaudeBypassPermissionsPrompt(result.stdout)) {
      blockedByBypassPrompt = true;
      return false;
    }
    if (paneHasTrustPrompt(result.stdout)) {
      if (resolvedDeps.autoAcceptTrustPrompt) {
        sendRobustEnter(paneId, resolvedDeps.runTmuxSyncImpl, resolvedDeps.sleepSyncImpl);
        promptDismissed = true;
        return false;
      }
      blockedByTrustPrompt = true;
      return false;
    }
    if (paneLooksReady(result.stdout)) return true;
    if (!paneShowsCodexViewport(result.stdout)) return false;

    const scrollbackResult = resolvedDeps.runTmuxSyncImpl(buildCapturePaneArgv(paneId, 80));
    if (!scrollbackResult.ok) return false;
    return paneLooksReady(scrollbackResult.stdout);
  };

  let delayMs = initialBackoffMs;
  while (Date.now() - startedAt < timeoutMs) {
    if (check()) return true;
    if (blockedByTrustPrompt || blockedByBypassPrompt) return false;
    if (promptDismissed) {
      delayMs = initialBackoffMs;
      promptDismissed = false;
    }
    const remaining = timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) break;
    resolvedDeps.sleepSyncImpl(Math.max(0, Math.min(delayMs, remaining)));
    delayMs = Math.min(maxBackoffMs, delayMs * 2);
  }

  return false;
}

export async function submitPromptToCodexPane(
  paneId: string,
  text: string,
  deps: RunTmuxDeps = {},
): Promise<boolean> {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error('submitPromptToCodexPane: text must be non-empty');
  }

  const resolvedDeps: Required<RunTmuxDeps> = {
    runTmuxSyncImpl: deps.runTmuxSyncImpl ?? defaultRunTmuxSync,
    sleepImpl: deps.sleepImpl ?? sleep,
    sleepSyncImpl: deps.sleepSyncImpl ?? sleepSync,
    autoAcceptTrustPrompt: deps.autoAcceptTrustPrompt ?? false,
    autoAcceptBypassPrompt: deps.autoAcceptBypassPrompt ?? false,
  };

  const captured = resolvedDeps.runTmuxSyncImpl(buildCapturePaneArgv(paneId, 80)).stdout;
  if (dismissClaudeBypassPermissionsPromptIfPresent(
    paneId,
    captured,
    resolvedDeps.runTmuxSyncImpl,
    resolvedDeps.sleepSyncImpl,
    resolvedDeps.autoAcceptBypassPrompt,
  )) {
    await resolvedDeps.sleepImpl(200);
  } else if (paneHasClaudeBypassPermissionsPrompt(captured)) {
    return false;
  }
  if (paneHasTrustPrompt(captured)) {
    if (!resolvedDeps.autoAcceptTrustPrompt) {
      return false;
    }
    sendRobustEnter(paneId, resolvedDeps.runTmuxSyncImpl, resolvedDeps.sleepSyncImpl);
    await resolvedDeps.sleepImpl(200);
  }

  for (const argv of buildSendPaneArgvs(paneId, text, false)) {
    if (!resolvedDeps.runTmuxSyncImpl(argv).ok) {
      return false;
    }
  }

  await resolvedDeps.sleepImpl(150);

  if (await attemptSubmitRounds(paneId, text, 4, 2, resolvedDeps)) {
    return true;
  }

  sendKeySync(paneId, 'C-m', resolvedDeps.runTmuxSyncImpl);
  await resolvedDeps.sleepImpl(120);
  sendKeySync(paneId, 'C-m', resolvedDeps.runTmuxSyncImpl);
  await resolvedDeps.sleepImpl(300);

  const verifyCapture = resolvedDeps.runTmuxSyncImpl(buildCapturePaneArgv(paneId, 80)).stdout;
  const verifyVisibleCapture = resolvedDeps.runTmuxSyncImpl(buildVisibleCapturePaneArgv(paneId)).stdout;
  if (paneHasActiveTask(verifyCapture)) {
    return true;
  }
  if (
    !normalizeTmuxCapture(verifyCapture).includes(normalizeTmuxCapture(text))
    && !paneHasQueuedCodexSubmission(verifyVisibleCapture)
  ) {
    return true;
  }

  sendKeySync(paneId, 'C-m', resolvedDeps.runTmuxSyncImpl);
  await resolvedDeps.sleepImpl(150);
  sendKeySync(paneId, 'C-m', resolvedDeps.runTmuxSyncImpl);
  const finalVisibleCapture = resolvedDeps.runTmuxSyncImpl(buildVisibleCapturePaneArgv(paneId)).stdout;
  return !paneHasQueuedCodexSubmission(finalVisibleCapture);
}
