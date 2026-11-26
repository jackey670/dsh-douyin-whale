# Changelog

## 1.17.0 — 2026-11-26

记忆星图 P1：把四层记忆摆成一个可交互的 3D 星系。

### 新增

- **`lib/memory_graph.js`**：只读、确定性的星图构建器。
  - 节点：`self`（自我）、`trait`（从人设/偏好拆出的性格）、`owner`、`fact`、
    `episode`、`arc`、`topic`（出现 ≥2 次的非通用标签）。
  - 边：`core`（自我→性格/主人）、`about`（事实/情节→主题、主人→事实）、
    `evidence`（事实→情节，bigram 相似度 top 2）、`part_of`（情节→叙事线）、
    `related`（情节↔情节，倒排索引 cosine，每个节点 top 4）、`supersedes`
    （旧事实→新事实）。
  - 星等：`starStrength()` 按重要度定初始强度/半衰期（2/5/14/45 天），
    `|valence|` 延长半衰期；输出 clear/faded/trace/pinned 四态，供星图调亮度。
  - 隐私：默认过滤私人节点；节点只带摘要与详情，**evidence 原话只参与相似度
    计算、绝不下发**；私人节点被隐藏时，相连的边一并隐藏。
  - 上限：情节默认 280、事实 200、叙事线 50、主题 40，统计里带截断标记。
- **`GET /memory/graph`**：`private=1` 才含私人；`max` 夹 20–600、`minSim`
  夹 0.05–0.95，缺省参数不会被 `Number(null)` 误读成 0。
- **面板「记忆星图」卡**（PANEL_BUILD=27）：纯 canvas 3D，不引第三方库。
  - 透视投影 + 轨道相机：拖动旋转、滚轮缩放、双击复位；预渲染光晕精灵 +
    加法混合 + 深度雾，标签带碰撞避让。
  - 布局：星图（性格/事实/叙事线/主题分层环 + 情节按主标签聚成星座）与
    时间（x=时间轴）。
  - 交互：点击星星看详情；情节自动拉 `/memory/episode` 显示原话；含私人开关、
    刷新、全屏（Esc 退出）。
  - 无 rAF 的环境（后台页/被节流）也先画一帧静态图，不会白屏。

### 验证

- `lib/memory_graph.test.mjs` 6 项：节点/主题/叙事/相似/取代/证据边、隐私门与
  原话不进图、上限/截断、性格星与 core 边、星等衰减、确定性。
- `lib/panel_api.test.mjs` 30 项（+星图路由与 private 门）。
- `npm test` 22 组全绿；面板预览实测：30 星/36 连线、含私人 32 星/41 连线、
  时间布局、全屏、点星看详情与原话。
- 调研参考（未引入依赖）：companion-memory 的衰减/共现模型、MemPalaceViz 的
  配色与布局、mcp-memory-service 的 typed edges/同心环、Graphiti 的 episode
  溯源思路。

## 1.16.2 — 2026-11-26

新工具补测试，值班真机清单补 R8/R9 观察项。

### 新增

- **`tools/release-pack.test.mjs`**：跑 `--no-upload` 实际打包，断言 tarball 与
  `.sha256` 存在且校验一致、白名单含运行时模块/面板/手册/工具自身、包内版本
  与仓库一致、`data/`/cookie/credential/storage_state/dm-* 不出包。
- **`tools/memory-eval-gen.test.mjs`**：夹具记忆生成四类题（事件/事实/私人/负例），
  断言事件题只取公开情节、事实题去「主人」前缀且只取公开事实、私人探针不期望
  公开命中、负例零期望；缺记忆文件时退出码 1 并提示 `--home`。
- **`docs/DUTY-ROTATE-VERIFY.md`**：观察项补 10–13（提前收轮与 `sealed_until`
  封存、忙轮跳过、侧栏显隐、分享降级），风险表把「900s 超时」「分享轮不发出」
  更新为已改进/可选降级，并新增「提前收轮后重复发送」条目。

### 变更

- `files` 增加 `!tools/*.test.mjs`：测试文件不进发布包（`lib/*.test.mjs` 之前已排除）。
- `npm test` 21 组；发版审计的测试清单同步收录两个新测试。

### 验证

- 两个新测试全绿；`npm run check` / `npm test` 通过；client.js 仅版本串改
  `v1.16.2·b26`（无 UI 改动）。

## 1.16.1 — 2026-11-26

交付与评测工具化：Release 附件一键打，真实语料评测一条命令跑。

### 新增

- **`tools/release-pack.mjs`**（`npm run release:pack`）：`npm pack` 按
  `files` 白名单打 tarball（72 个文件，data/、cookies、credentials 均不在内），
  同时生成 `.sha256`，再 `gh release upload` 挂到对应 GitHub Release；
  `--no-upload` 只打包，`--tag` 指定版本。Windows 下用 `cmd /c npm`，
  不触发 shell 参数拼接告警。
- **README「从 Release 装打包版」**：tarball + 校验和安装步骤，并写明打包安装的
  三处差异（dataDir 变 `~/.dsh/douyin-whale`、不带 `.venv` 需 `pythonPath`、
  升级 = 重新 add）。
- **`docs/UPGRADE.md`**：生产机升级/回滚/记忆恢复手册——升级前停值班与导出记忆、
  checkout 与打包两种升级路径、升级后自检清单、回滚、手工恢复 `~/.dsh` 记忆、
  常见坑（TEMP 权限、发送闸环境变量、双机同账号）。
- **`tools/memory-eval-gen.mjs`**（`npm run memory:eval:gen`）：从本地真实记忆
  生成评测问题集（事件/事实/私人/负例），只输出计数，题目写入 `data/`（gitignored）。
  `npm run memory:eval:local` 直接跑生成好的问题集。

### 验证

- 本机真实语料 30 题复跑：hit@1 87.0%、hit@4 100%、MRR 0.935、事实 5/5、
  负例 2/2、私人过滤 1/1。
- `npm run check`（+2 个新工具语法检查）、`npm test` 19 组全绿；
  tarball 内容扫描无敏感路径；已上传 v1.16.0 资产验证 release-pack 全链路。
- client.js 仅版本串改为 `v1.16.1·b26`（无 UI 改动，PANEL_BUILD 不增）。

## 1.16.0 — 2026-11-26

记忆体检（R10）：记忆库出问题时看得见、点一下就能修索引。

### 新增

- **`memoryHealth()` 诊断**：只读扫描四层记忆，输出六项
  —— 长期未更新的事实（默认 90 天，可取 7–365）、疑似重复事实（文本相似度，
  双方都置顶的跳过）、没有引文的情节、叙事线引用已删除情节、检索索引失配
  （无索引 / 条目数不符 / 索引比最新情节旧）、待确认积压（含最老天数）。
  返回每项 `count` + 最多 5–8 条样本，**不含证据原话**。
- **`rebuildMemoryIndex()`**：按当前情节重建倒排索引，返回情节数/词条数。
- **API**：`GET /memory/health?staleDays=`（夹取 7–365）、
  `POST /memory/reindex`（走记忆写锁，忙时 409）。
- **面板「记忆体检」卡**：六项逐条显示 ✓ 或「N 处」+ 样本摘要，顶部汇总
  事实/待确认/情节/叙事条数；底部「重新体检」「重建索引」两个按钮。默认随
  面板加载自动体检一次。

### 设计说明

- 体检**只诊断不动手**：重复事实与过期事实只提示，删除/采纳仍走现有逐条或
  批量操作，避免自动改记忆。
- 重建索引是幂等维护动作，不改 episodes/profile 原文。

### 验证

- memory_layers 16 项（+体检夹具：过期/重复/无引文/断引用/索引失配/积压
  六项逐项断言，重建后 indexStale 归零）；panel_api 29 项（+health 参数夹取、
  reindex 成功/忙锁 409）。
- PANEL_BUILD=26；面板预览实测体检卡渲染与重建按钮。

## 1.15.3 — 2026-11-26

主动分享链接兜底（R9）：分享面板没目标时不再空转。

### 新增

- **`proactiveShare.linkFallback`**（默认关）：抖音分享面板只列「最近分享过的人」，
  目标不在面板时原生卡片发不出去（此前整轮空转）。开启后主动分享提示词会追加
  降级规则——改用 `douyin_dm_send` 发一条带视频链接的文字
  （`https://www.douyin.com/video/<id>`），一轮只发一条，不加第二句。
- **面板开关**：设置 → 主动分享 →「分享面板没目标时发链接」；落盘为
  `proactiveShare.linkFallback`。**默认关 = 保持「宁缺毋滥」**，不想发链接的主人
  不受影响。

### 验证

- whale_prompt 10 项（+2：默认关不注入、打开后 tools/shell 两种写法都含链接与
  「只发一条」约束）；panel_api 28 项（+linkFallback 布尔落盘、非布尔 400）。
- PANEL_BUILD=25；全套 check/test 通过。

## 1.15.2 — 2026-11-26

检索分词修正：负例不再误召。

### 修复

- **`tokenize()` 过滤虚词二元组**：助词（的/了/呢/吧/啊/呀/哦/嘛）出现在任何
  位置的二元组不进索引/查询，疑问与指代类二元组（怎么/什么/如何/哪些/我们/
  这个/可以…）整词丢弃。负例「量子退火机的哈密顿量怎么写」此前靠「机的」
  「怎么」命中无关情节，根因是跨词边界的虚词二元组被当成了检索特征。
- 只影响检索 token，不改原文；旧索引里残留的虚词词条不再被查询命中，无需
  强制重建。

### 验证

- 内置评测（`npm test` 门禁 hit@4≥0.9）：hit@4 100%、负例 2/2 无误召、
  私人过滤 2/2。
- 真实语料 30 题基线：负例 **1/2 → 2/2** 修复；事件 hit@1 87%、hit@4 100%、
  MRR 0.935、事实 5/5 均持平（过滤没有伤到内容词召回）。
- memory_layers 15 项（+分词虚词过滤用例）、memory_consolidate 9 项全绿。

## 1.15.1 — 2026-11-26

双机切换脚本（R6）+ 真实语料评测基线（R3）。

### 新增

