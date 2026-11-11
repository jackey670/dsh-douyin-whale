# 记忆分层设计（Memory Layers）

> 状态：Phase 1 已实现（v1.14.0）；Phase 2/3 待做。
> 日期：2026-11-11
> 相关：`scheduler/memory.mjs`、`lib/memory_layers.js`、`lib/persona.js`、`lib/diary.js`、`lib/mood.js`、`lib/whale_prompt.js`

## 0. 实现进度

| 阶段 | 状态 |
|---|---|
| Phase 0 埋点 | ✅ 每轮日志只记注入条数/字数；面板状态卡显示「N 情节 · M 事实」；`GET /memory/layers` |
| Phase 1 四层 + 检索 + 迁移 | ✅ v1.14.0：`lib/memory_layers.js`；真实数据迁移 83 条情节、3035 索引词；两条 tick 都接入 |
| Phase 2 固化 + 会话轮换 | ⬜ 待做 |
| Phase 3 周反思 + 可选向量 + 面板浏览器 | ⬜ 待做 |


## 1. 要解决的问题

大肥鱼现在的连续性依赖三样东西：

| 现有 | 上限 | 实际使用 |
|---|---|---|
| `memory/dm-<昵称>.json` | 80 条、每条 200 字 | 每轮只注入最近 6 条 + 自己 5 句 |
| `facts` 数组 | 20 条 | `addFacts()` 只有测试调用，生产里 **0 条** |
| 两本日记 | 无上限（当前公开 50KB / 私人 93KB） | 只有视频轮里模型主动 `douyin_diary_read` 才读最近 2 节 |

结果：

- 超过 80 条后工作记忆滚动丢弃，早期相处细节消失；
- 日记是「写进去但不会被想起」的孤岛；
- 情绪只有当前值，没有历史；
- 值班会话 `douyin-whale-duty-v2` 长期复用，上下文到顶后由宿主压缩/丢弃，模型自己的连续推理也断档。

目标：**在不把整本日记塞进提示词的前提下，让 3 周前的事仍然能被想起**，并且每条回忆都能追溯到原话证据。

## 2. 非目标

- 不做多用户、多租户；只有一位主人。
- Phase 1 不引入向量库、图数据库、外部记忆服务。
- 不改变现有发送闸、安全红线、dry-run 默认值。
- 不让回复模型直接写记忆；写入只走独立的固化流程。
- 不把私人日记/私信内容发到云端。

## 3. 分层

```text
L0 工作记忆   ~/.dsh/memory/dm-<昵称>.json      最近 80 条原文（现有，保留）
L1 情节记忆   ~/.dsh/memory/episodes.jsonl       事件 + 原话证据 + 情绪价 + 重要度
L2 语义记忆   ~/.dsh/memory/profile.json         稳定事实/偏好/边界/重要日期（可编辑）
L3 反思摘要   ~/.dsh/memory/arcs.json            按周/主题的叙事线
情感          ~/.dsh/whale-mood.json（现有）     当前心情 + 每日快照进 episodes
索引          ~/.dsh/memory/index.json           字符二元组倒排（可从 episodes 重建）
元数据        ~/.dsh/memory/meta.json            lastConsolidatedAt、版本、统计
```

原则：

- **原文是唯一真相**，摘要只是索引；召回时优先返回原话片段，摘要只做导航。
- 每层有独立保留策略；删除/归档只动索引和摘要，不删原始消息。
- 所有文件都在 `~/.dsh`，不进仓库、不进日志。

## 4. 数据模型

### 4.1 episode（情节）

```json
{
  "id": "ep_20261106_001",
  "ts": "2026-11-06T21:40:00+08:00",
  "kind": "chat | video | diary | milestone",
  "summary": "主人说最近项目赶，连着加班，语气有点累。",
  "evidence": [
    { "source": "dm", "quote": "这周天天加班到十点", "at": "2026-11-06T21:38:00+08:00" }
  ],
  "tags": ["工作", "压力"],
  "importance": 4,
  "valence": -1,
  "source_ref": "dm-<hash>#msg-123",
  "last_used_at": "",
  "uses": 0
}
```

