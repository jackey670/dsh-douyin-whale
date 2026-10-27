# v1.4.1

> 真宿主联调修复版。v1.4.0 的代码在离线测试里全绿，但装进真正的 DSH 宿主后
> 设置页看不到插件、面板路由注册失败、值班开关关不掉、发布包还缺一个运行时文件。
> 这一版把插件实际装进 `~/.dsh/profiles/web`，逐项验过再发。

## 这版修了什么

| 现象 | 原因 |
|---|---|
| DSH 设置里没有「大肥鱼」入口 | `package.json` 声明了 `dsh.client`，却缺 `exports["./client"]`；模块系统找不到浏览器半端，直接不下发 |
| 面板路由注册失败：`cannot get property "webServer" without inject` | Cordis 4 的 `ctx` 代理对未写进 `inject` 的服务会抛错；改成 `ctx.inject(['webServer'], …)` 等能力就绪，宿主没有就永远不回调（工具照常） |
| 配置里 `whaleEnabled: false` 关不掉值班定时器 | `resolveConfig` 没把 `whaleEnabled` 放进 resolved 对象，`index.js` 读到的永远是 `undefined` |
| 从发布包安装后 `node douyin.mjs` 报 `ERR_MODULE_NOT_FOUND` | `files` 白名单只写了 `lib/*.js`，漏了 `lib/douyin_http_client.mjs` |
| 面板「出二维码」返回 500：`The "path" argument must be of type string` | `startLogin` 算了 `statusFile_`/`logFile_`，后面却用了未定义的 `statusFile`/`logFile` |
| 扫码进程被杀/超时后，面板一直显示「等待扫码」 | 状态文件停在 `phase: qr`；`readLoginStatus` 没按进程存活收敛状态，还把过期二维码继续下发 |
| 面板右上角一直显示 v1.3.3 | 版本字符串硬编码，没跟 `package.json` 走 |

## 这一版的发布级打磨（不需要登录就能验）

- 面板名字改为 **「大肥鱼刷抖音」**，设置导航和 package 描述同步。
- 登录二维码直接内嵌在面板里（`GET /login/qr.png`，只认进程活着 + 路径在
  `data/` 下 + `.png`），不用再去文件管理器找图。
- 运行日志默认看插件自己的值班日志，可切到 ZCode 调度器日志。
- `dataDir` 真正传给值班 tick 的 Python 子进程（之前配置了也读插件根下的 data）。
- **数据目录按安装方式分流**：开发 checkout 用 `<repo>/data`；打包安装用
  `~/.dsh/douyin-whale`，登录态/队列/日志不再写进 `node_modules`，升级不丢。
- 登录失效后 **30 分钟冷却**，不再每 10 分钟白起一次浏览器；手动 tick 可跳过。
- 登录页遇到滑块/拼图时，无头流程 **20 秒内快速失败**并给出有头验证命令，
  不再干等 10 分钟、也不把风控页当二维码展示。
- 二维码截图裁到二维码区域（找不到正方形元素才退回整页），手机更好扫。
- **值班会话自检**：面板「测试值班会话」+ `POST /duty/selftest`，只拉会话
  （`agents.get/resume/create`）不投任务；真宿主验证通过。
- 状态卡显示值班大脑开关；启用时禁用「启动本地调度器」（两者共用状态文件，不能同时跑）。
- 没装 ZCode 时禁用「启动本地调度器」，并说明 DSH 模式不需要它。
- `npm run check` 覆盖全部运行时 JS（补上 `duty_agent`/`whale_tick`/`services`）。

## 新增的机械防线

`tools/release-audit.mjs` 现在会拦这三类问题：

1. `dsh.client` 必须配 `exports["./client"]`，且指向真实存在的文件；
2. 面板版本号必须等于 `package.json` 的版本；
3. 发布包里每个 `.js`/`.mjs` 的相对 `import` 都必须在包内解析得到
   （`npm pack --dry-run --json` 的真实文件清单，不是猜）。

## 真宿主验证记录

- 宿主：`@deepseek-ai/dsh` 0.1.5-rc，`dsh --profile web --port 38080`；
- 插件注册 11 个工具，日志 `plugin registered`；
- 面板路由 `GET /api/douyin-whale/{status,queue,config,gate,memory,login/status}` 全部 200；
- 设置页「大肥鱼刷抖音」完整渲染：运行状态、主人、队列 7 条（待回复 4）、发送闸、记忆、
  配置表单（昵称/间隔/上限/时段）、内容队列、登录卡、运行日志；
- 「保存设置」写入成功（`配置已保存（下个 tick 生效）`），「看最近日志」能读出真实日志；
- 「出二维码」→ `POST /login/qr` 返回 pid → `starting` → `qr`，
  生成 167 KB 有效 PNG；测试后手动终止扫码进程；
- 不带覆盖层启动时 `timer_started`，15 秒后 tick 因未登录安全失败（只读私信，不发消息）；
- `POST /duty/selftest` → 200，新建 `douyin-whale-duty-v1`（provider=deepseek-official），
  日志记录了 `agents.get/resume/create` 的完整路径；该宿主没有根会话，所以值班会话
  暂时出现在侧栏（有任意根会话后会作为子会话隐藏）。
- 有头登录 `tools/export_login_state.py` 能正常弹出浏览器窗口；本次运行在已有
  有效会话时直接导出 84 条 cookie（只读状态 `logged_in: true`）。

## 安装 / 升级

```bash
# 本地开发（link 安装，改代码即生效）
dsh plugin --profile web add link:<插件目录>

# 从发布包
dsh plugin --profile web add dsh-douyin-whale@1.4.1
```

升级后重启宿主（或在设置里重载插件）。如果之前装过 1.4.0，
`npm pack` 出来的包缺 `lib/douyin_http_client.mjs`，必须重装。

## 已知限制

- **登录页遇到滑块/拼图**：无头扫码会在 20 秒内失败并提示改用有头窗口；
  验证码必须人工完成，项目不会绕过。持久化 profile 里的会话如果还有效，
  有头窗口会直接进入已登录状态。
- **图文帖**（`aweType=0` 带 `itemId`）不做抽帧，自动跳过并记日志。
- **值班会话的侧栏行为**：宿主没有任何根会话时，`douyin-whale-duty-v1` 会暂时
  出现在侧栏；有任意根会话后会作为子会话隐藏。这是 DSH 借 parent 的限制。
- **二维码裁剪**只在能找到可见正方形 `img/canvas` 时生效；页面改版找不到时
  退回整页截图（仍可人工放大扫）。
