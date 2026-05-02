import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type {
  AudioPreprocessor,
  AudioPreprocessResult,
} from './preprocess.js';
import { FfmpegWavPreprocessor, isExplicitLocalExecutablePath } from './preprocess.js';
import { createChildProcessRunner } from './runner.js';
import type {
  AudioTranscriptionFailure,
  AudioTranscriptionInput,
  AudioTranscriptionProcessRunner,
  AudioTranscriptionProvider,
  AudioTranscriptionResult,
  TelegramVoiceTranscriptionConfig,
  WhisperCppTranscriptionConfig,
} from './types.js';

export interface WhisperCppTranscriptionProviderDeps {
  runner?: AudioTranscriptionProcessRunner;
  preprocessor?: AudioPreprocessor;
  mkdtempImpl?: typeof mkdtemp;
  readFileImpl?: typeof readFile;
  rmImpl?: typeof rm;
  tmpDir?: string;
}

export interface WhisperCppParsedJsonOutput {
  transcript: string;
  language?: string;
  metadata?: Record<string, unknown>;
}

export function expandUserPath(pathValue: string): string {
  if (pathValue === '~') {
    return homedir();
  }
  if (pathValue.startsWith('~/')) {
    return join(homedir(), pathValue.slice(2));
  }
  return pathValue;
}

export function resolveLocalPath(pathValue: string): string {
  const expanded = expandUserPath(pathValue);
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

function addOptionalNumberArg(args: string[], flag: string, value: number | undefined): void {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    args.push(flag, String(value));
  }
}

