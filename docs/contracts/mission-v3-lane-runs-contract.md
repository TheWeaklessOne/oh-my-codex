# Mission V3 Lane Runs Contract

Records append-only proof-lane execution history.

## File
- `.omx/missions/<slug>/lane-runs.ndjson`

## Authority class
- Append-only journal

## Required payload fields
- `lane_run_id`
- `candidate_id`
- `lane_type`
- `proof_program_id`
- `attempt_index`
- `matrix_target`
- `env_attestation_ref`
- `checker_refs[]`
- `started_at`
- `completed_at`
- `outcome`
- `exit_summary`
- `produced_artifact_refs[]`
- `command_attestation_refs[]`
- `obligation_ids[]`

## Semantics
- Lane runs are journal-first and must be reproducible/idempotent.
- Evidence should point at lane runs instead of bypassing them.
- Recovery may repair truncated tails, but must preserve prior event ordering and hash chaining.
