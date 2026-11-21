# dsh-cooper-memory

给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的**跨会话长期记忆 + 本地知识库**插件。

数据全在本地一个 SQLite 文件里，不依赖 Docker、不需要向量数据库服务；
除了调用你自己配置的模型网关，进程不发起任何外部请求。

```bash
npm i -D dsh-cooper-memory
```

> 版本固定 `0.6.1`。需要 Node.js ≥ 22.5（用到内置 `node:sqlite`）。

---

## 它解决什么

| 痛点 | 做法 |
|---|---|
| 每次新对话都要重新交代背景 | 从对话里蒸馏偏好/事实，**每轮**自动注入 |
| AI 不知道你项目里的约定 | 把文档目录入库，检索命中就注入片段 |
| 反复解释同一件事 | 记忆有准入、去重、归并，不会越攒越乱 |
| 想不起上次聊到哪 | 检索工具 `memory_recall` / `kb_search` 随时可查 |

---

## 架构

```
DSH 宿主进程（Electron）
├─ index.js  原生 Host 插件
│    ├─ agent/pre-step ──► 召回 ──► 注入 <relevant-memories>
│    ├─ 30 秒定时器 ─────► 自动蒸馏 + 队列维护 + 画像刷新
│    └─ 内嵌 HTTP ───────► 127.0.0.1:17890（Web 界面）
└─ node mcp.mjs（子进程）──► 20 个 MCP 工具（stdio JSON-RPC）

数据：~/.dsh-memory/
  mem.db                  SQLite（WAL），约 100 MB
  memories.journal.jsonl  只增日志（记忆的事实源，可重建）
  inject-trace.log        注入轨迹（排查用）
```

**三层记忆**：

- **L1 条目**：`偏好 / 画像 / 事实 / 待办` 四类，分 `pending → active`，另有 `rejected`（抑制）与 `superseded`（被替换）
- **L2 场景块**：同类条目聚类后压成一份"主题规则"，按查询命中注入
- **L3 用户画像**：把常驻偏好压成 ≤400 字，**每会话注入一次**（按输入签名判重，变了才重发）

**知识库**：文件按标题层级 + 长度切块，四路召回；每个模块另有一句话摘要（见下文）。

---

## 安装

```bash
npm i -D dsh-cooper-memory
```

插件是 bundle 形态，安装后由 profile 的 patch 加载。重启 DSH 生效。

### 依赖（都可选）

| 依赖 | 作用 | 缺失时 |
|---|---|---|
| `@node-rs/jieba` ^2.0.4 | **必需**：中文分词（词元索引、查询切词） | 无法运行 |
| `@xenova/transformers` ^2.17.2 | 可选：本地向量检索（Transformers.js） | 向量路整体关闭，退回纯词面 |
| `dsh-better-sidebar` | 可选：侧边栏卡片入口 | 用原生槽位 |
| `@deepseek-ai/dsh-llm` | 可选：自动蒸馏 / 画像 / 重排 | 只用规则提取 |

装了 `@xenova/transformers` 会连带装 `onnxruntime-web`（推理）、`onnxruntime-node` 与 `sharp`。
**实际运行时只用 WASM 后端**：`env.backends.onnx.wasm.numThreads = 1`，原生后端不参与计算。
`sharp` 本插件不用，装它是 Transformers.js 的依赖链所致（`overrides` 已统一到 0.34）。

模型文件随包发布（`models/bge-small-zh-v1.5`，23 MB），**不联网下载**。

### 界面入口

按你的环境自动适配，三种任选其一即可生效：

1. **Better Sidebar 卡片**（装了 `dsh-better-sidebar` 时）— 起始页卡片，标题「记忆」
2. **原生左栏面板** — 走 `sidebar.panellist` + `main` 槽位
3. **浏览器** — `http://127.0.0.1:17890`（随宿主启动）

---

## 自动注入

每轮对话前注入一段 `<relevant-memories>`，四层按优先级排：

