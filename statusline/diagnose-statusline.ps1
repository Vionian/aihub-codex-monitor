param(
  [int]$CdpPort = 0,
  [int]$MonitorPort = 48160,
  [int]$HealthPort = 48161
)

$ErrorActionPreference = "Continue"
$pluginRoot = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -Raw -LiteralPath (Join-Path $pluginRoot ".codex-plugin\plugin.json") | ConvertFrom-Json
$result = [ordered]@{
  pluginRoot = $pluginRoot
  pluginVersion = $manifest.version
  installed = $false
  enabled = $false
  monitorHealthy = $false
  cdpListening = $false
  injectorRunning = $false
  injectedPages = 0
  visiblePages = 0
  pages = @()
  errors = @()
}

if ($CdpPort -le 0) {
  foreach ($candidate in @(9347, 9224, 9222)) {
    try {
      Invoke-WebRequest -Uri "http://127.0.0.1:$candidate/json" -UseBasicParsing -TimeoutSec 1 | Out-Null
      $CdpPort = $candidate
      break
    } catch {}
  }
}

try {
  $plugins = & codex plugin list --json | ConvertFrom-Json
  $installed = @($plugins.installed) | Where-Object { $_.pluginId -like "aihub-codex-monitor@*" }
  $result.installed = [bool]$installed
  $result.enabled = [bool]($installed | Where-Object { $_.enabled })
} catch { $result.errors += "Plugin: $($_.Exception.Message)" }

$cacheVersion = Join-Path $env:USERPROFILE ".codex\plugins\cache\personal\aihub-codex-monitor\$($manifest.version)"
$configPath = Join-Path $env:USERPROFILE ".codex\config.toml"
if (Test-Path -LiteralPath (Join-Path $cacheVersion ".codex-plugin\plugin.json") -PathType Leaf) {
  $result.installed = $true
}
if (Test-Path -LiteralPath $configPath -PathType Leaf) {
  $configText = Get-Content -Raw -LiteralPath $configPath
  if ($configText -match '(?ms)^\[plugins\."aihub-codex-monitor@personal"\]\s*^enabled\s*=\s*true\s*$') {
    $result.enabled = $true
  }
}

try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:$MonitorPort/healthz" -TimeoutSec 2
  $result.monitorHealthy = [bool]$health.ok
} catch { $result.errors += "Monitor: $($_.Exception.Message)" }

try {
  Invoke-RestMethod -Uri "http://127.0.0.1:$CdpPort/json" -TimeoutSec 2 | Out-Null
  $result.cdpListening = $true
} catch { $result.errors += "CDP: $($_.Exception.Message)" }

try {
  $injector = Invoke-RestMethod -Uri "http://127.0.0.1:$HealthPort/healthz" -TimeoutSec 2
  $result.injectorRunning = [bool]$injector.ok
  $result.injectedPages = [int]$injector.installedPages
  $result.visiblePages = [int]$injector.visiblePages
  $result.pages = @($injector.pages)
} catch { $result.errors += "Injector: $($_.Exception.Message)" }

$result | ConvertTo-Json -Depth 5
