// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { ServerFrame } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import { BrowserTurnLifecycle } from '../src/background/browser-turns.ts'
import { CdpManager, type DebuggerLike } from '../src/background/cdp/manager.ts'
import { clearTabCapabilityState, dispatchCapabilityTool, type CapabilityDeps } from '../src/background/capability-tools.ts'
import { BrowserEventLog } from '../src/background/browser-events.ts'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function setup() {
  let event!: Parameters<DebuggerLike['addEventListener']>[0]
  let detach!: (source: { tabId: number }) => void
  const adapter: DebuggerLike = {
    attach: vi.fn(async () => {}),
    detach: vi.fn(async () => {}),
    sendCommand: vi.fn(async (target, method) => ({ target, method })),
    addEventListener: (handler) => { event = handler },
    removeEventListener: () => {},
    addDetachListener: (handler) => { detach = handler },
  }
  const manager = new CdpManager(adapter, true)
  manager.setPanelActive(true)
  manager.setDeveloperMode(true)
  const releaseControl = vi.fn()
  const turns = new BrowserTurnLifecycle(manager, releaseControl)
  return { adapter, manager, turns, releaseControl, event: (...args: Parameters<typeof event>) => event(...args), detached: (tabId: number) => detach({ tabId }) }
}

function frame(sessionId: string, type: string, turnId?: string): ServerFrame {
  return { t: 'event', frame: { rpcId: 'event', method: 'session/event', payload: { sessionId, event: { type, turnId } } } }
}

