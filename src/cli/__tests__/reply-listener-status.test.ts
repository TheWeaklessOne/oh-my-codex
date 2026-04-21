import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildDiscordReplySource, buildTelegramReplySource } from '../../notifications/reply-source.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..', '..', '..');
const omxBin = join(repoRoot, 'dist', 'cli', 'omx.js');

function runOmx(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync(process.execPath, [omxBin, ...args], {
    cwd,
    env,
    encoding: 'utf-8',
  });
}

describe('CLI reply-listener status surface', () => {
  it('includes source-aware reply-listener diagnostics in `omx status` output', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-cli-reply-status-cwd-'));
    const home = await mkdtemp(join(tmpdir(), 'omx-cli-reply-status-home-'));
    const stateDir = join(home, '.omx', 'state');

    try {
      await mkdir(stateDir, { recursive: true });
      const discordSource = buildDiscordReplySource('discord-token', 'discord-channel');
      const telegramSource = buildTelegramReplySource('123456:telegram-token', '777');
      await writeFile(
        join(stateDir, 'reply-listener-config.json'),
        JSON.stringify({
          enabled: true,
          pollIntervalMs: 3000,
          maxMessageLength: 500,
          rateLimitPerMinute: 10,
          includePrefix: true,
          ackMode: 'minimal',
          authorizedDiscordUserIds: ['123456789012345678'],
          authorizedTelegramUserIds: ['4001'],
          telegramPollTimeoutSeconds: 30,
          telegramAllowedUpdates: ['message'],
          telegramStartupBacklogPolicy: 'resume',
          telegramEnabled: true,
          telegramChatId: '777',
          discordEnabled: true,
          discordChannelId: 'discord-channel',
        }, null, 2),
      );
      await writeFile(
        join(stateDir, 'reply-listener-state.json'),
        JSON.stringify({
          isRunning: true,
          pid: 98765,
          startedAt: '2026-03-20T00:00:00.000Z',
          lastPollAt: '2026-03-20T00:06:00.000Z',
          telegramLastUpdateId: 77,
          discordLastMessageId: 'discord-message-77',
          telegramStartupPolicyApplied: true,
          messagesInjected: 4,
          errors: 1,
          sourceStates: {
            [discordSource.key]: {
              sourceKey: discordSource.key,
              platform: 'discord-bot',
              label: discordSource.label,
              discordLastMessageId: 'discord-message-77',
              telegramStartupPolicyApplied: false,
              lastPollAt: '2026-03-20T00:06:00.000Z',
              lastIngestAt: '2026-03-20T00:06:01.000Z',
              lastFailureAt: '2026-03-20T00:06:02.000Z',
              lastFailureCategory: 'rate-limit',
              lastFailureMessage: 'Deferred Discord message 77',
              failureCounts: { 'rate-limit': 1 },
            },
            [telegramSource.key]: {
              sourceKey: telegramSource.key,
              platform: 'telegram',
              label: telegramSource.label,
              telegramLastUpdateId: 77,
              telegramStartupPolicyApplied: true,
              lastPollAt: '2026-03-20T00:05:00.000Z',
              lastIngestAt: '2026-03-20T00:05:01.000Z',
              lastFailureAt: null,
              lastFailureCategory: null,
              lastFailureMessage: null,
              failureCounts: {},
            },
          },
        }, null, 2),
      );

      const result = runOmx(
        cwd,
        {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          OMX_REPLY_ENABLED: 'true',
          OMX_DISCORD_NOTIFIER_BOT_TOKEN: 'discord-token',
          OMX_DISCORD_NOTIFIER_CHANNEL: 'discord-channel',
          OMX_TELEGRAM_BOT_TOKEN: '123456:telegram-token',
          OMX_TELEGRAM_CHAT_ID: '777',
        },
        'status',
      );

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /reply-listener: inactive \(2 active sources, ack=minimal, secrets=not-persisted\)/i);
      assert.match(result.stdout, /discord-bot:discord-channel .*cursor=discord-message-77/i);
      assert.match(result.stdout, /telegram:777 .*cursor=77/i);
      assert.match(result.stdout, /last_failure=rate-limit/i);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
