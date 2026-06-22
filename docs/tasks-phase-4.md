# Phase 4: 闭环与生产就绪

**Goal:** 统一 MCP Server、统一 CLI、统一安装器，让 Zincgraph 成为一个可直接使用的产品。

**Depends on:** Phase 3 完成。

**What this phase builds:** 统一的 MCP server（组合三个上游的工具）、统一 CLI 入口、统一安装器、增量同步集成。

---

## T4.1 — 统一 MCP Server

**What:** 一个 MCP Server 暴露三个上游 + 融合层的所有工具。

**Code spec:** goal.md G4.1

**Create:**
- `src/mcp/unified-server.ts` — 统一 MCP server
- `src/mcp/tool-registry.ts` — 工具注册表
- `tests/mcp/unified-server.test.ts`

**工具清单：**

| 来源 | 工具 | 说明 |
|---|---|---|
| CodeGraph | `zincgraph_explore` | 代码探索（被融合版替代） |
| CodeGraph | `zincgraph_search` | 符号搜索 |
| CodeGraph | `zincgraph_node` | 单符号/文件深度视图 |
| CodeGraph | `zincgraph_callers` | 调用者枚举 |
| CodeGraph | `zincgraph_callees` | 被调用者列表 |
| CodeGraph | `zincgraph_impact` | 影响半径分析 |
| CodeGraph | `zincgraph_affected` | 受影响测试推荐 |
| CodeGraph | `zincgraph_status` | 索引统计 |
| Ponytail | `zincgraph_ponytail_instructions` | 行为约束规则集 |
| Ponytail | `zincgraph_review` | 图谱增强 review |
| Ponytail | `zincgraph_audit` | 图谱增强 audit |
| Ponytail | `zincgraph_debt` | 技术债务收割 |
| Fusion | `zincgraph_semantic_search` | 向量增强语义搜索 |
| Fusion | `zincgraph_dedup_check` | 语义去重检查 |

**Server 模式：**
- Direct (stdio)：单客户端直连
- Daemon：后台进程，多客户端通过 socket 共享
- 复用 CodeGraph 的 daemon 架构（不重写）

**Acceptance:**
- [ ] MCP server 启动，`initialize` 返回全部 14 个工具
- [ ] `tools/call` 对 CodeGraph 工具（如 `zincgraph_callers`）正确委托给 CodeGraph
- [ ] `tools/call` 对 Ponytail 工具（如 `zincgraph_review`）正确委托给 Ponytail
- [ ] `tools/call` 对融合工具（如 `zincgraph_semantic_search`）调用 Zincgraph 融合引擎
- [ ] `tests/mcp/unified-server.test.ts` 通过 ≥ 8 test cases

---

## T4.2 — 统一 CLI

**What:** `zincgraph` 命令委托 CodeGraph 子命令 + 自有命令。

**Code spec:** goal.md G4.2

**Update:** `src/cli.ts`

**命令映射：**

| 类型 | 命令 | 实际执行 |
|---|---|---|
| 委托 | `init`, `index`, `status`, `search`, `node`, `callers`, `callees`, `impact`, `affected`, `watch`, `daemon`, `install`, `uninstall` | CodeGraph CLI |
| 自有 | `vectorize` | Zincgraph 向量索引 |
| 自有 | `explore` | Zincgraph 融合引擎（覆盖 CodeGraph explore） |
| 自有 | `review` | Zincgraph 图谱增强 review（覆盖 Ponytail review） |
| 自有 | `audit` | Zincgraph 图谱增强 audit |
| 自有 | `dedup` | Zincgraph 语义去重检查 |

**Acceptance:**
- [ ] `zincgraph init <project>` → 委托 CodeGraph，成功索引
- [ ] `zincgraph explore <query>` → 使用融合引擎（非 CodeGraph explore）
- [ ] `zincgraph review <project>` → 图谱增强 review（非 Ponytail review）
- [ ] `zincgraph vectorize <project>` → 构建向量索引
- [ ] `zincgraph callers <symbol>` → 委托 CodeGraph
- [ ] 所有命令有 `--help` 输出

