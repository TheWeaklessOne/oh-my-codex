import { request as defaultHttpsRequest } from 'https';
import { shouldBlockLiveNotificationNetworkInTests } from '../../utils/test-env.js';
import type { TelegramDownloadedFile, TelegramFileInfo, TelegramHttpsRequest } from './types.js';

export const TELEGRAM_BOT_API_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

interface TelegramFileRequestOptions {
  botToken: string;
  httpsRequestImpl?: TelegramHttpsRequest;
  timeoutMs?: number;
}

export interface GetTelegramFileInfoOptions extends TelegramFileRequestOptions {
  fileId: string;
}

export interface DownloadTelegramFileOptions extends TelegramFileRequestOptions {
  filePath: string;
  expectedFileSize?: number;
  maxBytes?: number;
}

export interface FetchTelegramFileOptions extends TelegramFileRequestOptions {
  fileId: string;
  maxBytes?: number;
}

function normalizeTelegramFileSize(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

export function validateTelegramFilePath(filePath: string): string {
  const trimmed = filePath.trim();
  if (!trimmed || trimmed.startsWith('/') || trimmed.startsWith('\\') || trimmed.includes('\\')) {
    throw new Error('Telegram returned an unsafe file path');
  }
  const segments = trimmed.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('Telegram returned an unsafe file path');
  }
  return trimmed;
}

export function encodeTelegramFileDownloadPath(filePath: string): string {
  return validateTelegramFilePath(filePath)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function resolveTelegramHttpsRequest(options: TelegramFileRequestOptions): TelegramHttpsRequest {
  const httpsRequestImpl = options.httpsRequestImpl ?? defaultHttpsRequest;
  if (shouldBlockLiveNotificationNetworkInTests(process.env, httpsRequestImpl)) {
    throw new Error('Live Telegram network requests are disabled in tests');
  }
  return httpsRequestImpl;
}

export async function getTelegramFileInfo(options: GetTelegramFileInfoOptions): Promise<TelegramFileInfo> {
  const httpsRequestImpl = resolveTelegramHttpsRequest(options);
  const params = new URLSearchParams();
  params.set('file_id', options.fileId);

  return await new Promise<TelegramFileInfo>((resolve, reject) => {
    const req = httpsRequestImpl(
      {
        hostname: 'api.telegram.org',
        path: `/bot${options.botToken}/getFile?${params.toString()}`,
        method: 'GET',
        family: 4,
        timeout: options.timeoutMs ?? 5_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          try {
            const responseText = Buffer.concat(chunks).toString('utf-8');
            let body: {
              ok?: unknown;
              description?: unknown;
              result?: {
                file_path?: unknown;
                file_size?: unknown;
              };
            } = {};
            if (responseText.trim()) {
              try {
                body = JSON.parse(responseText) as typeof body;
              } catch (error) {
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                  throw error;
                }
              }
            }
            if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
              if (body.ok === false && typeof body.description === 'string') {
                reject(new Error(body.description));
                return;
              }
              reject(new Error(`HTTP ${res.statusCode ?? 'unknown'}`));
              return;
            }
            if (body.ok === false) {
              reject(new Error(typeof body.description === 'string' ? body.description : 'Telegram Bot API returned ok=false'));
              return;
            }
            if (typeof body.result?.file_path !== 'string' || body.result.file_path.trim() === '') {
              reject(new Error('Telegram getFile did not return file_path'));
              return;
            }
            resolve({
              filePath: validateTelegramFilePath(body.result.file_path),
              ...(normalizeTelegramFileSize(body.result.file_size) !== undefined
                ? { fileSize: normalizeTelegramFileSize(body.result.file_size) }
                : {}),
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.end();
  });
}

export async function downloadTelegramFile(options: DownloadTelegramFileOptions): Promise<Buffer> {
  const httpsRequestImpl = resolveTelegramHttpsRequest(options);
  const maxBytes = options.maxBytes ?? TELEGRAM_BOT_API_MAX_DOWNLOAD_BYTES;
  if (options.expectedFileSize !== undefined && options.expectedFileSize > maxBytes) {
    throw new Error('Telegram attachment exceeds the 20 MB download limit');
  }
  const encodedPath = encodeTelegramFileDownloadPath(options.filePath);

  return await new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const req = httpsRequestImpl(
      {
        hostname: 'api.telegram.org',
        path: `/file/bot${options.botToken}/${encodedPath}`,
        method: 'GET',
        family: 4,
        timeout: options.timeoutMs ?? 15_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        res.on('data', (chunk: Buffer) => {
          if (settled) return;
          totalBytes += chunk.length;
          if (totalBytes > maxBytes) {
            req.destroy();
            fail(new Error('Telegram attachment exceeds the 20 MB download limit'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (settled) return;
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            settled = true;
            resolve(Buffer.concat(chunks));
            return;
          }
          fail(new Error(`HTTP ${res.statusCode ?? 'unknown'}`));
        });
      },
    );

    req.on('error', (error) => fail(error instanceof Error ? error : new Error(String(error))));
    req.on('timeout', () => {
      req.destroy();
      fail(new Error('Request timeout'));
    });
    req.end();
  });
}

export async function fetchTelegramFile(options: FetchTelegramFileOptions): Promise<TelegramDownloadedFile> {
  const fileInfo = await getTelegramFileInfo(options);
  const bytes = await downloadTelegramFile({
    ...options,
    filePath: fileInfo.filePath,
    expectedFileSize: fileInfo.fileSize,
  });
  return { fileInfo, bytes };
}
