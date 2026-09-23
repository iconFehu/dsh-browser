/**
 * Process-wide CDP observation manager instance.
 *
 * Kept in its own module so the background index (lifecycle owner) and the
 * tool dispatch layer (caller) can both reference the same singleton without
 * an import cycle.
 *
 * @module
 */

import { adaptChromeDebugger, CdpManager, type DebuggerLike } from './manager.ts'

/** No-op adapter used where chrome.debugger is absent; never invoked because `available` gates everything. */
const NULL_ADAPTER: DebuggerLike = {
  attach: () => Promise.reject(new Error('chrome.debugger is not available')),
  detach: () => Promise.resolve(),
  sendCommand: () => Promise.reject(new Error('chrome.debugger is not available')),
  addEventListener: () => {},
  removeEventListener: () => {},
}

const env = adaptChromeDebugger()

export const cdpObservation = new CdpManager(env.adapter ?? NULL_ADAPTER, env.available)
