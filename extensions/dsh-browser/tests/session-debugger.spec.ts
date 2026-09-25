// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import {
  DENIED_CDP_METHODS,
  CDP_DEVELOPER_MODE_HINT,
  isCdpMethodName,
} from '../src/background/cdp/session-debugger.ts'

describe('CDP debugger policy helpers', () => {
  it('validates CDP method names and keeps a minimal denylist', () => {
    expect(isCdpMethodName('Runtime.evaluate')).toBe(true)
    expect(isCdpMethodName('Input.dispatchMouseEvent')).toBe(true)
    expect(isCdpMethodName('not-a-method')).toBe(false)
    expect(DENIED_CDP_METHODS.has('Browser.close')).toBe(true)
    expect(DENIED_CDP_METHODS.has('Browser.crash')).toBe(true)
    expect(DENIED_CDP_METHODS.has('Target.closeTarget')).toBe(true)
    expect(DENIED_CDP_METHODS.has('Runtime.evaluate')).toBe(false)
  })

  it('hints models to enable developer mode, not enableDebugger', () => {
    expect(CDP_DEVELOPER_MODE_HINT).toContain('Browser developer mode')
    expect(CDP_DEVELOPER_MODE_HINT.toLowerCase()).not.toContain('enabledebugger')
  })
})
