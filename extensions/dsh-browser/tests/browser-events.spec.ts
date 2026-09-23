// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { BrowserEventLog, installBrowserEventListeners, type BrowserEventApis } from '../src/background/browser-events.ts'

function source<Args extends unknown[]>() {
  const listeners: ((...args: Args) => void)[] = []
  return { addListener: (listener: (...args: Args) => void) => { listeners.push(listener) }, emit: (...args: Args) => { for (const listener of listeners) listener(...args) } }
}

describe('BrowserEventLog', () => {
  it('pages events after a cursor', async () => {
    const log = new BrowserEventLog()
    log.record('tabs.created', { tabId: 1, windowId: 1 })
    log.record('tabs.removed', { tabId: 1 })
    const first = await log.read(0, 0)
    expect(first.events.map((event) => event.kind)).toEqual(['tabs.created', 'tabs.removed'])
    expect(first.cursor).toBe(2)
    expect((await log.read(first.cursor, 0)).events).toEqual([])
  })

  it('long-polls until a new event arrives', async () => {
    vi.useFakeTimers()
    try {
      const log = new BrowserEventLog()
      const pending = log.read(0, 5_000)
      await vi.advanceTimersByTimeAsync(100)
      log.record('windows.created', { windowId: 3 })
      const page = await pending
      expect(page.events).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports truncation once older events are evicted', async () => {
    const log = new BrowserEventLog(2)
    for (let tabId = 1; tabId <= 4; tabId += 1) log.record('tabs.created', { tabId, windowId: 1 })
    const page = await log.read(0, 0)
    expect(page.events.map((event) => event.data.tabId)).toEqual([3, 4])
    expect(page.truncated).toBe(true)
  })
})

describe('installBrowserEventListeners', () => {
  it('records ids and change kinds but never titles or URLs', async () => {
    const log = new BrowserEventLog()
    const onCreated = source<[chrome.tabs.Tab]>()
    const onUpdated = source<[number, chrome.tabs.TabChangeInfo, chrome.tabs.Tab]>()
    const onChanged = source<[chrome.downloads.DownloadDelta]>()
    installBrowserEventListeners(log, {
      tabs: { onCreated, onUpdated },
      downloads: { onChanged },
    } as unknown as BrowserEventApis)
    onCreated.emit({ id: 5, windowId: 2, title: 'Secret inbox', url: 'https://mail.example.com/inbox' } as chrome.tabs.Tab)
    onUpdated.emit(5, { url: 'https://mail.example.com/message/42', title: 'Private' } as chrome.tabs.TabChangeInfo, {} as chrome.tabs.Tab)
    onUpdated.emit(5, { favIconUrl: 'https://mail.example.com/icon.png' } as chrome.tabs.TabChangeInfo, {} as chrome.tabs.Tab)
    onChanged.emit({ id: 9, state: { current: 'complete' } } as chrome.downloads.DownloadDelta)
    const page = await log.read(0, 0)
    expect(page.events.map(({ kind, data }) => ({ kind, data }))).toEqual([
      { kind: 'tabs.created', data: { tabId: 5, windowId: 2 } },
      { kind: 'tabs.updated', data: { tabId: 5, navigated: true } },
      { kind: 'downloads.changed', data: { id: 9, state: 'complete' } },
    ])
    expect(JSON.stringify(page)).not.toMatch(/example\.com|Secret|Private/)
  })
})
