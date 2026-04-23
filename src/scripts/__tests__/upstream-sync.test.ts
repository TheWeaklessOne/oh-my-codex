import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, realpathSync, readFileSync, writeFileSync } from 'node:fs';
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

function gitStatus(cwd: string, args: string[]): number {
	const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
	return result.status ?? 1;
}

function handoffPath(cwd: string): string {
	return join(cwd, '.omx', 'state', 'upstream-sync', 'last-handoff.json');
}

function readHandoff(cwd: string): Record<string, unknown> {
	return JSON.parse(readFileSync(handoffPath(cwd), 'utf-8')) as Record<string, unknown>;
}

function writeExecutable(path: string, content: string): void {
	writeFileSync(path, content, 'utf-8');
	chmodSync(path, 0o755);
}

function setAnnotatedTag(cwd: string, tagName: string, target: string, message: string): void {
	execFileSync('git', ['tag', '-fa', tagName, target, '-m', message], { cwd, stdio: 'ignore' });
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

type LocalMainChangeMode = 'none' | 'fork-note' | 'readme-conflict';

async function createSyncFixture(
	branchName: string,
	options: {
		localMainChange?: LocalMainChangeMode;
		releaseTrailingMainCommit?: boolean;
	} = {},
): Promise<{ repo: string; cleanupRoot: string }> {
	const rawRoot = await mkdtemp(join(tmpdir(), 'omx-upstream-sync-fixture-'));
	const cleanupRoot = realpathSync(rawRoot);
	const repo = join(cleanupRoot, 'repo');
	const remote = join(cleanupRoot, 'origin.git');
	const upstreamRepo = join(cleanupRoot, 'upstream');
	const localMainChange = options.localMainChange ?? 'none';

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
	execFileSync('git', ['clone', remote, upstreamRepo], { stdio: 'ignore' });
	execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: upstreamRepo, stdio: 'ignore' });
	execFileSync('git', ['config', 'user.name', 'Upstream User'], { cwd: upstreamRepo, stdio: 'ignore' });
	execFileSync('git', ['checkout', 'main'], { cwd: upstreamRepo, stdio: 'ignore' });

	if (localMainChange === 'fork-note') {
		await writeFile(join(repo, 'LOCAL_MAIN.md'), 'local main fork note\n', 'utf-8');
		execFileSync('git', ['add', 'LOCAL_MAIN.md'], { cwd: repo, stdio: 'ignore' });
		execFileSync('git', ['commit', '-m', 'local main fork note'], { cwd: repo, stdio: 'ignore' });
	} else if (localMainChange === 'readme-conflict') {
		await writeFile(join(repo, 'README.md'), 'local main change\n', 'utf-8');
		execFileSync('git', ['add', 'README.md'], { cwd: repo, stdio: 'ignore' });
		execFileSync('git', ['commit', '-m', 'local main readme change'], { cwd: repo, stdio: 'ignore' });
	}

	execFileSync('git', ['checkout', '-b', branchName], { cwd: repo, stdio: 'ignore' });
	await writeFile(join(repo, 'AGENTS.md'), `work branch file for ${branchName}\n`, 'utf-8');
	execFileSync('git', ['add', 'AGENTS.md'], { cwd: repo, stdio: 'ignore' });
	execFileSync('git', ['commit', '-m', 'work branch change'], { cwd: repo, stdio: 'ignore' });

	execFileSync('git', ['checkout', 'main'], { cwd: repo, stdio: 'ignore' });
	await writeFile(join(upstreamRepo, 'README.md'), 'upstream release update\n', 'utf-8');
	execFileSync('git', ['add', 'README.md'], { cwd: upstreamRepo, stdio: 'ignore' });
	execFileSync('git', ['commit', '-m', 'upstream update'], { cwd: upstreamRepo, stdio: 'ignore' });
	execFileSync('git', ['tag', 'v0.1.1'], { cwd: upstreamRepo, stdio: 'ignore' });
	execFileSync('git', ['push', 'origin', 'main', '--tags'], { cwd: upstreamRepo, stdio: 'ignore' });

	if (options.releaseTrailingMainCommit) {
		await writeFile(join(upstreamRepo, 'README.md'), 'post-release main tip\n', 'utf-8');
		execFileSync('git', ['add', 'README.md'], { cwd: upstreamRepo, stdio: 'ignore' });
		execFileSync('git', ['commit', '-m', 'post-release main update'], { cwd: upstreamRepo, stdio: 'ignore' });
		execFileSync('git', ['push', 'origin', 'main'], { cwd: upstreamRepo, stdio: 'ignore' });
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
	it('defaults to syncing local main and emits a short dry-run report', async () => {
		const branchName = 'feat/current-work';
		const fixture = await createSyncFixture(branchName);

		try {
			const mainBefore = git(fixture.repo, ['rev-parse', 'main']);
			const result = runSync(fixture.repo, ['--remote', 'origin', '--check-only', '--no-cli-update']);
			assert.equal(result.status, 0, result.stderr || result.stdout);

			const lines = summaryLines(result.stdout);
			assert.equal(lines.length, 3, result.stdout);
			assert.equal(
				lines[0],
				'move: dry-run | branch=main | followup=none | target=release v0.1.1 | cli=skipped | conflicts=0',
			);
			assert.equal(lines[1], 'problems: none');
			assert.equal(lines[2], 'releases: v0.1.1 upstream update');
			assert.equal(git(fixture.repo, ['branch', '--show-current']), branchName);
			assert.equal(git(fixture.repo, ['rev-parse', 'main']), mainBefore);
		} finally {
			await rm(fixture.cleanupRoot, { recursive: true, force: true });
		}
	});

	it('merges the upstream release into local main while preserving local-only main work', async () => {
		const branchName = 'feat/local-main';
		const fixture = await createSyncFixture(branchName, { localMainChange: 'fork-note' });

		try {
			const result = runSync(fixture.repo, ['--remote', 'origin', '--no-cli-update']);
			assert.equal(result.status, 0, result.stderr || result.stdout);

			const lines = summaryLines(result.stdout);
			assert.equal(lines.length, 3, result.stdout);
			assert.equal(
				lines[0],
				'move: ok | branch=main | followup=none | target=release v0.1.1 | cli=skipped | conflicts=0',
			);
			assert.equal(lines[1], 'problems: none');
			assert.equal(lines[2], 'releases: v0.1.1 upstream update');

			assert.equal(git(fixture.repo, ['show', 'main:LOCAL_MAIN.md']), 'local main fork note');
			assert.equal(git(fixture.repo, ['show', 'main:README.md']), 'upstream release update');
			assert.equal(gitStatus(fixture.repo, ['merge-base', '--is-ancestor', 'refs/remotes/origin/main', 'main']), 0);
		} finally {
			await rm(fixture.cleanupRoot, { recursive: true, force: true });
		}
	});

	it('rebases the explicit follow-up branch onto the refreshed local main', async () => {
		const branchName = 'feat/rebase-me';
		const fixture = await createSyncFixture(branchName, { localMainChange: 'fork-note' });

		try {
			const result = runSync(fixture.repo, ['--branch', branchName, '--remote', 'origin', '--no-cli-update']);
			assert.equal(result.status, 0, result.stderr || result.stdout);

			const lines = summaryLines(result.stdout);
			assert.equal(lines.length, 3, result.stdout);
			assert.equal(
				lines[0],
				`move: ok | branch=main | followup=${branchName}(rebased) | target=release v0.1.1 | cli=skipped | conflicts=0`,
			);
			assert.equal(lines[1], 'problems: none');
			assert.equal(lines[2], 'releases: v0.1.1 upstream update');

			const counts = git(fixture.repo, ['rev-list', '--left-right', '--count', `${branchName}...main`]);
			const [ahead, behind] = counts.split(/\s+/);
			assert.equal(ahead, '1');
			assert.equal(behind, '0');
			assert.equal(git(fixture.repo, ['show', 'main:LOCAL_MAIN.md']), 'local main fork note');
			assert.equal(git(fixture.repo, ['show', `${branchName}:AGENTS.md`]), `work branch file for ${branchName}`);
		} finally {
			await rm(fixture.cleanupRoot, { recursive: true, force: true });
		}
	});

	it('preserves a conflict worktree for agent-authored main-merge resolution instead of auto-picking a side', async () => {
		const branchName = 'feat/conflict-main';
		const fixture = await createSyncFixture(branchName, { localMainChange: 'readme-conflict' });

		try {
			const result = runSync(fixture.repo, ['--remote', 'origin', '--no-cli-update']);
			assert.notEqual(result.status, 0, result.stdout);

			const lines = summaryLines(result.stdout);
			assert.equal(lines.length, 3, result.stdout);
			assert.equal(
				lines[0],
				'move: failed | branch=main | followup=none | target=release v0.1.1 | cli=skipped | conflicts=1(main)',
			);
			assert.equal(lines[1], 'problems: main merge conflict; handoff=.omx/state/upstream-sync/last-handoff.json');
			assert.equal(existsSync(handoffPath(fixture.repo)), true);
			const handoff = readHandoff(fixture.repo);
			assert.equal(handoff.operation, 'probe-main-merge-conflict');
			assert.equal(typeof handoff.worktree_path, 'string');
			assert.equal(existsSync(String(handoff.worktree_path)), true);
			assert.deepEqual(handoff.conflict_paths, ['README.md']);
			assert.equal(git(fixture.repo, ['show', 'main:README.md']), 'local main change');
		} finally {
			if (existsSync(handoffPath(fixture.repo))) {
				const handoff = readHandoff(fixture.repo);
				if (typeof handoff.worktree_path === 'string' && existsSync(handoff.worktree_path)) {
					await rm(handoff.worktree_path, { recursive: true, force: true });
				}
			}
			await rm(fixture.cleanupRoot, { recursive: true, force: true });
		}
	});

	it('fails before moving main when the current main checkout is dirty', async () => {
		const branchName = 'feat/main-dirty';
		const fixture = await createSyncFixture(branchName);

		try {
			execFileSync('git', ['checkout', 'main'], { cwd: fixture.repo, stdio: 'ignore' });
			const mainBefore = git(fixture.repo, ['rev-parse', 'main']);
			await writeFile(join(fixture.repo, 'README.md'), 'dirty local main\n', 'utf-8');

			const result = runSync(fixture.repo, ['--remote', 'origin', '--no-cli-update']);
			assert.notEqual(result.status, 0, result.stdout);

			const lines = summaryLines(result.stdout);
			assert.equal(lines.length, 3, result.stdout);
			assert.equal(lines[0], 'move: failed | branch=main | followup=none | target=release v0.1.1 | cli=skipped | conflicts=0');
			assert.equal(lines[1], 'problems: current main worktree is dirty');
			assert.equal(git(fixture.repo, ['rev-parse', 'main']), mainBefore);
		} finally {
			await rm(fixture.cleanupRoot, { recursive: true, force: true });
		}
	});

	it('fails before moving main when main is checked out in another worktree', async () => {
		const branchName = 'feat/main-other-worktree';
		const fixture = await createSyncFixture(branchName);
		const extraWorktree = join(fixture.cleanupRoot, 'main-worktree');

		try {
			execFileSync('git', ['worktree', 'add', extraWorktree, 'main'], { cwd: fixture.repo, stdio: 'ignore' });
			const mainBefore = git(fixture.repo, ['rev-parse', 'main']);

			const result = runSync(fixture.repo, ['--remote', 'origin', '--no-cli-update']);
			assert.notEqual(result.status, 0, result.stdout);

			const lines = summaryLines(result.stdout);
			assert.equal(lines.length, 3, result.stdout);
			assert.equal(lines[0], 'move: failed | branch=main | followup=none | target=release v0.1.1 | cli=skipped | conflicts=0');
			assert.equal(lines[1], 'problems: local main is checked out in another worktree');
			assert.equal(git(fixture.repo, ['rev-parse', 'main']), mainBefore);
		} finally {
			await rm(fixture.cleanupRoot, { recursive: true, force: true });
		}
	});

	it('fails dry-run and real run before moving main when the follow-up branch is checked out elsewhere', async () => {
		const branchName = 'feat/followup-blocked';
		const fixture = await createSyncFixture(branchName, { localMainChange: 'fork-note' });
		const extraWorktree = join(fixture.cleanupRoot, 'followup-worktree');

		try {
			execFileSync('git', ['checkout', 'main'], { cwd: fixture.repo, stdio: 'ignore' });
			execFileSync('git', ['worktree', 'add', extraWorktree, branchName], { cwd: fixture.repo, stdio: 'ignore' });

			const mainBefore = git(fixture.repo, ['rev-parse', 'main']);
			const followupBefore = git(fixture.repo, ['rev-parse', branchName]);

			const dryRun = runSync(fixture.repo, ['--branch', branchName, '--remote', 'origin', '--check-only', '--no-cli-update']);
			assert.notEqual(dryRun.status, 0, dryRun.stdout);
			const dryRunLines = summaryLines(dryRun.stdout);
			assert.equal(dryRunLines[0], `move: failed | branch=main | followup=${branchName}(blocked) | target=release v0.1.1 | cli=skipped | conflicts=0`);
			assert.equal(dryRunLines[1], `problems: followup branch '${branchName}' is checked out in another worktree`);
			assert.equal(git(fixture.repo, ['rev-parse', 'main']), mainBefore);
			assert.equal(git(fixture.repo, ['rev-parse', branchName]), followupBefore);

			const realRun = runSync(fixture.repo, ['--branch', branchName, '--remote', 'origin', '--no-cli-update']);
			assert.notEqual(realRun.status, 0, realRun.stdout);
			const realRunLines = summaryLines(realRun.stdout);
			assert.equal(realRunLines[0], `move: failed | branch=main | followup=${branchName}(blocked) | target=release v0.1.1 | cli=skipped | conflicts=0`);
			assert.equal(realRunLines[1], `problems: followup branch '${branchName}' is checked out in another worktree`);
			assert.equal(git(fixture.repo, ['rev-parse', 'main']), mainBefore);
			assert.equal(git(fixture.repo, ['rev-parse', branchName]), followupBefore);
		} finally {
			await rm(fixture.cleanupRoot, { recursive: true, force: true });
		}
	});

	it('rejects --branch main explicitly', async () => {
		const branchName = 'feat/reject-main';
		const fixture = await createSyncFixture(branchName);

		try {
			const mainBefore = git(fixture.repo, ['rev-parse', 'main']);
			const result = runSync(fixture.repo, ['--branch', 'main', '--remote', 'origin', '--no-cli-update']);
			assert.notEqual(result.status, 0, result.stdout);

			const lines = summaryLines(result.stdout);
			assert.equal(lines.length, 3, result.stdout);
			assert.equal(lines[0], 'move: failed | branch=main | followup=none | target=release v0.1.1 | cli=skipped | conflicts=0');
			assert.equal(lines[1], 'problems: --branch main is invalid; omit --branch to sync only local main');
			assert.equal(git(fixture.repo, ['rev-parse', 'main']), mainBefore);
		} finally {
			await rm(fixture.cleanupRoot, { recursive: true, force: true });
		}
	});

	it('fails before moving main when follow-up probe detects a rebase conflict and records a stable handoff artifact', async () => {
		const branchName = 'feat/followup-conflict';
		const fixture = await createSyncFixture(branchName, { localMainChange: 'fork-note' });

		try {
			await writeFile(join(fixture.repo, 'README.md'), 'branch follow-up conflict\n', 'utf-8');
			execFileSync('git', ['add', 'README.md'], { cwd: fixture.repo, stdio: 'ignore' });
			execFileSync('git', ['commit', '-m', 'followup readme change'], { cwd: fixture.repo, stdio: 'ignore' });

			const mainBefore = git(fixture.repo, ['rev-parse', 'main']);
			const followupBefore = git(fixture.repo, ['rev-parse', branchName]);

			const result = runSync(fixture.repo, ['--branch', branchName, '--remote', 'origin', '--no-cli-update']);
			assert.notEqual(result.status, 0, result.stdout);

			const lines = summaryLines(result.stdout);
			assert.equal(lines.length, 3, result.stdout);
			assert.equal(lines[0], `move: failed | branch=main | followup=${branchName}(probe-failed) | target=release v0.1.1 | cli=skipped | conflicts=1(followup)`);
			assert.equal(lines[1], 'problems: followup rebase conflict; handoff=.omx/state/upstream-sync/last-handoff.json');
			assert.equal(git(fixture.repo, ['rev-parse', 'main']), mainBefore);
			assert.equal(git(fixture.repo, ['rev-parse', branchName]), followupBefore);
			assert.equal(existsSync(handoffPath(fixture.repo)), true);
			const handoff = readHandoff(fixture.repo);
			assert.equal(handoff.operation, 'probe-followup-rebase-conflict');
			assert.equal(typeof handoff.worktree_path, 'string');
			assert.equal(existsSync(String(handoff.worktree_path)), true);
			assert.deepEqual(handoff.conflict_paths, ['README.md']);
		} finally {
			if (existsSync(handoffPath(fixture.repo))) {
				const handoff = readHandoff(fixture.repo);
				if (typeof handoff.worktree_path === 'string' && existsSync(handoff.worktree_path)) {
					await rm(handoff.worktree_path, { recursive: true, force: true });
				}
			}
			await rm(fixture.cleanupRoot, { recursive: true, force: true });
		}
	});

	it('uses the latest release tag rather than unreleased remote main commits', async () => {
		const branchName = 'feat/release-target';
		const fixture = await createSyncFixture(branchName, { releaseTrailingMainCommit: true });

		try {
			const result = runSync(fixture.repo, ['--remote', 'origin', '--no-cli-update']);
			assert.equal(result.status, 0, result.stderr || result.stdout);

			const lines = summaryLines(result.stdout);
			assert.equal(lines.length, 3, result.stdout);
			assert.equal(
				lines[0],
				'move: ok | branch=main | followup=none | target=release v0.1.1 | cli=skipped | conflicts=0',
			);
			assert.equal(lines[1], 'problems: none');
			assert.equal(lines[2], 'releases: v0.1.1 upstream update');

			const counts = git(fixture.repo, ['rev-list', '--left-right', '--count', 'main...refs/remotes/origin/main']);
			const [ahead, behind] = counts.split(/\s+/);
			assert.equal(ahead, '0');
			assert.equal(behind, '1');
			assert.equal(git(fixture.repo, ['show', 'main:README.md']), 'upstream release update');
		} finally {
			await rm(fixture.cleanupRoot, { recursive: true, force: true });
		}
	});

	it('uses the remote release tag even when a same-name local tag conflicts', async () => {
		const branchName = 'feat/conflicting-release-tag';
		const fixture = await createSyncFixture(branchName, { releaseTrailingMainCommit: true });

		try {
			setAnnotatedTag(fixture.repo, 'v0.1.1', 'v0.1.0', 'local conflicting release tag');

			const result = runSync(fixture.repo, ['--remote', 'origin', '--no-cli-update']);
			assert.equal(result.status, 0, result.stderr || result.stdout);

			const lines = summaryLines(result.stdout);
			assert.equal(lines.length, 3, result.stdout);
			assert.equal(
				lines[0],
				'move: ok | branch=main | followup=none | target=release v0.1.1 | cli=skipped | conflicts=0',
			);
			assert.equal(lines[1], 'problems: none');
			assert.equal(lines[2], 'releases: v0.1.1 upstream update');
			assert.equal(git(fixture.repo, ['show', 'main:README.md']), 'upstream release update');
		} finally {
			await rm(fixture.cleanupRoot, { recursive: true, force: true });
		}
	});

	it('ignores local-only shadow tags when choosing the release target', async () => {
		const branchName = 'feat/local-shadow-tag';
		const fixture = await createSyncFixture(branchName, { releaseTrailingMainCommit: true });

		try {
			setAnnotatedTag(fixture.repo, 'v9.9.9-shadow', 'v0.1.0', 'local shadow release tag');

			const result = runSync(fixture.repo, ['--remote', 'origin', '--no-cli-update']);
			assert.equal(result.status, 0, result.stderr || result.stdout);

			const lines = summaryLines(result.stdout);
			assert.equal(lines.length, 3, result.stdout);
			assert.equal(
				lines[0],
				'move: ok | branch=main | followup=none | target=release v0.1.1 | cli=skipped | conflicts=0',
			);
			assert.equal(lines[1], 'problems: none');
			assert.equal(lines[2], 'releases: v0.1.1 upstream update');
			assert.equal(git(fixture.repo, ['show', 'main:README.md']), 'upstream release update');
		} finally {
			await rm(fixture.cleanupRoot, { recursive: true, force: true });
		}
	});

	it('rebuilds and relinks the local repo-backed CLI when current checkout is main', async () => {
		const branchName = 'feat/link-sync';
		const fixture = await createSyncFixture(branchName);
		const fakeCli = await installFakeCliTools();

		try {
			execFileSync('git', ['checkout', 'main'], { cwd: fixture.repo, stdio: 'ignore' });

			const result = runSync(fixture.repo, ['--remote', 'origin'], fakeCli.env);
			assert.equal(result.status, 0, result.stderr || result.stdout);

			const lines = summaryLines(result.stdout);
			assert.equal(lines.length, 3, result.stdout);
			assert.equal(
				lines[0],
				'move: ok | branch=main | followup=none | target=release v0.1.1 | cli=linked | conflicts=0',
			);
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
