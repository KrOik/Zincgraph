## Zincgraph 开发路线图

### 项目定位

**Zincgraph 是 CodeGraph、Zvec、Ponytail、Headroom 四个项目的融合桥接层。** 它不重写任何一个项目，而是在它们之上构建统一入口、融合查询引擎、上下文压缩和闭环能力。

四个上游项目已经各自成熟：

| 上游 | 版本 | 成熟度 | Zincgraph 使用方式 |
|---|---|---|---|
| CodeGraph | v1.0.1 | 130 源文件, 87 测试, 24 语言, 22 框架, MCP daemon, 19 CLI | npm 依赖，作为图谱引擎 |
| Ponytail | v4.7.0 | 14 agent 适配器, MCP server, 6 命令, 完整生命周期 hooks | npm 依赖，作为行为约束层 |
| Zvec | v0.5.0 (core) | C++ 生产级内核, Python SDK, C API, 阿里内部验证 | @zvec/zvec npm 包，作为向量引擎 |
| Headroom | v0.26.0 | Python+Rust 双语言, MCP server, proxy, TS SDK, 11 阶段 pipeline, 60-95% token 压缩 | headroom-ai npm 包，作为上下文压缩层 |

Zincgraph 的独有价值是**闭环**——上游项目单独不具备的能力：

- **图谱验证行为**：agent 写新函数 → 图谱查"是否已有同签名函数" → 语义去重
- **语义感知的决策阶梯**：Ponytail 的第 4 步（已安装依赖）升级为向量相似度搜索
- **Freshness-aware 约束**：review/audit 只在索引新鲜时执行，避免基于过时图谱的误判
- **图谱感知压缩**：融合查询结果经 Headroom 智能压缩（SmartCrusher 处理结构化 JSON，CodeCompressor 处理代码片段），CCR 存储原始数据供 agent 按需检索，形成"压缩 → 检索 → 反馈 → 调优"闭环
- **统一 MCP Server**：agent 连一个 server，同时获得图谱 + 向量 + 行为约束 + 上下文压缩

### 架构

```
┌──────────────────────────────────────────────────────────┐
│                   Zincgraph (Bridge)                     │
│  ┌─────────┐  ┌──────────┐  ┌────────────┐  ┌────────┐ │
│  │ Fusion  │  │ Freshness│  │Graph-Aware │  │Compress│ │
│  │ Engine  │  │  Gate    │  │  Behavior  │  │ Layer  │ │
│  └────┬────┘  └────┬─────┘  └──────┬─────┘  └───┬────┘ │
│       │            │               │             │      │
│  ┌────┴────┐  ┌────┴────┐  ┌──────┴─────┐ ┌────┴───┐ │
│  │CodeGraph│  │  Zvec   │  │ Ponytail   │ │Headroom│ │
│  │ (graph) │  │ (vector)│  │ (behavior) │ │(compress)│ │
│  └─────────┘  └─────────┘  └────────────┘ └────────┘ │
└──────────────────────────────────────────────────────────┘
                   │ Unified MCP Server │
                   │ (with compression  │
                   │    middleware)      │
                   └────────────────────┘
```

### 技术基线

| 决策项 | 选择 | 理由 |
|---|---|---|
| 方法论 | 桥接层 | 不重写上游；依赖其 npm 包或本地引用，构建融合/适配/扩展层 |
| 图谱引擎 | @colbymchenry/codegraph (npm) | v1.0.1 已发布，24 语言 + 22 框架 + MCP daemon 全就绪 |
| 向量引擎 | @zvec/zvec (npm) | 阿里 C++ 内核的 Node.js 绑定；若不可用则基于 C API 写 N-API wrapper |
| 行为约束 | ponytail (本地引用或 npm) | v4.7.0，14 agent 适配器 + MCP server 全就绪 |
| 上下文压缩 | headroom-ai (npm) | v0.26.0，TS SDK + MCP server + CCR + SmartCrusher + CodeCompressor |
| 语言 | TypeScript (strict, ES2022, NodeNext) | 与 CodeGraph 技术栈一致 |
| 构建 | tsup (ESM + CJS + .d.ts) | 已验证可行 |
| 测试 | vitest | 与 tsup/ESM 生态一致 |
| 融合存储 | SQLite (fusion.sqlite) | 向量 manifest + 融合元数据 + CCR 压缩缓存；图谱存储复用 CodeGraph 的 graph.sqlite |

### 阶段依赖关系

