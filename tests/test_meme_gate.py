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


# ── 抖音原生表情（2026-11-03 实测定版）────────────────────────────────────

EMOJI_SRC = ("https://p26-sign.douyinpic.com/obj/im-resource/"
             "1687263141266-ts-e6999ae4b88ae5a5bd2de697a9e782b9e79da12e706e67"
             "?lk3s=91c5b7cb&x-expires=1825250400")


def test_emoji_name_and_token_from_src():
    # 文件名 hex 段是 UTF-8 中文：晚上好-早点睡.png
    assert D._emoji_name_from_src(EMOJI_SRC) == "晚上好-早点睡.png"
    assert D._emoji_token(EMOJI_SRC) == "e6999ae4b88ae5a5bd2de697a9e782b9e79da12e706e67"
    assert D._emoji_name_from_src("") == ""
    assert D._emoji_token("not-a-url") == ""


def test_emoji_pick_prefers_label_and_lists_available():
    items = [{"index": 1, "label": "续火花", "src": ""},
             {"index": 2, "label": "比心", "src": ""}]
    assert D._emoji_pick(items, "比心", None)["index"] == 2
    assert D._emoji_pick(items, "", 1)["label"] == "续火花"
    with pytest.raises(D.IMError) as e:
        D._emoji_pick(items, "不存在", None)
    assert e.value.code == "EMOJI_NOT_FOUND"
    assert "续火花" in e.value.message
    with pytest.raises(D.IMError) as e:
        D._emoji_pick(items, "", 9)
    assert e.value.code == "EMOJI_NOT_FOUND"
    with pytest.raises(D.IMError) as e:
        D._emoji_pick(items, "", None)
    assert e.value.code == "BAD_INPUT"


def test_count_my_media_counts_native_emoji():
    # 原生表情也是「无文字无 item」的媒体消息（aweType 507），必须计入
    msgs = [
        {"from": "me", "text": "", "kind": "sticker", "item_id": "",
         "image_uri": "emoji://x", "image_id": ""},
        {"from": "them", "text": "", "kind": "sticker", "item_id": "",
         "image_uri": "emoji://y", "image_id": ""},
    ]
    assert D.count_my_media(msgs) == 1
