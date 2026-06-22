# Phase 1: 向量桥接层

**Goal:** 将 Zvec 向量引擎接入 CodeGraph 的图谱数据，实现"代码节点 → 向量文档"的索引管线。

**Depends on:** Phase 0 完成（三个上游依赖已验证可用）。

**What this phase builds:** Zvec collection 适配器、代码→向量文档管线、embedding 适配器、向量 manifest。这些都是新代码——上游项目不包含这个桥接层。

---

## T1.1 — Zvec Collection 适配器

**What:** 类型安全封装 `@zvec/zvec`，创建面向代码的 collection schema。

**Code spec:** goal.md G1.1

**Create:**
- `src/vector/zvec-adapter.ts` — Zvec API 封装
- `src/vector/collection-manager.ts` — collection 生命周期管理
- `tests/vector/zvec-adapter.test.ts`

**Collection schema（代码专用）：**

| 字段 | 类型 | 用途 |
|---|---|---|
| `content` | SPARSE_VECTOR_FP32 | FTS 向量（bag of tokens） |
| `embedding` | VECTOR_FP32 | 语义向量（可选） |
| `file_path` | STRING | scalar filter + inverted index |
| `language` | STRING | scalar filter |
| `kind` | STRING | scalar filter（function/class/method） |
| `qualified_name` | STRING | 全限定名 |
| `node_id` | STRING | 关联 CodeGraph 节点 |
| `content_hash` | STRING | 内容哈希（变更检测） |

**Index 配置：**
- `content`: HNSW Sparse index
- `embedding`: HNSW index（有 embedding 时）
- `file_path` / `language` / `kind`: inverted index

**Methods:**
- `createCollection(projectPath)` — 创建 schema + index
- `openCollection(projectPath)` — 打开已有 collection
- `dropCollection(projectPath)` — 删除 collection
- `flush()` — 刷盘
- `destroy()` — 释放资源

**Acceptance:**
- [ ] `createCollection(path)` 在磁盘上创建 collection 目录
- [ ] `openCollection(path)` 重新打开同一 collection
- [ ] Schema 包含全部 8 个字段
- [ ] Inverted index 可用于 filtered query（`kind == 'function'`）
- [ ] `tests/vector/zvec-adapter.test.ts` 通过 ≥ 5 test cases

---

## T1.2 — 代码 → 向量文档管线

**What:** 从 CodeGraph 的图谱数据生成向量文档并写入 Zvec。

**Code spec:** goal.md G1.2

**Create:**
- `src/vector/code-to-vectors.ts` — 文档生成逻辑
- `src/vector/vectorize-command.ts` — CLI `zincgraph vectorize` 命令
- `tests/vector/code-to-vectors.test.ts`

**管线流程：**
1. 读取 CodeGraph 索引中的所有节点
2. 过滤有意义的节点：function, class, method, interface, component（跳过 parameter, variable 等噪声）
3. 为每个节点生成文本表示：
   - 签名（函数名 + 参数类型 + 返回类型）
   - docstring（如果有）
   - 关键调用（从 outgoing `calls` 边提取 callee 名）
4. 用 embedding adapter 生成向量
5. 创建 VectorDocument（node_id, content, embedding, metadata）
6. 批量写入 Zvec collection
7. 更新 manifest：所有文件标记为 `fresh`

**Acceptance:**
- [ ] `zincgraph vectorize <project>` 对已索引项目执行成功
- [ ] 一个 50 节点的图谱 → collection 中有 ≥ 20 个向量文档（过滤掉无意义节点）
- [ ] 每个文档的 `node_id` 可回溯到 CodeGraph 中的节点
- [ ] `content` 字段包含签名 + docstring 的 token 化稀疏向量
- [ ] `tests/vector/code-to-vectors.test.ts` 通过 ≥ 5 test cases

---

## T1.3 — Embedding 适配器

**What:** 可插拔的 embedding 提供者，默认本地无网络依赖。

**Code spec:** goal.md G1.3