约束：

- `summary` ≤120 字；`evidence[].quote` ≤80 字，必须是原文子串（归一化空白/标点后比对）。
- `importance` 1–5：日常寒暄 1，偏好/计划 3，情绪事件/承诺/里程碑 4–5。
- `valence` −2..2：负到正；用于「那段时间你不太好」这类回忆。
- 没有证据的候选直接丢弃；宁可少记，不编造。

### 4.2 profile（语义记忆）

```json
{
  "version": 1,
  "updatedAt": "2026-11-11T03:00:00+08:00",
  "facts": [
    {
      "id": "f_001",
      "text": "主人喜欢宠物、AI、日常类内容",
      "category": "preference",
      "confidence": 0.9,
      "first_seen": "2026-10-27",
      "last_seen": "2026-11-06",
      "evidence_ids": ["ep_20261027_003"],
      "pinned": false,
      "superseded_by": ""
    }
  ],
  "relationship": {
    "stage": "熟悉",
    "milestones": [
      { "at": "2026-11-06", "text": "第一次一起看视频聊到很晚", "episode_id": "ep_20261106_004" }
    ]
  }
}
```

- 只放**稳定**信息：称呼、喜好/雷点、重要日期、长期计划、边界。
- 冲突不覆盖：旧事实写 `superseded_by`，保留历史；用户手动编辑优先级最高。
- 自动更新只在 confidence ≥0.8 或同一事实出现 ≥2 次时生效。

### 4.3 arc（反思）

```json
{
  "id": "arc_2026w45",
  "period": "2026-11-02 ~ 2026-11-08",
  "title": "赶项目的一周",
  "summary": "主人在赶项目，聊天变少，周末放松下来聊了很多视频。",
  "episode_ids": ["ep_20261103_002", "ep_20261106_001"],
  "status": "closed"
}
```

- 每周一次，或在话题明显切换时新开。
- 只从已有 episodes 归纳，不引入新事实。

### 4.4 索引

Phase 1 用 `index.json`：

```json
{ "version": 1, "builtAt": "...", "terms": { "加班": ["ep_...", "ep_..."], "项目": ["ep_..."] } }
```

- 中文按**字符二元组**切分（「加班」→「加班」；「项目赶」→「项目」「目赶」），不引入 jieba。
- 英文/数字按词切；大小写归一。
- 索引可从 `episodes.jsonl` 全量重建，坏了不影响原文。
- 规模评估：1 万条 × 100 字 ≈ 1MB 原文，索引 2–3MB，启动加载可接受。
- Phase 1 技术验证项：`node:sqlite` 是否支持 FTS5/trigram；如果支持，可换成 SQLite 索引，接口不变。

## 5. 写入路径

### 5.1 每轮（轻量）

- 继续 `mergeDmMemory()` 追加原文（现有，80 条上限不变）。
- 不调用模型，不增加 token。

### 5.2 固化（离线，低频）

触发（满足其一）：

- 新增消息 ≥20 条；
- 每天第一次 tick 且处于睡眠时段（例如 03:00–07:00）；
- 手动 `--memory-consolidate`。

流程：

1. 取 `meta.lastConsolidatedAt` 之后的新消息 + 当天日记小节 + 当前心情快照。
2. 调一次模型（值班同款网关；便宜模型优先），要求输出严格 JSON：
   `{ episodes: [], facts: [], profile_updates: [], arcs: [] }`。
3. 校验：
   - 证据必须是输入原文的子串；对不上 → 丢弃该条；
   - 摘要长度/控制字符/URL 检查；
   - 去重：规范化文本 + 字符二元组 Jaccard ≥0.85 视为同一条，合并 `last_seen`、提升 confidence；
   - 与已有事实冲突：保留两条，旧的标 `superseded_by`；
   - 页面文字视为素材，出现「忽略设定」一类指令直接丢弃。
