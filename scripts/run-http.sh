#!/usr/bin/env bash
# 启动本地抖音 HTTP API（默认 127.0.0.1:7709）。
#
#   ./scripts/run-http.sh
#   DOUYIN_HTTP_PORT=7710 ./scripts/run-http.sh
#
# 若仓库根目录存在 .env，会先被 source（改完记得别把它提交进 git）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

PY="${DOUYIN_PYTHON:-$ROOT/.venv/bin/python}"
if [[ ! -x "$PY" ]]; then
  echo "找不到 Python：$PY" >&2
  echo "先建虚拟环境：python3 -m venv .venv && .venv/bin/pip install -r python/requirements-http.txt" >&2
  exit 1
fi

export DOUYIN_PYTHON="$PY"
export DOUYIN_DATA_DIR="${DOUYIN_DATA_DIR:-$ROOT/data}"
export DOUYIN_HTTP_HOST="${DOUYIN_HTTP_HOST:-127.0.0.1}"
export DOUYIN_HTTP_PORT="${DOUYIN_HTTP_PORT:-7709}"

echo "data: $DOUYIN_DATA_DIR"
echo "listen: http://$DOUYIN_HTTP_HOST:$DOUYIN_HTTP_PORT"
if [[ "${DOUYIN_IM_ALLOW_SEND:-0}" != "1" ]]; then
  echo "私信真实发送：关闭（dry-run 默认）"
else
  echo "私信真实发送：开启 —— 请确认这是你要的"
fi

exec "$PY" "$ROOT/python/douyin_http.py"
