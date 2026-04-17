# Mission V3 implementation review and next-step plan

Date: 2026-04-16
Repository snapshot reviewed:
- branch: `feat/mission-v3-assurance-runtime`
- head: `9920cb0d5513ece5d133ce1d47e23161042a48fc`
- base: `upstream/main @ 09d2126204a605b23cb37d72e3005dd4b571ad12`

## 1. Executive verdict

This branch is **substantially beyond RFC-only status**.

It already contains:
- a real Mission V2 subsystem,
- a large Mission V3 overlay in `src/mission/v3.ts`,
- kernel schema expansion for V3 state,
- canonical contracts (`assurance-contract`, `proof-program`, `checker-lock`, `environment-contract`),
- append-only V3 journals (`evidence-events`, `lane-runs`, `command-attestations`, `policy-decisions`, `promotion-events`, `decision-log`, `uncertainty-events`, `contract-amendments`, `compaction-events`),
- candidate lifecycle operations,
- promotion/release/handoff surfaces,
- waiver and amendment logic,
- derived context / trace / eval artifacts,
- and a strong automated test suite.

### Local validation completed during review

The following succeeded against the reviewed archive:
- `npm ci`
- `npm run build`
- `npm run lint`
- `node dist/scripts/run-test-files.js dist/mission/__tests__ dist/cli/__tests__/mission.test.js`

That final run passed **72/72 tests** across mission contracts, kernel, orchestration, runtime, recovery, telemetry, workflow, CLI, and V3 surfaces.

## 2. High-level status assessment

### What is already strong

1. **V2 remains a real kernel-first subsystem**
   - `src/mission/kernel.ts`
   - `src/mission/runtime.ts`
   - `src/mission/orchestration.ts`
   - `src/mission/events.ts`
   - `src/mission/workflow.ts`
   - `src/mission/isolation.ts`
   - `src/mission/recovery.ts`
   - `src/mission/telemetry.ts`

2. **V3 is not a stub**
   - `src/mission/v3.ts` is ~5000 lines and actually persists contracts, journals, candidates, promotion records, learning artifacts, and status surfaces.

3. **The implementation tracks the later RFC much better than the earlier drafts**
   - explicit lifecycle split: `verified`, `promotion_ready`, `released`, `handed_off`
   - append-only-first state for time-varying V3 surfaces
   - checker-lock, proof-program, lane-runs, command-attestations, impact-map, context snapshots, status ledger
   - waivers and contract amendments
   - candidate selection and rescission
   - promotion vs release separation

4. **The test posture is serious**
   - `src/mission/__tests__/v3.test.ts` is large and covers bootstrapping, stale evidence demotion, candidate operations, promotion/handoff, waivers, amendments, and journal tail repair.

## 3. Architecture as actually implemented today

The current codebase is best described as:

> **Mission V2 as the still-authoritative execution kernel, plus a substantial Mission V3 assurance/control/learning overlay that reconciles additional truth around that kernel.**

That distinction matters.

### 3.1 Current execution authority

Still primarily owned by V2 kernel/runtime:
- iteration creation
- lane directory layout
- lane summary recording
- delta computation
- closure matrix
- plateau / fail / cancel status
- latest snapshot commit ordering

### 3.2 Current V3 overlay authority

Added in V3:
- richer lifecycle state stored in `mission.json`
- assurance contract + proof program + checker lock
- environment contract + attestation/current view
- policy snapshot + policy decisions
- evidence graph + adjudication
- promotion decision / release record / handoff record
- candidate metadata + selection / rescission / hybrid lineage
- trace bundle / eval bundle / learning proposal / status ledger / context snapshot

### 3.3 Important implementation reality

V3 is **not yet a separate execution plane**.
It is a strong reconciliation and evidence layer wrapped around the still-dominant V2 execution loop.

That is acceptable for an incremental rollout.
It is **not yet** the fully independent assurance-first runtime described by the end-state RFC.

## 4. Status against the intended V3 rollout

### Phase 0 — semantic freeze
**Status:** largely done

