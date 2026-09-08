/**
 * Tool executors backed by Chrome extension APIs (bookmarks, history,
 * downloads, tab groups). These run in the background service worker
 * rather than the content script.
 *
 * @module
 */

import type { ToolCall, ToolAnswer } from './tools.ts'
import { wrapUntrustedContent } from '../security/untrusted.ts'

export const API_TOOL_NAMES: ReadonlySet<string> = new Set([
  'browser_download_media',
  'browser_list_downloads',
  'browser_bookmarks_search',
  'browser_bookmarks_add',
  'browser_bookmarks_remove',
  'browser_bookmarks_update',
  'browser_bookmarks_list',
  'browser_bookmarks_move',
  'browser_history',
  'browser_tab_groups_list',
  'browser_tab_groups_create',
  'browser_tab_groups_remove',
  'browser_page_context',
])

function unavailableError(message: string): ToolAnswer {
  return { ok: false, error: { code: 'action-failed', message } }
}

/**
 * Download media from the controlled page. Requires a selector or url.
 * When no url is given, the first <img>, <video>, or <audio> matching
 * selector is used. Opens the browser download dialog.
 */
export async function downloadMedia(call: ToolCall, tabId: number): Promise<ToolAnswer> {
  try {
    const selector = typeof call.args.selector === 'string' ? call.args.selector : undefined
    const url = typeof call.args.url === 'string' ? call.args.url : undefined
    const filename = typeof call.args.filename === 'string' ? call.args.filename : undefined

    let downloadUrl = url
    if (!downloadUrl && selector) {
      const result = await chrome.scripting.executeScript({
        target: { tabId },
        func: (selector: string) => {
          const el = document.querySelector(selector) as HTMLImageElement | HTMLVideoElement | HTMLAudioElement | null
          if (!el) return null
          if (el.tagName === 'IMG') return el.src
          if (el.tagName === 'VIDEO' || el.tagName === 'AUDIO') {
            // Try direct src first
            if (el.src) return el.src
            // Fall back to first <source> child element
            const source = el.querySelector('source')
            if (source && source.src) return source.src
          }
          return null
        },
        args: [selector],
      })
      if (result[0]?.result) {
        downloadUrl = result[0].result
      }
    }

    if (!downloadUrl) {
      return {
        ok: true,
        result: { text: 'Could not determine download URL from selector.' },
      }
    }

    await chrome.downloads.download({ url: downloadUrl, filename })
    return {
      ok: true,
      result: {
        text: `Download initiated${filename ? ` as '${filename}'` : ''}.`,
      },
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return unavailableError(`Download failed: ${msg}`)
  }
}

/**
 * List recent browser downloads with status, path, and size.
 */
export async function listDownloads(call: ToolCall): Promise<ToolAnswer> {
  try {
    const limit = typeof call.args.limit === 'number' ? call.args.limit : 10
    const filter = call.args.filter as Record<string, unknown> | undefined

    const searchFilter: chrome.downloads.DownloadQuery = {
      limit,
    }
    if (filter) {
      if (typeof filter.filename === 'string') searchFilter.filename = filter.filename
      if (typeof filter.state === 'string') searchFilter.state = filter.state
      if (typeof filter.startTime === 'number') searchFilter.startTime = new Date(filter.startTime).toISOString()
      if (typeof filter.endTime === 'number') searchFilter.endTime = new Date(filter.endTime).toISOString()
    }

    const items = await chrome.downloads.search(searchFilter)
    if (items.length === 0) {
      return { ok: true, result: { text: 'No downloads found.' } }
    }

    const lines = items.map((item) => {
      const state = item.state ?? 'unknown'
      const size = item.totalBytes ? ` (${item.totalBytes} bytes)` : ''
      return `- ${item.filename ?? 'unknown'} [${state}]${size} - ${item.url ?? 'no url'}`
    })

    return {
      ok: true,
      result: { text: `Recent downloads:\n${lines.join('\n')}` },
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return unavailableError(`List downloads failed: ${msg}`)
  }
}

/**
 * Search bookmarks by query string.
 */
export async function bookmarksSearch(call: ToolCall): Promise<ToolAnswer> {
  try {
    const query = typeof call.args.query === 'string' ? call.args.query : ''
    if (!query) {
      return unavailableError('query is required.')
    }
    const results = await chrome.bookmarks.search({ query })
    if (results.length === 0) {
      return { ok: true, result: { text: 'No bookmarks found.' } }
    }
    const lines = results.map((bm) => `- ${bm.title} [${bm.id}] - ${bm.url ?? 'folder'}`)
    return { ok: true, result: { text: `Bookmarks matching '${query}':\n${lines.join('\n')}` } }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return unavailableError(`Bookmarks search failed: ${msg}`)
  }
}

/**
 * Add a new bookmark.
 */
export async function bookmarksAdd(call: ToolCall): Promise<ToolAnswer> {
  try {
    const url = typeof call.args.url === 'string' ? call.args.url : undefined
    if (!url) {
      return unavailableError('url is required.')
    }
    const title = typeof call.args.title === 'string' ? call.args.title : undefined
    const parentId = typeof call.args.parentId === 'string' ? call.args.parentId : undefined
    const index = typeof call.args.index === 'number' ? call.args.index : undefined

    const bookmark = await chrome.bookmarks.create({ url, title, parentId, index })
    return {
      ok: true,
      result: { text: `Bookmark added [${bookmark.id}]: ${bookmark.title ?? bookmark.url}` },
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return unavailableError(`Bookmarks add failed: ${msg}`)
  }
}

/**
 * Remove a bookmark by ID.
 */
export async function bookmarksRemove(call: ToolCall): Promise<ToolAnswer> {
  try {
    const id = typeof call.args.id === 'string' ? call.args.id : undefined
    if (!id) {
      return unavailableError('id is required.')
    }
    await chrome.bookmarks.remove(id)
    return { ok: true, result: { text: `Bookmark ${id} removed.` } }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return unavailableError(`Bookmarks remove failed: ${msg}`)
  }
}

/**
 * Update an existing bookmark.
 */
export async function bookmarksUpdate(call: ToolCall): Promise<ToolAnswer> {
  try {
    const id = typeof call.args.id === 'string' ? call.args.id : undefined
    if (!id) {
      return unavailableError('id is required.')
    }
    const title = typeof call.args.title === 'string' ? call.args.title : undefined
    const url = typeof call.args.url === 'string' ? call.args.url : undefined

    const updates: Record<string, string> = {}
    if (title !== undefined) updates.title = title
    if (url !== undefined) updates.url = url

    const bookmark = await chrome.bookmarks.update(id, updates)
    return { ok: true, result: { text: `Bookmark updated: ${bookmark.title}` } }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return unavailableError(`Bookmarks update failed: ${msg}`)
  }
}

/**
 * List bookmarks. Optionally filter by folder ID.
 */
export async function bookmarksList(call: ToolCall): Promise<ToolAnswer> {
  try {
    const id = typeof call.args.id === 'string' ? call.args.id : undefined
    const bookmarkNodes = id ? await chrome.bookmarks.get(id) : await chrome.bookmarks.getTree()
    const bookmarks = Array.isArray(bookmarkNodes) ? bookmarkNodes : [bookmarkNodes]

    function formatNode(node: chrome.bookmarks.BookmarkTreeNode, depth = 0): string {
      const indent = '  '.repeat(depth)
      const isFolder = !node.url
      if (isFolder) {
        return `${indent}- ${node.title} [${node.id}] (folder)`
      }
      return `${indent}- ${node.title} [${node.id}] - ${node.url}`
    }

    const lines: string[] = []
    for (const node of bookmarks) {
      lines.push(formatNode(node))
      if (node.children) {
        for (const child of node.children) {
          lines.push(formatNode(child, 1))
        }
      }
    }
    return { ok: true, result: { text: lines.join('\n') } }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return unavailableError(`Bookmarks list failed: ${msg}`)
  }
}

/**
 * Move a bookmark to a different folder.
 */
export async function bookmarksMove(call: ToolCall): Promise<ToolAnswer> {
  try {
    const id = typeof call.args.id === 'string' ? call.args.id : undefined
    const parentId = typeof call.args.parentId === 'string' ? call.args.parentId : undefined
    if (!id || !parentId) {
      return unavailableError('id and parentId are required.')
    }
    const index = typeof call.args.index === 'number' ? call.args.index : undefined

    const bookmark = await chrome.bookmarks.move(id, { parentId, index })
    return { ok: true, result: { text: `Bookmark moved to folder ${parentId}: ${bookmark.title}` } }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return unavailableError(`Bookmarks move failed: ${msg}`)
  }
}

/**
 * Read or search browser history.
 */
export async function history(call: ToolCall): Promise<ToolAnswer> {
  try {
    const mode = typeof call.args.mode === 'string' ? call.args.mode : 'read'
    const query = typeof call.args.query === 'string' ? call.args.query : undefined
    const maxResults = typeof call.args.maxResults === 'number' ? call.args.maxResults : 20
    const startTime = typeof call.args.startTime === 'number' ? call.args.startTime : Date.now() - 30 * 24 * 60 * 60 * 1000
    const endTime = typeof call.args.endTime === 'number' ? call.args.endTime : Date.now()

    let entries: chrome.history.HistoryItem[]
    if (mode === 'search' && query) {
      entries = await chrome.history.search({ text: query, startTime, endTime, maxResults })
    } else {
      entries = await chrome.history.search({ text: '', startTime, endTime, maxResults })
    }

    if (entries.length === 0) {
      return { ok: true, result: { text: 'No history entries found.' } }
    }

    const lines = entries.map((item) => {
      const visitTime = item.lastVisitTime
      const visitDate = visitTime ? new Date(visitTime) : undefined
      const visitStr = visitDate && !isNaN(visitDate.getTime()) ? visitDate.toISOString() : 'unknown'
      return `- ${item.title || item.url} [${visitStr}] - ${item.url}`
    })
    return { ok: true, result: { text: `History entries:\n${lines.join('\n')}` } }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return unavailableError(`History failed: ${msg}`)
  }
}

/**
 * List all tab groups.
 */
export async function tabGroupsList(): Promise<ToolAnswer> {
  try {
    const groups = await chrome.tabGroups.query({})
    if (groups.length === 0) {
      return { ok: true, result: { text: 'No tab groups found.' } }
    }
    const lines = groups.map((g) => `- ${g.title} [${g.id}] (color: ${g.color ?? 'default'})`)
    return { ok: true, result: { text: `Tab groups:\n${lines.join('\n')}` } }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return unavailableError(`Tab groups list failed: ${msg}`)
  }
}

/**
 * Create a new tab group.
 */
export async function tabGroupsCreate(call: ToolCall): Promise<ToolAnswer> {
  try {
    const title = typeof call.args.title === 'string' ? call.args.title : undefined
    if (!title) {
      return unavailableError('title is required.')
    }
    const color = typeof call.args.color === 'string' ? call.args.color : 'blue'
    const windowId = typeof call.args.windowId === 'number' ? call.args.windowId : undefined

    // chrome.tabGroups.create is not in @types/chrome, use chrome.tabs.group instead
    // Find tabs in the window to group
    const tabs = await chrome.tabs.query({ windowId: windowId ?? chrome.windows.WINDOW_ID_CURRENT })
    if (tabs.length === 0) {
      return unavailableError('No tabs found to create group.')
    }
    // Group the first tab
    const groupId = await chrome.tabs.group({ tabIds: [tabs[0].id!] })
    // Update group properties
    await chrome.tabGroups.update(groupId, { title, color: color as chrome.tabGroups.ColorEnum })
    return { ok: true, result: { text: `Tab group created [${groupId}]: ${title}` } }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return unavailableError(`Tab groups create failed: ${msg}`)
  }
}

/**
 * Remove a tab group (tabs are not closed).
 */
export async function tabGroupsRemove(call: ToolCall): Promise<ToolAnswer> {
  try {
    const groupId = typeof call.args.groupId === 'number' ? call.args.groupId : undefined
    if (groupId === undefined) {
      return unavailableError('groupId is required.')
    }
    // chrome.tabGroups.remove is not in @types/chrome, use tabGroups.update with no tabs
    // Find tabs in the group
    const tabs = await chrome.tabs.query({ groupId })
    if (tabs.length > 0) {
      // Ungroup the tabs
      await chrome.tabs.ungroup(tabs.map(t => t.id!))
    }
    return { ok: true, result: { text: `Tab group ${groupId} removed.` } }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return unavailableError(`Tab groups remove failed: ${msg}`)
  }
}

/**
 * Get a semantic HTML representation of the page that provides context for AI models.
 * Uses Chrome's Page.captureSnapshot CDP method.
 */
export async function pageContext(_call: ToolCall, tabId: number): Promise<ToolAnswer> {
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const title = document.title
        const url = window.location.href
        const body = document.body?.innerText?.trim() ?? ''
        return { title, url, body: body.substring(0, 5000) }
      },
    })

    if (result[0]?.result) {
      const { title, url, body } = result[0].result as { title: string; url: string; body: string }
      return {
        ok: true,
        result: {
          text: wrapUntrustedContent(`Page: ${title}\nURL: ${url}\n\n${body}`, 10000),
        },
      }
    }
    return unavailableError('Could not extract page context.')
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return unavailableError(`Page context failed: ${msg}`)
  }
}

/** Dispatch API-based tools. */
export async function dispatchApiTool(call: ToolCall, tabId: number): Promise<ToolAnswer> {
  switch (call.name) {
    case 'browser_download_media':
      return downloadMedia(call, tabId)
    case 'browser_list_downloads':
      return listDownloads(call)
    case 'browser_bookmarks_search':
      return bookmarksSearch(call)
    case 'browser_bookmarks_add':
      return bookmarksAdd(call)
    case 'browser_bookmarks_remove':
      return bookmarksRemove(call)
    case 'browser_bookmarks_update':
      return bookmarksUpdate(call)
    case 'browser_bookmarks_list':
      return bookmarksList(call)
    case 'browser_bookmarks_move':
      return bookmarksMove(call)
    case 'browser_history':
      return history(call)
    case 'browser_tab_groups_list':
      return tabGroupsList()
    case 'browser_tab_groups_create':
      return tabGroupsCreate(call)
    case 'browser_tab_groups_remove':
      return tabGroupsRemove(call)
    case 'browser_page_context':
      return pageContext(call, tabId)
    default:
      return unavailableError(`Unknown API tool: ${call.name}`)
  }
}