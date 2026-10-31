# Changelog

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
  （如本机 wb2api，key 走启动环境 `apiKeyEnv`，不进配置文件）；留空跟随宿主默认。
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
  `docs/UPSTREAM-NOTES.md` 与 `RELEASE-1.5.1.md` 的更正。
- **值班大脑 0.2.2 真机全链路闭环**：读主人 sticker → `douyin_meme_pick` →
  `douyin_dm_send`（带图+caption，`send:true`）→ 回读确认（回复 19 字）→ 标记已回复。
  模型路由 = 本机 wb2api（settings.yaml `llm-pi-ai.providers` 声明 +
  启动环境 `WB2API_API_KEY`）。
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
