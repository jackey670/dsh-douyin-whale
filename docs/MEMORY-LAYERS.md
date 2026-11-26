# 记忆分层设计（Memory Layers）

> 状态：Phase 2A 已实现（v1.14.1）；Phase 3a 评测/面板（v1.14.2）、
> Phase 3b 周反思（v1.14.3）、Phase 2B 值班会话轮换（v1.14.4）已做；
> 记忆星图 P1/P2（v1.17.0 / v1.18.0）已完成；真实 DSH 值班宿主还需真机验证。
> 日期：2026-11-11（v1.18.0 更新于 2026-11-26）
> 相关：`scheduler/memory.mjs`、`lib/memory_layers.js`、`lib/persona.js`、`lib/diary.js`、`lib/mood.js`、`lib/whale_prompt.js`

## 0. 实现进度

| 阶段 | 状态 |
|---|---|
| Phase 0 埋点 | ✅ 每轮日志只记注入条数/字数；面板状态卡显示「N 情节 · M 事实」；`GET /memory/layers` |
| Phase 1 四层 + 检索 + 迁移 | ✅ v1.14.0：`lib/memory_layers.js`；真实数据迁移 83 条情节、3035 索引词；两条 tick 都接入 |
| Phase 2A 记忆固化 | ✅ v1.14.1：`lib/memory_consolidate.js`；证据校验/去重/私人标记；独立调度器已接，值班会话待接 |
| Phase 2B 会话轮换 | ✅ v1.14.4：`lib/session_rotate.js`；usage/年龄/轮数触发；交接简报；`session-epochs.json`；轮换前跑固化/反思 |
| Phase 3a 评测 + 面板 | ✅ v1.14.2：`tools/memory-eval.mjs` 30 题；`/memory/overview|search|pin|pending|item`；面板记忆卡；低置信待确认 |
| Phase 3b 周反思 | ✅ v1.14.3：`lib/memory_reflect.js`；最近 7 天情节 → arcs；私人叙事线默认不注入；面板显示叙事线 |
| Phase 3c 向量召回 | ⬜ 暂不上：合成集 hit@4 100%，等真实问题集出现缺口再评估 |
| Phase 4 记忆星图 | ✅ v1.17.0 P1（图构建 + 3D 面板）、v1.18.0 P2（回忆强化/共现边/轨迹回放）；图扩散回忆等真实共现数据攒够再上 |


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
关联          ~/.dsh/memory/links.jsonl          共现边：同轮被想起过（学出来的，重建不了）
轨迹          ~/.dsh/memory/traces.jsonl         最近想起记录（id/触发/时间，不含正文）
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
  "id": "arc_20261114_1",
  "period": "2026-11-08 ~ 2026-11-14",
  "title": "赶项目的一周",
  "summary": "主人连续加班，周末才缓过来；中间还换了新键盘。",
  "episode_ids": ["ep_20261109_01", "ep_20261110_02"],
  "visibility": "public",
  "createdAt": "2026-11-14T11:18:00.000Z",
  "source": "reflect"
}
```

- 最近 7 天一次；`episode_ids` 只能引用输入素材，至少 2 条；只归纳，不引入新事实。
- 引用私人日记的 arc 标 `visibility=private`，`buildMemoryContext` 默认不注入。
- 同一 `period` 重跑会替换旧 arc（不会叠加）；最多保留 52 条。

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

### 4.5 关联与回忆轨迹（v1.18.0）

```json
// links.jsonl：一行一条无向边，星图直接读
{ "a": "ep_20261106_001", "b": "ep_20261110_002", "kind": "co_recall", "w": 0.25, "updatedAt": "..." }
// traces.jsonl：一行一次召回，只记 id/触发/时间，不记正文
{ "id": "tr_mabc123", "at": "...", "trigger": "watch", "ids": ["ep_...", "ep_..."] }
```

- `recordRecall({ ids, trigger })` 在记忆锁内**重读**情节，只给仍然存在的 id 记
  `uses++` / `last_used_at`，再把这一轮的 id 两两写成 `co_recall` 边（每次 +0.05，
  上限 0.8）。锁被固化占用时返回 `{ok:false, reason:'busy'}`，调用方照常继续。
- 四条注入路径统一 `withMemoryLayers({ record:true, trigger:'watch'|'share' })`；
  搜索、面板浏览等只读路径不写轨迹。
- `traces.jsonl` 只保留最近 2000 条；`/memory/traces` 只回 id/触发/时间，摘要和
  原话都不出现。
- 星图亮度用强化后的强度：`s0 = 0.5 + importance/10 + min(0.25, 0.04·uses)`，
  衰减从 `last_used_at` 重新起算——越被想起越亮，长期不用的星自然变暗。

## 5. 写入路径

### 5.1 每轮（轻量）

- 继续 `mergeDmMemory()` 追加原文（现有，80 条上限不变）。
- 不调用模型，不增加 token。

### 5.2 固化（离线，低频）

触发（满足其一）：

- 新增消息 ≥10 条（`memory.consolidate.minMessages`，可调）；
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

- 两次尝试至少隔 6 小时（`minIntervalHours`）；没有新消息直接跳过；
- 输入截断到最近 30 条消息 + 8 节日记；
- 输出上限 20 条候选；单次目标 ≤3k token。

## 6. 读取路径

`buildMemoryContext({ query, budget, now })` 返回提示词块：

```text
【主人档案】（≤8 条，稳定事实）
【我们之间】（1–2 条关系里程碑/重要情绪）
【最近这几周】（≤2 条叙事线，默认只放公开 arc）
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
- 召回结果由 `recordRecall` 写回 `uses/last_used_at`（v1.18.0）：星图亮度据此增强。
  检索排序暂不读 `uses`——排序再吃强化信号会形成「越常被搜到就越常被搜到」的正反馈，
  等图扩散回忆上线时再统一考虑。

