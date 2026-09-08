import type { JsonRpcTransport } from './adapters.js'
import type { SocketFactory, SocketLike } from './dsh-transport.js'

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }

/** JSON-RPC transport for the standalone Codex App Server. */
export class CodexAppServerTransport implements JsonRpcTransport {
  private socket: SocketLike | undefined
  private sequence = 0
  private readonly pending = new Map<string, Pending>()
  private readonly listeners = new Set<(event: unknown) => void>()

  constructor(private readonly url: string, private readonly createSocket: SocketFactory, private readonly timeoutMs = 30_000) {}

  async connect(): Promise<void> {
    if (this.socket?.readyState === 1) return
    const socket = this.createSocket(this.url); this.socket = socket
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Codex App Server connection timed out')), this.timeoutMs)
      socket.addEventListener('open', () => { clearTimeout(timer); resolve() })
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Codex App Server connection failed')) })
      socket.addEventListener('message', (event) => this.handle(event.data))
      socket.addEventListener('close', () => this.fail(new Error('Codex App Server disconnected')))
    })
  }

  async request(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    await this.connect()
    if (!this.socket || this.socket.readyState !== 1) throw new Error('Codex App Server is not connected')
    const id = `codex-${++this.sequence}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex request timed out: ${method}`)) }, this.timeoutMs)
      const abort = () => { clearTimeout(timer); this.pending.delete(id); reject(new Error('Codex request cancelled')); void this.notify('$/cancelRequest', { id }) }
      if (signal.aborted) return abort()
      signal.addEventListener('abort', abort, { once: true })
      this.pending.set(id, { resolve, reject, timer })
      this.socket!.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }

  async notify(method: string, params: unknown): Promise<void> { await this.connect(); this.socket?.send(JSON.stringify({ jsonrpc: '2.0', method, params })) }
  async close(): Promise<void> { this.socket?.close(); this.socket = undefined; this.fail(new Error('Codex App Server closed')) }
  onEvent(listener: (event: unknown) => void): void { this.listeners.add(listener) }
  async toolResult(result: { id: string; ok: boolean; result?: unknown; error?: { code: string; message: string } }): Promise<void> { await this.notify('browser.tool.result', result) }

  private handle(raw: unknown): void {
    let value: unknown; try { value = JSON.parse(String(raw)) } catch { return }
    if (!value || typeof value !== 'object') return
    const frame = value as Record<string, unknown>
    if (frame.id !== undefined && typeof frame.id === 'string') {
      const pending = this.pending.get(frame.id); if (!pending) return
      clearTimeout(pending.timer); this.pending.delete(frame.id)
      if ('error' in frame) pending.reject(new Error(typeof frame.error === 'object' && frame.error && 'message' in frame.error ? String((frame.error as { message: unknown }).message) : 'Codex request failed'))
      else pending.resolve(frame.result)
      return
    }
    for (const listener of this.listeners) listener(frame)
  }

  private fail(error: Error): void { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }; this.pending.clear() }
}
