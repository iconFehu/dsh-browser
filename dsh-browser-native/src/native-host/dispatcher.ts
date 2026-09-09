import { CAPABILITIES, capabilityById } from '../shared/capabilities.js'
import { HOST_PROTOCOL_VERSION, isHostRequest, type HostRequest, type HostResponse } from '../shared/host-protocol.js'
import type { BackendKind, BackendRouter } from './backend.js'

export interface DispatcherOptions {
  readonly extensionId: string
  readonly backend: BackendKind
  readonly router: BackendRouter
}

export class HostDispatcher {
  private readonly pending = new Map<string, AbortController>()

  constructor(private readonly options: DispatcherOptions) {}

  async handle(value: unknown): Promise<HostResponse | undefined> {
    if (!isHostRequest(value)) return { type: 'result', id: 'invalid', ok: false, error: { code: 'bad-request', message: 'Invalid Native Messaging request.' } }
    const request = value as HostRequest
    if (request.type === 'hello') {
      if (request.extensionId !== this.options.extensionId || request.protocolVersion !== HOST_PROTOCOL_VERSION) {
        return { type: 'result', id: 'hello', ok: false, error: { code: 'unauthorized', message: 'Extension or protocol version is not accepted.' } }
      }
      return { type: 'hello.ok', protocolVersion: HOST_PROTOCOL_VERSION, capabilities: CAPABILITIES }
    }
    if (request.type === 'capability.cancel') {
      this.pending.get(request.id)?.abort()
      return { type: 'result', id: request.id, ok: true, value: { cancelled: true } }
    }
    if (request.type === 'capability.result') {
      await this.options.router.toolResult(this.options.backend, request)
      return undefined
    }
    if (request.type === 'session.close') return undefined
    const descriptor = capabilityById(request.capability)
    if (!descriptor) return { type: 'result', id: request.id, ok: false, error: { code: 'unsupported', message: `Unknown capability: ${request.capability}` } }
    const controller = new AbortController()
    this.pending.set(request.id, controller)
    const timeout = Math.max(0, request.deadline - Date.now())
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      const backend = this.options.router.select(this.options.backend)
      const value = await backend.call({ sessionId: request.sessionId, signal: controller.signal }, request.capability, request.method, request.args)
      return { type: 'result', id: request.id, ok: true, value }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { type: 'result', id: request.id, ok: false, error: { code: controller.signal.aborted ? 'timeout' : 'internal', message } }
    } finally {
      clearTimeout(timer)
      this.pending.delete(request.id)
    }
  }
}
