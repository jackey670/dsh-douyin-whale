# Changelog

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
  插件 `data/` 下 + `.png`），不用再去文件管理器找图。
- 运行日志可切换「值班日志 / 调度器日志」，默认看插件自己的值班日志。
- `dataDir` 真正透传给值班 tick 的 Python 子进程（之前配置了也读插件根下的 data）。
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
- `npm test` 70 项断言全过（22 Python + 48 JS）。

### 已知限制

- 宿主**没有任何根会话**时，值班会话（`douyin-whale-duty-v1`）会暂时出现在侧栏；
  宿主里有任意根会话后，它会作为子会话隐藏。这是 DSH 借 parent 的限制。
- 账号当前处于**滑块/拼图风控**：无头扫码会在 20 秒内失败并提示改用有头窗口；
  验证码必须人工完成，项目不会绕过。

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
