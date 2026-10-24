# 安全说明

这个项目会操作一个真实的抖音账号。请把它当成"会以你的身份说话的程序"来对待。

## 凭证边界

- 插件**从不**在工具返回值、日志或报错里返回 cookie、`sessionid`、
  `passport_*`、`localStorage`、`storage_state`。
- `lib/backend.js` 的 `redact()` 在落盘和返回前做正则脱敏。
- 下列路径含**明文凭证**，已被 `.gitignore` 排除，**不要**提交、分享或打包：
  - `<dataDir>/home/.dy/cookies/default.json`（storage_state）
  - `<dataDir>/browser-profile/`（浏览器 profile，含登录态）
  - `<dataDir>/im-profile/`（私信驱动的 profile）
  - `<dataDir>/state/account.json`（账号指纹，含 `sec_uid` 尾号）
- 建议 `chmod 600` cookie 文件，并让 `dataDir` 只对运行用户可读。

## 写操作的三道闸

真正把消息/评论发出去，需要同时满足：

| 闸 | 位置 | 默认 |
|---|---|---|
| 1. 请求显式要求 | `send: true` / `--send` / `dry_run: false` + `confirm: true` | 关 |
| 2. 服务端总闸 | `DOUYIN_IM_ALLOW_SEND=1`（私信）/ `writesEnabled: true`（评论） | 关 |
| 3. 目标白名单（可选） | `DOUYIN_IM_ALLOW_TO=昵称1,昵称2` | 未启用 |

任何一道不满足：

- 私信前两道不满足 → 文本填进输入框、截图、清空，不发送；
- 私信第三道不满足 → 直接 `TARGET_NOT_ALLOWED`，连输入框都不填；
- 评论未满足 → 返回 `writes_disabled`，不发请求。

`douyin_publish` 只是一个占位接口，永远返回 `implemented:false`，不发任何请求。

### 账号指纹

`data/state/account.json` 记录首个登录账号的指纹（作品标题+发布时间+作品 ID 的
SHA-256，或 `sec_uid` 的哈希）。发现当前账号与记录不一致时，写操作返回
`account_mismatch` 并拒绝执行 —— 防止"扫错号把消息发出去"。

换号是显式操作：删掉 `data/state/account.json` 后重新登录。

## 验证码

本项目**不**解决、绕过或外包验证码：

- 检测到滑块/安全验证立即停止，返回 `challenge_required` / `RISK_CONTROL`；
- 需要人工在可见窗口完成，再重试；
- 不接打码平台，不注入伪造指纹，也不改写 `navigator.webdriver`、`window.chrome`、
  `navigator.plugins` 等浏览器特征；Playwright 使用真实系统浏览器和独立 profile。

## 限频

- 全局单 worker，所有 dy / 浏览器调用串行；
- 翻页之间 3–8 秒抖动，独立调用之间 1.8–3.2 秒；
- 滚动 1 小时请求预算，默认 60；
- 触发限流后指数退避（1/2/4/8/15 分钟），不立即重试；
- 私信驱动另有文件锁，同一时刻只允许一个浏览器实例。

这些参数用于**降低请求频率、避免无意义重试**，不改变浏览器或账号特征，也不保证不被风控。

## 网络暴露

- HTTP 服务默认只监听 `127.0.0.1:7709`。
- 不要把它绑到 `0.0.0.0` 或挂到公网：接口没有鉴权，任何人都能用你的账号发私信。
- 需要远程访问时，用 SSH 隧道或只走本机的 agent。

## 报告问题

发现安全问题请开 GitHub issue，**不要**在 issue 里贴 cookie、token、`sec_uid`
或任何账号标识。
