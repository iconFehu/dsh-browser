/**
 * CDP observation lifecycle for the controlled tab (Chrome only).
 *
 * The observation layer never drives input: clicks, typing, scrolling and
 * navigation stay on the existing high-level content-script pipeline (the
 * Codex division of labor). chrome.debugger is attached only while a side
 * panel conversation is open AND the developer-mode switch is on, and is
 * detached when the panel closes, the controlled tab changes, or the tab
 * navigates away from http(s). Attaching pauses the user's own DevTools for
 * that tab, which is why the switch is off by default.
 *
 * The manager takes an injected debugger-like adapter so its state machine is
 * unit-testable without a browser.
 *
 * @module
 */

import type { CdpErrorShape, MetricSample, NetworkObservation, PageDiagnostic } from './types.ts'
import { CDP_PROTOCOL_VERSION } from './types.ts'
import { NETWORK_BODY_CHARS, NETWORK_LIMIT, RingBuffer } from './buffers.ts'

export interface DebuggeeTarget {
  tabId: number
}

export interface DebuggerLike {
  attach(target: DebuggeeTarget, requiredVersion: string): Promise<void>
  detach(target: DebuggeeTarget): Promise<void>
  sendCommand(target: DebuggeeTarget, method: string, params?: Record<string, unknown>): Promise<unknown>
  addEventListener(handler: (source: DebuggeeTarget, method: string, params: unknown) => void): void
  removeEventListener(handler: (source: DebuggeeTarget, method: string, params: unknown) => void): void
}

export type CdpUnavailableReason = 'disabled' | 'unsupported' | 'unavailable' | 'not-http' | 'retracted' | 'no-panel'

export class CdpUnavailableError extends Error {
  constructor(
    readonly reason: CdpUnavailableReason,
    message: string,
  ) {
    super(message)
    this.name = 'CdpUnavailableError'
  }
}

export interface CdpExecutionContext {
  frameId: string
  contextId: number
  origin: string
}

const OBSERVATION_DOMAINS = ['Runtime', 'Page', 'Network', 'Log', 'Performance'] as const

function describeCdpError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null) {
    const candidate = error as CdpErrorShape
    if (typeof candidate.message === 'string') return candidate.message
    if (candidate.code !== undefined) return String(candidate.code)
  }
  return String(error)
}

/**
 * Tracks one attached tab: execution contexts for deep reading, a diagnostics
 * ring buffer, an observed-network buffer, and performance baselines.
 */
export class CdpManager {
  /** chrome.debugger is available in this browser (Chrome, not Firefox). */
  readonly available: boolean

  private attachedTabId: number | undefined
  private developerMode = false
  private panelActive = false
  private readonly contexts = new Map<string, CdpExecutionContext>()
  readonly diagnostics = new RingBuffer<PageDiagnostic>(64)
  readonly network = new RingBuffer<NetworkObservation>(NETWORK_LIMIT)
  private metricBaseline: MetricSample[] = []

