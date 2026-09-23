/**
 * `/ext/browser-tabs`: the tab list behind the Web Client's `@tab` picker.
 *
 * The response names every open http(s) tab's title and URL, so only the
 * host's own Web UI may read it: the request must arrive over loopback, name a
 * loopback Host (defeats DNS rebinding), and carry `Sec-Fetch-Site:
 * same-origin` (a browser-set header other sites cannot forge). Entries carry
 * only a ref, window id, title, URL, and favicon; the ref is what
 * `management.tabs.bind` accepts and is meaningful only to the extension.
 *
 * @module
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { isLoopbackAddress, type BridgeServer } from './server.ts'

export const BROWSER_TABS_PATH = '/ext/browser-tabs'
/** Extension-internal method; the model-facing schema never allows it. */
export const BROWSER_TAB_REFS_METHOD = 'management.tabs.refs'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

function hostName(host: string | undefined): string | undefined {
  if (host === undefined) return undefined
  const match = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(host.trim().toLowerCase())
  return match?.[1]
}

/** Whether a request comes from the host's own loopback Web UI. */
export function browserTabsRequestAllowed(req: Pick<IncomingMessage, 'headers' | 'socket'>): boolean {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return false
  const host = hostName(req.headers.host)
  if (host === undefined || !LOOPBACK_HOSTS.has(host)) return false
  return req.headers['sec-fetch-site'] === 'same-origin'
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** Build the guarded route that asks the connected extension for tab refs. */
export function createBrowserTabsRoute(
  server: Pick<BridgeServer, 'requestTool'>,
  timeoutMs: number,
): WebRoute {
  return {
    kind: 'exact',
    path: BROWSER_TABS_PATH,
    handler: async (req, res) => {
      if (!browserTabsRequestAllowed(req)) {
        sendJson(res, 403, { error: 'forbidden' })
        return
      }
      try {
        const result = await server.requestTool(BROWSER_TAB_REFS_METHOD, {}, new AbortController().signal, timeoutMs)
        const text = typeof result === 'object' && result !== null && typeof (result as { text?: unknown }).text === 'string'
          ? (result as { text: string }).text
          : '[]'
        const parsed: unknown = JSON.parse(text)
        sendJson(res, 200, Array.isArray(parsed) ? parsed : [])
      } catch (error: unknown) {
        sendJson(res, 503, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }
}