- **`scripts/dev-duty.ps1`**（开发机值班开关）：
  - `-Status`：只读显示 whaleEnabled / DOUYIN_IM_ALLOW_SEND / 本机调度器状态；
  - `-Off`：whaleEnabled=false + 移除用户级发送开关（生产在笔记本时的常态）；
  - `-On`：必须先带 `-Yes`，否则只打印前置清单（停笔记本生产 / wb2 网关 /
    两机不能同跑 / 需完全重启）不做修改；
  - 只改 desktop profile patch 里的 `whaleEnabled` 与用户级环境变量，原文本正则替换、
    保留换行风格；往返测试（-On -Yes → -Off）后 patch 字节级还原。
- **`tools/memory-eval.mjs` 文件题库**：`--questions` 的加载器支持内置题库的
  `private`/`negative` 语义（expect 可为空；private 支持 includePrivate + 排位）。

### 验证

- 真实语料基线（30 题，问题文件留在本机 data/，不入库）：事件 hit@1 87%、
  hit@4 100%、MRR 0.935；事实命中 5/5；私人过滤 1/1。
- 发现（进 BACKLOG 待调）：负例「量子退火机的哈密顿量怎么写」因通用二元组
  （的/写等）误召 3 条情节 → 短词/停用词过滤或相关性分数下限。
- `dev-duty.ps1 -Status/-On/-Off` 实测输出正确，patch 往返无格式漂移。

## 1.15.0 — 2026-11-26

面板记忆卡增强（R4）：情节看原话 + 待确认批量操作。

### 新增

- **情节「看原话」**：每条情节行新增按钮，展开 evidence 引文块（引文 + 来源
  「私信/日记」+ 时间），再点收起。这是**唯一返回原文的出口**——overview/search
  仍只给摘要（原有契约与测试保留）。
- **私人情节门**：`GET /memory/episode` 默认不含私人；要 `private=1` 才给，
  面板上需先勾选「含私人日记」。被门拦住返回 `200 { ok:false, private:true }`，
  面板给出可读提示（非 2xx 会被面板 transport 层吃掉）。
- **待确认批量操作**：`POST /memory/pending/batch`（≤20 条，一次读一次写——
  单条版每条都整库重写 + 重建索引）。面板加复选框 + 全选 / 采纳所选(n) /
  忽略所选(n)（忽略前 confirm）；未知 id 进 `missing` 照常返回 200。
- overview 的待确认切片 10 → 20，与固化保留上限对齐（此前第 11–20 条在面板
  永远不可见）。

### 验证

- panel_api 28 项（+2 块：episode 原话/私人门/400/404；batch 采纳/忽略/missing/
  空 ids/非法 action/超 20/固化锁 409）。
- 面板预览实测（`tools/panel-preview`，补了记忆样例）：公开情节展开两条引文；
  私人情节未勾选被拦且不泄露原话，勾选后可见；全选 → 采纳所选(2) → 待确认清空、
  两条事实入档（置信 80%）。
- PANEL_BUILD=24，`v1.15.0·b24`；全套 check/test 通过。

## 1.14.9 — 2026-11-26

值班回合收尾优化（R8）：确认发送后不再空等 15 分钟。

### 修复

- **awaitIdle 的「消息数基线」是死代码**：v1.14.5 的 `send()` 只在返回值里带
  `messageCountBefore/runningNow`，从未写回模块状态 → `awaitIdle` 拿不到基线，
  只要 agent 跑起来就必然等满 `idleMs` 15 分钟才超时（11-22 真机日志里的 900s
  「超时」即此）。现在 `send()` 写回 `lastSendInfo`，回合正常跑完即可收轮。

### 新增

- **确认发送后提前收轮**：`shouldEndRoundEarly()`（纯函数）+ `awaitIdle({ earlyExit })`。
  回复标记 `sent:true` 且过了宽限期（默认 8 秒）就收轮，不再等模型生成收尾长文。
  排队轮（send 时上一轮还在跑）不启用，避免把上一轮的发送记到本轮。
- **封存标记防重复发送**：`sealReplyMarker()` + `markerBlocksSend()`。提前收轮时
  不删标记而是封存（默认 15 分钟），闸门继续拦 agent 追加发送；封存到期自动放行，
  手动发送不受长期影响。`douyin.mjs` 三处发送闸统一改用 `markerBlocksSend`。
- **busy-skip**：值班 tick 发现上一轮还在跑时直接跳过（不排队），避免回复标记
  被下一轮重置、旧轮次的发送被记到新条目。
- **finally 兜底**：`runWatchRound` 的标记 begin→end 包 try/finally，dispatch/
  awaitIdle/回读抛错时不再残留标记。
- 配置：`duty.earlyExit = { enabled: true, graceMs: 8000, sealMs: 900000 }`。

### 验证

- duty_agent 16（+5：基线/queued 刷新/earlyExit 命中/抛错/queued 禁用）、
  whale_round 14（+4：纯函数六分支/提前收轮封存/普通删除/finally 清理）、
  whale_tick 14（+2：busy-skip/透传 earlyExit）、send_gate 6（+2：封存期内拒、
  封存过期放行，端到端走 douyin.mjs）。
- 全套 Python + JS 19 组全绿。
- **真机验证延后**：笔记本在跑生产，本轮只在开发机跑单测；下次双机切换时
  按 `docs/DUTY-ROTATE-VERIFY.md` 复核「确认发送提前收轮」日志。

## 1.14.8 — 2026-11-22

内容队列默认收起，面板不再被几十条队列刷穿。

### 新增

- **内容队列卡默认只显示最近 5 条**（新→旧），标题行加「展开全部 N 条 / 收起」
  按钮；队列 ≤5 条时不显示按钮（没有可收的内容）。副标题在收起时提示
  「最近 5 条」。
- 预览样例队列补到 8 条（`tools/panel-preview/server.mjs`），让收起/展开有东西可验。

### 验证

- `node --check client.js` + 全套 check/test 通过；PANEL_BUILD=23。
- 面板预览实测（`tools/panel-preview`，127.0.0.1:7701）：默认 5 条 + 按钮 →
  点开 8 条 + 「收起」→ 再点回 5 条，三态与副标题、按钮文案均正确；
  截图确认按钮在标题行不挤。

## 1.14.7 — 2026-11-22

值班会话侧栏显隐开关（面板设置，默认隐藏）。

### 新增

- **面板「设置 → 值班会话 → 值班会话在侧栏可见」**：勾选后值班会话正常出现在
  DSH 侧栏；默认关闭（隐藏）。落盘为 `duty.sessionVisible`（默认 `false`）。
- **`duty_agent.js`**：`sidebarVisible` 参数支持布尔或函数——函数形态每次真正
  创建会话（首次/轮换）时现读面板配置，**开关改完不用重启**，下次轮换的
  新会话就按新值走；读不到配置时兜底隐藏。
- `origin=subagent` 与 `delegationDepth` 成对出现/成对消失（宿主 header
  一致性校验要求）；`parentSession` 仍只在借到 parent 时写。

### 说明

- 开关只影响**之后创建的会话**：resume 不改 header，当前会话与已落盘的
  旧会话（v1/v2/e2）不变——想清理旧框在侧栏手动归档。
- 隐藏机制不变（v1.14.6）：宿主 `sessionVisible()` 按 `origin === 'subagent'`
  过滤，持久化在 SessionHeader。

### 验证

- duty_agent 15 项（+4：③c 布尔/函数不写 origin、getter 抛错兜底隐藏、
  无 parent 自隐藏日志文案）；panel_api 26 项（+1：`duty.sessionVisible`
  开关落盘、deep merge 不覆盖 `duty.rotate`、非布尔拒绝）。

## 1.14.6 — 2026-11-22

值班会话不再出现在 DSH 侧栏。

### 修复

- **侧栏漏出对话框**（桌面版用户可见）：每次值班轮换/重启都会在侧栏多一个会话。
  根因：`origin: 'subagent'`（宿主侧栏唯一的隐藏开关，持久化在 SessionHeader）之前
  只在「借到 parent agent」时才写——DSH NEXT 桌面版平时没有 root 会话可借，于是
  退化成顶层会话进侧栏。现在无论有无 parent 都写 `origin=subagent` + `delegationDepth 1`
  （宿主 types 明确 origin 是「Navigation classification only」，不影响运行时行为）；
  `parentSession` 仍只在真借到 parent 时写。
- 修复前已创建的会话（v1/v2/e2）不受影响——resume 不改 header，想清理可在侧栏
  手动归档（会话已退役，归档安全）。

### 验证

- duty_agent 单测 +1（③b 无 parent 也写 origin=subagent），12 项全绿；全套 Python + JS 通过。
- 宿主侧依据：`dsh-client-ui-workspace/src/client/tree.ts` `sessionVisible()` 按
  `origin === 'subagent'` 过滤（树/平铺/搜索三条路径）；归档不可用作隐藏
  （ArchivedSessionGate 会拒绝归档会话的模型步骤）。

## 1.14.5 — 2026-11-22

记忆迁移闭环（memory-export 工具）+ 值班轮换真机验证（R1/R2）。

### 新增

- **`tools/memory-export.mjs`**（记忆备份/迁移，手动命令）：
  - `--export`：从 `~/.dsh` 导出四层记忆 + DM 记忆 + 日记 + 心情到 staging，
    固定清单、排除锁文件/临时文件，生成 `manifest.json`（sha256 + 条数统计）与 `README.md`（恢复步骤）；
  - `--push`：clone 增量推送到私有仓库（默认 `gitcode.com/uzibuxing/dsh-douyin-whale-memory`，
    保留历史；内容没变不产生空 commit；凭据走 git credential helper，不嵌 token）；
  - `--verify`：clone 回来逐文件比对 sha256/bytes，输出 `{files, bad, counts}`；
  - `.gitattributes * -text` 禁换行转换，字节级保真；拒绝把导出目录放进 `.git` 相关路径；
  - 只推 GitCode 私有仓；**记忆不上 GitHub、不进公开仓库**。
  - `npm run memory:export -- --export|--push|--verify`。
- **`docs/DUTY-ROTATE-VERIFY.md`**：值班轮换真机验证手册（开关流程、观察点、
  已知风险、回滚步骤、验证记录）。
- **配置**：`duty.rotate.contextWindowFallback`（默认 1M）——宿主在首轮模型请求前
  不报 `contextWindow`，兜底算占用率；宿主上报后以宿主为准。

### 修复（真机验证中发现）

