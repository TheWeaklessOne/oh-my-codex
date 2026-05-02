import { mkdtemp, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import type {
  AudioTranscriptionFailure,
  AudioTranscriptionPreprocessConfig,
  AudioTranscriptionProcessRunner,
} from './types.js';
import { createChildProcessRunner } from './runner.js';

export interface AudioPreprocessInput {
  audioPath: string;
  timeoutMs?: number;
}

export interface AudioPreprocessSuccess {
  ok: true;
  audioPath: string;
  tempDir: string;
  cleanup(): Promise<void>;
}

export type AudioPreprocessResult = AudioPreprocessSuccess | AudioTranscriptionFailure;

export interface AudioPreprocessor {
  preprocess(input: AudioPreprocessInput): Promise<AudioPreprocessResult>;
}

export interface FfmpegWavPreprocessorDeps {
  runner?: AudioTranscriptionProcessRunner;
  mkdtempImpl?: typeof mkdtemp;
  rmImpl?: typeof rm;
  tmpDir?: string;
}

export function buildFfmpegWavArgs(inputPath: string, outputPath: string): string[] {
  return ['-y', '-i', inputPath, '-ar', '16000', '-ac', '1', outputPath];
}

function expandUserPath(pathValue: string): string {
  if (pathValue === '~') return homedir();
  if (pathValue.startsWith('~/')) return join(homedir(), pathValue.slice(2));
  return pathValue;
}

export function isExplicitLocalExecutablePath(pathValue: string | undefined): boolean {
  if (!pathValue?.trim()) return false;
  return isAbsolute(expandUserPath(pathValue.trim()));
}

export class FfmpegWavPreprocessor implements AudioPreprocessor {
  readonly id = 'ffmpeg-wav';
  private readonly runner: AudioTranscriptionProcessRunner;
  private readonly mkdtempImpl: typeof mkdtemp;
  private readonly rmImpl: typeof rm;
  private readonly tmpDir: string;

  constructor(
    private readonly config: Pick<AudioTranscriptionPreprocessConfig, 'binaryPath'>,
    deps: FfmpegWavPreprocessorDeps = {},
  ) {
    this.runner = deps.runner ?? createChildProcessRunner();
    this.mkdtempImpl = deps.mkdtempImpl ?? mkdtemp;
    this.rmImpl = deps.rmImpl ?? rm;
    this.tmpDir = deps.tmpDir ?? tmpdir();
  }

  async preprocess(input: AudioPreprocessInput): Promise<AudioPreprocessResult> {
    const startedAt = Date.now();
    if (!isExplicitLocalExecutablePath(this.config.binaryPath)) {
      return {
        ok: false,
        providerId: this.id,
        code: 'config-error',
        message: 'ffmpeg binaryPath must be an absolute local path when Telegram voice transcription preprocessing is enabled',
        durationMs: Date.now() - startedAt,
      };
    }

    const tempDir = await this.mkdtempImpl(join(this.tmpDir, 'omx-telegram-audio-'));
    const outputPath = join(tempDir, 'input.wav');
    const cleanup = async () => {
      await this.rmImpl(tempDir, { recursive: true, force: true });
    };

    const result = await this.runner({
      command: this.config.binaryPath,
      args: buildFfmpegWavArgs(input.audioPath, outputPath),
      timeoutMs: input.timeoutMs,
      maxStdoutBytes: 16 * 1024,
      maxStderrBytes: 16 * 1024,
    });

    if (result.timedOut) {
      await cleanup();
      return {
        ok: false,
        providerId: this.id,
        code: 'timeout',
        message: 'ffmpeg audio preprocessing timed out',
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: Date.now() - startedAt,
      };
    }

    if (result.error || result.exitCode !== 0) {
      await cleanup();
      return {
        ok: false,
        providerId: this.id,
        code: 'preprocess-failed',
        message: result.error?.message || `ffmpeg exited with code ${result.exitCode ?? 'unknown'}`,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: Date.now() - startedAt,
      };
    }

    return {
      ok: true,
      audioPath: outputPath,
      tempDir,
      cleanup,
    };
  }
}
