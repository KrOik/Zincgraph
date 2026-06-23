# CodeGraph vs Zincgraph Benchmark Plan

This benchmark evaluates how much CodeGraph and Zincgraph help an agent-facing workflow. It intentionally separates raw speed from richer capability because Zincgraph wraps CodeGraph and adds fusion, freshness, review, and deduplication surfaces.

## Local deterministic suite

Run:

```bash
npm run benchmark:compare
```

Outputs:

- `bench/results/latest/summary.json`
- `bench/results/latest/report.md`

The package script builds `dist/` first, then runs `bench/compare.mjs`. Build time is not included in measured command latency.

Each command runs five times by default (`--runs <n>` overrides this). The runner persists per-run status, latency, raw-output size, and diagnostic previews in `summary.json`. A task is considered failed if **any** run fails. For scoring, the runner uses exactly one deterministic selected successful run (the median-latency successful run, with stable tie-breakers). Only raw tool stdout/stderr feeds file/symbol/term/freshness/top-hit/output-byte/density scoring; echoed commands and combined/per-run diagnostics are replay aids only and are not unioned into evidence.

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
7. isolated update/freshness behavior.

Current repository state roots `.codegraph` and `.zincgraph` are fingerprinted before and after the benchmark. This is a scoped non-mutation proof for those state roots only, not a whole-repo or whole-filesystem immutability claim. Mutating update/freshness checks run in fresh disposable temp fixtures for every run; the benchmark project itself is also a disposable copy prepared from the current source tree.

## What the score can prove

The local score can prove whether the installed CodeGraph and Zincgraph surfaces behave well on this repository under deterministic metrics. It cannot prove universal agent effectiveness across large external corpora.

For agent-level cost/tokens/time/correctness claims, use the optional external A/B extension in `bench/agent-eval/README.md`.

For implementation-oriented follow-up and anti-gaming hardening, see [CodeGraph vs Zincgraph Next Steps](./codegraph-vs-zincgraph-next-steps.md).
