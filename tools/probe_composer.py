#!/usr/bin/env python3
"""probe_composer.py — 探查抖音聊天输入区的 DOM（近只读：只点表情面板开关，绝不发送）。

目的：给「发送表情包图片」找到三样东西：
  1. 工具栏里图片/表情按钮的选择器（class / aria-label）
  2. 聊天页里的 input[type=file]（set_input_files 的落点）
  3. 图片/表情消息在 React fiber parsedContent 里的字段结构（收表情包要用）

用法::

    python tools/probe_composer.py                    # 用 config 里的 owner.nickname
    python tools/probe_composer.py --from 某昵称      # 指定会话
    python tools/probe_composer.py --no-panel         # 不点面板开关（纯只读）

输出：data/probe/composer.json + data/im-shots/composer-*.png
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

# 输入区容器（从编辑器往上爬 5 层）里的全部可见按钮/svg
TOOLBAR_JS = r"""
() => {
  const cls = (el) => String(el && (el.className && el.className.baseVal !== undefined
    ? el.className.baseVal : el.className) || '').slice(0, 160);
  const out = { editor: [], file_inputs: [], toolbar: [] };
  const editors = [...document.querySelectorAll('[contenteditable="true"]')];
  for (const e of editors) {
    out.editor.push({ cls: cls(e), ph: e.getAttribute('placeholder') || '' });
  }
  const editor = editors[0];
  for (const inp of document.querySelectorAll('input[type=file]')) {
    const chain = [];
    let p = inp;
    for (let i = 0; i < 4 && p; i++) { p = p.parentElement; if (p) chain.push(cls(p)); }
    out.file_inputs.push({
      cls: cls(inp), accept: inp.getAttribute('accept') || '', multiple: !!inp.multiple,
      visible: (() => { const r = inp.getBoundingClientRect(); return r.width > 0 || r.height > 0; })(),
      parents: chain,
    });
  }
  let root = editor;
  for (let i = 0; i < 5 && root; i++) root = root.parentElement;
  if (root) {
    for (const b of root.querySelectorAll('button, [role="button"], svg')) {
      const r = b.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      out.toolbar.push({
        tag: b.tagName, cls: cls(b), aria: b.getAttribute('aria-label') || '',
        text: (b.textContent || '').trim().slice(0, 20),
        w: Math.round(r.width), h: Math.round(r.height),
      });
      if (out.toolbar.length > 40) break;
    }
  }
  return out;
}
"""

# 点击后浮出的面板：class 带 emoji/sticker/panel 或含大量 img 的可见容器
PANEL_JS = r"""
() => {
  const cls = (el) => String(el && (el.className && el.className.baseVal !== undefined
    ? el.className.baseVal : el.className) || '');
  const out = [];
  for (const el of document.querySelectorAll('div')) {
    const c = cls(el);
    if (!/emoji|sticker|smiley|express|biaoqing|panel/i.test(c)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 120 || r.height < 60) continue;
    out.push({
      cls: c.slice(0, 200), w: Math.round(r.width), h: Math.round(r.height),
      imgs: el.querySelectorAll('img').length,
      buttons: [...el.querySelectorAll('button')].slice(0, 10).map((b) => ({
        cls: cls(b).slice(0, 120), aria: b.getAttribute('aria-label') || '',
        text: (b.textContent || '').trim().slice(0, 16),
      })),
    });
    if (out.length >= 6) break;
  }
  return out;
}
"""

# 消息 fiber parsedContent 全字段（收表情包要用的就是这里）
FIBER_FULL_JS = r"""
() => {
  const fiberKey = (n) => {
    for (const k of Object.keys(n)) {
      if (k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0) return k;
    }
    return null;
  };
  const trim = (v, depth) => {
    if (typeof v === 'string') return v.slice(0, 160);
    if (v === null || typeof v !== 'object') return v;
    if (depth > 3) return '[deep]';
    const o = Array.isArray(v) ? [] : {};
    for (const k of Object.keys(v)) o[k] = trim(v[k], depth + 1);
    return o;
  };
  const nodes = Array.prototype.slice.call(
    document.querySelectorAll('[class*="messageMessageBox"]'));
  const out = [];
  const seen = new WeakSet();
  for (const n of nodes) {
    const fk = fiberKey(n);
    if (!fk) continue;
    let f = n[fk], d = 0, found = null;
    while (f && d < 24) {
      const p = f.memoizedProps;
      if (p && p.message && p.message.parsedContent) { found = p.message; break; }
      f = f.return; d++;
    }
    if (!found || seen.has(found)) continue;
    seen.add(found);
    out.push({
      cls_me: /isFromMe/.test(String(n.className || '')),
      parsed: trim(found.parsedContent || {}, 0),
    });
  }
  return out.slice(0, 20);
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


# 按 (class, aria, text) 三元组定位工具栏按钮并派发点击事件序列
CLICK_TOOLBAR_JS = r"""
(sig) => {
  const cls = (el) => String(el && (el.className && el.className.baseVal !== undefined
    ? el.className.baseVal : el.className) || '');
  const editor = document.querySelector('[contenteditable="true"]');
  let root = editor;
  for (let i = 0; i < 5 && root; i++) root = root.parentElement;
  if (!root) return 'no-root';
  for (const b of root.querySelectorAll('button, [role="button"], svg')) {
    const r = b.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (cls(b) === sig.cls && (b.getAttribute('aria-label') || '') === sig.aria
        && (b.textContent || '').trim() === sig.text) {
      for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        b.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
      }
      return 'clicked';
    }
  }
  return 'not-found';
}
"""


async def probe(target: str, with_panel: bool) -> dict:
    out: dict = {"target": target, "panel": with_panel}
    async with D.open_browser(None) as page:
        await D.ensure_chat_page(page)
        await D.open_conversation(page, target)
        await page.wait_for_timeout(1500)

        out["toolbar"] = await page.evaluate(TOOLBAR_JS)
        await D.screenshot(page, "composer-base")

        out["fiber"] = await page.evaluate(FIBER_FULL_JS)

        if with_panel:
            cands = [
                b for b in out["toolbar"]["toolbar"]
                if "publish" not in b["cls"].lower()
                and (b["aria"] or b["cls"] or b["text"])
            ]
            ranked = [
                b for b in cands
                if any(k in (b["cls"] + b["aria"] + b["text"]).lower()
                       for k in ("emoji", "sticker", "smile", "biaoqing", "panel",
                                 "express", "plus", "add", "image", "pic", "photo"))
            ] or cands[:6]
            panels = []
            for i, b in enumerate(ranked[:6]):
                label = b["cls"][:70] or b["aria"][:70] or b["text"][:70]
                try:
                    clicked = await page.evaluate(
                        CLICK_TOOLBAR_JS,
                        {"cls": b["cls"], "aria": b["aria"], "text": b["text"]},
                    )
                    if clicked != "clicked":
                        panels.append({"clicked": label, "error": clicked})
                        continue
                except Exception as e:
                    panels.append({"clicked": label, "error": str(e)[:120]})
                    continue
                await page.wait_for_timeout(1200)
                found = await page.evaluate(PANEL_JS)
                name = f"composer-panel{i}"
                await D.screenshot(page, name)
                panels.append({"clicked": label, "found": found,
                               "screenshot": name + ".png"})
                await page.keyboard.press("Escape")
                await page.wait_for_timeout(500)
            out["panels"] = panels

    return out


async def main() -> int:
    ap = argparse.ArgumentParser(description="Probe Douyin chat composer DOM (near read-only)")
    ap.add_argument("--from", dest="target", default=owner_default(),
                    help="会话昵称（默认取 config owner.nickname）")
    ap.add_argument("--no-panel", action="store_true", help="不点面板开关")
    args = ap.parse_args()
    if not args.target:
        print("没有指定会话（--from），config 里也没有 owner.nickname", file=sys.stderr)
        return 1
    os.makedirs(OUT_DIR, exist_ok=True)
    os.makedirs(SHOT_DIR, exist_ok=True)
    result = await probe(args.target, with_panel=not args.no_panel)
    out_file = os.path.join(OUT_DIR, "composer.json")
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    # 控制台只打摘要，完整 JSON 看文件
    print(json.dumps({
        "out": out_file,
        "toolbar_buttons": len(result.get("toolbar", {}).get("toolbar", [])),
        "file_inputs": result.get("toolbar", {}).get("file_inputs", []),
        "fiber_messages": len(result.get("fiber", [])),
        "panels": [{k: p.get(k) for k in ("clicked", "error")}
                   for p in result.get("panels", [])],
    }, ensure_ascii=False, indent=2)[:3000])
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