Implemented:
- expanded mission state schema
- lifecycle states
- candidate states
- obligation states
- artifact role enumeration
- core contracts and docs

Gaps:
- no explicit migrator / schema normalizer for older persisted V2 mission state

### Phase 1 — environment kernel + assurance contract + proof program
**Status:** implemented, but minimal

Implemented:
- `assurance-contract.json`
- `proof-program.json`
- `checker-lock.json`
- `environment-contract.json`
- `environment-attestations.ndjson`
- `runtime-observations.ndjson`
- `environment-current.json`

Gaps:
- environment setup is self-attested, not materially prepared in a separate setup phase
- secrets are declared, not brokered/enforced
- checker-lock / proof-program are recorded, not fully enforced at execution time

### Phase 2 — policy plane and deterministic guardrails
**Status:** partial

Implemented:
- policy snapshot
- policy decisions journal
- source trust classes
- promotion blockers from policy
- waiver support

Gaps:
- command/path/network/secret guardrails are not yet real enforcement points
- source trust is summarized and reasoned about, but not enforced all the way down into command execution

### Phase 3 — evidence journal + adjudicator + quality watchdog
**Status:** good first implementation

Implemented:
- evidence journal
- lane runs
- command attestations
- impact map
- adjudication
- quality watchdog
- stale/contradicted/waived proof state evaluation

Gaps:
- several lane types are synthetic or placeholders rather than true runtime executions
- recovery does not rebuild V3 derived views

### Phase 4 — candidate portfolio runtime
**Status:** partial / metadata-first

Implemented:
- candidate state
- candidate events
- candidate creation
- selection
- rescission
- hybrid lineage metadata
- tournament derived view

Gaps:
- candidate execution is not actually isolated from the single V2 iteration runtime
- candidates do not yet own real worktrees, envelopes, or separate lane execution state
- parallel portfolio search is not truly operational

### Phase 5 — promotion governor / release / handoff
**Status:** implemented but thinner than target

Implemented:
- verified -> promotion_ready
- released / handed_off
- promotion events
- release/handoff records

Gaps:
- promotion artifact requirements are still narrow
- no commit/session/evidence linkage in actual VCS output
- rollback / observability / release notes are not enforced as first-class obligations

### Phase 6 — learning plane
**Status:** partial / placeholder-heavy

Implemented:
- trace bundle
- eval bundle
- learning proposal state
- postmortem output

Gaps:
- no actual shadow eval pipeline
- no held-out eval executor
- no safe promotion pipeline into skills/policy/runtime behavior

## 5. Confirmed problems

This section only lists issues that are real enough to matter before calling Mission V3 “production-grade”.

---

## P0-A. Candidate attribution is unsafe after candidate switching

### Severity
**Critical**

### What is wrong
Late lane results are attributed to the **current active candidate**, not to the candidate that actually produced the work.

### Why this happens
- lane execution envelopes are iteration/lane based, not candidate-bound
- `recordMissionRuntimeLaneSummary(...)` does not accept or verify candidate identity
- `recordMissionV3LaneSummary(...)` uses `mission.active_candidate_id` at record time
- iteration directories remain mission-global under `.omx/missions/<slug>/iterations/...`

### Consequence
If candidate selection changes while earlier candidate lanes are still in flight, stale results from the old candidate can be journaled as proof for the newly active candidate.

### Review evidence
- `src/mission/runtime.ts` -> `recordMissionRuntimeLaneSummary(...)`
- `src/mission/v3.ts` -> `recordMissionV3LaneSummary(...)`
- `src/mission/isolation.ts` has no candidate identity in the envelope contract
- candidate execution does not use candidate-local iteration roots

### Manual reproduction completed during review
I reproduced this against the reviewed archive:
1. prepare mission runtime
2. create candidate-002
3. select candidate-002 before old audit result is recorded
4. record the original audit summary
5. resulting `evidence-events.ndjson` entry is written under `candidate-002`

### Required fix
Candidate identity must become part of:
- execution envelopes
- lane summary provenance
- lane directories or lane run IDs
- stale write rejection logic

