/**
 * Executors for the remaining high-level capabilities, modeled on ChatGPT's
 * browser extension:
 *
 * - `browserAuth.request` is a sign-in handoff. The user types credentials on
 *   the page; only a status ever returns, never a field value.
 * - `pageAssets.list` inventories observed assets; `bundle` saves the selected
 *   ones into Downloads and returns file names and counts, never contents.
 * - `viewport.*` emulates a size through the shared CDP manager, so it obeys
 *   the developer-mode switch and disappears whenever CDP detaches.
 * - `visibility.*`, `botDetection.report`, and the extra `management.*`
 *   methods use plain extension APIs.
 *
 * State-changing calls go through `authorize`; the handoff goes through
 * `handoff`, which always asks the user.
 *
 * @module
 */

import type { ToolAnswer, ToolCall } from './tools.ts'
import type { ApprovalAuthorization, ApprovalPrompt } from '../security/approval.ts'
import { wrapUntrustedContent } from '../security/untrusted.ts'
import { getUiLocale } from '../i18n.ts'
import type { BrowserEventLog } from './browser-events.ts'
import { CdpUnavailableError } from './cdp/manager.ts'

/** Capabilities that act on the controlled tab. */
export const TAB_CAPABILITY_TOOL_NAMES: ReadonlySet<string> = new Set([
  'browserAuth.request',
  'botDetection.report',
  'pageAssets.list',
  'pageAssets.bundle',
  'viewport.get',
  'viewport.set',
  'viewport.reset',
])

/** Browser-level capabilities that need no controlled tab. */
export const BROWSER_CAPABILITY_TOOL_NAMES: ReadonlySet<string> = new Set([
  'management.windows.list',
  'management.tabs.update',
  'management.tabGroups.update',
  'management.downloads.cancel',
  'management.events',
  'visibility.get',
  'visibility.set',
])

export type BotDetectionReason = 'captcha_failed' | 'access_denied' | 'challenge_loop' | 'unexpected_bot_error'
const BOT_REASONS: readonly BotDetectionReason[] = ['captcha_failed', 'access_denied', 'challenge_loop', 'unexpected_bot_error']

export type HandoffStatus = 'submitted' | 'declined' | 'cancelled' | 'unavailable' | 'expired' | 'origin_changed' | 'page_changed'

export interface CapabilityCdp {
  readonly available: boolean
  attach(tabId: number): Promise<void>
  send(method: string, params?: Record<string, unknown>): Promise<unknown>
  attachedTab(): number | undefined
}

export interface CapabilityDeps {
  /** The controlled tab; absent for browser-level calls. */
  tab?: Pick<chrome.tabs.Tab, 'id' | 'url' | 'windowId'>
  sharePageContent: 'ask' | 'auto' | 'off'
  /** Ordinary approval (may be satisfied by unrestricted access). */
  authorize: (prompt: ApprovalPrompt) => Promise<ApprovalAuthorization>
  /** Always shown to the user; resolves when they finish, decline, or time out. */
  handoff: (prompt: ApprovalPrompt, timeoutMs: number) => Promise<ApprovalAuthorization>
  cdp: CapabilityCdp
  events: BrowserEventLog
  notifyBotDetection: (report: { reason: BotDetectionReason; hostname: string | null }) => void
  signal: AbortSignal
}

const MAX_HANDOFF_MS = 5 * 60_000
const MAX_INVENTORY_ASSETS = 300
const MAX_BUNDLE_ASSETS = 50
const MAX_INVENTORIES = 20
const LIST_TEXT_MAX = 40_000

type AssetKind = 'font' | 'image' | 'stylesheet' | 'video' | 'other'
interface AssetRecord { id: string; url: string; kind: AssetKind; type: string }
interface Inventory { tabId: number; documentUrl: string; assets: AssetRecord[] }

const inventories = new Map<string, Inventory>()
const viewportOverrides = new Map<number, { width: number; height: number }>()