- **awaitIdle 排队竞态**：send 进正在 running 的会话只是排队，旧判定立刻读到
  上一轮的空闲（1 秒收轮、回读必失败）→ 改为「消息数基线 + sawRunning」；
  排队场景先等上一轮跑完再计时。
- **dm_reader 空输出诊断**：失败日志带 stderr 尾部（定位到 360 拦 venv python 写 %TEMP%）。
- **whale_tick 测试兼容 360 环境**：子进程 python 改走 PATH（venv python 被 360 拦写 %TEMP%）。

### 真机验证（DSH NEXT 2.0.24-next / dsh 0.2.2-rc.5，2026-11-22）

轮换全链路在真宿主跑通（详见 `docs/DUTY-ROTATE-VERIFY.md` §5）：

- `轮换 douyin-whale-duty-v2 → douyin-whale-duty-e2（usage）`，
  `session-epochs.json` epoch 2 + history，面板状态卡同步；
- 新会话接真实私信：工具调用 → dm_send → 回读「已确认送达（回复 31 字）」，无重发；
- `contextInfo` usage 数据源有效（used/turns/messages），contextWindow 首轮请求后宿主上报。
- 已知现象（挂起，回读机制兜住）：GLM max-effort 在 dm_send 后仍长时间生成，
  回合以 900s 超时收尾；分享面板只列「最近分享过的人」，主人不在面板时分享轮诚实放弃。
- 部署注意：360 拦 venv python 写 %TEMP%（启动器 TEMP/TMP 指到仓库 `data\tmp` 绕行）；
  独立调度器与插件值班写同一份状态，**不能同时开**。

### 验证

- `npm run check` + `npm test` 全绿（新增 memory-export 5 项；MRR 0.929）。
- memory-export dogfood：本机 → 私有仓 push + verify PASS（commit 0f75f92）。
- 回滚后确认 `duty disabled`，机器回到「只开发」姿态；生产在笔记本。

## 1.14.4 — 2026-11-15

值班会话轮换（记忆分层 Phase 2B）：长生命周期会话不再被上下文顶满。

### 新增

- **`lib/session_rotate.js`**：
  - 上下文用量优先读最近 `assistant/message` 的 usage，读不到按可见消息字数估；
  - 触发：窗口占比 ≥0.7、会话年龄 ≥7 天、轮数 ≥200（任一满足）；
  - 交接简报从四层记忆拼：档案 ≤8、里程碑 ≤2、叙事线 ≤3、重要情节 ≤8、
    最近 5 句、当前状态；≤1400 字，私人事实/日记不进；
  - `memory/session-epochs.json` 只记 epoch/sessionId/时间/用量，不记正文。
- **`lib/duty_agent.js`**：新增 `contextInfo()`、`ask()`、`rotate()`。
  轮换时创建 `douyin-whale-duty-e{N}`，交接简报排进 `next-turn`（不额外唤醒），
  旧会话从 registry 摘掉、磁盘日志保留；状态文件让插件重载后继续用当前 epoch。
- **`lib/whale_tick.js`**：投任务前检查轮换。到阈值时**先在旧会话里跑固化/反思**
  （JSON 输出随旧会话丢弃，不污染新会话），再用最新记忆生成简报换会话。
- **面板**：`/status` 返回值班会话 epoch/窗口占用，状态卡显示 `eN · 72%`。
- **配置**：`duty.rotate = { enabled, contextRatio, maxAgeDays, maxTurns }`。

### 说明

- 轮换前的固化/反思是 Phase 2B 的值班路径接入；独立调度器仍按自己的 tick 固化。
- 旧会话不删除，磁盘日志保留；新会话继承 parent/meta，仍不进工作区侧栏。
- 纯离线单测覆盖了伪造宿主的生命周期；**真实 DSH 宿主的值班轮换还需真机验证**
  （当前生产走独立调度器，值班路径未常驻）。

### 验证

- `npm test`：Python 32 + JS 169 全绿；审计项随测试文件增加。
- 面板预览：`v1.14.4·b22` 正常渲染，无 console 错误。
- 单测：session_rotate 4（闸门/简报/状态/编排）、duty_agent 11（含轮换/恢复）、
  panel_api 25（`/status.duty`）。

## 1.14.3 — 2026-11-14

周反思：把最近 7 天的情节归纳成「最近这几周」的叙事线（记忆分层 Phase 3b）。

### 新增

- **`lib/memory_reflect.js`**：
  - 取最近 7 天 episodes（最多 40 条），让模型输出 1–2 条 arcs；
  - `episode_ids` 只能引用素材编号（E1…），对不上/少于 2 条/URL/控制字符/重复全丢；
  - 引用私人日记的 arc 标 `visibility=private`，默认不注入；
  - 同一 period 重跑会替换旧 arc，最多保留 52 条；
  - 闸门：`memory.reflect`（默认开、≥5 条情节、7 天一次、失败重试至少隔 6 小时）。
- **提示词注入**：`buildMemoryContext` 新增【最近这几周】块（最多 2 条，公开条目）；
  面板记忆卡显示叙事线，统计加「叙事 N 条」；`GET /memory/overview` 返回最近 3 条。
- **调度器**：tick 在固化之后跑一次周反思；手动
  `node scheduler/scheduler.mjs --memory-reflect`（先 `--stop`）。
- **配置**：`memory.reflect = { enabled, minEpisodes, minIntervalDays, minIntervalHours }`。

### 说明

- 反思只归纳已有情节，不产生新事实；私人叙事线不会进默认提示词。
- 向量召回仍暂不上：v1.14.2 评测 hit@4 100%，先做叙事层。
- Phase 2B 值班会话轮换仍未做；独立调度器每轮新会话，不受影响。

### 验证

- `npm test`：Python 32 + JS 162 全绿。
- 真机：11-08~11-14 的 6 条情节 → 1 条叙事线、0 丢弃、19 秒；公开 arc
  已进入【最近这几周】，默认上下文 609 字；私人 arc 默认不注入。
- 面板预览：叙事线与私人叙事正确渲染，无 console 错误。

## 1.14.2 — 2026-11-14

记忆召回评测 + 面板记忆浏览器（Phase 3 前半），顺手修了检索排序。

### 新增

- **`tools/memory-eval.mjs`**：内置合成语料 30 题（事实 6 / 事件 20 / 私人 2 /
  负例 2），输出 hit@1、hit@4、MRR、事实命中、负例误召回、私人过滤、注入字数、耗时。
  - `--real`：拿本机 `~/.dsh` 记忆做索引冒烟（只输出聚合，不打印内容）；
  - `--questions`：本机手写问题集（文件不入库）；
  - `--min-hit4`：低于阈值退出 1，已接入 `npm test`。
- **面板「记忆」卡**：四层统计、最后固化时间、搜索框（可含私人）、最近事实/情节、
  置顶/取消置顶、删除、待确认采纳/忽略。
- **API**：`GET /memory/overview`、`GET /memory/search`、`POST /memory/pin`、
  `POST /memory/pending`、`DELETE /memory/item`；写操作和固化共用
  `memory/consolidate.lock`，冲突返回 409。
- **偏好初始化**：配置里的 `preferences.like/dislike` 首次启动写成置顶事实
  （`source=config`，出处是主人配置，不算模型编造），之后幂等跳过。
- **低置信度待确认**：固化时 confidence <0.75 的事实进 `profile.pending`，
  面板采纳后才进档案；固化提示词放宽「明确说过的喜好」。
- **白框取证**：唤醒期间出现新窗口时，额外记录进程 ppid 与
  headless / user-data-dir / cdp 标记（不记命令行原文）。

### 修复与改进

- **检索排序**：`searchIndex` 相关性改为「命中词的 idf 饱和」——长问句里的
  虚词不再把分数摊薄。合成集 hit@1 从 52.2% 提升到 85.7%，hit@4 100%。
- 面板搜索结果只返回摘要/日期，不返回 `evidence` 原话。
- `memory/search` 默认过滤私人条目，勾选「含私人日记」才返回。

### 说明

- 30 题是合成语料，验证的是索引/排序/过滤链路；真实回忆质量用 `--questions`
  把问题留在本机，别把私人内容提交进仓库。
- 评测结论：暂不上向量召回（hit@4 已 100%），下一步优先做周反思 arcs。
- Phase 2B 会话轮换仍未做；独立调度器每轮新会话，不受影响。

### 验证

- `npm test`：Python 32 + JS 153 全绿；`memory-eval` 30 题
  hit@1 18/21、hit@4 21/21、事实 6/6、负例 2/2、私人 2/2。
- 面板预览实测：搜索「键盘」命中；勾选「含私人日记」后搜索「心疼」命中；
  浏览器 console 无错误。
- 白窗日志：11-14 03:47 UTC 那次是 `msedge` 新标签页，PID 已退出；
  新增的进程详情留给下次复现判断归属。

## 1.14.1 — 2026-11-12

记忆固化（记忆分层 Phase 2A）：新私信/日记自动抽成事实和情节。

### 新增

- **`lib/memory_consolidate.js`**：
  - 采集迁移之后的新私信 + 两本日记小节（带来源可见性）；
  - 模型只输出 JSON，抽 `facts` / `episodes` / `profile_updates`；
  - **证据校验**：每条候选必须能在素材里找到原话（归一化子串），
    URL/控制字符/空证据/重复全部丢弃；
  - 事实按相似度合并（≥0.8 视为同一条），情节按摘要+证据去重后追加；
  - 写回后重建索引，更新 `meta.lastConsolidatedAt`。
- **触发**：`memory.consolidate`（默认开、≥10 条新消息或凌晨 3–7 点、
  两次尝试至少隔 6 小时）；手动 `node scheduler/scheduler.mjs --memory-consolidate`
  （会唤醒一次模型，调度器在跑时先 `--stop`）。
- **隐私**：私人日记来源的情节/facts 标 `visibility=private`；
  `[wake:memory]` 的模型输出在日志里隐藏，只记条数。
- 迁移完成时把 `lastConsolidatedAt` 设为迁移时间，固化只吃迁移之后的新素材。

### 说明

- Phase 2A 先覆盖**独立调度器**；DSH 值班会话的固化/轮换在 Phase 2B 做。
- 会话轮换（上下文顶满时生成交接简报、换新值班会话）仍未做。

### 验证

