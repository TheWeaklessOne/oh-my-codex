import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ClientRequestArgs, IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildTelegramPromptInput } from '../telegram-inbound/index.js';
import type { TelegramInboundMessage } from '../telegram-inbound/types.js';
import type {
  AudioTranscriptionInput,
  AudioTranscriptionProvider,
  AudioTranscriptionResult,
  TelegramVoiceTranscriptionConfig,
} from '../transcription/types.js';
import { markMockTelegramTransportForTests } from '../../utils/test-env.js';

type HttpsRouteHandler = (body: string, options: ClientRequestArgs) => {
  statusCode: number;
  body?: unknown;
};

function createHttpsRequestMock(routes: Record<string, HttpsRouteHandler>): typeof import('node:https').request {
  return markMockTelegramTransportForTests(((options: ClientRequestArgs, callback?: (res: IncomingMessage) => void) => {
    const listeners = new Map<string, Array<(value?: unknown) => void>>();
    let requestBody = '';
    const request = {
      on(event: string, listener: (value?: unknown) => void) {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
        return request;
      },
      write(chunk: string | Buffer) {
        requestBody += chunk.toString();
        return true;
      },
      end() {
        const key = `${String(options.method ?? 'GET')} ${String(options.path)}`;
        const route = routes[key];
        if (!route) {
          for (const listener of listeners.get('error') ?? []) listener(new Error(`Unexpected route ${key}`));
          return request;
        }
        const response = route(requestBody, options);
        const res = new PassThrough() as unknown as IncomingMessage & PassThrough;
        res.statusCode = response.statusCode;
        callback?.(res);
        const body = typeof response.body === 'string' || Buffer.isBuffer(response.body)
          ? response.body
          : JSON.stringify(response.body ?? {});
        res.end(body);
        return request;
      },
      destroy() {},
      setTimeout() { return request; },
    };
    return request as unknown as import('node:http').ClientRequest;
  }) as typeof import('node:https').request);
}

function voiceMessage(overrides: Partial<TelegramInboundMessage> = {}): TelegramInboundMessage {
  return {
    messageId: 501,
    chatId: 777,
    textPart: undefined,
    mediaParts: [{
      kind: 'media',
      mediaKind: 'voice',
      index: 1,
      fileId: 'voice-file',
      fileUniqueId: 'voice-unique-1',
      mimeType: 'audio/ogg',
      fileSize: 7,
      durationSeconds: 5,
    }],
    rawMessage: {},
    ...overrides,
  };
}

function transcriptionConfig(overrides: Partial<TelegramVoiceTranscriptionConfig> = {}): TelegramVoiceTranscriptionConfig {
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
      mode: overrides.preprocess?.mode ?? 'ffmpeg-wav-auto',
      binaryPath: overrides.preprocess?.binaryPath ?? '/usr/bin/ffmpeg',
    },
    whisperCpp: {
      binaryPath: overrides.whisperCpp?.binaryPath ?? '/usr/local/bin/whisper-cli',
      modelPath: overrides.whisperCpp?.modelPath ?? '/models/model-a.bin',
      threads: overrides.whisperCpp?.threads ?? 0,
      processors: overrides.whisperCpp?.processors ?? 1,
      temperature: overrides.whisperCpp?.temperature ?? 0,
      outputJsonFull: overrides.whisperCpp?.outputJsonFull ?? false,
    },
  };
}

function telegramRoutes(botToken = '123456:token'): Record<string, HttpsRouteHandler> {
  return {
    [`GET /bot${botToken}/getFile?file_id=voice-file`]: () => ({
      statusCode: 200,
      body: { ok: true, result: { file_path: 'voice/file.ogg', file_size: 7 } },
    }),
    [`GET /file/bot${botToken}/voice/file.ogg`]: () => ({ statusCode: 200, body: 'voice!!' }),
    [`GET /bot${botToken}/getFile?file_id=audio-file`]: () => ({
      statusCode: 200,
      body: { ok: true, result: { file_path: 'audio/file.mp3', file_size: 6 } },
    }),
    [`GET /file/bot${botToken}/audio/file.mp3`]: () => ({ statusCode: 200, body: 'audio!' }),
  };
}

class FakeProvider implements AudioTranscriptionProvider {
  readonly id = 'fake-local';
  calls: AudioTranscriptionInput[] = [];

  constructor(private readonly result: AudioTranscriptionResult) {}

  async transcribe(input: AudioTranscriptionInput): Promise<AudioTranscriptionResult> {
    this.calls.push(input);
    return this.result;
  }
}

async function findFirstJsonFile(root: string): Promise<string> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      try {
        return await findFirstJsonFile(path);
      } catch (error) {
        if (!(error instanceof Error && error.message.includes('not found'))) {
          throw error;
        }
      }
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      return path;
    }
  }
  throw new Error(`JSON cache file not found under ${root}`);
}

