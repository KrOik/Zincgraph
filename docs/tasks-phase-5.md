# Phase 5: 上下文压缩桥接层

**Goal:** 将 Headroom 的压缩引擎接入 Zincgraph 的融合查询管线，实现"查询结果 → 智能压缩 → CCR 可检索存储"。解决融合查询结果到 LLM 上下文之间的信息密度断层。

**Depends on:** Phase 4 完成（统一 MCP + CLI 可用，融合引擎、行为层、安装器均已验证通过）。

**What this phase builds:** Headroom bridge adapter、融合结果压缩器、相关性评分替换、缓存对齐、MCP 压缩工具扩展。这些都是新代码——上游 Headroom 不包含这个桥接层。

**关键风险：** `headroom-ai` npm 包的 TypeScript SDK 功能覆盖度。TS SDK 可能不完整支持 Python SDK 的全部能力（如 SmartCrusher、CodeCompressor）。若 TS SDK 能力不足，需通过 Python 子进程或 Headroom proxy HTTP API 作为 fallback。此 Phase 的 T5.1 核心任务就是验证这一点。

**核心集成点（已有代码 → 新增逻辑）：**

| 已有模块 | 集成位置 | 新增逻辑 |
|---|---|---|
| `src/fusion/query-engine.ts` | `mergeCandidates` (L558) 之后、`applyContextBudget` (L69) 之前 | 插入 `FusionCompressor` 压缩阶段 |
| `src/fusion/context-budget.ts` | `applyContextBudget` (L69) 整体替换或包装 | 可选：用 Headroom IntelligentContext 替换内部 `fitExcerptToBudget`（注意：该函数未导出，需 export 或在 `applyContextBudget` 层面替换） |
| `src/mcp/tool-registry.ts` | `ZINCGRAPH_TOOL_NAMES` (L43) + `callTool` switch (L161) | 新增 3 个 Headroom 工具 |
| `src/mcp/unified-server.ts` | server creation (L12) | CacheAligner middleware |
| `src/bridge/` | 新文件 | `headroomAdapter.ts` 探测 + 封装 |
| `fusion.sqlite` | 新增表 | CCR 压缩缓存 + 压缩元数据 |

---

## T5.1 — Headroom 集成验证（关键路径）

**What:** 验证 `headroom-ai` TypeScript SDK 可被 Zincgraph 桥接。**整个压缩层方案的关键风险点。**

**Create:**
- `src/bridge/headroomAdapter.ts` — Headroom API 封装 + 探测
- `src/bridge/headroomProbe.ts` — 可用性探测脚本
- `tests/bridge/headroom.test.ts`

**Scenario A — `headroom-ai` npm 包可用：**
1. `npm install headroom-ai` 成功
2. `import { compress } from 'headroom-ai'` 编译通过
3. `compress(messages, { model: 'gpt-4o' })` 返回 `CompressResult`（`messages`, `tokensBefore`, `tokensAfter`, `tokensSaved`, `compressionRatio`, `transformsApplied`, `ccrHashes`, `compressed`）
4. `HeadroomClient` 可包装 OpenAI/Anthropic SDK
5. CCR 存储：`CompressionStore` 可通过 TS SDK 访问
6. MCP tools：`headroom_compress`, `headroom_retrieve`, `headroom_stats` 可通过 MCP server 暴露

**Scenario B — TS SDK 能力不足：**
1. 评估 TS SDK 导出表面（`compress`, `HeadroomClient`, `SharedContext` 等）
2. 检查是否暴露 SmartCrusher、CodeCompressor、IntelligentContext 等核心 transform
3. 若不暴露：通过 Headroom proxy HTTP API (`POST /v1/chat/completions`) 作为 fallback
4. 最终 fallback：`spawnSync('headroom', ...)` Python CLI 子进程

**探测流程（参照 `zvecAdapter.ts` 的 probe 模式）：**

```typescript
interface HeadroomProbeResult {
  scenario: 'A:npm-sdk' | 'B:proxy-http' | 'C:python-cli';
  packageAvailable: boolean;
  exports: string[];
  compressWorks: boolean;
  ccrAvailable: boolean;
  mcpToolsAvailable: boolean;
  relevanceScorerAvailable: boolean;
  cacheAlignerAvailable: boolean;
  errors: string[];
  fallbackAssessment?: HeadroomFallbackAssessment;
}
```

