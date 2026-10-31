#!/usr/bin/env python3
"""douyin_im.py — 抖音网页版私信 / 群聊的 Playwright 驱动（dry-run 默认开启）。

设计原则
--------
1. **默认不发**：所有发送命令默认 dry-run，只走到"文本已进入输入框"并截图，
   然后清空输入框；真实发送必须同时给 ``--send`` 和 ``DOUYIN_IM_ALLOW_SEND=1``。
   如果还设了 ``DOUYIN_IM_ALLOW_TO``（逗号分隔），目标必须落在白名单里 —— 这是
   可选的第三道闸。
2. **不伪造身份**：不注入 navigator.webdriver 伪造、不改指纹；只用真实 Chromium。
3. **串行**：文件锁保证同一时刻只有一个浏览器实例，避免并发触发风控。
4. **JSON 信封**：每个子命令在 stdout 打印一个 JSON，``{ok: true, data}`` 或
   ``{ok: false, error: {code, message}}``，便于 HTTP 层 / 上层程序解析。

子命令
------
  status                       检查登录态、风控页、私信页搜索框是否就绪
  conversations [--limit N]    列出左栏会话（含疑似群聊标记）
  groups [--limit N]           只列疑似群聊
  send --to <昵称> --text <文>  [--send] [--screenshot]
  group-send --group <群名> --text <文> [--send]

依赖
----
  playwright（``pip install -r python/requirements.txt``）
  Chromium：优先读 ``DOUYIN_BROWSER``，否则自动发现
  （项目内 ``bin/chromium`` → Playwright 自带 Chromium → 系统 chromium/chrome →
  Windows 上的 Edge）。

选择器来源
----------
本文件的 DOM 选择器基于 cong120/douyin-auto-fire（MIT）中经过线上验证的
选择器，并叠加了本环境的兜底项。抖音前端改版后按 ``status`` 的诊断输出调整。
"""
from __future__ import annotations

from contextlib import asynccontextmanager
import argparse
import asyncio
import glob
import json
import os
import re
import socket
import subprocess
import sys
import time
import urllib.request
from datetime import datetime

# --------------------------------------------------------------------------
# 路径与环境（全部可用环境变量覆盖，见 .env.example）
# --------------------------------------------------------------------------
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

DATA = os.path.abspath(os.path.expanduser(
    os.environ.get("DOUYIN_DATA_DIR") or os.path.join(ROOT, "data")))
PROFILE_DIR = os.path.join(DATA, "im-profile")
SHOT_DIR = os.path.join(DATA, "im-shots")
LOCK_FILE = os.path.join(DATA, "im.lock")

CHAT_URL = "https://www.douyin.com/chat"


