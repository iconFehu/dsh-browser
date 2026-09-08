import type { CapabilityRegistry } from './capability-registry.js'

export interface WebMcpTool { readonly name: string; readonly description?: string; readonly origin: string; readonly registrationId: string }
export interface WebMcpApi {
  fetchTools(tabId: number, signal: AbortSignal): Promise<readonly WebMcpTool[]>
  call(tabId: number, tool: WebMcpTool, input: unknown, signal: AbortSignal): Promise<unknown>
}

export function registerWebMcpCapability(registry: CapabilityRegistry, api: WebMcpApi): void {
  registry.register('webmcp', 'fetchTools', async (context) => {
    if (context.tabId === undefined) throw new Error('webmcp.fetchTools requires a tab')
    return api.fetchTools(context.tabId, context.signal)
  })
  registry.register('webmcp', 'call', async (context, _method, raw) => {
    if (context.tabId === undefined) throw new Error('webmcp.call requires a tab')
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('webmcp call must be an object')
    const args = raw as Record<string, unknown>
    if (!args.tool || typeof args.tool !== 'object' || Array.isArray(args.tool)) throw new Error('webmcp tool descriptor is required')
    const tool = args.tool as Record<string, unknown>
    if (typeof tool.name !== 'string' || typeof tool.origin !== 'string' || typeof tool.registrationId !== 'string') throw new Error('invalid webmcp tool descriptor')
    if (!/^https?:\/\//i.test(tool.origin)) throw new Error('webmcp tool origin must be http(s)')
    return api.call(context.tabId, { name: tool.name, description: typeof tool.description === 'string' ? tool.description : undefined, origin: tool.origin, registrationId: tool.registrationId }, args.input, context.signal)
  })
}
