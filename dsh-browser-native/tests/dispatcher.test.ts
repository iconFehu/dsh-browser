import { describe, expect, it } from 'vitest'
import { BackendRouter, type BrowserBackend } from '../src/native-host/backend.js'
import { HostDispatcher } from '../src/native-host/dispatcher.js'

function backend(): BrowserBackend {
  return {
    kind: 'dsh',
    connect: async () => {},
    close: async () => {},
    cancel: async () => {},
    call: async (_context, capability, method, args) => ({ capability, method, args }),
  }
}

describe('HostDispatcher', () => {
  it('advertises the registered capabilities after the extension handshake', async () => {
    const dispatcher = new HostDispatcher({ extensionId: 'test-extension', backend: 'dsh', router: new BackendRouter([backend()]) })
    const response = await dispatcher.handle({ type: 'hello', protocolVersion: 1, extensionId: 'test-extension' })
    expect(response?.type).toBe('hello.ok')
    expect(response && 'capabilities' in response ? response.capabilities.map((item) => item.id) : []).toContain('cdp')
  })

  it('routes calls through the selected backend', async () => {
    const dispatcher = new HostDispatcher({ extensionId: 'test-extension', backend: 'dsh', router: new BackendRouter([backend()]) })
    const response = await dispatcher.handle({ type: 'capability.call', id: '1', sessionId: 's', capability: 'cdp', method: 'readEvents', args: {}, deadline: Date.now() + 1000 })
    expect(response).toEqual({ type: 'result', id: '1', ok: true, value: { capability: 'cdp', method: 'readEvents', args: {} } })
  })

  it('returns tool results through the selected backend only', async () => {
    const sent: string[] = []
    const selected = backend()
    selected.toolResult = async (result) => { sent.push(result.id) }
    const other = { ...backend(), kind: 'codex' as const }
    const dispatcher = new HostDispatcher({ extensionId: 'test-extension', backend: 'dsh', router: new BackendRouter([other, selected]) })
    await dispatcher.handle({ type: 'tool.result', id: 'call-1', ok: true, result: { text: 'done' } })
    expect(sent).toEqual(['call-1'])
  })

  it('aborts the selected backend call through its signal', async () => {
    let aborted = false
    const selected = backend()
    selected.call = async (context) => new Promise((resolve) => {
      context.signal.addEventListener('abort', () => { aborted = true; resolve('cancelled') }, { once: true })
    })
    const dispatcher = new HostDispatcher({ extensionId: 'test-extension', backend: 'dsh', router: new BackendRouter([selected]) })
    const call = dispatcher.handle({ type: 'capability.call', id: 'cancel-me', sessionId: 's', capability: 'cdp', method: 'readEvents', args: {}, deadline: Date.now() + 1000 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const response = await dispatcher.handle({ type: 'capability.cancel', id: 'cancel-me' })
    await call
    expect(response).toMatchObject({ type: 'result', id: 'cancel-me', ok: true })
    expect(aborted).toBe(true)
  })
})
