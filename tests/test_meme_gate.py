"""表情包发送的安全边界：路径白名单、扩展名/大小、媒体回读计数。

运行：node tools/run-py.mjs -m pytest -q tests/test_meme_gate.py
"""
from __future__ import annotations

import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "python"))

import douyin_im as D  # noqa: E402


@pytest.fixture()
def meme_root(tmp_path, monkeypatch):
    root = tmp_path / "meme-packs"
    (root / "pack1").mkdir(parents=True)
    monkeypatch.setenv("DOUYIN_MEME_ROOTS", str(root))
    return root


def test_whitelist_accepts_pack_image(meme_root):
    img = meme_root / "pack1" / "ok.jpg"
    img.write_bytes(b"x" * 100)
    got = D.validate_image_path(str(img))
    assert os.path.realpath(str(img)) == got


def test_whitelist_rejects_outside(meme_root, tmp_path):
    outside = tmp_path / "evil.jpg"
    outside.write_bytes(b"x" * 10)
    with pytest.raises(D.IMError) as e:
        D.validate_image_path(str(outside))
    assert e.value.code == "IMAGE_NOT_ALLOWED"


def test_rejects_missing_and_bad_ext(meme_root):
    with pytest.raises(D.IMError) as e:
        D.validate_image_path(str(meme_root / "nope.jpg"))
    assert e.value.code == "BAD_INPUT"

    bad = meme_root / "pack1" / "a.txt"
    bad.write_bytes(b"x")
    with pytest.raises(D.IMError) as e:
        D.validate_image_path(str(bad))
    assert e.value.code == "BAD_INPUT"


def test_rejects_oversize(meme_root):
    big = meme_root / "pack1" / "big.jpg"
    big.write_bytes(b"0" * (D.MEME_MAX_BYTES + 1))
    with pytest.raises(D.IMError) as e:
        D.validate_image_path(str(big))
    assert e.value.code == "BAD_INPUT"


def test_fail_closed_when_no_roots(tmp_path, monkeypatch):
    """没有任何图库目录时（如 fresh 机器）必须 fail-closed：一律拒绝。"""
    monkeypatch.setattr(D, "meme_roots", lambda: [])
    outside = tmp_path / "x.jpg"
    outside.write_bytes(b"x")
    with pytest.raises(D.IMError) as e:
        D.validate_image_path(str(outside))
    assert e.value.code == "IMAGE_NOT_ALLOWED"


def test_count_my_media():
    msgs = [
        {"from": "me", "text": "在的", "kind": "text", "item_id": "", "image_uri": "", "image_id": ""},
        {"from": "me", "text": "", "kind": "sticker", "item_id": "", "image_uri": "tos://a", "image_id": "A"},
        {"from": "them", "text": "", "kind": "sticker", "item_id": "", "image_uri": "tos://b", "image_id": "B"},
        {"from": "me", "text": "", "kind": "sticker", "item_id": "", "image_uri": "tos://c", "image_id": "C"},
        {"from": "me", "text": "带说明的图", "kind": "sticker", "item_id": "", "image_uri": "tos://d", "image_id": "D"},
    ]
    # 我发的媒体 = 2 张无文字 + 1 张带 caption 的图
    assert D.count_my_media(msgs) == 3
    assert D.count_my_media(None) is None
