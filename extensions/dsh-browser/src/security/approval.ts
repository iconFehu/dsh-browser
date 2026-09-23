/** Shared panel/background contract for browser action approval. */

/**
 * `handoff` asks the user to do something on the page themselves (sign in);
 * `allow-once` then means "done" and `deny` means "declined". Handoffs never
 * pass through unrestricted access or trusted-origin shortcuts.
 */
export type ApprovalKind = 'read' | 'action' | 'handoff'
export type ApprovalDecision = 'deny' | 'allow-once' | 'always-allow-reads' | 'trust-session' | 'trust-origin'
/** Background authorization result; transport failures must not masquerade as a user decision. */
export type ApprovalAuthorization = 'approved' | 'denied' | 'unavailable' | 'timed-out' | 'cancelled'

/** A policy decision awaiting a user response. */
export interface ApprovalPrompt {
  kind: ApprovalKind
  action: string
  summary: string
  origins: string[]
  /** True only when one stable origin can safely be added to the action allowlist. */
  canTrust: boolean
}

/** Correlated request delivered to every open side-panel view. */
export interface ApprovalRequest extends ApprovalPrompt {
  id: string
  /** Agent session that requested the browser operation, when known. */
  sessionId?: string
}

export function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return value === 'deny'
    || value === 'allow-once'
    || value === 'always-allow-reads'
    || value === 'trust-session'
    || value === 'trust-origin'
}
