import type { CapabilityRegistry } from './capability-registry.js'

export interface AuthField { readonly id: string; readonly label: string; readonly type: 'text' | 'password' | 'otp'; readonly selector: string; readonly required: boolean }
export interface BrowserAuthApi {
  request(tabId: number, request: { origin: string; fields: readonly AuthField[]; submit?: { action: 'click' | 'press_enter'; selector: string } }, signal: AbortSignal): Promise<unknown>
}

export function registerBrowserAuthCapability(registry: CapabilityRegistry, api: BrowserAuthApi): void {
  registry.register('browserAuth', 'request', async (context, _method, raw) => {
    if (context.tabId === undefined) throw new Error('browserAuth.request requires a tab')
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('authentication request must be an object')
    const args = raw as Record<string, unknown>
    if (typeof args.origin !== 'string' || !/^https?:\/\//i.test(args.origin)) throw new Error('authentication origin must be http(s)')
    if (!Array.isArray(args.fields) || args.fields.length === 0 || args.fields.length > 6) throw new Error('authentication fields must contain 1-6 items')
    const fields = args.fields.map((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid authentication field')
      const field = value as Record<string, unknown>
      if (typeof field.id !== 'string' || typeof field.label !== 'string' || typeof field.selector !== 'string' || typeof field.required !== 'boolean' || !['text', 'password', 'otp'].includes(String(field.type))) throw new Error('invalid authentication field schema')
      return { id: field.id, label: field.label, type: field.type as AuthField['type'], selector: field.selector, required: field.required }
    })
    const submit = args.submit
    if (submit !== undefined) {
      if (!submit || typeof submit !== 'object' || Array.isArray(submit)) throw new Error('invalid submit action')
      const value = submit as Record<string, unknown>
      if (!['click', 'press_enter'].includes(String(value.action)) || typeof value.selector !== 'string') throw new Error('invalid submit action')
    }
    return api.request(context.tabId, { origin: args.origin, fields, submit: submit as { action: 'click' | 'press_enter'; selector: string } | undefined }, context.signal)
  })
}
