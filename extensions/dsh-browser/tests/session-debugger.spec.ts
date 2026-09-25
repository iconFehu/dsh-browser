// @vitest-environment jsdom

import { describe, expect, it, afterEach } from 'vitest'
import {
  DENIED_CDP_METHODS,
  clearAllSessionCdpDebuggers,
  isCdpMethodName,
  isSessionCdpDebuggerEnabled,
  setSessionCdpDebugger,
} from '../src/background/cdp/session-debugger.ts'

describe('session-debugger gate', () => {
  afterEach(() => clearAllSessionCdpDebuggers())

  it('defaults off and toggles per session id', () => {
    expect(isSessionCdpDebuggerEnabled(undefined)).toBe(false)
    expect(isSessionCdpDebuggerEnabled('')).toBe(false)
    expect(isSessionCdpDebuggerEnabled('s1')).toBe(false)
    setSessionCdpDebugger('s1', true)
    expect(isSessionCdpDebuggerEnabled('s1')).toBe(true)
    expect(isSessionCdpDebuggerEnabled('s2')).toBe(false)
    setSessionCdpDebugger('s1', false)
    expect(isSessionCdpDebuggerEnabled('s1')).toBe(false)
  })

  it('validates CDP method names and keeps a minimal denylist', () => {
    expect(isCdpMethodName('Runtime.evaluate')).toBe(true)
    expect(isCdpMethodName('Input.dispatchMouseEvent')).toBe(true)
    expect(isCdpMethodName('not-a-method')).toBe(false)
    expect(DENIED_CDP_METHODS.has('Browser.close')).toBe(true)
    expect(DENIED_CDP_METHODS.has('Runtime.evaluate')).toBe(false)
  })
})
