import type { HostRequest, HostResponse } from '../shared/host-protocol.js'
import { NativeMessageDecoder, encodeNativeMessage } from './framing.js'

export interface ByteTransport {
  onData(listener: (chunk: Buffer) => void): void
  onClose(listener: () => void): void
  write(chunk: Buffer): void
}

export function createStdioTransport(): ByteTransport {
  return {
    onData(listener) { process.stdin.on('data', listener) },
    onClose(listener) { process.stdin.once('close', listener); process.stdin.once('end', listener) },
    write(chunk) { process.stdout.write(chunk) },
  }
}

export function runNativeMessageLoop(
  transport: ByteTransport,
  handle: (request: unknown) => Promise<HostResponse | undefined>,
): void {
  const decoder = new NativeMessageDecoder()
  let closed = false
  transport.onData((chunk) => {
    if (closed) return
    let frames: unknown[]
    try { frames = decoder.push(chunk) } catch (error) {
      process.stderr.write(`native messaging decode error: ${String(error)}\n`)
      closed = true
      return
    }
    for (const frame of frames) {
      void handle(frame).then((response) => {
        if (response !== undefined && !closed) transport.write(encodeNativeMessage(response))
      }).catch((error) => {
        process.stderr.write(`native messaging handler error: ${String(error)}\n`)
      })
    }
  })
  transport.onClose(() => { closed = true })
}
