# Linux 适配说明

本项目在初始版本的基础上，补了
在无图形界面的 Linux 服务器上运行所需的改动。这份文档说明**改了什么、为什么改、
还有什么做不到**。

## 1. 浏览器发现

初始版本只认 Windows 的 Edge 安装路径。现在按优先级查找：

| 优先级 | 来源 |
|---|---|
| 1 | `config.edgePath`（`cordis.patch.yml`） |
| 2 | `DOUYIN_BROWSER` 环境变量 |
| 3 | `DOUYIN_EDGE_PATH` 环境变量（兼容初始版本） |
| 4 | 项目内 `bin/chromium` |
| 5 | 系统包：`/usr/bin/chromium`、`/usr/bin/chromium-browser`、`/usr/bin/google-chrome`、`/snap/bin/chromium` |
| 6 | Playwright 自带 Chromium（`~/.cache/ms-playwright/chromium-<rev>/...`，版本号目录用 glob 扫描） |
| 7 | Windows 上的 Edge（保持兼容） |

涉及文件：`lib/backend.js`（`resolveBrowser()`）、`python/douyin_bridge.py`
（`edge_path()`）、`python/douyin_im.py`（`discover_browser()`）。

> 初始版本文档要求手动 `ln -sfn` 一个 `bin/chromium` 符号链接，并在 Playwright
> 升级后重建。现在**不再需要**：`bin/chromium` 仍然优先，但找不到时会自动
> 扫描 Playwright 的缓存目录。

## 2. headless 降级

初始版本假设有真实窗口（扫码需要人看）。现在的行为：

- `python/douyin_bridge.py` 的 `resolve_headless()`：
  - `DOUYIN_HEADLESS=1/0` 显式指定时优先；
  - 有 `DISPLAY` / `WAYLAND_DISPLAY` → 按调用方请求（有头）；
  - 没有 → 强制 headless，避免
    `Looks like you launched a headed browser without having a XServer running`。
- `python/douyin_im.py` 的私信驱动：默认 headless（它只需要填框 + 截图），
  `DOUYIN_HEADLESS=0` 可开窗口调试。

## 3. 进程清理

初始版本用 PowerShell + `Get-CimInstance` 找并杀掉占用 profile 的 Edge。现在：

- POSIX 分支用 `pkill -f <profile 目录>`，只杀命令行里带**本项目 profile 路径**
  的进程，不会误伤别的浏览器；
- `python/douyin_im.py` 的 `kill_stale_browsers()` 用
  `pgrep -af playwright_chromiumdev_profile` 再按本驱动独有的启动参数
  （`--no-sandbox` + `AutomationControlled`）精确匹配，避免杀掉 dy-cli 同时
  在跑的浏览器；
- Windows 保持原逻辑。

## 4. 私信 / 群聊驱动

`python/douyin_im.py` 是新增模块：

- Playwright 驱动 `https://www.douyin.com/chat`；
- DOM 选择器带多级兜底（`data-e2e` → class 前缀 → 文案），前端改版后可用
  `tools/probe_im.py` 重新采集；
- 默认 dry-run；真实发送需要 `--send` + `DOUYIN_IM_ALLOW_SEND=1`，可选
  `DOUYIN_IM_ALLOW_TO` 白名单；
- 文件锁保证串行，避免小内存机器同时开两个 Chromium；
- 发送后必须确认到自己的消息气泡（`confirm_sent`），确认不到就报
  `SEND_UNCONFIRMED` 并要求人工核实，**不自动重试**。

## 5. 视频下载（绕过失效的 Douyin 提取器）

`python/douyin_http.py` 的 `/download` 与 `/frames` 不走 yt-dlp 的 Douyin
提取器 —— 那个提取器会请求需要 `a_bogus` 签名的
`/aweme/v1/web/aweme/detail/`，在机房 IP 上通常只返回空。替代路线：

1. 带 cookie 请求移动端分享页 `https://www.iesdouyin.com/share/video/<id>/`；
2. 从内嵌的 `_ROUTER_DATA` 解析 `video.play_addr.url_list[0]`；
3. `playwm` → `play` 得到无水印地址；
4. 交给 yt-dlp 的 generic 提取器（带 Referer + 移动端 UA），失败再退
   `urllib` 流式下载。

直链有时效，所以每次重新解析，只缓存成片。

## 6. 路径全部参数化

初始代码里写死的 `<repo>/.venv`、`<repo>/data` 等相对路径保留，但服务器上原本
散落的绝对路径已全部改成环境变量（`DOUYIN_DATA_DIR`、`DOUYIN_PYTHON`、
`DOUYIN_BROWSER`、`DOUYIN_MEDIA_DIR`、`DOUYIN_COOKIE_FILE` 等），见
[`.env.example`](../.env.example)。

## 已知限制

- **服务器上无法完成扫码/短信/滑块**。`login_start` 能起浏览器，但没有可见窗口，
  二维码只能落盘成截图；真正登录请用
  [`tools/export_login_state.py`](../tools/export_login_state.py) 在本地导出
  `storage_state`，见 [`COOKIE-GUIDE.md`](COOKIE-GUIDE.md)。
- `douyin_hot` / `douyin_search` 走 dy-cli 的 HTTP 通道，**不需要浏览器**，
  服务器开箱可用。
- `douyin_video` / `douyin_user` / 私信需要浏览器；未登录或触发风控时会返回
  `not_authenticated` / `challenge_required`。
- 机房 IP 的风控比家庭宽带严，限频参数（`hourlyRequestBudget` 等）建议保守。
- 小内存机器（≤2G）跑 Chromium 很紧张，私信驱动强制串行就是为了这个。
