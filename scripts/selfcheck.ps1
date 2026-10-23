# 最小自检：确认 Python 依赖、浏览器、cookie 与一次真实热榜请求。
#
#   powershell -ExecutionPolicy Bypass -File scripts\selfcheck.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\selfcheck.ps1 -SkipNetwork
param(
    [switch]$SkipNetwork
)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$py = if ($env:DOUYIN_PYTHON) { $env:DOUYIN_PYTHON } else { Join-Path $root '.venv\Scripts\python.exe' }
if (-not (Test-Path $py)) {
    Write-Host "FAIL: 找不到 Python：$py" -ForegroundColor Red
    Write-Host "Run: python -m venv .venv; .venv\Scripts\pip install -r python\requirements.txt"
    exit 1
}

# 子进程统一 UTF-8，避免中文乱码
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUTF8 = '1'

Write-Host '== python ==' -ForegroundColor Cyan
& $py -V
& $py -c "import dy_cli, playwright; print('dy-cli', getattr(dy_cli, '__version__', '?')); print('playwright ok')"

Write-Host '== browser ==' -ForegroundColor Cyan
Push-Location (Join-Path $root 'python')
try {
    & $py -c "import douyin_im as D; print('browser:', D.CHROME or 'NOT FOUND'); print('headless:', D.resolve_headless()); print('data:', D.DATA)"
} finally { Pop-Location }

Write-Host '== cookie ==' -ForegroundColor Cyan
$cookie = Join-Path $root 'data\home\.dy\cookies\default.json'
if (Test-Path $cookie) {
    Write-Host "found: $cookie"
} else {
    Write-Host "missing: $cookie（先跑 tools\export_login_state.py，见 docs\COOKIE-GUIDE.md）" -ForegroundColor Yellow
}

if ($SkipNetwork) { Write-Host 'skip network' -ForegroundColor Yellow; exit 0 }

Write-Host '== douyin trending (3 entries, real request) ==' -ForegroundColor Cyan
$env:DOUYIN_DATA_DIR = Join-Path $root 'data'
& $py -m dy_cli.main trending --count 3 --json-output
if ($LASTEXITCODE -ne 0) {
    Write-Host "FAIL: dy-cli trending exited $LASTEXITCODE" -ForegroundColor Red
    exit $LASTEXITCODE
}
Write-Host 'OK' -ForegroundColor Green
