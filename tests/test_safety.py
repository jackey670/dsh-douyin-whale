"""Static safety checks for this fork.

The early login bridge injected a small STEALTH_JS script to hide
``navigator.webdriver`` and fake ``window.chrome`` / plugins. This fork removes
that behavior: the browser must be a real system browser, and verification
pages must be completed by a human.

These tests are intentionally dependency-free so they run before installing
Playwright or FastAPI.
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PYTHON_SOURCES = sorted((ROOT / "python").glob("*.py"))

FORBIDDEN_CODE_MARKERS = (
    "STEALTH_JS",
    "add_init_script(",
    "Object.defineProperty(navigator, 'webdriver'",
    "Object.defineProperty(navigator, \"webdriver\"",
    "navigator.plugins",
    "--disable-blink-features=AutomationControlled",
)


def test_no_stealth_injection() -> None:
    offenders = []
    for path in PYTHON_SOURCES:
        text = path.read_text(encoding="utf-8")
        for marker in FORBIDDEN_CODE_MARKERS:
            if marker in text:
                offenders.append(f"{path.relative_to(ROOT)}: {marker}")
    assert not offenders, "browser stealth injection is forbidden:\n" + "\n".join(offenders)


def test_im_driver_keeps_real_browser_policy() -> None:
    text = (ROOT / "python" / "douyin_im.py").read_text(encoding="utf-8")
    assert "不伪造身份" in text
    assert "add_init_script(" not in text


def test_dy_cli_dependency_is_pinned() -> None:
    text = (ROOT / "python" / "requirements.txt").read_text(encoding="utf-8")
    assert re.search(r"^dy-cli==\d+\.\d+\.\d+$", text, re.MULTILINE), (
        "dy-cli must stay pinned; its browser/API behavior is third-party"
    )
