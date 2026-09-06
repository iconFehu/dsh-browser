// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { CDP_OBSERVATION_TOOLS, dispatchCdpObservation, type CdpObservationDeps } from '../src/background/cdp/tools.ts'
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
    const answer = await dispatchCdpObservation(call('browser_diagnostics'), d)
    expect(answer).toMatchObject({ ok: false, error: { code: 'feature-unavailable' } })
  })

  it('refuses non-http controlled tabs', async () => {
    const d = deps({ tab: { id: 1, url: 'https://example.com', windowId: 1 }, manager: fakeManager() })
    const d2 = deps({ tab: { id: 1, url: 'chrome://extensions', windowId: 1 } })
    expect(await dispatchCdpObservation(call('browser_diagnostics'), d2))
      .toMatchObject({ ok: false, error: { code: 'feature-unavailable' } })
    // Attach still must succeed for http: emulate the manager recording attach.
    const recorded: number[] = []
    const attaching = fakeManager()
    ;(attaching as unknown as { attach: (tabId: number) => Promise<void> }).attach = async (tabId: number) => { recorded.push(tabId) }
    const answer = await dispatchCdpObservation(call('browser_diagnostics'), { ...d, manager: attaching })
    expect(recorded).toEqual([1])
    expect(answer).toMatchObject({ ok: true })
  })

  it('surfaces attach failures as feature-unavailable without fallback', async () => {
    const failing = fakeManager()
    ;(failing as unknown as { attach: () => Promise<void> }).attach = async () => {
      throw new CdpUnavailableError('unavailable', 'Another debugger is already attached')
    }
    const d = deps({ manager: failing })
    const answer = await dispatchCdpObservation(call('browser_dom'), d)
    expect(answer).toMatchObject({ ok: false, error: { code: 'feature-unavailable' } })
  })

  it('maps denial and unavailable authorization outcomes', async () => {
    const denied = deps({ sharePageContent: 'ask', authorize: () => Promise.resolve('denied' as const) })
    const deniedAnswer = await dispatchCdpObservation(call('browser_dom'), denied)
    expect(deniedAnswer).toMatchObject({ ok: false, error: { code: 'action-failed' } })

    const unavailable = deps({ sharePageContent: 'ask', authorize: () => Promise.resolve('unavailable' as const) })
    const unavailableAnswer = await dispatchCdpObservation(call('browser_dom'), unavailable)
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
    const answer = await dispatchCdpObservation(call('browser_diagnostics'), d)
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
    const answer = await dispatchCdpObservation(call('browser_dom'), deps({ manager: domManager }))
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
      const answer = await dispatchCdpObservation(call('browser_screenshot'), d)
      expect(answer.ok).toBe(true)
      expect((answer.result as { text: string }).text).toContain('download id 42')
      expect(savedAs).toBe(true)
    } finally {
      ;(globalChrome as { chrome: unknown }).chrome = previous
    }
  })

  it('covers exactly the routed tool names', () => {
    expect([...CDP_OBSERVATION_TOOLS].sort()).toEqual([
      'browser_diagnostics',
      'browser_dom',
      'browser_export_pdf',
      'browser_network',
      'browser_performance',
      'browser_screenshot',
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
    const answer = await dispatchCdpObservation(call('browser_dom'), d)
    expect(kinds).toEqual(['read'])
    expect(answer.ok).toBe(true)
  })
})