| 层 | 上限 | 说明 |
|---|---|---|
| L3 画像 | 220 字 | 每会话一次 |
| L1 记忆 | `min(380, 剩余×0.40)` | 最多 6 条 |
| 知识库 | 300 字 | 每块：路径 + 模块摘要 + 110 字正文 |
| L2 场景 | ≤ `min(240, 剩余)` | **整块放入或丢弃**，不切半句 |

总预算 1000 字（可配）。顺序是 画像 → 记忆 → 知识库 → 场景：记忆（偏好/事实）
是本插件的核心，不能给文档让路。

### 去重与复位

- 会话内按 id 记录**实际渲染进文本**的条目；被预算裁掉的下一轮还能补
- 上下文被压缩（`contextFoldSeq` 变化）后清空去重表，否则压缩掉的记忆整个会话都进不来

### 什么情况下不注入

- 有效词不足 2 个（"你好""今天天气不错"）→ 不做匹配召回，只给常驻层
- 消息不是"提问"（"把v1删掉""连接155的redis"）→ **不查知识库、不给场景**
  （知识库回答的是"系统怎么运作"，不是"帮我执行"）
- 本会话已注入过的条目不重复

### 排查

```bash
tail -f ~/.dsh-memory/inject-trace.log
```

每步一行：

```
inject items=6 scenes=0 kb=2 chars=1003 session=... q="..."
skip no-messages / skip no-new-user kinds=goal / skip all-deduped / skip no-hits
autodistill ok added=3 / partial okTurns=15/16 / skip no-new-turns
```

---

## 检索

### 四路召回

```
查询词
 ├─ ① jieba 词元 BM25   chunks_fts_tokens MATCH   权重 1.0
 ├─ ② trigram 子串      chunks_fts MATCH          权重 0.9
 ├─ ③ 向量（可选）      chunk_vectors 暴力余弦    权重 0.6
 └─ ④ LIKE 兜底         仅当前几路全空             权重 0.35
        ↓
   加权 RRF（k=60）→ 归一化 → min-max 拉伸 → 启发式重排 → MMR（λ=0.7）
```

- **RRF 归一化**按"所有列表都排第一"的理论最大值，不是单列最大值
  （按单列归一时三路叠加会把分数全部压到 1.0，排序失效）
- **min-max 拉伸** `0.35 + 0.65×norm`：RRF 的绝对分差太小，不拉开展，MMR 的冗余惩罚会盖过相关度
- **启发式重排**在 MMR 之前：索引页/汇总页降权，规格文档加权，标题命中加权，标识符精确命中加权

### 向量检索（可选）

- 模型 `bge-small-zh-v1.5`（quantized ONNX，22.9 MB，随包发布），512 维
- 推理用 `@xenova/transformers` ^2.17.2（Transformers.js），后端是 **ONNX Runtime Web（WASM）**，
  `numThreads = 1`，**完全离线**（`env.allowRemoteModels = false`）
- 向量存 SQLite 的 `chunk_vectors` 表：int8 + 每行一个 scale，512 维 = 每块 512 字节，
  2 万块约 10 MB。**没有用 sqlite-vec，也没有外部向量服务**——检索是进程内 JS 暴力余弦
  （在 2 万块规模下每次查询约 2 ms）
- **BGE 系列必须用 CLS 池化**；用 `mean` 会让相关文档得分低于无关文档
- 查询要加前缀：`为这个句子生成表示以用于检索相关文章：`
- 建库一次约 3~8 分钟；`vector-build` 增量补齐

同义改写实测（字面零重叠）：

| 查询 | 纯词面（字面零重叠） | 混合 |
|---|---|---|
| `how do I roll back a release` | 版本号规范 / 分支策略 | **发布流程文档** / 版本号规范 |
| `who approves production deploys` | CI 配置 / 提交规范 | **发布流程文档** / CI 配置 |

注入路径里向量只做**补位**：词面招不满时补，且相似度要 ≥0.50
（实测相关查询 0.52~0.61，无关查询 0.43~0.47）。

