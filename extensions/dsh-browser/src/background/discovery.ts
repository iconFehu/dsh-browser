/** Bounded local discovery. A config response is a candidate, never authentication. */
import { BEACON_PORTS } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'

export type DiagnosticCode = 'discovering' | 'not-found' | 'forbidden' | 'missing-bridge' | 'invalid-response' | 'authentication' | 'handshake-timeout' | 'replaced' | 'connected'
export interface ConnectionDiagnostic { code: DiagnosticCode; address?: string; pid?: number }
export const DESKTOP_PORTS = Array.from({ length: 33 }, (_, i) => 43120 + i)
// DSH Desktop launches its host with --port 0, so a random-port instance is
// only reachable through the bridge's fixed-port discovery beacon; the rest of
// the list covers pinned deployments and older releases.
const FALLBACK_PORTS = [14389, ...BEACON_PORTS, 3080, 3081, 3090]

export function safeAddress(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (!['ws:', 'wss:'].includes(url.protocol)) return undefined
    return `${url.protocol}//${url.host}${url.pathname}`
  } catch { return undefined }
}

export function localCandidate(value: unknown, port?: string): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || !url.port
      || url.pathname !== '/ext/bridge' || url.username || url.password || url.search || url.hash
      || (port !== undefined && url.port !== port)) return undefined
    return url.href
  } catch { return undefined }
}

export async function inspectBridge(address: string, request: typeof fetch = fetch): Promise<ConnectionDiagnostic> {
  const display = safeAddress(address)
  try {
    const target = new URL(address)
    if (target.hostname !== '127.0.0.1') return { code: 'invalid-response', address: display }
    target.protocol = target.protocol === 'wss:' ? 'https:' : 'http:'
    target.pathname = '/ext/bridge-config'
    target.search = ''
    target.hash = ''
    const response = await request(target.href, { signal: AbortSignal.timeout(1500), redirect: 'error', cache: 'no-store' })
    if (response.status === 403) return { code: 'forbidden', address: display }
    if (response.status === 401) return { code: 'authentication', address: display }
    if (response.status === 404) return { code: 'missing-bridge', address: display }
    if (!response.ok) return { code: 'invalid-response', address: display }
    let body: unknown
    try { body = await response.json() } catch { return { code: 'invalid-response', address: display } }
    if (typeof body !== 'object' || body === null) return { code: 'invalid-response', address: display }
    const payload = body as { wsUrl?: unknown; beacon?: unknown; pid?: unknown }
    // A beacon answer reports the real host port, which differs from the
    // beacon port that was probed; a direct host answer must match its port.
    const url = payload.beacon === true
      ? localCandidate(payload.wsUrl)
      : localCandidate(payload.wsUrl, target.port)
    if (!url) return { code: 'invalid-response', address: display }
    return {
      code: 'connected',
      address: url,
      ...(typeof payload.pid === 'number' && Number.isInteger(payload.pid) && payload.pid > 0 ? { pid: payload.pid } : {}),
    }
  } catch { return { code: 'not-found', address: display } }
}

export async function discoverLocalBridge(last: string | undefined, active: () => boolean, request: typeof fetch = fetch): Promise<ConnectionDiagnostic> {
  const cached = localCandidate(last)
  const urls = [...new Set([
    ...(cached && DESKTOP_PORTS.includes(Number(new URL(cached).port)) ? [cached] : []),
    ...[...DESKTOP_PORTS, ...FALLBACK_PORTS].map(port => `ws://127.0.0.1:${port}/ext/bridge`),
  ])]
  let failure: ConnectionDiagnostic = { code: 'not-found' }
  // Batches preserve candidate preference, with no more than four requests in flight.
  for (let i = 0; i < urls.length && active(); i += 4) {
    const results = await Promise.all(urls.slice(i, i + 4).map(url => inspectBridge(url, request)))
    if (!active()) return { code: 'not-found' }
    const found = results.find(result => result.code === 'connected')
    if (found) return found
    for (const result of results) {
      if (result.code === 'forbidden' || (failure.code === 'not-found' && result.code !== 'not-found')) failure = result
    }
  }
  return failure
}
