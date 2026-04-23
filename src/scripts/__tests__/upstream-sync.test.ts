import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, realpathSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..', '..', '..');
const syncScript = join(repoRoot, '.codex', 'skills', 'upstream-sync', 'scripts', 'sync.sh');

function git(cwd: string, args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function writeExecutable(path: string, content: string): void {
	writeFileSync(path, content, 'utf-8');
	chmodSync(path, 0o755);
}

function runSync(
	cwd: string,
	args: string[],
	envOverrides: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync('bash', [syncScript, ...args], {
		cwd,
		encoding: 'utf-8',
		env: {
			...process.env,
			...envOverrides,
		},
	});
	return {
		status: result.status,
		stdout: result.stdout || '',
		stderr: result.stderr || '',
	};
}

function summaryLines(stdout: string): string[] {
	return stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
}

async function createSyncFixture(
	branchName: string,
	conflictMode: 'delete-agents' | 'clean',
	options: {
		releaseTrailingMainCommit?: boolean;
	} = {},
): Promise<{ repo: string; cleanupRoot: string }> {
	const rawRoot = await mkdtemp(join(tmpdir(), 'omx-upstream-sync-fixture-'));
	const cleanupRoot = realpathSync(rawRoot);
	const repo = join(cleanupRoot, 'repo');
	const remote = join(cleanupRoot, 'origin.git');

	execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
	execFileSync('git', ['init', repo], { stdio: 'ignore' });
	execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo, stdio: 'ignore' });
	execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo, stdio: 'ignore' });
	execFileSync('git', ['checkout', '-b', 'main'], { cwd: repo, stdio: 'ignore' });

	await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'oh-my-codex', version: '0.1.0' }, null, 2) + '\n', 'utf-8');
	await writeFile(join(repo, 'README.md'), 'base\n', 'utf-8');
	await writeFile(join(repo, 'AGENTS.md'), 'base agents\n', 'utf-8');

	execFileSync('git', ['add', 'package.json', 'README.md', 'AGENTS.md'], { cwd: repo, stdio: 'ignore' });
	execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo, stdio: 'ignore' });
	execFileSync('git', ['tag', 'v0.1.0'], { cwd: repo, stdio: 'ignore' });
	execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: repo, stdio: 'ignore' });
	execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: repo, stdio: 'ignore' });
	execFileSync('git', ['push', 'origin', 'v0.1.0'], { cwd: repo, stdio: 'ignore' });

	execFileSync('git', ['checkout', '-b', branchName], { cwd: repo, stdio: 'ignore' });
	await writeFile(join(repo, 'AGENTS.md'), `work branch file for ${branchName}\n`, 'utf-8');
	execFileSync('git', ['add', 'AGENTS.md'], { cwd: repo, stdio: 'ignore' });
	execFileSync('git', ['commit', '-m', 'work branch change'], { cwd: repo, stdio: 'ignore' });

	execFileSync('git', ['checkout', 'main'], { cwd: repo, stdio: 'ignore' });
	if (conflictMode === 'delete-agents') {
		await rm(join(repo, 'AGENTS.md'));
		execFileSync('git', ['add', '-A', 'AGENTS.md'], { cwd: repo, stdio: 'ignore' });
	} else {
		await writeFile(join(repo, 'README.md'), 'upstream release update\n', 'utf-8');
		execFileSync('git', ['add', 'README.md'], { cwd: repo, stdio: 'ignore' });
	}
	execFileSync('git', ['commit', '-m', 'upstream update'], { cwd: repo, stdio: 'ignore' });
	execFileSync('git', ['tag', 'v0.1.1'], { cwd: repo, stdio: 'ignore' });
	execFileSync('git', ['push', 'origin', 'main', '--tags'], { cwd: repo, stdio: 'ignore' });

	if (options.releaseTrailingMainCommit) {
		await writeFile(join(repo, 'README.md'), 'post-release main tip\n', 'utf-8');
		execFileSync('git', ['add', 'README.md'], { cwd: repo, stdio: 'ignore' });
		execFileSync('git', ['commit', '-m', 'post-release main update'], { cwd: repo, stdio: 'ignore' });
		execFileSync('git', ['push', 'origin', 'main'], { cwd: repo, stdio: 'ignore' });
	}

	execFileSync('git', ['checkout', branchName], { cwd: repo, stdio: 'ignore' });

	return { repo, cleanupRoot };
}

