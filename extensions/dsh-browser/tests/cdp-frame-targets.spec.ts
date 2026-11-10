// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CdpManager, type DebuggerLike } from '../src/background/cdp/manager.ts'
import { resolveFrameContext, resolveMarkedNode } from '../src/background/cdp/frame-targets.ts'
import { dispatchToolCall, type ToolAnswer, type ToolCall } from '../src/background/tools.ts'
import type { CdpSession } from '../src/background/cdp/manager.ts'
import type { TabFrame } from '../src/background/frames.ts'

type SentCommand = { method: string; params?: Record<string, unknown>; sessionId?: string; tabId: number }
type Responder = (method: string, params: Record<string, unknown> | undefined, sessionId?: string) => unknown

function fakeDebugger(respond?: Responder): {
  adapter: DebuggerLike
  sent: SentCommand[]
  emit: (source: { tabId: number; sessionId?: string }, method: string, params?: unknown) => void
} {
  let listener: ((source: { tabId: number; sessionId?: string }, method: string, params: unknown) => void) | null = null
  const sent: SentCommand[] = []
  const adapter: DebuggerLike = {
    attach: async () => {},
    detach: async () => {},
    sendCommand: async (target, method, params) => {
      sent.push({ method, params, sessionId: target.sessionId, tabId: target.tabId })
      return respond?.(method, params, target.sessionId) ?? {}
    },
    addEventListener: (handler) => { listener = handler },
    removeEventListener: () => { listener = null },
  }
  return {
    adapter,
    sent,
    emit: (source, method, params) => listener?.(
      { tabId: source.tabId, ...(source.sessionId === undefined ? {} : { sessionId: source.sessionId }) },
      method,
      params,
    ),
  }
}

function frameManager(respond?: Responder): { cdp: CdpManager; fake: ReturnType<typeof fakeDebugger> } {
  const fake = fakeDebugger(respond)
  const cdp = new CdpManager(fake.adapter, true)
  cdp.setDeveloperMode(true)
  cdp.setPanelActive(true)
  return { cdp, fake }
}

function emitFrameContexts(fake: ReturnType<typeof fakeDebugger>): void {
  fake.emit({ tabId: 7 }, 'Runtime.executionContextCreated', {
    context: { id: 11, uniqueId: 'u-top', origin: 'https://a.test', auxData: { frameId: 'F0', isDefault: true } },
  })
  fake.emit({ tabId: 7 }, 'Target.attachedToTarget', { sessionId: 's1' })
  fake.emit({ tabId: 7, sessionId: 's1' }, 'Runtime.executionContextCreated', {
    context: { id: 22, uniqueId: 'u-child', origin: 'https://b.test', auxData: { frameId: 'F8', isDefault: true } },
  })
}

const childFrame: TabFrame = { frameId: 8, parentFrameId: 0, documentId: 'doc-8', url: 'https://b.test/' }

describe('CdpManager frame contexts', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('collects top-page and flatten child-session contexts, routing sends per session', async () => {
    const { cdp, fake } = frameManager()
    await cdp.attach(7)
    await cdp.frameExecutionContexts(7)
    emitFrameContexts(fake)

    const contexts = await cdp.frameExecutionContexts(7)
    expect(contexts.map((context) => context.frameId)).toEqual(['F0', 'F8'])
    // Child session arms Runtime and recurses so nested OOP frames attach too.
    expect(fake.sent).toContainEqual(expect.objectContaining({ method: 'Runtime.enable', sessionId: 's1' }))
    expect(fake.sent).toContainEqual(expect.objectContaining({ method: 'Target.setAutoAttach', sessionId: 's1' }))
    // Observation contexts stay page-session scoped.
    expect(cdp.executionContexts(7).map((context) => context.frameId)).toEqual(['F0'])
    // Frame contexts send through their owning session.
    await contexts[1]!.send('Runtime.evaluate', { expression: '1' })
    expect(fake.sent.at(-1)).toMatchObject({ method: 'Runtime.evaluate', sessionId: 's1' })
  })

  it('drops child contexts when the child session detaches', async () => {
    const { cdp, fake } = frameManager()
    await cdp.attach(7)
    await cdp.frameExecutionContexts(7)
    emitFrameContexts(fake)
    await cdp.frameExecutionContexts(7)

    fake.emit({ tabId: 7 }, 'Target.detachedFromTarget', { sessionId: 's1' })
    expect((await cdp.frameExecutionContexts(7)).map((context) => context.frameId)).toEqual(['F0'])
  })
})

