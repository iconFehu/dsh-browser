// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchCapabilityTool, resetCapabilityState, type CapabilityDeps } from '../src/background/capability-tools.ts'
import { BrowserEventLog } from '../src/background/browser-events.ts'
import { CdpUnavailableError } from '../src/background/cdp/manager.ts'
import type { ApprovalAuthorization, ApprovalPrompt } from '../src/security/approval.ts'
import type { ToolCall } from '../src/background/tools.ts'

const TAB = { id: 7, windowId: 2, url: 'https://shop.example.com/login' }

function call(name: string, args: Record<string, unknown> = {}, expiresAt?: number): ToolCall {
  return { id: `call-${name}`, name, args, ...(expiresAt === undefined ? {} : { expiresAt }) }
}

function deps(overrides: Partial<CapabilityDeps> = {}) {
  const prompts: ApprovalPrompt[] = []
  const handoffs: { prompt: ApprovalPrompt; timeoutMs: number }[] = []
  const cdp = {
    available: true,
    attached: undefined as number | undefined,
    attach: vi.fn(async (tabId: number) => { cdp.attached = tabId }),
    send: vi.fn(async () => ({})),
    attachedTab: () => cdp.attached,
  }
  const value: CapabilityDeps = {
    tab: TAB,
    sharePageContent: 'auto',
    authorize: vi.fn(async (prompt: ApprovalPrompt): Promise<ApprovalAuthorization> => { prompts.push(prompt); return 'approved' }),
    handoff: vi.fn(async (prompt: ApprovalPrompt, timeoutMs: number): Promise<ApprovalAuthorization> => { handoffs.push({ prompt, timeoutMs }); return 'approved' }),
    cdp,
    events: new BrowserEventLog(),
    notifyBotDetection: vi.fn(),
    signal: new AbortController().signal,
    ...overrides,
  }
  return { deps: value, prompts, handoffs, cdp }
}

function result(answer: Awaited<ReturnType<typeof dispatchCapabilityTool>>): Record<string, unknown> {
  expect(answer.ok).toBe(true)
  return JSON.parse((answer.result as { text: string }).text) as Record<string, unknown>
}

const chromeMock = {
  tabs: {
    get: vi.fn(async () => TAB),
    update: vi.fn(async (tabId: number, update: Record<string, unknown>) => {
      const after: Record<string, unknown> = { ...TAB, id: tabId, ...update }
      if (typeof update.muted === 'boolean') {
        after.mutedInfo = { muted: update.muted }
        delete after.muted
      }
      if (typeof update.url === 'string') after.url = update.url
      return after
    }),
  },
  windows: { get: vi.fn(async () => ({ id: 2, width: 1280, height: 800, state: 'normal' })), getLastFocused: vi.fn(async () => ({ id: 2, state: 'normal' })), update: vi.fn(async () => ({})), getAll: vi.fn(async () => []) },
  scripting: { executeScript: vi.fn(async () => [{ result: [
    { url: 'https://cdn.example.com/logo.png', type: 'img' },
    { url: 'https://cdn.example.com/app.css', type: 'stylesheet' },
    { url: 'https://cdn.example.com/logo.png', type: 'img' },
    { url: 'data:image/png;base64,AAAA', type: 'img' },
  ] }]) },
  downloads: { download: vi.fn(async () => 41), cancel: vi.fn(async () => {}) },
  tabGroups: { update: vi.fn(async (id: number) => ({ id })) },
}

beforeEach(() => {
  resetCapabilityState()
  vi.stubGlobal('chrome', chromeMock)
  for (const api of Object.values(chromeMock)) for (const fn of Object.values(api)) (fn as ReturnType<typeof vi.fn>).mockClear()
})
afterEach(() => { vi.unstubAllGlobals() })

describe('browserAuth.request handoff', () => {
  const request = { origin: 'https://shop.example.com', fields: [{ id: 'email', label: 'Email', type: 'email', required: true }, { id: 'pw', label: 'Password', type: 'password', required: true }] }

  it('hands off to the user, bypassing ordinary approval, and returns a status only', async () => {
    const { deps: d, handoffs } = deps()
    const answer = result(await dispatchCapabilityTool(call('browserAuth.request', request, Date.now() + 90_000), d))
    expect(answer).toEqual({ status: 'submitted', currentOrigin: 'https://shop.example.com' })
    expect(d.authorize).not.toHaveBeenCalled()
    expect(handoffs[0]!.prompt).toMatchObject({ kind: 'handoff', action: 'browserAuth.request', origins: ['https://shop.example.com'], canTrust: false })
    expect(handoffs[0]!.prompt.summary).toContain('Email')
    expect(handoffs[0]!.timeoutMs).toBeLessThanOrEqual(90_000)
    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled()
  })

  it('maps decline, timeout, and closed panels to statuses', async () => {
    for (const [authorization, status] of [['denied', 'declined'], ['timed-out', 'expired'], ['unavailable', 'unavailable'], ['cancelled', 'cancelled']] as const) {
      const { deps: d } = deps({ handoff: vi.fn(async () => authorization) })
      expect(result(await dispatchCapabilityTool(call('browserAuth.request', request), d))).toEqual({ status })
    }
  })

  it('refuses a handoff for a different origin than the controlled page', async () => {
    const { deps: d } = deps()
    const answer = result(await dispatchCapabilityTool(call('browserAuth.request', { ...request, origin: 'https://evil.example.net' }), d))
    expect(answer).toEqual({ status: 'origin_changed' })
    expect(d.handoff).not.toHaveBeenCalled()
  })
})

