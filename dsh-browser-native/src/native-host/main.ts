import { BackendRouter } from './backend.js'
import { HostDispatcher } from './dispatcher.js'
import { createStdioTransport, runNativeMessageLoop } from './transport.js'
import { encodeNativeMessage } from './framing.js'
import type { BrowserBackend } from './backend.js'

export function startNativeHost(backends: readonly BrowserBackend[], extensionId = process.env.DSH_EXTENSION_ID ?? 'dsh-browser-native'): void {
  const router = new BackendRouter(backends)
  const dispatcher = new HostDispatcher({ extensionId, backend: (process.env.DSH_BACKEND as 'codex' | 'dsh') ?? 'dsh', router })
  const transport = createStdioTransport()
  router.onEvent((event) => transport.write(encodeNativeMessage({ type: 'event', event })))
  runNativeMessageLoop(transport, (request) => dispatcher.handle(request))
}