### Implementation steps
1. Add `candidate_id` to execution envelopes and lane provenance contracts.
2. Require candidate binding on every runtime lane summary record.
3. Reject lane results whose candidate binding does not match the expected candidate state.
4. Move from mission-global iteration output to candidate-scoped iteration output, or add candidate-scoped lane roots.
5. Add tests for:
   - late write after candidate switch
   - parallel candidate writes
   - candidate rescission while prior lanes are still running

---

## P0-B. Candidate portfolio is metadata-rich but execution-poor

### Severity
**Critical**

### What is wrong
Additional candidates exist as state and artifacts, but not as real independent execution branches.

### Why this matters
A true portfolio runtime needs:
- isolated worktrees or sandboxes per candidate
- candidate-scoped execution envelopes
- candidate-scoped iteration history
- ability to run or resume candidate lanes independently

Current code still uses the single V2 iteration runtime under mission root.
Candidate-local directories are created, but the actual iteration loop does not use them.

### Review evidence
- `prepareMissionRuntime(...)` and `startIteration(...)` still operate on umbrella mission iteration roots
- candidate directories under `candidates/<id>/iterations/` are mostly placeholder structure
- no candidate-aware lane planner / scheduler exists

### Required fix
Implement a real candidate execution layer, not only candidate metadata.

### Implementation steps
1. Introduce candidate-scoped iteration root resolution.
2. Make lane envelopes candidate-aware.
3. Route runtime lane planning through active candidate workspace.
4. Make selection/rescission operate on candidate execution state, not only metadata.
5. Add a scheduler that can run one or more candidate execution queues.

---

## P0-C. V3 recovery is not implemented as promised

### Severity
**Critical**

### What is wrong
`src/mission/recovery.ts` still only reconciles V2 read models:
- workflow
- telemetry
- closeout
- latest

It does **not** rebuild V3 derived surfaces such as:
- `environment-current.json`
- `policy-snapshot.json`
- `impact-map.json`
- `evidence-graph.json`
- `adjudication.json`
- `promotion-decision.json`
- `quality-watchdog.json`
- `uncertainty-register.json`
- `candidate-tournament.json`
- `context-snapshots/current.json`
- status ledger / trace / eval / learning proposal

### Manual reproduction completed during review
I deleted `evidence-graph.json`, ran `recoverMissionReadModels(...)`, and the file remained missing.

### Consequence
The branch currently claims rebuildable V3 derived views more strongly than the actual recovery code supports.

### Required fix
Add a V3 recovery/reconcile layer that can deterministically rebuild all derived V3 views from authoritative state and append-only journals.

### Implementation steps
1. Create `rebuildMissionV3DerivedStateFromDisk(...)` or equivalent public reconciler.
2. Call it from `recoverMissionReadModels(...)` when `mission_version >= 3`.
3. Define drift detection for each V3 derived artifact family.
4. Add crash-window tests for missing/truncated V3 derived views.
5. Add tests for recovering after partial promotion, partial release, and partial contract amendment writes.

---

## P0-D. V3 verification still depends on V2 `status === complete`

### Severity
**High / architectural**

### What is wrong
`rebuildMissionV3DerivedState(...)` only moves to `verified` when:
- selected candidate exists
- proof is ready
- **and `mission.status === "complete"`**

That means the V2 kernel closure remains a prerequisite for V3 verified state.

### Why this matters
This is a perfectly reasonable migration strategy, but it means:
- V3 is not yet the true closure authority
- proof obligations are layered on top of V2 closure rather than replacing it

### Required decision
Choose one of two paths explicitly:
1. **Incremental path**: keep this dependency and document V3 as an overlay until later
2. **Full V3 path**: move verified-state authority fully into V3 obligation evaluation

### Recommended path
Short term: keep the dependency but document it as an intentional interim constraint.
Medium term: move closure-critical authority into a V3-specific authoritative kernel state machine.

---

## P1-A. Checker-lock and proof-program are only partially enforced

### Severity
**High**

