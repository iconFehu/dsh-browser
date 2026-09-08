param(
  [string]$HostPath = "$PSScriptRoot\..\dist\native-host.mjs",
  [string]$ExtensionId = $env:DSH_EXTENSION_ID
)
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($ExtensionId)) { $ExtensionId = 'REPLACE_WITH_EXTENSION_ID' }
$manifestPath = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data\NativeMessagingHosts\com.dsh.browser.native.json'
New-Item -ItemType Directory -Force -Path (Split-Path $manifestPath) | Out-Null
$manifest = [ordered]@{ name='com.dsh.browser.native'; description='dsh-browser-native Native Messaging host'; path=(Resolve-Path $HostPath).Path; type='stdio'; allowed_origins=@("chrome-extension://$ExtensionId/") }
$manifest | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 -LiteralPath $manifestPath
Write-Host "Installed Native Messaging manifest: $manifestPath"
