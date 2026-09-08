type ActionRequest = { type: 'browser.action'; action: string; args?: Record<string, unknown> }

const indexed = new Map<number, Element>()
let nextIndex = 1

function visible(element: Element): boolean {
  const node = element as HTMLElement
  const style = getComputedStyle(node)
  const rect = node.getBoundingClientRect()
  return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
}

function snapshot(): string {
  indexed.clear(); nextIndex = 1
  const lines: string[] = [`URL: ${location.href}`, `Title: ${document.title}`]
  for (const element of document.querySelectorAll('a,button,input,textarea,select,[role="button"]')) {
    if (!visible(element)) continue
    const index = nextIndex++
    indexed.set(index, element)
    const label = (element.getAttribute('aria-label') || element.textContent || (element as HTMLInputElement).placeholder || '').trim().replace(/\s+/g, ' ').slice(0, 160)
    const tag = element.tagName.toLowerCase()
    lines.push(`[${index}] ${tag}${label ? `: ${label}` : ''}`)
    if (lines.length >= 61) break
  }
  return lines.join('\n')
}

function indexArg(args: Record<string, unknown>): Element {
  const index = args.index
  if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 1) throw new Error('index must be a positive integer')
  const element = indexed.get(index)
  if (!element) throw new Error('element index is stale; call browser.snapshot again')
  return element
}

function targetArg(args: Record<string, unknown>): Element {
  if (args.selector !== undefined) {
    if (typeof args.selector !== 'string' || !args.selector) throw new Error('selector must be a non-empty string')
    const element = document.querySelector(args.selector)
    if (!element) throw new Error('selector did not match')
    return element
  }
  return indexArg(args)
}

async function execute(request: ActionRequest): Promise<unknown> {
  const args = request.args ?? {}
  switch (request.action) {
    case 'snapshot':
    case 'browser_snapshot':
    case 'page_context':
    case 'browser_page_context': return { text: snapshot() }
    case 'get_text':
    case 'browser_get_text': {
      const selector = typeof args.selector === 'string' ? args.selector : 'body'
      const element = document.querySelector(selector)
      if (!element) throw new Error('selector did not match')
      return { text: element.textContent?.trim() ?? '' }
    }
    case 'click':
    case 'browser_click': targetArg(args).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); return { clicked: true }
    case 'type':
    case 'browser_type': {
      const element = targetArg(args) as HTMLInputElement | HTMLTextAreaElement
      if (!('value' in element)) throw new Error('element is not editable')
      const text = typeof args.text === 'string' ? args.text : args.value
      if (typeof text !== 'string') throw new Error('text is required')
      element.focus(); element.value = text
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
      element.dispatchEvent(new Event('change', { bubbles: true }))
      return { typed: text.length }
    }
    case 'press':
    case 'browser_press':
    case 'browser_press_key': {
      const key = args.key
      if (typeof key !== 'string') throw new Error('key is required')
      const element = targetArg(args); element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); element.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true })); return { pressed: key }
    }
    case 'scroll':
    case 'browser_scroll': window.scrollBy({ top: typeof args.y === 'number' ? args.y : 0, left: typeof args.x === 'number' ? args.x : 0, behavior: 'instant' }); return { scrolled: true }
    case 'wait':
    case 'browser_wait': {
      const timeout = typeof args.ms === 'number' && args.ms >= 0 && args.ms <= 30_000 ? args.ms : 500
      await new Promise((resolve) => setTimeout(resolve, timeout)); return { waitedMs: timeout }
    }
    default: throw new Error(`unsupported content action: ${request.action}`)
  }
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!message || typeof message !== 'object' || !('type' in message) || (message as { type?: string }).type !== 'browser.action') return false
  void execute(message as ActionRequest).then((result) => sendResponse({ ok: true, result })).catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }))
  return true
})
