# Mission V3 RFC — assurance-first autonomous mission runtime

Status: Draft (implementation baseline)  
Audience: OMX core maintainers, mission runtime owners, verifier/runtime contributors  
Primary inputs:
- `docs/mission-v2-architecture-deep-dive.md`
- `docs/contracts/mission-kernel-semantics-contract.md`
- the external Mission V2 architectural review and the follow-up critical review captured in the design discussion

---

## 1. Executive summary

Mission V2 established a strong foundation for long-running autonomous work inside OMX:

- a kernel-owned lifecycle and iteration model,
- contract-first pre-loop preparation,
- append-only mission history,
- verifier isolation,
- recovery for rebuildable read models,
- and a trust model designed to resist false closure.

Mission V3 must preserve those strengths and extend them where V2 is still weakest:

- verifier completeness,
- environment ownership,
- proof-oriented closure,
- deterministic policy enforcement,
- controlled portfolio search under one target authority,
- and trace/eval learning loops.

The central position of this RFC is:

> Mission V2 is already a trustworthy mission supervisor.  
> Mission V3 must become a trustworthy engineering proof system.

This RFC is implementation-oriented. Compared with the earlier V3 drafts, it intentionally freezes eight additional surfaces before coding begins:

1. **Completion semantics are split cleanly.**  
   `verified`, `candidate_selected`, `promotion_ready`, `released`, and `handed_off` are separate facts.

2. **Authority boundaries are explicit.**  
   Every artifact family is classified as authoritative mutable state, append-only journal, canonical durable contract, or derived view.

3. **Time-varying state is journal-first.**  
   Evidence, candidate comparison, policy decisions, promotion decisions, uncertainty, compaction, and environment attestations are append-only first and view-derived second.

4. **Assurance is executable, not just declarative.**  
   `assurance-contract.json` defines obligations; `proof-program.json` defines the proof procedure; `checker-lock.json` freezes the trusted checker surface.

5. **Proof artifacts become attestable.**  
   Lane runs, command executions, environment materialization, and evidence production are all linkable and auditable.

6. **Policy is deterministic.**  
   Guardrails, source-trust enforcement, write scopes, secret brokering, and promotion governance become platform surfaces rather than prompt wishes.

7. **Long-horizon memory is explicit.**  
   Decision logs, uncertainty tracking, compaction snapshots, and status ledgers become first-class runtime outputs.

8. **Learning is promotion-controlled.**  
   Traces and evals may improve the system, but only via shadow evaluation, held-out validation, and explicit rollout.

Mission V3 is therefore proposed as a five-surface system:

- **Intent Plane** — grounded sources, mission brief, contracts, profile resolution
- **Execution Plane** — candidates, role lanes, isolated workspaces, implementation outputs
- **Assurance Plane** — proof-producing verification fabric
- **Control Plane** — policy, guardrails, secrets, promotion, quality watchdogs
- **Learning Plane** — traces, evals, postmortems, safe promotion of learned improvements

This RFC is intended to be strong enough to guide artifact design, contract writing, recovery semantics, and rollout sequencing—not only discussion.

---

## 2. Problem statement

Mission V2 solves the V2 problem well:

- start from grounded inputs,
- keep the kernel authoritative,
- require fresh verifier outputs for closure,
- isolate verifier lanes,
- preserve replayable read models,
- and recover from crash/drift windows.

However, Mission V2 still has important gaps for a true **max-autonomy / max-quality** mode:

1. **Planning remains artifact-driven rather than kernel-owned.**  
   This is a documented V2 limitation and remains acceptable, but it must now be paired with stronger proof contracts.

2. **Verifier freshness is stronger than verifier completeness.**  
   V2 proves the verifier is fresh and isolated better than it proves the verifier executed a sufficiently rich proof program.

3. **Optional hardening is optimized for bounded efficiency, not maximal confidence.**  
   That is the right V2 default, but not the right top-level policy for quality-first missions.

4. **Environment ownership is incomplete.**  
   Worktree/snapshot isolation exists, but a deterministic environment contract with attestation semantics does not yet sit beside the mission contract.

5. **Telemetry is runtime-economic, not assurance-economic.**  
   V2 measures time, retries, stage counts, and ambiguity, but not proof depth, contradiction counts, stale evidence burden, or validated-surface coverage.

6. **Closeout is evidence-indexed, but not claim-bound.**  
   V2 lacks a first-class claim→evidence graph and a precise distinction between observed, derived, claimed, waived, and contradicted evidence.

7. **Same-target safety blocks duplication, but does not yet enable controlled portfolio search.**  
   V3 needs one target authority with multiple subordinate candidates under policy.

8. **Mission history is auditable, but not yet a learning flywheel.**  
   V2 reconstructs what happened, but does not yet safely promote mission traces into skills, guardrails, evals, or policy refinements.

9. **Append-only history is not yet protocolized enough.**  
   V2 journals history, but V3 needs event envelopes, idempotency semantics, causal links, and tamper-evident chaining so recovery and audit stay trustworthy at scale.

10. **Long-horizon memory is still too implicit.**  
    V3 needs explicit compaction checkpoints, uncertainty tracking, and milestone/status surfaces so multi-hour or multi-day missions do not rot their own context.

Mission V3 exists to close those gaps without regressing V2’s kernel-first trust model.

---

## 3. Goals

### 3.1 Primary goals

Mission V3 must:

1. Preserve the V2 kernel as the authoritative owner of mission truth.
2. Upgrade closure from “fresh verifier + green safety baseline” to “blocking proof obligations satisfied.”
3. Introduce a first-class deterministic environment contract for executor and verifier lanes.
4. Add executable proof programs that bind obligations to lanes, checkers, commands, freshness windows, and environments.
5. Freeze the trusted checker surface per mission.
6. Support multiple candidate execution strategies under one umbrella mission and one target authority.
7. Expand verification into a layered, risk/profile-driven assurance fabric.
8. Introduce a policy plane for tools, network, source trust, third-party content, secrets, risky writes, and promotion.
9. Treat plateau as a strategy-search trigger before it becomes a terminal mission state.
10. Turn traces and failures into reusable evaluation and learning assets with explicit rollout control.
11. Preserve crash safety, auditability, idempotency, and rebuild semantics as first-class constraints.
12. Make long-horizon progress inspectable through durable memory and compaction artifacts.

### 3.2 Non-goals

Mission V3 does **not** aim to:

- replace the kernel with the event log,
- make every mission run the maximal verification ladder regardless of risk,
- eliminate human review from high-risk or destructive actions,
- silently self-modify skills or policy from learned traces,
- collapse all mission artifacts into one file or one authority surface,
- or treat public coding benchmarks as sufficient proof of real-world capability.

V3 extends V2’s trust architecture; it does not discard it.

---

## 4. Core semantic model

### 4.1 Verification vs selection vs promotion vs release