describe('Telegram inbound voice transcription integration', () => {
  it('preserves current voice attachment path behavior when transcription is disabled', async () => {
    const attachmentRoot = await mkdtemp(join(tmpdir(), 'omx-telegram-transcription-disabled-'));
    try {
      const rendered = await buildTelegramPromptInput(voiceMessage(), {
        botToken: '123456:token',
        sourceKey: 'telegram-source',
        httpsRequestImpl: createHttpsRequestMock(telegramRoutes()),
        attachmentRoot,
        transcriptionConfig: { ...transcriptionConfig(), enabled: false },
      });

      assert.match(rendered, /Telegram attachment saved locally:/);
      assert.match(rendered, /777-501-1-voice\.ogg \(voice, audio\/ogg, 5s, 7 bytes\)/);
      assert.doesNotMatch(rendered, /voice transcript/i);
    } finally {
      await rm(attachmentRoot, { recursive: true, force: true });
    }
  });

  it('injects successful voice transcript only by default while still saving the attachment', async () => {
    const attachmentRoot = await mkdtemp(join(tmpdir(), 'omx-telegram-transcription-success-'));
    const provider = new FakeProvider({ ok: true, providerId: 'fake-local', transcript: 'привет hello bonjour' });
    try {
      const rendered = await buildTelegramPromptInput(voiceMessage(), {
        botToken: '123456:token',
        sourceKey: 'telegram-source',
        httpsRequestImpl: createHttpsRequestMock(telegramRoutes()),
        attachmentRoot,
        transcriptionConfig: transcriptionConfig(),
        transcriptionProvider: provider,
      });

      assert.equal(rendered, 'привет hello bonjour');
      assert.equal(provider.calls.length, 1);
      assert.equal(await readFile(join(attachmentRoot, 'telegram-source', new Date().toISOString().slice(0, 10), '777-501-1-voice.ogg'), 'utf-8'), 'voice!!');
    } finally {
      await rm(attachmentRoot, { recursive: true, force: true });
    }
  });

  it('renders caption before transcript block and truncates long transcripts visibly', async () => {
    const attachmentRoot = await mkdtemp(join(tmpdir(), 'omx-telegram-transcription-caption-'));
    const provider = new FakeProvider({ ok: true, providerId: 'fake-local', transcript: `start ${'x'.repeat(300)}` });
    try {
      const rendered = await buildTelegramPromptInput(voiceMessage({
        textPart: { kind: 'text', source: 'caption', text: 'caption text' },
      }), {
        botToken: '123456:token',
        sourceKey: 'telegram-source',
        httpsRequestImpl: createHttpsRequestMock(telegramRoutes()),
        attachmentRoot,
        transcriptionConfig: transcriptionConfig({ maxTranscriptChars: 120 }),
        transcriptionProvider: provider,
        maxPromptChars: 260,
      });

      assert.match(rendered, /^caption text\n\nTelegram voice transcript:/);
      assert.match(rendered, /voice#1: start/);
      assert.match(rendered, /\[transcript truncated; original 306 chars\]/);
      assert.ok(rendered.length <= 260);
    } finally {
      await rm(attachmentRoot, { recursive: true, force: true });
    }
  });

  it('falls back to saved attachment path plus diagnostic when provider fails', async () => {
    const attachmentRoot = await mkdtemp(join(tmpdir(), 'omx-telegram-transcription-failure-'));
    const provider = new FakeProvider({ ok: false, providerId: 'fake-local', code: 'process-failed', message: 'local model failed loudly' });
    try {
      const rendered = await buildTelegramPromptInput(voiceMessage(), {
        botToken: '123456:token',
        sourceKey: 'telegram-source',
        httpsRequestImpl: createHttpsRequestMock(telegramRoutes()),
        attachmentRoot,
        transcriptionConfig: transcriptionConfig(),
        transcriptionProvider: provider,
      });

      assert.match(rendered, /Telegram attachment saved locally:/);
      assert.match(rendered, /777-501-1-voice\.ogg/);
      assert.match(rendered, /Telegram voice transcription failed:/);
      assert.match(rendered, /voice#1: local model failed loudly/);
    } finally {
      await rm(attachmentRoot, { recursive: true, force: true });
    }
  });

  it('honors mediaKinds, max duration, cache hits, and model fingerprint invalidation', async () => {
    const attachmentRoot = await mkdtemp(join(tmpdir(), 'omx-telegram-transcription-cache-'));
    const provider = new FakeProvider({ ok: true, providerId: 'fake-local', transcript: 'cached transcript' });
    try {
      const message = voiceMessage({
        mediaParts: [
          ...voiceMessage().mediaParts,
          {
            kind: 'media',
            mediaKind: 'audio',
            index: 2,
            fileId: 'audio-file',
            fileUniqueId: 'audio-unique-1',
            mimeType: 'audio/mpeg',
            durationSeconds: 4,
          },
        ],
      });
      const rendered = await buildTelegramPromptInput(message, {
        botToken: '123456:token',
        sourceKey: 'telegram-source',
        httpsRequestImpl: createHttpsRequestMock(telegramRoutes()),
        attachmentRoot,
        transcriptionConfig: transcriptionConfig({ mediaKinds: ['voice', 'audio'], injectMode: 'transcript-with-attachment' }),
        transcriptionProvider: provider,
      });
      assert.equal(provider.calls.length, 2);
      assert.match(rendered, /voice#1: cached transcript/);
      assert.match(rendered, /audio#2: cached transcript/);

      await buildTelegramPromptInput(voiceMessage(), {
        botToken: '123456:token',
        sourceKey: 'telegram-source',
        httpsRequestImpl: createHttpsRequestMock(telegramRoutes()),
        attachmentRoot,
        transcriptionConfig: transcriptionConfig(),
        transcriptionProvider: provider,
      });
      assert.equal(provider.calls.length, 2, 'voice cache hit should avoid provider call');

      await buildTelegramPromptInput(voiceMessage(), {
        botToken: '123456:token',
        sourceKey: 'telegram-source',
        httpsRequestImpl: createHttpsRequestMock(telegramRoutes()),
        attachmentRoot,
        transcriptionConfig: transcriptionConfig({ whisperCpp: { ...transcriptionConfig().whisperCpp, temperature: 0.9 } }),
        transcriptionProvider: provider,
      });
      assert.equal(provider.calls.length, 3, 'temperature change should invalidate cache');

      await buildTelegramPromptInput(voiceMessage(), {
        botToken: '123456:token',
        sourceKey: 'telegram-source',
        httpsRequestImpl: createHttpsRequestMock(telegramRoutes()),
        attachmentRoot,
        transcriptionConfig: transcriptionConfig({ whisperCpp: { ...transcriptionConfig().whisperCpp, modelPath: '/models/model-b.bin' } }),
        transcriptionProvider: provider,
      });
      assert.equal(provider.calls.length, 4, 'model path change should invalidate cache');

      const tooLongProvider = new FakeProvider({ ok: true, providerId: 'fake-local', transcript: 'should not run' });
      const tooLong = await buildTelegramPromptInput(voiceMessage({
        mediaParts: [{ ...voiceMessage().mediaParts[0], durationSeconds: 301 }],
      }), {
        botToken: '123456:token',
        sourceKey: 'telegram-source-long',
        httpsRequestImpl: createHttpsRequestMock(telegramRoutes()),
        attachmentRoot,
        transcriptionConfig: transcriptionConfig({ maxDurationSeconds: 300 }),
        transcriptionProvider: tooLongProvider,
      });
      assert.equal(tooLongProvider.calls.length, 0);
      assert.match(tooLong, /duration 301s exceeds configured transcription max 300s/);
    } finally {
      await rm(attachmentRoot, { recursive: true, force: true });
    }
  });

  it('ignores malformed success cache records and retranscribes safely', async () => {
    const attachmentRoot = await mkdtemp(join(tmpdir(), 'omx-telegram-transcription-cache-shape-'));
    const provider = new FakeProvider({ ok: true, providerId: 'fake-local', transcript: 'fresh transcript' });
    try {
      await buildTelegramPromptInput(voiceMessage(), {
        botToken: '123456:token',
        sourceKey: 'telegram-source',
        httpsRequestImpl: createHttpsRequestMock(telegramRoutes()),
        attachmentRoot,
        transcriptionConfig: transcriptionConfig(),
        transcriptionProvider: provider,
      });
      assert.equal(provider.calls.length, 1);

      const cacheFile = await findFirstJsonFile(join(attachmentRoot, 'transcripts'));
      const cacheRecord = JSON.parse(await readFile(cacheFile, 'utf-8')) as Record<string, unknown>;
      await writeFile(cacheFile, `${JSON.stringify({
        ...cacheRecord,
        result: { status: 'success', providerId: 'fake-local' },
      })}\n`);

      const rendered = await buildTelegramPromptInput(voiceMessage(), {
        botToken: '123456:token',
        sourceKey: 'telegram-source',
        httpsRequestImpl: createHttpsRequestMock(telegramRoutes()),
        attachmentRoot,
        transcriptionConfig: transcriptionConfig(),
        transcriptionProvider: provider,
      });

      assert.equal(provider.calls.length, 2);
      assert.equal(rendered, 'fresh transcript');
    } finally {
      await rm(attachmentRoot, { recursive: true, force: true });
    }
  });
});
