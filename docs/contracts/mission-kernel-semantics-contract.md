# Mission kernel lifecycle + atomic iteration semantics

This document freezes the Mission MVP kernel behavior that task 3 depends on.

Authoritative implementation:

- `src/mission/kernel.ts`
- `src/mission/contracts.ts`
- `src/mission/__tests__/kernel.test.ts`

## Required kernel surface

The Mission MVP kernel owns these operations:

- `createMission`
- `loadMission`
- `resumeMission`
- `startIteration`
- `recordLaneSummary`
- `commitIteration`
- `computeDelta`
- `judgeMissionState`
- `cancelMission`
- `finalizeMission`

The skill layer may shape UX and summaries, but it must not become the source of truth for lifecycle transitions.

Mission V2 may add orchestration artifacts such as append-only `events.ndjson`,
`source-pack.json`, `mission-brief.md`, `acceptance-contract.json`, `execution-plan.md`,
canonical `planning-transaction.json`, derived `workflow.json`, lane `briefing.md`,
lane `execution-envelope.json`, `budget.json`, `run-metrics.json`, `watchdog.json`,
and terminal `closeout.md` packages under `.omx/missions/<slug>/`. Those artifacts are
supportive context for source grounding, planning handoff, verifier guidance, stage
tracking, recovery, planning provenance, runtime observability, and lane isolation; they
do **not** supersede the kernel-owned lifecycle, lane-summary, delta, or closure
semantics described below.

Artifact roles:
- **Authoritative**: `mission.json`, iteration lane summaries, `delta.json`
- **Append-only**: `events.ndjson`
- **Canonical orchestration records**: `planning-transaction.json`
- **Derived read models**: `workflow.json`, `budget.json`, `run-metrics.json`, `watchdog.json`, `closeout.md`, `closeout.json`

## Atomic write rules

- `mission.json`, `latest.json`, iteration summaries, and `delta.json` are written with atomic temp-file + rename semantics.
- Iteration commit durability is ordered as:
  1. `mission.json`
  2. `delta.json`
  3. `latest.json`
- `latest.json` is a read model only and advances **after** iteration commit succeeds.
- Partial/torn writes must never become the authoritative latest mission state.
- `startIteration` only advances when the previous iteration has both:
  - `delta.json`
  - a matching committed `latest.json` / `mission.latest_summary_path`

## Iteration semantics

- Iterations live under `.omx/missions/<slug>/iterations/<NNN>/`.
- `startIteration` resumes the current iteration when it already exists without a committed `delta.json`.
- Once an iteration has `delta.json`, the next `startIteration` advances to a new iteration number.
- `recordLaneSummary` rejects future iterations as well as past ones.
- The iteration loop is:
  - audit
  - remediation
  - execution
  - optional hardening
  - re-audit
  - delta / closure judgment

## Late-summary reconciliation

- Lane summaries are **write once** per `<iteration, lane_type>`.
- Duplicate writes return deterministic duplicate handling instead of mutating the summary.
- `commitIteration` requires these lane summaries for the current iteration:
  - audit
  - remediation
  - execution
  - re-audit
- `hardening` is optional and only participates when the bounded fallback lane ran for that iteration.
- Summaries for older iterations are ignored as `superseded`.
- Summaries for future iterations are ignored as `future`.
- Late summaries after terminal mission states are ignored deterministically.
- Cancelled / cancelling missions take precedence over late-arriving lane summaries.

## Delta semantics

Delta comparison must surface:

- improved residuals
- unchanged residuals
- regressed residuals
- resolved residuals
- introduced residuals
- oscillating residuals
- split lineage residuals
- merge lineage residuals
- low-confidence residual identities

Lineage-aware comparison means split/merge follow-up findings should not be silently treated as wholly new work when lineage explicitly ties them back to prior residuals.

## Plateau / closure expectations

- Local green checks alone do **not** close the mission.
- Closure still requires the closure matrix to accept the fresh verifier verdict + green safety baseline.
- Terminal closure is blocked when the final verifier provenance is not a fresh read-only verifier lane distinct from non-verifier lane identities.
- Repeated unchanged findings can plateau only when the plateau policy threshold is met.
- Oscillation and ambiguous retry exhaustion follow explicit deterministic exits.

## Cancel / terminal-state expectations

- `cancelMission` yields:
  - `cancelling` when active lanes are still tracked
  - `cancelled` when no active lanes remain
- `startIteration` derives `active_lanes` from the set of lane summaries still missing for the current iteration.
- Late summaries received during `cancelling` do not mutate iteration artifacts, but they do reconcile pending lanes so the kernel can transition from `cancelling` to `cancelled` deterministically.
- Invalid lifecycle transitions are rejected instead of normalized silently.
- Terminal states are:
  - `complete`
  - `plateau`
  - `failed`
  - `cancelled`

## Collision safety

- `createMission` rejects non-terminal same-target collisions.
- Collision safety keys off the target fingerprint, not only the slug.

This keeps concurrent launches from corrupting a live mission for the same target.