```
Phase 0 ──> Phase 1 ──> Phase 2 ──> Phase 3 ──> Phase 4 ──> Phase 5 ──> Phase 6
(Bootstrap)  (Vector)   (Fusion)   (Behavior)   (Polish)  (Compress) (Feedback)
```

每个 Phase 产出可运行、可测试的交付物。

---

### Phase 0: Bootstrap & 依赖验证

**目标：** 验证三个上游项目作为依赖可用，建立 Zincgraph 项目骨架和桥接接口。

#### G0.1 — 项目脚手架

```
zincgraph/
├── package.json            # 依赖 codegraph, @zvec/zvec, ponytail, headroom-ai
├── tsconfig.json           # strict, ES2022, NodeNext
├── tsup.config.ts          # ESM + CJS + .d.ts
├── vitest.config.ts
├── src/
│   ├── index.ts            # SDK 公共 API
│   ├── cli.ts              # 统一 CLI 入口（委托 CodeGraph + 自有命令）
│   ├── bridge/             # 上游项目适配器
│   ├── vector/             # Zvec 桥接层 (Phase 1)
│   ├── fusion/             # 融合查询引擎 (Phase 2)
│   ├── behavior/           # 图谱增强行为层 (Phase 3)
│   ├── compression/        # Headroom 上下文压缩层 (Phase 5)
│   └── freshness/          # 新鲜度追踪 (Phase 2)
└── tests/
```

#### G0.2 — CodeGraph 集成验证

安装 `@colbymchenry/codegraph`，验证其 API 可被导入和使用：

- 导入核心类型（CodeNode, CodeEdge, UnresolvedReference 等）
- 调用 CodeGraph 的 index/explore/search API 编程式
- 验证 MCP server 模式（direct/daemon）可被 Zincgraph 包装
- 验证 CLI 命令可被 `commander` 委托

#### G0.3 — Ponytail 集成验证

引入 Ponytail，验证其行为约束可被 Zincgraph 注入：

- 导入 instruction builder，按 mode 生成规则文本
- 验证 MCP server 可被 Zincgraph 的 unified server 组合
- 验证 review/audit 命令可被 Zincgraph CLI 调用
- 验证 agent 适配器格式（Claude, Cursor, Copilot 等）

#### G0.4 — Zvec 可用性验证

安装 `@zvec/zvec`，验证 Node.js 绑定可用：

- `require('@zvec/zvec')` 或 `import` 成功
- `init()` 初始化引擎
- `create_and_open()` 创建 collection
- 基本的 insert + query 操作
- 若 `@zvec/zvec` 不可用：评估基于 C API + N-API 自写 wrapper 的工作量

**退出标准：**
```bash
npm install                    # 三个依赖全部安装成功
npm run typecheck              # exit 0
npm run build                  # 产出 dist/
# CodeGraph 验证：
node -e "const cg = require('@colbymchenry/codegraph'); console.log(typeof cg.explore)"
# Zvec 验证：
node -e "const z = require('@zvec/zvec'); z.init(); console.log('ok')"
# Ponytail 验证：
node -e "const p = require('./refer/ponytail/ponytail-mcp/instructions'); console.log(p.buildInstructions('full').length > 0)"
```

---

### Phase 1: 向量桥接层

**目标：** 将 Zvec 向量引擎接入 CodeGraph 的图谱数据，实现"代码节点 → 向量文档"的索引管线。

**依赖：** Phase 0 完成。

#### G1.1 — Zvec Collection 适配器

类型安全封装 `@zvec/zvec`，创建面向代码的 collection schema：

- `content`: SPARSE_VECTOR_FP32（FTS 向量）
- `embedding`: VECTOR_FP32（语义向量，可选）
- `file_path`, `language`, `kind`: STRING（scalar filter + inverted index）
- `qualified_name`, `node_id`, `content_hash`: STRING
- HNSW Sparse index on content，HNSW index on embedding

#### G1.2 — 代码 → 向量文档管线

从 CodeGraph 的图谱数据生成向量文档：

- 遍历 CodeGraph 索引中的节点
- 对每个有意义的节点（function, class, method）生成文本表示（签名 + docstring + 关键调用）
- 用 embedding adapter 生成向量
- 写入 Zvec collection

#### G1.3 — Embedding 适配器

可插拔的 embedding 提供者，默认本地（无网络依赖）：

- `LocalTokenEmbedding`：camelCase 拆词 + 形态学扩展，生成 sparse bag-of-words（默认）
- `OpenAIEmbedding` / `QwenEmbedding` / `HTTPEmbedding`：显式 opt-in
- `NetworkPolicy`：非 local 适配器默认 disabled，未授权请求抛 `RemoteProviderBlockedError`