Mission V3 explicitly retires the overloaded intuition that one terminal word can mean all of the following:

- “the code appears correct,”
- “the winning candidate was chosen,”
- “promotion is allowed,”
- “release already happened.”

Those are separate facts with separate transitions.

### 4.2 Mission terms

#### Umbrella mission
The single authoritative mission for a target fingerprint.
It owns:

- target authority,
- umbrella lifecycle,
- selected candidate reference,
- proof obligation summaries,
- policy/profile resolution,
- and terminal release/handoff facts.

#### Candidate
A subordinate execution strategy under the umbrella mission.
Candidates may run serially or in parallel depending on policy.

#### Obligation
A proof requirement from the assurance contract, such as functional correctness, regression safety, invariant preservation, security, performance, migration safety, operability, or release readiness.

#### Checker
A trusted validation surface used by the proof program.
Examples: a typechecker runner, impact-map builder, benchmark harness, UI regression runner, or internal adjudicator.

#### Checker lock
The mission-local frozen resolution of checker identities, versions, capability classes, and permitted command templates for the proof program.

#### Proof program
The executable verification plan that binds each obligation to:

- concrete lanes,
- concrete checkers,
- concrete commands or command references,
- admissible evidence,
- freshness TTL,
- flake policy,
- required matrix target,
- and required environment attestation.

#### Claim
A machine-readable statement that may appear in closeout or promotion logic, such as “core behavior fixed,” “no blocking regressions detected,” or “release-smoke passed.”
Claims are not authoritative by themselves; they must be backed by evidence.

#### Waiver
A first-class decision allowing a specific obligation or policy clause to proceed without its normal proof requirements under a defined authority, rationale, scope, expiry, and compensating controls.

#### Promotion
The policy-controlled act of making a verified candidate eligible for the chosen external outcome.
Promotion is **not** verification and **not** release.

#### Release / handoff
The actual terminal externalization of mission output:

- released,
- handed off for review,
- or otherwise delivered.

### 4.3 Operating profiles (separate axes)

Mission V3 separates three concerns that should not be forced into one `risk_class`.

#### `risk_class`
How dangerous the change is if wrong.
Examples:

- `low-risk-local`
- `cross-cutting-refactor`
- `security-sensitive`
- `ui-critical`
- `migration-sensitive`
- `release-blocking`

#### `assurance_profile`
How much proof is required.
Examples:

- `balanced`
- `high`
- `max-quality`

#### `autonomy_profile`
What may proceed without external review.
Examples:

- `guarded`
- `semi-auto`
- `max-auto`

These three axes compile into the proof program, candidate spawn policy, policy clauses, and promotion policy.

### 4.4 Source trust classes

All grounded sources in V3 must carry a trust label:

- `trusted` — repo-tracked authoritative files, signed internal contracts, explicit operator input
- `semi_trusted` — first-party docs or tools outside the repo but controlled by the same org
- `untrusted` — web pages, third-party issues, copied external content
- `quote_only` — may inform summaries or quotes, but cannot directly drive execution decisions
- `execution_forbidden` — must never be executed, transformed into commands, or used to auto-amend policy/contracts

Source-trust labels are inputs to the control plane and must survive compaction, replay, evidence generation, and learning.

### 4.5 Third-party content policy

Trust and licensing are separate concerns.
Every external content reference that may influence code, tests, docs, or policy should carry:

- source trust class,
- provenance metadata,
- license or usage classification when known,
- incorporation policy (`reference_only`, `quote_only`, `review_required`, `allowed_with_attribution`),
- and any security or privacy warnings.

Unreviewed third-party code or text must never be silently copied into the repository, contracts, or checker surfaces.

---

## 5. State model

### 5.1 Umbrella mission lifecycle

Mission V3 uses explicit lifecycle states that separate proof completion from externalization.

### Authoritative mission states

- `bootstrapping`
- `planning`
- `blocked_external`
- `executing`
- `assuring`
- `verified`
- `promotion_ready`
- `released`
- `handed_off`
- `plateau`
- `failed`
- `cancelled`

### Interpretation

- `blocked_external` means progress is blocked by a non-strategy cause such as missing credentials, unavailable dependency, required human decision, or unavailable environment materialization.
- `verified` means a selected candidate has satisfied all blocking proof obligations under current policy.
- `promotion_ready` means the promotion governor has approved the verified result for the target destination.
- `released` means the result was actually promoted or released.
- `handed_off` means the result was externally delivered for review or takeover instead of auto-release.
- `plateau` means all permitted strategy mutations and candidate expansions were exhausted without satisfying exit criteria.

### Critical rule

Mission V3 does **not** use `complete` as the umbrella terminal word, because that collapses proof completion and external promotion.

### 5.2 Authoritative mission fields

`mission.json` remains authoritative and should include at minimum:

- `mission_id`
- `target_fingerprint`
- `status`
- `active_candidate_id`
- `selected_candidate_id`
- `candidate_ids[]`
- `assurance_contract_id`
- `proof_program_id`
- `checker_lock_id`
- `environment_contract_id`
- `policy_profile`
- `verification_state`
- `promotion_state`
- `plateau_strategy_state`
- `kernel_blockers[]`
- `latest_authoritative_iteration_ref`
- `latest_authoritative_adjudication_ref`

`selected_candidate_id` becomes authoritative once chosen. Selection is **not** promotion and **not** release.

### 5.3 Candidate lifecycle

Each candidate is a first-class subordinate state machine.

### Candidate states

- `proposed`
- `approved`
- `running`
- `blocked`
- `stalled`
- `superseded`
- `rejected`
- `selected`
- `archived`

### Candidate invariants

- A candidate may write only within its own isolated workspace and artifact scope.
- Stale writes from superseded or archived candidates must be rejected deterministically.
- A candidate becomes `selected` only through an authoritative umbrella selection decision.
- A candidate synthesized from others must get a **new candidate ID**.
- Cherry-pick/merge between candidates may never silently mutate an existing candidate lineage.
- A selected candidate may be rescinded only through an authoritative rescission decision when blocking contradictions or staleness invalidate the selection before release.

### 5.4 Obligation state machine

Each obligation must have an explicit state.

### Obligation states

- `planned`
- `running`
- `satisfied`
- `contradicted`
- `waived`
- `deferred`
- `not_applicable`
- `stale`

### Core rules

- `satisfied -> stale` when evidence TTL expires, required environment parity breaks, checker lock changes, or a later contract amendment supersedes the proof.
- `running|satisfied -> contradicted` when blocking contradictory evidence arrives.
- `planned|running -> deferred` only when policy permits deferral.
- `waived` requires a first-class waiver object with authority, scope, rationale, expiry, and compensating controls.
- `not_applicable` requires a typed reason and adjudicator confirmation.

Blocking obligations must be `satisfied` or `waived` before mission state may move to `verified`.

### 5.5 Waiver objects

Waivers are first-class signed or policy-approved objects, not free-form notes.

