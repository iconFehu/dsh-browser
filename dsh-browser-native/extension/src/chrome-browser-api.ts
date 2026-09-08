import type { BrowserApi, BrowserTab, BrowserWindow } from '../../src/shared/browser-api.js'
import type { CdpApi } from '../../src/shared/cdp-capability.js'

export class ChromeBrowserApi implements BrowserApi {
  private readonly viewportOverrides = new Map<number, { width: number; height: number }>()
  private readonly debuggerTabs = new Set<number>()
  async getWindows(): Promise<readonly BrowserWindow[]> {
    const windows = await chrome.windows.getAll()
    return windows.filter((window) => window.id !== undefined).map((window) => ({ id: window.id!, focused: window.focused, state: window.state }))
  }

  async updateWindow(windowId: number, update: { state?: string; focused?: boolean }): Promise<BrowserWindow> {
    const window = await chrome.windows.update(windowId, update as chrome.windows.UpdateInfo)
    if (window.id === undefined) throw new Error('Chrome returned a window without an id')
    return { id: window.id, focused: window.focused, state: window.state }
  }

  async getTabs(query?: { windowId?: number; active?: boolean }): Promise<readonly BrowserTab[]> {
    const tabs = await chrome.tabs.query({ windowId: query?.windowId, active: query?.active })
    return tabs.filter((tab) => tab.id !== undefined && tab.windowId !== undefined).map((tab) => ({ id: tab.id!, windowId: tab.windowId!, title: tab.title, url: tab.url, active: tab.active }))
  }

  async updateTab(tabId: number, update: { active?: boolean; pinned?: boolean; muted?: boolean }): Promise<BrowserTab> {
    const tab = await chrome.tabs.update(tabId, update)
    if (tab.id === undefined || tab.windowId === undefined) throw new Error('Chrome returned a tab without an id')
    return { id: tab.id, windowId: tab.windowId, title: tab.title, url: tab.url, active: tab.active }
  }

  async removeTabs(tabIds: readonly number[]): Promise<void> { await chrome.tabs.remove([...tabIds]) }

  async getViewport(tabId: number): Promise<{ width: number; height: number }> {
    const override = this.viewportOverrides.get(tabId)
    if (override) return override
    const tab = await chrome.tabs.get(tabId)
    if (tab.windowId === undefined) throw new Error('Tab has no window')
    const window = await chrome.windows.get(tab.windowId)
    return { width: window.width ?? 0, height: window.height ?? 0 }
  }

  async setViewport(tabId: number, viewport: { width: number; height: number } | undefined): Promise<void> {
    const target = { tabId }
    if (!this.debuggerTabs.has(tabId)) {
      await chrome.debugger.attach(target, '1.3')
      this.debuggerTabs.add(tabId)
    }
    if (viewport === undefined) {
      await chrome.debugger.sendCommand(target, 'Emulation.clearDeviceMetricsOverride')
      this.viewportOverrides.delete(tabId)
      await chrome.debugger.detach(target).catch(() => {})
      this.debuggerTabs.delete(tabId)
      return
    }
    await chrome.debugger.sendCommand(target, 'Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
    })
    this.viewportOverrides.set(tabId, viewport)
  }

  async isVisible(): Promise<boolean> {
    const current = await chrome.windows.getLastFocused()
    return current.state !== 'minimized'
  }

  async setVisible(visible: boolean): Promise<void> {
    const current = await chrome.windows.getLastFocused()
    if (current.id === undefined) throw new Error('No focused window')
    await chrome.windows.update(current.id, { state: visible ? 'normal' : 'minimized' })
  }
}

export class ChromeCdpApi implements CdpApi {
  async send(tabId: number, method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) throw new Error('CDP request cancelled')
    const target = { tabId }
    await chrome.debugger.attach(target, '1.3')
    try {
      if (signal.aborted) throw new Error('CDP request cancelled')
      return await chrome.debugger.sendCommand(target, method, params)
    } finally {
      await chrome.debugger.detach(target).catch(() => undefined)
    }
  }

  async events(_tabId: number, _afterSequence?: number, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new Error('CDP request cancelled')
    return { events: [], nextSequence: 0 }
  }
}