function zh(): boolean {
  return getUiLocale() === 'zh'
}

function text(value: unknown): ToolAnswer {
  return { ok: true, result: { text: typeof value === 'string' ? value : JSON.stringify(value) } }
}

function failure(message: string, code: 'action-failed' | 'feature-unavailable' | 'content-unavailable' = 'action-failed'): ToolAnswer {
  return { ok: false, error: { code, message } }
}

function originOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : undefined
  } catch {
    return undefined
  }
}

function integer(value: unknown, min = 0): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min ? value : undefined
}

function actionPrompt(action: string, summary: string, origins: string[] = []): ApprovalPrompt {
  return { kind: 'action', action, summary, origins, canTrust: false }
}

async function approved(deps: CapabilityDeps, prompt: ApprovalPrompt): Promise<ToolAnswer | undefined> {
  const authorization = await deps.authorize(prompt)
  if (deps.signal.aborted) return failure(`${prompt.action} was cancelled.`)
  return authorization === 'approved' ? undefined : failure(`${prompt.action} was not approved (${authorization}).`)
}

function requireTab(deps: CapabilityDeps, name: string): { id: number; url: string | undefined; windowId: number } | ToolAnswer {
  const tab = deps.tab
  if (tab?.id === undefined) return failure(`${name} needs a controlled tab. Call management.tabs.list and management.tabs.activate first.`, 'content-unavailable')
  return { id: tab.id, url: tab.url, windowId: tab.windowId }
}

/** Dispatch one capability call. Unknown names answer an error instead of throwing. */
export async function dispatchCapabilityTool(call: ToolCall, deps: CapabilityDeps): Promise<ToolAnswer> {
  try {
    switch (call.name) {
      case 'management.windows.list': return await windowsList()
      case 'management.tabs.update': return await tabsUpdate(call, deps)
      case 'management.tabGroups.update': return await tabGroupsUpdate(call, deps)
      case 'management.downloads.cancel': return await downloadsCancel(call, deps)
      case 'management.events': return await events(call, deps)
      case 'visibility.get': return await visibilityGet(deps)
      case 'visibility.set': return await visibilitySet(call, deps)
      case 'botDetection.report': return await botDetectionReport(call, deps)
      case 'browserAuth.request': return await browserAuthRequest(call, deps)
      case 'pageAssets.list': return await pageAssetsList(call, deps)
      case 'pageAssets.bundle': return await pageAssetsBundle(call, deps)
      case 'viewport.get': return await viewportGet(deps)
      case 'viewport.set': return await viewportSet(call, deps)
      case 'viewport.reset': return await viewportReset(deps)
      default: return failure(`Unknown capability method: ${call.name}`)
    }
  } catch (error) {
    if (error instanceof CdpUnavailableError) return failure(error.message, 'feature-unavailable')
    return failure(error instanceof Error ? error.message : String(error))
  }
}

async function windowsList(): Promise<ToolAnswer> {
  const windows = await chrome.windows.getAll()
  return text({
    windows: windows.filter((window) => window.id !== undefined).map((window) => ({
      windowId: window.id,
      focused: window.focused,
      state: window.state,
      type: window.type,
      width: window.width,
      height: window.height,
    })),
  })
}

