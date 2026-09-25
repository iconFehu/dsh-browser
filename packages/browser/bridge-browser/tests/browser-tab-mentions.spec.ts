import { describe, expect, it } from 'vitest'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { bindBrowserTabMentions } from '../src/browser-tab-mentions.ts'

describe('browser tab mentions', () => {
  it('binds every selected tab and removes every internal marker before the model step', async () => {
    const refs: string[] = []
    const messages = [{ content: [{ type: 'text', text: 'Compare [[dsh-browser-tab:one]] and [[dsh-browser-tab:two]]' }] }] as UserMessage[]
    const result = await bindBrowserTabMentions(messages, async (ref) => {
      refs.push(ref)
      return { text: JSON.stringify({ tabId: refs.length, title: ref, url: `https://${ref}.test` }) }
    })
    expect(refs).toEqual(['one', 'two'])
    expect(JSON.stringify(result)).not.toContain('dsh-browser-tab:')
    expect(JSON.stringify(result)).toContain('The current controlled tab is 2')
    expect(JSON.stringify(messages)).toContain('dsh-browser-tab:one')
  })

  it('rejects a stale selection before passing a marked prompt to the model', async () => {
    const messages = [{ content: [{ type: 'text', text: 'Look [[dsh-browser-tab:closed]]' }] }] as UserMessage[]
    await expect(bindBrowserTabMentions(messages, async () => { throw new Error('The selected browser tab is no longer available') }))
      .rejects.toThrow('no longer available')
  })
})
