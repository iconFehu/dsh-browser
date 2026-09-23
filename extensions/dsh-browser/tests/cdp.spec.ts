// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { CdpManager, type DebuggerLike } from '../src/background/cdp/manager.ts'
import { redactUrl, renderDiagnostics, renderNetwork, RingBuffer } from '../src/background/cdp/buffers.ts'
import { metricDeltas, renderMetrics } from '../src/background/cdp/metrics.ts'
import type { MetricSample, NetworkObservation, PageDiagnostic } from '../src/background/cdp/types.ts'

function fakeDebugger(): {
  adapter: DebuggerLike
  attached: Array<{ tabId: number }>
  detached: Array<{ tabId: number }>
  commands: string[]
  emit: (method: string, params: unknown) => void
  respond: (method: string, result: unknown) => void
} {
  const state = {
    attached: [] as Array<{ tabId: number }>,
    detached: [] as Array<{ tabId: number }>,
    commands: [] as string[],
  }
  let listener: ((source: { tabId: number }, method: string, params: unknown) => void) | null = null
  const adapter: DebuggerLike = {
    attach: async (target) => { state.attached.push(target) },
    detach: async (target) => { state.detached.push(target) },
    sendCommand: async (_target, method, _params) => {
      state.commands.push(method)
      if (method === 'Performance.getMetrics') {
        return { metrics: [{ name: 'TaskDuration', value: state.commands.length * 10 }] }
      }
      if (method === 'Network.getResponseBody') {
        return { body: 'aGVsbG8=', base64Encoded: true }
      }
      return {}
    },
    addEventListener: (handler) => { listener = handler },
    removeEventListener: () => { listener = null },
  }
  return {
    adapter,
    ...state,
    emit: (method, params) => listener?.({ tabId: 7 }, method, params),
    respond: () => {},
  }
}

function attachedManager(): { cdp: CdpManager; fake: ReturnType<typeof fakeDebugger> } {
  const fake = fakeDebugger()
  const cdp = new CdpManager(fake.adapter, true)
  cdp.setDeveloperMode(true)
  cdp.setPanelActive(true)
  return { cdp, fake }
}

describe('CdpManager lifecycle', () => {
  it('refuses attach when developer mode is off or no panel is open', async () => {
    const fake = fakeDebugger()
    const cdp = new CdpManager(fake.adapter, true)
    await expect(cdp.attach(7)).rejects.toMatchObject({ reason: 'disabled' })
    cdp.setDeveloperMode(true)
    await expect(cdp.attach(7)).rejects.toMatchObject({ reason: 'no-panel' })
    expect(fake.attached.length).toBe(0)
  })

  it('reports unsupported browsers before touching the adapter', async () => {
    const fake = fakeDebugger()
    const cdp = new CdpManager(fake.adapter, false)
    cdp.setDeveloperMode(true)
    cdp.setPanelActive(true)
    await expect(cdp.attach(7)).rejects.toMatchObject({ reason: 'unsupported' })
    expect(fake.attached.length).toBe(0)
  })

  it('attaches once and enables observation domains', async () => {
    const { cdp, fake } = attachedManager()
    await cdp.attach(7)
    expect(fake.attached).toEqual([{ tabId: 7 }])
    for (const domain of ['Runtime', 'Page', 'Network', 'Log', 'Performance']) {
      expect(fake.commands).toContain(`${domain}.enable`)
    }
    expect(cdp.isAttached()).toBe(true)
    expect(cdp.attachedTab()).toBe(7)
    // Attaching to the same tab is a no-op.
    await cdp.attach(7)
    expect(fake.attached.length).toBe(1)
  })

  it('detaches when the panel closes or developer mode turns off', async () => {
    const { cdp, fake } = attachedManager()
    await cdp.attach(7)
    cdp.setPanelActive(false)
    expect(fake.detached).toEqual([{ tabId: 7 }])
    expect(cdp.isAttached()).toBe(false)

    cdp.setPanelActive(true)
    await cdp.attach(7)
    cdp.setDeveloperMode(false)
    expect(fake.detached.length).toBe(2)
    expect(cdp.isAttached()).toBe(false)
  })

  it('switching tabs detaches the previous target', async () => {
    const { cdp, fake } = attachedManager()
    await cdp.attach(7)
    await cdp.attach(9)
    expect(fake.detached).toEqual([{ tabId: 7 }])
    expect(cdp.attachedTab()).toBe(9)
  })

  it('retracts explicitly', async () => {
    const { cdp, fake } = attachedManager()
    await cdp.attach(7)
    await cdp.retract()
    expect(fake.detached).toEqual([{ tabId: 7 }])
  })
})

