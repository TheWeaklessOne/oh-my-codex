import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveTurnOriginForNotification } from '../codex-session-origin.js';

function sessionDateDir(codexHome: string, now: Date): string {
  return join(
    codexHome,
    'sessions',
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  );
}

describe('resolveTurnOriginForNotification', () => {
  it('uses a discovered rollout transcript when the payload transcript path has no matching session metadata', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'omx-origin-rollout-transcript-'));
    const codexHome = join(tempRoot, 'codex-home');
    const cwd = join(tempRoot, 'repo');
    const now = new Date('2026-05-03T12:00:00.000Z');
    const threadId = 'thread-discovered-transcript';

    try {
      await mkdir(cwd, { recursive: true });
      const staleTranscriptPath = join(tempRoot, 'stale-rollout.jsonl');
      await writeFile(staleTranscriptPath, `${JSON.stringify({
        type: 'session_meta',
        payload: { id: 'other-thread', cwd },
      })}\n`);

      const transcriptDir = sessionDateDir(codexHome, now);
      await mkdir(transcriptDir, { recursive: true });
      const discoveredTranscriptPath = join(transcriptDir, `rollout-test-${threadId}.jsonl`);
      await writeFile(discoveredTranscriptPath, `${JSON.stringify({
        type: 'session_meta',
        payload: { id: threadId, cwd },
      })}\n`);

      const resolution = await resolveTurnOriginForNotification({
        cwd,
        now,
        env: {
          CODEX_HOME: codexHome,
          HOME: tempRoot,
          USERPROFILE: tempRoot,
        } as NodeJS.ProcessEnv,
        payload: {
          thread_id: threadId,
          transcript_path: staleTranscriptPath,
        },
      });

      assert.equal(resolution.transcriptPath, discoveredTranscriptPath);
      assert.ok(resolution.evidence.some((entry) =>
        entry.source === 'transcript-path' && entry.detail === 'no_matching_session_meta'
      ));
      assert.ok(resolution.evidence.some((entry) => entry.source === 'rollout-path'));
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
