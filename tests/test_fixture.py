"""在本地 fixture（模拟抖音私信 DOM）上验证 dry-run / 发送 / 群名匹配逻辑。

这个测试**不接触真实抖音账号、不联网、不发送任何真实消息**：它加载
``tests/fixture_chat.html``（一份手写的 DOM 仿真页），然后驱动真实的
``douyin_im.py`` 里的函数去操作它。

运行：
    python tests/test_fixture.py

需要 playwright 已安装，并且能找到 Chromium（``DOUYIN_BROWSER`` 或自动发现）。
退出码 0 表示所有断言通过。
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "python"))

import douyin_im as D  # noqa: E402
from playwright.async_api import async_playwright  # noqa: E402

FIXTURE = (os.path.join(HERE, "fixture_chat.html")).replace(os.sep, "/")
FIXTURE_URL = "file:///" + FIXTURE.lstrip("/")


def check(name: str, condition: bool, detail=None) -> bool:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}")
    if not condition and detail is not None:
        print(f"       {detail}")
    return condition


async def run() -> int:
    out: dict = {}
    failures = 0

    if not D.CHROME:
        print("[FAIL] 未找到可用浏览器：请安装 Chromium，或设置 DOUYIN_BROWSER")
        return 1

    shot_dir = os.environ.get("DOUYIN_TEST_SHOTS") or os.path.join(tempfile.gettempdir(), "douyin-fixture-shots")
    os.makedirs(shot_dir, exist_ok=True)

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            executable_path=D.CHROME,
            headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        ctx = await browser.new_context(viewport={"width": 1280, "height": 800}, locale="zh-CN")
        page = await ctx.new_page()
        await page.goto(FIXTURE_URL, wait_until="domcontentloaded")
        out["fixture"] = FIXTURE_URL

        # 1) 打开会话（走搜索 → 发消息按钮 → 标题确认）
        try:
            title = await D.open_conversation(page, "小测试")
            out["open_conversation"] = {"ok": True, "resolved_title": title}
        except Exception as e:
            out["open_conversation"] = {"ok": False, "error": f"{type(e).__name__}: {e}"}
        failures += 0 if check(
            "open_conversation", out["open_conversation"].get("ok") is True,
            json.dumps(out["open_conversation"], ensure_ascii=False)) else 1

        # 2) dry-run：输入文本、校验输入框、不点发送
        try:
            editor_sel, ready = await D.type_message(page, "这是 dry-run 测试文本")
            out["dry_run_type"] = {
                "editor_selector": editor_sel,
                "publish_button_ready": ready,
                "bubbles_before_clear": await page.locator(".messageMessageBox").count(),
            }
        except Exception as e:
            out["dry_run_type"] = {"ok": False, "error": f"{type(e).__name__}: {e}"}
        failures += 0 if check(
            "dry_run_type", "error" not in out["dry_run_type"],
            json.dumps(out["dry_run_type"], ensure_ascii=False)) else 1

        try:
            cleared = await D.clear_composer(page)
            out["dry_run_clear"] = {
                "cleared": cleared,
                "bubbles_after_clear": await page.locator(".messageMessageBox").count(),
            }
        except Exception as e:
            out["dry_run_clear"] = {"ok": False, "error": str(e)}
        failures += 0 if check("dry_run_clear", out["dry_run_clear"].get("cleared") is True,
                               json.dumps(out["dry_run_clear"], ensure_ascii=False)) else 1

        sent_nothing = (
            out.get("dry_run_type", {}).get("bubbles_before_clear") == 0
            and out.get("dry_run_clear", {}).get("bubbles_after_clear") == 0
        )
        out["dry_run_sent_nothing"] = sent_nothing
        failures += 0 if check("dry_run_sent_nothing", sent_nothing) else 1

        # 3) 真实发送路径（只在 fixture 上，气泡是本地 DOM）
        try:
            await D.type_message(page, "发送路径测试")
            how = await D.trigger_send(page)
            conf = await D.confirm_sent(page, "发送路径测试", timeout_ms=8_000)
            out["send_path"] = {
                "trigger": how,
                "confirm": conf,
                "bubbles_after_send": await page.locator(".messageMessageBox").count(),
            }
        except Exception as e:
            out["send_path"] = {"ok": False, "error": f"{type(e).__name__}: {e}"}
        failures += 0 if check("send_path", out["send_path"].get("confirm", {}).get("bubble_found") is True,
                               json.dumps(out["send_path"], ensure_ascii=False)) else 1

        # 4) 群聊名后缀匹配（"同学群" 命中 "同学群(7)"）
        try:
            t2 = await D.open_conversation(page, "同学群")
            out["group_match"] = {"ok": True, "resolved_title": t2}
        except Exception as e:
            out["group_match"] = {"ok": False, "error": f"{type(e).__name__}: {e}"}
        failures += 0 if check("group_match", out["group_match"].get("ok") is True,
                               json.dumps(out["group_match"], ensure_ascii=False)) else 1

        # 5) 不存在的目标 → NOT_FOUND
        try:
            await D.open_conversation(page, "根本不存在的人")
            out["not_found"] = {"ok": False, "note": "未按预期报错"}
        except D.IMError as e:
            out["not_found"] = {"ok": True, "code": e.code}
        except Exception as e:
            out["not_found"] = {"ok": False, "error": f"{type(e).__name__}: {e}"}
        failures += 0 if check("not_found", out["not_found"].get("code") == "NOT_FOUND") else 1

        out["screenshot"] = os.path.join(shot_dir, "final.png")
        try:
            await page.screenshot(path=out["screenshot"])
        except Exception:
            out["screenshot"] = ""
        await browser.close()

    print(json.dumps(out, ensure_ascii=False, indent=2))
    print(f"\n{'ALL PASSED' if failures == 0 else f'{failures} FAILED'}")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(run()))
    except Exception:
        traceback.print_exc()
        sys.exit(2)
