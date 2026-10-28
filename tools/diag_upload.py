#!/usr/bin/env python3
"""diag_upload.py — 诊断表情包上传卡在「发送中」的原因。

流程：开聊天 → 监听网络请求/响应 → set_input_files → 点「发送 (N)」
→ 等 40 秒，把上传相关请求、响应码、消息气泡状态全部 dump 出来。
只发一条测试图（E2E 已授权），结束后打印诊断 JSON。
"""
from __future__ import annotations

import asyncio
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "python"))

import douyin_im as D  # noqa: E402

TARGET = "漱月鸣筝"
IMG = os.path.join(os.path.expanduser("~"), ".dsh", "meme-packs", "dafeiyu-001",
                   "memes", "happy", "ok.jpg")

NET_JS = r"""
() => {
  // 消息气泡状态：找「我发的」最新气泡附近的文字（发送中/发送失败/已读）
  const bubbles = [...document.querySelectorAll('[class*="isFromMe"]')];
  const last = bubbles[bubbles.length - 1];
  return {
    bubble_text: last ? (last.innerText || '').trim().slice(0, 40) : '',
    bubble_html_snip: last ? last.outerHTML.slice(-300) : '',
    sending_marks: [...document.querySelectorAll('div,span')]
      .map((e) => (e.childElementCount === 0 ? (e.innerText || '').trim() : ''))
      .filter((t) => t === '发送中' || t === '发送失败' || t === '已读' || t === '已送达').length,
  };
}
"""


async def main() -> int:
    net: list[str] = []
    status: dict = {}

    def on_response(resp):
        url = resp.url
        if any(k in url for k in ("upload", "im/resource", "frontier", " SendMessage", "send_msg")) or "tos" in url:
            net.append(f"RESP {resp.status} {resp.request.method} {url[:160]}")

    def on_request(req):
        url = req.url
        if any(k in url for k in ("upload", "im/resource", "frontier", "send_msg", "SendMessage")):
            body = ""
            try:
                if req.method == "POST":
                    body = (req.post_data or "")[:120]
            except Exception:
                pass
            net.append(f"REQ  {req.method} {url[:160]} body={body}")

    async with D.open_browser(None) as page:
        page.on("response", on_response)
        page.on("request", on_request)
        await D.ensure_chat_page(page)
        await D.open_conversation(page, TARGET)
        pre = await D.read_messages(page)
        media_before = D.count_my_media(pre)
        status["media_before"] = media_before

        modal = await D.attach_image(page, IMG)
        status["modal"] = modal
        await page.wait_for_timeout(4000)          # 给上传留点时间再点发送
        status["modal_after_wait"] = await page.evaluate(D.MODAL_JS)
        clicked = await page.evaluate(D.CLICK_MODAL_BTN_JS, "send")
        status["clicked"] = clicked
        for i in range(8):
            await page.wait_for_timeout(5000)
            status[f"t+{(i + 1) * 5}s"] = await page.evaluate(NET_JS)
        await D.screenshot(page, "diag-upload-after")

    print(json.dumps({
        "status": status,
        "net": net[-40:],
    }, ensure_ascii=False, indent=2)[:6000])
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
