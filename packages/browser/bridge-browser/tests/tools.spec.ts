import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { BridgeServer } from '../src/server.ts'
import { BROWSER_TOOL_NAMES, registerBrowserTools } from '../src/tools.ts'

describe('registerBrowserTools', () => {
  function makeHarness() {
    const registered: { name: string; definition: Record<string, unknown> }[] = []
    const ctx = {
      tools: {
        register: vi.fn((definition: { name: string }) => {
          registered.push({ name: definition.name, definition: definition as Record<string, unknown> })
          return () => {}
        }),
      },
    } as unknown as Context
    const requestTool = vi.fn(async (_name: string, _args: Record<string, unknown>, _signal: AbortSignal, _timeoutMs?: number): Promise<unknown> => {
      return { text: 'ok' }
    })
    const bridge = { requestTool } as unknown as BridgeServer
    return { ctx, bridge, requestTool, registered }
  }

  it('registers the full v1 tool set', () => {
    const { ctx, bridge, registered } = makeHarness()
    const disposers = registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    expect(registered.map((r) => r.name).sort()).toEqual([...BROWSER_TOOL_NAMES].sort())
    expect(disposers.size).toBe(BROWSER_TOOL_NAMES.length)
    for (const dispose of disposers.values()) dispose()
  })

  it('executes management.tabs.click with mapped args', async () => {
    const { ctx, bridge, requestTool, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const tool = registered.find((r) => r.name === 'management.tabs.click')!
    const exec = { signal: new AbortController().signal }
    const result = await (tool.definition.execute as (args: unknown, e: { signal: AbortSignal }) => Promise<unknown>)({ index: 3, frame: 7 }, exec)
    expect(requestTool).toHaveBeenCalledWith('management.tabs.click', { index: 3, frame: 7 }, exec.signal, 1_000)
    expect(result).toEqual({ text: 'ok' })
  })

  it('associates browser calls with the owning Agent session', async () => {
    const { ctx, bridge, requestTool, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const tool = registered.find((r) => r.name === 'management.tabs.click')!
    const exec = {
      signal: new AbortController().signal,
      agent: { id: 'session-browser' },
    }

    await (tool.definition.execute as (args: unknown, e: typeof exec) => Promise<unknown>)({ index: 3 }, exec)

    expect(requestTool).toHaveBeenCalledWith(
      'management.tabs.click',
      { index: 3 },
      exec.signal,
      1_000,
      'session-browser',
    )
  })

  it('normalizes snapshot args (delta/region omitted when absent)', async () => {
    const { ctx, bridge, requestTool, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const tool = registered.find((r) => r.name === 'pageAssets.snapshot')!
    const exec = { signal: new AbortController().signal }
    await (tool.definition.execute as (args: unknown, e: { signal: AbortSignal }) => Promise<unknown>)({ delta: true }, exec)
    expect(requestTool).toHaveBeenLastCalledWith('pageAssets.snapshot', { delta: true }, exec.signal, 1_000)
    await (tool.definition.execute as (args: unknown, e: { signal: AbortSignal }) => Promise<unknown>)({}, exec)
    expect(requestTool).toHaveBeenLastCalledWith('pageAssets.snapshot', {}, exec.signal, 1_000)
    await (tool.definition.execute as (args: unknown, e: { signal: AbortSignal }) => Promise<unknown>)({ delta: true, region: 'main' }, exec)
    expect(requestTool).toHaveBeenLastCalledWith('pageAssets.snapshot', { delta: true, region: 'main' }, exec.signal, 1_000)
  })

  it('executes every remaining tool with mapped args', async () => {
    const { ctx, bridge, requestTool, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const byName = new Map(registered.map((r) => [r.name, r.definition]))
    const exec = { signal: new AbortController().signal }
    const run = async (name: string, args: unknown): Promise<void> => {
      await (byName.get(name)!.execute as (a: unknown, e: { signal: AbortSignal }) => Promise<unknown>)(args, exec)
    }

    await run('management.tabs.type', { index: 2, text: 'hello' })
    expect(requestTool).toHaveBeenLastCalledWith('management.tabs.type', { index: 2, text: 'hello' }, exec.signal, 1_000)
    await run('management.tabs.type', { index: 2, text: 'hello', replace: true })
    expect(requestTool).toHaveBeenLastCalledWith('management.tabs.type', { index: 2, text: 'hello', replace: true }, exec.signal, 1_000)
    await run('management.tabs.type', { index: 2, frame: 4, text: 'inside frame' })
    expect(requestTool).toHaveBeenLastCalledWith('management.tabs.type', { index: 2, frame: 4, text: 'inside frame' }, exec.signal, 1_000)

    await run('management.tabs.press', { key: 'Enter' })
    expect(requestTool).toHaveBeenLastCalledWith('management.tabs.press', { key: 'Enter' }, exec.signal, 1_000)

    await run('management.tabs.scroll', { direction: 'down', amount: 200 })
    expect(requestTool).toHaveBeenLastCalledWith('management.tabs.scroll', { direction: 'down', amount: 200 }, exec.signal, 1_000)
    await run('management.tabs.scroll', { direction: 'top' })
    expect(requestTool).toHaveBeenLastCalledWith('management.tabs.scroll', { direction: 'top' }, exec.signal, 1_000)
    await run('management.tabs.scroll', { direction: 'down', frame: 4 })
    expect(requestTool).toHaveBeenLastCalledWith('management.tabs.scroll', { direction: 'down', frame: 4 }, exec.signal, 1_000)

    await run('management.tabs.navigate', { url: 'https://example.com' })
    expect(requestTool).toHaveBeenLastCalledWith('management.tabs.navigate', { url: 'https://example.com' }, exec.signal, 1_000)
    await run('management.tabs.open', { url: 'https://example.com/new' })
    expect(requestTool).toHaveBeenLastCalledWith('management.tabs.open', { url: 'https://example.com/new' }, exec.signal, 1_000)

    for (const name of ['management.tabs.back', 'management.tabs.forward', 'management.tabs.reload'] as const) {
      await run(name, {})
      expect(requestTool).toHaveBeenLastCalledWith(name, {}, exec.signal, 1_000)
    }

    await run('pageAssets.getText', { selector: '#main' })
    expect(requestTool).toHaveBeenLastCalledWith('pageAssets.getText', { selector: '#main' }, exec.signal, 1_000)
    await run('pageAssets.getText', {})
    expect(requestTool).toHaveBeenLastCalledWith('pageAssets.getText', {}, exec.signal, 1_000)
    await run('pageAssets.getText', { selector: 'main', frame: 4 })
    expect(requestTool).toHaveBeenLastCalledWith('pageAssets.getText', { selector: 'main', frame: 4 }, exec.signal, 1_000)

    await run('management.tabs.wait', { ms: 100 })
    expect(requestTool).toHaveBeenLastCalledWith('management.tabs.wait', { ms: 100 }, exec.signal, 1_000)
    await run('management.tabs.wait', {})
    expect(requestTool).toHaveBeenLastCalledWith('management.tabs.wait', {}, exec.signal, 1_000)
    await run('management.tabs.wait', { frame: 4 })
    expect(requestTool).toHaveBeenLastCalledWith('management.tabs.wait', { frame: 4 }, exec.signal, 1_000)
  })

  it('normalizes every DSH parameter map to JSON Schema before registration', () => {
    const { ctx, bridge, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    for (const { definition } of registered) {
      const params = definition.parameters as { type?: unknown; properties?: unknown }
      expect(params.type).toBe('object')
      expect(params.properties).toBeDefined()
    }
    const click = registered.find(({ name }) => name === 'management.tabs.click')!.definition.parameters as {
      properties: Record<string, unknown>
      required?: string[]
    }
    expect(click.properties.index).toBeDefined()
    expect(click.required).toContain('index')
  })

  it('declares cooperative timeoutMs on every tool', () => {
    const { ctx, bridge, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 5_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    for (const { definition } of registered) {
      expect(definition.timeoutMs).toBe(5_000)
    }
  })

  it('keeps model-facing tool schemas in English', () => {
    const { ctx, bridge, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 5_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const han = /\p{Script=Han}/u
    for (const { definition } of registered) {
      expect(String(definition.description)).not.toMatch(han)
      expect(JSON.stringify(definition.parameters)).not.toMatch(han)
    }
  })

  it('keeps model-facing tool descriptions concise', () => {
    const { ctx, bridge, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 5_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const descriptionChars = registered.reduce((sum, { definition }) => sum + String(definition.description).length, 0)
    // 31 tools incl. six full-CDP observation tools; keep the whole surface under 4.5k chars.
    expect(descriptionChars).toBeLessThan(4_500)
  })

  it('exposes optional frame routing on frame-local tools only', () => {
    const { ctx, bridge, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 5_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const byName = new Map(registered.map((entry) => [entry.name, entry.definition]))
    for (const name of ['management.tabs.click', 'management.tabs.type', 'management.tabs.press', 'management.tabs.scroll', 'pageAssets.getText', 'management.tabs.wait']) {
      const params = byName.get(name)!.parameters as { properties: { frame?: { type?: unknown } } }
      expect(params.properties.frame?.type).toBe('number')
    }
    for (const name of ['pageAssets.snapshot', 'management.tabs.navigate', 'management.tabs.open', 'management.tabs.back', 'management.tabs.forward', 'management.tabs.reload']) {
      const params = byName.get(name)!.parameters as { properties: { frame?: unknown } }
      expect(params.properties.frame).toBeUndefined()
    }
  })

  it('falls back to a no-text payload when the extension returns non-text', async () => {
    const { ctx, bridge, requestTool, registered } = makeHarness()
    requestTool.mockResolvedValueOnce(null)
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const tool = registered.find((r) => r.name === 'management.tabs.wait')!
    const exec = { signal: new AbortController().signal }
    const result = await (tool.definition.execute as (args: unknown, e: { signal: AbortSignal }) => Promise<unknown>)({}, exec)
    expect(result).toEqual({ text: expect.stringContaining('no text') })
  })

  it('renders the canonical result as one text block', () => {
    const { ctx, bridge, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const tool = registered.find((r) => r.name === 'management.tabs.click')!
    const output = tool.definition.output as { render: (args: unknown, value: unknown) => unknown }
    expect(output.render({}, { text: 'hello' })).toEqual([{ type: 'text', text: 'hello' }])
  })
})
