# Agent Note：浏览器开发者模式（完整 CDP，对齐 Codex）

Status: implemented

[English](2026-09-06-browser-developer-mode-cdp.md) | 中文

## Problem

content script 管线以纯文本读取并操作页面。含 open shadow DOM 或沙箱/无法注入的跨源 iframe 的页面无法被完整读取；console/网络失败对模型不可见；也没有抓取页面（截图/PDF）用于调试的手段。Chrome 通过 `debugger` 权限暴露完整 DevTools Protocol，但这是高风险能力（可取得 cookie、token 等浏览器内部信息），绝不能常驻默认生效。

## Decision

新增**浏览器开发者模式（完整 CDP）**层，对齐 Codex 的开发者模式姿态：

- **默认关闭。** 设置开关 `cdpEnabled`（默认 `false`，仅 Chrome 渲染）门控一切；Chrome manifest 增 `debugger` 与 `downloads`，Firefox manifest 不含（其工具调用返回 `feature-unavailable`）。
- **只做观察。** 点击、输入、滚动与导航保持既有高层 content script 管线不动——即 Codex 的分工。CDP 仅附加到受控标签页观察：`browser_dom`（逐帧深层文本读取，含 open shadow DOM 与无法注入的 iframe，不产清单）、`browser_diagnostics`（console/Log/网络失败）、`browser_network`（请求清单；`includeBodies` 拉取截断的 `Network.getResponseBody` 文本并带敏感数据警告）、`browser_performance`（计数器增量）、`browser_screenshot`/`browser_export_pdf`（`Page.captureScreenshot`/`Page.printToPDF`，经**保存对话框**导出本地文件）。
- **文本仍是文本。** 观察输出有界并包进不可信边界；捕获只落本地、绝不进模型通道。未来 dsh 若支持多模态工具结果可内联；v1 契约不含。
- **生命周期。** `cdp/manager.ts` 在观察工具执行时惰性附加，要求开发者模式 + 面板在开 + http(s) 受控页；侧栏关闭、开关关闭、受控页被关闭/替换或导航离开 http(s) 时分离。附加会暂停该标签页用户自己的 DevTools——设置文案已提示。
- **失败不回退。** 被门禁/不支持时返回新增的 `feature-unavailable` 错误码。

## Alternatives considered

**完整 CDP 常开。** 只有名字像"开发者模式"；在用户日常 Chrome 上常驻浏览器级调试，每次对话都会断开其 DevTools，与 Codex/OpenAI 默认关闭的风险姿态相悖。

**由 CDP 驱动输入。** 早期草案曾把 click/type/press 走 CDP `Input.*`；与 Codex 对比后认定输入应归高层 API，故本层只观察，合成按键限制照旧记录在文档。

**捕获进会话附件通道。** 对话图片走 dsh 附件服务；从 service worker 把 CDP 捕获接进去需要新的宿主契约。v1 用本地保存对话框导出，自包含且对用户可见。

## Verification

`tests/cdp.spec.ts` 用假 debugger 适配器驱动 attach 状态机与事件缓冲（门禁、附加/启用域、面板/开关分离、切页、console/Log/网络捕获含取消、base64 响应体、性能基线、其它标签页隔离）。`tests/cdp-tools.spec.ts` 用假 manager 覆盖工具分发（各类拒绝、附加失败映射、审批结果、untrusted 边界内渲染、深层 DOM 读取、经 downloads stub 的截图导出）。`tests/manifests.spec.ts` 断言 Chrome/Firefox 权限分拆。扩展 typecheck 与 376 项测试、bridge typecheck、根构建全绿。

## Consequences

Chrome Web Store 会显示 `debugger`/`downloads` 警告；扩展如实声明其用途（仅开发者模式）。调试 Web 应用时无需离开对话即可获得 DevTools 级观察。后续：多模态工具结果通道内联捕获、响应体按请求 pin origin、以及 `cdpEnabled` 的企业策略钉死（对齐 Codex managed-config flag）。
