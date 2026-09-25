/**
 * CDP tool executors backed by the CDP manager (Chrome, developer-mode switch).
 *
 * Default path is observation-only: allowlisted methods map to read/capture
 * tools and never dispatch input. After one explicit session approval via
 * `cdp.enableDebugger`, `cdp.call` may passthrough most Page/Runtime/Input/DOM/
 * Network methods (debugger-level) on the controlled http(s) tab. A minimal
 * denylist still blocks catastrophic Browser/Target process methods.
 *
 * Every tool: lazily attaches CDP to the controlled tab, obtains authorization
 * when required, produces bounded text, and wraps page/browser-authored content
 * in the untrusted boundary.
 *
 * @module
 */

import type { ToolCall, ToolAnswer } from '../tools.ts'
import type { ToolErrorCode } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'
import { approvalPromptForCall } from '../authorization.ts'
import { listTabFrames } from '../frames.ts'
import { wrapUntrustedContent } from '../../security/untrusted.ts'
import { NETWORK_BODY_CHARS, renderDiagnostics, renderNetwork, redactUrl } from './buffers.ts'
import { renderMetrics } from './metrics.ts'
import { CdpUnavailableError, type CdpManager } from './manager.ts'
import type { ApprovalAuthorization, ApprovalPrompt } from '../../security/approval.ts'
import {
  CDP_SESSION_DEBUGGER_HINT,
  DENIED_CDP_METHODS,
  isCdpMethodName,
  isSessionCdpDebuggerEnabled,
  setSessionCdpDebugger,
} from './session-debugger.ts'
import { getUiLocale } from '../../i18n.ts'

export {
  CDP_SESSION_DEBUGGER_HINT,
  DENIED_CDP_METHODS,
  clearAllSessionCdpDebuggers,
  isSessionCdpDebuggerEnabled,
  setSessionCdpDebugger,
} from './session-debugger.ts'

/** Session gate / status tools routed alongside observation tools. */
export const CDP_DEBUGGER_GATE_TOOLS: ReadonlySet<string> = new Set([
  'cdp.enableDebugger',
  'cdp.disableDebugger',
  'cdp.debuggerStatus',
])

/** Tool names routed to the CDP observation layer instead of the content pipeline. */
export const CDP_OBSERVATION_TOOLS: ReadonlySet<string> = new Set([
  'cdp.diagnostics',
  'cdp.network',
  'cdp.getResponseBody',
  'cdp.performance',
  'cdp.dom',
  'cdp.captureScreenshot',
  'cdp.exportPdf',
])

/** Bridge `cdp.call` methods and the observation tool that serves each one. */
const CDP_METHOD_OBSERVATIONS: Readonly<Record<string, string>> = {
  'Accessibility.getFullAXTree': 'cdp.dom',
  'DOM.getDocument': 'cdp.dom',
  'DOM.getOuterHTML': 'cdp.dom',
  'Network.enable': 'cdp.network',
  'Network.disable': 'cdp.network',
  // Pass-through: model may call Network.getResponseBody with { requestId }.
  // Body text is still capped by manager.fetchResponseBody (NETWORK_BODY_CHARS).
  'Network.getResponseBody': 'cdp.getResponseBody',
  'Performance.enable': 'cdp.performance',
  'Performance.disable': 'cdp.performance',
  'Performance.getMetrics': 'cdp.performance',
  'Page.captureScreenshot': 'cdp.captureScreenshot',
  'Page.printToPDF': 'cdp.exportPdf',
}

/**
 * Translate the model-facing `cdp.call` / `cdp.events` wire methods into one
 * observation tool call. Direct observation names pass through unchanged.
 * @returns the observation call, or undefined for an unsupported request.
 */
export function resolveCdpCall(call: ToolCall): ToolCall | undefined {
  if (CDP_OBSERVATION_TOOLS.has(call.name)) return call
  // A model that copies management's namespace onto cdp sends cdp.cdp.call.
  const wireName = normalizeCdpWireName(call.name)
  if (wireName === 'cdp.events') return { ...call, name: 'cdp.diagnostics' }
  if (wireName !== 'cdp.call' || typeof call.args.method !== 'string') return undefined
  const name = CDP_METHOD_OBSERVATIONS[call.args.method]
  if (name === undefined) return undefined
  return { ...call, name, args: cdpCallParams(call) }
}

