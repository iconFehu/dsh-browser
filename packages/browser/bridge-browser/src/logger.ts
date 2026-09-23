export type BridgeLogLevel = 'debug' | 'info' | 'warn' | 'error'
export interface BridgeLogEntry {
  id: string
  timestamp: number
  level: BridgeLogLevel
  source: 'bridge'
  event: string
  message: string
  requestId?: string
  rpcId?: string
  sessionId?: string
  durationMs?: number
  transport?: 'websocket' | 'native'
  errorCode?: string
  metadata?: Record<string, string | number | boolean | null>
}

const rank: Record<BridgeLogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }
export class BridgeLogger {
  private readonly entries: BridgeLogEntry[] = []
  private sequence = 0
  private level: BridgeLogLevel = 'info'
  constructor(private readonly emit: (entry: BridgeLogEntry) => void, private readonly capacity = 200) {}
  setLevel(level: BridgeLogLevel): void { this.level = level }
  recent(limit = 50): BridgeLogEntry[] { return this.entries.slice(-limit) }
  clear(): void { this.entries.length = 0 }
  debug(event: string, message: unknown, context?: Partial<BridgeLogEntry>): void { this.write('debug', event, message, context) }
  info(event: string, message: unknown, context?: Partial<BridgeLogEntry>): void { this.write('info', event, message, context) }
  warn(event: string, message: unknown, context?: Partial<BridgeLogEntry>): void { this.write('warn', event, message, context) }
  error(event: string, message: unknown, context?: Partial<BridgeLogEntry>): void { this.write('error', event, message, context) }
  private write(level: BridgeLogLevel, event: string, message: unknown, context?: Partial<BridgeLogEntry>): void {
    if (rank[level] < rank[this.level]) return
    const entry: BridgeLogEntry = { id: `bridge-${Date.now()}-${++this.sequence}`, timestamp: Date.now(), level, source: 'bridge', event, message: String(message).replace(/(token|authorization|bearer|api[-_]?key)\s*[:=]\s*\S+/gi, '$1=<redacted>').slice(0, 240), ...context }
    this.entries.push(entry); while (this.entries.length > this.capacity) this.entries.shift(); this.emit(entry)
  }
}
