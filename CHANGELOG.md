# Changelog

## 1.1.1 — 2026-10-24

本地安全修改（fork 自 `JianHeShui/dsh-douyin`）：

- 删除 `python/douyin_bridge.py` 中的 `STEALTH_JS` 注入及其
  `context.add_init_script(...)` 调用。浏览器不再改写 `navigator.webdriver`、
  `window.chrome`、`navigator.plugins` 等特征；登录/评论遇到验证码时继续人工处理。
- 更新 `docs/SECURITY.md`，去掉“只加最小的 navigator.webdriver 清理”的表述，
  明确不注入、不伪造指纹。
- 新增 `tests/test_safety.py`：静态检查 Python 源码中不得出现 stealth 注入。
- 保留 `dy-cli==0.2.2` 版本锁定；限频/退避只用于降低请求频率，不作为反检测能力。

## 1.1.0 — 2026-10-23

Fork 后的第一个版本，基于上游 `dsh-douyin-toolkit` 1.0.0。

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
- **包名**：`dsh-douyin-toolkit` → `dsh-douyin`（插件 id 仍为 `douyin`）。
- 私信驱动与插件共用同一个 `data/` 目录，不再分开维护测试档。

保持不变：

- dy-cli 只读通道、11 个 DSH 工具、错误码、限频与配额、凭证脱敏、
  登录状态机、账号指纹、`douyin_publish` 占位接口。

## 1.0.0 — 2026-10-20

上游初始版本（`SakuraMat0u/dsh-douyin-toolkit`）。

- 11 个 DSH 工具：hot、search、video、user、status、login start/status/submit、
  manual verify、guarded comment、publish interface。
- 只读路径走 dy-cli 逆向 API，接口拒绝时回退到 Edge 页面 XHR。
- `search_id` 链式分页。
- 可轮询的扫码/短信登录状态机，专用 Edge profile。
- 账号指纹（作品标题 + 发布时间 + 作品 ID 的 SHA-256）。
- 单 worker、3–8 秒页间抖动、小时配额、指数退避、`verify_check` 检测。
- 返回值与日志凭证脱敏；写操作默认关闭。
