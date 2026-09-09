export interface NativeHostPort {
  onMessage: { addListener(listener: (message: unknown) => void): void }
  onDisconnect: { addListener(listener: () => void): void }
  postMessage(message: unknown): void
  disconnect(): void
}

export class NativeClient {
  private port: NativeHostPort | undefined
  private nextId = 0
  private pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>()
  private eventListeners = new Set<(event: unknown) => void>()
  private connected = false

  get isConnected(): boolean { return this.connected }

  onEvent(listener: (event: unknown) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  connect(): void {
    this.port = chrome.runtime.connectNative('com.dsh.browser.native') as unknown as NativeHostPort
    this.port.onMessage.addListener((message) => this.handleMessage(message))
    this.port.onDisconnect.addListener(() => {
      this.connected = false
      for (const pending of this.pending.values()) pending.reject(new Error('Native host disconnected'))
      this.pending.clear()
      this.port = undefined
    })
    this.port.postMessage({ type: 'hello', protocolVersion: 1, extensionId: chrome.runtime.id })
  }

  call(capability: string, method: string, args: unknown, sessionId: string, deadline = Date.now() + 30_000): Promise<unknown> {
    if (!this.port) this.connect()
    const id = String(++this.nextId)
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.port?.postMessage({ type: 'capability.call', id, sessionId, capability, method, args, deadline })
    })
  }

  cancel(id: string): void { this.port?.postMessage({ type: 'capability.cancel', id }) }

  sendToolResult(id: string, result: { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } }): void {
    this.port?.postMessage({ type: 'capability.result', id, ...result })
  }

  private handleMessage(message: unknown): void {
    if (!message || typeof message !== 'object' || !('type' in message)) return
    const frame = message as { type: string; id?: string; ok?: boolean; value?: unknown; error?: { message?: string } }
    if (frame.type === 'hello.ok') {
      this.connected = true
      return
    }
    if (frame.type === 'event' && 'event' in frame) {
      for (const listener of this.eventListeners) listener((frame as unknown as { event: unknown }).event)
      return
    }
    if (frame.type !== 'result' || frame.id === undefined) return
    const pending = this.pending.get(frame.id)
    if (!pending) return
    this.pending.delete(frame.id)
    frame.ok === true ? pending.resolve(frame.value) : pending.reject(new Error(frame.error?.message ?? 'Native host request failed'))
  }
}