**Acceptance:**
- [ ] Scenario A: `compress()` 返回有效 `CompressionResult`，`compressionRatio > 0`
- [ ] Scenario A: CCR 存储可写入和检索（`headroom_retrieve` 按 hash 返回原始内容）
- [ ] Scenario A: `headroom_compress` + `headroom_retrieve` + `headroom_stats` MCP 工具可用
- [ ] Scenario B: 若 A 不满足，输出 proxy HTTP API 或 Python CLI 可行性评估
- [ ] `HeadroomProbeResult` 结构体完整输出，决策记录在 `docs/decisions.md`
- [ ] `tests/bridge/headroom.test.ts` 通过 >= 5 test cases

---

## T5.2 — 融合结果压缩器

**What:** 在融合查询管线的 `mergeAndRank` 之后、`applyContextBudget` 之前插入 Headroom 压缩阶段。

**Code spec:** goal.md G5.2

**Create:**
- `src/compression/fusion-compressor.ts` — 融合结果压缩器核心
- `src/compression/compression-strategy.ts` — 按内容类型选择压缩策略
- `src/compression/ccr-store.ts` — CCR 压缩缓存（SQLite backend）
- `tests/compression/fusion-compressor.test.ts`

**集成位置：** `query-engine.ts` 的 `query()` 方法（L168-L200）

```
原流程: parse -> graph/vector/text candidates -> mergeCandidates -> slice topK
        -> attachAnnotations -> applyContextBudget -> ContextCapsule

新流程: parse -> graph/vector/text candidates -> mergeCandidates -> slice topK
        -> attachAnnotations -> [compressFusionResults] -> applyContextBudget -> ContextCapsule
```

**实现方案：** 扩展 `QueryEngineDependencies` 接口：

```typescript
interface QueryEngineDependencies {
  // ... existing fields ...
  compressResults?: FusionCompressionAdapter;  // Phase 5 新增
}

interface FusionCompressionAdapter {
  compress(candidates: FusionNode[], options: CompressionOptions): Promise<FusionCompressionResult>;
  retrieve(hash: string): Promise<string | null>;
  getStats(): CompressionStats;
}

interface FusionCompressionResult {
  compressedCandidates: FusionNode[];  // content 字段被压缩，附带 CCR 标记
  ccrHashes: Map<string, string>;      // nodeId -> hash 映射
  tokensSaved: number;
  compressionRatio: number;
}
```

**压缩策略路由（`compression-strategy.ts`）：**

> **实现注意：** Headroom TS SDK 仅导出配置类型（`SmartCrusherConfig`, `CodeCompressorConfig` 等），不导出 transform 实现类。实际压缩变换在 Headroom proxy 端执行。因此压缩策略路由需根据 T5.1 探测结果选择调用路径：Scenario A（TS SDK `compress()` 自动路由到正确 transform）、Scenario B（HTTP 请求到 proxy `/v1/compress`）、Scenario C（Python 子进程）。下表描述的是逻辑策略，具体调用方式由 T5.1 确定。

| 内容类型 | 来源 | 压缩器 | 策略 |
|---|---|---|---|
| 结构化 JSON 数组 | graph callers/callees | SmartCrusher | 提取常量字段，压缩稳定区间，保留异常值 |
| 代码片段 | vector 结果 | CodeCompressor | AST 感知截断，保留函数签名 + 关键调用 |
| 文本片段 | FTS 结果 | IntelligentContext | 多因子重要性评分，保留 diff-relevant 部分 |
| 混合内容 | 多源融合 | Pipeline | 先按类型分派，再统一 token budget |

**CCR 存储（`ccr-store.ts`）：**
- Backend: SQLite（复用 `fusion.sqlite`，新增 `ccr_entries` 表）
- Schema: `ccr_entries(hash TEXT PRIMARY KEY, content TEXT, content_type TEXT, created_at INTEGER, ttl INTEGER, retrieval_count INTEGER)`
- TTL 过期 + LRU 淘汰
- 支持 BM25 搜索（按内容关键词检索缓存条目）