**Create:**
- `src/vector/embedding/index.ts` — EmbeddingAdapter 接口 + registry
- `src/vector/embedding/local.ts` — LocalTokenEmbedding（默认）
- `src/vector/embedding/openai.ts` — OpenAI API（opt-in）
- `src/vector/embedding/qwen.ts` — Qwen/DashScope（opt-in）
- `src/vector/embedding/http.ts` — 通用 HTTP endpoint（opt-in）
- `src/vector/network-policy.ts` — 网络访问控制
- `tests/vector/embedding.test.ts`

**LocalTokenEmbedding（默认）：**
- Token-based bag-of-words，无需网络
- camelCase 拆词：`authenticateUser` → [`authenticate`, `user`]
- 形态学扩展：`-ing`, `-ed`, `-s`, `-ation` 词尾剥离
- 输出：sparse vector（token vocabulary 上的 TF 向量）

**NetworkPolicy：**
- 默认 `disabled`：非 local 适配器必须显式 opt-in
- 未授权的网络请求 → 抛出 `RemoteProviderBlockedError`
- 配置方式：`zincgraph config set embedding.provider openai --opt-in`

**Acceptance:**
- [ ] `LocalTokenEmbedding.embed(['authenticateUser'])` → sparse vector 含 tokens `authenticate`, `user`
- [ ] 语义相似字符串的向量余弦相似度 > 不相似字符串
- [ ] `OpenAIEmbedding` 无 opt-in → 抛 `RemoteProviderBlockedError`
- [ ] Adapter registry: `getAdapter('local')` → LocalTokenEmbedding 实例
- [ ] `tests/vector/embedding.test.ts` 通过 ≥ 6 test cases

---

## T1.4 — 向量 Manifest & Freshness 追踪

**What:** Per-file 记录向量文档状态，支持新鲜度查询。

**Code spec:** goal.md G1.4

**Create:**
- `src/freshness/manifest.ts` — VectorManifestStore
- `src/freshness/semantic-status.ts` — 状态聚合
- `src/freshness/fusion-store.ts` — fusion.sqlite 持久化
- `tests/freshness/manifest.test.ts`

**VectorManifestStore：**
- Per-file 记录：`file_path + embedding_profile + chunker_version → vector doc IDs`
- 状态生命周期：`fresh → pending → stale → failed`
- 存储：`fusion.sqlite` 的 `manifest_entries` 表

**SemanticStatus：**
- 聚合所有文件的 manifest 状态
- 生成 human-readable warnings（"3 files have stale embeddings"）
- 查询时合并到 ContextCapsule.freshness

**FusionStore (fusion.sqlite)：**
- `vector_documents(id, node_id, file_path, embedding_profile, json)`
- `manifest_entries(entry_key, file_path, embedding_profile, chunker_version, json)`
- `metadata(key, value)` — embedding_profile, schema_version

**Acceptance:**
- [ ] Vectorize 项目 → 所有文件 manifest 状态为 `fresh`
- [ ] 修改一个文件 → 该文件 manifest 变为 `stale`
- [ ] 重新 embed → 经过 `pending` → 回到 `fresh`
- [ ] `SemanticStatus.getWarnings()` 对 stale 文件生成警告
- [ ] fusion.sqlite 重启后数据仍在
- [ ] `tests/freshness/manifest.test.ts` 通过 ≥ 5 test cases

---

## Phase 1 Exit Criteria

```bash
# 向量索引
zincgraph init <project>           # CodeGraph 索引
zincgraph vectorize <project>      # 向量索引
# 预期：fusion.sqlite 创建，所有文件 manifest fresh
# 预期：collection 中有向量文档

# 查询验证
node -e "
  const { openCollection } = require('./dist/vector/collection-manager');
  const col = openCollection('<project>');
  const results = col.query([{ text: 'token validation' }], 10);
  console.log(results.length > 0 ? 'vector query ok' : 'FAIL');
"

npx vitest run                     # all pass
```