- 新增 `lib/memory_consolidate.test.mjs`（8 项：采集/闸门/JSON 容错/
  证据校验/端到端/去重/坏 JSON/提示词）。
- `npm test`：Python 32 + JS 141 全绿。
- 真机：3 条迁移后素材 → 1 条情节、0 条事实、0 丢弃、20 秒；
  `meta.lastConsolidation` 已落盘，模型输出未进日志。

## 1.14.0 — 2026-11-11

大肥鱼开始有长期记忆：四层存储 + 检索注入（记忆分层 Phase 1）。

### 新增

- **`lib/memory_layers.js`**：四层记忆的文件层——
  `memory/profile.json`（稳定事实）、`episodes.jsonl`（情节 + 原话证据）、
  `arcs.json`（反思，Phase 3 用）、`index.json`（字符二元组倒排）、`meta.json`。
- **迁移**：首次启动把现有 `dm-*.json` 的 80 条私信按天、两本日记按小节
  转成 episodes；facts 并入 profile。幂等，只新增文件，不改原文。
- **检索**：相关性（idf 覆盖率）+ 新近度 + 重要度 + 情绪强度打分，同一 tag
  最多占 2 条；按任务标题/正文检索，1000 字预算内拼成【长期记忆】。
- **注入**：值班大脑和独立调度器两条路径都接 `withMemoryLayers`；
  没有相关记忆就不注入，不拿无关内容凑数。
- **隐私**：私人日记标 `visibility=private`，默认不注入到私信回复；
  需要时显式 `includePrivate`。
- **面板**：状态卡记忆改为「N 情节 · M 事实」；新路由 `GET /memory/layers`。

### 说明

- 会话轮换、模型固化新事实、周反思、面板记忆浏览器在 Phase 2/3，
  见 [`docs/MEMORY-LAYERS.md`](docs/MEMORY-LAYERS.md)。

### 验证

- 新增 `lib/memory_layers.test.mjs`（9 项：分词/迁移/幂等/检索/预算/私人过滤/统计/空记忆）。
- `npm test`：Python 32 + JS 133 全绿。
- 真实数据迁移：83 条情节、3035 个索引词、17ms；查询「视频」召回 2 条 232 字；
  真实任务提示词 1196 字，含【长期记忆】与【相关回忆】。
- 真机调度器重启后加载新代码；私人日记不进入默认召回。

## 1.13.0 — 2026-11-10

大肥鱼有状态了：心情/精力、可编辑人设、桌宠联动。

### 新增

- **心情系统**（`lib/mood.js`，`~/.dsh/whale-mood.json`）：
  - 三条轴 0–100：精力 / 想念 / 无聊；读取时按小时惰性漂移
    （醒着精力掉、想念/无聊涨；作息内反过来恢复）。
  - 事件：回复送达、未确认、投递失败、主动分享、摸摸头；全部原子落盘。
  - 状态标签：睡着 / 困 / 黏人 / 无聊 / 精神 / 平静。
- **人设文本** `persona.text`（面板「人设」卡，≤800 字），
  拼进每轮任务提示词，改完下一轮生效。
- **提示词注入**：两条路径的任务/分享提示词都带「现在的状态」块；
  只让语气和长短体现，不许报数值。
- **主动分享接心情**：睡着或精力 <20 直接跳过；概率按想念/无聊上调
  （0 和 1 仍是显式的「从不 / 总是」端点）。
- **作息**：`mood.sleepWindows` 支持跨午夜；睡觉时精力恢复、不主动分享，
  主人来消息照回，只是语气迷糊。
- **桌宠联动**（`lib/pet_bridge.js`）：回复送达/分享视频冒短气泡，
  到点 `/sleep` `/wake`；走独立通道，不碰与 ZCode hook 共用的
  `/work-status`。气泡默认 15 分钟限流，桌宠离线自动跳过。
- 面板新增「现在」卡（三条轴 + 摸摸头 + 刷新）、「人设」卡、
  「状态与桌宠」设置组；新路由 `POST /mood/poke`。

### 修复

- `lib/whale_state.js` 的 `readState` 补 `lastShareAt` 透传：以前插件侧
  一写状态就会把调度器记的分享时间抹掉，主动分享的最小间隔可能失效。

### 验证

- 新增 `mood.test.mjs`（11 项）与 `pet_bridge.test.mjs`（6 项）；
  提示词/回合/面板/接口测试补心情与人设断言；
  `npm test`：Python 32 + JS 123 全绿。
- 面板预览截图：状态卡、现在卡、人设卡、状态与桌宠组渲染正确；
  摸摸头后想念 48→30、无聊 35→21。
- 真机：调度器重启后首轮确认送达，`whale-mood.json` 写入 68/33/23；
  真实桌宠气泡 HTTP 200。

## 1.12.0 — 2026-11-07

设置面板暴露「刷抖音强度」：主动分享的四个旋钮直接在面板里调。

### 新增

- **运行参数卡分三组**（组标题带蓝色左条）：
  · 互动频率 —— 检查间隔 / 每日上限 / 观看时段 / 自动观看（原有字段归组）
  · 表情包回复 —— 概率 / 每日上限（原有）
  · **主动分享 —— 开关 / 分享概率 / 分享每日上限 / 分享最小间隔**（新增暴露）
- `panel_api` 的 `/config` PATCH 补 `proactiveShare.minIntervalMinutes`
  （钳到 5–1440，默认 120）。

### 说明

- 互动强度 = 互动频率组的三个参数（回复主人多勤快、每天回多少）；
  刷抖音强度 = 主动分享组的四个参数（空闲时刷视频的频率/量/节奏）。
  点赞/评论/关注类互动是既定安全红线，**不做**强度开关。

### 验证

- 预览截图：三组渲染正确；POST /config → GET /status 回环
  （0.15 / 5 条 / 90 分钟全持久化）。
- `panel_api.test.mjs` 补 minIntervalMinutes 钳制断言；
  `npm test`：Python 32 + JS 101 全绿。

## 1.11.2 — 2026-11-07

设置面板 UI 整修（按 ui-design 准则评审后逐项改，截图对比验证）。

### 修复

- **状态色从未生效的选择器 bug**：徽章变体写成 `[data-dy2-badge][data-ok]`
  （要求两个属性），而 JSX 是单属性 `data-dy2-badge="data-ok"` —— 所有状态
  徽章从上线起一直是灰的。改为值匹配 `[data-dy2-badge="data-ok"]` 等。

### 变更

- 状态徽章：加状态圆点 + 同色相浅底深字（ok 绿 / warn 琥珀 / err 红），
  色弱也能靠圆点分辨。
- 内容队列：待回复行加蓝色左条 + 浅蓝底，失败行红左条，已回复行整体弱化
  （opacity .55）——扫一眼先看到待处理的。
- 登录风控提示从灰色徽章长文本改成红底 alert 条（浅底深字）。
- 运行参数表单组间距 12→20px（组间 ≥ 2× 组内 6px），六组字段扫得出块。
- 状态卡统计数值 12px/500 → 14px/600（和 11px 标签拉开层级）。
- 日志卡「值班日志/调度器日志」改 segmented 切换（选中态内嵌高亮），
  未读取时显示空状态提示「点读取加载…」。

### 验证

- 预览服务器截图对比（before/after，1280px 全页 + 420px 窄屏）；
  全量 `npm test`：Python 32 + JS 101 全绿；发版审计 34 项通过。

## 1.11.1 — 2026-11-07

值班会话升级到 v2：新能力配新会话，不被旧对话历史锚住。

### 变更

- 值班会话 id `douyin-whale-duty-v1` → `douyin-whale-duty-v2`。
  v1 的持久化历史里全是旧流程（「日记写不了跳过」、无 frames/emoji）——
  真机回归发现恢复会话 16 秒零工具调用直接 text 收尾（no-send）；
  v2 新会话首轮即完整走 sticker_look → meme_pick → dm_send（31s 真发）
  并回读确认（0.2.2-rc.1 宿主，23 字）。

### 兼容

- v1 会话文件留在宿主 sessions 目录里不删（不碍事）；要回 v1 改回
  `lib/duty_agent.js` 的默认 sessionId 即可。

## 1.11.0 — 2026-11-07

主动分享轮移植到调度器路径：两条路径现在都有「空闲时刷视频」。

### 新增

- **调度器主动分享 `maybeShareShell`**：队列空闲时按
  `proactiveShare.probability`（默认 0.08）唤醒 agent 刷热榜/搜索，
  用 `share --send` 发原生卡片；回读按「我发的卡片 item_id」确认才计数。
- **`lib/whale_round.js` 新增 `shouldProactiveShare`**：五道闸统一成纯函数——
  开关 → 手动跳过 → 概率 → 每日上限 → **最小间隔**
  （`proactiveShare.minIntervalMinutes`，默认 120 分钟）。调度器版每次尝试
  （无论成败）都落 `lastShareAt`，空队列的唤醒烧不穿 token。
- **`lib/whale_prompt.js` 新增 `buildProactiveShareMessage({ mode })`**：
  tools = douyin_hot/search + douyin_dm_share；shell = trending/search + share 命令
  （无文案、不写日记）。`scheduler/prompt.mjs` 出 `buildSharePrompt` 薄封装，
  值班版从 whale_tick 再导出。
- `scheduler/state.mjs` 透传 `lastShareAt`（跨天保留——它只是时间戳）；
  `config.example.json` 补 `meme` / `proactiveShare` 两节。

### 变更

- 值班路径的分享轮行为不变（没有最小间隔闸，按原概率/上限跑）。

### 验证

- `lib/whale_round.test.mjs` 补闸门五道条件 1 项；`lib/whale_prompt.test.mjs`
  补两种模式的分享提示词；`scheduler/state.test.mjs` 补 lastShareAt 透传。
- `npm test`：Python 32 + JS 101 全绿。

## 1.10.0 — 2026-11-07

值班大脑补日记：两本日记（公开反应 / 私人偏好校准）现在两条路径都能写。

### 新增

- **`douyin_diary_read` / `douyin_diary_write` 工具**（18→20）：
  read 返回今天的小节 + 最近几节（每节截断 900 字，保护上下文）；
  write 追加一条 ≤300 字的一句话，永远新开 `## 当天 · HH:MM（值班轮）` 小节，
  与调度器侧「按轮分节」的格式一致。路径固定在 DSH home 的
  `whale-diary.md` / `whale-diary-private.md`，不接受任何外部路径。