### What is wrong
The code records checker metadata, command refs, and proof bindings, but it does not yet strongly enforce:
- allowed command templates
- source-trust eligibility per checker
- checker/command mismatch rejection
- execution-time binding correctness for all lanes

The contract docs explicitly admit this.

### Consequence
The system has the **shape** of deterministic proof surfaces, but not yet the full execution-time guarantees.

### Required fix
Introduce a central verifier/proof-lane executor that validates every lane run against checker-lock and proof-program before journaling it as admissible evidence.

### Implementation steps
1. Build a `MissionV3ProofExecutor` or `MissionV3LaneRunner` interface.
2. Resolve lane -> checker -> command through checker-lock, not ad hoc string construction.
3. Reject lane runs that do not match the compiled binding.
4. Carry source-trust constraints through into lane execution inputs.
5. Add negative tests for forbidden command refs and forbidden source-trust combinations.

---

## P1-B. Environment Kernel is mostly self-attested

### Severity
**High**

### What is wrong
Environment artifacts exist, but the environment model is still thin:
- based mostly on current process platform + lockfiles
- bootstrap writes a successful attestation immediately
- no real setup materialization phase
- no service bring-up validation
- no separate setup logs
- no actual runtime secret broker enforcement

### Consequence
Environment parity is better represented than before, but not yet truly proven.

### Required fix
Introduce a real setup/materialization step with attested outputs.

### Implementation steps
1. Add `setup-run.jsonl` or equivalent append-only setup journal.
2. Materialize environment from contract before execution.
3. Record actual toolchain resolution, service readiness, and secret scopes used.
4. Split setup secrets from runtime secrets in enforced code, not only in docs.
5. Make attestation expiry and contradiction handling part of recovery and promotion gates.

---

## P1-C. Policy plane is reasoning-first, not enforcement-first

### Severity
**High**

### What is wrong
Current policy clauses produce blockers and journal entries, but there is no strong runtime enforcement layer for:
- forbidden commands
- path protection
- external execution denials
- secret access by lane
- network mode changes

### Required fix
Create a deterministic guardrail layer that sits in front of actual execution.

### Implementation steps
1. Add a policy enforcement hook before every lane command.
2. Validate path/write scope against resolved mission policy.
3. Reject execution derived from `untrusted` / `execution_forbidden` sources.
4. Introduce a real secret broker interface and grant log.
5. Add audit tests that execution is blocked, not merely described as blocked.

---

## P1-D. Additional proof lanes are mostly placeholders

### Severity
**High**

### What is wrong
The lane taxonomy is broad, but only a subset is truly connected to execution.

Real/wired today:
- reproduction (from `audit`)
- targeted-regression (from `re_audit`)
- static-analysis (synthesized during commit)

Mostly placeholder / derived / not operational:
- full-suite
- performance
- security (policy-derived)
- ui-vision (impact-map derived)
- migration (environment-derived)
- property-checks (evidence-graph derived)
- release-smoke (promotion-derived)

### Required fix
Implement actual lane runners or mark these clearly as future lanes and remove them from production-facing obligation claims until real.

### Implementation steps
1. Add an explicit lane capability matrix: `implemented`, `synthetic`, `planned`.
2. Do not generate blocking obligations for unimplemented lanes in production mode.
3. Add actual runners for at least:
   - impacted-tests
   - security
   - release-smoke
4. Add output schemas and command attestations for those lanes.
5. Only then widen the mandatory-lane matrix.

---

## P1-E. Tournament logic is not yet a real multi-candidate evaluation engine

### Severity
**Medium-high**

### What is wrong
`candidate-tournament.json` is derived mostly from the selected candidate's adjudication, not from full candidate-by-candidate proof evaluation.

### Consequence
The current tournament surface is a useful status view, but not yet a trustworthy portfolio decision engine.

### Required fix
Evaluate every candidate against the proof program and build tournament state from candidate-local evidence.

### Implementation steps
1. Make evidence evaluation candidate-local for all candidates.
2. Produce candidate-local adjudication outputs.
3. Compute hard vetoes and comparison vectors per candidate.
4. Only then derive umbrella selection advice.
5. Add tests where two candidates have different proof states and the tournament reflects it.

