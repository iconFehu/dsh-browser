/**
 * Session-scoped unrestricted CDP debugger gate.
 *
 * Default off. After one explicit approval via `cdp.enableDebugger` for the
 * current side-panel session, `cdp.call` may invoke methods beyond the
 * observation allowlist (Runtime.evaluate, Input.*, etc.) on the controlled
 * http(s) tab. Cleared when the side panel closes, developer mode turns off,
 * or `cdp.disableDebugger` runs.
 *
 * @module
 */

/** Catastrophic CDP methods that stay blocked even with the session debugger on. */
export const DENIED_CDP_METHODS: ReadonlySet<string> = new Set([
  'Browser.close',
  'Browser.crash',
  'Target.closeTarget',
])

/**
 * Hint appended when observation-only mode rejects evaluate / Input / other
 * non-allowlisted methods. Teach the model how to enable the session gate;
 * Cloudflare-style human challenges should still prefer botDetection.
 */
export const CDP_SESSION_DEBUGGER_HINT =
  'This CDP method is outside the observation allowlist. Call cdp.enableDebugger once (requires user approval for this side-panel session; Browser developer mode must be on), then retry cdp.call. Prefer botDetection for human CAPTCHA / challenge pages rather than treating debugger Input/evaluate as the default bypass.'

const enabledSessions = new Set<string>()

export function isSessionCdpDebuggerEnabled(sessionId: string | undefined): boolean {
  return typeof sessionId === 'string' && sessionId.length > 0 && enabledSessions.has(sessionId)
}

export function setSessionCdpDebugger(sessionId: string, enabled: boolean): void {
  const sid = sessionId.trim()
  if (sid === '') return
  if (enabled) enabledSessions.add(sid)
  else enabledSessions.delete(sid)
}

/** Drop every session gate (panel closed or developer mode off). */
export function clearAllSessionCdpDebuggers(): void {
  enabledSessions.clear()
}

/** Well-formed CDP method names look like `Domain.methodName`. */
export function isCdpMethodName(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/.test(value)
}