- **`lib/diary.js`**：日记读写的共享实现（空/超长/控制字符/未知 kind 全拒），
  两条路径共用同一份文件——值班和调度器交替跑，日记连续。

### 变更

- 值班视频任务消息加入「写两本日记」步骤（1 抽帧 → 2 日记 → 3 私信）；
  值班系统提示同步去掉「日记写不了」的旧说法。
- 调度器（shell）路径行为不变——agent 依旧直接编辑文件。

### 验证

- `lib/diary.test.mjs` 5 项（空读、追加开节、每条一节、双文件隔离、校验全拒）；
  工具级真机（临时 DSH_HOME）：20 个工具注册、写入/读取/校验全通，
  日记正文不进日志（只记 kind/长度元数据）。
- `npm test`：Python 32 + JS 99 全绿。

## 1.9.3 — 2026-11-06

架构合并 D3：两条路径的「一轮 tick」主循环收进共享引擎。

### 变更

- **`lib/whale_round.js`**：`runWatchRound` 引擎——队列合并 → 挑最早 → 下载贴图 →
  建提示词 → 写标记 → 投递 → 等空闲 → 回读 → 推进状态，一条龙共享。
  调度器和值班大脑只剩前置检查 + brain 适配器（shell 唤醒 / 宿主会话）+ 各自的
  失败/空转文案。同文件带 `inWatchWindow`（时钟可注入、空窗口=全天、NaN 防御）、
  `collectIncoming`、`memeAllowedFor`。
- **`lib/dm_reader.js`**：两份 checkDm 合一（stdout 空读 `DOUYIN_IM_OUT_FILE`
  回退文件 + 本轮重试 + `{__error}` 结构化错误）。
- **修复：调度器写状态不再抹掉 `shares`**——`scheduler/state.mjs` 的 readState
  此前不含该字段，两种模式并存时插件累计的分享计数会被清零；现在透传 + 跨天清零。
- 统一三处行为：① fiber 读不到时**两条路径都在投递前 bail**（调度器以前先唤醒
  agent 再跳过回读，白烧一轮 token）；② 调度器「未确认到私信」日志升级为详细
  判据格式（marker/expected/fresh/媒体）；③ 窗口空数组语义统一为「全天开放」。

### 验证

- 新增 `lib/whale_round.test.mjs` 8 项（文字/表情/卡片送达、派活失败不记
  attempts、fiber 不可读不投递、空队列 onEmpty、daily-max、未确认 bumpAttempt）；
  `scheduler/state.test.mjs` 补 shares 透传/跨天清零断言。
- 旧 tick 测试 12 项全数保留并通过（日志锚点未动）。
- 真机：`--dry-tick` / `--watch-now` 走新链路正常；重启后引擎空转路径确认。
- `npm test`：Python 32 + JS 94 全绿。

## 1.9.2 — 2026-11-04

架构合并第一步：两条运行路径共用「回读判定」和「任务提示词」。

### 变更

- **`lib/whale_readback.js`**：把调度器与值班大脑各自重复的回读逻辑收成纯函数——
  `meTextSet` / `meMediaCount` / `meCardIds` / `judgeDelivery` / `deliverySummary`。
  文字（新正文）、原生表情（媒体 +1）、分享卡片（item_id）三种送达形态一次判定，
  fiber 读不到时保守返回。两侧 tick 都改用 `judgeDelivery`。
- **`lib/whale_prompt.js`**：`buildWhaleTaskMessage({ mode: 'tools' | 'shell' })`
  统一任务提示词。`tools` = 值班大脑（插件工具、无文件系统）；`shell` = 独立调度器
  （`node douyin.mjs` + Read + 两本日记）。`scheduler/prompt.mjs` 与
  `whale_tick.js` 的 `buildTaskMessage` 都变成薄封装，以后加回复方式只改一处。
- 唯一文案差异：调度器视频提示里的「frames 失败」统一成「抽帧失败」（与值班一致）。

### 验证

- 新增 `lib/whale_readback.test.mjs`（7 项）+ `lib/whale_prompt.test.mjs`（6 项）。
- 旧/新提示词逐字对比：text/sticker/note 完全一致，video 仅上述一处措辞统一；
  值班 `tools` 模式四种内容全部逐字一致。
- 真机：调度器重启后第一轮 `text:0ac4cfaa...` 用新共享代码投递 → 24 字回复 →
  回读确认送达。
- `npm test`：Python 32 + JS 85 全绿。

## 1.9.1 — 2026-11-03

小修小补：读私信「exit 0 但 stdout 空」的兜底，分享卡片回读配对。

### 修复

- **`read` 偶发空输出（~1/8）**：8 连跑复现 1 次（`status=0`、stdout/stderr
  都空、耗时 31s vs 正常 16s）。带 `DOUYIN_IM_TRACE` 再跑时 Python 明确走到了
  `emit`/`exit0`——JSON 是在 Node/Windows 管道侧丢的，不是脚本没执行。
  修法三层：
  1. `emit` 在打印的同时把同一份 JSON **原子写**到 `DOUYIN_IM_OUT_FILE`；
  2. 调度器 / 值班 tick / `read-dm` 三个读方 stdout 空就改读回退文件；
  3. 两边都空则**本轮原地重试一次**（读操作幂等）。
  另加 `PYTHONUNBUFFERED=1`，排除缓冲层因素。
- **分享卡片回读配对**：卡片没有正文，之前 `douyin.mjs share` 往标记里写
  假正文「视频分享 <id>」，而 tick 按正文核对——永远对不上，可能重复分享。
  现在标记只记 `video: aweme`，调度器和值班 tick 都按「我发的卡片 item_id」
  确认（新增 `meCardIds` 回读分支，成功日志写「分享卡片 <id>，回读确认」）。

### 验证

- 8 连跑复现空输出 1 次；修复后 `read`/`read-dm`/`--dry-tick` 真机全通，
  回退文件内容与 stdout 字节数一致。
- `npm test`：Python 32 + JS 72 项全绿（新增值班 tick 分享卡片回读用例）。

## 1.9.0 — 2026-11-03

抖音原生表情面板直发：`emoji-list` / `emoji-send`，值班和调度器两条路径都能用。

### 新增

- **`emoji-list` / `emoji-send` 子命令**（`python/douyin_im.py`）：点开聊天输入框的
  表情面板，列出账号自带的 21 个原生表情（中文标签 + 1 起编号 + 面板编号截图）。
  面板可视区只放得下两行多，按行高截 3 张，保证每行都有一张是完整的。
- **`douyin.mjs emoji list|send`**：给调度器 / 命令行用；`send` 默认 dry-run
  只截选中表情的预览，真发要 `--send` + `DOUYIN_IM_ALLOW_SEND=1`，
  并和文字/贴图共用「一轮只发一条」标记（标记新增 `emoji` 字段）。
- **DSH 工具 `douyin_emoji_list` / `douyin_emoji_send`**（16→18）：列表把面板截图
  经宿主 attachments 服务作为 image 块带进对话，模型看得到图标再按标签发；
  发送后按回读确认才返回 `sent`。
- **纯表情回复的回读**：表情没有正文，调度器和值班 tick 都新增
  `meMediaCount()`——「我发的媒体条数 +1」才算送达，标记 `emoji: true` 时生效；
  日志会写「原生表情，媒体 N→M 条」。
- 提示词接入：值班系统提示和调度器 `AGENTS.md` 都写明「表情顶替文字，
  一轮只发一条，不要文字和表情各发一条」。

### 关键实测（2026-11-03）

- 面板结构：`.componentsemojiemojiPanel` > `.componentsemojitabPanel` >
  `.emojiEmojiItememojiItem`（img + 中文标签）；21 个表情，5 列、可滚动。
- **点格子就是直接发**（没有「插入输入框」这步）；面板底部 tab 栏会盖住
  第三行，按坐标点会点到 tab——改用 `locator.click()` 自动滚动后正常。
- 回读：发出去的表情是 `aweType 507`、`kind: sticker`，`image_uri` 里带
  `-ts-<hex 中文名>`；媒体条数 2→3 且 token 对得上。
- 真机发出「晚上好」「比心」各一个（发到主人自己的会话）。

### 验证

- `npm test`：Python 32 + JS 71 项全绿（新增表情名解码/选择/媒体计数、
  值班 tick 纯表情回读用例）。
- `douyin.mjs emoji list` / `emoji send`（dry-run）真机通过。

## 1.8.0 — 2026-11-03

值班大脑看懂视频画面：`douyin_frames` 工具（抽帧图批量进模型对话）。

### 新增

- **`douyin_frames` 工具**（15→16）：下载视频 + ffmpeg 抽 4-6 帧，
  帧图经宿主 attachments 服务作为 image 块批量带进对话；返回值附带
  文案/作者供交叉核对。值班模式不再「按文案瞎猜画面」。
- 抽出共用助手 `attachLocalImage`（sticker_look 与 frames 共用）：
  路径白名单（dataDir / 图库根）+ 魔数嗅探（扩展名不可信）+ 空文件拒绝。
- 值班视频任务消息改为「先 `douyin_frames` 看画面 → 就画面回」，
  抽帧失败回 FRAMES_FAILED 不发私信；值班人设同步说明。

### 文档

- README 模型路由改为通用指引：**装在 DSH 里就用宿主已配置的模型；自定义则在宿主
  设置里声明自己的 OpenAI 兼容网关（provider 名、地址、key 均由部署者自选）**，
  不再出现任何本机网关痕迹；`input: [text, image]` 声明要求保留（缺了图会被
  投影层静默丢掉）。
- 值班环境限制段更新到现状（看图/表情/分享都走工具，日记做不了）。

### 验证

- 工具级真机：真实视频 7701273404049551526 → 4 帧 JPEG 入库（46-71KB）
  → render 出 4 image + 1 text。
- 全量 `npm test`：Python 29 + JS 70 项。

## 1.7.1 — 2026-10-31

接入 humanizer 技能（维基百科「Signs of AI writing」的去 AI 腔规则集）到大肥鱼说话系统。

### 变更

- **AI 腔雷区**（取对中文短句私信最致命的结构模式，双语告示进三处说话面）：
  「不是 X，而是 Y」句式、破折号连句、金句收尾总结上一句、三连排比、
  「说实话/讲真/其实吧」开场铺垫、句句等长。