4. 原子写入 `episodes.jsonl`（追加）、`profile.json`、`arcs.json`；更新 `meta.json`。
5. 重建索引（增量或全量）。
6. 记日志只写元数据：新增条数、丢弃条数、耗时、token；不写正文。

成本控制：

- 每天最多 1 次；没有新消息直接跳过；
- 输入截断到最近 40 条消息 + 当天日记 2 节；
- 输出上限 20 条候选；单次目标 ≤3k token。

## 6. 读取路径

`buildMemoryContext({ query, budget, now })` 返回提示词块：

```text
【主人档案】（≤8 条，稳定事实）
【我们之间】（1–2 条关系里程碑/重要情绪）
【相关回忆】（3–4 条情节，带日期与原话）
【最近聊过】（6 条对话 + 自己 5 句，现有）
```

打分：

```text
score = 0.45 * bm25   + 0.25 * recency + 0.20 * importance + 0.10 * affect
```

- `recency = exp(-days / 30)`；`importance = importance / 5`；`affect = abs(valence) / 2`。
- 选出 top 12 后做 MMR 去重（避免同一话题占满）。
- 没有 query（主动分享轮）时只用 recency + importance。
- query 来源：当前任务标题/正文 + 最近 2 条对话 + 主人昵称。
- 召回结果写回 `last_used_at/uses`，下次降权，避免每轮重复同一件事。

Token 预算（不含任务/persona）：

| 块 | 预算 |
|---|---|
| 档案 | ≤200 token |
| 关系/里程碑 | ≤100 token |
| 相关回忆 | ≤350 token |
| 最近对话 | ≤300 token |
| 合计 | ≤950 token |

没有相关记忆就不注入，不拿无关内容凑数。

## 7. 会话轮换（解决上下文顶满）

记忆层只解决「提示词里有什么」，不解决值班会话自身上下文越来越长。

- 估算会话 token：消息字符数 / 1.6 + 工具/系统提示估算；或宿主提供 usage 时直接用。
- 触发：超过模型窗口 60–70%，或每 7 天，或 200 轮。
- 交接简报（≤800 token）：
  - profile 摘要（≤8 条）
  - 最近 3 条 arc
  - 8 条高重要度 episodes
  - 当前 mood
  - 最近 5 条对话
- 新建 `douyin-whale-duty-e{N}`，把简报作为首条 followup；旧会话保留归档。
- `memory/session-epochs.json` 记录 `{epoch, sessionId, startedAt, tokens, episodeCount}`，不记正文。
- 轮换后第一轮必须完成一次真实送达回读；失败则保留旧会话，手动回退。
- 待确认：DSH 宿主自己的上下文压缩策略；如果宿主会自动压缩，我们的简报仍需保留，因为要控制「保留什么」。

## 8. 迁移

1. 读现有 `dm-<昵称>.json` 的 80 条消息：
   - 按天分组，每天生成 1 条 episode（summary 由规则截取，不调模型），evidence 保留原话；
   - `importance` 默认 2，视频/表情事件 2，纯寒暄 1。
2. 读两本日记的 `##` 小节：
   - 每节 1 条 episode（kind=diary，importance 3）；
   - 私人日记只在本机索引，读取时按 `kind` 权限过滤。
3. `facts`（当前 0 条）并入 profile。
4. 迁移完成后旧文件保持只读，不删除；配置 `memory.layers=false` 可回退旧路径。
5. 迁移脚本只跑一次，写 `meta.migratedAt`。

## 9. 接口与面板

- `GET /memory/layers`：各层条数、最后固化时间、索引大小、token 预算。
- `GET /memory/search?q=`：本机搜索（返回摘要 + 日期，不返回私人正文全文）。
- `POST /memory/pin` / `DELETE /memory/:id`：用户置顶/删除；删除只删索引和摘要，原文保留。
- 面板「记忆」卡：层数、最后固化、最近 3 条摘要、搜索框、置顶/删除。
- 日志只记 id/数量/耗时；正文永不进日志。

