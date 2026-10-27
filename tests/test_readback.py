"""Unit tests for the send read-back judgement.

`confirm_sent` used to accept "a bubble containing the text exists", which
false-positived when the composer still held the text and when somebody else
had sent a similar line. The judgement is now "how many of *my* messages match
this text", so these tests pin down that counting rule.

No browser, no network, no Douyin account involved.
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

import douyin_im as D  # noqa: E402


def msg(sender: str, text: str) -> dict:
    return {"from": sender, "text": text, "kind": "text", "item_id": ""}


def test_norm_text_collapses_whitespace_and_zero_width() -> None:
    assert D._norm_text("  你好\n世界  ") == "你好 世界"
    assert D._norm_text("a\u200bb\u200c\u200d\ufeffc") == "abc"
    assert D._norm_text(None) == ""


def test_counts_only_my_messages() -> None:
    msgs = [
        msg("them", "主人，这条视频不错"),
        msg("me", "主人，这条视频不错"),
        msg("me", "另一句完全不相干的话"),
    ]
    assert D.count_my_matching(msgs, "主人，这条视频不错") == 1


def test_them_saying_the_same_thing_does_not_count() -> None:
    msgs = [msg("them", "收到"), msg("them", "收到")]
    assert D.count_my_matching(msgs, "收到") == 0


def test_exact_match() -> None:
    assert D.count_my_matching([msg("me", "今天吃红烧肉")], "今天吃红烧肉") == 1


def test_whitespace_differences_still_match() -> None:
    # 抖音会对正文做空白归一化，回读时不能因此判成没发出去
    assert D.count_my_matching([msg("me", "今天  吃\n红烧肉")], "今天 吃 红烧肉") == 1


def test_long_text_matches_by_prefix() -> None:
    sent = "主人，这吃播看得本鱼饿了，红烧肉配鹌鹑蛋、虾滑酿青椒、豆角烧茄子，三盘一起上"
    echoed = sent[:20] + "……（被前端截断）"
    assert D.count_my_matching([msg("me", echoed)], sent) == 1


def test_prefix_match_does_not_swallow_unrelated_text() -> None:
    sent = "主人，这吃播看得本鱼饿了，红烧肉配鹌鹑蛋"
    other = "主人，这条完全说的是别的事情，跟吃播没有关系"
    assert D.count_my_matching([msg("me", other)], sent) == 0


def test_repeated_send_increments() -> None:
    msgs = [msg("me", "好耶"), msg("me", "好耶")]
    assert D.count_my_matching(msgs, "好耶") == 2


def test_empty_text_counts_zero() -> None:
    assert D.count_my_matching([msg("me", "")], "") == 0
    assert D.count_my_matching([msg("me", "任意内容")], "   ") == 0


def test_unknown_sender_is_not_counted() -> None:
    # 发送方判断不出来时宁可不算，避免把别人的话当自己发的
    assert D.count_my_matching([msg("unknown", "好耶")], "好耶") == 0


def test_missing_pid_is_not_alive() -> None:
    # Windows 上 os.kill(缺失 PID, 0) 抛 SystemError 而不是 OSError；
    # 若当成“活着”，僵死锁永远清不掉，读私信会卡满 180 秒再 BUSY。
    assert D._pid_alive(2_147_483_600) is False