- `lib/persona.js`：`styleHint()` 每轮从雷区池**随机带一条**进任务消息——
  固定写成一大段模型会当耳旁风，轮换点名才起作用。调度器（ZCode 路径）与
  值班大脑共用。
- `lib/duty_agent.js` 系统提示与 `scheduler/agent/AGENTS.md` 各加一个
  【AI 腔雷区】常驻小节（值班 agent 的雷区是全量禁止，调度器 agent 同）。

## 1.7.0 — 2026-10-31

值班大脑会「刷视频」了：队列空闲时低频挑一条主人可能感兴趣的视频，以原生卡片分享。

### 新增

- **主动分享轮**：`proactiveShare` 配置（`enabled`/`probability` 默认 0.08/轮、
  `maxPerDay` 默认 3）——队列空闲时按概率投「刷热榜/搜索 → 挑一条主人偏好内的视频 →
  分享」任务；卡片无文案（caption 会撞 30s 发送闸，后续再说）。手动 tick 不触发。
  每日计数 `shares` 跨天清零，面板 status 的 today 附带。
- **`douyin_dm_share` 工具**（工具数 14→15）：原生分享卡片，python 侧自带发送闸与
  回读（aweType 800 + 同 item_id）；`douyin.mjs share` 接入「一轮一条」标记
  （`markReplySent` 新增 `video` 字段）。
- **`douyin_sticker_look` 工具**：把本地图（dm-images 下载件/图库成员）经宿主
  `attachments` 服务带进值班对话——**值班模型第一次能看到主人发的表情**。
  路径白名单 = dataDir + 图库根；魔数嗅探真实格式（抖音 CDN 下载件扩展名常名不符实）；
  宿主 pi-ai 路由的模型条目必须声明 `input: [text, image]`，否则工具结果里的图
  会被投影层静默丢弃（`~/.dsh/settings.yaml`，注意 0.2.2 启动会导入并改名
  `.imported`）。
- `panel_api` sanitize 放行 `proactiveShare` 节（probability 钳 [0,1]、
  maxPerDay 钳 [0,20]）。

### 真机验证（0.2.2 值班大脑 + 自定义网关）

- 看图链路：sticker_look 74ms 入库 → 模型引用图片内容（修复扩展名谎报后）。
- 主动分享链路：douyin_hot 1.8s + douyin_search 2.2s 浏览 → dm_share 33s 卡片送达
  → 回读确认 aweme 7669768453024937125 → 计数 1。

### 测试

- 新增：whale_tick ⑨（主动分享轮：概率命中→卡片回读→计数；手动不触发）、
  panel_api proactiveShare 钳制。全量 `npm test`：Python 29 + JS 70 项。

## 1.6.1 — 2026-10-31

文字发送确认与图片确认对齐（修「输入框未清」误判）。

### 修复

| 现象 | 原因 |
|---|---|
| 文字消息实际送达（count 0→1、独立回读都有原文），确认却报 `SEND_UNCONFIRMED（输入框未清）` → 烧掉一次尝试，下一轮给主人**重复回复** | `confirm_sent` 的成功门是 `composer_empty AND readback`——「输入框清没清」是 count 时代的老启发式，防不了它想防的卡发送（卡住时输入框恰恰是清掉的）。现在有基线计数时以 **count+1 且最近 4 条气泡无「发送中/发送失败」** 为准（与图片确认同一语义）；composer 只在 fiber 读不到的兜底路径继续作数 |

### 验证

- 真机（0.2.2 值班大脑）：修复上线后首个 sticker 轮 29s 带图送达、回读确认 21 字。
- 全量 `npm test`：Python 29 + JS 68 项。

## 1.6.0 — 2026-10-31

值班大脑真机闭环：宿主内模型路由 + 发送/挑图工具 + 三个真 bug 修复。

### 新增

- **值班工具两枚**（工具数 11→13）：
  `douyin_dm_send`——带三道闸的私信发送（dry-run 默认、宿主 env `DOUYIN_IM_ALLOW_SEND`
  总闸、30s 发送闸+冷却、image 只认图库白名单），图+caption 与 `douyin.mjs send` 同链路；
  `douyin_meme_pick`——本地图库挑表情（直读 SQLite，无浏览器、无配额）。
- **值班模型路由**：值班会话可用 `duty.provider`/`duty.model` 指定模型路由
  （`lib/duty_agent.js` 的 `modelSelection`），配合宿主 `dsh-llm-pi-ai` 的自定义网关声明
  （OpenAI 兼容端点，key 走启动环境 `apiKeyEnv`，不进配置文件）；留空跟随宿主默认。
  没有官方 DeepSeek key 也能跑值班大脑。
- **任务消息工具化**：值班 agent 在宿主里拿不到 shell/Read（后台会话不给审批类工具），
  `buildTaskMessage` 从「`node douyin.mjs …` shell 指令」改为工具调用指令；
  视频按 `douyin_video` 文案回复（值班环境抽不了帧、写不了日记——明说跳过，不装看过画面）。
- 值班人设同步：发私信走 `douyin_dm_send`、表情包走 `douyin_meme_pick`。

### 修复

| 现象 | 原因 |
|---|---|
| 值班发的私信 CLI 回报成功、tick 回读永远 no-send | `childEnv()` 的 `USERPROFILE/HOME` 隔离把 CLI 的 `os.homedir()` 拐到 `data/home`，`reply_marker` 的标记读写跟着偏到 `data/home/.dsh`——CLI 读不到 tick 写的 begin 标记、写回的 sent:true tick 也看不见。childEnv 现在显式传 `DSH_HOME`（whale 状态目录），CLI 与 tick 对齐 |
| 图片发送回报 ok、对方却收不到（卡「发送中」） | 发送确认只查**最后一条**气泡——caption 是独立消息排在图后面，图上的「发送中」根本没被看到。改为查最近 4 条我方气泡（`RECENT_BUBBLES_SENDING_JS`，含「发送失败」） |
| 队列空转时值班日志一片安静，看起来像死了 | `!pending.length` 原本只在手动 tick 打日志；现在每轮一行（覆盖「主人重发同一张收藏表情被 image_id 去重」的场景） |
| 回读失败无法定位是没发还是没读到 | 失败日志补判据摘要：marker 状态（sent/字数/null）、expected 正文、fresh 条数与样例 |

### 运维记录（2026-10-31）

- **DSH 0.2.2「第三方 client 面板 404」定论为误诊**：`/plugins` 路由对无 rev 的猜测 URL
  按设计 404（rev 只随 boot graph 下发）。真 UI 实测：boot graph 有本插件行、
  设置弹窗出现「大肥鱼刷抖音」页签、面板完整渲染、API 全通。详见
  `docs/UPSTREAM-NOTES.md`。
- **值班大脑 0.2.2 真机全链路闭环**：读主人 sticker → `douyin_meme_pick` →
  `douyin_dm_send`（带图+caption，`send:true`）→ 回读确认（回复 19 字）→ 标记已回复。
  模型路由 = 自定义网关（settings.yaml `llm-pi-ai.providers` 声明 +
  启动环境 `apiKeyEnv` 引用的变量）。
- 已知限制（值班环境）：宿主 tool 结果暂不能携带图片 → 值班模型看不到主人发的图
  （按附言/上下文挑情绪）；抽帧、写日记做不了（无文件工具）。独立调度器（ZCode 版）
  仍是全功能路径。

### 测试

- 全量 `npm test`：Python 29 项 + JS 68 项。

## 1.5.1 — 2026-10-30

面板表情包配置 + GitHub 发布补齐。

### 新增

- 设置页面板新增「表情包概率（%）」「表情每日上限」两个配置项（对应 `meme.probability` /
  `meme.maxPerDay`，后端钳制已有、这次补 UI）；状态卡「今天」附带当天表情数。
- `summary()` 输出 `meme` 配置节与 `today.memes` 计数。

### 运维记录

- **GitHub 发布补齐**：main 同步至 `503d615`，补 tag `v1.4.2`/`v1.5.0` 与对应 Release
  （gh CLI，走 clash 7897 代理）。
- **DSH 宿主**：0.2.2-alpha.2 从 npx 缓存直启验证——插件 API 路由全通，但第三方插件
  client 面板 404（`dsh-client-runtime` 已被 0.2.2 移除，换新 inject 清单仍 404，
  疑似要走插件管理器安装路径）；主力宿主暂留 0.1.5-rc.1，0.2.2 用
  `~/.dsh/start-dsh.cmd 022` 备用。详见 `docs/UPSTREAM-NOTES.md`。

## 1.5.0 — 2026-10-29

表情包收发 + 白框结案。

### 新增

- **发表情包**：`douyin.mjs send --image <路径>`（caption 必填）。链路：聊天页隐藏上传
  input（`semi-upload-hidden-input`）→「发送给 ××」模态框（caption 是 `semi-input-textarea`，
  发送按钮「发送 (N)」）→ 点发送。**必须等预览图从本地 blob 换成 douyinpic CDN 地址再点发送**，
  否则消息永远卡「发送中」、对方收不到（2026-10-29 实测）。
- **图库**：`lib/meme.js`（只读 dsh-meme 的 SQLite 索引）+ `douyin.mjs meme pick/list/search`。
  图库自动发现 `~/.dsh/meme-packs/*`，`DOUYIN_MEME_ROOTS` 可加根目录；与
  `douyin_im.py meme_roots()` 同一份白名单。
- **收表情包**：私信解析新增 `kind=sticker`（aweType 501 收藏表情 / 2702 聊天图片，
  带 `image_uri/image_url/image_id`），按 `image_id` 入队；回复前自动把图下载到
  `data/media/dm-images/`（`douyin.mjs dm-image`），模型先 Read 看图再用
  `meme pick` 挑同情绪的图回敬。
- **拟人化节奏**：每轮按 `meme.probability`（默认 0.3）允许带图，`meme.maxPerDay`
  （默认 6）防刷屏；面板配置页可调（`sanitizeConfigPatch` 放行 meme 节）。
- 回读确认新增媒体维度：`count_my_media`（图片消息没有 text/itemId，
  `count_my_matching` 数不到）；带图回复按 caption 文本核对。
- `tools/whitebox-probe.mjs`（`npm run probe:whitebox`）：白框取证探针。
- `tools/probe_composer.py`：聊天输入区 DOM 探针（近只读，只点面板开关）。

