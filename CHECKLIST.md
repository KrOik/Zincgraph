# Benchmark Checklist

- [x] Identify the comparison contract and benchmark entrypoints
- [x] Reuse the current benchmark summary as the baseline reference
- [x] Pin down the current benchmark shortcoming: isolated-update fixture setup noise is counted in scoring output
- [x] Split isolated-update scoring output from setup diagnostics in `bench/compare.mjs`
- [x] Add a regression test that keeps setup chatter out of isolated-update scoring
- [ ] Compact `impact` output without removing `src/cli.ts` / `src/freshness/auto-sync.ts` evidence
- [x] Re-run typecheck, tests, build, benchmark, and the gate on the updated state
- [x] Decide whether a second product-side query/index pass is still justified after the benchmark signal is cleaned up