Token 预算（不含任务/persona）：

| 块 | 预算 |
|---|---|
| 档案 | ≤200 token |
| 关系/里程碑 | ≤100 token |
| 最近这几周 | ≤120 token |
| 相关回忆 | ≤350 token |
| 最近对话 | ≤300 token |
| 合计 | ≤950 token |

没有相关记忆就不注入，不拿无关内容凑数。

## 7. 会话轮换（解决上下文顶满）

记忆层只解决「提示词里有什么」，不解决值班会话自身上下文越来越长。
实现见 `lib/session_rotate.js` + `lib/duty_agent.js` 的 `contextInfo/ask/rotate`。

- **用量估算**：优先取会话里最近一条 `assistant/message` 的 `usage`
  （`inputTokens + cacheRead + cacheWrite`，缺失时 `totalTokens`）；
  读不到事件就按 `deriveMessages()` 的可见字数 / 1.6 估；窗口取
  `session.requestContext().contextWindow`。
- **触发**：窗口占比 ≥ `duty.rotate.contextRatio`（默认 0.7）/ 会话年龄
  ≥ `maxAgeDays`（7）/ 轮数 ≥ `maxTurns`（200）；任一满足；`enabled=false` 可关。
- **轮换前**：在旧会话里跑一次固化和周反思（`dutyAgent.ask` 取 JSON 回复），
  输出留在旧上下文，马上随旧会话丢弃，不会污染新会话。
- **交接简报**（`buildHandoffBriefing`，≤1400 字）：
  - profile 公开事实（≤8，置顶优先）
  - 关系里程碑（≤2）
  - 最近公开叙事线（≤3）
  - 高重要度公开情节（≤8，带日期与原话）
  - 最近 5 句对话
  - 当前 mood
- **换会话**：新建 `douyin-whale-duty-e{N}`，简报用
  `agent.send(msg, 'next-turn', false)` 排进下一轮（不额外唤醒）；旧会话从
  registry 摘掉、磁盘日志保留。新会话继承 parent/meta，不进工作区侧栏。
- **状态文件** `memory/session-epochs.json`：只记
  `{epoch, sessionId, startedAt, rotatedAt, previousSessionId, 用量, reason}` 和
  最近 10 条 history，不记正文；插件重载后从当前 epoch 继续。
- **失败处理**：create 失败保留旧会话；`e{N}` 撞 id 会向后试两格；轮换后第一轮
  仍按原有回读确认，失败则下轮重试。