/** Normalize wire names such as `cdp.cdp.call` → `cdp.call`. */
export function normalizeCdpWireName(name: string): string {
  if (name === 'cdp.cdp.call' || name === 'cdp.cdp.events'
    || name === 'cdp.cdp.enableDebugger' || name === 'cdp.cdp.disableDebugger'
    || name === 'cdp.cdp.debuggerStatus') {
    return name.slice('cdp.'.length)
  }
  return name
}

/** Extract the CDP protocol method from a `cdp.call` wire request. */
export function cdpCallMethod(call: ToolCall): string | undefined {
  const wireName = normalizeCdpWireName(call.name)
  if (wireName !== 'cdp.call') return undefined
  return typeof call.args.method === 'string' ? call.args.method : undefined
}

export function cdpCallParams(call: ToolCall): Record<string, unknown> {
  const params = call.args.params
  if (typeof params === 'object' && params !== null && !Array.isArray(params)) {
    return params as Record<string, unknown>
  }
  return {}
}

export interface CdpObservationDeps {
  manager: CdpManager
  tab: { id?: number; url?: string; windowId: number }
  sharePageContent: 'ask' | 'auto' | 'off'
  authorize: (prompt: ApprovalPrompt) => Promise<ApprovalAuthorization>
  signal: AbortSignal
}

const OBSERVATION_TEXT_MAX = 40_000
const MAX_BODY_FETCHES = 3

/** Deep text read executed inside one frame's main world (constant string). */
const DOM_READ_EXPRESSION = `(() => {
  const countInteractive = (root) => {
    let n = 0;
    const seen = new WeakSet();
    const walk = (node) => {
      for (const child of node.children || []) {
        if (child.shadowRoot && !seen.has(child.shadowRoot)) { seen.add(child.shadowRoot); walk(child.shadowRoot); }
        const tag = child.tagName && child.tagName.toLowerCase();
        if (tag === 'a' && child.hasAttribute && child.hasAttribute('href')) n += 1;
        else if (tag === 'button' || tag === 'input' || tag === 'select' || tag === 'textarea') n += 1;
        else if (child.getAttribute && child.getAttribute('role') === 'button') n += 1;
        walk(child);
      }
    };
    walk(root);
    return n;
  };
  const countShadow = (root) => {
    let n = 0;
    const seen = new WeakSet();
    const walk = (node) => {
      for (const child of node.children || []) {
        if (child.shadowRoot) { n += 1; if (!seen.has(child.shadowRoot)) { seen.add(child.shadowRoot); walk(child.shadowRoot); } }
        walk(child);
      }
    };
    walk(root);
    return n;
  };
  const body = document.body || document.documentElement;
  return {
    title: document.title || '',
    text: body && body.innerText ? body.innerText.slice(0, 120000) : '',
    interactive: body ? countInteractive(body) : 0,
    shadowRoots: body ? countShadow(body) : 0
  };
})()`

function cancelledOrExpired(call: ToolCall, signal: AbortSignal): boolean {
  return signal.aborted || (call.expiresAt !== undefined && Date.now() >= call.expiresAt)
}

function unavailableError(code: ToolErrorCode, message: string): ToolAnswer {
  return { ok: false, error: { code, message } }
}

function approvalFailure(prompt: ApprovalPrompt, authorization: Exclude<ApprovalAuthorization, 'approved'>): ToolAnswer {
  const name = prompt.action
  switch (authorization) {
    case 'denied':
      return unavailableError('action-failed', `The user denied the browser approval request for "${name}".`)
    case 'unavailable':
      return unavailableError('action-failed', `No browser side panel was available to receive the approval request for "${name}".`)
    case 'timed-out':
      return unavailableError('timeout', `The browser approval request for "${name}" timed out before the user responded.`)
    case 'cancelled':
      return unavailableError('bridge-closed', `The browser approval request for "${name}" was cancelled.`)
  }
}

function httpUrl(url: string | undefined): boolean {
  return url !== undefined && /^https?:\/\//i.test(url)
}

