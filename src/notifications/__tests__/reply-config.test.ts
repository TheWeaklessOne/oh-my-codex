import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ENV_KEYS = [
  'CODEX_HOME',
  'OMX_DISCORD_NOTIFIER_BOT_TOKEN',
  'OMX_DISCORD_NOTIFIER_CHANNEL',
  'OMX_TELEGRAM_BOT_TOKEN',
  'OMX_TELEGRAM_CHAT_ID',
  'OMX_REPLY_ENABLED',
  'OMX_REPLY_DISCORD_USER_IDS',
  'OMX_REPLY_TELEGRAM_USER_IDS',
  'OMX_REPLY_POLL_INTERVAL_MS',
  'OMX_REPLY_RATE_LIMIT',
  'OMX_REPLY_ACK_MODE',
  'OMX_REPLY_TELEGRAM_ACK_MODE',
  'OMX_REPLY_TELEGRAM_POLL_TIMEOUT_SECONDS',
  'OMX_REPLY_TELEGRAM_ALLOWED_UPDATES',
  'OMX_REPLY_TELEGRAM_STARTUP_BACKLOG',
  'OMX_REPLY_TELEGRAM_VOICE_TRANSCRIPTION_ENABLED',
  'OMX_REPLY_TELEGRAM_VOICE_TRANSCRIPTION_PROVIDER',
  'OMX_REPLY_TELEGRAM_VOICE_TRANSCRIPTION_MODEL',
  'OMX_REPLY_TELEGRAM_VOICE_TRANSCRIPTION_BINARY',
  'OMX_REPLY_TELEGRAM_VOICE_TRANSCRIPTION_LANGUAGE',
  'OMX_REPLY_TELEGRAM_VOICE_TRANSCRIPTION_PROMPT',
  'OMX_REPLY_TELEGRAM_VOICE_TRANSCRIPTION_TIMEOUT_MS',
  'OMX_REPLY_TELEGRAM_VOICE_TRANSCRIPTION_MAX_DURATION_SECONDS',
  'OMX_REPLY_TELEGRAM_VOICE_TRANSCRIPTION_INJECT_MODE',
  'OMX_REPLY_TELEGRAM_VOICE_TRANSCRIPTION_FFMPEG_BINARY',
] as const;

let codexHomeDir = '';

function clearReplyEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

async function importConfigFresh(): Promise<typeof import('../config.js')> {
  const nonce = `${Date.now()}-${Math.random()}`;
  return await import(`../config.js?reply-test=${nonce}`);
}

