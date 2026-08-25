$ErrorActionPreference = "Stop"
$shortcutPath = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup\AIHub Codex Monitor.lnk"
if (Test-Path -LiteralPath $shortcutPath) {
  Remove-Item -LiteralPath $shortcutPath -Force
  Write-Host "Removed current-user startup entry: $shortcutPath"
}
$dataRoot = Join-Path $env:LOCALAPPDATA "AIHubCodexMonitor"
New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null
$stopMarker = Join-Path $dataRoot "statusline-supervisor.stop"
Set-Content -LiteralPath $stopMarker -Value ([DateTime]::UtcNow.ToString("o")) -Encoding ascii
Write-Host "Requested the running AIHub statusline supervisor to stop."
