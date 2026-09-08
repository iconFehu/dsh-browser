import type { CapabilityRegistry } from './capability-registry.js'

export type AssetKind = 'font' | 'image' | 'stylesheet' | 'video' | 'other'

export interface PageAssetsApi {
  list(tabId: number, signal: AbortSignal): Promise<unknown>
  bundle(tabId: number, assetIds: readonly string[] | undefined, kinds: readonly AssetKind[] | undefined, signal: AbortSignal): Promise<unknown>
}

export function registerPageAssetsCapability(registry: CapabilityRegistry, api: PageAssetsApi): void {
  registry.register('pageAssets', 'list', async (context) => {
    if (context.tabId === undefined) throw new Error('pageAssets.list requires a tab')
    return api.list(context.tabId, context.signal)
  })
  registry.register('pageAssets', 'bundle', async (context, _method, raw) => {
    if (context.tabId === undefined) throw new Error('pageAssets.bundle requires a tab')
    const args = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
    const assetIds = args.assetIds
    const kinds = args.kinds
    if (assetIds !== undefined && (!Array.isArray(assetIds) || !assetIds.every((id) => typeof id === 'string' && id.length > 0))) throw new Error('assetIds must be an array of strings')
    if (kinds !== undefined && (!Array.isArray(kinds) || !kinds.every((kind) => typeof kind === 'string' && ['font', 'image', 'stylesheet', 'video', 'other'].includes(kind)))) throw new Error('kinds contains an unsupported asset kind')
    return api.bundle(context.tabId, assetIds as string[] | undefined, kinds as AssetKind[] | undefined, context.signal)
  })
}
