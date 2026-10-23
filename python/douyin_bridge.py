#!/usr/bin/env python3
"""Playwright bridge for the DSH Douyin plugin.

Only two jobs live here, both of which the upstream ``dy-cli`` does not expose
as a pollable state machine:

1. QR / SMS login that advances through ``login_start -> login_status ->
   login_submit`` and stores a Playwright ``storage_state`` where ``dy-cli``
   expects its cookie file.
2. Browser-only read/write helpers that ``dy-cli`` implements with a bundled
   Chromium (``dy comments`` / ``dy comment``). This bridge always drives a
   system browser (Edge on Windows, Chromium/Chrome on Linux/macOS) in a
   dedicated profile, never a browser it downloads itself.

Protocol: every CLI subcommand prints exactly one JSON envelope on stdout
``{ok: true, data: ...}`` or ``{ok: false, error: {code, message}}``.
The login daemon is detached and reports through ``data/state/login.json``.
"""
from __future__ import annotations

import argparse
import glob
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import traceback
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.environ.get("DOUYIN_DATA_DIR") or os.path.join(ROOT, "data")
STATE_DIR = os.path.join(DATA, "state")
LOG_DIR = os.path.join(DATA, "logs")
PROFILE_DIR = os.path.join(DATA, "browser-profile")
HOME_DIR = os.path.join(DATA, "home")
TMP_DIR = os.path.join(DATA, "tmp")
COOKIE_FILE = os.path.join(HOME_DIR, ".dy", "cookies", "default.json")
STATE_FILE = os.path.join(STATE_DIR, "login.json")
LOCK_FILE = os.path.join(STATE_DIR, "login.lock")
COMMAND_FILE = os.path.join(STATE_DIR, "command.json")
QR_FILE = os.path.join(DATA, "login-qrcode.png")
BRIDGE_LOG = os.path.join(LOG_DIR, "bridge.log")

EDGE_CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    # Linux/macOS: a distro package is the most predictable entry point.
    # DOUYIN_BROWSER / DOUYIN_EDGE_PATH (set by the plugin from config.edgePath)
    # always win over every candidate below.
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/snap/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
]

# Playwright's own download directory embeds a revision number, so it can only
# be found with a glob: ~/.cache/ms-playwright/chromium-<rev>/chrome-linux64/chrome
PW_CHROMIUM_GLOBS = (
    "~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome",
    "~/.cache/ms-playwright/chromium-*/chrome-linux/chrome",
    "~/Library/Caches/ms-playwright/chromium-*/chrome-mac/Chromium.app/Contents/MacOS/Chromium",
    "~/.cache/ms-playwright/chromium-*/chrome-win/chrome.exe",
    "~/AppData/Local/ms-playwright/chromium-*/chrome-win/chrome.exe",
)

STEALTH_JS = """
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
if (!window.chrome) { window.chrome = {}; }
if (!window.chrome.runtime) { window.chrome.runtime = {}; }
Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en-US', 'en'] });
Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
"""


# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------

