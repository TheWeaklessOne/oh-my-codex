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
   - upstream result
   - problems encountered
   - short release-news summary

## Command

```bash
./.codex/skills/upstream-sync/scripts/sync.sh [--branch <name>] [--remote <origin|upstream>] [--check-only] [--no-cli-update]
```

## Optional automatic release watcher

Use the watcher when you want this checkout to notice new upstream releases without manually invoking the skill. It has exactly one execution path: poll the selected remote for the newest `v*` release tag already merged into `<remote>/main`; if that tag has not already completed, run `omx exec` with `$upstream-sync`. The skill owns the sync, conflict resolution, verification, and local CLI update.

```bash
# One-shot: record the current upstream release as the baseline without syncing.
./.codex/skills/upstream-sync/scripts/watch-release.sh --mark-current

# One-shot: check for a new release and run $upstream-sync via omx exec if needed.
./.codex/skills/upstream-sync/scripts/watch-release.sh

# macOS: install a LaunchAgent that checks hourly.
./.codex/skills/upstream-sync/scripts/install-release-watch-launchagent.sh --interval 3600
```

Notes:

- This is intentionally a local watcher, not a GitHub Actions workflow in the fork. Upstream release events do not directly execute code on this machine unless you run a webhook receiver, so polling via `launchd` is the lowest-friction local trigger.
- The watcher always runs `omx exec -C <repo> "Run $upstream-sync ..."` so an agent can continue from a handoff record and verify the result. Ensure the LaunchAgent environment can find `omx` and has Codex auth.
- If you want automation to start only from the next future release, run `watch-release.sh --mark-current` before installing/loading the LaunchAgent.
- LaunchAgent logs go to `.omx/logs/upstream-sync/release-watch.launchd.log` and `.omx/logs/upstream-sync/release-watch.launchd.err.log`; watcher state goes to `.omx/state/upstream-sync/release-watch.json`.

## Default behavior

- Remote selection preference: `upstream`, then `origin`, but only when the URL is the canonical `Yeachan-Heo/oh-my-codex` GitHub remote; pass `--remote <name>` explicitly for non-canonical remotes.
- Primary sync target: local `main`.
- Follow-up branch behavior: no branch rebase happens unless `--branch <name>` is explicitly supplied, and `main` is not a valid follow-up branch name.
- Sync target: the newest release tag already merged into `<remote>/main`, not unreleased commits past that tag.
- Main sync strategy: merge the upstream release baseline into local `main`; do not rebase `main`.
- Follow-up strategy: if `--branch <name>` is supplied, rebase that explicit non-`main` branch onto the refreshed local `main`.
- Conflict strategy: probe first; if probe or apply conflicts, stop before moving more refs and write a stable handoff record to `.omx/state/upstream-sync/last-handoff.json` for agent-authored resolution instead of blind `ours/theirs` conflict picks.
- CLI sync target: this repo checkout via `npm run build && npm link`, not the published npm package.
- Output contract: always end with the concise final response contract below.

## Final response contract for invoking agents

The final assistant answer must be brief and must contain exactly these three lines:

```text
upstream: <ok|failed> — <target tag/version and whether local CLI was updated>
issues: <none | one short sentence about conflicts, blockers, or notable fixes>
release: <one short sentence, max 240 characters, about what is new>
```

Rules:

- Use `ok` only after the sync completed, verification ran, and the repo-backed CLI was rebuilt/relinked when required.
- Use `failed` when the release was not fully applied or the CLI update did not complete.
- Keep `issues:` to one sentence. If nothing noteworthy happened, write `issues: none`.
- Keep `release:` short. Summarize only the highest-impact release notes; do not paste changelog sections or raw logs.
- Do not include step-by-step narration, command transcripts, raw diff output, long release notes, or “I will/I did” process commentary.
- If conflict resolution happened, mention only the affected area and outcome, not the whole conflict transcript.

Positive examples:

```text
upstream: ok — synced main to v0.14.5; local CLI relinked
issues: resolved one package-lock conflict during the release merge
release: v0.14.5 improves team resume stability and tightens notification fallback handling.
```

```text
upstream: failed — v0.14.5 was not applied; local CLI unchanged
issues: merge conflict in src/hooks/runtime.ts still needs manual review; handoff written
release: v0.14.5 focuses on hook/runtime fixes; full notes are available upstream.
```

Negative examples:

```text
I fetched upstream, created a worktree, ran several commands, here is the full output...
```

```text
upstream: ok
issues: none
release: ## Summary
- long pasted changelog bullet 1
- long pasted changelog bullet 2
- long pasted changelog bullet 3
```

## Safety rules

- After local ref-safety preflight passes, always run the probe before any apply step.
- Never rewrite `main`; only fast-forward it to a prepared merge candidate.
- Reject `--branch main`; omit `--branch` when you only want to sync local `main`.
- If the current checkout is `main`, require a clean working tree before fast-forwarding it to the prepared candidate.
- If `--branch <name>` targets the current checkout, require a clean working tree before the real rebase.
- If `main` or the explicit follow-up branch is checked out in another worktree, do not move that ref behind the user's back.
- On conflict, read `.omx/state/upstream-sync/last-handoff.json` and let the invoking agent resolve it semantically:
  preserve the functional behavior from both the new upstream release and the fork-local branch, then continue the merge/rebase and verify the result.
