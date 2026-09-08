import { capabilityById, type CapabilityId } from './capabilities.js'

export interface CapabilityCallContext {
  readonly sessionId: string
  readonly signal: AbortSignal
  readonly tabId?: number
}

export type CapabilityHandler = (context: CapabilityCallContext, method: string, args: unknown) => Promise<unknown>

export class CapabilityRegistry {
  private readonly handlers = new Map<CapabilityId, Map<string, CapabilityHandler>>()

  register(capability: CapabilityId, method: string, handler: CapabilityHandler): void {
    if (!capabilityById(capability)) throw new Error(`Unknown capability: ${capability}`)
    const methods = this.handlers.get(capability) ?? new Map<string, CapabilityHandler>()
    if (methods.has(method)) throw new Error(`Duplicate capability method: ${capability}.${method}`)
    methods.set(method, handler)
    this.handlers.set(capability, methods)
  }

  has(capability: string, method: string): boolean {
    return this.handlers.get(capability as CapabilityId)?.has(method) ?? false
  }

  async call(capability: string, method: string, context: CapabilityCallContext, args: unknown): Promise<unknown> {
    const handler = this.handlers.get(capability as CapabilityId)?.get(method)
    if (!handler) throw new Error(`Unsupported capability method: ${capability}.${method}`)
    return handler(context, method, args)
  }
}
