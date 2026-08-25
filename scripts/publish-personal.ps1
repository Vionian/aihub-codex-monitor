param(
  [string]$SourceRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$TargetRoot = (Join-Path $env:USERPROFILE "plugins\aihub-codex-monitor"),
  [int]$Port = 48160,
  [int]$StatuslineHealthPort = 48161,
  [switch]$StopRunningMonitor,
  [switch]$SelfTest
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

function Ensure-PersonalMarketplaceEntry {
  param(
    [string]$MarketplacePath = (Join-Path $env:USERPROFILE ".agents\plugins\marketplace.json")
  )
  $marketplacePath = [System.IO.Path]::GetFullPath($MarketplacePath)
  $marketplaceDirectory = Split-Path -Parent $marketplacePath
  $payload = $null
  $changed = $false
  if (Test-Path -LiteralPath $marketplacePath -PathType Leaf) {
    try {
      $payload = Get-Content -Raw -LiteralPath $marketplacePath | ConvertFrom-Json -ErrorAction Stop
    } catch {
      throw "The personal marketplace file is invalid JSON and was preserved: $marketplacePath"
    }
    if ($null -eq $payload -or $payload -is [array] -or $payload -is [string]) {
      throw "The personal marketplace file must contain a JSON object: $marketplacePath"
    }
    if (-not "$($payload.name)" -or "$($payload.name)" -notmatch '\A[A-Za-z0-9_-]+\z') {
      throw "The personal marketplace has an invalid name: $marketplacePath"
    }
    if ($null -eq $payload.PSObject.Properties['plugins']) {
      $payload | Add-Member -NotePropertyName plugins -NotePropertyValue @()
      $changed = $true
    } elseif ($null -ne $payload.plugins -and $payload.plugins -isnot [array] -and
      $payload.plugins -isnot [System.Collections.IEnumerable]) {
      throw "The personal marketplace plugins field must be an array: $marketplacePath"
    }
  } else {
    $payload = [pscustomobject][ordered]@{
      name = 'personal'
      interface = [pscustomobject][ordered]@{ displayName = 'Personal' }
      plugins = @()
    }
    $changed = $true
  }

  $entry = [pscustomobject][ordered]@{
    name = 'aihub-codex-monitor'
    source = [pscustomobject][ordered]@{
      source = 'local'
      path = './plugins/aihub-codex-monitor'
    }
    policy = [pscustomobject][ordered]@{
      installation = 'AVAILABLE'
      authentication = 'ON_INSTALL'
    }
    category = 'Productivity'
  }
  $plugins = @($payload.plugins)
  $entryJson = $entry | ConvertTo-Json -Depth 10 -Compress
  $found = $false
  for ($index = 0; $index -lt $plugins.Count; $index++) {
    if ($null -ne $plugins[$index] -and "$($plugins[$index].name)" -ceq 'aihub-codex-monitor') {
      $found = $true
      if (($plugins[$index] | ConvertTo-Json -Depth 10 -Compress) -cne $entryJson) {
        $plugins[$index] = $entry
        $changed = $true
      }
      break
    }
  }
  if (-not $found) {
    $plugins += $entry
    $changed = $true
  }
  $payload.plugins = @($plugins)

  if ($changed) {
    $null = New-Item -ItemType Directory -Path $marketplaceDirectory -Force
    $temporaryPath = Join-Path $marketplaceDirectory (
      '.marketplace.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    )
    try {
      $encoding = [System.Text.UTF8Encoding]::new($false)
      $content = ($payload | ConvertTo-Json -Depth 20) + "`r`n"
      [System.IO.File]::WriteAllText($temporaryPath, $content, $encoding)
      Move-Item -LiteralPath $temporaryPath -Destination $marketplacePath -Force
    } finally {
      if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) {
        Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
      }
    }
  }
  return "$($payload.name)"
}

if ($SelfTest) {
  $testRoot = Join-Path ([System.IO.Path]::GetTempPath()) (
    'AIHubCodexMonitorInstallerTest.' + [Guid]::NewGuid().ToString('N')
  )
  $testMarketplace = Join-Path $testRoot 'marketplace.json'
  try {
    $firstName = Ensure-PersonalMarketplaceEntry -MarketplacePath $testMarketplace
    $secondName = Ensure-PersonalMarketplaceEntry -MarketplacePath $testMarketplace
    $testPayload = Get-Content -Raw -LiteralPath $testMarketplace |
      ConvertFrom-Json -ErrorAction Stop
    $entries = @($testPayload.plugins | Where-Object { $_.name -ceq 'aihub-codex-monitor' })
    if ($firstName -cne 'personal' -or $secondName -cne 'personal' -or
      $entries.Count -ne 1 -or
      $entries[0].source.path -cne './plugins/aihub-codex-monitor') {
      throw 'Personal marketplace installer self-test returned an invalid entry.'
    }
    Write-Host 'AIHub Codex Monitor installer self-test passed.'
  } finally {
    if (Test-Path -LiteralPath $testRoot -PathType Container) {
      Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  return
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

$manifestPath = Join-Path $SourceRoot ".codex-plugin\plugin.json"
try { $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json -ErrorAction Stop } catch {
  throw "Plugin manifest is invalid JSON: $manifestPath"
}
if ($manifest.name -cne 'aihub-codex-monitor' -or -not "$($manifest.version)") {
  throw "Plugin manifest name or version is invalid: $manifestPath"
}

New-Item -ItemType Directory -Path $TargetRoot -Force | Out-Null
Get-ChildItem -Force -LiteralPath $SourceRoot | Where-Object {
  $_.Name -notin @(".dev-data", ".launcher-data", ".git", "dist")
} | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination $TargetRoot -Recurse -Force
}

$marketplaceName = Ensure-PersonalMarketplaceEntry

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
