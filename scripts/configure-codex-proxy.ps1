param(
  [ValidateSet("Enable", "Disable")][string]$Mode = "Enable",
  [string]$ConfigPath = (Join-Path $env:USERPROFILE ".codex\config.toml"),
  [string]$DataRoot = (Join-Path $env:LOCALAPPDATA "AIHubCodexMonitor"),
  [int]$MonitorPort = 48160
)

$ErrorActionPreference = "Stop"
$proxyUrl = "http://127.0.0.1:$MonitorPort/v1"
$backupPath = Join-Path $DataRoot "codex-provider-backup.json"

if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw "Codex config was not found: $ConfigPath" }
if ($Mode -eq "Enable") {
  try { Invoke-RestMethod -Uri "http://127.0.0.1:$MonitorPort/healthz" -TimeoutSec 3 | Out-Null }
  catch { throw "The AIHub monitor is not healthy on port $MonitorPort. Start it before enabling the proxy." }
}

$lines = [Collections.Generic.List[string]]::new()
[IO.File]::ReadAllLines($ConfigPath) | ForEach-Object { $lines.Add($_) }
$providerName = $null
foreach ($line in $lines) {
  if ($line -match '^\s*model_provider\s*=\s*"([^"]+)"\s*(?:#.*)?$') { $providerName = $Matches[1]; break }
}
if (-not $providerName) { throw "The top-level model_provider setting could not be found." }

$headers = @("[model_providers.$providerName]", "[model_providers.`"$providerName`"]")
$sectionStart = -1
for ($index = 0; $index -lt $lines.Count; $index++) {
  if ($headers -contains $lines[$index].Trim()) { $sectionStart = $index; break }
}
if ($sectionStart -lt 0) { throw "The model provider section for '$providerName' could not be found." }

$sectionEnd = $lines.Count
for ($index = $sectionStart + 1; $index -lt $lines.Count; $index++) {
  if ($lines[$index] -match '^\s*\[') { $sectionEnd = $index; break }
}
$baseUrlIndex = -1
$currentUrl = $null
for ($index = $sectionStart + 1; $index -lt $sectionEnd; $index++) {
  if ($lines[$index] -match '^\s*base_url\s*=\s*"([^"]+)"\s*(?:#.*)?$') {
    $baseUrlIndex = $index
    $currentUrl = $Matches[1]
    break
  }
}
if ($baseUrlIndex -lt 0) { throw "The base_url setting for '$providerName' could not be found." }

if ($Mode -eq "Enable") {
  if ($currentUrl -eq $proxyUrl) { Write-Host "Codex already uses the AIHub loopback proxy."; exit 0 }
  if ($currentUrl -notmatch '^https://aihub\.top(?:/|$)') {
    throw "Refusing to replace an unexpected provider URL: $currentUrl"
  }
  New-Item -ItemType Directory -Path $DataRoot -Force | Out-Null
  [ordered]@{ provider = $providerName; baseUrl = $currentUrl; savedAt = [DateTime]::UtcNow.ToString("o") } |
    ConvertTo-Json | Set-Content -LiteralPath $backupPath -Encoding utf8
  $nextUrl = $proxyUrl
} else {
  if (-not (Test-Path -LiteralPath $backupPath -PathType Leaf)) { throw "No saved Codex provider backup exists at $backupPath" }
  $backup = Get-Content -Raw -LiteralPath $backupPath | ConvertFrom-Json
  if ($backup.provider -ne $providerName -or $backup.baseUrl -notmatch '^https://aihub\.top(?:/|$)') {
    throw "The saved Codex provider backup is invalid for '$providerName'."
  }
  $nextUrl = [string]$backup.baseUrl
}

$indent = if ($lines[$baseUrlIndex] -match '^(\s*)') { $Matches[1] } else { "" }
$lines[$baseUrlIndex] = "${indent}base_url = `"$nextUrl`""
$temporary = "$ConfigPath.$PID.tmp"
try {
  [IO.File]::WriteAllLines($temporary, $lines, [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $ConfigPath -Force
} finally {
  if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
}
Write-Host "Codex provider '$providerName' now uses $nextUrl"
Write-Host "The change applies to new Codex requests/tasks."
