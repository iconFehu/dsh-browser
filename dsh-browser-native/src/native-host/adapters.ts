import type { CapabilityId } from '../shared/capabilities.js'
import type { BackendContext, BrowserBackend } from './backend.js'

export interface JsonRpcTransport {
  request(method: string, params: unknown, signal: AbortSignal): Promise<unknown>
  notify(method: string, params: unknown): Promise<void>
  close(): Promise<void>
  onEvent?(listener: (event: unknown) => void): void
  toolResult?(result: { id: string; ok: boolean; result?: unknown; error?: { code: string; message: string } }): Promise<void>
}

/** Adapter for an App Server exposing capability.call over JSON-RPC. */
export class CodexBackend implements BrowserBackend {
  readonly kind = 'codex' as const
  constructor(private readonly transport: JsonRpcTransport) {}
  async connect(_signal: AbortSignal): Promise<void> {}
  async close(): Promise<void> { await this.transport.close() }
  async call(context: BackendContext, capability: CapabilityId, method: string, args: unknown): Promise<unknown> {
    return this.transport.request('capability.call', { sessionId: context.sessionId, capability, method, args }, context.signal)
  }
  async cancel(requestId: string): Promise<void> { await this.transport.notify('capability.cancel', { requestId }) }
  onEvent(listener: (event: unknown) => void): void { this.transport.onEvent?.(listener) }
  async toolResult(result: { id: string; ok: boolean; result?: unknown; error?: { code: string; message: string } }): Promise<void> { await this.transport.toolResult?.(result) }
}

/** Adapter for the existing DSH bridge RPC surface. */
export class DshBackend implements BrowserBackend {
  readonly kind = 'dsh' as const
  constructor(private readonly transport: JsonRpcTransport) {}
  async connect(_signal: AbortSignal): Promise<void> {}
  async close(): Promise<void> { await this.transport.close() }
  async call(context: BackendContext, capability: CapabilityId, method: string, args: unknown): Promise<unknown> {
    return this.transport.request('browser.capability.call', { sessionId: context.sessionId, capability, method, args }, context.signal)
  }
  async cancel(requestId: string): Promise<void> { await this.transport.notify('browser.capability.cancel', { requestId }) }
  onEvent(listener: (event: unknown) => void): void { this.transport.onEvent?.(listener) }
  async toolResult(result: { id: string; ok: boolean; result?: unknown; error?: { code: string; message: string } }): Promise<void> { await this.transport.toolResult?.(result) }
}