describe('pageAssets', () => {
  it('lists http(s) assets once, behind the page-sharing policy', async () => {
    const off = deps({ sharePageContent: 'off' })
    expect((await dispatchCapabilityTool(call('pageAssets.list'), off.deps)).ok).toBe(false)
    const ask = deps({ sharePageContent: 'ask' })
    const answer = await dispatchCapabilityTool(call('pageAssets.list'), ask.deps)
    expect(ask.prompts[0]).toMatchObject({ kind: 'read', action: 'pageAssets.list' })
    const text = (answer.result as { text: string }).text
    expect(text).toContain('UNTRUSTED_PAGE_CONTENT')
    expect(text.match(/logo\.png/g)).toHaveLength(1)
    expect(text).not.toContain('data:image')
  })

  it('saves an approved bundle to Downloads and returns file names, never contents', async () => {
    const { deps: d, prompts } = deps()
    const listed = (await dispatchCapabilityTool(call('pageAssets.list'), d)).result as { text: string }
    const inventoryId = /"inventoryId":"([^"]+)"/.exec(listed.text)![1]!
    const answer = result(await dispatchCapabilityTool(call('pageAssets.bundle', { inventoryId, kinds: ['image'] }), d))
    expect(prompts.at(-1)).toMatchObject({ kind: 'action', action: 'pageAssets.bundle', origins: ['https://shop.example.com'] })
    expect(chromeMock.downloads.download).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://cdn.example.com/logo.png',
      filename: expect.stringMatching(/^dsh-browser-assets\/[^/]+\/001-logo\.png$/),
      saveAs: false,
    }))
    expect(answer).toMatchObject({ summary: { requestedCount: 1, startedCount: 1, failedCount: 0 } })
    expect(JSON.stringify(answer)).not.toMatch(/base64|"data"/)
  })

  it('refuses a stale inventory and a denied bundle', async () => {
    const { deps: d } = deps()
    expect((await dispatchCapabilityTool(call('pageAssets.bundle', { inventoryId: 'missing' }), d)).ok).toBe(false)
    const listed = (await dispatchCapabilityTool(call('pageAssets.list'), d)).result as { text: string }
    const inventoryId = /"inventoryId":"([^"]+)"/.exec(listed.text)![1]!
    const moved = deps({ tab: { ...TAB, url: 'https://shop.example.com/other' } })
    expect((await dispatchCapabilityTool(call('pageAssets.bundle', { inventoryId }), moved.deps)).ok).toBe(false)
    const denied = deps({ authorize: vi.fn(async () => 'denied' as const) })
    expect((await dispatchCapabilityTool(call('pageAssets.bundle', { inventoryId }), denied.deps)).ok).toBe(false)
    expect(chromeMock.downloads.download).not.toHaveBeenCalled()
  })
})

