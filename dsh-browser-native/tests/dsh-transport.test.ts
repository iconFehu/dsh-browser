import { describe, expect, it } from 'vitest'
import { DshBridgeTransport, type SocketLike } from '../src/native-host/dsh-transport.js'

class FakeSocket implements SocketLike {
  readyState = 0
  sent: string[] = []
  private listeners = new Map<string, ((event: { data?: unknown }) => void)[]>()
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: { data?: unknown }) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]) }
  send(data: string): void { this.sent.push(data) }
  close(): void { this.readyState = 3; for (const listener of this.listeners.get('close') ?? []) listener({}) }
  open(): void { this.readyState = 1; for (const listener of this.listeners.get('open') ?? []) listener({}) }
  reply(value: unknown): void { for (const listener of this.listeners.get('message') ?? []) listener({ data: JSON.stringify(value) }) }
}

describe('DshBridgeTransport', () => {
  it('performs hello and resolves RPC results', async () => {
    const socket = new FakeSocket()
    const transport = new DshBridgeTransport('ws://127.0.0.1/ext/bridge', 'token', () => socket)
    const connecting = transport.connect(); socket.open(); await connecting
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({ t: 'hello', token: 'token' })
    const request = transport.request('rpc', { x: 1 }, new AbortController().signal)
    await Promise.resolve()
    const frame = JSON.parse(socket.sent[1]!) as { id: string }
    socket.reply({ t: 'rpc.result', id: frame.id, ok: true, result: { ok: true } })
    await expect(request).resolves.toEqual({ ok: true })
  })

  it('emits tool calls and writes tool results back to the bridge', async () => {
    const socket = new FakeSocket()
    const transport = new DshBridgeTransport('ws://127.0.0.1/ext/bridge', 'token', () => socket)
    const events: unknown[] = []
    transport.onEvent((event) => events.push(event))
    const connecting = transport.connect(); socket.open(); await connecting
    socket.reply({ t: 'capability.call', id: 'call-1', capability: 'pageAssets', method: 'snapshot', args: {}, expiresAt: Date.now() + 1000 })
    expect(events).toEqual([expect.objectContaining({ t: 'capability.call', id: 'call-1', capability: 'pageAssets', method: 'snapshot' })])
    await transport.toolResult?.({ id: 'call-1', ok: true, result: { text: 'ok' } })
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ t: 'capability.result', id: 'call-1', ok: true, result: { text: 'ok' } })
  })
})