### 修复

| 现象 | 原因 |
|---|---|
| 图片发出后对方看不到、本地永远「发送中」 | 点发送太早：上传还没完成。现在等预览换 CDN 地址再点；回读时「发送中」未消失不算送达 |
| 回读假阳性（主人自己新发的消息被当成回复送达的证据） | 旧逻辑在「无标记」时退回「任意新正文」判据；现在没有标记正文一律不算送达 |
| 白框（结案） | `ZCODE_HOME` 不是 CLI 读取的变量，之前「隔离 home」从未生效；桌面窗口关闭状态下用与调度器完全同参的唤醒实测 **无新窗口**——白框来源是旧版 `--surface desktop` 行为与凭据过期登录弹窗，分别被 `--surface terminal` 和 `--no-browser` 修掉 |

### 测试

- 新增：`scheduler/meme.test.mjs`（图库 4 项）、`tests/test_meme_gate.py`
  （白名单/扩展名/大小/fail-closed/媒体计数 6 项，抓到并修掉「无图库目录时白名单被跳过」）。
- 扩展：state 10 项（sticker 入队、sticker 提示词、memeAllowed）、send_gate 4 项（--image 透传）。
- 全量 `npm test`：Python 29 项 + JS 67 项。

### 已知限制

- caption 与图是两条消息（抖音行为）；一轮一条标记按「一次发送动作」计。
- caption 短暂丢失（发送中断）会导致回读失败重试，不会重复发图。
- DSH 0.2.2-alpha.2 已实测可启动；插件加载验证因本机 symlink 权限（`plugin add` 拒绝访问）
  未完成，等升级主力宿主时一并验证。

## 1.4.2 — 2026-10-28

修主人反馈的四类问题：白框、回复顺序/错配、纯文字消息不回、回复太机械。

### 修复

| 现象 | 原因 |
|---|---|
| 回复顺序乱、偶尔回了对不上号的内容 | **跨天重置把 `repliedIds` 和 `queue` 一起清空**，第二天私信页上还留着的旧卡片被当成新内容再回一遍；现在跨天只清当天计数（watches/loginFails/冷却），队列和已回复 id 保留 |
| 回了「没有视频卡片、只有文字」的内容 | 图文（`kind=note`）被直接标记已处理、一条消息都不发，主人看着像「视频没发出来」；现在图文按文字内容回复，并计入队列状态 |
| 主人主动发的文字消息永远不回 | 队列只收带 `item_id` 的卡片，纯文字（`kind=text`）进不了队列；现在文字也入队，不抽帧、不写日记，只接话；一次最多收最近 5 条，避免第一次接入把历史聊天全回一遍 |
| 回复和内容对不上 | `send` 只是发一条裸文本，和 item_id 没有绑定；新增「一轮只发一条」标记：唤醒前写标记，`douyin.mjs send` 发过一条就拒绝第二条并把正文记进标记，调度器回读时按这条正文核对 |
| 抽帧失败仍硬编一段回复 | 提示词要求 `frames` 失败只回 `FRAMES_FAILED`、不发私信；每条内容最多试 3 次，超了标记 `failed`，不再堵住队头 |
| `watch.dailyMax` 从没生效 | 配置里有、代码里没人读；现在每日上限真的会拦住发送 |
| 白框（部分修复） | `ZCODE_HOME` 不是 ZCode CLI 读取的变量（CLI 用 `ZCODE_DATA_BASE_DIR`，实测也被忽略），之前那版「隔离 home」从未生效；现在唤醒加 `--no-browser`、子进程强制 `DOUYIN_HEADLESS=1`，并在唤醒前后快照可见窗口——再冒出窗口时日志会记下进程名和标题 |

### 新增

- `scheduler/state.mjs`：状态/队列纯函数（跨天规则、文字入队、重试计数）。
- `scheduler/prompt.mjs`：视频 / 图文 / 文字三种任务提示词。
- `lib/persona.js`：称呼、自称、语气、emoji、开头随机池 + 反重复记忆块。
- `lib/reply_marker.js`：一轮只发一条的标记（调度器、值班插件、`douyin.mjs` 共用）。
- 测试：`scheduler/state.test.mjs`（8 项）、`scheduler/send_gate.test.mjs`（3 项）。
- `DOUYIN_IM_SCRIPT` 环境变量：测试或自定义部署可替换私信脚本路径。

### 拟人化

- 每条随机换自称（我 / 咱 / 本鱼 / 本小姐）、语气、开头、emoji 数量。
- 提示词注入「最近说过的 5 句」，明确禁止重复开头和句式。
- 人设与值班 `systemPrompt` 同步重写，不再每条都以「主人」开头。

### 验证

- `npm test` 全绿：Python 23 项 + JS 60 项（memory 8 / state 8 / send-gate 3 /
  panel 9 / panel_api 15 / duty_agent 8 / whale_tick 9）。
- 真账号连跑两轮 `--watch-now`：视频回复 48 字、文字消息回复 17 字，回读均确认送达；
  两条开头都不是「主人」，日志只记字数不记正文。
- 发版审计：除「工作区未提交」外全部通过。

### 已知限制

- 白框在当前环境（ZCode 桌面正在运行）无法复现；若仍出现，`[wake] ⚠️ 唤醒期间新窗口`
  日志会记录新窗口的 PID/进程名/标题，下次据此定位。
- 纯文字消息的队列 id 是 `from + 正文` 的哈希：主人连发两条一模一样的文字只会回一条。

## 1.4.1 — 2026-10-27

真宿主联调修复：v1.4.0 在 DSH 里实际不可用——设置页看不到插件、面板路由注册失败、
值班开关关不掉、发布包缺文件。这一版把插件装进 `~/.dsh/profiles/web` 逐项验过。

### 修复

| 现象 | 原因 |
|---|---|
| 设置里没有「大肥鱼」入口 | `dsh.client` 缺 `exports["./client"]`，模块系统不下发浏览器半端 |
| 面板路由注册失败：`cannot get property "webServer" without inject` | Cordis 4 读未 inject 的服务会抛错；改用 `ctx.inject(['webServer'])` 等能力就绪 |
| `whaleEnabled: false` 不生效 | `resolveConfig` 没把 `whaleEnabled` 放进 resolved，定时器照起 |
| 装好发布包后 `node douyin.mjs` 报 `ERR_MODULE_NOT_FOUND` | `files` 只写 `lib/*.js`，漏了 `lib/douyin_http_client.mjs` |
| 面板「出二维码」返回 500（`path` 参数 undefined） | `startLogin` 算了 `statusFile_/logFile_` 却用了未定义的 `statusFile/logFile` |
| 扫码进程被杀/超时后面板一直显示「等待扫码」 | 状态文件停在 `phase: qr`；`readLoginStatus` 没按进程存活收敛状态，还把过期二维码继续下发 |
| 面板版本号停在 v1.3.3 | 版本字符串硬编码，没跟 package.json 走 |

### 新增

- `lib/services.js`：可选 Cordis 服务的统一读取（`ctx.reflect.get` 旁路 + 逐级降级），
  面板和值班大脑都变成「有就接上、没有就降级」，工具始终可用。
- 发版审计新增三项机械检查：`exports["./client"]` 与 `dsh.client` 成对、
  面板版本号与 package.json 一致、发布包内每个 js/mjs 的相对 import 都能解析。
- `startLogin` 的默认状态/日志路径跟随 `root`，补了「不注入也不炸」的回归测试。
- 删掉一次性脚本 `tools/make-release.mjs`（硬编码 1.4.0，误跑会把版本改回去）。

### 发布版打磨

- 面板名字改成 **「大肥鱼刷抖音」**（设置导航里的 label），package 描述同步。
- 二维码直接内嵌在面板里（`GET /login/qr.png`，只认扫码进程活着 + 路径在
  `dataDir` 下 + `.png`），不用再去文件管理器找图。
- 运行日志可切换「值班日志 / 调度器日志」，默认看插件自己的值班日志。
- `dataDir` 真正透传给值班 tick 的 Python 子进程（之前配置了也读插件根下的 data）。
- **数据目录按安装方式分流**：开发 checkout 用 `<repo>/data`；打包安装用
  `~/.dsh/douyin-whale`，登录态/队列/日志不再写进 `node_modules`，升级不丢。
- 登录失效后 **30 分钟冷却**，不再每 10 分钟起一次浏览器；手动 tick 可跳过。
- 登录页遇到滑块/拼图时，无头流程 **20 秒内快速失败**并给出有头验证命令，
  不再干等 10 分钟、也不把风控页当二维码展示。
- 二维码截图裁到二维码区域（找不到正方形元素才退回整页），手机更好扫。
- **值班会话自检**：面板加「测试值班会话」按钮 + `POST /duty/selftest`，只拉会话
  （`agents.get/resume/create`）不投任务；真宿主验证通过（新建 `douyin-whale-duty-v1`）。
- 状态卡显示值班大脑开关；启用时禁用独立调度器按钮（两者共用状态文件，不能同时跑）。
- 没装 ZCode 时禁用「启动本地调度器」并说明 DSH 模式不需要它。
- `npm run check` 覆盖全部运行时 JS（补上 `duty_agent`/`whale_tick`/`services`）。

### 验证

- 真 DSH 0.1.5-rc 宿主（`dsh --profile web`）：插件注册 11 个工具、面板路由 200、
  设置页「大肥鱼刷抖音」完整渲染（状态/队列/配置/登录/日志），保存设置与读取日志均可用。
- 扫码链路：`POST /login/qr` → `starting` → `qr`，产出有效 PNG（167 KB），
  随后手动终止进程；未登录状态下的 tick 只读私信即安全失败，不发消息。
- `npm test` 71 项断言全过（22 Python + 49 JS）。

### 已知限制

- 宿主**没有任何根会话**时，值班会话（`douyin-whale-duty-v1`）会暂时出现在侧栏；
  宿主里有任意根会话后，它会作为子会话隐藏。这是 DSH 借 parent 的限制。
- 无头扫码遇到**滑块/拼图**时会在 20 秒内失败并提示改用有头窗口；
  验证码必须人工完成，项目不会绕过。持久化 profile 里的会话如果还有效，
  有头窗口会直接进入已登录状态。

