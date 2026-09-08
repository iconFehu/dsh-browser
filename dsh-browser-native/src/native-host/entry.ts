import { CodexBackend, DshBackend } from './adapters.js'
import { DshBridgeTransport } from './dsh-transport.js'
import { CodexAppServerTransport } from './codex-transport.js'
import type { SocketLike } from './dsh-transport.js'
import { startNativeHost } from './main.js'

const backend = process.env.DSH_BACKEND === 'codex' ? 'codex' : 'dsh'
const url = backend === 'codex'
  ? (process.env.CODEX_APP_SERVER_URL ?? 'ws://127.0.0.1:4500')
  : (process.env.DSH_BRIDGE_URL ?? 'ws://127.0.0.1:3080/ext/bridge')
const token = process.env.DSH_BRIDGE_TOKEN ?? ''

function createSocket(target: string): SocketLike {
  const WebSocketCtor = (globalThis as unknown as { WebSocket?: new (url: string) => unknown }).WebSocket
  if (!WebSocketCtor) throw new Error('This Native Host runtime does not provide WebSocket')
  return new WebSocketCtor(target) as SocketLike
}

const transport = backend === 'codex'
  ? new CodexAppServerTransport(url, createSocket)
  : new DshBridgeTransport(url, token, createSocket)
startNativeHost([backend === 'codex' ? new CodexBackend(transport) : new DshBackend(transport)])
