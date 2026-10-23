# 启动本地抖音 HTTP API（默认 127.0.0.1:7709）。
#
#   .\scripts\run-http.ps1
#   $env:DOUYIN_HTTP_PORT = 7710; .\scripts\run-http.ps1
#
# PowerShell 不会自动读 .env；需要的话先在当前会话里设置环境变量，
# 或者参照 .env.example 手工 export。
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$py = $env:DOUYIN_PYTHON
if (-not $py) { $py = Join-Path $root '.venv\Scripts\python.exe' }
if (-not (Test-Path $py)) {
    Write-Host "找不到 Python：$py" -ForegroundColor Red
    Write-Host "先建虚拟环境：python -m venv .venv; .venv\Scripts\pip install -r python\requirements-http.txt"
    exit 1
}

$env:DOUYIN_PYTHON = $py
if (-not $env:DOUYIN_DATA_DIR) { $env:DOUYIN_DATA_DIR = Join-Path $root 'data' }
if (-not $env:DOUYIN_HTTP_HOST) { $env:DOUYIN_HTTP_HOST = '127.0.0.1' }
if (-not $env:DOUYIN_HTTP_PORT) { $env:DOUYIN_HTTP_PORT = '7709' }

Write-Host "data:   $env:DOUYIN_DATA_DIR"
Write-Host "listen: http://$($env:DOUYIN_HTTP_HOST):$($env:DOUYIN_HTTP_PORT)"
if ($env:DOUYIN_IM_ALLOW_SEND -ne '1') {
    Write-Host "私信真实发送：关闭（dry-run 默认）" -ForegroundColor Yellow
} else {
    Write-Host "私信真实发送：开启 —— 请确认这是你要的" -ForegroundColor Red
}

& $py (Join-Path $root 'python\douyin_http.py')
