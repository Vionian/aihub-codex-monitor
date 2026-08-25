param(
  [int]$CdpPort = 0,
  [int]$MonitorPort = 48160,
  [int]$HealthPort = 48161,
  [switch]$RestartCodex
)

$ErrorActionPreference = "Stop"
$statuslineRoot = $PSScriptRoot
$pluginRoot = Split-Path -Parent $statuslineRoot
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "Node.js is required." }

function Test-Http([string]$Uri) {
  try { return [bool](Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 2) } catch { return $false }
}

function Find-CdpPort([int]$RequestedPort) {
  $ports = [System.Collections.Generic.List[int]]::new()
  if ($RequestedPort -gt 0) { $ports.Add($RequestedPort) }
  if ($RequestedPort -le 0) {
    try {
      $lines = @(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty CommandLine)
      foreach ($line in $lines) {
        foreach ($match in [regex]::Matches([string]$line, '--remote-debugging-port=(\d+)', 'IgnoreCase')) {
          $ports.Add([int]$match.Groups[1].Value)
        }
      }
    } catch {}
  }
  foreach ($fallback in @(9347, 9224, 9222)) { $ports.Add($fallback) }
  foreach ($port in @($ports | Select-Object -Unique)) {
    if (Test-Http "http://127.0.0.1:$port/json") { return [int]$port }
  }
  return 0
}

function Start-CodexWithDebugPort([int]$Port) {
  $aumid = (Get-StartApps -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -in @("Codex", "ChatGPT") } |
    Select-Object -First 1).AppID
  if (-not $aumid) {
    $family = (Get-AppxPackage -Name "OpenAI.Codex" -ErrorAction SilentlyContinue |
      Select-Object -First 1).PackageFamilyName
    if ($family) { $aumid = "$family!App" }
  }
  if ($aumid) {
    try {
      Add-Type -Path (Join-Path $statuslineRoot "CodexActivator.cs") -ErrorAction Stop
      $processId = [uint32]0
      $arguments = "--remote-debugging-address=127.0.0.1 --remote-debugging-port=$Port"
      $result = [CodexActivator]::Activate($aumid, $arguments, [ref]$processId)
      if ($result -eq 0) {
        Write-Host "Activated Codex with CDP port $Port (PID $processId)."
        return
      }
      Write-Warning "MSIX activation returned HRESULT $result; using the executable fallback."
    } catch {
      Write-Warning "MSIX activation failed: $($_.Exception.Message)"
    }
  }
  $codex = Get-Process ChatGPT -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1 -ExpandProperty Path
  if (-not $codex) {
    $codex = Get-ChildItem "C:\Program Files\WindowsApps\OpenAI.Codex_*\app\ChatGPT.exe" -ErrorAction SilentlyContinue |
      Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
  }
  if (-not $codex) { throw "Codex desktop executable was not found." }
  Start-Process -FilePath $codex -ArgumentList "--remote-debugging-address=127.0.0.1 --remote-debugging-port=$Port"
}

if (-not (Test-Http "http://127.0.0.1:$MonitorPort/healthz")) {
  Write-Host "Starting AIHub monitor service on port $MonitorPort..."
  Start-Process -FilePath $node -ArgumentList @((Join-Path $pluginRoot "scripts\launcher.mjs"), "--standalone") -WindowStyle Hidden
  for ($i = 0; $i -lt 20 -and -not (Test-Http "http://127.0.0.1:$MonitorPort/healthz"); $i++) { Start-Sleep -Milliseconds 500 }
}

if ($CdpPort -le 0) { $CdpPort = Find-CdpPort 0 }
if ($CdpPort -le 0 -or -not (Test-Http "http://127.0.0.1:$CdpPort/json")) {
  if (-not $RestartCodex) {
    throw "Codex is not running with a usable CDP port. Restart Codex once with -RestartCodex, then rerun this script."
  }
  if ($CdpPort -le 0) { $CdpPort = 9347 }
  Write-Warning "Stopping Codex to enable the debug port. Save active work before continuing."
  Get-Process ChatGPT -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 2
  Start-CodexWithDebugPort $CdpPort
  for ($i = 0; $i -lt 30 -and -not (Test-Http "http://127.0.0.1:$CdpPort/json"); $i++) { Start-Sleep -Seconds 1 }
  if (-not (Test-Http "http://127.0.0.1:$CdpPort/json")) { throw "Codex CDP port $CdpPort did not come up." }
}

if (Test-Http "http://127.0.0.1:$HealthPort/healthz") {
  Write-Host "AIHub statusline injector is already running."
  exit 0
}

$env:AIHUB_STATUSLINE_CDP_PORT = [string]$CdpPort
$env:AIHUB_MONITOR_PORT = [string]$MonitorPort
$env:AIHUB_STATUSLINE_HEALTH_PORT = [string]$HealthPort
Start-Process -FilePath $node -ArgumentList (Join-Path $statuslineRoot "injector.mjs") -WindowStyle Hidden
for ($i = 0; $i -lt 20 -and -not (Test-Http "http://127.0.0.1:$HealthPort/healthz"); $i++) { Start-Sleep -Milliseconds 250 }
if (-not (Test-Http "http://127.0.0.1:$HealthPort/healthz")) { throw "AIHub statusline injector did not start." }
Write-Host "AIHub statusline injector started."
