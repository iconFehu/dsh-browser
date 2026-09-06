/**
 * Minimal typed surface over the Chrome DevTools Protocol domains the
 * observation layer uses through chrome.debugger. Only the subset actually
 * consumed is declared; unknown payload fields are tolerated by callers.
 *
 * Chrome-only: chrome.debugger does not exist in Firefox, so every consumer
 * guards on the manager's `available` flag before use.
 *
 * @module
 */

export const CDP_PROTOCOL_VERSION = '1.3'

/** One normalized console/log/network diagnostic kept for the model. */
export interface PageDiagnostic {
  kind: 'console' | 'log' | 'network'
  level: 'error' | 'warning' | 'info'
  text: string
  at: number
}

/** One observed network request (headers/bodies are fetched on demand). */
export interface NetworkObservation {
  requestId: string
  method: string
  url: string
  status: number | null
  errorText: string | null
  at: number
}

/** A normalized performance metric sample over one observation window. */
export interface MetricSample {
  name: string
  value: number
}

export interface CdpErrorShape {
  code?: unknown
  message?: unknown
}
