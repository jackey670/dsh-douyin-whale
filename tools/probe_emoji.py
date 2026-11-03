#!/usr/bin/env python3
"""probe_emoji.py — 探查抖音聊天输入框的「表情面板」DOM（只点开面板，不点表情、不发送）。

目的：给 `emoji-list` / `emoji-send` 找三样东西：
  1. 表情面板的开关按钮（工具栏里那个 iconAction）
  2. 面板里每个表情格子的 DOM 特征（img src / alt / 容器 class / 坐标）
  3. 面板的滚动容器与可见区域尺寸（编号截图要按它裁）

用法::

    .venv/Scripts/python.exe tools/probe_emoji.py            # 默认 owner.nickname
    .venv/Scripts/python.exe tools/probe_emoji.py --from 某昵称

输出：data/probe/emoji.json + data/im-shots/emoji-*.png
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "python"))

import douyin_im as D  # noqa: E402

OUT_DIR = os.path.join(ROOT, "data", "probe")
SHOT_DIR = os.path.join(ROOT, "data", "im-shots")

# 工具栏全量 + 输入框状态（点击前后都拍一份）
TOOLBAR_JS = r"""
() => {
  const cls = (el) => String(el && (el.className && el.className.baseVal !== undefined
    ? el.className.baseVal : el.className) || '').slice(0, 200);
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const editor = document.querySelector('[contenteditable="true"]');
  const out = { editor_html: '', editor_text: '', toolbar: [], similar_class: [] };
  if (editor) {
    out.editor_html = String(editor.innerHTML || '').slice(0, 1200);
    out.editor_text = String(editor.innerText || '').slice(0, 200);
  }
  let root = editor;
  for (let i = 0; i < 6 && root; i++) root = root.parentElement;
  if (!root) return out;
  for (const b of root.querySelectorAll('button, [role="button"], svg, [class*="iconAction"]')) {
    const r = b.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    out.toolbar.push({
      tag: b.tagName, cls: cls(b), aria: b.getAttribute('aria-label') || '',
      text: (b.textContent || '').trim().slice(0, 20), box: box(b),
    });
  }
  // 同族 class（messageMsgInput* / *icon*）在整页的可见实例，帮助定位面板
  for (const el of document.querySelectorAll('[class*="messageMsgInput"], [class*="Emoji"], [class*="emoji"]')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (out.similar_class.length > 60) break;
    out.similar_class.push({ tag: el.tagName, cls: cls(el), box: box(el),
                             imgs: el.querySelectorAll('img').length,
                             kids: el.children.length });
  }
  return out;
}
"""

# 面板特征：可见、面积合理、含 img 的容器；以及所有可见 img
PANEL_JS = r"""
() => {
  const cls = (el) => String(el && (el.className && el.className.baseVal !== undefined
    ? el.className.baseVal : el.className) || '').slice(0, 220);
  const chain = (el, n) => {
    const out = [];
    let p = el;
    for (let i = 0; i < n && p; i++) { out.push({ tag: p.tagName, cls: cls(p) }); p = p.parentElement; }
    return out;
  };
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const out = { containers: [], imgs: [], emoji_like: [] };
  const editor = document.querySelector('[contenteditable="true"]');
  for (const el of document.querySelectorAll('div, ul')) {
    if (!vis(el)) continue;
    const b = el.getBoundingClientRect();
    if (b.width < 120 || b.height < 80) continue;
    const imgs = el.querySelectorAll('img');
    const c = cls(el);
    const near = editor ? (() => {
      const er = editor.getBoundingClientRect();
      return Math.abs(b.right - er.right) < 500 && b.bottom <= er.bottom + 20;
    })() : false;
    if (imgs.length >= 4 || /emoji|sticker|biaoqing|smile|Emoji|Sticker|Panel/i.test(c)) {
      if (out.containers.length < 25) {
        out.containers.push({ cls: c, box: box(el), imgs: imgs.length,
                              kids: el.children.length, near_composer: near,
                              chain: chain(el, 3) });
      }
    }
  }
  for (const img of document.querySelectorAll('img')) {
    if (!vis(img)) continue;
    const c = cls(img);
    const alt = img.getAttribute('alt') || '';
    const title = img.getAttribute('title') || '';
    const src = String(img.currentSrc || img.src || '').slice(0, 300);
    const inPanel = /emoji|sticker|biaoqing|smile|Emoji|Sticker|Panel/i.test(
      chain(img, 4).map((x) => x.cls).join(' '));
    if (!inPanel && !alt && !/emoji|sticker/i.test(src)) continue;
    if (out.imgs.length > 120) break;
    out.imgs.push({ src, alt, title: title.slice(0, 60), cls: c, box: box(img),
                    chain: chain(img, 3) });
  }
  return out;
}
"""

# 面板里的表情格子 + 底部 tab 栏（只读，不点格子）
ITEMS_JS = r"""
() => {
  const cls = (el) => String(el && (el.className && el.className.baseVal !== undefined
    ? el.className.baseVal : el.className) || '').slice(0, 200);
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const items = [...document.querySelectorAll('.emojiEmojiItememojiItem')].map((el, i) => {
    const img = el.querySelector('img');
    return {
      i, text: String(el.innerText || '').replace(/\s+/g, ' ').trim(),
      src: img ? String(img.currentSrc || img.src || '').slice(0, 400) : '',
      box: box(el),
    };
  });
  const tabs = [...document.querySelectorAll('[class*="emoji"][class*="tab"], [class*="emoji"] [role="tab"], [class*="emoji"] [class*="Tab"]')]
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && el.querySelectorAll('img, svg').length <= 2;
    })
    .slice(0, 20)
    .map((el) => ({
      cls: cls(el), text: String(el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 20),
      box: box(el), imgs: el.querySelectorAll('img').length,
      selected: /active|selected|cur/i.test(cls(el)) || el.getAttribute('aria-selected') === 'true',
    }));
  const panel = document.querySelector('.componentsemojiemojiPanel');
  const grid = document.querySelector('.componentsemojitabPanel');
  return {
    items, tabs,
    panel: panel ? box(panel) : null,
    grid: grid ? { ...box(grid), scroll_h: grid.scrollHeight, client_h: grid.clientHeight,
                   scroll_top: grid.scrollTop } : null,
  };
}
"""

# 点 svg 本身派发完整指针序列（有的组件监听在 parent div 上，parent 也补一遍）
CLICK_ICON_JS = r"""
() => {
  const editor = document.querySelector('[contenteditable="true"]');
  let root = editor;
  for (let i = 0; i < 6 && root; i++) root = root.parentElement;
  if (!root) return 'no-root';
  const targets = [...root.querySelectorAll('svg')].filter((s) =>
    /iconAction/i.test(String(s.className && s.className.baseVal !== undefined
      ? s.className.baseVal : s.className || '')));
  if (!targets.length) return 'no-icon';
  const svg = targets[0];
  const els = [svg, svg.parentElement].filter(Boolean);
  for (const el of els) {
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      try { el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })); } catch (e) {}
    }
  }
  return 'clicked:' + targets.length;
}
"""


def owner_default() -> str:
    cfg = os.path.join(
        os.environ.get("DSH_HOME") or os.path.join(os.path.expanduser("~"), ".dsh"),
        "douyin-whale.config.json",
    )
    try:
        j = json.load(open(cfg, encoding="utf-8"))
        return str((j.get("owner") or {}).get("nickname") or "")
    except Exception:
        return ""


async def probe(target: str) -> dict:
    out: dict = {"target": target}
    async with D.open_browser(None) as page:
        await D.ensure_chat_page(page)
        await D.open_conversation(page, target)
        await page.wait_for_timeout(1200)

        out["before"] = await page.evaluate(TOOLBAR_JS)
        out["click"] = await page.evaluate(CLICK_ICON_JS)
        await page.wait_for_timeout(1200)
        out["panel"] = await page.evaluate(PANEL_JS)
        out["items"] = await page.evaluate(ITEMS_JS)
        out["after"] = await page.evaluate(TOOLBAR_JS)
        out["screenshot"] = await D.screenshot(page, "emoji-open")
        # 面板可能悬在右下角：再单独截一张全页（D.screenshot 已是全页）
        await page.keyboard.press("Escape")
        await page.wait_for_timeout(400)
        out["after_escape"] = await page.evaluate(TOOLBAR_JS)

    return out


async def main() -> int:
    ap = argparse.ArgumentParser(description="Probe Douyin emoji panel DOM (read-only)")
    ap.add_argument("--from", dest="target", default=owner_default(),
                    help="会话昵称（默认取 config owner.nickname）")
    args = ap.parse_args()
    if not args.target:
        print("没有指定会话（--from），config 里也没有 owner.nickname", file=sys.stderr)
        return 1
    os.makedirs(OUT_DIR, exist_ok=True)
    os.makedirs(SHOT_DIR, exist_ok=True)
    result = await probe(args.target)
    out_file = os.path.join(OUT_DIR, "emoji.json")
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(json.dumps({
        "out": out_file,
        "click": result.get("click"),
        "containers": len(result.get("panel", {}).get("containers", [])),
        "imgs": len(result.get("panel", {}).get("imgs", [])),
        "toolbar_after": len(result.get("after", {}).get("toolbar", [])),
        "screenshot": result.get("screenshot"),
    }, ensure_ascii=False, indent=2)[:3000])
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
