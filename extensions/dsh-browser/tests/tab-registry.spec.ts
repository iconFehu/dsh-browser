// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { makeTabRef, matchesTabQuery, tabRefFromChrome } from '../src/background/tab-registry.ts'

describe('browser tab registry references', () => {
  it('creates an opaque stable reference without exposing the Chrome id', () => {
    const tab = tabRefFromChrome({ id: 42, windowId: 3, title: 'Docs', url: 'https://example.com/docs', favIconUrl: 'https://example.com/favicon.ico' })
    expect(tab).toMatchObject({ ref: makeTabRef(42, 3), title: 'Docs', url: 'https://example.com/docs', windowId: 3 })
    expect(tab).not.toHaveProperty('tabId')
  })

  it('filters pages that cannot be controlled by the content bridge', () => {
    expect(tabRefFromChrome({ id: 1, windowId: 1, title: 'Extensions', url: 'chrome://extensions' })).toBeNull()
    expect(tabRefFromChrome({ id: 2, windowId: 1, title: 'New tab', url: 'about:blank' })).toBeNull()
  })

  it('matches title, URL, and host search terms', () => {
    const tab = { ref: 'tab-v1-1-2', windowId: 1, title: 'DeepSeek Docs', url: 'https://docs.example.test/guide', updatedAt: 1 }
    expect(matchesTabQuery(tab, 'deepseek')).toBe(true)
    expect(matchesTabQuery(tab, 'docs.example')).toBe(true)
    expect(matchesTabQuery(tab, 'unrelated')).toBe(false)
  })
})
