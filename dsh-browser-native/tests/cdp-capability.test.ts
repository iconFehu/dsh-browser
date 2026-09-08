import { describe, expect, it, vi } from 'vitest'
import { CapabilityRegistry } from '../src/shared/capability-registry.js'
import { ALLOWED_CDP_METHODS, registerCdpCapability } from '../src/shared/cdp-capability.js'

describe('cdp capability', () => {
  it('allows observation methods and forwards tab/context', async () => {
    const send = vi.fn(async () => ({ ok: true }))
    const events = vi.fn(async () => ({ events: [] }))
    const registry = new CapabilityRegistry()
    registerCdpCapability(registry, { send, events })
    const context = { sessionId: 's', tabId: 7, signal: new AbortController().signal }
    await registry.call('cdp', 'call', context, { method: 'DOM.getDocument', params: { depth: 2 } })
    expect(send).toHaveBeenCalledWith(7, 'DOM.getDocument', { depth: 2 }, context.signal)
  })

  it('rejects script/navigation/cookie methods outside the allowlist', async () => {
    expect(ALLOWED_CDP_METHODS.has('Page.navigate')).toBe(false)
    const registry = new CapabilityRegistry()
    registerCdpCapability(registry, { send: async () => null, events: async () => null })
    await expect(registry.call('cdp', 'call', { sessionId: 's', tabId: 7, signal: new AbortController().signal }, { method: 'Page.navigate' })).rejects.toThrow('allowlisted')
  })
})
