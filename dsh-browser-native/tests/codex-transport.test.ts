import { describe, expect, it } from 'vitest'
import { CodexAppServerTransport } from '../src/native-host/codex-transport.js'
import { type SocketLike } from '../src/native-host/dsh-transport.js'

class Socket implements SocketLike {
  readyState = 0; sent: string[] = []; private listeners = new Map<string, ((event: { data?: unknown }) => void)[]>()
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: { data?: unknown }) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]) }
  send(data: string): void { this.sent.push(data) }
  close(): void { this.readyState = 3 }
  open(): void { this.readyState = 1; for (const listener of this.listeners.get('open') ?? []) listener({}) }
  reply(value: unknown): void { for (const listener of this.listeners.get('message') ?? []) listener({ data: JSON.stringify(value) }) }
}

describe('CodexAppServerTransport', () => {
  it('sends JSON-RPC requests and resolves responses', async () => {
    const socket = new Socket(); const transport = new CodexAppServerTransport('ws://127.0.0.1:9000', () => socket)
    const connecting = transport.connect(); socket.open(); await connecting
    const request = transport.request('capability.call', { capability: 'cdp' }, new AbortController().signal)
    await Promise.resolve(); const frame = JSON.parse(socket.sent[0]!) as { id: string }
    socket.reply({ jsonrpc: '2.0', id: frame.id, result: { ok: true } })
    await expect(request).resolves.toEqual({ ok: true })
  })
})
