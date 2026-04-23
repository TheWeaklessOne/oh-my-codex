---
name: upstream-sync
description: Sync local fork main onto the current upstream release state, optionally rebase one named work branch onto the refreshed main, relink the global CLI from this repo, and print a short three-line move report plus a short release-news summary.
argument-hint: "[--branch <name>] [--remote <origin|upstream>] [--check-only] [--no-cli-update]"
---

# Upstream Sync

Use this local skill when you want one canonical OMX fork-maintainer sync flow:

1. fetch upstream tags and `main`
2. target the newest release tag already merged into upstream `main`
3. probe a merge of your local `main` onto that release baseline in a temporary worktree
4. apply the real `main` sync through a prepared candidate branch/worktree
5. fast-forward local `main` to that prepared candidate when that is clean and safe
6. if `--branch <name>` is set, rebase that explicit non-`main` work branch onto the refreshed local `main`
7. rebuild + `npm link` the global CLI from this repo when the current checkout is `main` (unless `--no-cli-update` is set)
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
- Primary sync target: local `main`.
- Follow-up branch behavior: no branch rebase happens unless `--branch <name>` is explicitly supplied, and `main` is not a valid follow-up branch name.
- Sync target: the newest release tag already merged into `<remote>/main`, not unreleased commits past that tag.
- Main sync strategy: merge the upstream release baseline into local `main`; do not rebase `main`.
- Follow-up strategy: if `--branch <name>` is supplied, rebase that explicit non-`main` branch onto the refreshed local `main`.
- Conflict strategy: probe first; if probe or apply conflicts, stop before moving more refs and write a stable handoff record to `.omx/state/upstream-sync/last-handoff.json` for agent-authored resolution instead of blind `ours/theirs` conflict picks.
- CLI sync target: this repo checkout via `npm run build && npm link`, not the published npm package.
- Output contract: always end with a short three-line report.

## Safety rules

- After local ref-safety preflight passes, always run the probe before any apply step.
- Never rewrite `main`; only fast-forward it to a prepared merge candidate.
- Reject `--branch main`; omit `--branch` when you only want to sync local `main`.
- If the current checkout is `main`, require a clean working tree before fast-forwarding it to the prepared candidate.
- If `--branch <name>` targets the current checkout, require a clean working tree before the real rebase.
- If `main` or the explicit follow-up branch is checked out in another worktree, do not move that ref behind the user's back.
- On conflict, read `.omx/state/upstream-sync/last-handoff.json` and let the invoking agent resolve it semantically:
  preserve the functional behavior from both the new upstream release and the fork-local branch, then continue the merge/rebase and verify the result.
