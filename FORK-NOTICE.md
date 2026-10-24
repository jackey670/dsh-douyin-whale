# Fork notice

This repository is a local fork of
[`JianHeShui/dsh-douyin`](https://github.com/JianHeShui/dsh-douyin), which is
itself based on [`SakuraMat0u/dsh-douyin-toolkit`](https://github.com/SakuraMat0u/dsh-douyin-toolkit).
Upstream code is MIT-licensed; see `LICENSE` for the original copyright notices.

## Local changes

- Removed the `STEALTH_JS` browser-fingerprint injection from
  `python/douyin_bridge.py`. The fork uses a real system browser and a dedicated
  profile; it does not hide `navigator.webdriver`, fake `window.chrome`, or
  rewrite `navigator.plugins`.
- Added `tests/test_safety.py` as a static regression test for that policy.
- Kept `dy-cli==0.2.2` pinned. Rate limiting and backoff are used only to avoid
  unnecessary request volume; they are not presented as anti-detection.
- Read-only endpoints remain the default. DM sending stays behind the existing
  dry-run gates (`DOUYIN_IM_ALLOW_SEND=0` by default).

## Not included

This fork does not contain cookies, browser profiles, downloaded videos, logs,
account identifiers, or API keys. Those paths are covered by `.gitignore` and
must stay local.
