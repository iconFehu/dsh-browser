import { NativeClient } from './native-client.js'
import { ChromeBrowserApi, ChromeCdpApi } from './chrome-browser-api.js'
import { CapabilityRegistry } from '../../src/shared/capability-registry.js'
import { registerBasicCapabilities } from '../../src/shared/basic-capabilities.js'
import { registerCdpCapability } from '../../src/shared/cdp-capability.js'
import { registerPageAssetsCapability } from '../../src/shared/page-assets-capability.js'
import { ChromePageAssetsApi } from './page-assets-api.js'
import { registerWebMcpCapability } from '../../src/shared/webmcp-capability.js'
import { ChromeWebMcpApi } from './webmcp-api.js'
import { registerBrowserAuthCapability } from '../../src/shared/browser-auth-capability.js'
import { ChromeBrowserAuthApi } from './browser-auth-api.js'

const native = new NativeClient()
const registry = new CapabilityRegistry()
registerBasicCapabilities(registry, new ChromeBrowserApi())
registerCdpCapability(registry, new ChromeCdpApi())
registerPageAssetsCapability(registry, new ChromePageAssetsApi())
registerWebMcpCapability(registry, new ChromeWebMcpApi())
registerBrowserAuthCapability(registry, new ChromeBrowserAuthApi())
const sessionTabs = new Map<string, number>()
const activeCalls = new Map<string, AbortController>()

async function sendBrowserAction(tabId: number, action: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    const [capability, ...methodParts] = action.split('.')
    return await chrome.tabs.sendMessage(tabId, { type: 'capability.action', capability, method: methodParts.join('.'), args })
  } catch (firstError) {
    const tab = await chrome.tabs.get(tabId)
    if (!tab.url || !/^https?:\/\//i.test(tab.url)) throw firstError
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] })
    const [capability, ...methodParts] = action.split('.')
    return chrome.tabs.sendMessage(tabId, { type: 'capability.action', capability, method: methodParts.join('.'), args })
  }
}

