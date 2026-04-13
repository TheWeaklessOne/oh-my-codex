# oh-my-codex v0.12.6

**Wiki-first knowledge workflows, hook/notification hardening, launch safety improvements, and dev-merge issue auto-close**

`0.12.6` is the `v0.12.5..v0.12.6` patch train across 32 PR merges. It ships OMX wiki as a first-class local knowledge workflow, deepens hook/notification/session-state hardening, improves launch/worktree safety, and adds automation that closes explicitly linked issues after merges into `dev`.

## Highlights

- **OMX wiki is now first-class** — local markdown wiki storage, query/lint/refresh flows, CLI/MCP parity, and explore integration all land together (#1481).
- **Hook and session-state hardening** — native hook, notify hook, lifecycle dedupe, reply-listener/session-status, and HUD cleanup paths are more stable and less noisy (#1487, #1491, #1493, #1495, #1496, #1514, #1518, #1520, #1526, #1529, #1539).
- **Launch/operator safety** — reusable worktree dependency bootstrap, AGENTS preservation during setup, proxy inheritance, dirty-worktree caution handling, and Claude issue approval-flow smoothing all improve day-to-day operator reliability (#1507, #1521, #1522, #1532, #1536).
- **Discord + dev-merge workflow automation** — tracked Discord sessions get safer control primitives, and merged `dev` PRs can auto-close explicitly linked issues (#1528, #1540).

## What's Changed

### Added
- OMX wiki workflow, storage engine, CLI/MCP parity, and wiki-aware explore behavior (PR [#1481](https://github.com/Yeachan-Heo/oh-my-codex/pull/1481))
- Discord tracked-session control primitive and safer message-id reuse handling (PR [#1530](https://github.com/Yeachan-Heo/oh-my-codex/pull/1530))
- Auto-close workflow for explicitly linked issues after `dev` merges (PR [#1541](https://github.com/Yeachan-Heo/oh-my-codex/pull/1541))

### Fixed — Hooks / notifications / session state
- Needs-input watcher parity for array-backed assistant prompts (PR [#1487](https://github.com/Yeachan-Heo/oh-my-codex/pull/1487))
- Local worker runtime startup / dispatch stability (PRs [#1491](https://github.com/Yeachan-Heo/oh-my-codex/pull/1491), [#1493](https://github.com/Yeachan-Heo/oh-my-codex/pull/1493))
- Managed-session hook cwd alias and ownership stability (PR [#1495](https://github.com/Yeachan-Heo/oh-my-codex/pull/1495))
- Ralph steer / release-readiness follow-up scoping (PRs [#1496](https://github.com/Yeachan-Heo/oh-my-codex/pull/1496), [#1514](https://github.com/Yeachan-Heo/oh-my-codex/pull/1514))
- Lifecycle/keyword alert noise reduction and post-stop replay suppression (PRs [#1518](https://github.com/Yeachan-Heo/oh-my-codex/pull/1518), [#1520](https://github.com/Yeachan-Heo/oh-my-codex/pull/1520), [#1526](https://github.com/Yeachan-Heo/oh-my-codex/pull/1526), [#1529](https://github.com/Yeachan-Heo/oh-my-codex/pull/1529))
- Dead-session HUD residue cleanup before follow-up tooling reads it (PR [#1539](https://github.com/Yeachan-Heo/oh-my-codex/pull/1539))

### Fixed — Launch / setup / operator safety
- Reusable worktree dependency bootstrap (PR [#1510](https://github.com/Yeachan-Heo/oh-my-codex/pull/1510))
- Defensive handling for malformed native-hook stdin JSON (PR [#1504](https://github.com/Yeachan-Heo/oh-my-codex/pull/1504))
- Preserve user-authored AGENTS guidance during setup (PR [#1524](https://github.com/Yeachan-Heo/oh-my-codex/pull/1524))
- Preserve tmux worker proxy environment inheritance (PR [#1523](https://github.com/Yeachan-Heo/oh-my-codex/pull/1523))
- Dirty worktree caution flow with hard-failure preservation outside launch reuse (PR [#1535](https://github.com/Yeachan-Heo/oh-my-codex/pull/1535))
- Claude issue sessions continue through obvious repo reads without unnecessary approval stalls (PR [#1537](https://github.com/Yeachan-Heo/oh-my-codex/pull/1537))

### Fixed — MCP / docs / workflow surfaces
- Superseded MCP stdio sibling cleanup under live Codex app-server parents (PR [#1517](https://github.com/Yeachan-Heo/oh-my-codex/pull/1517))
- Canonical mixed OMX + Codex skill-root documentation plus wiki docs refresh (PR [#1534](https://github.com/Yeachan-Heo/oh-my-codex/pull/1534))

## Verification

- `npm run build` ✅
- `npm run lint` ✅
- `npm test` ✅
- `npm run test:recent-bug-regressions` ✅
- `node --test dist/cli/__tests__/version-sync-contract.test.js` ✅
- `npm run smoke:packed-install` ✅

## Contributors

- [@Yeachan-Heo](https://github.com/Yeachan-Heo) (Bellman)
- [@HaD0Yun](https://github.com/HaD0Yun)

**Full Changelog**: [`v0.12.5...v0.12.6`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.12.5...v0.12.6)
