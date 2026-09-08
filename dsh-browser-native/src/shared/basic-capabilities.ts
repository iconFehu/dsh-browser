import type { CapabilityRegistry } from './capability-registry.js'
import type { BrowserApi } from './browser-api.js'

function recordArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Capability arguments must be an object')
  return args as Record<string, unknown>
}

function integerArg(args: Record<string, unknown>, name: string): number {
  const value = args[name]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
  return value
}

export function registerBasicCapabilities(registry: CapabilityRegistry, browser: BrowserApi): void {
  registry.register('management', 'windows.list', async () => browser.getWindows())
  registry.register('management', 'tabs.list', async (_context, _method, raw) => {
    const args = recordArgs(raw)
    const windowId = args.windowId === undefined ? undefined : integerArg(args, 'windowId')
    return browser.getTabs({ windowId, active: args.active === true })
  })
  registry.register('management', 'tabs.activate', async (_context, _method, raw) => {
    const tabId = integerArg(recordArgs(raw), 'tabId')
    return browser.updateTab(tabId, { active: true })
  })
  registry.register('management', 'tabs.close', async (_context, _method, raw) => {
    const args = recordArgs(raw)
    const ids = args.tabIds
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === 'number' && Number.isSafeInteger(id) && id >= 0)) throw new Error('tabIds must be a non-empty integer array')
    await browser.removeTabs(ids)
    return { closed: ids.length }
  })
  registry.register('viewport', 'get', async (context) => {
    if (context.tabId === undefined) throw new Error('viewport.get requires a tab')
    return browser.getViewport(context.tabId)
  })
  registry.register('viewport', 'set', async (context, _method, raw) => {
    if (context.tabId === undefined) throw new Error('viewport.set requires a tab')
    const args = recordArgs(raw)
    const width = integerArg(args, 'width')
    const height = integerArg(args, 'height')
    if (width < 320 || width > 10000 || height < 240 || height > 10000) throw new Error('viewport dimensions are outside the supported range')
    await browser.setViewport(context.tabId, { width, height })
    return { width, height }
  })
  registry.register('viewport', 'reset', async (context) => {
    if (context.tabId === undefined) throw new Error('viewport.reset requires a tab')
    await browser.setViewport(context.tabId, undefined)
    return { reset: true }
  })
  registry.register('visibility', 'get', async () => ({ visible: await browser.isVisible() }))
  registry.register('visibility', 'set', async (_context, _method, raw) => {
    const visible = recordArgs(raw).visible
    if (typeof visible !== 'boolean') throw new Error('visible must be boolean')
    await browser.setVisible(visible)
    return { visible }
  })
}