describe('resolveFrameContext', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function stubChrome(documentId: string | undefined): { executeScript: ReturnType<typeof vi.fn> } {
    const executeScript = vi.fn(async () => [])
    vi.stubGlobal('chrome', {
      scripting: { executeScript },
      webNavigation: { getFrame: vi.fn(async () => documentId === undefined ? undefined : { documentId }) },
    })
    return { executeScript }
  }

  it('returns the context whose document carries the one-shot marker and clears it', async () => {
    const { executeScript } = stubChrome('doc-8')
    const { cdp, fake } = frameManager((method, params) => {
      if (method === 'Runtime.evaluate' && typeof params?.expression === 'string' && params.expression.includes('hasAttribute')) {
        return { result: { value: params.contextId === 22 } }
      }
      return {}
    })
    await cdp.attach(7)
    await cdp.frameExecutionContexts(7)
    emitFrameContexts(fake)

    const context = await resolveFrameContext(cdp, 7, childFrame)
    expect(context.frameId).toBe('F8')
    expect(executeScript).toHaveBeenCalledTimes(2) // set then clear
  })

  it('fails closed when the frame navigated during resolution', async () => {
    stubChrome('doc-9')
    const { cdp, fake } = frameManager((method, params) => {
      if (method === 'Runtime.evaluate' && typeof params?.expression === 'string' && params.expression.includes('hasAttribute')) {
        return { result: { value: params.contextId === 22 } }
      }
      return {}
    })
    await cdp.attach(7)
    await cdp.frameExecutionContexts(7)
    emitFrameContexts(fake)

    await expect(resolveFrameContext(cdp, 7, childFrame)).rejects.toThrow(/navigated/)
  })

  it('fails when no debugger context matches the frame document', async () => {
    stubChrome('doc-8')
    const { cdp, fake } = frameManager(() => ({ result: { value: false } }))
    await cdp.attach(7)
    await cdp.frameExecutionContexts(7)
    emitFrameContexts(fake)

    await expect(resolveFrameContext(cdp, 7, childFrame)).rejects.toThrow(/no matching debugger context/)
  })
})

describe('resolveMarkedNode', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('finds the marked element, requests its DOM node, and releases the probe object', async () => {
    const { cdp, fake } = frameManager((method, params) => {
      if (method === 'Runtime.evaluate' && typeof params?.expression === 'string' && params.expression.includes('querySelector')) {
        return params.contextId === 22 ? { result: { objectId: 'obj-1' } } : { result: {} }
      }
      if (method === 'DOM.requestNode') return { nodeId: 42 }
      return {}
    })
    await cdp.attach(7)
    await cdp.frameExecutionContexts(7)
    emitFrameContexts(fake)

    const found = await resolveMarkedNode(cdp, 'marker-1')
    expect(found.nodeId).toBe(42)
    expect(found.context.frameId).toBe('F8')
    expect(fake.sent).toContainEqual(expect.objectContaining({ method: 'DOM.enable', sessionId: 's1' }))
    expect(fake.sent).toContainEqual(expect.objectContaining({ method: 'Runtime.releaseObject', sessionId: 's1', params: { objectId: 'obj-1' } }))
  })
})

