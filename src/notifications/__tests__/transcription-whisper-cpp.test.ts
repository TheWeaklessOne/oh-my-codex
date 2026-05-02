import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  WhisperCppTranscriptionProvider,
  buildWhisperCppArgs,
  parseWhisperCppJsonOutput,
} from '../transcription/whisper-cpp.js';
import type { AudioPreprocessor, AudioPreprocessInput, AudioPreprocessResult } from '../transcription/preprocess.js';
import type {
  AudioTranscriptionProcessRunner,
  TelegramVoiceTranscriptionConfig,
} from '../transcription/types.js';

function config(overrides: Partial<TelegramVoiceTranscriptionConfig> = {}): TelegramVoiceTranscriptionConfig {
  return {
    enabled: true,
    provider: 'whisper-cpp',
    mediaKinds: ['voice'],
    injectMode: 'transcript-only',
    fallbackMode: 'attachment-with-diagnostic',
    timeoutMs: 120000,
    maxDurationSeconds: 300,
    maxTranscriptChars: 3500,
    language: 'auto',
    prompt: 'preserve languages',
    ...overrides,
    preprocess: {
      mode: overrides.preprocess?.mode ?? 'off',
      binaryPath: overrides.preprocess?.binaryPath ?? '/usr/bin/ffmpeg',
    },
    whisperCpp: {
      binaryPath: overrides.whisperCpp?.binaryPath ?? '/usr/local/bin/whisper-cli',
      modelPath: overrides.whisperCpp?.modelPath ?? '/models/ggml-large-v3.bin',
      threads: overrides.whisperCpp?.threads ?? 0,
      processors: overrides.whisperCpp?.processors ?? 1,
      temperature: overrides.whisperCpp?.temperature ?? 0,
      outputJsonFull: overrides.whisperCpp?.outputJsonFull ?? false,
    },
  };
}

function outputFileBase(args: string[]): string {
  const index = args.indexOf('--output-file');
  assert.notEqual(index, -1);
  return args[index + 1];
}

class FakePreprocessor implements AudioPreprocessor {
  calls: AudioPreprocessInput[] = [];

  constructor(private readonly result: AudioPreprocessResult) {}

  async preprocess(input: AudioPreprocessInput): Promise<AudioPreprocessResult> {
    this.calls.push(input);
    return this.result;
  }
}

