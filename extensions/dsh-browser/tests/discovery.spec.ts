// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { discoverLocalBridge, inspectBridge, localCandidate, safeAddress } from '../src/background/discovery.ts'

const response = (port: number) => new Response(JSON.stringify({ wsUrl: `ws://127.0.0.1:${port}/ext/bridge` }))
describe('Desktop discovery', () => {
  it('prefers the last authenticated Desktop over default Desktop and web, with four requests maximum', async () => {
    let inflight = 0
    let peak = 0
    const request = vi.fn<typeof fetch>(async input => {
      peak = Math.max(peak, ++inflight)
      await Promise.resolve()
      inflight--
      return response(Number(new URL(String(input)).port))
    })
    expect(await discoverLocalBridge('ws://127.0.0.1:43125/ext/bridge', () => true, request))
      .toEqual({ code: 'connected', address: 'ws://127.0.0.1:43125/ext/bridge' })
    expect(peak).toBeLessThanOrEqual(4)
    expect(request.mock.calls.every(([url]) => Number(new URL(String(url)).port) >= 43120)).toBe(true)
  })
  it('finds a collision fallback and never scans arbitrary ports', async () => {
    const request = vi.fn<typeof fetch>(async input => {
      const port = Number(new URL(String(input)).port)
      if (port === 43152) return response(port)
      throw new Error('offline')
    })
    expect((await discoverLocalBridge(undefined, () => true, request)).address).toContain(':43152/')
    expect(request.mock.calls.length).toBeLessThanOrEqual(38)
  })
  it('falls back to web only after Desktop candidates fail, and rediscovers after a restart', async () => {
    let port = 3080
    const request = vi.fn<typeof fetch>(async input => {
      if (Number(new URL(String(input)).port) === port) return response(port)
      throw new Error('offline')
    })
    expect((await discoverLocalBridge(undefined, () => true, request)).address).toContain(':3080/')
    port = 43121
    expect((await discoverLocalBridge(undefined, () => true, request)).address).toContain(':43121/')
  })
  it.each([[403, 'forbidden'], [404, 'missing-bridge'], [401, 'authentication']] as const)('reports HTTP %i explicitly', async (status, code) => {
    const request = vi.fn<typeof fetch>(async () => new Response('', { status }))
    expect((await inspectBridge('ws://127.0.0.1:43120/ext/bridge', request)).code).toBe(code)
  })
  it('does not accept redirect, cross-port, remote, query-token or malformed discoveries', async () => {
    for (const value of ['ws://evil.test:43120/ext/bridge', 'ws://127.0.0.1:43120/ext/bridge?token=secret', 'ws://user:pass@127.0.0.1:43120/ext/bridge', 'garbage']) {
      expect(localCandidate(value)).toBeUndefined()
    }
    expect((await inspectBridge('ws://127.0.0.1:43120/ext/bridge', async () => response(3080))).code).toBe('invalid-response')
    expect((await inspectBridge('ws://127.0.0.1:43120/ext/bridge', async () => new Response('bad json'))).code).toBe('invalid-response')
  })
  it('stops after panel cancellation and exports no credentials', async () => {
    let active = true
    const request = vi.fn<typeof fetch>(async () => { active = false; return response(43120) })
    expect((await discoverLocalBridge(undefined, () => active, request)).code).toBe('not-found')
    expect(request.mock.calls.length).toBe(4)
    expect(safeAddress('ws://user:secret@127.0.0.1:43120/ext/bridge?token=secret#secret')).toBe('ws://127.0.0.1:43120/ext/bridge')
  })
})
