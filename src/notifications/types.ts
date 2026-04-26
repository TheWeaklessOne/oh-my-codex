/**
 * Notification System Types
 *
 * Defines types for the multi-platform notification system.
 * Supports Discord, Telegram, Slack, and generic webhooks across
 * lifecycle events plus semantic turn-complete events.
 */

/** Events that can trigger notifications */
export type NotificationEvent =
  | "session-start"
  | "session-stop"
  | "session-end"
  | "session-idle"
  | "ask-user-question"
  | "result-ready";

/**
 * Verbosity levels for notification filtering.
 *
 * - verbose: all text/tool call output
 * - agent:   per-agent-call events (includes ask-user-question)
 * - session: session lifecycle + meaningful turn-complete notifications [DEFAULT]
 * - minimal: start/stop/end only, no idle, no tmux tail
 */
export type VerbosityLevel = "verbose" | "agent" | "session" | "minimal";

/** Supported notification platforms */
export type NotificationPlatform =
  | "discord"
  | "discord-bot"
  | "telegram"
  | "slack"
  | "webhook";

export type CompletedTurnRenderMode =
  | "formatted-notification"
  | "raw-assistant-text";

export type TelegramCompletedTurnFormat = "literal" | "entities";

export interface CompletedTurnPlatformPresentationConfig {
  resultReadyMode?: CompletedTurnRenderMode;
  askUserQuestionMode?: CompletedTurnRenderMode;
  /** Telegram-only rendering for raw assistant completed-turn text. */
  telegramFormat?: TelegramCompletedTurnFormat;
}

export interface CompletedTurnPresentationConfig {
  resultReadyMode: CompletedTurnRenderMode;
  askUserQuestionMode: CompletedTurnRenderMode;
  platformOverrides?: Partial<
    Record<NotificationPlatform, CompletedTurnPlatformPresentationConfig>
  >;
}

/** Discord webhook configuration */
export interface DiscordNotificationConfig {
  enabled: boolean;
  /** Discord webhook URL */
  webhookUrl: string;
  /** Optional username override for the webhook bot */
  username?: string;
  /** Optional mention to prepend to messages (e.g. "<@123456>" for user, "<@&789>" for role) */
  mention?: string;
}

/** Discord Bot API configuration (bot token + channel ID) */
export interface DiscordBotNotificationConfig {
  enabled: boolean;
  /** Discord bot token (or env var: OMX_DISCORD_NOTIFIER_BOT_TOKEN) */
  botToken?: string;
  /** Channel ID to send messages to (or env var: OMX_DISCORD_NOTIFIER_CHANNEL) */
  channelId?: string;
  /** Optional mention to prepend to messages (e.g. "<@123456>" for user, "<@&789>" for role) */
  mention?: string;
}

/** Telegram platform configuration */
export type TelegramProjectTopicNaming = "projectName" | "projectNameWithHash";

export interface TelegramProjectTopicsConfig {
  enabled: boolean;
  /** Automatically create missing forum topics on first send (default: true) */
  autoCreate?: boolean;
  /** Fall back to the root/general chat when topic routing is unavailable (default: true) */
  fallbackToGeneral?: boolean;
  /** Visible topic naming policy (default: projectName) */
  naming?: TelegramProjectTopicNaming;
  /** Optional Bot API forum topic icon color */
  iconColor?: number;
  /** Cooldown before retrying a failed topic creation (default: 300000 / 5 min) */
  createFailureCooldownMs?: number;
}

export interface TelegramNotificationConfig {
  enabled: boolean;
  /** Telegram bot token */
  botToken: string;
  /** Chat ID to send messages to */
  chatId: string;
  /** Parse mode: Markdown or HTML (default: Markdown) */
  parseMode?: "Markdown" | "HTML";
  /** Optional per-project Telegram topic routing policy */
  projectTopics?: TelegramProjectTopicsConfig;
}

export interface TelegramAcceptedAckCleanupTarget {
  chatId: string;
  messageId: string;
  messageThreadId?: string;
}

/** Slack platform configuration */
export interface SlackNotificationConfig {
  enabled: boolean;
  /** Slack incoming webhook URL */
  webhookUrl: string;
  /** Optional channel override */
  channel?: string;
  /** Optional username override */
  username?: string;
  /** Optional mention to prepend to messages (e.g. "<!here>", "<@UXXXXXXXX>") */
  mention?: string;
}

/** Generic webhook configuration */
export interface WebhookNotificationConfig {
  enabled: boolean;
  /** Webhook URL (POST with JSON body) */
  url: string;
  /** Optional custom headers */
  headers?: Record<string, string>;
  /** Optional HTTP method override (default: POST) */
  method?: "POST" | "PUT";
}

