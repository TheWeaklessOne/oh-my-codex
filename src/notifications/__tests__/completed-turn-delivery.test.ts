import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildCompletedTurnDeliveryEnvelope,
  hasDeliverableContent,
  hasRichMediaContent,
} from '../rich-content.js';

let tempRoot = '';

async function writeGeneratedImage(codexHome: string, threadId: string, name = 'image.png', bytes = 4): Promise<string> {
  const path = join(codexHome, 'generated_images', threadId, name);
  await mkdir(join(codexHome, 'generated_images', threadId), { recursive: true });
  await writeFile(path, Buffer.alloc(bytes, 1));
  return path;
}

async function writeTranscript(path: string, records: readonly unknown[]): Promise<void> {
  await writeFile(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
}

describe('completed-turn rich delivery envelope', () => {
  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'omx-rich-delivery-'));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('treats an empty-text generated image turn as deliverable photo content', async () => {
    const codexHome = join(tempRoot, 'codex-home');
    const threadId = 'thread-image-only';
    const turnId = 'turn-image-only';
    const imagePath = await writeGeneratedImage(codexHome, threadId);
    const transcriptPath = join(tempRoot, 'rollout-image-only.jsonl');
    await writeTranscript(transcriptPath, [
      { type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },
      { type: 'event_msg', payload: { type: 'image_generation_end', saved_path: imagePath } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId } },
    ]);

    const envelope = await buildCompletedTurnDeliveryEnvelope({
      assistantText: '',
      threadId,
      turnId,
      transcriptPath,
      env: { CODEX_HOME: codexHome, HOME: tempRoot } as NodeJS.ProcessEnv,
    });

    assert.equal(envelope.visibleText, '');
    assert.equal(hasDeliverableContent(envelope), true);
    assert.equal(hasRichMediaContent(envelope), true);
    assert.equal(envelope.parts.length, 1);
    assert.deepEqual(envelope.parts[0], {
      kind: 'photo',
      source: { type: 'local_path', path: imagePath, trust: 'turn-artifact' },
      alt: 'image.png',
    });
  });

  it('falls back from generated photo to document when the photo policy rejects size', async () => {
    const codexHome = join(tempRoot, 'codex-home');
    const threadId = 'thread-large-image';
    const turnId = 'turn-large-image';
    const imagePath = await writeGeneratedImage(codexHome, threadId, 'large.png', 8);
    const transcriptPath = join(tempRoot, 'rollout-large-image.jsonl');
    await writeTranscript(transcriptPath, [
      { type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },
      { type: 'event_msg', payload: { type: 'image_generation_end', saved_path: imagePath } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId } },
    ]);

    const envelope = await buildCompletedTurnDeliveryEnvelope({
      assistantText: '',
      threadId,
      turnId,
      transcriptPath,
      env: { CODEX_HOME: codexHome, HOME: tempRoot } as NodeJS.ProcessEnv,
      telegramRichRepliesConfig: { maxPhotoBytes: 1 },
    });

    assert.equal(envelope.parts.length, 1);
    assert.deepEqual(envelope.parts[0], {
      kind: 'document',
      source: { type: 'local_path', path: imagePath, trust: 'turn-artifact' },
      filename: 'large.png',
      mimeType: 'image/png',
    });
  });

  it('does not scan a generated image root without current-turn transcript metadata', async () => {
    const codexHome = join(tempRoot, 'codex-home');
    const threadId = 'thread-missing-turn-proof';
    await writeGeneratedImage(codexHome, threadId, 'stale.png');

    const envelope = await buildCompletedTurnDeliveryEnvelope({
      assistantText: '',
      threadId,
      env: { CODEX_HOME: codexHome, HOME: tempRoot } as NodeJS.ProcessEnv,
    });

    assert.equal(hasDeliverableContent(envelope), false);
    assert.deepEqual(envelope.parts, []);
    assert.ok(envelope.warnings.includes('generated-artifact-current-turn-metadata-missing'));
  });

  it('uses current-turn transcript image events instead of scanning stale thread images', async () => {
    const codexHome = join(tempRoot, 'codex-home');
    const threadId = 'thread-scoped-image';
    const staleImagePath = await writeGeneratedImage(codexHome, threadId, 'stale.png');
    const currentImagePath = await writeGeneratedImage(codexHome, threadId, 'current.png');
    const transcriptPath = join(tempRoot, 'rollout.jsonl');
    await writeTranscript(transcriptPath, [
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'previous-turn' } },
      { type: 'event_msg', payload: { type: 'image_generation_end', saved_path: staleImagePath } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'previous-turn' } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'current-turn' } },
      { type: 'event_msg', payload: { type: 'image_generation_end', saved_path: currentImagePath } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'current-turn' } },
    ]);

    const envelope = await buildCompletedTurnDeliveryEnvelope({
      assistantText: '',
      threadId,
      turnId: 'current-turn',
      transcriptPath,
      env: { CODEX_HOME: codexHome, HOME: tempRoot } as NodeJS.ProcessEnv,
    });

    assert.equal(envelope.parts.length, 1);
    assert.deepEqual(envelope.parts[0], {
      kind: 'photo',
      source: { type: 'local_path', path: currentImagePath, trust: 'turn-artifact' },
      alt: 'current.png',
    });
  });

  it('does not fall back to root scanning when the current transcript turn has no image artifacts', async () => {
    const codexHome = join(tempRoot, 'codex-home');
    const threadId = 'thread-no-current-image';
    await writeGeneratedImage(codexHome, threadId, 'stale.png');
    const transcriptPath = join(tempRoot, 'rollout-no-image.jsonl');
    await writeTranscript(transcriptPath, [
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'current-turn' } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'current-turn' } },
    ]);

    const envelope = await buildCompletedTurnDeliveryEnvelope({
      assistantText: '',
      threadId,
      turnId: 'current-turn',
      transcriptPath,
      env: { CODEX_HOME: codexHome, HOME: tempRoot } as NodeJS.ProcessEnv,
    });

    assert.equal(hasDeliverableContent(envelope), false);
    assert.deepEqual(envelope.parts, []);
  });

  it('rejects current-turn transcript image paths outside trusted generated roots', async () => {
    const codexHome = join(tempRoot, 'codex-home');
    const threadId = 'thread-outside-image';
    const outsidePath = join(tempRoot, 'outside.png');
    await writeFile(outsidePath, Buffer.from('not trusted'));
    const transcriptPath = join(tempRoot, 'rollout-outside-image.jsonl');
    await writeTranscript(transcriptPath, [
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'current-turn' } },
      { type: 'event_msg', payload: { type: 'image_generation_end', saved_path: outsidePath } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'current-turn' } },
    ]);

    const envelope = await buildCompletedTurnDeliveryEnvelope({
      assistantText: '',
      threadId,
      turnId: 'current-turn',
      transcriptPath,
      env: { CODEX_HOME: codexHome, HOME: tempRoot } as NodeJS.ProcessEnv,
    });

    assert.equal(hasDeliverableContent(envelope), false);
    assert.deepEqual(envelope.parts, []);
    assert.ok(envelope.warnings.includes('local-path-outside-trusted-artifact-roots'));
  });

  it('parses explicit photo and document manifests from trusted artifact roots', async () => {
    const projectPath = join(tempRoot, 'repo');
    const artifactRoot = join(projectPath, '.omx', 'artifacts');
    await mkdir(artifactRoot, { recursive: true });
    const photoPath = join(artifactRoot, 'preview.png');
    const documentPath = join(artifactRoot, 'report.pdf');
    await writeFile(photoPath, Buffer.from('png'));
    await writeFile(documentPath, Buffer.from('pdf'));

    const envelope = await buildCompletedTurnDeliveryEnvelope({
      projectPath,
      assistantText: [
        'Here are the deliverables.',
        '```omx-delivery',
        JSON.stringify({
          parts: [
            { kind: 'photo', path: photoPath, caption: 'Preview' },
            { kind: 'document', path: documentPath, filename: 'report.pdf', caption: 'Report', mimeType: 'application/pdf' },
          ],
        }),
        '```',
      ].join('\n'),
    });

    assert.equal(envelope.visibleText, 'Here are the deliverables.');
    assert.equal(envelope.parts.length, 3);
    assert.deepEqual(envelope.parts[0], {
      kind: 'text',
      text: 'Here are the deliverables.',
      format: 'markdown',
    });
    assert.deepEqual(envelope.parts[1], {
      kind: 'photo',
      source: { type: 'local_path', path: photoPath, trust: 'manifest' },
      caption: 'Preview',
    });
    assert.deepEqual(envelope.parts[2], {
      kind: 'document',
      source: { type: 'local_path', path: documentPath, trust: 'manifest' },
      filename: 'report.pdf',
      caption: 'Report',
      mimeType: 'application/pdf',
    });
  });

  it('rejects explicit manifest paths when the default project artifact root is symlinked outside the project', async () => {
    const projectPath = join(tempRoot, 'repo-symlink-root');
    const omxDir = join(projectPath, '.omx');
    const externalRoot = join(tempRoot, 'external-artifacts');
    await mkdir(omxDir, { recursive: true });
    await mkdir(externalRoot, { recursive: true });
    await symlink(externalRoot, join(omxDir, 'artifacts'));
    const externalPath = join(externalRoot, 'secret.txt');
    await writeFile(externalPath, 'do not upload');

    const envelope = await buildCompletedTurnDeliveryEnvelope({
      projectPath,
      assistantText: [
        '```omx-delivery',
        JSON.stringify({ parts: [{ kind: 'document', path: join(projectPath, '.omx', 'artifacts', 'secret.txt') }] }),
        '```',
      ].join('\n'),
    });

    assert.equal(hasDeliverableContent(envelope), false);
    assert.deepEqual(envelope.parts, []);
    assert.ok(envelope.warnings.includes('local-path-outside-trusted-artifact-roots'));
  });

  it('rejects explicit local manifest paths outside trusted artifact roots', async () => {
    const projectPath = join(tempRoot, 'repo');
    const outsidePath = join(tempRoot, 'secret.txt');
    await writeFile(outsidePath, 'do not upload');

    const envelope = await buildCompletedTurnDeliveryEnvelope({
      projectPath,
      assistantText: [
        '```omx-delivery',
        JSON.stringify({ parts: [{ kind: 'document', path: outsidePath }] }),
        '```',
      ].join('\n'),
    });

    assert.equal(hasDeliverableContent(envelope), false);
    assert.deepEqual(envelope.parts, []);
    assert.ok(envelope.warnings.includes('local-path-outside-trusted-artifact-roots'));
  });
});
