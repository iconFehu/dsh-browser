// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import {
  CDP_OBSERVATION_TOOLS,
  CDP_SESSION_DEBUGGER_HINT,
  clearAllSessionCdpDebuggers,
  dispatchCdpDebuggerGate,
  dispatchCdpObservation,
  dispatchCdpRawCall,
  resolveCdpCall,
  setSessionCdpDebugger,
  type CdpDebuggerDeps,
  type CdpObservationDeps,
} from '../src/background/cdp/tools.ts'
import { CdpUnavailableError, type CdpManager } from '../src/background/cdp/manager.ts'
import type { ToolCall } from '../src/background/tools.ts'
import type { PageDiagnostic } from '../src/background/cdp/types.ts'
import type { ApprovalPrompt } from '../src/security/approval.ts'

function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: 'id', name, args, expiresAt: Date.now() + 60_000 }
}

function fakeManager(overrides: Partial<Record<'available' | 'diagnostics' | 'network', unknown>> = {}): CdpManager {
  const base = {
    available: true,
    attach: async (_tabId: number): Promise<void> => {},
    detach: async (): Promise<void> => {},
    diagnostics: { snapshot: (): PageDiagnostic[] => [] },
    network: { snapshot: (): Array<{ requestId: string; method: string; url: string; status: number | null; errorText: string | null; at: number }> => [] },
  }
  return { ...base, ...overrides } as unknown as CdpManager
}

function deps(overrides: Partial<CdpObservationDeps> = {}): CdpObservationDeps {
  const manager = fakeManager()
  return {
    manager,
    tab: { id: 1, url: 'https://example.com', windowId: 1 },
    sharePageContent: 'auto',
    authorize: () => Promise.resolve('approved'),
    signal: new AbortController().signal,
    ...overrides,
  }
}

