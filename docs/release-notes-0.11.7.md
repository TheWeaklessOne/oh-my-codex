# Release notes — 0.11.7

## Summary

`0.11.7` packages the current `origin/dev` hotfix train after `0.11.6`, with emphasis on degraded-state auto-nudge recovery and the latest team control-plane correctness fixes.

## Included fixes

- `#1023` — keep leader control mailbox-only and reduce false stalled nudges
- `#1021` — recover successful fallback dispatches to notified state
- `#1020` — restore tmux injection targeting and dispatch ID parity
- `#1018` — keep child agents on the current frontier default
- `#1017` — deduplicate repeated undelivered leader mailbox messages
- `#1016` — add exact-model prompt seam for gpt-5.4-mini subagents
- `#1013` / `#1012` / `#1011` — linked Ralph/team follow-up fixes
- local release fix — fallback watcher degraded-state auto-nudge coverage + cwd pane fallback resolution

## Verification evidence

### Targeted regression suite

- `npm run build` ✅
- `node --test dist/hooks/__tests__/notify-fallback-watcher.test.js dist/hooks/__tests__/notify-hook-auto-nudge.test.js` ✅
  - result: `49/49` passing

### Real tmux / OMX smoke

#### Degraded-state auto-nudge

- branch: `release/0.11.7-refresh` at `1bc3dde`
- setup: live tmux pane running a long-lived fake `codex` process, stalled `hud-state.json` with `If you want, I can keep going from here.` and 5s stall threshold
- result: **PASS**
  - watcher result: `fallback_auto_nudge.last_reason = sent`
  - `auto-nudge-state.json`: `nudgeCount = 1`
  - pane capture contained: `yes, proceed [OMX_TMUX_INJECT]`

#### Ralph continue-steer anti-spam

- setup: live tmux pane with active `ralph-state.json`, watcher run twice back-to-back in `--once` mode
- result: **PASS** for immediate anti-spam check
  - second run ended in `startup_cooldown`
  - no immediate repeat continue-steer was observed in the back-to-back smoke

## Remaining risk

- The real smoke used isolated disposable tmux sessions with a long-lived fake `codex` process, not a full interactive Codex conversation loop.
- Full release confidence is strong for the nudge / watcher path, but broader team startup behavior should still rely on the targeted runtime suite in addition to this smoke.