describe('browser turn and debugger ownership', () => {
  it('ends all tabs of one turn while preserving another session', async () => {
    const { turns, manager, adapter, releaseControl } = setup()
    const a = turns.start('a', 'a1')
    const b = turns.start('b', 'b1')
    await Promise.all([manager.forTab(7, a.signal).attach(7), manager.forTab(8, a.signal).attach(8), manager.forTab(9, b.signal).attach(9)])
    await turns.end('a', 'a1')
    expect(manager.attachedTabs()).toEqual([9])
    expect(adapter.detach).toHaveBeenCalledTimes(2)
    expect(a.signal.aborted).toBe(true)
    expect(b.signal.aborted).toBe(false)
    expect(releaseControl).toHaveBeenCalledExactlyOnceWith(a)
    await turns.end('a', 'a1')
    expect(releaseControl).toHaveBeenCalledTimes(1)
    await expect(manager.forTab(7, a.signal).attach(7)).rejects.toMatchObject({ reason: 'retracted' })
  })

  it('does not disconnect a shared tab until its final owner ends', async () => {
    const { turns, manager, adapter } = setup()
    const a = turns.start('a')
    const b = turns.start('b')
    const first = manager.forTab(7, a.signal)
    const peer = manager.forTab(7, b.signal)
    await Promise.all([first.attach(7), peer.attach(7)])
    expect(adapter.attach).toHaveBeenCalledTimes(1)
    await turns.end('a')
    expect(adapter.detach).not.toHaveBeenCalled()
    expect(() => first.send('Page.getFrameTree')).toThrow(/ended/)
    await expect(peer.send('Page.getFrameTree')).resolves.toMatchObject({ target: { tabId: 7 } })
    await turns.end('b')
    expect(adapter.detach).toHaveBeenCalledExactlyOnceWith({ tabId: 7 })
  })

  it('keeps parallel commands and same-numbered network/context events isolated by tab', async () => {
    const { turns, manager, event } = setup()
    const turn = turns.start('a')
    const a = manager.forTab(7, turn.signal)
    const b = manager.forTab(8, turn.signal)
    await Promise.all([a.attach(7), b.attach(8)])
    event({ tabId: 7 }, 'Network.requestWillBeSent', { requestId: '1', request: { url: 'https://a.example' } })
    event({ tabId: 8 }, 'Network.requestWillBeSent', { requestId: '1', request: { url: 'https://b.example' } })
    event({ tabId: 8 }, 'Network.responseReceived', { requestId: '1', response: { status: 404 } })
    event({ tabId: 7 }, 'Runtime.executionContextCreated', { context: { id: 1, origin: 'https://a.example', auxData: { frameId: 'frame' } } })
    event({ tabId: 8 }, 'Runtime.executionContextCreated', { context: { id: 1, origin: 'https://b.example', auxData: { frameId: 'frame' } } })
    const [one, two] = await Promise.all([a.send('Page.getFrameTree'), b.send('Page.getFrameTree')])
    expect(one).toMatchObject({ target: { tabId: 7 } })
    expect(two).toMatchObject({ target: { tabId: 8 } })
    expect(a.network.snapshot()).toMatchObject([{ url: 'https://a.example', status: null }])
    expect(b.network.snapshot()).toMatchObject([{ url: 'https://b.example', status: 404 }])
    expect(a.executionContexts()[0].origin).toBe('https://a.example')
    expect(b.executionContexts()[0].origin).toBe('https://b.example')
    await manager.retract(7)
    expect(manager.attachedTabs()).toEqual([8])
    expect(b.network.snapshot()).toHaveLength(1)
  })

  it('cleans a native attach that resolves after turn end and blocks a late command', async () => {
    const { turns, manager, adapter } = setup()
    const attaching = deferred()
    vi.mocked(adapter.attach).mockImplementationOnce(() => attaching.promise)
    const turn = turns.start('a', 'one')
    const tab = manager.forTab(7, turn.signal)
    const attach = tab.attach(7)
    const rejected = expect(attach).rejects.toMatchObject({ reason: 'retracted' })
    const end = turns.end('a', 'one')
    attaching.resolve()
    await Promise.all([rejected, end])
    expect(adapter.detach).toHaveBeenCalledExactlyOnceWith({ tabId: 7 })
    expect(adapter.sendCommand).not.toHaveBeenCalled()
    expect(manager.attachedTabs()).toEqual([])
  })

  it('does not release a new generation when an old turn end arrives', async () => {
    const { turns, manager, adapter } = setup()
    const old = turns.start('a', 'one')
    await manager.forTab(7, old.signal).attach(7)
    await turns.end('a', 'one')
    const current = turns.start('a', 'two')
    await manager.forTab(7, current.signal).attach(7)
    turns.ingest(frame('a', 'turn/end', 'one'))
    expect(current.signal.aborted).toBe(false)
    expect(manager.attachedTabs()).toEqual([7])
    expect(adapter.detach).toHaveBeenCalledTimes(1)
  })

  it('waits for outstanding detach before reattaching the same tab', async () => {
    const { turns, manager, adapter } = setup()
    const detaching = deferred()
    const old = turns.start('a', 'one')
    await manager.forTab(7, old.signal).attach(7)
    vi.mocked(adapter.detach).mockImplementationOnce(() => detaching.promise)
    const end = turns.end('a', 'one')
    await vi.waitFor(() => expect(adapter.detach).toHaveBeenCalledTimes(1))
    const current = turns.start('a', 'two')
    const attach = manager.forTab(7, current.signal).attach(7)
    expect(adapter.attach).toHaveBeenCalledTimes(1)
    detaching.resolve()
    await Promise.all([end, attach])
    expect(adapter.attach).toHaveBeenCalledTimes(2)
    expect(manager.attachedTabs()).toEqual([7])
  })

  it('forgets an external detach and reattaches without retaining old observations', async () => {
    const { turns, manager, adapter, detached, event } = setup()
    const turn = turns.start('a')
    const tab = manager.forTab(7, turn.signal)
    await tab.attach(7)
    event({ tabId: 7 }, 'Runtime.consoleAPICalled', { type: 'error', args: [{ type: 'string', value: 'old' }] })
    detached(7)
    expect(manager.isAttached(7)).toBe(false)
    await expect(manager.forTab(7, turn.signal).attach(7)).resolves.toBeUndefined()
    expect(adapter.attach).toHaveBeenCalledTimes(2)
    expect(manager.forTab(7, turn.signal).diagnostics.snapshot()).toEqual([])
    expect(() => tab.send('Page.getFrameTree')).toThrow(/ended/)
  })

  it('invalidates a lost native connection and reconnects on the next tool call without replaying input', async () => {
    const { turns, manager, adapter, event } = setup()
    const turn = turns.start('a')
    const tab = manager.forTab(7, turn.signal)
    await tab.attach(7)
    event({ tabId: 7 }, 'Network.requestWillBeSent', { requestId: 'old', request: { url: 'https://example.com/old' } })
    vi.mocked(adapter.sendCommand).mockRejectedValueOnce(new Error('Debugger is not attached to the tab with id: 7.'))

    await expect(tab.send('Input.dispatchMouseEvent', { type: 'mousePressed' })).rejects.toThrow(/not attached/)
    expect(manager.isAttached(7)).toBe(false)
    expect(adapter.detach).not.toHaveBeenCalled()
    expect(vi.mocked(adapter.sendCommand).mock.calls.filter(([, method]) => method === 'Input.dispatchMouseEvent')).toHaveLength(1)
    expect(() => tab.send('Runtime.evaluate')).toThrow(/ended/)

    const next = manager.forTab(7, turn.signal)
    await next.attach(7)
    expect(adapter.attach).toHaveBeenCalledTimes(2)
    expect(next.network.snapshot()).toEqual([])
    await expect(next.send('Runtime.evaluate')).resolves.toMatchObject({ target: { tabId: 7 } })
    await turns.end('a')
    expect(manager.isAttached(7)).toBe(false)
  })

  it('does not invalidate a new attachment when an old command reports a lost connection late', async () => {
    const { turns, manager, adapter, detached } = setup()
    const turn = turns.start('a')
    const tab = manager.forTab(7, turn.signal)
    await tab.attach(7)
    let fail!: (reason: Error) => void
    vi.mocked(adapter.sendCommand).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
    const command = expect(tab.send('Runtime.evaluate')).rejects.toThrow(/not attached/)
    detached(7)
    const next = manager.forTab(7, turn.signal)
    await next.attach(7)
    fail(new Error('Debugger is not attached to the tab with id: 7.'))
    await command
    expect(manager.isAttached(7)).toBe(true)
    await expect(next.send('Runtime.evaluate')).resolves.toMatchObject({ target: { tabId: 7 } })
  })

  it('keeps the attachment for ordinary protocol errors', async () => {
    const { turns, manager, adapter } = setup()
    const turn = turns.start('a')
    const tab = manager.forTab(7, turn.signal)
    await tab.attach(7)
    vi.mocked(adapter.sendCommand).mockRejectedValueOnce(new Error('Cannot find context with specified id'))
    await expect(tab.send('Runtime.evaluate')).rejects.toThrow(/Cannot find context/)
    expect(manager.isAttached(7)).toBe(true)
    await expect(tab.send('Page.getFrameTree')).resolves.toMatchObject({ target: { tabId: 7 } })
    expect(adapter.attach).toHaveBeenCalledTimes(1)
  })

  it('clears every turn on disconnect and permits new work after reset', async () => {
    const { turns, manager } = setup()
    const a = turns.start('a')
    const b = turns.start('b')
    await Promise.all([manager.forTab(7, a.signal).attach(7), manager.forTab(8, b.signal).attach(8)])
    await turns.clear()
    expect(manager.attachedTabs()).toEqual([])
    expect(turns.current('a').signal.aborted).toBe(true)
    turns.reset()
    expect(turns.current('a').signal.aborted).toBe(false)
  })

  it('clears viewport state on turn end without losing a different tab override', async () => {
    const { turns, manager } = setup()
    manager.addDetachHandler(clearTabCapabilityState)
    vi.stubGlobal('chrome', { windows: { get: async () => ({ width: 1200, height: 900 }) } })
    try {
      const a = turns.start('a')
      const b = turns.start('b')
      const deps = (id: number, signal: AbortSignal): CapabilityDeps => ({
        tab: { id, windowId: 1, url: 'https://example.com/' },
        sharePageContent: 'auto', authorize: async () => 'approved', handoff: async () => 'approved',
        cdp: manager.forTab(id, signal), events: new BrowserEventLog(), notifyBotDetection: () => {}, signal,
      })
      const set = { id: 'set', name: 'viewport.set', args: { width: 800, height: 600 } }
      expect((await dispatchCapabilityTool(set, deps(7, a.signal))).ok).toBe(true)
      expect((await dispatchCapabilityTool(set, deps(8, b.signal))).ok).toBe(true)
      await turns.end('a')
      const next = turns.start('a')
      await manager.forTab(7, next.signal).attach(7)
      const get = { id: 'get', name: 'viewport.get', args: {} }
      const resultA = await dispatchCapabilityTool(get, deps(7, next.signal))
      const resultB = await dispatchCapabilityTool(get, deps(8, b.signal))
      expect(JSON.parse((resultA.result as { text: string }).text)).toMatchObject({ override: false })
      expect(JSON.parse((resultB.result as { text: string }).text)).toMatchObject({ override: true, width: 800 })
      await turns.clear()
    } finally { vi.unstubAllGlobals() }
  })

  it('handles actual turn event frames and rejects malformed/unrelated frames', async () => {
    const { turns, manager, releaseControl } = setup()
    turns.ingest(frame('a', 'turn/start'))
    const turn = turns.current('a')
    await manager.forTab(7, turn.signal).attach(7)
    turns.ingest({ t: 'event', frame: { rpcId: 'x', method: 'session/event', payload: null } })
    turns.ingest(frame('b', 'turn/end'))
    expect(turn.signal.aborted).toBe(false)
    turns.ingest(frame('a', 'turn/end'))
    expect(turn.signal.aborted).toBe(true)
    await turns.end('a')
    expect(manager.attachedTabs()).toEqual([])
    expect(releaseControl).toHaveBeenCalledTimes(1)
  })
})
