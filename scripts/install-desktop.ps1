# Windows PowerShell 5.1+; no Git, Node, pnpm or administrator privileges required.
[CmdletBinding()]
param(
  [string]$Version = '0.1.7',
  [string]$BundleDirectory,
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }),
  [switch]$NoOpen
)
$ErrorActionPreference = 'Stop'
if (-not $BundleDirectory) { $BundleDirectory = $PSScriptRoot }
$ProgressPreference = 'SilentlyContinue'
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid release version' }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$root = [IO.Path]::GetFullPath($DshHome)
$destination = Join-Path $root 'browser-extension'
$marker = '.managed-by-dsh-browser'
$stage = Join-Path $root ('browser-install-' + [Guid]::NewGuid().ToString('N'))
$backup = Join-Path $root ('browser-backup-' + [Guid]::NewGuid().ToString('N'))

function Assert-OwnedPath([string]$Path) {
  $full = [IO.Path]::GetFullPath($Path)
  if (-not $full.StartsWith($root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Path escapes installation root' }
  if (Test-Path -LiteralPath $full) {
    $item = Get-Item -LiteralPath $full -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing linked installation path: $full" }
    foreach ($child in @(Get-ChildItem -LiteralPath $full -Recurse -Force)) {
      if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing linked installation entry: $($child.FullName)" }
    }
  }
}

function Assert-Extension([string]$Path) {
  $manifest = Get-Content -LiteralPath (Join-Path $Path 'manifest.json') -Raw | ConvertFrom-Json
  if ($manifest.manifest_version -ne 3 -or $manifest.version -ne $Version -or $manifest.background.service_worker -ne 'background.js') { throw 'Invalid extension manifest/version' }
  foreach ($entry in @('background.js', 'content.js', 'panel\index.html', '_locales\zh_CN\messages.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $Path $entry) -PathType Leaf)) { throw "Missing extension file: $entry" }
  }
}

$backedUp = $false
$installed = $false
try {
  New-Item -ItemType Directory -Path $root -Force | Out-Null
  Assert-OwnedPath $destination
  if (Test-Path -LiteralPath $destination) {
    $owned = Test-Path -LiteralPath (Join-Path $destination $marker)
    if (-not $owned -and (Test-Path -LiteralPath (Join-Path $destination 'install-info.json'))) {
      $legacy = Get-Content -LiteralPath (Join-Path $destination 'install-info.json') -Raw | ConvertFrom-Json
      $owned = $legacy.schemaVersion -eq 1 -and $legacy.mode -eq 'managed'
    }
    if (-not $owned) { throw "保留非托管目录，请先自行迁移：$destination" }
  }
  New-Item -ItemType Directory -Path $stage | Out-Null
  $archiveName = "dsh-browser-chrome-$Version.zip"
  $archive = Join-Path $stage $archiveName
  $checksums = Join-Path $stage 'SHA256SUMS.txt'
  if (Test-Path -LiteralPath (Join-Path $BundleDirectory $archiveName)) {
    Copy-Item -LiteralPath (Join-Path $BundleDirectory $archiveName) -Destination $archive
    Copy-Item -LiteralPath (Join-Path $BundleDirectory 'SHA256SUMS.txt') -Destination $checksums
  } else {
    $base = "https://github.com/iconFehu/dsh-browser/releases/download/v$Version"
    Invoke-WebRequest -UseBasicParsing "$base/$archiveName" -OutFile $archive
    Invoke-WebRequest -UseBasicParsing "$base/SHA256SUMS.txt" -OutFile $checksums
  }
  $lines = @(Get-Content -LiteralPath $checksums | Where-Object { $_ -match ('^[a-fA-F0-9]{64}  ' + [regex]::Escape($archiveName) + '$') })
  if ($lines.Count -ne 1 -or (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $lines[0].Substring(0,64)) { throw 'SHA-256 verification failed' }
  # Reject archive traversal before extraction, even when a checksum was supplied locally.
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($archive)
  try {
    foreach ($entry in $zip.Entries) {
      if ($entry.FullName -match '(^[/\\]|:|(^|[/\\])\.\.([/\\]|$))') { throw 'Unsafe archive entry' }
    }
  } finally { $zip.Dispose() }
  $extension = Join-Path $stage 'extension'
  Expand-Archive -LiteralPath $archive -DestinationPath $extension
  Assert-Extension $extension
  Set-Content -LiteralPath (Join-Path $extension $marker) -Value $Version -Encoding UTF8
  Set-Content -LiteralPath (Join-Path $extension 'install-info.json') -Value '{"schemaVersion":1,"mode":"managed"}' -Encoding UTF8
  if (Test-Path -LiteralPath $destination) {
    Assert-OwnedPath $destination
    Assert-OwnedPath $backup
    Move-Item -LiteralPath $destination -Destination $backup
    $backedUp = $true
  }
  Assert-OwnedPath $extension
  Move-Item -LiteralPath $extension -Destination $destination
  $installed = $true
  Assert-Extension $destination
} catch {
  if ($installed) { Assert-OwnedPath $destination; Remove-Item -LiteralPath $destination -Recurse -Force }
  if ($backedUp) { Assert-OwnedPath $backup; Move-Item -LiteralPath $backup -Destination $destination }
  throw
} finally {
  if (Test-Path -LiteralPath $stage) { Assert-OwnedPath $stage; Remove-Item -LiteralPath $stage -Recurse -Force }
}
# Preserve the previous version as a recoverable backup after a successful update.
Write-Host "安装完成 / Installed v$Version : $destination"
if ($backedUp) { Write-Host "上一版本备份 / Previous version: $backup" }
Write-Host '首次：Chrome 扩展管理页开启开发者模式，加载上述目录；更新：点击扩展的重新加载。'
Write-Host '启动 DSH Desktop，在设置中启用兼容模式和浏览器访问。扩展桥地址留空，打开侧边栏自动连接。'
Write-Host 'First use: load the directory in chrome://extensions; on updates click Reload. Enable Desktop compatibility mode and browser access.'
if (-not $NoOpen) {
  try { Set-Clipboard -Value $destination } catch { Write-Warning '无法复制路径，请使用上方路径。' }
  try { Start-Process 'chrome.exe' -ArgumentList 'chrome://extensions' -WindowStyle Hidden } catch { Write-Host '请手动打开 chrome://extensions' }
}
