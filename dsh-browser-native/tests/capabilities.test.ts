import { describe, expect, it } from 'vitest'
import { CapabilityRegistry } from '../src/shared/capability-registry.js'
import { registerBasicCapabilities } from '../src/shared/basic-capabilities.js'
import type { BrowserApi } from '../src/shared/browser-api.js'

function fakeBrowser(): BrowserApi {
  return {
    getWindows: async () => [{ id: 1, focused: true }], updateWindow: async () => ({ id: 1, focused: true }),
    getTabs: async () => [{ id: 2, windowId: 1, active: true }], updateTab: async () => ({ id: 2, windowId: 1, active: true }),
    removeTabs: async () => {}, getViewport: async () => ({ width: 1280, height: 800 }), setViewport: async () => {},
    isVisible: async () => false, setVisible: async () => {},
  }
}

describe('basic capabilities', () => {
  it('registers and executes management, viewport and visibility methods', async () => {
    const registry = new CapabilityRegistry()
    registerBasicCapabilities(registry, fakeBrowser())
    const context = { sessionId: 's', signal: new AbortController().signal, tabId: 2 }
    expect(await registry.call('management', 'tabs.list', context, {})).toEqual([{ id: 2, windowId: 1, active: true }])
    expect(await registry.call('viewport', 'set', context, { width: 1024, height: 768 })).toEqual({ width: 1024, height: 768 })
    expect(await registry.call('visibility', 'get', context, {})).toEqual({ visible: false })
  })

  it('rejects unsafe viewport dimensions and unknown methods', async () => {
    const registry = new CapabilityRegistry(); registerBasicCapabilities(registry, fakeBrowser())
    const context = { sessionId: 's', signal: new AbortController().signal, tabId: 2 }
    await expect(registry.call('viewport', 'set', context, { width: 10, height: 10 })).rejects.toThrow('outside')
    await expect(registry.call('management', 'bookmarks.delete', context, {})).rejects.toThrow('Unsupported')
  })
})
