# Build with pnpm run build before invoking. This script only packages built artifacts.
[CmdletBinding()]
param([string]$OutputDirectory = (Join-Path $PSScriptRoot '../release'))
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$version = (Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
$output = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $output -Force | Out-Null
$extension = Join-Path $repo 'extensions/dsh-browser/dist'
$manifest = Get-Content (Join-Path $extension 'manifest.json') -Raw | ConvertFrom-Json
if ($manifest.version -ne $version) { throw 'Build version mismatch' }
foreach ($scriptName in @('install.ps1', 'install-desktop.ps1', 'install-web.ps1', 'install.sh')) {
  $source = Get-Content -LiteralPath (Join-Path $PSScriptRoot $scriptName) -Raw
  if (-not $source.Contains("'$version'") -and -not $source.Contains("v$version")) { throw "Installer version mismatch: $scriptName" }
}
$chromeName = "dsh-browser-chrome-$version.zip"
Compress-Archive -Path (Join-Path $extension '*') -DestinationPath (Join-Path $output $chromeName) -Force
Push-Location (Join-Path $repo 'packages/browser/bridge-browser')
try {
  pnpm pack --pack-destination $output
  if ($LASTEXITCODE -ne 0) { throw 'Bridge packaging failed' }
} finally { Pop-Location }
foreach ($name in @('install.ps1', 'install-desktop.ps1', 'install-web.ps1', 'install.sh')) {
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $output $name) -Force
}
Copy-Item -LiteralPath (Join-Path $repo 'README.zh.md') -Destination (Join-Path $output 'README.zh.md') -Force
$files = @($chromeName, 'install.ps1', 'install-desktop.ps1', 'install-web.ps1', 'install.sh', 'README.zh.md') + @(Get-ChildItem -LiteralPath $output -Filter '*.tgz' | Select-Object -ExpandProperty Name)
$lines = foreach ($name in $files) { "{0}  {1}" -f (Get-FileHash -LiteralPath (Join-Path $output $name) -Algorithm SHA256).Hash.ToLowerInvariant(), $name }
Set-Content -LiteralPath (Join-Path $output 'SHA256SUMS.txt') -Value $lines -Encoding ASCII
$bundle = Join-Path $output 'dsh-browser-windows.zip'
Compress-Archive -LiteralPath @($files + 'SHA256SUMS.txt' | ForEach-Object { Join-Path $output $_ }) -DestinationPath $bundle -Force
Write-Host "Windows bundle: $bundle"