async function tabsUpdate(call: ToolCall, deps: CapabilityDeps): Promise<ToolAnswer> {
  const tabId = integer(call.args.tabId)
  if (tabId === undefined) return failure('management.tabs.update requires a tabId from management.tabs.list.')

  const booleanKeys = ['active', 'autoDiscardable', 'highlighted', 'muted', 'pinned'] as const
  const update: chrome.tabs.UpdateProperties = {}
  for (const key of booleanKeys) {
    if (call.args[key] !== undefined && typeof call.args[key] !== 'boolean') {
      return failure(`management.tabs.update ${key} must be boolean.`)
    }
    if (typeof call.args[key] === 'boolean') update[key] = call.args[key] as boolean
  }
  if (call.args.selected !== undefined) {
    if (typeof call.args.selected !== 'boolean') return failure('management.tabs.update selected must be boolean.')
    // Chrome deprecated selected in favor of highlighted; map when highlighted is omitted.
    if (update.highlighted === undefined) update.highlighted = call.args.selected
  }
  if (call.args.openerTabId !== undefined) {
    const openerTabId = integer(call.args.openerTabId)
    if (openerTabId === undefined) return failure('management.tabs.update openerTabId must be a non-negative integer.')
    update.openerTabId = openerTabId
  }
  if (call.args.url !== undefined) {
    if (typeof call.args.url !== 'string') return failure('management.tabs.update url must be a string.')
    try {
      const parsed = new URL(call.args.url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return failure('management.tabs.update url must be a valid http(s) URL (javascript: and other schemes are not allowed).')
      }
      update.url = parsed.href
    } catch {
      return failure('management.tabs.update url must be a valid http(s) URL (javascript: and other schemes are not allowed).')
    }
  }

  if (Object.keys(update).length === 0) {
    const present = Object.keys(call.args).filter((key) => key !== 'tabId' && call.args[key] !== undefined)
    const hints: string[] = []
    if (present.includes('title')) hints.push('title is not supported (page titles are not writable via tabs.update)')
    if (present.includes('groupId')) hints.push('groupId belongs to management.tabs.group (or tabGroups.update for title/color)')
    if (present.includes('index')) hints.push('index belongs to management.tabs.move')
    const allowed = 'active, autoDiscardable, highlighted, muted, openerTabId, pinned, selected (alias of highlighted), url'
    let message = `management.tabs.update requires at least one of: ${allowed}.`
    if (hints.length > 0) message += ` ${hints.join(' ')}.`
    else if (present.length > 0) message += ` Unsupported fields: ${present.join(', ')}.`
    message += ' For navigation, url is allowed here, or use management.tabs.navigate.'
    return failure(message)
  }

  const before = await chrome.tabs.get(tabId).catch(() => undefined)
  if (before === undefined) return failure(`Tab ${tabId} is no longer open. Call management.tabs.list again.`, 'content-unavailable')

  const changes = Object.entries(update).map(([key, value]) => `${key}=${String(value)}`).join(', ')
  const currentOrigin = originOf(before.url)
  const destinationOrigin = update.url === undefined ? undefined : originOf(update.url)
  const origins: string[] = []
  if (update.url !== undefined) {
    // Treat url changes like navigation: include current and destination origins.
    if (currentOrigin !== undefined) origins.push(currentOrigin)
    if (destinationOrigin !== undefined && !origins.includes(destinationOrigin)) origins.push(destinationOrigin)
  } else if (currentOrigin !== undefined) {
    origins.push(currentOrigin)
  }

  let summary: string
  if (update.url !== undefined) {
    summary = zh()
      ? `导航标签页 ${tabId} 至 ${update.url}`
      : `Navigate tab ${tabId} to ${update.url}`
    const other = Object.entries(update).filter(([key]) => key !== 'url').map(([key, value]) => `${key}=${String(value)}`).join(', ')
    if (other.length > 0) summary += zh() ? `（同时 ${other}）` : ` (also ${other})`
  } else {
    summary = zh()
      ? `更新标签页 ${tabId}（${changes}）`
      : `Update tab ${tabId} (${changes})`
  }

  const rejected = await approved(deps, actionPrompt(call.name, summary, origins))
  if (rejected !== undefined) return rejected
  const after = await chrome.tabs.update(tabId, update)
  return text({
    tabId,
    active: after?.active,
    pinned: after?.pinned,
    muted: after?.mutedInfo?.muted,
    highlighted: after?.highlighted,
    autoDiscardable: after?.autoDiscardable,
    openerTabId: after?.openerTabId,
    url: after?.url,
    status: after?.status,
  })
}