Required waiver fields:

- `waiver_id`
- `obligation_ids[]` and/or `policy_clause_ids[]`
- `scope`
- `authority`
- `rationale`
- `compensating_controls[]`
- `expires_at`
- `evidence_refs[]`
- `created_at`

Waivers are append-only decisions and must be journaled.

### 5.6 Reopen and rescission rules

Mission V3 must support authoritative demotion before release.

#### Before `released` or `handed_off`

If blocking contradictory evidence arrives, environment parity breaks, checker resolution changes incompatibly, or a blocking obligation goes stale:

- `promotion_ready -> assuring`
- `verified -> assuring`
- selected-candidate status may remain `selected`, or may be rescinded if policy or adjudication requires reselection
- any prior promotion permission is invalidated and must be re-earned

#### After `released`

A released mission is immutable for closure semantics.
Any newly discovered issue must create:

- a follow-up mission,
- a rollback/release incident,
- or an external remediation process,

but must not silently reopen or rewrite the released mission’s authoritative truth.

---

## 6. Authority, journal, and rebuild model

### 6.1 Artifact trust classes

The following table freezes artifact trust classes for V3.

| Artifact family | Owner | Trust class | Mutation model | Rebuild source | Notes |
|---|---|---|---|---|---|
| `mission.json` | kernel | authoritative mutable | atomic rewrite | none | umbrella truth |
| `candidates/<id>/candidate-state.json` | kernel | authoritative mutable | atomic rewrite | none | per-candidate truth |
| iteration lane summaries | kernel | authoritative write-once | append-by-file | none | same semantics as V2 lane truth |
| `delta.json` | kernel | authoritative write-once | append-by-iteration | none | closure-critical |
| `source-pack.json` | orchestration compiler | canonical durable | immutable by revision | none | includes source trust + provenance |
| `mission-brief.md` | orchestration compiler | canonical durable | immutable by revision | none | human-readable summary |
| `assurance-contract.json` | orchestration compiler | canonical durable | immutable by revision | none | proof obligations |
| `proof-program.json` | orchestration compiler | canonical durable | immutable by revision | none | executable proof plan |
| `checker-lock.json` | checker resolver | canonical durable | immutable by revision | none | freezes checker identities and versions |
| `environment-contract.json` | environment kernel | canonical durable | immutable by revision | none | declared environment lock |
| `contract-amendments.ndjson` | policy/orchestration | append-only | append-only | none | amendment journal |
| `events.ndjson` | runtime bridge | append-only | append-only | none | umbrella history |
| `candidate-events.ndjson` | runtime bridge | append-only | append-only | none | candidate history |
| `evidence-events.ndjson` | assurance plane | append-only | append-only | none | evidence journal |
| `lane-runs.ndjson` | execution/assurance runtime | append-only | append-only | none | lane attempt history |
| `command-attestations.ndjson` | command runner | append-only | append-only | none | exact command execution records |
| `environment-attestations.ndjson` | environment kernel | append-only | append-only | none | setup/materialization attestations |
| `runtime-observations.ndjson` | lanes/runtime | append-only | append-only | none | observed env/runtime facts |
| `policy-decisions.ndjson` | control plane | append-only | append-only | none | grants, denials, clause outcomes |
| `promotion-events.ndjson` | promotion governor | append-only | append-only | none | promotion decision history |
| `decision-log.ndjson` | umbrella mission | append-only | append-only | none | major system/operator decisions |
| `uncertainty-events.ndjson` | control plane | append-only | append-only | none | uncertainty lifecycle journal |
| `compaction-events.ndjson` | context compiler | append-only | append-only | none | compaction/checkpoint history |
| `uncertainty-register.json` | control plane | derived view | rebuildable | uncertainty journal + decision log | current unresolved set |
| `workflow.json` | workflow reconciler | derived view | rebuildable | authoritative state + events | not truth |
| `status-ledger.md` | operator view builder | derived view | rebuildable | decision log + candidate state + uncertainty register | human-readable progress surface |
| `impact-map.json` | assurance reconciler | derived view | rebuildable | static analysis + test graph + lane runs | consumed by impacted-tests |
| `evidence-graph.json` | assurance reconciler | derived view | rebuildable | evidence journal + contracts + waivers | claim/evidence graph |
| `candidate-tournament.json` | tournament reconciler | derived view | rebuildable | candidate journal + evidence graph + policy | not truth |
| `policy-snapshot.json` | control plane | derived view | rebuildable | policy decisions + contracts + profiles | current resolved policy |
| `quality-watchdog.json` | control plane | derived view | rebuildable | metrics + obligations + evidence freshness | blocking only through explicit clause outcomes |
| `promotion-decision.json` | promotion reconciler | derived view | rebuildable | promotion events + policy + evidence graph | latest promotion view |
| `environment-current.json` | environment reconciler | derived view | rebuildable | environment attestation + observations | current parity view |
| `context-snapshots/*.json` | context compiler | derived view | rebuildable | authoritative state + journals + compaction events | lane-scoped memory checkpoints |
| `closeout.json/.md` | closeout builder | derived view | rebuildable | authoritative state + journals + derived views | terminal package |

### 6.2 Common artifact conventions

To keep V3 artifacts interoperable and migration-safe, the following conventions apply across all JSON and NDJSON surfaces:

- every structured artifact must declare `schema_version`
- every timestamp must use RFC3339 UTC
- every stable identifier should use a typed prefix (for example `mission:`, `candidate:`, `obl:`, `checker:`, `env:`)
- every content digest should use one project-wide digest format and algorithm (default: SHA-256)
- every cross-artifact pointer should use explicit typed refs (`*_ref`, `*_refs[]`) rather than positional assumptions
- every authoritative rewrite must be atomic, and every append-only journal append must be idempotent

These conventions are intentionally boring. They reduce recovery ambiguity, simplify tooling, and prevent silent drift between artifact families.

### 6.3 Common journal envelope

Every append-only journal event in V3 must use a common envelope with at least:

- `event_id`
- `schema_version`
- `journal_type`
- `sequence`
- `recorded_at` (RFC3339 UTC)
- `mission_id`
- `candidate_id` (optional)
- `lane_id` (optional)
- `actor_principal`
- `causation_ref`
- `correlation_ref`
- `idempotency_key`
- `prev_event_hash`
- `payload_hash`
- `payload`

#### Rules

- `sequence` is monotonically increasing per journal file.
- `idempotency_key` must make replay after crash safe.
- `prev_event_hash` and `payload_hash` make journals tamper-evident.
- Recovery-generated events must be marked as such and may never masquerade as original runtime events.
- Journal parsing must remain tolerant of crash-truncated tails, but repaired events must preserve causal correctness.

### 6.4 Write ordering

For closure-critical transitions, Mission V3 preserves deterministic write discipline:

