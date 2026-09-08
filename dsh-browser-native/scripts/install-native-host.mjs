import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { platform, env } from 'node:process'

const hostPath = resolve(env.DSH_NATIVE_HOST_PATH ?? resolve('dist/native-host.mjs'))
const extensionId = env.DSH_EXTENSION_ID ?? 'REPLACE_WITH_EXTENSION_ID'
const hostName = 'com.dsh.browser.native'
const browser = process.argv.includes('--firefox') ? 'firefox' : (env.DSH_BROWSER ?? 'chrome')
let executablePath = hostPath
if (platform === 'win32' && hostPath.toLowerCase().endsWith('.mjs')) {
  executablePath = `${hostPath}.cmd`
  await writeFile(executablePath, `@echo off\r\n"${process.execPath}" "${hostPath}"\r\n`, 'utf8')
} else if (platform !== 'win32' && hostPath.toLowerCase().endsWith('.mjs')) {
  executablePath = `${hostPath}.sh`
  await writeFile(executablePath, `#!/bin/sh\nexec "${process.execPath}" "${hostPath}"\n`, 'utf8')
  await chmod(executablePath, 0o755)
}
const manifest = browser === 'firefox'
  ? { name: hostName, description: 'dsh-browser-native Native Messaging host', path: executablePath, type: 'stdio', allowed_extensions: [extensionId] }
  : { name: hostName, description: 'dsh-browser-native Native Messaging host', path: executablePath, type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`] }

const target = env.DSH_NATIVE_MANIFEST_PATH ?? (
  browser === 'firefox'
    ? platform === 'win32'
      ? resolve(env.APPDATA ?? '.', 'Mozilla', 'NativeMessagingHosts', `${hostName}.json`)
      : platform === 'darwin'
        ? resolve(env.HOME ?? '.', 'Library', 'Application Support', 'Mozilla', 'NativeMessagingHosts', `${hostName}.json`)
        : resolve(env.XDG_CONFIG_HOME ?? resolve(env.HOME ?? '.', '.config'), 'mozilla', 'NativeMessagingHosts', `${hostName}.json`)
    : platform === 'win32'
    ? resolve(env.LOCALAPPDATA ?? '.', 'Google', 'Chrome', 'User Data', 'NativeMessagingHosts', `${hostName}.json`)
    : platform === 'darwin'
      ? resolve(env.HOME ?? '.', 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts', `${hostName}.json`)
      : resolve(env.XDG_CONFIG_HOME ?? resolve(env.HOME ?? '.', '.config'), 'google-chrome', 'NativeMessagingHosts', `${hostName}.json`)
)
await mkdir(dirname(target), { recursive: true })
await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
console.log(`Installed Native Messaging manifest: ${target}`)
