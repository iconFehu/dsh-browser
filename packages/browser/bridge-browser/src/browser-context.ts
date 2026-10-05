/**
 * Model-facing browser page context injected after an explicit tab handoff.
 *
 * The extension captures the page immediately after the user chooses to
 * follow it. A live Agent receives that snapshot at once; a deferred session
 * keeps only its newest snapshot until `agent/created` publishes the Agent.
 * Live inboxes also keep only the newest unclaimed browser snapshot.
 * Injection deliberately does not wake an idle Agent — the snapshot is
 * claimed together with the user's next message.
 *
 * @module
 */

import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm'

/** Package that produces browser page context (legacy `plugin` source field). */
export const BROWSER_CONTEXT_PLUGIN = '@yuxianglin/dsh-bridge-browser'

/**
 * Producer-owned message source kind. DSH 0.2.x (session format v4) refuses the
 * retired `{ kind: 'plugin', plugin }` wrapper, so each producer declares its
 * own kind instead.
 */
export const BROWSER_CONTEXT_KIND = 'dsh-bridge-browser'

/** Kind the v3→v4 session-format migration assigns to this package's old `plugin` sources. */
const MIGRATED_BROWSER_CONTEXT_KIND = `plugin:${BROWSER_CONTEXT_PLUGIN}`

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Followed-page snapshot injected by the browser bridge. */
    'dsh-bridge-browser': {
      kind: 'dsh-bridge-browser'
    } & ContextFormed
  }
}

/** Bound orphaned provisional sessions while retaining normal recent tabs. */
const DEFAULT_MAX_PENDING = 32

/** Build one immutable context message from a captured browser snapshot. */
export function createBrowserSnapshotMessage(snapshot: string): UserMessage {
  const text = [
    'The user chose to follow the newly active browser tab. The browser page context was refreshed immediately after that choice.',
    'The following is an already completed pageAssets.snapshot of the current page. Use its stable indices directly for the next request; do not take an immediate duplicate snapshot unless required context is missing.',
    snapshot,
  ].join('\n\n')
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: BROWSER_CONTEXT_KIND,
      form: 'snapshot',
      sections: [{ name: 'browser-page', text }],
    },
  })
}

/**
 * Whether a pending message is a browser snapshot produced by this package,
 * including sources written by older releases (`kind: 'plugin'`) or rewritten
 * by the v3→v4 session-format migration (`kind: 'plugin:<package>'`).
 */
export function isBrowserSnapshotSource(source: UserMessage['source']): boolean {
  const record = source as { readonly kind?: unknown; readonly plugin?: unknown; readonly form?: unknown }
  if (record.form !== 'snapshot') return false
  return record.kind === BROWSER_CONTEXT_KIND
    || record.kind === MIGRATED_BROWSER_CONTEXT_KIND
    || (record.kind === 'plugin' && record.plugin === BROWSER_CONTEXT_PLUGIN)
}

/** Supersede pending tab context through the durable Inbox command surface. */
function injectLatestSnapshot(agent: Agent, snapshot: string): void {
  for (const message of agent.inbox.nextStep) {
    if (isBrowserSnapshotSource(message.source)) {
      agent.inbox.remove(message.id)
    }
  }
  agent.inject(createBrowserSnapshotMessage(snapshot))
}

/** Deliver followed-page snapshots to live or not-yet-materialized Agents. */
export class BrowserContextInjector {
  private readonly pending = new Map<string, string>()

  constructor(
    private readonly agents: Pick<AgentRegistry, 'get'>,
    private readonly maxPending = DEFAULT_MAX_PENDING,
  ) {
    if (!Number.isInteger(maxPending) || maxPending < 1) {
      throw new Error('browser context maxPending must be a positive integer')
    }
  }

  /** Inject now when possible; otherwise retain the newest snapshot per session. */
  inject(sessionId: string, snapshot: string): 'injected' | 'queued' {
    const agent = this.agents.get(sessionId as Parameters<AgentRegistry['get']>[0])
    if (agent !== undefined) {
      this.pending.delete(sessionId)
      injectLatestSnapshot(agent, snapshot)
      return 'injected'
    }

    // Refresh insertion order when the same provisional session follows again.
    this.pending.delete(sessionId)
    while (this.pending.size >= this.maxPending) {
      const oldest = this.pending.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.pending.delete(oldest)
    }
    this.pending.set(sessionId, snapshot)
    return 'queued'
  }

  /** Flush one provisional session at the supported Agent startup boundary. */
  activate(agent: Agent): boolean {
    const sessionId = String(agent.id)
    const snapshot = this.pending.get(sessionId)
    if (snapshot === undefined) return false
    injectLatestSnapshot(agent, snapshot)
    this.pending.delete(sessionId)
    return true
  }
}