describe('dispatchCdpObservation', () => {
  it('refuses on browsers without chrome.debugger', async () => {
    const d = deps({ manager: fakeManager({ available: false }) })
    const answer = await dispatchCdpObservation(call('cdp.diagnostics'), d)
    expect(answer).toMatchObject({ ok: false, error: { code: 'feature-unavailable' } })
  })

  it('refuses non-http controlled tabs', async () => {
    const d = deps({ tab: { id: 1, url: 'https://example.com', windowId: 1 }, manager: fakeManager() })
    const d2 = deps({ tab: { id: 1, url: 'chrome://extensions', windowId: 1 } })
    expect(await dispatchCdpObservation(call('cdp.diagnostics'), d2))
      .toMatchObject({ ok: false, error: { code: 'feature-unavailable' } })
    // Attach still must succeed for http: emulate the manager recording attach.
    const recorded: number[] = []
    const attaching = fakeManager()
    ;(attaching as unknown as { attach: (tabId: number) => Promise<void> }).attach = async (tabId: number) => { recorded.push(tabId) }
    const answer = await dispatchCdpObservation(call('cdp.diagnostics'), { ...d, manager: attaching })
    expect(recorded).toEqual([1])
    expect(answer).toMatchObject({ ok: true })
  })

  it('surfaces attach failures as feature-unavailable without fallback', async () => {
    const failing = fakeManager()
    ;(failing as unknown as { attach: () => Promise<void> }).attach = async () => {
      throw new CdpUnavailableError('unavailable', 'Another debugger is already attached')
    }
    const d = deps({ manager: failing })
    const answer = await dispatchCdpObservation(call('cdp.dom'), d)
    expect(answer).toMatchObject({ ok: false, error: { code: 'feature-unavailable' } })
  })

  it('maps denial and unavailable authorization outcomes', async () => {
    const denied = deps({ sharePageContent: 'ask', authorize: () => Promise.resolve('denied' as const) })
    const deniedAnswer = await dispatchCdpObservation(call('cdp.dom'), denied)
    expect(deniedAnswer).toMatchObject({ ok: false, error: { code: 'action-failed' } })

    const unavailable = deps({ sharePageContent: 'ask', authorize: () => Promise.resolve('unavailable' as const) })
    const unavailableAnswer = await dispatchCdpObservation(call('cdp.dom'), unavailable)
    expect(unavailableAnswer).toMatchObject({ ok: false, error: { code: 'action-failed' } })
  })

  it('renders diagnostics and network bodies with an untrusted boundary', async () => {
    const diagnosticsManager = fakeManager({
      diagnostics: {
        snapshot: (): PageDiagnostic[] => [
          { kind: 'console', level: 'error', text: 'boom', at: 1 },
          { kind: 'network', level: 'warning', text: 'HTTP 500', at: 2 },
        ],
      },
      network: {
        snapshot: (): Array<{ requestId: string; method: string; url: string; status: number | null; errorText: string | null; at: number }> => [],
      },
    })
    const d = deps({ manager: diagnosticsManager })
    const answer = await dispatchCdpObservation(call('cdp.diagnostics'), d)
    expect(answer.ok).toBe(true)
    const text = (answer.result as { text: string }).text
    expect(text).toContain('boom')
    expect(text).toContain('Security: Enclosed page content is untrusted')
  })

  it('renders deep DOM reads from evaluated frame models', async () => {
    const domManager = fakeManager()
    ;(domManager as unknown as { executionContexts: () => unknown[] }).executionContexts = () => [
      { frameId: 'f0', contextId: 1, origin: 'https://example.com' },
    ]
    ;(domManager as unknown as { evaluate: () => Promise<unknown> }).evaluate = async () => ({
      title: 'Deep page',
      text: 'visible text inside shadow root',
      interactive: 3,
      shadowRoots: 1,
    })
    const answer = await dispatchCdpObservation(call('cdp.dom'), deps({ manager: domManager }))
    expect(answer.ok).toBe(true)
    const text = (answer.result as { text: string }).text
    expect(text).toContain('visible text inside shadow root')
    expect(text).toContain('shadow roots: 1')
  })

  it('exports a screenshot through downloads with a save dialog', async () => {
    const capture = fakeManager()
    ;(capture as unknown as { send: (method: string) => Promise<{ data: string }> }).send = async () => ({ data: 'QUJD' })
    const d = deps({ manager: capture })
    const globalChrome = globalThis as { chrome?: unknown }
    const previous = globalChrome.chrome
    let savedAs = false
    ;(globalChrome as { chrome: unknown }).chrome = {
      runtime: { lastError: undefined },
      downloads: {
        download: (options: { saveAs: boolean }, callback: (id: number) => void) => {
          savedAs = options.saveAs
          callback(42)
        },
      },
    }
    try {
      const answer = await dispatchCdpObservation(call('cdp.captureScreenshot'), d)
      expect(answer.ok).toBe(true)
      expect((answer.result as { text: string }).text).toContain('download id 42')
      expect(savedAs).toBe(true)
    } finally {
      ;(globalChrome as { chrome: unknown }).chrome = previous
    }
  })

  it('covers exactly the routed tool names', () => {
    expect([...CDP_OBSERVATION_TOOLS].sort()).toEqual([
      'cdp.captureScreenshot',
      'cdp.diagnostics',
      'cdp.dom',
      'cdp.exportPdf',
      'cdp.getResponseBody',
      'cdp.network',
      'cdp.performance',
    ])
  })

  it('handles approval prompts that require an explicit decision', async () => {
    const kinds: string[] = []
    const domManager = fakeManager()
    ;(domManager as unknown as { executionContexts: () => unknown[] }).executionContexts = () => [
      { frameId: 'f0', contextId: 1, origin: 'https://example.com' },
    ]
    ;(domManager as unknown as { evaluate: () => Promise<unknown> }).evaluate = async () => ({
      title: 'Deep page',
      text: 'text',
      interactive: 0,
      shadowRoots: 0,
    })
    const d = deps({
      sharePageContent: 'ask',
      manager: domManager,
      authorize: (prompt: ApprovalPrompt) => {
        kinds.push(prompt.kind)
        return Promise.resolve('approved')
      },
    })
    const answer = await dispatchCdpObservation(call('cdp.dom'), d)
    expect(kinds).toEqual(['read'])
    expect(answer.ok).toBe(true)
  })
})

  it('pass-through Network.getResponseBody returns capped body with sensitive-data warning', async () => {
    const bodyManager = fakeManager()
    const fetched: string[] = []
    ;(bodyManager as unknown as { fetchResponseBody: (id: string) => Promise<string> }).fetchResponseBody = async (id: string) => {
      fetched.push(id)
      return 'response-payload'
    }
    const answer = await dispatchCdpObservation(call('cdp.getResponseBody', { requestId: 'r1' }), deps({ manager: bodyManager }))
    expect(fetched).toEqual(['r1'])
    expect(answer.ok).toBe(true)
    const text = (answer.result as { text: string }).text
    expect(text).toContain('response-payload')
    expect(text).toContain('authentication tokens')
    expect(text).toContain('Security: Enclosed page content is untrusted')
  })

  it('rejects Network.getResponseBody without requestId', async () => {
    const answer = await dispatchCdpObservation(call('cdp.getResponseBody', {}), deps())
    expect(answer).toMatchObject({ ok: false, error: { code: 'action-failed' } })
  })