describe('whisper.cpp transcription provider', () => {
  it('builds structured whisper-cli args with configured model, file, language, prompt, and JSON output', () => {
    const args = buildWhisperCppArgs(
      {
        binaryPath: 'whisper-cli',
        modelPath: '~/models/model.bin',
        threads: 6,
        processors: 2,
        temperature: 0.2,
        outputJsonFull: true,
      },
      '/tmp/input.ogg',
      '/tmp/output-base',
      { language: 'auto', prompt: 'Transcribe exactly.' },
    );

    assert.deepEqual(args, [
      '--model', `${process.env.HOME}/models/model.bin`,
      '--file', '/tmp/input.ogg',
      '--language', 'auto',
      '--prompt', 'Transcribe exactly.',
      '--output-json',
      '--output-json-full',
      '--output-file', '/tmp/output-base',
      '--threads', '6',
      '--processors', '2',
      '--temperature', '0.2',
      '--no-prints',
    ]);
  });

  it('omits optional numeric flags when unset or zero', () => {
    const args = buildWhisperCppArgs(
      {
        binaryPath: 'whisper-cli',
        modelPath: '/models/model.bin',
        threads: 0,
        processors: 0,
        temperature: 0,
        outputJsonFull: false,
      },
      '/tmp/input.ogg',
      '/tmp/output-base',
      { language: 'en' },
    );

    assert.equal(args.includes('--threads'), false);
    assert.equal(args.includes('--processors'), false);
    assert.equal(args.includes('--temperature'), false);
    assert.equal(args.includes('--output-json-full'), false);
  });

  it('parses whisper.cpp JSON sidecar into a normalized transcript', () => {
    const parsed = parseWhisperCppJsonOutput(JSON.stringify({
      result: { language: 'ru' },
      transcription: [{ text: 'Привет ' }, { text: 'hello' }],
    }));

    assert.equal(parsed.transcript, 'Привет hello');
    assert.equal(parsed.language, 'ru');
  });

  it('reads generated JSON sidecar and returns transcript text', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-whisper-provider-success-'));
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: AudioTranscriptionProcessRunner = async ({ command, args }) => {
      calls.push({ command, args });
      await writeFile(`${outputFileBase(args)}.json`, JSON.stringify({
        result: { language: 'auto' },
        transcription: [{ text: 'bonjour привет hello' }],
      }));
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    };

    try {
      const provider = new WhisperCppTranscriptionProvider(config(), { runner, tmpDir: tempRoot });
      const result = await provider.transcribe({ audioPath: '/tmp/voice.ogg' });
      assert.equal(result.ok, true);
      assert.equal(result.ok ? result.transcript : '', 'bonjour привет hello');
      assert.equal(calls[0]?.command, '/usr/local/bin/whisper-cli');
      assert.deepEqual(calls[0]?.args.slice(0, 4), ['--model', '/models/ggml-large-v3.bin', '--file', '/tmp/voice.ogg']);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('returns typed failures for malformed or missing JSON sidecars', async () => {
    const malformedRunner: AudioTranscriptionProcessRunner = async ({ args }) => {
      await writeFile(`${outputFileBase(args)}.json`, '{not json');
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    };
    const missingRunner: AudioTranscriptionProcessRunner = async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
    });

    const malformed = await new WhisperCppTranscriptionProvider(config(), { runner: malformedRunner })
      .transcribe({ audioPath: '/tmp/voice.ogg' });
    const missing = await new WhisperCppTranscriptionProvider(config(), { runner: missingRunner })
      .transcribe({ audioPath: '/tmp/voice.ogg' });

    assert.equal(malformed.ok, false);
    assert.equal(malformed.ok ? '' : malformed.code, 'malformed-output');
    assert.equal(missing.ok, false);
    assert.equal(missing.ok ? '' : missing.code, 'missing-output');
  });

  it('returns typed process and timeout failures', async () => {
    const failedRunner: AudioTranscriptionProcessRunner = async () => ({
      exitCode: 2,
      stdout: 'out',
      stderr: 'bad model',
      timedOut: false,
    });
    const timeoutRunner: AudioTranscriptionProcessRunner = async () => ({
      exitCode: null,
      stdout: '',
      stderr: 'slow',
      timedOut: true,
    });

    const failed = await new WhisperCppTranscriptionProvider(config(), { runner: failedRunner })
      .transcribe({ audioPath: '/tmp/voice.ogg' });
    const timedOut = await new WhisperCppTranscriptionProvider(config(), { runner: timeoutRunner })
      .transcribe({ audioPath: '/tmp/voice.ogg' });

    assert.equal(failed.ok, false);
    assert.equal(failed.ok ? '' : failed.code, 'process-failed');
    assert.equal(failed.ok ? '' : failed.stderr, 'bad model');
    assert.equal(timedOut.ok, false);
    assert.equal(timedOut.ok ? '' : timedOut.code, 'timeout');
  });

  it('falls back to original audio when optional ffmpeg preprocessing fails', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-whisper-provider-preprocess-auto-'));
    const preprocessor = new FakePreprocessor({
      ok: false,
      providerId: 'ffmpeg-wav',
      code: 'preprocess-failed',
      message: 'ffmpeg cannot decode input',
    });
    const calls: Array<{ command: string; args: string[]; timeoutMs?: number }> = [];
    const runner: AudioTranscriptionProcessRunner = async ({ command, args, timeoutMs }) => {
      calls.push({ command, args, timeoutMs });
      await writeFile(`${outputFileBase(args)}.json`, JSON.stringify({ text: 'fallback transcript' }));
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    };

    try {
      const provider = new WhisperCppTranscriptionProvider(
        config({ preprocess: { mode: 'ffmpeg-wav-auto', binaryPath: '/usr/bin/ffmpeg' } }),
        { runner, preprocessor, tmpDir: tempRoot },
      );
      const result = await provider.transcribe({ audioPath: '/tmp/original.ogg', timeoutMs: 1000 });

      assert.equal(result.ok, true);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0]?.args.slice(2, 4), ['--file', '/tmp/original.ogg']);
      assert.deepEqual(result.ok ? result.metadata?.preprocessFallback : undefined, {
        code: 'preprocess-failed',
        message: 'ffmpeg cannot decode input',
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('stops before whisper.cpp when required ffmpeg preprocessing fails', async () => {
    const preprocessor = new FakePreprocessor({
      ok: false,
      providerId: 'ffmpeg-wav',
      code: 'preprocess-failed',
      message: 'ffmpeg cannot decode input',
    });
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: AudioTranscriptionProcessRunner = async ({ command, args }) => {
      calls.push({ command, args });
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    };

    const provider = new WhisperCppTranscriptionProvider(
      config({ preprocess: { mode: 'ffmpeg-wav-required', binaryPath: '/usr/bin/ffmpeg' } }),
      { runner, preprocessor },
    );
    const result = await provider.transcribe({ audioPath: '/tmp/original.ogg' });

    assert.equal(result.ok, false);
    assert.equal(result.ok ? '' : result.code, 'preprocess-failed');
    assert.equal(calls.length, 0);
  });

  it('passes only the remaining end-to-end timeout to whisper.cpp after preprocessing', async () => {
    const originalNow = Date.now;
    let now = 1_000;
    Date.now = () => now;
    const preprocessor = new FakePreprocessor({
      ok: true,
      audioPath: '/tmp/preprocessed.wav',
      tempDir: '/tmp/preprocess-dir',
      cleanup: async () => {},
    });
    const calls: Array<{ timeoutMs?: number }> = [];
    const runner: AudioTranscriptionProcessRunner = async ({ args, timeoutMs }) => {
      calls.push({ timeoutMs });
      await writeFile(`${outputFileBase(args)}.json`, JSON.stringify({ text: 'deadline transcript' }));
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    };

    try {
      const provider = new WhisperCppTranscriptionProvider(
        config({ timeoutMs: 100, preprocess: { mode: 'ffmpeg-wav-required', binaryPath: '/usr/bin/ffmpeg' } }),
        { runner, preprocessor },
      );
      const pending = provider.transcribe({ audioPath: '/tmp/original.ogg' });
      now += 75;
      const result = await pending;

      assert.equal(result.ok, true);
      assert.equal(preprocessor.calls[0]?.timeoutMs, 100);
      assert.equal(calls[0]?.timeoutMs, 25);
    } finally {
      Date.now = originalNow;
    }
  });

  it('cleans successful preprocess output if whisper temp directory creation fails', async () => {
    let cleaned = false;
    const preprocessor = new FakePreprocessor({
      ok: true,
      audioPath: '/tmp/preprocessed.wav',
      tempDir: '/tmp/preprocess-dir',
      cleanup: async () => { cleaned = true; },
    });

    const provider = new WhisperCppTranscriptionProvider(
      config({ preprocess: { mode: 'ffmpeg-wav-required', binaryPath: '/usr/bin/ffmpeg' } }),
      {
        preprocessor,
        mkdtempImpl: async () => {
          throw new Error('tmpdir unavailable');
        },
      },
    );
    const result = await provider.transcribe({ audioPath: '/tmp/original.ogg' });

    assert.equal(result.ok, false);
    assert.equal(result.ok ? '' : result.code, 'process-failed');
    assert.equal(cleaned, true);
  });
});
