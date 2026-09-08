import type { JsonRpcTransport } from './adapters.js'

export interface SocketLike {
  readonly readyState: number
  send(data: string): void
  close(): void
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: { data?: unknown }) => void): void
}

export type SocketFactory = (url: string) => SocketLike

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }

export class DshBridgeTransport implements JsonRpcTransport {
  private socket: SocketLike | undefined
  private sequence = 0
  private readonly pending = new Map<string, Pending>()
  private readonly eventListeners = new Set<(event: unknown) => void>()

  constructor(private readonly url: string, private readonly token: string, private readonly createSocket: SocketFactory, private readonly timeoutMs = 30_000) {}

  async connect(): Promise<void> {
    if (this.socket?.readyState === 1) return
    const socket = this.createSocket(this.url)
    this.socket = socket
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('DSH Bridge connection timed out')), this.timeoutMs)
      socket.addEventListener('open', () => { clearTimeout(timer); socket.send(JSON.stringify({ t: 'hello', token: this.token, caps: { textOnly: true } })); resolve() })
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('DSH Bridge connection failed')) })
      socket.addEventListener('message', (event) => this.handleMessage(event.data))
      socket.addEventListener('close', () => this.failPending(new Error('DSH Bridge disconnected')))
    })
  }

  async request(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    await this.connect()
    if (!this.socket || this.socket.readyState !== 1) throw new Error('DSH Bridge is not connected')
    const id = `dsh-${++this.sequence}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`DSH request timed out: ${method}`)) }, this.timeoutMs)
      const abort = () => { clearTimeout(timer); this.pending.delete(id); reject(new Error('DSH request cancelled')); void this.notify('browser.capability.cancel', { requestId: id }) }
      if (signal.aborted) return abort()
      signal.addEventListener('abort', abort, { once: true })
      this.pending.set(id, { resolve, reject, timer })
      this.socket!.send(JSON.stringify({ t: 'rpc', id, method, payload: params }))
    })
  }

  async notify(method: string, params: unknown): Promise<void> {
    await this.connect()
    this.socket?.send(JSON.stringify({ t: 'rpc', id: `notify-${++this.sequence}`, method, payload: params }))
  }

  async toolResult(result: { id: string; ok: boolean; result?: unknown; error?: { code: string; message: string } }): Promise<void> {
    await this.connect()
    this.socket?.send(JSON.stringify({ t: 'tool.result', ...result }))
  }

  async close(): Promise<void> { this.socket?.close(); this.socket = undefined; this.failPending(new Error('DSH Bridge closed')) }

  onEvent(listener: (event: unknown) => void): void { this.eventListeners.add(listener) }

  private handleMessage(raw: unknown): void {
    let frame: unknown
    try { frame = JSON.parse(String(raw)) } catch { return }
    if (!frame || typeof frame !== 'object') return
    const value = frame as Record<string, unknown>
    if (value.t === 'tool.call' || value.t === 'tool.cancel' || value.t === 'event') {
      for (const listener of this.eventListeners) listener(value)
      return
    }
    if (value.t !== 'rpc.result' || typeof value.id !== 'string') return
    const pending = this.pending.get(value.id)
    if (!pending) return
    clearTimeout(pending.timer); this.pending.delete(value.id)
    value.ok === true ? pending.resolve(value.result) : pending.reject(new Error(typeof value.error === 'object' && value.error && 'message' in value.error ? String((value.error as { message: unknown }).message) : 'DSH request failed'))
  }

  private failPending(error: Error): void { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }; this.pending.clear() }
}
