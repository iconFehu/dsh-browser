import type { BrowserAuthApi, AuthField } from '../../src/shared/browser-auth-capability.js'

type AuthRequest = { origin: string; fields: readonly AuthField[]; submit?: { action: 'click' | 'press_enter'; selector: string } }

async function readForm(request: AuthRequest): Promise<unknown> {
  if (location.origin !== new URL(request.origin).origin) throw new Error('Authentication origin does not match the active page')
  const values: Record<string, string> = {}
  const missing: string[] = []
  for (const field of request.fields) {
    const element = document.querySelector(field.selector) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null
    if (!element) {
      if (field.required) missing.push(field.id)
      continue
    }
    const value = 'value' in element ? String(element.value) : ''
    if (field.required && !value) missing.push(field.id)
    values[field.id] = value
  }
  if (missing.length > 0) return { ok: false, missing }
  if (request.submit) {
    const target = document.querySelector(request.submit.selector) as HTMLElement | null
    if (!target) throw new Error('Authentication submit selector did not match')
    if (request.submit.action === 'click') target.click()
    else target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
  }
  return { ok: true, values }
}

export class ChromeBrowserAuthApi implements BrowserAuthApi {
  async request(tabId: number, request: AuthRequest, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) throw new Error('Authentication request cancelled')
    const result = await chrome.scripting.executeScript({ target: { tabId }, args: [request], func: readForm })
    return result[0]?.result
  }
}
