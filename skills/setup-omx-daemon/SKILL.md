---
name: setup-omx-daemon
description: Scaffold and launch the OMX GitHub issue-triage daemon for the current repo
---

# Setup OMX Daemon

Use this skill when the user wants a repo-local OMX daemon that continuously watches GitHub issues, drafts triage proposals, and maintains an approval-gated project wiki sink.

## What this skill should do

1. Scaffold tracked governance inputs if missing:
   - `.omx/daemon/ISSUE_GATE.md`
   - `.omx/daemon/PROJECT_CONTEXT.md`
   - `.omx/daemon/RULES.md`
   - `.omx/daemon/daemon.config.json`
2. Ensure project `.gitignore` keeps `.omx/daemon/*.md` and `.omx/daemon/daemon.config.json` trackable while `.omx/state/daemon/` stays ignored.
3. Check daemon status:

```bash
omx daemon status
```

4. If the repo is not initialized yet, scaffold the default daemon files:

```bash
omx daemon scaffold
```

5. After reviewing the governance/config files, run one foreground cycle or start the background daemon:

```bash
omx daemon run-once
# or
omx daemon start
```

## Expected v1 behavior

- The daemon is **approval-first**.
- `.omx/daemon/*` is tracked governance input; the daemon must not rewrite those files automatically.
- Runtime state lives under `.omx/state/daemon/`.
- Draft triage/wiki proposals land in `.omx/state/daemon/outbox/`.
- Approved publications land in `docs/project-wiki/`.
- Queue items are actioned with:

```bash
omx daemon approve <item-id>
omx daemon reject <item-id>
```

## Credential expectations

Default config expects a token reference rather than a raw token. The daemon resolves credentials in this order:
1. `.omx/daemon/daemon.config.json` token reference
2. `GH_TOKEN`
3. `GITHUB_TOKEN`
4. `gh auth token`

## Notes for the agent

- Prefer preserving any existing repo-specific policy text instead of overwriting it.
- If the repository remote is not GitHub, explain that the current daemon implementation is GitHub-specific.
- If credentials are missing, stop after status guidance instead of pretending the daemon is active.