---

## T4.3 — 统一安装器

**What:** `zincgraph install` 一条命令配置所有能力。

**Code spec:** goal.md G4.3

**Create:**
- `src/installer/unified-installer.ts` — 统一安装器
- `tests/installer/unified-installer.test.ts`

**安装流程：**
1. 检测已安装的 agent（Claude Code, Cursor, Copilot, Codex, Gemini 等 14+）
2. 用户选择要配置的 agent
3. 对每个选定 agent 写入：
   a. MCP server 配置（Zincgraph unified server → 包含 CodeGraph + Ponytail + 融合工具）
   b. 行为约束 rules/hooks（Ponytail 规则）
4. 初始化当前项目（`zincgraph init` + `zincgraph vectorize`）

**Acceptance:**
- [ ] 检测 Claude Code（`.claude/` 目录存在）
- [ ] 写入 MCP 配置指向 Zincgraph unified server
- [ ] 写入行为约束 rules
- [ ] `zincgraph install --yes` 非交互模式可用于 CI
- [ ] `tests/installer/unified-installer.test.ts` 通过 ≥ 4 test cases

---

## T4.4 — 增量同步集成

**What:** 文件变更时同步更新图谱 + 向量。

**Code spec:** goal.md G4.4

**Create:**
- `src/freshness/auto-sync.ts` — 增量同步管线
- `tests/freshness/auto-sync.test.ts`

**同步流程：**
1. CodeGraph watcher 检测文件变更 → 增量更新图谱（已有能力）
2. Zincgraph 监听图谱变更事件 → 标记受影响文件的 manifest 为 `stale`
3. 触发增量 re-embed：只处理 stale 文件
4. manifest 状态流转：`stale → pending → fresh`
5. staleness banner：debounce 窗口内通知 agent "正在同步"

**Acceptance:**
- [ ] 编辑一个文件 → 2s 内图谱更新（CodeGraph watcher）
- [ ] 图谱更新后 → 该文件 manifest 变 stale → re-embed → 回到 fresh
- [ ] debounce 窗口内查询 → freshness 包含 warning
- [ ] `tests/freshness/auto-sync.test.ts` 通过 ≥ 4 test cases

---

## T4.5 — 端到端集成测试

**What:** 完整闭环验证。

**Create:** `tests/integration/full-pipeline.test.ts`

**测试场景：**
1. 在一个真实 TypeScript 项目上执行完整管线：init → vectorize → explore → review
2. 验证 MCP server 对外暴露的所有工具
3. 验证文件编辑后的增量同步
4. 验证安装器配置的正确性

**Acceptance:**
- [ ] `init <project>` → `vectorize <project>` → `explore "token validation"` → 融合结果
- [ ] MCP `tools/list` 返回 14 个工具
- [ ] 编辑文件 → 2s 后查询反映变更
- [ ] `install --yes` → agent 配置正确
- [ ] `tests/integration/full-pipeline.test.ts` 通过

---

## Phase 4 Exit Criteria

```bash
# 统一安装
zincgraph install --yes
# 预期：检测到 agent，配置 MCP + 行为约束

# 完整管线
zincgraph init <project>
zincgraph vectorize <project>
zincgraph explore "token validation"      # 融合查询
zincgraph search kind:function name:auth  # 符号搜索
zincgraph callers authenticateUser        # 调用者
zincgraph review <project> --diff         # 图谱增强 review
zincgraph dedup --describe "format date"  # 语义去重

# 闭环验证
# 编辑文件 → 2s 内图谱 + 向量自动更新
# 再次 explore → 结果反映最新状态

# MCP 验证
echo '{"jsonrpc":"2.0","method":"tools/list","id":1}' | zincgraph mcp
# 预期：14 个工具

npx vitest run                            # all pass
```
