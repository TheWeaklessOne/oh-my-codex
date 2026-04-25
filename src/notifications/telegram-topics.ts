import { createHash } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { basename } from 'node:path';
import { canonicalizeComparablePath } from '../utils/paths.js';
import { shouldBlockLiveNotificationNetworkInTests } from '../utils/test-env.js';
import { buildTelegramReplySource } from './reply-source.js';
import { loadAllMappings, type SessionMapping } from './session-registry.js';
import {
  getTelegramTopicRegistryRecord,
  listTelegramTopicRegistryRecords,
  touchTelegramTopicRegistryRecord,
  updateTelegramTopicRegistryRecord,
  withTelegramTopicProjectLock,
  type TelegramTopicRegistryRecord,
} from './telegram-topic-registry.js';
import type {
  FullNotificationPayload,
  TelegramNotificationConfig,
  TelegramProjectTopicNaming,
  TelegramProjectTopicsConfig,
} from './types.js';

const TELEGRAM_API_HOST = 'api.telegram.org';
const TELEGRAM_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_CREATE_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
const TOPIC_NAME_LIMIT = 128;
const DEFAULT_TOPIC_NAMING: TelegramProjectTopicNaming = 'projectName';

type LoggerLike = Pick<Console, 'warn'>;

export interface TelegramProjectIdentity {
  projectKey: string;
  canonicalProjectPath: string;
  displayName: string;
}

export interface TelegramResolvedDestination {
  chatId: string;
  sourceChatKey: string;
  messageThreadId?: string;
  projectKey?: string;
  topicName?: string;
  canonicalProjectPath?: string;
  usedFallback?: boolean;
  skipSend?: boolean;
  warningCode?: string;
  warningMessage?: string;
}

export interface TelegramBotApiRequestDeps {
  httpsRequestImpl?: typeof httpsRequest;
  timeoutMs?: number;
}

export interface TelegramTopicResolutionDeps extends TelegramBotApiRequestDeps {
  now?: Date | (() => Date);
  logger?: LoggerLike;
}

export interface CreateForumTopicParams {
  chatId: string;
  name: string;
  iconColor?: number;
}

export interface CreatedForumTopic {
  messageThreadId: string;
  name: string;
  iconColor?: number;
}

interface TelegramApiEnvelope<T> {
  ok?: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

interface TelegramApiErrorOptions {
  methodName: string;
  message: string;
  statusCode?: number;
  errorCode?: number;
  description?: string;
  responseBody?: string;
}

export class TelegramBotApiError extends Error {
  readonly methodName: string;
  readonly statusCode?: number;
  readonly errorCode?: number;
  readonly description?: string;
  readonly responseBody?: string;

