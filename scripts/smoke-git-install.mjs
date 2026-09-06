import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

/**
 * Git-install smoke: prove the bridge can be registered through
 * `dsh plugin --profile web add -w <git-spec>&path:/packages/browser/bridge-browser`
 * and then serve a real web host, exactly like a consumer who has not
 * published the package (or who prefers the git channel).
 *
 * Self-contained: the "remote" is a fresh git clone of this repository
 * (commit a373b55 or later carries the `prepare` script that builds the
 * gitignored lib/ during install). The first pnpm add hits the allowBuilds
 * gate by design; the smoke appends the printed allowlist key to the
 * profile's pnpm-workspace.yaml and re-runs, mirroring what dsh's CLI
 * instructs users to do.
 */

const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(join(root, 'package.json'))
const cli = join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js')
const bridgeRequire = createRequire(join(root, 'packages/browser/bridge-browser/package.json'))
const { default: WebSocket } = await import(pathToFileURL(bridgeRequire.resolve('ws')).href)
const bridgeName = JSON.parse(await readFile(join(root, 'packages/browser/bridge-browser/package.json'), 'utf8')).name
const temp = await mkdtemp(join(tmpdir(), 'dsh-git-install-'))
const remote = join(temp, 'remote')
const home = join(temp, 'home')
const patch = join(temp, 'cfg.patch.yml')
const token = randomUUID()
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
// Do not inherit bridge settings or credentials from the developer's shell.
delete env.DSH_EXT_TOKEN
delete env.DSH_BROWSER_SESSION_WORKSPACE
let host
let socket
let hostLog = ''
let succeeded = false

async function waitFor(check, label, timeout = 90_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (host && (host.exitCode !== null || host.signalCode !== null)) {
      throw new Error(`DSH exited (${host.exitCode ?? host.signalCode}) while waiting for ${label}`)
    }
    const value = await check()
    if (value) return value
    await delay(100)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function git(args, options) {
  const result = spawnSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'], ...options })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.status}):\n${result.stdout}${result.stderr}`)
  }
  return result.stdout.toString().trim()
}

async function run(args) {
  const child = spawn(process.execPath, [cli, ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 300_000)
  try {
    const [code] = await once(child, 'exit')
    return { code, output }
  } finally { clearTimeout(timeout) }
}

async function boot() {
  // Same settings overlay smoke-runtime/smoke-publish use.
  await writeFile(patch, [
    '- id: bridge-browser',
    '  config:',
    `    token: ${JSON.stringify(token)}`,
    '    sessionWorkspacePath: ""',
    '    deferSessionCreate: false',
    '',
  ].join('\n'))
  hostLog = ''
  host = spawn(process.execPath, [cli, 'web', '--patch', patch, '--no-open', '--port', '0'], {
    cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  host.stdout.on('data', data => { hostLog += data })
  host.stderr.on('data', data => { hostLog += data })
  let spawnError
  host.on('error', error => { spawnError = error })
  const base = await waitFor(() => {
    if (spawnError) throw spawnError
    return hostLog.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+)/)?.[1]
  }, 'host readiness')
  const response = await fetch(`${base}/ext/bridge-config`, { signal: AbortSignal.timeout(10_000) })
  assert.equal(response.status, 200)
  const config = await response.json()
  assert.equal(config.wsUrl, base.replace('http:', 'ws:') + '/ext/bridge')
  // Firefox-style origin requires a valid token even on loopback.
  socket = new WebSocket(config.wsUrl, { origin: 'moz-extension://git-install-smoke', handshakeTimeout: 10_000 })
  const frames = []
  let socketError
  socket.on('error', error => { socketError = error })
  socket.on('message', data => { frames.push(JSON.parse(data.toString())) })
  await once(socket, 'open')
  socket.send(JSON.stringify({ t: 'hello', token, caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 } }))
  await waitFor(() => {
    if (socketError) throw socketError
    const ok = frames.find(value => value.t === 'hello.ok')
    if (ok) return ok
    if (socket.readyState === WebSocket.CLOSED) throw new Error(`Bridge closed: ${JSON.stringify(frames)}`)
    return undefined
  }, 'hello.ok', 15_000)
}

async function stop() {
  socket?.terminate()
  socket = undefined
  if (!host || host.exitCode !== null || host.signalCode !== null) return
  const exited = once(host, 'exit')
  host.kill('SIGTERM')
  const timeout = setTimeout(() => host.kill('SIGKILL'), 10_000)
  try { await exited } finally { clearTimeout(timeout) }
  host = undefined
}

try {
  // Fresh clone of the current checkout doubles as the git "remote"; the
  // HEAD commit must carry the bridge's prepare script (builds lib/).
  await mkdir(temp, { recursive: true })
  git(['clone', '--no-hardlinks', '-q', root, remote])
  // file:// URLs need exactly three slashes on both platforms: strip a
  // leading "/" from a POSIX absolute path and convert Windows backslashes.
  const urlPath = remote.replaceAll('\\', '/').replace(/^\//, '')
  const gitUrl = `git+file:///${urlPath}`
  const spec = `${gitUrl}#path:/packages/browser/bridge-browser`
  const first = await run(['plugin', '--profile', 'web', 'add', '-w', spec])
  if (first.code !== 0) {
    // Expected: pnpm blocks the git dependency's build scripts on purpose.
    assert.match(first.output, /allowBuilds/, first.output)
    const commit = git(['rev-parse', 'HEAD'], { cwd: remote })
    const key = `${bridgeName}@${gitUrl}#${commit}&path:/packages/browser/bridge-browser`
    const workspaceYaml = join(home, 'profiles/web/pnpm-workspace.yaml')
    const existing = await readFile(workspaceYaml, 'utf8')
    const addition = existing.includes('\nallowBuilds:')
      ? `  "${key}": true\n`
      : `allowBuilds:\n  "${key}": true\n`
    await writeFile(workspaceYaml, existing.trimEnd() + '\n' + addition)
    console.log(`allowBuilds approved for ${bridgeName}@${commit}`)
    const second = await run(['plugin', '--profile', 'web', 'add', '-w', spec])
    assert.equal(second.code, 0, second.output)
  }
  const profileManifest = join(home, 'profiles/web/package.json')
  const manifest = JSON.parse(await readFile(profileManifest, 'utf8'))
  assert.ok(manifest.dependencies?.[bridgeName], `profile missing ${bridgeName} dependency`)
  assert.ok(manifest.dsh?.profile?.bundles?.includes(bridgeName), `profile missing ${bridgeName} bundle layer`)
  await boot()
  console.log('Git-install smoke passed: registered via git+file spec, booted, and answered on /ext/bridge')
  await stop()
  const removal = await run(['plugin', '--profile', 'web', 'remove', bridgeName])
  assert.equal(removal.code, 0, removal.output)
  succeeded = true
} catch (error) {
  console.error(hostLog)
  console.error(`Smoke artifacts retained at ${temp}`)
  throw error
} finally {
  await stop()
  if (succeeded) await rm(temp, { recursive: true, force: true, maxRetries: 3 })
}