/**
 * Execute one observation tool. Attach failures or missing developer mode
 * surface as `feature-unavailable`; these tools never silently fall back to
 * the content pipeline.
 */
export async function dispatchCdpObservation(call: ToolCall, deps: CdpObservationDeps): Promise<ToolAnswer> {
  if (cancelledOrExpired(call, deps.signal)) {
    return unavailableError('bridge-closed', 'The browser tool call was cancelled.')
  }
  if (!deps.manager.available) {
    return unavailableError('feature-unavailable', 'Browser developer mode is available in Google Chrome only; this tool is not supported in the current browser.')
  }
  if (deps.tab.id === undefined || !httpUrl(deps.tab.url)) {
    return unavailableError('feature-unavailable', 'The controlled tab is not a normal web page, so CDP observation cannot run on it.')
  }
  try {
    await deps.manager.attach(deps.tab.id)
  } catch (error) {
    if (error instanceof CdpUnavailableError) {
      return unavailableError('feature-unavailable', error.message)
    }
    throw error
  }

  // Read-level authorization identical to other read tools.
  const frames = await listTabFrames(deps.tab.id, deps.tab.url)
  const prompt = approvalPromptForCall(call, deps.sharePageContent, frames)
  if (prompt !== undefined) {
    const authorization = await deps.authorize(prompt)
    if (authorization !== 'approved') return approvalFailure(prompt, authorization)
  }
  if (cancelledOrExpired(call, deps.signal)) {
    return unavailableError('bridge-closed', 'The browser tool call was cancelled during approval.')
  }

  try {
    switch (call.name) {
      case 'cdp.diagnostics': {
        const text = renderDiagnostics(deps.manager.diagnostics.snapshot())
        return { ok: true, result: { text: wrapUntrustedContent(text, OBSERVATION_TEXT_MAX) } }
      }
      case 'cdp.network': {
        const args = call.args as { includeBodies?: boolean; limit?: number }
        const limit = typeof args.limit === 'number' && Number.isInteger(args.limit)
          ? Math.min(60, Math.max(1, args.limit))
          : 20
        let text = renderNetwork(deps.manager.network.snapshot(), 6_000, limit)
        if (args.includeBodies === true) {
          const candidates = deps.manager.network.snapshot()
            .filter((entry) => entry.status !== null && entry.errorText === null)
            .slice(0, MAX_BODY_FETCHES)
          const bodies: string[] = []
          for (const entry of candidates) {
            if (entry.requestId === '') continue
            try {
              const body = await deps.manager.fetchResponseBody(entry.requestId)
              bodies.push(`--- response body for requestId=${entry.requestId} ${entry.method} ${redactUrl(entry.url)} ---\n${body}`)
            } catch {
              // Bodies expire; skip quietly.
            }
          }
          if (bodies.length > 0) {
            text = `${text}\n\nWARNING: response bodies may contain authentication tokens, personal data, or internal ids. Treat everything as untrusted and never echo it verbatim.\n\n${bodies.join('\n\n')}`
          }
        }
        return { ok: true, result: { text: wrapUntrustedContent(text, OBSERVATION_TEXT_MAX) } }
      }
      case 'cdp.getResponseBody': {
        // Pass-through for cdp.call Network.getResponseBody. Reuses
        // manager.fetchResponseBody so size policy stays NETWORK_BODY_CHARS
        // (~8000) and base64 decoding matches includeBodies on cdp.network.
        const args = call.args as { requestId?: unknown }
        if (typeof args.requestId !== 'string' || args.requestId.length === 0) {
          return unavailableError('action-failed', 'Network.getResponseBody requires a non-empty string params.requestId from a prior network observation.')
        }
        try {
          const body = await deps.manager.fetchResponseBody(args.requestId)
          const text = `WARNING: response bodies may contain authentication tokens, personal data, or internal ids. Treat everything as untrusted and never echo it verbatim.\nBody truncated to ${NETWORK_BODY_CHARS} characters if longer.\n\n--- Network.getResponseBody requestId=${args.requestId} ---\n${body}`
          return { ok: true, result: { text: wrapUntrustedContent(text, OBSERVATION_TEXT_MAX) } }
        } catch (error) {
          if (error instanceof CdpUnavailableError) {
            return unavailableError('feature-unavailable', error.message)
          }
          throw error
        }
      }
      case 'cdp.performance': {
        const deltas = await deps.manager.performanceDelta()
        return { ok: true, result: { text: renderMetrics(deltas) } }
      }
      case 'cdp.dom': {
        const text = await readDomDeep(deps.manager)
        return { ok: true, result: { text: wrapUntrustedContent(text, OBSERVATION_TEXT_MAX) } }
      }
      case 'cdp.captureScreenshot':
      case 'cdp.exportPdf': {
        return await exportCapture(deps, call.name)
      }
      default:
        return unavailableError('action-failed', `Unknown observation tool "${call.name}".`)
    }
  } catch (error) {
    if (error instanceof CdpUnavailableError) {
      return unavailableError('feature-unavailable', error.message)
    }
    throw error
  }
}

