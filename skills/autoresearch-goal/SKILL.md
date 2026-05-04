---
name: autoresearch-goal
description: Durable professor-critic research workflow over Codex goal mode without reviving deprecated omx autoresearch
---

# Autoresearch Goal

Use this workflow when a research mission should be bound to Codex goal-mode focus while OMX remains the durable state owner.

## Boundary
- Do **not** use or revive the deprecated `omx autoresearch` direct launch surface.
- Do **not** claim shell commands mutate hidden Codex `/goal` state.
- Do **not** edit upstream `../../codex` or add dependencies.
- Use `get_goal`, `create_goal`, and `update_goal({status: "complete"})` only through the active Codex thread when those tools are available.

## Artifacts
`omx autoresearch-goal` writes:
- `.omx/goals/autoresearch/<slug>/mission.json`
- `.omx/goals/autoresearch/<slug>/rubric.md`
- `.omx/goals/autoresearch/<slug>/ledger.jsonl`
- `.omx/goals/autoresearch/<slug>/completion.json`

## Flow
1. Create the mission and professor-critic rubric:
   `omx autoresearch-goal create --topic "..." --rubric "..." --critic-command "..."`
2. Emit the model-facing handoff:
   `omx autoresearch-goal handoff --slug <slug>`
3. In the active Codex thread, call `get_goal`; call `create_goal` only if no active goal exists and the printed payload is the intended objective.
4. Research iteratively against the rubric. Record every critic outcome:
   `omx autoresearch-goal verdict --slug <slug> --verdict <pass|fail|blocked> --evidence "..."`
5. Completion is blocked until professor-critic validation records `verdict=pass`:
   `omx autoresearch-goal complete --slug <slug>`
6. Only after the completion audit passes, call `update_goal({status: "complete"})` for the active Codex goal.

## Completion gate
A passing professor-critic artifact is required. Assistant prose, partial tests, or a failed/blocked verdict are not sufficient.
