// Real-Chromium browser smoke: built MV3 extension + real dsh host + the real
// tool registry. Harness skeleton adapted from omdsh-dev/dsh-browser
// (37b0ba0/5dcdd3f/e52eb75), with every scenario rewritten onto the local
// capability tools (pageAssets / management / cdp). Not part of `pnpm test`;
// run via `pnpm test:browser` (needs a Chromium/Chrome/Edge binary).
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { once } from 'node:events'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const bridge = join(root, 'packages/browser/bridge-browser')
const extension = join(root, 'extensions/dsh-browser/dist')
const require = createRequire(join(root, 'package.json'))
const bridgeRequire = createRequire(join(bridge, 'package.json'))
const { chromium } = bridgeRequire('playwright-core')
const cli = join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js')
const artifacts = join(root, '.artifacts/browser-smoke')
await mkdir(artifacts, { recursive: true })
const directory = await mkdtemp(join(artifacts, 'run-'))
const runtimeTmp = join(directory, 'tmp')
await mkdir(runtimeTmp)
const token = randomUUID()
const env = { ...process.env, DSH_HOME: join(directory, 'home'), TMPDIR: runtimeTmp, DSH_TELEMETRY_DISABLED: '1' }
// Do not inherit bridge settings or credentials from the developer's shell.
delete env.DSH_EXT_TOKEN
delete env.DSH_BROWSER_SESSION_WORKSPACE
let host
let browser
let hostLog = ''
const results = []