/**
 * Capture the controlled tab as a PNG (viewport) or PDF and start a save
 * dialog for it. The capture is exported as a local artifact for the user to
 * inspect or share; the model only receives a confirmation text, keeping the
 * tool channel text-only.
 */
async function exportCapture(deps: CdpObservationDeps, tool: 'cdp.captureScreenshot' | 'cdp.exportPdf'): Promise<ToolAnswer> {
  const downloads = (globalThis as { chrome?: { downloads?: unknown } }).chrome?.downloads
  if (downloads === undefined || typeof downloads !== 'object' || typeof (downloads as { download?: unknown }).download !== 'function') {
    return unavailableError('feature-unavailable', 'Saving files is not available in this browser; exports require the downloads permission.')
  }
  const isPdf = tool === 'cdp.exportPdf'
  const method = isPdf ? 'Page.printToPDF' : 'Page.captureScreenshot'
  const params = isPdf
    ? { printBackground: true, preferCSSPageSize: true }
    : { format: 'png' }
  const raw = await deps.manager.send(method, params) as { data?: string }
  if (typeof raw.data !== 'string' || raw.data === '') {
    return unavailableError('action-failed', `${tool} returned no capture data; retry once the page settles.`)
  }
  const mime = isPdf ? 'application/pdf' : 'image/png'
  const extension = isPdf ? 'pdf' : 'png'
  const dataUrl = `data:${mime};base64,${raw.data}`
  const filename = `dsh-browser-${isPdf ? 'page' : 'screenshot'}-${Date.now()}.${extension}`
  const downloadId = await new Promise<number>((resolve, reject) => {
    (downloads as { download(options: { url: string; filename: string; saveAs: boolean }, callback: (id: number) => void): void })
      .download({ url: dataUrl, filename, saveAs: true }, (id) => {
        const error = chrome.runtime.lastError
        if (error !== undefined) reject(new Error(String(error.message ?? error)))
        else resolve(id)
      })
  })
  const kib = Math.max(1, Math.round((raw.data.length * 3) / 4 / 1024))
  return {
    ok: true,
    result: {
      text: `${isPdf ? 'PDF export' : 'Screenshot'} of the controlled tab captured (${kib} KB) and a save dialog was opened for "${filename}" (download id ${downloadId}). The image/PDF is a local file for you to inspect or attach; it was not sent to the model.`,
    },
  }
}