1. authoritative mutable state (`candidate-state.json`, then `mission.json` if needed)
2. authoritative iteration outputs (`delta.json`, lane summaries where applicable)
3. append-only journal entries for the same transition family
4. derived views (`workflow.json`, `impact-map.json`, `evidence-graph.json`, `policy-snapshot.json`, `promotion-decision.json`, `status-ledger.md`, `closeout.json`)

### 6.5 Recovery rule

If a crash occurs after authoritative state writes but before journals or derived views are updated:

- authoritative state remains the source of truth,
- journals may be backfilled by recovery with synthesized gap events marked as recovery-generated,
- derived views must be rebuilt from authoritative state + journals,
- stale or duplicate journal append attempts must be rejected via `idempotency_key`,
- no derived view may invent authority or override authoritative files.

---

## 7. Artifact families

### 7.1 Canonical durable contracts

Canonical durable contracts are immutable by revision and treated as durable inputs to execution and assurance.

### Required V3 contract artifacts

- `source-pack.json`
- `mission-brief.md`
- `assurance-contract.json`
- `proof-program.json`
- `checker-lock.json`
- `environment-contract.json`

### 7.2 Contract amendment model

Contracts evolve via append-only `contract-amendments.ndjson`, not silent in-place mutation.
The latest effective contract view may be materialized as a derived artifact if needed, but amendment history is durable.

### 7.3 Authoritative mutable state

These files define current truth and must be updated atomically:

- `mission.json`
- `candidates/<id>/candidate-state.json`
- iteration lane summaries
- `delta.json`

These are the only files that should directly determine mission status, candidate status, or obligation resolution outcomes.

### 7.4 Append-only journals

Mission V3 prefers journals over mutable singleton JSON for anything that changes over time.

### Required journals

- `events.ndjson`
- `candidate-events.ndjson`
- `evidence-events.ndjson`
- `lane-runs.ndjson`
- `command-attestations.ndjson`
- `environment-attestations.ndjson`
- `runtime-observations.ndjson`
- `policy-decisions.ndjson`
- `promotion-events.ndjson`
- `decision-log.ndjson`
- `uncertainty-events.ndjson`
- `compaction-events.ndjson`

### 7.5 Derived views

Derived views exist for UX, audit, and operator convenience.
They must be rebuildable and clearly labeled non-authoritative.

Important derived views:

- `workflow.json`
- `status-ledger.md`
- `impact-map.json`
- `policy-snapshot.json`
- `environment-current.json`
- `evidence-graph.json`
- `candidate-tournament.json`
- `quality-watchdog.json`
- `promotion-decision.json`
- `context-snapshots/*.json`
- `closeout.json` / `closeout.md`

---

## 8. Environment Kernel

### 8.1 Purpose

Mission V3 treats environment parity as a mission concern, not a shell-side convenience.

The Environment Kernel owns:

- setup recipes,
- toolchain locks,
- service declarations,
- network policy for setup and runtime,
- secret scopes,
- environment hashing,
- attestation generation,
- environment drift detection,
- and matrix target resolution.

### 8.2 Environment artifacts

#### `environment-contract.json`
The declared environment lock.

Required fields:

- `env_contract_id`
- `revision`
- `schema_version`
- `base_image_digest` or equivalent runtime base identifier
- toolchain versions + lockfile hashes
- service inventory and versions
- setup network allowlist
- runtime network allowlist
- declared secret scopes
- matrix targets
- declared environment hash

#### `environment-attestations.ndjson`
Append-only materialization history.

Each attestation event should include:

- `attestation_id`
- `candidate_id`
- `lane_id` or `setup_run_id`
- `declared_hash`
- `achieved_hash`
- `base_image_digest`
- `toolchain_digests`
- `service_versions`
- redacted secret-scope fingerprints
- `attested_at`
- `expires_at`
- success/failure metadata

#### `runtime-observations.ndjson`
Append-only observed runtime facts from execution and assurance lanes.

Each observation should include:

- `candidate_id`
- `lane_id`
- `env_hash`
- observed toolchain/service facts
- source of observation
- `observed_at`

#### `environment-current.json`
Derived current view combining the latest valid attestation and runtime observations.

### 8.3 Environment parity rule

A proof result may only count toward `satisfied` if:

- the proof program accepts the environment-contract revision,
- the evidence references a valid environment attestation,
- the attestation is not expired,
- no contradictory runtime observation invalidates parity,
- and the matrix target required by the proof program was actually satisfied.

### 8.4 Setup secrets rule

Secrets available during setup must not automatically leak into execution or verifier lanes.
The secret broker must grant runtime secrets separately and by explicit scope.

### 8.5 Minimal local-attestation rule

Non-containerized or local missions are allowed only if they can still produce a minimum viable attestation, including:

- OS + kernel/runtime fingerprint,
- toolchain versions,
- lockfile hashes when applicable,
- service inventory,
- network mode,
- working directory boundary,
- and an achieved environment hash.

If that floor cannot be met, high-risk or high-assurance proofs must fail closed.

---

## 9. Assurance system

### 9.1 `assurance-contract.json`

This is the primary closure contract for V3.
It defines **what must be proven**, not how it is proven.

### Obligation families

- `functional`
- `regression`
- `invariant`
- `security`
- `performance`
- `migration`
- `operability`
- `release`

Each obligation must declare at least:

- `obligation_id`
- `class`
- `description`
- `blocking_severity`
- `required_evidence_kinds`
- `waiver_allowed`
- `waiver_authority`
- `freshness_ttl`
- `required_env_profile`

### 9.2 `checker-lock.json`

This freezes the trusted checker surface for the mission.
Proof programs should prefer checker IDs over free-form shell text.

Each checker lock entry should include:

- `checker_id`
- `checker_version`
- `runner_class`
- `expected_output_schema`
- `allowed_command_templates[]`
- `required_capabilities[]`
- `required_env_profile`
- `allowed_source_trust_inputs[]`

#### Rule

Raw command text is permitted only for repo-local validation commands from trusted or semi-trusted sources and only when the checker lock or policy explicitly permits it.

### 9.3 `proof-program.json`

This is the executable companion to the assurance contract.
It defines **how each obligation is proven**.

### Required fields

- `proof_program_id`
- `assurance_contract_id`
- `checker_lock_id`
- `environment_contract_id`
- `risk_class`
- `assurance_profile`
- `autonomy_profile`
- obligation-to-lane bindings
- exact validators/checkers
- validation commands or command references
- flake rerun policy
- fail-closed rules
- admissible evidence kinds
- evidence freshness TTL
- required matrix target/env hash class

### 9.4 Lane-run and command-attestation contracts

Mission V3 must not treat “a test passed somewhere” as sufficient evidence.

#### `lane-runs.ndjson`
Each lane run should record:

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

#### `command-attestations.ndjson`
Each command attestation should record:

