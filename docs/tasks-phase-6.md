# Phase 6: 反馈闭环与压缩优化

**Goal:** 建立"压缩 → 检索 → 反馈 → ranking 调优"的学习循环，让压缩策略随使用模式自适应进化。实现 Headroom 与 Zincgraph 图谱/行为层的深度闭环。

**Depends on:** Phase 5 完成（压缩管线 + MCP 工具 + 相关性评分 + 缓存对齐均已验证通过）。

**What this phase builds:** 压缩反馈循环、review 压缩集成、learn 能力集成、端到端六阶段闭环验证。这些是 Zincgraph 独有能力——上游 Headroom 不包含图谱感知的反馈循环。

**核心闭环（Zincgraph 独有，任何上游单独不具备）：**

```
  explore/review 返回压缩结果
         ↓
  agent 调用 zincgraph_retrieve 展开某些内容
         ↓
  CompressionFeedback 记录检索模式
         ↓
  反馈到 ranking 权重 + 压缩策略
         ↓
  下次 explore 的排名和压缩更精准
         ↓
  learn 从 failed sessions 提取规则
         ↓
  更新 Ponytail 行为约束
         ↓
  下次 review 更准确
```

**核心集成点（已有代码 → 新增逻辑）：**

| 已有模块 | 集成位置 | 新增逻辑 |
|---|---|---|
| `src/fusion/query-engine.ts` | `FUSION_RANKING_POLICY` (L115) | 动态权重：feedback 信号调整 `routeWeights` 和 `fusionBoosts` |
| `src/behavior/graph-review.ts` | `GraphReviewAnalyzer` 输出 | 经 Headroom 压缩后发送，附带 CCR 标记 |
| `src/behavior/review-command.ts` | review 命令输出管线 | 压缩 + cross-turn context tracker |
| `src/compression/ccr-store.ts` | CCR 缓存 | 新增 `retrieval_count`, `last_retrieved_at` 用于反馈 |
| `src/freshness/fusion-store.ts` | fusion.sqlite | 新增 `compression_feedback` 表 |
| `src/mcp/tool-registry.ts` | `zincgraph_retrieve` 的 dispatch | 记录检索事件到 feedback store |
| `src/cli.ts` | 新增 `learn` 命令 | 委托 Headroom learn CLI |

---

## T6.1 — 压缩反馈循环

**What:** 接入 Headroom 的 `CompressionFeedback`，将检索行为信号回传到融合引擎的 ranking 权重。

**Code spec:** goal.md G6.1

**Create:**
- `src/compression/feedback-loop.ts` — 反馈循环核心
- `src/compression/feedback-store.ts` — 反馈数据持久化
- `src/compression/ranking-adjuster.ts` — 动态 ranking 权重调整器
- `tests/compression/feedback-loop.test.ts`

**修改：**
- `src/mcp/tool-registry.ts` — `zincgraph_retrieve` dispatch 中记录检索事件
- `src/fusion/query-engine.ts` — `FUSION_RANKING_POLICY` 接受动态调整

**反馈数据模型：**

```typescript
interface RetrievalEvent {
  hash: string;                    // CCR 哈希
  nodeId: string;                  // 关联的图谱节点
  source: 'graph' | 'vector' | 'fts';  // 原始来源
  contentType: string;             // 内容类型（code/json/text）
  kind: string;                    // 节点类型（function/class/method）
  retrievedAt: number;             // 检索时间
  queryContext: string;            // 触发检索的查询
}

interface FeedbackSummary {
  totalCompressions: number;
  totalRetrievals: number;
  retrievalRate: number;           // 检索率 = retrievals / compressions
  bySource: Record<string, { compressed: number; retrieved: number }>;
  byContentType: Record<string, { compressed: number; retrieved: number }>;
  byKind: Record<string, { compressed: number; retrieved: number }>;
  neverRetrievedCategories: string[];  // 从未被检索的类型
  frequentlyRetrievedCategories: string[];  // 频繁被检索的类型
}
```