#### G1.4 — 向量 Manifest

Per-file 记录向量文档状态：

- `fresh → pending → stale → failed` 生命周期
- 存储在 `fusion.sqlite` 的 `manifest_entries` 表
- `SemanticStatus` 聚合状态，生成 human-readable warnings

**退出标准：**
```bash
zincgraph vectorize <project>
# 预期：fusion.sqlite 创建，所有源文件有 fresh manifest
# 预期：collection 中有向量文档，可执行 FTS + vector query
# 预期：RemoteProviderBlockedError 阻止未授权网络请求
npx vitest run    # all pass
```

---

### Phase 2: 融合查询引擎

**目标：** 将 CodeGraph 的图谱查询与 Zvec 的向量/FTS 查询融合为统一的排名管线。这是 Zincgraph 的核心差异化。

**依赖：** Phase 1 完成（向量数据就绪）。

#### G2.1 — 融合查询管线

三路并行查询 → 去重合并 → 排名：

1. **Graph 精确查询**：CodeGraph `search_nodes(text, filters)` → 精确符号匹配
2. **Vector 语义查询**：Zvec `collection.query(embedding, topk, filter)` → 语义相似
3. **FTS 文本查询**：Zvec `collection.query(Fts(match_string), topk, filter)` → 关键词匹配

融合排名策略：
- 去重：以 `node_id` 为 key 合并三个结果集
- 精确符号提升：graph 精确匹配加权
- 图邻近度提升：在调用链/继承链上的结果加权
- 新鲜度惩罚：manifest stale 的候选降权

#### G2.2 — 意图路由

根据查询特征选择路径：
- 精确符号（`"authenticateUser"`）→ graph-first
- 自然语言（`"how does auth work"`）→ hybrid
- 路径限定（`"path:src/api"`）→ graph-first + filter
- 语义相似（`"similar to token validation"`）→ vector-first

#### G2.3 — 上下文预算

控制返回给 agent 的上下文总量：
- 按 token 预算裁剪（默认 8000）
- 优先保留 graph-confirmed 结果
- 同源文件结果合并展示

#### G2.4 — Freshness Gate

查询前检查向量数据新鲜度：
- manifest 中有 stale 文件 → ContextCapsule.freshness 包含警告
- review/audit 命令在索引不新鲜时自动触发 sync 或拒绝执行

#### G2.5 — 融合存储 (fusion.sqlite)

持久化向量文档和 manifest：
- `vector_documents(id, node_id, file_path, embedding_profile, json)`
- `manifest_entries(entry_key, file_path, embedding_profile, chunker_version, json)`
- `metadata(key, value)`

**退出标准：**
```bash
zincgraph explore "token validation"
# 预期：同时返回 graph 精确匹配和 vector 语义匹配结果
# 预期：重复节点只出现一次，分数更高
# 预期：stale 文件有 ⚠️ 标记
npx vitest run    # all pass
```

---

### Phase 3: 图谱增强行为层

**目标：** 在 Ponytail 的规则引擎之上叠加图谱证据，让 review/audit 从主观判断升级为有数据的结论。

**依赖：** Phase 2 完成（融合查询可用）。

#### G3.1 — 图谱增强 Review

Ponytail review 标记 over-engineering（delete/stdlib/native/yagni/shrink）。Zincgraph 叠加图谱证据：

- agent 引入新函数 → graph `search_nodes(sameSignature)` → "已有同签名函数 X"
- agent 引入新 import → graph `imports` → "依赖 Y 已通过 Z 间接引入"
- agent 创建新抽象 → graph `callers` → "只有 1 个调用点，违反 YAGNI"

#### G3.2 — 语义去重

当 agent 要写新函数时：
1. 提取待写代码的语义特征
2. 向量搜索"代码库中是否已有语义相似的实现"
3. 相似度 > threshold → 建议复用而非重复实现
4. 这是 Ponytail 决策阶梯第 4 步的语义增强版

#### G3.3 — 影响感知 YAGNI

当 agent 要添加新抽象时：
1. 先用 impact 分析现有代码
2. 判断"这个抽象能减少多少调用点的复杂度"
3. 影响半径 < threshold → 建议内联
4. 将"凭感觉 YAGNI"升级为"数据驱动 YAGNI"

#### G3.4 — 上下文标注

explore 返回的上下文附带行为约束标注：
- "这段代码可以用 stdlib X 替代"（决策阶梯第 2 步）
- "和 Y 文件中的实现语义重复"（语义去重）
- "图谱中无调用者"（dead code 提示）

