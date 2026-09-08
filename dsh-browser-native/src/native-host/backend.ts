import type { CapabilityId } from '../shared/capabilities.js'

export type BackendKind = 'codex' | 'dsh'

export interface BackendContext {
  readonly sessionId: string
  readonly signal: AbortSignal
}

export interface BrowserBackend {
  readonly kind: BackendKind
  connect(signal: AbortSignal): Promise<void>
  close(): Promise<void>
  call(context: BackendContext, capability: CapabilityId, method: string, args: unknown): Promise<unknown>
  cancel(requestId: string): Promise<void>
  toolResult?(result: { id: string; ok: boolean; result?: unknown; error?: { code: string; message: string } }): Promise<void>
  onEvent?(listener: (event: unknown) => void): void
}

export class BackendRouter {
  constructor(private readonly backends: readonly BrowserBackend[]) {}

  async connect(signal: AbortSignal): Promise<void> {
    for (const backend of this.backends) await backend.connect(signal)
  }

  select(kind: BackendKind): BrowserBackend {
    const backend = this.backends.find((candidate) => candidate.kind === kind)
    if (!backend) throw new Error(`Backend is not configured: ${kind}`)
    return backend
  }

  async close(): Promise<void> {
    await Promise.all(this.backends.map((backend) => backend.close()))
  }

  onEvent(listener: (event: unknown) => void): void {
    for (const backend of this.backends) backend.onEvent?.(listener)
  }

  async toolResult(kind: BackendKind, result: { id: string; ok: boolean; result?: unknown; error?: { code: string; message: string } }): Promise<void> {
    const backend = this.select(kind)
    if (!backend?.toolResult) throw new Error('No backend accepts tool results')
    await backend.toolResult(result)
  }
}
