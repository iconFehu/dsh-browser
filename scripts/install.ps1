# Desktop is the default. Use -Runtime Web for the source-based standard dsh web installer.
[CmdletBinding()]
param(
  [ValidateSet('Desktop', 'Web')][string]$Runtime = 'Desktop',
  [string]$Version = '0.1.5',
  [string]$BundleDirectory,
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }),
  [switch]$NoOpen
)
$ErrorActionPreference = 'Stop'
if (-not $BundleDirectory) { $BundleDirectory = $PSScriptRoot }
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid version' }
$scriptName = if ($Runtime -eq 'Desktop') { 'install-desktop.ps1' } else { 'install-web.ps1' }
$scriptPath = Join-Path $PSScriptRoot $scriptName
if (-not (Test-Path -LiteralPath $scriptPath)) {
  throw "请下载完整 Windows 安装包并解压后运行 install.ps1 / Download and extract the complete Windows release bundle. Missing: $scriptName"
}
if ($Runtime -eq 'Desktop') {
  & $scriptPath -Version $Version -BundleDirectory $BundleDirectory -DshHome $DshHome -NoOpen:$NoOpen
} else {
  if ($Version -ne '0.1.5') { throw 'Use the matching release installer for standard web.' }
  $env:DSH_HOME = $DshHome
  & $scriptPath
}
