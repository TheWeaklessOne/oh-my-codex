import { createHash } from 'node:crypto';

export type ReplySourcePlatform = 'discord-bot' | 'telegram';

export interface ReplySourceDescriptor {
  platform: ReplySourcePlatform;
  key: string;
  label: string;
  channelId?: string;
  chatId?: string;
  botId?: string;
  tokenFingerprint?: string;
}

function fingerprintToken(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 12);
}

function extractTelegramBotId(botToken: string): string {
  const [botId] = botToken.split(':', 1);
  return botId?.trim() || 'unknown-bot';
}

export function buildTelegramReplySource(
  botToken: string,
  chatId: string,
): ReplySourceDescriptor {
  const botId = extractTelegramBotId(botToken);
  return {
    platform: 'telegram',
    key: `telegram:${botId}:${chatId}`,
    label: `telegram:${chatId}`,
    chatId,
    botId,
  };
}

export function buildDiscordReplySource(
  botToken: string,
  channelId: string,
): ReplySourceDescriptor {
  const tokenFingerprint = fingerprintToken(botToken);
  return {
    platform: 'discord-bot',
    key: `discord-bot:${channelId}:${tokenFingerprint}`,
    label: `discord-bot:${channelId}`,
    channelId,
    tokenFingerprint,
  };
}