- `command_attestation_id`
- `lane_run_id`
- `checker_id` or `command_ref`
- normalized argv or command template resolution
- `cwd`
- `env_hash`
- `network_mode`
- `write_scope`
- `started_at`
- `completed_at`
- `exit_code`
- stdout/stderr hashes
- produced artifact hashes

Evidence events should refer to lane runs and command attestations, not bypass them.

### 9.5 Verification Fabric

Mission V3 replaces “one verifier pair as the top of the trust pyramid” with a layered assurance fabric.

### Core verification lanes

- `reproduction`
- `targeted-regression`
- `impacted-tests`
- `full-suite`
- `static-analysis`
- `security`
- `performance`
- `ui-vision`
- `migration`
- `release-smoke`
- `property-checks`
- `adjudication`

### Mandatory baseline for the first V3 increment

The first increment should require at minimum:

- `reproduction`
- `targeted-regression`
- `static-analysis`
- `adjudication`

And additionally:

- `impacted-tests` for `cross-cutting-refactor`
- `security` for `security-sensitive`
- `ui-vision` for `ui-critical`
- `migration` for `migration-sensitive`
- `release-smoke` for `release-blocking`

`property-checks` should be enabled for invariant-heavy or max-quality missions when the system can infer or ingest executable properties safely.

### 9.6 Impact map and test-selection rule

`impacted-tests` should be driven by a first-class `impact-map.json` rather than vague “run some nearby tests” guidance.

`impact-map.json` should capture:

- changed code surfaces,
- mapped dependent tests,
- confidence of linkage,
- required regression slice,
- and unresolved blind spots.

Proof programs should prefer targeted impact data over generic TDD slogans.

### 9.7 Agent-written tests rule

Agent-written tests are admissible evidence, but they are not sufficient by default.
They should be treated as supplementary when:

- they are clearly linked to an obligation,
- they are executed under attested environments,
- and they do not replace independent regression or impact-based validation.

### 9.8 Adjudicator contract

The adjudicator is a read-only synthesis lane.
It must not be a free-form essay engine.

### Minimum adjudicator output

- obligation status table
- blocking contradictions
- waiver summary
- stale evidence summary
- residual risk summary
- recommended next mission state

The adjudicator may add narrative explanation, but the structured output is mandatory.

### 9.9 Closure rules

A mission may enter `verified` only when:

1. `selected_candidate_id` is set,
2. all blocking obligations for the selected candidate are `satisfied` or `waived`,
3. no blocking obligation is `contradicted` or `stale`,
4. required environment attestation remains valid,
5. all required lane runs and command attestations are present,
6. no hard policy deny remains unresolved,
7. and the adjudicator recommends `verified`.

A mission may enter `promotion_ready` only when:

1. mission state is `verified`,
2. the promotion governor returns `allow`,
3. required promotion artifacts exist,
4. and no blocking policy exception remains unresolved.

A mission may enter `released` or `handed_off` only after the corresponding promotion action is actually recorded in `promotion-events.ndjson`.

---

## 10. Execution plane

### 10.1 Umbrella mission + candidate portfolio

Mission V3 preserves **single target authority** while allowing **multiple subordinate candidates**.

### Default spawn policy

- default: 1 candidate
- allow 2 candidates when ambiguity, plateau, or task value justifies it
- allow up to 3 candidates only in `assurance_profile=max-quality` and when policy permits

### 10.2 Candidate artifact model

Candidates may spawn specialized role lanes such as explorer, implementer, refactor, docs, performance, or release lanes. Any model, tool, or skill specialization for such lanes must be resolved by policy and recorded through lane runs and context snapshots.

Each candidate should have:

- `candidate-state.json` (authoritative mutable)
- candidate-local iteration artifacts
- candidate-local lane results
- candidate-local evidence refs
- candidate-local isolation and environment refs
- candidate-local recovery and supersession metadata
- candidate-local execution plan and milestone status

### 10.3 Candidate spawn policy

The policy plane decides when a new candidate may be created.

### Allowed triggers

- explicit ambiguity unresolved after one viable strategy,
- plateau after permitted mutation within the current candidate,
- high-value or release-critical targets,
- policy-approved architecture forks.

### Disallowed triggers

- blind duplication,
- spawning without unique rationale,
- spawning beyond concurrency caps,
- spawning when the control plane requires consolidation first.

### 10.4 Tournament semantics

The candidate tournament must **not** be a single opaque score.

Tournament resolution should be:

1. **hard veto filter**
   - policy violations
   - missing blocking obligations
   - invalid environment attestation
   - unresolved contradictions
2. **structured comparison vector**
   - proof completeness
   - regression safety
   - maintainability
   - diff surface size
   - performance impact
   - release readiness
   - residual uncertainty
3. **lexicographic/Pareto selection**
   - not pure weighted averaging by default
4. **tie handling**
   - either spawn synthesis candidate, or require explicit review depending on policy

`candidate-tournament.json` must therefore be a derived view from candidate, evidence, and policy journals—not a hidden mutable scoring oracle.

### 10.5 Candidate hybridization rule

If changes from multiple candidates are combined:

- a new candidate is created,
- source candidates are referenced as parents,
- source candidates remain immutable in lineage,
- the hybrid candidate gets fresh obligations and evidence bindings,
- and the proof program must be recompiled if obligation coverage, matrix targets, checker bindings, or policy obligations changed materially.

### 10.6 Candidate milestone rule

Each candidate should maintain a milestone-oriented execution plan with:

- scoped milestones,
- milestone-level validation commands,
- stop-and-fix semantics,
- decision notes,
- and explicit next-step visibility.

The system should continuously rebuild a human-readable `status-ledger.md` so long-horizon progress remains inspectable without reading raw journals.

### 10.7 Plateau as strategy mutation

Plateau should usually mean:

> the current candidate strategy is exhausted; attempt a permitted strategy mutation or new candidate before umbrella plateau.

Only after allowed strategy mutations and allowed candidate portfolio expansions are exhausted may the umbrella mission itself plateau.

---

## 11. Control plane

### 11.1 Policy model

The policy plane resolves:

- risk class,
- assurance profile,
- autonomy profile,
- lane capability classes,
- network permissions,
- write scope,
- secret scopes,
- promotion permissions,
- candidate parallelism,
- third-party incorporation policy,
- and required deterministic guardrails.

This is materialized in append-only `policy-decisions.ndjson` and derived `policy-snapshot.json`.

### 11.2 Policy clause types

Every resolved policy clause should yield one of the following outcomes:

- `allow`
- `allow_with_attestation`
- `deny`
- `require_review`
- `require_waiver`
- `require_revalidation`

Only explicit clause outcomes may become kernel-consumable blockers.

### 11.3 Deterministic guardrails

Mission V3 must expose first-class guardrails rather than treating them as advisory prompt text.

### Required guardrail surfaces

- hooks / pre-post execution guards
- command allow/deny rules
- path protections
- required checks before selected actions
- required checks before promotion
- source-trust enforcement
- unsafe write denials
- external execution denials for untrusted sources

