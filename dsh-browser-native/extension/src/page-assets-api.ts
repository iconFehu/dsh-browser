import type { PageAssetsApi, AssetKind } from '../../src/shared/page-assets-capability.js'

type AssetRecord = { id: string; url: string; kind: AssetKind; type?: string; size?: number }

function classify(url: string, type: string): AssetKind {
  if (type.includes('font')) return 'font'
  if (type.includes('image')) return 'image'
  if (type.includes('stylesheet') || url.endsWith('.css')) return 'stylesheet'
  if (type.includes('video')) return 'video'
  return 'other'
}

async function collect(): Promise<AssetRecord[]> {
  const entries: Array<{ url: string; type: string }> = []
  for (const link of Array.from(document.querySelectorAll('link[href]'))) {
    const node = link as HTMLLinkElement
    entries.push({ url: node.href, type: node.type || node.rel || '' })
  }
  for (const image of Array.from(document.images)) entries.push({ url: image.currentSrc || image.src, type: 'image' })
  for (const video of Array.from(document.querySelectorAll('video, audio, source'))) {
    const node = video as HTMLMediaElement
    if (node.currentSrc || node.src) entries.push({ url: node.currentSrc || node.src, type: node.tagName.toLowerCase() })
  }
  const seen = new Set<string>()
  return entries.filter((entry) => entry.url && !seen.has(entry.url) && seen.add(entry.url)).map((entry, index) => ({
    id: `asset-${index + 1}`,
    url: entry.url,
    kind: classify(entry.url, entry.type),
    type: entry.type,
  }))
}

export class ChromePageAssetsApi implements PageAssetsApi {
  async list(tabId: number, signal: AbortSignal): Promise<readonly AssetRecord[]> {
    if (signal.aborted) throw new Error('Asset request cancelled')
    const result = await chrome.scripting.executeScript({ target: { tabId }, func: collect })
    return (result[0]?.result ?? []) as AssetRecord[]
  }

  async bundle(tabId: number, assetIds: readonly string[] | undefined, kinds: readonly AssetKind[] | undefined, signal: AbortSignal): Promise<unknown> {
    const assets = (await this.list(tabId, signal)).filter((asset) => (!assetIds || assetIds.includes(asset.id)) && (!kinds || kinds.includes(asset.kind)))
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      args: [assets.map((asset) => asset.url)],
      func: async (urls: string[]) => Promise.all(urls.map(async (url) => {
        try {
          const response = await fetch(url)
          const bytes = new Uint8Array(await response.arrayBuffer())
          let binary = ''
          for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
          return { url, ok: response.ok, mime: response.headers.get('content-type'), data: btoa(binary) }
        } catch (error) {
          return { url, ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      })),
    })
    return { assets, bundles: result[0]?.result ?? [] }
  }
}
