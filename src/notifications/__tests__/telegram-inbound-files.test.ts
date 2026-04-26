import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ClientRequestArgs, IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import {
  downloadTelegramFile,
  fetchTelegramFile,
  getTelegramFileInfo,
  validateTelegramFilePath,
} from '../telegram-inbound/files.js';
import type { TelegramHttpsRequest } from '../telegram-inbound/types.js';
import { markMockTelegramTransportForTests } from '../../utils/test-env.js';

type HttpsRouteResult = {
  statusCode: number;
  body?: unknown;
  timeout?: boolean;
};

type HttpsRouteHandler = (body: string, options: ClientRequestArgs) => HttpsRouteResult;

function createHttpsRequestMock(routes: Record<string, HttpsRouteHandler>): TelegramHttpsRequest {
  return markMockTelegramTransportForTests(((options: ClientRequestArgs, callback?: (res: IncomingMessage) => void) => {
    const listeners = new Map<string, Array<(value?: unknown) => void>>();
    let requestBody = '';

    const emit = (event: string, value?: unknown) => {
      for (const handler of listeners.get(event) ?? []) {
        handler(value);
      }
    };

    const request = {
      on(event: string, handler: (value?: unknown) => void) {
        listeners.set(event, [...(listeners.get(event) ?? []), handler]);
        return request;
      },
      write(chunk: string | Buffer) {
        requestBody += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : chunk;
        return true;
      },
      end() {
        queueMicrotask(() => {
          try {
            const key = `${options.method ?? 'GET'} ${options.path ?? ''}`;
            const route = routes[key];
            assert.ok(route, `Unexpected https request: ${key}`);
            const result = route(requestBody, options);
            if (result.timeout) {
              emit('timeout');
              return;
            }
            const response = new PassThrough() as PassThrough & IncomingMessage;
            (response as { statusCode?: number }).statusCode = result.statusCode;
            callback?.(response);
            if (result.body !== undefined) {
              response.write(
                Buffer.isBuffer(result.body) || typeof result.body === 'string'
                  ? result.body
                  : JSON.stringify(result.body),
              );
            }
            response.end();
          } catch (error) {
            emit('error', error);
          }
        });
        return request;
      },
      destroy() {
        return request;
      },
    };

    return request;
  }) as TelegramHttpsRequest);
}

describe('telegram inbound file service', () => {
  it('calls getFile with an encoded file_id and downloads an encoded Telegram file path', async () => {
    const transport = createHttpsRequestMock({
      'GET /bottoken/getFile?file_id=file+id%2F%2B': () => ({
        statusCode: 200,
        body: { ok: true, result: { file_path: 'photos/file 1.jpg', file_size: 11 } },
      }),
      'GET /file/bottoken/photos/file%201.jpg': () => ({
        statusCode: 200,
        body: Buffer.from('hello world'),
      }),
    });

    const downloaded = await fetchTelegramFile({
      botToken: 'token',
      fileId: 'file id/+',
      httpsRequestImpl: transport,
    });

    assert.equal(downloaded.fileInfo.filePath, 'photos/file 1.jpg');
    assert.equal(downloaded.fileInfo.fileSize, 11);
    assert.equal(downloaded.bytes.toString('utf-8'), 'hello world');
  });

  it('blocks unmarked Telegram transports when live notification network is disabled in tests', async () => {
    const previous = process.env.OMX_TEST_DISABLE_LIVE_NOTIFICATIONS;
    process.env.OMX_TEST_DISABLE_LIVE_NOTIFICATIONS = '1';
    const unmarkedTransport = (() => {
      throw new Error('unmarked transport should not be called');
    }) as TelegramHttpsRequest;

    try {
      await assert.rejects(
        getTelegramFileInfo({
          botToken: 'token',
          fileId: 'file-id',
          httpsRequestImpl: unmarkedTransport,
        }),
        /Live Telegram network requests are disabled in tests/,
      );
    } finally {
      if (previous === undefined) {
        delete process.env.OMX_TEST_DISABLE_LIVE_NOTIFICATIONS;
      } else {
        process.env.OMX_TEST_DISABLE_LIVE_NOTIFICATIONS = previous;
      }
    }
  });

  it('surfaces Telegram ok=false and non-2xx getFile responses', async () => {
    await assert.rejects(
      getTelegramFileInfo({
        botToken: 'token',
        fileId: 'bad',
        httpsRequestImpl: createHttpsRequestMock({
          'GET /bottoken/getFile?file_id=bad': () => ({
            statusCode: 200,
            body: { ok: false, description: 'file not found' },
          }),
        }),
      }),
      /file not found/,
    );

    await assert.rejects(
      getTelegramFileInfo({
        botToken: 'token',
        fileId: 'bad-http',
        httpsRequestImpl: createHttpsRequestMock({
          'GET /bottoken/getFile?file_id=bad-http': () => ({ statusCode: 500, body: { ok: true } }),
        }),
      }),
      /HTTP 500/,
    );
  });

  it('rejects unsafe Telegram file paths', () => {
    assert.throws(() => validateTelegramFilePath('/absolute/file.jpg'), /unsafe file path/);
    assert.throws(() => validateTelegramFilePath('../escape/file.jpg'), /unsafe file path/);
    assert.throws(() => validateTelegramFilePath('safe/../escape.jpg'), /unsafe file path/);
    assert.throws(() => validateTelegramFilePath('safe\\escape.jpg'), /unsafe file path/);
  });

  it('rejects non-2xx download responses', async () => {
    await assert.rejects(
      downloadTelegramFile({
        botToken: 'token',
        filePath: 'photos/file.jpg',
        httpsRequestImpl: createHttpsRequestMock({
          'GET /file/bottoken/photos/file.jpg': () => ({ statusCode: 404, body: 'missing' }),
        }),
      }),
      /HTTP 404/,
    );
  });

  it('enforces max bytes before and during download', async () => {
    await assert.rejects(
      downloadTelegramFile({
        botToken: 'token',
        filePath: 'photos/file.jpg',
        expectedFileSize: 6,
        maxBytes: 5,
        httpsRequestImpl: createHttpsRequestMock({}),
      }),
      /20 MB download limit/,
    );

    await assert.rejects(
      downloadTelegramFile({
        botToken: 'token',
        filePath: 'photos/file.jpg',
        maxBytes: 5,
        httpsRequestImpl: createHttpsRequestMock({
          'GET /file/bottoken/photos/file.jpg': () => ({ statusCode: 200, body: Buffer.from('123456') }),
        }),
      }),
      /20 MB download limit/,
    );
  });

  it('times out with a typed request failure', async () => {
    await assert.rejects(
      getTelegramFileInfo({
        botToken: 'token',
        fileId: 'slow',
        timeoutMs: 1,
        httpsRequestImpl: createHttpsRequestMock({
          'GET /bottoken/getFile?file_id=slow': () => ({ statusCode: 200, timeout: true }),
        }),
      }),
      /Request timeout/,
    );
  });
});
