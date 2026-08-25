param(
  [string]$PluginRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = "Stop"
$PluginRoot = (Resolve-Path -LiteralPath $PluginRoot).Path
$watchdog = Join-Path $PluginRoot "statusline\watchdog.ps1"
if (-not (Test-Path -LiteralPath $watchdog -PathType Leaf)) { throw "Missing statusline supervisor: $watchdog" }
$launcher = Join-Path $PluginRoot "scripts\start-hidden.vbs"
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw "Missing hidden startup launcher: $launcher" }
$dataRoot = Join-Path $env:LOCALAPPDATA "AIHubCodexMonitor"
$stopMarker = Join-Path $dataRoot "statusline-supervisor.stop"
if (Test-Path -LiteralPath $stopMarker -PathType Leaf) { Remove-Item -LiteralPath $stopMarker -Force }

$startup = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"
New-Item -ItemType Directory -Path $startup -Force | Out-Null
$shortcutPath = Join-Path $startup "AIHub Codex Monitor.lnk"
$temporaryShortcutPath = Join-Path $startup (".AIHub Codex Monitor." + [guid]::NewGuid().ToString("N") + ".lnk")
$wscript = (Get-Command wscript.exe -ErrorAction Stop).Source
$shell = New-Object -ComObject WScript.Shell
try {
  $shortcut = $shell.CreateShortcut($temporaryShortcutPath)
  $shortcut.TargetPath = $wscript
  $shortcut.Arguments = "`"$launcher`""
  $shortcut.WorkingDirectory = $PluginRoot
  $shortcut.Description = "Keep the AIHub Codex monitor and status line available."
  $shortcut.Save()
} finally {
  if ($null -ne $shortcut) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shortcut) }
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell)
}
Move-Item -LiteralPath $temporaryShortcutPath -Destination $shortcutPath -Force
Write-Host "Installed current-user startup entry: $shortcutPath"
Start-Process -FilePath $wscript -ArgumentList @("`"$launcher`"") -WindowStyle Hidden
Write-Host "Started the AIHub Codex Monitor supervisor."
