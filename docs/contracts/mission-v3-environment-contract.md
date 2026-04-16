# Mission V3 Environment Contract

Declares the attested execution and verification environment for a Mission V3 run.

## File
- `.omx/missions/<slug>/environment-contract.json`

## Authority class
- Canonical durable contract

## Required fields
- `schema_version`
- `generated_at`
- `env_contract_id`
- `revision`
- `mission_id`
- `runtime_base_id`
- `toolchain_versions`
- `lockfile_hashes`
- `service_inventory`
- `setup_network_allowlist[]`
- `runtime_network_allowlist[]`
- `declared_secret_scopes[]`
- `matrix_targets[]`
- `declared_environment_hash`

## Semantics
- Proof only counts when evidence references a valid environment attestation.
- Setup and runtime network permissions are resolved separately.
- Secret scopes are declared here; attestation should record only redacted fingerprints.
- High-assurance proofs fail closed when parity is stale or broken.
