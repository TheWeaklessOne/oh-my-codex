---
name: mission-upstream-sync
description: Check the latest upstream oh-my-codex release, summarize newer releases, sync the freshest local mission branch onto upstream main, and rebuild/relink the local repo-backed omx CLI. When rebase conflicts appear, the skill stops and leaves conflict resolution to the invoking agent instead of scripted auto-resolution.
argument-hint: "[--branch <name>] [--remote <origin|upstream>] [--check-only] [--no-cli-update]"
---

# Mission Upstream Sync

Use this project-scoped skill for the recurring OMX maintainer flow:

1. fetch upstream tags and `main`
2. report the newest upstream release tag plus the current `main` tip
3. print a short “what’s new” summary for any GitHub releases newer than the local repo version (or the installed `omx` version if `package.json` cannot be read)
4. choose the freshest local branch matching `/mission/i` (or use `--branch`)
5. dry-run the rebase in a temporary worktree and surface conflicts early
6. if the probe is clean and `--check-only` is not set, perform the real rebase; if conflicts appear, stop and let the invoking agent resolve them manually in the current checkout or preserved worktree
7. fast-forward the local `main` branch to `<remote>/main` when that is a clean fast-forward
8. rebuild + `npm link` the local CLI from this repo (unless `--no-cli-update` is set)

## Command

Run the bundled script from the repo root:

```bash
./.codex/skills/mission-upstream-sync/scripts/sync.sh [--branch <name>] [--remote <origin|upstream>] [--check-only] [--no-cli-update]
```

## Default behavior

- Remote selection preference: `upstream` if it points at `Yeachan-Heo/oh-my-codex`, otherwise `origin`, otherwise the first configured remote.
- Release summary source: GitHub release descriptions via `gh api` when available, otherwise the public GitHub releases API via `curl`.
- Release summary baseline: `package.json` version first, then installed `omx` version as a fallback.
- Branch selection preference: current branch if its name contains `mission`; otherwise the freshest local branch whose name matches `/mission/i`.
- Rebase target: `<remote>/main`.
- Conflict strategy: no scripted conflict resolution. The script surfaces conflict files, preserves the relevant worktree when needed, and leaves all edits/decisions to the invoking agent.
- Local main sync: if local `main` only lags `<remote>/main`, fast-forward it; if it diverges, leave it alone and report that.
- CLI sync target: this repo checkout via `npm run build && npm link`, not the published npm package.

## Safety rules

- Always run the probe first; do not skip it.
- Keep the release summary brief; it should be an operator-oriented synopsis, not a full changelog dump.
- If the target branch is the current branch, require a clean working tree before the real rebase.
- If the target branch is checked out in another worktree, stop after the probe and explain which worktree must handle the real rebase.
- If local `main` diverges from `<remote>/main`, do not rewrite it automatically.
- If the target branch is not the current repo checkout, skip the final local CLI relink because `npm link` follows the repo root checkout, not the branch rebased in a temporary worktree.
- When conflicts occur, the invoking agent should resolve files manually, `git add` them, and run `git rebase --continue` or `git rebase --abort`.

## Common examples

Check only, no mutations:

```bash
./.codex/skills/mission-upstream-sync/scripts/sync.sh --check-only
```

Rebase a specific branch without touching the linked CLI:

```bash
./.codex/skills/mission-upstream-sync/scripts/sync.sh --branch mission-v2 --no-cli-update
```

Full default flow:

```bash
./.codex/skills/mission-upstream-sync/scripts/sync.sh
```