/** Generic custom webhook command config (normalized to OpenClaw gateway at runtime) */
export interface CustomWebhookCommandConfig {
  enabled?: boolean;
  url: string;
  headers?: Record<string, string>;
  method?: "POST" | "PUT";
  timeout?: number;
}

/** Generic custom CLI command config (normalized to OpenClaw gateway at runtime) */
export interface CustomCliCommandConfig {
  enabled?: boolean;
  command: string;
  timeout?: number;
}

/** Platform config union */
export type PlatformConfig =
  | DiscordNotificationConfig
  | DiscordBotNotificationConfig
  | TelegramNotificationConfig
  | SlackNotificationConfig
  | WebhookNotificationConfig;

/** Per-event notification configuration */
export interface EventNotificationConfig {
  /** Whether this event triggers notifications */
  enabled: boolean;
  /** Custom message template (optional, uses default if not set) */
  messageTemplate?: string;
  /** Platform overrides for this event (inherits from top-level if not set) */
  discord?: DiscordNotificationConfig;
  "discord-bot"?: DiscordBotNotificationConfig;
  telegram?: TelegramNotificationConfig;
  slack?: SlackNotificationConfig;
  webhook?: WebhookNotificationConfig;
}

/** Top-level notification configuration (stored in .omx-config.json) */
export interface FullNotificationConfig {
  /** Global enable/disable for all notifications */
  enabled: boolean;

  /** Notification verbosity level (default: "session") */
  verbosity?: VerbosityLevel;

  /** Default platform configs (used when event-specific config is not set) */
  discord?: DiscordNotificationConfig;
  "discord-bot"?: DiscordBotNotificationConfig;
  telegram?: TelegramNotificationConfig;
  slack?: SlackNotificationConfig;
  webhook?: WebhookNotificationConfig;

  /** OpenClaw gateway (enabled flag only — full config lives in openclaw subsystem) */
  openclaw?: { enabled: boolean };
  /** Generic custom webhook transport alias (OpenClaw-compatible bridge) */
  custom_webhook_command?: CustomWebhookCommandConfig;
  /** Generic custom CLI transport alias (OpenClaw-compatible bridge) */
  custom_cli_command?: CustomCliCommandConfig;

  /** Completed-turn rendering policy for result/question notifications */
  completedTurn?: CompletedTurnPresentationConfig;

  /** Per-event configuration */
  events?: Partial<Record<NotificationEvent, EventNotificationConfig>>;
}

export type TelegramMessageEntityType =
  | "bold"
  | "italic"
  | "underline"
  | "strikethrough"
  | "spoiler"
  | "blockquote"
  | "expandable_blockquote"
  | "code"
  | "pre"
  | "text_link";

export interface TelegramMessageEntity {
  type: TelegramMessageEntityType;
  /** UTF-16 code-unit offset, as required by Telegram Bot API. */
  offset: number;
  /** UTF-16 code-unit length, as required by Telegram Bot API. */
  length: number;
  /** Required only for text_link entities. */
  url?: string;
  /** Optional, sanitized language token for pre entities. */
  language?: string;
}

export type TelegramRenderWarningCode =
  | "unsafe-url-dropped"
  | "sensitive-url-dropped"
  | "local-url-dropped"
  | "entity-invalid-range-dropped"
  | "entity-trimmed"
  | "entity-empty-after-trim-dropped"
  | "partial-overlap-dropped"
  | "nested-blockquote-dropped"
  | "code-formatting-dropped"
  | "pre-language-sanitized"
  | "unsupported-node-degraded"
  | "raw-html-degraded"
  | "image-degraded"
  | "markdown-render-fallback"
  | "table-rendered-as-cards"
  | "message-truncated";

export interface TelegramRenderWarning {
  code: TelegramRenderWarningCode;
  message: string;
  source: "renderer" | "normalizer" | "chunker";
  entityType?: TelegramMessageEntityType;
  nodeType?: string;
  reason?: string;
  /** Redacted diagnostic value safe for debug logging. */
  value?: string;
}

export interface TelegramRenderedMessage {
  text: string;
  entities: TelegramMessageEntity[];
  warnings: string[];
  structuredWarnings?: TelegramRenderWarning[];
}

export interface NotificationTransportOverride {
  /** Per-platform message override when a planner wants custom rendering */
  message?: string;
  /** Transport-specific parse mode override; null disables parse_mode entirely */
  parseMode?: "Markdown" | "HTML" | null;
  /** Telegram Bot API message entities; when present Telegram sends omit parse_mode. */
  entities?: TelegramMessageEntity[];
}

export type NotificationTransportOverrides = Partial<
  Record<NotificationPlatform, NotificationTransportOverride>
>;

