---
name: mission
description: Thin mission-supervisor entrypoint for long-running oracle-driven closure loops
---

# Mission Skill

`$mission` is the operator-facing entrypoint for the Mission MVP.

You can invoke it either:

- in-session via `$mission "..."`, or
- from the shell via `omx mission "..."`.

Use it when the user wants OMX to keep iterating until an **independent audit/re-audit lane** says the target is closed, plateaued, or failed — not merely when local checks look green.

## Core contract

- **Thin supervisor**: keep only mission state, concise summaries, policies, and lane provenance in the long-lived context.
- **Fresh lanes**: audit and re-audit must run in fresh OMX sessions/lane identities; they must not reuse the execution lane context.
- **Kernel owns truth**: lifecycle transitions, iteration bookkeeping, delta judgment, plateau detection, resume, cancel, and latest-read-model updates live in `src/mission/kernel.ts`.
- **Contract-first artifacts**: mission state persists under `.omx/missions/<slug>/` with:
  - `events.ndjson` as the append-only mission audit trail
  - `source-pack.json`
  - `mission-brief.md`
  - `acceptance-contract.json`
  - `execution-plan.md`
  - `planning-transaction.json` as the canonical planning transaction record
  - `workflow.json` (derived Mission V2 stage + strategy history read model)
  - `budget.json`, `run-metrics.json`, and `watchdog.json` for runtime telemetry / expensive-failure controls
  - `iterations/<n>/*/execution-envelope.json` for lane workspace / write-policy / provenance binding
  - `mission.json`
  - read models should be rebuildable from `mission.json` + `events.ndjson`; snapshots are not authoritative
  - `latest.json` (read model only; never authoritative)
  - `iterations/<n>/{audit,remediation,execution,re_audit}/summary.json`
  - `iterations/<n>/*/briefing.md` lane-specific handoff context derived from the contract/plan
  - `iterations/<n>/hardening/summary.json` only when the bounded hardening fallback runs
  - `iterations/<n>/delta.json`
  - `closeout.md` once the kernel reaches a terminal state

## Default routing policy

- **Audit / re-audit**: fresh read-only lane by contract
- **Remediation shaping**: direct bounded lane unless coordination is needed
- **Execution**: `team` is the default coordinated executor
- **Hardening / stubborn narrow follow-up**: bounded `ralph` slice when needed; if no hardening slice is needed, the iteration may commit without a hardening summary

Do **not** let the outer mission loop devolve into “everything is Ralph”.

## Invocation posture

When the user invokes `$mission`:

1. Create or load the mission via the mission kernel.
2. Build or reuse the pre-loop Mission V2 artifacts before iteration 1:
   - source grounding / source pack
   - mission brief
   - acceptance / verification contract
   - explicit planning handoff (`plan` / `ralplan` / `deep-interview`) persisted as an execution plan artifact
3. Lock the iteration contract before broad execution:
   - mission/lane/verifier artifacts
   - residual identity + normalization rules
   - closure matrix and lifecycle table
4. Start a fresh **audit** lane.
5. If the audit closes immediately, still require the kernel’s closure matrix + safety baseline to declare `complete`.
   The kernel must refuse terminal closure if the final `re_audit` summary reuses non-verifier lane provenance.
6. Otherwise run:
   - remediation shaping
   - execution
   - optional hardening
   - fresh re-audit
   - kernel delta / plateau / closure judgment
7. Continue until the kernel returns one of:
   - `complete`
   - `plateau`
   - `failed`
   - `cancelled`

## Evidence expectations

Every iteration should preserve only compact artifacts:

- normalized verifier verdict + confidence
- residual list with stable identities
- evidence references
- recommended next action
- lane provenance (`lane_id`, `session_id`, `lane_type`, runner, timing, trigger reason)

Do **not** persist raw lane transcripts by default.

## Resume / cancel rules

- Resume from `mission.json`, not from conversational memory.
- `latest.json` may advance **only after** iteration commit succeeds.
- Late summaries from cancelled or superseded lanes must be ignored deterministically.
- Same-target collisions must reject or namespace the new launch instead of corrupting the existing mission.

## MVP boundaries

- One verifier/oracle contract
- One default execution policy
- No generalized plugin ecosystem
- `omx mission ...` is now a first-class OMX entrypoint for launching this workflow from the shell

This skill is the UX/orchestration entrypoint; the kernel remains the authoritative state machine.
