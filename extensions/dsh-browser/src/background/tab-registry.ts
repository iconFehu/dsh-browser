/** Stable, opaque references for user-selectable browser tabs. */
import type { BrowserTabRef } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
export type { BrowserTabRef } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'

export function makeTabRef(tabId: number, windowId: number): string { return `tab-v1-${windowId}-${tabId}` }

export function tabRefFromChrome(tab: Pick<chrome.tabs.Tab, 'id' | 'windowId' | 'title' | 'url' | 'favIconUrl'>): BrowserTabRef | null {
  if (tab.id === undefined || tab.windowId === undefined || !/^https?:\/\//i.test(tab.url ?? '')) return null
  return { ref: makeTabRef(tab.id, tab.windowId), windowId: tab.windowId,
    title: tab.title ?? '', url: tab.url ?? '', ...(tab.favIconUrl ? { favIconUrl: tab.favIconUrl } : {}), updatedAt: Date.now() }
}

export function matchesTabQuery(tab: BrowserTabRef, query: string): boolean {
  const q = query.trim().toLocaleLowerCase()
  return q === '' || `${tab.title} ${tab.url}`.toLocaleLowerCase().includes(q)
}
