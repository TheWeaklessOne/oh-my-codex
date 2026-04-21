import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { mkdtemp, mkdir, writeFile, rm, appendFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import type { SessionMapping } from '../session-registry.js';
import { buildDiscordReplySource, buildTelegramReplySource } from '../reply-source.js';

// The session-registry module uses hardcoded paths under ~/.omx/state/.
// We test the data shapes and logic patterns rather than filesystem integration
// to avoid polluting the real state directory.

function createMockMapping(overrides?: Partial<SessionMapping>): SessionMapping {
  return {
    platform: 'discord-bot',
    messageId: randomUUID(),
    source: buildDiscordReplySource('discord-token', 'channel-1'),
    sessionId: randomUUID(),
    tmuxPaneId: '%0',
    tmuxSessionName: 'test-session',
    event: 'session-idle',
    createdAt: new Date().toISOString(),
    projectPath: '/tmp/test',
    ...overrides,
  };
}

describe('SessionMapping shape', () => {
  it('creates valid mapping with all required fields', () => {
    const mapping = createMockMapping();
    assert.ok(mapping.platform);
    assert.ok(mapping.messageId);
    assert.ok(mapping.sessionId);
    assert.ok(mapping.tmuxPaneId);
    assert.ok(mapping.tmuxSessionName !== undefined);
    assert.ok(mapping.event);
    assert.ok(mapping.createdAt);
  });

  it('supports discord-bot platform', () => {
    const mapping = createMockMapping({ platform: 'discord-bot' });
    assert.equal(mapping.platform, 'discord-bot');
  });

  it('supports telegram platform', () => {
    const mapping = createMockMapping({
      platform: 'telegram',
      source: buildTelegramReplySource('123456:telegram-token', '777'),
    });
    assert.equal(mapping.platform, 'telegram');
  });

  it('serializes to valid JSON', () => {
    const mapping = createMockMapping();
    const json = JSON.stringify(mapping);
    const parsed = JSON.parse(json) as SessionMapping;
    assert.equal(parsed.platform, mapping.platform);
    assert.equal(parsed.messageId, mapping.messageId);
    assert.equal(parsed.sessionId, mapping.sessionId);
  });

  it('supports optional projectPath', () => {
    const withPath = createMockMapping({ projectPath: '/test/path' });
    assert.equal(withPath.projectPath, '/test/path');

    const withoutPath = createMockMapping();
    delete (withoutPath as any).projectPath;
    const json = JSON.stringify(withoutPath);
    const parsed = JSON.parse(json);
    assert.equal(parsed.projectPath, undefined);
  });

  it('stores source-aware correlation metadata', () => {
    const mapping = createMockMapping({
      source: buildTelegramReplySource('123456:telegram-token', '777'),
    });
    assert.equal(mapping.source?.platform, 'telegram');
    assert.ok(mapping.source?.key.includes('telegram:123456:777'));
  });
});

describe('JSONL format', () => {
  it('produces valid JSONL lines from mappings', () => {
    const mappings = [
      createMockMapping({ messageId: 'msg-1' }),
      createMockMapping({ messageId: 'msg-2' }),
      createMockMapping({ messageId: 'msg-3' }),
    ];

    const jsonl = mappings.map(m => JSON.stringify(m)).join('\n') + '\n';
    const lines = jsonl.split('\n').filter(line => line.trim());
    assert.equal(lines.length, 3);

    for (const line of lines) {
      const parsed = JSON.parse(line) as SessionMapping;
      assert.ok(parsed.messageId);
      assert.ok(parsed.platform);
    }
  });

  it('can lookup mapping by messageId from parsed JSONL', () => {
    const target = createMockMapping({ messageId: 'target-msg', platform: 'telegram' });
    const mappings = [
      createMockMapping({ messageId: 'other-1' }),
      target,
      createMockMapping({ messageId: 'other-2' }),
    ];

    const found = mappings.find(m => m.platform === 'telegram' && m.messageId === 'target-msg');
    assert.ok(found);
    assert.equal(found.messageId, 'target-msg');
    assert.equal(found.platform, 'telegram');
  });

  it('can filter mappings by sessionId', () => {
    const sessionId = 'session-to-remove';
    const mappings = [
      createMockMapping({ sessionId }),
      createMockMapping({ sessionId: 'other-session' }),
      createMockMapping({ sessionId }),
    ];

    const filtered = mappings.filter(m => m.sessionId !== sessionId);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].sessionId, 'other-session');
  });

  it('can filter mappings by paneId', () => {
    const mappings = [
      createMockMapping({ tmuxPaneId: '%0' }),
      createMockMapping({ tmuxPaneId: '%1' }),
      createMockMapping({ tmuxPaneId: '%0' }),
    ];

    const filtered = mappings.filter(m => m.tmuxPaneId !== '%0');
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].tmuxPaneId, '%1');
  });

  it('can prune stale entries by age', () => {
    const now = Date.now();
    const maxAgeMs = 24 * 60 * 60 * 1000;

    const mappings = [
      createMockMapping({ createdAt: new Date(now - maxAgeMs - 1000).toISOString() }), // stale
      createMockMapping({ createdAt: new Date(now - 1000).toISOString() }), // fresh
      createMockMapping({ createdAt: new Date(now - maxAgeMs + 60000).toISOString() }), // just within
    ];

    const filtered = mappings.filter(m => {
      const age = now - new Date(m.createdAt).getTime();
      return age < maxAgeMs;
    });

    assert.equal(filtered.length, 2);
  });
});

