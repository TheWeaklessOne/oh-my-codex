import { WhisperCppTranscriptionProvider, fingerprintWhisperCppModelPath } from './whisper-cpp.js';
import type { WhisperCppTranscriptionProviderDeps } from './whisper-cpp.js';
import { isExplicitLocalExecutablePath } from './preprocess.js';
import type {
  AudioTranscriptionInput,
  AudioTranscriptionProvider,
  AudioTranscriptionResult,
  TelegramVoiceTranscriptionConfig,
} from './types.js';

class ConfigurationFailureTranscriptionProvider implements AudioTranscriptionProvider {
  readonly id: string;

  constructor(
    providerId: string,
    private readonly message: string,
  ) {
    this.id = providerId;
  }

  async transcribe(_input: AudioTranscriptionInput): Promise<AudioTranscriptionResult> {
    return {
      ok: false,
      providerId: this.id,
      code: 'config-error',
      message: this.message,
    };
  }
}

export type AudioTranscriptionProviderDeps = WhisperCppTranscriptionProviderDeps;

export function createAudioTranscriptionProvider(
  config: TelegramVoiceTranscriptionConfig,
  deps: AudioTranscriptionProviderDeps = {},
): AudioTranscriptionProvider {
  if (config.provider !== 'whisper-cpp') {
    return new ConfigurationFailureTranscriptionProvider(
      String(config.provider),
      `Unsupported audio transcription provider: ${String(config.provider)}`,
    );
  }

  if (!config.whisperCpp.modelPath?.trim()) {
    return new ConfigurationFailureTranscriptionProvider(
      'whisper-cpp',
      'whisper.cpp modelPath is required when Telegram voice transcription is enabled',
    );
  }

  if (!isExplicitLocalExecutablePath(config.whisperCpp.binaryPath)) {
    return new ConfigurationFailureTranscriptionProvider(
      'whisper-cpp',
      'whisper.cpp binaryPath must be an absolute local path when Telegram voice transcription is enabled',
    );
  }

  if (config.preprocess.mode !== 'off' && !isExplicitLocalExecutablePath(config.preprocess.binaryPath)) {
    return new ConfigurationFailureTranscriptionProvider(
      'whisper-cpp',
      'ffmpeg binaryPath must be an absolute local path when Telegram voice transcription preprocessing is enabled',
    );
  }

  return new WhisperCppTranscriptionProvider(config, deps);
}

export async function fingerprintAudioTranscriptionModel(
  config: TelegramVoiceTranscriptionConfig,
): Promise<string> {
  if (config.provider === 'whisper-cpp') {
    return await fingerprintWhisperCppModelPath(config.whisperCpp.modelPath);
  }
  return `${config.provider}:unknown-model`;
}
