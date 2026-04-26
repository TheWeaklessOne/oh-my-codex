import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeTelegramUpdate } from '../telegram-inbound/parse.js';
import {
  TELEGRAM_ATTACHMENT_DIR_ENV,
  TELEGRAM_ATTACHMENT_DIR_MODE,
  TELEGRAM_ATTACHMENT_FILE_MODE,
  saveTelegramMedia,
} from '../telegram-inbound/storage.js';

let cleanupRoots: string[] = [];

afterEach(async () => {
  for (const root of cleanupRoots) {
    await rm(root, { recursive: true, force: true });
  }
  cleanupRoots = [];
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'omx-telegram-storage-'));
  cleanupRoots.push(root);
  return root;
}

function buildMessage() {
  const message = normalizeTelegramUpdate({
    message: {
      message_id: 333,
      message_thread_id: 9001,
      media_group_id: 'album-1',
      chat: { id: 777 },
      from: { id: 'telegram-user-1' },
      caption: 'caption',
      photo: [{ file_id: 'photo-id', file_unique_id: 'photo-u', width: 100, height: 200, file_size: 5 }],
      reply_to_message: { message_id: 222 },
    },
  });
  assert.ok(message);
  return message;
}

describe('telegram inbound storage', () => {
  it('writes a deterministic file path under the configured attachment root', async () => {
    const root = await makeRoot();
    const message = buildMessage();
    const saved = await saveTelegramMedia({
      rootDir: root,
      sourceKey: 'telegram:123456/777',
      message,
      part: message.mediaParts[0]!,
      bytes: Buffer.from('image-bytes'),
      telegramFilePath: 'photos/file_1.jpg',
      createdAt: new Date('2026-04-27T01:02:03.000Z'),
    });

    const expectedPath = join(root, 'telegram-123456-777', '2026-04-27', '777-333-1-photo.jpg');
    assert.equal(saved.path, expectedPath);
    assert.equal(await readFile(expectedPath, 'utf-8'), 'image-bytes');
    assert.equal(saved.metadataPath, `${expectedPath}.metadata.json`);
  });

  it('writes sidecar metadata without bot tokens or Telegram file_id values', async () => {
    const root = await makeRoot();
    const message = buildMessage();
    const saved = await saveTelegramMedia({
      rootDir: root,
      sourceKey: 'telegram-123456-777',
      message,
      part: message.mediaParts[0]!,
      bytes: Buffer.from('image-bytes'),
      telegramFilePath: 'photos/file_1.jpg',
      createdAt: new Date('2026-04-27T01:02:03.000Z'),
    });

    const metadata = JSON.parse(await readFile(saved.metadataPath, 'utf-8')) as Record<string, unknown>;
    assert.equal(metadata.createdAt, '2026-04-27T01:02:03.000Z');
    assert.equal(metadata.sourceKey, 'telegram-123456-777');
    assert.equal(metadata.messageId, 333);
    assert.equal(metadata.messageThreadId, 9001);
    assert.equal(metadata.chatId, 777);
    assert.equal(metadata.replyToMessageId, 222);
    assert.equal(metadata.kind, 'photo');
    assert.equal(metadata.telegramFileUniqueId, 'photo-u');
    assert.equal(metadata.telegramFilePath, 'photos/file_1.jpg');
    assert.equal(metadata.savedPath, saved.path);
    assert.equal(JSON.stringify(metadata).includes('photo-id'), false);
    assert.equal(JSON.stringify(metadata).includes('123456:telegram-token'), false);
  });

  it('uses restrictive modes where the platform supports POSIX permissions', async () => {
    if (process.platform === 'win32') return;
    const root = await makeRoot();
    const message = buildMessage();
    const saved = await saveTelegramMedia({
      rootDir: root,
      sourceKey: 'telegram-123456-777',
      message,
      part: message.mediaParts[0]!,
      bytes: Buffer.from('image-bytes'),
      createdAt: new Date('2026-04-27T01:02:03.000Z'),
    });

    const fileMode = (await stat(saved.path)).mode & 0o777;
    const dirMode = (await stat(join(root, 'telegram-123456-777', '2026-04-27'))).mode & 0o777;
    assert.equal(fileMode, TELEGRAM_ATTACHMENT_FILE_MODE);
    assert.equal(dirMode, TELEGRAM_ATTACHMENT_DIR_MODE);
  });

  it('does not write outside the attachment root after malicious source and filename input', async () => {
    const root = await makeRoot();
    const message = normalizeTelegramUpdate({
      message: {
        message_id: '../../333',
        chat: { id: '../777' },
        document: {
          file_id: 'document-id',
          file_name: '../../escape.png',
          mime_type: 'image/png',
        },
      },
    });
    assert.ok(message);

    const saved = await saveTelegramMedia({
      rootDir: root,
      sourceKey: '../telegram/source',
      message,
      part: message.mediaParts[0]!,
      bytes: Buffer.from('bytes'),
      createdAt: new Date('2026-04-27T01:02:03.000Z'),
    });

    const normalizedRoot = `${resolve(root)}${sep}`;
    assert.equal(saved.path.startsWith(normalizedRoot), true);
    assert.equal(saved.path.includes('escape'), false);
    assert.equal(await readFile(saved.path, 'utf-8'), 'bytes');
  });

  it('can use the environment-provided attachment root', async () => {
    const root = await makeRoot();
    const previous = process.env[TELEGRAM_ATTACHMENT_DIR_ENV];
    process.env[TELEGRAM_ATTACHMENT_DIR_ENV] = root;
    try {
      const message = buildMessage();
      const saved = await saveTelegramMedia({
        sourceKey: 'telegram-123456-777',
        message,
        part: message.mediaParts[0]!,
        bytes: Buffer.from('bytes'),
        createdAt: new Date('2026-04-27T01:02:03.000Z'),
      });
      assert.equal(saved.path.startsWith(root), true);
    } finally {
      if (previous === undefined) delete process.env[TELEGRAM_ATTACHMENT_DIR_ENV];
      else process.env[TELEGRAM_ATTACHMENT_DIR_ENV] = previous;
    }
  });
});
