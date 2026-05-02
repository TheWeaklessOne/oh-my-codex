import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { basename } from "node:path";
import type { IncomingMessage } from "node:http";
import { shouldBlockLiveNotificationNetworkInTests } from "../../utils/test-env.js";
import { TelegramBotApiError, type TelegramBotApiRequestDeps } from "../telegram-topics.js";
import type { TelegramLocalFileUpload } from "./types.js";

const TELEGRAM_API_HOST = "api.telegram.org";
const TELEGRAM_MULTIPART_TIMEOUT_MS = 10_000;

interface TelegramApiEnvelope<T> {
  ok?: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

function parseEnvelope<T>(body: string): TelegramApiEnvelope<T> | null {
  if (!body.trim()) return null;
  try {
    return JSON.parse(body) as TelegramApiEnvelope<T>;
  } catch {
    return null;
  }
}

function toTelegramMultipartError(
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

function fieldValueToString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function sanitizeMultipartFilename(filename: string): string {
  const sanitized = filename
    .replace(/[\x00-\x1F\x7F"\\\/]/g, "_")
    .trim();
  return sanitized || "upload.bin";
}

function sanitizeMultipartContentType(contentType: string): string {
  const normalized = contentType.trim();
  return /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u.test(normalized)
    ? normalized
    : "application/octet-stream";
}

function buildFieldPart(boundary: string, name: string, value: unknown): Buffer {
  return Buffer.from([
    `--${boundary}`,
    `Content-Disposition: form-data; name="${name}"`,
    "",
    fieldValueToString(value),
    "",
  ].join("\r\n"), "utf-8");
}

async function buildFilePart(boundary: string, upload: TelegramLocalFileUpload): Promise<Buffer> {
  const file = await readFile(upload.path);
  const filename = sanitizeMultipartFilename(upload.filename || basename(upload.path));
  const contentType = sanitizeMultipartContentType(upload.contentType || "application/octet-stream");
  return Buffer.concat([
    Buffer.from([
      `--${boundary}`,
      `Content-Disposition: form-data; name="${upload.fieldName}"; filename="${filename}"`,
      `Content-Type: ${contentType}`,
      "",
      "",
    ].join("\r\n"), "utf-8"),
    file,
    Buffer.from("\r\n", "utf-8"),
  ]);
}

async function buildMultipartBody(
  fields: Record<string, unknown>,
  upload: TelegramLocalFileUpload,
): Promise<{ boundary: string; body: Buffer }> {
  const boundary = `----omx-telegram-${randomBytes(12).toString("hex")}`;
  const fieldParts = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([name, value]) => buildFieldPart(boundary, name, value));
  const filePart = await buildFilePart(boundary, upload);
  const closing = Buffer.from(`--${boundary}--\r\n`, "utf-8");
  return {
    boundary,
    body: Buffer.concat([...fieldParts, filePart, closing]),
  };
}

export async function performTelegramBotApiMultipartRequest<T>(
  botToken: string,
  methodName: string,
  fields: Record<string, unknown>,
  upload: TelegramLocalFileUpload,
  deps: TelegramBotApiRequestDeps = {},
): Promise<T | undefined> {
  if (shouldBlockLiveNotificationNetworkInTests(process.env, deps.httpsRequestImpl)) {
    throw new Error("Live Telegram Bot API requests are disabled while running tests");
  }

  const { boundary, body } = await buildMultipartBody(fields, upload);
  const httpsRequestImpl = deps.httpsRequestImpl ?? httpsRequest;
  const timeoutMs = deps.timeoutMs ?? TELEGRAM_MULTIPART_TIMEOUT_MS;

  return await new Promise<T | undefined>((resolvePromise, reject) => {
    const req = httpsRequestImpl(
      {
        hostname: TELEGRAM_API_HOST,
        path: `/bot${botToken}/${methodName}`,
        method: "POST",
        family: 4,
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.byteLength,
        },
        timeout: timeoutMs,
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const responseBody = Buffer.concat(chunks).toString("utf-8");
          const envelope = parseEnvelope<T>(responseBody);
          const statusCode = res.statusCode;
          if (statusCode && statusCode >= 200 && statusCode < 300) {
            if (envelope?.ok === false) {
              reject(toTelegramMultipartError(
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
            resolvePromise(envelope?.result);
            return;
          }

          const description = envelope?.description || responseBody.trim() || `HTTP ${statusCode ?? "unknown"}`;
          reject(toTelegramMultipartError(methodName, description, {
            statusCode,
            errorCode: envelope?.error_code,
            description: envelope?.description,
            responseBody,
          }));
        });
      },
    );

    req.on("error", (error) => {
      reject(toTelegramMultipartError(methodName, error instanceof Error ? error.message : String(error)));
    });
    req.on("timeout", () => {
      req.destroy();
      reject(toTelegramMultipartError(methodName, "Request timeout"));
    });

    req.write(body);
    req.end();
  });
}
