import type { CapabilityRegistry } from './capability-registry.js'

export type BotDetectionReason = 'captcha_failed' | 'access_denied' | 'challenge_loop' | 'unexpected_bot_error'

export interface BotDetectionApi {
  report(tabId: number, reason: BotDetectionReason, signal: AbortSignal): Promise<unknown>
}

export function registerBotDetectionCapability(registry: CapabilityRegistry, api: BotDetectionApi): void {
  registry.register('botDetection', 'report', async (context, _method, raw) => {
    if (context.tabId === undefined) throw new Error('botDetection.report requires a tab')
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof (raw as Record<string, unknown>).reason !== 'string') throw new Error('reason is required')
    const reason = (raw as Record<string, unknown>).reason as string
    if (!['captcha_failed', 'access_denied', 'challenge_loop', 'unexpected_bot_error'].includes(reason)) throw new Error('unsupported bot-detection reason')
    return api.report(context.tabId, reason as BotDetectionReason, context.signal)
  })
}
