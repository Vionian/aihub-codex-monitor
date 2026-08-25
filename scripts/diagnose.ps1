param(
  [int]$Port = 48160
)

$ErrorActionPreference = "Continue"
$pluginRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $pluginRoot ".codex-plugin\plugin.json"
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$result = [ordered]@{
  pluginRoot = $pluginRoot
  manifestVersion = $manifest.version
  dataDir = Join-Path $env:LOCALAPPDATA "AIHubCodexMonitor"
  port = $Port
  listening = $false
  owningProcessId = $null
  health = $null
  authentication = $null
  providerCount = 0
  keyCount = 0
  balanceAvailable = $false
  pluginList = $null
  errors = @()
}

try {
  $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1
  if ($listener) {
    $result.listening = $true
    $result.owningProcessId = $listener.OwningProcess
  }
} catch {
  foreach ($line in (& netstat -ano -p tcp 2>$null)) {
    if ($line -match "^\s*TCP\s+127\.0\.0\.1:$Port\s+\S+\s+LISTENING\s+(\d+)\s*$") {
      $result.listening = $true
      $result.owningProcessId = [int]$Matches[1]
      break
    }
  }
}

try {
  $result.health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 3
  if ($result.health.ok) { $result.listening = $true }
  $state = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/state" -TimeoutSec 5
  $result.authentication = $state.runtime.auth
  $result.providerCount = @($state.providers).Count
  $result.keyCount = @($state.keys).Count
  $result.balanceAvailable = $null -ne $state.balance
} catch {
  $result.errors += "Health check: $($_.Exception.Message)"
}

try {
  $result.pluginList = (& codex plugin list --json 2>&1 | Out-String).Trim()
} catch {
  $result.errors += "Plugin list: $($_.Exception.Message)"
}

$result | ConvertTo-Json -Depth 8

Write-Host ""
Write-Host "Statusline:"
& (Join-Path $pluginRoot "statusline\diagnose-statusline.ps1") -MonitorPort $Port
