#!/usr/bin/env python3
"""probe_im.py — 探查抖音网页版私信/群聊的 DOM 结构（只读，不发消息）。

用途：抖音前端改版后，``douyin_im.py`` 里的选择器可能失效。这个脚本会打开
若干页面，把候选元素的 class / placeholder / aria-label 以及页面文本 dump
成 JSON，用来对照着改 ``douyin_im.py`` 顶部的选择器常量。

它是纯只读的：不点「发送」、不填输入框、不注入任何内容。

用法::

    # 默认探查三个入口（首页 / 消息页 / 私信页）
    python tools/probe_im.py

    # 只探一个页面，并把截图和 JSON 放到指定目录
    python tools/probe_im.py --url https://www.douyin.com/chat --out ./probe-out

注意：需要一份有效的登录 cookie（storage_state），否则只能看到登录墙。
cookie 的导出方式见 ``docs/COOKIE-GUIDE.md``。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys

from playwright.async_api import async_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "python"))

import douyin_im as D  # noqa: E402

DEFAULT_TARGETS = [
    ("home", "https://www.douyin.com/"),
    ("message", "https://www.douyin.com/user/self?showTab=message"),
    ("chat", "https://www.douyin.com/chat"),
]

MSG_JS = """
() => {
  const out = [];
  for (const el of document.querySelectorAll('*')) {
    const t = (el.childElementCount === 0 ? el.textContent : '').trim();
    if (!t || t.length > 20) continue;
    if (/消息|私信|聊天|朋友/.test(t)) {
      out.push({tx: t, tag: el.tagName, cls: (el.className || '').toString().slice(0, 120),
                id: el.id || '', aria: el.getAttribute('aria-label') || ''});
      if (out.length > 40) break;
    }
  }
  return out;
}
"""

INPUT_JS = """
() => [...document.querySelectorAll('input,textarea,[contenteditable="true"]')].slice(0, 12)
  .map(e => ({tag: e.tagName, type: e.type || '', ph: e.getAttribute('placeholder') || '',
              cls: (e.className || '').toString().slice(0, 100)}))
"""


async def dump(page, tag: str) -> dict:
    info = {"tag": tag, "url": page.url}
    try:
        info["title"] = await page.title()
    except Exception as e:
        info["title"] = "ERR " + str(e)[:120]
    try:
        info["body_text"] = (await page.inner_text("body"))[:1500]
    except Exception as e:
        info["body_text"] = "ERR " + str(e)[:200]
    try:
        info["links"] = await page.eval_on_selector_all(
            "a",
            'els => els.slice(0, 60).map(e => ({t: (e.innerText || "").trim().slice(0, 40), h: e.getAttribute("href")})).filter(x => x.t || x.h)',
        )
    except Exception:
        info["links"] = []
    for key, script in (("msg_els", MSG_JS), ("inputs", INPUT_JS)):
        try:
            info[key] = await page.evaluate(script)
        except Exception as e:
            info[key] = "ERR " + str(e)[:200]
    try:
        info["has_login_modal"] = await page.evaluate(
            """() => {
              const t = document.body ? document.body.innerText : '';
              return {qr: /扫码登录|二维码登录|手机号登录/.test(t),
                      login_word: /登录/.test(t)};
            }"""
        )
    except Exception as e:
        info["has_login_modal"] = "ERR " + str(e)[:120]
    return info


async def main() -> int:
    ap = argparse.ArgumentParser(description="Probe Douyin web IM DOM (read-only)")
    ap.add_argument("--url", action="append", default=None,
                    help="要探查的 URL，可重复；默认探查首页/消息页/私信页")
    ap.add_argument("--out", default=os.environ.get("DOUYIN_PROBE_OUT")
                    or os.path.join(ROOT, "data", "probe"),
                    help="输出目录（截图 + probe.json）")
    args = ap.parse_args()

    if not D.CHROME:
        print("未找到可用浏览器：请安装 Chromium，或设置 DOUYIN_BROWSER", file=sys.stderr)
        return 1

    targets = [(f"custom{i}", u) for i, u in enumerate(args.url)] if args.url else DEFAULT_TARGETS
    cookie_file = D.find_cookie_file()
    os.makedirs(args.out, exist_ok=True)

    results = []
    async with async_playwright() as pw:
        ctx_kwargs = dict(viewport={"width": 1440, "height": 900}, locale="zh-CN")
        if cookie_file:
            ctx_kwargs["storage_state"] = cookie_file
        browser = await pw.chromium.launch(
            executable_path=D.CHROME,
            headless=D.resolve_headless(),
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        ctx = await browser.new_context(**ctx_kwargs)
        page = await ctx.new_page()
        for tag, url in targets:
            try:
                await page.goto(url, wait_until="domcontentloaded", timeout=45_000)
                await page.wait_for_timeout(6_000)
                results.append(await dump(page, tag))
                await page.screenshot(path=os.path.join(args.out, tag + ".png"))
            except Exception as e:
                results.append({"tag": tag, "url": url, "error": str(e)[:300]})
        await browser.close()

    out_file = os.path.join(args.out, "probe.json")
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print(json.dumps(results, ensure_ascii=False, indent=2)[:7000])
    print(f"\n已写入：{out_file}")
    print(f"cookie：{cookie_file or '未找到（只能看到登录墙）'}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