async function installFakeCliTools(): Promise<{ env: Record<string, string>; logPath: string; globalRoot: string; cleanupRoot: string }> {
	const rawRoot = await mkdtemp(join(tmpdir(), 'omx-upstream-sync-bin-'));
	const cleanupRoot = realpathSync(rawRoot);
	const fakeBin = join(cleanupRoot, 'bin');
	const logPath = join(cleanupRoot, 'npm.log');
	const globalRoot = join(cleanupRoot, 'global-root');
	const npmPath = join(fakeBin, 'npm');
	const omxPath = join(fakeBin, 'omx');

	await mkdir(fakeBin, { recursive: true });

	writeExecutable(
		npmPath,
		[
			'#!/bin/sh',
			'set -eu',
			'log="$UPSTREAM_SYNC_NPM_LOG"',
			'case "$1" in',
			'  root)',
			'    if [ "${2:-}" = "-g" ]; then',
			'      printf \'%s\\n\' "$UPSTREAM_SYNC_GLOBAL_ROOT"',
			'      exit 0',
			'    fi',
			'    ;;',
			'  run)',
			'    printf \'npm run %s\\n\' "$2" >> "$log"',
			'    exit 0',
			'    ;;',
			'  link)',
			'    printf \'npm link\\n\' >> "$log"',
			'    mkdir -p "$UPSTREAM_SYNC_GLOBAL_ROOT"',
			'    rm -rf "$UPSTREAM_SYNC_GLOBAL_ROOT/oh-my-codex"',
			'    ln -s "$PWD" "$UPSTREAM_SYNC_GLOBAL_ROOT/oh-my-codex"',
			'    exit 0',
			'    ;;',
			'esac',
			'printf \'npm %s\\n\' "$*" >> "$log"',
			'exit 0',
			'',
		].join('\n'),
	);

	writeExecutable(
		omxPath,
		[
			'#!/bin/sh',
			'if [ "${1:-}" = "--version" ]; then',
			'  printf \'oh-my-codex v0.0.9\\nNode.js v22.16.0\\nPlatform: test\\n\'',
			'  exit 0',
			'fi',
			'exit 1',
			'',
		].join('\n'),
	);

	return {
		env: {
			PATH: `${fakeBin}:${process.env.PATH || ''}`,
			UPSTREAM_SYNC_NPM_LOG: logPath,
			UPSTREAM_SYNC_GLOBAL_ROOT: globalRoot,
		},
		logPath,
		globalRoot,
		cleanupRoot,
	};
}

