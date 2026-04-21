import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tempHome = '';
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

async function importRegistryFresh() {
  const moduleUrl = new URL('../telegram-topic-registry.js', import.meta.url);
  moduleUrl.searchParams.set('t', `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  return import(moduleUrl.href);
}

describe('telegram-topic-registry', () => {
  before(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'omx-telegram-topic-registry-'));
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
  });

  beforeEach(async () => {
    await rm(join(tempHome, '.omx'), { recursive: true, force: true });
  });

  after(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }

    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }

    await rm(tempHome, { recursive: true, force: true });
  });

  it('stores and retrieves project topic records by source chat and project key', async () => {
    const mod = await importRegistryFresh();
    const record = await mod.upsertTelegramTopicRegistryRecord({
      sourceChatKey: 'telegram:123456:777',
      projectKey: 'project-key-1',
      canonicalProjectPath: '/repos/worktree-a',
      displayName: 'worktree-a',
      topicName: 'worktree-a',
      messageThreadId: '9001',
      createdAt: '2026-04-21T16:00:00.000Z',
      lastUsedAt: '2026-04-21T16:00:00.000Z',
    });

    assert.equal(record.messageThreadId, '9001');

    const loaded = await mod.getTelegramTopicRegistryRecord('telegram:123456:777', 'project-key-1');
    assert.ok(loaded);
    assert.equal(loaded?.canonicalProjectPath, '/repos/worktree-a');
    assert.equal(loaded?.topicName, 'worktree-a');

    const list = await mod.listTelegramTopicRegistryRecords('telegram:123456:777');
    assert.equal(list.length, 1);
    assert.equal(list[0].projectKey, 'project-key-1');

    const persisted = JSON.parse(await readFile(mod.getTelegramTopicRegistryPath(), 'utf-8')) as {
      version: number;
      records: Array<{ messageThreadId?: string }>;
    };
    assert.equal(persisted.version, 1);
    assert.equal(persisted.records[0]?.messageThreadId, '9001');
  });

  it('touches existing records without removing the stored topic mapping', async () => {
    const mod = await importRegistryFresh();
    await mod.upsertTelegramTopicRegistryRecord({
      sourceChatKey: 'telegram:123456:777',
      projectKey: 'project-key-1',
      canonicalProjectPath: '/repos/worktree-a',
      displayName: 'worktree-a',
      topicName: 'worktree-a',
      messageThreadId: '9001',
      createdAt: '2026-04-21T16:00:00.000Z',
      lastUsedAt: '2026-04-21T16:00:00.000Z',
    });

    const touched = await mod.touchTelegramTopicRegistryRecord(
      'telegram:123456:777',
      'project-key-1',
      {
        displayName: 'renamed-display',
        lastUsedAt: '2026-04-21T17:00:00.000Z',
      },
    );

    assert.ok(touched);
    assert.equal(touched?.displayName, 'renamed-display');
    assert.equal(touched?.messageThreadId, '9001');
    assert.equal(touched?.lastUsedAt, '2026-04-21T17:00:00.000Z');
  });

  it('finds records by message thread id within the same Telegram source chat', async () => {
    const mod = await importRegistryFresh();
    await mod.upsertTelegramTopicRegistryRecord({
      sourceChatKey: 'telegram:123456:777',
      projectKey: 'project-key-1',
      canonicalProjectPath: '/repos/worktree-a',
      displayName: 'worktree-a',
      topicName: 'worktree-a',
      messageThreadId: '9001',
    });

    const found = await mod.findTelegramTopicRegistryRecordByThreadId('telegram:123456:777', 9001);
    assert.ok(found);
    assert.equal(found?.projectKey, 'project-key-1');
    assert.equal(found?.canonicalProjectPath, '/repos/worktree-a');
  });

  it('keeps thread-id reverse lookup isolated by source chat key', async () => {
    const mod = await importRegistryFresh();
    await mod.upsertTelegramTopicRegistryRecord({
      sourceChatKey: 'telegram:123456:777',
      projectKey: 'project-key-1',
      canonicalProjectPath: '/repos/worktree-a',
      displayName: 'worktree-a',
      messageThreadId: '9001',
    });
    await mod.upsertTelegramTopicRegistryRecord({
      sourceChatKey: 'telegram:123456:888',
      projectKey: 'project-key-2',
      canonicalProjectPath: '/repos/worktree-b',
      displayName: 'worktree-b',
      messageThreadId: '9001',
    });

    const found = await mod.findTelegramTopicRegistryRecordByThreadId('telegram:123456:888', '9001');
    assert.ok(found);
    assert.equal(found?.projectKey, 'project-key-2');

    const missing = await mod.findTelegramTopicRegistryRecordByThreadId('telegram:123456:999', '9001');
    assert.equal(missing, null);
  });

  it('serializes concurrent callers with the per-project lock', async () => {
    const mod = await importRegistryFresh();
    const order: string[] = [];
    let releaseFirstStart!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      releaseFirstStart = resolve;
    });

    const first = mod.withTelegramTopicProjectLock('telegram:123456:777', 'project-key-1', async () => {
      order.push('first:start');
      releaseFirstStart();
      await new Promise((resolve) => setTimeout(resolve, 40));
      order.push('first:end');
      return 'first';
    });

    await firstStarted;
    const second = mod.withTelegramTopicProjectLock('telegram:123456:777', 'project-key-1', async () => {
      order.push('second:start');
      order.push('second:end');
      return 'second';
    });

    const results = await Promise.all([first, second]);
    assert.deepEqual(results, ['first', 'second']);
    assert.deepEqual(order, ['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('preserves both records when different project keys update the shared registry concurrently', async () => {
    const mod = await importRegistryFresh();

    await Promise.all([
      mod.updateTelegramTopicRegistryRecord(
        'telegram:123456:777',
        'project-key-1',
        () => ({
          sourceChatKey: 'telegram:123456:777',
          projectKey: 'project-key-1',
          canonicalProjectPath: '/repos/worktree-a',
          displayName: 'worktree-a',
          topicName: 'worktree-a',
          messageThreadId: '9001',
          createdAt: '2026-04-21T16:00:00.000Z',
          lastUsedAt: '2026-04-21T16:00:00.000Z',
        }),
      ),
      mod.updateTelegramTopicRegistryRecord(
        'telegram:123456:777',
        'project-key-2',
        () => ({
          sourceChatKey: 'telegram:123456:777',
          projectKey: 'project-key-2',
          canonicalProjectPath: '/repos/worktree-b',
          displayName: 'worktree-b',
          topicName: 'worktree-b',
          messageThreadId: '9002',
          createdAt: '2026-04-21T16:00:00.000Z',
          lastUsedAt: '2026-04-21T16:00:00.000Z',
        }),
      ),
    ]);

    const stored = await mod.listTelegramTopicRegistryRecords('telegram:123456:777');
    assert.equal(stored.length, 2);
    assert.deepEqual(
      stored.map((record: { projectKey: string; messageThreadId?: string }) => ({
        projectKey: record.projectKey,
        messageThreadId: record.messageThreadId,
      })),
      [
        { projectKey: 'project-key-1', messageThreadId: '9001' },
        { projectKey: 'project-key-2', messageThreadId: '9002' },
      ],
    );

    const persisted = JSON.parse(await readFile(mod.getTelegramTopicRegistryPath(), 'utf-8')) as {
      records: Array<{ projectKey: string }>;
    };
    assert.equal(persisted.records.length, 2);
  });

  it('backs up a corrupt registry file and recovers with an empty store', async () => {
    const mod = await importRegistryFresh();
    await mod.upsertTelegramTopicRegistryRecord({
      sourceChatKey: 'telegram:123456:777',
      projectKey: 'project-key-1',
      canonicalProjectPath: '/repos/worktree-a',
      displayName: 'worktree-a',
    });
    const registryPath = mod.getTelegramTopicRegistryPath();
    await writeFile(registryPath, '{ definitely-not-json', 'utf-8');

    const record = await mod.getTelegramTopicRegistryRecord('telegram:123456:777', 'project-key-1');
    assert.equal(record, null);

    const registryDir = join(tempHome, '.omx', 'state');
    const entries = await readFile(registryPath, 'utf-8').catch(() => '');
    assert.equal(entries, '');

    const backupExists = readdir(registryDir)
      .then((files) => files.some((file) => file.startsWith('telegram-topic-registry.json.corrupt.')));
    assert.equal(await backupExists, true);
    assert.equal(existsSync(registryPath), false);
  });
});