def ensure_dirs() -> None:
    for path in (STATE_DIR, LOG_DIR, PROFILE_DIR, HOME_DIR, TMP_DIR,
                 os.path.dirname(COOKIE_FILE)):
        os.makedirs(path, exist_ok=True)
    os.environ.setdefault("TMP", TMP_DIR)
    os.environ.setdefault("TEMP", TMP_DIR)


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def read_json(path: str) -> dict | None:
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def write_json(path: str, value: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(value, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def log(message: str) -> None:
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        line = f"{now_iso()} {message}\n"
        with open(BRIDGE_LOG, "a", encoding="utf-8") as fh:
            fh.write(line)
    except OSError:
        pass


def emit(data) -> None:
    sys.stdout.write(json.dumps({"ok": True, "data": data}, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def fail(code: str, message: str) -> int:
    sys.stdout.write(json.dumps(
        {"ok": False, "error": {"code": code, "message": message}},
        ensure_ascii=False,
    ) + "\n")
    sys.stdout.flush()
    return 1


def pid_alive(pid: int | None) -> bool:
    """Cross-platform liveness probe.

    ``os.kill(pid, 0)`` is NOT safe on Windows: Python forwards any signal
    other than CTRL_C/CTRL_BREAK to ``TerminateProcess``, so a "probe" would
    kill the very daemon it is checking. Use Win32 ``OpenProcess`` instead.
    """
    if not pid:
        return False
    if os.name == "nt":
        import ctypes

        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            ok = kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
            return bool(ok) and code.value == STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def edge_path() -> str | None:
    """Resolve the browser binary to drive.

    Priority: ``DOUYIN_BROWSER`` → ``DOUYIN_EDGE_PATH`` (injected by the plugin
    from ``config.edgePath``) → known system paths → Playwright's own Chromium
    under its versioned cache directory.
    """
    for env_name in ("DOUYIN_BROWSER", "DOUYIN_EDGE_PATH"):
        override = (os.environ.get(env_name) or "").strip()
        if override and os.path.isfile(override):
            return override
    for candidate in EDGE_CANDIDATES:
        if os.path.isfile(candidate):
            return candidate
    for pattern in PW_CHROMIUM_GLOBS:
        hits = sorted(glob.glob(os.path.expanduser(pattern)))
        if hits:
            return hits[-1]
    return None


def load_state() -> dict | None:
    return read_json(STATE_FILE)


def save_state(state: dict) -> None:
    state["updated_at"] = now_iso()
    write_json(STATE_FILE, state)


def terminal(phase: str | None) -> bool:
    return phase in {"logged_in", "expired", "failed", "stopped"}


# ---------------------------------------------------------------------------
# Playwright helpers
# ---------------------------------------------------------------------------

def resolve_headless(requested: bool) -> bool:
    """Decide headed vs headless for this host.

    Windows keeps the caller's request: the login state machine needs a real
    window a human can scan. A Linux server usually has no X server, where a
    headed launch dies with "Looks like you launched a headed browser without
    having a XServer running" — there we fall back to headless so the QR
    screenshot written by the daemon stays usable. ``DOUYIN_HEADLESS`` pins the
    answer explicitly (1/0, true/false, yes/no).
    """
    override = os.environ.get("DOUYIN_HEADLESS", "").strip().lower()
    if override in {"1", "true", "yes", "on"}:
        return True
    if override in {"0", "false", "no", "off"}:
        return False
    if os.name == "nt":
        return requested
    if os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"):
        return requested
    return True


def launch_context(playwright, headless: bool = False):
    """Launch the configured browser with a dedicated persistent profile."""
    ensure_dirs()
    exe = edge_path()
    if exe is None:
        raise RuntimeError(
            "未找到可用浏览器。Windows 请安装 Edge，Linux/macOS 请安装 Chromium 或 Chrome，"
            "或运行 `playwright install chromium`，"
            "或用 DOUYIN_BROWSER 指定可执行文件绝对路径。"
        )
    kwargs = {
        "user_data_dir": PROFILE_DIR,
        "executable_path": exe,
        "headless": resolve_headless(headless),
        "args": [
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-sync",
            "--disable-blink-features=AutomationControlled",
            "--lang=zh-CN",
        ],
        "viewport": {"width": 1280, "height": 900},
        "locale": "zh-CN",
        "timezone_id": "Asia/Shanghai",
    }
    try:
        context = playwright.chromium.launch_persistent_context(**kwargs)
    except Exception as exc:
        # A previous run may have left Edge processes holding the dedicated
        # profile (Playwright's close can race with Edge's own shutdown).
        # Only processes whose command line names THIS profile are touched.
        log(f"launch failed, cleaning orphan Edge for this profile: {exc}")
        kill_profile_browsers()
        time.sleep(2)
        context = playwright.chromium.launch_persistent_context(**kwargs)
    context.add_init_script(STEALTH_JS)
    return context


def kill_profile_browsers() -> None:
    """Kill only browser processes that use the plugin's dedicated profile."""
    if not os.path.isdir(PROFILE_DIR):
        return
    if os.name != "nt":
        # POSIX: `pkill -f` matches the full command line, so only processes
        # launched with THIS profile path (i.e. ours) are terminated.
        try:
            subprocess.run(["pkill", "-f", PROFILE_DIR], capture_output=True, timeout=20)
        except Exception as exc:
            log(f"kill_profile_browsers failed: {exc}")
        return
    quoted = PROFILE_DIR.replace("'", "''")
    script = (
        "$p = Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | "
        f"Where-Object {{ $_.CommandLine -like '*{quoted}*' }}; "
        "$p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
    )
    try:
        subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True, timeout=25,
        )
    except Exception as exc:
        log(f"kill_profile_browsers failed: {exc}")


PAGE_PROBE = r"""
() => {
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && s.display !== 'none' && s.visibility !== 'hidden';
  };
  const txt = (document.body && document.body.innerText) || '';
  const inputs = Array.from(document.querySelectorAll('input'));
  const codeInput = inputs.find((i) => /验证码/.test(i.placeholder || '') && visible(i));
  const phoneInput = inputs.find((i) => /手机号/.test(i.placeholder || '') && visible(i));
  const qr = Array.from(document.querySelectorAll('canvas, img, div'))
    .some((el) => visible(el) && (
      /qrcode|qr-code|qr_code|login-qr/i.test(el.className || '') ||
      /qrcode|qr/i.test(el.getAttribute('src') || '')
    ));
  const security = /安全验证|拖动滑块|请完成验证|人机验证|身份验证|验证失败/.test(txt);
  const loginTab = /验证码登录/.test(txt);
  return {
    url: location.href,
    hasUserLogin: localStorage.getItem('HasUserLogin'),
    codeInput: !!codeInput,
    phoneLen: phoneInput ? (phoneInput.value || '').length : 0,
    qr,
    security,
    loginTab,
    text: txt.slice(0, 400),
  };
}
"""


def page_phase(page) -> dict:
    try:
        return page.evaluate(PAGE_PROBE)
    except Exception:
        return {"url": "", "hasUserLogin": None, "codeInput": False,
                "phoneLen": 0, "qr": False, "security": False,
                "loginTab": False, "text": ""}


def cookie_has_session(context) -> bool:
    try:
        cookies = context.cookies()
    except Exception:
        return False
    names = {c.get("name") for c in cookies}
    return bool(names & {"sessionid", "sessionid_ss"})


def storage_state_to_dy_cookie(context) -> None:
    """Write the storage_state where dy-cli's from_config() looks for it."""
    ensure_dirs()
    os.makedirs(os.path.dirname(COOKIE_FILE), exist_ok=True)
    tmp = COOKIE_FILE + ".tmp"
    context.storage_state(path=tmp)
    os.replace(tmp, COOKIE_FILE)
    try:
        os.chmod(COOKIE_FILE, 0o600)
    except OSError:
        pass


def collect_identity(page) -> tuple[dict | None, list]:
    """Read self identity and recent works from the creator center.

    ``www.douyin.com/user/self`` is unreliable for this: the SPA often keeps
    the previous profile's DOM, which yields another creator's sec_uid. The
    creator center exposes the authenticated account explicitly through
    ``/web/api/media/user/info/`` and its own work list.
    """
    captured: dict[str, dict] = {}

    def on_response(response) -> None:
        url = response.url.split("?")[0]
        if not any(part in url for part in (
            "/web/api/media/user/info/",
            "/janus/douyin/creator/pc/work_list",
            "/web/api/creator/item/list",
        )):
            return
        try:
            captured[url] = response.json()
        except Exception:
            pass

    page.on("response", on_response)
    user = None
    works: list = []
    try:
        page.goto("https://creator.douyin.com/creator-micro/home",
                  wait_until="domcontentloaded", timeout=45000)
        page.wait_for_timeout(6000)
        for url, payload in captured.items():
            if "/web/api/media/user/info/" in url and payload.get("user"):
                user = payload["user"]
            if "/pc/work_list" in url:
                works = payload.get("aweme_list") or payload.get("items") or works
            if "/web/api/creator/item/list" in url and not works:
                works = payload.get("items") or payload.get("aweme_list") or works
    except Exception as exc:  # identity is best-effort; never fail login on it
        log(f"collect_identity failed: {exc}")
    return user, works


def works_sample(works: list, limit: int = 10) -> list:
    """Basis for the account fingerprint: title + publish time + work id."""
    sample = []
    for item in works[:limit]:
        if not isinstance(item, dict):
            continue
        title = (item.get("desc") or item.get("title") or item.get("item_title")
                 or item.get("description"))
        created = item.get("create_time") or item.get("create_time_ms")
        ident = item.get("aweme_id") or item.get("id")
        if title is None and created is None and ident is None:
            continue
        sample.append([title, created, ident])
    return sample


def works_fingerprint(works: list, limit: int = 10) -> tuple[str | None, int]:
    """Irreversible digest of the account's recent works (title + time + id)."""
    sample = works_sample(works, limit)
    if not sample:
        return None, 0
    ordered = sorted(sample, key=lambda row: str(row[0]))
    payload = json.dumps(ordered, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest(), len(sample)


def refresh_identity() -> int:
    """Re-read self identity from the creator center and update state."""
    ensure_dirs()
    if not os.path.isfile(COOKIE_FILE):
        return fail("not_authenticated", "Cookie 文件不存在，请先完成 login_start。")
    from playwright.sync_api import sync_playwright
    try:
        with sync_playwright() as pw:
            context = launch_context(pw, headless=False)
            try:
                page = context.pages[0] if context.pages else context.new_page()
                user, works = collect_identity(page)
                fingerprint, count = works_fingerprint(works)
                state = load_state() or {}
                if user:
                    state["sec_uid"] = user.get("sec_uid") or state.get("sec_uid")
                    state["nickname"] = user.get("nickname") or state.get("nickname")
                    state["unique_id"] = user.get("unique_id") or state.get("unique_id")
                if fingerprint:
                    state["works_fingerprint"] = fingerprint
                    state["works_count"] = count
                state.pop("works_sample", None)
                save_state(state)
                emit({
                    "sec_uid": state.get("sec_uid"),
                    "nickname": state.get("nickname"),
                    "unique_id": state.get("unique_id"),
                    "works_fingerprint": fingerprint,
                    "works_count": count,
                })
                return 0
            finally:
                context.close()
    except Exception as exc:
        log(f"refresh_identity failed: {exc}\n{traceback.format_exc()}")
        return fail("backend_unavailable", f"读取账号身份失败：{exc}")


# ---------------------------------------------------------------------------
# Login daemon
# ---------------------------------------------------------------------------

def login_daemon() -> int:
    ensure_dirs()
    existing = load_state()
    if existing and existing.get("pid") and existing["pid"] != os.getpid() \
            and pid_alive(existing.get("pid")) and not terminal(existing.get("phase")):
        log("login daemon refused: another session is alive")
        return 0

    write_json(LOCK_FILE, {"pid": os.getpid(), "started_at": now_iso()})
    state = {
        "pid": os.getpid(),
        "phase": "starting",
        "started_at": now_iso(),
        "screenshot": None,
        "sec_uid": None,
        "nickname": None,
        "verified_via": None,
        "note": None,
        "error": None,
    }
    save_state(state)

    from playwright.sync_api import sync_playwright

    try:
        with sync_playwright() as pw:
            context = launch_context(pw, headless=False)
            page = context.pages[0] if context.pages else context.new_page()
            page.goto("https://creator.douyin.com/",
                      wait_until="domcontentloaded", timeout=45000)
            page.wait_for_timeout(2500)

            deadline = time.time() + 600
            last_shot = 0.0
            last_cookie_check = 0.0
            last_phase = None

            while time.time() < deadline:
                probe = page_phase(page)
                phase = "qrcode"
                if probe.get("security"):
                    phase = "challenge_required"
                elif probe.get("qr") and probe.get("phoneLen", 0) == 0:
                    # The creator card renders the QR panel and the SMS panel
                    # side by side; an untouched phone field means QR is the
                    # active method.
                    phase = "qrcode"
                elif probe.get("codeInput") and probe.get("phoneLen", 0) >= 11:
                    phase = "sms_code_input"
                elif probe.get("codeInput"):
                    phase = "sms_verification"

                # Handle a code submitted through login_submit.
                command = read_json(COMMAND_FILE)
                if command and command.get("action") == "submit_code":
                    codes = str(command.get("codes") or "").strip()
                    command_code = None
                    try:
                        if codes and probe.get("codeInput"):
                            filled = page.evaluate(
                                """(code) => {
                                    const inputs = Array.from(document.querySelectorAll('input'));
                                    const target = inputs.find((i) => /验证码/.test(i.placeholder || ''));
                                    if (!target) return false;
                                    target.focus();
                                    target.value = code;
                                    target.dispatchEvent(new Event('input', {bubbles: true}));
                                    target.dispatchEvent(new Event('change', {bubbles: true}));
                                    return true;
                                }""",
                                codes,
                            )
                            if filled:
                                try:
                                    page.locator(
                                        'button:has-text("登录"), [class*="login-btn"], [class*="submit"]'
                                    ).last.click(timeout=5000)
                                except Exception:
                                    page.keyboard.press("Enter")
                                page.wait_for_timeout(2500)
                                command_code = "submitted"
                        else:
                            command_code = "not_in_sms_phase"
                    except Exception as exc:
                        command_code = f"submit_failed: {exc}"
                    finally:
                        try:
                            os.remove(COMMAND_FILE)
                        except OSError:
                            pass
                    if command_code:
                        state["note"] = f"code_submit:{command_code}"
                        save_state(state)

                # Detect an authenticated session.
                login_signal = (
                    "creator-micro" in (probe.get("url") or "")
                    or probe.get("hasUserLogin") in {"1", "true", "True"}
                )
                if not login_signal and time.time() - last_cookie_check > 5:
                    last_cookie_check = time.time()
                    if cookie_has_session(context):
                        verify = context.new_page()
                        try:
                            verify.goto("https://www.douyin.com/",
                                        wait_until="domcontentloaded", timeout=30000)
                            verify.wait_for_timeout(2500)
                            vprobe = page_phase(verify)
                            if vprobe.get("hasUserLogin") in {"1", "true", "True"}:
                                login_signal = True
                                probe = vprobe
                        except Exception as exc:
                            log(f"verify page failed: {exc}")
                        finally:
                            if not login_signal:
                                try:
                                    verify.close()
                                except Exception:
                                    pass
                            else:
                                page = verify

                if login_signal:
                    state["phase"] = "logging_in"
                    save_state(state)
                    page.goto("https://www.douyin.com/",
                              wait_until="domcontentloaded", timeout=30000)
                    page.wait_for_timeout(2500)
                    final = page_phase(page)
                    user, works = collect_identity(page)
                    sec_uid = user.get("sec_uid") if user else None
                    nickname = user.get("nickname") if user else None
                    fingerprint, count = works_fingerprint(works)
                    storage_state_to_dy_cookie(context)
                    verified = "localStorage.HasUserLogin" if final.get("hasUserLogin") in {"1", "true", "True"} else None
                    if verified is None and cookie_has_session(context):
                        verified = "cookie:sessionid"
                    state.update({
                        "phase": "logged_in",
                        "sec_uid": sec_uid,
                        "nickname": nickname,
                        "unique_id": user.get("unique_id") if user else None,
                        "works_fingerprint": fingerprint,
                        "works_count": count,
                        "verified_via": verified,
                        "note": None if verified else "logged_in_unverified",
                        "screenshot": QR_FILE if os.path.isfile(QR_FILE) else None,
                        "url": page.url,
                    })
                    state.pop("works_sample", None)
                    save_state(state)
                    context.close()
                    return 0

                state["phase"] = phase
                state["url"] = probe.get("url")
                if phase != last_phase:
                    log(f"phase -> {phase}")
                    last_phase = phase
                if time.time() - last_shot > 4:
                    last_shot = time.time()
                    try:
                        page.screenshot(path=QR_FILE, full_page=False)
                        state["screenshot"] = QR_FILE
                    except Exception as exc:
                        log(f"screenshot failed: {exc}")
                save_state(state)
                time.sleep(1.0)

            state.update({
                "phase": "expired",
                "error": "登录等待超时（10 分钟）。请重新调用 login_start。",
            })
            save_state(state)
            context.close()
            return 0

    except Exception as exc:
        log(f"login daemon failed: {exc}\n{traceback.format_exc()}")
        state.update({"phase": "failed", "error": str(exc)})
        save_state(state)
        return 1
    finally:
        lock = read_json(LOCK_FILE)
        if lock and lock.get("pid") == os.getpid():
            try:
                os.remove(LOCK_FILE)
            except OSError:
                pass


# ---------------------------------------------------------------------------
# Login status / submit
# ---------------------------------------------------------------------------

def login_status() -> int:
    ensure_dirs()
    state = load_state()
    alive = bool(state and pid_alive(state.get("pid")))
    if state and not alive and not terminal(state.get("phase")):
        state["phase"] = "stopped"
        state["note"] = "login daemon is no longer running"
    cookie_present = os.path.isfile(COOKIE_FILE)
    screenshot = None
    if state and state.get("phase") in {"qrcode", "sms_verification", "sms_code_input", "challenge_required"}:
        screenshot = QR_FILE if os.path.isfile(QR_FILE) else None
    emit({
        "phase": (state or {}).get("phase") or "idle",
        "alive": alive,
        "pid": (state or {}).get("pid"),
        "started_at": (state or {}).get("started_at"),
        "updated_at": (state or {}).get("updated_at"),
        "screenshot": screenshot,
        "sec_uid": (state or {}).get("sec_uid"),
        "nickname": (state or {}).get("nickname"),
        "verified_via": (state or {}).get("verified_via"),
        "note": (state or {}).get("note"),
        "error": (state or {}).get("error"),
        "cookie_present": cookie_present,
    })
    return 0


def login_submit(codes: str) -> int:
    ensure_dirs()
    state = load_state()
    if not state or not pid_alive(state.get("pid")) or terminal(state.get("phase")):
        return fail("not_authenticated", "没有正在进行的登录会话，请先调用 login_start。")
    phase = state.get("phase")
    if phase not in {"sms_verification", "sms_code_input", "challenge_required", "qrcode"}:
        return fail("invalid_args", f"当前登录阶段是 {phase}，不接受验证码。")
    if not re.fullmatch(r"\d{4,8}", codes.strip()):
        return fail("invalid_args", "验证码必须是 4-8 位数字。")
    write_json(COMMAND_FILE, {"action": "submit_code", "codes": codes.strip(), "at": now_iso()})
    before = state.get("note")
    deadline = time.time() + 25
    while time.time() < deadline:
        time.sleep(1.0)
        state = load_state() or {}
        if state.get("phase") == "logged_in":
            break
        if state.get("note") and state.get("note") != before:
            break
    return login_status()


# ---------------------------------------------------------------------------
# Browser read/write helpers
# ---------------------------------------------------------------------------

def _ensure_logged_in(page, context) -> bool:
    page.goto("https://www.douyin.com/", wait_until="domcontentloaded", timeout=30000)
    page.wait_for_timeout(2500)
    probe = page_phase(page)
    if probe.get("hasUserLogin") in {"1", "true", "True"}:
        return True
    return cookie_has_session(context)


def scrape_comments(page, aweme_id: str, count: int) -> list:
    page.goto(f"https://www.douyin.com/video/{aweme_id}",
              wait_until="domcontentloaded", timeout=45000)
    page.wait_for_timeout(6000)
    for _ in range(max(0, min(3, count // 10 - 1))):
        page.evaluate("window.scrollBy(0, 800)")
        page.wait_for_timeout(1800)
    return page.evaluate(
        """(limit) => {
            const items = document.querySelectorAll('[data-e2e="comment-item"]');
            const out = [];
            items.forEach((item) => {
                const lines = (item.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
                if (lines.length < 2) return;
                let text = '';
                for (let i = 1; i < lines.length; i++) {
                    const line = lines[i];
                    if (line === '作者' || line === '...' || line === '展开' || line.length < 2) continue;
                    if (/^\\d+[天时分秒]前/.test(line) || /^\\d{4}/.test(line) || line.includes('·')) break;
                    text = line;
                    break;
                }
                let digg = null;
                const last = lines[lines.length - 1];
                if (/^\\d+$/.test(last)) digg = parseInt(last, 10);
                if (text) out.push({
                    user: {nickname: lines[0] || null},
                    text,
                    digg_count: digg,
                    is_author: lines.includes('作者'),
                });
            });
            return out.slice(0, limit);
        }""",
        max(0, count),
    )


def browser_video(aweme_id: str, comment_limit: int) -> int:
    """Read a video page and capture the signed XHR payloads it already makes.

    The web detail endpoint fails for this account through the reverse-API
    client, but the logged-in page performs the same request with a valid
    signature. Capturing the response avoids re-implementing that signature.
    """
    ensure_dirs()
    if not os.path.isfile(COOKIE_FILE):
        return fail("not_authenticated", "Cookie 文件不存在，请先完成 login_start。")
    from playwright.sync_api import sync_playwright

    captured: dict[str, dict] = {}

    def on_response(response) -> None:
        url = response.url.split("?")[0]
        if "/aweme/detail/" not in url and "/comment/list/" not in url:
            return
        try:
            captured[url] = response.json()
        except Exception:
            pass

    try:
        with sync_playwright() as pw:
            context = launch_context(pw, headless=False)
            try:
                page = context.pages[0] if context.pages else context.new_page()
                page.on("response", on_response)
                page.goto(f"https://www.douyin.com/video/{aweme_id}",
                          wait_until="domcontentloaded", timeout=45000)
                detail = None
                deadline = time.time() + 15
                while time.time() < deadline:
                    page.wait_for_timeout(600)
                    for url, payload in captured.items():
                        if "/aweme/detail/" in url and payload.get("aweme_detail"):
                            detail = payload["aweme_detail"]
                            break
                    if detail is not None:
                        break
                page.wait_for_timeout(2000)
                comments: list = []
                total = None
                for url, payload in captured.items():
                    if "/comment/list/" in url:
                        rows = payload.get("comments") or []
                        if rows:
                            comments = rows
                            total = payload.get("total")
                            break
                if not comments and comment_limit > 0:
                    page.evaluate("window.scrollBy(0, 900)")
                    page.wait_for_timeout(2500)
                    for url, payload in captured.items():
                        if "/comment/list/" in url and payload.get("comments"):
                            comments = payload["comments"]
                            total = payload.get("total")
                            break
                if not detail:
                    return fail("parse_failed", f"未捕获到视频 {aweme_id} 的详情响应（页面可能需要验证或视频不可见）。")
                emit({
                    "video": detail,
                    "comments": comments[:max(0, comment_limit)],
                    "comment_total": total,
                    "source": "browser_xhr",
                })
                return 0
            finally:
                context.close()
    except Exception as exc:
        log(f"browser_video failed: {exc}\n{traceback.format_exc()}")
        return fail("backend_unavailable", f"浏览器读取视频失败：{exc}")


def browser_user(sec_uid: str, post_limit: int) -> int:
    """Read a creator page and capture its signed profile/posts XHRs.

    dy-cli's reverse client gets HTTP 403 from /aweme/post/ for this account;
    the logged-in page performs the same request with a valid signature.
    """
    ensure_dirs()
    if not os.path.isfile(COOKIE_FILE):
        return fail("not_authenticated", "Cookie 文件不存在，请先完成 login_start。")
    from playwright.sync_api import sync_playwright

    captured: dict[str, dict] = {}

    def on_response(response) -> None:
        url = response.url.split("?")[0]
        if "/aweme/post/" not in url and "/user/profile/other/" not in url:
            return
        try:
            captured[url] = response.json()
        except Exception:
            pass

    try:
        with sync_playwright() as pw:
            context = launch_context(pw, headless=False)
            try:
                page = context.pages[0] if context.pages else context.new_page()
                page.on("response", on_response)
                page.goto(f"https://www.douyin.com/user/{sec_uid}",
                          wait_until="domcontentloaded", timeout=45000)
                page.wait_for_timeout(6000)
                posts: list = []
                profile = None
                has_more = None
                cursor = None
                deadline = time.time() + 8
                while time.time() < deadline:
                    for url, payload in captured.items():
                        if "/aweme/post/" in url and payload.get("aweme_list"):
                            posts = payload["aweme_list"]
                            has_more = payload.get("has_more")
                            cursor = payload.get("max_cursor")
                        if "/user/profile/other/" in url and payload.get("user"):
                            profile = payload["user"]
                    if posts or profile:
                        break
                    page.wait_for_timeout(700)
                if not posts and post_limit > 0:
                    page.evaluate("window.scrollBy(0, 900)")
                    page.wait_for_timeout(3000)
                    for url, payload in captured.items():
                        if "/aweme/post/" in url and payload.get("aweme_list"):
                            posts = payload["aweme_list"]
                            has_more = payload.get("has_more")
                            cursor = payload.get("max_cursor")
                            break
                if not profile and not posts:
                    return fail("parse_failed", f"未捕获到用户 {sec_uid} 的资料或作品响应。")
                emit({
                    "user": profile,
                    "posts": posts[:max(0, post_limit)],
                    "has_more": has_more,
                    "next_cursor": cursor,
                    "source": "browser_xhr",
                })
                return 0
            finally:
                context.close()
    except Exception as exc:
        log(f"browser_user failed: {exc}\n{traceback.format_exc()}")
        return fail("backend_unavailable", f"浏览器读取用户失败：{exc}")


def manual_verify(url: str, seconds: int) -> int:
    """Open the dedicated profile for a human to clear a challenge.

    The plugin never solves a captcha itself. This command only makes the
    affected page visible in the isolated profile, screenshots it for the
    caller, and polls until the security text disappears or time runs out.
    """
    ensure_dirs()
    from playwright.sync_api import sync_playwright
    shot = os.path.join(DATA, "manual-verify.png")
    try:
        with sync_playwright() as pw:
            context = launch_context(pw, headless=False)
            try:
                page = context.pages[0] if context.pages else context.new_page()
                page.goto(url, wait_until="domcontentloaded", timeout=45000)
                deadline = time.time() + max(20, min(600, seconds))
                calm = 0
                started = time.time()
                while time.time() < deadline:
                    probe = page_phase(page)
                    try:
                        page.screenshot(path=shot, full_page=False)
                    except Exception:
                        pass
                    if probe.get("security"):
                        calm = 0
                    else:
                        calm += 1
                        if calm >= 2 and time.time() - started > 3:
                            emit({
                                "verified": True,
                                "screenshot": shot,
                                "elapsed_ms": int((time.time() - started) * 1000),
                                "url": page.url,
                            })
                            return 0
                    time.sleep(1.5)
                emit({
                    "verified": False,
                    "screenshot": shot,
                    "elapsed_ms": int((time.time() - started) * 1000),
                    "url": page.url,
                    "note": "等待超时；若已手动完成验证，请直接重试原工具。",
                })
                return 0
            finally:
                context.close()
    except Exception as exc:
        log(f"manual_verify failed: {exc}\n{traceback.format_exc()}")
        return fail("backend_unavailable", f"打开验证页面失败：{exc}")


def browser_comments(aweme_id: str, count: int) -> int:
    ensure_dirs()
    if not os.path.isfile(COOKIE_FILE):
        return fail("not_authenticated", "Cookie 文件不存在，请先完成 login_start。")
    from playwright.sync_api import sync_playwright
    try:
        with sync_playwright() as pw:
            context = launch_context(pw, headless=False)
            try:
                page = context.pages[0] if context.pages else context.new_page()
                if not _ensure_logged_in(page, context):
                    return fail("not_authenticated", "登录态不可用，请重新扫码。")
                comments = scrape_comments(page, aweme_id, count)
                emit({"comments": comments, "count": len(comments)})
                return 0
            finally:
                context.close()
    except Exception as exc:
        log(f"browser_comments failed: {exc}\n{traceback.format_exc()}")
        return fail("backend_unavailable", f"浏览器评论抓取失败：{exc}")


def browser_comment(aweme_id: str, content: str) -> int:
    ensure_dirs()
    if not os.path.isfile(COOKIE_FILE):
        return fail("not_authenticated", "Cookie 文件不存在，请先完成 login_start。")
    from playwright.sync_api import sync_playwright
    try:
        with sync_playwright() as pw:
            context = launch_context(pw, headless=False)
            try:
                page = context.pages[0] if context.pages else context.new_page()
                if not _ensure_logged_in(page, context):
                    return fail("not_authenticated", "登录态不可用，请重新扫码。")
                page.goto(f"https://www.douyin.com/video/{aweme_id}",
                          wait_until="domcontentloaded", timeout=45000)
                page.wait_for_timeout(6000)
                for _ in range(8):
                    if page.locator('[data-e2e="video-player-digg"]').count() > 0:
                        break
                    page.wait_for_timeout(1000)
                clicked = page.evaluate(
                    """(content) => {
                        const icon = document.querySelector('[data-e2e="feed-comment-icon"]');
                        if (icon) icon.click();
                        const sels = [
                            '[data-e2e="comment-input"]',
                            '[class*="comment"] [contenteditable="true"]',
                            '[placeholder*="善语结善缘"]',
                            '[placeholder*="说点什么"]',
                        ];
                        let input = null;
                        for (const s of sels) {
                            const el = document.querySelector(s);
                            if (el) { input = el; break; }
                        }
                        if (!input) return {ok: false, reason: 'input_not_found'};
                        input.focus();
                        if (input.isContentEditable) {
                            input.textContent = content;
                        } else {
                            input.value = content;
                        }
                        input.dispatchEvent(new Event('input', {bubbles: true}));
                        input.dispatchEvent(new Event('change', {bubbles: true}));
                        return {ok: true, reason: 'filled'};
                    }""",
                    content,
                )
                if not clicked.get("ok"):
                    return fail("parse_failed", f"未找到评论输入框（{clicked.get('reason')}）。")
                page.wait_for_timeout(800)
                submitted = page.evaluate(
                    """() => {
                        const buttons = Array.from(document.querySelectorAll(
                            '[data-e2e="comment-post"], button'
                        ));
                        const send = buttons.find((b) => {
                            const t = (b.innerText || '').trim();
                            return (b.getAttribute('data-e2e') === 'comment-post' || t === '发布' || t === '发送')
                                && !b.disabled;
                        });
                        if (!send) return false;
                        send.click();
                        return true;
                    }"""
                )
                if not submitted:
                    page.keyboard.press("Enter")
                page.wait_for_timeout(2500)
                body = page.evaluate("() => (document.body.innerText || '').slice(0, 5000)")
                evidence = None
                if content[:12] and content[:12] in body:
                    evidence = "comment text visible in page"
                emit({"sent": True, "aweme_id": aweme_id, "evidence": evidence})
                return 0
            finally:
                context.close()
    except Exception as exc:
        log(f"browser_comment failed: {exc}\n{traceback.format_exc()}")
        return fail("backend_unavailable", f"浏览器评论失败：{exc}")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> int:
    ensure_dirs()
    parser = argparse.ArgumentParser(description="DSH Douyin Playwright bridge")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("login-daemon", help="detached login driver")
    sub.add_parser("login-status", help="report login state")
    sub.add_parser("identity", help="re-read sec_uid for a logged-in profile")
    submit = sub.add_parser("login-submit", help="submit an SMS code")
    submit.add_argument("--codes", required=True)
    status = sub.add_parser("status", help="static capability probe")
    status.add_argument("--json", action="store_true")

    comments = sub.add_parser("comments", help="scrape comments with Edge")
    comments.add_argument("--aweme-id", required=True)
    comments.add_argument("--count", type=int, default=20)

    video = sub.add_parser("video", help="capture signed video XHR with Edge")
    video.add_argument("--aweme-id", required=True)
    video.add_argument("--comment-count", type=int, default=0)

    user = sub.add_parser("user", help="capture signed profile/posts XHR with Edge")
    user.add_argument("--sec-uid", required=True)
    user.add_argument("--post-limit", type=int, default=10)

    verify = sub.add_parser("verify", help="open a page for manual challenge completion")
    verify.add_argument("--url", default="https://www.douyin.com/")
    verify.add_argument("--seconds", type=int, default=180)

    comment = sub.add_parser("comment", help="post one comment with Edge")
    comment.add_argument("--aweme-id", required=True)
    comment.add_argument("--content", required=True)

    args = parser.parse_args()

    if args.command == "login-daemon":
        return login_daemon()
    if args.command == "login-status":
        return login_status()
    if args.command == "identity":
        return refresh_identity()
    if args.command == "login-submit":
        return login_submit(args.codes)
    if args.command == "status":
        emit({
            "edge_path": edge_path(),
            "profile_dir": PROFILE_DIR,
            "cookie_present": os.path.isfile(COOKIE_FILE),
            "state": load_state(),
            "pid_alive": pid_alive((load_state() or {}).get("pid")),
        })
        return 0
    if args.command == "comments":
        return browser_comments(args.aweme_id, args.count)
    if args.command == "video":
        return browser_video(args.aweme_id, args.comment_count)
    if args.command == "user":
        return browser_user(args.sec_uid, args.post_limit)
    if args.command == "verify":
        return manual_verify(args.url, args.seconds)
    if args.command == "comment":
        return browser_comment(args.aweme_id, args.content)
    return fail("invalid_args", f"unknown command: {args.command}")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 - last-resort structured failure
        log(f"fatal: {exc}\n{traceback.format_exc()}")
        raise SystemExit(fail("backend_unavailable", f"bridge failed: {exc}"))