**动态 ranking 调整规则：**

| 信号 | 条件 | 调整 |
|---|---|---|
| 频繁检索 graph 结果 | graph retrievalRate > 0.6 | `routeWeights['graph-first']` += 0.1, graph 压缩激进度 -= 1 级 |
| 从不检索 FTS 结果 | fts retrievalRate < 0.05 | FTS 结果压缩激进度 += 2 级 或直接过滤 |
| 频繁检索某类节点 | kind retrievalRate > 0.5 | 该类节点 ranking 优先级提升 |
| 代码片段检索率高 | code contentType retrievalRate > 0.7 | CodeCompressor 切换为 conservative 模式 |
| JSON 数组检索率低 | json contentType retrievalRate < 0.1 | SmartCrusher 切换为 aggressive 模式 |

**反馈数据存储（`feedback-store.ts`）：**
- SQLite 表 `compression_feedback`：
  - `retrieval_events(id, hash, node_id, source, content_type, kind, retrieved_at, query_context)`
  - `feedback_summary(period_start, period_end, json)` — 周期性聚合
  - `ranking_adjustments(adjusted_at, adjustment_type, field, old_value, new_value, reason)`

**`FusionRankingPolicy` 动态化：**

```typescript
interface DynamicFusionPolicy extends FusionRankingPolicy {
  feedbackAdjustments: {
    routeWeightOverrides?: Partial<Record<QueryRoute, number>>;
    fusionBoostOverrides?: Partial<FusionBoosts>;
    compressionAggressiveness?: Record<string, 'off' | 'conservative' | 'normal' | 'aggressive'>;
  };
}
```

`TopoSemanticQueryEngine` 在构造时接受可选的 `FeedbackSummary`，据此生成 `DynamicFusionPolicy`。

**Acceptance:**
- [ ] `zincgraph_retrieve` 每次调用记录 `RetrievalEvent` 到 `compression_feedback` 表
- [ ] `FeedbackSummary` 可从 `feedback-store` 正确聚合
- [ ] 模拟 10 次 explore + 选择性 retrieve 后，`RankingAdjuster` 生成有效调整建议
- [ ] 调整后的 ranking 反映在后续 explore 结果中（被频繁检索的类型排名上升）
- [ ] `ranking_adjustments` 表记录每次调整的原因和前后值
- [ ] `tests/compression/feedback-loop.test.ts` 通过 >= 8 test cases

---

## T6.2 — Review 压缩集成

**What:** graph-review 输出经 Headroom 压缩后发送给 agent，支持多轮 review 的 cross-turn context 感知。

**Code spec:** goal.md G6.2

**Create:**
- `src/compression/review-compressor.ts` — review 输出专用压缩器
- `tests/compression/review-compressor.test.ts`

**修改：**
- `src/behavior/review-command.ts` — 在 review 输出管线中接入压缩

**集成位置：** `review-command.ts` 的 review 输出阶段

当前 review 输出是 `GraphReviewFindings[]` 拼接为文本。新流程：

```
原流程: PonytailReview -> GraphReview叠加 -> findings[] -> 文本输出

新流程: PonytailReview -> GraphReview叠加 -> findings[] -> ReviewCompressor -> 压缩文本 + CCR
```

**ReviewCompressor 策略：**

| Finding 类型 | 压缩策略 |
|---|---|
| same-signature | 保留新函数签名 + 匹配函数签名，省略完整代码 |
| redundant-import | 保留 import 语句，省略文件上下文 |
| yagni | 保留调用者列表摘要，省略完整调用链 |
| dead-code | 保留节点名 + 调用计数(0)，省略完整定义 |
| cycle-dependency | 保留循环路径摘要，省略中间节点详情 |

