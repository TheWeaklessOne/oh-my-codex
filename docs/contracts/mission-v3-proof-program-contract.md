# Mission V3 Proof Program Contract

Defines how each Mission V3 obligation is proven.

## File
- `.omx/missions/<slug>/proof-program.json`

## Authority class
- Canonical durable contract

## Required fields
- `schema_version`
- `generated_at`
- `proof_program_id`
- `revision`
- `assurance_contract_id`
- `checker_lock_id`
- `environment_contract_id`
- `mission_id`
- `profile`
- `mandatory_lanes[]`
- `bindings[]`
- `fail_closed_rules[]`

## Binding fields
- `binding_id`
- `obligation_id`
- `proof_lane`
- `checker_refs[]`
- `command_refs[]`
- `flake_reruns`
- `fail_closed`
- `admissible_evidence_kinds[]`
- `freshness_ttl_seconds`
- `required_matrix_target`
- `required_env_hash_class`

## Semantics
- The proof program is the executable companion to the assurance contract.
- It must bind each obligation to an explicit lane/checker/command surface.
- The current runtime derives closure from obligation-linked evidence, freshness, and environment parity; strict checker/command binding enforcement is a future tightening rather than a fully enforced gate today.
