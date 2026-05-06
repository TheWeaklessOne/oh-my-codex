import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

function todaySessionDir(baseHome: string): string {
  const now = new Date();
  return join(
    baseHome,
    '.codex',
    'sessions',
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number = 3000, stepMs: number = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(stepMs);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe('hook-derived-watcher', () => {
  it('uses offset-bounded rollout reads instead of re-reading whole tracked files', async () => {
    const source = await readFile(new URL('../hook-derived-watcher.js', import.meta.url), 'utf-8');

    assert.match(source, /async function readFileDelta/);
    assert.match(source, /while \(totalBytesRead < length\)/);
    assert.match(source, /nextOffset: offset \+ totalBytesRead/);
    assert.match(source, /new StringDecoder\('utf8'\)/);
    assert.match(source, /decoder\.write\(bytes\)/);
    assert.match(source, /const fileStat = await stat\(path\)\.catch\(\(\) => null\);\s*if \(!fileStat\)\s*continue;/);
    assert.match(source, /if \(currentSize < meta\.offset\) \{\s*meta\.offset = 0;\s*meta\.partial = '';/);
    assert.doesNotMatch(source, /const content = await readFile\(path, 'utf-8'\)[\s\S]*const delta = content\.slice\(meta\.offset\)/);
    assert.doesNotMatch(source, /stat\(path\)\.catch\(\(\) => \(\{ size: 0 \}\)\)/);
  });

  it('stores watcher state and logs under boxed runtime root when OMX_ROOT is set', async () => {
    const base = await mkdtemp(join(tmpdir(), 'omx-hook-derived-boxed-'));
    const homeDir = join(base, 'home');
    const cwd = join(base, 'cwd');
    const boxedRoot = join(base, 'boxed-runtime');

    try {
      await mkdir(todaySessionDir(homeDir), { recursive: true });
      await mkdir(cwd, { recursive: true });
      const watcherScript = new URL('../hook-derived-watcher.js', import.meta.url).pathname;
      const result = spawnSync(
        process.execPath,
        [watcherScript, '--once', '--cwd', cwd, '--poll-ms', '250'],
        {
          cwd,
          env: {
            ...process.env,
            HOME: homeDir,
            OMX_ROOT: boxedRoot,
            OMXBOX_ACTIVE: '1',
            OMX_SOURCE_CWD: cwd,
            OMX_HOOK_DERIVED_SIGNALS: '1',
          },
          encoding: 'utf8',
        },
      );

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(
        existsSync(join(boxedRoot, '.omx', 'state', 'hook-derived-watcher-state.json')),
        true,
      );
      assert.equal(
        existsSync(join(cwd, '.omx', 'state', 'hook-derived-watcher-state.json')),
        false,
      );
      const logDir = join(boxedRoot, '.omx', 'logs');
      const logNames = await readdir(logDir);
      assert.equal(logNames.some((name) => name.startsWith('hook-derived-watcher-')), true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('dispatches needs-input for assistant_message content arrays', async () => {
    const base = await mkdtemp(join(tmpdir(), 'omx-hook-derived-array-'));
    const homeDir = join(base, 'home');
    const cwd = join(base, 'cwd');
    const hookLogPath = join(cwd, '.omx', 'hook-events.jsonl');

    try {
      await mkdir(todaySessionDir(homeDir), { recursive: true });
      await mkdir(join(cwd, '.omx', 'hooks'), { recursive: true });

      await writeFile(
        join(cwd, '.omx', 'hooks', 'capture-needs-input.mjs'),
        `import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function onHookEvent(event) {
  await mkdir(dirname(${JSON.stringify(hookLogPath)}), { recursive: true });
  await appendFile(${JSON.stringify(hookLogPath)}, JSON.stringify(event) + '\\n');
}
`,
      );

      const rolloutPath = join(todaySessionDir(homeDir), 'rollout-hook-derived-array.jsonl');
      await writeFile(
        rolloutPath,
        [
          JSON.stringify({
            type: 'session_meta',
            payload: {
              id: 'thread-hook-array',
              cwd,
            },
          }),
          JSON.stringify({
            timestamp: new Date().toISOString(),
            type: 'event_msg',
            payload: {
              type: 'assistant_message',
              turn_id: 'turn-hook-array',
              content: [
                {
                  type: 'output_text',
                  text: 'Would you like me to continue with the cleanup?',
                },
                {
                  type: 'output_text',
                  text: 'I need your approval before I keep going.',
                },
              ],
            },
          }),
          '',
        ].join('\n'),
      );

      const watcherScript = new URL('../hook-derived-watcher.js', import.meta.url).pathname;
      const result = spawnSync(
        process.execPath,
        [watcherScript, '--once', '--cwd', cwd, '--poll-ms', '250'],
        {
          cwd,
          env: {
            ...process.env,
            HOME: homeDir,
            OMX_HOOK_DERIVED_SIGNALS: '1',
            OMX_HOOK_PLUGINS: '1',
          },
          encoding: 'utf8',
        },
      );

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(existsSync(hookLogPath), true, 'expected needs-input hook log to be written');

      const events = (await readFile(hookLogPath, 'utf-8'))
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      assert.equal(events.length, 1);
      assert.equal(events[0].event, 'needs-input');
      assert.equal(events[0].source, 'derived');
      assert.equal(events[0].parser_reason, 'assistant_message_heuristic_question');
      assert.match(String((events[0].context as Record<string, unknown>)?.preview ?? ''), /Would you like me to continue/i);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('records public commentary progress and ignores final/reasoning rollout records', async () => {
    const base = await mkdtemp(join(tmpdir(), 'omx-hook-derived-progress-'));
    const homeDir = join(base, 'home');
    const codexHome = join(homeDir, '.codex');
    const cwd = join(base, 'cwd');
    const sessionId = 'session-progress';
    const turnId = 'turn-progress';

    try {
      await mkdir(todaySessionDir(homeDir), { recursive: true });
      await mkdir(join(cwd, '.omx', 'state', 'sessions', sessionId), { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await writeFile(join(codexHome, '.omx-config.json'), JSON.stringify({
        notifications: {
          enabled: true,
          telegram: {
            enabled: true,
            botToken: '123456:telegram-token',
            chatId: '777',
            progress: {
              enabled: true,
              mode: 'peek',
              transport: 'draft',
            },
          },
          events: {
            'result-ready': { enabled: true },
          },
        },
      }, null, 2));
      await writeFile(join(cwd, '.omx', 'state', 'sessions', sessionId, 'actors.json'), JSON.stringify({
        schemaVersion: 1,
        sessionId,
        cwd,
        ownerActorId: 'leader-1',
        actors: {
          'leader-1': {
            actorId: 'leader-1',
            kind: 'leader',
            audience: 'external-owner',
            threadId: 'thread-progress',
            nativeSessionId: sessionId,
            source: 'test',
            firstSeenAt: new Date().toISOString(),
            lastSeenAt: new Date().toISOString(),
            lifecycleStatus: 'active',
            claimStrength: 'turn-started',
          },
        },
        aliases: {},
      }, null, 2));

      const rolloutPath = join(todaySessionDir(homeDir), 'rollout-hook-derived-progress.jsonl');
      await writeFile(
        rolloutPath,
        [
          JSON.stringify({
            type: 'session_meta',
            payload: {
              id: 'thread-progress',
              cwd,
            },
          }),
          JSON.stringify({
            timestamp: new Date().toISOString(),
            type: 'event_msg',
            payload: {
              type: 'agent_message',
              phase: 'commentary',
              turn_id: turnId,
              message: [
                { type: 'output_text', text: 'Public commentary update' },
                { type: 'reasoning', content: [{ text: 'nested hidden reasoning leak' }] },
                { type: 'encrypted_content', text: 'encrypted secret leak' },
              ],
            },
          }),
          JSON.stringify({
            timestamp: new Date().toISOString(),
            type: 'event_msg',
            payload: {
              type: 'task_complete',
              turn_id: turnId,
              content: 'raw secret tool output token=sk-proj-should-not-leak',
            },
          }),
          JSON.stringify({
            timestamp: new Date().toISOString(),
            type: 'event_msg',
            payload: {
              type: 'agent_message',
              phase: 'final_answer',
              turn_id: turnId,
              message: 'Final answer must not be progress',
            },
          }),
          JSON.stringify({
            timestamp: new Date().toISOString(),
            type: 'response_item',
            payload: {
              type: 'reasoning',
              content: 'hidden reasoning must not be progress',
            },
          }),
          '',
        ].join('\n'),
      );

      const watcherScript = new URL('../hook-derived-watcher.js', import.meta.url).pathname;
      const result = spawnSync(
        process.execPath,
        [watcherScript, '--once', '--cwd', cwd, '--poll-ms', '250'],
        {
          cwd,
          env: {
            ...process.env,
            HOME: homeDir,
            CODEX_HOME: codexHome,
            OMX_SESSION_ID: sessionId,
            OMX_HOOK_DERIVED_SIGNALS: '1',
          },
          encoding: 'utf8',
        },
      );

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const tracePath = join(cwd, '.omx', 'state', 'sessions', sessionId, 'telegram-progress', `${turnId}.json`);
      const trace = JSON.parse(await readFile(tracePath, 'utf-8')) as {
        entries: Array<{ text: string }>;
      };
      assert.equal(trace.entries.length, 2);
      assert.equal(trace.entries[0]?.text, 'Public commentary update');
      assert.equal(trace.entries[1]?.text, 'Задача завершена');
      assert.doesNotMatch(JSON.stringify(trace), /hidden reasoning|encrypted secret|sk-proj-should-not-leak/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('does not record Telegram progress when notifications or result-ready delivery are disabled', async () => {
    for (const [name, notificationsEnabled, resultReadyEnabled] of [
      ['global-disabled', false, true],
      ['event-disabled', true, false],
    ] as const) {
      const base = await mkdtemp(join(tmpdir(), `omx-hook-derived-progress-${name}-`));
      const homeDir = join(base, 'home');
      const codexHome = join(homeDir, '.codex');
      const cwd = join(base, 'cwd');
      const sessionId = `session-progress-${name}`;
      const turnId = `turn-progress-${name}`;

      try {
        await mkdir(todaySessionDir(homeDir), { recursive: true });
        await mkdir(join(cwd, '.omx', 'state', 'sessions', sessionId), { recursive: true });
        await mkdir(codexHome, { recursive: true });
        await writeFile(join(codexHome, '.omx-config.json'), JSON.stringify({
          notifications: {
            enabled: notificationsEnabled,
            telegram: {
              enabled: true,
              botToken: '123456:telegram-token',
              chatId: '777',
              progress: {
                enabled: true,
                mode: 'peek',
                transport: 'draft',
              },
            },
            events: {
              'result-ready': { enabled: resultReadyEnabled },
            },
          },
        }, null, 2));
        await writeFile(join(cwd, '.omx', 'state', 'sessions', sessionId, 'actors.json'), JSON.stringify({
          schemaVersion: 1,
          sessionId,
          cwd,
          ownerActorId: 'leader-1',
          actors: {
            'leader-1': {
              actorId: 'leader-1',
              kind: 'leader',
              audience: 'external-owner',
              threadId: `thread-progress-${name}`,
              nativeSessionId: sessionId,
              source: 'test',
              firstSeenAt: new Date().toISOString(),
              lastSeenAt: new Date().toISOString(),
              lifecycleStatus: 'active',
              claimStrength: 'turn-started',
            },
          },
          aliases: {},
        }, null, 2));

        const rolloutPath = join(todaySessionDir(homeDir), `rollout-hook-derived-progress-${name}.jsonl`);
        await writeFile(
          rolloutPath,
          [
            JSON.stringify({
              type: 'session_meta',
              payload: {
                id: `thread-progress-${name}`,
                cwd,
              },
            }),
            JSON.stringify({
              timestamp: new Date().toISOString(),
              type: 'event_msg',
              payload: {
                type: 'agent_message',
                phase: 'commentary',
                turn_id: turnId,
                message: [{ type: 'output_text', text: 'Should not be stored' }],
              },
            }),
            '',
          ].join('\n'),
        );

        const watcherScript = new URL('../hook-derived-watcher.js', import.meta.url).pathname;
        const result = spawnSync(
          process.execPath,
          [watcherScript, '--once', '--cwd', cwd, '--poll-ms', '250'],
          {
            cwd,
            env: {
              ...process.env,
              HOME: homeDir,
              CODEX_HOME: codexHome,
              OMX_SESSION_ID: sessionId,
              OMX_HOOK_DERIVED_SIGNALS: '1',
            },
            encoding: 'utf8',
          },
        );

        assert.equal(result.status, 0, result.stderr || result.stdout);
        const tracePath = join(cwd, '.omx', 'state', 'sessions', sessionId, 'telegram-progress', `${turnId}.json`);
        assert.equal(existsSync(tracePath), false);
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    }
  });

  it('suppresses Telegram progress from non-owner rollout actors', async () => {
    const base = await mkdtemp(join(tmpdir(), 'omx-hook-derived-progress-non-owner-'));
    const homeDir = join(base, 'home');
    const codexHome = join(homeDir, '.codex');
    const cwd = join(base, 'cwd');
    const sessionId = 'session-progress-non-owner';
    const turnId = 'turn-progress-non-owner';

    try {
      await mkdir(todaySessionDir(homeDir), { recursive: true });
      await mkdir(join(cwd, '.omx', 'state', 'sessions', sessionId), { recursive: true });
      await mkdir(codexHome, { recursive: true });
      await writeFile(join(codexHome, '.omx-config.json'), JSON.stringify({
        notifications: {
          enabled: true,
          telegram: {
            enabled: true,
            botToken: '123456:telegram-token',
            chatId: '777',
            progress: {
              enabled: true,
              mode: 'peek',
              transport: 'draft',
            },
          },
          events: {
            'result-ready': { enabled: true },
          },
        },
      }, null, 2));
      await writeFile(join(cwd, '.omx', 'state', 'sessions', sessionId, 'actors.json'), JSON.stringify({
        schemaVersion: 1,
        sessionId,
        cwd,
        ownerActorId: 'leader-1',
        actors: {
          'leader-1': {
            actorId: 'leader-1',
            kind: 'leader',
            audience: 'external-owner',
            threadId: 'thread-owner',
            nativeSessionId: sessionId,
            source: 'test',
            firstSeenAt: new Date().toISOString(),
            lastSeenAt: new Date().toISOString(),
            lifecycleStatus: 'active',
            claimStrength: 'turn-started',
          },
          'child-1': {
            actorId: 'child-1',
            kind: 'native-subagent',
            audience: 'child',
            threadId: 'thread-child',
            nativeSessionId: 'child-session',
            source: 'test',
            firstSeenAt: new Date().toISOString(),
            lastSeenAt: new Date().toISOString(),
            lifecycleStatus: 'active',
            claimStrength: 'turn-started',
          },
        },
        aliases: {},
      }, null, 2));

      const rolloutPath = join(todaySessionDir(homeDir), 'rollout-hook-derived-progress-non-owner.jsonl');
      await writeFile(
        rolloutPath,
        [
          JSON.stringify({
            type: 'session_meta',
            payload: {
              id: 'thread-child',
              cwd,
            },
          }),
          JSON.stringify({
            timestamp: new Date().toISOString(),
            type: 'event_msg',
            payload: {
              type: 'agent_message',
              phase: 'commentary',
              turn_id: turnId,
              message: [{ type: 'output_text', text: 'Child progress should not be stored' }],
            },
          }),
          '',
        ].join('\n'),
      );

      const watcherScript = new URL('../hook-derived-watcher.js', import.meta.url).pathname;
      const result = spawnSync(
        process.execPath,
        [watcherScript, '--once', '--cwd', cwd, '--poll-ms', '250'],
        {
          cwd,
          env: {
            ...process.env,
            HOME: homeDir,
            CODEX_HOME: codexHome,
            OMX_SESSION_ID: sessionId,
            OMX_HOOK_DERIVED_SIGNALS: '1',
          },
          encoding: 'utf8',
        },
      );

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const tracePath = join(cwd, '.omx', 'state', 'sessions', sessionId, 'telegram-progress', `${turnId}.json`);
      assert.equal(existsSync(tracePath), false);
      const logPath = join(cwd, '.omx', 'logs', `hook-derived-watcher-${new Date().toISOString().split('T')[0]}.jsonl`);
      const logContent = await readFile(logPath, 'utf-8');
      assert.match(logContent, /telegram_progress_draft_suppressed/);
      assert.match(logContent, /non-owner/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('preserves multibyte assistant text split across polling reads', async () => {
    const base = await mkdtemp(join(tmpdir(), 'omx-hook-derived-utf8-'));
    const homeDir = join(base, 'home');
    const cwd = join(base, 'cwd');
    const hookLogPath = join(cwd, '.omx', 'hook-events.jsonl');

    try {
      await mkdir(todaySessionDir(homeDir), { recursive: true });
      await mkdir(join(cwd, '.omx', 'hooks'), { recursive: true });

      await writeFile(
        join(cwd, '.omx', 'hooks', 'capture-needs-input.mjs'),
        `import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function onHookEvent(event) {
  await mkdir(dirname(${JSON.stringify(hookLogPath)}), { recursive: true });
  await appendFile(${JSON.stringify(hookLogPath)}, JSON.stringify(event) + '\\n');
}
`,
      );

      const rolloutPath = join(todaySessionDir(homeDir), 'rollout-hook-derived-utf8.jsonl');
      await writeFile(
        rolloutPath,
        `${JSON.stringify({
          type: 'session_meta',
          payload: {
            id: 'thread-hook-utf8',
            cwd,
          },
        })}\n`,
      );

      const watcherScript = new URL('../hook-derived-watcher.js', import.meta.url).pathname;
      const child = spawn(
        process.execPath,
        [watcherScript, '--cwd', cwd, '--poll-ms', '75'],
        {
          cwd,
          stdio: 'ignore',
          env: {
            ...process.env,
            HOME: homeDir,
            OMX_HOOK_DERIVED_SIGNALS: '1',
            OMX_HOOK_PLUGINS: '1',
          },
        },
      );

      const watcherStatePath = join(cwd, '.omx', 'state', 'hook-derived-watcher-state.json');
      await waitFor(async () => {
        try {
          const state = JSON.parse(await readFile(watcherStatePath, 'utf-8'));
          return state.tracked_files === 1;
        } catch {
          return false;
        }
      });

      const questionText = 'Can you preserve split emoji 🧪 please?';
      const eventLine = `${JSON.stringify({
        timestamp: new Date().toISOString(),
        type: 'event_msg',
        payload: {
          type: 'assistant_message',
          turn_id: 'turn-hook-utf8',
          content: [{ type: 'output_text', text: questionText }],
        },
      })}\n`;
      const bytes = Buffer.from(eventLine, 'utf8');
      const emojiOffset = bytes.indexOf(Buffer.from('🧪', 'utf8'));
      assert.ok(emojiOffset > 0, 'expected test payload to contain emoji bytes');

      await appendFile(rolloutPath, bytes.subarray(0, emojiOffset + 1));
      await sleep(250);
      assert.equal(existsSync(hookLogPath), false, 'incomplete UTF-8 and JSON line should not dispatch');

      const hiddenRolloutPath = `${rolloutPath}.missing`;
      await rename(rolloutPath, hiddenRolloutPath);
      await sleep(250);
      assert.equal(existsSync(hookLogPath), false, 'transient missing file should preserve buffered bytes');
      await rename(hiddenRolloutPath, rolloutPath);

      await appendFile(rolloutPath, bytes.subarray(emojiOffset + 1));
      await waitFor(async () => {
        if (!existsSync(hookLogPath)) return false;
        const raw = await readFile(hookLogPath, 'utf-8');
        return raw.includes('turn-hook-utf8') && raw.includes(questionText);
      }, 4000, 75);

      child.kill('SIGTERM');
      await once(child, 'exit');

      const raw = await readFile(hookLogPath, 'utf-8');
      assert.match(raw, /turn-hook-utf8/);
      assert.match(raw, /Can you preserve split emoji 🧪 please\?/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
