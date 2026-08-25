param(
  [string]$SourceRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$TargetRoot = (Join-Path $env:USERPROFILE "plugins\aihub-codex-monitor"),
  [int]$Port = 48160,
  [int]$StatuslineHealthPort = 48161,
  [switch]$StopRunningMonitor
)

$ErrorActionPreference = "Stop"
$SourceRoot = (Resolve-Path -LiteralPath $SourceRoot).Path
if (-not (Test-Path -LiteralPath (Join-Path $SourceRoot ".codex-plugin\plugin.json"))) {
  throw "SourceRoot is not an AIHub Codex Monitor plugin: $SourceRoot"
}

function Get-ListenerProcessId([int]$ListenPort) {
  $pattern = "^\s*TCP\s+127\.0\.0\.1:$ListenPort\s+\S+\s+LISTENING\s+(\d+)\s*$"
  foreach ($line in (& netstat -ano -p tcp)) {
    if ($line -match $pattern) { return [int]$Matches[1] }
  }
  return $null
}

function Wait-PortClosed([int]$ListenPort) {
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    if (-not (Get-ListenerProcessId $ListenPort)) { return }
    Start-Sleep -Milliseconds 250
  }
  throw "Port $ListenPort is still listening after the monitor process was stopped."
}

$listenerPid = Get-ListenerProcessId $Port
if ($listenerPid) {
  $listenerProcess = Get-Process -Id $listenerPid -ErrorAction Stop
  if ($listenerProcess.ProcessName -ne "node") {
    throw "Port $Port is owned by unexpected process $($listenerProcess.ProcessName) (PID $listenerPid)."
  }
  if (-not $StopRunningMonitor) {
    throw "AIHub Codex Monitor is running on port $Port (PID $listenerPid). Close Codex or pass -StopRunningMonitor."
  }
  Write-Host "Stopping AIHub Codex Monitor on port $Port (PID $listenerPid)..."
  Stop-Process -Id $listenerPid -Force
  Wait-PortClosed $Port
}

$statuslinePid = Get-ListenerProcessId $StatuslineHealthPort
if ($statuslinePid) {
  $statuslineProcess = Get-Process -Id $statuslinePid -ErrorAction Stop
  if ($statuslineProcess.ProcessName -ne "node") {
    throw "Port $StatuslineHealthPort is owned by unexpected process $($statuslineProcess.ProcessName) (PID $statuslinePid)."
  }
  if (-not $StopRunningMonitor) {
    throw "AIHub statusline is running on port $StatuslineHealthPort (PID $statuslinePid). Pass -StopRunningMonitor to update it."
  }
  Write-Host "Stopping AIHub statusline on port $StatuslineHealthPort (PID $statuslinePid)..."
  Stop-Process -Id $statuslinePid -Force
  Wait-PortClosed $StatuslineHealthPort
}

$creatorRoot = Join-Path $env:USERPROFILE ".codex\skills\.system\plugin-creator"
$cachebuster = Join-Path $creatorRoot "scripts\update_plugin_cachebuster.py"
$validator = Join-Path $creatorRoot "scripts\validate_plugin.py"
$marketplaceReader = Join-Path $creatorRoot "scripts\read_marketplace_name.py"

& python $cachebuster $SourceRoot
if ($LASTEXITCODE -ne 0) { throw "Could not update the plugin cachebuster." }
& python $validator $SourceRoot
if ($LASTEXITCODE -ne 0) { throw "Plugin validation failed." }

New-Item -ItemType Directory -Path $TargetRoot -Force | Out-Null
Get-ChildItem -Force -LiteralPath $SourceRoot | Where-Object {
  $_.Name -notin @(".dev-data", ".launcher-data")
} | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination $TargetRoot -Recurse -Force
}

$marketplaceName = (& python $marketplaceReader).Trim()
if ($LASTEXITCODE -ne 0 -or -not $marketplaceName) { throw "Could not read the personal marketplace name." }

$list = & codex plugin list --json | ConvertFrom-Json
$installed = @($list.installed) | Where-Object { $_.pluginId -eq "aihub-codex-monitor@$marketplaceName" }
$cacheRoot = Join-Path $env:USERPROFILE ".codex\plugins\cache\$marketplaceName\aihub-codex-monitor"
$recovery = $null
if (-not $installed -and (Test-Path -LiteralPath $cacheRoot)) {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $recovery = "$cacheRoot.recovery-$stamp"
  Move-Item -LiteralPath $cacheRoot -Destination $recovery
  Write-Host "Moved the orphaned cache to $recovery"
}

try {
  & codex plugin add "aihub-codex-monitor@$marketplaceName" --json
  if ($LASTEXITCODE -ne 0) { throw "codex plugin add failed with exit code $LASTEXITCODE" }
} catch {
  if ($recovery) { Write-Warning "The previous cache remains recoverable at $recovery" }
  throw
}

& codex plugin list
$autostartInstaller = Join-Path $TargetRoot "scripts\install-autostart.ps1"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $autostartInstaller -PluginRoot $TargetRoot
if ($LASTEXITCODE -ne 0) { throw "Could not install the current-user statusline startup entry." }
Write-Host "Publishing completed. Start Codex and create a new task to load version $((Get-Content -Raw (Join-Path $TargetRoot '.codex-plugin\plugin.json') | ConvertFrom-Json).version)."