function chromiumExecutable() {
  const fromEnv = process.env.CHROMIUM_PATH
  if (fromEnv !== undefined && existsSync(fromEnv)) return fromEnv
  const fromPlaywright = chromium.executablePath()
  if (typeof fromPlaywright === 'string' && existsSync(fromPlaywright)) return fromPlaywright
  // Branded Chrome/Edge 137+ ignore --load-extension, so an unbranded
  // Chromium (playwright cache) always wins over an installed browser.
  const cacheRoot = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(process.env.LOCALAPPDATA ?? process.env.HOME ?? '', 'ms-playwright')
  if (existsSync(cacheRoot)) {
    for (const entry of readdirSync(cacheRoot).sort().reverse()) {
      for (const candidate of [
        join(cacheRoot, entry, 'chrome-win64', 'chrome.exe'),
        join(cacheRoot, entry, 'chrome-win', 'chrome.exe'),
        join(cacheRoot, entry, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
        join(cacheRoot, entry, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
        join(cacheRoot, entry, 'chrome-linux', 'chrome'),
      ]) {
        if (existsSync(candidate)) return candidate
      }
    }
  }
  const candidates = process.platform === 'win32'
    ? [
        join(process.env['ProgramFiles'] ?? 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
        join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
        join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
        join(process.env['ProgramFiles'] ?? 'C:/Program Files', 'Microsoft/Edge/Application/msedge.exe'),
      ]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/microsoft-edge']
  const found = candidates.find(candidate => candidate !== '' && existsSync(candidate))
  if (found === undefined) {
    throw new Error('No Chromium/Chrome/Edge binary found. Set CHROMIUM_PATH to a Chromium-based browser executable.')
  }
  return found
}

async function waitFor(check, label, timeout = 60_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (host && (host.exitCode !== null || host.signalCode !== null)) throw new Error(`Host exited while waiting for ${label}: ${hostLog}`)
    const result = await check()
    if (result) return result
    await delay(100)
  }
  throw new Error(`Timed out waiting for ${label}: ${hostLog}`)
}

async function command(args) {
  const child = spawn(process.execPath, [cli, ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  const [code] = await once(child, 'exit')
  assert.equal(code, 0, output)
}

const inner = `<!doctype html><body style="margin:0;min-height:1000px"><button id="inner" style="position:absolute;left:20px;top:20px;width:120px;height:40px">Inner target</button>
  <input id="input" value="abcd" aria-label="Inner text" style="position:absolute;left:20px;top:90px;width:160px">
  <input id="upload" type="file" style="position:absolute;left:20px;top:140px;width:200px">
  <script>
    window.innerClicks = 0; window.pageMarker = 'frame-world';
    document.querySelector('#inner').addEventListener('click', () => window.innerClicks++);
  </script></body>`
const childServer = createServer((request, response) => {
  response.setHeader('content-type', 'text/html')
  if (request.url === '/nested') {
    // Evaluated per request; the main origin is known by the time a page loads.
    response.end(`<!doctype html><body style="margin:0;min-height:900px">
      <iframe id="nestedSame" src="/inner?nested-same" style="position:absolute;left:20px;top:20px;width:280px;height:160px;border:7px solid;padding:3px"></iframe>
      <iframe id="nestedCross" src="${origin}/inner?nested-cross" style="position:absolute;left:20px;top:260px;width:280px;height:160px;border:7px solid;padding:3px"></iframe></body>`)
    return
  }
  response.end(inner)
})
childServer.listen(0, '127.0.0.1')
await once(childServer, 'listening')
const crossOrigin = `http://127.0.0.1:${childServer.address().port}`
const crossSiteOrigin = `http://localhost:${childServer.address().port}`

const server = createServer((request, response) => {
  response.setHeader('content-type', 'text/html')
  if (request.url.startsWith('/inner')) { response.end(inner); return }
  response.end(`<!doctype html><body style="margin:0;min-height:1600px">
    <button id="button" style="position:absolute;left:20px;top:20px;width:120px;height:40px">Target</button>
    <input id="text" value="abcd" aria-label="Text target" style="position:absolute;left:20px;top:90px;width:160px">
    <input id="upload" type="file" style="position:absolute;left:20px;top:140px;width:220px">
    <div id="editor" contenteditable="true" style="position:absolute;left:20px;top:200px;width:200px;height:40px">abcd</div>
    <p style="position:absolute;top:280px">Public page text</p>
    <iframe id="same" src="/inner" style="position:absolute;left:300px;top:20px;width:300px;height:200px;border:0"></iframe>
    <iframe id="cross" src="${crossOrigin}/inner" style="position:absolute;left:300px;top:280px;width:300px;height:200px;border:0"></iframe>
    <iframe id="crossSite" src="${crossSiteOrigin}/inner" style="position:absolute;left:300px;top:540px;width:300px;height:200px;border:0"></iframe>
    <iframe id="nested" src="${crossSiteOrigin}/nested" style="position:absolute;left:20px;top:800px;width:640px;height:480px;border:5px solid;padding:4px"></iframe>
    <script>
      window.executed = 0; window.events = [];
      const button = document.querySelector('#button');
      for (const type of ['click', 'auxclick', 'contextmenu']) {
        button.addEventListener(type, event => window.events.push({ type, button: event.button, shift: event.shiftKey }));
      }
    </script></body>`)
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const origin = `http://127.0.0.1:${server.address().port}`

try {
  await command(['plugin', '--profile', 'web', 'add', '-w', `@yuxianglin/dsh-bridge-browser@link:${bridge}`])
  const patch = join(directory, 'host.patch.yml')
  await writeFile(patch, [
    '- id: bridge-browser',
    '  config:',
    `    token: ${JSON.stringify(token)}`,
    '    sessionWorkspacePath: ""',
    '- id: tools',
    '  config:',
    '    mode: native',
    '- insert:',
    '    - id: browser-smoke-probe',
    `      name: ${JSON.stringify(pathToFileURL(join(root, 'scripts/fixtures/browser-probe.mjs')).href)}`,
    '      config:',
    `        token: ${JSON.stringify(token)}`,
    '',
  ].join('\n'))
  host = spawn(process.execPath, [cli, 'web', '--patch', patch, '--no-open', '--port', '0'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  host.stdout.on('data', data => { hostLog += data })
  host.stderr.on('data', data => { hostLog += data })
  const base = await waitFor(() => hostLog.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+)/)?.[1], 'DSH startup')
  const probe = await waitFor(() => hostLog.match(/Browser smoke probe: (http:\/\/127\.0\.0\.1:\d+)/)?.[1], 'tool probe startup')
  const hostConfig = await (await fetch(`${base}/ext/bridge-config`)).json()
  assert.equal(typeof hostConfig.pid, 'number', `host config payload: ${JSON.stringify(hostConfig)}`)

  // Fixed-port discovery beacon: the host route and one beacon port answer the
  // same instance metadata (beacon marks itself, host route does not).
  const beaconPorts = []
  for (const port of [43189, 43190, 43191, 43192, 43193, 43194, 43195, 43196, 43197, 43198]) {
    try {
      const answer = await (await fetch(`http://127.0.0.1:${port}/ext/bridge-config`, { signal: AbortSignal.timeout(800) })).json()
      if (answer?.beacon === true) beaconPorts.push({ port, answer })
    } catch { /* not ours or not listening */ }
  }
  const beacon = beaconPorts.find(entry => entry.answer.pid === hostConfig.pid)
  assert.ok(beacon !== undefined, `no discovery beacon answered for host pid ${hostConfig.pid}; beacon ports seen: ${JSON.stringify(beaconPorts)}`)
  assert.equal(beacon.answer.wsUrl, hostConfig.wsUrl)
  results.push('discovery beacon advertises the random host port with instance metadata')

  browser = await chromium.launchPersistentContext(join(directory, 'chromium'), {
    executablePath: chromiumExecutable(),
    channel: 'chromium',
    headless: true,
    env: { ...process.env, TMPDIR: runtimeTmp },
    viewport: { width: 1280, height: 900 },
    args: ['--site-per-process', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  })
  const worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker')
  const extensionId = new URL(worker.url()).host
  const page = await browser.newPage()
  await page.goto(`${origin}/`)
  const panel = await browser.newPage()
  await panel.goto(`chrome-extension://${extensionId}/panel/index.html`)
  await panel.waitForSelector('header.topbar', { timeout: 20_000 })

  // Panel harness: drive the production background over its own port protocol.
  await panel.evaluate(() => {
    globalThis.messages = []
    globalThis.panelPort = chrome.runtime.connect({ name: 'dsh-panel' })
    panelPort.onMessage.addListener(message => messages.push(message))
  })
  const sendSettings = async value => {
    const id = await panel.evaluate(value => {
      const id = crypto.randomUUID()
      panelPort.postMessage({ type: 'settings', id, settings: value })
      return id
    }, value)
    const answer = await waitFor(() => panel.evaluate(id => globalThis.messages.find(message => message.type === 'settings.result' && message.id === id), id), 'settings ack')
    assert.equal(answer.ok, true, JSON.stringify(answer))
  }
  const waitStatus = state => waitFor(
    () => panel.evaluate(state => globalThis.messages.some(message => message.type === 'status' && message.state === state), state),
    `status ${state}`,
  )

  // Zero-config connection: an empty bridgeUrl lets the extension discover the
  // host through its beacon. A competing local dsh instance could win the
  // discovery race; detect that with a canary and fall back to the explicit
  // address so the rest of the scenarios stay deterministic.
  await sendSettings({ bridgeUrl: '', token: '', autoResumeSession: false })
  await panel.evaluate(() => panelPort.postMessage({ type: 'request-status' }))
  await waitStatus('connected')
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const tool = async (name, args, timeoutMs = 90_000) => {
    const response = await fetch(probe, { method: 'POST', headers, body: JSON.stringify({ name, args }), signal: AbortSignal.timeout(timeoutMs) })
    assert.equal(response.status, 200)
    return response.json()
  }
  const text = result => result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  const succeed = result => { assert.equal(result.isError, false, JSON.stringify(result)); return text(result) }

  let zeroConfig = false
  try {
    // A snapshot round-trip proves the extension is connected to THIS host's
    // registry, and under the default 'auto' sharing it never prompts.
    const canary = await tool('pageAssets', { method: 'snapshot', args: {} }, 20_000)
    zeroConfig = canary.isError !== true
  } catch { /* a competing bridge cannot answer our probe's tool call */ }
  if (!zeroConfig) {
    await sendSettings({ bridgeUrl: hostConfig.wsUrl, token: '' })
    await waitStatus('connected')
    results.push('zero-config discovery was won by another local instance; explicit address used')
  } else {
    results.push('zero-config discovery connected through the fixed-port beacon')
  }

  const registered = await (await fetch(probe, { headers })).json()
  for (const capability of ['pageAssets', 'management', 'cdp']) {
    assert.ok(registered.includes(capability), `capability ${capability} missing from ${JSON.stringify(registered)}`)
  }
  results.push('bridge registers the capability tools on the real host')

  await sendSettings({ unrestrictedBrowserAccess: true })
  const [pageTab] = await panel.evaluate(async origin => await chrome.tabs.query({ url: `${origin}/*` }), origin)
  assert.ok(pageTab?.id !== undefined, 'fixture tab missing')
  const tabId = pageTab.id
  await panel.evaluate(windowId => panelPort.postMessage({ type: 'panel.window', windowId }), pageTab.windowId)
  await page.bringToFront()
  succeed(await tool('management', { namespace: 'tabs', method: 'activate', args: { tabId } }))
  results.push('model-selected tab is bound as the controlled tab')

  // Main page: snapshot numbering feeds every numbered action.
  const snapshot = succeed(await tool('pageAssets', { method: 'snapshot', args: {} }))
  const sectionOf = (source, frameId) => {
    if (frameId === undefined) {
      const top = source.indexOf('\n--- iframe')
      return top === -1 ? source : source.slice(0, top)
    }
    const start = source.indexOf(`--- iframe frame=${frameId} `)
    assert.ok(start !== -1, `frame ${frameId} section missing from snapshot:\n${source.slice(0, 1500)}`)
    const rest = source.slice(start)
    const next = rest.indexOf('\n--- iframe frame=')
    return next === -1 ? rest : rest.slice(0, next)
  }
  const findItem = (source, frameId, name) => {
    const section = sectionOf(source, frameId)
    const match = [...section.matchAll(/\[(\d+)\] (\w+) "([^"]*)"/g)].find(entry => entry[3] === name)
    assert.ok(match !== undefined, `element "${name}" not found in ${frameId === undefined ? 'top' : `frame ${frameId}`} section:\n${section.slice(0, 2000)}`)
    return Number(match[1])
  }
  const findForm = (source, frameId, index) => {
    const section = sectionOf(source, frameId)
    const start = section.indexOf('Form fields:')
    assert.ok(start !== -1, `Form fields section missing in ${frameId === undefined ? 'top' : `frame ${frameId}`}:\n${section.slice(0, 2000)}`)
    const rest = section.slice(start)
    const next = rest.indexOf('\n\n')
    const forms = rest.slice(0, next === -1 ? rest.length : next)
    assert.ok(new RegExp(`\\[${index}\\]`).test(forms), `element [${index}] not listed under Form fields:\n${forms.slice(0, 800)}`)
    return index
  }
  // Frame sections may drop an input's interactive-item line under the frame
  // item budget while keeping an identity-annotated Form fields line, and the
  // top page lists every input as an item. Try the item line first, then the
  // identity form line.
  const findInputByKind = (source, frameId, itemName, kind) => {
    const section = sectionOf(source, frameId)
    const byName = [...section.matchAll(/\[(\d+)\] (\w+) "([^"]*)"/g)].find(entry => entry[3] === itemName)
    if (byName !== undefined) return Number(byName[1])
    const byIdentity = [...section.matchAll(new RegExp(`\\[(\\d+)\\] [^\\n]*\\(${kind}\\)`, 'g'))][0]
    assert.ok(byIdentity !== undefined, `${kind} input not found in ${frameId === undefined ? 'top' : `frame ${frameId}`} section:\n${section.slice(0, 2000)}`)
    return Number(byIdentity[1])
  }

  const buttonIndex = findItem(snapshot, undefined, 'Target')
  succeed(await tool('management', { namespace: 'tabs', method: 'click', args: { index: buttonIndex } }))
  assert.equal(await page.evaluate(() => window.events.length), 1)
  const textIndex = findForm(snapshot, undefined, findInputByKind(snapshot, undefined, 'Text target', 'textbox'))
  succeed(await tool('management', { namespace: 'tabs', method: 'type', args: { index: textIndex, text: 'hello-smoke', replace: true } }))
  assert.equal(await page.locator('#text').inputValue(), 'hello-smoke')
  succeed(await tool('management', { namespace: 'tabs', method: 'press', args: { key: 'Enter' } }))
  assert.equal(await page.evaluate(() => window.events.length), 1) // Enter stayed in the input; no button click
  succeed(await tool('management', { namespace: 'tabs', method: 'scroll', args: { direction: 'down', amount: 300 } }))
  await waitFor(async () => page.evaluate(() => scrollY > 0), 'page scroll')
  succeed(await tool('management', { namespace: 'tabs', method: 'scroll', args: { direction: 'top' } }))
  await waitFor(async () => page.evaluate(() => scrollY === 0), 'scroll back to top')
  results.push('snapshot numbering drives click, type, press, and scroll on the main page')

  // Frame matrix: every frame kind is element-addressable through its snapshot
  // section, including out-of-process frames under --site-per-process.
  const frameUrls = {
    same: `${origin}/inner`,
    cross: `${crossOrigin}/inner`,
    crossSite: `${crossSiteOrigin}/inner`,
    nestedSame: `${crossSiteOrigin}/inner?nested-same`,
    nestedCross: `${origin}/inner?nested-cross`,
  }
  const allFrames = await panel.evaluate(tabId => chrome.webNavigation.getAllFrames({ tabId }), tabId)
  const frameIds = {}
  for (const [kind, url] of Object.entries(frameUrls)) {
    const frame = allFrames.find(entry => entry.url === url)
    assert.ok(frame !== undefined, `frame ${kind} (${url}) missing from ${JSON.stringify(allFrames.map(entry => [entry.frameId, entry.url]))}`)
    frameIds[kind] = frame.frameId
  }
  for (const [kind, frameId] of Object.entries(frameIds)) {
    const fresh = succeed(await tool('pageAssets', { method: 'snapshot', args: {} }))
    const innerIndex = findItem(fresh, frameId, 'Inner target')
    const innerInputIndex = findForm(fresh, frameId, findInputByKind(fresh, frameId, 'Inner text', 'textbox'))
    succeed(await tool('management', { namespace: 'tabs', method: 'click', args: { frame: frameId, index: innerIndex } }))
    assert.equal(await page.frame({ url: frameUrls[kind] }).evaluate(() => window.innerClicks), 1, kind)
    succeed(await tool('management', { namespace: 'tabs', method: 'type', args: { frame: frameId, index: innerInputIndex, text: kind, replace: true } }))
    assert.equal(await page.frame({ url: frameUrls[kind] }).locator('#input').inputValue(), kind, kind)
    succeed(await tool('management', { namespace: 'tabs', method: 'scroll', args: { frame: frameId, direction: 'down', amount: 120 } }))
    await waitFor(async () => page.frame({ url: frameUrls[kind] }).evaluate(() => scrollY > 0), `${kind} frame scroll`)
    succeed(await tool('management', { namespace: 'tabs', method: 'scroll', args: { frame: frameId, direction: 'top' } }))
    await waitFor(async () => page.frame({ url: frameUrls[kind] }).evaluate(() => scrollY === 0), `${kind} frame scroll top`)
  }
  assert.equal(await page.evaluate(() => window.events.length), 1, 'frame actions must not click the outer page')
  results.push('element actions reach same-origin, cross-origin, cross-site, and nested frames without touching the outer page')

  // Debugger-backed uploads and frame-bound CDP need developer mode.
  await sendSettings({ cdpEnabled: true })
  const upload = join(directory, 'upload.txt')
  await writeFile(upload, 'Browser upload regression fixture')
  for (const kind of ['same', 'crossSite', 'nestedCross']) {
    const fresh = succeed(await tool('pageAssets', { method: 'snapshot', args: {} }))
    const fileIndex = findForm(fresh, frameIds[kind], findInputByKind(fresh, frameIds[kind], 'file', 'file'))
    succeed(await tool('management', { namespace: 'tabs', method: 'upload', args: { frame: frameIds[kind], index: fileIndex, paths: [upload] } }))
    assert.equal(await page.frame({ url: frameUrls[kind] }).locator('#upload').evaluate(input => input.files[0]?.name), 'upload.txt', kind)
  }
  results.push('uploads set files into same-origin and out-of-process iframe file inputs')

  succeed(await tool('cdp', { method: 'call', args: { method: 'Runtime.evaluate', params: { expression: 'window.executed++', returnByValue: true } } }))
  assert.equal(await page.evaluate(() => window.executed), 1)
  const markerAnswer = succeed(await tool('cdp', {
    method: 'call',
    args: { method: 'Runtime.evaluate', params: { expression: 'window.pageMarker', returnByValue: true }, frame: frameIds.crossSite },
  }))
  assert.match(markerAnswer, /frame-world/, 'frame-bound cdp.call must evaluate inside the cross-site frame')
  const denied = await tool('cdp', { method: 'call', args: { method: 'Browser.close' } })
  assert.equal(denied.isError, true, 'Browser.close must stay denied')
  results.push('cdp.call evaluates on the page and inside an out-of-process frame; the denylist still applies')

  // Approval flow: with unrestricted access off, a state-changing action waits
  // for the panel's decision. Stale requests from earlier restricted-mode calls
  // are dropped first so the captured request belongs to this click.
  await sendSettings({ unrestrictedBrowserAccess: false })
  await panel.evaluate(() => { globalThis.messages = globalThis.messages.filter(message => message.type !== 'approval.request') })
  const approved = tool('management', { namespace: 'tabs', method: 'click', args: { index: buttonIndex } })
  const request = await waitFor(() => panel.evaluate(() => globalThis.messages.find(message => message.type === 'approval.request')?.request), 'approval request')
  assert.equal(request.action, 'management.tabs.click')
  await panel.evaluate(({ id }) => {
    globalThis.messages = globalThis.messages.filter(message => message.type !== 'approval.request')
    panelPort.postMessage({ type: 'approval.response', id, decision: 'allow-once' })
  }, { id: request.id })
  succeed(await approved)
  assert.equal(await page.evaluate(() => window.events.length), 2)
  results.push('a state-changing action waits for panel approval and allow-once lets it through')

  await writeFile(join(directory, 'results.json'), JSON.stringify(results, null, 2))
  console.log(`Browser smoke passed: ${results.join('; ')}`)
  console.log(`Evidence: ${directory}`)
} finally {
  if (browser) await browser.close()
  if (host && host.exitCode === null && host.signalCode === null) {
    host.kill('SIGTERM')
    await once(host, 'exit').catch(() => {})
  }
  await new Promise(resolve => server.close(resolve))
  await new Promise(resolve => childServer.close(resolve))
  await writeFile(join(directory, 'host.log'), hostLog)
}
