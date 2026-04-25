import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');
const runTestFilesScript = join(repoRoot, 'dist', 'scripts', 'run-test-files.js');

describe('run-test-files', () => {
  it('spawns tests with isolated HOME and sanitized live notification env', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'omx-run-test-files-'));
    const fixtureDir = join(tempRoot, 'fixture');
    const resultPath = join(tempRoot, 'child-env.json');
    const parentHome = join(tempRoot, 'parent-home');
    const cargoHome = join(tempRoot, 'cargo-home');
    const rustupHome = join(tempRoot, 'rustup-home');

    try {
      writeFileSync(join(tempRoot, 'noop'), '');
      mkdirSync(fixtureDir, { recursive: true });
      mkdirSync(parentHome, { recursive: true });
      mkdirSync(cargoHome, { recursive: true });
      mkdirSync(rustupHome, { recursive: true });
      writeFileSync(
        join(fixtureDir, 'env-check.test.js'),
        [
          "import test from 'node:test';",
          "import { writeFileSync } from 'node:fs';",
          "test('captures sanitized env', () => {",
          "  writeFileSync(process.env.OMX_CHILD_ENV_RESULT, JSON.stringify({",
          "    home: process.env.HOME,",
          "    userProfile: process.env.USERPROFILE,",
          "    codeHome: process.env.CODEX_HOME ?? null,",
          "    telegramToken: process.env.OMX_TELEGRAM_BOT_TOKEN ?? null,",
          "    mockOptIn: process.env.OMX_TEST_MOCK_TELEGRAM_TRANSPORT ?? null,",
          "    disableLive: process.env.OMX_TEST_DISABLE_LIVE_NOTIFICATIONS ?? null,",
          "    sanitizedLive: process.env.OMX_TEST_SANITIZED_LIVE_NOTIFICATIONS ?? null,",
          "    cargoHome: process.env.CARGO_HOME ?? null,",
          "    rustupHome: process.env.RUSTUP_HOME ?? null,",
          "  }));",
          "});",
          "",
        ].join('\n'),
        'utf-8',
      );

      const result = spawnSync(process.execPath, [runTestFilesScript, fixtureDir], {
        cwd: repoRoot,
        encoding: 'utf-8',
        env: {
          ...process.env,
          HOME: parentHome,
          USERPROFILE: parentHome,
          CODEX_HOME: join(tempRoot, 'real-codex-home'),
          OMX_TELEGRAM_BOT_TOKEN: '123456:live-token',
          OMX_TEST_MOCK_TELEGRAM_TRANSPORT: '1',
          CARGO_HOME: cargoHome,
          RUSTUP_HOME: rustupHome,
          OMX_CHILD_ENV_RESULT: resultPath,
        },
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.ok(existsSync(resultPath), `missing child env file; stdout=${result.stdout} stderr=${result.stderr}`);
      const childEnv = JSON.parse(readFileSync(resultPath, 'utf-8')) as Record<string, string | null>;
      assert.notEqual(childEnv.home, parentHome);
      assert.equal(childEnv.home, childEnv.userProfile);
      assert.equal(childEnv.codeHome, null);
      assert.equal(childEnv.telegramToken, null);
      assert.equal(childEnv.mockOptIn, null);
      assert.equal(childEnv.disableLive, '1');
      assert.equal(childEnv.sanitizedLive, '1');
      assert.equal(childEnv.cargoHome, cargoHome);
      assert.equal(childEnv.rustupHome, rustupHome);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