  constructor(options: TelegramApiErrorOptions) {
    super(options.message);
    this.name = 'TelegramBotApiError';
    this.methodName = options.methodName;
    this.statusCode = options.statusCode;
    this.errorCode = options.errorCode;
    this.description = options.description;
    this.responseBody = options.responseBody;
  }
}

interface NormalizedProjectTopicsConfig {
  enabled: true;
  autoCreate: boolean;
  fallbackToGeneral: boolean;
  naming: TelegramProjectTopicNaming;
  iconColor?: number;
  createFailureCooldownMs: number;
}

function resolveNow(now: TelegramTopicResolutionDeps['now']): Date {
  if (typeof now === 'function') {
    return now();
  }

  if (now instanceof Date) {
    return now;
  }

  return new Date();
}

function normalizeProjectTopicsConfig(
  config: TelegramProjectTopicsConfig | undefined,
): NormalizedProjectTopicsConfig | null {
  if (config?.enabled !== true) {
    return null;
  }

  const normalizedCooldownMs =
    typeof config.createFailureCooldownMs === 'number'
    && Number.isFinite(config.createFailureCooldownMs)
    && config.createFailureCooldownMs > 0
      ? Math.floor(config.createFailureCooldownMs)
      : DEFAULT_CREATE_FAILURE_COOLDOWN_MS;

  return {
    enabled: true,
    autoCreate: config.autoCreate !== false,
    fallbackToGeneral: config.fallbackToGeneral !== false,
    naming: config.naming === 'projectNameWithHash' ? config.naming : DEFAULT_TOPIC_NAMING,
    iconColor:
      typeof config.iconColor === 'number' && Number.isFinite(config.iconColor)
        ? Math.floor(config.iconColor)
        : undefined,
    createFailureCooldownMs: normalizedCooldownMs,
  };
}

function toTelegramApiError(
  methodName: string,
  message: string,
  options: {
    statusCode?: number;
    errorCode?: number;
    description?: string;
    responseBody?: string;
  } = {},
): TelegramBotApiError {
  return new TelegramBotApiError({
    methodName,
    message,
    statusCode: options.statusCode,
    errorCode: options.errorCode,
    description: options.description,
    responseBody: options.responseBody,
  });
}

function extractEnvelope<T>(body: string): TelegramApiEnvelope<T> | null {
  if (body.trim() === '') {
    return null;
  }

  try {
    return JSON.parse(body) as TelegramApiEnvelope<T>;
  } catch {
    return null;
  }
}

export async function performTelegramBotApiRequest<T>(
  botToken: string,
  methodName: string,
  body: Record<string, unknown>,
  deps: TelegramBotApiRequestDeps = {},
): Promise<T | undefined> {
  if (
    shouldBlockLiveNotificationNetworkInTests(process.env, deps.httpsRequestImpl)
  ) {
    throw new Error('Live Telegram Bot API requests are disabled while running tests');
  }

  const httpsRequestImpl = deps.httpsRequestImpl ?? httpsRequest;
  const timeoutMs = deps.timeoutMs ?? TELEGRAM_REQUEST_TIMEOUT_MS;
  const requestBody = JSON.stringify(body);

  return await new Promise<T | undefined>((resolve, reject) => {
    const req = httpsRequestImpl(
      {
        hostname: TELEGRAM_API_HOST,
        path: `/bot${botToken}/${methodName}`,
        method: 'POST',
        family: 4,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(requestBody),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const responseBody = Buffer.concat(chunks).toString('utf-8');
          const envelope = extractEnvelope<T>(responseBody);
          const statusCode = res.statusCode;

          if (statusCode && statusCode >= 200 && statusCode < 300) {
            if (envelope?.ok === false) {
              reject(toTelegramApiError(
                methodName,
                envelope.description || `Telegram Bot API ${methodName} failed`,
                {
                  statusCode,
                  errorCode: envelope.error_code,
                  description: envelope.description,
                  responseBody,
                },
              ));
              return;
            }

            resolve(envelope?.result);
            return;
          }

          const description = envelope?.description || responseBody.trim() || `HTTP ${statusCode ?? 'unknown'}`;
          reject(toTelegramApiError(
            methodName,
            description,
            {
              statusCode,
              errorCode: envelope?.error_code,
              description: envelope?.description,
              responseBody,
            },
          ));
        });
      },
    );

    req.on('error', (error) => {
      reject(toTelegramApiError(methodName, error instanceof Error ? error.message : String(error)));
    });
    req.on('timeout', () => {
      req.destroy();
      reject(toTelegramApiError(methodName, 'Request timeout'));
    });

    req.write(requestBody);
    req.end();
  });
}

function normalizeDisplayName(value: string | undefined, fallbackPath: string): string {
  const trimmed = (value || basename(fallbackPath) || 'project')
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return trimmed.length > 0 ? trimmed : 'project';
}

export function normalizeTelegramProjectIdentity(
  payload: Pick<FullNotificationPayload, 'projectPath' | 'projectName'>,
): TelegramProjectIdentity | null {
  if (!payload.projectPath) {
    return null;
  }

  const canonicalProjectPath = canonicalizeComparablePath(payload.projectPath);
  const displayName = normalizeDisplayName(payload.projectName, canonicalProjectPath);

  return {
    canonicalProjectPath,
    displayName,
    projectKey: createHash('sha256').update(canonicalProjectPath).digest('hex'),
  };
}