describe('CdpManager observations', () => {
  it('collects console errors/warnings but ignores info', async () => {
    const { cdp, fake } = attachedManager()
    await cdp.attach(7)
    fake.emit('Runtime.consoleAPICalled', { type: 'error', args: [{ type: 'string', value: 'boom' }] })
    fake.emit('Runtime.consoleAPICalled', { type: 'warning', args: [{ type: 'string', value: 'careful' }] })
    fake.emit('Runtime.consoleAPICalled', { type: 'info', args: [{ type: 'string', value: 'noise' }] })
    const entries = cdp.diagnostics.snapshot()
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ kind: 'console', level: 'warning', text: 'careful' })
  })

  it('tracks network requests, statuses, and failures (ignoring cancellations)', async () => {
    const { cdp, fake } = attachedManager()
    await cdp.attach(7)
    fake.emit('Network.requestWillBeSent', { requestId: 'r1', request: { method: 'POST', url: 'https://a.example/x?q=1' } })
    fake.emit('Network.responseReceived', { requestId: 'r1', response: { status: 500 } })
    fake.emit('Network.requestWillBeSent', { requestId: 'r2', request: { method: 'GET', url: 'https://a.example/y' } })
    fake.emit('Network.loadingFailed', { requestId: 'r2', errorText: 'net::ERR_FAILED', canceled: false })
    fake.emit('Network.requestWillBeSent', { requestId: 'r3', request: { method: 'GET', url: 'https://a.example/z' } })
    fake.emit('Network.loadingFailed', { requestId: 'r3', errorText: 'canceled', canceled: true })
    const entries: NetworkObservation[] = cdp.network.snapshot()
    expect(entries).toHaveLength(3)
    const byId = new Map(entries.map((entry) => [entry.requestId, entry]))
    expect(byId.get('r1')).toMatchObject({ status: 500, errorText: null })
    expect(byId.get('r2')).toMatchObject({ status: null, errorText: 'net::ERR_FAILED' })
    expect(byId.get('r3')).toMatchObject({ errorText: null, status: null })
  })

  it('fetches base64 response bodies', async () => {
    const { cdp } = attachedManager()
    await cdp.attach(7)
    await expect(cdp.fetchResponseBody('r1')).resolves.toBe('hello')
  })

  it('returns a delta only after a baseline exists', async () => {
    const { cdp } = attachedManager()
    await cdp.attach(7)
    const first = await cdp.performanceDelta()
    expect(first).toEqual([])
    const second = await cdp.performanceDelta()
    expect(second.some((sample) => sample.name === 'TaskDuration' && sample.value > 0)).toBe(true)
  })

  it('ignores events from tabs it is not attached to', async () => {
    const { cdp, fake } = attachedManager()
    await cdp.attach(7)
    fake.emit('Runtime.consoleAPICalled', { type: 'error', args: [] })
    const other = fakeDebugger()
    other.emit('Runtime.consoleAPICalled', { type: 'error', args: [] })
    expect(cdp.diagnostics.snapshot().length).toBe(1)
  })
})

describe('buffers and renderers', () => {
  it('keeps bounded rings newest-first', () => {
    const ring = new RingBuffer<number>(3)
    for (let index = 0; index < 5; index += 1) ring.push(index)
    expect(ring.snapshot()).toEqual([4, 3, 2])
    ring.clear()
    expect(ring.snapshot()).toEqual([])
  })

  it('renders diagnostics and network summaries with caps', () => {
    const diagnostics: PageDiagnostic[] = [
      { kind: 'console', level: 'error', text: 'boom', at: 1 },
      { kind: 'network', level: 'warning', text: 'slow', at: 2 },
    ]
    const text = renderDiagnostics(diagnostics)
    expect(text).toContain('[error] (console) boom')
    expect(renderDiagnostics([])).toContain('No recent')
    const network: NetworkObservation[] = [
      { requestId: '1', method: 'GET', url: 'https://x.example/data?token=abc', status: 200, errorText: null, at: 1 },
    ]
    const networkText = renderNetwork(network)
    expect(networkText).toContain('HTTP 200')
    expect(networkText).not.toContain('token=abc')
    expect(renderNetwork([])).toContain('No network requests')
  })

  it('redacts URLs without losing host/path', () => {
    expect(redactUrl('https://x.example/p?secret=1#frag')).toBe('https://x.example/p')
    expect(redactUrl('not a url')).toBe('(opaque URL)')
  })
})

describe('performance metrics', () => {
  it('computes positive deltas between samples', () => {
    const before: MetricSample[] = [{ name: 'TaskDuration', value: 10 }, { name: 'JSHeapUsedSize', value: 20 }]
    const after: MetricSample[] = [{ name: 'TaskDuration', value: 25 }, { name: 'JSHeapUsedSize', value: 15 }]
    expect(metricDeltas(before, after)).toEqual([{ name: 'TaskDuration', value: 15 }])
  })

  it('renders metrics as text', () => {
    expect(renderMetrics([{ name: 'Nodes', value: 2_087 }])).toContain('Nodes: 2.09 kB')
    expect(renderMetrics([])).toContain('No measurable change')
  })
})