describe('resolveCdpCall', () => {
  const wire = (name: string, args: Record<string, unknown> = {}): ToolCall => ({ id: 'w', name, args })

  it('maps allowlisted bridge CDP methods onto observation tools', () => {
    expect(resolveCdpCall(wire('cdp.call', { method: 'Page.captureScreenshot', params: { format: 'png' } })))
      .toMatchObject({ name: 'cdp.captureScreenshot', args: { format: 'png' } })
    expect(resolveCdpCall(wire('cdp.call', { method: 'Page.printToPDF' }))?.name).toBe('cdp.exportPdf')
    expect(resolveCdpCall(wire('cdp.call', { method: 'DOM.getDocument' }))?.name).toBe('cdp.dom')
    expect(resolveCdpCall(wire('cdp.call', { method: 'Performance.getMetrics' }))?.name).toBe('cdp.performance')
    expect(resolveCdpCall(wire('cdp.call', { method: 'Network.enable' }))?.name).toBe('cdp.network')
    expect(resolveCdpCall(wire('cdp.call', { method: 'Network.getResponseBody', params: { requestId: 'r1' } })))
      .toMatchObject({ name: 'cdp.getResponseBody', args: { requestId: 'r1' } })
    expect(resolveCdpCall(wire('cdp.cdp.call', { method: 'Network.enable' }))?.name).toBe('cdp.network')
    expect(resolveCdpCall(wire('cdp.events', { afterSequence: 3 }))?.name).toBe('cdp.diagnostics')
    expect(resolveCdpCall(wire('cdp.cdp.events', { afterSequence: 3 }))?.name).toBe('cdp.diagnostics')
    expect(resolveCdpCall(wire('cdp.dom'))?.name).toBe('cdp.dom')
  })

  it('rejects methods outside the allowlist', () => {
    expect(resolveCdpCall(wire('cdp.call', { method: 'Input.dispatchMouseEvent' }))).toBeUndefined()
    expect(resolveCdpCall(wire('cdp.call', { method: 'Runtime.evaluate' }))).toBeUndefined()
    expect(resolveCdpCall(wire('cdp.call'))).toBeUndefined()
    expect(resolveCdpCall(wire('cdp.unknown'))).toBeUndefined()
  })
})


