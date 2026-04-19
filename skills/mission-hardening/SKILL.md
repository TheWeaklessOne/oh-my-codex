---
name: mission-hardening
description: Repo-owned hardening coordinator for Mission Ralph lanes
---

# Mission Hardening Skill

Use this skill inside the **Mission hardening = Ralph** lane when the execution plan's `hardening_gate` policy says hardening is required, or when a later approved Mission plan explicitly routes a bounded hardening follow-up for a balanced mission.

## Purpose

Keep Mission itself a **thin supervisor**. The outer Mission loop should launch the hardening lane, then wait for the hardening coordinator to emit a compact `summary.json` plus the hardening sidecars under the hardening lane root.

## Lane ownership

- `execution` stays `team`
- `hardening` stays `ralph`
- `re_audit` stays a fresh direct verifier lane

Do **not** move the inner code-edit loop into the long-lived Mission supervisor.

## Required bounded loop

Inside the hardening lane, run exactly this bounded sequence:

1. Run `codex-parallel-review`
2. Synthesize only blocking/high-confidence findings
3. Apply fixes
4. Re-run verification
5. Repeat steps 1-4 up to the plan's `max_review_fix_cycles`
6. Run **one** `ai-slop-cleaner` pass on changed files only
7. Re-run verification after the deslop pass
8. Run one final review sanity pass
9. Write:
   - `review-cycle-1.json` … `review-cycle-N.json`
   - `deslop-report.md`
   - `final-review.json`
   - `gate-result.json`
   - compact `summary.json`

## Engine policy

- Preferred review engine: `codex-parallel-review`
- If the hardening policy requires that engine and it is unavailable, fail fast with an explicit hardening error unless the policy explicitly allows a fallback review engine.
- Do **not** silently skip the review stage.

## Summary contract

- Keep `summary.json` compact.
- Store detailed review/deslop/final-review evidence in the sidecar artifacts listed above.
- Point `summary.json` evidence refs at those sidecars instead of embedding the full loop transcript.