/** Deep text read across every observed frame (open shadow DOM included). */
async function readDomDeep(manager: CdpManager): Promise<string> {
  const contexts = [...manager.executionContexts()].sort((a, b) => a.contextId - b.contextId)
  if (contexts.length === 0) {
    return 'CDP is attached but no page execution context has been observed yet. Retry once the page settles.'
  }
  const sections: string[] = []
  let budget = 32_000
  let frameNumber = 0
  for (const context of contexts) {
    if (budget <= 500) break
    let scheme = ''
    try { scheme = new URL(context.origin).protocol } catch { continue }
    if (scheme !== 'http:' && scheme !== 'https:') continue
    const raw = await manager.evaluate(context, DOM_READ_EXPRESSION)
    if (typeof raw !== 'object' || raw === null) continue
    const model = raw as { title?: unknown; text?: unknown; interactive?: unknown; shadowRoots?: unknown }
    const header = frameNumber === 0
      ? `URL origin: ${context.origin}`
      : `--- iframe ${frameNumber} origin=${context.origin} ---`
    const shadow = typeof model.shadowRoots === 'number' ? model.shadowRoots : 0
    const interactive = typeof model.interactive === 'number' ? model.interactive : 0
    const title = typeof model.title === 'string' && model.title !== '' ? `${model.title}\n` : ''
    const pageText = typeof model.text === 'string' ? model.text : ''
    const body = `${header}\n${title}${clipText(pageText, Math.min(budget, 12_000))}\n[shadow roots: ${shadow}; interactive elements: ${interactive} — use pageAssets.snapshot for numbered action targets]`
    sections.push(body)
    budget -= body.length
    frameNumber += 1
  }
  if (sections.length === 0) return 'CDP could not read any http(s) page frame.'
  return sections.join('\n\n').trim()
}

function clipText(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}


export interface CdpDebuggerDeps {
  manager: CdpManager
  tab: { id?: number; url?: string; windowId: number }
  sessionId: string | undefined
  authorize: (prompt: ApprovalPrompt) => Promise<ApprovalAuthorization>
  signal: AbortSignal
}

/**
 * Enable / disable / status for the session-unrestricted CDP debugger gate.
 * Requires Chrome, Browser developer mode, an open side panel, and a controlled
 * http(s) tab (same attach prerequisites as observation tools).
 */
export async function dispatchCdpDebuggerGate(call: ToolCall, deps: CdpDebuggerDeps): Promise<ToolAnswer> {
  if (cancelledOrExpired(call, deps.signal)) {
    return unavailableError('bridge-closed', 'The browser tool call was cancelled.')
  }
  const wireName = normalizeCdpWireName(call.name)
  if (wireName === 'cdp.debuggerStatus') {
    return {
      ok: true,
      result: {
        text: JSON.stringify({
          sessionDebugger: isSessionCdpDebuggerEnabled(deps.sessionId),
          sessionId: deps.sessionId ?? null,
          developerModeRequired: true,
          note: 'When sessionDebugger is true, cdp.call may use Runtime.evaluate and Input.* on the controlled http(s) tab (denylist still applies). Prefer botDetection for human challenges.',
        }),
      },
    }
  }
  if (wireName === 'cdp.disableDebugger') {
    if (typeof deps.sessionId === 'string' && deps.sessionId.length > 0) {
      setSessionCdpDebugger(deps.sessionId, false)
    }
    return { ok: true, result: { text: 'Session-unrestricted CDP debugger disabled for this side-panel session. cdp.call is observation-allowlist only again.' } }
  }
  if (wireName !== 'cdp.enableDebugger') {
    return unavailableError('action-failed', `Unknown CDP debugger gate tool "${call.name}".`)
  }
  if (typeof deps.sessionId !== 'string' || deps.sessionId.length === 0) {
    return unavailableError('action-failed', 'cdp.enableDebugger requires an active side-panel session.')
  }
  if (isSessionCdpDebuggerEnabled(deps.sessionId)) {
    return { ok: true, result: { text: 'Session-unrestricted CDP debugger is already enabled for this side-panel session. cdp.call may use Runtime.evaluate, Input.dispatchMouseEvent / Input.dispatchKeyEvent / Input.insertText, and related Page/Runtime/Input/DOM/Network methods (Browser.close and Target.closeTarget remain denied).' } }
  }
  if (!deps.manager.available) {
    return unavailableError('feature-unavailable', 'Browser developer mode is available in Google Chrome only; this tool is not supported in the current browser.')
  }
  if (deps.tab.id === undefined || !httpUrl(deps.tab.url)) {
    return unavailableError('feature-unavailable', 'The controlled tab is not a normal web page, so the CDP debugger cannot attach to it.')
  }
  try {
    await deps.manager.attach(deps.tab.id)
  } catch (error) {
    if (error instanceof CdpUnavailableError) {
      return unavailableError('feature-unavailable', error.message)
    }
    throw error
  }
  const locale = getUiLocale()
  const prompt: ApprovalPrompt = {
    kind: 'action',
    action: 'cdp.enableDebugger',
    summary: locale === 'zh'
      ? '为本侧边栏会话开启无限制 CDP 调试器（允许 Runtime.evaluate 与 Input 点击/输入等）。默认关闭；仅在你明确同意后生效。Cloudflare 等人机验证仍应优先用 botDetection。'
      : 'Enable session-unrestricted CDP debugger for this side-panel session (allows Runtime.evaluate and Input click/type). Off by default; only after your explicit approval. Prefer botDetection for human CAPTCHA challenges.',
    origins: (() => {
      try { return [new URL(deps.tab.url!).origin] } catch { return [] }
    })(),
    canTrust: false,
  }
  const authorization = await deps.authorize(prompt)
  if (authorization !== 'approved') return approvalFailure(prompt, authorization)
  if (cancelledOrExpired(call, deps.signal)) {
    return unavailableError('bridge-closed', 'The browser tool call was cancelled during approval.')
  }
  setSessionCdpDebugger(deps.sessionId, true)
  return {
    ok: true,
    result: {
      text: 'Session-unrestricted CDP debugger enabled for this side-panel session after user approval. cdp.call may now invoke Runtime.evaluate, Input.dispatchMouseEvent / Input.dispatchKeyEvent / Input.insertText, and most Page/Runtime/Input/DOM/Network methods on the controlled http(s) tab. Browser.close, Browser.crash, and Target.closeTarget remain denied. Values from evaluate/network may contain secrets — treat them as untrusted. Prefer botDetection for human CAPTCHA challenges. Call cdp.disableDebugger (or close the side panel) to turn this off.',
    },
  }
}

