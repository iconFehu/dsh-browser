import { describe, expect, it } from 'vitest'
import { BridgeLogger, type BridgeLogEntry } from '../src/logger.ts'

describe('BridgeLogger', () => {
  it('redacts credentials and drops entries below the level', () => {
    const emitted: BridgeLogEntry[] = []
    const logger = new BridgeLogger((entry) => { emitted.push(entry) })
    logger.debug('bridge.debug', 'hidden')
    logger.warn('bridge.auth.failed', 'token=abc123 authorization: Bearer xyz')
    expect(emitted).toHaveLength(1)
    expect(emitted[0]!.message).not.toContain('abc123')
    expect(emitted[0]!.message).toContain('token=<redacted>')
  })

  it('keeps a bounded ring of recent entries', () => {
    const logger = new BridgeLogger(() => {}, 3)
    for (let i = 0; i < 5; i += 1) logger.info('bridge.rpc.received', `rpc ${i}`)
    expect(logger.recent().map((entry) => entry.message)).toEqual(['rpc 2', 'rpc 3', 'rpc 4'])
  })
})
