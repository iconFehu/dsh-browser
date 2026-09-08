# dsh-browser-native

面向 ChatGPT/Codex 浏览器扩展能力模型的独立兼容实现。

当前基础层包含：

- ChatGPT 风格能力注册表：`botDetection`、`browserAuth`、`cdp`、`management`、`pageAssets`、`viewport`、`visibility`、`webmcp`。
- Native Messaging JSON framing 与输入校验。
- 可插拔的 Codex / DSH backend router。
- Host 请求分发、deadline、取消和错误映射。

项目是独立实现，不使用 OpenAI 官方扩展签名、密钥或品牌身份。后续后端适配器可以分别连接独立 Codex App Server 和现有 DSH Bridge。

## 开发

```powershell
pnpm install
pnpm --filter dsh-browser-native typecheck
pnpm --filter dsh-browser-native test
```
