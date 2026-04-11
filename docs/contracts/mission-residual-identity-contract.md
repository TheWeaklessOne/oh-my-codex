# Mission residual identity + oracle adapter contract

This document freezes the Mission MVP rules for verifier artifacts, residual normalization, and deterministic identity matching.

Authoritative implementation:

- `src/mission/contracts.ts`
- `src/mission/kernel.ts`
- `src/mission/__tests__/contracts.test.ts`
- `src/mission/__tests__/kernel.test.ts`

## Canonical verifier artifact

Every audit / re-audit lane must emit a normalized summary with:

- `verdict`: `PASS | PARTIAL | FAIL | AMBIGUOUS`
- `confidence`: `high | medium | low`
- `residuals[]`
- `evidence_refs[]`
- `recommended_next_action`
- `provenance`

Provenance must include:

- `lane_id`
- `session_id`
- `lane_type`
- `runner_type`
- `adapter_version`
- `started_at`
- `finished_at`
- `parent_iteration`
- `trigger_reason`

Malformed or unsupported verifier outputs normalize to a **non-closing** summary:

- unsupported verdicts become `AMBIGUOUS`
- unsupported confidence values become `low`
- normalization errors are recorded explicitly

## Stable residual identity precedence

Residual identity follows this strict precedence order:

1. **`stable_id`** — explicit operator/adapter supplied stable identifier
2. **`canonical_key`** — explicit normalized canonical key, promoted to `residual:<canonical_key>`
3. **structural key** — deterministic key from `identity_version + category + closure_condition + target path + symbol + normalized title tokens`
4. **`lineage`** — split/merge lineage key combined with matcher seed
5. **matcher-derived key** — deterministic hash of severity + target path + symbol + normalized title tokens
6. **fallback hash** — deterministic hash of normalized title/summary when nothing better is available

This precedence prevents low-signal wording changes from unnecessarily rekeying the same residual.

## Split / merge lineage

Residuals may carry:

```json
{
  "lineage": {
    "kind": "split | merge",
    "related_residual_ids": ["residual:..."]
  }
}
```

Normalization rules:

- `related_residual_ids` are sanitized, deduplicated, and sorted
- the canonical lineage key is:
  - `split:<id>`
  - `merge:<id-a>|<id-b>|...`
- lineage-based stable ids are deterministic hashes of:
  - the lineage key
  - the matcher seed for the current residual

This preserves history across:

- one broad finding splitting into several narrow findings
- several narrow findings merging into one consolidated finding

## Deterministic wording-drift behavior

Residual titles are normalized into token signatures:

- lowercase
- punctuation collapsed
- stopwords removed
- tokens sorted

Matching is deterministic and must never fall through to “human decision required”.

Identity match order:

1. exact `stable_id`
2. exact `canonical_key`
3. exact structural key
4. exact lineage key
5. shared lineage relation
6. exact matcher key
7. exact fallback hash
8. otherwise `no_match`

Confidence expectations:

- exact `stable_id` / `canonical_key` => `high`
- exact structural key => `high` or `medium`
- exact lineage key => `medium`
- shared lineage relation => `low`
- exact matcher key => `high` or `medium` based on matcher confidence
- fallback hash => `low`

## MVP boundary

This contract is intentionally limited to the Mission MVP:

- one verifier contract
- one default execution policy
- no pluginized oracle adapters
- Mission now has a first-class `omx mission ...` CLI entrypoint, but the kernel remains the source of truth

The Mission skill is the UX surface; the mission kernel remains the authoritative state machine.