- **待真机验证**：DSH 宿主的 `agent.session` 是否稳定暴露
  `snapshotEvents/requestContext/deriveMessages`；当前生产走独立调度器，
  值班轮换只用伪造宿主做了离线单测。

## 8. 迁移

跨机迁移/备份用 `tools/memory-export.mjs`（v1.14.5）：
`--export` 出 staging + manifest（每文件 sha256），`--push` 推私有仓
（GitCode `dsh-douyin-whale-memory`，含历史、禁 GitHub），`--verify` 克隆比对；
排除 `consolidate.lock` / `session-epochs.json` / `*.tmp`。v1.18.0 起
`links.jsonl`（共现边）与 `traces.jsonl`（回忆轨迹）也进迁移包——这两份是「用出来的」，
无法从原文重建。

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
- `GET /memory/overview`：统计 + 置顶/高置信事实 + 待确认 + 最近情节（摘要）。
- `GET /memory/search?q=`：本机搜索（返回摘要 + 日期，不返回 evidence/私人正文全文）；
  `private=1` 才包含私人条目。
- `POST /memory/pin`：事实置顶/取消置顶。
- `POST /memory/pending`：`{id, action: accept|dismiss}` 采纳或忽略待确认事实。
- `POST /memory/pending/batch`：`{ids:[…≤20], action}` 批量采纳/忽略，一次读一次写；
  返回 `resolved` 与 `missing`，不存在的 id 不算失败。
- `GET /memory/episode?id=&private=1`：**唯一返回 evidence 原话的出口**；私人情节
  不带 `private=1` 时返回 `200 {ok:false, private:true}`（不抛 404，免得面板只显示
  transport 错误）。
- `GET /memory/health?staleDays=`：只读六项诊断（见 §10.2），`staleDays` 夹 7–365，
  缺省 90。
- `GET /memory/graph?private=1&max=&minSim=`：只读星图（v1.17.0）。节点 = 自我/
  性格/主人/事实/情节/叙事线/主题，边 = core/about/evidence/part_of/related/
  supersedes/co_recall（v1.18.0）；节点只带摘要与详情，evidence 原话只参与相似度
  计算、不下发。私人条目默认过滤，`private=1` 才出现。
- `GET /memory/traces?limit=`：最近想起记录（v1.18.0），`limit` 夹 1–100、缺省 20；
  只回 `{id, at, trigger, ids}`，不含摘要/原话。
- `POST /memory/reindex`：按当前情节重建倒排索引（幂等维护动作，不改原文）。
- `DELETE /memory/item?id=`：删除事实（软删）或情节（移出 jsonl 并重建索引）；
  私信/日记原文保留。
- 写操作和固化共用 `memory/consolidate.lock`，固化进行中返回 409。
- 面板「记忆」卡：层数、最后固化、最近 3–5 条摘要、搜索框、置顶/删除、待确认
  （勾选 + 全选 + 批量采纳/忽略）、情节「看原话」。
- 面板「记忆体检」卡：六项诊断逐条 ✓/「N 处」+ 样本，底部「重新体检」「重建索引」；
  面板加载时自动体检一次。
- 面板「记忆星图」卡（v1.17.0）：canvas 3D 星图，轨道旋转/缩放/点选详情/看原话、
  含私人开关、星图与时间两种布局、全屏；亮度=强化衰减后的强度，节点大小=重要度/
  度数，颜色按类型。
- 星图「最近想起」（v1.18.0）：星图下方 chips 列出最近召回；点一条把该轮的星和
  它们之间的边金色高亮，再点取消。数据只来自 `/memory/traces`，不加载正文。
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

- 30 题回忆测试（3 周前的事实/偏好/承诺），目标命中率 ≥80%；
- 每轮提示词新增 ≤700 token；
- 固化每天 ≤3k token；
- 200 条合成消息 + 5 次轮换后，早期事实仍能召回；
- 页面里的注入文本不会变成记忆（安全测试）；
- 现有 Python 32 + JS 169 测试全绿。

### 10.1 当前基线（v1.14.2，合成 30 题）

