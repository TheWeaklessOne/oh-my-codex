import { TelegramBotApiError } from "./telegram-topics.js";

export type TelegramBotApiErrorCategory =
  | "entity-or-rich-payload"
  | "stale-topic"
  | "delivery-topic-mismatch"
  | "retryable-network-or-api"
  | "auth-config-permanent"
  | "unknown";

export interface TelegramBotApiErrorClassification {
  category: TelegramBotApiErrorCategory;
  retryable: boolean;
  permanent: boolean;
  methodName?: string;
  statusCode?: number;
  errorCode?: number;
}

function errorDescription(error: unknown): string {
  if (error instanceof TelegramBotApiError) {
    return `${error.description || ""} ${error.message}`.toLowerCase();
  }
  return error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
}

function isEntityOrRichPayloadFailure(description: string): boolean {
  return (
    /can't\s+parse\s+entities/u.test(description)
    || /cant\s+parse\s+entities/u.test(description)
    || /can't\s+parse\s+message\s+text/u.test(description)
    || /cant\s+parse\s+message\s+text/u.test(description)
    || /can't\s+find\s+end\s+of\s+the\s+entity/u.test(description)
    || /entity\s+(?:start|end|range|length|offset)/u.test(description)
    || /entities\s+(?:are|is|must|can't|cant|invalid)/u.test(description)
    || /unsupported\s+(?:start\s+)?tag/u.test(description)
    || /can't\s+find\s+end\s+tag/u.test(description)
    || /cant\s+find\s+end\s+tag/u.test(description)
    || /bad request:\s*entity\b/u.test(description)
  );
}

function isStaleTopicFailure(description: string): boolean {
  return (
    (description.includes("topic") && description.includes("not found"))
    || (description.includes("thread") && description.includes("not found"))
  );
}

function isDeliveryTopicMismatchFailure(description: string): boolean {
  return (
    description.includes("not a forum topic message")
    || (description.includes("topic") && description.includes("mismatch"))
    || (description.includes("thread") && description.includes("mismatch"))
  );
}

function isAuthOrConfigFailure(error: TelegramBotApiError, description: string): boolean {
  return (
    error.statusCode === 401
    || error.statusCode === 403
    || error.errorCode === 401
    || error.errorCode === 403
    || description.includes("unauthorized")
    || description.includes("forbidden")
    || description.includes("bot token")
  );
}

function isRetryableFailure(error: TelegramBotApiError, description: string): boolean {
  return (
    error.statusCode === undefined
    || error.statusCode >= 500
    || error.errorCode === 429
    || error.statusCode === 429
    || description.includes("too many requests")
    || description.includes("timeout")
    || description.includes("econnreset")
    || description.includes("enotfound")
    || description.includes("network")
  );
}

export function classifyTelegramBotApiError(
  error: unknown,
): TelegramBotApiErrorClassification {
  if (!(error instanceof TelegramBotApiError)) {
    return {
      category: error instanceof Error ? "retryable-network-or-api" : "unknown",
      retryable: error instanceof Error,
      permanent: false,
    };
  }

  const description = errorDescription(error);
  const base = {
    methodName: error.methodName,
    statusCode: error.statusCode,
    errorCode: error.errorCode,
  };

  if (isEntityOrRichPayloadFailure(description)) {
    return {
      ...base,
      category: "entity-or-rich-payload",
      retryable: false,
      permanent: false,
    };
  }

  if (isDeliveryTopicMismatchFailure(description)) {
    return {
      ...base,
      category: "delivery-topic-mismatch",
      retryable: true,
      permanent: false,
    };
  }

  if (isStaleTopicFailure(description)) {
    return {
      ...base,
      category: "stale-topic",
      retryable: true,
      permanent: false,
    };
  }

  if (isAuthOrConfigFailure(error, description)) {
    return {
      ...base,
      category: "auth-config-permanent",
      retryable: false,
      permanent: true,
    };
  }

  if (isRetryableFailure(error, description)) {
    return {
      ...base,
      category: "retryable-network-or-api",
      retryable: true,
      permanent: false,
    };
  }

  return {
    ...base,
    category: "unknown",
    retryable: false,
    permanent: false,
  };
}

export function isTelegramRichPayloadError(error: unknown): boolean {
  const classification = classifyTelegramBotApiError(error);
  return classification.methodName === "sendMessage"
    && classification.category === "entity-or-rich-payload";
}

export function isTelegramStaleTopicError(error: unknown): boolean {
  const classification = classifyTelegramBotApiError(error);
  return classification.methodName === "sendMessage"
    && classification.category === "stale-topic";
}

export function isTelegramDeliveryTopicMismatchError(error: unknown): boolean {
  const classification = classifyTelegramBotApiError(error);
  return classification.methodName === "sendMessage"
    && classification.category === "delivery-topic-mismatch";
}