These guardrails are part of the platform and must remain effective even if a model proposes to bypass them.

### 11.4 Source trust and prompt-injection defense

All non-repo or external sources must be treated as untrusted until labeled otherwise.

### Control rules

- `untrusted` or `execution_forbidden` sources may never directly generate shell commands, checker resolutions, or policy amendments.
- `quote_only` sources may contribute narrative summaries but may not mutate contracts or proof programs.
- Planner, verifier, context compiler, and learning components must preserve source-trust labels in their outputs.
- External research may inform candidate generation, but only corroborated facts may enter proof obligations, checker locks, or promotion decisions.

### 11.5 Third-party incorporation rule

The control plane must be able to deny or gate:

- copying external code into the repository,
- adding new dependencies,
- importing content with unknown licensing,
- or materializing examples from untrusted web pages into executable artifacts.

When such content is allowed, the resulting evidence and closeout must record provenance and any required attribution or review.

### 11.6 Secret broker

The secret broker must:

- grant secrets by named scope,
- log grants/denials in `policy-decisions.ndjson`,
- keep setup secrets separate from execution/verifier secrets,
- expire or revoke scopes when candidate/lane/mission state changes.

### 11.7 Quality watchdog

Mission V3 adds quality economics to runtime economics.

### Example watchdog metrics

- unresolved blocking obligations
- stale evidence count
- contradiction count
- verifier disagreement rate
- impacted-surface vs validated-surface ratio
- waiver count
- uncertainty burden
- policy-exception count
- candidate spread and stagnation

### Watchdog outcomes

- `continue`
- `warn`
- `escalate`
- `force_assurance`
- `require_strategy_mutation`
- `block_promotion`

The quality watchdog remains a derived control-plane view, but its blocking outputs may be consumed by the kernel only via explicit policy clause outcomes.

### 11.8 Kernel-consumable blockers

To prevent authority leakage, the kernel may consume only a narrow blocker set:

- invalid environment parity for required proofs,
- blocking obligations in `contradicted` or `stale`,
- unresolved `deny`/`require_review`/`require_waiver`/`require_revalidation` policy clauses,
- active promotion block,
- and selected-candidate rescission.

No other derived metric may directly change mission truth.

### 11.9 Context Compiler

Mission V3 keeps the Context Compiler as a first-class platform surface.

The Context Compiler produces lane-specific context bundles from:

- AGENTS hierarchy,
- mission brief,
- assurance contract,
- proof program,
- checker lock,
- environment contract,
- policy snapshot,
- source-trust labels,
- selected candidate state,
- latest validated evidence,
- uncertainty register,
- and the latest context snapshot.

Outputs should include:

- lane-specific prompt/context bundles,
- explicit authoritative-vs-derived markers,
- stale-fact markers,
- compacted history summaries,
- allowed-decision boundaries for the lane.

The compiler must never silently drop trust labels or turn untrusted material into authoritative instruction text.

### 11.10 Compaction and memory checkpoints

Long-horizon missions need explicit memory control.

`compaction-events.ndjson` should record:

- snapshot creation,
- source ranges summarized,
- unresolved uncertainty carried forward,
- stale facts intentionally dropped,
- and validation of the new snapshot.

`context-snapshots/*.json` should be rebuildable memory checkpoints that new lanes can consume without replaying the full mission history.

---

## 12. Uncertainty and contract evolution

### 12.1 `uncertainty-events.ndjson` + `uncertainty-register.json`

Long-horizon missions need explicit uncertainty tracking.

Each uncertainty should carry:

- `uncertainty_id`
- `statement`
- `class`
- `candidate_scope`
- `blocking_for`
- `status` (`open`, `resolved`, `parked`, `superseded`)
- `owner`
- `last_reviewed_at`
- `resolution_strategy`

Plateau and strategy-mutation logic must consult this register.

### 12.2 `decision-log.ndjson`

Major decisions should be recorded append-only, including:

- candidate spawn approvals/denials,
- candidate selection or rescission,
- waiver creation,
- proof-program overrides,
- amendment approvals,
- promotion actions,
- release or handoff decisions.

### 12.3 Contract amendments

Contracts must evolve by append-only amendment, not silent overwrite.

Use `contract-amendments.ndjson` to record:

- amendment id
- target contract
- rationale
- authority
- scope
- resulting revision ref
- affected obligations, checker bindings, environment clauses, or policy clauses

The effective contract view may be derived from base contract + amendment journal.

---

## 13. Learning plane

### 13.1 Trace store

Mission traces should be normalized into `trace-bundle.json` with at least:

- prompt/context bundle hashes,
- candidate and lane IDs,
- tool calls,
- command attestations,
- env hashes,
- artifact hashes,
- verdicts,
- timings,
- supersession links.

### 13.2 Eval bundle

`eval-bundle.json` should capture:

- failing prompts or mission fragments,
- grader inputs and outputs,
- counterexamples,
- residual patterns,
- lessons for skills/policy/guardrails,
- held-out eval references where applicable.

### 13.3 Benchmark hygiene rule

Public benchmarks are useful but insufficient.
V3 learning and promotion policy should prioritize:

- held-out internal tasks,
- mutated prompt corpora,
- regression corpora from real mission failures,
- contamination checks for any public benchmark used,
- and benchmark sets that measure both resolution and regression behavior.

### 13.4 Learning promotion path

No learning output may silently update live behavior.

Each proposed learned improvement must move through a rollout path:

- `captured`
- `shadow_evaluated`
- `approved_for_rollout`
- `rejected`
- `superseded`

This applies to:

- skill updates,
- policy updates,
- context-compiler heuristics,
- adjudicator templates,
- source-trust heuristics,
- checker defaults.

### 13.5 Safe promotion rule

A trace or eval output may only affect runtime behavior after:

1. shadow evaluation,
2. held-out evaluation,
3. explicit approval,
4. and an audit trail linking the promoted change to its source traces.

---

## 14. Threat model and failure taxonomy

Mission V3 needs an explicit threat model.

### Core failure classes

- `false_closure`
- `false_regression`
- `stale_evidence`
- `environment_drift`
- `candidate_contamination`
- `prompt_injection`
- `third_party_content_violation`
- `waiver_abuse`
- `authority_leakage`
- `journal_tampering`
- `silent_self_modification`
- `flake_misclassification`
- `stale_compaction`
- `promotion_race`

### Design intent by class

