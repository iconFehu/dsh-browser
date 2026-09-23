import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { BROWSER_TAB_REFS_METHOD, browserTabsRequestAllowed, createBrowserTabsRoute } from '../src/browser-tabs-route.ts'

function request(headers: Record<string, string>, remoteAddress = '127.0.0.1'): IncomingMessage {
  return { headers, socket: { remoteAddress } } as unknown as IncomingMessage
}

function response() {
  const res = { status: 0, body: '', writeHead: vi.fn((status: number) => { res.status = status }), end: vi.fn((body: string) => { res.body = body }) }
  return res
}

const sameOrigin = { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' }

describe('browser tabs route', () => {
  it('accepts only the loopback same-origin Web UI', () => {
    expect(browserTabsRequestAllowed(request(sameOrigin))).toBe(true)
    expect(browserTabsRequestAllowed(request({ ...sameOrigin, host: 'localhost:3080' }))).toBe(true)
    expect(browserTabsRequestAllowed(request(sameOrigin, '::1'))).toBe(true)
  })

  it('rejects non-loopback peers, cross-site pages, missing fetch metadata, and rebinding hosts', () => {
    expect(browserTabsRequestAllowed(request(sameOrigin, '192.168.1.20'))).toBe(false)
    expect(browserTabsRequestAllowed(request({ ...sameOrigin, 'sec-fetch-site': 'cross-site' }))).toBe(false)
    expect(browserTabsRequestAllowed(request({ ...sameOrigin, 'sec-fetch-site': 'same-site' }))).toBe(false)
    expect(browserTabsRequestAllowed(request({ host: '127.0.0.1:3080' }))).toBe(false)
    expect(browserTabsRequestAllowed(request({ ...sameOrigin, host: 'attacker.example:3080' }))).toBe(false)
    expect(browserTabsRequestAllowed(request({ 'sec-fetch-site': 'same-origin' }))).toBe(false)
  })

  it('answers 403 without asking the extension when the guard fails', async () => {
    const requestTool = vi.fn()
    const route = createBrowserTabsRoute({ requestTool }, 1000)
    const res = response()
    await route.handler(request({ host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' }), res as unknown as ServerResponse)
    expect(res.status).toBe(403)
    expect(requestTool).not.toHaveBeenCalled()
  })

  it('returns the extension tab refs for the Web UI', async () => {
    const refs = [{ ref: 'tab-v1-1-7', windowId: 1, title: 'Docs', url: 'https://example.com/', updatedAt: 1 }]
    const requestTool = vi.fn(async () => ({ text: JSON.stringify(refs) }))
    const route = createBrowserTabsRoute({ requestTool }, 1000)
    const res = response()
    await route.handler(request(sameOrigin), res as unknown as ServerResponse)
    expect(requestTool).toHaveBeenCalledWith(BROWSER_TAB_REFS_METHOD, {}, expect.any(AbortSignal), 1000)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual(refs)
  })

  it('reports an unavailable extension as 503', async () => {
    const route = createBrowserTabsRoute({ requestTool: vi.fn(async () => { throw new Error('no browser extension is connected') }) }, 1000)
    const res = response()
    await route.handler(request(sameOrigin), res as unknown as ServerResponse)
    expect(res.status).toBe(503)
  })
})