async function tabGroupsUpdate(call: ToolCall, deps: CapabilityDeps): Promise<ToolAnswer> {
  const groupId = integer(call.args.groupId)
  if (groupId === undefined) return failure('management.tabGroups.update requires a groupId from management.tabGroups.list.')
  const update: chrome.tabGroups.UpdateProperties = {}
  if (typeof call.args.title === 'string') {
    if (call.args.title.length > 200) return failure('Tab group title must be at most 200 characters.')
    update.title = call.args.title
  }
  if (typeof call.args.color === 'string') update.color = call.args.color as chrome.tabGroups.ColorEnum
  if (typeof call.args.collapsed === 'boolean') update.collapsed = call.args.collapsed
  if (Object.keys(update).length === 0) return failure('management.tabGroups.update requires title, color, or collapsed.')
  const rejected = await approved(deps, actionPrompt(call.name, zh() ? `更新标签组 ${groupId}` : `Update tab group ${groupId}`))
  if (rejected !== undefined) return rejected
  const group = await chrome.tabGroups.update(groupId, update)
  return text({ groupId: group.id, title: group.title, color: group.color, collapsed: group.collapsed })
}

async function downloadsCancel(call: ToolCall, deps: CapabilityDeps): Promise<ToolAnswer> {
  const id = integer(call.args.id)
  if (id === undefined) return failure('management.downloads.cancel requires a download id from management.downloads.list.')
  if (typeof chrome.downloads?.cancel !== 'function') return failure('Downloads are not available in this browser.', 'feature-unavailable')
  const rejected = await approved(deps, actionPrompt(call.name, zh() ? `取消下载 ${id}` : `Cancel download ${id}`))
  if (rejected !== undefined) return rejected
  await chrome.downloads.cancel(id)
  return text({ cancelled: id })
}

async function events(call: ToolCall, deps: CapabilityDeps): Promise<ToolAnswer> {
  const afterSequence = call.args.afterSequence === undefined ? 0 : integer(call.args.afterSequence)
  const waitMs = call.args.waitMs === undefined ? 0 : integer(call.args.waitMs)
  if (afterSequence === undefined || waitMs === undefined) return failure('management.events afterSequence and waitMs must be non-negative integers.')
  return text(await deps.events.read(afterSequence, waitMs, deps.signal))
}

async function visibilityWindow(deps: CapabilityDeps): Promise<chrome.windows.Window> {
  return deps.tab?.windowId !== undefined ? chrome.windows.get(deps.tab.windowId) : chrome.windows.getLastFocused()
}

async function visibilityGet(deps: CapabilityDeps): Promise<ToolAnswer> {
  const window = await visibilityWindow(deps)
  return text({ visible: window.state !== 'minimized', windowId: window.id })
}

async function visibilitySet(call: ToolCall, deps: CapabilityDeps): Promise<ToolAnswer> {
  const visible = call.args.visible
  if (typeof visible !== 'boolean') return failure('visibility.set requires boolean visible.')
  const window = await visibilityWindow(deps)
  if (window.id === undefined) return failure('No browser window is available.', 'content-unavailable')
  const rejected = await approved(deps, actionPrompt(
    call.name,
    visible
      ? (zh() ? '显示浏览器窗口' : 'Show the browser window')
      : (zh() ? '最小化浏览器窗口' : 'Minimize the browser window'),
  ))
  if (rejected !== undefined) return rejected
  await chrome.windows.update(window.id, visible ? { state: 'normal', focused: true } : { state: 'minimized' })
  return text({ visible })
}