describe('viewport', () => {
  it('emulates an approved size through the CDP manager and clears it on reset', async () => {
    const { deps: d, cdp } = deps()
    const set = result(await dispatchCapabilityTool(call('viewport.set', { width: 390, height: 844 }), d))
    expect(set).toMatchObject({ width: 390, height: 844, override: true })
    expect(cdp.attach).toHaveBeenCalledWith(7)
    expect(cdp.send).toHaveBeenCalledWith('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false })
    expect(result(await dispatchCapabilityTool(call('viewport.get'), d))).toEqual({ width: 390, height: 844, override: true })
    await dispatchCapabilityTool(call('viewport.reset'), d)
    expect(cdp.send).toHaveBeenLastCalledWith('Emulation.clearDeviceMetricsOverride', {})
    expect(result(await dispatchCapabilityTool(call('viewport.get'), d))).toMatchObject({ override: false })
  })

  it('surfaces developer-mode refusal and forgets overrides once CDP detaches', async () => {
    const refused = deps()
    refused.cdp.attach.mockRejectedValueOnce(new CdpUnavailableError('disabled', 'Browser developer mode is off.'))
    const answer = await dispatchCapabilityTool(call('viewport.set', { width: 390, height: 844 }), refused.deps)
    expect(answer).toMatchObject({ ok: false, error: { code: 'feature-unavailable' } })

    const { deps: d, cdp } = deps()
    await dispatchCapabilityTool(call('viewport.set', { width: 800, height: 600 }), d)
    cdp.attached = undefined
    expect(result(await dispatchCapabilityTool(call('viewport.get'), d))).toMatchObject({ override: false })
  })

  it('does not attach when the change is denied', async () => {
    const { deps: d, cdp } = deps({ authorize: vi.fn(async () => 'denied' as const) })
    expect((await dispatchCapabilityTool(call('viewport.set', { width: 390, height: 844 }), d)).ok).toBe(false)
    expect(cdp.attach).not.toHaveBeenCalled()
  })
})

describe('browser-level capabilities', () => {
  it('minimizes or shows the controlled window only after approval', async () => {
    const { deps: d, prompts } = deps()
    await dispatchCapabilityTool(call('visibility.set', { visible: false }), d)
    expect(prompts[0]).toMatchObject({ kind: 'action', action: 'visibility.set' })
    expect(chromeMock.windows.update).toHaveBeenCalledWith(2, { state: 'minimized' })
    expect(result(await dispatchCapabilityTool(call('visibility.get'), d))).toEqual({ visible: true, windowId: 2 })
  })

  it('reports bot detection to the panel without acting on the page', async () => {
    const { deps: d } = deps()
    const answer = result(await dispatchCapabilityTool(call('botDetection.report', { reason: 'captcha_failed' }), d))
    expect(answer).toMatchObject({ status: 'reported', hostname: 'shop.example.com' })
    expect(d.notifyBotDetection).toHaveBeenCalledWith({ reason: 'captcha_failed', hostname: 'shop.example.com' })
    expect((await dispatchCapabilityTool(call('botDetection.report', { reason: 'solve_it' }), d)).ok).toBe(false)
  })

  it('updates tabs, groups, and downloads only after approval', async () => {
    const { deps: d, prompts } = deps()
    await dispatchCapabilityTool(call('management.tabs.update', { tabId: 7, pinned: true }), d)
    await dispatchCapabilityTool(call('management.tabGroups.update', { groupId: 3, title: 'Research' }), d)
    await dispatchCapabilityTool(call('management.downloads.cancel', { id: 12 }), d)
    expect(prompts.map((prompt) => prompt.action)).toEqual(['management.tabs.update', 'management.tabGroups.update', 'management.downloads.cancel'])
    expect(chromeMock.tabs.update).toHaveBeenCalledWith(7, { pinned: true })
    expect(chromeMock.tabGroups.update).toHaveBeenCalledWith(3, { title: 'Research' })
    expect(chromeMock.downloads.cancel).toHaveBeenCalledWith(12)

    const denied = deps({ authorize: vi.fn(async () => 'denied' as const) })
    chromeMock.tabs.update.mockClear()
    expect((await dispatchCapabilityTool(call('management.tabs.update', { tabId: 7, muted: true }), denied.deps)).ok).toBe(false)
    expect(chromeMock.tabs.update).not.toHaveBeenCalled()
  })

  it('aligns tabs.update with Chrome updateProperties including url navigation', async () => {
    const { deps: d, prompts } = deps()

    const unsupported = await dispatchCapabilityTool(call('management.tabs.update', { tabId: 7, title: 'x', groupId: 1, index: 0 }), d)
    expect(unsupported.ok).toBe(false)
    expect(String((unsupported as { error: { message: string } }).error.message)).toMatch(/title is not supported/)
    expect(String((unsupported as { error: { message: string } }).error.message)).toMatch(/groupId belongs to/)
    expect(String((unsupported as { error: { message: string } }).error.message)).toMatch(/index belongs to/)
    expect(chromeMock.tabs.update).not.toHaveBeenCalled()

    const js = await dispatchCapabilityTool(call('management.tabs.update', { tabId: 7, url: 'javascript:alert(1)' }), d)
    expect(js.ok).toBe(false)
    expect(String((js as { error: { message: string } }).error.message)).toMatch(/http\(s\) URL/)

    prompts.length = 0
    const selected = result(await dispatchCapabilityTool(call('management.tabs.update', { tabId: 7, selected: true, muted: true }), d))
    expect(chromeMock.tabs.update).toHaveBeenCalledWith(7, { highlighted: true, muted: true })
    expect(selected).toMatchObject({ tabId: 7, highlighted: true, muted: true })
    expect(prompts[0]).toMatchObject({ action: 'management.tabs.update', origins: ['https://shop.example.com'] })
    expect(prompts[0]!.summary).toMatch(/Update tab 7|更新标签页 7/)

    prompts.length = 0
    chromeMock.tabs.update.mockClear()
    const navigated = result(await dispatchCapabilityTool(call('management.tabs.update', {
      tabId: 7,
      url: 'https://news.example.com/story',
      pinned: true,
    }), d))
    expect(chromeMock.tabs.update).toHaveBeenCalledWith(7, { url: 'https://news.example.com/story', pinned: true })
    expect(navigated).toMatchObject({
      tabId: 7,
      url: 'https://news.example.com/story',
      pinned: true,
    })
    expect(prompts[0]!.origins).toEqual(['https://shop.example.com', 'https://news.example.com'])
    expect(prompts[0]!.summary).toMatch(/Navigate tab 7 to https:\/\/news\.example\.com\/story|导航标签页 7/)
  })

  it('reads the browser event log', async () => {
    const { deps: d } = deps()
    d.events.record('tabs.created', { tabId: 9, windowId: 2 })
    expect(result(await dispatchCapabilityTool(call('management.events', { afterSequence: 0 }), d))).toMatchObject({ cursor: 1, events: [{ kind: 'tabs.created' }] })
  })
})
