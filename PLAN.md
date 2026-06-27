# Benchmark Iteration Plan

## Objective
Improve the local benchmark signal for Zincgraph by tightening the `impact` output shape, then re-running the suite to confirm whether the current fusion path still leads on quality while staying lean and fast.

## Current contract
- Benchmark command: `npm run benchmark:compare`
- Gate command: `node bench/goal-gate.mjs bench/results/latest/summary.json`
- Acceptance:
  - `zincgraph-fusion` quality score stays at or above `codegraph`
  - `isolated-update-freshness` scores on the update/query evidence only, not fixture setup chatter
  - `isolated-update-freshness` top-hit credit flips to the real update evidence when the setup noise is removed
  - `npm test`, typecheck, and the benchmark gate remain green

## Iteration route
1. [x] Keep the isolated-update split in `bench/compare.mjs` so setup chatter stays out of scoring.
2. [x] Compact `impact` output so the topology task keeps the same evidence but spends fewer bytes on repeated graph-detail suffixes.
3. [x] Re-run the benchmark and inspect whether the impact density gate clears without regressing the update/freshness improvements.
4. [x] Confirm the remaining update/query output shape does not need a broader index or query rewrite for this iteration.

## Main risks
- accidentally dropping evidence that should stay in the scoring output
- changing benchmark semantics beyond the isolated-update task
- fixing the benchmark transcript without improving the actual update/query evidence

## Fallback
If the benchmark still misses the density gate after the compact output pass, keep the evidence lines, then move to the smallest product-side query/index improvement that the next benchmark run justifies.