async function executeBrowserAction(tabId: number, action: string, args: Record<string, unknown>): Promise<unknown> {
  const normalized = action
    .replace(/^management\.tabs\./, '')
    .replace(/^pageAssets\./, '')
    .replace(/^browser[._]/, '')
  switch (normalized) {
    case 'navigate':
    case 'open': {
      if (typeof args.url !== 'string' || !/^https?:\/\//i.test(args.url)) throw new Error('A valid http(s) URL is required')
      await chrome.tabs.update(tabId, { url: args.url })
      return { navigated: true, url: args.url }
    }
    case 'back':
      await chrome.tabs.goBack(tabId)
      return { navigated: true, direction: 'back' }
    case 'forward':
      await chrome.tabs.goForward(tabId)
      return { navigated: true, direction: 'forward' }
    case 'reload':
      await chrome.tabs.reload(tabId, { bypassCache: args.bypassCache === true })
      return { reloaded: true }
    default:
      return sendBrowserAction(tabId, normalized, args)
  }
}

async function handleNativeEvent(event: unknown): Promise<void> {
  if (!event || typeof event !== 'object') return
  const frame = event as { t?: string; id?: string; capability?: string; method?: string; args?: Record<string, unknown>; tabId?: number; sessionId?: string }
  if (frame.t === 'capability.cancel' && typeof frame.id === 'string') {
    activeCalls.get(frame.id)?.abort()
    activeCalls.delete(frame.id)
    native.sendToolResult(frame.id, { ok: false, error: { code: 'cancelled', message: 'Browser capability call was cancelled.' } })
    return
  }
  if (frame.t !== 'capability.call' || typeof frame.id !== 'string' || typeof frame.capability !== 'string' || typeof frame.method !== 'string') return
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  const sessionId = frame.sessionId ?? 'default'
  const tabId = typeof frame.tabId === 'number' ? frame.tabId : sessionTabs.get(sessionId) ?? tabs[0]?.id
  if (tabId === undefined) {
    native.sendToolResult(frame.id, { ok: false, error: { code: 'no-active-tab', message: 'No active tab is available.' } })
    return
  }
  sessionTabs.set(sessionId, tabId)
  const controller = new AbortController()
  activeCalls.set(frame.id, controller)
  try {
    if (registry.has(frame.capability, frame.method)) {
      const result = await registry.call(frame.capability, frame.method, {
        sessionId,
        signal: controller.signal,
        tabId,
      }, frame.args ?? {})
      if (controller.signal.aborted) return
      native.sendToolResult(frame.id, { ok: true, result })
      return
    }
    const result = await executeBrowserAction(tabId, `${frame.capability}.${frame.method}`, frame.args ?? {}) as { ok?: boolean; error?: unknown; result?: unknown }
    if (controller.signal.aborted) return
    if (result?.ok === false) throw new Error(String(result.error ?? 'Browser action failed'))
    native.sendToolResult(frame.id, { ok: true, result: result?.result ?? result })
  } catch (error) {
    if (controller.signal.aborted) return
    native.sendToolResult(frame.id, { ok: false, error: { code: 'action-failed', message: error instanceof Error ? error.message : String(error) } })
  } finally {
    activeCalls.delete(frame.id)
  }
}

native.onEvent((event) => { void handleNativeEvent(event) })

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!message || typeof message !== 'object' || !('type' in message)) return false
  const type = (message as { type?: string }).type
  if (type === 'GET_CHATGPT_EXTENSION_STATUS') {
    sendResponse({ ok: true, state: {
      browserContext: { instanceId: null },
      browserControl: { phase: 'idle' },
      capabilities: {
        'browserControl.state.read': true,
        'browserSideChat.tabContext.read': true,
        'nativeHost.status': native.isConnected,
        'website.action.request': true,
      },
      extension: { channel: 'dev' },
    } })
    return false
  }
  if (type === 'GET_CHATGPT_BROWSER_TAB_CONTEXT') {
    void chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((tabs) => {
      const tab = tabs[0]
      sendResponse(tab?.id === undefined ? { ok: false, error: 'No active tab' } : { ok: true, tabId: tab.id, title: tab.title, url: tab.url, faviconUrl: tab.favIconUrl })
    }).catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }))
    return true
  }
  if (type === 'OPEN_CODEX_SIDE_PANEL') {
    void chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(async (tabs) => {
      const tabId = tabs[0]?.id
      if (tabId === undefined) throw new Error('No active tab')
      await chrome.sidePanel.open({ tabId })
      sendResponse({ ok: true })
    }).catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }))
    return true
  }
  if (type === 'SHOW_CODEX_INSTALLER') {
    sendResponse({ ok: false, error: 'Codex installer is not bundled with dsh-browser-native.' })
    return false
  }
  return false
})

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [sessionId, boundTabId] of sessionTabs) {
    if (boundTabId === tabId) sessionTabs.delete(sessionId)
  }
})

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  for (const [sessionId, boundTabId] of sessionTabs) {
    if (boundTabId === removedTabId) sessionTabs.set(sessionId, addedTabId)
  }
})

chrome.runtime.onMessage.addListener((message: unknown, sender) => {
  if (!message || typeof message !== 'object' || !('capability' in message)) return false
  const request = message as { capability: string; method: string; args?: unknown; sessionId?: string }
  const tabId = sender.tab?.id
  const local = new Set(['management', 'viewport', 'visibility'])
  if (!local.has(request.capability)) return false
  return registry.call(request.capability, request.method, {
    sessionId: request.sessionId ?? 'extension',
    signal: new AbortController().signal,
    tabId,
  }, request.args ?? {}).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }))
})

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!message || typeof message !== 'object' || !('type' in message) || (message as { type?: string }).type !== 'capability.request') return false
  const request = message as unknown as { capability: string; method: string; args?: Record<string, unknown>; sessionId?: string }
  const tabId = sender.tab?.id ?? (typeof request.args?.tabId === 'number' ? request.args.tabId : undefined)
  void native.call(request.capability, request.method, request.args ?? {}, request.sessionId ?? 'extension').then((result) => sendResponse({ ok: true, result })).catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }))
  return true
})

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!message || typeof message !== 'object' || !('type' in message) || (message as { type?: string }).type !== 'page.snapshot') return false
  void chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(async (tabs) => {
    const tabId = tabs[0]?.id
    if (tabId === undefined) throw new Error('No active tab is available.')
    return sendBrowserAction(tabId, 'snapshot', {})
  }).then((result) => sendResponse(result)).catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }))
  return true
})

void native
