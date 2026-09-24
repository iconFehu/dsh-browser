// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { TabRecency } from '../src/background/tab-recency.ts'

describe('tab recency', () => {
  it('orders activations across worker restarts and forgets closed tabs', async () => {
    const saved: Record<string, unknown> = {}
    const storage = {
      get: async (key: string) => ({ [key]: saved[key] }),
      set: async (items: Record<string, unknown>) => { Object.assign(saved, items) },
    } as unknown as typeof chrome.storage.local
    const first = new TabRecency(storage)
    await first.activated(1, 100)
    await first.activated(2, 200)

    const restarted = new TabRecency(storage)
    const tabs = [{ id: 1 }, { id: 2 }] as chrome.tabs.Tab[]
    expect([...(await restarted.forTabs(tabs))].sort((a, b) => b[1] - a[1]).map(([id]) => id)).toEqual([2, 1])
    await restarted.forTabs([{ id: 1 }] as chrome.tabs.Tab[])
    expect([...(await new TabRecency(storage).forTabs(tabs)).keys()]).toEqual([1])
  })
})
