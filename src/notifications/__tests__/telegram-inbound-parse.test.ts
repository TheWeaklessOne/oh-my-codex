import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getTelegramInboundText,
  hasTelegramInboundContent,
  normalizeTelegramCallbackQuery,
  normalizeTelegramUpdate,
  selectBestTelegramPhotoVariant,
} from '../telegram-inbound/parse.js';

const baseMessage = {
  message_id: 10,
  message_thread_id: 9001,
  media_group_id: 'album-1',
  chat: { id: 777, type: 'supergroup' },
  from: { id: 'telegram-user-1' },
  reply_to_message: { message_id: 222, message_thread_id: 9001 },
};

describe('telegram inbound parser', () => {
  it('normalizes text-only messages and reply/thread identifiers', () => {
    const message = normalizeTelegramUpdate({
      update_id: 44,
      message: { ...baseMessage, text: 'continue' },
    });

    assert.ok(message);
    assert.equal(message.updateId, 44);
    assert.equal(message.messageId, 10);
    assert.equal(message.messageThreadId, 9001);
    assert.equal(message.chatId, 777);
    assert.equal(message.chatType, 'supergroup');
    assert.equal(message.senderId, 'telegram-user-1');
    assert.equal(message.replyToMessageId, 222);
    assert.equal(message.replyToThreadId, 9001);
    assert.equal(message.mediaGroupId, 'album-1');
    assert.equal(message.textPart?.source, 'text');
    assert.equal(getTelegramInboundText(message), 'continue');
    assert.equal(hasTelegramInboundContent(message), true);
    assert.deepEqual(message.mediaParts, []);
  });

  it('normalizes caption-only media text', () => {
    const message = normalizeTelegramUpdate({
      message: { ...baseMessage, caption: 'caption text' },
    });

    assert.equal(message?.textPart?.source, 'caption');
    assert.equal(getTelegramInboundText(message), 'caption text');
  });

  it('selects the best photo variant by file size, then dimensions, then file id', () => {
    assert.equal(selectBestTelegramPhotoVariant([
      { file_id: 'small', width: 100, height: 100, file_size: 10 },
      { file_id: 'large', width: 10, height: 10, file_size: 20 },
    ])?.file_id, 'large');

    assert.equal(selectBestTelegramPhotoVariant([
      { file_id: 'wide', width: 200, height: 200 },
      { file_id: 'tiny', width: 10, height: 10 },
    ])?.file_id, 'wide');

    assert.equal(selectBestTelegramPhotoVariant([
      { file_id: 'a', width: 10, height: 10, file_size: 1 },
      { file_id: 'b', width: 10, height: 10, file_size: 1 },
    ])?.file_id, 'b');
  });

  it('extracts photo, document, audio, and voice metadata in deterministic part order', () => {
    const message = normalizeTelegramUpdate({
      message: {
        ...baseMessage,
        caption: 'mixed media',
        photo: [
          { file_id: 'photo-small', width: 10, height: 10, file_size: 1 },
          { file_id: 'photo-large', file_unique_id: 'photo-u', width: 100, height: 100, file_size: 2 },
        ],
        document: {
          file_id: 'document-id',
          file_unique_id: 'document-u',
          file_name: 'screenshot.png',
          mime_type: 'image/png',
          file_size: 11,
        },
        audio: {
          file_id: 'audio-id',
          file_unique_id: 'audio-u',
          duration: 120,
          performer: 'Performer',
          title: 'Title',
          file_name: 'song.mp3',
          mime_type: 'audio/mpeg',
          file_size: 22,
        },
        voice: {
          file_id: 'voice-id',
          file_unique_id: 'voice-u',
          duration: 7,
          mime_type: 'audio/ogg',
          file_size: 33,
        },
      },
    });

    assert.ok(message);
    assert.deepEqual(message.mediaParts.map((part) => part.mediaKind), ['photo', 'document', 'audio', 'voice']);
    assert.deepEqual(message.mediaParts.map((part) => part.index), [1, 2, 3, 4]);
    assert.equal(message.mediaParts[0]?.fileId, 'photo-large');
    assert.equal(message.mediaParts[0]?.width, 100);
    assert.equal(message.mediaParts[1]?.fileName, 'screenshot.png');
    assert.equal(message.mediaParts[1]?.mimeType, 'image/png');
    assert.equal(message.mediaParts[2]?.durationSeconds, 120);
    assert.equal(message.mediaParts[2]?.title, 'Title');
    assert.equal(message.mediaParts[2]?.performer, 'Performer');
    assert.equal(message.mediaParts[3]?.durationSeconds, 7);
  });

  it('ignores updates without a message', () => {
    assert.equal(normalizeTelegramUpdate({ update_id: 1 }), null);
    assert.equal(hasTelegramInboundContent(null), false);
  });

  it('normalizes callback queries separately from message replies', () => {
    const callback = normalizeTelegramCallbackQuery({
      update_id: 45,
      callback_query: {
        id: 'callback-1',
        from: { id: 'telegram-user-1' },
        data: 'omx:pg:abc123',
        message: {
          message_id: 222,
          message_thread_id: 9001,
          chat: { id: 777, type: 'private' },
        },
      },
    });

    assert.ok(callback);
    assert.equal(callback.updateId, 45);
    assert.equal(callback.id, 'callback-1');
    assert.equal(callback.senderId, 'telegram-user-1');
    assert.equal(callback.chatId, 777);
    assert.equal(callback.chatType, 'private');
    assert.equal(callback.messageId, 222);
    assert.equal(callback.messageThreadId, 9001);
    assert.equal(callback.data, 'omx:pg:abc123');
    assert.equal(normalizeTelegramUpdate({ update_id: 45, callback_query: callback.rawCallbackQuery }), null);
  });
});
