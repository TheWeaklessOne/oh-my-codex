# Mission V3 Command Attestations Contract

Records append-only command execution attestations used by Mission V3 proof lanes.

## File
- `.omx/missions/<slug>/command-attestations.ndjson`

## Authority class
- Append-only journal

## Required payload fields
- `command_attestation_id`
- `lane_run_id`
- `checker_id` or `command_ref`
- `normalized_argv` or command-template resolution
- `cwd`
- `env_hash`
- `network_mode`
- `write_scope`
- `started_at`
- `completed_at`
- `exit_code`
- `stdout_hash`
- optional `stderr_hash`
- `produced_artifact_hashes[]`

## Semantics
- Command attestations link proof evidence back to an explicit checker/command surface.
- They capture the environment and write scope used for execution.
- Lane runs and evidence events should reference these attestations rather than embedding raw command claims directly.
