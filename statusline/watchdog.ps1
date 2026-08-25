param(
  [int]$MonitorPort = 48160,
  [int]$HealthPort = 48161,
  [int]$PollSeconds = 10
)

$ErrorActionPreference = "Continue"
$statuslineRoot = $PSScriptRoot
$pluginRoot = Split-Path -Parent $statuslineRoot
$launcher = Join-Path $statuslineRoot "launch-statusline.ps1"
$dataRoot = Join-Path $env:LOCALAPPDATA "AIHubCodexMonitor"
$logPath = Join-Path $dataRoot "statusline-supervisor.log"
$stopMarker = Join-Path $dataRoot "statusline-supervisor.stop"
$mutex = [Threading.Mutex]::new($false, "Local\AIHubCodexMonitor.StatuslineSupervisor")
$acquired = $false

function Test-Http([string]$Uri) {
  try { return [bool](Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 2) } catch { return $false }
}

function Write-SupervisorLog([string]$Message) {
  try {
    New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null
    $line = "[aihub-monitor] $([DateTime]::UtcNow.ToString('o')) $Message`r`n"
    [IO.File]::AppendAllText($logPath, $line, [Text.UTF8Encoding]::new($false))
  } catch {}
}

try {
  try { $acquired = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $acquired = $true }
  if (-not $acquired) { exit 0 }
  Write-SupervisorLog "Supervisor started from $pluginRoot"
  while (-not (Test-Path -LiteralPath $stopMarker -PathType Leaf)) {
    try {
      $monitorReady = Test-Http "http://127.0.0.1:$MonitorPort/healthz"
      $cdpReady = (Test-Http "http://127.0.0.1:9347/json") -or
        (Test-Http "http://127.0.0.1:9224/json") -or
        (Test-Http "http://127.0.0.1:9222/json")
      $injectorReady = Test-Http "http://127.0.0.1:$HealthPort/healthz"
      if (-not $monitorReady -or ($cdpReady -and -not $injectorReady)) {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $launcher `
          -MonitorPort $MonitorPort -HealthPort $HealthPort | Out-Null
        Write-SupervisorLog "Recovered monitor=$(-not $monitorReady) injector=$($cdpReady -and -not $injectorReady)"
      }
    } catch {
      Write-SupervisorLog "Recovery failed: $($_.Exception.Message)"
    }
    Start-Sleep -Seconds ([Math]::Max(5, $PollSeconds))
  }
  Write-SupervisorLog "Stop marker observed; supervisor exiting"
} finally {
  if ($acquired) { try { $mutex.ReleaseMutex() } catch {} }
  $mutex.Dispose()
}
