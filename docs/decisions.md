# Decisions

## Phase 0 — Zvec integration path

**Decision:** Start with **Scenario A (`@zvec/zvec` npm binding)** and keep
Scenario B as a documented fallback.

**Evidence to verify in this repository:**

- `npm install` must install `@zvec/zvec@0.5.x`.
- `npm run typecheck` and `npm run build` must compile the bridge adapter.
- `node dist/cli.js probe zvec` must load the package and run the safe init
  probe.
- `node dist/cli.js probe zvec --live` is the live collection
  create/insert/query probe when the installed binding exposes those methods.

**Fallback if Scenario A fails:** use `refer/zvec/src/include/zvec/c_api.h` as
the N-API wrapper surface. Required bindings include initialization, collection
create/open, insert, vector query, and FTS query parameters. Estimated work is
**2+ weeks** because it includes native builds, memory ownership, cross-platform
packaging, and TypeScript API maintenance.

**Temporary fallback for early bridge work:** SQLite FTS5 plus a local
cosine-similarity table can unblock Phase 1/2 experiments, but it is not the
production vector engine.

## Phase 5 — Headroom integration path

**Decision:** Start with **Scenario A (`headroom-ai` npm TS SDK)** and keep
Scenario B (proxy HTTP API) and Scenario C (Python CLI subprocess) as
documented fallbacks.

**Evidence to verify in this repository:**

- `npm install` must install `headroom-ai@0.26.x`.
- `npm run typecheck` and `npm run build` must compile the bridge adapter.
- `node dist/cli.js probe headroom` must load the package and run the safe
  compress probe.
- `compress(messages, { model })` must return a valid `CompressionResult` with
  `tokensSaved > 0` and `compressionRatio > 0`.
- CCR store must be accessible: write original content, retrieve by hash.

**Key risk:** The TS SDK (`headroom-ai`) may not expose the full Python SDK
surface. Specifically, SmartCrusher, CodeCompressor, and IntelligentContext
transforms may only be available through the Python pipeline or proxy server.
The `relevance` module (BM25/embedding/hybrid) and CacheAligner
(DynamicContentDetector) may also be Python-only. T5.1 probe must verify each
capability independently.

**Fallback if Scenario A partial:** use `headroom-ai` TS SDK for available
capabilities (compress, CCR, MCP tools). For missing capabilities:

1. **Scenario B — Proxy HTTP API:** Start `headroom proxy --port 8787` as a
   background process. Send compression requests to `POST /v1/chat/completions`.
   This gives access to the full Python pipeline (SmartCrusher, CodeCompressor,
   CacheAligner, IntelligentContext) without reimplementing in TypeScript.
   Downside: requires a running proxy process, adds network latency.

2. **Scenario C — Python CLI subprocess:** `spawnSync('headroom', ['compress', ...])`
   or `spawnSync('python3', ['-m', 'headroom.cli', ...])`.
   Gives full Python SDK access but adds Python runtime dependency.

**Recommended hybrid approach:** Use TS SDK for CCR storage, MCP tools, and
basic compression. Use proxy HTTP API for advanced transforms (SmartCrusher,
CodeCompressor) when needed. This minimizes Python dependency while retaining
full compression capability.

**Integration with fusion engine:** The compression hook is injected between
`mergeCandidates` (query-engine.ts L558) and `applyContextBudget`
(context-budget.ts L69) via a new `compressResults?` field in
`QueryEngineDependencies`. This is a non-invasive extension: the fusion engine
works without compression when the dependency is not provided.

**Integration with MCP server:** Three new tools (`zincgraph_compress`,
`zincgraph_retrieve`, `zincgraph_compression_stats`) follow the same
`fusionTool()` builder pattern as existing fusion tools. Tool count increases
from 14 to 17.