### 模块索引

给每个模块生成一句话摘要，检索命中时先看摘要再决定是否展开正文：

```bash
dsh-cooper-memory module-index-build    # 批量生成（一次 8 个模块）
dsh-cooper-memory module-index-list
```

切分规则：

| 路径形状 | 模块 |
|---|---|
| `<root>/modules/<x>.md` | 一个文件一个模块 |
| `<root>/<group>/<feature>/…` | 一个目录一个模块 |
| `<root>/<x>.md` | 顶层单文件 |
| 其余 | 前两级路径 |

摘要示例：

```
发布流程：汇总上线前检查、灰度放量与回滚步骤。
```

### 重排

- **启发式**（默认开，<10 ms）：索引/汇总页降权、测试报告降权、规格文档加权、标题命中加权
- **LLM 列表重排**（默认关，`MEM_RERANK=1` 开启）：实测在 `deepseek-v4.1-flash` 上
  质量不稳定、延迟 3~6 秒，只作实验功能

---

## 记忆生命周期

```
对话 ──► 蒸馏（LLM）或规则提取 ──► 候选
                                    ├─ 长度 <8 / 元配置噪声 / 近重复(≥0.78) → 丢弃
                                    ├─ 满足准入 → active
                                    └─ 否则 → pending
pending ──► maintainPending（每轮蒸馏后自动跑）
              ├─ 与活跃记忆重复(≥0.75) → rejected
              └─ 满足准入 → active（打 auto-admitted 标签）
```

### 准入阈值

| 条件 | 阈值 |
|---|---|
| 强指令句式（以后都/别再/一律/必须/记住） | ≥0.72 |
| preference / profile / interest | ≥0.78 |
| fact | ≥0.82 |
| todo | ≥0.85 |
| 含糊措辞（可能/也许/似乎） | 一律 pending |
| 与旧条目相似 0.5~0.78（拟替换） | 一律 pending，由人裁决 |

> 阈值下调过一轮：模型给事实打分普遍 0.85~0.9，原阈值 0.92 等于全部拦下。

### 自动蒸馏的触发

- 阈值渐进：1 → 2 → 4 → 6 轮，静默 300 秒兜底，30 秒扫一次
- **按会话隔离**：只处理触发会话自己的发言，并记 `meta.distill_wm:<sessionId>` 水位线
  ——多会话并行不串味，也不重复计费
- 失败指数退避（30s 起，最长 10 分钟）；部分批次失败时水位只推进到"连续成功"处

### 归并

```bash
dsh-cooper-memory merge-active --dry            # 干跑
dsh-cooper-memory merge-active --threshold 0.6  # 执行（写 JSON 备份）
dsh-cooper-memory restore-merge <备份文件>       # 撤销
```

同 kind 内按词包含度找近重复，保留最长最具体的一条，其余标 `superseded` 并指向保留者。

---

## 工具（20 个 MCP）

| 分类 | 工具 |
|---|---|
| 记忆 | `memory_recall` `memory_remember` `memory_list` `memory_confirm` `memory_reject` `memory_edit` `memory_extract` `memory_distill` |
| 场景/画像 | `memory_scenes` `memory_scene` |
| 知识库 | `kb_search` `kb_get` `kb_tree` `kb_ingest` |
| 运维 | `memory_probe_llm` `memory_usage` |
| 扩展 | `kb_diff` `kb_history` `kb_edit` `kb_rollback` |

---

## 命令行

```bash
dsh-cooper-memory <命令>

# 记忆
stats | recall | remember | confirm-all | reject-all | admit-pending
dedupe-pending | merge-active | restore-merge | auto-admitted | revoke-auto
profile-build | profile-show | scenes-build | scenes-list | scenes-cluster
journal-rebuild | rebuild | usage | cleanup

# 知识库
ingest <目录> [--prefix 命名空间] | search <查询> | kb-clear | reindex-tokens
vector-status | vector-build | vector-on | vector-off
module-index-build | module-index-list
```

