# Code RAG / 本地代码索引工具的 Benchmark 与同类项目

> 日期：2026-06-21  
> 目的：整理“RAG 或本地代码索引库工具是否有统一 benchmark / 测试集，以及有哪些同类型项目”的调研结论，供 Zincgraph 后续 benchmark 设计与竞品分析参考。

## 结论摘要

目前没有一个事实上的统一 benchmark 能完整覆盖 **本地代码索引 / Code RAG / agent 工具增益**。

原因是这类工具横跨多个层面：

1. **检索层**：自然语言 / 符号 / 文件 / 行为描述能否找对代码。
2. **仓库理解层**：跨文件依赖、调用链、配置、测试、模块边界是否理解正确。
3. **生成 / 修复层**：给定 issue 或任务，agent 是否能用索引工具完成补丁。
4. **索引系统层**：索引覆盖率、增量更新、freshness、stale 隔离、上下文密度、非破坏性等。

因此，实际评估通常需要组合公开 benchmark 与自建本地真实仓库 benchmark。

## 公开 Benchmark / 测试集

| Benchmark / 数据集 | 主要用途 | 适合评估什么 | 备注 |
|---|---|---|---|
| [CodeSearchNet](https://github.com/github/CodeSearchNet) | 语义代码搜索 | Natural language query → code snippet 的 Recall@K / MRR / nDCG | 经典代码检索数据集，适合基础语义搜索能力 |
| [CoSQA](https://www.microsoft.com/en-us/research/publication/cosqa-20-000-web-queries-for-code-search-and-question-answering/) | Web 查询式代码搜索 / QA | 更接近真实用户自然语言查询的代码搜索 | 可用于补充 CodeSearchNet 的“真实查询”维度 |
| [RepoBench](https://openreview.net/forum?id=pPjZIOuQuF) | 仓库级检索与补全 | RepoBench-R 检索、RepoBench-C 补全、RepoBench-P pipeline | 适合测跨文件上下文查找能力 |
| [CrossCodeEval](https://crosscodeeval.github.io/) | 跨文件代码补全 | 多语言真实 repo 中需要 cross-file context 的补全 | 适合评估索引能否提供有效跨文件上下文 |
| [RepoQA](https://evalplus.github.io/repoqa.html) | 仓库级代码问答 / 函数定位 | 给自然语言描述找目标函数 | 适合测“行为描述 → 代码位置”的能力 |
| [CodeRAG-Bench](https://code-rag-bench.github.io/) | Code RAG 端到端 | retrieval + generation，包括 basic / open-domain / repository-level code generation | 更贴近 RAG 系统端到端效果 |
| [SWE-bench](https://www.swebench.com/) / SWE-bench Verified | Agent 软件工程任务 | GitHub issue → 修改真实 repo → 测试是否通过 | 适合评估索引工具对 agent 修复率的提升 |
| [Long Code Arena](https://arxiv.org/html/2406.11612v1) | 长代码 / 仓库级任务综合 | project-level completion、bug localization、CI repair、module summarization 等 | 适合长上下文与仓库级工具能力比较 |

## 这些 Benchmark 的局限

公开 benchmark 多数不能直接证明本地索引工具的完整价值，尤其缺少以下维度：

- **Index coverage**：文件、符号、调用边、引用边、测试、配置是否覆盖。
- **Freshness / 增量更新**：文件变更后索引是否及时更新，旧向量是否隔离。
- **Context density**：输出上下文中有效信息占比，单位 token / KB 的有用证据密度。
- **Agent utility**：工具是否减少 agent 调用次数、token 消耗、错误定位时间、补丁失败率。
- **Non-mutation**：benchmark 运行是否污染真实 `.codegraph` / `.zincgraph` 状态。
- **Local repo realism**：真实项目中的 generated files、symlink、大文件、ignored files、monorepo、混合语言等情况。

因此，Zincgraph 这类工具应采用“公开集 + 本地真实仓库集 + 索引系统专属指标”的组合评估。

## 推荐评估架构

### 1. 检索层

目标：证明“能否找对代码”。

推荐数据：CodeSearchNet、CoSQA、RepoQA、RepoBench-R。

推荐指标：

- Recall@K
- Precision@K
- MRR
- nDCG
- Golden file hit
- Golden symbol hit
- Top result relevance

### 2. 仓库理解层

目标：证明“能否提供跨文件、跨模块、调用链上下文”。

推荐数据：RepoBench-P、CrossCodeEval、Long Code Arena、自建真实 repo query 集。

推荐指标：

- 跨文件依赖命中率
- 调用链 / import / reference 命中率
- 上下文完整性
- 上下文冗余率
- 有效信息密度

### 3. Agent 任务层

目标：证明“索引工具是否让 agent 更会写补丁”。

推荐数据：SWE-bench Verified 子集、项目内部真实 issue / bug / feature request、本地 deterministic issue fixtures。

推荐指标：

- Pass rate
- Patch correctness
- Test pass rate
- Agent 工具调用次数
- 总 token
- 总耗时
- 首次定位成功率
- 无关改动数量

### 4. 索引系统层

目标：证明“索引工具自身是否可靠”。

推荐自建场景：

- 初始索引完整性
- 单文件修改后的增量更新
- 文件删除 / 重命名 / 移动
- symlink / path traversal 防护
- ignored files / generated files 处理
- stale vector 隔离
- SQLite / 向量库状态非破坏性
- 多语言仓库覆盖

推荐指标：

- 文件覆盖率
- 符号覆盖率
- 边覆盖率
- stale 检出率
- stale 清理 / 隔离成功率
- 增量更新时间
- 查询结果稳定性
- benchmark non-mutation proof

## 同类型项目 / 工具

### 传统代码搜索 / 浏览

| 项目 | 类型 | 特点 |
|---|---|---|
| [ripgrep](https://github.com/BurntSushi/ripgrep) | 文本 / 正则搜索 | 极快，常作为 agent fallback 搜索工具 |
| [Zoekt](https://github.com/sourcegraph/zoekt) | 代码搜索引擎 | Sourcegraph 维护，trigram index，支持 regexp / 布尔查询 |
| [OpenGrok](https://github.com/oracle/opengrok) | 代码搜索 + cross-reference | 适合大型代码库浏览与引用跳转 |
| [Sourcebot](https://github.com/sourcebot-dev/sourcebot) | 自托管代码搜索 | 面向 humans 和 agents 的代码搜索 / 理解入口 |

### 符号 / AST / 静态分析索引

| 项目 | 类型 | 特点 |
|---|---|---|
| [Universal Ctags](https://github.com/universal-ctags/ctags) | 符号索引 | 经典 tags 方案，轻量、跨语言 |
| [Tree-sitter](https://tree-sitter.github.io/) | 增量解析 / AST | 很多 repo-map、semantic chunker、结构搜索工具的底层 |
| [ast-grep](https://ast-grep.github.io/) | AST structural search / rewrite | 适合结构化代码查询与重写 |
| [SCIP](https://scip-code.org/) / LSIF | 代码智能协议 | go-to-definition、references、语义导航 |
| [CodeQL](https://codeql.github.com/) | 代码数据库 / 静态分析 | 适合安全、数据流、复杂静态分析查询 |

### AI / RAG / Agent 代码索引

| 项目 | 类型 | 特点 |
|---|---|---|
| [CocoIndex Code](https://cocoindex.io/cocoindex-code/) | 本地语义代码索引 / MCP | AST-aware semantic code search，支持增量 re-index |
| [Claude Context / CodeIndexer](https://github.com/zilliztech/claude-context) | 语义代码搜索 MCP | 面向 Claude Code 等 agent 的 codebase indexing |
| [Continue](https://docs.continue.dev/) | 开源 coding agent / IDE 插件 | 支持 codebase / docs context |
| [Kilo Code codebase indexing](https://kilo.ai/docs/customize/context/codebase-indexing) | IDE / agent 代码索引 | embedding-based codebase semantic search |
| [Tabby](https://github.com/TabbyML/tabby) | 自托管 AI coding assistant | 支持 repository context / indexing |
| [bloop](https://github.com/bloopai/bloop) | 语义代码搜索 / 问答 | Rust 实现的代码搜索与代码问答工具 |
| [Aider repo map](https://aider.chat/docs/repomap.html) | Agent repo-map | 基于 Tree-sitter 构建仓库 map，按重要符号压缩上下文 |

## Zincgraph Benchmark 的建议定位

Zincgraph 不应该只和 CodeGraph 比“速度”或“默认输出大小”。更合理的定位是：

> CodeGraph 是图谱与符号基线；Zincgraph 在其上提供 fusion、freshness、semantic retrieval、dedup/review、agent context packaging 等增量能力。

因此，Zincgraph 的 benchmark 应至少分成两类分数：

1. **比较分 / quality score**
   - retrieval
   - depth
   - freshness
   - capability

2. **诊断项 / diagnostic metrics**
   - output size
   - information density
   - CLI latency
   - storage size
   - indexing time

默认 CLI 输出大小和 CLI 延迟可以展示，但不应在“工具给 agent 带来的作用效果”比较中直接决定胜负，除非 benchmark 目标明确是“速度 / 成本优先”。

## 推荐落地方案

### 最小可用方案

在现有本地 deterministic benchmark 上继续扩展：

- 保持当前真实 repo task matrix。
- 新增更多 query 类型：exact symbol、behavior description、call chain、config / CLI flow、test failure localization、update / freshness。
- 固定 golden files / golden symbols / relevant terms。
- 输出 `summary.json` + `report.md`。
- 保持 non-mutation proof。

### 中期方案

增加 5–20 个真实仓库：

- TypeScript / Python / Go / Rust / mixed monorepo。
- 每个仓库 20–50 个 query。
- 每个 query 标注 golden files、symbols、relations、expected context。
- 对 CodeGraph、Zincgraph、CocoIndex、ripgrep/ctags baseline 做横向比较。

### 长期方案

引入 agent A/B：

- 同一批 issue，随机分配工具配置：no index、ripgrep only、CodeGraph、Zincgraph、CocoIndex。
- 统计 patch pass rate、task success rate、token cost、tool call count、time to first correct file、final diff size、reviewer findings。

## 参考链接

- CodeSearchNet: <https://github.com/github/CodeSearchNet>
- CoSQA: <https://www.microsoft.com/en-us/research/publication/cosqa-20-000-web-queries-for-code-search-and-question-answering/>
- RepoBench: <https://openreview.net/forum?id=pPjZIOuQuF>
- CrossCodeEval: <https://crosscodeeval.github.io/>
- RepoQA: <https://evalplus.github.io/repoqa.html>
- CodeRAG-Bench: <https://code-rag-bench.github.io/>
- SWE-bench: <https://www.swebench.com/>
- Long Code Arena: <https://arxiv.org/html/2406.11612v1>
- ripgrep: <https://github.com/BurntSushi/ripgrep>
- Zoekt: <https://github.com/sourcegraph/zoekt>
- OpenGrok: <https://github.com/oracle/opengrok>
- Sourcebot: <https://github.com/sourcebot-dev/sourcebot>
- Universal Ctags: <https://github.com/universal-ctags/ctags>
- Tree-sitter: <https://tree-sitter.github.io/>
- ast-grep: <https://ast-grep.github.io/>
- SCIP: <https://scip-code.org/>
- CodeQL: <https://codeql.github.com/>
- CocoIndex Code: <https://cocoindex.io/cocoindex-code/>
- Claude Context / CodeIndexer: <https://github.com/zilliztech/claude-context>
- Continue: <https://docs.continue.dev/>
- Kilo Code codebase indexing: <https://kilo.ai/docs/customize/context/codebase-indexing>
- Tabby: <https://github.com/TabbyML/tabby>
- bloop: <https://github.com/bloopai/bloop>
- Aider repo map: <https://aider.chat/docs/repomap.html>