---

## P1-F. Journals are append-only, but not yet strongly validated or scalable

### Severity
**Medium-high**

### What is wrong
Good work already exists here:
- idempotency keys
- sequence numbers
- `prev_event_hash`
- `payload_hash`
- truncated-tail repair

But there are still important issues:
- no hash-chain verification on read
- no tamper/quarantine mode
- `stableJson(...)` is plain `JSON.stringify(...)`, not canonical serialization
- appends reread whole journals repeatedly, which will not scale for very long runs

### Required fix
Harden journal semantics and performance.

### Implementation steps
1. Introduce canonical JSON serialization for all hashed payloads/events.
2. Validate hash chains when loading journals.
3. Add a quarantine / corrupted-journal recovery path.
4. Maintain append metadata or last-event caches so appends do not reread the full file repeatedly.
5. Add stress tests with large journals.

---

## P1-G. No explicit migrator for old Mission V2 persisted state

### Severity
**Medium-high**

### What is wrong
`MissionState` now assumes `mission_version: 3` and V3 fields are present.
`loadMission(...)` is a direct JSON load with no compatibility normalizer.

### Consequence
Older persisted missions may load as structurally incomplete objects, and any code path that expects V3 fields can behave unpredictably.

### Required fix
Add schema migration / normalization.

### Implementation steps
1. Introduce `normalizeMissionState(...)` with defaults for V2-era persisted state.
2. Add versioned migrators.
3. Run migration on load or at least on first resume.
4. Add tests loading V2-style minimal mission state.

---

## P2-A. Context compiler is only partially realized

### Severity
**Medium**

### What is wrong
There is a `context-snapshots/current.json` derived checkpoint and `compaction-events.ndjson`, but not yet lane-specific compiled bundles with explicit decision boundaries per lane.

### Required fix
Implement lane-scoped context bundle generation.

### Implementation steps
1. Produce `context/<lane>.json` or equivalent.
2. Include authoritative refs, derived refs, stale markers, and lane decision boundaries.
3. Add compaction policies for long-running missions.
4. Ensure source trust labels survive compaction.

---

## P2-B. Learning plane outputs are placeholders, not a rollout system

### Severity
**Medium**

### What is wrong
Trace bundles, eval bundles, and learning proposals exist, but they do not flow into an actual shadow-eval -> held-out-eval -> approved rollout pipeline.

### Required fix
Implement a real learning promotion path.

### Implementation steps
1. Create learning proposal state storage and transition operations.
2. Add shadow eval runner.
3. Add held-out eval runner.
4. Add approval/audit trail for promoted learning changes.
5. Wire resulting changes into skills/policy only after approval.

---

## P2-C. Promotion governor is thinner than the target RFC

### Severity
**Medium**

### Missing today
- explicit rollback-plan requirement
- observability-delta requirement
- release note / handoff package enforcement
- commit/session/evidence linkage
- signed or trace-linked commit metadata

### Required fix
Expand promotion requirements.

### Implementation steps
1. Add required promotion artifact matrix by risk class.
2. Require `rollback-plan.md` and `observability-delta.md` for qualifying missions.
3. Add release-note / handoff summary requirements.
4. Add VCS trace-linking conventions.
5. Verify promotion package completeness in the governor.

---

## P2-D. Documentation drift remains

### Severity
**Medium**

### Observed drift
- `skills/mission/SKILL.md` still describes Mission as MVP/V2-oriented thin supervisor language
- the repo now contains much stronger V3 semantics than some user-facing guidance suggests

### Required fix
Refresh operator-facing docs to match the actual implementation and current limitations.

### Implementation steps
1. Update `skills/mission/SKILL.md` to describe V3 accurately.
2. Document what is implemented vs synthetic vs planned.
3. Add a recovery/troubleshooting guide for V3 artifacts.
4. Add operator guidance for candidate selection/rescission/promotion.

## 6. Recommended implementation order

### Track 1 — Stop-ship correctness
Do first.