| 指标 | 结果 |
|---|---|
| hit@1 | 18/21（85.7%） |
| hit@4 | 21/21（100%） |
| MRR | 0.929 |
| 事实命中 | 6/6 |
| 负例无误召回 | 2/2 |
| 私人过滤 | 2/2 |
| 最大注入 | 239 字 |
| 耗时 | ~25 ms |

结论：hit@4 已达标，**暂不上本地向量召回**；真实回忆质量用
`node tools/memory-eval.mjs --questions <本机文件>` 手工出题测，问题集不入库。

### 10.2 真实语料基线（v1.16.1）

| 指标 | 结果 |
|---|---|
| 题数 | 30（事件可排序 21–23，随记忆增长） |
| hit@1 | 87–88% |
| hit@4 | 100% |
| MRR | ~0.93 |
| 事实命中 | 5/5 |
| 负例无误召 | 2/2 |
| 私人过滤 | 1–2/2 |

一条命令重跑（题目来自本机真实记忆，只写 `data/`，gitignored、不回显）：

```bash
npm run memory:eval:gen     # ~/.dsh 记忆 → data/memory-eval-questions.json
npm run memory:eval:local   # 用生成的问题集跑评测
```

### 10.3 记忆体检（v1.16.0）

`memoryHealth()` 六项诊断，只提示、**不自动改记忆**：

| key | 含义 | 判据 |
|---|---|---|
| `staleFacts` | 长期未更新的事实 | `last_seen/first_seen` 超过 `staleDays`（默认 90） |
| `duplicateFacts` | 疑似重复事实 | `similarText` 相似；双方都置顶的跳过 |
| `episodesNoEvidence` | 没有引文的情节 | `evidence` 为空 |
| `arcBrokenRefs` | 叙事线引用已删除情节 | `episode_ids` 里有 id 不在 episodes |
| `indexStale` | 检索索引失配 | 无索引 / `docCount` ≠ 情节数 / 比最新情节旧 |
| `pendingBacklog` | 待确认积压 | `pending` 条数，附最老天数 |

样本只给摘要（最多 5–8 条），**不含证据原话**。`rebuildMemoryIndex()` 可幂等重建
索引；重复/过期事实的处置仍走逐条或批量操作，避免自动改记忆改坏。

## 11. 阶段

| 阶段 | 内容 | 预估 |
|---|---|---|
| Phase 0 | 埋点：每轮 token、注入记忆 id、面板记忆统计 | 0.5 天 |
| Phase 1 | 四层文件 + 二元组索引 + `buildMemoryContext` + 迁移 | 2–3 天 |
| Phase 2A | 夜间固化 + 证据校验 | ✅ v1.14.1 |
| Phase 2B | 会话轮换简报 | ✅ v1.14.4 |
| Phase 3a | 30 题评测 + 面板记忆浏览器 + 待确认 | ✅ v1.14.2 |
| Phase 3b | 周反思 arcs | ✅ v1.14.3 |
| Phase 3c | 可选本地向量召回 | ⬜ 暂不上（等真实问题集缺口） |
| Phase 4 | 记忆星图（图构建/3D 面板/回忆强化/轨迹回放） | ✅ v1.17.0–v1.18.0 |

建议版本：v1.14.0 = Phase 1，v1.14.1 = Phase 2A，v1.14.2 = Phase 3a，
v1.14.3 = Phase 3b，v1.14.4 = Phase 2B。下一版先做值班轮换真机验证。

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

1. ⚠️ v1.14.4 已按宿主类型定义实现 usage/contextWindow 读取（`requestContext` +
   `assistant/message.usage`），但还没在真实值班宿主里跑过一次轮换；先观察
   面板上的 `eN · 占用%` 是否随对话变化。
2. 私人日记要不要默认进索引？建议进，但只在私人对话/日记任务里召回。
3. ✅ v1.14.2：高置信度自动进档案，confidence <0.75 进 `profile.pending`，
   面板人工采纳/忽略。
4. ⚠️ 会话轮换后旧会话从 registry 摘掉、磁盘日志保留；宿主侧栏展示需真机确认。
5. ⏸ 暂不上本地 embedding：v1.14.2 合成集 hit@4 100%、hit@1 85.7%；
   等真实手写问题集出现明显缺口再评估 bge-small-zh / FTS5。
