/**
 * Notification Configuration Reader
 *
 * Reads notification config from .omx-config.json and provides
 * backward compatibility with the old stopHookCallbacks format.
 */

import { readFileSync, existsSync } from "fs";
import { isAbsolute, join } from "path";
import { homedir } from "os";
import { codexHome, defaultCodexHome } from "../utils/paths.js";
import type {
  CompletedTurnPlatformPresentationConfig,
  CompletedTurnPresentationConfig,
  TelegramCompletedTurnFormat,
  CompletedTurnRenderMode,
  FullNotificationConfig,
  NotificationsBlock,
  NotificationEvent,
  NotificationPlatform,
  EventNotificationConfig,
  DiscordNotificationConfig,
  DiscordBotNotificationConfig,
  TelegramNotificationConfig,
  VerbosityLevel,
} from "./types.js";
import {
  isTelegramProgressButtonEnabled,
  normalizeTelegramProgressConfig,
} from "./telegram-progress.js";
import type {
  AudioTranscriptionPreprocessMode,
  TelegramVoiceTranscriptionConfig,
  TelegramVoiceTranscriptionFallbackMode,
  TelegramVoiceTranscriptionInjectMode,
} from "./transcription/types.js";
import { getHookConfig, mergeHookConfigIntoNotificationConfig } from "./hook-config.js";
import {
  getTempBuiltinSelectors,
  isNotifyTempEnvActive,
  isOpenClawSelectedInTempContract,
  readNotifyTempContractFromEnv,
} from "./temp-contract.js";

const TEMP_SELECTOR_PLATFORM_MAP = {
  discord: ["discord", "discord-bot"],
  telegram: ["telegram"],
  slack: ["slack"],
} as const satisfies Record<string, NotificationPlatform[]>;

const NOTIFICATION_PLATFORMS = [
  "discord",
  "discord-bot",
  "telegram",
  "slack",
  "webhook",
] as const satisfies readonly NotificationPlatform[];

const TEMP_FILTERABLE_PLATFORMS = NOTIFICATION_PLATFORMS;

const COMPLETED_TURN_RENDER_MODES = new Set<CompletedTurnRenderMode>([
  "formatted-notification",
  "raw-assistant-text",
]);
const TELEGRAM_COMPLETED_TURN_FORMATS = new Set<TelegramCompletedTurnFormat>([
  "literal",
  "entities",
]);
const DEFAULT_RESULT_READY_MODE: CompletedTurnRenderMode = "raw-assistant-text";
const DEFAULT_ASK_USER_QUESTION_MODE: CompletedTurnRenderMode =
  "raw-assistant-text";
const DEFAULT_TELEGRAM_COMPLETED_TURN_FORMAT: TelegramCompletedTurnFormat =
  "entities";

export interface NotificationConfigLoadOptions {
  codexHomeOverride?: string;
  env?: NodeJS.ProcessEnv;
}

function resolveNotificationConfigPathCandidates(
  options: NotificationConfigLoadOptions = {},
): string[] {
  const env = options.env ?? process.env;
  const primaryCodexHome = options.codexHomeOverride || codexHome(env);
  const userCodexHome = defaultCodexHome();
  const candidates = [
    join(primaryCodexHome, ".omx-config.json"),
    ...(primaryCodexHome === userCodexHome
      ? []
      : [join(userCodexHome, ".omx-config.json")]),
  ];
  return [...new Set(candidates)];
}

function readRawConfig(
  options: NotificationConfigLoadOptions = {},
): Record<string, unknown> | null {
  const configPaths = resolveNotificationConfigPathCandidates(options);

  for (let index = 0; index < configPaths.length; index += 1) {
    const configPath = configPaths[index];
    if (!existsSync(configPath)) continue;
    try {
      return JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      if (index === 0) {
        return null;
      }
      continue;
    }
  }

  return null;
}

function normalizeCompletedTurnRenderMode(
  value: unknown,
  fallback: CompletedTurnRenderMode,
): CompletedTurnRenderMode {
  return typeof value === "string" && COMPLETED_TURN_RENDER_MODES.has(value as CompletedTurnRenderMode)
    ? value as CompletedTurnRenderMode
    : fallback;
}

function normalizeTelegramCompletedTurnFormat(
  value: unknown,
  fallback: TelegramCompletedTurnFormat = DEFAULT_TELEGRAM_COMPLETED_TURN_FORMAT,
): TelegramCompletedTurnFormat {
  return typeof value === "string"
    && TELEGRAM_COMPLETED_TURN_FORMATS.has(value as TelegramCompletedTurnFormat)
    ? value as TelegramCompletedTurnFormat
    : fallback;
}