**Acceptance:**
- [ ] `TopoSemanticQueryEngine.query()` 传入 `compressResults` 依赖后，返回的 `ContextCapsule` 中 candidate content 被压缩
- [ ] 压缩后的 candidate 包含 CCR 标记（`__headroom_compressed: true`, `__headroom_hash: "abc123"`）
- [ ] `ccr-store.retrieve(hash)` 返回原始未压缩内容
- [ ] 大型 callers 结果（100+ 节点）经 SmartCrusher 压缩后 token 减少 > 50%
- [ ] 代码片段经 CodeCompressor 压缩后保留函数签名和关键调用
- [ ] `compressionRatio` 和 `tokensSaved` 统计准确
- [ ] fusion.sqlite 中 `ccr_entries` 表有数据
- [ ] `tests/compression/fusion-compressor.test.ts` 通过 >= 8 test cases

---

## T5.3 — 相关性评分替换

**What:** 用 Headroom 的 `RelevanceScorer` 替代融合引擎中文本分支的 token-overlap 计分，解决 `nativeFts: false` 已知 gap。

**Code spec:** goal.md G5.3

**Create:**
- `src/compression/relevance-scorer.ts` — Headroom RelevanceScorer 适配器
- `tests/compression/relevance-scorer.test.ts`

**修改：**
- `src/fusion/query-engine.ts` — 文本分支评分逻辑

**集成位置：** `query-engine.ts` 中文本候选的评分阶段

当前文本分支使用内联 token overlap（`textBranch: 'fusion-store-token-overlap'`, `nativeFts: false`）。替换为：

```typescript
interface RelevanceScorerAdapter {
  score(query: string, documents: TextDocument[], options: ScorerOptions): ScoredDocument[];
}

interface ScorerOptions {
  mode: 'bm25' | 'embedding' | 'hybrid';
  bm25Weight?: number;      // hybrid 模式下 BM25 权重，默认 0.5
  embeddingWeight?: number;  // hybrid 模式下 embedding 权重，默认 0.5
}
```

**三级评分器：**

1. **BM25 模式：** 经典信息检索评分，适配代码领域的 TF-IDF 变体。直接调用 Headroom TS SDK 的 relevance 模块。
2. **Embedding 模式：** 语义相似度评分。复用 Zincgraph 已有的 embedding 基础设施（`LocalTokenEmbedding` / `OpenAIEmbedding`），计算 query 与 document 的余弦相似度。
3. **Hybrid 模式（默认）：** BM25 + embedding 加权融合。`finalScore = bm25Weight * bm25Score + embeddingWeight * embeddingScore`。

**FusionPolicy 变更：**
```typescript
// Before (query-engine.ts L48-51, hardcoded literal types):
export interface FusionPolicy {
  textBranch: 'fusion-store-token-overlap';
  nativeFts: false;
}

// After (类型需要宽泛化):
export interface FusionPolicy {
  textBranch: string;
  nativeFts: false | string;
  relevanceMode?: 'bm25' | 'embedding' | 'hybrid';
}

// Runtime value:
policy.textBranch = 'headroom-relevance';
policy.nativeFts = 'headroom-relevance';
policy.relevanceMode = 'hybrid';  // 'bm25' | 'embedding' | 'hybrid'
```

**注意：** 当前 `FusionPolicy` 接口使用 literal types（`'fusion-store-token-overlap'` 和 `false`）。T5.3 需要将这些类型宽泛化为 `string` 和 `false | string`，同时更新 `query-engine.ts` L202 的硬编码赋值。这是 Phase 5 对现有代码的唯一侵入性修改。

**Acceptance:**
- [ ] `RelevanceScorerAdapter.score()` 在 BM25 模式下返回有效 BM25 分数
- [ ] Hybrid 模式下文本分支评分同时考虑关键词匹配和语义相似度
- [ ] 融合查询结果中 `FusionPolicy.nativeFts` 不再为 `false`
- [ ] 自然语言查询（如 "how does authentication work"）的文本分支结果质量优于 token overlap
- [ ] BM25 / embedding / hybrid 三种模式均可通过配置切换
- [ ] `tests/compression/relevance-scorer.test.ts` 通过 >= 6 test cases

---

## T5.4 — 缓存对齐

**What:** 在 MCP server 中接入 Headroom CacheAligner，稳定 tool definitions 前缀以提升 LLM provider KV cache 命中率。

**Code spec:** goal.md G5.4

**Create:**
- `src/compression/cache-aligner.ts` — CacheAligner 适配器
- `tests/compression/cache-aligner.test.ts`

**修改：**
- `src/mcp/unified-server.ts` — 注册 CacheAligner 中间件

**问题场景：** Zincgraph 的 17 个 MCP 工具定义（含 Phase 5 新增的 3 个）在每次 `tools/list` 调用时包含动态内容：

