import { describe, expect, it, vi } from 'vitest'
import { CapabilityRegistry } from '../src/shared/capability-registry.js'
import { registerPageAssetsCapability } from '../src/shared/page-assets-capability.js'
import { registerBotDetectionCapability } from '../src/shared/bot-detection-capability.js'

describe('page assets and bot detection capabilities', () => {
  it('lists and bundles page assets for the selected tab', async () => {
    const list = vi.fn(async () => ({ assets: [] }))
    const bundle = vi.fn(async () => ({ path: 'bundle.zip' }))
    const registry = new CapabilityRegistry()
    registerPageAssetsCapability(registry, { list, bundle })
    const context = { sessionId: 's', tabId: 4, signal: new AbortController().signal }
    expect(await registry.call('pageAssets', 'list', context, {})).toEqual({ assets: [] })
    await registry.call('pageAssets', 'bundle', context, { assetIds: ['a'], kinds: ['image'] })
    expect(bundle).toHaveBeenCalledWith(4, ['a'], ['image'], context.signal)
  })

  it('validates bot detection reasons', async () => {
    const report = vi.fn(async () => ({ status: 'reported' }))
    const registry = new CapabilityRegistry()
    registerBotDetectionCapability(registry, { report })
    const context = { sessionId: 's', tabId: 4, signal: new AbortController().signal }
    await registry.call('botDetection', 'report', context, { reason: 'challenge_loop' })
    expect(report).toHaveBeenCalledWith(4, 'challenge_loop', context.signal)
    await expect(registry.call('botDetection', 'report', context, { reason: 'anything' })).rejects.toThrow('unsupported')
  })
})
