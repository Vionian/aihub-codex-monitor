param(
  [string]$DataDir = (Join-Path $env:LOCALAPPDATA "AIHubCodexMonitor"),
  [switch]$ImportToken
)

$ErrorActionPreference = "Stop"
if (-not $env:LOCALAPPDATA -and -not $PSBoundParameters.ContainsKey("DataDir")) {
  throw "LOCALAPPDATA is unavailable. Pass -DataDir explicitly."
}

function ConvertFrom-LocalSecureString {
  param([Security.SecureString]$Value)
  if ($null -eq $Value -or $Value.Length -eq 0) { return "" }
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

$payload = [ordered]@{
  version      = 2
  email        = ""
  password     = ""
  accessToken  = ""
  refreshToken = ""
  expiresAt    = $null
  cookie       = ""
  userAgent    = ""
}

if ($ImportToken) {
  $secureToken = Read-Host "AIHub login access token" -AsSecureString
  if ($secureToken.Length -eq 0) { throw "The access token cannot be empty." }
  $payload.accessToken = ConvertFrom-LocalSecureString $secureToken
} else {
  $email = (Read-Host "AIHub login email").Trim()
  if (-not $email) { throw "The AIHub login email cannot be empty." }
  $securePassword = Read-Host "AIHub login password" -AsSecureString
  if ($securePassword.Length -eq 0) { throw "The AIHub login password cannot be empty." }
  $payload.email = $email
  $payload.password = ConvertFrom-LocalSecureString $securePassword
}

$secureCookie = Read-Host "Cloudflare Cookie (optional; press Enter to skip)" -AsSecureString
if ($secureCookie.Length -gt 0) {
  $payload.cookie = ConvertFrom-LocalSecureString $secureCookie
  $payload.userAgent = (Read-Host "Browser User-Agent matching that Cookie").Trim()
}

New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
$target = Join-Path $DataDir "credential.xml"
$temporary = "$target.$PID.tmp"
$json = $payload | ConvertTo-Json -Compress
$securePayload = ConvertTo-SecureString -String $json -AsPlainText -Force
$securePayload | Export-Clixml -LiteralPath $temporary
Move-Item -LiteralPath $temporary -Destination $target -Force
Write-Host "AIHub login credential stored with Windows DPAPI at $target"
try {
  Invoke-RestMethod -Uri "http://127.0.0.1:48160/api/actions/reload-credentials" `
    -Method Post -ContentType "application/json" -Body "{}" -TimeoutSec 20 | Out-Null
  $state = Invoke-RestMethod -Uri "http://127.0.0.1:48160/api/state" -TimeoutSec 10
  if ($state.runtime.auth.authenticated) {
    Write-Host "AIHub login succeeded. The monitor is authenticated."
  } else {
    $reason = $state.runtime.auth.lastError
    if (-not $reason) { $reason = "AIHub did not accept the saved login." }
    Write-Warning "Credential saved, but authentication failed: $reason"
  }
} catch {
  Write-Warning "The credential was saved, but the running monitor could not reload it: $($_.Exception.Message)"
  Write-Host "Restart only the AIHub monitor service, or sign out and back in. Codex itself does not need to be restarted."
}
