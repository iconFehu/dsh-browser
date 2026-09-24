import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { BridgeServer } from '../src/server.ts'
import { BROWSER_TOOL_NAMES, registerBrowserTools } from '../src/tools.ts'

describe('registerBrowserTools', () => {
  function harness() {
    const registered: { name: string; definition: Record<string, unknown> }[] = []
    const ctx = { tools: { register: vi.fn((definition: { name: string }) => { registered.push({ name: definition.name, definition: definition as Record<string, unknown> }); return () => {} }) } } as unknown as Context
    const requestTool = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({ text: 'ok' }))
    return { ctx, registered, requestTool, bridge: { requestTool } as unknown as BridgeServer }
  }

  it('registers exactly the seven high-level capabilities and keeps WebMCP internal', () => {
    const { ctx, registered } = harness()
    const disposers = registerBrowserTools(ctx, {} as BridgeServer, { toolTimeoutMs: 1000, snapshotMaxChars: 12000, maxInteractiveItems: 60 })
    expect(registered.map(({ name }) => name)).toEqual([...BROWSER_TOOL_NAMES])
    expect(disposers.size).toBe(7)
    expect(registered.map(({ name }) => name)).not.toContain('webmcp')
  })

  it('unwraps a high-level call into capability method and args', async () => {
    const { ctx, registered, requestTool, bridge } = harness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1000, snapshotMaxChars: 12000, maxInteractiveItems: 60 })
    const tool = registered.find(({ name }) => name === 'management')!.definition
    const signal = new AbortController().signal
    await (tool.execute as (args: unknown, exec: unknown) => Promise<unknown>)({ namespace: 'tabs', method: 'list', args: { active: true } }, { signal })
    expect(requestTool).toHaveBeenCalledWith('management', { method: 'tabs.list', args: { active: true } }, signal, 1000)
  })

  it('associates calls with the owning Agent session', async () => {
    const { ctx, registered, requestTool, bridge } = harness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1000, snapshotMaxChars: 12000, maxInteractiveItems: 60 })
    const tool = registered.find(({ name }) => name === 'pageAssets')!.definition
    const exec = { signal: new AbortController().signal, agent: { id: 'session-browser' } }
    await (tool.execute as (args: unknown, exec: typeof exec) => Promise<unknown>)({ method: 'list', args: {} }, exec)
    expect(requestTool).toHaveBeenCalledWith('pageAssets', { method: 'list', args: {} }, exec.signal, 1000, 'session-browser')
  })

  it('uses a JSON object schema and common timeout for every capability', () => {
    const { ctx, registered } = harness()
    registerBrowserTools(ctx, {} as BridgeServer, { toolTimeoutMs: 5000, snapshotMaxChars: 12000, maxInteractiveItems: 60 })
    for (const { definition } of registered) {
      expect(definition.timeoutMs).toBe(5000)
      expect((definition.parameters as { type: string }).type).toBe('object')
    }
  })

  it('requires a known management namespace and method', async () => {
    const { ctx, registered, bridge } = harness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1000, snapshotMaxChars: 12000, maxInteractiveItems: 60 })
    const tool = registered.find(({ name }) => name === 'management')!.definition
    const exec = { signal: new AbortController().signal }
    await expect((tool.execute as (args: unknown, exec: unknown) => Promise<unknown>)({ method: 'list', args: {} }, exec)).rejects.toThrow('invalid arguments')
    await expect((tool.execute as (args: unknown, exec: unknown) => Promise<unknown>)({ namespace: 'tabs', method: 'open_tab', args: {} }, exec)).rejects.toThrow('invalid arguments')
  })

  it('exposes management namespace and method enums to the model', () => {
    const { ctx, registered, bridge } = harness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1000, snapshotMaxChars: 12000, maxInteractiveItems: 60 })
    const parameters = registered.find(({ name }) => name === 'management')!.definition.parameters as { properties: { namespace: { enum: string[] }; method: { enum: string[] }; args: { properties: Record<string, unknown> } } }
    expect(parameters.properties.namespace.enum).toEqual(['windows', 'tabs', 'tabGroups', 'bookmarks', 'history', 'downloads', 'events'])
    expect(parameters.properties.method.enum).toEqual(['list', 'open', 'navigate', 'activate', 'update', 'reload', 'close', 'click', 'type', 'press', 'scroll', 'wait', 'back', 'forward', 'create', 'ungroup', 'search', 'delete', 'cancel', 'events'])
    expect(Object.keys(parameters.properties.args.properties)).toEqual(['url', 'tabId', 'tabIds', 'windowId', 'active', 'index', 'frame', 'text', 'replace', 'key', 'direction', 'amount', 'ms', 'groupId', 'title', 'color', 'collapsed', 'query', 'id', 'parentId', 'startTime', 'endTime', 'maxResults', 'state', 'limit', 'afterSequence', 'waitMs'])
  })

  it('validates method-specific management arguments before dispatch', async () => {
    const { ctx, registered, bridge, requestTool } = harness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1000, snapshotMaxChars: 12000, maxInteractiveItems: 60 })
    const tool = registered.find(({ name }) => name === 'management')!.definition
    const exec = { signal: new AbortController().signal }
    await expect((tool.execute as (args: unknown, exec: unknown) => Promise<unknown>)({ namespace: 'tabs', method: 'open', args: {} }, exec)).rejects.toThrow('requires a valid http(s) url')
    expect(requestTool).not.toHaveBeenCalled()
  })

  it('exposes native argument schemas for non-management capabilities', () => {
    const { ctx, registered, bridge } = harness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1000, snapshotMaxChars: 12000, maxInteractiveItems: 60 })
    const cdp = registered.find(({ name }) => name === 'cdp')!.definition.parameters as { properties: { args: { properties: Record<string, unknown> } } }
    const pageAssets = registered.find(({ name }) => name === 'pageAssets')!.definition.parameters as { properties: { args: { properties: Record<string, unknown> } } }
    expect(Object.keys(cdp.properties.args.properties)).toEqual(['method', 'params', 'afterSequence'])
    expect(Object.keys(cdp.properties)).toEqual(['method', 'args'])
    expect(Object.keys(pageAssets.properties.args.properties)).toEqual(['delta', 'region', 'selector', 'frame', 'inventoryId', 'assetIds', 'kinds'])
    expect(Object.keys(pageAssets.properties)).not.toContain('namespace')
  })

  it('lists allowed CDP methods while allowing events without a CDP method', async () => {
    const { ctx, registered, bridge, requestTool } = harness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1000, snapshotMaxChars: 12000, maxInteractiveItems: 60 })
    const cdp = registered.find(({ name }) => name === 'cdp')!.definition
    const args = (cdp.parameters as { properties: { args: { properties: { method: { enum: string[] } }; required?: string[] } } }).properties.args
    expect(args.properties.method.enum).toEqual([
      'Accessibility.getFullAXTree', 'DOM.getDocument', 'DOM.getOuterHTML',
      'Network.enable', 'Network.disable', 'Performance.enable', 'Performance.disable', 'Performance.getMetrics',
      'Page.captureScreenshot', 'Page.printToPDF',
    ])
    expect(args.required ?? []).not.toContain('method')
    const exec = { signal: new AbortController().signal }
    await (cdp.execute as (args: unknown, exec: unknown) => Promise<unknown>)({ method: 'events', args: { afterSequence: 0 } }, exec)
    expect(requestTool).toHaveBeenCalledWith('cdp', { method: 'events', args: { afterSequence: 0 } }, exec.signal, 1000)
  })

  it('ignores a duplicated cdp namespace instead of prefixing the wire method', async () => {
    const { ctx, registered, bridge, requestTool } = harness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1000, snapshotMaxChars: 12000, maxInteractiveItems: 60 })
    const cdp = registered.find(({ name }) => name === 'cdp')!.definition
    const exec = { signal: new AbortController().signal }
    await (cdp.execute as (args: unknown, exec: unknown) => Promise<unknown>)({ namespace: 'cdp', method: 'call', args: { method: 'Network.enable' } }, exec)
    expect(requestTool).toHaveBeenCalledWith('cdp', { method: 'call', args: { method: 'Network.enable' } }, exec.signal, 1000)
  })

  it('routes page reads and page actions to the extension method names', async () => {
    const { ctx, registered, bridge, requestTool } = harness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1000, snapshotMaxChars: 12000, maxInteractiveItems: 60 })
    const run = (name: string) => registered.find((tool) => tool.name === name)!.definition.execute as (args: unknown, exec: unknown) => Promise<unknown>
    const exec = { signal: new AbortController().signal }
    await run('pageAssets')({ method: 'snapshot', args: { delta: true } }, exec)
    await run('management')({ namespace: 'tabs', method: 'click', args: { index: 3, frame: 1 } }, exec)
    await run('management')({ namespace: 'tabs', method: 'type', args: { index: 4, text: 'hi', replace: true } }, exec)
    await run('management')({ namespace: 'tabs', method: 'back', args: {} }, exec)
    expect(requestTool.mock.calls.map(([name, args]) => [name, args])).toEqual([
      ['pageAssets', { method: 'snapshot', args: { delta: true } }],
      ['management', { method: 'tabs.click', args: { index: 3, frame: 1 } }],
      ['management', { method: 'tabs.type', args: { index: 4, text: 'hi', replace: true } }],
      ['management', { method: 'tabs.back', args: {} }],
    ])
  })

  it('rejects malformed page actions before dispatch', async () => {
    const { ctx, registered, bridge, requestTool } = harness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1000, snapshotMaxChars: 12000, maxInteractiveItems: 60 })
    const management = registered.find(({ name }) => name === 'management')!.definition.execute as (args: unknown, exec: unknown) => Promise<unknown>
    const exec = { signal: new AbortController().signal }
    await expect(management({ namespace: 'tabs', method: 'click', args: {} }, exec)).rejects.toThrow('non-negative integer index')
    await expect(management({ namespace: 'tabs', method: 'type', args: { index: 1 } }, exec)).rejects.toThrow('requires text')
    await expect(management({ namespace: 'tabs', method: 'press', args: {} }, exec)).rejects.toThrow('requires a key')
    await expect(management({ namespace: 'tabs', method: 'scroll', args: { direction: 'left' } }, exec)).rejects.toThrow('direction')
    await expect(management({ namespace: 'tabs', method: 'wait', args: { ms: -1 } }, exec)).rejects.toThrow('wait ms')
    expect(requestTool).not.toHaveBeenCalled()
  })

  it('validates capability-specific arguments before dispatch', async () => {
    const { ctx, registered, bridge, requestTool } = harness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1000, snapshotMaxChars: 12000, maxInteractiveItems: 60 })
    const cdp = registered.find(({ name }) => name === 'cdp')!.definition
    const exec = { signal: new AbortController().signal }
    await expect((cdp.execute as (args: unknown, exec: unknown) => Promise<unknown>)({ method: 'call', args: { method: 'Page.navigate' } }, exec)).rejects.toThrow('invalid arguments')
    await expect((cdp.execute as (args: unknown, exec: unknown) => Promise<unknown>)({ method: 'call', args: {} }, exec)).rejects.toThrow('not allowlisted')
    expect(requestTool).not.toHaveBeenCalled()
  })

  it('describes the sign-in handoff without any credential value field', () => {
    const { ctx, registered, bridge } = harness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1000, snapshotMaxChars: 12000, maxInteractiveItems: 60 })
    const auth = registered.find(({ name }) => name === 'browserAuth')!.definition.parameters as { properties: { args: { properties: { fields: { items: { properties: Record<string, unknown> } } } & Record<string, unknown> } } }
    expect(Object.keys(auth.properties.args.properties)).toEqual(['origin', 'fields'])
    expect(Object.keys(auth.properties.args.properties.fields.items.properties)).toEqual(['id', 'label', 'type', 'required', 'selector'])
  })

  it('validates handoff, viewport, visibility, and bundle arguments before dispatch', async () => {
    const { ctx, registered, bridge, requestTool } = harness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1000, snapshotMaxChars: 12000, maxInteractiveItems: 60 })
    const run = (name: string) => registered.find((tool) => tool.name === name)!.definition.execute as (args: unknown, exec: unknown) => Promise<unknown>
    const exec = { signal: new AbortController().signal }
    await expect(run('browserAuth')({ method: 'request', args: { origin: 'javascript:alert(1)', fields: [{ id: 'u', label: 'User', type: 'text', required: true }] } }, exec)).rejects.toThrow('http(s) origin')
    await expect(run('browserAuth')({ method: 'request', args: { origin: 'https://example.com', fields: [] } }, exec)).rejects.toThrow('1-6 items')
    await expect(run('viewport')({ method: 'set', args: { width: 100, height: 800 } }, exec)).rejects.toThrow('width 320-10000')
    await expect(run('visibility')({ method: 'set', args: {} }, exec)).rejects.toThrow('boolean visible')
    await expect(run('pageAssets')({ method: 'bundle', args: { kinds: ['image'] } }, exec)).rejects.toThrow('inventoryId')
    expect(requestTool).not.toHaveBeenCalled()
    await run('visibility')({ method: 'get', args: {} }, exec)
    await run('viewport')({ method: 'set', args: { width: 390, height: 844 } }, exec)
    expect(requestTool.mock.calls.map(([name, args]) => [name, args])).toEqual([
      ['visibility', { method: 'get', args: {} }],
      ['viewport', { method: 'set', args: { width: 390, height: 844 } }],
    ])
  })
})
