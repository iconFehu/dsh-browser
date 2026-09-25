/** Resolve Web Client @tab markers before a model step is admitted. */
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { extractBrowserTabMarker } from './server.ts'

interface BoundTab { tabId: number; title: string; url: string }

export async function bindBrowserTabMentions(
  messages: UserMessage[],
  bind: (ref: string) => Promise<unknown>,
): Promise<UserMessage[]> {
  const refs: string[] = []
  const cleaned = messages.map((message) => {
    const extracted = extractBrowserTabMarker({ content: message.content })
    for (const ref of extracted.tabRefs ?? []) if (!refs.includes(ref)) refs.push(ref)
    if (extracted.tabRefs === undefined) return message
    return { ...message, content: (extracted.payload as { content: UserMessage['content'] }).content }
  })
  if (refs.length === 0) return messages

  const tabs: BoundTab[] = []
  for (const ref of refs) {
    const answer = await bind(ref)
    const text = typeof answer === 'object' && answer !== null ? (answer as { text?: unknown }).text : undefined
    const tab = typeof text === 'string' ? JSON.parse(text) as BoundTab : null
    if (tab === null || !Number.isSafeInteger(tab.tabId) || typeof tab.title !== 'string' || typeof tab.url !== 'string') {
      throw new Error('The selected browser tab could not be bound. Select it again and retry.')
    }
    tabs.push(tab)
  }

  const note = `Selected browser tab IDs in this session: ${tabs.map((tab) => tab.tabId).join(', ')}. `
    + `The current controlled tab is ${tabs.at(-1)!.tabId}. Use management.tabs.activate with a listed tabId to switch before reading or acting on another selected tab.`
  const last = cleaned.at(-1)!
  return [...cleaned.slice(0, -1), { ...last, content: [...last.content, { type: 'text', text: note }] }]
}
