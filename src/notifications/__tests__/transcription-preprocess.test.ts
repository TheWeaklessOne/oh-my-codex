import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  FfmpegWavPreprocessor,
  buildFfmpegWavArgs,
} from '../transcription/preprocess.js';
import type { AudioTranscriptionProcessRunner } from '../transcription/types.js';

describe('ffmpeg WAV preprocessor', () => {
  it('builds structured ffmpeg args for 16 kHz mono wav output', () => {
    assert.deepEqual(
      buildFfmpegWavArgs('/tmp/input.ogg', '/tmp/output.wav'),
      ['-y', '-i', '/tmp/input.ogg', '-ar', '16000', '-ac', '1', '/tmp/output.wav'],
    );
  });

  it('returns a temp wav path and cleans temp directory on success', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-ffmpeg-success-'));
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: AudioTranscriptionProcessRunner = async ({ command, args }) => {
      calls.push({ command, args });
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    };

    try {
      const preprocessor = new FfmpegWavPreprocessor({ binaryPath: '/usr/bin/ffmpeg' }, { runner, tmpDir: root });
      const result = await preprocessor.preprocess({ audioPath: '/tmp/input.ogg', timeoutMs: 1000 });
      assert.equal(result.ok, true);
      assert.match(result.ok ? result.audioPath : '', /input\.wav$/);
      assert.equal(calls[0]?.command, '/usr/bin/ffmpeg');
      assert.deepEqual(calls[0]?.args.slice(0, 6), ['-y', '-i', '/tmp/input.ogg', '-ar', '16000', '-ac']);
      assert.equal((await readdir(root)).length, 1);
      if (result.ok) await result.cleanup();
      assert.deepEqual(await readdir(root), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('cleans temp directory and returns typed failure when ffmpeg fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-ffmpeg-failure-'));
    const runner: AudioTranscriptionProcessRunner = async () => ({
      exitCode: 1,
      stdout: 'stdout',
      stderr: 'ffmpeg missing codec',
      timedOut: false,
    });

    try {
      const preprocessor = new FfmpegWavPreprocessor({ binaryPath: '/usr/bin/ffmpeg' }, { runner, tmpDir: root });
      const result = await preprocessor.preprocess({ audioPath: '/tmp/input.ogg' });
      assert.equal(result.ok, false);
      assert.equal(result.ok ? '' : result.code, 'preprocess-failed');
      assert.equal(result.ok ? '' : result.stderr, 'ffmpeg missing codec');
      assert.deepEqual(await readdir(root), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns timeout failure for slow ffmpeg runs', async () => {
    const runner: AudioTranscriptionProcessRunner = async () => ({
      exitCode: null,
      stdout: '',
      stderr: 'slow',
      timedOut: true,
    });
    const preprocessor = new FfmpegWavPreprocessor({ binaryPath: '/usr/bin/ffmpeg' }, { runner });
    const result = await preprocessor.preprocess({ audioPath: '/tmp/input.ogg' });

    assert.equal(result.ok, false);
    assert.equal(result.ok ? '' : result.code, 'timeout');
  });

  it('rejects PATH-resolved ffmpeg binaries before spawning', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: AudioTranscriptionProcessRunner = async ({ command, args }) => {
      calls.push({ command, args });
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    };

    const preprocessor = new FfmpegWavPreprocessor({ binaryPath: 'ffmpeg' }, { runner });
    const result = await preprocessor.preprocess({ audioPath: '/tmp/input.ogg' });

    assert.equal(result.ok, false);
    assert.equal(result.ok ? '' : result.code, 'config-error');
    assert.equal(calls.length, 0);
  });
});