- `false_closure` → blocked by obligation state machine + proof program + adjudicator + promotion governor
- `stale_evidence` → blocked by TTL + environment attestation + obligation `stale`
- `candidate_contamination` → blocked by candidate isolation + stale-write rejection + lineage rules
- `prompt_injection` → blocked by source-trust classes + command/path guardrails + restricted network policy
- `third_party_content_violation` → blocked by provenance + incorporation policy + policy gates on copying/importing
- `authority_leakage` → blocked by authority matrix + journal/derived separation + kernel-only terminal semantics
- `journal_tampering` → exposed by hash chaining + payload hashing + sequence/idempotency checks
- `silent_self_modification` → blocked by learning promotion path and reviewable rollout
- `stale_compaction` → blocked by snapshot validation + carried uncertainty + authoritative replay fallback
- `promotion_race` → blocked by explicit promotion events + state demotion rules + release immutability

---

## 15. Proposed filesystem layout

```text
.omx/missions/<slug>/
  mission.json                         # authoritative umbrella truth
  events.ndjson                        # append-only umbrella history
  workflow.json                        # derived workflow view
  latest.json                          # derived latest summary view
  status-ledger.md                     # derived human-readable progress view

  source-pack.json                     # canonical durable input
  mission-brief.md                     # canonical durable brief
  assurance-contract.json              # canonical durable proof obligations
  proof-program.json                   # canonical durable executable proof plan
  checker-lock.json                    # canonical durable checker resolution
  contract-amendments.ndjson           # append-only contract amendments

  environment-contract.json            # canonical durable env lock
  environment-attestations.ndjson      # append-only attestation journal
  runtime-observations.ndjson          # append-only observed env/runtime facts
  environment-current.json             # derived env parity view

  policy-decisions.ndjson              # append-only policy decisions
  policy-snapshot.json                 # derived current policy
  quality-watchdog.json                # derived quality watchdog view

  evidence-events.ndjson               # append-only evidence journal
  lane-runs.ndjson                     # append-only lane run history
  command-attestations.ndjson          # append-only command execution records
  impact-map.json                      # derived changed-surface/test map
  evidence-graph.json                  # derived claim/evidence graph

  promotion-events.ndjson              # append-only promotion history
  promotion-decision.json              # derived latest promotion view

  decision-log.ndjson                  # append-only key decisions
  uncertainty-events.ndjson            # append-only uncertainty history
  uncertainty-register.json            # derived current uncertainty view
  compaction-events.ndjson             # append-only compaction history
  context-snapshots/                   # derived lane-scoped memory checkpoints

  candidates/
    candidate-001/
      candidate-state.json             # authoritative candidate truth
      candidate-events.ndjson          # append-only candidate history
      execution-plan.md                # candidate-local plan view
      iterations/
      assurance/
        lane-results/
        evidence/

  candidate-tournament.json            # derived comparison view

  traces/
    trace-bundle.json
    eval-bundle.json
    postmortem.md
    learning-proposals/

  closeout.json
  closeout.md
```

---

## 16. Backward compatibility with Mission V2

Mission V3 should be introduced incrementally and preserve V2 semantics where possible.

### Must preserve

- kernel lifecycle authority,
- mission slug + target fingerprint model,
- same-target collision protection at umbrella level,
- V2 lane summary and delta semantics,
- verifier isolation semantics,
- rebuildable derived views,
- crash-safe write ordering principles.

### Compatibility strategy

- keep `acceptance-contract.json` as a generated compatibility artifact/view where useful,
- expose a derived compatibility `complete` view to V2-facing consumers when V3 state is `verified`,
- introduce V3 contracts alongside V2 artifacts,
- gate V3 closure semantics behind explicit mission versioning,
- ensure recovery paths can reason about both V2 and V3 artifact families,
- keep V2-derived closeout working during migration.

### Canonical source shift

In V3, the canonical source of truth for closure becomes:

- `assurance-contract.json` + `proof-program.json` + `checker-lock.json` + authoritative state,

while `acceptance-contract.json` becomes a compatibility and human-readable view where retained.

---

## 17. Rollout plan

The rollout order is intentionally stricter than the earlier drafts.

### Phase 0 — semantic freeze

Deliverables:

- authority and rebuild matrix accepted,
- lifecycle terminology frozen,
- mission/candidate/obligation state machines accepted,
- source-trust taxonomy and third-party content policy accepted,
- journal envelope and idempotency semantics accepted.

Exit criteria:

- no implementation begins before authority boundaries and event protocol are frozen.

### Phase 1 — Environment Kernel + checker surface + journal protocol

Deliverables:

- `environment-contract.json`
- `environment-attestations.ndjson`
- `runtime-observations.ndjson`
- `checker-lock.json`
- `lane-runs.ndjson`
- `command-attestations.ndjson`
- journal envelope helpers

Exit criteria:

- V3 missions cannot start execution without environment and checker artifacts,
- lane runs and command attestations are reproducible and idempotent.

### Phase 2 — Assurance Contract + Proof Program

Deliverables:

- `assurance-contract.json`
- `proof-program.json`
- obligation state machine
- proof-program compiler

Exit criteria:

- proof obligations compile into executable lane bindings,
- kernel closure checks consume obligation truth, not generic green signals.

### Phase 3 — Policy plane and deterministic guardrails

Deliverables:

- `policy-decisions.ndjson`
- `policy-snapshot.json`
- deterministic guardrail surfaces
- source-trust enforcement
- third-party incorporation gates
- secret broker
- waiver model

Exit criteria:

- unsafe actions are policy-enforced,
- untrusted material cannot silently mutate contracts or execution surfaces.

### Phase 4 — Evidence journal, impact map, adjudicator, quality watchdog

Deliverables:

- `evidence-events.ndjson`
- derived `impact-map.json`
- derived `evidence-graph.json`
- adjudicator structured output contract
- quality watchdog metrics and kernel-consumable blocker mapping

Exit criteria:

- a V3 mission can enter `verified` only through obligation resolution,
- adjudicator can explain exact blocking contradictions and stale proofs.

### Phase 5 — Candidate portfolio runtime

Deliverables:

- authoritative candidate state model
- candidate spawn policy
- candidate lineage rules
- hybrid candidate creation rules
- derived tournament view

Exit criteria:

- multiple candidates can run under one target authority,
- stale candidate writes are rejected,
- selection and rescission semantics are authoritative and recoverable.

### Phase 6 — Promotion governor and release/handoff states

Deliverables:

- `promotion-events.ndjson`
- derived `promotion-decision.json`
- `promotion_ready`, `released`, `handed_off` semantics
- release/handoff artifact requirements

Exit criteria:

- `verified` and `released` are no longer conflated,
- promotion is auditable and policy-controlled.

### Phase 7 — Long-horizon memory + learning plane

Deliverables:

- `status-ledger.md`
- `context-snapshots/*.json`
- `trace-bundle.json`
- `eval-bundle.json`
- learning promotion path states
- benchmark hygiene and held-out eval policy

Exit criteria:

- successful and failed missions generate reusable learning assets,
- no learned improvement reaches runtime behavior without explicit promotion.

---

## 18. Testing and chaos strategy

Mission V3 needs more than ordinary unit tests.

### 18.1 Kernel and contract tests

Prove:

