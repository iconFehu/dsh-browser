/**
 * Bounded diagnostics ring buffer and renderer. All page- or browser-authored
 * text is untrusted and must be wrapped by the caller before reaching the
 * model.
 *
 * @module
 */

import type { NetworkObservation, PageDiagnostic } from './types.ts'

export const DIAGNOSTICS_LIMIT = 64
export const NETWORK_LIMIT = 128
export const NETWORK_BODY_CHARS = 8_000

/** Strip query/hash so diagnostics never leak navigation secrets. */
export function redactUrl(value: string): string {
  try {
    const url = new URL(value)
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return '(opaque URL)'
  }
}

/** A plain append-only ring buffer (module state; unit-testable). */
export class RingBuffer<T> {
  private readonly entries: T[] = []

  constructor(private readonly limit: number) {}

  push(entry: T): void {
    this.entries.push(entry)
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit)
  }

  clear(): void {
    this.entries.length = 0
  }

  /** Most recent first. */
  snapshot(): T[] {
    return [...this.entries].reverse()
  }
}

/** Render diagnostics as bounded text (browser/page text, so untrusted). */
export function renderDiagnostics(entries: PageDiagnostic[], maxChars = 3_000): string {
  if (entries.length === 0) return 'No recent console errors, warnings, or failed network requests.'
  let output = ''
  for (const entry of entries) {
    const line = `[${entry.level}] (${entry.kind}) ${entry.text}`
    if (output.length + line.length + 1 > maxChars) break
    output += `${line}\n`
  }
  return output.trimEnd()
}

/** Render observed requests as bounded text; URLs are pre-redacted. */
export function renderNetwork(entries: NetworkObservation[], maxChars = 6_000, maxEntries = 40): string {
  if (entries.length === 0) return 'No network requests observed yet on this page.'
  const lines: string[] = []
  let chars = 0
  for (const entry of entries) {
    if (lines.length >= maxEntries) break
    const status = entry.status !== null ? `HTTP ${entry.status}` : entry.errorText !== null ? `failed: ${entry.errorText}` : 'pending'
    const line = `${entry.method} ${redactUrl(entry.url)} → ${status}`
    if (chars + line.length + 1 > maxChars) break
    lines.push(line)
    chars += line.length + 1
  }
  return lines.join('\n')
}
