import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sanitizeLiveNotificationEnv } from '../utils/test-env.js';

function collectTests(path: string, out: string[]): void {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return;
  }

  if (stats.isDirectory()) {
    for (const entry of readdirSync(path)) {
      collectTests(join(path, entry), out);
    }
    return;
  }

  if (stats.isFile() && path.endsWith('.test.js')) {
    out.push(path);
  }
}

const roots = process.argv.slice(2);
const targets = roots.length > 0 ? roots : ['dist'];
const files: string[] = [];
for (const target of targets) {
  collectTests(resolve(target), files);
}

files.sort();

if (files.length === 0) {
  console.error(`No test files found under: ${targets.join(', ')}`);
  process.exit(1);
}

const testHome = mkdtempSync(join(tmpdir(), 'omx-test-home-'));
const testEnv = sanitizeLiveNotificationEnv(process.env);
const originalHome = process.env.HOME || process.env.USERPROFILE;
testEnv.HOME = testHome;
testEnv.USERPROFILE = testHome;
if (originalHome) {
  testEnv.CARGO_HOME ??= join(originalHome, '.cargo');
  testEnv.RUSTUP_HOME ??= join(originalHome, '.rustup');
}

try {
  const result = spawnSync(process.execPath, ['--test', ...files], {
    stdio: 'inherit',
    env: testEnv,
  });

  if (typeof result.status === 'number') {
    process.exitCode = result.status;
  } else {
    process.exitCode = 1;
  }
} finally {
  rmSync(testHome, { recursive: true, force: true });
}
