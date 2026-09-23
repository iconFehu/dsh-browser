import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

interface TabSource {
  trigger: string
  name: string
  candidates(session: unknown, request: { query: string; signal: AbortSignal }): Promise<{ name: string; description?: string; value?: string }[]>
  onPick(pick: { candidate: { name: string; value?: string } }): unknown
  codec: { clipboardText(ref: string): string; serialize(ref: string): Promise<string> }
}

let apply: (ctx: unknown) => void
let inject: unknown

beforeAll(async () => {
  let factory!: (require: (id: string) => unknown) => { apply: typeof apply; inject: unknown }
  vi.stubGlobal('window', { __ModuleLoader__: { load: (entry: { factory: typeof factory }) => { factory = entry.factory } } })
  await import('../src/client.js')
  const exports = factory(() => ({ createElement: () => null, useEffect: () => {}, useState: (value: unknown) => [value, () => {}] }))
  apply = exports.apply
  inject = exports.inject
  vi.unstubAllGlobals()
})

afterEach(() => { vi.unstubAllGlobals() })

function applyClient(withTriggers: boolean): TabSource | undefined {
  let source: TabSource | undefined
  const ctx = {
    effect: vi.fn(),
    locale: { register: vi.fn() },
    slots: { inject: vi.fn(), register: vi.fn() },
    inject: vi.fn((_deps: string[], callback: (ctx: unknown) => void) => {
      if (!withTriggers) return
      callback({
        effect: (run: () => unknown) => run(),
        inputTriggers: { registerSource: (registered: TabSource) => { source = registered; return () => {} } },
      })
    }),
  }
  apply(ctx)
  expect(ctx.inject).toHaveBeenCalledWith(['inputTriggers'], expect.any(Function))
  return source
}

describe('client @tab source', () => {
  it('keeps the input-trigger service optional', () => {
    expect(inject).toEqual(['slots', 'locale'])
    expect(applyClient(false)).toBeUndefined()
  })

  it('lists matching tabs from the guarded same-origin endpoint', async () => {
    const source = applyClient(true)!
    expect(source).toMatchObject({ trigger: '@', name: 'browser-tab' })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([
      { ref: 'tab-v1-1-7', title: 'Docs', url: 'https://example.com/docs' },
      { ref: 'tab-v1-1-8', title: 'Mail', url: 'https://mail.example.com/' },
      { title: 'missing ref' },
    ])))
    vi.stubGlobal('fetch', fetchMock)
    const candidates = await source.candidates({}, { query: 'doc', signal: new AbortController().signal })
    expect(fetchMock).toHaveBeenCalledWith('/ext/browser-tabs', expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }))
    expect(candidates).toEqual([{ name: 'Docs', description: 'https://example.com/docs', icon: 'session', value: 'tab-v1-1-7' }])
  })

  it('returns no candidates when the endpoint refuses', async () => {
    const source = applyClient(true)!
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"forbidden"}', { status: 403 })))
    expect(await source.candidates({}, { query: '', signal: new AbortController().signal })).toEqual([])
  })

  it('inserts a tab reference that serializes to the bridge prompt marker', async () => {
    const source = applyClient(true)!
    expect(source.onPick({ candidate: { name: 'Docs', value: 'tab-v1-1-7' } })).toEqual({
      insert: { source: 'browser-tab', ref: 'tab-v1-1-7', label: 'Docs', appearance: 'session', clipboardText: '@Docs' },
    })
    expect(source.onPick({ candidate: { name: 'Docs' } })).toBeUndefined()
    expect(await source.codec.serialize('tab-v1-1-7')).toBe('[[dsh-browser-tab:tab-v1-1-7]]')
  })
})