**退出标准：**
```bash
zincgraph review <project> --diff
# 预期：review 输出包含图谱证据（"已有同签名函数"、"只有1个调用者"）
zincgraph explore "formatDate"
# 预期：如果库中已有语义相似的函数，输出中包含复用建议
npx vitest run    # all pass
```

---

### Phase 4: 闭环与生产就绪

**目标：** 统一 MCP Server、统一 CLI、统一安装器，让 Zincgraph 成为一个可直接使用的产品。

**依赖：** Phase 3 完成。

#### G4.1 — 统一 MCP Server

一个 MCP Server 暴露三个上游 + 融合层的所有工具：

- CodeGraph 工具：`explore`, `search`, `node`, `callers`, `callees`, `impact`, `affected`, `status`
- Ponytail 工具：`ponytail_instructions`, `review`, `audit`, `debt`
- 融合工具：`semantic_search`（向量增强搜索）, `dedup_check`（语义去重检查）
- 所有工具通过单一 stdio/daemon 连接提供

#### G4.2 — 统一 CLI

`zincgraph` 命令委托 CodeGraph 的子命令 + 自有命令：

- 委托：`init`, `index`, `status`, `explore`, `search`, `node`, `callers`, `callees`, `impact`, `affected`, `watch`, `daemon`, `install`
- 自有：`vectorize`（构建向量索引）, `review`（图谱增强 review）, `audit`（图谱增强 audit）, `dedup`（语义去重检查）

#### G4.3 — 统一安装器

`zincgraph install` 一条命令配置：
1. CodeGraph 的 MCP server（代码智能）
2. Ponytail 的行为约束 rules/hooks
3. Zincgraph 的融合层工具

对所有 14+ agent 适配器写入正确配置。

#### G4.4 — 增量同步集成

文件变更时同步更新图谱 + 向量：
- CodeGraph watcher 检测变更 → 增量更新图谱
- Zincgraph 检测图谱变更 → 增量更新向量文档
- manifest 状态流转：stale → pending → fresh
- staleness banner 在 debounce 窗口内通知 agent

**退出标准：**
```bash
# 统一安装
zincgraph install
# 预期：检测到已安装的 agent，配置 MCP + 行为约束 + 融合工具

# 统一 MCP
echo '{"jsonrpc":"2.0","method":"tools/list","id":1}' | zincgraph mcp
# 预期：返回 CodeGraph + Ponytail + 融合层的所有工具

# 闭环验证
zincgraph init <project> && zincgraph vectorize <project>
zincgraph explore "token validation"     # 融合查询
zincgraph review <project> --diff        # 图谱增强 review
# 编辑文件 → 2s 内图谱 + 向量自动更新
npx vitest run    # all pass
```

---

### Phase 5: 上下文压缩桥接层

**目标：** 将 Headroom 的压缩引擎接入 Zincgraph 的融合查询管线，实现"查询结果 → 智能压缩 → CCR 可检索存储"。解决融合查询结果到 LLM 上下文之间的信息密度断层。

**依赖：** Phase 4 完成（统一 MCP + CLI 可用）。

#### G5.1 — Headroom 集成验证

安装 `headroom-ai`，验证 TypeScript SDK 可被 Zincgraph 桥接：

- `import { compress } from 'headroom-ai'` 编译通过
- `compress(messages, { model })` 返回压缩结果
- MCP server 模式可被 Zincgraph 包装
- 探测 Scenario A（npm 包直连）/ Scenario B（Python 子进程 fallback）

#### G5.2 — 融合结果压缩器

在 `mergeAndRank` 之后、`applyContextBudget` 之前插入压缩阶段：

- **SmartCrusher** 处理 graph 结果中的大型结构化 JSON（callers/callees 返回的节点数组）
- **CodeCompressor**（tree-sitter AST 感知）处理 vector 分支返回的代码片段
- **IntelligentContext** 替代硬截断 token budget，用多因子重要性评分做软选择
- CCR 存储原始结果，注入 `zincgraph_retrieve` MCP 工具让 LLM 按需展开

#### G5.3 — 相关性评分替换

用 Headroom 的 `RelevanceScorer` 替代融合引擎中文本分支的 token-overlap 计分：

- **BM25** 经典信息检索评分
- **Embedding-based** 语义相似度（复用 Zvec 的 embedding 基础设施）
- **Hybrid** BM25 + embedding 加权融合
- 将 `FusionPolicy.nativeFts` 从 `false` 升级为 `'headroom-relevance'`

#### G5.4 — 缓存对齐

