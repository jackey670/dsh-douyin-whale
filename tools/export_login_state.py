#!/usr/bin/env python3
"""export_login_state.py — 在**本地有显示器的电脑**上扫码登录抖音，导出 storage_state。

为什么需要它
------------
服务器（headless）打不开扫码窗口，滑块/短信验证也没法人工操作。正确做法是：

  1. 在自己电脑上跑这个脚本 → 它打开一个真实浏览器窗口；
  2. 用抖音 App 扫码（或短信）登录；
  3. 脚本检测到登录成功后，把 Playwright 的 ``storage_state`` 写到
     ``data/home/.dy/cookies/default.json``；
  4. 把这个文件（**它等同于账号凭证，务必保密**）scp 到服务器上同一个相对位置，
     或在服务器上设 ``DOUYIN_COOKIE_FILE`` 指向它。

这个脚本只读页面状态，不发消息、不点赞、不评论。

用法::

    # 默认写到 <repo>/data/home/.dy/cookies/default.json
    python tools/export_login_state.py

    # 指定输出位置和浏览器
    python tools/export_login_state.py --out ./my-cookies.json \
        --browser "/usr/bin/chromium"

    # 已有可用的浏览器 profile 时，直接从 profile 导出
    python tools/export_login_state.py --profile ./data/im-profile

注意
----
* 需要 ``playwright install chromium``，或者系统里已装 Chrome/Edge。
* 这个文件 = 你的登录凭证。不要提交到 git，不要发到聊天窗口，不要贴进 issue。
* 抖音 cookie 会过期（通常几天到几周）。失效后重跑一次即可。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import stat
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "python"))

import douyin_im as D  # noqa: E402

LOGIN_URL = "https://www.douyin.com/"

# 两个判定条件是"或"的关系：HasUserLogin 更准，sessionid 是兜底。
LOGGED_IN_JS = """() => {
  try {
    if (localStorage.getItem('HasUserLogin') === '1') return 'localStorage';
  } catch (e) {}
  return '';
}"""


def cookies_have_session(cookies) -> bool:
    for c in cookies or []:
        if c.get("name") in {"sessionid", "sessionid_ss", "sid_tt"} and c.get("value"):
            return True
    return False


async def run(args) -> int:
    from playwright.async_api import async_playwright

    exe = args.browser or D.CHROME
    if not exe:
        print("找不到浏览器：请先 `playwright install chromium`，或用 --browser 指定。", file=sys.stderr)
        return 1

    async with async_playwright() as pw:
        if args.profile:
            context = await pw.chromium.launch_persistent_context(
                os.path.abspath(args.profile),
                executable_path=exe,
                headless=False,
                args=["--no-first-run", "--disable-blink-features=AutomationControlled"],
                viewport={"width": 1280, "height": 900},
                locale="zh-CN",
            )
        else:
            browser = await pw.chromium.launch(
                executable_path=exe,
                headless=False,
                args=["--no-first-run", "--disable-blink-features=AutomationControlled"],
            )
            context = await browser.new_context(
                viewport={"width": 1280, "height": 900},
                locale="zh-CN",
                user_agent=D.UA,
            )

        page = context.pages[0] if context.pages else await context.new_page()
        await page.goto(LOGIN_URL, wait_until="domcontentloaded", timeout=60_000)

        print("=" * 60)
        print("浏览器已打开。请在窗口里用抖音 App 扫码登录（或短信登录）。")
        print(f"登录成功后会自动保存，最多等 {args.timeout} 秒。按 Ctrl+C 可中止。")
        print("=" * 60)

        deadline = time.monotonic() + args.timeout
        how = ""
        while time.monotonic() < deadline:
            try:
                how = await page.evaluate(LOGGED_IN_JS)
            except Exception:
                how = ""
            if not how:
                try:
                    if cookies_have_session(await context.cookies()):
                        how = "sessionid cookie"
                except Exception:
                    pass
            if how:
                break
            await page.wait_for_timeout(1_500)

        if not how:
            print("超时：没有检测到登录态。请重试，或确认页面没有被安全验证挡住。", file=sys.stderr)
            await context.close()
            return 1

        # 登录后稍等，让跳转把剩余的 cookie 种完
        await page.wait_for_timeout(2_500)
        state = await context.storage_state()

        out = os.path.abspath(os.path.expanduser(args.out))
        os.makedirs(os.path.dirname(out), exist_ok=True)
        with open(out, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False, indent=2)
        try:
            os.chmod(out, stat.S_IRUSR | stat.S_IWUSR)  # 0600
        except OSError:
            pass

        n_cookies = len(state.get("cookies") or [])
        n_origins = len(state.get("origins") or [])
        nickname = ""
        try:
            nickname = await page.evaluate(
                """() => {
                  const el = document.querySelector('[data-e2e="user-info"] img, [class*="avatar"] img');
                  return el ? (el.getAttribute('alt') || '') : '';
                }"""
            )
        except Exception:
            pass

        await context.close()

    print("\n登录成功：" + how)
    if nickname:
        print("昵称：" + nickname)
    print(f"已写入：{out}")
    print(f"cookie 条数：{n_cookies}，localStorage origin：{n_origins}")
    print("\n下一步：")
    print("  1) 把该文件放到服务器（DOUYIN_DATA_DIR 之下）：")
    print("     scp <本地文件> user@host:~/dsh-douyin/data/home/.dy/cookies/default.json")
    print("  2) chmod 600 它，并确保不要提交进 git。")
    print("  3) 在服务器上调用 /im/status 或 douyin_status 验证。")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Login to Douyin locally and export storage_state")
    ap.add_argument("--out", default=os.path.join(
        ROOT, "data", "home", ".dy", "cookies", "default.json"),
        help="输出文件（默认 data/home/.dy/cookies/default.json）")
    ap.add_argument("--browser", default="", help="浏览器可执行文件（默认自动发现）")
    ap.add_argument("--profile", default="", help="从已有的 persistent profile 打开并导出")
    ap.add_argument("--timeout", type=int, default=300, help="等待登录的秒数（默认 300）")
    args = ap.parse_args()

    try:
        return asyncio.run(run(args))
    except KeyboardInterrupt:
        print("\n已中止。", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
