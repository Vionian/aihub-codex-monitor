param(
  [int]$Port = 48160
)

$pluginRoot = Split-Path -Parent $PSScriptRoot
$env:AIHUB_MONITOR_PORT = [string]$Port
node (Join-Path $pluginRoot "scripts\launcher.mjs") --standalone