describe('getReplyConfig validation', () => {
  beforeEach(async () => {
    clearReplyEnv();
    codexHomeDir = await mkdtemp(join(tmpdir(), 'omx-reply-config-'));
    await mkdir(codexHomeDir, { recursive: true });
    process.env.CODEX_HOME = codexHomeDir;
  });

  afterEach(async () => {
    clearReplyEnv();
    if (codexHomeDir) {
      await rm(codexHomeDir, { recursive: true, force: true });
    }
  });

  it('clamps invalid env poll interval and rate limit', async () => {
    process.env.OMX_DISCORD_NOTIFIER_BOT_TOKEN = 'bot-token';
    process.env.OMX_DISCORD_NOTIFIER_CHANNEL = 'channel-id';
    process.env.OMX_TELEGRAM_BOT_TOKEN = '123456:telegram-token';
    process.env.OMX_TELEGRAM_CHAT_ID = '777';
    process.env.OMX_REPLY_ENABLED = 'true';
    process.env.OMX_REPLY_DISCORD_USER_IDS = '12345678901234567';
    process.env.OMX_REPLY_TELEGRAM_USER_IDS = '4001';
    process.env.OMX_REPLY_POLL_INTERVAL_MS = '0';
    process.env.OMX_REPLY_RATE_LIMIT = '-2';
    process.env.OMX_REPLY_ACK_MODE = 'invalid-mode';
    process.env.OMX_REPLY_TELEGRAM_ACK_MODE = 'accepted-final-message';
    process.env.OMX_REPLY_TELEGRAM_POLL_TIMEOUT_SECONDS = '0';
    process.env.OMX_REPLY_TELEGRAM_ALLOWED_UPDATES = 'message, edited_message';
    process.env.OMX_REPLY_TELEGRAM_STARTUP_BACKLOG = 'drop_pending';

    const { getReplyConfig } = await importConfigFresh();
    const config = getReplyConfig();
    assert.ok(config);
    assert.equal(config.pollIntervalMs, 500);
    assert.equal(config.rateLimitPerMinute, 1);
    assert.deepEqual(config.authorizedTelegramUserIds, ['4001']);
    assert.equal(config.ackMode, 'minimal');
    assert.equal(config.telegramAckMode, 'accepted-final-message');
    assert.equal(config.telegramPollTimeoutSeconds, 1);
    assert.deepEqual(config.telegramAllowedUpdates, ['message', 'edited_message']);
    assert.equal(config.telegramStartupBacklogPolicy, 'drop_pending');
  });

  it('normalizes invalid config file reply values', async () => {
    const configFile = join(codexHomeDir, '.omx-config.json');
    const raw = {
      notifications: {
        enabled: true,
        'discord-bot': {
          enabled: true,
          botToken: 'cfg-token',
          channelId: 'cfg-channel',
        },
        reply: {
          enabled: true,
          pollIntervalMs: 5,
          rateLimitPerMinute: 0,
          maxMessageLength: 999999,
          authorizedDiscordUserIds: ['12345678901234567'],
          authorizedTelegramUserIds: ['4002', 1234, ''],
          ackMode: 'summary',
          telegramAckMode: 'accepted-final-message',
          telegramPollTimeoutSeconds: 90,
          telegramAllowedUpdates: ['message', 'callback_query'],
          telegramStartupBacklogPolicy: 'replay_once',
        },
      },
    };
    await writeFile(configFile, JSON.stringify(raw, null, 2));

    const { getReplyConfig } = await importConfigFresh();
    const config = getReplyConfig();
    assert.ok(config);
    assert.equal(config.pollIntervalMs, 500);
    assert.equal(config.rateLimitPerMinute, 1);
    assert.equal(config.maxMessageLength, 4000);
    assert.deepEqual(config.authorizedTelegramUserIds, ['4002']);
    assert.equal(config.ackMode, 'summary');
    assert.equal(config.telegramAckMode, 'accepted-final-message');
    assert.equal(config.telegramPollTimeoutSeconds, 60);
    assert.deepEqual(config.telegramAllowedUpdates, ['message', 'callback_query']);
    assert.equal(config.telegramStartupBacklogPolicy, 'replay_once');
  });

  it('honors an explicit notification config so reply enablement can follow the active profile', async () => {
    const configFile = join(codexHomeDir, '.omx-config.json');
    await writeFile(configFile, JSON.stringify({
      notifications: {
        enabled: true,
        reply: {
          enabled: true,
        },
      },
    }, null, 2));

    const { getReplyConfig } = await importConfigFresh();
    const config = getReplyConfig({
      enabled: true,
      telegram: {
        enabled: true,
        botToken: 'profile-token',
        chatId: 'profile-chat',
      },
    });

    assert.ok(config);
    assert.equal(config.pollIntervalMs, 3000);
    assert.equal(config.rateLimitPerMinute, 10);
    assert.equal(config.ackMode, 'minimal');
    assert.equal(config.telegramPollTimeoutSeconds, 30);
    assert.deepEqual(config.telegramAllowedUpdates, ['message']);
    assert.equal(config.telegramStartupBacklogPolicy, 'resume');
    assert.equal(config.telegramVoiceTranscription?.enabled, false);
    assert.equal(config.telegramVoiceTranscription?.provider, 'whisper-cpp');
    assert.deepEqual(config.telegramVoiceTranscription?.mediaKinds, ['voice']);
  });

  it('parses Telegram voice transcription config and explicit env overrides', async () => {
    const configFile = join(codexHomeDir, '.omx-config.json');
    await writeFile(configFile, JSON.stringify({
      notifications: {
        enabled: true,
        telegram: {
          enabled: true,
          botToken: '123456:telegram-token',
          chatId: '777',
        },
        reply: {
          enabled: true,
          authorizedTelegramUserIds: ['4003'],
          telegramVoiceTranscription: {
            enabled: true,
            provider: 'whisper-cpp',
            mediaKinds: ['voice', 'document', 'audio'],
            injectMode: 'transcript-with-attachment',
            fallbackMode: 'attachment-with-diagnostic',
            timeoutMs: 1000,
            maxDurationSeconds: 10,
            maxTranscriptChars: 900,
            language: 'ru',
            prompt: 'config prompt',
            preprocess: {
              mode: 'ffmpeg-wav-required',
              binaryPath: 'cfg-ffmpeg',
            },
            whisperCpp: {
              binaryPath: 'cfg-whisper',
              modelPath: '/cfg/model.bin',
              threads: 4,
              processors: 2,
              temperature: 0,
              outputJsonFull: true,
            },
          },
        },
      },
    }, null, 2));

    process.env.OMX_REPLY_TELEGRAM_VOICE_TRANSCRIPTION_MODEL = '/env/model.bin';
    process.env.OMX_REPLY_TELEGRAM_VOICE_TRANSCRIPTION_BINARY = '/usr/local/bin/whisper-cli';
    process.env.OMX_REPLY_TELEGRAM_VOICE_TRANSCRIPTION_LANGUAGE = 'auto';
    process.env.OMX_REPLY_TELEGRAM_VOICE_TRANSCRIPTION_PROMPT = 'env prompt';
    process.env.OMX_REPLY_TELEGRAM_VOICE_TRANSCRIPTION_TIMEOUT_MS = '120000';
    process.env.OMX_REPLY_TELEGRAM_VOICE_TRANSCRIPTION_MAX_DURATION_SECONDS = '300';
    process.env.OMX_REPLY_TELEGRAM_VOICE_TRANSCRIPTION_INJECT_MODE = 'transcript-only';
    process.env.OMX_REPLY_TELEGRAM_VOICE_TRANSCRIPTION_FFMPEG_BINARY = '/opt/homebrew/bin/ffmpeg';

    const { getReplyConfig } = await importConfigFresh();
    const config = getReplyConfig();
    assert.ok(config);
    assert.equal(config.telegramVoiceTranscription?.enabled, true);
    assert.equal(config.telegramVoiceTranscription?.provider, 'whisper-cpp');
    assert.deepEqual(config.telegramVoiceTranscription?.mediaKinds, ['voice', 'audio']);
    assert.equal(config.telegramVoiceTranscription?.injectMode, 'transcript-only');
    assert.equal(config.telegramVoiceTranscription?.timeoutMs, 120000);
    assert.equal(config.telegramVoiceTranscription?.maxDurationSeconds, 300);
    assert.equal(config.telegramVoiceTranscription?.maxTranscriptChars, 900);
    assert.equal(config.telegramVoiceTranscription?.language, 'auto');
    assert.equal(config.telegramVoiceTranscription?.prompt, 'env prompt');
    assert.equal(config.telegramVoiceTranscription?.preprocess.mode, 'ffmpeg-wav-required');
    assert.equal(config.telegramVoiceTranscription?.preprocess.binaryPath, '/opt/homebrew/bin/ffmpeg');
    assert.equal(config.telegramVoiceTranscription?.whisperCpp.binaryPath, '/usr/local/bin/whisper-cli');
    assert.equal(config.telegramVoiceTranscription?.whisperCpp.modelPath, '/env/model.bin');
    assert.equal(config.telegramVoiceTranscription?.whisperCpp.threads, 4);
    assert.equal(config.telegramVoiceTranscription?.whisperCpp.processors, 2);
    assert.equal(config.telegramVoiceTranscription?.whisperCpp.outputJsonFull, true);
  });

  it('keeps enabled transcription soft-failing when whisper.cpp model path is missing', async () => {
    const configFile = join(codexHomeDir, '.omx-config.json');
    await writeFile(configFile, JSON.stringify({
      notifications: {
        enabled: true,
        telegram: {
          enabled: true,
          botToken: '123456:telegram-token',
          chatId: '777',
        },
        reply: {
          enabled: true,
          telegramVoiceTranscription: {
            enabled: true,
            provider: 'whisper-cpp',
          },
        },
      },
    }, null, 2));

    const { getReplyConfig } = await importConfigFresh();
    const config = getReplyConfig();
    assert.ok(config);
    assert.equal(config.telegramVoiceTranscription?.enabled, true);
    assert.equal(config.telegramVoiceTranscription?.whisperCpp.modelPath, undefined);
    assert.match(config.telegramVoiceTranscription?.warnings?.join('\n') ?? '', /modelPath is required/);
  });
});
