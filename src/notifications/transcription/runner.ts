import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type {
  AudioTranscriptionProcessRunner,
  AudioTranscriptionProcessRunOptions,
  AudioTranscriptionProcessRunResult,
} from './types.js';

const DEFAULT_CAPTURE_BYTES = 16 * 1024;
const TIMEOUT_SIGKILL_DELAY_MS = 1_000;
const CHILD_PROCESS_ENV_ALLOWLIST = new Set([
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'SystemRoot',
  'SYSTEMROOT',
  'windir',
  'COMSPEC',
]);

function appendBounded(current: string, chunk: Buffer | string, maxBytes: number): string {
  const next = Buffer.concat([Buffer.from(current, 'utf8'), Buffer.from(chunk)]);
  if (next.byteLength <= maxBytes) {
    return next.toString('utf8');
  }
  return `${next.subarray(0, maxBytes).toString('utf8')}\n[truncated]`;
}

function buildChildProcessEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (CHILD_PROCESS_ENV_ALLOWLIST.has(key) || key.startsWith('LC_')) {
      env[key] = value;
    }
  }
  return env;
}

function killChildProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && child.pid) {
    process.kill(-child.pid, signal);
    return;
  }
  child.kill(signal);
}

export function createChildProcessRunner(): AudioTranscriptionProcessRunner {
  return async (options: AudioTranscriptionProcessRunOptions) => await new Promise<AudioTranscriptionProcessRunResult>((resolve) => {
    const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_CAPTURE_BYTES;
    const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_CAPTURE_BYTES;
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const settle = (result: Omit<AudioTranscriptionProcessRunResult, 'stdout' | 'stderr' | 'timedOut'>) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        ...result,
        stdout,
        stderr,
        timedOut,
      });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(options.command, options.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        env: buildChildProcessEnv(options.env ?? process.env),
        windowsHide: true,
      });
    } catch (error) {
      settle({
        exitCode: null,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return;
    }

    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          killChildProcessTree(child, 'SIGTERM');
        } catch {
          // The child may already be gone; close/error handlers will settle.
        }
        killTimer = setTimeout(() => {
          try {
            killChildProcessTree(child, 'SIGKILL');
          } catch {
            // Best-effort hard kill if the process ignored SIGTERM.
          }
        }, TIMEOUT_SIGKILL_DELAY_MS);
      }, options.timeoutMs);
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk, maxStdoutBytes);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk, maxStderrBytes);
    });
    child.on('error', (error) => {
      settle({ exitCode: null, error });
    });
    child.on('close', (exitCode, signal) => {
      settle({
        exitCode,
        signal,
        error: timedOut ? new Error(`Process timed out after ${Date.now() - startedAt}ms`) : undefined,
      });
    });
  });
}