async function botDetectionReport(call: ToolCall, deps: CapabilityDeps): Promise<ToolAnswer> {
  const reason = call.args.reason
  if (typeof reason !== 'string' || !BOT_REASONS.includes(reason as BotDetectionReason)) return failure('botDetection.report requires a supported reason.')
  const hostname = deps.tab?.url === undefined ? null : (() => { try { return new URL(deps.tab.url).hostname } catch { return null } })()
  deps.notifyBotDetection({ reason: reason as BotDetectionReason, hostname })
  return text({ status: 'reported', hostname, note: 'The user was told the page is blocked. Wait for them to resolve it; do not retry the challenge.' })
}

function safeLabel(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 60) : ''
}

async function browserAuthRequest(call: ToolCall, deps: CapabilityDeps): Promise<ToolAnswer> {
  const tab = requireTab(deps, call.name)
  if ('ok' in tab) return tab
  const requested = originOf(typeof call.args.origin === 'string' ? call.args.origin : undefined)
  if (requested === undefined) return failure('browserAuth.request origin must be an http(s) origin.')
  const current = originOf(tab.url)
  if (current !== requested) return text({ status: 'origin_changed' satisfies HandoffStatus })
  const fields = Array.isArray(call.args.fields) ? call.args.fields : []
  const labels = fields
    .map((field) => (typeof field === 'object' && field !== null ? safeLabel((field as { label?: unknown }).label) : ''))
    .filter((label) => label !== '')
    .slice(0, 6)
  const list = labels.length === 0 ? '' : labels.join(zh() ? '、' : ', ')
  const remaining = call.expiresAt === undefined ? MAX_HANDOFF_MS : call.expiresAt - Date.now() - 2_000
  if (remaining <= 0) return text({ status: 'expired' satisfies HandoffStatus })
  const authorization = await deps.handoff({
    kind: 'handoff',
    action: call.name,
    summary: zh()
      ? `请直接在页面上登录${list === '' ? '' : `（${list}）`}。你输入的内容不会发给助手。完成后点「我已登录」。`
      : `Sign in on the page yourself${list === '' ? '' : ` (${list})`}. What you type is never sent to the assistant. Choose "I've signed in" when done.`,
    origins: [requested],
    canTrust: false,
  }, Math.min(MAX_HANDOFF_MS, remaining))
  const status: HandoffStatus = authorization === 'approved'
    ? 'submitted'
    : authorization === 'denied'
      ? 'declined'
      : authorization === 'timed-out'
        ? 'expired'
        : authorization
  if (status !== 'submitted') return text({ status })
  const after = await chrome.tabs.get(tab.id).catch(() => undefined)
  if (after === undefined) return text({ status: 'page_changed' satisfies HandoffStatus })
  return text({ status, currentOrigin: originOf(after.url) ?? null })
}

function classifyAsset(url: string, type: string): AssetKind {
  const lower = type.toLowerCase()
  if (lower.includes('font') || /\.(woff2?|ttf|otf)(\?|$)/i.test(url)) return 'font'
  if (lower.includes('image') || lower === 'img' || lower === 'icon') return 'image'
  if (lower.includes('stylesheet') || /\.css(\?|$)/i.test(url)) return 'stylesheet'
  if (lower === 'video' || lower === 'audio' || lower === 'source') return 'video'
  return 'other'
}

/** Runs in the page's isolated world; reads element attributes only. */
function collectAssetUrls(): Array<{ url: string; type: string }> {
  const entries: Array<{ url: string; type: string }> = []
  for (const link of Array.from(document.querySelectorAll('link[href]'))) {
    const node = link as HTMLLinkElement
    entries.push({ url: node.href, type: node.as || node.rel || node.type || '' })
  }
  for (const image of Array.from(document.images)) entries.push({ url: image.currentSrc || image.src, type: 'img' })
  for (const media of Array.from(document.querySelectorAll('video, audio, source'))) {
    const node = media as HTMLMediaElement | HTMLSourceElement
    const src = 'currentSrc' in node && node.currentSrc ? node.currentSrc : node.src
    if (src) entries.push({ url: src, type: node.tagName.toLowerCase() })
  }
  return entries
}