export function buildWhisperCppArgs(
  config: WhisperCppTranscriptionConfig,
  inputPath: string,
  outputBasePath: string,
  options: Pick<TelegramVoiceTranscriptionConfig, 'language' | 'prompt'>,
): string[] {
  const args = [
    '--model', resolveLocalPath(config.modelPath ?? ''),
    '--file', inputPath,
  ];

  if (options.language.trim()) {
    args.push('--language', options.language.trim());
  }
  if (options.prompt?.trim()) {
    args.push('--prompt', options.prompt.trim());
  }

  args.push('--output-json');
  if (config.outputJsonFull) {
    args.push('--output-json-full');
  }
  args.push('--output-file', outputBasePath);
  addOptionalNumberArg(args, '--threads', config.threads);
  addOptionalNumberArg(args, '--processors', config.processors);
  addOptionalNumberArg(args, '--temperature', config.temperature);
  args.push('--no-prints');
  return args;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function segmentText(segment: unknown): string {
  if (typeof segment === 'string') return segment;
  if (isRecord(segment) && typeof segment.text === 'string') return segment.text;
  return '';
}

export function parseWhisperCppJsonOutput(jsonText: string): WhisperCppParsedJsonOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`Malformed whisper.cpp JSON output: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!isRecord(parsed)) {
    throw new Error('Malformed whisper.cpp JSON output: root is not an object');
  }

  const transcript = Array.isArray(parsed.transcription)
    ? parsed.transcription.map(segmentText).join('').trim()
    : typeof parsed.text === 'string'
      ? parsed.text.trim()
      : typeof parsed.transcript === 'string'
        ? parsed.transcript.trim()
        : '';

  if (!transcript) {
    throw new Error('whisper.cpp JSON output did not contain transcript text');
  }

  const result = isRecord(parsed.result) ? parsed.result : undefined;
  const language = typeof result?.language === 'string'
    ? result.language
    : typeof parsed.language === 'string'
      ? parsed.language
      : undefined;

  return {
    transcript,
    ...(language ? { language } : {}),
    metadata: {
      ...(typeof parsed.systeminfo === 'string' ? { systeminfo: parsed.systeminfo } : {}),
      ...(isRecord(parsed.params) ? { params: parsed.params } : {}),
      ...(isRecord(parsed.result) ? { result: parsed.result } : {}),
    },
  };
}

async function cleanupBestEffort(cleanup: (() => Promise<void>) | undefined): Promise<void> {
  if (!cleanup) return;
  try {
    await cleanup();
  } catch {
    // Temporary-file cleanup is best effort; transcription result is already determined.
  }
}

function resolveRemainingTimeoutMs(startedAt: number, timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined || timeoutMs <= 0) {
    return undefined;
  }
  return Math.max(0, timeoutMs - (Date.now() - startedAt));
}

export class WhisperCppTranscriptionProvider implements AudioTranscriptionProvider {
  readonly id = 'whisper-cpp';
  private readonly runner: AudioTranscriptionProcessRunner;
  private readonly preprocessor?: AudioPreprocessor;
  private readonly mkdtempImpl: typeof mkdtemp;
  private readonly readFileImpl: typeof readFile;
  private readonly rmImpl: typeof rm;
  private readonly tmpDir: string;

  constructor(
    private readonly config: TelegramVoiceTranscriptionConfig,
    deps: WhisperCppTranscriptionProviderDeps = {},
  ) {
    this.runner = deps.runner ?? createChildProcessRunner();
    this.preprocessor = deps.preprocessor
      ?? (config.preprocess.mode === 'off'
        ? undefined
        : new FfmpegWavPreprocessor(config.preprocess, { runner: this.runner }));
    this.mkdtempImpl = deps.mkdtempImpl ?? mkdtemp;
    this.readFileImpl = deps.readFileImpl ?? readFile;
    this.rmImpl = deps.rmImpl ?? rm;
    this.tmpDir = deps.tmpDir ?? tmpdir();
  }

  async transcribe(input: AudioTranscriptionInput): Promise<AudioTranscriptionResult> {
    const startedAt = Date.now();
    const totalTimeoutMs = input.timeoutMs ?? this.config.timeoutMs;
    const modelPath = this.config.whisperCpp.modelPath?.trim();
    if (!modelPath) {
      return this.failure('config-error', 'whisper.cpp modelPath is required when Telegram voice transcription is enabled', startedAt);
    }
    if (!isExplicitLocalExecutablePath(this.config.whisperCpp.binaryPath)) {
      return this.failure('config-error', 'whisper.cpp binaryPath must be an absolute local path when Telegram voice transcription is enabled', startedAt);
    }
    if (this.config.preprocess.mode !== 'off' && !isExplicitLocalExecutablePath(this.config.preprocess.binaryPath)) {
      return this.failure('config-error', 'ffmpeg binaryPath must be an absolute local path when Telegram voice transcription preprocessing is enabled', startedAt);
    }

    let audioPath = input.audioPath;
    let preprocessed: AudioPreprocessResult | undefined;
    let preprocessCleanup: (() => Promise<void>) | undefined;
    let preprocessDiagnostic: AudioTranscriptionFailure | undefined;
    let tempDir: string | undefined;

    try {
      if (this.preprocessor) {
        preprocessed = await this.preprocessor.preprocess({
          audioPath: input.audioPath,
          timeoutMs: resolveRemainingTimeoutMs(startedAt, totalTimeoutMs),
        });
        if (preprocessed.ok) {
          audioPath = preprocessed.audioPath;
          preprocessCleanup = preprocessed.cleanup;
        } else if (this.config.preprocess.mode === 'ffmpeg-wav-auto') {
          preprocessDiagnostic = preprocessed;
        } else {
          return {
            ok: false,
            providerId: this.id,
            code: preprocessed.code === 'timeout' ? 'timeout' : 'preprocess-failed',
            message: preprocessed.message,
            stdout: preprocessed.stdout,
            stderr: preprocessed.stderr,
            durationMs: Date.now() - startedAt,
          };
        }
      }

      const remainingTimeoutMs = resolveRemainingTimeoutMs(startedAt, totalTimeoutMs);
      if (remainingTimeoutMs !== undefined && remainingTimeoutMs <= 0) {
        return this.failure('timeout', 'whisper.cpp transcription timed out before transcription could start', startedAt);
      }

      tempDir = await this.mkdtempImpl(join(this.tmpDir, 'omx-whisper-cpp-'));
      const outputBasePath = join(tempDir, 'transcript');
      const outputJsonPath = `${outputBasePath}.json`;
      const result = await this.runner({
        command: this.config.whisperCpp.binaryPath,
        args: buildWhisperCppArgs(this.config.whisperCpp, audioPath, outputBasePath, this.config),
        timeoutMs: remainingTimeoutMs,
        maxStdoutBytes: 32 * 1024,
        maxStderrBytes: 32 * 1024,
      });

      if (result.timedOut) {
        return this.failure('timeout', 'whisper.cpp transcription timed out', startedAt, result.stdout, result.stderr);
      }
      if (result.error || result.exitCode !== 0) {
        return this.failure(
          'process-failed',
          result.error?.message || `whisper.cpp exited with code ${result.exitCode ?? 'unknown'}`,
          startedAt,
          result.stdout,
          result.stderr,
        );
      }

      let jsonText: string;
      try {
        jsonText = await this.readFileImpl(outputJsonPath, 'utf-8');
      } catch (error) {
        return this.failure(
          'missing-output',
          `whisper.cpp did not produce JSON output at ${outputJsonPath}: ${error instanceof Error ? error.message : String(error)}`,
          startedAt,
          result.stdout,
          result.stderr,
        );
      }

      let parsed: WhisperCppParsedJsonOutput;
      try {
        parsed = parseWhisperCppJsonOutput(jsonText);
      } catch (error) {
        return this.failure(
          error instanceof Error && error.message.includes('did not contain transcript') ? 'empty-output' : 'malformed-output',
          error instanceof Error ? error.message : String(error),
          startedAt,
          result.stdout,
          result.stderr,
        );
      }

      return {
        ok: true,
        providerId: this.id,
        transcript: parsed.transcript,
        ...(parsed.language ? { language: parsed.language } : {}),
        durationMs: Date.now() - startedAt,
        stdout: result.stdout,
        stderr: result.stderr,
        metadata: {
          ...(parsed.metadata ?? {}),
          ...(preprocessDiagnostic ? {
            preprocessFallback: {
              code: preprocessDiagnostic.code,
              message: preprocessDiagnostic.message,
            },
          } : {}),
        },
      };
    } catch (error) {
      return this.failure(
        'process-failed',
        error instanceof Error ? error.message : String(error),
        startedAt,
      );
    } finally {
      if (tempDir) {
        const cleanupTempDir = tempDir;
        await cleanupBestEffort(async () => {
          await this.rmImpl(cleanupTempDir, { recursive: true, force: true });
        });
      }
      await cleanupBestEffort(preprocessCleanup);
    }
  }

  private failure(
    code: AudioTranscriptionFailure['code'],
    message: string,
    startedAt: number,
    stdout?: string,
    stderr?: string,
  ): AudioTranscriptionFailure {
    return {
      ok: false,
      providerId: this.id,
      code,
      message,
      ...(stdout ? { stdout } : {}),
      ...(stderr ? { stderr } : {}),
      durationMs: Date.now() - startedAt,
    };
  }
}

export async function fingerprintWhisperCppModelPath(modelPath: string | undefined): Promise<string> {
  const trimmed = modelPath?.trim();
  if (!trimmed) {
    return 'missing-model-path';
  }
  const resolved = resolveLocalPath(trimmed);
  try {
    const stats = await stat(resolved);
    return `${resolved}:size=${stats.size}:mtimeMs=${Math.trunc(stats.mtimeMs)}`;
  } catch {
    return `${resolved}:missing`;
  }
}