  private readonly onEvent = (source: DebuggeeTarget, method: string, params: unknown): void => {
    if (source.tabId !== this.attachedTabId) return
    switch (method) {
      case 'Runtime.executionContextCreated': {
        const created = params as { context: { id: number; origin: string; auxData?: { frameId?: string; isDefault?: boolean } } }
        const frameId = created.context.auxData?.frameId
        if (frameId !== undefined && created.context.auxData?.isDefault !== false) {
          if (!this.contexts.has(frameId)) {
            this.contexts.set(frameId, { frameId, contextId: created.context.id, origin: created.context.origin })
          }
        }
        return
      }
      case 'Runtime.consoleAPICalled': {
        const event = params as { type?: string; args?: Array<{ type: string; value?: unknown }> }
        if (event.type !== 'error' && event.type !== 'warning') return
        const text = (event.args ?? []).map((arg) => {
          if (arg.type === 'string' && typeof arg.value === 'string') return arg.value
          if (arg.type === 'undefined') return 'undefined'
          return String(arg.value ?? arg.type)
        }).join(' ').slice(0, 400)
        this.diagnostics.push({ kind: 'console', level: event.type === 'error' ? 'error' : 'warning', text, at: Date.now() })
        return
      }
      case 'Log.entryAdded': {
        const entry = (params as { entry?: { level?: string; text?: string; url?: string } }).entry
        if (entry === undefined) return
        const level = entry.level === 'error' ? 'error' : entry.level === 'warning' ? 'warning' : 'info'
        if (level === 'info') return
        const text = `${entry.text ?? ''}${entry.url ? ` @ ${entry.url}` : ''}`.slice(0, 400)
        this.diagnostics.push({ kind: 'log', level, text, at: Date.now() })
        return
      }
      case 'Network.requestWillBeSent': {
        const request = (params as { requestId?: string; request?: { method?: string; url?: string } }).request
        if (request === undefined) return
        this.network.push({
          requestId: String(params && typeof params === 'object' ? (params as { requestId?: string }).requestId ?? '' : ''),
          method: request.method ?? 'GET',
          url: request.url ?? '',
          status: null,
          errorText: null,
          at: Date.now(),
        })
        return
      }
      case 'Network.responseReceived': {
        const received = params as { requestId?: string; response?: { status?: number } }
        if (received.requestId === undefined) return
        const observation = this.network.snapshot().find((entry) => entry.requestId === received.requestId)
        if (observation !== undefined) observation.status = received.response?.status ?? null
        return
      }
      case 'Network.loadingFailed': {
        const failed = params as { requestId?: string; errorText?: string; canceled?: boolean }
        if (failed.requestId === undefined) return
        if (failed.canceled !== true) {
          const observation = this.network.snapshot().find((entry) => entry.requestId === failed.requestId)
          if (observation !== undefined) observation.errorText = failed.errorText ?? 'unknown failure'
        }
        return
      }
    }
  }

  constructor(
    private readonly debuggerLike: DebuggerLike,
    available: boolean,
  ) {
    this.available = available
    if (available) this.debuggerLike.addEventListener(this.onEvent)
  }

  /** Developer mode (user opt-in) gates all attachment. */
  setDeveloperMode(enabled: boolean): void {
    this.developerMode = enabled
    if (!enabled) void this.detach()
  }

  setPanelActive(active: boolean): void {
    this.panelActive = active
    if (!active) void this.detach()
  }

  isAttached(): boolean {
    return this.attachedTabId !== undefined
  }

  attachedTab(): number | undefined {
    return this.attachedTabId
  }

  /** Called when the controlled tab changes or closes, or navigates off http(s). */
  async retract(): Promise<void> {
    await this.detach()
  }

  executionContexts(): CdpExecutionContext[] {
    return [...this.contexts.values()]
  }

  async attach(tabId: number): Promise<void> {
    if (!this.available) throw new CdpUnavailableError('unsupported', 'Chrome DevTools Protocol is not available in this browser.')
    if (!this.developerMode) throw new CdpUnavailableError('disabled', 'Browser developer mode is off. Enable it in the extension settings first.')
    if (!this.panelActive) throw new CdpUnavailableError('no-panel', 'A side panel conversation must be open to attach the browser debugger.')
    if (this.attachedTabId === tabId) return
    await this.detach()
    try {
      await this.debuggerLike.attach({ tabId }, CDP_PROTOCOL_VERSION)
    } catch (error) {
      throw new CdpUnavailableError('unavailable', `Could not attach CDP to this tab (${describeCdpError(error)}). A DevTools window or another debugger may already be attached.`)
    }
    this.attachedTabId = tabId
    this.contexts.clear()
    this.network.clear()
    this.diagnostics.clear()
    this.metricBaseline = []
    try {
      for (const domain of OBSERVATION_DOMAINS) {
        await this.debuggerLike.sendCommand({ tabId }, `${domain}.enable`)
      }
    } catch (error) {
      await this.detach()
      throw new CdpUnavailableError('unavailable', `CDP attach failed while enabling observation domains (${describeCdpError(error)}).`)
    }
  }