**分类去重：** 当多个 finding 属于同一类型 + 同一文件时，合并为一条聚合 finding：
```
# Before: 5 条 same-signature findings
same-signature: formatDateTime in src/utils/date.ts matches formatDateTime in src/helpers/time.ts
same-signature: formatDateTime in src/utils/date.ts matches formatDateTime in src/lib/format.ts
same-signature: parseTimestamp in src/utils/date.ts matches parseTimestamp in src/helpers/time.ts
...

# After: 1 条聚合 finding
same-signature (3 matches): src/utils/date.ts has 3 functions with duplicates elsewhere
  - formatDateTime: matches in src/helpers/time.ts, src/lib/format.ts
  - parseTimestamp: matches in src/helpers/time.ts
  [Retrieve full details: zincgraph_retrieve hash=abc123]
```

**Cross-turn Context Tracker：**
- 在多轮 review 中维护已讨论 finding 的列表
- 新一轮 review 输出时，已讨论的 finding 降级为摘要或省略
- 通过 CCR hash 追踪哪些 finding 的原始数据已被 agent 检索过

**Acceptance:**
- [ ] `zincgraph review <project> --diff` 输出经压缩，相同 finding 类型被聚合
- [ ] 压缩后的 review 输出包含 CCR hash，可通过 `zincgraph_retrieve` 展开完整 findings
- [ ] 多轮 review 中（同一 session 多次调用），已讨论 finding 不重复详细输出
- [ ] review 输出的 token 数相比未压缩版本减少 > 30%
- [ ] `tests/compression/review-compressor.test.ts` 通过 >= 5 test cases

---

## T6.3 — Learn 集成

**What:** 接入 `headroom learn` 能力，从失败 session 中提取改进信号，反哺 Ponytail 行为约束。

**Code spec:** goal.md G6.3

**Create:**
- `src/compression/learn-integration.ts` — Learn 集成适配器
- `tests/compression/learn-integration.test.ts`

**修改：**
- `src/cli.ts` — 新增 `zincgraph learn` 命令

**Learn 能力：** Headroom 的 `headroom learn` 挖掘失败 session 的历史记录，识别模式并生成纠正规则。

**Zincgraph 集成方案：**

1. **Session 日志收集：** Zincgraph 的 MCP server 记录每次 tool call 的输入/输出/耗时/错误。日志存储在 `fusion.sqlite` 的 `session_logs` 表。

2. **失败检测：** 自动识别失败模式：
   - review finding 被 agent 忽略（agent 未采纳 finding → 可能是误报）
   - retrieve 调用后 agent 未使用检索结果（压缩过度 → 信息丢失）
   - explore 返回 0 结果（索引不完整 → 需要 re-sync）

3. **规则生成：** 将学习结果输出为 Ponytail 兼容的行为约束：
   - AGENTS.md 格式（用于 Zincgraph 项目自身）
   - CLAUDE.md / GEMINI.md 格式（用于目标 agent）

4. **CLI 命令：**

```
zincgraph learn [options]
  --from-failures <path>    从指定的 session log 学习
  --from-history            从 fusion.sqlite 的 session_logs 表学习
  --output <format>         输出格式：agents-md | claude-md | gemini-md | json
  --min-occurrences <n>     模式最少出现次数才生成规则（默认 3）
  --dry-run                 只分析不写入
```

**LearnIntegrationAdapter：**

```typescript
interface LearnIntegrationAdapter {
  analyzeFailures(logs: SessionLog[]): LearnResult;
  generateRules(result: LearnResult, format: RuleFormat): string;
  applyRules(rules: string, targetPath: string): void;  // 写入 AGENTS.md / CLAUDE.md
}

interface LearnResult {
  patterns: FailurePattern[];
  rules: GeneratedRule[];
  confidence: number;
}

interface FailurePattern {
  type: 'review-false-positive' | 'compression-over-aggressive' | 'empty-search' | 'stale-index';
  occurrences: number;
  affectedFiles: string[];
  description: string;
  suggestedRule: string;
}
```

