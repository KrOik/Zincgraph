# CodeGraph vs Zincgraph Benchmark Plan

This benchmark evaluates how much CodeGraph and Zincgraph help an agent-facing workflow. It intentionally separates raw speed from richer capability because Zincgraph wraps CodeGraph and adds fusion, freshness, review, and deduplication surfaces.

## Local deterministic suite

Run:

```bash
npm test
```

Outputs:

- `bench/results/latest/summary.json`
- `bench/results/latest/report.md`

`npm test` now runs through `bench/test-all.mjs`, which executes the unit suite and then always executes the benchmark gate via `npm run benchmark:test` before returning a combined failure status. The benchmark test script builds `dist/` first, runs `bench/compare.mjs --runs 1`, and enforces the goal threshold through `bench/goal-gate.mjs`. Build time is not included in measured command latency.

For manual deeper runs:

```bash
npm run benchmark:compare
npm run benchmark:goal
```

The default comparison command runs five times per command (`--runs <n>` overrides this). The `npm test` benchmark gate uses one run to keep CI latency bounded; `npm run benchmark:goal` uses three runs for a more stable local release gate. The runner persists per-run status, latency, raw-output size, and diagnostic previews in `summary.json`. A task is considered failed if **any** run fails. For scoring, the runner uses exactly one deterministic selected successful run (the median-latency successful run, with stable tie-breakers). Only raw tool stdout/stderr feeds file/symbol/term/freshness/top-hit/output-byte/density scoring; echoed commands and combined/per-run diagnostics are replay aids only and are not unioned into evidence.

## Dimensions

| Dimension | Weight | Meaning |
|---|---:|---|
| Retrieval | 30 | Golden file/symbol/term recall and top-output relevance |
| Information density | 20 | Relevant evidence per KB, normalized per task |
| Runtime | 15 | Inverse normalized median command latency |
| Depth | 10 | Relevant file diversity plus structural terms like calls/imports/dependencies |
| Freshness | 15 | Freshness/manifest semantics and isolated update behavior |
| Capability | 10 | Exercised graph/fusion/freshness/dedup/review/delegation surface |

`summary.json` also emits per-task normalization baselines (`densityDenominator`, `bestMedianLatencyMs`, applicable primary arms, successful primary arms) so density/runtime scores can be audited without reading runner source.

## Local arms

- `codegraph`: upstream graph baseline via `node_modules/.bin/codegraph`.
- `zincgraph-fusion`: Zincgraph-owned fusion/context commands via `dist/cli.js`.
- `zincgraph-delegated`: sidecar wrapper-overhead arm for CodeGraph-compatible delegation. It is excluded from the primary winner by default.

## Task matrix

The local suite covers:

1. exact API retrieval (`runAutoSyncOnce`),
2. auto-sync CLI flow,
3. MCP fusion registry,
4. freshness/manifest semantics,
5. behavior dedup/review,
6. index status coverage,
7. isolated update/freshness behavior,
8. graph navigation (`node`, `callers`, `callees` around `runAutoSyncOnce`),
9. affected-test selection (`affected` for `review-command.ts` changes).

The isolated-update/freshness task seeds the temp fixture first and starts timing after the initial seed index/vectorize step. The measured latency is the append -> sync -> query update path, not bootstrap setup.

Current repository state roots `.codegraph` and `.zincgraph` are fingerprinted before and after the benchmark. This is a scoped non-mutation proof for those state roots only, not a whole-repo or whole-filesystem immutability claim. Mutating update/freshness checks run in fresh disposable temp fixtures for every run; the benchmark project itself is also a disposable copy prepared from the current source tree.

## What the score can prove

The local score can prove whether the installed CodeGraph and Zincgraph surfaces behave well on this repository under deterministic metrics. It cannot prove universal agent effectiveness across large external corpora.

For agent-level cost/tokens/time/correctness claims, use the optional external A/B extension in `bench/agent-eval/README.md`.