describe('upstream-sync skill script', () => {
	it('defaults to the current non-main branch and emits a short dry-run report', async () => {
		const branchName = 'feat/current-work';
		const fixture = await createSyncFixture(branchName, 'clean');

		try {
			const result = runSync(fixture.repo, ['--remote', 'origin', '--check-only', '--no-cli-update']);
			assert.equal(result.status, 0, result.stderr || result.stdout);

			const lines = summaryLines(result.stdout);
			assert.equal(lines.length, 3, result.stdout);
			assert.match(lines[0], new RegExp(`^move: dry-run \\| branch=${branchName} \\| target=release v0\\.1\\.1 \\| cli=skipped \\| conflicts=0$`));
			assert.equal(lines[1], 'problems: none');
			assert.equal(lines[2], 'releases: v0.1.1 upstream update');
		} finally {
			await rm(fixture.cleanupRoot, { recursive: true, force: true });
		}
	});

	it('auto-resolves rebase conflicts in favor of the current work and reports them briefly', async () => {
		const branchName = 'feat/conflict-sync';
		const fixture = await createSyncFixture(branchName, 'delete-agents');

		try {
			const result = runSync(fixture.repo, ['--branch', branchName, '--remote', 'origin', '--no-cli-update']);
			assert.equal(result.status, 0, result.stderr || result.stdout);

			const lines = summaryLines(result.stdout);
			assert.equal(lines.length, 3, result.stdout);
			assert.match(lines[0], new RegExp(`^move: ok \\| branch=${branchName} \\| target=release v0\\.1\\.1 \\| cli=skipped \\| conflicts=1\\(auto\\)$`));
			assert.equal(lines[1], 'problems: auto-resolved AGENTS.md');
			assert.equal(lines[2], 'releases: v0.1.1 upstream update');

			const conflicts = git(fixture.repo, ['diff', '--name-only', '--diff-filter=U']);
			assert.equal(conflicts, '');

			const counts = git(fixture.repo, ['rev-list', '--left-right', '--count', `${branchName}...refs/remotes/origin/main`]);
			const [ahead, behind] = counts.split(/\s+/);
			assert.equal(ahead, '1');
			assert.equal(behind, '0');

			const agents = await readFile(join(fixture.repo, 'AGENTS.md'), 'utf-8');
			assert.match(agents, /work branch file for feat\/conflict-sync/);
		} finally {
			await rm(fixture.cleanupRoot, { recursive: true, force: true });
		}
	});

	it('rebases onto the latest release tag instead of unreleased remote main commits and reports release news briefly', async () => {
		const branchName = 'feat/release-target';
		const fixture = await createSyncFixture(branchName, 'clean', { releaseTrailingMainCommit: true });

		try {
			const result = runSync(fixture.repo, ['--branch', branchName, '--remote', 'origin', '--no-cli-update']);
			assert.equal(result.status, 0, result.stderr || result.stdout);

			const lines = summaryLines(result.stdout);
			assert.equal(lines.length, 3, result.stdout);
			assert.match(lines[0], /^move: ok \| branch=feat\/release-target \| target=release v0\.1\.1 \| cli=skipped \| conflicts=0$/);
			assert.equal(lines[1], 'problems: none');
			assert.equal(lines[2], 'releases: v0.1.1 upstream update');

			const counts = git(fixture.repo, ['rev-list', '--left-right', '--count', `${branchName}...refs/remotes/origin/main`]);
			const [ahead, behind] = counts.split(/\s+/);
			assert.equal(ahead, '1');
			assert.equal(behind, '1');

			const readme = await readFile(join(fixture.repo, 'README.md'), 'utf-8');
			assert.equal(readme, 'upstream release update\n');
		} finally {
			await rm(fixture.cleanupRoot, { recursive: true, force: true });
		}
	});

	it('rebuilds and relinks the local repo-backed CLI and reports the move concisely', async () => {
		const branchName = 'feat/link-sync';
		const fixture = await createSyncFixture(branchName, 'clean');
		const fakeCli = await installFakeCliTools();

		try {
			const result = runSync(fixture.repo, ['--branch', branchName, '--remote', 'origin'], fakeCli.env);
			assert.equal(result.status, 0, result.stderr || result.stdout);

			const lines = summaryLines(result.stdout);
			assert.equal(lines.length, 3, result.stdout);
			assert.match(lines[0], /^move: ok \| branch=feat\/link-sync \| target=release v0\.1\.1 \| cli=linked \| conflicts=0$/);
			assert.equal(lines[1], 'problems: none');
			assert.equal(lines[2], 'releases: v0.1.1 upstream update');

			const npmLog = readFileSync(fakeCli.logPath, 'utf-8');
			assert.match(npmLog, /^npm run build$/m);
			assert.match(npmLog, /^npm link$/m);
			assert.doesNotMatch(npmLog, /install -g/);

			const linkedRoot = realpathSync(join(fakeCli.globalRoot, 'oh-my-codex'));
			assert.equal(linkedRoot, realpathSync(fixture.repo));
		} finally {
			await rm(fakeCli.cleanupRoot, { recursive: true, force: true });
			await rm(fixture.cleanupRoot, { recursive: true, force: true });
		}
	});
});
