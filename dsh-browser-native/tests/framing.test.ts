import { describe, expect, it } from 'vitest'
import { NativeMessageDecoder, encodeNativeMessage } from '../src/native-host/framing.js'

describe('Native Messaging framing', () => {
  it('round trips messages split across chunks', () => {
    const encoded = encodeNativeMessage({ type: 'hello', value: '中文' })
    const decoder = new NativeMessageDecoder()
    expect(decoder.push(encoded.subarray(0, 3))).toEqual([])
    expect(decoder.push(encoded.subarray(3))).toEqual([{ type: 'hello', value: '中文' }])
  })

  it('decodes multiple frames in one chunk', () => {
    const decoder = new NativeMessageDecoder()
    const chunk = Buffer.concat([encodeNativeMessage(1), encodeNativeMessage({ ok: true })])
    expect(decoder.push(chunk)).toEqual([1, { ok: true }])
  })
})
