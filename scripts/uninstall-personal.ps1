param(
  [switch]$RemoveLocalRuntime,
  [switch]$RestoreCodexProvider
)

$ErrorActionPreference = "Stop"
& (Join-Path $PSScriptRoot "remove-autostart.ps1")
if ($RestoreCodexProvider) {
  & (Join-Path $PSScriptRoot "configure-codex-proxy.ps1") -Mode Disable
}
& codex plugin remove "aihub-codex-monitor@personal" --json
if ($LASTEXITCODE -ne 0) { throw "codex plugin remove failed with exit code $LASTEXITCODE" }

if ($RemoveLocalRuntime) {
  $runtime = Join-Path $env:LOCALAPPDATA "AIHubCodexMonitor"
  if (Test-Path -LiteralPath $runtime) {
    $backup = "$runtime.uninstalled-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Move-Item -LiteralPath $runtime -Destination $backup
    Write-Host "Moved local monitor data to the recoverable backup $backup"
  }
}
