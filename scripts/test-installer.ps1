# Exercises the real offline installer in isolated directories, never the user's DSH home.
param([Parameter(Mandatory = $true)][string]$BundleDirectory)
$ErrorActionPreference = 'Stop'
$bundle = (Resolve-Path -LiteralPath $BundleDirectory).Path
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('dsh-installer-test-' + [Guid]::NewGuid().ToString('N'))
$originalPath = $env:PATH
# Simulate a consumer machine without Git/Node/pnpm on PATH.
$env:PATH = "$env:SystemRoot\System32;$env:SystemRoot\System32\WindowsPowerShell\v1.0"
$testHome = Join-Path $testRoot '中文 path with spaces'
$installer = Join-Path $PSScriptRoot 'install-desktop.ps1'
function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Expect-Failure([scriptblock]$Operation) {
  $failed = $false
  try { & $Operation } catch { $failed = $true }
  Assert $failed 'Expected installer failure'
}
try {
  & $installer -BundleDirectory $bundle -DshHome $testHome -NoOpen
  $manifest = Join-Path $testHome 'browser-extension\manifest.json'
  Assert (Test-Path -LiteralPath $manifest) 'Fresh install failed'
  $before = (Get-FileHash -LiteralPath $manifest).Hash
  & $installer -BundleDirectory $bundle -DshHome $testHome -NoOpen
  Assert (@(Get-ChildItem -LiteralPath $testHome -Filter 'browser-backup-*').Count -eq 1) 'Update backup missing'
  Assert ((Get-FileHash -LiteralPath $manifest).Hash -eq $before) 'Repeated install changed manifest'
  $oldManifest = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
  $oldManifest.version = '0.1.3'
  $oldManifest | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $manifest -Encoding UTF8
  & $installer -BundleDirectory $bundle -DshHome $testHome -NoOpen
  Assert ((Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json).version -eq '0.1.4') 'Version upgrade failed'
  $bad = Join-Path $testRoot 'bad-bundle'
  New-Item -ItemType Directory -Path $bad -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $bundle 'dsh-browser-chrome-0.1.4.zip') -Destination $bad
  Set-Content -LiteralPath (Join-Path $bad 'SHA256SUMS.txt') -Value ('0' * 64 + '  dsh-browser-chrome-0.1.4.zip')
  Expect-Failure { & $installer -BundleDirectory $bad -DshHome $testHome -NoOpen }
  Assert ((Get-FileHash -LiteralPath $manifest).Hash -eq $before) 'Failed verification damaged old install'
  $unmanaged = Join-Path $testRoot 'unmanaged'
  New-Item -ItemType Directory -Path (Join-Path $unmanaged 'browser-extension') -Force | Out-Null
  $sentinel = Join-Path $unmanaged 'browser-extension\my-source.txt'
  Set-Content -LiteralPath $sentinel -Value 'keep'
  Expect-Failure { & $installer -BundleDirectory $bundle -DshHome $unmanaged -NoOpen }
  Assert ((Get-Content -LiteralPath $sentinel) -eq 'keep') 'Unmanaged source changed'
  # Inject a move failure after the old version has been backed up; verify restoration.
  function Move-Item {
    param([string]$LiteralPath, [string]$Destination)
    if ((Split-Path -Leaf $LiteralPath) -eq 'extension') { throw 'Injected staged-move failure' }
    Microsoft.PowerShell.Management\Move-Item -LiteralPath $LiteralPath -Destination $Destination
  }
  Expect-Failure { & $installer -BundleDirectory $bundle -DshHome $testHome -NoOpen }
  Assert ((Get-FileHash -LiteralPath $manifest).Hash -eq $before) 'Rollback failed'
  Write-Host 'PASS: fresh install, repeat/update, checksum failure, unmanaged directory, rollback, Unicode/spaces.'
} finally {
  $env:PATH = $originalPath
  $resolved = [IO.Path]::GetFullPath($testRoot)
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  if (-not $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $resolved) -notlike 'dsh-installer-test-*') { throw 'Unsafe cleanup path' }
  if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
