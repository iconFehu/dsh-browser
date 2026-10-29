/**
 * CDP lifecycle for controlled tabs (Chrome only).
 *
 * Observation tools never drive input through the content-script pipeline path;
 * clicks, typing, scrolling and navigation stay on high-level tools. When
 * Browser developer mode (`cdpEnabled`) is ON, tool dispatch may also send
 * Runtime.evaluate / Input.* through this manager on the controlled http(s)
 * tab (unrestricted debugger; hard denylist still applies).
 * chrome.debugger is attached only while a side panel conversation is open AND
 * the developer-mode switch is on, and is detached when the panel closes, the
 * owning turn ends, or the tab navigates away from http(s). Attaching
 * pauses the user's own DevTools for that tab, which is why the switch is off
 * by default.
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
  addDetachListener?(handler: (source: DebuggeeTarget) => void): void
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

interface TabState {
  owners: Set<AbortSignal | undefined>
  contexts: Map<string, CdpExecutionContext>
  diagnostics: RingBuffer<PageDiagnostic>
  network: RingBuffer<NetworkObservation>
  metricBaseline: MetricSample[]
  attached: boolean
  ready: Promise<void>
}

/** Target-bound surface passed to tool executors. */
export type CdpSession = Pick<CdpManager, 'available' | 'developerModeEnabled' | 'diagnostics' | 'network'
  | 'attach' | 'attachedTab' | 'send' | 'executionContexts' | 'evaluate' | 'fetchResponseBody' | 'performanceDelta'>

/** Keeps execution contexts, observations and performance baselines isolated per tab. */
export class CdpManager {
  /** chrome.debugger is available in this browser (Chrome, not Firefox). */
  readonly available: boolean

  private developerMode = false
  private panelActive = false
  private readonly tabs = new Map<number, TabState>()
  private readonly detaching = new Map<number, Promise<void>>()
  private readonly detachHandlers = new Set<(tabId: number) => void>()

