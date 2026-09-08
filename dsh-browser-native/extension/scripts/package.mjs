import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = dirname(fileURLToPath(import.meta.url))
const extension = join(root, '..')
const firefox = process.argv.includes('--firefox')
const dist = join(extension, firefox ? 'dist-firefox' : 'dist')
const output = join(extension, 'release')
await mkdir(output, { recursive: true })
await run('node', [join(extension, 'scripts', 'build.mjs'), ...(firefox ? ['--firefox'] : [])])
const archive = join(output, firefox ? 'dsh-browser-native-firefox.zip' : 'dsh-browser-native-chrome.zip')
await rm(archive, { force: true })
if (process.platform === 'win32') {
  await run('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${dist}\\*' -DestinationPath '${archive}' -Force`])
} else {
  await run('zip', ['-qr', archive, '.'], { cwd: dist })
}
console.log(`Packaged ${firefox ? 'Firefox' : 'Chrome'} extension: ${archive}`)
