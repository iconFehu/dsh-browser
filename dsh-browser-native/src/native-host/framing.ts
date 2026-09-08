const MAX_MESSAGE_BYTES = 16 * 1024 * 1024

export function encodeNativeMessage(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), 'utf8')
  if (payload.byteLength > MAX_MESSAGE_BYTES) throw new Error('Native Messaging payload exceeds 16 MiB')
  const frame = Buffer.allocUnsafe(4 + payload.byteLength)
  frame.writeUInt32LE(payload.byteLength, 0)
  payload.copy(frame, 4)
  return frame
}

export class NativeMessageDecoder {
  private buffer = Buffer.alloc(0)

  push(chunk: Uint8Array): unknown[] {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)])
    const messages: unknown[] = []
    while (this.buffer.byteLength >= 4) {
      const length = this.buffer.readUInt32LE(0)
      if (length > MAX_MESSAGE_BYTES) throw new Error('Native Messaging frame exceeds 16 MiB')
      if (this.buffer.byteLength < 4 + length) break
      const text = this.buffer.subarray(4, 4 + length).toString('utf8')
      this.buffer = this.buffer.subarray(4 + length)
      messages.push(JSON.parse(text) as unknown)
    }
    return messages
  }
}
