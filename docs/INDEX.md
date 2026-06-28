# Zincgraph Task Index (Bridge Architecture)

Task decomposition of [goal.md](../goal.md). Zincgraph 是 CodeGraph + Zvec + Ponytail + Headroom 的融合桥接层——不重写上游，在其之上构建统一入口、融合查询、上下文压缩和闭环能力。

## Phase Overview

| Phase | Tasks | Description | Depends On |
|-------|-------|-------------|------------|
| [Phase 0](./tasks-phase-0.md) | T0.1 ~ T0.4 | Bootstrap & 依赖验证 | -- |
| [Phase 1](./tasks-phase-1.md) | T1.1 ~ T1.4 | 向量桥接层 | Phase 0 |
| [Phase 2](./tasks-phase-2.md) | T2.1 ~ T2.5 | 融合查询引擎 | Phase 1 |
| [Phase 3](./tasks-phase-3.md) | T3.1 ~ T3.4 | 图谱增强行为层 | Phase 2 |
| [Phase 4](./tasks-phase-4.md) | T4.1 ~ T4.5 | 闭环与生产就绪 | Phase 3 |
| [Phase 5](./tasks-phase-5.md) | T5.1 ~ T5.6 | 上下文压缩桥接层 | Phase 4 |
| [Phase 6](./tasks-phase-6.md) | T6.1 ~ T6.4 | 反馈闭环与压缩优化 | Phase 5 |

## Dependency Graph

```
Phase 0 ──> Phase 1 ──> Phase 2 ──> Phase 3 ──> Phase 4 ──> Phase 5 ──> Phase 6
(Bootstrap)  (Vector)   (Fusion)   (Behavior)   (Polish)  (Compress) (Feedback)
```

## 与旧版对比

| | 旧版 (Clean-Room Rewrite) | 新版 (Bridge Layer) |
|---|---|---|
| Phase 数量 | 8 + 扩展 | 7 |
| Task 总数 | ~50 | ~32 |
| CodeGraph | 从零重写提取/解析/遍历/MCP | npm 依赖，直接用 |
| Ponytail | 从零重写规则/hooks/适配器 | 本地引用，直接用 |
| Zvec | 从零写 Node.js 绑定 + 集成 | npm 包 + 桥接层 |
| Headroom | 无 | npm 包 + 压缩桥接层 + 反馈闭环 |
| 独有价值 | 全部 | 融合引擎 + 图谱增强行为 + 图谱感知压缩 + 统一入口 |

## Obsolete Files (可删除)

以下文件是旧版 clean-room 架构的产物，已被替代：
- ~~`tasks-phase-5.md`~~ (旧 Phase 5: 行为约束) — 已被 Phase 3 替代；**新 Phase 5 是上下文压缩桥接层**
- ~~`tasks-phase-6.md`~~ (旧 Phase 6: 实时同步) — 已被 Phase 4 替代；**新 Phase 6 是反馈闭环与压缩优化**
- `tasks-phase-7.md` (旧 Phase 7: 融合闭环) — 已被 Phase 3+4+6 替代
- `tasks-phase-x.md` (旧扩展阶段) — 语言/框架扩展已由上游 CodeGraph 覆盖

## How to Use

1. Pick the lowest-numbered incomplete phase
2. Execute tasks in order within that phase (T*.N depends on T*.N-1)
3. Every task has acceptance criteria — run them before moving on
4. goal.md defines the architecture; these task files tell you WHAT to build and HOW to verify
5. When in doubt about upstream capabilities, check `refer/codegraph`, `refer/ponytail`, `refer/zvec`, `refer/headroom`

## Benchmark References

- [CodeGraph vs Zincgraph Benchmark Plan](./benchmarks/codegraph-vs-zincgraph.md)
- [Code RAG / 本地代码索引工具的 Benchmark 与同类项目](./benchmarks/code-rag-index-benchmarks-and-tools.md)
- [Open-Source Benchmark Pool and Scoring Standard](./benchmarks/open-source-benchmark-pool.md)