describe('session-registry module exports', () => {
  it('exports registerMessage function', async () => {
    const mod = await import('../session-registry.js');
    assert.equal(typeof mod.registerMessage, 'function');
  });

  it('exports loadAllMappings function', async () => {
    const mod = await import('../session-registry.js');
    assert.equal(typeof mod.loadAllMappings, 'function');
  });

  it('exports lookupByMessageId function', async () => {
    const mod = await import('../session-registry.js');
    assert.equal(typeof mod.lookupByMessageId, 'function');
  });

  it('exports lookupBySourceMessage function', async () => {
    const mod = await import('../session-registry.js');
    assert.equal(typeof mod.lookupBySourceMessage, 'function');
  });

  it('exports removeSession function', async () => {
    const mod = await import('../session-registry.js');
    assert.equal(typeof mod.removeSession, 'function');
  });

  it('exports removeMessagesByPane function', async () => {
    const mod = await import('../session-registry.js');
    assert.equal(typeof mod.removeMessagesByPane, 'function');
  });

  it('exports pruneStale function', async () => {
    const mod = await import('../session-registry.js');
    assert.equal(typeof mod.pruneStale, 'function');
  });
});

async function importSessionRegistryFresh() {
  const moduleUrl = new URL('../session-registry.js', import.meta.url);
  moduleUrl.searchParams.set('t', `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  return import(moduleUrl.href);
}

describe('session-registry lock contention behavior', () => {
  it('registerMessage times out and returns false instead of blocking indefinitely', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'omx-session-registry-lock-'));
    const stateDir = join(homeDir, '.omx', 'state');
    const lockPath = join(stateDir, 'reply-session-registry.lock');
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(lockPath, JSON.stringify({ pid: process.pid, token: 'held-by-test' }), 'utf-8');
      process.env.HOME = homeDir;
      process.env.USERPROFILE = homeDir;

      const registry = await importSessionRegistryFresh();
      const started = Date.now();
      const ok = registry.registerMessage(createMockMapping());
      const elapsedMs = Date.now() - started;

      assert.equal(ok, false);
      assert.ok(elapsedMs < 7000, `expected bounded wait, got ${elapsedMs}ms`);
    } finally {
      if (typeof originalHome === 'string') process.env.HOME = originalHome;
      else delete process.env.HOME;
      if (typeof originalUserProfile === 'string') process.env.USERPROFILE = originalUserProfile;
      else delete process.env.USERPROFILE;
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});

describe('lookupByMessageId', () => {
  it('prefers the most recent mapping when a platform message id is reused', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'omx-session-registry-reuse-'));
    const stateDir = join(homeDir, '.omx', 'state');
    const registryPath = join(stateDir, 'reply-session-registry.jsonl');
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;

    try {
      await mkdir(stateDir, { recursive: true });
      process.env.HOME = homeDir;
      process.env.USERPROFILE = homeDir;

      const first = createMockMapping({
        platform: 'discord-bot',
        messageId: 'reused-message',
        sessionId: 'session-earlier',
        tmuxPaneId: '%1',
        tmuxSessionName: 'earlier-session',
        createdAt: '2026-03-20T00:00:00.000Z',
      });
      const second = createMockMapping({
        platform: 'discord-bot',
        messageId: 'reused-message',
        sessionId: 'session-later',
        tmuxPaneId: '%2',
        tmuxSessionName: 'later-session',
        createdAt: '2026-03-20T00:10:00.000Z',
      });

      await appendFile(registryPath, `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`, 'utf-8');

      const registry = await importSessionRegistryFresh();
      const found = registry.lookupByMessageId('discord-bot', 'reused-message');

      assert.ok(found);
      assert.equal(found.sessionId, 'session-later');
      assert.equal(found.tmuxPaneId, '%2');
    } finally {
      if (typeof originalHome === 'string') process.env.HOME = originalHome;
      else delete process.env.HOME;
      if (typeof originalUserProfile === 'string') process.env.USERPROFILE = originalUserProfile;
      else delete process.env.USERPROFILE;
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});

describe('lookupBySourceMessage', () => {
  it('prefers the most recent exact source-key match and falls back to legacy rows when needed', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'omx-session-registry-source-aware-'));
    const stateDir = join(homeDir, '.omx', 'state');
    const registryPath = join(stateDir, 'reply-session-registry.jsonl');
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const currentSource = buildDiscordReplySource('discord-token', 'channel-1');
    const otherSource = buildDiscordReplySource('discord-token-2', 'channel-2');

    try {
      await mkdir(stateDir, { recursive: true });
      process.env.HOME = homeDir;
      process.env.USERPROFILE = homeDir;

      const legacy = createMockMapping({
        messageId: 'shared-message',
      });
      delete legacy.source;

      const wrongSource = createMockMapping({
        messageId: 'shared-message',
        source: otherSource,
        sessionId: 'session-wrong-source',
        tmuxPaneId: '%8',
      });

      const exact = createMockMapping({
        messageId: 'shared-message',
        source: currentSource,
        sessionId: 'session-exact',
        tmuxPaneId: '%9',
      });

      await writeFile(
        registryPath,
        [legacy, wrongSource, exact].map((entry) => JSON.stringify(entry)).join('\n') + '\n',
        'utf-8',
      );

      const registry = await importSessionRegistryFresh();
      const exactMatch = registry.lookupBySourceMessage('discord-bot', 'shared-message', currentSource.key);
      assert.equal(exactMatch?.sessionId, 'session-exact');

      const legacyFallback = registry.lookupBySourceMessage('discord-bot', 'shared-message', 'discord-bot:missing-source');
      assert.equal(legacyFallback?.sessionId, legacy.sessionId);
    } finally {
      if (typeof originalHome === 'string') process.env.HOME = originalHome;
      else delete process.env.HOME;
      if (typeof originalUserProfile === 'string') process.env.USERPROFILE = originalUserProfile;
      else delete process.env.USERPROFILE;
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});

describe('source-aware registry mutations', () => {
  it('removeSession prunes legacy and source-aware rows for only the targeted session', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'omx-session-registry-remove-session-'));
    const stateDir = join(homeDir, '.omx', 'state');
    const registryPath = join(stateDir, 'reply-session-registry.jsonl');
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;

    try {
      await mkdir(stateDir, { recursive: true });
      process.env.HOME = homeDir;
      process.env.USERPROFILE = homeDir;

      const targetLegacy = createMockMapping({
        sessionId: 'session-target',
        messageId: 'legacy-target',
      });
      delete targetLegacy.source;

      const targetSourceAware = createMockMapping({
        sessionId: 'session-target',
        messageId: 'source-target',
        platform: 'telegram',
        source: buildTelegramReplySource('123456:telegram-token', '777'),
      });

      const keep = createMockMapping({
        sessionId: 'session-keep',
        messageId: 'keep-message',
      });

      await writeFile(
        registryPath,
        [targetLegacy, targetSourceAware, keep].map((entry) => JSON.stringify(entry)).join('\n') + '\n',
        'utf-8',
      );

      const registry = await importSessionRegistryFresh();
      registry.removeSession('session-target');

      const persisted = readFileSync(registryPath, 'utf-8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as SessionMapping);

      assert.deepEqual(persisted.map((entry) => entry.sessionId), ['session-keep']);
      assert.equal(persisted[0].messageId, 'keep-message');
    } finally {
      if (typeof originalHome === 'string') process.env.HOME = originalHome;
      else delete process.env.HOME;
      if (typeof originalUserProfile === 'string') process.env.USERPROFILE = originalUserProfile;
      else delete process.env.USERPROFILE;
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('removeMessagesByPane removes only the targeted pane across mixed legacy/source-aware rows', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'omx-session-registry-remove-pane-'));
    const stateDir = join(homeDir, '.omx', 'state');
    const registryPath = join(stateDir, 'reply-session-registry.jsonl');
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;

    try {
      await mkdir(stateDir, { recursive: true });
      process.env.HOME = homeDir;
      process.env.USERPROFILE = homeDir;

      const targetLegacy = createMockMapping({
        tmuxPaneId: '%9',
        messageId: 'legacy-pane-target',
      });
      delete targetLegacy.source;

      const targetSourceAware = createMockMapping({
        tmuxPaneId: '%9',
        messageId: 'source-pane-target',
        platform: 'telegram',
        source: buildTelegramReplySource('123456:telegram-token', '777'),
      });

      const keep = createMockMapping({
        tmuxPaneId: '%10',
        messageId: 'keep-pane-message',
      });

      await writeFile(
        registryPath,
        [targetLegacy, targetSourceAware, keep].map((entry) => JSON.stringify(entry)).join('\n') + '\n',
        'utf-8',
      );

      const registry = await importSessionRegistryFresh();
      registry.removeMessagesByPane('%9');

      const persisted = readFileSync(registryPath, 'utf-8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as SessionMapping);

      assert.deepEqual(persisted.map((entry) => entry.tmuxPaneId), ['%10']);
      assert.equal(persisted[0].messageId, 'keep-pane-message');
    } finally {
      if (typeof originalHome === 'string') process.env.HOME = originalHome;
      else delete process.env.HOME;
      if (typeof originalUserProfile === 'string') process.env.USERPROFILE = originalUserProfile;
      else delete process.env.USERPROFILE;
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('pruneStale keeps fresh source-aware rows while removing stale legacy rows', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'omx-session-registry-prune-'));
    const stateDir = join(homeDir, '.omx', 'state');
    const registryPath = join(stateDir, 'reply-session-registry.jsonl');
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;

    try {
      await mkdir(stateDir, { recursive: true });
      process.env.HOME = homeDir;
      process.env.USERPROFILE = homeDir;

      const now = Date.now();
      const staleLegacy = createMockMapping({
        messageId: 'stale-legacy',
        createdAt: new Date(now - (25 * 60 * 60 * 1000)).toISOString(),
      });
      delete staleLegacy.source;

      const freshSourceAware = createMockMapping({
        messageId: 'fresh-source-aware',
        platform: 'telegram',
        source: buildTelegramReplySource('123456:telegram-token', '777'),
        createdAt: new Date(now - 60_000).toISOString(),
      });

      await writeFile(
        registryPath,
        [staleLegacy, freshSourceAware].map((entry) => JSON.stringify(entry)).join('\n') + '\n',
        'utf-8',
      );

      const registry = await importSessionRegistryFresh();
      registry.pruneStale();

      const persisted = readFileSync(registryPath, 'utf-8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as SessionMapping);

      assert.equal(persisted.length, 1);
      assert.equal(persisted[0].messageId, 'fresh-source-aware');
      assert.equal(persisted[0].source?.platform, 'telegram');
    } finally {
      if (typeof originalHome === 'string') process.env.HOME = originalHome;
      else delete process.env.HOME;
      if (typeof originalUserProfile === 'string') process.env.USERPROFILE = originalUserProfile;
      else delete process.env.USERPROFILE;
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});