| 动态字段 | 示例 | 影响 |
|---|---|---|
| 文件路径 | `/home/user/project/src/...` | 不同项目不同 |
| 时间戳 | `indexed_at: "2026-06-22T10:00:00Z"` | 每次 sync 变化 |
| Session ID | `session: "abc123"` | 每个 session 不同 |
| 版本号 | `version: "0.1.0"` | 版本更新时变化 |

**实现方案：**

```typescript
interface CacheAlignerAdapter {
  stabilize(toolDefinitions: ToolDefinition[]): StabilizedTools;
}

interface StabilizedTools {
  staticDefinitions: ToolDefinition[];   // 稳定前缀（可被 KV cache）
  dynamicMetadata: Record<string, any>;  // 动态内容（移入 metadata/header）
  alignmentReport: AlignmentReport;      // 对齐报告
}

interface AlignmentReport {
  dynamicFieldsDetected: string[];
  cacheablePrefixBytes: number;
  estimatedCacheHitRate: number;
}
```

CacheAligner 在 `unified-server.ts` 中作为 ListTools 响应中间件运行：
1. 拦截 `tools/list` 响应
2. 用 DynamicContentDetector 扫描每个 tool 的 `description` 和 `inputSchema`
3. 提取动态字段到 metadata
4. 返回稳定化的 tool definitions

**Acceptance:**
- [ ] `CacheAlignerAdapter.stabilize()` 识别 tool definitions 中的动态字段
- [ ] 稳定化后的 tool definitions 在不同项目/session 间保持一致（前缀不变）
- [ ] `AlignmentReport.dynamicFieldsDetected` 列出所有被提取的动态字段
- [ ] MCP `tools/list` 返回的 tool definitions 经过 CacheAligner 处理
- [ ] `tests/compression/cache-aligner.test.ts` 通过 >= 4 test cases

---

## T5.5 — MCP 压缩工具扩展

**What:** 在 unified MCP server 中注册 Headroom 相关的 3 个新工具，扩展 tool-registry。

**Code spec:** goal.md G5.5

**修改：**
- `src/mcp/tool-registry.ts` — 新增 3 个工具定义 + dispatch 逻辑
- `src/mcp/unified-server.ts` — 注入 Headroom 依赖

**新增工具：**

| 工具名 | 来源 | 说明 |
|---|---|---|
| `zincgraph_compress` | Headroom | 按需压缩任意内容，返回压缩结果 + CCR hash |
| `zincgraph_retrieve` | Headroom | 按 hash 检索原始未压缩内容 |
| `zincgraph_compression_stats` | Headroom | 当前 session 的压缩统计（节省 token 数、压缩比、检索次数） |

**工具定义：**

```typescript
// zincgraph_compress
{
  name: 'zincgraph_compress',
  description: 'Compress content to reduce token usage. Returns compressed content with a retrieval hash.',
  inputSchema: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'Content to compress' },
      content_type: {
        type: 'string',
        enum: ['code', 'json', 'text', 'auto'],
        description: 'Content type for strategy selection (default: auto)'
      },
      max_tokens: { type: 'number', description: 'Target token budget (default: 2000)' }
    },
    required: ['content']
  },
  annotations: { readOnlyHint: true, idempotentHint: false }
}

// zincgraph_retrieve
{
  name: 'zincgraph_retrieve',
  description: 'Retrieve original uncompressed content by hash.',
  inputSchema: {
    type: 'object',
    properties: {
      hash: { type: 'string', description: 'CCR hash from a previous compress operation' },
      query: { type: 'string', description: 'Optional search query for BM25-based retrieval' }
    }
  },
  annotations: { readOnlyHint: true, idempotentHint: true }
}

// zincgraph_compression_stats
{
  name: 'zincgraph_compression_stats',
  description: 'Get compression statistics for the current session.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  annotations: { readOnlyHint: true, idempotentHint: true }
}
```

**`ZincgraphToolRegistryDependencies` 扩展：**

```typescript
interface ZincgraphToolRegistryDependencies {
  // ... existing fields ...
  compressContent?: (content: string, contentType: string, maxTokens: number) => Promise<CompressionResult>;
  retrieveContent?: (hash: string, query?: string) => Promise<string | null>;
  getCompressionStats?: () => CompressionStats;
}
```