function normalizeCompletedTurnPlatformOverrides(
  value: unknown,
): CompletedTurnPresentationConfig["platformOverrides"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const overrides = Object.entries(value).reduce<NonNullable<
    CompletedTurnPresentationConfig["platformOverrides"]
  >>((acc, [platform, rawOverride]) => {
    if (
      !NOTIFICATION_PLATFORMS.includes(platform as NotificationPlatform)
      || !rawOverride
      || typeof rawOverride !== "object"
      || Array.isArray(rawOverride)
    ) {
      return acc;
    }

    const overrideConfig = rawOverride as CompletedTurnPlatformPresentationConfig;
    const normalizedOverride: CompletedTurnPlatformPresentationConfig = {};
    if (overrideConfig.resultReadyMode !== undefined) {
      normalizedOverride.resultReadyMode = normalizeCompletedTurnRenderMode(
        overrideConfig.resultReadyMode,
        DEFAULT_RESULT_READY_MODE,
      );
    }
    if (overrideConfig.askUserQuestionMode !== undefined) {
      normalizedOverride.askUserQuestionMode = normalizeCompletedTurnRenderMode(
        overrideConfig.askUserQuestionMode,
        DEFAULT_ASK_USER_QUESTION_MODE,
      );
    }
    if (
      platform === "telegram"
      && overrideConfig.telegramFormat !== undefined
    ) {
      normalizedOverride.telegramFormat = normalizeTelegramCompletedTurnFormat(
        overrideConfig.telegramFormat,
      );
    }

    if (Object.keys(normalizedOverride).length > 0) {
      acc[platform as NotificationPlatform] = normalizedOverride;
    }
    return acc;
  }, {});

  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

export function normalizeCompletedTurnPresentationConfig(
  config?: Partial<CompletedTurnPresentationConfig> | null,
): CompletedTurnPresentationConfig {
  return {
    resultReadyMode: normalizeCompletedTurnRenderMode(
      config?.resultReadyMode,
      DEFAULT_RESULT_READY_MODE,
    ),
    askUserQuestionMode: normalizeCompletedTurnRenderMode(
      config?.askUserQuestionMode,
      DEFAULT_ASK_USER_QUESTION_MODE,
    ),
    platformOverrides: normalizeCompletedTurnPlatformOverrides(config?.platformOverrides),
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeNotificationConfig(
  config: FullNotificationConfig,
): FullNotificationConfig {
  const normalizeTelegramConfig = (
    telegram: TelegramNotificationConfig | undefined,
    baseTelegram?: TelegramNotificationConfig,
    options: { includeDefaultProgress: boolean } = { includeDefaultProgress: true },
  ): TelegramNotificationConfig | undefined => {
    if (!telegram) return undefined;
    const hasProgressOverride = hasOwn(telegram, "progress");
    const rawProgress =
      hasProgressOverride
      && isPlainRecord(baseTelegram?.progress)
      && isPlainRecord(telegram.progress)
        ? { ...baseTelegram.progress, ...telegram.progress }
        : hasProgressOverride
          ? telegram.progress
          : undefined;
    const normalized: TelegramNotificationConfig = {
      ...telegram,
    };
    if (options.includeDefaultProgress || hasProgressOverride) {
      normalized.progress = normalizeTelegramProgressConfig(rawProgress);
    }
    return normalized;
  };
  const events = config.events
    ? Object.fromEntries(
        Object.entries(config.events).map(([eventName, eventConfig]) => {
          const normalizedEvent = eventConfig
            ? {
                ...eventConfig,
                ...(eventConfig.telegram
                  ? {
                      telegram: normalizeTelegramConfig(
                        eventConfig.telegram,
                        config.telegram,
                        { includeDefaultProgress: false },
                      ),
                    }
                  : {}),
              }
            : eventConfig;
          return [eventName, normalizedEvent];
        }),
      ) as FullNotificationConfig["events"]
    : undefined;

  return {
    ...config,
    ...(config.telegram ? { telegram: normalizeTelegramConfig(config.telegram) } : {}),
    ...(events ? { events } : {}),
    completedTurn: normalizeCompletedTurnPresentationConfig(config.completedTurn),
  };
}

function migrateStopHookCallbacks(
  raw: Record<string, unknown>,
): FullNotificationConfig | null {
  const callbacks = raw.stopHookCallbacks as
    | Record<string, unknown>
    | undefined;
  if (!callbacks) return null;

  const config: FullNotificationConfig = {
    enabled: true,
    events: {
      "session-end": { enabled: true },
    },
  };

  const telegram = callbacks.telegram as Record<string, unknown> | undefined;
  if (telegram?.enabled) {
    const telegramConfig: TelegramNotificationConfig = {
      enabled: true,
      botToken: (telegram.botToken as string) || "",
      chatId: (telegram.chatId as string) || "",
    };
    config.telegram = telegramConfig;
  }

  const discord = callbacks.discord as Record<string, unknown> | undefined;
  if (discord?.enabled) {
    const discordConfig: DiscordNotificationConfig = {
      enabled: true,
      webhookUrl: (discord.webhookUrl as string) || "",
    };
    config.discord = discordConfig;
  }

  return config;
}

function normalizeOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export function validateMention(raw: string | undefined): string | undefined {
  const mention = normalizeOptional(raw);
  if (!mention) return undefined;
  if (/^<@!?\d{17,20}>$/.test(mention) || /^<@&\d{17,20}>$/.test(mention)) {
    return mention;
  }
  return undefined;
}

/**
 * Validate Slack mention format.
 * Accepts: <@UXXXXXXXX> (user), <!channel>, <!here>, <!everyone>, <!subteam^SXXXXXXXXX> (user group).
 * Returns the mention string if valid, undefined otherwise.
 */
export function validateSlackMention(raw: string | undefined): string | undefined {
  const mention = normalizeOptional(raw);
  if (!mention) return undefined;
  // <@U...> or <@W...> user mention
  if (/^<@[UW][A-Z0-9]{8,11}>$/.test(mention)) return mention;
  // <!channel>, <!here>, <!everyone>
  if (/^<!(?:channel|here|everyone)>$/.test(mention)) return mention;
  // <!subteam^S...> user group
  if (/^<!subteam\^S[A-Z0-9]{8,11}>$/.test(mention)) return mention;
  return undefined;
}

export function parseMentionAllowedMentions(
  mention: string | undefined,
): { users?: string[]; roles?: string[] } {
  if (!mention) return {};
  const userMatch = mention.match(/^<@!?(\d{17,20})>$/);
  if (userMatch) return { users: [userMatch[1]] };
  const roleMatch = mention.match(/^<@&(\d{17,20})>$/);
  if (roleMatch) return { roles: [roleMatch[1]] };
  return {};
}

export function buildConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): FullNotificationConfig | null {
  const config: FullNotificationConfig = { enabled: false };
  let hasAnyPlatform = false;

  const discordMention = validateMention(env.OMX_DISCORD_MENTION);

  const discordBotToken = env.OMX_DISCORD_NOTIFIER_BOT_TOKEN;
  const discordChannel = env.OMX_DISCORD_NOTIFIER_CHANNEL;
  if (discordBotToken && discordChannel) {
    config["discord-bot"] = {
      enabled: true,
      botToken: discordBotToken,
      channelId: discordChannel,
      mention: discordMention,
    };
    hasAnyPlatform = true;
  }

  const discordWebhook = env.OMX_DISCORD_WEBHOOK_URL;
  if (discordWebhook) {
    config.discord = {
      enabled: true,
      webhookUrl: discordWebhook,
      mention: discordMention,
    };
    hasAnyPlatform = true;
  }

  const telegramToken =
    env.OMX_TELEGRAM_BOT_TOKEN ||
    env.OMX_TELEGRAM_NOTIFIER_BOT_TOKEN;
  const telegramChatId =
    env.OMX_TELEGRAM_CHAT_ID ||
    env.OMX_TELEGRAM_NOTIFIER_CHAT_ID ||
    env.OMX_TELEGRAM_NOTIFIER_UID;
  if (telegramToken && telegramChatId) {
    config.telegram = {
      enabled: true,
      botToken: telegramToken,
      chatId: telegramChatId,
    };
    hasAnyPlatform = true;
  }

  const slackWebhook = env.OMX_SLACK_WEBHOOK_URL;
  if (slackWebhook) {
    const slackMention = validateSlackMention(env.OMX_SLACK_MENTION);
    config.slack = {
      enabled: true,
      webhookUrl: slackWebhook,
      ...(slackMention !== undefined && { mention: slackMention }),
    };
    hasAnyPlatform = true;
  }

  if (!hasAnyPlatform) return null;

  config.enabled = true;
  return config;
}

function mergeEnvIntoFileConfig(
  fileConfig: FullNotificationConfig,
  envConfig: FullNotificationConfig,
): FullNotificationConfig {
  const merged = { ...fileConfig };

  if (!merged["discord-bot"] && envConfig["discord-bot"]) {
    merged["discord-bot"] = envConfig["discord-bot"];
  } else if (merged["discord-bot"] && envConfig["discord-bot"]) {
    merged["discord-bot"] = {
      ...merged["discord-bot"],
      botToken: merged["discord-bot"].botToken || envConfig["discord-bot"].botToken,
      channelId: merged["discord-bot"].channelId || envConfig["discord-bot"].channelId,
      mention:
        merged["discord-bot"].mention !== undefined
          ? validateMention(merged["discord-bot"].mention)
          : envConfig["discord-bot"].mention,
    };
  }

  if (!merged.discord && envConfig.discord) {
    merged.discord = envConfig.discord;
  } else if (merged.discord && envConfig.discord) {
    merged.discord = {
      ...merged.discord,
      webhookUrl: merged.discord.webhookUrl || envConfig.discord.webhookUrl,
      mention:
        merged.discord.mention !== undefined
          ? validateMention(merged.discord.mention)
          : envConfig.discord.mention,
    };
  } else if (merged.discord) {
    merged.discord = {
      ...merged.discord,
      mention: validateMention(merged.discord.mention),
    };
  }

  if (!merged.telegram && envConfig.telegram) {
    merged.telegram = envConfig.telegram;
  } else if (merged.telegram && envConfig.telegram) {
    merged.telegram = {
      ...merged.telegram,
      botToken: merged.telegram.botToken || envConfig.telegram.botToken,
      chatId: merged.telegram.chatId || envConfig.telegram.chatId,
      parseMode: merged.telegram.parseMode || envConfig.telegram.parseMode,
      projectTopics:
        merged.telegram.projectTopics ?? envConfig.telegram.projectTopics,
    };
  }

  if (!merged.slack && envConfig.slack) {
    merged.slack = envConfig.slack;
  } else if (merged.slack && envConfig.slack) {
    merged.slack = {
      ...merged.slack,
      webhookUrl: merged.slack.webhookUrl || envConfig.slack.webhookUrl,
      mention:
        merged.slack.mention !== undefined
          ? validateSlackMention(merged.slack.mention)
          : envConfig.slack.mention,
    };
  } else if (merged.slack) {
    merged.slack = {
      ...merged.slack,
      mention: validateSlackMention(merged.slack.mention),
    };
  }

  return merged;
}

/**
 * Resolve a named profile from the notifications block.
 *
 * Priority:
 *   1. Explicit `profileName` argument
 *   2. OMX_NOTIFY_PROFILE environment variable
 *   3. `defaultProfile` field in config
 *   4. null (no profile selected → fall back to flat config)
 */
export function resolveProfileConfig(
  notifications: NotificationsBlock,
  profileName?: string,
  env: NodeJS.ProcessEnv = process.env,
): FullNotificationConfig | null {
  const profiles = notifications.profiles;
  if (!profiles || Object.keys(profiles).length === 0) {
    return null; // no profiles defined, use flat config
  }

  const name =
    profileName ||
    env.OMX_NOTIFY_PROFILE ||
    notifications.defaultProfile;

  if (!name) {
    return null; // no profile selected, use flat config
  }

  const profile = profiles[name];
  if (!profile) {
    console.warn(
      `[notifications] Profile "${name}" not found. Available: ${Object.keys(profiles).join(", ")}`,
    );
    return null;
  }

  return profile;
}

/**
 * List available profile names from the config file.
 */
export function listProfiles(): string[] {
  const raw = readRawConfig();
  if (!raw) return [];
  const notifications = raw.notifications as NotificationsBlock | undefined;
  if (!notifications?.profiles) return [];
  return Object.keys(notifications.profiles);
}

/**
 * Get the active profile name based on resolution priority.
 * Returns null if no profile is active (flat config mode).
 */
export function getActiveProfileName(): string | null {
  if (process.env.OMX_NOTIFY_PROFILE) {
    return process.env.OMX_NOTIFY_PROFILE;
  }
  const raw = readRawConfig();
  if (!raw) return null;
  const notifications = raw.notifications as NotificationsBlock | undefined;
  if (!notifications?.profiles || Object.keys(notifications.profiles).length === 0) {
    return null;
  }
  return notifications.defaultProfile || null;
}

function applyHookConfigIfPresent(config: FullNotificationConfig): FullNotificationConfig {
  const hookConfig = getHookConfig();
  if (!hookConfig) return config;
  return mergeHookConfigIntoNotificationConfig(hookConfig, config);
}

function hasCustomTransportAlias(config: FullNotificationConfig): boolean {
  const cli = config.custom_cli_command;
  const webhook = config.custom_webhook_command;
  const cliEnabled = Boolean(cli && cli.enabled !== false && cli.command);
  const webhookEnabled = Boolean(webhook && webhook.enabled !== false && webhook.url);
  return cliEnabled || webhookEnabled;
}

function normalizeCustomTransportGate(config: FullNotificationConfig): FullNotificationConfig {
  if (config.openclaw?.enabled) return config;
  if (!hasCustomTransportAlias(config)) return config;
  return {
    ...config,
    openclaw: { enabled: true },
  };
}

function isPlatformSelectedInTempMode(
  selectors: Set<string>,
  platform: NotificationPlatform,
): boolean {
  return Object.entries(TEMP_SELECTOR_PLATFORM_MAP).some(([selector, platforms]) => {
    const allowedPlatforms = platforms as readonly NotificationPlatform[];
    return selectors.has(selector) && allowedPlatforms.includes(platform);
  });
}

function filterEventPlatformsForTempSelection(
  eventConfig: EventNotificationConfig | undefined,
  selectors: Set<string>,
): EventNotificationConfig | undefined {
  if (!eventConfig) return eventConfig;
  const filtered = { ...eventConfig };
  for (const platform of TEMP_FILTERABLE_PLATFORMS) {
    if (!isPlatformSelectedInTempMode(selectors, platform)) {
      delete filtered[platform];
    }
  }
  return filtered;
}

function filterTopLevelPlatformsForTempSelection(
  config: FullNotificationConfig,
  selectors: Set<string>,
): FullNotificationConfig {
  const filtered = { ...config };
  for (const platform of TEMP_FILTERABLE_PLATFORMS) {
    if (!isPlatformSelectedInTempMode(selectors, platform)) {
      delete filtered[platform];
    }
  }
  return filtered;
}

function resolvePersistentNotificationConfig(
  profileName?: string,
  options: NotificationConfigLoadOptions = {},
): FullNotificationConfig | null {
  const env = options.env ?? process.env;
  const raw = readRawConfig(options);

  if (raw) {
    const notifications = raw.notifications as NotificationsBlock | undefined;
    if (notifications) {
      const profileConfig = resolveProfileConfig(notifications, profileName, env);
      if (profileConfig) {
        if (typeof profileConfig.enabled !== "boolean") {
          return null;
        }
        const envConfig = buildConfigFromEnv(env);
        const merged = envConfig
          ? mergeEnvIntoFileConfig(profileConfig, envConfig)
          : profileConfig;
        return applyHookConfigIfPresent(normalizeCustomTransportGate(merged));
      }

      if (typeof notifications.enabled !== "boolean") {
        return null;
      }
      const envConfig = buildConfigFromEnv(env);
      if (envConfig) {
        return applyHookConfigIfPresent(
          normalizeCustomTransportGate(mergeEnvIntoFileConfig(notifications, envConfig)),
        );
      }
      const envMention = validateMention(env.OMX_DISCORD_MENTION);
      if (envMention) {
        const patched = { ...notifications };
        if (patched["discord-bot"] && patched["discord-bot"].mention === undefined) {
          patched["discord-bot"] = { ...patched["discord-bot"], mention: envMention };
        }
        if (patched.discord && patched.discord.mention === undefined) {
          patched.discord = { ...patched.discord, mention: envMention };
        }
        return applyHookConfigIfPresent(normalizeCustomTransportGate(patched));
      }
      return applyHookConfigIfPresent(normalizeCustomTransportGate(notifications));
    }
  }

  const envConfig = buildConfigFromEnv(env);
  if (envConfig) return applyHookConfigIfPresent(envConfig);

  if (raw) {
    const migrated = migrateStopHookCallbacks(raw);
    if (migrated) return applyHookConfigIfPresent(migrated);
    return null;
  }

  return null;
}

function selectTempModeTransports(
  config: FullNotificationConfig,
  selectors: Set<string>,
  openClawSelected: boolean,
): FullNotificationConfig {
  const nextEvents = config.events
    ? Object.fromEntries(
        Object.entries(config.events).map(([eventName, eventConfig]) => {
          return [eventName, filterEventPlatformsForTempSelection(eventConfig, selectors)];
        }),
      ) as FullNotificationConfig["events"]
    : undefined;

  const selected: FullNotificationConfig = {
    ...filterTopLevelPlatformsForTempSelection(config, selectors),
    events: nextEvents,
    openclaw: openClawSelected ? (config.openclaw ?? { enabled: true }) : undefined,
    custom_cli_command: openClawSelected ? config.custom_cli_command : undefined,
    custom_webhook_command: openClawSelected ? config.custom_webhook_command : undefined,
  };

  selected.enabled = Boolean(
    selected.discord?.enabled
    || selected["discord-bot"]?.enabled
    || selected.telegram?.enabled
    || selected.slack?.enabled
    || selected.openclaw?.enabled
    || hasCustomTransportAlias(selected),
  );
  return selected;
}

function hasExplicitEventPolicy(
  config: FullNotificationConfig,
): boolean {
  return Boolean(config.events && Object.keys(config.events).length > 0);
}

function applyMeaningfulTelegramTempDefaults(
  config: FullNotificationConfig,
  selectors: Set<string>,
): FullNotificationConfig {
  if (!selectors.has("telegram") || hasExplicitEventPolicy(config)) {
    return config;
  }

  return {
    ...config,
    events: {
      ...(config.events ?? {}),
      "session-start": { enabled: false },
      "session-stop": { enabled: false },
      "session-idle": { enabled: false },
      "result-ready": { enabled: true },
      "ask-user-question": { enabled: true },
      "session-end": { enabled: true },
    },
  };
}

function buildTempModeConfigFromContract(
  baseConfig: FullNotificationConfig | null,
  env: NodeJS.ProcessEnv = process.env,
): FullNotificationConfig | null {
  const contract = readNotifyTempContractFromEnv(env);
  const envActive = isNotifyTempEnvActive(env);
  if (!contract?.active && !envActive) return null;

  const selectors = getTempBuiltinSelectors(contract);
  const seedConfig = baseConfig ?? buildConfigFromEnv(env) ?? { enabled: false };
  return applyMeaningfulTelegramTempDefaults(
    selectTempModeTransports(
      seedConfig,
      selectors,
      isOpenClawSelectedInTempContract(contract),
    ),
    selectors,
  );
}

export function getNotificationConfig(
  profileName?: string,
  options: NotificationConfigLoadOptions = {},
): FullNotificationConfig | null {
  const env = options.env ?? process.env;
  const persistentConfig = resolvePersistentNotificationConfig(profileName, options);
  const tempModeConfig = buildTempModeConfigFromContract(persistentConfig, env);
  const effectiveConfig = tempModeConfig ?? persistentConfig;
  return effectiveConfig ? normalizeNotificationConfig(effectiveConfig) : null;
}

const VALID_VERBOSITY_LEVELS: VerbosityLevel[] = ["verbose", "agent", "session", "minimal"];
const DEFAULT_VERBOSITY: VerbosityLevel = "session";

/**
 * Numeric rank for verbosity levels (higher = more verbose).
 */
const VERBOSITY_RANK: Record<VerbosityLevel, number> = {
  minimal: 0,
  session: 1,
  agent: 2,
  verbose: 3,
};

/**
 * Minimum verbosity level required for each event type.
 */
const EVENT_MIN_VERBOSITY: Record<NotificationEvent, VerbosityLevel> = {
  "session-start": "minimal",
  "session-stop": "minimal",
  "session-end": "minimal",
  "session-idle": "session",
  "result-ready": "session",
  "ask-user-question": "agent",
};

/**
 * Resolve the effective verbosity level.
 * Priority: env var > config field > default ("session").
 */
export function getVerbosity(config: FullNotificationConfig | null): VerbosityLevel {
  const envVal = process.env.OMX_NOTIFY_VERBOSITY as string | undefined;
  if (envVal && VALID_VERBOSITY_LEVELS.includes(envVal as VerbosityLevel)) {
    return envVal as VerbosityLevel;
  }
  if (config?.verbosity && VALID_VERBOSITY_LEVELS.includes(config.verbosity)) {
    return config.verbosity;
  }
  return DEFAULT_VERBOSITY;
}

/**
 * Check whether a given event is allowed at the specified verbosity level.
 */
export function isEventAllowedByVerbosity(
  verbosity: VerbosityLevel,
  event: NotificationEvent,
): boolean {
  const required = EVENT_MIN_VERBOSITY[event] ?? "session";
  return VERBOSITY_RANK[verbosity] >= VERBOSITY_RANK[required];
}

/**
 * Whether the given verbosity level should include tmux tail output.
 */
export function shouldIncludeTmuxTail(verbosity: VerbosityLevel): boolean {
  return VERBOSITY_RANK[verbosity] >= VERBOSITY_RANK["session"];
}

export function isEventEnabled(
  config: FullNotificationConfig,
  event: NotificationEvent,
): boolean {
  if (!config.enabled) return false;
  const eventConfig = config.events?.[event];
  if (eventConfig?.enabled === false) return false;

  // Verbosity gate: explicit per-event enables override the coarse verbosity floor.
  const verbosity = getVerbosity(config);
  if (eventConfig?.enabled !== true && !isEventAllowedByVerbosity(verbosity, event)) return false;

  if (!eventConfig) {
    return !!(
      config.discord?.enabled ||
      config["discord-bot"]?.enabled ||
      config.telegram?.enabled ||
      config.slack?.enabled ||
      config.webhook?.enabled ||
      config.openclaw?.enabled ||
      hasCustomTransportAlias(config)
    );
  }

  if (
    eventConfig.discord?.enabled ||
    eventConfig["discord-bot"]?.enabled ||
    eventConfig.telegram?.enabled ||
    eventConfig.slack?.enabled ||
    eventConfig.webhook?.enabled
  ) {
    return true;
  }

  return !!(
    config.discord?.enabled ||
    config["discord-bot"]?.enabled ||
    config.telegram?.enabled ||
    config.slack?.enabled ||
    config.webhook?.enabled ||
    config.openclaw?.enabled ||
    hasCustomTransportAlias(config)
  );
}

export function getEnabledPlatforms(
  config: FullNotificationConfig,
  event: NotificationEvent,
): NotificationPlatform[] {
  if (!config.enabled) return [];

  const platforms: NotificationPlatform[] = [];
  const eventConfig = config.events?.[event];

  if (eventConfig && eventConfig.enabled === false) return [];

  const checkPlatform = (platform: NotificationPlatform) => {
    const eventPlatform =
      eventConfig?.[platform as keyof EventNotificationConfig];
    if (
      eventPlatform &&
      typeof eventPlatform === "object" &&
      "enabled" in eventPlatform
    ) {
      if ((eventPlatform as { enabled: boolean }).enabled) {
        platforms.push(platform);
      }
      return;
    }

    const topLevel = config[platform as keyof FullNotificationConfig];
    if (
      topLevel &&
      typeof topLevel === "object" &&
      "enabled" in topLevel &&
      (topLevel as { enabled: boolean }).enabled
    ) {
      platforms.push(platform);
    }
  };

  checkPlatform("discord");
  checkPlatform("discord-bot");
  checkPlatform("telegram");
  checkPlatform("slack");
  checkPlatform("webhook");

  return platforms;
}

const REPLY_PLATFORM_EVENTS: NotificationEvent[] = [
  "session-start",
  "ask-user-question",
  "result-ready",
  "session-stop",
  "session-idle",
  "session-end",
];

function getEnabledReplyPlatformConfig<T extends { enabled: boolean }>(
  config: FullNotificationConfig,
  platform: "discord-bot" | "telegram",
): T | undefined {
  const topLevel = config[platform] as T | undefined;
  if (topLevel?.enabled) {
    return topLevel;
  }

  for (const event of REPLY_PLATFORM_EVENTS) {
    const eventConfig = config.events?.[event];
    const eventPlatform =
      eventConfig?.[platform as keyof EventNotificationConfig];

    if (
      eventPlatform &&
      typeof eventPlatform === "object" &&
      "enabled" in eventPlatform &&
      (eventPlatform as { enabled: boolean }).enabled
    ) {
      return eventPlatform as T;
    }
  }

  return undefined;
}

export function getReplyListenerPlatformConfig(
  config: FullNotificationConfig | null,
): {
  telegramEnabled: boolean;
  telegramBotToken?: string;
  telegramChatId?: string;
  discordEnabled: boolean;
  discordBotToken?: string;
  discordChannelId?: string;
  discordMention?: string;
} {
  if (!config) {
    return {
      telegramEnabled: false,
      discordEnabled: false,
    };
  }

  const telegramConfig =
    getEnabledReplyPlatformConfig<TelegramNotificationConfig>(
      config,
      "telegram",
    );
  const discordBotConfig =
    getEnabledReplyPlatformConfig<DiscordBotNotificationConfig>(
      config,
      "discord-bot",
    );

  const telegramEnabled = !!(telegramConfig?.botToken && telegramConfig?.chatId);
  const discordEnabled = !!(discordBotConfig?.botToken && discordBotConfig?.channelId);

  return {
    telegramEnabled,
    telegramBotToken: telegramEnabled ? telegramConfig?.botToken : undefined,
    telegramChatId: telegramEnabled ? telegramConfig?.chatId : undefined,
    discordEnabled,
    discordBotToken: discordEnabled ? discordBotConfig?.botToken : undefined,
    discordChannelId: discordEnabled ? discordBotConfig?.channelId : undefined,
    discordMention: discordEnabled ? discordBotConfig?.mention : undefined,
  };
}

function parseDiscordUserIds(
  envValue: string | undefined,
  configValue: unknown,
): string[] {
  if (envValue) {
    const ids = envValue
      .split(",")
      .map((id) => id.trim())
      .filter((id) => /^\d{17,20}$/.test(id));
    if (ids.length > 0) return ids;
  }

  if (Array.isArray(configValue)) {
    const ids = configValue
      .filter((id) => typeof id === "string" && /^\d{17,20}$/.test(id));
    if (ids.length > 0) return ids;
  }

  return [];
}

function parseTelegramUserIds(
  envValue: string | undefined,
  configValue: unknown,
): string[] {
  if (envValue) {
    const ids = envValue
      .split(",")
      .map((id) => id.trim())
      .filter((id) => /^\d{1,20}$/.test(id));
    if (ids.length > 0) return ids;
  }

  if (Array.isArray(configValue)) {
    const ids = configValue
      .filter((id): id is string => typeof id === "string")
      .map((id) => id.trim())
      .filter((id) => /^\d{1,20}$/.test(id));
    if (ids.length > 0) return ids;
  }

  return [];
}

const REPLY_POLL_INTERVAL_MIN_MS = 500;
const REPLY_POLL_INTERVAL_MAX_MS = 60_000;
const REPLY_POLL_INTERVAL_DEFAULT_MS = 3_000;
const REPLY_RATE_LIMIT_MIN_PER_MINUTE = 1;
const REPLY_RATE_LIMIT_DEFAULT_PER_MINUTE = 10;
const REPLY_MAX_MESSAGE_LENGTH_MIN = 1;
const REPLY_MAX_MESSAGE_LENGTH_MAX = 4_000;
const REPLY_MAX_MESSAGE_LENGTH_DEFAULT = 500;
const REPLY_ACK_MODE_DEFAULT = "minimal";
const REPLY_TELEGRAM_POLL_TIMEOUT_SECONDS_MIN = 1;
const REPLY_TELEGRAM_POLL_TIMEOUT_SECONDS_MAX = 60;
const REPLY_TELEGRAM_POLL_TIMEOUT_SECONDS_DEFAULT = 30;
const REPLY_TELEGRAM_ALLOWED_UPDATES_DEFAULT = ["message"];
const REPLY_TELEGRAM_STARTUP_BACKLOG_DEFAULT = "resume";
const REPLY_ACK_MODES = new Set(["off", "minimal", "summary"]);
const REPLY_TELEGRAM_ACK_MODES = new Set([
  "off",
  "minimal",
  "summary",
  "accepted",
  "accepted-final-message",
]);
const REPLY_TELEGRAM_STARTUP_BACKLOG_POLICIES = new Set([
  "resume",
  "drop_pending",
  "replay_once",
]);
const REPLY_TELEGRAM_VOICE_TRANSCRIPTION_PROVIDERS = new Set(["whisper-cpp"]);
const REPLY_TELEGRAM_VOICE_TRANSCRIPTION_MEDIA_KINDS = new Set(["voice", "audio"]);
const REPLY_TELEGRAM_VOICE_TRANSCRIPTION_INJECT_MODES = new Set([
  "transcript-only",
  "transcript-with-attachment",
  "attachment-on-failure",
]);
const REPLY_TELEGRAM_VOICE_TRANSCRIPTION_FALLBACK_MODES = new Set([
  "attachment-with-diagnostic",
  "attachment-only",
]);
const REPLY_TELEGRAM_VOICE_TRANSCRIPTION_PREPROCESS_MODES = new Set([
  "off",
  "ffmpeg-wav-auto",
  "ffmpeg-wav-required",
]);
const DEFAULT_TELEGRAM_VOICE_TRANSCRIPTION_PROMPT =
  "Transcribe exactly. The speaker may mix Russian, English, and French. Preserve original languages. Do not translate.";
const DEFAULT_TELEGRAM_VOICE_TRANSCRIPTION_CONFIG: TelegramVoiceTranscriptionConfig = {
  enabled: false,
  provider: "whisper-cpp",
  mediaKinds: ["voice"],
  injectMode: "transcript-only",
  fallbackMode: "attachment-with-diagnostic",
  timeoutMs: 120_000,
  maxDurationSeconds: 300,
  maxTranscriptChars: 3_500,
  language: "auto",
  prompt: DEFAULT_TELEGRAM_VOICE_TRANSCRIPTION_PROMPT,
  preprocess: {
    mode: "ffmpeg-wav-auto",
    binaryPath: "ffmpeg",
  },
  whisperCpp: {
    binaryPath: "whisper-cli",
    threads: 0,
    processors: 1,
    temperature: 0,
    outputJsonFull: false,
  },
};

interface ReplySettingsRaw {
  enabled?: unknown;
  authorizedDiscordUserIds?: unknown;
  authorizedTelegramUserIds?: unknown;
  pollIntervalMs?: unknown;
  rateLimitPerMinute?: unknown;
  maxMessageLength?: unknown;
  includePrefix?: unknown;
  ackMode?: unknown;
  telegramAckMode?: unknown;
  telegramPollTimeoutSeconds?: unknown;
  telegramAllowedUpdates?: unknown;
  telegramStartupBacklogPolicy?: unknown;
  telegramVoiceTranscription?: unknown;
}

interface NotificationsConfigRaw {
  reply?: ReplySettingsRaw;
}

function readReplySettings(raw: Record<string, unknown> | null): ReplySettingsRaw | undefined {
  const notificationsUnknown = raw?.notifications;
  if (!notificationsUnknown || typeof notificationsUnknown !== 'object') return undefined;
  const notifications = notificationsUnknown as NotificationsConfigRaw;
  return notifications.reply;
}

function parseIntegerInput(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number.parseInt(trimmed, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function parseStringList(
  envValue: string | undefined,
  configValue: unknown,
): string[] {
  if (envValue) {
    const values = envValue
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (values.length > 0) return values;
  }

  if (Array.isArray(configValue)) {
    const values = configValue
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (values.length > 0) return values;
  }

  return [];
}

function parseBooleanInput(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(trimmed)) return true;
  if (["false", "0", "no", "off"].includes(trimmed)) return false;
  return undefined;
}

function parseTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseEnumValue<T extends string>(
  envValue: string | undefined,
  configValue: unknown,
  allowed: ReadonlySet<string>,
  fallback: T,
): T {
  const candidate = parseTrimmedString(envValue)?.toLowerCase()
    ?? parseTrimmedString(configValue)?.toLowerCase()
    ?? fallback;
  return allowed.has(candidate) ? candidate as T : fallback;
}

function parseOptionalNumber(value: unknown): number | undefined {
  const parsed = parseIntegerInput(value);
  return parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined;
}

function parseOptionalFloat(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number.parseFloat(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function expandHomeShorthand(pathValue: string): string {
  if (pathValue === "~") return homedir();
  if (pathValue.startsWith("~/")) return join(homedir(), pathValue.slice(2));
  return pathValue;
}

function isExplicitLocalExecutablePath(pathValue: string | undefined): boolean {
  if (!pathValue?.trim()) return false;
  return isAbsolute(expandHomeShorthand(pathValue.trim()));
}

function normalizeTranscriptionMediaKinds(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_TELEGRAM_VOICE_TRANSCRIPTION_CONFIG.mediaKinds];
  const normalized = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => REPLY_TELEGRAM_VOICE_TRANSCRIPTION_MEDIA_KINDS.has(item));
  return normalized.length > 0
    ? [...new Set(normalized)]
    : [...DEFAULT_TELEGRAM_VOICE_TRANSCRIPTION_CONFIG.mediaKinds];
}

export function getDefaultTelegramVoiceTranscriptionConfig(): TelegramVoiceTranscriptionConfig {
  return {
    ...DEFAULT_TELEGRAM_VOICE_TRANSCRIPTION_CONFIG,
    mediaKinds: [...DEFAULT_TELEGRAM_VOICE_TRANSCRIPTION_CONFIG.mediaKinds],
    preprocess: { ...DEFAULT_TELEGRAM_VOICE_TRANSCRIPTION_CONFIG.preprocess },
    whisperCpp: { ...DEFAULT_TELEGRAM_VOICE_TRANSCRIPTION_CONFIG.whisperCpp },
  };
}

export function normalizeTelegramVoiceTranscriptionConfig(
  configValue: unknown,
  env: NodeJS.ProcessEnv = process.env,
): TelegramVoiceTranscriptionConfig {
  const defaults = getDefaultTelegramVoiceTranscriptionConfig();
  const raw = readObject(configValue);
  const preprocessRaw = readObject(raw.preprocess);
  const whisperCppRaw = readObject(raw.whisperCpp);
  const envEnabled = parseBooleanInput(env.OMX_REPLY_TELEGRAM_VOICE_TRANSCRIPTION_ENABLED);
  const enabled = envEnabled ?? parseBooleanInput(raw.enabled) ?? defaults.enabled;
  const timeoutMs = normalizeInteger(
    parseIntegerInput(env.OMX_REPLY_TELEGRAM_VOICE_TRANSCRIPTION_TIMEOUT_MS)
      ?? parseIntegerInput(raw.timeoutMs),
    defaults.timeoutMs,
    1_000,
  );
  const maxDurationSeconds = normalizeInteger(
    parseIntegerInput(env.OMX_REPLY_TELEGRAM_VOICE_TRANSCRIPTION_MAX_DURATION_SECONDS)
      ?? parseIntegerInput(raw.maxDurationSeconds),
    defaults.maxDurationSeconds,
    1,
  );
  const maxTranscriptChars = normalizeInteger(
    parseIntegerInput(raw.maxTranscriptChars),
    defaults.maxTranscriptChars,
    64,
    100_000,
  );
  const provider = parseEnumValue(
    env.OMX_REPLY_TELEGRAM_VOICE_TRANSCRIPTION_PROVIDER,
    raw.provider,
    REPLY_TELEGRAM_VOICE_TRANSCRIPTION_PROVIDERS,
    defaults.provider,
  );
  const injectMode = parseEnumValue<TelegramVoiceTranscriptionInjectMode>(
    env.OMX_REPLY_TELEGRAM_VOICE_TRANSCRIPTION_INJECT_MODE,
    raw.injectMode,
    REPLY_TELEGRAM_VOICE_TRANSCRIPTION_INJECT_MODES,
    defaults.injectMode,
  );
  const fallbackMode = parseEnumValue<TelegramVoiceTranscriptionFallbackMode>(
    undefined,
    raw.fallbackMode,
    REPLY_TELEGRAM_VOICE_TRANSCRIPTION_FALLBACK_MODES,
    defaults.fallbackMode,
  );
  const preprocessMode = parseEnumValue<AudioTranscriptionPreprocessMode>(
    undefined,
    preprocessRaw.mode,
    REPLY_TELEGRAM_VOICE_TRANSCRIPTION_PREPROCESS_MODES,
    defaults.preprocess.mode,
  );
  const prompt = parseTrimmedString(env.OMX_REPLY_TELEGRAM_VOICE_TRANSCRIPTION_PROMPT)
    ?? parseTrimmedString(raw.prompt)
    ?? defaults.prompt;
  const modelPath = parseTrimmedString(env.OMX_REPLY_TELEGRAM_VOICE_TRANSCRIPTION_MODEL)
    ?? parseTrimmedString(whisperCppRaw.modelPath);
  const preprocessBinaryPath = parseTrimmedString(env.OMX_REPLY_TELEGRAM_VOICE_TRANSCRIPTION_FFMPEG_BINARY)
    ?? parseTrimmedString(preprocessRaw.binaryPath)
    ?? defaults.preprocess.binaryPath;
  const whisperCppBinaryPath = parseTrimmedString(env.OMX_REPLY_TELEGRAM_VOICE_TRANSCRIPTION_BINARY)
    ?? parseTrimmedString(whisperCppRaw.binaryPath)
    ?? defaults.whisperCpp.binaryPath;
  const warnings: string[] = [];
  if (enabled && provider === "whisper-cpp") {
    if (!modelPath) {
      warnings.push("telegramVoiceTranscription.whisperCpp.modelPath is required when Telegram voice transcription is enabled");
    }
    if (!isExplicitLocalExecutablePath(whisperCppBinaryPath)) {
      warnings.push("telegramVoiceTranscription.whisperCpp.binaryPath must be an absolute local path when Telegram voice transcription is enabled");
    }
    if (preprocessMode !== "off" && !isExplicitLocalExecutablePath(preprocessBinaryPath)) {
      warnings.push("telegramVoiceTranscription.preprocess.binaryPath must be an absolute local path when Telegram voice transcription preprocessing is enabled");
    }
  }

  return {
    enabled,
    provider,
    mediaKinds: normalizeTranscriptionMediaKinds(raw.mediaKinds),
    injectMode,
    fallbackMode,
    timeoutMs,
    maxDurationSeconds,
    maxTranscriptChars,
    language: parseTrimmedString(env.OMX_REPLY_TELEGRAM_VOICE_TRANSCRIPTION_LANGUAGE)
      ?? parseTrimmedString(raw.language)
      ?? defaults.language,
    ...(prompt ? { prompt } : {}),
    preprocess: {
      mode: preprocessMode,
      binaryPath: preprocessBinaryPath,
    },
    whisperCpp: {
      binaryPath: whisperCppBinaryPath,
      ...(modelPath ? { modelPath } : {}),
      threads: normalizeInteger(
        parseOptionalNumber(whisperCppRaw.threads),
        defaults.whisperCpp.threads ?? 0,
        0,
      ),
      processors: normalizeInteger(
        parseOptionalNumber(whisperCppRaw.processors),
        defaults.whisperCpp.processors ?? 1,
        0,
      ),
      temperature: Math.max(0, parseOptionalFloat(whisperCppRaw.temperature) ?? defaults.whisperCpp.temperature ?? 0),
      outputJsonFull: parseBooleanInput(whisperCppRaw.outputJsonFull) ?? defaults.whisperCpp.outputJsonFull,
    },
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function parseReplyAckMode(
  envValue: string | undefined,
  configValue: unknown,
): "off" | "minimal" | "summary" {
  const candidate = typeof envValue === "string" && envValue.trim()
    ? envValue.trim().toLowerCase()
    : typeof configValue === "string" && configValue.trim()
      ? configValue.trim().toLowerCase()
      : REPLY_ACK_MODE_DEFAULT;
  return REPLY_ACK_MODES.has(candidate)
    ? candidate as "off" | "minimal" | "summary"
    : REPLY_ACK_MODE_DEFAULT;
}

function parseTelegramReplyAckMode(
  envValue: string | undefined,
  configValue: unknown,
  fallback: "off" | "minimal" | "summary",
): "off" | "minimal" | "summary" | "accepted" | "accepted-final-message" {
  const candidate = typeof envValue === "string" && envValue.trim()
    ? envValue.trim().toLowerCase()
    : typeof configValue === "string" && configValue.trim()
      ? configValue.trim().toLowerCase()
      : fallback;
  return REPLY_TELEGRAM_ACK_MODES.has(candidate)
    ? candidate as "off" | "minimal" | "summary" | "accepted" | "accepted-final-message"
    : fallback;
}

function hasTelegramProgressCallbackUx(config: FullNotificationConfig): boolean {
  const candidates: Array<TelegramNotificationConfig | undefined> = [
    config.telegram,
    ...Object.values(config.events ?? {}).map((eventConfig) => eventConfig?.telegram),
  ];
  return candidates.some((telegramConfig) => (
    telegramConfig?.enabled === true
    && isTelegramProgressButtonEnabled(telegramConfig.progress)
  ));
}

function parseTelegramStartupBacklogPolicy(
  envValue: string | undefined,
  configValue: unknown,
): "resume" | "drop_pending" | "replay_once" {
  const candidate = typeof envValue === "string" && envValue.trim()
    ? envValue.trim().toLowerCase()
    : typeof configValue === "string" && configValue.trim()
      ? configValue.trim().toLowerCase()
      : REPLY_TELEGRAM_STARTUP_BACKLOG_DEFAULT;
  return REPLY_TELEGRAM_STARTUP_BACKLOG_POLICIES.has(candidate)
    ? candidate as "resume" | "drop_pending" | "replay_once"
    : REPLY_TELEGRAM_STARTUP_BACKLOG_DEFAULT;
}

function normalizeInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max?: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  if (value < min) return min;
  if (max !== undefined && value > max) return max;
  return value;
}

export function getReplyConfig(
  notifConfig: FullNotificationConfig | null = getNotificationConfig(),
): import("./types.js").ReplyConfig | null {
  if (!notifConfig?.enabled) return null;

  const hasDiscordBot = !!getEnabledReplyPlatformConfig<DiscordBotNotificationConfig>(
    notifConfig,
    "discord-bot",
  );
  const hasTelegram = !!getEnabledReplyPlatformConfig<TelegramNotificationConfig>(
    notifConfig,
    "telegram",
  );
  if (!hasDiscordBot && !hasTelegram) return null;

  const raw = readRawConfig();
  const replyRaw = readReplySettings(raw);

  const enabled = process.env.OMX_REPLY_ENABLED === "true" || replyRaw?.enabled === true;
  if (!enabled) return null;

  const authorizedDiscordUserIds = parseDiscordUserIds(
    process.env.OMX_REPLY_DISCORD_USER_IDS,
    replyRaw?.authorizedDiscordUserIds,
  );
  const authorizedTelegramUserIds = parseTelegramUserIds(
    process.env.OMX_REPLY_TELEGRAM_USER_IDS,
    replyRaw?.authorizedTelegramUserIds,
  );

  if (hasDiscordBot && authorizedDiscordUserIds.length === 0) {
    console.warn(
      "[notifications] Discord reply listening disabled: authorizedDiscordUserIds is empty. " +
      "Set OMX_REPLY_DISCORD_USER_IDS or add to .omx-config.json notifications.reply.authorizedDiscordUserIds"
    );
  }
  if (hasTelegram && authorizedTelegramUserIds.length === 0) {
    console.warn(
      "[notifications] Telegram reply listening allows replies only from private chats because authorizedTelegramUserIds is empty. " +
      "Set OMX_REPLY_TELEGRAM_USER_IDS or add to .omx-config.json notifications.reply.authorizedTelegramUserIds to enable sender-level authorization in group chats."
    );
  }

  const pollIntervalMs = normalizeInteger(
    parseIntegerInput(process.env.OMX_REPLY_POLL_INTERVAL_MS)
      ?? parseIntegerInput(replyRaw?.pollIntervalMs),
    REPLY_POLL_INTERVAL_DEFAULT_MS,
    REPLY_POLL_INTERVAL_MIN_MS,
    REPLY_POLL_INTERVAL_MAX_MS,
  );
  const rateLimitPerMinute = normalizeInteger(
    parseIntegerInput(process.env.OMX_REPLY_RATE_LIMIT)
      ?? parseIntegerInput(replyRaw?.rateLimitPerMinute),
    REPLY_RATE_LIMIT_DEFAULT_PER_MINUTE,
    REPLY_RATE_LIMIT_MIN_PER_MINUTE,
  );
  const maxMessageLength = normalizeInteger(
    parseIntegerInput(replyRaw?.maxMessageLength),
    REPLY_MAX_MESSAGE_LENGTH_DEFAULT,
    REPLY_MAX_MESSAGE_LENGTH_MIN,
    REPLY_MAX_MESSAGE_LENGTH_MAX,
  );
  const telegramPollTimeoutSeconds = normalizeInteger(
    parseIntegerInput(process.env.OMX_REPLY_TELEGRAM_POLL_TIMEOUT_SECONDS)
      ?? parseIntegerInput(replyRaw?.telegramPollTimeoutSeconds),
    REPLY_TELEGRAM_POLL_TIMEOUT_SECONDS_DEFAULT,
    REPLY_TELEGRAM_POLL_TIMEOUT_SECONDS_MIN,
    REPLY_TELEGRAM_POLL_TIMEOUT_SECONDS_MAX,
  );
  const telegramAllowedUpdates = parseStringList(
    process.env.OMX_REPLY_TELEGRAM_ALLOWED_UPDATES,
    replyRaw?.telegramAllowedUpdates,
  );
  const defaultTelegramAllowedUpdates = hasTelegramProgressCallbackUx(notifConfig)
    ? [...REPLY_TELEGRAM_ALLOWED_UPDATES_DEFAULT, "callback_query"]
    : [...REPLY_TELEGRAM_ALLOWED_UPDATES_DEFAULT];
  const effectiveTelegramAllowedUpdates = telegramAllowedUpdates.length > 0
    ? telegramAllowedUpdates
    : defaultTelegramAllowedUpdates;
  if (
    hasTelegramProgressCallbackUx(notifConfig)
    && !effectiveTelegramAllowedUpdates.includes("callback_query")
  ) {
    effectiveTelegramAllowedUpdates.push("callback_query");
  }
  const telegramVoiceTranscription = normalizeTelegramVoiceTranscriptionConfig(
    replyRaw?.telegramVoiceTranscription,
    process.env,
  );
  if (telegramVoiceTranscription.enabled) {
    for (const warning of telegramVoiceTranscription.warnings ?? []) {
      console.warn(`[notifications] Telegram voice transcription configuration warning: ${warning}`);
    }
  }

  const ackMode = parseReplyAckMode(process.env.OMX_REPLY_ACK_MODE, replyRaw?.ackMode);
  return {
    enabled: true,
    pollIntervalMs,
    maxMessageLength,
    rateLimitPerMinute,
    includePrefix: process.env.OMX_REPLY_INCLUDE_PREFIX !== "false" && (replyRaw?.includePrefix !== false),
    ackMode,
    telegramAckMode: parseTelegramReplyAckMode(
      process.env.OMX_REPLY_TELEGRAM_ACK_MODE,
      replyRaw?.telegramAckMode,
      ackMode,
    ),
    authorizedDiscordUserIds,
    authorizedTelegramUserIds,
    telegramPollTimeoutSeconds,
    telegramAllowedUpdates:
      effectiveTelegramAllowedUpdates,
    telegramStartupBacklogPolicy: parseTelegramStartupBacklogPolicy(
      process.env.OMX_REPLY_TELEGRAM_STARTUP_BACKLOG,
      replyRaw?.telegramStartupBacklogPolicy,
    ),
    telegramVoiceTranscription,
  };
}
