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
import sys
import time
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

UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36"
)

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


def acquire_lock():
    """串行化：同一时刻只允许一个浏览器实例。返回文件句柄（需保活）。"""
    os.makedirs(DATA, exist_ok=True)
    fh = open(LOCK_FILE, "w")
    try:
        import fcntl
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        fh.close()
        raise IMError("BUSY", "已有另一个抖音私信任务在运行，请稍后再试")
    except ImportError:
        pass
    return fh


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
async def new_context(pw, cookie_file: str | None):
    """普通 browser context（storage_state 只支持 new_context，不支持 persistent）。"""
    if not CHROME:
        raise IMError(
            "NO_BROWSER",
            "未找到可用浏览器：请安装 Chromium/Chrome，或用 DOUYIN_BROWSER "
            "指定可执行文件绝对路径（例如 /usr/bin/chromium）",
        )
    browser = await pw.chromium.launch(
        headless=resolve_headless(),
        executable_path=CHROME,
        args=[
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
        ],
    )
    ctx_kwargs = dict(
        viewport={"width": 1440, "height": 950},
        locale="zh-CN",
        user_agent=UA,
    )
    if cookie_file:
        ctx_kwargs["storage_state"] = cookie_file
    ctx = await browser.new_context(**ctx_kwargs)
    return browser, ctx


async def ensure_chat_page(page) -> None:
    """打开 /chat 并判定 风控 / 登录 / 页面就绪。"""
    await page.goto(CHAT_URL, wait_until="domcontentloaded", timeout=45_000)
    await page.wait_for_timeout(3_000)
    await dismiss_save_password(page)

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


async def confirm_sent(page, text: str, timeout_ms: int = 15_000) -> dict:
    """等待自己发出的消息气泡出现，并排除失败标记。返回确认信息。"""
    deadline = time.monotonic() + timeout_ms / 1000
    while time.monotonic() < deadline:
        for f in FAILURE_MARKERS:
            if await page.locator(f).first.count():
                raise IMError("SEND_FAILED", "页面出现「发送失败/重试」，消息未送达")
        try:
            found = await page.evaluate(
                """([txt]) => {
                    const norm = s => (s || '').replace(/[\\s\\u200B\\u200C\\u200D\\uFEFF]+/g, ' ').trim();
                    const bubbles = [...document.querySelectorAll(
                        '[class*="isFromMe"], [class*="messageBoxisFromMe"], [class*="MessageItemTextisFromMe"]'
                    )];
                    return bubbles.some(b => norm(b.innerText).includes(norm(txt)));
                }""",
                [text],
            )
            if found:
                return {"bubble_found": True, "confirmed_after_ms": timeout_ms - int((deadline - time.monotonic()) * 1000)}
        except Exception:
            pass
        await page.wait_for_timeout(400)
    raise IMError("SEND_UNCONFIRMED", "已触发发送，但未确认到自己的消息气泡；请到页面上人工核实，勿自动重试")


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
    try:
        browser, ctx = await new_context(pw, cookie_file)
        page = await ctx.new_page()
        yield page
    finally:
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
           "data_dir": DATA,
           # 真实发送的总闸：只有环境变量为 1 且命令带 --send 才会发出去
           "send_allowed": os.environ.get("DOUYIN_IM_ALLOW_SEND") == "1"}
    if not cookie_file:
        raise IMError("NEED_LOGIN",
                      "未找到抖音 cookie（storage_state）。请先 dy login 扫码登录，"
                      f"期望路径: {COOKIE_CANDIDATES[1]}")
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
  return {
    count: rows.length,
    items: rows.map(el => ({
      title: pick(el, ['[class*="conversationConversationItemtitle"]',
                       '[class*="ConversationItemtitle"]',
                       '[class*="ConversationItemTitle"]']),
      text: (el.innerText || '').trim().slice(0, 200),
      badge: pick(el, ['[class*="badge"]', '[class*="Badge"]', '[class*="unread"]',
                       '[class*="Unread"]']),
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
                   want_shot: bool, expect_group: bool = False) -> dict:
    if not text.strip():
        raise IMError("BAD_INPUT", "text 不能为空")
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
        editor_sel, publish_ready = await type_message(page, text)
        result = {
            "target": target,
            "resolved_title": title,
            "text": text,
            "editor_selector": editor_sel,
            "publish_button_ready": publish_ready,
            "dry_run": not do_send,
            "sent": False,
        }
        # 清空前先留证：这张图能看到文本确实进了输入框
        result["screenshot_composed"] = await screenshot(page, target) if want_shot else ""
        if do_send:
            how = await trigger_send(page)
            result["trigger"] = how
            result.update(await confirm_sent(page, text))
            result["sent"] = True
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


async def cmd_read(cookie_file: str | None, target: str, limit: int = 20) -> dict:
    """打开与 target 的会话，读最近 limit 条消息，提取视频链接。"""
    async with open_browser(cookie_file) as page:
        await ensure_chat_page(page)
        title = await open_conversation(page, target)
        await page.wait_for_timeout(2000)

        # 拿聊天区域的完整文本（最可靠的通用方式）
        chat_text = ""
        for area_sel in CHAT_AREA:
            loc = page.locator(area_sel).first
            try:
                if await loc.count():
                    chat_text = await loc.inner_text(timeout=5000)
                    break
            except Exception:
                continue

        # 兜底：如果选择器没命中，直接拿 body 文本
        if not chat_text:
            chat_text = await page.inner_text("body")

        # 按行拆分，去掉空行和噪音
        lines = [l.strip() for l in chat_text.split("\n") if l.strip()]
        messages = []
        for line in lines:
            if any(noise in line for noise in NOISE_PATTERNS):
                continue
            # 跳过纯时间戳行（如 "刚刚" "54分钟前" "21:46"）
            if re.match(r'^[\d:分钟前小时天月年刚\s]+$', line):
                continue
            # 跳过搜索框文本
            if line in ("搜索", "取消"):
                continue
            if len(line) < 2:
                continue
            messages.append(line)

        # 只取最后 limit 条
        messages = messages[-limit:]

        # 提取视频链接
        video_urls = []
        full_text = "\n".join(messages)
        for match in VIDEO_URL_RE.finditer(full_text):
            url = match.group(0).rstrip(".,;:)】」")
            if url not in video_urls:
                video_urls.append(url)

        return {
            "target": target,
            "resolved_title": title,
            "message_count": len(messages),
            "messages": messages,
            "video_urls": video_urls,
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
            if cookie_file is None:
                raise IMError("NEED_LOGIN",
                              "未找到抖音 cookie（storage_state），需要先登录。"
                              f"期望路径: {COOKIE_CANDIDATES[1]}")
            if args.cmd == "conversations":
                return await cmd_conversations(cookie_file, args.limit, False)
            if args.cmd == "groups":
                return await cmd_conversations(cookie_file, args.limit, True)
            if args.cmd == "send":
                return await cmd_send(cookie_file, args.to, args.text, do_send, True)
            if args.cmd == "group-send":
                return await cmd_group_send(cookie_file, args.group, args.text, do_send, True)
            if args.cmd == "read":
                return await cmd_read(cookie_file, args.from_nick, args.limit)
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
