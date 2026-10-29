import type { ServerFrame } from '@yuxianglin/dsh-bridge-browser/src/protocol.ts'

/** A generation token: asynchronous work retains this exact turn after awaits. */
export interface BrowserTurn {
  readonly sessionId: string | undefined
  readonly turnId: string | undefined
  readonly signal: AbortSignal
}

interface TurnState extends BrowserTurn {
  controller: AbortController
  cleanup?: Promise<void>
}

interface TurnResources {
  release(owner: AbortSignal): Promise<void>
}

/** Session bindings survive turns; temporary control and debugger ownership do not. */
export class BrowserTurnLifecycle {
  private readonly turns = new Map<string | undefined, TurnState>()

  constructor(
    private readonly resources: TurnResources,
    private readonly releaseControl: (turn: BrowserTurn) => void | Promise<void> = () => {},
  ) {}

  current(sessionId?: string): BrowserTurn {
    let turn = this.turns.get(sessionId)
    if (turn === undefined) {
      turn = this.create(sessionId)
      this.turns.set(sessionId, turn)
    }
    return turn
  }

  start(sessionId: string, turnId?: string): BrowserTurn {
    const previous = this.turns.get(sessionId)
    if (previous !== undefined && !previous.signal.aborted) {
      // Explicit IDs make duplicate start notifications idempotent.
      if (turnId !== undefined && previous.turnId === turnId) return previous
      void this.endTurnUnlocked(previous)
    }
    const turn = this.create(sessionId, turnId)
    this.turns.set(sessionId, turn)
    return turn
  }

  async end(sessionId: string, turnId?: string): Promise<void> {
    const turn = this.turns.get(sessionId)
    if (turn === undefined || (turnId !== undefined && turn.turnId !== turnId)) return
    await this.endTurnUnlocked(turn)
  }

  async clear(): Promise<void> {
    const turns = [...this.turns.values()]
    // Keep ended tokens until the next start (or reconnection) to reject late calls.
    await Promise.allSettled(turns.map((turn) => this.endTurnUnlocked(turn)))
  }

  reset(): void {
    void this.clear()
    this.turns.clear()
  }

  ingest(frame: ServerFrame): void {
    if (frame.t !== 'event' || frame.frame.method !== 'session/event') return
    const payload = frame.frame.payload as { sessionId?: unknown; event?: { type?: unknown; turnId?: unknown } } | null
    if (payload === null || typeof payload !== 'object' || typeof payload.sessionId !== 'string') return
    const event = payload.event
    if (event === null || typeof event !== 'object') return
    const turnId = typeof event.turnId === 'string' ? event.turnId : undefined
    if (event.type === 'turn/start') this.start(payload.sessionId, turnId)
    else if (event.type === 'turn/end') void this.end(payload.sessionId, turnId)
  }

  private create(sessionId?: string, turnId?: string): TurnState {
    const controller = new AbortController()
    return { sessionId, turnId, controller, signal: controller.signal }
  }

  private endTurnUnlocked(turn: TurnState): Promise<void> {
    if (turn.cleanup !== undefined) return turn.cleanup
    // Revoke synchronously so delayed approval/attach continuations cannot restart control.
    turn.controller.abort()
    let control: void | Promise<void> = undefined
    try { control = this.releaseControl(turn) } catch { /* debugger cleanup must still run */ }
    turn.cleanup = (async () => {
      try { await control } finally { await this.resources.release(turn.signal) }
    })().catch(() => { /* a failed control cleanup must not reject an event callback */ })
    return turn.cleanup
  }
}
