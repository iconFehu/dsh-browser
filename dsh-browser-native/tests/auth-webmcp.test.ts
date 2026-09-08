import { describe, expect, it, vi } from 'vitest'
import { CapabilityRegistry } from '../src/shared/capability-registry.js'
import { registerBrowserAuthCapability } from '../src/shared/browser-auth-capability.js'
import { registerWebMcpCapability } from '../src/shared/webmcp-capability.js'

describe('browserAuth and webmcp capabilities', () => {
  it('passes auth metadata without accepting malformed fields', async () => {
    const request = vi.fn(async () => ({ status: 'submitted' }))
    const registry = new CapabilityRegistry(); registerBrowserAuthCapability(registry, { request })
    const context = { sessionId: 's', tabId: 5, signal: new AbortController().signal }
    await registry.call('browserAuth', 'request', context, { origin: 'https://example.test', fields: [{ id: 'user', label: 'User', type: 'text', selector: '#user', required: true }] })
    expect(request).toHaveBeenCalledWith(5, expect.objectContaining({ origin: 'https://example.test' }), context.signal)
    await expect(registry.call('browserAuth', 'request', context, { origin: 'file:///secret', fields: [] })).rejects.toThrow()
  })

  it('discovers and calls only a validated WebMCP descriptor', async () => {
    const call = vi.fn(async () => ({ ok: true }))
    const registry = new CapabilityRegistry(); registerWebMcpCapability(registry, { fetchTools: async () => [], call })
    const context = { sessionId: 's', tabId: 5, signal: new AbortController().signal }
    await registry.call('webmcp', 'call', context, { tool: { name: 'search', origin: 'https://example.test', registrationId: 'r1' }, input: { q: 'x' } })
    expect(call).toHaveBeenCalledWith(5, expect.objectContaining({ name: 'search', registrationId: 'r1' }), { q: 'x' }, context.signal)
    await expect(registry.call('webmcp', 'call', context, { tool: { name: 'bad', origin: 'file:///x', registrationId: 'r1' } })).rejects.toThrow('http')
  })
})
