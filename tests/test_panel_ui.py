"""面板 UI 冒烟测试：起 preview server + headless Edge，验证面板真的能渲染、能交互。

只做 DOM 级断言（卡片渲染 / 按钮状态 / 搜索流程 / 开关切换）。canvas 里的点星
交互坐标敏感，不进自动化——那部分用「npm run preview + 浏览器」人工验证。

跑法：npm run test:ui
需要：.venv 里装了 playwright（python/requirements.txt 已含），且本机有
Edge（channel="msedge"）或 Chromium。浏览器缺失 → 整模块 skip，不拖垮默认套件。

注意：测试会把 data/panel-preview-home 删掉重建（gitignored 的样例数据），
保证每次断言的计数都是种子值；手动预览前跑过测试也没关系，服务重启就重新播种。
"""

import re
import os
import shutil
import socket
import subprocess
import time
import urllib.request
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
PREVIEW_HOME = ROOT / "data" / "panel-preview-home"

# 360 会拦 venv python 写系统 %TEMP%（EPERM mkdtemp）。和 DSH 启动器同一招：
# 把 TEMP 指到仓库的 data/tmp（gitignored）；必须在 playwright launch 之前生效。
_TMP = ROOT / "data" / "tmp"
_TMP.mkdir(parents=True, exist_ok=True)
for _k in ("TMP", "TEMP", "TMPDIR"):
    os.environ[_k] = str(_TMP)

pytest.importorskip("playwright.sync_api")
from playwright.sync_api import sync_playwright  # noqa: E402


def _free_port() -> int:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


@pytest.fixture(scope="module")
def preview_base():
    port = _free_port()
    shutil.rmtree(PREVIEW_HOME, ignore_errors=True)  # 强制重新播种，计数才可断言
    proc = subprocess.Popen(
        ["node", str(ROOT / "tools" / "panel-preview" / "server.mjs"), f"--port={port}"],
        cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    base = f"http://127.0.0.1:{port}"
    try:
        for _ in range(80):
            try:
                with urllib.request.urlopen(f"{base}/api/douyin-whale/status", timeout=1) as resp:
                    if resp.status == 200:
                        break
            except Exception:
                time.sleep(0.25)
        else:
            pytest.fail("preview server 没在 20s 内就绪")
        yield base
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


@pytest.fixture(scope="module")
def page(preview_base):
    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(channel="msedge", headless=True)
        except Exception:
            try:
                browser = p.chromium.launch(headless=True)
            except Exception as exc:  # 没有 Edge 也没有 Chromium
                pytest.skip(f"没有可用的 headless 浏览器：{exc}")
        pg = browser.new_page()
        errors: list[str] = []
        pg.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
        pg.goto(f"{preview_base}/")
        pg.wait_for_load_state("domcontentloaded")
        # 面板首帧要拉 /status /memory/overview /memory/graph 等一串接口
        pg.wait_for_selector("[data-dy2-star]", timeout=15_000)
        pg.wait_for_timeout(500)
        yield pg, errors
        browser.close()


def _text_exists(page, pattern: str) -> bool:
    return re.search(pattern, page.locator("body").inner_text()) is not None


def test_cards_render(page) -> None:
    pg, _ = page
    body = pg.locator("body").inner_text()
    assert re.search(r"v\d+\.\d+\.\d+·b\d+", body), "面板版本串没渲染"
    assert "记忆星图" in body
    assert "记忆体检" in body
    assert "运行参数" in body
    assert "内容队列" in body


def test_star_map_legend_and_badge(page) -> None:
    pg, _ = page
    assert re.search(r"\d+ 星 · \d+ 连线", pg.locator("body").inner_text()), "星图徽章没渲染"
    legends = " ".join(pg.locator("[data-dy2-star-legend]").all_inner_texts())
    for legend in ("自我", "主人", "心情", "里程碑", "实体", "主题"):
        assert legend in legends, f"星图图例缺 {legend}"


def test_trace_chips_toggle(page) -> None:
    pg, _ = page
    chips = pg.locator("button", has_text=re.compile(r"想起 \d+ 条"))
    assert chips.count() >= 1, "「最近想起」chips 没渲染"
    first = chips.first
    first.click()
    pg.wait_for_timeout(200)
    assert first.get_attribute("data-primary") == "", "点 chip 应高亮（data-primary）"
    first.click()
    pg.wait_for_timeout(200)
    assert first.get_attribute("data-primary") is None, "再点应取消高亮"


def test_star_fullscreen_toggle(page) -> None:
    pg, _ = page
    star = pg.locator("[data-dy2-star]")
    assert star.get_attribute("data-full") == "0"
    pg.get_by_role("button", name="展开星图").click()
    pg.wait_for_timeout(200)
    assert star.get_attribute("data-full") == "1", "展开星图后应进入全屏"
    pg.keyboard.press("Escape")
    pg.wait_for_timeout(200)
    assert star.get_attribute("data-full") == "0", "Esc 应退出全屏"


def test_pending_batch_enable(page) -> None:
    # 注意：搜索过一次后待确认块会被结果列表顶掉，所以这个用例必须先于搜索用例跑
    pg, _ = page
    adopt = pg.get_by_role("button", name="采纳所选")
    assert adopt.is_disabled(), "没勾选时批量按钮应禁用"
    box = pg.get_by_role("checkbox", name="选中后可批量采纳/忽略").first
    box.check()
    pg.wait_for_timeout(200)
    assert adopt.is_enabled(), "勾选后批量按钮应启用"
    box.uncheck()
    pg.wait_for_timeout(200)
    assert adopt.is_disabled(), "取消勾选后应回到禁用"


def test_memory_search_flow(page) -> None:
    pg, _ = page
    box = pg.get_by_placeholder(re.compile(r"搜一条回忆"))
    box.fill("加班")
    pg.get_by_role("button", name="搜索", exact=True).click()
    pg.wait_for_timeout(500)
    assert re.search(r"搜索「加班」：事实 \d+ 条 · 情节 \d+ 条", pg.locator("body").inner_text()), \
        "搜索结果汇总没出现"
    box.fill("量子退火机")
    pg.get_by_role("button", name="搜索", exact=True).click()
    pg.wait_for_timeout(500)
    assert _text_exists(pg, r"没有匹配的记忆"), "无命中时应提示没有匹配"


def test_no_console_errors(page) -> None:
    _, errors = page
    noise = [e for e in errors if "Failed to load resource" in e]
    real = [e for e in errors if e not in noise]
    assert not real, f"页面有 JS 报错：{real[:5]}"