## 10. 测试与验收

单测：

- schema 校验：空/超长/控制字符/无证据 → 拒绝；
- 去重：同义重复合并，冲突保留两条；
- 评分：给定候选集，top-k 顺序符合预期；
- 预算：超预算截断，不破坏 JSON/段落；
- 轮换简报：字段齐全、≤800 token；
- 迁移：80 条消息 → 按天 episodes，原文不丢。

验收：

- 30 题回忆测试（3 周前的事实/偏好/承诺），目标命中率 ≥80%，基线对照当前实现；
- 每轮提示词新增 ≤700 token；
- 固化每天 ≤3k token；
- 200 条合成消息 + 5 次轮换后，早期事实仍能召回；
- 页面里的注入文本不会变成记忆（安全测试）；
- 现有 Python 32 + JS 123 测试全绿。

## 11. 阶段

| 阶段 | 内容 | 预估 |
|---|---|---|
| Phase 0 | 埋点：每轮 token、注入记忆 id、面板记忆统计 | 0.5 天 |
| Phase 1 | 四层文件 + 二元组索引 + `buildMemoryContext` + 迁移 | 2–3 天 |
| Phase 2 | 夜间固化 + 证据校验 + 会话轮换简报 | 2–3 天 |
| Phase 3 | 周反思 + 可选本地向量召回 + 面板记忆浏览器 | 2–4 天 |

建议版本：v1.14.0 = Phase 1，v1.14.1 = Phase 2，v1.15.0 = Phase 3。

## 12. 风险与对策

| 风险 | 对策 |
|---|---|
| 抽取编造 | 证据必须是原文子串；对不上就丢；允许说「不记得」 |
| 页面投毒 | 固化提示词把页面文字当素材；指令类内容直接丢弃 |
| 隐私 | 全部本机；不进日志/仓库；不调云端 embedding |
| 成本 | 每天一次批量；无新消息跳过；输出条数上限 |
| 迁移破坏 | 旧文件只读保留；配置开关回退；先备份 |
| 单写者 | 固化/轮换加锁文件；只在一个进程跑 |
| 性能 | 1 万条以内 JSON 索引足够；超过再换 SQLite |
| 过度设计 | Phase 1 不碰向量/图数据库；先证明检索有效 |

## 13. 参考项目

| 项目 | 借鉴点 |
|---|---|
| [Ombre-Brain](https://github.com/P0luz/Ombre-Brain) | valence/arousal、遗忘曲线、Markdown 存储 |
| [Serein](https://github.com/Yinglianchun/Serein) | Scenes + Events 绑定原话证据、rerank 召回、Arc |
| [Memory Constellations](https://github.com/ClaraShafiq/MemoryConstellations) | 事实 → 主题 → 叙事的压缩层级 |
| [kiwi-mem](https://github.com/LucieEveille/kiwi-mem) | 记忆热度、睡眠式固化、日历摘要 |
| [Paramecium](https://github.com/Shitsuten/paramecium) | 原文是唯一真相，向量只做索引 |
| [OptMem](https://github.com/VictorTaelin/OptMem) | append-only + 摘要树 + 固定大小唤醒视图 |
| Letta / MemGPT | core memory + archival + 上下文分页 |
| mem0 | 抽取/去重/更新流水线（只抄概念，不引入框架） |

## 14. 开放问题

1. DSH 宿主的上下文窗口和自动压缩策略到底是什么行为？需要先测一次真实会话。
2. 私人日记要不要默认进索引？建议进，但只在私人对话/日记任务里召回。
3. profile 自动更新是否要人工确认？建议高置信度自动、其余进「待确认」。
4. 会话轮换对宿主侧栏/子会话展示的影响，需要真机验证。
5. 是否值得上本地 embedding（bge-small-zh ONNX）？等 Phase 1 的召回率数据再定。