  async detach(): Promise<void> {
    const tabId = this.attachedTabId
    this.attachedTabId = undefined
    this.contexts.clear()
    if (tabId === undefined) return
    try {
      await this.debuggerLike.detach({ tabId })
    } catch { /* target already gone or detached */ }
  }

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const tabId = this.attachedTabId
    if (tabId === undefined) throw new CdpUnavailableError('retracted', 'CDP detached before the operation could run.')
    try {
      return await this.debuggerLike.sendCommand({ tabId }, method, params)
    } catch (error) {
      throw new CdpUnavailableError('unavailable', `CDP command ${method} failed (${describeCdpError(error)}).`)
    }
  }

  async evaluate(context: CdpExecutionContext, expression: string): Promise<unknown> {
    const result = await this.send('Runtime.evaluate', {
      expression,
      contextId: context.contextId,
      returnByValue: true,
      awaitPromise: true,
      userGesture: false,
      timeout: 5_000,
    }) as { result?: { value?: unknown; type?: string }; exceptionDetails?: { text?: string } }
    if (result.exceptionDetails !== undefined) {
      throw new CdpUnavailableError('unavailable', `Page evaluation failed: ${result.exceptionDetails.text ?? 'unknown error'}`)
    }
    return result.result?.value
  }

  /** Fetch a previously observed request's response body (text, capped). */
  async fetchResponseBody(requestId: string): Promise<string> {
    const result = await this.send('Network.getResponseBody', { requestId }) as { body?: string; base64Encoded?: boolean }
    if (typeof result.body !== 'string') throw new CdpUnavailableError('unavailable', 'The response body is no longer available.')
    const body = result.base64Encoded === true ? atob(result.body) : result.body
    return body.slice(0, NETWORK_BODY_CHARS)
  }

  /** Take a performance sample and return the delta since the last call. */
  async performanceDelta(): Promise<MetricSample[]> {
    const result = await this.send('Performance.getMetrics') as { metrics?: Array<{ name: string; value: number }> }
    const sample: MetricSample[] = (result.metrics ?? []).map((entry) => ({ name: entry.name, value: entry.value }))
    const baseline = this.metricBaseline
    this.metricBaseline = sample
    if (baseline.length === 0) return []
    const after = new Map(sample.map((entry) => [entry.name, entry.value]))
    const deltas: MetricSample[] = []
    for (const entry of baseline) {
      const next = after.get(entry.name)
      if (next === undefined || next < entry.value) continue
      const delta = next - entry.value
      if (delta > 0) deltas.push({ name: entry.name, value: delta })
    }
    return deltas.sort((a, b) => b.value - a.value)
  }
}

/** Wrap the real chrome.debugger API in the DebuggerLike adapter. */
export function adaptChromeDebugger(): { adapter: DebuggerLike | null; available: boolean } {
  const debuggerApi = (globalThis as { chrome?: { debugger?: unknown } }).chrome?.debugger
  if (debuggerApi === undefined || typeof debuggerApi !== 'object') {
    return { adapter: null, available: false }
  }
  const api = debuggerApi as {
    attach(target: { tabId?: number }, version: string, callback: () => void): void
    detach(target: { tabId?: number }, callback: () => void): void
    sendCommand(target: { tabId?: number }, method: string, params: unknown, callback: (result: unknown) => void): void
    onEvent: {
      addListener(callback: (source: { tabId?: number }, method: string, params: unknown) => void): void
      removeListener(callback: (source: { tabId?: number }, method: string, params: unknown) => void): void
    }
  }
  if (typeof api.attach !== 'function') return { adapter: null, available: false }
  const readError = (): Error | undefined => {
    const lastError = chrome.runtime.lastError
    return lastError === undefined ? undefined : new Error(String(lastError.message ?? lastError))
  }
  const adapter: DebuggerLike = {
    attach: (target, version) => new Promise((resolve, reject) => {
      api.attach(target, version, () => {
        const error = readError()
        if (error !== undefined) reject(error)
        else resolve()
      })
    }),
    detach: (target) => new Promise((resolve, reject) => {
      api.detach(target, () => {
        const error = readError()
        if (error !== undefined) reject(error)
        else resolve()
      })
    }),
    sendCommand: (target, method, params) => new Promise((resolve, reject) => {
      api.sendCommand(target, method, params, (result) => {
        const error = readError()
        if (error !== undefined) reject(error)
        else resolve(result)
      })
    }),
    addEventListener: (handler) => {
      api.onEvent.addListener((source, method, params) => {
        handler({ tabId: source.tabId === undefined ? -1 : source.tabId }, method, params)
      })
    },
    removeEventListener: (handler) => {
      api.onEvent.removeListener((source, method, params) => {
        handler({ tabId: source.tabId === undefined ? -1 : source.tabId }, method, params)
      })
    },
  }
  return { adapter, available: true }
}
