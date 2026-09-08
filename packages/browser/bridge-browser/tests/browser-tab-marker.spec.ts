import { describe, expect, it } from 'vitest'
import { extractBrowserTabMarker } from '../src/server.ts'

describe('browser tab prompt marker', () => {
  it('extracts and removes a tab reference from prompt content', () => {
    const input = {
      sessionId: 's1',
      content: [{ type: 'text', text: '请总结 [[dsh-browser-tab:tab-v1-7]]\n' }],
    }
    expect(extractBrowserTabMarker(input)).toEqual({
      tabRef: 'tab-v1-7',
      payload: {
        sessionId: 's1',
        content: [{ type: 'text', text: '请总结 ' }],
      },
    })
  })

  it('leaves ordinary prompts unchanged', () => {
    const input = { sessionId: 's1', content: [{ type: 'text', text: 'hello' }] }
    expect(extractBrowserTabMarker(input)).toEqual({ payload: input })
  })

  it('does not mutate the original payload', () => {
    const input = { content: [{ type: 'text', text: '[[dsh-browser-tab:tab-v1-2]]go' }] }
    const result = extractBrowserTabMarker(input)
    expect(result.payload).not.toBe(input)
    expect(input.content[0].text).toBe('[[dsh-browser-tab:tab-v1-2]]go')
  })
})
