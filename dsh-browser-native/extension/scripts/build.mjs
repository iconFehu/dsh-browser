import { build } from 'esbuild'
import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const extension = join(root, '..')
const firefox = process.argv.includes('--firefox')
const out = join(extension, firefox ? 'dist-firefox' : 'dist')
await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })
for (const entry of ['background', 'content']) {
  await build({ entryPoints: [join(extension, 'src', `${entry}.ts`)], bundle: true, format: 'esm', platform: 'browser', target: firefox ? 'firefox120' : 'chrome116', outfile: join(out, `${entry}.js`), sourcemap: true })
}
await mkdir(join(out, 'panel'), { recursive: true })
await cp(join(extension, 'panel', 'index.html'), join(out, 'panel', 'index.html'))
await cp(join(extension, 'panel', 'panel.css'), join(out, 'panel', 'panel.css'))
await cp(join(extension, 'panel', 'panel.js'), join(out, 'panel', 'panel.js'))
await cp(join(extension, firefox ? 'manifest.firefox.json' : 'manifest.chrome.json'), join(out, 'manifest.json'))
console.log(`Built ${firefox ? 'Firefox' : 'Chrome'} extension: ${out}`)
