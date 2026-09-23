/**
 * Bounded log of browser-level changes behind `management.events`.
 *
 * Entries carry ids and change kinds only, never titles or URLs, so reading
 * the log reveals no page content; `management.tabs.list` (approval-gated)
 * stays the way to learn what a tab shows.
 *
 * @module
 */

export type BrowserEventKind =
  | 'tabs.created'
  | 'tabs.updated'
  | 'tabs.activated'
  | 'tabs.removed'
  | 'windows.created'
  | 'windows.removed'
  | 'downloads.created'
  | 'downloads.changed'

export interface BrowserEvent {
  sequence: number
  at: number
  kind: BrowserEventKind
  data: Record<string, number | string | boolean>
}

export interface BrowserEventPage {
  events: BrowserEvent[]
  /** Pass back as `afterSequence` to continue after the last returned event. */
  cursor: number
  /** Older events after `afterSequence` were already evicted from the ring. */
  truncated: boolean
}

export const MAX_EVENT_WAIT_MS = 10_000

export class BrowserEventLog {
  private readonly entries: BrowserEvent[] = []
  private sequence = 0
  private readonly waiters = new Set<() => void>()

  constructor(private readonly capacity = 200) {}

  record(kind: BrowserEventKind, data: BrowserEvent['data']): void {
    this.entries.push({ sequence: ++this.sequence, at: Date.now(), kind, data })
    while (this.entries.length > this.capacity) this.entries.shift()
    for (const wake of [...this.waiters]) wake()
  }

  /**
   * Events after `afterSequence`; waits up to `waitMs` for the first new one.
   * @param afterSequence - cursor from a previous page (0 for everything retained).
   * @param waitMs - long-poll budget, clamped to {@link MAX_EVENT_WAIT_MS}.
   * @param signal - cancels the wait.
   */
  async read(afterSequence: number, waitMs: number, signal?: AbortSignal, limit = 100): Promise<BrowserEventPage> {
    if (this.sequence <= afterSequence && waitMs > 0 && signal?.aborted !== true) {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer)
          this.waiters.delete(done)
          signal?.removeEventListener('abort', done)
          resolve()
        }
        const timer = setTimeout(done, Math.min(waitMs, MAX_EVENT_WAIT_MS))
        this.waiters.add(done)
        signal?.addEventListener('abort', done, { once: true })
      })
    }
    const newer = this.entries.filter((entry) => entry.sequence > afterSequence)
    const events = newer.slice(0, limit)
    const oldest = this.entries[0]?.sequence
    return {
      events,
      cursor: events.at(-1)?.sequence ?? Math.max(afterSequence, this.sequence),
      truncated: oldest !== undefined && oldest > afterSequence + 1 && afterSequence < this.sequence,
    }
  }
}

interface ChromeEventSource<Args extends unknown[]> {
  addListener(callback: (...args: Args) => void): void
}

/** The subset of `chrome` the log listens to; any missing API is skipped. */
export interface BrowserEventApis {
  tabs?: {
    onCreated?: ChromeEventSource<[chrome.tabs.Tab]>
    onUpdated?: ChromeEventSource<[number, chrome.tabs.TabChangeInfo, chrome.tabs.Tab]>
    onActivated?: ChromeEventSource<[{ tabId: number; windowId: number }]>
    onRemoved?: ChromeEventSource<[number, { windowId: number; isWindowClosing: boolean }]>
  }
  windows?: {
    onCreated?: ChromeEventSource<[chrome.windows.Window]>
    onRemoved?: ChromeEventSource<[number]>
  }
  downloads?: {
    onCreated?: ChromeEventSource<[chrome.downloads.DownloadItem]>
    onChanged?: ChromeEventSource<[chrome.downloads.DownloadDelta]>
  }
}

/** Register listeners synchronously at service-worker startup. */
export function installBrowserEventListeners(log: BrowserEventLog, apis: BrowserEventApis): void {
  apis.tabs?.onCreated?.addListener((tab) => {
    if (tab.id !== undefined) log.record('tabs.created', { tabId: tab.id, windowId: tab.windowId })
  })
  apis.tabs?.onUpdated?.addListener((tabId, changeInfo) => {
    const data: BrowserEvent['data'] = { tabId }
    if (typeof changeInfo?.status === 'string') data.status = changeInfo.status
    if (changeInfo?.url !== undefined) data.navigated = true
    if (typeof changeInfo?.pinned === 'boolean') data.pinned = changeInfo.pinned
    if (changeInfo?.mutedInfo !== undefined) data.muted = changeInfo.mutedInfo.muted
    if (Object.keys(data).length > 1) log.record('tabs.updated', data)
  })
  apis.tabs?.onActivated?.addListener((info) => {
    if (info !== undefined) log.record('tabs.activated', { tabId: info.tabId, windowId: info.windowId })
  })
  apis.tabs?.onRemoved?.addListener((tabId, info) => {
    log.record('tabs.removed', info?.windowId === undefined ? { tabId } : { tabId, windowId: info.windowId })
  })
  apis.windows?.onCreated?.addListener((window) => {
    if (window.id !== undefined) log.record('windows.created', { windowId: window.id })
  })
  apis.windows?.onRemoved?.addListener((windowId) => { log.record('windows.removed', { windowId }) })
  apis.downloads?.onCreated?.addListener((item) => { log.record('downloads.created', { id: item.id }) })
  apis.downloads?.onChanged?.addListener((delta) => {
    const state = delta.state?.current
    if (state !== undefined) log.record('downloads.changed', { id: delta.id, state })
  })
}
