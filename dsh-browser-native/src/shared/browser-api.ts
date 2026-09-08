export interface BrowserApi {
  getWindows(): Promise<readonly BrowserWindow[]>
  updateWindow(windowId: number, update: { state?: string; focused?: boolean }): Promise<BrowserWindow>
  getTabs(query?: { windowId?: number; active?: boolean }): Promise<readonly BrowserTab[]>
  updateTab(tabId: number, update: { active?: boolean; pinned?: boolean; muted?: boolean }): Promise<BrowserTab>
  removeTabs(tabIds: readonly number[]): Promise<void>
  getViewport(tabId: number): Promise<{ width: number; height: number }>
  setViewport(tabId: number, viewport: { width: number; height: number } | undefined): Promise<void>
  isVisible(): Promise<boolean>
  setVisible(visible: boolean): Promise<void>
}

export interface BrowserWindow { readonly id: number; readonly focused: boolean; readonly state?: string }
export interface BrowserTab { readonly id: number; readonly windowId: number; readonly title?: string; readonly url?: string; readonly active?: boolean }
