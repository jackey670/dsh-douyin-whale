#requires -Version 7.0
<#
.SYNOPSIS
  开发机「值班开关」（大肥鱼刷抖音）。

.DESCRIPTION
  只动两样东西：
    · ~/.dsh/profiles/desktop/cordis.patch.yml 里的 whaleEnabled
    · 用户级环境变量 DOUYIN_IM_ALLOW_SEND

  生产在笔记本时保持 -Off（开发机只开发）。
  要在本机调试值班才 -On —— 先停笔记本生产！两条机器不能同时跑同一抖音账号。
  改完必须**完全退出并重启 DSH NEXT**才生效（关窗口不等于退出，托盘也要退）。

.EXAMPLE
  pwsh -File scripts/dev-duty.ps1 -Status
  pwsh -File scripts/dev-duty.ps1 -Off
  pwsh -File scripts/dev-duty.ps1 -On -Yes
#>
param(
  [switch]$On,
  [switch]$Off,
  [switch]$Status,
  [switch]$Yes
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$RepoRoot = Split-Path $PSScriptRoot -Parent
$Patch = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\cordis.patch.yml'
$EnvName = 'DOUYIN_IM_ALLOW_SEND'

function Get-PatchLineIndex {
  if (-not (Test-Path $Patch)) { return -1 }
  $lines = Get-Content -LiteralPath $Patch
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^\s*whaleEnabled:\s*(true|false)\s*$') { return $i }
  }
  return -1
}

function Get-WhaleEnabled {
  $idx = Get-PatchLineIndex
  if ($idx -lt 0) { return $null }
  $line = (Get-Content -LiteralPath $Patch)[$idx]
  return $line -match 'true'
}

function Set-WhaleEnabled([bool]$value) {
  $raw = [System.IO.File]::ReadAllText($Patch)
  if ($raw -notmatch '(?m)^\s*whaleEnabled:\s*(true|false)\s*$') {
    throw "找不到 whaleEnabled 配置行：$Patch"
  }
  # 只在原文本上替换目标行，保留原有换行风格（LF/CRLF）与其余内容
  $new = [regex]::Replace(
    $raw,
    '(?m)^(\s*)whaleEnabled:\s*(true|false)(\s*)$',
    ('${1}whaleEnabled: ' + $value.ToString().ToLower() + '${3}')
  )
  [System.IO.File]::WriteAllText($Patch, $new, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-SendEnv {
  return [Environment]::GetEnvironmentVariable($EnvName, 'User')
}

function Get-SchedulerStatus {
  $sched = Join-Path $RepoRoot 'scheduler\scheduler.mjs'
  if (-not (Test-Path $sched)) { return '（找不到 scheduler/scheduler.mjs）' }
  try {
    $out = & node $sched --status 2>&1 | Out-String
    return $out.Trim()
  } catch {
    return "（读取失败：$($_.Exception.Message)）"
  }
}

function Show-State {
  $whale = Get-WhaleEnabled
  $whaleText = if ($null -eq $whale) { '（未配置）' } else { $whale.ToString() }
  $envVal = Get-SendEnv
  $envText = if ([string]::IsNullOrEmpty($envVal)) { '（未设置）' } else { $envVal }
  Write-Host '── 开发机值班状态 ──────────────────────────'
  Write-Host ("whaleEnabled          : " + $whaleText)
  Write-Host ("DOUYIN_IM_ALLOW_SEND  : " + $envText)
  Write-Host ("patch                 : " + $Patch)
  Write-Host ''
  Write-Host '── 本机调度器 ──────────────────────────────'
  Write-Host (Get-SchedulerStatus)
  Write-Host ''
  Write-Host '提示：生产在笔记本时本机应保持 whaleEnabled=false；两条机器不能同时跑同一账号。'
}

if ($Status -or (-not $On -and -not $Off)) {
  Show-State
  exit 0
}

if ($On -and $Off) { throw '不能同时指定 -On 和 -Off' }

if ($Off) {
  Set-WhaleEnabled $false
  [Environment]::SetEnvironmentVariable($EnvName, $null, 'User')
  Write-Host '已关闭：whaleEnabled=false，DOUYIN_IM_ALLOW_SEND 已移除（用户级）。'
  Write-Host '注意：已启动的 DSH NEXT 进程还带着旧值 —— 要完全退出再打开才生效。'
  Show-State
  exit 0
}

# -On
if (-not $Yes) {
  Write-Host '【-On 前置检查清单】确认后加 -Yes 重跑：'
  Write-Host '  1. 笔记本上的生产已停（node scheduler\scheduler.mjs --stop；DSH 值班如开着也停）'
  Write-Host '  2. 本机 wb2 网关可达（7863），WB2_API_KEY 用户环境变量已设置'
  Write-Host '  3. 明白：同一抖音账号不能两台机器同时跑'
  Write-Host '  4. 明白：改完要完全退出并重启 DSH NEXT（关窗口不等于退出）'
  Write-Host ''
  Write-Host '本次未做任何修改。'
  exit 2
}

Set-WhaleEnabled $true
[Environment]::SetEnvironmentVariable($EnvName, '1', 'User')
Write-Host '已开启：whaleEnabled=true，DOUYIN_IM_ALLOW_SEND=1（用户级）。'
Write-Host '现在完全退出 DSH NEXT（含托盘）再重新打开，值班定时器才会启动。'
Show-State
exit 0
