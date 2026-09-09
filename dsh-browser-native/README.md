# dsh-browser-native

ChatGPT 浏览器扩展能力的独立重建版本。扩展通过 Chrome/Firefox Native Messaging 连接 Native Host，再由 Native Host 选择 Codex App Server 或 DSH Bridge。

## 架构

```text
Side Panel / Content Script
          │ Native Messaging
          ▼
Native Host ── BackendRouter ── Codex App Server
                         └───── DSH Bridge
```

协议和能力 ID 位于 `src/shared`，浏览器实现位于 `extension/src`，后端传输位于 `src/native-host`。DSH 是后端适配器，不会渗透到页面动作代码中。

## 能力

已注册的兼容能力：

- `management`：窗口、标签页查询/激活/关闭
- `viewport`：读取、设置、重置视口
- `visibility`：读取和设置浏览器窗口可见状态
- `cdp`：受 allowlist 约束的 DOM、AX tree、性能和截图/PDF 调用
- `pageAssets`：列出页面资源并按类型打包
- `browserAuth`：按 selector 读取认证表单并执行显式提交动作
- `webmcp`：读取并调用页面 WebMCP 工具
- `botDetection`：向后端报告受支持的挑战原因

页面动作通过 `capability.action` 传递，并使用 `pageAssets.snapshot`、`management.tabs.click` 等 capability 与 method 组合。

## 开发

```powershell
pnpm install
pnpm --filter dsh-browser-native typecheck
pnpm --filter dsh-browser-native test
pnpm --filter dsh-browser-native build:host
pnpm --filter dsh-browser-native-extension typecheck
pnpm --filter dsh-browser-native-extension build
```

打包扩展：

```powershell
pnpm --filter dsh-browser-native-extension package
pnpm --filter dsh-browser-native-extension package:firefox
```

## 运行后端

默认使用 DSH：

```powershell
$env:DSH_BACKEND = 'dsh'
$env:DSH_BRIDGE_URL = 'ws://127.0.0.1:3080/ext/bridge'
$env:DSH_BRIDGE_TOKEN = '<token>'
node dist/native-host.mjs
```

使用 Codex App Server：

```powershell
$env:DSH_BACKEND = 'codex'
$env:CODEX_APP_SERVER_URL = 'ws://127.0.0.1:4500'
node dist/native-host.mjs
```

## Native Messaging 安装

先构建 Host，然后设置实际的扩展 ID：

```powershell
$env:DSH_EXTENSION_ID = '<unpacked-or-store-extension-id>'
pnpm --filter dsh-browser-native install:host
```

安装脚本会为 `.mjs` Host 生成平台启动器：Windows 使用 `.cmd`，macOS/Linux 使用可执行 `.sh`。Chrome 清单安装位置可通过 `DSH_NATIVE_MANIFEST_PATH` 覆盖；Host 路径可通过 `DSH_NATIVE_HOST_PATH` 覆盖。

Firefox 使用 `com.dsh.browser.native.firefox.json`，扩展 ID 必须与 Firefox manifest 中的 `browser_specific_settings.gecko.id` 一致。

也可以让安装脚本直接生成 Firefox 清单：

```powershell
$env:DSH_EXTENSION_ID = 'dsh-browser-native@dsh-browser-native'
pnpm --filter dsh-browser-native install:host:firefox
```

## 当前验证

Native Host 的单元测试覆盖 Native Messaging framing、dispatcher、Codex/DSH transport 和能力校验；Chrome/Firefox 扩展均可完成类型检查、构建和 ZIP 打包。真实 DSH/Codex 端到端验证需要对应服务正在运行并提供连接地址/token。
