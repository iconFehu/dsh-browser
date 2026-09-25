// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiToolApproval, dispatchApiTool } from '../src/background/api-tools.ts'

function stubChrome(): { remove: ReturnType<typeof vi.fn>; search: ReturnType<typeof vi.fn> } {
  const remove = vi.fn(async () => undefined)
  const search = vi.fn(async () => [{ id: '1', title: 'Docs', url: 'https://example.com/' }])
  vi.stubGlobal('chrome', { bookmarks: { remove, search } })
  return { remove, search }
}

describe('api tools', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('asks for approval only on state-changing methods', () => {
    expect(apiToolApproval({ id: 'a', name: 'management.bookmarks.search', args: {} })).toBeUndefined()
    expect(apiToolApproval({ id: 'b', name: 'management.bookmarks.delete', args: { id: '1' } }))
      .toMatchObject({ kind: 'action', action: 'management.bookmarks.delete', canTrust: false })
  })

  it('does not delete a bookmark without approval', async () => {
    const chrome = stubChrome()
    const denied = await dispatchApiTool({ id: 'c', name: 'management.bookmarks.delete', args: { id: '1' } }, 1, async () => 'denied')
    expect(denied.ok).toBe(false)
    expect(chrome.remove).not.toHaveBeenCalled()

    const unattended = await dispatchApiTool({ id: 'd', name: 'management.bookmarks.delete', args: { id: '1' } }, 1)
    expect(unattended.ok).toBe(false)
    expect(chrome.remove).not.toHaveBeenCalled()

    const approved = await dispatchApiTool({ id: 'e', name: 'management.bookmarks.delete', args: { id: '1' } }, 1, async () => 'approved')
    expect(approved.ok).toBe(true)
    expect(chrome.remove).toHaveBeenCalledWith('1')
  })

  it('runs reads without prompting', async () => {
    const chrome = stubChrome()
    const authorize = vi.fn(async () => 'approved' as const)
    const answer = await dispatchApiTool({ id: 'f', name: 'management.bookmarks.search', args: { query: 'docs' } }, 1, authorize)
    expect(answer.ok).toBe(true)
    expect(authorize).not.toHaveBeenCalled()
    expect(chrome.search).toHaveBeenCalledWith({ query: 'docs' })
  })

  it('requires tabIds for tabGroups.create and does not hijack the first window tab', async () => {
    const group = vi.fn(async () => 42)
    const update = vi.fn(async (id: number) => ({ id }))
    const query = vi.fn(async () => [{ id: 99, title: 'Other' }])
    vi.stubGlobal('chrome', {
      tabs: { group, ungroup: vi.fn(), query },
      tabGroups: { update, query: vi.fn(async () => []) },
    })

    const missing = await dispatchApiTool({ id: 'g1', name: 'management.tabGroups.create', args: { title: 'Nope' } }, 1, async () => 'approved')
    expect(missing.ok).toBe(false)
    expect(String((missing as { error: { message: string } }).error.message)).toMatch(/requires tabIds/)
    expect(group).not.toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()

    const created = await dispatchApiTool(
      { id: 'g2', name: 'management.tabGroups.create', args: { tabIds: [7, 8], title: 'Research', color: 'green' } },
      1,
      async () => 'approved',
    )
    expect(created.ok).toBe(true)
    expect((created.result as { text: string }).text).toContain('[42]')
    expect((created.result as { text: string }).text).toContain('7, 8')
    expect(group).toHaveBeenCalledWith({ tabIds: [7, 8] })
    expect(update).toHaveBeenCalledWith(42, { title: 'Research', color: 'green' })
  })

  it('dissolves tabGroups by groupId while documenting tabs.ungroup for tabIds', async () => {
    const ungroup = vi.fn(async () => undefined)
    const query = vi.fn(async () => [{ id: 7 }, { id: 8 }])
    vi.stubGlobal('chrome', {
      tabs: { group: vi.fn(), ungroup, query },
      tabGroups: { update: vi.fn(), query: vi.fn() },
    })
    const missing = await dispatchApiTool({ id: 'u1', name: 'management.tabGroups.ungroup', args: {} }, 1, async () => 'approved')
    expect(missing.ok).toBe(false)
    expect(String((missing as { error: { message: string } }).error.message)).toMatch(/tabs\.ungroup/)

    const removed = await dispatchApiTool({ id: 'u2', name: 'management.tabGroups.ungroup', args: { groupId: 3 } }, 1, async () => 'approved')
    expect(removed.ok).toBe(true)
    expect(query).toHaveBeenCalledWith({ groupId: 3 })
    expect(ungroup).toHaveBeenCalledWith([7, 8])
  })
})
