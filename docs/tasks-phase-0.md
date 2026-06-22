# Phase 0: Bootstrap & 依赖验证

**Goal:** 验证三个上游项目作为依赖可用，建立 Zincgraph 桥接骨架。

**Depends on:** Nothing.

**关键风险：** `@zvec/zvec` npm 包的 Node.js 绑定源码不在本地 refer/ 中。如果 npm 包不可用，需要基于 C API 自写 N-API wrapper，这会显著增加工程量。此 Phase 的核心任务就是验证这一点。

---

## T0.1 — 项目脚手架

**What:** 创建 Zincgraph 项目骨架，配置三个上游依赖。

**Files to create/update:**
- `package.json` — 添加 dependencies: `@colbymchenry/codegraph`, `@zvec/zvec`（或本地路径引用）
- `tsconfig.json` — 已有，验证可用
- `tsup.config.ts` — 已有，更新 entry points
- `src/index.ts` — barrel export
- `src/cli.ts` — CLI 入口（此阶段仅 `--version`）

**Dependency resolution strategy:**
- CodeGraph: 优先 npm 包 `@colbymchenry/codegraph`；不可用则 `file:./refer/codegraph`
- Ponytail: `file:./refer/ponytail/ponytail-mcp` 或直接引用 hooks/
- Zvec: `npm install @zvec/zvec`

**Do:**
1. 更新 `package.json` dependencies
2. 创建 `src/index.ts`（re-export bridge modules）和 `src/cli.ts`（commander skeleton）
3. `npm install` + `npm run build` + `npm run typecheck`
4. 修复任何 type 或 build 问题

**Acceptance:**
- [ ] `npm install` 成功，无 peer dependency 冲突
- [ ] `npm run typecheck` exit 0
- [ ] `npm run build` 产出 `dist/index.js`, `dist/cli.js`
- [ ] `node dist/cli.js --version` 打印版本号

---

## T0.2 — CodeGraph 集成验证

**What:** 验证 CodeGraph 可被 Zincgraph 编程式调用和 CLI 委托。

**Create:**
- `src/bridge/codegraph-adapter.ts` — CodeGraph API 封装
- `tests/bridge/codegraph.test.ts`

**Verify:**
1. 可导入 CodeGraph 核心类型（CodeNode, CodeEdge, GraphStore 等）
2. 可编程式调用 index：给一个项目路径 → 得到图谱数据
3. 可编程式调用 search/explore：给一个查询 → 得到结果
4. CodeGraph CLI 命令可被 `commander` 委托为 `zincgraph` 子命令
5. MCP server 可被 Zincgraph 包装（在其上叠加自有工具）

**Acceptance:**
- [ ] `import { CodeNode } from '@colbymchenry/codegraph'` 编译通过
- [ ] 编程式索引测试项目 → nodes/edges count > 0
- [ ] `zincgraph status <project>` 委托 CodeGraph 输出正确统计
- [ ] `tests/bridge/codegraph.test.ts` 通过 ≥ 5 test cases

---

## T0.3 — Ponytail 集成验证

**What:** 验证 Ponytail 行为约束可被 Zincgraph 注入和调用。

**Create:**
- `src/bridge/ponytail-adapter.ts` — Ponytail API 封装
- `tests/bridge/ponytail.test.ts`

**Verify:**
1. 可导入 instruction builder，按 mode 生成规则文本
2. `buildInstructions('full')` → 非空文本，包含 6 步决策阶梯
3. `buildInstructions('off')` → 空或最小文本
4. Ponytail MCP server 可被 Zincgraph unified server 组合
5. review/audit 命令可被 Zincgraph CLI 委托调用

**Acceptance:**
- [ ] `buildInstructions('full')` 返回文本包含决策阶梯所有 6 步
- [ ] `buildInstructions('ultra')` 包含 "delete before adding" 语言
- [ ] `zincgraph review <project> --diff` 委托 Ponytail 输出标记
- [ ] `tests/bridge/ponytail.test.ts` 通过 ≥ 4 test cases

---

## T0.4 — Zvec 可用性验证（关键路径）

**What:** 验证 `@zvec/zvec` Node.js 绑定是否可用。**整个 bridge 方案的关键风险点。**

**Create:**
- `src/bridge/zvec-probe.ts` — Zvec 探测脚本
- `tests/bridge/zvec-probe.test.ts`

**Scenario A — `@zvec/zvec` npm 包可用：**
1. `npm install @zvec/zvec` 成功
2. `init({ log_level: 'info' })` 执行无错
3. `create_and_open(path, schema, option)` 创建 collection
4. `collection.insert(docs)` 插入文档
5. `collection.query(queries, topk)` 返回结果
6. FTS query: `Fts({ match_string: 'test' })` 返回 BM25 排序结果

**Scenario B — npm 包不可用：**
1. 评估 `refer/zvec/src/include/zvec/c_api.h` C API 表面
2. 用 `node-addon-api` 写最小 wrapper：init, create, insert, query
3. 构建 libzvec shared library → N-API binding → Node.js 调用
4. 若工作量 > 2 周，考虑降级方案：SQLite FTS5 + 简单余弦相似度

**Acceptance:**
- [ ] Scenario A: `init()` + `create_and_open()` + `insert()` + `query()` 全链路通过
- [ ] Scenario A: FTS query 返回 BM25 排序结果
- [ ] Scenario B: 若 A 失败，输出 N-API wrapper 可行性评估（工作量、风险）
- [ ] 决策记录在 `docs/decisions.md`：明确选择 A 或 B

---

## Phase 0 Exit Criteria

```bash
npm install                        # 三个依赖全部安装成功
npm run typecheck                  # exit 0
npm run build                      # 产出 dist/
node dist/cli.js --version         # 打印版本
node dist/cli.js status <project>  # 委托 CodeGraph 输出统计

# Zvec 关键验证（Scenario A）:
node -e "const z = require('@zvec/zvec'); z.init(); console.log('zvec ok')"

npx vitest run                     # all pass
```
