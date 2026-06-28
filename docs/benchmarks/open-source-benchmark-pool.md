# Open-Source Benchmark Pool and Scoring Standard

This document materializes the first cross-repository benchmark contract for Zincgraph. It defines the repository pool, acquisition policy, case quotas, golden annotation schema, score model, non-mutation proof, and promotion gates.

The machine-readable source of truth is [bench/benchmark-pool.json](/home/radxa/project/zincgrapf/bench/benchmark-pool.json).

The contract self-check command is `node bench/pool-status.mjs`. It validates the 3+2+1 pool shape, score-model version, case quotas, acquisition mode, and local ignore policy. Add `--strict-materialization` when the submodules and local stress clone are expected to exist on disk.

The materialization command is `node bench/pool-sync.mjs`. It now prefers local GitHub source archives (`*.zip`) found under `bench/` and falls back to git/submodule operations only when no matching archive exists. For archive-backed materialization it writes provenance into `bench/benchmark-pool.local.json`; for the stress repository it also populates the top-level `enabled/repoUrl/commitSha/fetchedAt/dirty` fields. Use `--dry-run` to inspect the planned actions first.

Archive-backed strict validation is supported. If a repo was extracted from a local archive instead of a submodule, `node bench/pool-status.mjs --strict-materialization` accepts it when the local metadata contains:

- `archivePath`
- `archiveSha256`
- `sourceCommitSha`
- `extractedPath`
- `materializedAt`
- `dirty=false`

Archive-backed `core` and `extended` repositories are intentionally gitignored at their tier roots:

- `bench/corpora/core/.gitignore`
- `bench/corpora/extended/.gitignore`

## Pool

The pool shape is `3+2+1`:

- `core` daily submodules:
  - `apache/superset`
  - `denoland/deno`
  - `apache/airflow`
- `extended` nightly submodules:
  - `grafana/grafana`
  - `open-metadata/openmetadata`
- `stress` local gitignored clone:
  - `airbytehq/airbyte`

Canonical materialization paths:

- `bench/corpora/core/apache-superset`
- `bench/corpora/core/deno`
- `bench/corpora/core/apache-airflow`
- `bench/corpora/extended/grafana`
- `bench/corpora/extended/openmetadata`
- `bench/worktrees/airbyte`

## Acquisition

Core and extended repositories are pinned as submodules. Their canonical upstreams and pins are carried by `repoUrl` plus the checked-in submodule gitlink SHA.

Stress repositories live under `bench/worktrees/` and stay out of git history. Stress mode is valid only when [bench/worktrees/.gitignore](/home/radxa/project/zincgrapf/bench/worktrees/.gitignore) exists and `bench/benchmark-pool.local.json` records:

- `repoUrl`
- `commitSha`
- `fetchedAt`
- `dirty=false`
- `enabled=true`

If stress is enabled and local metadata is missing, invalid, dirty, or mismatched with local `HEAD`, the run hard-fails before scoring.

A checked-in template lives at [bench/benchmark-pool.local.example.json](/home/radxa/project/zincgrapf/bench/benchmark-pool.local.example.json). The real `bench/benchmark-pool.local.json` remains machine-local and should not be committed.

## Case Quotas

Each core repo contributes exactly `10` cases:

- `2` retrieval-heavy
- `2` flow
- `2` structure
- `2` impact
- `2` freshness

Each extended repo contributes exactly `8` cases:

- `2` retrieval-heavy
- `2` flow
- `2` structure-or-multi-implementation
- `1` impact
- `1` freshness

Stress contributes exactly `6` cases:

- `1` retrieval-heavy
- `2` multi-implementation-or-connector
- `1` config-to-runtime
- `1` freshness
- `1` impact

## Case Schema

Every case fixture must include these fields:

- `repoId`
- `queryId`
- `tier`
- `family`
- `query`
- `difficulty`
- `goldenFiles`
- `goldenSymbols`
- `goldenRelations`
- `goldenImplementations`
- `acceptableAlternates`
- `invalidImplementations`
- `requiredTopK`
- `requiredEvidenceTerms`
- `forbiddenFalsePositives`
- `freshnessSetup`
- `goldenTests`
- `goldenRuntimeArtifacts`
- `requiredConsequenceTerms`
- `impactRequired`

Matching semantics are exact by default:

- files: exact repo-relative path equality
- symbols: exact identifier equality
- relations: exact `{kind, from, to}` tuple equality
- implementations: exact identifier equality
- runtime artifacts: exact repo-relative path or declared identifier equality
- consequence terms: case-insensitive token equality
- tests: exact repo-relative test path or exact test ID equality

## Scoring

Base weights:

- retrieval `30`
- relation `20`
- multi-implementation `15`
- freshness `20`
- impact `15`

Applicability is family-aware. If a dimension is `N/A`, the remaining applicable weights are renormalized:

```text
case_score = sum((weight_d / sum(weights_applicable)) * raw_score_d)
```

Key raw score rules:

- retrieval:
  - with `goldenSymbols`: `50%` file recall + `30%` symbol recall + `20%` precision@K
  - without `goldenSymbols`: `70%` file recall + `30%` precision@K
- relation:
  - `matched_golden_relations / total_golden_relations * 100`
- multi-implementation:
  - `100` valid only
  - `50` mixed valid and invalid
  - `0` invalid only or no valid implementation
- freshness:
  - `50 * surfacingPass + 50 * suppressionPass`
- impact:
  - `40%` affected tests
  - `30%` config/runtime
  - `30%` consequence explanation

False-positive policy:

- score only top-K evidence after stable sort
- each distinct forbidden false positive in top-K subtracts `25`
- duplicates do not stack
- precision floor is `0`

Evidence ordering is stable:

1. explicit tool rank
2. latency source rank, missing as `+Infinity`
3. shorter path length
4. lexical path
5. original emission index

## Aggregation

- `repoScore`: arithmetic mean of case scores
- `tierScore`: arithmetic mean of repo scores
- `globalQualityScore`: weighted sum of enabled tier scores

Tier weights:

- core `0.60`
- extended `0.30`
- stress `0.10`

If a tier is disabled, weights are renormalized over enabled tiers only.

## Gates

Hard gates:

- all `30` core cases execute successfully
- every enabled repo passes pin/dirty checks
- freshness stale leakage is zero
- non-mutation proof passes

Score floors:

- at least `27/30` core cases score `>= 70`
- each core repo score `>= 75.00`
- global quality score `>= baseline quality - 1.00` when baseline exists

Diagnostics for release promotion only:

- median core-pool latency regression `<= 15%`
- output-byte regression `<= 20%`

Exception:

- output-byte regression may exceed `20%` only when global quality improves by at least `5.00` and no core repo drops by more than `2.00`

## Baseline and Non-Mutation

The baseline source is the latest accepted summary artifact under `bench/results/**/summary.json` with:

- `accepted=true`
- `schemaVersion=1`
- `scoreModel.version='2026-06-27-v1'`
- the same enabled tier set

If none exists, baseline-dependent checks are skipped as first-run.

The non-mutation proof tracks, per source repo:

- `HEAD` SHA
- git dirty status
- `.codegraph/`
- `.zincgraph/`
- `bench/benchmark-pool.json`
- `bench/benchmark-pool.local.json` if present

Disposable temp fixtures outside source repo paths are excluded by definition.
