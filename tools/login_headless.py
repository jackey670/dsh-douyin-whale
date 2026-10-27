#!/usr/bin/env python3
"""login_headless.py —— 在**无头**浏览器里出二维码，截图给人扫。

为什么不用有头窗口：
    运行时的私信驱动是 headless + 持久化 profile。如果扫码是在**有头**浏览器里
    完成的，登录态就带着有头那套指纹（WebGL/GPU/窗口），换到 headless 里跑，
    抖音会把它当成「换了设备」，在发送这类敏感动作上直接把会话踢掉。
    实测症状：读消息一直正常，一发私信就掉登录。

    所以登录也必须在**同一个 headless 环境、同一个 profile** 里完成。
    人是看屏幕扫码的，于是把二维码截成 PNG，你用手机扫这个文件就行。

用法：
    python tools/login_headless.py [--timeout 300] [--out <png路径>]

输出：一行 JSON，含 qr 路径、是否已登录、等待结果。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "python"))

import douyin_im as D  # noqa: E402

LOGIN_URL = "https://www.douyin.com/"

# 点开登录弹层：找可见的、文字正好是「登录」的元素
CLICK_LOGIN_JS = r"""
() => {
  const els = Array.from(document.querySelectorAll('div,span,button,a,p'));
  const hit = els.find(e => {
    const t = (e.innerText || '').trim();
    return t === '登录' && e.offsetParent !== null;
  });
  if (hit) { hit.click(); return 'clicked'; }
  return document.body.innerText.includes('扫码登录') ? 'already-open' : 'no-button';
}
"""

QR_READY_JS = r"""
() => {
  const t = (document.body && document.body.innerText) || '';
  const capEl = document.querySelector(
    '[class*="captcha"],[id*="captcha"],[class*="verify"],[id*="verify"]');
  const capFrame = [...document.querySelectorAll('iframe')]
    .some((f) => /captcha|verify|secsdk/i.test(f.src || ''));
  return JSON.stringify({
    qr_text: t.includes('扫码登录') || t.includes('扫一扫') || t.includes('打开「抖音APP」'),
    phone: t.includes('验证码登录'),
    captcha: t.includes('拖动') || t.includes('滑块') || t.includes('拼图')
      || t.includes('验证后继续') || !!capEl || capFrame,
  });
}
"""

# 整页截图里二维码只占一小块，手机很难扫。找页面上最大的“可见正方形”
# （img/canvas），裁出二维码 + 16px 静区；找不到就退回整页截图。
QR_BOX_JS = r"""
() => {
  const vw = innerWidth, vh = innerHeight;
  let best = null;
  for (const el of document.querySelectorAll('img, canvas')) {
    const r = el.getBoundingClientRect();
    if (r.width < 140 || r.height < 140) continue;
    if (Math.abs(r.width - r.height) > Math.max(r.width, r.height) * 0.2) continue;
    if (r.left < 0 || r.top < 0 || r.right > vw || r.bottom > vh) continue;
    const score = r.width * r.height;
    if (!best || score > best.score) best = { score, x: r.left, y: r.top, w: r.width, h: r.height };
  }
  if (!best) return '';
  const pad = 16;
  const x = Math.max(0, Math.floor(best.x - pad));
  const y = Math.max(0, Math.floor(best.y - pad));
  const w = Math.min(vw - x, Math.ceil(best.w + pad * 2));
  const h = Math.min(vh - y, Math.ceil(best.h + pad * 2));
  return JSON.stringify({ x, y, w, h });
}
"""


async def has_session(ctx) -> bool:
    try:
        cookies = await ctx.cookies("https://www.douyin.com")
        return any(c.get("name") in ("sessionid", "sessionid_ss") for c in cookies)
    except Exception:
        return False


async def session_actually_works(page) -> bool:
    """cookie 存在 ≠ 登录有效。

    抖音会**在服务端作废**会话：sessionid 还在 profile 里，但页面已经要求重新
    扫码。所以判断登录态必须看页面，不能只看 cookie。
    """
    try:
        await page.goto("https://www.douyin.com/chat",
                        wait_until="domcontentloaded", timeout=60_000)
        await page.wait_for_timeout(4_000)
        if await D.any_visible(page, D.LOGIN_MARKERS, 1_500):
            return False
        return True
    except Exception:
        return False


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--timeout", type=int, default=300)
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "im-shots", "login-qr.png"))
    ap.add_argument("--status-file", dest="status_file", default="",
                    help="把阶段状态（qr/waiting/ok/failed）写进这个 JSON，给面板轮询用")
    args = ap.parse_args()

    status_file = os.path.abspath(args.status_file) if args.status_file else ""

    def put_status(patch: dict) -> None:
        """把当前阶段**合并**进状态文件（面板写的 running_pid 不能丢）。"""
        if not status_file:
            return
        try:
            os.makedirs(os.path.dirname(status_file), exist_ok=True)
            cur = {}
            try:
                with open(status_file, encoding="utf-8") as fh:
                    cur = json.load(fh) or {}
            except Exception:
                cur = {}
            cur.update(patch)
            with open(status_file, "w", encoding="utf-8") as fh:
                json.dump(cur, fh, ensure_ascii=False)
        except Exception:
            pass

    out_path = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    result = {"ok": False, "qr": "", "already_logged_in": False, "profile": D.PROFILE_DIR}
    put_status({"phase": "starting", "qr": "", "ok": None})

    async with D.open_browser(None) as page:
        ctx = page.context
        if await session_actually_works(page):
            result.update(ok=True, already_logged_in=True,
                          hint="这个 profile 里的登录态还能用，不用扫码")
            put_status({"phase": "ok", "ok": True, "already_logged_in": True, "qr": ""})
        else:
            # 会话被服务端作废了，但 sessionid 还躺在 profile 里。清掉它们，
            # 否则后面的轮询会把这条**死 cookie** 当成「刚登录成功」。
            try:
                await ctx.clear_cookies()
                result["cleared_stale_cookies"] = True
            except Exception:
                result["cleared_stale_cookies"] = False

            await page.goto(LOGIN_URL, wait_until="domcontentloaded", timeout=60_000)
            await page.wait_for_timeout(3_000)
            clicked = await page.evaluate(CLICK_LOGIN_JS)

            # 等弹层渲染出来（抖音这个面板是异步的，4 秒经常不够）
            ready = {}
            for _ in range(20):
                await page.wait_for_timeout(1_000)
                try:
                    ready = json.loads(await page.evaluate(QR_READY_JS) or "{}")
                except Exception:
                    ready = {}
                if ready.get("qr_text") or ready.get("phone"):
                    break

            # 风控页会直接弹滑块/拼图，无头模式无法完成 —— 别把它当二维码，
            # 也别干等到 timeout。立刻结束，面板会显示 captcha 提示。
            if ready.get("captcha"):
                result["hint"] = (
                    "抖音要求滑块/拼图验证，无头模式无法完成；请用有头窗口运行 "
                    "python tools/export_login_state.py 人工通过后重试"
                )
                put_status({"phase": "failed", "qr": "", "ok": False,
                            "captcha": True, "hint": result["hint"]})
                print(json.dumps({"phase": "failed", "captcha": True,
                                  "hint": result["hint"]}, ensure_ascii=False), flush=True)
                return 1

            # 20 秒都没等到二维码/验证码登录界面：别干等 10 分钟，也别把
            # 风控页当二维码截图。直接失败，让人去有头窗口看。
            if not (ready.get("qr_text") or ready.get("phone")):
                result["hint"] = (
                    "20 秒内没等到二维码/验证码登录界面（可能是滑块/拼图风控或页面改版）；"
                    "请用有头窗口运行 python tools/export_login_state.py 检查并人工完成"
                )
                put_status({"phase": "failed", "qr": "", "ok": False,
                            "captcha": bool(ready.get("captcha")), "hint": result["hint"]})
                print(json.dumps({"phase": "failed", "captcha": bool(ready.get("captcha")),
                                  "hint": result["hint"]}, ensure_ascii=False), flush=True)
                return 1

            # 优先只截二维码；找不到正方形元素再退回整页
            try:
                raw_box = await page.evaluate(QR_BOX_JS)
                box = json.loads(raw_box) if raw_box else {}
            except Exception:
                box = {}
            if box:
                await page.screenshot(path=out_path, clip={
                    "x": box["x"], "y": box["y"],
                    "width": box["w"], "height": box["h"],
                })
                result["qr_cropped"] = True
            else:
                await page.screenshot(path=out_path, full_page=False)
            result.update(qr=out_path, click=clicked, qr_ready=bool(ready.get("qr_text")))
            put_status({"phase": "qr", "qr": out_path, "qr_ready": result["qr_ready"],
                        "captcha": bool(ready.get("captcha")), "ok": None})
            # 先把二维码路径打出来，调用方不用等超时才知道文件在哪
            print(json.dumps({"phase": "qr", "qr": out_path,
                              "qr_ready": result["qr_ready"]}, ensure_ascii=False), flush=True)

            deadline = time.monotonic() + args.timeout
            while time.monotonic() < deadline:
                # 先等 cookie 出现（便宜），再用页面验证一次（贵，别每轮都做）
                if await has_session(ctx):
                    await page.wait_for_timeout(2_000)
                    if await session_actually_works(page):
                        result.update(ok=True)
                        break
                await page.wait_for_timeout(2_000)

            if result["ok"]:
                # 顺便导一份 storage_state 当备份（登录态本来已经在 profile 里了）
                try:
                    state = await ctx.storage_state()
                    bak = os.path.join(D.ROOT, "data", "home", ".dy", "cookies", "default.json")
                    os.makedirs(os.path.dirname(bak), exist_ok=True)
                    with open(bak, "w", encoding="utf-8") as fh:
                        json.dump(state, fh, ensure_ascii=False)
                except Exception:
                    pass
            else:
                result["hint"] = ("没等到登录态。二维码可能过期了，重跑一次；"
                                  "如果扫完卡在短信/滑块，那是要你去手机端完成验证")

    put_status({"phase": "ok" if result.get("ok") else "failed", "ok": bool(result.get("ok")),
                "qr": result.get("qr") or "", "hint": result.get("hint") or ""})
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("ok") else 2


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