function buildHashSuffix(projectKey: string): string {
  return ` · ${projectKey.slice(0, 6)}`;
}

function truncateTopicName(base: string, suffix = ''): string {
  const normalizedBase = base.slice(0, TOPIC_NAME_LIMIT).trim();
  if (suffix === '') {
    return normalizedBase || 'project';
  }

  const maxBaseLength = TOPIC_NAME_LIMIT - suffix.length;
  const trimmedBase = normalizedBase.slice(0, Math.max(1, maxBaseLength)).trimEnd() || 'project';
  return `${trimmedBase}${suffix}`;
}

function normalizeTopicComparisonValue(value: string | undefined): string {
  return (value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase();
}

export function buildProjectTopicName(options: {
  displayName: string;
  projectKey: string;
  naming: TelegramProjectTopicNaming;
  existingRecords: TelegramTopicRegistryRecord[];
}): string {
  const baseName = truncateTopicName(normalizeDisplayName(options.displayName, options.displayName));
  const hashedName = truncateTopicName(baseName, buildHashSuffix(options.projectKey));
  if (options.naming === 'projectNameWithHash') {
    return hashedName;
  }

  const comparableBase = normalizeTopicComparisonValue(baseName);
  const hasCollision = options.existingRecords.some((record) => {
    if (record.projectKey === options.projectKey) {
      return false;
    }

    return normalizeTopicComparisonValue(record.topicName || record.displayName) === comparableBase;
  });

  return hasCollision ? hashedName : baseName;
}

export function coerceTelegramMessageThreadId(
  messageThreadId: string | number | undefined,
): string | number | undefined {
  if (typeof messageThreadId === 'number' && Number.isFinite(messageThreadId)) {
    return Math.floor(messageThreadId);
  }

  if (typeof messageThreadId === 'string' && /^\d+$/.test(messageThreadId)) {
    const parsed = Number(messageThreadId);
    return Number.isSafeInteger(parsed) ? parsed : messageThreadId;
  }

  return messageThreadId;
}

function getTelegramSourceChatKey(config: TelegramNotificationConfig): string {
  return buildTelegramReplySource(config.botToken, config.chatId).key;
}

function buildFallbackDestination(
  config: TelegramNotificationConfig,
  sourceChatKey: string,
  identity: TelegramProjectIdentity | null,
  warningCode: string,
  warningMessage: string,
  allowFallback: boolean,
): TelegramResolvedDestination {
  if (allowFallback) {
    return {
      chatId: config.chatId,
      sourceChatKey,
      projectKey: identity?.projectKey,
      canonicalProjectPath: identity?.canonicalProjectPath,
      usedFallback: true,
      warningCode,
      warningMessage,
    };
  }

  return {
    chatId: config.chatId,
    sourceChatKey,
    projectKey: identity?.projectKey,
    canonicalProjectPath: identity?.canonicalProjectPath,
    skipSend: true,
    warningCode,
    warningMessage,
  };
}

function logTopicWarning(
  logger: LoggerLike | undefined,
  warningCode: string,
  warningMessage: string,
  context: Record<string, unknown>,
): void {
  const target = logger ?? console;
  target.warn('[notifications] telegram topic routing warning', {
    warningCode,
    warningMessage,
    ...context,
  });
}

function recoverTopicRecordFromSessionMappings(
  sourceChatKey: string,
  identity: TelegramProjectIdentity,
): TelegramTopicRegistryRecord | null {
  const mappings = loadAllMappings();
  for (let index = mappings.length - 1; index >= 0; index -= 1) {
    const mapping = mappings[index];
    if (!isRecoverableTelegramTopicMapping(mapping, sourceChatKey, identity)) {
      continue;
    }

    return {
      sourceChatKey,
      projectKey: identity.projectKey,
      canonicalProjectPath: identity.canonicalProjectPath,
      displayName: identity.displayName,
      topicName: mapping.topicName,
      messageThreadId: mapping.messageThreadId,
      createdAt: mapping.createdAt,
      lastUsedAt: mapping.createdAt,
    };
  }

  return null;
}

function isRecoverableTelegramTopicMapping(
  mapping: SessionMapping,
  sourceChatKey: string,
  identity: TelegramProjectIdentity,
): boolean {
  if (mapping.platform !== 'telegram') {
    return false;
  }

  if (mapping.source?.key !== sourceChatKey) {
    return false;
  }

  if (!mapping.messageThreadId) {
    return false;
  }

  if (mapping.projectKey === identity.projectKey) {
    return true;
  }

  if (!mapping.projectPath) {
    return false;
  }

  return canonicalizeComparablePath(mapping.projectPath) === identity.canonicalProjectPath;
}

async function recoverTopicRecordFromSessionRegistry(
  sourceChatKey: string,
  identity: TelegramProjectIdentity,
  nowIso: string,
  logger?: LoggerLike,
): Promise<TelegramTopicRegistryRecord | null> {
  const recovered = recoverTopicRecordFromSessionMappings(sourceChatKey, identity);
  if (!recovered?.messageThreadId) {
    return null;
  }

  try {
    return await updateTelegramTopicRegistryRecord(
      sourceChatKey,
      identity.projectKey,
      (record) => ({
        ...record,
        ...recovered,
        sourceChatKey,
        projectKey: identity.projectKey,
        canonicalProjectPath: identity.canonicalProjectPath,
        displayName: identity.displayName,
        topicName: recovered.topicName || record?.topicName || identity.displayName,
        messageThreadId: recovered.messageThreadId,
        createdAt: record?.createdAt || recovered.createdAt || nowIso,
        lastUsedAt: nowIso,
      }),
    );
  } catch (error) {
    logTopicWarning(
      logger,
      'topic-registry-recovery-persist-failed',
      'Recovered a Telegram topic mapping from session correlation metadata, but failed to restore it into the topic registry; continuing with the recovered thread destination.',
      {
        sourceChatKey,
        projectKey: identity.projectKey,
        canonicalProjectPath: identity.canonicalProjectPath,
        messageThreadId: recovered.messageThreadId,
        topicName: recovered.topicName,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return {
      ...recovered,
      canonicalProjectPath: identity.canonicalProjectPath,
      displayName: identity.displayName,
      lastUsedAt: nowIso,
    };
  }
}

async function persistTopicRecordBestEffort(
  options: {
    sourceChatKey: string;
    identity: TelegramProjectIdentity;
    topicName: string;
    messageThreadId: string;
    nowIso: string;
    logger?: LoggerLike;
    warningCode: string;
    warningMessage: string;
  },
): Promise<TelegramTopicRegistryRecord | null> {
  try {
    return await updateTelegramTopicRegistryRecord(
      options.sourceChatKey,
      options.identity.projectKey,
      (record) => ({
        ...record,
        sourceChatKey: options.sourceChatKey,
        projectKey: options.identity.projectKey,
        canonicalProjectPath: options.identity.canonicalProjectPath,
        displayName: options.identity.displayName,
        topicName: options.topicName,
        messageThreadId: options.messageThreadId,
        createdAt: record?.createdAt || options.nowIso,
        lastUsedAt: options.nowIso,
        lastCreateAttemptAt: options.nowIso,
        lastCreateFailureAt: undefined,
        lastCreateFailureCode: undefined,
        lastCreateFailureMessage: undefined,
        createFailureCooldownUntil: undefined,
      }),
    );
  } catch (error) {
    logTopicWarning(
      options.logger,
      options.warningCode,
      options.warningMessage,
      {
        sourceChatKey: options.sourceChatKey,
        projectKey: options.identity.projectKey,
        canonicalProjectPath: options.identity.canonicalProjectPath,
        topicName: options.topicName,
        messageThreadId: options.messageThreadId,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return null;
  }
}

function isCooldownActive(record: TelegramTopicRegistryRecord | null, now: Date): boolean {
  if (!record?.createFailureCooldownUntil) {
    return false;
  }

  const deadline = new Date(record.createFailureCooldownUntil).getTime();
  return Number.isFinite(deadline) && deadline > now.getTime();
}

function classifyTopicCreationError(error: unknown): {
  code: string;
  message: string;
  shouldCooldown: boolean;
} {
  if (error instanceof TelegramBotApiError) {
    const description = (error.description || error.message).toLocaleLowerCase();
    if (
      description.includes('manage topics')
      || description.includes('administrator rights')
      || description.includes('not enough rights')
      || error.statusCode === 403
    ) {
      return {
        code: 'insufficient-permissions',
        message: error.message,
        shouldCooldown: true,
      };
    }

    if (
      description.includes('forum')
      || description.includes('topic') && (description.includes('not found') || description.includes('not supported'))
    ) {
      return {
        code: 'forum-unavailable',
        message: error.message,
        shouldCooldown: true,
      };
    }

    if (description.includes('name') || description.includes('1-128')) {
      return {
        code: 'invalid-topic-name',
        message: error.message,
        shouldCooldown: false,
      };
    }

    return {
      code: 'bot-api-error',
      message: error.message,
      shouldCooldown: false,
    };
  }

  return {
    code: 'topic-create-error',
    message: error instanceof Error ? error.message : String(error),
    shouldCooldown: false,
  };
}

export async function createForumTopic(
  config: TelegramNotificationConfig,
  params: CreateForumTopicParams,
  deps: TelegramBotApiRequestDeps = {},
): Promise<CreatedForumTopic> {
  const result = await performTelegramBotApiRequest<{
    message_thread_id?: number | string;
    name?: string;
    icon_color?: number;
  }>(
    config.botToken,
    'createForumTopic',
    {
      chat_id: params.chatId,
      name: params.name,
      ...(typeof params.iconColor === 'number' ? { icon_color: params.iconColor } : {}),
    },
    deps,
  );

  const messageThreadId = result?.message_thread_id;
  if (messageThreadId === undefined || messageThreadId === null) {
    throw toTelegramApiError('createForumTopic', 'Telegram Bot API did not return a message_thread_id');
  }

  return {
    messageThreadId: String(messageThreadId),
    name: result?.name || params.name,
    iconColor: result?.icon_color,
  };
}

export async function ensureProjectTopic(
  config: TelegramNotificationConfig,
  payload: Pick<FullNotificationPayload, 'projectPath' | 'projectName'>,
  deps: TelegramTopicResolutionDeps = {},
): Promise<TelegramResolvedDestination> {
  const projectTopics = normalizeProjectTopicsConfig(config.projectTopics);
  const sourceChatKey = getTelegramSourceChatKey(config);
  const identity = normalizeTelegramProjectIdentity(payload);
  const now = resolveNow(deps.now);
  const nowIso = now.toISOString();

  if (!projectTopics) {
    return {
      chatId: config.chatId,
      sourceChatKey,
    };
  }

  if (!identity) {
    return buildFallbackDestination(
      config,
      sourceChatKey,
      null,
      'missing-project-path',
      'Telegram project topic routing requires payload.projectPath; falling back to the root chat.',
      true,
    );
  }

  try {
    return await withTelegramTopicProjectLock(sourceChatKey, identity.projectKey, async () => {
      const currentRecord = await getTelegramTopicRegistryRecord(sourceChatKey, identity.projectKey);
      if (currentRecord?.messageThreadId) {
        try {
          await touchTelegramTopicRegistryRecord(sourceChatKey, identity.projectKey, {
            canonicalProjectPath: identity.canonicalProjectPath,
            displayName: identity.displayName,
            lastUsedAt: nowIso,
          });
        } catch (error) {
          logTopicWarning(
            deps.logger,
            'topic-registry-touch-failed',
            'Failed to refresh Telegram topic registry usage metadata; continuing with the cached thread destination.',
            {
              sourceChatKey,
              projectKey: identity.projectKey,
              canonicalProjectPath: identity.canonicalProjectPath,
              messageThreadId: currentRecord.messageThreadId,
              error: error instanceof Error ? error.message : String(error),
            },
          );
        }
        return {
          chatId: config.chatId,
          sourceChatKey,
          projectKey: identity.projectKey,
          canonicalProjectPath: identity.canonicalProjectPath,
          topicName: currentRecord.topicName,
          messageThreadId: currentRecord.messageThreadId,
        };
      }

      const recoveredRecord = await recoverTopicRecordFromSessionRegistry(
        sourceChatKey,
        identity,
        nowIso,
        deps.logger,
      );
      if (recoveredRecord?.messageThreadId) {
        return {
          chatId: config.chatId,
          sourceChatKey,
          projectKey: identity.projectKey,
          canonicalProjectPath: identity.canonicalProjectPath,
          topicName: recoveredRecord.topicName,
          messageThreadId: recoveredRecord.messageThreadId,
        };
      }

      if (isCooldownActive(currentRecord, now)) {
        const warningMessage =
          currentRecord?.lastCreateFailureMessage
          || 'Project topic creation is cooling down after a previous failure.';
        logTopicWarning(deps.logger, 'topic-create-cooldown', warningMessage, {
          sourceChatKey,
          projectKey: identity.projectKey,
          canonicalProjectPath: identity.canonicalProjectPath,
          cooldownUntil: currentRecord?.createFailureCooldownUntil,
        });
        return buildFallbackDestination(
          config,
          sourceChatKey,
          identity,
          'topic-create-cooldown',
          warningMessage,
          projectTopics.fallbackToGeneral,
        );
      }

      if (!projectTopics.autoCreate) {
        return buildFallbackDestination(
          config,
          sourceChatKey,
          identity,
          'topic-auto-create-disabled',
          'Telegram project topic routing is enabled, but autoCreate is disabled and no mapping exists for this project.',
          projectTopics.fallbackToGeneral,
        );
      }

      const existingRecords = await listTelegramTopicRegistryRecords(sourceChatKey);
      const topicName = buildProjectTopicName({
        displayName: identity.displayName,
        projectKey: identity.projectKey,
        naming: projectTopics.naming,
        existingRecords,
      });

      await updateTelegramTopicRegistryRecord(sourceChatKey, identity.projectKey, (record) => ({
        ...record,
        sourceChatKey,
        projectKey: identity.projectKey,
        canonicalProjectPath: identity.canonicalProjectPath,
        displayName: identity.displayName,
        topicName,
        lastCreateAttemptAt: nowIso,
      }));

      try {
        const createdTopic = await createForumTopic(
          config,
          {
            chatId: config.chatId,
            name: topicName,
            iconColor: projectTopics.iconColor,
          },
          deps,
        );

        const savedRecord = await persistTopicRecordBestEffort({
          sourceChatKey,
          identity,
          topicName: createdTopic.name,
          messageThreadId: createdTopic.messageThreadId,
          nowIso,
          logger: deps.logger,
          warningCode: 'topic-registry-persist-failed',
          warningMessage:
            'Telegram topic was created, but persisting the mapping failed; continuing with the created topic and retrying persistence on later sends.',
        });

        return {
          chatId: config.chatId,
          sourceChatKey,
          projectKey: identity.projectKey,
          canonicalProjectPath: identity.canonicalProjectPath,
          topicName: savedRecord?.topicName || createdTopic.name,
          messageThreadId: savedRecord?.messageThreadId || createdTopic.messageThreadId,
          ...(savedRecord
            ? {}
            : {
                warningCode: 'topic-registry-persist-failed',
                warningMessage:
                  'Telegram topic was created, but persisting the mapping failed; current delivery will continue with the created topic.',
              }),
        };
      } catch (error) {
        const failure = classifyTopicCreationError(error);
        const cooldownUntil = failure.shouldCooldown
          ? new Date(now.getTime() + projectTopics.createFailureCooldownMs).toISOString()
          : undefined;

        await updateTelegramTopicRegistryRecord(sourceChatKey, identity.projectKey, (record) => ({
          ...record,
          sourceChatKey,
          projectKey: identity.projectKey,
          canonicalProjectPath: identity.canonicalProjectPath,
          displayName: identity.displayName,
          topicName,
          lastCreateAttemptAt: nowIso,
          lastCreateFailureAt: nowIso,
          lastCreateFailureCode: failure.code,
          lastCreateFailureMessage: failure.message,
          createFailureCooldownUntil: cooldownUntil,
          messageThreadId: record?.messageThreadId,
          createdAt: record?.createdAt,
          lastUsedAt: record?.lastUsedAt,
        }));

        logTopicWarning(deps.logger, failure.code, failure.message, {
          sourceChatKey,
          projectKey: identity.projectKey,
          canonicalProjectPath: identity.canonicalProjectPath,
          topicName,
          cooldownUntil,
        });

        return buildFallbackDestination(
          config,
          sourceChatKey,
          identity,
          failure.code,
          failure.message,
          projectTopics.fallbackToGeneral,
        );
      }
    });
  } catch (error) {
    const warningMessage = error instanceof Error ? error.message : String(error);
    logTopicWarning(deps.logger, 'topic-lock-failed', warningMessage, {
      sourceChatKey,
      projectKey: identity.projectKey,
      canonicalProjectPath: identity.canonicalProjectPath,
    });
    return buildFallbackDestination(
      config,
      sourceChatKey,
      identity,
      'topic-lock-failed',
      warningMessage,
      projectTopics.fallbackToGeneral,
    );
  }
}

export async function resolveTelegramDestination(
  config: TelegramNotificationConfig,
  payload: Pick<FullNotificationPayload, 'projectPath' | 'projectName'>,
  deps: TelegramTopicResolutionDeps = {},
): Promise<TelegramResolvedDestination> {
  const sourceChatKey = getTelegramSourceChatKey(config);
  const identity = normalizeTelegramProjectIdentity(payload);
  const projectTopics = normalizeProjectTopicsConfig(config.projectTopics);

  if (!projectTopics) {
    if (identity) {
      const existingRecord = await getTelegramTopicRegistryRecord(
        sourceChatKey,
        identity.projectKey,
      );
      if (existingRecord?.messageThreadId) {
        logTopicWarning(
          deps.logger,
          'topic-routing-disabled-with-existing-record',
          'Telegram topic registry record exists, but projectTopics is disabled in the effective notification config; delivering to the root chat.',
          {
            sourceChatKey,
            projectKey: identity.projectKey,
            canonicalProjectPath: identity.canonicalProjectPath,
            messageThreadId: existingRecord.messageThreadId,
            topicName: existingRecord.topicName,
          },
        );
      }
    }
    return {
      chatId: config.chatId,
      sourceChatKey,
    };
  }

  if (!identity) {
    return buildFallbackDestination(
      config,
      sourceChatKey,
      null,
      'missing-project-path',
      'Telegram project topic routing requires payload.projectPath; falling back to the root chat.',
      true,
    );
  }

  const now = resolveNow(deps.now);
  const existingRecord = await getTelegramTopicRegistryRecord(sourceChatKey, identity.projectKey);
  if (existingRecord?.messageThreadId) {
    try {
      await touchTelegramTopicRegistryRecord(sourceChatKey, identity.projectKey, {
        canonicalProjectPath: identity.canonicalProjectPath,
        displayName: identity.displayName,
        lastUsedAt: now.toISOString(),
      });
    } catch (error) {
      logTopicWarning(
        deps.logger,
        'topic-registry-touch-failed',
        'Failed to refresh Telegram topic registry usage metadata; continuing with the cached thread destination.',
        {
          sourceChatKey,
          projectKey: identity.projectKey,
          canonicalProjectPath: identity.canonicalProjectPath,
          messageThreadId: existingRecord.messageThreadId,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
    return {
      chatId: config.chatId,
      sourceChatKey,
      projectKey: identity.projectKey,
      canonicalProjectPath: identity.canonicalProjectPath,
      topicName: existingRecord.topicName,
      messageThreadId: existingRecord.messageThreadId,
    };
  }

  return await ensureProjectTopic(config, payload, deps);
}