`ingest` 的 `--prefix` 用于导入多个根目录，避免同名文件互相覆盖。

`cleanup` 支持 `--rule process|short|meta-config|all-imported`，写备份，可回滚。

---

## 浏览器界面

`http://127.0.0.1:17890`

- 左侧目录树、中间检索、右侧分块正文
- 分块编辑 / 版本历史 / 逐行比对 / 回滚
- 记忆管理（待确认批量处置）、场景与画像查看
- 只绑 `127.0.0.1`；校验 `Host` 头（挡 DNS rebinding）；请求体上限 2 MB

---

## 存储与成本

| 项 | 实测 |
|---|---|
| 2 万块知识库 | `mem.db` 约 100 MB（含向量 10 MB） |
| 注入一次 | 约 900~1000 字 ≈ 500 token |
| 向量索引常驻内存 | 约 47 MB；模型加载后再 +115 MB（仅 MCP 子进程，宿主不加载） |
| 模块索引生成 | 125 个模块 / 18 次调用 / 约 3.1 万 token |
| 蒸馏 | 每 15 条发言一次调用 |

记账：`dsh-cooper-memory usage --days 7` 按用途/日期聚合 token。

---

## 配置

配置来自 profile 的插件行（`cordis.patch.yml` 里那一条），常用项：

```yaml
budgetChars: 1000      # 注入总预算（字）
maxItems: 6            # 单轮最多注入几条记忆
maxScenes: 2           # 场景块上限
kb:
  enabled: true
  maxChunks: 2
  budgetChars: 300
l3:
  enabled: true
  maxChars: 220
autoDistill:
  enabled: true
  steadyThreshold: 6
  idleSeconds: 300
```

环境变量：

| 变量 | 作用 |
|---|---|
| `MEM_ROOT` | 数据目录（默认 `~/.dsh-memory`） |
| `MEM_DB` / `MEM_JOURNAL` | 单独指定数据库 / 日志 |
| `MEM_RERANK=1` | 开启 LLM 重排 |
| `MEM_KB_VECTOR_FLOOR` | 注入路径的向量相似度下限（默认 0.5） |
| `DEBUG_DISTILL=1` | 打印蒸馏原文与错误 |

---

## 导入工作流

```bash
# 1) 存量对话蒸馏（可选）
dsh-cooper-memory distill --limit 30

# 2) 文档入库
dsh-cooper-memory ingest "D:\docs\Spec" --prefix spec
dsh-cooper-memory ingest "D:\docs\docs-site" --prefix docs

# 3) 建向量（可选，3~8 分钟）
dsh-cooper-memory vector-build

# 4) 建模块索引（可选，约 3 万 token）
dsh-cooper-memory module-index-build

# 5) 试一下
dsh-cooper-memory search "发布流程" --limit 3
```

---

## 隐私边界

- 数据只在本地 SQLite；除**你自己配置的模型网关**外，不发起任何网络请求
- 向量模型随包发布，不下载
- 蒸馏发送的是你的发言原文（去掉注入内容与系统通知）；不想要 LLM 蒸馏可关掉 `autoDistill`
- Web 只绑回环地址

---

## 已知限制

- 不做语义分段：按标题层级 + 固定长度切，长表格会被切断
- 向量只用于知识库；记忆检索仍是词面（条目短，够用）
- 单机单库，无多租户、无同步
- LLM 重排依赖外部模型，网关不可用时静默退回原顺序
- `cli search` 是"用户主动检索"，**不受**提问意图闸门限制（搜操作指令会返回结果，属预期）

---

## 开发

```bash
git clone <repo> && cd dsh-cooper-memory
npm i
node cli.mjs stats          # 冒烟
node cli.mjs search "测试" --limit 3
```

设计取舍与实现细节见 [`docs/DETAIL.md`](docs/DETAIL.md)。

---

## 许可

MIT