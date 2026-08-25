[CmdletBinding()]
param(
  [string]$OutputDirectory,
  [string]$Version
)

$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $root 'dist' }
if (-not [System.IO.Path]::IsPathRooted($OutputDirectory)) {
  $OutputDirectory = Join-Path $root $OutputDirectory
}
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)

$package = Get-Content -Raw -LiteralPath (Join-Path $root 'package.json') |
  ConvertFrom-Json -ErrorAction Stop
if (-not $Version) { $Version = "$($package.version)" }
if ($Version -cnotmatch '\A[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?\z') {
  throw "Invalid release version: $Version"
}
$manifest = Get-Content -Raw -LiteralPath (Join-Path $root '.codex-plugin\plugin.json') |
  ConvertFrom-Json -ErrorAction Stop
$manifestBaseVersion = "$($manifest.version)" -replace '\+.*\z', ''
$versionSource = Get-Content -Raw -LiteralPath (Join-Path $root 'src\version.mjs')
if ($package.name -cne 'aihub-codex-monitor' -or "$($package.version)" -cne $Version -or
  $manifest.name -cne 'aihub-codex-monitor' -or $manifestBaseVersion -cne $Version -or
  $versionSource -notmatch ('VERSION = "' + [regex]::Escape($Version) + '"')) {
  throw 'Monitor package, manifest, and runtime versions do not match.'
}

$packageName = "aihub-codex-monitor-$Version"
$stagingParent = Join-Path ([System.IO.Path]::GetTempPath()) (
  'AIHubCodexMonitorRelease.' + [Guid]::NewGuid().ToString('N')
)
$packageRoot = Join-Path $stagingParent $packageName
$zipPath = Join-Path $OutputDirectory "$packageName.zip"
$checksumPath = "$zipPath.sha256"
$include = @(
  '.codex-plugin',
  '.mcp.json',
  'assets',
  'docs',
  'scripts',
  'skills',
  'src',
  'statusline',
  'CHANGELOG.md',
  'codex-config.example.toml',
  'config.example.json',
  'config.generic.example.json',
  'install.bat',
  'LICENSE',
  'package.json',
  'README.md',
  'server.mjs'
)

try {
  $null = New-Item -ItemType Directory -Path $packageRoot -Force
  foreach ($relativePath in $include) {
    $source = Join-Path $root $relativePath
    if (-not (Test-Path -LiteralPath $source)) {
      throw "Release input is missing: $relativePath"
    }
    Copy-Item -LiteralPath $source -Destination $packageRoot -Recurse -Force
  }
  foreach ($requiredPath in @(
      'install.bat',
      '.codex-plugin\plugin.json',
      'scripts\publish-personal.ps1',
      'server.mjs'
    )) {
    if (-not (Test-Path -LiteralPath (Join-Path $packageRoot $requiredPath) -PathType Leaf)) {
      throw "Release package is missing its install entry point: $requiredPath"
    }
  }

  $null = New-Item -ItemType Directory -Path $OutputDirectory -Force
  foreach ($oldPath in @($zipPath, $checksumPath)) {
    if (Test-Path -LiteralPath $oldPath -PathType Leaf) {
      Remove-Item -LiteralPath $oldPath -Force
    }
  }
  Compress-Archive -LiteralPath $packageRoot -DestinationPath $zipPath -CompressionLevel Optimal
  $hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $encoding = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::WriteAllText(
    $checksumPath,
    "$hash  $([System.IO.Path]::GetFileName($zipPath))`r`n",
    $encoding
  )
  Write-Host "Release archive: $zipPath"
  Write-Host "SHA256: $hash"
} finally {
  if (Test-Path -LiteralPath $stagingParent -PathType Container) {
    Remove-Item -LiteralPath $stagingParent -Recurse -Force -ErrorAction SilentlyContinue
  }
}