async function pageAssetsList(call: ToolCall, deps: CapabilityDeps): Promise<ToolAnswer> {
  const tab = requireTab(deps, call.name)
  if ('ok' in tab) return tab
  if (deps.sharePageContent === 'off') return failure('Page content sharing is disabled in Settings > Page content sharing.')
  const origin = originOf(tab.url)
  if (origin === undefined) return failure('The controlled tab is not a normal web page.', 'content-unavailable')
  if (deps.sharePageContent === 'ask') {
    const authorization = await deps.authorize({
      kind: 'read',
      action: call.name,
      summary: zh() ? '列出当前页面加载的图片、字体、样式表和媒体地址' : 'List the images, fonts, stylesheets, and media the current page loaded',
      origins: [origin],
      canTrust: false,
    })
    if (authorization !== 'approved') return failure(`${call.name} was not approved (${authorization}).`)
  }
  const result = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: collectAssetUrls })
  const raw = (result[0]?.result ?? []) as Array<{ url: string; type: string }>
  const seen = new Set<string>()
  const assets: AssetRecord[] = []
  for (const entry of raw) {
    if (typeof entry?.url !== 'string' || !/^https?:\/\//i.test(entry.url) || seen.has(entry.url)) continue
    seen.add(entry.url)
    assets.push({ id: `asset-${assets.length + 1}`, url: entry.url, kind: classifyAsset(entry.url, String(entry.type ?? '')), type: String(entry.type ?? '') })
    if (assets.length >= MAX_INVENTORY_ASSETS) break
  }
  const inventoryId = crypto.randomUUID()
  inventories.set(inventoryId, { tabId: tab.id, documentUrl: tab.url ?? '', assets })
  while (inventories.size > MAX_INVENTORIES) inventories.delete(inventories.keys().next().value!)
  return text(wrapUntrustedContent(JSON.stringify({ inventoryId, assets: assets.map(({ id, url, kind }) => ({ id, url, kind })) }), LIST_TEXT_MAX))
}

function assetFileName(asset: AssetRecord, index: number): string {
  let base = ''
  try { base = decodeURIComponent(new URL(asset.url).pathname.split('/').pop() ?? '') } catch { base = '' }
  base = base.replace(/[^\w.\-]+/g, '_').replace(/^\.+/, '').slice(0, 80)
  return `${String(index + 1).padStart(3, '0')}-${base === '' ? asset.kind : base}`
}

