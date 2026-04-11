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
  - `mission.json`
  - `latest.json` (read model only; never authoritative)
  - `iterations/<n>/{audit,remediation,execution,hardening,re_audit}/summary.json`
  - `iterations/<n>/delta.json`

## Default routing policy

- **Audit / re-audit**: fresh read-only lane by contract
- **Remediation shaping**: direct bounded lane unless coordination is needed
- **Execution**: `team` is the default coordinated executor
- **Hardening / stubborn narrow follow-up**: bounded `ralph` slice when needed

Do **not** let the outer mission loop devolve into “everything is Ralph”.

## Invocation posture

When the user invokes `$mission`:

1. Create or load the mission via the mission kernel.
2. Lock the iteration contract before broad execution:
   - mission/lane/verifier artifacts
   - residual identity + normalization rules
   - closure matrix and lifecycle table
3. Start a fresh **audit** lane.
4. If the audit closes immediately, still require the kernel’s closure matrix + safety baseline to declare `complete`.
5. Otherwise run:
   - remediation shaping
   - execution
   - hardening
   - fresh re-audit
   - kernel delta / plateau / closure judgment
6. Continue until the kernel returns one of:
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
