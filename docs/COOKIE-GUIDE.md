# 登录与 Cookie 指南

抖音的搜索、视频详情、私信、群聊都需要登录态。本项目**不实现登录协议**，也不
保存账号密码：它只使用 Playwright 的 `storage_state`（一份 cookie + localStorage
的快照），把它放在 `dy-cli` 期望的位置。

## 为什么不能"在服务器上扫码"

服务器通常没有图形界面：

- 没有 X server / Wayland，headed 浏览器起不来（报 `Looks like you launched a
  headed browser without having a XServer running`）；
- 即使能起窗口，也没人能看到那个二维码；
- 短信验证码、滑块验证都需要人工操作。

所以正确流程是：**在自己的电脑上登录 → 导出 storage_state → 把文件送到服务器**。

## 方案 A：用仓库自带脚本（推荐）

`tools/export_login_state.py` 会打开一个真实浏览器窗口，你扫码登录，成功后它
自动把 `storage_state` 写出来。

```bash
# 1) 本地（有显示器的电脑）准备好环境
python -m venv .venv
# Linux / macOS
.venv/bin/pip install -r python/requirements.txt
.venv/bin/playwright install chromium
# Windows
.venv\Scripts\pip install -r python\requirements.txt
.venv\Scripts\playwright install chromium

# 2) 扫码登录并导出（默认写到 data/home/.dy/cookies/default.json）
# Linux / macOS
.venv/bin/python tools/export_login_state.py
# Windows
.venv\Scripts\python tools\export_login_state.py
```

脚本输出类似：

```text
登录成功：localStorage
已写入：/path/to/dsh-douyin-whale/data/home/.dy/cookies/default.json
cookie 条数：23，localStorage origin：2
```

常用参数：

| 参数 | 说明 |
|---|---|
| `--out <path>` | 输出位置，默认 `data/home/.dy/cookies/default.json` |
| `--browser <exe>` | 指定浏览器，默认自动发现 |
| `--profile <dir>` | 从已有的 persistent profile 打开并导出 |
| `--timeout <秒>` | 等待登录的上限，默认 300 |

## 方案 B：把 cookie 放到服务器

`storage_state` 是 JSON，路径由 `DOUYIN_DATA_DIR` / `DOUYIN_COOKIE_FILE` 决定。
默认是：

```text
<DOUYIN_DATA_DIR>/home/.dy/cookies/default.json
```

送到服务器并收紧权限：

```bash
# 在本地执行
scp data/home/.dy/cookies/default.json user@your-server:/tmp/douyin-cookie.json

# 在服务器执行
mkdir -p ~/dsh-douyin-whale/data/home/.dy/cookies
mv /tmp/douyin-cookie.json ~/dsh-douyin-whale/data/home/.dy/cookies/default.json
chmod 600 ~/dsh-douyin-whale/data/home/.dy/cookies/default.json
```

如果数据目录不在默认位置，用环境变量指过去：

```bash
export DOUYIN_DATA_DIR=/srv/douyin-data
mkdir -p "$DOUYIN_DATA_DIR/home/.dy/cookies"
cp /tmp/douyin-cookie.json "$DOUYIN_DATA_DIR/home/.dy/cookies/default.json"
```

或者干脆指定文件本身：

```bash
export DOUYIN_COOKIE_FILE=/srv/douyin-data/cookies.json
```

## 方案 C：验证是否登录成功

```bash
# HTTP 服务方式
curl -s -X POST http://127.0.0.1:7709/im/status | jq .

# 命令行方式
python python/douyin_im.py status

# dy-cli 自身状态
python -m dy_cli.main status
```

`/im/status` 会返回 `logged_in`、`search_box`、`composer_present` 等字段；如果
返回 `NEED_LOGIN`，说明 cookie 缺失或已失效。

## Cookie 会过期

抖音的 `sessionid` 通常几天到几周失效，表现为：

- `not_authenticated`
- 视频详情返回空
- `/im/status` 报 `NEED_LOGIN`

处理方式：重新跑一次 `export_login_state.py`，覆盖同一个文件。**不要**自动重试
或写脚本刷登录 —— 那更容易触发风控。

## 安全

- `storage_state` 等同于账号凭证。**不要**提交进 git、贴进 issue、发到聊天窗口。
- 本仓库的 `.gitignore` 已排除 `data/`、`*.cookie`、`*cookies*.json`、`.env`。
- 文件权限建议 `chmod 600`。
- 插件返回值和日志都做了脱敏（`lib/backend.js` 的 `redact()`），但这不代表
  cookie 文件本身是安全的 —— 它仍然是明文 JSON。

## 常见问题

**Q：能在服务器上用 `--headless` 扫二维码吗？**

不能。二维码需要人看、需要手机扫。`bridge` 在无 X server 时会降级为 headless，
此时登录状态机会停在 `qrcode` 或直接失败，这是预期行为。请用方案 A。

**Q：我本地是 Windows，服务器是 Linux，cookie 通用吗？**

通用。`storage_state` 是标准 JSON，与操作系统无关。

**Q：可以多开几个账号吗？**

本项目不支持多账号矩阵：`data/state/account.json` 会记录首个账号的指纹，
换号后写操作会返回 `account_mismatch`。删掉该文件并重新登录才切换账号。
