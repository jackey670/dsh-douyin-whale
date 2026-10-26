"""发送闸的单元测试（纯本地，不联网、不开浏览器）。

抖音对连续发送很敏感：实测连发会返回发送失败，随后整个会话被服务端作废。
所以本地必须先挡一道——冷却中或间隔不够就根本不该去开浏览器。
"""

import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

import douyin_im as D  # noqa: E402


def fresh(tmp_path):
    D.GATE_FILE = str(tmp_path / "gate.json")
    return D


def test_no_gate_file_allows_send(tmp_path) -> None:
    fresh(tmp_path)
    D.check_send_gate("text")  # 不抛就算通过


def test_min_interval_blocks_second_send(tmp_path) -> None:
    fresh(tmp_path)
    D.record_send("text")
    try:
        D.check_send_gate("text")
    except D.IMError as exc:
        assert exc.code == "SEND_TOO_SOON"
    else:
        raise AssertionError("刚发完又发，应该被拦")


def test_interval_uses_separate_channels(tmp_path) -> None:
    # 卡片和文字各记各的时间戳，但都受同一个最小间隔约束
    fresh(tmp_path)
    D.record_send("card")
    try:
        D.check_send_gate("text")
    except D.IMError as exc:
        assert exc.code == "SEND_TOO_SOON"
    else:
        raise AssertionError("卡片之后马上发文字也应被拦")


def test_cool_after_interval(tmp_path) -> None:
    fresh(tmp_path)
    D._gate_write({"last_send_at": time.time() - (D.SEND_MIN_INTERVAL + 5)})
    D.check_send_gate("text")


def test_risk_cooldown_blocks(tmp_path) -> None:
    fresh(tmp_path)
    D.record_risk("安全验证", seconds=600)
    try:
        D.check_send_gate("text")
    except D.IMError as exc:
        assert exc.code == "SEND_COOLDOWN"
        assert "600" in exc.message or "59" in exc.message or "还要等" in exc.message
    else:
        raise AssertionError("风控冷却期内应该拒绝发送")


def test_expired_cooldown_allows(tmp_path) -> None:
    fresh(tmp_path)
    D._gate_write({"blocked_until": time.time() - 1})
    D.check_send_gate("text")


def test_failure_maps_to_cooldown(tmp_path) -> None:
    fresh(tmp_path)

    class E:
        code = "SEND_FAILED"

    D._note_gate_failure(E())
    assert D._gate_read().get("blocked_until", 0) > time.time()


def test_risk_control_maps_to_longer_cooldown(tmp_path) -> None:
    fresh(tmp_path)

    class E:
        code = "RISK_CONTROL"

    D._note_gate_failure(E())
    left = D._gate_read()["blocked_until"] - time.time()
    assert left > 500  # 默认 600 秒


def test_unrelated_error_does_not_block(tmp_path) -> None:
    fresh(tmp_path)

    class E:
        code = "NEED_LOGIN"

    D._note_gate_failure(E())
    assert not D._gate_read().get("blocked_until")
