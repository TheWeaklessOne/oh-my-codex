# oh-my-codex v0.14.3

## Summary

`0.14.3` is a patch release after `v0.14.2` focused on the latest `dev` hardening train for interactive OMX execution. It preserves leader-pane question replies across tool-launched `omx question`, keeps reused deep-interview sessions attached to the correct pane, honors project-local `CODEX_HOME` for explore sessions, prevents multiline root TOML corruption during setup, keeps HUD reconciliation in the emitting tmux window, adds deep-interview summary gates, prevents answered deep-interview rounds from re-prompting, aligns ultrawork with upstream protocol improvements, hardens visible question rendering across tmux/docker-host metadata races, keeps cleanup compatible with BusyBox `ps`, avoids stale native Stop/autopilot loops, adds canonical runtime events for supervisor control, and hardens native Windows psmux worker pane bootstrap.

## Added

- **Korean `ulw` keyboard drift handling** — prompts typed as `ㅕㅣㅈ` normalize to the existing `ulw` ultrawork shorthand before workflow activation.
- **Background-question guidance for deep-interview** — skill, template, and native-hook guidance now tell agents to wait for background `omx question` terminals to finish and read the JSON answer before scoring ambiguity or handing off.
- **`omx question` structured interactive entrypoint** — OMX now has a first-party blocking-question command for agent-invoked user questions, with JSON input, tmux renderer selection, persistent question records, and structured answer output.
- **Question-obligation tracking for deep-interview** — deep-interview can now mark a question as pending/required, satisfy it, and clear it explicitly so interactive progress is durable instead of inferred from free-form prompt text.
- **Advisory triage classifier** — non-keyword prompts now get PASS/LIGHT/HEAVY advisory routing backed by persisted triage state and follow-up suppression.

## Changed

- **Question replies preserve the leader pane** — tool-launched `omx question` flows now retain and reuse the correct return pane across prompt reseeding and renderer metadata races.
- **Explore respects project-local Codex homes** — launch/session helpers honor persisted project setup scope by resolving `CODEX_HOME` to the project `.codex` directory when appropriate.
- **Setup config repair is safer** — multiline root TOML strings are parsed as root entries so setup refreshes no longer orphan fragments or corrupt `developer_instructions`-style values.
- **HUD reconciliation stays window-local** — hook-driven HUD resize/reconcile work targets the emitting tmux window instead of drifting across windows.
- **Ultrawork protocol stays aligned upstream** — the shipped ultrawork skill incorporates the upstream protocol refresh used by oh-my-openagent.
- **Native Windows worker panes are more robust** — psmux worker bootstrap avoids the stale pane/startup assumptions that caused native Windows team launch regressions.

## Fixed

- **Answered deep-interview rounds no longer re-prompt** — stale question state is reconciled against answered records before enforcement asks again.
- **Question answers no longer stall on renderer metadata races** — renderer return-target metadata is stabilized so answers can be injected back to the invoking pane.
- **Detached/hidden question prompts remain operator-visible** — question rendering fails closed or bridges to visible tmux contexts instead of leaving prompts hidden from the operator.
- **BusyBox cleanup compatibility** — cleanup retries process discovery with the BusyBox-compatible `args` field when `ps` rejects `command`.
- **Native Stop no longer loops on stale autopilot planning state** — stale planning state is cleared/reconciled before Stop handling repeats.
- **Release metadata drift** — Node/Cargo metadata, lockfiles, changelog, release body, release notes, and release-readiness collateral are aligned to `0.14.3`.

## Verification

- `npm test` ✅ — 3910 tests passed, 0 failed; catalog check ok.
- `npm run check:no-unused` ✅
- `cargo test --workspace` ✅
- `npm run lint` ✅
- `npm run build` ✅
- `node --test` targeted changed-path suites for question/deep-interview/hooks/team/config/cleanup/HUD ✅

## Upgrade notes

- No migration steps are required for normal users.
- Operators relying on project-local setup should benefit from the corrected `.codex` launch resolution automatically after setup/update refresh.
- `omx question` continues to require an operator-visible tmux path for owned question UI rendering; when that path is unavailable it fails closed with actionable guidance.

## Contributors

Thanks to the contributors who made this release possible.

**Full Changelog**: [`v0.14.2...v0.14.3`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.14.2...v0.14.3)