在 MCP server 中接入 CacheAligner：

- 提取 tool definitions 中的动态字段（文件路径、时间戳、session 标识）
- 保持静态前缀不变，动态内容移入 metadata
- 提升 Anthropic/OpenAI 侧的 prompt caching 命中率

#### G5.5 — MCP 压缩工具扩展

在 unified MCP server 中注册 Headroom 相关工具：

- `zincgraph_compress`：按需压缩任意内容，返回 CCR 哈希
- `zincgraph_retrieve`：按哈希检索原始未压缩内容
- `zincgraph_compression_stats`：当前 session 的压缩统计

**退出标准：**
```bash
zincgraph explore "token validation"
# 预期：返回压缩后的结果，附带 CCR 哈希标记
# 预期：原始结果可通过 zincgraph_retrieve 检索
# 预期：compression_stats 报告 token 节省比例 > 40%

# MCP 验证
echo '{"jsonrpc":"2.0","method":"tools/list","id":1}' | zincgraph mcp
# 预期：返回 17 个工具（原 14 + 3 压缩工具）

# FTS 验证
zincgraph explore "how does authentication work"
# 预期：FusionPolicy.nativeFts 不再是 false
# 预期：文本分支使用 BM25/hybrid 评分

npx vitest run    # all pass
```

---

### Phase 6: 反馈闭环与压缩优化

**目标：** 建立"压缩 → 检索 → 反馈 → ranking 调优"的学习循环，让压缩策略随使用模式自适应进化。

**依赖：** Phase 5 完成（压缩管线可用）。

#### G6.1 — 压缩反馈循环

接入 Headroom 的 `CompressionFeedback`，将检索行为信号回传到融合引擎：

- 跟踪哪些被压缩的内容被 LLM 实际检索了（通过 `zincgraph_retrieve` 调用）
- 反馈到 ranking 权重：频繁检索的类型 → 降低压缩激进度 / 提升排名优先级
- 从未检索的类型 → 更激进压缩或直接过滤
- 存储在 `fusion.sqlite` 的 `compression_feedback` 表

#### G6.2 — Review 压缩集成

graph-review 输出经 Headroom 压缩后发送给 agent：

- 相同 finding pattern 合并（same-signature、redundant-import 等分类去重）
- 稳定代码上下文压缩，只保留 diff-relevant 部分
- CCR cross-turn context tracker 在多轮 review 中保持对之前 finding 的感知
- 避免重复讨论已解决的 finding

#### G6.3 — Learn 集成

接入 `headroom learn` 能力，从失败 session 中提取改进信号：

- 挖掘 failed review sessions → 识别误报的 finding 类型
- 将学习结果写入 Ponytail 行为约束（AGENTS.md / CLAUDE.md 格式）
- 形成"review 误报 → learn 识别 → 约束更新 → 下次不再误报"的改进循环

#### G6.4 — 端到端集成测试

完整六阶段闭环验证：

- 在真实项目上执行 init → vectorize → explore（带压缩）→ review（带压缩）→ retrieve → 反馈验证
- 验证 compression feedback 在多轮交互中调整 ranking 权重
- 验证 learn 从失败 session 中提取规则

**退出标准：**
```bash
# 完整六阶段管线
zincgraph init <project>
zincgraph vectorize <project>
zincgraph explore "token validation"           # 带压缩的融合查询
zincgraph review <project> --diff              # 带压缩的图谱增强 review
zincgraph compression-stats                    # 压缩统计

# 反馈循环验证
# 多轮 explore → retrieve → 再次 explore → 排名反映检索偏好

# Learn 验证
zincgraph learn --from-failures <session-log>
# 预期：输出行为约束更新建议

npx vitest run                                 # all pass
```

---

### 附录：排除项

| 排除项 | 理由 |
|---|---|
| 重写 CodeGraph 的提取/解析/遍历/MCP | 已成熟，直接依赖 |
| 重写 Ponytail 的规则/hooks/适配器 | 已成熟，直接依赖 |
| 自构建 Zvec C++ 内核 | 用 npm 包或 N-API wrapper |
| 重写 Headroom 的压缩引擎/CCR/proxy | 已成熟，直接桥接 TS SDK |
| 自训练 ML 压缩模型 | Headroom 的 kompress-v2-base 已提供 |
| Headroom proxy 独立部署 | 通过 MCP 工具集成，不单独运行 proxy |
| 跨平台 bundle 分发 | 上游已有分发方案 |
| 遥测系统 | 上游 CodeGraph 已内置 |
| 文档站点 | README + 上游文档足够 |
