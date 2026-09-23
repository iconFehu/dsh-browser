import { useState } from 'react'
import type { ConnectionDiagnostic, DiagnosticCode } from '../background/discovery.ts'
import { safeAddress } from '../background/discovery.ts'
import { getUiLocale } from '../i18n.ts'

const messages: Record<DiagnosticCode, [string, string]> = {
  discovering: ['正在检测本机 DSH…', 'Detecting local DSH…'],
  'not-found': ['未发现服务，请启动 DSH Desktop。自定义端口请在设置中填写桥地址。', 'No service found. Start DSH Desktop, or enter your custom bridge address in Settings.'],
  forbidden: ['Desktop 拒绝浏览器访问。请在 Desktop 设置中选择兼容模式，并开启浏览器访问，然后重新检测。', 'Desktop denied browser access. Select compatibility mode and enable browser access in Desktop settings, then retry.'],
  'missing-bridge': ['服务未提供 bridge 接口。请检查 Desktop 版本，或为标准 web 安装 bridge 插件。', 'The bridge endpoint is missing. Check Desktop compatibility or install the bridge plugin for dsh web.'],
  'invalid-response': ['桥地址或发现响应无效，请检查地址和版本。', 'Invalid bridge address or discovery response. Check the address and version.'],
  authentication: ['认证失败，请检查桥 Token；不会自动清除或绕过认证。', 'Authentication failed. Check the bridge token.'],
  'handshake-timeout': ['桥握手超时，请检查 Desktop 与扩展版本是否兼容。', 'Bridge handshake timed out. Check Desktop and extension compatibility.'],
  replaced: ['连接已被另一浏览器接管。需要使用此浏览器时，点击重新检测。', 'Another browser took over the connection. Retry when you want to use this browser.'],
  connected: ['已连接', 'Connected'],
}

export function ConnectionCard({ diagnostic, address, retry }: {
  diagnostic?: ConnectionDiagnostic
  address?: string
  retry: () => Promise<void>
}) {
  const [feedback, setFeedback] = useState('')
  const zh = getUiLocale() === 'zh'
  const code = diagnostic?.code ?? 'discovering'
  const display = safeAddress(address || diagnostic?.address || '')
  return <section className="settings-panel" aria-label={zh ? '连接引导' : 'Connection setup'} style={{ margin: '12px', padding: '12px', overflowWrap: 'anywhere' }}>
    <strong>{zh ? 'DSH Desktop 连接' : 'DSH Desktop connection'}</strong>
    <p role="status">{messages[code][zh ? 0 : 1]}</p>
    {code !== 'connected' && <details>
      <summary>{zh ? '首次使用步骤' : 'First-time setup'}</summary>
      <ol>
        <li>{zh ? '运行安装器，在 Chrome 扩展管理页加载安装器给出的目录。' : 'Run the installer and load its extension directory in Chrome.'}</li>
        <li>{zh ? '启动 Desktop，在设置中启用兼容模式和浏览器访问。' : 'Start Desktop and enable compatibility mode and browser access in Settings.'}</li>
        <li>{zh ? '保持桥地址为空，点击重新检测；普通网页中可读取、点击及填表。' : 'Leave the bridge address empty and retry; use an ordinary web page to read, click and fill forms.'}</li>
      </ol>
    </details>}
    {display && <p><code>{display}</code></p>}
    <button onClick={() => { void retry().catch(() => setFeedback(zh ? '检测请求失败，请重新打开侧边栏。' : 'Retry failed. Reopen the sidebar.')) }}>{zh ? '重新检测' : 'Detect again'}</button>{' '}
    <button onClick={() => {
      // Deliberate allowlist: no settings, query strings, page data, tokens or server errors.
      const report = JSON.stringify({ version: chrome.runtime.getManifest().version, code, address: display }, null, 2)
      void navigator.clipboard.writeText(report).then(() => setFeedback(zh ? '诊断已复制' : 'Diagnostics copied'), () => setFeedback(zh ? '复制失败' : 'Copy failed'))
    }}>{zh ? '复制诊断' : 'Copy diagnostics'}</button>
    {feedback && <small role="status"> {feedback}</small>}
  </section>
}
