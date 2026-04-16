# oh-my-codex v0.13.0

**Adapt foundations, Ralph/session authority hardening, safer launch paths, and quieter hook/HUD workflows**

`0.13.0` is the `v0.12.6..v0.13.0` minor release train. It adds the first `omx adapt` foundation for persistent external targets, tightens Ralph and native Stop session authority, hardens explore/Windows/detached launch paths, and refreshes setup/release workflow guardrails across 56 first-parent PR merges.

## Highlights

- **`omx adapt` foundation** — new adapter-owned CLI/reporting surfaces for persistent targets start with OpenClaw and Hermes, linking canonical planning artifacts while keeping writes under `.omx/adapters/<target>/...` (#1600, #1599, #1598).
- **Ralph and native Stop authority** — prompt-side Ralph activation, PRD CLI startup, tmux Ralph nudges, session assignment, and permission-seeking Stop continuation now respect session ownership more consistently (#1604, #1608, #1591, #1590, #1611).
- **Safer platform launch paths** — explore/codex resolution skips unusable PATH entries, handles sandboxed POSIX shims, fails closed before Windows paths reach POSIX wrappers, and cleans detached leader children on signal exit (#1562, #1610, #1605).
- **Quieter hooks, HUD, and notifications** — live-session HUD binding, startup/dispatch regression coverage, Slack mention parsing, macOS stale-polling git-probe reduction, hook metadata routing, and receiving-agent ownership guidance reduce stale/noisy automation (#1573, #1595, #1585, #1619, #1611).
- **Release/setup workflow hygiene** — wiki setup registration, native-hook doctor coverage, explicit `dev` PR-base guidance, and dependency refreshes keep operator and release paths aligned (#1571, #1546, #1567, #1575, #1576, #1577, #1578).

## What's Changed

### Added
- `omx adapt` foundation for OMX-owned adapter artifacts, probe/status/doctor reports, envelopes, and canonical planning linkage (PR [#1600](https://github.com/Yeachan-Heo/oh-my-codex/pull/1600))
- OpenClaw adapter observation for local config, gateways, hook mappings, and lifecycle bridge evidence (PR [#1599](https://github.com/Yeachan-Heo/oh-my-codex/pull/1599))
- Hermes adapter observation for ACP, gateway, session-store, and bootstrap evidence (PR [#1598](https://github.com/Yeachan-Heo/oh-my-codex/pull/1598))

### Fixed — Ralph / runtime authority
- Ralph assignment, tmux Ralph nudges, and PRD startup semantics now stay session-scoped and explicit (PRs [#1604](https://github.com/Yeachan-Heo/oh-my-codex/pull/1604), [#1608](https://github.com/Yeachan-Heo/oh-my-codex/pull/1608), [#1591](https://github.com/Yeachan-Heo/oh-my-codex/pull/1591))
- Native Stop resumes permission-seeking handoffs and stays stable across session-id drift (PR [#1590](https://github.com/Yeachan-Heo/oh-my-codex/pull/1590), direct commit `4377e1e`)
- Native hook metadata can no longer hijack real prompt routing (PR [#1611](https://github.com/Yeachan-Heo/oh-my-codex/pull/1611))
- Resumed MCP state writers survive duplicate reconcile/self-teardown paths (PR [#1596](https://github.com/Yeachan-Heo/oh-my-codex/pull/1596))

### Fixed — Launch / platform / worktree safety
- Explore resolves usable node/Codex paths across unusable PATH entries and sandboxed pnpm-style shims (PRs [#1562](https://github.com/Yeachan-Heo/oh-my-codex/pull/1562), [#1610](https://github.com/Yeachan-Heo/oh-my-codex/pull/1610))
- Windows explore fails closed before POSIX allowlist fallback can run on Windows paths (direct commit `72b1e5d`)
- Detached leader signal exits terminate child Codex processes (PR [#1605](https://github.com/Yeachan-Heo/oh-my-codex/pull/1605))
- Windows cleanup and stale worktree startup paths are more resilient (PRs [#1589](https://github.com/Yeachan-Heo/oh-my-codex/pull/1589), [#1582](https://github.com/Yeachan-Heo/oh-my-codex/pull/1582))

### Fixed — Hooks / HUD / notifications
- HUD stays bound to the live OMX session instead of stale root scope (PR [#1573](https://github.com/Yeachan-Heo/oh-my-codex/pull/1573))
- Leader stale polling reduces repeated git probes on macOS so long-running sessions do less redundant repo work (PR [#1619](https://github.com/Yeachan-Heo/oh-my-codex/pull/1619))
- Queued startup and dispatch lock behavior is protected by regression coverage (PR [#1595](https://github.com/Yeachan-Heo/oh-my-codex/pull/1595))
- Slack mention environment parsing has dedicated coverage (PR [#1585](https://github.com/Yeachan-Heo/oh-my-codex/pull/1585))
- Safe reversible runtime work is now receiving-agent-owned in generated guidance (direct commit `76e808e`)

### Fixed — Setup / release workflows
- Wiki setup registration stays aligned with shipped assets (PR [#1571](https://github.com/Yeachan-Heo/oh-my-codex/pull/1571))
- Native-hook doctor coverage surfaces config drift clearly (PR [#1546](https://github.com/Yeachan-Heo/oh-my-codex/pull/1546))
- Contributor guidance makes `dev` the normal PR base (PR [#1567](https://github.com/Yeachan-Heo/oh-my-codex/pull/1567))
- Release workflow and TypeScript/Biome dependencies were refreshed (PRs [#1575](https://github.com/Yeachan-Heo/oh-my-codex/pull/1575), [#1576](https://github.com/Yeachan-Heo/oh-my-codex/pull/1576), [#1577](https://github.com/Yeachan-Heo/oh-my-codex/pull/1577), [#1578](https://github.com/Yeachan-Heo/oh-my-codex/pull/1578))

## Verification

- `npm run build` ✅
- `npm run lint` ✅
- `npm test` ✅
- `npm run test:recent-bug-regressions` ✅
- `node --test dist/cli/__tests__/version-sync-contract.test.js` ✅
- `npm run smoke:packed-install` ✅

## Contributors

- [@Yeachan-Heo](https://github.com/Yeachan-Heo) (Bellman)
- [@lifrary](https://github.com/lifrary)
- [@gujishh](https://github.com/gujishh)
- [@dependabot](https://github.com/dependabot)

**Full Changelog**: [`v0.12.6...v0.13.0`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.12.6...v0.13.0)
