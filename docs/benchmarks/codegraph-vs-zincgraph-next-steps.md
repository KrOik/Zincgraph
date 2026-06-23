# CodeGraph vs Zincgraph Next Steps

This note turns the latest local benchmark into an execution plan.

Current report:

- generatedAt: `2026-06-23T09:43:40.275Z`
- [bench/results/latest/report.md](../../bench/results/latest/report.md)
- [bench/results/latest/summary.json](../../bench/results/latest/summary.json)

It answers three questions:

1. Can the quality score still improve?
2. Can runtime and output size still improve?
3. Is the current result inflated by output verbosity?

## Snapshot

| Arm | Quality-only total | Legacy diagnostic total | Median latency | Output bytes |
|---|---:|---:|---:|---:|
| `zincgraph-fusion` | 79.67 | 61.17 | 5717.78 ms | 673651 |
| `codegraph` | 71.88 | 81.72 | 1003.99 ms | 58279 |
| `zincgraph-delegated` | 61.54 | 66.69 | 1954.86 ms | 5191 |

Current interpretation:

- `zincgraph-fusion` is the quality-only winner.
- `codegraph` is still the runtime and size leader.
- `zincgraph-delegated` is a wrapper/delegation arm and should not be treated as a primary winner candidate.

Runtime and output size are diagnostics only. They are shown for analysis, not for winner selection.

## Direct Answers

### Can the quality score still improve?

Yes.

The remaining room is mostly in retrieval precision, stronger depth evidence, and less brittle freshness scoring. Capability is already saturated in the current suite, so it is not the main source of separation.

### Can runtime and output size still improve?

Yes.

The fusion path still does extra work per query:

- reads the CodeGraph snapshot,
- loads vector documents,
- reads freshness state,
- runs graph, vector, and text candidate generation,
- optionally compresses the result,
- serializes a large JSON payload.

The likely wins now are stage-level timing, cache reuse, and a smaller default response.

### Is the result inflated by output verbosity?

Not in the primary score.

The score does not count latency or output bytes. However, the current design is still somewhat sensitive to verbose answers because:

- `countHits()` rewards any appearance of a gold term in raw stdout/stderr,
- `topHit` only inspects the first 25% of the output,
- capability is effectively a success flag rather than a proof score.

So this is not a pure "more text equals more points" game, but the benchmark can still favor broad answers that surface more target terms.

## What Is Safe To Claim Now

- `zincgraph-fusion` leads on the current local quality-only score.
- `codegraph` remains faster on raw latency.
- The result is local and deterministic, not a universal claim about agent quality.
- The benchmark still has room to reduce verbosity bias.

## Risks To Fix First

1. Capability is too coarse.

   The benchmark should reward proof, not just success.

2. Recall is easier to game than precision.

   Extra irrelevant material should hurt the score.

3. Freshness evidence is still text-sensitive.

   Multiple freshness tokens can still be packed into one verbose answer.

4. Default output is too large for routine use.

   That is not a primary score issue, but it is a product issue.

## Next Steps

### P0. Harden the score against verbosity bias

Goal: make score gains depend on evidence quality, not output length.

Actions:

- Split the score into explicit sub-scores for retrieval, precision, freshness, and capability proof.
- Add `precision@1`, `precision@3`, and `precision@10`.
- Add false-positive penalties for irrelevant files, symbols, paths, or freshness tokens.
- Cap scored output and keep overflow only in the transcript.
- Require structured top-k evidence instead of unrestricted raw-text scanning.
- Make capability evidence-based instead of success-flag-based.

Acceptance criteria:

- A longer answer with the same true result does not score higher by itself.
- A broader answer with more false positives scores lower than a compact precise answer.
- Capability changes only when the output proves the task.

### P1. Reduce Zincgraph latency and response size

Goal: make Zincgraph faster on the same task set.

Actions:

- Add stage timing for snapshot read, vector document load, vector search, lexical candidate generation, compression, and JSON serialization.
- Reuse `TopoSemanticQueryEngine` across repeated CLI calls where safe.
- Avoid rereading unchanged snapshots and vector documents.
- Reduce repeated process spawning in the freshness store path.
- Make the default CLI output compact and move verbose material to `--verbose` or transcript mode.

Acceptance criteria:

- The benchmark report includes stage-level runtime breakdowns.
- Median latency drops without reducing retrieval quality.
- Default output size drops materially.

### P2. Separate measurement from product behavior

Goal: keep benchmark scoring, runtime diagnostics, and agent-facing output distinct.

Actions:

- Keep one benchmark for quality correctness.
- Keep one benchmark for runtime and cost.
- Keep one optional agent-level A/B benchmark.
- Move diagnostic output into a separate appendix instead of mixing it into scoring logic.

Acceptance criteria:

- A reader can tell which metric is primary and which is diagnostic.
- A speed improvement does not automatically imply a quality improvement.
- A quality improvement does not automatically imply lower user cost.

## Recommended Order

1. Fix the score shape and anti-gaming rules.
2. Add stage timing and compact output.
3. Re-run the local benchmark.
4. Decide whether the current Zincgraph lead is real, stable, and worth shipping.

## Suggested Gate

Use this as the next checkpoint:

- `zincgraph-fusion` must still beat `codegraph` on quality-only score.
- `codegraph` should remain faster on raw latency unless Zincgraph closes the gap.
- Zincgraph's score should not improve just because output got longer.
- Every score increase should be explainable by a better evidence trail.

## Related Implementation References

- [bench/compare.mjs](../../bench/compare.mjs)
- [tests/benchmark/compare.test.ts](../../tests/benchmark/compare.test.ts)
- [src/fusion/query-engine.ts](../../src/fusion/query-engine.ts)
- [src/freshness/fusion-store.ts](../../src/freshness/fusion-store.ts)
- [src/cli.ts](../../src/cli.ts)
