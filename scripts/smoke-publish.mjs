import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

/**
 * Publish-artifact smoke: register the bridge from the exact tarball `pnpm
 * pack` (and therefore `pnpm publish`) produces, boot a real dsh web host
 * against a fresh profile, and prove the bridge answers on /ext/bridge.
 *
 * The registry install path (`dsh plugin --profile web add -w
 * @yuxianglin/dsh-bridge-browser@0.0.5`) forwards to `pnpm add` in the
 * profile directory; installing the same bytes from a local `file:` tarball
 * exercises everything except the network hop, so this stays hermetic in CI.
 */

const root = fileURLToPath(new URL('../', import.meta.url))
const bridge = join(root, 'packages/browser/bridge-browser')
const require = createRequire(join(root, 'package.json'))
const cli = join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js')
const bridgeManifest = JSON.parse(await readFile(join(bridge, 'package.json'), 'utf8'))
const expectedVersion = bridgeManifest.version
const bridgeName = bridgeManifest.name
const bridgeRequire = createRequire(join(bridge, 'package.json'))
const { default: WebSocket } = await import(pathToFileURL(bridgeRequire.resolve('ws')).href)
const temp = await mkdtemp(join(tmpdir(), 'dsh-publish-smoke-'))
const home = join(temp, 'home')
const patch = join(temp, 'smoke.patch.yml')
const sessionId = `session-${randomUUID()}`
const token = randomUUID()
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
// Do not inherit bridge settings or credentials from the developer's shell.
delete env.DSH_EXT_TOKEN
delete env.DSH_BROWSER_SESSION_WORKSPACE
let host
let socket
let hostLog = ''
let succeeded = false

async function waitFor(check, label, timeout = 60_000) {
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

/** Invoke pnpm from PATH the same way the repo's own scripts do. */
function invokePnpm(args, options) {
  return runSync('pnpm', args, { shell: process.platform === 'win32', ...options })
}

function runSync(command, args, options) {
  const result = spawnSync(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}):\n${result.stdout}${result.stderr}`)
  }
  return result
}

async function run(command, args) {
  const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 180_000)
  try {
    const [code] = await once(child, 'exit')
    assert.equal(code, 0, output)
  } finally { clearTimeout(timeout) }
}

async function start() {
  // Same settings overlay smoke-runtime uses: a fixed token plus the two
  // deferred-workspace options, so the boot is deterministic and hermetic.
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
  socket = new WebSocket(config.wsUrl, { origin: 'moz-extension://smoke-publish', handshakeTimeout: 10_000 })
  const frames = []
  let socketError
  socket.on('error', error => { socketError = error })
  socket.on('message', data => { frames.push(JSON.parse(data.toString())) })
  await once(socket, 'open')
  async function frame(predicate) {
    return waitFor(() => {
      if (socketError) throw socketError
      const found = frames.find(predicate)
      if (found) return found
      if (socket.readyState === WebSocket.CLOSED) throw new Error(`Bridge closed: ${JSON.stringify(frames)}`)
    }, 'bridge response', 15_000)
  }
  socket.send(JSON.stringify({ t: 'hello', token, caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 } }))
  await frame(value => value.t === 'hello.ok')
  return async (method, payload) => {
    const id = randomUUID()
    socket.send(JSON.stringify({ t: 'rpc', id, method, payload }))
    const result = await frame(value => value.t === 'rpc.result' && value.id === id)
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.result?.result?.ok, true, JSON.stringify(result))
    return result.result.result.value
  }
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
  await mkdir(home, { recursive: true })
  // `pnpm pack` runs the prepack build, so the tarball carries a fresh lib/.
  invokePnpm(['--filter', bridgeName, 'pack', '--pack-destination', temp], { cwd: root })
  const packed = (await readdir(temp)).filter(name => name.endsWith('.tgz'))
  assert.equal(packed.length, 1, `expected one tarball, got ${JSON.stringify(packed)}`)
  const tarball = join(temp, packed[0])
  assert.equal(basename(tarball), `${bridgeName.replace('@', '').replace('/', '-')}-${expectedVersion}.tgz`)
  const profileManifest = join(home, 'profiles/web/package.json')
  // Forward-slash absolute file: spec: the CLI anchors relative specs against
  // its own cwd but passes absolute ones through verbatim to pnpm.
  const spec = `file:${tarball.replaceAll('\\', '/')}`
  await run(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', '-w', spec])
  const manifest = JSON.parse(await readFile(profileManifest, 'utf8'))
  // The reconciler keys the layer stack by the package's real installed name,
  // exactly as a registry install would.
  assert.ok(manifest.dependencies?.[bridgeName], `profile missing ${bridgeName} dependency`)
  assert.ok(manifest.dsh?.profile?.bundles?.includes(bridgeName), `profile missing ${bridgeName} bundle layer`)
  const rpc = await start()
  const created = await rpc('session.create', { sessionId, cwd: temp })
  assert.equal(created.sessionId, sessionId)
  assert.ok((await rpc('session.list', {})).items.some(item => item.sessionId === sessionId))
  assert.ok(Array.isArray((await rpc('session.history', { sessionId })).events))
  await stop()
  // Removal keeps the profile reconcilable, mirroring `dsh plugin ... remove`.
  await run(process.execPath, [cli, 'plugin', '--profile', 'web', 'remove', bridgeName])
  const after = JSON.parse(await readFile(profileManifest, 'utf8'))
  assert.equal(after.dependencies?.[bridgeName], undefined)
  assert.ok(!after.dsh?.profile?.bundles?.includes(bridgeName))
  console.log(`Publish smoke passed: packed ${basename(tarball)} registered via dsh plugin add, booted, and answered on /ext/bridge`)
  succeeded = true
} catch (error) {
  console.error(hostLog)
  console.error(`Smoke artifacts retained at ${temp}`)
  throw error
} finally {
  await stop()
  if (succeeded) await rm(temp, { recursive: true, force: true, maxRetries: 3 })
}