async function pageAssetsBundle(call: ToolCall, deps: CapabilityDeps): Promise<ToolAnswer> {
  const tab = requireTab(deps, call.name)
  if ('ok' in tab) return tab
  if (typeof chrome.downloads?.download !== 'function') return failure('Saving files is not available in this browser.', 'feature-unavailable')
  const inventoryId = typeof call.args.inventoryId === 'string' ? call.args.inventoryId : ''
  const inventory = inventories.get(inventoryId)
  if (inventory === undefined) return failure('Unknown inventoryId. Call pageAssets.list again.', 'content-unavailable')
  if (inventory.tabId !== tab.id || inventory.documentUrl !== (tab.url ?? '')) {
    return failure('The page changed since pageAssets.list. Call pageAssets.list again.', 'content-unavailable')
  }
  const ids = Array.isArray(call.args.assetIds) ? new Set(call.args.assetIds.filter((id): id is string => typeof id === 'string')) : undefined
  const kinds = Array.isArray(call.args.kinds) ? new Set(call.args.kinds.map(String)) : undefined
  const selected = inventory.assets.filter((asset) => (ids === undefined || ids.has(asset.id)) && (kinds === undefined || kinds.has(asset.kind)))
  if (selected.length === 0) return failure('No assets match the requested assetIds or kinds.')
  if (selected.length > MAX_BUNDLE_ASSETS) return failure(`Select at most ${MAX_BUNDLE_ASSETS} assets per bundle.`)
  const directory = `dsh-browser-assets/${new Date().toISOString().replace(/[:.]/g, '-')}`
  const origin = originOf(tab.url)
  const rejected = await approved(deps, actionPrompt(
    call.name,
    zh()
      ? `把这个页面的 ${selected.length} 个资源保存到「下载/${directory}」`
      : `Save ${selected.length} assets from this page to Downloads/${directory}`,
    origin === undefined ? [] : [origin],
  ))
  if (rejected !== undefined) return rejected
  const saved: Array<{ id: string; file: string; downloadId: number }> = []
  const failures: Array<{ id: string; reason: string }> = []
  for (const [index, asset] of selected.entries()) {
    if (deps.signal.aborted) break
    const file = `${directory}/${assetFileName(asset, index)}`
    try {
      const downloadId = await chrome.downloads.download({ url: asset.url, filename: file, conflictAction: 'uniquify', saveAs: false })
      saved.push({ id: asset.id, file, downloadId })
    } catch (error) {
      failures.push({ id: asset.id, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return text({
    directory: `Downloads/${directory}`,
    saved,
    failures,
    summary: { requestedCount: selected.length, startedCount: saved.length, failedCount: failures.length },
    note: 'Files were saved locally for the user; their contents were not read.',
  })
}

function activeOverride(tabId: number, cdp: CapabilityCdp): { width: number; height: number } | undefined {
  // Detaching the debugger clears Emulation overrides; forget stale entries.
  if (cdp.attachedTab() !== tabId) viewportOverrides.delete(tabId)
  return viewportOverrides.get(tabId)
}

async function viewportGet(deps: CapabilityDeps): Promise<ToolAnswer> {
  const tab = requireTab(deps, 'viewport.get')
  if ('ok' in tab) return tab
  const override = activeOverride(tab.id, deps.cdp)
  if (override !== undefined) return text({ ...override, override: true })
  const window = await chrome.windows.get(tab.windowId)
  return text({ width: window.width, height: window.height, override: false, note: 'Window outer size; no override is active.' })
}

async function viewportSet(call: ToolCall, deps: CapabilityDeps): Promise<ToolAnswer> {
  const tab = requireTab(deps, call.name)
  if ('ok' in tab) return tab
  const width = integer(call.args.width, 320)
  const height = integer(call.args.height, 240)
  if (width === undefined || height === undefined || width > 10_000 || height > 10_000) return failure('viewport.set requires integer width 320-10000 and height 240-10000.')
  if (!deps.cdp.available) return failure('Viewport overrides need Chrome DevTools Protocol, which this browser does not provide.', 'feature-unavailable')
  if (originOf(tab.url) === undefined) return failure('The controlled tab is not a normal web page.', 'content-unavailable')
  const origin = originOf(tab.url)
  const rejected = await approved(deps, actionPrompt(
    call.name,
    zh() ? `把受控标签页模拟为 ${width}×${height} 的视口` : `Emulate a ${width}×${height} viewport on the controlled tab`,
    origin === undefined ? [] : [origin],
  ))
  if (rejected !== undefined) return rejected
  await deps.cdp.attach(tab.id)
  await deps.cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  viewportOverrides.set(tab.id, { width, height })
  return text({ width, height, override: true, note: 'Call viewport.reset before finishing unless the user asked to keep this size.' })
}

async function viewportReset(deps: CapabilityDeps): Promise<ToolAnswer> {
  const tab = requireTab(deps, 'viewport.reset')
  if ('ok' in tab) return tab
  if (activeOverride(tab.id, deps.cdp) === undefined) return text({ reset: true, note: 'No viewport override was active.' })
  await deps.cdp.send('Emulation.clearDeviceMetricsOverride', {})
  viewportOverrides.delete(tab.id)
  return text({ reset: true })
}

/** Test hook: forget module-level inventories and overrides. */
export function resetCapabilityState(): void {
  inventories.clear()
  viewportOverrides.clear()
}