**Acceptance:**
- [ ] `zincgraph learn --from-history --dry-run` 输出分析报告（不修改任何文件）
- [ ] 报告中包含失败模式分类和出现次数
- [ ] `zincgraph learn --from-failures <log-path> --output agents-md` 生成 AGENTS.md 格式的约束规则
- [ ] 生成的规则可被 Ponytail 的 instruction builder 消费
- [ ] `--min-occurrences` 参数有效过滤低频模式
- [ ] `tests/compression/learn-integration.test.ts` 通过 >= 5 test cases

---

## T6.4 — 端到端六阶段闭环验证

**What:** 完整闭环验证，覆盖 Phase 0-6 全部能力。

**Create:**
- `tests/integration/six-phase-pipeline.test.ts` — 六阶段端到端测试
- `tests/integration/compression-feedback.test.ts` — 反馈循环专项测试

**测试场景 1 — 完整管线：**
1. `zincgraph init <project>` — Phase 0: Bootstrap
2. `zincgraph vectorize <project>` — Phase 1: 向量索引
3. `zincgraph explore "token validation"` — Phase 2: 融合查询 + Phase 5: 带压缩
4. `zincgraph review <project> --diff` — Phase 3: 图谱增强 + Phase 6: 带压缩
5. `zincgraph retrieve <hash>` — Phase 5: CCR 检索
6. `zincgraph compression-stats` — Phase 5: 统计验证
7. 再次 `zincgraph explore` — Phase 6: 排名反映反馈信号

**测试场景 2 — 反馈循环：**
1. 连续执行 5 次 explore + 选择性 retrieve
2. 验证 `FeedbackSummary` 正确聚合
3. 验证 `RankingAdjuster` 生成调整建议
4. 第 6 次 explore 的排名与第 1 次有可测量差异
5. 验证被频繁检索的内容类型排名上升

**测试场景 3 — Learn 闭环：**
1. 模拟 3 次 review，其中 1 次包含误报 finding
2. `zincgraph learn --from-history` 识别误报模式
3. 生成的规则被写入约束文件
4. 后续 review 不再产生同类误报

**测试场景 4 — MCP 全工具验证：**
1. MCP `tools/list` 返回 17 个工具
2. 对每个工具执行 `tools/call`，验证响应格式正确
3. 重点验证压缩工具链：`compress` → `retrieve` → `stats`

**Acceptance:**
- [ ] `tests/integration/six-phase-pipeline.test.ts` 通过：init → vectorize → explore(压缩) → review(压缩) → retrieve → stats
- [ ] `tests/integration/compression-feedback.test.ts` 通过：多次交互后排名有可测量变化
- [ ] Learn 场景：误报 finding 被识别并生成约束规则
- [ ] MCP 全工具场景：17 个工具均可调用
- [ ] 压缩统计：端到端管线中 `compressionRatio > 0`，`tokensSaved > 0`

---

## Phase 6 Exit Criteria

```bash
# 完整六阶段管线
zincgraph init <project>
zincgraph vectorize <project>
zincgraph explore "token validation"           # 带压缩的融合查询
# 预期：结果压缩，附带 CCR hash
zincgraph review <project> --diff              # 带压缩的图谱增强 review
# 预期：findings 聚合，附带 CCR hash
zincgraph retrieve <hash>                      # CCR 检索
# 预期：返回原始未压缩内容
zincgraph compression-stats                    # 压缩统计
# 预期：tokensSaved > 0, compressionRatio > 0

# 反馈循环验证
# 多轮 explore + 选择性 retrieve
# 后续 explore 排名反映检索偏好（通过 diff 对比验证）

# Learn 验证
zincgraph learn --from-history --dry-run
# 预期：输出分析报告
zincgraph learn --from-history --output agents-md
# 预期：生成 AGENTS.md 格式的行为约束

# MCP 全工具验证
echo '{"jsonrpc":"2.0","method":"tools/list","id":1}' | zincgraph mcp
# 预期：17 个工具
echo '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"zincgraph_compression_stats","arguments":{}},"id":2}' | zincgraph mcp
# 预期：返回统计信息

npx vitest run                                 # all pass
```