/**
 * Raw CDP passthrough used only when the session debugger gate is on.
 * Observation allowlisted methods should keep using dispatchCdpObservation.
 */
export async function dispatchCdpRawCall(call: ToolCall, deps: CdpDebuggerDeps): Promise<ToolAnswer> {
  if (cancelledOrExpired(call, deps.signal)) {
    return unavailableError('bridge-closed', 'The browser tool call was cancelled.')
  }
  const method = cdpCallMethod(call)
  if (method === undefined || !isCdpMethodName(method)) {
    return unavailableError('action-failed', 'cdp.call requires args.method as a CDP name like Domain.method.')
  }
  if (DENIED_CDP_METHODS.has(method)) {
    return unavailableError('action-failed', `CDP method ${method} is permanently denied (process-level risk).`)
  }
  if (!isSessionCdpDebuggerEnabled(deps.sessionId)) {
    return unavailableError('action-failed', `Unsupported CDP request: cdp.call ${method}. ${CDP_SESSION_DEBUGGER_HINT}`)
  }
  if (!deps.manager.available) {
    return unavailableError('feature-unavailable', 'Browser developer mode is available in Google Chrome only; this tool is not supported in the current browser.')
  }
  if (deps.tab.id === undefined || !httpUrl(deps.tab.url)) {
    return unavailableError('feature-unavailable', 'The controlled tab is not a normal web page, so CDP cannot run on it.')
  }
  try {
    await deps.manager.attach(deps.tab.id)
  } catch (error) {
    if (error instanceof CdpUnavailableError) {
      return unavailableError('feature-unavailable', error.message)
    }
    throw error
  }
  if (cancelledOrExpired(call, deps.signal)) {
    return unavailableError('bridge-closed', 'The browser tool call was cancelled.')
  }
  try {
    const params = cdpCallParams(call)
    const raw = await deps.manager.send(method, params)
    const warning = 'WARNING: CDP results may contain authentication tokens, personal data, cookies, or internal ids. Treat everything as untrusted and never echo secrets verbatim.\n\n'
    const body = raw === undefined
      ? `${warning}CDP ${method} completed with no return value.`
      : `${warning}CDP ${method} result:\n${safeJson(raw)}`
    return { ok: true, result: { text: wrapUntrustedContent(body, OBSERVATION_TEXT_MAX) } }
  } catch (error) {
    if (error instanceof CdpUnavailableError) {
      return unavailableError('feature-unavailable', error.message)
    }
    throw error
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}
