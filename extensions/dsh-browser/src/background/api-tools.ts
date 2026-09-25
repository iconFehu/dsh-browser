/**
 * Tool executors backed by Chrome extension APIs (bookmarks, history,
 * downloads, tab groups). These run in the background service worker
 * rather than the content script.
 *
 * @module
 */

import type { ToolCall, ToolAnswer } from './tools.ts'
import type { ApprovalAuthorization, ApprovalPrompt } from '../security/approval.ts'
import { wrapUntrustedContent } from '../security/untrusted.ts'
import { getUiLocale } from '../i18n.ts'

export const API_TOOL_NAMES: ReadonlySet<string> = new Set([
  'pageAssets.downloadMedia',
  'management.downloads.list',
  'management.bookmarks.search',
  'management.bookmarks.create',
  'management.bookmarks.delete',
  'management.bookmarks.update',
  'management.bookmarks.list',
  'management.bookmarks.move',
  'management.history.search',
  'management.tabGroups.list',
  'management.tabGroups.create',
  'management.tabGroups.ungroup',
  'pageAssets.pageContext',
])

/** API tools that change browser state and therefore need the user's approval. */
const MUTATING_API_TOOLS: ReadonlySet<string> = new Set([
  'pageAssets.downloadMedia',
  'management.bookmarks.create',
  'management.bookmarks.delete',
  'management.bookmarks.update',
  'management.bookmarks.move',
  'management.tabGroups.create',
  'management.tabGroups.ungroup',
])

function unavailableError(message: string): ToolAnswer {
  return { ok: false, error: { code: 'action-failed', message } }
}

/** The approval prompt for a state-changing API tool, or undefined for reads. */
export function apiToolApproval(call: ToolCall): ApprovalPrompt | undefined {
  if (!MUTATING_API_TOOLS.has(call.name)) return undefined
  const zh = getUiLocale() === 'zh'
  return {
    kind: 'action',
    action: call.name,
    summary: zh ? `执行浏览器操作 ${call.name}` : `Run browser operation ${call.name}`,
    origins: [],
    canTrust: false,
  }
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
    if (typeof chrome.tabGroups?.query !== 'function') {
      return unavailableError('Tab groups are only available in Chrome.')
    }
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
 * Create a new tab group from explicit tabIds (Chrome cannot create empty groups).
 * Prefer management.tabs.group({ tabIds }) then tabGroups.update for title/color.
 */
export async function tabGroupsCreate(call: ToolCall): Promise<ToolAnswer> {
  try {
    if (typeof chrome.tabs?.group !== 'function' || typeof chrome.tabGroups?.update !== 'function') {
      return unavailableError('Tab groups are only available in Chrome.')
    }
    const raw = call.args.tabIds
    let tabIds: number[] | undefined
    if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) tabIds = [raw]
    else if (Array.isArray(raw) && raw.length > 0 && raw.every((id) => typeof id === 'number' && Number.isSafeInteger(id) && id >= 0)) {
      tabIds = raw as number[]
    }
    if (tabIds === undefined) {
      return unavailableError('management.tabGroups.create requires tabIds (at least one). Chrome cannot create empty tab groups. Prefer management.tabs.group({ tabIds }) then management.tabGroups.update({ groupId, title, color }).')
    }
    const title = typeof call.args.title === 'string' ? call.args.title : undefined
    const color = typeof call.args.color === 'string' ? call.args.color : undefined
    const collapsed = typeof call.args.collapsed === 'boolean' ? call.args.collapsed : undefined

    const groupId = await chrome.tabs.group({ tabIds: tabIds.length === 1 ? tabIds[0]! : tabIds })
    const update: chrome.tabGroups.UpdateProperties = {}
    if (title !== undefined) {
      if (title.length > 200) return unavailableError('Tab group title must be at most 200 characters.')
      update.title = title
    }
    if (color !== undefined) update.color = color as chrome.tabGroups.ColorEnum
    if (collapsed !== undefined) update.collapsed = collapsed
    if (Object.keys(update).length > 0) {
      await chrome.tabGroups.update(groupId, update)
    }
    const named = title ? `: ${title}` : ''
    return { ok: true, result: { text: `Tab group created [${groupId}] with tabs [${tabIds.join(', ')}]${named}.` } }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return unavailableError(`Tab groups create failed: ${msg}`)
  }
}

/**
 * Dissolve a tab group by groupId (tabs stay open).
 * For removing specific tabs from groups, use management.tabs.ungroup({ tabIds }).
 */
export async function tabGroupsRemove(call: ToolCall): Promise<ToolAnswer> {
  try {
    if (typeof chrome.tabs?.ungroup !== 'function') {
      return unavailableError('Tab groups are only available in Chrome.')
    }
    const groupId = typeof call.args.groupId === 'number' ? call.args.groupId : undefined
    if (groupId === undefined) {
      return unavailableError('management.tabGroups.ungroup requires groupId. To ungroup specific tabs, use management.tabs.ungroup({ tabIds }).')
    }
    const tabs = await chrome.tabs.query({ groupId })
    if (tabs.length > 0) {
      const ids = tabs.map((t) => t.id!).filter((id): id is number => typeof id === 'number')
      await chrome.tabs.ungroup(ids.length === 1 ? ids[0]! : ids)
    }
    return { ok: true, result: { text: `Tab group ${groupId} removed (tabs ungrouped, not closed).` } }
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

/** Dispatch API-based tools; state-changing ones wait for `authorize` first. */
export async function dispatchApiTool(
  call: ToolCall,
  tabId: number,
  authorize?: (prompt: ApprovalPrompt) => Promise<ApprovalAuthorization>,
): Promise<ToolAnswer> {
  const prompt = apiToolApproval(call)
  if (prompt !== undefined) {
    const authorization = authorize === undefined ? 'unavailable' : await authorize(prompt)
    if (authorization !== 'approved') {
      return { ok: false, error: { code: 'action-failed', message: `${call.name} was not approved (${authorization}).` } }
    }
  }
  switch (call.name) {
    case 'pageAssets.downloadMedia':
      return downloadMedia(call, tabId)
    case 'management.downloads.list':
      return listDownloads(call)
    case 'management.bookmarks.search':
      return bookmarksSearch(call)
    case 'management.bookmarks.create':
      return bookmarksAdd(call)
    case 'management.bookmarks.delete':
      return bookmarksRemove(call)
    case 'management.bookmarks.update':
      return bookmarksUpdate(call)
    case 'management.bookmarks.list':
      return bookmarksList(call)
    case 'management.bookmarks.move':
      return bookmarksMove(call)
    case 'management.history.search':
      return history(call)
    case 'management.tabGroups.list':
      return tabGroupsList()
    case 'management.tabGroups.create':
      return tabGroupsCreate(call)
    case 'management.tabGroups.ungroup':
      return tabGroupsRemove(call)
    case 'pageAssets.pageContext':
      return pageContext(call, tabId)
    default:
      return unavailableError(`Unknown API tool: ${call.name}`)
  }
}