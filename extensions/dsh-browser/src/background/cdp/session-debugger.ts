/**
 * CDP debugger policy helpers.
 *
 * When Browser developer mode (`cdpEnabled`) is ON, `cdp.call` may invoke
 * methods beyond the observation allowlist (Runtime.evaluate, Input.*, etc.)
 * on the controlled http(s) tab under the usual CDP prerequisites (Chrome,
 * side panel open, attach). When developer mode is OFF, attach fails and
 * evaluate / Input are unavailable. A minimal denylist still blocks
 * catastrophic Browser/Target process methods.
 *
 * `cdp.enableDebugger` / `cdp.disableDebugger` are legacy no-ops: models should
 * not call them — turn developer mode on/off in extension settings instead.
 *
 * @module
 */

/** Catastrophic CDP methods that stay blocked even with developer mode on. */
export const DENIED_CDP_METHODS: ReadonlySet<string> = new Set([
  'Browser.close',
  'Browser.crash',
  'Target.closeTarget',
])

/**
 * Hint when CDP debugger methods are unavailable. Teach the model to enable
 * Browser developer mode in settings — not to call enableDebugger.
 * Cloudflare-style human challenges should still prefer botDetection.
 */
export const CDP_DEVELOPER_MODE_HINT =
  'CDP debugger methods (Runtime.evaluate, Input.*, etc.) require Browser developer mode ON in the extension settings, an open side panel, and a controlled http(s) tab. Prefer botDetection for human CAPTCHA / challenge pages rather than treating debugger Input/evaluate as the default bypass.'

/** @deprecated Alias — prefer CDP_DEVELOPER_MODE_HINT. */
export const CDP_SESSION_DEBUGGER_HINT = CDP_DEVELOPER_MODE_HINT

/** Well-formed CDP method names look like `Domain.methodName`. */
export function isCdpMethodName(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/.test(value)
}
