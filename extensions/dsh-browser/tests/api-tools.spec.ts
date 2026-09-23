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
})