def discover_browser() -> str:
    """找一个可用的 Chromium/Chrome 可执行文件，找不到返回空串。

    顺序：DOUYIN_BROWSER → 项目内 bin/chromium → 系统包 → Playwright 下载的
    Chromium → Windows 的 Edge。Playwright 缓存目录带版本号，所以用 glob。
    """
    explicit = (os.environ.get("DOUYIN_BROWSER") or "").strip()
    if explicit:
        return explicit

    candidates = [
        os.path.join(ROOT, "bin", "chromium"),
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/snap/bin/chromium",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ]
    # Playwright 自带的 Chromium：~/.cache/ms-playwright/chromium-<rev>/chrome-linux64/chrome
    for pattern in (
        "~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome",
        "~/.cache/ms-playwright/chromium-*/chrome-linux/chrome",
        "~/Library/Caches/ms-playwright/chromium-*/chrome-mac/Chromium.app/Contents/MacOS/Chromium",
        "~/.cache/ms-playwright/chromium-*/chrome-win/chrome.exe",
    ):
        hits = sorted(glob.glob(os.path.expanduser(pattern)))
        if hits:
            candidates.append(hits[-1])

    for path in candidates:
        if path and os.path.isfile(path):
            return path
    return ""


CHROME = discover_browser()


def resolve_headless() -> bool:
    """私信驱动默认 headless。

    它只需要把消息填进输入框并截图，不需要人盯着的窗口；服务器上没有 X
    server 时更是只能 headless。``DOUYIN_HEADLESS=0`` 可以强制打开可见窗口
    调试（需要 DISPLAY）。
    """
    override = (os.environ.get("DOUYIN_HEADLESS") or "").strip().lower()
    if override in {"1", "true", "yes", "on"}:
        return True
    if override in {"0", "false", "no", "off"}:
        return False
    return True

COOKIE_CANDIDATES = [
    os.environ.get("DOUYIN_COOKIE_FILE") or "",
    os.path.join(DATA, "home", ".dy", "cookies", "default.json"),
    os.path.expanduser("~/.dy/cookies/default.json"),
]

# 不再覆盖 user_agent：给 Windows 上的 Chrome 套 Linux UA 会让登录态和
# 运行态指纹对不上，抖音会判定为「新设备」并把会话踢掉。用浏览器真实 UA。

# --------------------------------------------------------------------------
# DOM 选择器（按优先级排列，全部为"尽量用 class 前缀 + data-e2e"的写法）
# --------------------------------------------------------------------------
# 只认登录面板自己的文案。不能放 "text=登录后"：正常页面到处是
# 「登录后查看更多」，会把已登录状态误判成 NEED_LOGIN。
LOGIN_MARKERS = ("text=扫码登录", "text=验证码登录", "text=密码登录")
RISK_MARKERS = ("text=安全验证", "text=完成验证", "text=验证身份", "text=滑块")

SEARCH_INPUTS = (
    'input[placeholder*="搜索"]',
    '[role="textbox"][placeholder*="搜索"]',
    'input[aria-label*="搜索"]',
)

RESULT_ROWS = (
    '[class*="SearchPanelitembox"]',
    '[class*="SearchPanelitem-box"]',
    '[class*="SearchPanelitem_box"]',
    '[class*="SearchPanelitem"]',
)
NAME_NODES = (
    '[class*="SearchPanelitemtitle"]',
    '[class*="SearchPanelitemTitle"]',
    '[class*="SearchPanelitemname"]',
    '[class*="SearchPanelitemName"]',
)
CHAT_BTNS = (
    '[class*="SearchPanelitemchat_btn"]',
    '[class*="SearchPanelitemchatBtn"]',
    '[class*="SearchPanelitemchat_"]',
)

CONV_ROWS = (
    '[data-e2e="conversation-item"]',
    '[class*="conversationConversationItem"]',
    '[class*="conversation-item"]',
    '[class*="ConversationItem"]',
)
CONV_TITLES = (
    '[class*="conversationConversationItemtitle"]',
    '[class*="ConversationItemtitle"]',
    '[class*="ConversationItemTitle"]',
)

HEADER_TITLES = (
    '[class*="RightPanelHeadertitle"]',
    '[class*="RightPanelHeaderTitle"]',
    '[class*="chatHeadertitle"]',
    '[class*="ChatHeaderTitle"]',
)

MESSAGE_INPUTS = (
    '[data-contents="true"]',
    '.DraftEditor-editor [contenteditable="true"]',
    '.DraftEditor-root [contenteditable="true"]',
    '[contenteditable="true"][data-placeholder*="发送消息"]',
    '[contenteditable="true"][aria-label*="消息"]',
    '.messageEditorinputArea',
    '[contenteditable="true"]',
    'textarea[placeholder*="消息"]',
)

SEND_BUTTONS = (
    '[class*="messageMsgInputpublishBtn"]',
    '.e2e-send-msg-bt',
    'button[aria-label*="发送"]',
    '[role="button"][aria-label*="发送"]',
)

# 会话列表中"自己发出的消息"气泡（用于发送确认）
OUTGOING = (
    '.messageMessageListlist [data-index="0"] '
    '.messageMessageBoxmessageBox:has(.messageMessageBoxcontentBox.messageMessageBoxisFromMe)'
)
OUTGOING_FALLBACK = '[class*="messageBoxisFromMe"]'
FAILURE_MARKERS = (
    "text=发送失败",
    '[aria-label*="重试"]',
    '[class*="ContentSideSendStatusretry"]',
    '[class*="SendStatusretry"]',
)
GROUP_NAME_RE = r"{name}\s*[\(（]\s*\d+\s*[\)）]"
# 群聊标题的成员数后缀：「群名 (12)」——只认行尾，避免误伤「(2024)」这类昵称
GROUP_SUFFIX_RE = r"\s*[\(（]\s*\d+\s*[\)）]\s*$"
# 会话行标题可能带的尾巴：「56分钟前」「昨天 12:30」「10-23 18:05」
TS_TAIL_RE = (
    r"(?:\s*(?:\d+\s*秒前|\d+\s*分钟前|\d+\s*小时前|\d+\s*天前|刚刚|昨天|前天"
    r"|\d{1,2}[-/]\d{1,2}(?:\s+\d{1,2}:\d{2})?|\d{1,2}:\d{2}))\s*$"
)


# --------------------------------------------------------------------------
# 小工具
# --------------------------------------------------------------------------
def now_tag() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def emit(ok: bool, data=None, code: str = "", message: str = "") -> None:
    if ok:
        print(json.dumps({"ok": True, "data": data}, ensure_ascii=False))
    else:
        print(json.dumps(
            {"ok": False, "error": {"code": code, "message": message}},
            ensure_ascii=False,
        ))
    sys.stdout.flush()


class IMError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def find_cookie_file() -> str | None:
    for path in COOKIE_CANDIDATES:
        if path and os.path.isfile(path) and os.path.getsize(path) > 2:
            return path
    return None


def profile_has_data() -> bool:
    """持久化 profile 目录里有没有东西（有就说明登录过，未必还有效）。"""
    try:
        return os.path.isdir(PROFILE_DIR) and bool(os.listdir(PROFILE_DIR))
    except Exception:
        return False


# --------------------------------------------------------------------------
# 发送闸：同一通道最小间隔 + 风控冷却
# --------------------------------------------------------------------------
GATE_FILE = os.path.join(DATA, "im-send-gate.json")
SEND_MIN_INTERVAL = float(os.environ.get("DOUYIN_SEND_MIN_INTERVAL", "30"))
RISK_COOLDOWN = float(os.environ.get("DOUYIN_RISK_COOLDOWN", "600"))
FAIL_COOLDOWN = float(os.environ.get("DOUYIN_FAIL_COOLDOWN", "120"))


def _gate_read() -> dict:
    try:
        with open(GATE_FILE, encoding="utf-8") as fh:
            return json.load(fh) or {}
    except Exception:
        return {}


def _gate_write(patch: dict) -> None:
    cur = _gate_read()
    cur.update(patch)
    cur["updated_at"] = time.time()
    try:
        os.makedirs(DATA, exist_ok=True)
        with open(GATE_FILE, "w", encoding="utf-8") as fh:
            json.dump(cur, fh, ensure_ascii=False)
    except Exception:
        pass


def check_send_gate(kind: str = "text") -> None:
    """发送前检查：冷却中 / 间隔太短都直接拒绝，不要去打抖音。

    为什么要有：抖音对连续发送很敏感，实测连发会 403，然后会话被作废。
    宁可本地挡住，也不要在服务端试错。
    """
    g = _gate_read()
    now = time.time()
    blocked_until = float(g.get("blocked_until") or 0)
    if blocked_until > now:
        raise IMError(
            "SEND_COOLDOWN",
            f"风控冷却中，还要等 {int(blocked_until - now)} 秒"
            f"（原因：{g.get('blocked_reason') or '未知'}）")
    last = float(g.get(f"last_{kind}_at") or g.get("last_send_at") or 0)
    if last and (now - last) < SEND_MIN_INTERVAL:
        wait = int(SEND_MIN_INTERVAL - (now - last)) + 1
        raise IMError("SEND_TOO_SOON", f"距上次发送不足 {int(SEND_MIN_INTERVAL)} 秒，还要等 {wait} 秒")


def record_send(kind: str = "text") -> None:
    now = time.time()
    _gate_write({"last_send_at": now, f"last_{kind}_at": now})


def record_risk(reason: str, seconds: float | None = None) -> None:
    secs = RISK_COOLDOWN if seconds is None else seconds
    _gate_write({"blocked_until": time.time() + secs,
                 "blocked_reason": reason[:120]})


def _note_gate_failure(exc) -> None:
    """命令失败时按错误类型落闸。"""
    code = getattr(exc, "code", "") or ""
    if code == "RISK_CONTROL":
        record_risk("抖音弹安全验证")
    elif code in ("SEND_FAILED", "SEND_UNCONFIRMED"):
        record_risk(f"发送失败 {code}", FAIL_COOLDOWN)


class _LockHandle:
    """锁句柄：close() 时删掉锁文件。"""

    def __init__(self, fh=None, file_lock=False):
        self._fh = fh
        self._file_lock = file_lock

    def close(self):
        if self._file_lock:
            try:
                os.remove(LOCK_FILE)
            except Exception:
                pass
        if self._fh:
            try:
                self._fh.close()
            except Exception:
                pass


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False
    except SystemError:
        # Windows: os.kill(missing_pid, 0) 抛的是 SystemError（"returned a result
        # with an exception set"），不是 OSError。若当成“活着”，僵死锁永远清不掉，
        # 读私信会卡满 180 秒再报 BUSY。
        return False
    except Exception:
        return True


def acquire_lock(timeout_s: float = 180.0):
    """串行化：同一时刻只允许一个浏览器实例。

    Windows 上没有 fcntl —— 旧实现的锁在 Windows 上是**空跑**，调度器和手动
    命令可以同时开同一个持久化 profile，后启动的那个会直接失败。这里补一个
    跨平台的实现：POSIX 用 flock，其它平台用 O_EXCL 建文件 + PID + 过期清理。
    """
    os.makedirs(DATA, exist_ok=True)
    try:
        import fcntl  # noqa: F401
        fh = open(LOCK_FILE, "w")
        try:
            fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            fh.close()
            raise IMError("BUSY", "已有另一个抖音私信任务在运行，请稍后再试")
        return _LockHandle(fh, file_lock=False)
    except ImportError:
        pass

    deadline = time.monotonic() + timeout_s
    while True:
        try:
            fd = os.open(LOCK_FILE, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, str(os.getpid()).encode("ascii"))
            os.close(fd)
            return _LockHandle(file_lock=True)
        except FileExistsError:
            # 上次异常退出可能留下僵死锁：PID 不在了就清掉重来
            stale_pid = 0
            try:
                with open(LOCK_FILE, encoding="ascii", errors="ignore") as fh:
                    stale_pid = int((fh.read() or "0").strip() or 0)
            except Exception:
                stale_pid = 0
            stale = False
            if stale_pid:
                stale = not _pid_alive(stale_pid)
            else:
                # 老版本（POSIX flock 实现）留下的空锁文件没有 PID；
                # 超过 60 秒还没人更新，就当僵死锁清掉。
                try:
                    stale = (time.time() - os.path.getmtime(LOCK_FILE)) > 60
                except Exception:
                    stale = True
            if stale:
                try:
                    os.remove(LOCK_FILE)
                except Exception:
                    pass
                continue
            if time.monotonic() > deadline:
                raise IMError(
                    "BUSY",
                    f"已有另一个抖音私信任务在运行（锁文件 {LOCK_FILE}，PID {stale_pid or '未知'}）")
            time.sleep(0.5)


async def first_visible(page, selectors, timeout_ms: int = 12_000):
    per = max(400, timeout_ms // max(1, len(selectors)))
    for sel in selectors:
        loc = page.locator(sel).first
        try:
            await loc.wait_for(state="visible", timeout=per)
            return loc, sel
        except Exception:
            continue
    return None, None


async def any_visible(page, selectors, timeout_ms: int = 1_500) -> bool:
    loc, _ = await first_visible(page, selectors, timeout_ms)
    return loc is not None


def norm(text: str) -> str:
    return re.sub(r"[\s\u200b\u200c\u200d\ufeff]+", " ", text or "").strip()


def is_group_name(actual: str, expected: str) -> bool:
    actual, expected = norm(actual), norm(expected)
    if actual == expected:
        return True
    return re.fullmatch(GROUP_NAME_RE.format(name=re.escape(expected)), actual) is not None


def split_conv_title(raw_title: str, raw_text: str) -> tuple[str, str]:
    """把一行会话拆成 (标题, kind)，kind ∈ {"user", "group"}。

    两条硬约束：
      1) 群聊标题是「群名 (12)」，成员数后缀不属于群名。旧实现先按空格切
         第一段、再在切完的串上判 (N)，于是每个群都被判成 user，groups
         永远返回空。
      2) 昵称/群名本身可以含空格，所以标题节点可用时保留整串、只剥时间戳；
         只有标题节点缺失（此时 raw_text 是「标题 + 消息预览」拼成的整行）
         才退化成取第一段。
    """
    head = norm(raw_title) or norm(raw_text)
    if not head:
        return "", "user"

    kind, name = "user", head
    m = re.search(GROUP_SUFFIX_RE, head)
    if m:
        kind, name = "group", head[:m.start()]
    elif not norm(raw_title):
        # 无标题节点时群成员数后缀不在行尾（后面还跟着预览），在行首窗口再判一次
        m2 = re.search(r"[\(（]\s*\d+\s*[\)）]", head[:60])
        if m2:
            kind, name = "group", head[:m2.start()]

    name = re.sub(TS_TAIL_RE, "", name.strip()).strip()
    if not norm(raw_title) and kind == "user":
        # 只能保守取第一段（含空格的昵称会被截断，与历史行为一致）
        name = name.split(" ")[0].strip()
    return name, kind


async def text_is(loc, expected: str) -> bool:
    try:
        return norm(await loc.inner_text(timeout=600)) == norm(expected)
    except Exception:
        return False


# --------------------------------------------------------------------------
# 浏览器
# --------------------------------------------------------------------------
BROWSER_STATE = os.path.join(DATA, "im-browser.json")
CDP_PORT_FIRST, CDP_PORT_LAST = 9334, 9374
# 常驻浏览器默认关闭。
# 实测（2026-10-26）复用同一个 headless 浏览器时，命令耗时在 6s~90s 之间
# 剧烈抖动，偶尔直接卡死；单独启停一个浏览器反而稳定在 24s 左右。
# 怀疑与 headless 长驻页面的渲染/定时器状态有关，等能稳定复现再开。
# 想试的话：DOUYIN_PERSISTENT_BROWSER=1
PERSISTENT_BROWSER = os.environ.get("DOUYIN_PERSISTENT_BROWSER") == "1"


def _cdp_alive(port: int) -> bool:
    try:
        with urllib.request.urlopen(
                f"http://127.0.0.1:{port}/json/version", timeout=0.8) as resp:
            return resp.status == 200
    except Exception:
        return False


def _free_port() -> int:
    for p in range(CDP_PORT_FIRST, CDP_PORT_LAST):
        s = socket.socket()
        try:
            s.bind(("127.0.0.1", p))
            return p
        except OSError:
            continue
        finally:
            s.close()
    return 0


def _save_browser_port(port: int) -> None:
    try:
        os.makedirs(DATA, exist_ok=True)
        with open(BROWSER_STATE, "w", encoding="utf-8") as fh:
            json.dump({"port": port, "pid": 0, "at": time.time()}, fh)
    except Exception:
        pass


def ensure_persistent_browser() -> int:
    """确保有一个常驻 Chromium 在跑（持久化 profile），返回 CDP 端口。

    为什么要常驻：每条命令都 `launch_persistent_context` 的话，一次读私信里
    光启动 Chromium 就占 8 秒左右；而且频繁启停本身就是一条噪音。复用同一个
    浏览器进程后，命令只剩导航和页面操作。

    起不来就返回 0，调用方退回「每次启动」的老路（不影响正确性）。
    """
    if not CHROME:
        return 0
    try:
        with open(BROWSER_STATE, encoding="utf-8") as fh:
            saved = int(json.load(fh).get("port") or 0)
    except Exception:
        saved = 0
    if saved and _cdp_alive(saved):
        return saved
    for p in range(CDP_PORT_FIRST, CDP_PORT_LAST):
        if _cdp_alive(p):
            _save_browser_port(p)
            return p

    port = _free_port()
    if not port:
        return 0
    os.makedirs(PROFILE_DIR, exist_ok=True)
    args = [CHROME]
    if resolve_headless():
        args.append("--headless=new")
    args += [
        f"--remote-debugging-port={port}",
        f"--user-data-dir={PROFILE_DIR}",
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=1440,950",
        "--lang=zh-CN",
        # 常驻的 headless 页面会被当成「后台标签」节流（定时器降频、渲染暂停），
        # 复用它的时候导航和 evaluate 会慢到几十秒。这三条是关掉节流的标准做法。
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-features=CalculateNativeWinOcclusion",
        "about:blank",
    ]
    flags = 0
    if os.name == "nt":
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        subprocess.Popen(args, stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         creationflags=flags)
    except Exception:
        return 0
    for _ in range(60):
        if _cdp_alive(port):
            _save_browser_port(port)
            return port
        time.sleep(0.5)
    return 0


async def _import_cookies_once(ctx, cookie_file: str | None) -> None:
    """老版本只有 storage_state：profile 里没有 sessionid 时灌一次。

    已有登录态时绝不覆盖 —— 否则会把刚登录的新会话冲掉。
    """
    if not cookie_file or not os.path.isfile(cookie_file):
        return
    try:
        existing = await ctx.cookies("https://www.douyin.com")
        if any(c.get("name") in ("sessionid", "sessionid_ss") for c in existing):
            return
        with open(cookie_file, encoding="utf-8") as fh:
            state = json.load(fh) or {}
        cookies = state.get("cookies") or []
        if cookies:
            await ctx.add_cookies(cookies)
    except Exception:
        pass


async def new_context(pw, cookie_file: str | None):
    """返回 (browser, ctx, shared)。shared=True 表示连的是常驻浏览器，不能关。

    优先复用常驻浏览器；连不上时退回 `launch_persistent_context`。
    两种方式用的是**同一个持久化 profile**，cookie、localStorage 都在里面，
    所以重启对抖音来说只是「同一个浏览器重启」，不是新设备。
    """
    if not CHROME:
        raise IMError(
            "NO_BROWSER",
            "未找到可用浏览器：请安装 Chromium/Chrome，或用 DOUYIN_BROWSER "
            "指定可执行文件绝对路径（例如 /usr/bin/chromium）",
        )

    port = ensure_persistent_browser() if PERSISTENT_BROWSER else 0
    if port:
        try:
            browser = await pw.chromium.connect_over_cdp(f"http://127.0.0.1:{port}")
            ctx = browser.contexts[0] if browser.contexts else None
            if ctx is None:
                await browser.close()
            else:
                await _import_cookies_once(ctx, cookie_file)
                return browser, ctx, True
        except Exception:
            pass

    os.makedirs(PROFILE_DIR, exist_ok=True)
    ctx = await pw.chromium.launch_persistent_context(
        PROFILE_DIR,
        headless=resolve_headless(),
        executable_path=CHROME,
        args=[
            "--no-sandbox",
            "--disable-dev-shm-usage",
            # 不要加 --disable-gpu：那会让 headless 完全没有 WebGL，和扫码登录
            # 时那个有头浏览器的指纹对不上，抖音会把这当成「换了设备」把会话踢掉。
        ],
        viewport={"width": 1440, "height": 950},
        locale="zh-CN",
        # 不覆盖 user_agent：用浏览器自己的真实 UA。给 Windows 上的 Chrome
        # 套一个 Linux UA 本身就是一条显眼的指纹不一致。
    )
    await _import_cookies_once(ctx, cookie_file)
    return None, ctx, False


async def ensure_chat_page(page) -> None:
    """打开 /chat 并判定 风控 / 登录 / 页面就绪。"""
    await page.goto(CHAT_URL, wait_until="domcontentloaded", timeout=45_000)
    await page.wait_for_timeout(3_000)
    await dismiss_save_password(page)

    # 快速轮询：风控面板 / 登录面板 / 搜索框，谁先出现就按谁处理。
    # 不能按固定顺序死等某一个——已登出时等搜索框会白等 18 秒；
    # 而登录面板是异步挂载的，只看 1 秒又会漏（实测两种都会踩）。
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        if await any_visible(page, RISK_MARKERS, 300):
            raise IMError("RISK_CONTROL", "抖音弹出安全验证，已停止（不要尝试绕过验证码）")
        if await any_visible(page, LOGIN_MARKERS, 300):
            raise IMError("NEED_LOGIN",
                          "需要先登录抖音：请先扫码登录（登录会写进持久化 profile）")
        if await first_visible(page, SEARCH_INPUTS, 300):
            await page.wait_for_timeout(800)
            return
        await page.wait_for_timeout(250)

    # 搜索框是 SPA 异步挂载的，冷启动可能慢；最多等 ~25s，只在必要时 reload 一次
    loc, sel = await first_visible(page, SEARCH_INPUTS, 10_000)
    if loc is None:
        await dismiss_save_password(page)
        loc, sel = await first_visible(page, SEARCH_INPUTS, 8_000)
    if loc is None:
        try:
            await page.reload(wait_until="domcontentloaded", timeout=45_000)
            await page.wait_for_timeout(3_000)
            await dismiss_save_password(page)
            loc, sel = await first_visible(page, SEARCH_INPUTS, 10_000)
        except Exception:
            pass

    # 风控永远最先判定（宁可误报也不冒险）；登录判定只在私信页没就绪时做，
    # 否则页面上的「登录后…」类文案会把正常的已登录页面误报成 NEED_LOGIN。
    if await any_visible(page, RISK_MARKERS, 1_000):
        raise IMError("RISK_CONTROL", "抖音弹出安全验证，已停止（不要尝试绕过验证码）")
    if loc is not None:
        await page.wait_for_timeout(1_200)
        return
    if await any_visible(page, LOGIN_MARKERS, 1_000):
        raise IMError("NEED_LOGIN", "需要先登录抖音：请先用 dy login 扫码，生成 cookie 后重试")

    diag = await page.evaluate(
        """() => ({
            url: location.href,
            title: document.title,
            text: (document.body ? document.body.innerText : '').slice(0, 300),
            plain_inputs: [...document.querySelectorAll('input')].map(i => i.placeholder || i.type).slice(0, 8),
            ce_count: document.querySelectorAll('[contenteditable="true"]').length,
        })"""
    )
    raise IMError(
        "PAGE_NOT_READY",
        "私信页已打开但搜索框未就绪（可能未登录或前端改版）；诊断: "
        + json.dumps(diag, ensure_ascii=False)[:500],
    )


# --------------------------------------------------------------------------
# 找目标 & 打开会话
# --------------------------------------------------------------------------
async def search_target(page, name: str):
    """在私信页搜索框搜索 name，返回 (可点击 locator, 匹配方式, 结果名)。"""
    search, sel = await first_visible(page, SEARCH_INPUTS, 10_000)
    if search is None:
        raise IMError("PAGE_NOT_READY", "找不到私信页搜索框")
    await search.click()
    await search.fill("")
    await search.fill(name)
    await page.wait_for_timeout(2_000)

    # 1) 搜索结果里的「发消息」按钮（好友/陌生人/群）
    rows = []
    for rsel in RESULT_ROWS:
        loc = page.locator(rsel)
        n = await loc.count()
        if n:
            rows.append((rsel, loc, n))
    for rsel, loc, n in rows:
        for i in range(min(n, 30)):
            item = loc.nth(i)
            if not await item.is_visible():
                continue
            shown = ""
            for nsel in NAME_NODES:
                node = item.locator(nsel).first
                try:
                    if await node.count() and await node.is_visible():
                        shown = norm(await node.inner_text(timeout=600))
                        break
                except Exception:
                    continue
            if not shown:
                continue
            exact = norm(shown) == norm(name)
            groupy = is_group_name(shown, name)
            if not (exact or groupy):
                continue
            for bsel in CHAT_BTNS:
                btn = item.locator(bsel).first
                try:
                    if await btn.count() and await btn.is_visible():
                        return btn, ("exact" if exact else "group-suffix"), shown
                except Exception:
                    continue

    # 2) 已存在的会话行（搜索结果没按钮时兜底）
    for csel in CONV_ROWS:
        rows2 = page.locator(csel)
        n = await rows2.count()
        for i in range(min(n, 50)):
            row = rows2.nth(i)
            try:
                if not await row.is_visible():
                    continue
            except Exception:
                continue
            shown = ""
            for tsel in CONV_TITLES:
                node = row.locator(tsel).first
                try:
                    if await node.count():
                        shown = norm(await node.inner_text(timeout=600))
                        break
                except Exception:
                    continue
            if not shown:
                continue
            if norm(shown) == norm(name) or is_group_name(shown, name):
                return row, "conversation", shown

    raise IMError("NOT_FOUND", f"搜索不到目标「{name}」；请确认昵称完全一致，或对方是否允许私信")


async def _chat_ready(page, name: str, shown: str, wait_ms: int):
    """在 wait_ms 内反复检查聊天面板是否真的打开了，返回确认到的标题或 None。"""
    deadline = time.monotonic() + wait_ms / 1000
    while time.monotonic() < deadline:
        for hsel in HEADER_TITLES:
            hdr = page.locator(hsel).first
            try:
                if await hdr.count() and await hdr.is_visible():
                    title = norm(await hdr.inner_text(timeout=600))
                    if is_group_name(title, name) or norm(title) == norm(name):
                        return title
            except Exception:
                pass
        # 标题选择器失效时，退化为"输入框出现 + 搜索结果名匹配"
        editor, _ = await first_visible(page, MESSAGE_INPUTS, 800)
        if editor is not None and (norm(shown) == norm(name) or is_group_name(shown, name)):
            await page.wait_for_timeout(600)
            return shown
        await page.wait_for_timeout(500)
    return None


# 会话项中央盖着一个 hint 浮层（"最后一条消息预览"，pointer-events: auto），
# 真实鼠标点击会被它吃掉，页面表现为「右侧一直 RightPanelEmpty」。
# 在目标元素和它的会话项容器上派发完整指针序列可以绕过，已在本环境验证有效。
_FIRE_JS = r"""
el => {
  const fire = node => {
    const r = node.getBoundingClientRect();
    const opt = {bubbles: true, cancelable: true, view: window, button: 0,
                 clientX: r.left + Math.min(r.width / 2, 60),
                 clientY: r.top + Math.min(12, r.height / 2)};
    for (const type of ['pointerover', 'pointerenter', 'pointerdown', 'mousedown',
                        'pointerup', 'mouseup', 'click']) {
      const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
      node.dispatchEvent(new Ctor(type, opt));
    }
  };
  fire(el);
  const parents = [
    el.closest('[class*="conversationConversationItemwrapper"]'),
    el.closest('[class*="ConversationItemwrapper"]'),
    el.closest('[class*="SearchPanelitem"]'),
  ].filter(Boolean);
  const uniq = [...new Set(parents)];
  for (const p of uniq) {
    if (p !== el) fire(p);
  }
  return uniq.length + 1;
}
"""


async def open_conversation(page, name: str) -> str:
    """搜索并点开与 name 的会话，返回确认到的标题。

    点击按可靠性排序，每步之后都校验聊天面板是否真的打开：
      1) 在目标与所在会话项上派发完整指针事件（本环境唯一稳定有效的路径）
      2) 常规 locator.click（搜索面板里的「发消息」按钮走这条）
      3) 会话项顶部坐标点击（避开中央 hint 浮层）
    """
    target, how, shown = await search_target(page, name)

    try:
        await target.evaluate(_FIRE_JS)
    except Exception:
        pass
    got = await _chat_ready(page, name, shown, 8_000)
    if got:
        return got

    try:
        await target.click(timeout=3_000)
    except Exception:
        try:
            await target.click(force=True, timeout=2_000)
        except Exception:
            pass
    got = await _chat_ready(page, name, shown, 6_000)
    if got:
        return got

    try:
        box = await target.bounding_box()
        if box:
            await page.mouse.click(box["x"] + min(40, box["width"] / 3), box["y"] + 10)
    except Exception:
        pass
    got = await _chat_ready(page, name, shown, 6_000)
    if got:
        return got

    raise IMError(
        "CHAT_NOT_OPEN",
        f"点了「{name}」的搜索结果，但右侧聊天面板没打开（可能对方限制私信、账号被限制，或前端改版）。"
        "可先调用 /im/status 看登录态与页面是否正常",
    )


# --------------------------------------------------------------------------
# 输入 / 发送 / dry-run
# --------------------------------------------------------------------------
async def type_message(page, text: str) -> str:
    editor, sel = await first_visible(page, MESSAGE_INPUTS, 12_000)
    if editor is None:
        raise IMError("NO_COMPOSER", "聊天面板里找不到输入框（Draft.js contenteditable）")
    await editor.click()
    await page.wait_for_timeout(300)
    await page.keyboard.insert_text(text)
    await page.wait_for_timeout(600)

    # 校验文本真的进了编辑器（Draft.js 不响应直接设 value）
    try:
        await page.wait_for_function(
            """([txt]) => {
                const norm = s => (s || '').replace(/[\\s\\u200B\\u200C\\u200D\\uFEFF]+/g, ' ').trim();
                const nodes = [...document.querySelectorAll(
                    '[class*=messageEditor] [contenteditable=true], .messageEditorinputArea, [data-contents=true], .DraftEditor-editor [contenteditable=true]'
                )];
                return nodes.some(n => norm(n.innerText).includes(norm(txt)));
            }""",
            arg=[text],
            timeout=6_000,
        )
    except Exception:
        raise IMError("COMPOSE_FAILED", "文本未能写入聊天输入框（Draft.js 未接受输入）")

    # 清空按钮状态（发布按钮是否可用）
    ready = False
    for s in SEND_BUTTONS:
        b = page.locator(s).first
        try:
            if await b.count() and await b.is_visible():
                ready = True
                break
        except Exception:
            continue
    return sel or "", ready


async def composer_text(page) -> str:
    """读输入框里剩下的文本（诊断用；读不到就返回空）。

    Draft.js 清空后常留一个 U+200B 零宽字符，用 norm 一起清掉，否则永远判"没清干净"。
    """
    try:
        editor, _ = await first_visible(page, MESSAGE_INPUTS, 2_000)
        if editor is None:
            return ""
        return norm(str(await editor.evaluate("el => (el.innerText || '')")))
    except Exception:
        return ""


async def clear_composer(page) -> bool:
    """清空输入框，避免 dry-run 留下草稿。

    实测抖音的 Draft.js 编辑器对 `Control+A` 不响应（焦点/手势判定问题），
    键按下去没反应，草稿会留在框里 —— 下次误点发送就真发出去了。
    所以按可靠性逐个尝试，每步都回读校验，最后还有逐字退格兜底。
    """
    try:
        editor, _ = await first_visible(page, MESSAGE_INPUTS, 3_000)
        if editor is None:
            return False

        async def cleaned() -> bool:
            await page.wait_for_timeout(300)
            return not await composer_text(page)

        # 1) Playwright fill("")：对 contenteditable 走 CDP 选区 + 替换
        try:
            await editor.fill("")
            if await cleaned():
                return True
        except Exception:
            pass

        # 2) execCommand 全选 + delete：会触发 input 事件，Draft 认这个
        try:
            await editor.evaluate("""el => {
                el.focus();
                const sel = window.getSelection();
                const r = document.createRange();
                r.selectNodeContents(el);
                sel.removeAllRanges();
                sel.addRange(r);
                document.execCommand('delete', false);
            }""")
            if await cleaned():
                return True
        except Exception:
            pass

        # 3) 键盘全选 + 退格
        try:
            await editor.click()
            await page.keyboard.press("Control+A")
            await page.keyboard.press("Backspace")
            if await cleaned():
                return True
        except Exception:
            pass

        # 4) 兜底：光标移到末尾，按文本长度逐字退格
        try:
            left = await composer_text(page)
            await editor.click()
            await page.keyboard.press("Control+End")
            for _ in range(min(len(left) + 8, 240)):
                await page.keyboard.press("Backspace")
            if await cleaned():
                return True
        except Exception:
            pass

        return False
    except Exception:
        return False


async def trigger_send(page) -> str:
    async def cleared() -> bool:
        try:
            return not (await composer_text(page) or "").strip()
        except Exception:
            return False

    # 1) Playwright 原生点击发送按钮
    for s in SEND_BUTTONS:
        b = page.locator(s).first
        try:
            if await b.count() and await b.is_visible():
                await b.click()
                await page.wait_for_timeout(1800)
                if await cleared():
                    return "button:" + s
                break
        except Exception:
            continue

    # 2) JS 派发完整指针事件序列到发送按钮及其 SVG（实测有效）
    try:
        ok = await page.evaluate(
            """() => {
                const btn = document.querySelector('[class*="messageMsgInputpublishBtn"]') ||
                            document.querySelector('[class*="publishBtn"]');
                if (!btn) return false;
                const targets = [btn];
                const svg = btn.querySelector('svg');
                if (svg) targets.push(svg);
                for (const el of targets) {
                    for (const t of ['pointerdown','mousedown','pointerup','mouseup','click']) {
                        try { el.dispatchEvent(new MouseEvent(t, {bubbles: true, cancelable: true, view: window})); } catch (e) {}
                    }
                }
                return true;
            }"""
        )
        if ok:
            await page.wait_for_timeout(2200)
            if await cleared():
                return "js-events"
    except Exception:
        pass

    # 3) 坐标点击（发送按钮固定右下角）
    try:
        vp = page.viewport_size or {"width": 1440, "height": 950}
        await page.mouse.click(vp["width"] - 60, vp["height"] - 54)
        await page.wait_for_timeout(2200)
        if await cleared():
            return "coords"
    except Exception:
        pass

    # 4) Enter 兜底
    try:
        for s in MESSAGE_INPUTS:
            loc = page.locator(s).first
            if await loc.count() and await loc.is_visible():
                await loc.click()
                break
        await page.wait_for_timeout(300)
    except Exception:
        pass
    await page.keyboard.press("Enter")
    await page.wait_for_timeout(1800)
    return "enter"


async def confirm_sent(page, text: str, before_count: int | None = None,
                       timeout_ms: int = 15_000) -> dict:
    """确认消息真正发出去。

    主判据（回读）：**「我发的、内容匹配」的消息条数有没有 +1**。
    只数气泡总数会在别人刚好说了同样的话时假阳性；找 `isFromMe` 元素
    则分不清「没发出去」和「class 名改了」。数匹配条数才是语义级证据。

    ``before_count`` 是发送前的基线（由调用方在按回车之前取）。传 None
    或 fiber 读不到时，退化到旧的「输入框清空 + 气泡出现」判据。
    """
    deadline = time.monotonic() + timeout_ms / 1000
    composer_empty = False
    readback = False
    after_count = before_count
    used_fallback = False
    last_error = ""

    while time.monotonic() < deadline:
        for f in FAILURE_MARKERS:
            if await page.locator(f).first.count():
                raise IMError("SEND_FAILED", "页面出现「发送失败/重试」，消息未送达")

        # 条件 1：输入框已经清空（如果还有文字，说明没发出去）
        composer_empty = True
        for sel in MESSAGE_INPUTS:
            loc = page.locator(sel).first
            try:
                if await loc.count():
                    remaining = await loc.inner_text(timeout=2000)
                    if remaining.strip():
                        composer_empty = False
                    break
            except Exception:
                continue

        # 条件 2：回读「我发的、内容匹配」的条数
        # 「发送中」还挂着 = 本地回显，不算送达（与图片确认同一语义）
        try:
            still_sending = await page.evaluate(RECENT_BUBBLES_SENDING_JS)
        except Exception:
            still_sending = False
        msgs = await read_messages(page)
        if msgs is None:
            # fiber 读不到 → 退化到旧的气泡判据
            used_fallback = True
            try:
                readback = bool(await page.evaluate(
                    """([txt]) => {
                        const norm = s => (s || '').replace(/[\\s\\u200B\\u200C\\u200D\\uFEFF]+/g, ' ').trim();
                        const want = norm(txt);
                        if (!want) return false;
                        const head = want.slice(0, 20);
                        const bubbles = [...document.querySelectorAll('[class*="isFromMe"]')];
                        return bubbles.some(b => {
                            const t = norm(b.innerText);
                            return t === want || (head && t.startsWith(head));
                        });
                    }""",
                    [text],
                ))
            except Exception as exc:
                last_error = str(exc)[:120]
        elif before_count is not None:
            after_count = count_my_matching(msgs, text)
            readback = after_count > before_count
        else:
            # 没给基线：至少要有 1 条匹配，聊胜于无
            after_count = count_my_matching(msgs, text)
            readback = after_count >= 1

        # 有基线计数时以 count+1 + 无「发送中」为准（2026-10-31 实测：抖音偶发
        # 发送成功但输入框没清空，旧门会误判未确认 → 烧尝试次数 + 重复回复）；
        # composer 只在无基线的兜底路径里继续当判据。
        if readback and not still_sending and (composer_empty or before_count is not None):
            return {
                "bubble_found": True,
                "composer_cleared": composer_empty,
                "readback": readback,
                "my_msg_before": before_count,
                "my_msg_after": after_count,
                "judge": "fallback_bubble" if used_fallback else "readback_count",
                "confirmed_after_ms": timeout_ms - int((deadline - time.monotonic()) * 1000),
            }

        await page.wait_for_timeout(400)

    raise IMError(
        "SEND_UNCONFIRMED",
        f"已触发发送但未确认（{'发送中' if still_sending else '输入框' + ('已清' if composer_empty else '未清')}，"
        f"回读{'通过' if readback else '未通过'}"
        + (f"，我发的匹配条数 {before_count}→{after_count}" if before_count is not None else "")
        + (f"，错误 {last_error}" if last_error else "")
        + "）；请人工核实，勿自动重试",
    )


# 选完文件后弹出的发送确认模态框（2026-10-28 实测）：
#   标题「发送给 ××」+ 缩略图 + caption 输入框（placeholder「有什么想和朋友说的...」）
#   + 「取消」和「发送 (N)」两个按钮。注意 scope 是整个 document，
#   composer 容器里已有的聊天图片（MessageItemEmojiimage）会造成假阳性。
MODAL_JS = r"""
() => {
  const norm = (s) => String(s || '').replace(/\s+/g, '');
  const cls = (el) => String(el && (el.className && el.className.baseVal !== undefined
    ? el.className.baseVal : el.className) || '');
  const btns = [...document.querySelectorAll('button')];
  const send = btns.find((b) => {
    const t = norm(b.innerText);
    return t.startsWith('发送') && t.length <= 8 && t !== '发送消息';
  });
  const cancel = btns.find((b) => norm(b.innerText) === '取消');
  const caption = [...document.querySelectorAll('textarea, [contenteditable="true"]')]
    .map((el) => ({tag: el.tagName, cls: cls(el).slice(0, 140),
                   ph: el.getAttribute('placeholder') || ''}))
    .find((e) => /朋友说|想和/.test(e.ph)) || null;
  const title = [...document.querySelectorAll('div,span,h2,h3')]
    .map((el) => norm(el.innerText || ''))
    .find((t) => t.startsWith('发送给') && t.length < 40) || '';
  return {
    found: Boolean(send),
    title, send_text: send ? (send.innerText || '').trim() : '',
    send_cls: send ? cls(send) : '', cancel: Boolean(cancel), caption,
  };
}
"""

# 点模态框里的「发送 (N)」或「取消」
CLICK_MODAL_BTN_JS = r"""
(want) => {
  const norm = (s) => String(s || '').replace(/\s+/g, '');
  for (const b of document.querySelectorAll('button')) {
    const t = norm(b.innerText);
    const hit = want === 'send'
      ? (t.startsWith('发送') && t.length <= 8 && t !== '发送消息')
      : (t === '取消');
    if (!hit) continue;
    for (const ev of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      b.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
    }
    return true;
  }
  return false;
}
"""


# 上传完成信号：模态框里的预览图从本地 blob 换成了 douyinpic CDN 地址。
# 2026-10-29 实测：不等上传完成就点「发送」，消息会永远卡在「发送中」，对方收不到。
MODAL_READY_JS = r"""
() => {
  const modal = document.querySelector('[class*="MsgInputSendFileModal"]');
  if (!modal) return { modal: false };
  const imgs = [...modal.querySelectorAll('img')]
    .map((im) => String(im.currentSrc || im.src || ''));
  const uploaded = imgs.some((s) => /douyinpic\.com|bytetos|\/tos-/.test(s) && !s.startsWith('blob:'));
  return { modal: true, imgs: imgs.length, uploaded };
}
"""

# 最后一条「我发的」气泡附近还有没有「发送中」标记
RECENT_BUBBLES_SENDING_JS = r"""
() => {
  // 查最近几条「我发的」气泡——caption 是独立消息排在图后面，只看最后一条
  // 会漏掉还挂着「发送中」的图片（2026-10-31 实测被骗过一次）。
  const bubbles = document.querySelectorAll('[class*="isFromMe"]');
  const tail = Array.from(bubbles).slice(-4);
  return tail.some((b) => {
    let root = b;
    for (let i = 0; i < 3 && root.parentElement; i++) root = root.parentElement;
    return /发送中|发送失败/.test(root.innerText || '');
  });
}
"""


async def attach_image(page, image_path: str, wait_ms: int = 15_000) -> dict:
    """把本地图片塞进聊天上传 input（set_input_files），等「发送给」模态框出现，
    再等预览图从本地 blob 换成 CDN 地址（上传真正完成）。

    返回模态框信息；found=False 说明上传没起来（前端改版或文件被拒），
    调用方不要盲目点发送。
    """
    sel = None
    for s in UPLOAD_INPUTS:
        try:
            if await page.locator(s).first.count():
                sel = s
                break
        except Exception:
            continue
    if not sel:
        raise IMError(
            "NO_UPLOAD_INPUT",
            "聊天页里找不到文件上传 input（前端改版？跑 tools/probe_composer.py 对照更新 UPLOAD_INPUTS）",
        )
    await page.locator(sel).first.set_input_files(image_path)
    deadline = time.monotonic() + wait_ms / 1000
    modal: dict = {}
    while time.monotonic() < deadline:
        try:
            modal = await page.evaluate(MODAL_JS)
        except Exception as e:
            modal = {"error": str(e)[:120]}
        if modal.get("found"):
            break
        await page.wait_for_timeout(500)
    if not modal.get("found"):
        return modal
    # 等上传完成（预览图换成 CDN 地址）；检测不到就固定再等 3 秒兜底。
    ready_deadline = time.monotonic() + 12
    uploaded = False
    while time.monotonic() < ready_deadline:
        try:
            ready = await page.evaluate(MODAL_READY_JS)
        except Exception:
            ready = {}
        if ready.get("uploaded"):
            uploaded = True
            break
        await page.wait_for_timeout(500)
    if not uploaded:
        await page.wait_for_timeout(3000)
    modal["upload_ready"] = uploaded
    return modal


async def type_modal_caption(page, text: str) -> bool:
    """往「发送给」模态框的 caption 输入框里打字。打不进去返回 False（只发图）。"""
    try:
        cap = page.locator(
            'textarea[placeholder*="朋友说"], [placeholder*="朋友说"], '
            'textarea[placeholder*="想和"], [placeholder*="想和"]'
        ).first
        if not await cap.count():
            return False
        await cap.click(timeout=3000)
        await cap.fill("")
        await page.keyboard.insert_text(text)
        await page.wait_for_timeout(400)
        got = await cap.input_value() if await cap.evaluate(
            "el => el.tagName === 'TEXTAREA'") else await cap.inner_text()
        return text[:10] in (got or "")
    except Exception:
        return False


async def confirm_image_sent(page, caption: str, media_before: int | None,
                             text_before: int | None,
                             timeout_ms: int = 20_000) -> dict:
    """图片消息的发送确认。

    主判据：**「我发的」媒体消息条数 +1**（媒体没有 text/itemId，
    count_my_matching 数不到）。caption 若作为文字一起出现（合成一条或
    拆成第二条）会记录在 text_after 里供参考，但不作为必要条件。
    """
    deadline = time.monotonic() + timeout_ms / 1000
    media_after = media_before
    text_after = text_before
    last_error = ""
    while time.monotonic() < deadline:
        for f in FAILURE_MARKERS:
            if await page.locator(f).first.count():
                raise IMError("SEND_FAILED", "页面出现「发送失败/重试」，图片未送达")
        # 「发送中」还挂着 = 上传/投递没完成，条数+1 也只是本地回显，不算数
        try:
            still_sending = await page.evaluate(RECENT_BUBBLES_SENDING_JS)
        except Exception:
            still_sending = False
        msgs = await read_messages(page)
        if msgs is not None:
            media_after = count_my_media(msgs)
            text_after = count_my_matching(msgs, caption) if caption else text_before
            if (media_before is None or media_after > media_before) and not still_sending:
                return {
                    "readback": True,
                    "media_before": media_before,
                    "media_after": media_after,
                    "text_before": text_before,
                    "text_after": text_after,
                    "judge": "media_count",
                }
        else:
            last_error = "fiber 读不到"
        await page.wait_for_timeout(400)
    raise IMError(
        "SEND_UNCONFIRMED",
        f"图片已触发发送但未确认（我发的媒体消息 {media_before}→{media_after}"
        + (f"，caption 匹配 {text_before}→{text_after}" if caption else "")
        + (f"，{last_error}" if last_error else "")
        + "）；请人工核实，勿自动重试",
    )


async def screenshot(page, name: str) -> str:
    os.makedirs(SHOT_DIR, exist_ok=True)
    safe = re.sub(r"[^\w\u4e00-\u9fa5-]+", "_", name)[:30]
    path = os.path.join(SHOT_DIR, f"{now_tag()}_{safe}.png")
    try:
        await page.screenshot(path=path)
        return path
    except Exception:
        return ""


# --------------------------------------------------------------------------
# 命令实现
# --------------------------------------------------------------------------
@asynccontextmanager
async def open_browser(cookie_file: str | None):
    """启动 → 注入登录态 → 交出一个 page；退出时确保浏览器被真正关闭。

    用 async with 而不是 async generator，避免命令提前 return 时 finally 里的
    await 得不到执行（那会让事件循环挂死，进程只能等超时被杀）。
    """
    from playwright.async_api import async_playwright

    pw = await async_playwright().start()
    browser = None
    ctx = None
    shared = False
    try:
        browser, ctx, shared = await new_context(pw, cookie_file)
        # 常驻浏览器里可能开着好几个标签页：优先挑已经在抖音上的那个，
        # 否则挑第一个。用错页面会让后续判定多绕一圈。
        pages = list(getattr(ctx, "pages", []) or [])
        page = next((p for p in pages if "douyin.com" in (p.url or "")), None)
        if page is None:
            page = pages[0] if pages else await ctx.new_page()
        yield page
    finally:
        if shared:
            # 连的是常驻浏览器：只断开，绝不能 close 掉（下一个命令还要用）
            try:
                await browser.close()
            except Exception:
                pass
            try:
                await pw.stop()
            except Exception:
                pass
        else:
            for step in (ctx.close if ctx else None, browser.close if browser else None,
                         pw.stop):
                if step is None:
                    continue
                try:
                    await step()
                except Exception:
                    pass


async def cmd_status(cookie_file: str | None) -> dict:
    out = {"cookie_file": cookie_file or None, "chrome": CHROME,
           "chrome_exists": os.path.exists(CHROME),
           "profile": PROFILE_DIR,
           "profile_has_data": profile_has_data(),
           "data_dir": DATA,
           # 真实发送的总闸：只有环境变量为 1 且命令带 --send 才会发出去
           "send_allowed": os.environ.get("DOUYIN_IM_ALLOW_SEND") == "1"}
    _g = _gate_read()
    out["send_gate"] = {
        "cooldown_remaining_s": max(0, int(float(_g.get("blocked_until") or 0) - time.time())),
        "blocked_reason": _g.get("blocked_reason") or "",
        "last_send_ago_s": (int(time.time() - float(_g.get("last_send_at") or 0))
                            if _g.get("last_send_at") else None),
    }
    if not cookie_file and not profile_has_data():
        out.update({
            "logged_in": False,
            "hint": "还没有登录：先跑 python tools/export_login_state.py 扫码"
                    "（登录会写进持久化 profile，运行时复用同一份）",
        })
        return out
    async with open_browser(cookie_file) as page:
        await ensure_chat_page(page)
        search, sel = await first_visible(page, SEARCH_INPUTS, 5_000)
        out.update({
            "logged_in": True,
            "chat_url": page.url,
            "search_box": bool(search),
            "search_selector": sel,
            "composer_present": (await first_visible(page, MESSAGE_INPUTS, 2_000))[0] is not None,
            "screenshot": await screenshot(page, "status"),
        })
    return out


CONV_JS = r"""
() => {
  // 固定优先级：先精确的 wrapper，再退化到宽松 class。不能按 count 取最大，
  // 因为宽泛选择器会把 wrapper 的子节点也算进来。
  const sels = ['[class*="conversationConversationItemwrapper"]',
                '[data-e2e="conversation-item"]',
                '[class*="conversationConversationItem"]',
                '[class*="conversation-item"]'];
  let rows = [];
  for (const s of sels) {
    const n = document.querySelectorAll(s);
    if (n.length) { rows = Array.from(n); break; }
  }
  const pick = (el, ss) => {
    for (const s of ss) {
      const n = el.querySelector(s);
      if (n && (n.innerText || '').trim()) return (n.innerText || '').trim();
    }
    return '';
  };
  // 未读数：fiber 里的 conversation.unreadCount 比红点徽标可靠
  // （徽标会被「99+」截断，也可能被别的红点干扰）。
  const unreadOf = (el) => {
    const fk = Object.keys(el).find(k => k.indexOf('__reactFiber$') === 0
      || k.indexOf('__reactInternalInstance$') === 0);
    if (!fk) return null;
    let f = el[fk], d = 0;
    while (f && d < 14) {
      const p = f.memoizedProps;
      const c = p && p.conversation;
      if (c && typeof c.unreadCount !== 'undefined') {
        const n = Number(c.unreadCount);
        return Number.isFinite(n) ? n : null;
      }
      f = f.return; d++;
    }
    return null;
  };
  return {
    count: rows.length,
    items: rows.map(el => ({
      title: pick(el, ['[class*="conversationConversationItemtitle"]',
                       '[class*="ConversationItemtitle"]',
                       '[class*="ConversationItemTitle"]']),
      text: (el.innerText || '').trim().slice(0, 200),
      badge: pick(el, ['[class*="badge"]', '[class*="Badge"]', '[class*="unread"]',
                       '[class*="Unread"]']),
      unread: unreadOf(el),
      visible: !!(el.offsetWidth || el.offsetHeight)
    }))
  };
}
"""


async def dismiss_save_password(page) -> bool:
    """关掉 Chromium 的「是否保存登录信息？」提示，它会挡住主区域。"""
    try:
        dlg = page.get_by_text("是否保存登录信息", exact=False).first
        if await dlg.count():
            await dlg.wait_for(state="visible", timeout=1500)
            cancel = page.get_by_role("button", name="取消").first
            if await cancel.count():
                await cancel.click(timeout=3000)
                await page.wait_for_timeout(400)
                return True
    except Exception:
        pass
    return False


async def cmd_conversations(cookie_file: str | None, limit: int, groups_only: bool) -> dict:
    items = []
    seen = set()
    async with open_browser(cookie_file) as page:
        await ensure_chat_page(page)
        await page.wait_for_timeout(2_500)
        raw = await page.evaluate(CONV_JS)
        for row in raw.get("items", []):
            if not row.get("visible"):
                continue
            title, kind = split_conv_title(row.get("title") or "", row.get("text") or "")
            if not title or title in seen:
                continue
            if groups_only and kind != "group":
                continue
            seen.add(title)
            items.append({
                "title": title,
                "kind": kind,
                "preview": norm(row.get("text") or "")[:120],
                "unread_hint": norm(row.get("badge") or "")[:20],
                "unread": row.get("unread"),
            })
            if len(items) >= limit:
                break
        return {
            "count": len(items),
            "items": items,
            "dom_rows": raw.get("count", 0),
            "groups_only": groups_only,
            "screenshot": await screenshot(
                page, "groups" if groups_only else "conversations"),
        }
    return {"count": 0, "items": items}


async def cmd_send(cookie_file: str | None, target: str, text: str, do_send: bool,
                   want_shot: bool, expect_group: bool = False,
                   image: str | None = None) -> dict:
    # caption 必填：表情包回复也要有一句话（回读按文本核对，人也更爱看）
    if not text.strip():
        raise IMError("BAD_INPUT", "text 不能为空")
    image_path = validate_image_path(image) if image else None
    gate_kind = "image" if image_path else "text"
    if do_send:
        check_send_gate(gate_kind)  # 冷却中/间隔太短就不开浏览器了，直接拒
    async with open_browser(cookie_file) as page:
        await ensure_chat_page(page)
        title = await open_conversation(page, target)
        # 群发前先确认打开的确是群：群名和个人昵称可能撞名/前缀相同，
        # 校验放在输入之前，任何情况下都不会把消息发错对象。
        if expect_group and not is_group_name(title, target):
            raise IMError(
                "NOT_GROUP",
                f"打开的会话「{title}」与群「{target}」不匹配（不像是该群），已中止，未输入任何内容",
            )
        result = {
            "target": target,
            "resolved_title": title,
            "text": text,
            "image": image_path or None,
            "kind": gate_kind,
            "dry_run": not do_send,
            "sent": False,
        }

        if image_path:
            # 先取基线再动页面：媒体条数 + caption 匹配条数都要「发送前」的值
            pre = await read_messages(page)
            media_before = count_my_media(pre)
            text_before = count_my_matching(pre, text) if pre is not None else None
            modal = await attach_image(page, image_path)
            result["modal"] = modal
            if not modal.get("found"):
                result["attach_failed"] = True
                raise IMError(
                    "ATTACH_FAILED",
                    "选入图片后「发送给」弹窗没有出现（前端改版或格式被拒），已放弃，未发送",
                )
            result["caption_typed"] = await type_modal_caption(page, text)
            result["screenshot_composed"] = await screenshot(page, target) if want_shot else ""
            if do_send:
                clicked = await page.evaluate(CLICK_MODAL_BTN_JS, "send")
                if not clicked:
                    raise IMError("SEND_FAILED", "找不到「发送 (N)」按钮，图片未发送")
                result["trigger"] = "modal_send_btn"
                result.update(await confirm_image_sent(page, text, media_before, text_before))
                result["sent"] = True
                record_send("image")
                result["screenshot"] = await screenshot(page, target + "_sent") if want_shot else ""
            else:
                cancelled = await page.evaluate(CLICK_MODAL_BTN_JS, "cancel")
                if not cancelled:
                    await page.keyboard.press("Escape")
                result["cleared"] = True
                result["composer_left"] = await composer_text(page)
                if want_shot:
                    result["screenshot"] = await screenshot(page, target + "_dryrun")
            return result

        editor_sel, publish_ready = await type_message(page, text)
        result.update({
            "editor_selector": editor_sel,
            "publish_button_ready": publish_ready,
        })
        # 清空前先留证：这张图能看到文本确实进了输入框
        result["screenshot_composed"] = await screenshot(page, target) if want_shot else ""
        if do_send:
            # 按回车之前先数一遍「我发的、内容匹配」的条数，作为回读基线
            pre = await read_messages(page)
            baseline = count_my_matching(pre, text) if pre is not None else None
            how = await trigger_send(page)
            result["trigger"] = how
            result.update(await confirm_sent(page, text, baseline))
            result["sent"] = True
            record_send("text")
            result["screenshot"] = await screenshot(page, target + "_sent") if want_shot else ""
        else:
            result["input_verified"] = True
            result["cleared"] = await clear_composer(page)
            # 清不干净时把残留打出来：草稿留在框里，下次误点发送就会发出去
            result["composer_left"] = await composer_text(page)
            if want_shot:
                result["screenshot"] = await screenshot(page, target + "_dryrun")
        return result
    return {}


async def cmd_group_send(cookie_file: str | None, group: str, text: str, do_send: bool,
                         want_shot: bool) -> dict:
    res = await cmd_send(cookie_file, group, text, do_send, want_shot, expect_group=True)
    if res:
        res["group"] = group
        res["kind"] = "group"
    return res


# --------------------------------------------------------------------------
# 分享视频卡片（走抖音自己的「分享给朋友」，不是发链接）
# --------------------------------------------------------------------------

SHARE_ICON = '[data-e2e="video-share-icon-container"]'
SHARE_PANEL = '[data-e2e="video-share-container"]'

# 在分享面板里找目标那一行。
# 昵称会重名 ⇒ 同时返回 fiber 里的 sec_uid，调用方可以按稳定 id 精确匹配。
_FIND_SHARE_ROW_JS = r"""
([who, toId]) => {
  const sc = document.querySelector('[data-e2e="video-share-container"]');
  if (!sc) return { err: 'no-panel' };
  const secOf = (node) => {
    const fk = Object.keys(node).find(k => k.indexOf('__reactFiber$') === 0
      || k.indexOf('__reactInternalInstance$') === 0);
    if (!fk) return '';
    let f = node[fk], d = 0;
    while (f && d < 14) {
      const p = f.memoizedProps;
      if (p && typeof p === 'object') {
        for (const k in p) {
          const v = p[k];
          if (v && typeof v === 'object' && v.sec_uid) return String(v.sec_uid);
        }
      }
      f = f.return; d++;
    }
    return '';
  };
  const nodes = Array.from(sc.querySelectorAll('div,span,p'))
    .filter(e => (e.innerText || '').trim() === who)
    .sort((a, b) => a.getBoundingClientRect().width - b.getBoundingClientRect().width);
  if (!nodes.length) {
    return { err: 'no-name',
             panel: (sc.innerText || '').replace(/\s+/g, ' ').slice(0, 240) };
  }
  const out = [];
  for (const nameNode of nodes) {
    let row = nameNode;
    for (let i = 0; i < 6 && row; i++) {
      const btns = Array.from(row.querySelectorAll('div,span,button'))
        .filter(e => (e.innerText || '').trim() === '分享');
      if (btns.length) {
        const b = btns[0], r = b.getBoundingClientRect();
        if (r.width > 16 && r.height > 12) {
          out.push({
            sec_uid: secOf(row) || secOf(nameNode),
            btn: { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) },
          });
        }
        break;
      }
      row = row.parentElement;
    }
  }
  const seen = new Set(), uniq = [];
  for (const o of out) {
    const k = o.sec_uid || (o.btn.x + ',' + o.btn.y);
    if (seen.has(k)) continue;
    seen.add(k); uniq.push(o);
  }
  if (toId) {
    const hit = uniq.filter(o => o.sec_uid === toId);
    if (!hit.length) {
      return { err: 'to-id-missing', to_id: toId, candidates: uniq,
               panel: (sc.innerText || '').replace(/\s+/g, ' ').slice(0, 240) };
    }
    return { candidates: hit };
  }
  return { candidates: uniq };
}
"""


async def _hover_with_motion(page, x: float, y: float, steps: int = 8) -> None:
    """按真实轨迹把鼠标移到 (x, y)。

    分享图标挂的是 onMouseEnter / onFocus，没有 onClick —— `el.click()`
    打不开面板，必须真的让指针走过去。
    """
    await page.mouse.move(20, 20)
    await page.wait_for_timeout(250)
    for i in range(1, steps + 1):
        await page.mouse.move(20 + (x - 20) * i / steps, 20 + (y - 20) * i / steps)
        await page.wait_for_timeout(70)
    await page.mouse.move(x, y)
    await page.wait_for_timeout(2000)


async def cmd_share(cookie_file: str | None, aweme_id: str, target: str, do_send: bool,
                    want_shot: bool, to_id: str = "") -> dict:
    """把视频以**原生分享卡片**发给 target（不是文本链接）。

    文本链接在抖音里点不开，而且私信带 URL 会被吞成空气泡；卡片是前端把
    结构化消息交给服务端生成的，只有走分享面板这一条路。
    """
    aweme_id = str(aweme_id or "").strip()
    if not re.fullmatch(r"\d{15,25}", aweme_id):
        raise IMError("BAD_INPUT", f"aweme_id 不合法：{aweme_id!r}")
    if not target:
        raise IMError("BAD_INPUT", "target 不能为空")
    if do_send:
        check_send_gate("card")

    async with open_browser(cookie_file) as page:
        await page.goto(f"https://www.douyin.com/video/{aweme_id}",
                        wait_until="domcontentloaded", timeout=60_000)
        await page.wait_for_timeout(7_000)

        icon = page.locator(SHARE_ICON).first
        if not await icon.count():
            raise IMError("NO_SHARE_ICON", "视频页没加载出分享图标（可能未登录或页面没准备好）")
        box = await icon.bounding_box()
        if not box:
            raise IMError("NO_SHARE_ICON", "分享图标不可见")
        await _hover_with_motion(page, box["x"] + box["width"] / 2,
                                 box["y"] + box["height"] / 2)

        panel = page.locator(SHARE_PANEL).first
        if not await panel.count():
            raise IMError("NO_PANEL", "分享面板没展开（hover 没触发）")

        found = await page.evaluate(_FIND_SHARE_ROW_JS, [target, to_id or ""])
        if found.get("err") == "no-panel":
            raise IMError("NO_PANEL", "分享面板消失了")
        if found.get("err") == "no-name":
            raise IMError(
                "TARGET_NOT_IN_PANEL",
                f"分享面板里没有「{target}」。面板只列**最近分享过的人**——"
                f"先在手机上或网页里手动分享一次给 TA，之后才会出现在这里。"
                f"面板当前内容：{found.get('panel', '')[:160]}")
        if found.get("err") == "to-id-missing":
            raise IMError(
                "TARGET_ID_MISMATCH",
                f"面板里有同名的「{target}」，但没有 sec_uid={to_id} 那个")

        cands = found.get("candidates") or []
        if not cands:
            raise IMError("TARGET_NOT_IN_PANEL", f"没在「{target}」那一行找到「分享」按钮")
        if len(cands) > 1:
            raise IMError(
                "AMBIGUOUS",
                f"分享面板里有 {len(cands)} 个「{target}」，不敢猜（猜错就是发给陌生人）；"
                f"请用 --to-id 指定 sec_uid")

        btn = cands[0]["btn"]
        result = {
            "aweme_id": aweme_id,
            "target": target,
            "to_sec_uid": cands[0].get("sec_uid") or to_id or "",
            "button": btn,
            "dry_run": not do_send,
            "sent": False,
        }
        if not do_send:
            result["panel"] = (await panel.inner_text())[:200] if await panel.count() else ""
            if want_shot:
                result["screenshot"] = await screenshot(page, target + "_share_dry")
            return result

        await page.mouse.click(btn["x"], btn["y"])
        await page.wait_for_timeout(2500)

        # 回读：卡片必须出现在「我发的」消息里，且 item_id 一致
        readback = await confirm_share(page, target, aweme_id)
        result["readback"] = readback
        result["sent"] = bool(readback.get("found"))
        if result["sent"]:
            record_send("card")
        if want_shot:
            result["screenshot"] = await screenshot(page, target + "_share_sent")
        if not result["sent"]:
            raise IMError(
                "SHARE_UNCONFIRMED",
                "已点击分享，但回读没在「我发的」消息里找到这张卡片；"
                "请人工核实，勿自动重试")
        return result
    return {}


async def confirm_share(page, target: str, aweme_id: str) -> dict:
    """回读确认卡片真的发到了对方会话里（aweType=800 + item_id 相同）。"""
    try:
        await page.goto(CHAT_URL, wait_until="domcontentloaded", timeout=45_000)
        await page.wait_for_timeout(2500)
        await open_conversation(page, target)
        await page.wait_for_timeout(2500)
        msgs = await read_messages(page)
        if msgs is None:
            return {"found": False, "reason": "fiber 不可用，无法回读"}
        cards = [
            m for m in msgs
            if m.get("from") == "me"
            and int(m.get("awe") or 0) == AWE_TYPE_CARD
            and str(m.get("item") or "") == str(aweme_id)
        ]
        return {"found": bool(cards), "matching_cards": len(cards)}
    except Exception as exc:
        return {"found": False, "reason": str(exc)[:160]}


# --------------------------------------------------------------------------
# 读私信（提取主人发来的视频链接 / 指令）
# --------------------------------------------------------------------------

# 消息气泡可能的 class 模式
MSG_BUBBLES = (
    '[class*="messageMsgItem"]',
    '[class*="messageItem"]',
    '[class*="msgItem"]',
    '[class*="MessageItem"]',
    '[class*="message-item"]',
)

# 聊天区容器
CHAT_AREA = (
    '[class*="messageList"]',
    '[class*="MessageList"]',
    '[class*="chatMessage"]',
    '[class*="ChatMessage"]',
    '[class*="message-list"]',
)

# 非消息内容（时间戳 / 系统提示）
NOISE_PATTERNS = (
    "你们已互相关注",
    "可以开始聊天",
    "打个招呼吧",
)

VIDEO_URL_RE = re.compile(
    r'https?://(?:www\.douyin\.com/video/|v\.douyin\.com/|www\.iesdouyin\.com/share/video/)\S+'
)

# 分享卡片的 aweType。普通文字消息上也有 aweType（实测 700），
# 只有 800 才是视频/图文卡片 —— 不能拿「有没有 awe」判断。
AWE_TYPE_CARD = 800
# 收藏表情/贴纸（personal_upload 的 webp，带 CDN 直链）。
# 2026-10-28 实测：parsedContent 有 emoji_type/sticker_type/url{uri,url_list,width,height}，
# 没有 text/itemId —— 所以「无文字无 itemId」的消息要看这个值，不能当空消息丢掉。
AWE_TYPE_STICKER = 501
# 通过聊天上传 input 发出去的图片消息（2026-10-29 实测）：
# 也是无 text/itemId，parsedContent 和 501 同构；caption 不随图走，是独立文本消息。
AWE_TYPE_IMAGE = 2702

# 聊天输入区的文件上传 input（2026-10-28 实测，semi-upload 组件）。
# accept=".jpg,.jpeg,.png,.gif,.mp4"；-replace 是替换预览用的第二个 input。
UPLOAD_INPUTS = (
    'input.semi-upload-hidden-input',
    'input.semi-upload-hidden-input-replace',
)
# 表情包图片白名单：扩展名和大小上限（accept 里没有 webp，但程序化 set_input_files
# 不受选择器过滤限制，实测抖音吃 webp 字节；保守起见 webp 也放行，由预览判成败）
MEME_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp"}
MEME_MAX_BYTES = 2 * 1024 * 1024


def meme_roots() -> list[str]:
    """表情包图片允许来自的目录（ realpath 白名单）。"""
    roots = []
    for part in (os.environ.get("DOUYIN_MEME_ROOTS") or "").split(os.pathsep):
        p = part.strip()
        if p:
            roots.append(p)
    roots.append(os.path.join(os.path.expanduser("~"), ".dsh", "meme-packs"))
    out = []
    for r in roots:
        rp = os.path.realpath(r)
        if os.path.isdir(rp) and rp not in out:
            out.append(rp)
    return out


def validate_image_path(raw: str) -> str:
    """表情包路径白名单：必须在图库目录里、扩展名/大小合规。返回 realpath。"""
    p = os.path.realpath(str(raw or "").strip())
    if not p or not os.path.isfile(p):
        raise IMError("BAD_INPUT", f"图片不存在：{raw!r}")
    if os.path.splitext(p)[1].lower() not in MEME_EXTS:
        raise IMError("BAD_INPUT", f"图片扩展名不支持（只允许 {'/'.join(sorted(MEME_EXTS))}）：{p}")
    size = os.path.getsize(p)
    if size <= 0 or size > MEME_MAX_BYTES:
        raise IMError("BAD_INPUT", f"图片大小 {size} 字节超出限制（0, {MEME_MAX_BYTES}]")
    roots = meme_roots()
    if not roots:
        # fail-closed：没有图库目录就一律拒发，绝不能退化成「任意路径都行」
        raise IMError(
            "IMAGE_NOT_ALLOWED",
            "没有可用的表情包图库目录（~/.dsh/meme-packs 不存在且未配置 DOUYIN_MEME_ROOTS），拒绝发送",
        )
    if not any(p == r or p.startswith(r + os.sep) for r in roots):
        raise IMError(
            "IMAGE_NOT_ALLOWED",
            "图片不在表情包目录白名单里（DOUYIN_MEME_ROOTS / ~/.dsh/meme-packs），拒绝发送："
            + p,
        )
    return p

# 从 React fiber 里读结构化消息。
#
# 抖音前端把解析好的消息对象挂在 `message.parsedContent` 上，里面有
# itemId（19 位 aweme_id）、aweType、text、content_title。这比在 DOM 里
# 找 class 名稳定得多，也终于能拿到卡片里那个视频 ID（以前只能截图让
# 模型用眼睛数）。
#
# 发送方判定：**36px 头像落在消息列表左半边还是右半边**。
# 抖音的 `message.isMyMessage` 恒为 true（连对方发的也是），不能用来判方向；
# 三层祖先的 class 名也完全一样。同一人连发时只有组里最早那条带头像，
# 所以没有头像的消息用 `isFromMe` class 兜底（实测两者 100% 一致）。
# 两边不一致的条数记在 diag.sender_disagree 里，方便前端改版后第一时间发现。
READ_MESSAGES_JS = r"""
() => {
  const fiberKey = (n) => {
    const ks = Object.keys(n);
    for (const k of ks) {
      if (k.indexOf('__reactFiber$') === 0) return k;
      if (k.indexOf('__reactInternalInstance$') === 0) return k;
    }
    return null;
  };
  const listNode = document.querySelector('[class*="messageMessageList"]')
    || document.querySelector('[class*="componentsRightPanel"]') || document.body;
  const lb = listNode.getBoundingClientRect();
  const mid = lb.left + lb.width / 2;
  const nodes = Array.prototype.slice.call(
    document.querySelectorAll('[class*="messageMessageBox"]'));
  const out = [];
  const seen = new WeakSet();
  let fiberHits = 0, parsedHits = 0, avatarHits = 0, classHits = 0, systemHits = 0;

  nodes.forEach(function (n) {
    const fk = fiberKey(n);
    if (!fk) return;
    fiberHits++;
    let f = n[fk], d = 0, found = null;
    while (f && d < 24) {
      const p = f.memoizedProps;
      if (p && p.message && typeof p.message === 'object' && p.message.parsedContent) {
        found = p.message;
        break;
      }
      f = f.return; d++;
    }
    if (!found) return;
    if (seen.has(found)) return;
    seen.add(found);
    parsedHits++;

    const pc = found.parsedContent || {};
    // 系统消息（「获得火花见面礼」之类）：不是谁说的话，不能当成聊天内容。
    // 它们的 text 是空的，混进来会被误判成「我发的空消息」。
    if (String(pc.is_system_type) === 'true') { systemHits++; return; }

    const r = n.getBoundingClientRect();
    let side = '';
    const imgs = Array.prototype.slice.call(n.querySelectorAll('img')).filter(function (img) {
      const b = img.getBoundingClientRect();
      if (b.width < 28 || b.width > 48) return false;
      if (Math.abs(b.width - b.height) > 6) return false;
      const cy = b.top + b.height / 2;
      return cy >= r.top - 2 && cy <= r.bottom + 2;
    });
    if (imgs.length) {
      const ib = imgs[0].getBoundingClientRect();
      side = ((ib.left + ib.width / 2) < mid) ? 'them' : 'me';
      avatarHits++;
    }
    const clsMe = !!n.querySelector('[class*="isFromMe"]')
      || /isFromMe/.test(String(n.className || ''));
    if (clsMe) classHits++;

    out.push({
      own: side,
      cls_me: clsMe,
      text: String(pc.text || pc.content_title || '').replace(/\s+/g, ' ').trim(),
      title: String(pc.content_title || '').trim(),
      awe: Number(pc.aweType) || 0,
      item: pc.itemId ? String(pc.itemId) : '',
      type: String(pc.type || ''),
      // 收藏表情/贴纸（aweType 501）：没有 text/itemId，靠这几个字段识别和下载
      img_uri: (pc.url && pc.url.uri) ? String(pc.url.uri) : '',
      img_url: (pc.url && Array.isArray(pc.url.url_list) && pc.url.url_list.length)
        ? String(pc.url.url_list[0]) : '',
      img_id: pc.image_id ? String(pc.image_id) : '',
      top: Math.round(r.top),
    });
  });

  // 顺序：parsedContent 里没有时间戳（实测只有 aweType/text/richTextInfos），
  // 所以直接用几何位置判断——DOM 第一个节点在屏幕上更靠下，就说明它是更新的。
  // 不依赖 flex-direction（实测父容器是 row，看不出来）。
  let domNewestFirst = true;
  if (out.length >= 2) {
    domNewestFirst = out[0].top >= out[out.length - 1].top;
  }
  const chrono = domNewestFirst ? out.slice().reverse() : out;

  // 发送方：头像左右最可靠；没有头像时用 isFromMe class 兜底
  // （实测两者 100% 一致；class 兜底能救「最新一条还没渲染出头像」的情况）。
  chrono.forEach(function (m) {
    m.from = m.own || (m.cls_me ? 'me' : 'them');
    m.sender_basis = m.own ? 'avatar' : 'class';
  });

  return {
    messages: chrono,
    diag: {
      nodes: nodes.length,
      fiber_hits: fiberHits,
      parsed_hits: parsedHits,
      avatar_hits: avatarHits,
      class_me_hits: classHits,
      system_hits: systemHits,
      dom_newest_first: domNewestFirst,
      sender_disagree: chrono.filter(function (m) {
        return m.own && (m.cls_me !== (m.own === 'me'));
      }).length,
    },
  };
}
"""


_ZW_RE = re.compile(r"[\u200B\u200C\u200D\uFEFF]")
_WS_RE = re.compile(r"\s+")


def _norm_text(s: str) -> str:
    """归一化正文用于比对：删零宽字符，再把连续空白压成一个空格。

    零宽字符必须**删掉**而不是换成空格——它是不可见的，换成空格会把
    单词/句子切断，导致回读比对失败。
    """
    return _WS_RE.sub(" ", _ZW_RE.sub("", s or "")).strip()


async def read_messages(page) -> list[dict] | None:
    """读当前会话的结构化消息（旧 → 新）。

    返回 ``None`` 表示 fiber 读不到（前端改版等），调用方应退化到旧判据；
    返回 ``[]`` 表示确实没有消息。
    """
    try:
        raw = await page.evaluate(READ_MESSAGES_JS) or {}
        if not isinstance(raw, dict):
            return None
        diag = raw.get("diag") or {}
        nodes = int(diag.get("nodes") or 0)
        # 有消息节点、却一条 fiber / parsedContent 都读不到 ⇒ fiber 不可用
        # （前端改版，或 fixture 这种手写 DOM），交给调用方退化到旧判据。
        if nodes > 0 and (int(diag.get("fiber_hits") or 0) == 0
                          or int(diag.get("parsed_hits") or 0) == 0):
            return None
        return raw.get("messages") or []
    except Exception:
        return None


def count_my_matching(msgs: list[dict], text: str) -> int:
    """数「我发的、内容与 text 匹配」的消息条数。

    用「整段相等 或 前 20 字前缀相等」匹配：抖音会对正文做空白归一化，
    也可能截断长文本；只数总数会在别人刚好说了同样的话时假阳性。
    """
    want = _norm_text(text)
    if not want:
        return 0
    head = want[:20]
    n = 0
    for m in msgs:
        if m.get("from") != "me":
            continue
        got = _norm_text(m.get("text") or "")
        if got == want or (head and got.startswith(head)):
            n += 1
    return n


def count_my_media(msgs: list[dict] | None) -> int | None:
    """「我发的」媒体消息（表情/贴纸/图片）条数；fiber 读不到返回 None。

    这类消息没有 text 也没有 item_id，count_my_matching 数不到它们，
    发图片后的回读确认要用这个计数。
    """
    if msgs is None:
        return None
    return sum(
        1 for m in msgs
        if m.get("from") == "me"
        and (m.get("image_uri") or m.get("image_id")
             # 没有 img 字段的老前端结构：无文字无 item 的也算媒体
             or ((m.get("text") or "").strip() == "" and not m.get("item_id")))
    )


def _fallback_text_lines(chat_text: str) -> list[str]:
    """fiber 读不到时的兜底：按行切纯文本。"""
    out = []
    for line in chat_text.split("\n"):
        line = line.strip()
        if not line: continue
        if any(noise in line for noise in NOISE_PATTERNS): continue
        if re.match(r'^[\d:分钟前小时天月年刚\s]+$', line): continue
        if line in ("搜索", "取消"): continue
        if len(line) < 2: continue
        out.append(line)
    return out


async def cmd_read(cookie_file: str | None, target: str, limit: int = 20) -> dict:
    """打开与 target 的会话，读消息（优先 React fiber，DOM 文本兜底）。"""
    async with open_browser(cookie_file) as page:
        await ensure_chat_page(page)
        title = await open_conversation(page, target)
        await page.wait_for_timeout(3000)

        # 截图保留：agent 仍可用它核对卡片长什么样
        shot = await screenshot(page, target + "_read")

        raw: dict = {}
        try:
            raw = await page.evaluate(READ_MESSAGES_JS) or {}
        except Exception as exc:  # 前端改版 / fiber 结构变了
            raw = {"messages": [], "diag": {"error": str(exc)[:200]}}
        diag = raw.get("diag") or {}
        raw_msgs = raw.get("messages") or []

        # 兜底：fiber 一条都没读到 → 退回纯文本
        fallback_lines: list[str] = []
        if not raw_msgs:
            chat_text = ""
            for area_sel in CHAT_AREA:
                loc = page.locator(area_sel).first
                try:
                    if await loc.count():
                        chat_text = await loc.inner_text(timeout=5000)
                        break
                except Exception:
                    continue
            if not chat_text:
                chat_text = await page.inner_text("body")
            fallback_lines = _fallback_text_lines(chat_text)

        raw_msgs = raw_msgs[-limit:]
        messages = []
        for m in raw_msgs:
            awe = int(m.get("awe") or 0)
            item_id = m.get("item") or ""
            img_uri = m.get("img_uri") or ""
            img_url = m.get("img_url") or ""
            # aweType: 800 = 视频卡片；501 = 收藏表情/贴纸；2702 = 聊天发出的图片；
            # 0 但带 itemId = 图文；700/703 = 普通文字
            if awe == AWE_TYPE_CARD:
                kind = "video"
            elif awe in (AWE_TYPE_STICKER, AWE_TYPE_IMAGE) or (img_uri and not item_id):
                kind = "sticker"
            elif item_id:
                kind = "note"
            else:
                kind = "text"
            messages.append({
                "from": m.get("from") or "unknown",
                "text": m.get("text") or "",
                "kind": kind,
                "awe": awe,
                "item_id": item_id,
                "title": m.get("title") or "",
                "sender_basis": m.get("sender_basis") or "",
                "image_uri": img_uri,
                "image_url": img_url,
                "image_id": m.get("img_id") or "",
            })

        # 主人发来的内容（视频 + 图文）：只要带 itemId 就算一条，旧 → 新
        videos = [{
            "item_id": m["item_id"],
            "title": m["title"] or m["text"],
            "kind": m["kind"],
            "from": m["from"],
        } for m in messages if m["item_id"]]

        # 文本链接（老路径兜底）
        text_video_urls = []
        full_text = ("\n".join(m["text"] for m in messages)
                     if messages else "\n".join(fallback_lines))
        for match in VIDEO_URL_RE.finditer(full_text):
            url = match.group(0).rstrip(".,;:)】」")
            if url not in text_video_urls:
                text_video_urls.append(url)

        return {
            "target": target,
            "resolved_title": title,
            "screenshot": shot,
            "message_count": len(messages) or len(fallback_lines),
            "messages": messages or fallback_lines,
            "videos": videos,
            "video_urls": text_video_urls,
            # 兼容旧调用方：卡片数量 = videos 条数
            "card_authors": [v["title"] for v in videos],
            "fiber_diag": diag,
        }
    return {}


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------
def kill_stale_browsers() -> int:
    """清理本驱动上次异常退出留下的 Chromium，返回杀掉的个数。

    不能用 `pkill -f playwright_chromiumdev_profile` 一刀切：dy-cli（/trending、
    /search 用的那个）同样是 `chromium.launch()`，临时目录名一模一样，一刀切会
    把别的接口正在跑的浏览器杀掉。这里按本驱动独有的启动参数（--no-sandbox +
    --disable-dev-shm-usage）精确匹配。
    """
    killed = 0
    if os.name == "nt":
        # Windows 上没有 pgrep；残留浏览器由 bridge 的 profile 清理逻辑处理
        return 0
    try:
        import subprocess
        out = subprocess.run(["pgrep", "-af", "playwright_chromiumdev_profile"],
                             capture_output=True, text=True, timeout=10).stdout
        for line in (out or "").splitlines():
            pid, _, cmd = line.partition(" ")
            if "--no-sandbox" in cmd and "--disable-dev-shm-usage" in cmd:
                try:
                    os.kill(int(pid), 9)
                    killed += 1
                except Exception:
                    pass
    except Exception:
        pass
    return killed


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Douyin web IM driver (dry-run by default)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("status")

    p_conv = sub.add_parser("conversations")
    p_conv.add_argument("--limit", type=int, default=30)

    p_grp = sub.add_parser("groups")
    p_grp.add_argument("--limit", type=int, default=30)

    p_send = sub.add_parser("send")
    p_send.add_argument("--to", required=True)
    p_send.add_argument("--text", required=True)
    p_send.add_argument("--image", default="",
                        help="附带本地图片（白名单：DOUYIN_MEME_ROOTS / ~/.dsh/meme-packs）")
    p_send.add_argument("--send", action="store_true", help="真实发送（另需 DOUYIN_IM_ALLOW_SEND=1）")
    p_send.add_argument("--screenshot", action="store_true", default=True)

    p_gs = sub.add_parser("group-send")
    p_gs.add_argument("--group", required=True)
    p_gs.add_argument("--text", required=True)
    p_gs.add_argument("--send", action="store_true")
    p_gs.add_argument("--screenshot", action="store_true", default=True)

    p_read = sub.add_parser("read", help="读某个会话的最近消息")
    p_read.add_argument("--from", dest="from_nick", required=True, help="对方昵称")
    p_read.add_argument("--limit", type=int, default=20)

    p_share = sub.add_parser("share", help="把视频以原生分享卡片发给某人")
    p_share.add_argument("--aweme", required=True, help="视频 ID（15-25 位数字）")
    p_share.add_argument("--to", required=True, help="对方昵称")
    p_share.add_argument("--to-id", dest="to_id", default="",
                         help="对方 sec_uid（昵称重名时必填）")
    p_share.add_argument("--send", action="store_true",
                         help="真实发送（另需 DOUYIN_IM_ALLOW_SEND=1）")
    p_share.add_argument("--screenshot", action="store_true", default=True)

    p_gate = sub.add_parser("gate", help="查看/清除发送闸（风控冷却）")
    p_gate.add_argument("--clear", action="store_true", help="清除冷却，立即允许发送")

    args = ap.parse_args(argv)

    do_send = bool(getattr(args, "send", False))
    if do_send and os.environ.get("DOUYIN_IM_ALLOW_SEND") != "1":
        emit(False, code="SEND_BLOCKED",
             message="真实发送被拦截：需要设置环境变量 DOUYIN_IM_ALLOW_SEND=1 才允许 --send")
        return 2

    # 第三道闸（可选）：DOUYIN_IM_ALLOW_TO 逗号分隔的允许对象。
    # 只有真实发送时才校验；留空 = 不启用白名单（兼容旧行为）。
    allow_to = [x.strip() for x in (os.environ.get("DOUYIN_IM_ALLOW_TO") or "").split(",") if x.strip()]
    if do_send and allow_to:
        target = getattr(args, "to", None) or getattr(args, "group", None) or ""
        if target not in allow_to:
            emit(False, code="TARGET_NOT_ALLOWED",
                 message=f"目标「{target}」不在 DOUYIN_IM_ALLOW_TO 白名单里，已拒绝发送")
            return 2

    # gate 只读写一个本地文件，不需要开浏览器，也不该抢浏览器锁
    if args.cmd == "gate":
        if getattr(args, "clear", False):
            try:
                os.remove(GATE_FILE)
            except Exception:
                pass
            emit(True, data={"cleared": True})
            return 0
        g = _gate_read()
        now = time.time()
        emit(True, data={
            "gate": g,
            "cooldown_remaining_s": max(0, int(float(g.get("blocked_until") or 0) - now)),
            "last_send_ago_s": (int(now - float(g.get("last_send_at") or 0))
                                if g.get("last_send_at") else None),
            "min_interval_s": SEND_MIN_INTERVAL,
        })
        return 0

    lock = None
    try:
        # 2G 内存 + Chromium 很重：连 status 也要拿锁，任何命令都不并发开浏览器
        lock = acquire_lock()
        # 拿到锁（= 确认没有别的 IM 任务在跑）之后才清上一次异常退出留下的铬进程。
        # 顺序不能反：先清再拿锁，会把正在运行那个实例的浏览器杀掉。
        try:
            kill_stale_browsers()
        except Exception:
            pass
        cookie_file = find_cookie_file()

        async def run():
            if args.cmd == "status":
                return await cmd_status(cookie_file)
            if cookie_file is None and not profile_has_data():
                raise IMError("NEED_LOGIN",
                              "还没登录过。先跑 python tools/export_login_state.py 扫码，"
                              f"登录态会写进持久化 profile：{PROFILE_DIR}")
            if args.cmd == "conversations":
                return await cmd_conversations(cookie_file, args.limit, False)
            if args.cmd == "groups":
                return await cmd_conversations(cookie_file, args.limit, True)
            if args.cmd == "send":
                return await cmd_send(cookie_file, args.to, args.text, do_send, True,
                                      image=getattr(args, "image", "") or "")
            if args.cmd == "group-send":
                return await cmd_group_send(cookie_file, args.group, args.text, do_send, True)
            if args.cmd == "read":
                return await cmd_read(cookie_file, args.from_nick, args.limit)
            if args.cmd == "share":
                return await cmd_share(cookie_file, args.aweme, args.to, do_send, True,
                                       getattr(args, "to_id", "") or "")
            raise IMError("BAD_CMD", "unknown command")

        data = asyncio.run(asyncio.wait_for(run(), timeout=150))
        emit(True, data=data)
        # Playwright 的 pipe transport 线程偶尔不会随事件循环退出，导致进程
        # 挂到最后被 timeout 杀掉。JSON 已经 flush，直接退出进程。
        os._exit(0)
    except asyncio.TimeoutError:
        emit(False, code="TIMEOUT", message="操作超时（150s）：页面可能加载缓慢或风控弹窗阻塞")
        os._exit(1)
    except IMError as e:
        # 风控/发送失败要落闸：冷却期内别再打抖音，越重试封越久
        try:
            _note_gate_failure(e)
        except Exception:
            pass
        emit(False, code=e.code, message=e.message)
        os._exit(1)
    except Exception as e:  # 兜底：不让上层看到裸栈
        emit(False, code="INTERNAL", message=f"{type(e).__name__}: {e}")
        os._exit(1)
    finally:
        if lock:
            try:
                lock.close()
            except Exception:
                pass


if __name__ == "__main__":
    sys.exit(main())