## 1.4.0 — 2026-10-27

发布版第一刀：**DSH 插件模式闭环**（面板 + 值班大脑 + 登录引导），本地独立调度器（ZCode 版）保留。

### 新增

- **设置页面板**（`client.js`，宿主注入的 React，无构建步骤）：运行状态、内容队列
  （旧→新，带已回复/待回复标记）、配置（主人昵称/间隔/上限/时段）、启停调度器、
  登录引导、日志 tail。整页包 error boundary，任何一块抛错只塌这一页。
- **值班大脑**（`lib/duty_agent.js` + `lib/whale_tick.js`）：DSH 宿主的常驻
  agent 会话替代 zcode.cjs 外挂——get(live) → resume → create 三步链、
  per-agent 人设、subagent 化不进侧栏；tick 保留回读确认才标记已回复、
  队列持久化、观看时段、图文跳过。宿主没有 agents 能力时整块降级为日志。
- **登录引导**：面板一键出二维码（无头截图给人扫），状态文件轮询；
  出现滑块/短信验证时面板明示「只能人工完成」。
- **原生分享卡片**（`douyin.mjs share`）：走抖音自己的「分享给朋友」，
  鼠标轨迹 hover 展开面板，发完回读确认。
- **本地发送闸**：两次真实发送最少隔 30 秒；失败冷却 2 分钟、风控冷却 10 分钟；
  冷却期内连浏览器都不开。面板可见，`gate --clear` 可手动解除。
- **每人一份本地记忆**（`scheduler/memory.mjs`）：合并去重、80 条上限，
  回复时只带最近 10 行 + 长期事实。
- **内容队列持久化**：私信页只渲染十来条，老卡片会被挤出 DOM；按 item_id
  记队列，处理不再依赖卡片还在页面上。
- **面板离线验证**：`npm run preview` 伪造宿主三件套本地跑面板，
  `tools/panel-preview/` 全套。

### 修复

| 现象 | 原因 |
|---|---|
| 发完一条私信就掉登录 | 每次从 storage_state 新建 context 被当成「新设备登录」；改持久化 profile |
| agent 跑完却没回私信，也被记成已回复 | 回读确认改成「我发的、内容匹配的消息 +1」，零宽字符删除而非替换 |
| 老视频被永久跳过 | 私信页只渲染十来条，新消息把老卡片挤出 DOM；队列按 id 持久化 |
| 检查间隔配置不生效 | 调度器写死 60 秒 tick；改成按 `watch.intervalMinutes` 自调度 |
| Windows 上锁不生效 | fcntl 不存在；改 O_EXCL 锁文件 + PID + 过期清理 |
| 一分钟连发多条 | `intervalMinutes` 只用于显示；改为真正按配置间隔 |
| `--watch-now` 必崩 | 调用了不存在的 `checkDmForVideos()` |
| 面板/调度器抢浏览器 | Windows 无 fcntl，锁是空跑；补 O_EXCL 跨平台锁 |
| readConfig 丢自定义键 | 合并只走默认键；补「默认外键保留」 |

### 已知限制

- **图文**（aweType=0 带 itemId）：抽帧只支持视频，图文自动跳过并记日志。
- **自动恢复登录**：抖音在服务端作废会话时必须人工扫码；出现滑块/短信验证
  只能人工完成——插件不会也不会尝试绕过验证码。
- **网页端发群消息**（继承自上游）：服务端收下但群里其他人可能收不到（回执 7523）。

### 升级

```bash
git -C <你的插件目录> pull
# 依赖没变过就不用重装；新增 JS 测试在 lib/*.test.mjs，npm test 一键跑
```

## 2026-10-25 的四个待修 bug，已在 1.4.0 全部解决
主人发了 3 条视频 → 23 次 API / 27k token → 只回了 1 条不相关的话。问题：

1. **`read-dm` 读不到视频卡片里的 aweme_id**：主人发的是视频卡片（缩略图），
   `cmd_read` 用 `innerText` 读不到卡片嵌入的链接。需要 Playwright 提取卡片 DOM 的 href/data 属性。
2. **`seen.json` 误杀主人推荐**：早期关键词搜索写了 9 个 ID 到 seen。
   主人发的视频如果同 ID → 被跳过。主人推荐应优先于 seen。
3. **agent 回复不相关**：没有真正看到主人发的视频帧，自行选了别的凑。
4. **`confirm_sent` 仍可能假阳性**：报 `SEND_UNCONFIRMED` 但消息已送达。

## 1.3.3 — 2026-10-24

- 修复：`douyin.mjs` `spawnSync` 加 `windowsHide: true`，不再弹出空白 CMD 窗口。
- 修复：调度器 `waking` 标志卡死检测（15 分钟超时强制重置）。
- 修复：全局 `uncaughtException` / `unhandledRejection` 处理，防止调度器静默崩溃。
- 修复：`tick()` 每次触发时写日志，方便排查停更。

## 1.3.2 — 2026-10-24

- HTTP API 私信默认 headless（无窗口弹出）：`DOUYIN_HEADLESS=1`。
- README / docs 同步更新。

## 1.3.1 — 2026-10-24

- `douyin.mjs` 新增 `watch` 命令：按关键词选一条没看过的视频并抽帧；
  已看记录写入 `data/whale/douyin/seen.json`，供大肥鱼不重复观看。

## 1.3.0 — 2026-10-24

- 新增 Node 适配层 `douyin.mjs` 和 `lib/douyin_http_client.mjs`：
  - 给 agent / 调度器一条稳定的 JSON 命令；
  - 支持 `health`、`start`、`status`、`trending`、`search`、`detail`、
    `download`、`frames`、`profile`；
  - 默认自动拉起本地 HTTP API，可用 `--no-start` 关闭。
- README 新增「Node 适配层」用法；`npm run douyin` 直接调用。

## 1.2.0 — 2026-10-24

- 项目与插件更名为 `dsh-douyin-whale`：包名、插件 id（`douyin-whale`）、
  cordis 配置、部署路径和文档同步更新。
- 项目定位为大肥鱼的抖音工具层；README 改为产品化说明。
- MIT 许可和第三方版权声明继续保留在 `LICENSE` 中。

## 1.1.1 — 2026-10-24

本地安全修改：

- 删除 `python/douyin_bridge.py` 中的 `STEALTH_JS` 注入及其
  `context.add_init_script(...)` 调用。浏览器不再改写 `navigator.webdriver`、
  `window.chrome`、`navigator.plugins` 等特征；登录/评论遇到验证码时继续人工处理。
- 更新 `docs/SECURITY.md`，去掉“只加最小的 navigator.webdriver 清理”的表述，
  明确不注入、不伪造指纹。
- 新增 `tests/test_safety.py`：静态检查 Python 源码中不得出现 stealth 注入。
- 保留 `dy-cli==0.2.2` 版本锁定；限频/退避只用于降低请求频率，不作为反检测能力。

## 1.1.0 — 2026-10-23

本地版本的第一个版本。

新增：

- **私信 / 群聊驱动** `python/douyin_im.py`：Playwright 驱动抖音网页版，
  默认 dry-run，三道闸（`--send` + `DOUYIN_IM_ALLOW_SEND=1` + 可选
  `DOUYIN_IM_ALLOW_TO` 白名单），文件锁串行，发送后气泡确认，超时进程组回收。
- **HTTP API** `python/douyin_http.py`：FastAPI，默认 `127.0.0.1:7709`，
  暴露 `/health` `/trending` `/search` `/detail` `/profile` `/status`
  `/download` `/frames` `/im/*`。
- **视频下载与抽帧**：带 cookie 请求移动端分享页，从 `_ROUTER_DATA` 解析无水印
  直链，绕过需要 `a_bogus` 签名的官方详情接口；yt-dlp generic 提取失败时退回
  `urllib` 流式下载；ffmpeg 均匀抽 4–12 帧供视觉模型使用。
- **登录态导出工具** `tools/export_login_state.py`：在本地有显示器的电脑上扫码
  登录并导出 `storage_state`，解决服务器 headless 无法扫码的问题。
- **DOM 探测工具** `tools/probe_im.py`：前端改版后采集选择器。
- **离线测试** `tests/test_fixture.py` + `tests/fixture_chat.html`：在仿真 DOM 上
  验证 dry-run、发送路径、群名后缀匹配、NOT_FOUND，不联网、不发真实消息。
- **文档**：`docs/COOKIE-GUIDE.md`、`docs/HTTP-API.md`、`docs/SECURITY.md`、
  `docs/LINUX-ADAPTER.md`。
- `scripts/run-http.{sh,ps1}`、`scripts/selfcheck.{sh,ps1}`、
  `deploy/douyin-api.service`。

修改：

- **Linux / headless 适配**：浏览器发现扩展到 Chromium / Chrome / Playwright
  自带内核（版本号目录用 glob 扫描），无 `DISPLAY` 时自动降级 headless，
  进程清理增加 POSIX 分支（`pkill -f <profile>` / `pgrep` + 启动参数精确匹配）。
- **路径参数化**：所有服务器绝对路径改为环境变量或相对路径
  （`DOUYIN_DATA_DIR`、`DOUYIN_PYTHON`、`DOUYIN_BROWSER`、`DOUYIN_MEDIA_DIR`、
  `DOUYIN_COOKIE_FILE` 等）。
- **包名**：1.2.0 起统一为 `dsh-douyin-whale`，插件 id 为 `douyin-whale`。
- 私信驱动与插件共用同一个 `data/` 目录，不再分开维护测试档。

保持不变：

- dy-cli 只读通道、11 个 DSH 工具、错误码、限频与配额、凭证脱敏、
  登录状态机、账号指纹、`douyin_publish` 占位接口。

## 1.0.0 — 2026-10-20

初始版本。

- 11 个 DSH 工具：hot、search、video、user、status、login start/status/submit、
  manual verify、guarded comment、publish interface。
- 只读路径走 dy-cli 逆向 API，接口拒绝时回退到 Edge 页面 XHR。
- `search_id` 链式分页。
- 可轮询的扫码/短信登录状态机，专用 Edge profile。
- 账号指纹（作品标题 + 发布时间 + 作品 ID 的 SHA-256）。
- 单 worker、3–8 秒页间抖动、小时配额、指数退避、`verify_check` 检测。
- 返回值与日志凭证脱敏；写操作默认关闭。