describe('management.tabs.upload', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const CALL: ToolCall = { id: 'tool-1', name: 'pageAssets.snapshot', args: {} }
  const OK: ToolAnswer = { ok: true, result: { text: 'page' } }

  function mockChrome(options: { markAnswer?: unknown } = {}): { sendMessage: ReturnType<typeof vi.fn>; getAllFrames: ReturnType<typeof vi.fn> } {
    const sendMessage = vi.fn(async (_tabId: number, message: unknown) => {
      const action = (message as { action?: string }).action
      if (action === 'pageAssets.snapshot') return { ok: true, result: { text: 'Snapshot with elements' } }
      if (action === 'dsh.mark') return options.markAnswer ?? { ok: true, result: { text: 'marked' } }
      if (action === 'dsh.unmark') return { ok: true, result: { text: 'unmarked' } }
      return OK
    })
    const getAllFrames = vi.fn(async () => [
      { frameId: 0, parentFrameId: -1, documentId: 'doc-0', url: 'https://example.com/' },
      { frameId: 8, parentFrameId: 0, documentId: 'doc-8', url: 'https://widget.example/' },
    ])
    vi.stubGlobal('chrome', {
      tabs: { query: vi.fn(async () => [{ id: 7, url: 'https://example.com/', title: 'Tab 7' }]), get: vi.fn(async () => ({ id: 7, url: 'https://example.com/', title: 'Tab 7' })), sendMessage },
      scripting: { executeScript: vi.fn(async () => []) },
      webNavigation: { getAllFrames, getFrame: vi.fn(async () => ({ documentId: 'doc-8' })) },
      runtime: { onMessage: { addListener: () => {}, removeListener: () => {} } },
    })
    return { sendMessage, getAllFrames }
  }

  function fakeSessionWith(nodeId: number): { session: CdpSession; setFiles: ReturnType<typeof vi.fn> } {
    const setFiles = vi.fn(async () => ({}))
    const session = {
      frameExecutionContexts: async () => [{
        frameId: 'F8',
        uniqueId: 'u-1',
        contextId: 5,
        origin: 'https://widget.example',
        send: vi.fn(async (method: string, params?: Record<string, unknown>) => {
          if (method === 'Runtime.evaluate') return { result: { objectId: 'obj-9' } }
          if (method === 'DOM.requestNode') return { nodeId }
          if (method === 'DOM.setFileInputFiles') return setFiles(method, params)
          return {}
        }),
      }],
    } as unknown as CdpSession
    return { session, setFiles }
  }

  const uploadCall: ToolCall = {
    id: 'upload-1',
    name: 'management.tabs.upload',
    args: { frame: 8, index: 3, paths: ['C:/tmp/report.pdf'] },
  }

  it('marks the element, resolves the node, and sets files in the owning context', async () => {
    mockChrome()
    const { session, setFiles } = fakeSessionWith(99)
    const sessionFor = vi.fn(async () => session)

    await dispatchToolCall(CALL, 'auto')
    const answer = await dispatchToolCall(uploadCall, 'auto', undefined, undefined, undefined, undefined, undefined, {
      unrestrictedAccess: true,
      frameDebugger: { sessionFor },
    })

    expect(answer.ok).toBe(true)
    expect((answer.result as { text: string }).text).toContain('element [3] in frame 8')
    expect(setFiles).toHaveBeenCalledWith('DOM.setFileInputFiles', expect.objectContaining({ nodeId: 99, files: ['C:/tmp/report.pdf'] }))
    // Mark and unmark both ran in the target frame document.
    const marked = sessionFor.mock.calls.length
    expect(marked).toBe(1)
  })

  it('reports the debugger gate clearly when developer mode is off', async () => {
    mockChrome()
    const sessionFor = vi.fn(async () => {
      throw Object.assign(new Error('Browser developer mode is off. Enable it in the extension settings first.'), { name: 'CdpUnavailableError', reason: 'disabled' })
    })

    await dispatchToolCall(CALL, 'auto')
    const answer = await dispatchToolCall(uploadCall, 'auto', undefined, undefined, undefined, undefined, undefined, {
      unrestrictedAccess: true,
      frameDebugger: { sessionFor },
    })

    expect(answer.ok).toBe(false)
    expect(answer.error?.message).toContain('developer mode is off')
  })

  it('rolls back the commit and cleans the marker when node resolution fails', async () => {
    const chromeMock = mockChrome()
    const session = {
      frameExecutionContexts: async () => [],
    } as unknown as CdpSession
    const commitAction = vi.fn()
    const rollbackActionCommit = vi.fn()

    await dispatchToolCall(CALL, 'auto')
    const answer = await dispatchToolCall(uploadCall, 'auto', undefined, undefined, undefined, undefined, undefined, {
      unrestrictedAccess: true,
      frameDebugger: { sessionFor: async () => session },
      commitAction,
      rollbackActionCommit,
    })

    expect(answer.ok).toBe(false)
    expect(commitAction).toHaveBeenCalled()
    expect(rollbackActionCommit).toHaveBeenCalled()
    // The cleanup path still cleared the marker in the frame document.
    await vi.waitFor(() => {
      const unmark = chromeMock.sendMessage.mock.calls.find(([ _tab, message ]: unknown[]) => (message as { action?: string }).action === 'dsh.unmark')
      expect(unmark).toBeDefined()
    })
  })
})