1. Candidate binding and stale-write rejection
2. Candidate-scoped execution roots / candidate execution runtime
3. V3 recovery / rebuild
4. Explicitly document or refactor V3-vs-V2 closure authority

### Track 2 — Trust hardening
Do next.

5. Checker-lock / proof-program enforcement
6. Real environment materialization + attestation
7. Real policy enforcement + secret broker
8. Hash-chain validation + canonical serialization + scalable journal append path

### Track 3 — Make the assurance fabric real
Then expand breadth.

9. Actual additional proof-lane runners
10. Candidate-local adjudication and real tournamenting
11. Lane-specific context compiler
12. Stronger promotion governor

### Track 4 — Make the learning plane real
After the system is trustworthy.

13. Learning proposal state machine
14. Shadow eval runner
15. Held-out eval runner
16. Safe rollout path into skills/policy/runtime behavior

## 7. Concrete engineering backlog

### Sprint A — candidate safety and recovery

#### A1. Candidate binding contract
- add `candidate_id` to execution envelopes
- add `candidate_id` to lane provenance
- reject mismatched candidate writes
- update tests

#### A2. Candidate execution roots
- introduce candidate-aware iteration path helpers
- route lane briefings and execution envelopes into candidate roots
- keep umbrella mission metadata separate from candidate execution state

#### A3. V3 recovery
- implement `reconcileMissionV3(...)`
- rebuild all derived V3 files
- add drift flags and recovery events

#### Exit criteria
- late write after candidate switch is rejected
- deleting `evidence-graph.json` and running recovery restores it
- deleting `promotion-decision.json` and running recovery restores it

### Sprint B — trust enforcement

#### B1. Checker enforcement
- central proof-lane executor
- command ref resolution from checker lock
- source-trust eligibility enforcement

#### B2. Policy enforcement
- command gate
- path gate
- secret broker gate
- network gate

#### B3. Journal hardening
- canonical serializer
- chain verification
- corruption quarantine
- append performance improvements

#### Exit criteria
- forbidden checker/command combos fail closed
- forbidden source trust cannot generate lane execution
- tampered journal chain is detected

### Sprint C — real assurance breadth

#### C1. Implement real proof lanes
Minimum practical target:
- impacted-tests
- security
- release-smoke

#### C2. Expand promotion package
- rollback plan
- observability delta
- release/handoff summary

#### C3. Candidate-local adjudication
- adjudication per candidate
- real tournament from candidate-local proof state

#### Exit criteria
- tournament reflects at least two independently evaluated candidates
- promotion can be blocked by missing rollback/observability artifacts when policy requires them

### Sprint D — learning plane

#### D1. Learning proposal transitions
- captured
- shadow_evaluated
- approved_for_rollout
- rejected
- superseded

#### D2. Eval execution surfaces
- shadow eval runner
- held-out eval runner
- promotion gate for learned behavior changes

#### Exit criteria
- no learning artifact changes runtime behavior without explicit promotion

## 8. Suggested go/no-go status

### Good enough to merge as:
- **experimental / behind flag / branch-only architectural milestone**
- **not yet** “Mission V3 complete”
- **not yet** “fully autonomous assurance runtime”

### Not yet good enough to claim:
- true multi-candidate execution
- full proof-program enforcement
- deterministic guardrails
- strong environment attestation
- rebuildable V3 recovery
- production-grade promotion governance
- production-grade learning plane

## 9. Final recommendation

Merge only if the branch is framed honestly as:

> a strong Mission V3 foundation with real contracts, journals, state expansion, promotion surfaces, and tests,
> but still requiring follow-through on candidate execution authority, recovery, policy enforcement, environment attestation, and real proof-lane execution before it can be considered the full target architecture.

If the goal is “maximum autonomy and quality”, the next milestone should not be cosmetic polish.
It should be:

1. **candidate-safe execution authority**,
2. **V3 recovery parity**,
3. **proof/policy enforcement**,
4. **real additional proof lanes**.

Those four changes will move this from a strong architectural scaffold to a genuinely trustworthy runtime.