/** Payload sent with each notification */
export interface FullNotificationPayload {
  /** The event that triggered this notification */
  event: NotificationEvent;
  /** Session identifier */
  sessionId: string;
  /** Pre-formatted message text */
  message: string;
  /** ISO timestamp */
  timestamp: string;
  /** Current tmux session name (if in tmux) */
  tmuxSession?: string;
  /** Project directory path */
  projectPath?: string;
  /** Basename of the project directory */
  projectName?: string;
  /** Active OMX modes during this session */
  modesUsed?: string[];
  /** Context summary of what was done */
  contextSummary?: string;
  /** Session duration in milliseconds */
  durationMs?: number;
  /** Number of agents spawned */
  agentsSpawned?: number;
  /** Number of agents completed */
  agentsCompleted?: number;
  /** Stop/end reason */
  reason?: string;
  /** Active mode name (for stop events) */
  activeMode?: string;
  /** Current iteration (for stop events) */
  iteration?: number;
  /** Max iterations (for stop events) */
  maxIterations?: number;
  /** Question text (for ask-user-question events) */
  question?: string;
  /** Incomplete task count */
  incompleteTasks?: number;
  /** tmux pane ID for reply injection target */
  tmuxPaneId?: string;
  /** Captured tmux pane output (tail lines) for session-level notifications */
  tmuxTail?: string;
  /** Whether the tmux tail came from a session/pane proven live at capture time */
  tmuxTailLive?: boolean;
  /** Generic per-platform rendering overrides */
  transportOverrides?: NotificationTransportOverrides;
  /** Accepted Telegram reply placeholder to delete after a successful fresh final sendMessage. */
  telegramAcceptedAck?: TelegramAcceptedAckCleanupTarget;
  /** Agent name (populated by extensibility plugins, not set by core Codex CLI hooks) */
  agentName?: string;
  /** Agent type (populated by extensibility plugins, not set by core Codex CLI hooks) */
  agentType?: string;
}

/** Result of a notification send attempt */
export interface NotificationResult {
  platform: NotificationPlatform;
  success: boolean;
  error?: string;
  messageId?: string;
  /** All message IDs produced by transports that split one notification. */
  messageIds?: string[];
  messageThreadId?: string;
  projectKey?: string;
  topicName?: string;
}

/** Result of dispatching notifications for an event */
export interface DispatchResult {
  event: NotificationEvent;
  results: NotificationResult[];
  /** Whether at least one notification was sent successfully */
  anySuccess: boolean;
}

/** Named notification profiles configuration */
export interface NotificationProfilesConfig {
  /** Global enable/disable for all notifications */
  enabled: boolean;

  /** Default profile name when none specified */
  defaultProfile?: string;

  /** Named profiles, each a full notification config */
  profiles: Record<string, FullNotificationConfig>;
}

/** Top-level notifications block (supports both flat and profiled config) */
export interface NotificationsBlock extends FullNotificationConfig {
  /** Default profile name (used when profiles are defined) */
  defaultProfile?: string;

  /** Named notification profiles */
  profiles?: Record<string, FullNotificationConfig>;
}

/** Reply injection configuration */
export type ReplyAcknowledgementMode = "off" | "minimal" | "summary";
export type TelegramReplyAcknowledgementMode =
  | ReplyAcknowledgementMode
  | "accepted"
  | "accepted-final-message";
export type TelegramStartupBacklogPolicy = "resume" | "drop_pending" | "replay_once";

export interface ReplyConfig {
  enabled: boolean;
  /** Polling interval in milliseconds (default: 3000) */
  pollIntervalMs: number;
  /** Maximum message length (default: 500) */
  maxMessageLength: number;
  /** Rate limit: max messages per minute (default: 10) */
  rateLimitPerMinute: number;
  /** Include visual prefix like [reply:discord] (default: true) */
  includePrefix: boolean;
  /** Reply acknowledgement verbosity (default: minimal) */
  ackMode: ReplyAcknowledgementMode;
  /** Telegram-specific acknowledgement UX (default: ackMode) */
  telegramAckMode?: TelegramReplyAcknowledgementMode;
  /** Authorized Discord user IDs (REQUIRED for Discord, empty = Discord disabled) */
  authorizedDiscordUserIds: string[];
  /** Authorized Telegram sender IDs (empty = fallback to chat-level auth only) */
  authorizedTelegramUserIds: string[];
  /** Telegram long-poll timeout in seconds (default: 30) */
  telegramPollTimeoutSeconds: number;
  /** Allowed Telegram update types for reply intake (default: ['message']) */
  telegramAllowedUpdates: string[];
  /** Startup backlog handling policy for Telegram intake (default: resume) */
  telegramStartupBacklogPolicy: TelegramStartupBacklogPolicy;
}
