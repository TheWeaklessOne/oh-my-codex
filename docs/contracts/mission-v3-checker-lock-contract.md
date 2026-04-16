# Mission V3 Checker Lock Contract

Freezes the trusted checker surface for a Mission V3 run.

## File
- `.omx/missions/<slug>/checker-lock.json`

## Authority class
- Canonical durable contract

## Required fields
- `schema_version`
- `generated_at`
- `checker_lock_id`
- `mission_id`
- `revision`
- `profile`
- `checkers[]`

## Checker entry fields
- `checker_id`
- `checker_version`
- `runner_class`
- `expected_output_schema`
- `allowed_command_templates[]`
- `required_capabilities[]`
- `required_env_profile`
- `allowed_source_trust_inputs[]`

## Semantics
- Prefer checker IDs and locked templates over free-form shell.
- The current runtime records checker metadata and expected constraints in attestations/rebuild surfaces; it does not yet act as a full execution-time gate for `allowed_command_templates[]` or `allowed_source_trust_inputs[]`.
- Raw shell should therefore be treated as policy- and trust-sensitive by higher-level orchestration, not as fully blocked by the checker-lock artifact alone.
- Contract changes must be revisioned and journaled through `contract-amendments.ndjson`.