**`callTool` switch 扩展：**
```typescript
case 'zincgraph_compress':
  return dependencies.compressContent!(args.content, args.content_type ?? 'auto', args.max_tokens ?? 2000);
case 'zincgraph_retrieve':
  return dependencies.retrieveContent!(args.hash, args.query);
case 'zincgraph_compression_stats':
  return dependencies.getCompressionStats!();
```

**`ZINCGRAPH_TOOL_NAMES` 扩展：** 从 14 → 17。新增 `'zincgraph_compress'`, `'zincgraph_retrieve'`, `'zincgraph_compression_stats'`。

**Acceptance:**
- [ ] MCP `tools/list` 返回 17 个工具（原 14 + 3 压缩工具）
- [ ] `tools/call zincgraph_compress` 对一段 500 token 的代码返回压缩结果 + hash
- [ ] `tools/call zincgraph_retrieve` 用 hash 检索返回原始内容
- [ ] `tools/call zincgraph_compression_stats` 返回统计信息（`tokensSaved`, `compressionRatio`, `retrievalCount`）
- [ ] `content_type: 'auto'` 能正确检测内容类型并选择压缩策略
- [ ] `tests/mcp/compression-tools.test.ts` 通过 >= 6 test cases

---

## T5.6 — CLI 压缩命令 & 配置

**What:** 为压缩功能添加 CLI 入口和配置支持。

**修改：** `src/cli.ts`

**新增命令：**

| 命令 | 说明 |
|---|---|
| `zincgraph probe headroom` | 探测 Headroom 可用性（类似 `probe zvec`） |
| `zincgraph compression-stats` | 输出压缩统计 |
| `zincgraph config set compression.enabled true` | 启用/禁用压缩 |
| `zincgraph config set compression.strategy auto` | 设置压缩策略 |
| `zincgraph config set compression.maxTokens 8000` | 设置 token 预算 |
| `zincgraph config set relevance.mode hybrid` | 设置相关性评分模式 |

**配置持久化：** 存储在 `fusion.sqlite` 的 `metadata` 表：

| Key | 默认值 | 说明 |
|---|---|---|
| `compression.enabled` | `true` | 是否启用融合结果压缩 |
| `compression.strategy` | `'auto'` | 压缩策略：`auto | aggressive | conservative | off` |
| `compression.maxTokens` | `8000` | 上下文 token 预算 |
| `compression.ccrTtl` | `3600` | CCR 缓存 TTL（秒） |
| `relevance.mode` | `'hybrid'` | 相关性评分模式：`bm25 | embedding | hybrid` |
| `relevance.bm25Weight` | `0.5` | hybrid 模式下 BM25 权重 |
| `relevance.embeddingWeight` | `0.5` | hybrid 模式下 embedding 权重 |

**Acceptance:**
- [ ] `zincgraph probe headroom` 输出 `HeadroomProbeResult` 结构化信息
- [ ] `zincgraph compression-stats` 输出统计信息
- [ ] `zincgraph config set compression.enabled false` → explore 不再压缩
- [ ] `zincgraph config set relevance.mode bm25` → FTS 使用纯 BM25 评分
- [ ] 配置重启后仍有效（持久化在 fusion.sqlite）
- [ ] `tests/cli/compression-commands.test.ts` 通过 >= 4 test cases

---

## Phase 5 Exit Criteria

```bash
# Headroom 探测
zincgraph probe headroom
# 预期：scenario A/B/C 明确，核心能力可用

# 带压缩的融合查询
zincgraph init <project>
zincgraph vectorize <project>
zincgraph explore "token validation"
# 预期：返回压缩后的结果，附带 CCR 哈希标记
# 预期：FusionPolicy.nativeFts 不再是 false
# 预期：compressionRatio > 0

# CCR 检索
zincgraph retrieve <hash>
# 预期：返回原始未压缩内容

# 压缩统计
zincgraph compression-stats
# 预期：tokensSaved > 0, compressionRatio > 0

# MCP 验证
echo '{"jsonrpc":"2.0","method":"tools/list","id":1}' | zincgraph mcp
# 预期：返回 17 个工具

# 配置验证
zincgraph config set compression.strategy aggressive
zincgraph explore "formatDate"
# 预期：压缩比更高

zincgraph config set relevance.mode bm25
zincgraph explore "how does authentication work"
# 预期：FTS 使用纯 BM25 评分

npx vitest run    # all pass
```