- umbrella lifecycle correctness,
- candidate lifecycle correctness,
- obligation state transitions,
- waiver semantics,
- verified/promotion/release state separation,
- reopen and rescission semantics.

### 18.2 Journal integrity tests

Prove:

- event envelopes validate,
- idempotency keys suppress duplicate recovery writes,
- sequence numbers remain monotonic,
- hash chaining detects mutation,
- truncated journal tails are repaired safely.

### 18.3 Recovery and rebuild tests

Prove:

- derived views rebuild correctly from authoritative state + journals,
- gap events can be synthesized safely after crash windows,
- tournament and promotion views survive partial writes,
- uncertainty, compaction, and policy views reconcile correctly.

### 18.4 Environment parity tests

Prove:

- executor/verifier lanes respect the same environment contract,
- achieved vs declared hash mismatches are detected,
- attestation expiry marks obligations stale,
- runtime observations can invalidate parity.

### 18.5 Assurance fabric tests

Prove:

- proof-program lane bindings are deterministic,
- checker-lock resolution is stable,
- blocking obligations fail closed,
- impact-map generation is reproducible,
- adjudicator handles stale and contradictory evidence,
- flake policy behaves deterministically.

### 18.6 Control-plane tests

Prove:

- source-trust labels are preserved,
- guardrails block forbidden commands and writes,
- untrusted sources cannot auto-amend contracts or policies,
- secret scopes do not leak across setup/execution/verifier boundaries,
- third-party incorporation gates enforce review.

### 18.7 Candidate portfolio tests

Prove:

- candidate spawn caps are enforced,
- hybrid candidates get fresh identities,
- superseded candidates cannot write,
- selection/rescission is recoverable,
- tournament hard vetoes dominate soft comparison.

### 18.8 Promotion tests

Prove:

- promotion is blocked when mandatory evidence is absent,
- release-smoke and observability obligations behave correctly,
- rollback requirements are enforced for qualifying missions,
- promotion-ready demotion occurs on stale or contradictory proofs.

### 18.9 Learning-plane tests

Prove:

- traces and eval bundles are deterministic,
- compaction snapshots preserve required uncertainties,
- learned changes cannot bypass shadow/held-out evaluation,
- rejected learning artifacts do not affect runtime behavior.

### 18.10 Chaos and fault-injection tests

Explicitly test:

- torn writes,
- stale evidence,
- contradictory adjudication,
- partial candidate deletion,
- environment drift,
- duplicated lane results,
- corrupted journal tails,
- mutated source-trust labels,
- stale compaction snapshots,
- recovery after selection/promotion crash windows.

---

## 19. Risks and mitigations

### Risk 1 — V3 becomes too heavyweight
Mitigation:

- keep `risk_class`, `assurance_profile`, and `autonomy_profile` separate,
- preserve a lightweight class for normal missions,
- keep V2-compatible mode where appropriate.

### Risk 2 — Artifact sprawl confuses operators
Mitigation:

- freeze authority matrix,
- label every view by trust class,
- provide `status-ledger.md` and context snapshots for human-readable operation.

### Risk 3 — Candidate portfolios explode cost and complexity
Mitigation:

- default to one candidate,
- require policy justification for expansion,
- cap concurrency by profile.

### Risk 4 — Assurance becomes narrative instead of executable
Mitigation:

- require `proof-program.json`,
- freeze checker surface via `checker-lock.json`,
- bind evidence to lane runs and command attestations,
- keep adjudicator structured first, narrative second.

### Risk 5 — Learning plane becomes self-modification by stealth
Mitigation:

- use explicit learning-promotion states,
- require shadow + held-out evaluation,
- never auto-apply live behavior changes from traces.

### Risk 6 — Journal-first design becomes operationally fragile
Mitigation:

- require common journal envelope,
- require idempotency keys,
- hash-chain append-only events,
- keep authoritative mutable state minimal and clear.

---

## 20. Resolved design decisions and narrow deferrals

The earlier drafts left several important questions open. For implementation, this RFC resolves them as follows.

1. **What moves into kernel truth?**  
   Only closure-critical semantics: mission status, selected candidate, authoritative blockers, obligation summaries, selection/rescission, promotion state.

2. **Should `acceptance-contract.json` remain first-class?**  
   No. It remains only as a compatibility/human-readable view over the V3 assurance surfaces.

3. **How many concurrent candidates by default?**  
   One by default, two on justified ambiguity or plateau, three only in `assurance_profile=max-quality`.

4. **Which lanes are mandatory first?**  
   `reproduction`, `targeted-regression`, `static-analysis`, `adjudication`; plus risk-gated `impacted-tests`, `security`, `ui-vision`, `migration`, and `release-smoke`.

5. **Mission-local environment only or reusable profiles?**  
   Both. Reusable named profiles may exist, but every mission materializes a mission-local resolved environment contract and attestation set.

6. **How are waivers represented?**  
   As append-only first-class objects with scope, authority, rationale, expiry, compensating controls, and linked evidence.

7. **What is the minimal adjudicator interface?**  
   Structured obligation table + contradictions + stale evidence + waivers + residual risk + recommended next state.

8. **How much raw shell should proofs use?**  
   Prefer checker IDs and locked command templates. Free-form shell is allowed only under trusted inputs and explicit checker/policy authorization.

9. **Should uncertainty and decision logs be unified?**  
   No. Keep separate journals with shared correlation fields; combine only in derived views.

10. **How much history should the context compiler expose by default?**  
    Latest authoritative state + active candidate + current uncertainty register + newest validated evidence + most recent context snapshot. Full replay stays available but is opt-in.

### Narrow deferrals that do not block implementation

- richer property-check inference for `property-checks` lanes,
- advanced portfolio schedulers beyond the initial spawn policy,
- cryptographic signing beyond tamper-evident hash chaining,
- automatic benchmark mutation tooling beyond initial held-out corpora.

---

## 21. Immediate next steps

1. Accept this RFC as the implementation baseline for Mission V3 semantics.
2. Write contract docs for the first six artifact families:
   - `assurance-contract.json`
   - `proof-program.json`
   - `checker-lock.json`
   - `environment-contract.json`
   - `lane-runs.ndjson`
   - `command-attestations.ndjson`
3. Freeze the authority matrix and journal envelope in dedicated contract docs.
4. Define the first proof-program compiler inputs from:
   - source pack,
   - assurance contract,
   - checker lock,
   - environment contract,
   - risk/assurance/autonomy profiles.
5. Implement Phase 0 and Phase 1 before building candidate portfolio runtime.

---

## 22. Final position

Mission V2 should be considered a success.  
It already solves the right V2 problem: trustworthy orchestration of autonomous mission loops.

Mission V3 should solve the next problem:

> not just how OMX continues autonomous work safely,  
> but how OMX proves, governs, and learns from that work at engineering quality depth.

That is the step from a mission supervisor to a full autonomous engineering runtime.
