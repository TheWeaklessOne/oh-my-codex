---
name: upstream-sync
description: Sync the current local oh-my-codex work branch onto the current upstream release state, auto-resolve rebase conflicts in favor of the current work, relink the global CLI from this repo, and print a short three-line move report plus a short release-news summary.
argument-hint: "[--branch <name>] [--remote <origin|upstream>] [--check-only] [--no-cli-update]"
---

# Upstream Sync

Use this local skill when you want one canonical OMX maintainer sync flow:

1. fetch upstream tags and `main`
2. target the newest release tag already merged into upstream `main`
3. sync the current non-`main` branch by default (or use `--branch`)
4. probe the rebase in a temporary worktree
5. perform the real rebase onto the current release state, auto-resolving conflicts in favor of the current work
6. fast-forward local `main` when that is clean and safe
7. rebuild + `npm link` the global CLI from this repo (unless `--no-cli-update` is set)
8. print a short three-line report:
   - move status
   - problems encountered
   - short release-news summary

## Command

```bash
./.codex/skills/upstream-sync/scripts/sync.sh [--branch <name>] [--remote <origin|upstream>] [--check-only] [--no-cli-update]
```

## Default behavior

- Remote selection preference: `upstream` if it points at `Yeachan-Heo/oh-my-codex`, otherwise `origin`, otherwise the first configured remote.
- Branch selection preference: the current branch when it is not `main`; otherwise the freshest local non-`main` branch.
- Sync target: the newest release tag already merged into `<remote>/main`, not unreleased commits past that tag.
- Conflict strategy: auto-resolve rebase conflicts in favor of the current work branch whenever possible.
- CLI sync target: this repo checkout via `npm run build && npm link`, not the published npm package.
- Output contract: always end with a short three-line report.

## Safety rules

- Always run the probe first.
- If the target branch is the current branch, require a clean working tree before the real rebase.
- If local `main` diverges from `<remote>/main`, do not rewrite it automatically.
- If the target branch is not the current checkout, skip the final CLI relink and report that briefly.
- If an automatic conflict fix still cannot complete the rebase, abort the rebase and report failure briefly.
