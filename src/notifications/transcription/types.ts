export type AudioTranscriptionProviderId = 'whisper-cpp';

export type AudioTranscriptionPreprocessMode =
  | 'off'
  | 'ffmpeg-wav-auto'
  | 'ffmpeg-wav-required';

export type TelegramVoiceTranscriptionInjectMode =
  | 'transcript-only'
  | 'transcript-with-attachment'
  | 'attachment-on-failure';

export type TelegramVoiceTranscriptionFallbackMode =
  | 'attachment-with-diagnostic'
  | 'attachment-only';

export type AudioTranscriptionFailureCode =
  | 'config-error'
  | 'preprocess-failed'
  | 'process-failed'
  | 'timeout'
  | 'missing-output'
  | 'malformed-output'
  | 'empty-output'
  | 'max-duration-exceeded'
  | 'cache-error';

export interface AudioTranscriptionPreprocessConfig {
  mode: AudioTranscriptionPreprocessMode;
  binaryPath: string;
}

export interface WhisperCppTranscriptionConfig {
  binaryPath: string;
  modelPath?: string;
  threads?: number;
  processors?: number;
  temperature?: number;
  outputJsonFull: boolean;
}

export interface TelegramVoiceTranscriptionConfig {
  enabled: boolean;
  provider: AudioTranscriptionProviderId;
  mediaKinds: string[];
  injectMode: TelegramVoiceTranscriptionInjectMode;
  fallbackMode: TelegramVoiceTranscriptionFallbackMode;
  timeoutMs: number;
  maxDurationSeconds: number;
  maxTranscriptChars: number;
  language: string;
  prompt?: string;
  preprocess: AudioTranscriptionPreprocessConfig;
  whisperCpp: WhisperCppTranscriptionConfig;
  warnings?: string[];
}

export interface AudioTranscriptionInput {
  audioPath: string;
  sourceId?: string;
  mimeType?: string;
  durationSeconds?: number;
  timeoutMs?: number;
}

export interface AudioTranscriptionSuccess {
  ok: true;
  providerId: string;
  transcript: string;
  language?: string;
  durationMs?: number;
  stdout?: string;
  stderr?: string;
  metadata?: Record<string, unknown>;
}

export interface AudioTranscriptionFailure {
  ok: false;
  providerId: string;
  code: AudioTranscriptionFailureCode;
  message: string;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

export type AudioTranscriptionResult = AudioTranscriptionSuccess | AudioTranscriptionFailure;

export interface AudioTranscriptionProvider {
  readonly id: string;
  transcribe(input: AudioTranscriptionInput): Promise<AudioTranscriptionResult>;
}

export interface AudioTranscriptionProcessRunOptions {
  command: string;
  args: string[];
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  env?: NodeJS.ProcessEnv;
}

export interface AudioTranscriptionProcessRunResult {
  exitCode: number | null;
  signal?: NodeJS.Signals | string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: Error;
}

export type AudioTranscriptionProcessRunner = (
  options: AudioTranscriptionProcessRunOptions,
) => Promise<AudioTranscriptionProcessRunResult>;
