# Phase 3: 图谱增强行为层

**Goal:** 在 Ponytail 的规则引擎之上叠加图谱证据，让 review/audit 从主观判断升级为有数据的结论。

**Depends on:** Phase 2 完成（融合查询可用）。

**What this phase builds:** 图谱增强的 review/audit、语义去重检查、影响感知 YAGNI、上下文行为标注。这些都是 Zincgraph 独有的新代码——Ponytail 提供基础规则，Zincgraph 叠加图谱证据。

---

## T3.1 — 图谱增强 Review

**What:** 在 Ponytail review 的基础上，用图谱数据提供客观证据。

**Code spec:** goal.md G3.1

**Create:**
- `src/behavior/graph-review.ts` — 图谱增强逻辑
- `src/behavior/review-command.ts` — `zincgraph review` 命令（组合 Ponytail + 图谱）
- `tests/behavior/graph-review.test.ts`

**Ponytail 已有的 review 标记：** delete, stdlib, native, yagni, shrink

**Zincgraph 叠加的图谱检查：**
1. agent 引入新函数 → graph `searchNodes(sameSignature)` → "代码库中已有同签名函数 X (file:line)，不需要新建"
2. agent 引入新 import → graph `imports` → "依赖 Y 已通过 Z 间接引入了相同功能"
3. agent 创建新抽象 → graph `callers` → "这个抽象只有 1 个调用点，违反 YAGNI"
4. agent 添加新类 → graph `extends`/`implements` → "相似类层次已存在"

**Audit 增强：**
- CodeGraph 的 dead code 检测 → 作为 audit 的 "应该删除" 证据
- CodeGraph 的循环依赖检测 → 作为 audit 的 "架构问题" 证据

**Acceptance:**
- [ ] Review diff 中添加的函数与已有函数同签名 → 输出 "已有同签名函数 at file:line"
- [ ] Review diff 中添加新 import 但依赖已间接引入 → 输出冗余 import 提示
- [ ] Review diff 中添加的抽象只有 1 个调用者 → 输出 YAGNI 证据
- [ ] Audit 输出包含 CodeGraph 检测的 dead code 列表
- [ ] `tests/behavior/graph-review.test.ts` 通过 ≥ 5 test cases

---

## T3.2 — 语义去重检查

**What:** 用向量搜索检测语义相似的已有实现，在 agent 写新代码前提示复用。

**Code spec:** goal.md G3.2

**Create:**
- `src/behavior/dedup-check.ts` — DedupChecker
- `src/behavior/dedup-command.ts` — `zincgraph dedup` CLI 命令
- `tests/behavior/dedup-check.test.ts`

**DedupChecker 流程：**
1. 输入：待写代码的描述（函数签名 + docstring + 关键逻辑描述）
2. 向量搜索：Zvec collection 中查找语义相似的已有实现
3. 如果相似度 > threshold（默认 0.85）：
   - 返回建议："已有 function X (file:line) 实现了类似功能，建议复用而非重复实现"
4. 这是 Ponytail 决策阶梯第 4 步（已安装依赖）的语义增强版

**Acceptance:**
- [ ] 提议 `formatDate()` 而库中已有 `formatDateTime()` 相似度 87% → 建议复用
- [ ] 提议无相似已有实现的函数 → 无误报
- [ ] `zincgraph dedup --describe "parse JWT token and validate expiry"` → 返回相似实现（如有）
- [ ] `tests/behavior/dedup-check.test.ts` 通过 ≥ 4 test cases

---

## T3.3 — 影响感知 YAGNI

**What:** 用图谱 impact 分析让 YAGNI 决策数据驱动。

**Code spec:** goal.md G3.3

**Create:**
- `src/behavior/impact-yagni.ts` — ImpactAwareYagni
- `tests/behavior/impact-yagni.test.ts`

**ImpactAwareYagni 流程：**
1. agent 要添加新抽象/模块 → 先用 CodeGraph impact 分析现有代码
2. 计算："这个抽象能减少多少调用点的复杂度"
3. 影响半径 < threshold（默认 2 个调用点）→ 建议内联而非抽象
4. 影响半径大但调用点都已简单 → 建议保持现状
5. 输出量化证据："该抽象覆盖 N 个调用点，节省约 M 行重复代码" vs "只有 1 个调用者，建议内联"

**Acceptance:**
- [ ] 3 个调用点会用到新工具函数 → "proceed, saves N lines across 3 sites"
- [ ] 只有 1 个调用点 → "suggest inlining, insufficient reuse"
- [ ] 输出包含量化数据（调用点数、行数估算）
- [ ] `tests/behavior/impact-yagni.test.ts` 通过 ≥ 4 test cases

---

## T3.4 — 上下文行为标注

**What:** explore 返回的上下文附带行为约束标注，让 agent 在看到代码的同时获得行为约束信息。

**Code spec:** goal.md G3.4

**Update:** `src/fusion/context-budget.ts`（标注注入逻辑）

**标注类型：**
- "这段代码可以用 stdlib X 替代" → 决策阶梯第 2 步
- "和 Y 文件中的实现语义重复" → 语义去重
- "图谱中无调用者" → dead code 提示
- "这段代码可以用 Node.js 原生 X 替代" → 决策阶梯第 3 步

**触发条件：**
- 每个 explore 结果节点，检查是否有 stdlib 替代（查 Ponytail platform-native catalog）
- 检查是否有语义相似的其他实现（向量搜索）
- 检查图谱中入边数是否为零（dead code）

**Acceptance:**
- [ ] explore 一个用了 lodash 的函数 → 标注 "可用 stdlib structuredClone 替代"
- [ ] explore 一个无调用者的函数 → 标注 "无调用者 (dead code?)"
- [ ] explore 一个和另一文件语义相似的函数 → 标注 "语义相似于 X"
- [ ] 无约束命中时不产生标注（无误报）
- [ ] `tests/fusion/context-annotations.test.ts` 通过 ≥ 4 test cases

---

## Phase 3 Exit Criteria

```bash
# 图谱增强 review
zincgraph review <project> --diff
# 预期：输出包含图谱证据（"已有同签名函数"、"只有1个调用者"）

# 语义去重
zincgraph dedup --describe "format date as ISO string"
# 预期：如果库中有相似实现，返回复用建议

# 影响感知 YAGNI
# 通过 MCP: zincgraph_review 工具返回带图谱证据的 review

# 上下文标注
zincgraph explore "formatDate"
# 预期：如果有语义相似函数，输出中包含复用建议

npx vitest run                     # all pass
```