  private readonly onEvent = (source: DebuggeeTarget, method: string, params: unknown): void => {
    const state = this.tabs.get(source.tabId)
    if (state === undefined) return
    switch (method) {
      case 'Runtime.executionContextCreated': {
        const created = params as { context: { id: number; origin: string; auxData?: { frameId?: string; isDefault?: boolean } } }
        const frameId = created.context.auxData?.frameId
        if (frameId !== undefined && created.context.auxData?.isDefault !== false) {
          if (!state.contexts.has(frameId)) {
            state.contexts.set(frameId, { frameId, contextId: created.context.id, origin: created.context.origin })
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
        state.diagnostics.push({ kind: 'console', level: event.type === 'error' ? 'error' : 'warning', text, at: Date.now() })
        return
      }
      case 'Log.entryAdded': {
        const entry = (params as { entry?: { level?: string; text?: string; url?: string } }).entry
        if (entry === undefined) return
        const level = entry.level === 'error' ? 'error' : entry.level === 'warning' ? 'warning' : 'info'
        if (level === 'info') return
        const text = `${entry.text ?? ''}${entry.url ? ` @ ${entry.url}` : ''}`.slice(0, 400)
        state.diagnostics.push({ kind: 'log', level, text, at: Date.now() })
        return
      }
      case 'Network.requestWillBeSent': {
        const request = (params as { requestId?: string; request?: { method?: string; url?: string } }).request
        if (request === undefined) return
        state.network.push({
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
        const observation = state.network.snapshot().find((entry) => entry.requestId === received.requestId)
        if (observation !== undefined) observation.status = received.response?.status ?? null
        return
      }
      case 'Network.loadingFailed': {
        const failed = params as { requestId?: string; errorText?: string; canceled?: boolean }
        if (failed.requestId === undefined) return
        if (failed.canceled !== true) {
          const observation = state.network.snapshot().find((entry) => entry.requestId === failed.requestId)
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
    if (available) {
      this.debuggerLike.addEventListener(this.onEvent)
      this.debuggerLike.addDetachListener?.(({ tabId }) => {
        if (this.tabs.get(tabId)?.attached) void this.detach(tabId, true)
      })
    }
  }

  /** Developer mode (user opt-in) gates all attachment and unrestricted debugger. */
  get developerModeEnabled(): boolean {
    return this.developerMode
  }

  setDeveloperMode(enabled: boolean): void {
    this.developerMode = enabled
    if (!enabled) void this.detach()
  }

  setPanelActive(active: boolean): void {
    this.panelActive = active
    if (!active) void this.detach()
  }

  isAttached(tabId?: number): boolean {
    return tabId === undefined ? this.tabs.size > 0 : this.tabs.has(tabId)
  }

  attachedTabs(): number[] { return [...this.tabs.keys()] }

  /** Compatibility for single-tab callers; never choose an arbitrary tab. */
  attachedTab(): number | undefined {
    return this.tabs.size === 1 ? this.tabs.keys().next().value : undefined
  }

  addDetachHandler(handler: (tabId: number) => void): void { this.detachHandlers.add(handler) }

  async retract(tabId?: number): Promise<void> { await this.detach(tabId) }

  private state(tabId = this.attachedTab()): TabState {
    const state = tabId === undefined ? undefined : this.tabs.get(tabId)
    if (state === undefined) throw new CdpUnavailableError('retracted', 'CDP detached or no explicit tab was selected.')
    return state
  }

  get diagnostics(): RingBuffer<PageDiagnostic> { return this.state().diagnostics }
  get network(): RingBuffer<NetworkObservation> { return this.state().network }
  executionContexts(tabId?: number): CdpExecutionContext[] { return [...this.state(tabId).contexts.values()] }

  /** Bind every operation, including reads after awaits, to one target and owner. */
  forTab(tabId: number, owner?: AbortSignal): CdpSession {
    let attachedState: TabState | undefined
    const check = (): void => {
      if (owner?.aborted || (attachedState !== undefined && this.tabs.get(tabId) !== attachedState)) {
        throw new CdpUnavailableError('retracted', 'The browser turn or CDP attachment has ended.')
      }
    }
    const manager = this
    return {
      get available() { return manager.available },
      get developerModeEnabled() { return manager.developerModeEnabled },
      get diagnostics() { check(); return manager.state(tabId).diagnostics },
      get network() { check(); return manager.state(tabId).network },
      attach: async (target) => {
        check()
        if (target !== tabId) throw new CdpUnavailableError('retracted', 'CDP target changed during the operation.')
        await manager.attach(tabId, owner)
        check()
        attachedState = manager.state(tabId)
      },
      attachedTab: () => owner?.aborted ? undefined : manager.isAttached(tabId) ? tabId : undefined,
      send: (method, params) => { check(); return manager.send(method, params, tabId) },
      executionContexts: () => { check(); return manager.executionContexts(tabId) },
      evaluate: (context, expression) => { check(); return manager.evaluate(context, expression, tabId) },
      fetchResponseBody: (requestId) => { check(); return manager.fetchResponseBody(requestId, tabId) },
      performanceDelta: () => { check(); return manager.performanceDelta(tabId) },
    }
  }

  async attach(tabId: number, owner?: AbortSignal): Promise<void> {
    if (!this.available) throw new CdpUnavailableError('unsupported', 'Chrome DevTools Protocol is not available in this browser.')
    if (!this.developerMode) throw new CdpUnavailableError('disabled', 'Browser developer mode is off. Enable it in the extension settings first.')
    if (!this.panelActive) throw new CdpUnavailableError('no-panel', 'A side panel conversation must be open to attach the browser debugger.')
    if (owner?.aborted) throw new CdpUnavailableError('retracted', 'The browser turn has ended.')
    let state = this.tabs.get(tabId)
    if (state === undefined) {
      state = {
        owners: new Set(), contexts: new Map(), diagnostics: new RingBuffer(64),
        network: new RingBuffer(NETWORK_LIMIT), metricBaseline: [], attached: false,
        ready: Promise.resolve(),
      }
      this.tabs.set(tabId, state)
      const previousDetach = this.detaching.get(tabId)
      state.ready = this.initialize(tabId, state, previousDetach)
    }
    state.owners.add(owner)
    try {
      await state.ready
      if (owner?.aborted || this.tabs.get(tabId) !== state) {
        throw new CdpUnavailableError('retracted', 'CDP detached before the operation could run.')
      }
    } catch (error) {
      if (this.tabs.get(tabId) === state) {
        if (owner?.aborted) state.owners.delete(owner)
        if (!owner?.aborted || state.owners.size === 0) await this.detach(tabId)
      }
      throw error
    }
  }

  private async initialize(tabId: number, state: TabState, previousDetach?: Promise<void>): Promise<void> {
    if (previousDetach !== undefined) await previousDetach
    if (this.tabs.get(tabId) !== state) throw new CdpUnavailableError('retracted', 'CDP attachment was revoked.')
    try {
      await this.debuggerLike.attach({ tabId }, CDP_PROTOCOL_VERSION)
      state.attached = true
      for (const domain of OBSERVATION_DOMAINS) {
        if (this.tabs.get(tabId) !== state) throw new CdpUnavailableError('retracted', 'CDP attachment was revoked.')
        await this.debuggerLike.sendCommand({ tabId }, `${domain}.enable`)
      }
    } catch (error) {
      if (error instanceof CdpUnavailableError) throw error
      throw new CdpUnavailableError('unavailable', `Could not initialize CDP for tab ${tabId} (${describeCdpError(error)}). A DevTools window or another debugger may already be attached.`)
    }
  }

  /** Remove one turn's ownership; peers using the same tab retain their connection. */
  async release(owner: AbortSignal): Promise<void> {
    const pending: Promise<void>[] = []
    for (const [tabId, state] of this.tabs) {
      if (state.owners.delete(owner) && state.owners.size === 0) pending.push(this.detach(tabId))
    }
    await Promise.allSettled(pending)
  }

  async detach(tabId?: number, alreadyDetached = false): Promise<void> {
    if (tabId === undefined) {
      await Promise.allSettled([...this.tabs.keys()].map((id) => this.detach(id)))
      await Promise.allSettled([...this.detaching.values()])
      return
    }
    const state = this.tabs.get(tabId)
    if (state === undefined) { await this.detaching.get(tabId); return }
    this.tabs.delete(tabId)
    state.contexts.clear()
    state.network.clear()
    state.diagnostics.clear()
    state.metricBaseline = []
    for (const handler of this.detachHandlers) handler(tabId)
    const cleanup = (async () => {
      try { await state.ready } catch { /* a revoked or failed attach still needs cleanup */ }
      if (!state.attached || alreadyDetached) return
      try { await this.debuggerLike.detach({ tabId }) } catch { /* target already gone */ }
    })()
    this.detaching.set(tabId, cleanup)
    try { await cleanup } finally {
      if (this.detaching.get(tabId) === cleanup) this.detaching.delete(tabId)
    }
  }

  async send(method: string, params?: Record<string, unknown>, tabId = this.attachedTab()): Promise<unknown> {
    this.state(tabId)
    if (tabId === undefined) throw new CdpUnavailableError('retracted', 'CDP detached before the operation could run.')
    try {
      return await this.debuggerLike.sendCommand({ tabId }, method, params)
    } catch (error) {
      throw new CdpUnavailableError('unavailable', `CDP command ${method} failed (${describeCdpError(error)}).`)
    }
  }

  async evaluate(context: CdpExecutionContext, expression: string, tabId?: number): Promise<unknown> {
    const result = await this.send('Runtime.evaluate', {
      expression,
      contextId: context.contextId,
      returnByValue: true,
      awaitPromise: true,
      userGesture: false,
      timeout: 5_000,
    }, tabId) as { result?: { value?: unknown; type?: string }; exceptionDetails?: { text?: string } }
    if (result.exceptionDetails !== undefined) {
      throw new CdpUnavailableError('unavailable', `Page evaluation failed: ${result.exceptionDetails.text ?? 'unknown error'}`)
    }
    return result.result?.value
  }

  /** Fetch a previously observed request's response body (text, capped). */
  async fetchResponseBody(requestId: string, tabId?: number): Promise<string> {
    const result = await this.send('Network.getResponseBody', { requestId }, tabId) as { body?: string; base64Encoded?: boolean }
    if (typeof result.body !== 'string') throw new CdpUnavailableError('unavailable', 'The response body is no longer available.')
    const body = result.base64Encoded === true ? atob(result.body) : result.body
    return body.slice(0, NETWORK_BODY_CHARS)
  }

  /** Take a performance sample and return the delta since the last call. */
  async performanceDelta(tabId?: number): Promise<MetricSample[]> {
    const state = this.state(tabId)
    const result = await this.send('Performance.getMetrics', undefined, tabId) as { metrics?: Array<{ name: string; value: number }> }
    const sample: MetricSample[] = (result.metrics ?? []).map((entry) => ({ name: entry.name, value: entry.value }))
    const baseline = state.metricBaseline
    state.metricBaseline = sample
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
    onDetach?: { addListener(callback: (source: { tabId?: number }) => void): void }
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
  const eventHandlers = new Map<Parameters<DebuggerLike['addEventListener']>[0], (source: { tabId?: number }, method: string, params: unknown) => void>()
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
      const wrapped = (source: { tabId?: number }, method: string, params: unknown): void => {
        handler({ tabId: source.tabId ?? -1 }, method, params)
      }
      eventHandlers.set(handler, wrapped)
      api.onEvent.addListener(wrapped)
    },
    removeEventListener: (handler) => {
      const wrapped = eventHandlers.get(handler)
      if (wrapped !== undefined) api.onEvent.removeListener(wrapped)
      eventHandlers.delete(handler)
    },
    addDetachListener: (handler) => {
      api.onDetach?.addListener((source) => { if (source.tabId !== undefined) handler({ tabId: source.tabId }) })
    },
  }
  return { adapter, available: true }
}
