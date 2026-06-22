# Phase 2: 融合查询引擎

**Goal:** 将 CodeGraph 的图谱查询与 Zvec 的向量/FTS 查询融合为统一的排名管线。这是 Zincgraph 的核心差异化。

**Depends on:** Phase 1 完成（向量数据就绪）。

**What this phase builds:** 三路并行查询 → 去重合并 → 排名的融合引擎，意图路由，上下文预算，freshness gate。这些都是新代码。

---

## T2.1 — 融合查询管线

**What:** 三路并行子查询 → 去重 → 加权排名 → 输出 ContextCapsule。

**Code spec:** goal.md G2.1

**Create:**
- `src/fusion/query-engine.ts` — TopoSemanticQueryEngine
- `tests/fusion/query-engine.test.ts`

**查询流程：**
1. 解析约束：剥离 `language:`, `kind:`, `file:`, `path:` → scalar filters
2. 并行发起三路子查询：
   a. **Graph 精确**：CodeGraph `searchNodes(strippedText, scalarFilters)` → 精确符号匹配
   b. **Vector 语义**：Zvec `collection.query(embedding, topk, filter)` → 语义相似
   c. **FTS 文本**：Zvec `collection.query(Fts(matchString), topk, filter)` → 关键词匹配
3. 去重合并：以 `node_id` 为 key 合并三个结果集
4. 排名加权：
   - 精确符号提升：graph 精确匹配的结果加权（+30%）
   - 图邻近度提升：在调用链/继承链上的结果加权（+15%）
   - 新鲜度惩罚：manifest stale 的候选降权（-20%）
5. 构建 `ContextCapsule`：nodes + edges + documents + freshness + policy + warnings

**Acceptance:**
- [ ] `query('token validation')` 同时返回 graph 精确匹配和 vector 语义匹配
- [ ] 重复节点（graph + vector 都命中）只出现一次，分数更高
- [ ] `query('import type')` with `kind:function` filter → 只返回 functions
- [ ] ContextCapsule.freshness 包含 fresh/stale/failed 计数
- [ ] `tests/fusion/query-engine.test.ts` 通过 ≥ 8 test cases

---

## T2.2 — 意图路由

**What:** 根据查询特征自动选择最优查询路径。

**Code spec:** goal.md G2.2

**Create:**
- `src/fusion/intent-router.ts`
- `tests/fusion/intent-router.test.ts`

**路由规则：**
- 精确符号查询（如 `"authenticateUser"`）→ graph-first（CodeGraph 精确搜索优先）
- 自然语言问题（如 `"how does auth work"`）→ hybrid（三路并行）
- 文件/路径限定查询（如 `"path:src/api authenticate"`）→ graph-first + filter
- 语义相似性查询（如 `"similar to token validation"`）→ vector-first

**路由判定启发式：**
- 查询是单个 PascalCase/camelCase 标识符 → 精确符号
- 查询包含 `path:` / `file:` 前缀 → 路径限定
- 查询包含 "similar" / "like" / "related" → 语义
- 其他 → hybrid

**Acceptance:**
- [ ] `route('authenticateUser')` → `'graph-first'`
- [ ] `route('how does auth work')` → `'hybrid'`
- [ ] `route('path:src/api authenticate')` → `'graph-first-filter'`
- [ ] `route('similar to token validation')` → `'vector-first'`
- [ ] `tests/fusion/intent-router.test.ts` 通过 ≥ 6 test cases

---

## T2.3 — 上下文预算

**What:** 控制返回给 agent 的上下文总量，防止信息过载。

**Code spec:** goal.md G2.3

**Create:**
- `src/fusion/context-budget.ts`
- `tests/fusion/context-budget.test.ts`

**裁剪策略：**
- 默认 token 预算：8000（可配置）
- 优先级：graph-confirmed > vector-confirmed > FTS-only
- 同源文件的结果合并展示（减少冗余上下文）
- 超长函数体截断（保留签名 + docstring + 前 20 行）

**Acceptance:**
- [ ] 100 个结果 → 裁剪到 fit 8000 token 预算
- [ ] graph-confirmed 结果优先保留，FTS-only 优先被裁掉
- [ ] 同一文件的 5 个函数合并为 1 个文件上下文块
- [ ] `tests/fusion/context-budget.test.ts` 通过 ≥ 4 test cases

---

## T2.4 — Freshness Gate

**What:** 查询前检查向量数据新鲜度；review/audit 在索引不新鲜时拒绝或自动 sync。

**Code spec:** goal.md G2.4

**Create:**
- `src/freshness/freshness-gate.ts`
- `tests/freshness/freshness-gate.test.ts`

**Gate 行为：**
- 查询时：manifest 中有 stale 文件 → ContextCapsule.freshness 包含警告（"3 files have stale embeddings"）
- review/audit 时：
  1. 检查 manifest freshness
  2. 如果有 stale/pending → 触发增量 sync
  3. sync 完成后执行 review/audit
  4. sync 失败 → 告知 agent "索引不新鲜，结果可能不准确"
- `--force` flag：跳过 freshness 检查

**Acceptance:**
- [ ] 查询时 stale 文件有 ⚠️ 标记
- [ ] review 时 stale 索引 → 自动触发 sync → 然后执行
- [ ] sync 失败 → 输出 warning "index not fresh"
- [ ] `--force` → 跳过检查直接执行
- [ ] `tests/freshness/freshness-gate.test.ts` 通过 ≥ 4 test cases

---

## T2.5 — 融合 CLI 集成

**What:** 将融合引擎接入 CLI。

**Update:** `src/cli.ts`

**新增/更新命令：**
- `zincgraph explore <query>` — 使用融合引擎（graph + vector + FTS），替代 CodeGraph 的 graph-only explore
- `zincgraph search <query>` — 支持字段限定（`kind:`, `lang:`, `path:`）

**Acceptance:**
- [ ] `zincgraph explore "token validation"` 返回融合结果（graph + vector）
- [ ] `zincgraph search kind:function name:auth` 返回匹配的函数
- [ ] 结果中包含 freshness 状态
- [ ] `tests/cli.test.ts` 更新并通过

---

## Phase 2 Exit Criteria

```bash
zincgraph init <project>
zincgraph vectorize <project>
zincgraph explore "token validation"
# 预期：同时返回 graph 精确匹配和 vector 语义匹配
# 预期：重复节点只出现一次
# 预期：stale 文件有 ⚠️ 标记

zincgraph search kind:function name:handle
# 预期：返回匹配的函数节点

npx vitest run                     # all pass
```
