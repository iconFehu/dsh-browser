/**
 * Frame-bound debugger targeting (ported from omdsh-dev/dsh-browser e645f8c,
 * adapted to the CdpManager surface).
 *
 * Chrome frameIds and CDP execution contexts are separate namespaces; a frame
 * inside an out-of-process iframe is a flatten child session the manager only
 * reaches after Target.setAutoAttach. Resolution marks the target document
 * with a one-shot attribute via chrome.scripting (documentId targeting), then
 * probes every default frame context until one observes the mark, and re-checks
 * webNavigation so a frame that navigated mid-resolution fails closed.
 *
 * @module
 */

import { CdpUnavailableError, type CdpSession, type FrameExecutionContext } from './manager.ts'
import type { TabFrame } from '../frames.ts'

/** Resolve the execution context that evaluates one frame's current document. */
export async function resolveFrameContext(
  session: CdpSession,
  tabId: number,
  frame: TabFrame,
): Promise<FrameExecutionContext> {
  if (frame.documentId === undefined) {
    throw new CdpUnavailableError('unavailable', 'The target frame has no stable document id; call pageAssets.snapshot again.')
  }
  const contexts = await session.frameExecutionContexts()
  const attribute = `data-dsh-frame-${crypto.randomUUID()}`
  const target = { tabId, documentIds: [frame.documentId] }
  await chrome.scripting.executeScript({ target, args: [attribute], func: setDocumentMarker })
  try {
    for (const context of contexts) {
      const answer = await context.send('Runtime.evaluate', {
        expression: `document.documentElement.hasAttribute(${JSON.stringify(attribute)})`,
        contextId: context.contextId,
        returnByValue: true,
      }) as { result?: { value?: unknown } }
      if (answer.result?.value !== true) continue
      const current = await chrome.webNavigation.getFrame({ tabId, frameId: frame.frameId })
      if (current?.documentId !== frame.documentId) {
        throw new CdpUnavailableError('unavailable', 'The target frame navigated before execution.')
      }
      return context
    }
    throw new CdpUnavailableError('unavailable', `Frame ${frame.frameId} has no matching debugger context.`)
  } finally {
    try {
      await chrome.scripting.executeScript({ target, args: [attribute], func: clearDocumentMarker })
    } catch {
      // The frame navigated or closed; the one-shot attribute died with its document.
    }
  }
}

/**
 * Find the DOM node carrying an upload marker across all frame contexts.
 * Returns the owning context so follow-up commands (DOM.setFileInputFiles)
 * reach the session that actually owns the node.
 */
export async function resolveMarkedNode(
  session: CdpSession,
  marker: string,
): Promise<{ context: FrameExecutionContext; nodeId: number }> {
  const contexts = await session.frameExecutionContexts()
  const selector = `[data-dsh-upload="${CSS.escape(marker)}"]`
  for (const context of contexts) {
    try {
      await context.send('DOM.enable')
      const answer = await context.send('Runtime.evaluate', {
        expression: `document.querySelector(${JSON.stringify(selector)})`,
        contextId: context.contextId,
        returnByValue: false,
      }) as { result?: { objectId?: string }; exceptionDetails?: unknown }
      if (answer.exceptionDetails !== undefined || answer.result?.objectId === undefined) continue
      const objectId = answer.result.objectId
      try {
        const node = await context.send('DOM.requestNode', { objectId }) as { nodeId?: number }
        if (node.nodeId === undefined || node.nodeId === 0) continue
        return { context, nodeId: node.nodeId }
      } finally {
        await context.send('Runtime.releaseObject', { objectId }).catch(() => { /* release is best effort */ })
      }
    } catch {
      // A context may have died between listing and probing; try the next one.
    }
  }
  throw new CdpUnavailableError('unavailable', 'The marked element is no longer available in any frame context.')
}

function setDocumentMarker(name: string): void {
  document.documentElement.setAttribute(name, '')
}

function clearDocumentMarker(name: string): void {
  document.documentElement.removeAttribute(name)
}
