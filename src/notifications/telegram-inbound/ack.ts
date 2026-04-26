import {
  coerceTelegramMessageThreadId,
  performTelegramBotApiRequest,
  type TelegramBotApiRequestDeps,
} from '../telegram-topics.js';
import type { TelegramAcceptedAckCleanupTarget } from '../types.js';

export const TELEGRAM_ACCEPTED_ACK_TEXT = '✅ Принято, обрабатываю…';
const TELEGRAM_ACK_TIMEOUT_MS = 5_000;

export interface TelegramAckConfig {
  botToken: string;
  chatId: string;
}

export interface TelegramAckReplyTarget {
  replyToMessageId?: number | string;
  messageThreadId?: number | string;
}

interface TelegramMessageResult {
  message_id?: number | string;
  message_thread_id?: number | string;
}

function normalizeTelegramId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(Math.floor(value));
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return value.trim();
  }
  return undefined;
}

function buildTelegramAckDeps(
  deps: TelegramBotApiRequestDeps = {},
): TelegramBotApiRequestDeps {
  return {
    ...(deps.httpsRequestImpl ? { httpsRequestImpl: deps.httpsRequestImpl } : {}),
    timeoutMs: deps.timeoutMs ?? TELEGRAM_ACK_TIMEOUT_MS,
  };
}

export async function sendTelegramAcceptedAck(
  config: TelegramAckConfig,
  target: TelegramAckReplyTarget,
  deps: TelegramBotApiRequestDeps = {},
): Promise<TelegramAcceptedAckCleanupTarget | null> {
  const result = await performTelegramBotApiRequest<TelegramMessageResult>(
    config.botToken,
    'sendMessage',
    {
      chat_id: config.chatId,
      text: TELEGRAM_ACCEPTED_ACK_TEXT,
      ...(target.replyToMessageId !== undefined
        ? { reply_to_message_id: target.replyToMessageId }
        : {}),
      ...(target.messageThreadId !== undefined
        ? { message_thread_id: coerceTelegramMessageThreadId(target.messageThreadId) }
        : {}),
    },
    buildTelegramAckDeps(deps),
  );

  const messageId = normalizeTelegramId(result?.message_id);
  const messageThreadId =
    normalizeTelegramId(result?.message_thread_id)
    ?? normalizeTelegramId(target.messageThreadId);
  if (!messageId) {
    return null;
  }

  return {
    chatId: config.chatId,
    messageId,
    ...(messageThreadId ? { messageThreadId } : {}),
  };
}

export async function sendTelegramProcessingAction(
  config: TelegramAckConfig,
  target: Pick<TelegramAckReplyTarget, 'messageThreadId'> = {},
  deps: TelegramBotApiRequestDeps = {},
): Promise<void> {
  await performTelegramBotApiRequest<true>(
    config.botToken,
    'sendChatAction',
    {
      chat_id: config.chatId,
      action: 'typing',
      ...(target.messageThreadId !== undefined
        ? { message_thread_id: coerceTelegramMessageThreadId(target.messageThreadId) }
        : {}),
    },
    buildTelegramAckDeps(deps),
  );
}

export async function deleteTelegramAcceptedAck(
  config: Pick<TelegramAckConfig, 'botToken'>,
  ack: TelegramAcceptedAckCleanupTarget,
  deps: TelegramBotApiRequestDeps = {},
): Promise<void> {
  await performTelegramBotApiRequest<true>(
    config.botToken,
    'deleteMessage',
    {
      chat_id: ack.chatId,
      message_id: ack.messageId,
    },
    buildTelegramAckDeps(deps),
  );
}

export async function trySendTelegramAcceptedAck(
  config: TelegramAckConfig,
  target: TelegramAckReplyTarget,
  options: TelegramBotApiRequestDeps & {
    logImpl?: (message: string) => void;
    context?: string;
  } = {},
): Promise<TelegramAcceptedAckCleanupTarget | null> {
  try {
    return await sendTelegramAcceptedAck(config, target, options);
  } catch (error) {
    options.logImpl?.(`WARN: Failed to send Telegram accepted acknowledgement${options.context ? ` (${options.context})` : ''}: ${error}`);
    return null;
  }
}

export async function trySendTelegramProcessingAction(
  config: TelegramAckConfig,
  target: Pick<TelegramAckReplyTarget, 'messageThreadId'>,
  options: TelegramBotApiRequestDeps & {
    logImpl?: (message: string) => void;
    context?: string;
  } = {},
): Promise<boolean> {
  try {
    await sendTelegramProcessingAction(config, target, options);
    return true;
  } catch (error) {
    options.logImpl?.(`WARN: Failed to send Telegram processing action${options.context ? ` (${options.context})` : ''}: ${error}`);
    return false;
  }
}

export async function deleteTelegramAcceptedAckBestEffort(
  config: Pick<TelegramAckConfig, 'botToken'>,
  ack: TelegramAcceptedAckCleanupTarget,
  options: TelegramBotApiRequestDeps & {
    logger?: Pick<Console, 'warn'>;
  } = {},
): Promise<boolean> {
  try {
    await deleteTelegramAcceptedAck(config, ack, options);
    return true;
  } catch (error) {
    (options.logger ?? console).warn('[notifications] telegram accepted acknowledgement cleanup warning', {
      warningCode: 'telegram-accepted-ack-delete-failed',
      chatId: ack.chatId,
      messageId: ack.messageId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