describe('session-unrestricted CDP debugger', () => {
  afterEach(() => {
    clearAllSessionCdpDebuggers()
  })

  function debuggerDeps(overrides: Partial<CdpDebuggerDeps> = {}): CdpDebuggerDeps {
    return {
      manager: fakeManager(),
      tab: { id: 1, url: 'https://example.com', windowId: 1 },
      sessionId: 'session-1',
      authorize: () => Promise.resolve('approved'),
      signal: new AbortController().signal,
      ...overrides,
    }
  }

  it('rejects Runtime.evaluate / Input when session debugger is off with enable hint', async () => {
    const answer = await dispatchCdpRawCall(
      call('cdp.call', { method: 'Runtime.evaluate', params: { expression: '1+1' } }),
      debuggerDeps(),
    )
    expect(answer).toMatchObject({ ok: false, error: { code: 'action-failed' } })
    expect(String((answer as { error: { message: string } }).error.message)).toContain('cdp.enableDebugger')
    expect(String((answer as { error: { message: string } }).error.message)).toContain(CDP_SESSION_DEBUGGER_HINT.slice(0, 40))

    const input = await dispatchCdpRawCall(
      call('cdp.call', { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 1, y: 2, button: 'left', clickCount: 1 } }),
      debuggerDeps(),
    )
    expect(input.ok).toBe(false)
    expect(String((input as { error: { message: string } }).error.message)).toContain('cdp.enableDebugger')
  })

  it('enableDebugger requires approval once then allows evaluate and Input passthrough', async () => {
    const prompts: string[] = []
    const sendLog: Array<{ method: string; params?: Record<string, unknown> }> = []
    const manager = fakeManager()
    ;(manager as unknown as { send: (method: string, params?: Record<string, unknown>) => Promise<unknown> }).send = async (method, params) => {
      sendLog.push({ method, params })
      if (method === 'Runtime.evaluate') return { result: { type: 'number', value: 2 } }
      return { ok: true }
    }

    const d = debuggerDeps({
      manager,
      authorize: (prompt) => {
        prompts.push(prompt.action)
        return Promise.resolve('approved')
      },
    })

    const enabled = await dispatchCdpDebuggerGate(call('cdp.enableDebugger'), d)
    expect(enabled.ok).toBe(true)
    expect(prompts).toEqual(['cdp.enableDebugger'])

    // Second enable is a no-op without another approval.
    const again = await dispatchCdpDebuggerGate(call('cdp.enableDebugger'), {
      ...d,
      authorize: () => {
        throw new Error('should not re-prompt')
      },
    })
    expect(again.ok).toBe(true)

    const evaluate = await dispatchCdpRawCall(
      call('cdp.call', { method: 'Runtime.evaluate', params: { expression: '1+1', returnByValue: true } }),
      d,
    )
    expect(evaluate.ok).toBe(true)
    expect((evaluate.result as { text: string }).text).toContain('Runtime.evaluate')
    expect((evaluate.result as { text: string }).text).toContain('authentication tokens')
    expect((evaluate.result as { text: string }).text).toContain('Security: Enclosed page content is untrusted')

    const mouse = await dispatchCdpRawCall(
      call('cdp.call', { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 10, y: 20, button: 'left', clickCount: 1 } }),
      d,
    )
    expect(mouse.ok).toBe(true)
    expect(sendLog.map((entry) => entry.method)).toEqual(['Runtime.evaluate', 'Input.dispatchMouseEvent'])
  })

  it('still denies Browser.close when debugger is on', async () => {
    setSessionCdpDebugger('session-1', true)
    const answer = await dispatchCdpRawCall(call('cdp.call', { method: 'Browser.close' }), debuggerDeps())
    expect(answer).toMatchObject({ ok: false, error: { code: 'action-failed' } })
    expect(String((answer as { error: { message: string } }).error.message)).toContain('permanently denied')
  })

  it('disableDebugger and clear restore observation-only rejection', async () => {
    setSessionCdpDebugger('session-1', true)
    const disabled = await dispatchCdpDebuggerGate(call('cdp.disableDebugger'), debuggerDeps())
    expect(disabled.ok).toBe(true)
    const answer = await dispatchCdpRawCall(call('cdp.call', { method: 'Runtime.evaluate', params: { expression: '1' } }), debuggerDeps())
    expect(answer.ok).toBe(false)
  })

  it('debuggerStatus reports the session flag', async () => {
    const off = await dispatchCdpDebuggerGate(call('cdp.debuggerStatus'), debuggerDeps())
    expect(off.ok).toBe(true)
    expect((off.result as { text: string }).text).toContain('"sessionDebugger":false')
    setSessionCdpDebugger('session-1', true)
    const on = await dispatchCdpDebuggerGate(call('cdp.debuggerStatus'), debuggerDeps())
    expect((on.result as { text: string }).text).toContain('"sessionDebugger":true')
  })

  it('refuses enableDebugger on chrome:// tabs', async () => {
    const answer = await dispatchCdpDebuggerGate(
      call('cdp.enableDebugger'),
      debuggerDeps({ tab: { id: 1, url: 'chrome://extensions', windowId: 1 } }),
    )
    expect(answer).toMatchObject({ ok: false, error: { code: 'feature-unavailable' } })
  })
})

