# Mission V3 Assurance Contract

Defines the blocking proof obligations for a Mission V3 run.

## File
- `.omx/missions/<slug>/assurance-contract.json`

## Authority class
- Canonical durable contract

## Required fields
- `schema_version`
- `generated_at`
- `assurance_contract_id`
- `revision`
- `mission_id`
- `source_pack_ref`
- `brief_ref`
- `profile`
- `obligations[]`

## Obligation fields
- `obligation_id`
- `class`
- `description`
- `blocking_severity`
- `required_evidence_kinds[]`
- `waiver_allowed`
- `waiver_authority`
- `freshness_ttl_seconds`
- `required_env_profile`
- `required_lane`
- optional `not_applicable_reason`

## Semantics
- Blocking obligations must be `satisfied` or `waived` before the mission may become `verified`.
- Contract changes advance `revision` and must be journaled through `contract-amendments.ndjson`.
- Earlier proof can become stale when a later amendment supersedes the obligation surface.
