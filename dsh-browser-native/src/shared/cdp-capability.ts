import type { CapabilityRegistry } from './capability-registry.js'

export interface CdpApi {
  send(tabId: number, method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
  events(tabId: number, afterSequence?: number, signal?: AbortSignal): Promise<unknown>
}

// Observation and capture only. Debugger attach, arbitrary script execution,
// cookie access and navigation are intentionally not exposed by this layer.
export const ALLOWED_CDP_METHODS = new Set([
  'Accessibility.getFullAXTree',
  'DOM.getDocument',
  'DOM.getOuterHTML',
  'Network.enable',
  'Network.disable',
  'Performance.enable',
  'Performance.disable',
  'Performance.getMetrics',
  'Page.captureScreenshot',
  'Page.printToPDF',
])

export function registerCdpCapability(registry: CapabilityRegistry, cdp: CdpApi): void {
  registry.register('cdp', 'call', async (context, _method, raw) => {
    if (context.tabId === undefined) throw new Error('cdp.call requires a tab')
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('cdp.call arguments must be an object')
    const args = raw as Record<string, unknown>
    if (typeof args.method !== 'string' || !ALLOWED_CDP_METHODS.has(args.method)) throw new Error('CDP method is not allowlisted')
    const params = args.params === undefined ? {} : args.params
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('CDP params must be an object')
    return cdp.send(context.tabId, args.method, params as Record<string, unknown>, context.signal)
  })
  registry.register('cdp', 'events', async (context, _method, raw) => {
    if (context.tabId === undefined) throw new Error('cdp.events requires a tab')
    const args = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
    const sequence = args.afterSequence
    if (sequence !== undefined && (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0)) throw new Error('afterSequence must be a non-negative integer')
    return cdp.events(context.tabId, sequence as number | undefined, context.signal)
  })
}
