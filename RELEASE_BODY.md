# oh-my-codex v0.15.1

## Summary

`0.15.1` is a patch release for the `0.15.x` train focused on operator-controlled launch behavior, passive state reads, safer repo-aware Team DAG dependency handling, setup/plugin-mode recovery, audited exec follow-ups, and hook/runtime reliability fixes.

## Highlights

- **Direct/non-tmux launch controls** — `omx --direct` and `OMX_LAUNCH_POLICY=direct|tmux|detached-tmux|auto` let operators choose direct or tmux-managed leader startup per launch or environment.
- **Passive read-only state operations** — state read/list/status paths no longer create `.omx/state` directories or initialize tmux-hook config.
- **Repo-aware Team DAG dependency remapping** — symbolic DAG dependencies are remapped to concrete task IDs after task creation and before worker inbox/bootstrap generation.
- **Setup and plugin-mode hardening** — setup reruns explain persisted choices, explicit legacy mode is restored, plugin marketplace discovery is wired, and stale plugin/legacy surfaces are guarded.
- **Runtime reliability** — Stop lifecycle reads prefer canonical run-state, MCP state persistence survives transport disconnects, prompt resume avoids unverified PID hard failures, hook diagnostics are less noisy, and macOS startup polling pressure is reduced.

## Verification

Release readiness evidence is recorded in `docs/qa/release-readiness-0.15.1.md`.

- `npm run build` — see readiness doc
- `npm run lint` — see readiness doc
- `npm run check:no-unused` — see readiness doc
- `npm run verify:native-agents` — see readiness doc
- `npm run verify:plugin-bundle` — see readiness doc
- `npm run test:recent-bug-regressions:compiled` — see readiness doc

## Upgrade notes

- No tag, npm publish, or GitHub release has been created by this local release-prep change.
- Default supported interactive launches remain detached-tmux managed; use `omx --direct` or `OMX_LAUNCH_POLICY=direct` to bypass tmux/HUD management.
- Existing setup installs keep their persisted plugin-vs-legacy choice unless overridden with `--plugin`, `--legacy`, or `--install-mode <legacy|plugin>`.

## Contributors

Thanks to everyone who contributed launch-policy controls, Team DAG hardening, setup/plugin reliability, MCP/runtime fixes, and verification work for this patch release.

**Full Changelog**: [`v0.14.3...v0.15.1`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.14.3...v0.15.1)
