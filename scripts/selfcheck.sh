#!/usr/bin/env bash
# 最小自检：Python 依赖、浏览器、cookie、可选的真实热榜请求。
#
#   ./scripts/selfcheck.sh
#   ./scripts/selfcheck.sh --skip-network
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
[[ -f .env ]] && { set -a; source .env; set +a; }

PY="${DOUYIN_PYTHON:-$ROOT/.venv/bin/python}"
SKIP_NETWORK=0
[[ "${1:-}" == "--skip-network" ]] && SKIP_NETWORK=1

if [[ ! -x "$PY" ]]; then
  echo "FAIL: 找不到 Python：$PY" >&2
  echo "Run: python3 -m venv .venv && .venv/bin/pip install -r python/requirements.txt" >&2
  exit 1
fi

export PYTHONIOENCODING=utf-8
export PYTHONUTF8=1
export DOUYIN_DATA_DIR="${DOUYIN_DATA_DIR:-$ROOT/data}"

echo "== python =="
"$PY" -V
"$PY" -c "import dy_cli, playwright; print('dy-cli', getattr(dy_cli,'__version__','?')); print('playwright ok')"

echo "== browser / data =="
(cd python && "$PY" -c "import douyin_im as D; print('browser:', D.CHROME or 'NOT FOUND'); print('headless:', D.resolve_headless()); print('data:', D.DATA)")

echo "== cookie =="
if [[ -f "$DOUYIN_DATA_DIR/home/.dy/cookies/default.json" ]]; then
  echo "found: $DOUYIN_DATA_DIR/home/.dy/cookies/default.json"
else
  echo "missing: $DOUYIN_DATA_DIR/home/.dy/cookies/default.json（见 docs/COOKIE-GUIDE.md）"
fi

if [[ "$SKIP_NETWORK" == "1" ]]; then
  echo "skip network"
  exit 0
fi

echo "== douyin trending (3 entries, real request) =="
if ! "$PY" -m dy_cli.main trending --count 3 --json-output; then
  echo "FAIL: dy-cli trending 失败（可能是网络或风控）" >&2
  exit 1
fi
echo "OK"
