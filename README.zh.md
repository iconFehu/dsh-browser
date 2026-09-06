# dsh 浏览器操作

[English](README.md) | **中文**

<img width="1701" height="897" alt="dsh 浏览器操作" src="https://github.com/user-attachments/assets/3b1f3a25-f962-4e02-a9ef-d23e0d01fc8e" />

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 连接到你正在使用的 Chrome 或 Firefox 标签页。模型可以读取页面内容、点击控件、填写表单、滚动与导航，同时保留登录态、会话和 Cookie。侧边栏提供对话界面。

`dsh` 是由 DeepSeek AI 开发的开源、插件化 agent harness（智能体框架）。本仓库将配套的浏览器桥插件与 Chrome/Firefox MV3 扩展组成一个独立的 pnpm workspace。

浏览器操作仍采用纯文本设计：页面会转换为结构化文本和带编号的交互元素清单，模型通过编号定位元素。dsh 0.1.2 的多模态对话走独立通道——宿主声明图片能力时，侧栏可发送 PNG、JPEG、WebP 和 GIF；浏览器工具本身从不把截图发给模型。只有可选的**浏览器开发者模式**（完整 CDP，默认关闭，Chrome）才能经保存对话框把截图/PDF 导出为本地文件。

> [!IMPORTANT]
> 当前工作区固定使用 dsh 0.1.2-rc.1，也是最低支持版本；不再支持旧版 DSH。

## 快速安装

两个独立组件，各自安装：

| 组件 | 是什么 | 怎么安装 |
|---|---|---|
| **桥插件** — `@yuxianglin/dsh-bridge-browser` | dsh 插件：挂载 token 认证的 `/ext/bridge` 与纯文本 `browser_*` 工具 | 命令行：`dsh plugin --profile web add` |
| **Chrome/Firefox 扩展** | MV3 侧边栏：经 bridge 驱动你受控的标签页 | 浏览器：在 `chrome://extensions` 加载已解压的目录 |

| 环境 | 桥插件 | 扩展 |
|---|---|---|
| 标准 `dsh web` | 方式 A（命令行）或方式 C | 方式 B 或 C |
| DSH Desktop（内置 bridge） | 无需——Desktop 自带 | 方式 B 或 C |

### 方式 A：纯命令行（标准 dsh web）

需要 Node.js 与固定版本的 dsh CLI，以及已发布的 bridge 包：

```sh
npx @deepseek-ai/dsh@0.1.2-rc.1 plugin --profile web add -w @yuxianglin/dsh-bridge-browser@0.0.5
npx @deepseek-ai/dsh@0.1.2-rc.1 web
```

卸载：

```sh
npx @deepseek-ai/dsh@0.1.2-rc.1 plugin --profile web remove @yuxianglin/dsh-bridge-browser
```

> [!NOTE]
> 方式 A 需要 `@yuxianglin/dsh-bridge-browser@0.0.5` 已发布到 npm registry。首次发布之前，请改用方式 C，或用同样命令注册发布包内附带的 `*.tgz`（`dsh plugin --profile web add -w file:…`）。

### 方式 B：安装扩展 ZIP

1. 从 [Releases](https://github.com/iconFehu/dsh-browser/releases) 下载 `dsh-browser-chrome-v0.1.4.zip`——每个发布标签对应匹配的归档。
2. 解压到固定目录。
3. 打开 `chrome://extensions`，开启**开发者模式**，点击**加载已解压的扩展程序**，选择该目录。

更新时把新版 ZIP 解压覆盖到同一目录，再点击扩展卡片上的**重新加载**。扩展本身也会检查已发布的 Release。

### 方式 C：一键安装器（组合两者）

**Windows + DSH Desktop（推荐）：** 从 [Releases](https://github.com/iconFehu/dsh-browser/releases) 下载 **dsh-browser-windows.zip**，完整解压后运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

安装器默认使用预构建扩展，不需要 Git、Node 或 pnpm，不会重复注册 Desktop 的 bridge。首次在 Chrome 的 `chrome://extensions` 开启开发者模式，点击“加载已解压的扩展程序”，选择安装器打印的目录。启动 DSH Desktop，在设置中选择**兼容模式**并开启**浏览器访问**。扩展桥地址留空，打开侧边栏自动连接。Chrome 首次加载和 Desktop 访问设置需要用户操作。

**macOS / Linux 与标准 dsh web**（源码安装）：要求 Node.js `^22.19` 或 `>=24`、pnpm，Chrome 116+ 或 Firefox 140+：

```sh
curl -fsSL https://github.com/iconFehu/dsh-browser/releases/latest/download/install.sh | bash
```

Windows 标准 web 在完整安装包中运行 `powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Runtime Web`。它需要开发依赖并构建、注册 web profile 的 bridge；bridge 已注册时自动跳过。

## 性能基准

在 2026 年 8 月 18 日完成的 60 次配对端到端评测中，两个后端分配到的 30 次运行均全部成功；dsh 浏览器操作使用了更少的模型/工具轮次，并以更短时间完成任务：

| 后端 | 成功率 | 平均端到端耗时 | 平均浏览器工具调用 |
|---|---:|---:|---:|
| **dsh 浏览器操作** | **30/30** | **5.32 秒** | **3.4** |
| 对齐工具契约的 Playwright 基线 | 30/30 | 6.67 秒 | 4.7 |

Playwright / 扩展的配对耗时比为 **1.24**（95% CI **1.16–1.34**）：Playwright 耗时约多 24%；等价地说，dsh 浏览器操作将延迟降低约 20%，每个任务平均节省 1.35 秒。评测使用 6 个浏览器任务、5 个确定性 seed、相同的 DSH profile 与模型（`deepseek-v4-flash`），并通过独立页面状态验证结果。详见[评测方法与复现说明](benchmark/README.md)。

## 核心能力

| 能力 | 工具 | 说明 |
|---|---|---|
| 读取页面 | `browser_snapshot` | 结构化文本快照：标题/URL/正文/编号交互清单/表单字段（敏感值掩码）；`delta: true` 只返回变化 |
| 点击元素 | `browser_click` | 按编号点击链接/按钮/复选框等 |
| 填写表单 | `browser_type` | 输入文本（React/Vue 受控组件兼容），`replace` 清空重填 |
| 按键 | `browser_press` | 键盘事件（Enter/Tab/Escape/方向键…） |
| 滚动 | `browser_scroll` | 视口滚动（up/down/top/bottom） |
| 页面导航 | `browser_navigate` / `browser_open_tab` / `browser_back` / `browser_forward` / `browser_reload` | 受控标签页内导航，或新开标签页并跟随 |
| 读取区域 | `browser_get_text` | 懒加载内容 / 局部文本 |
| 等待稳定 | `browser_wait` | 页面加载与渲染稳定检测 |
| 发送图片 | `session.prompt` / `session.attachment` | 按宿主能力启用图片草稿、纯图片消息和持久历史预览 |
| 引用选中内容 | 侧栏输入框 | 在页面里划选的文字会出现在输入框，随下一条消息一起发送，并带上来源与不可信内容边界 |

### 浏览器开发者模式（完整 CDP，Chrome，默认关闭）

对齐 Codex 的开发者模式姿态，扩展在设置中提供**浏览器开发者模式**开关，**默认关闭**。在 Chrome 开启后，助手可以对受控标签页附加 Chrome DevTools Protocol，但**只做观察**——点击、输入、滚动与导航仍走常规高层工具：

- `browser_dom` — 逐帧深层文本读取，含 open shadow DOM 与沙箱/无法注入的跨源 iframe
- `browser_diagnostics` — console 报错/警告、Log 条目、失败或 HTTP 4xx/5xx 网络请求
- `browser_network` — 近期请求；`includeBodies` 还会拉取截断的响应体（可能含 token 或个人数据——一律视为不可信）
- `browser_performance` — Chrome 性能计数器增量
- `browser_screenshot` / `browser_export_pdf` — 把标签页存为 PNG/PDF 并打开保存对话框落到本地文件；捕获内容绝不进入模型通道

附加期间会暂停该标签页你自己的 DevTools。侧栏关闭、开发者模式关闭、受控页离开 http(s)、被关闭或被替换时，调试器立即分离。Firefox 不提供这些工具。观察工具返回的页面/浏览器文本一律标记为不可信输入。

## 组成

```
packages/browser/bridge-browser/
  cordis.patch.yml
extensions/dsh-browser/
scripts/install.sh
scripts/install.ps1
```

## 为什么这样设计

- **使用你的真实浏览器，而不是无头副本**：模型操作你已经打开的页面，登录态、会话和 Cookie 均会保留。
- **纯文本页面接口**：编号控件、跨快照稳定 ID、delta 更新和敏感值掩码，使模型无需截图也能操作页面；用户主动添加的对话图片走 dsh 独立的多模态消息通道。
- **用「指」代替「描述」**：直接划选你要问的那段文字，侧栏会把它引用下来，说「解释这个」不必再描述整页内容。只有侧栏打开时才会捕获，并且在你发送消息之前不会离开浏览器。
- **收窄隐私边界**：密码和支付卡字段始终显示为 `••••`，字段值不会离开页面。
- **受保护的桥连接**：远程连接使用认证握手，特权网关方法拒绝非回环调用方，扩展把工具绑定到一个由用户控制的标签页。

## 详细安装与使用

### 安装或更新

Windows Desktop 要求 Windows PowerShell 5.1+、Chrome 116+ 和提供兼容 bridge 的 DSH Desktop。当前现场确认 Desktop 2.0.5 使用 `43120` 起始端口；扩展自动检查 `43120–43152`，然后检查历史端口及标准 web。上次握手成功的 Desktop 地址优先，手动地址优先于全部自动发现。

安装器默认写入 `~/.dsh/browser-extension`，支持 `DSH_HOME` 或 `-DshHome` 指定根目录。完整安装包可离线使用；安装前校验 SHA-256 和扩展文件，更新前备份旧目录，失败自动恢复。成功后的备份路径会打印出来。遇到非托管目录会停止，不覆盖用户源码。

更新时重新下载完整 ZIP 并运行安装器，然后在 Chrome 点击“重新加载”。扩展中的更新提示检查 GitHub 已发布 Release，不以 main 分支代替发布版本。每份安装器固定自身对应版本，`-Version` 可为 Desktop 显式指定其他发布版本。

源码开发安装：

```sh
git clone https://github.com/iconFehu/dsh-browser.git
cd dsh-browser
pnpm install --frozen-lockfile
pnpm build
```

Windows 源码 web 安装运行 `.\scripts\install.ps1 -Runtime Web`；macOS/Linux 运行 `./scripts/install.sh`。本地 checkout 使用本地源码；远程安装固定发布标签。Desktop 本地打包运行 `.\scripts\package-release.ps1`，然后使用 `release` 中的完整包。

### Firefox 源码构建

Firefox 使用独立的 MV3 manifest、事件页后台和 Sidebar。在 checkout 中构建后，打开 `about:debugging#/runtime/this-firefox`，选择「临时载入附加组件」，再选取 `extensions/dsh-browser/dist-firefox/manifest.json`：

```sh
pnpm install
pnpm --filter dsh-browser-extension run build:firefox
```

桥地址仍会自动探测。Firefox 的 `moz-extension://` UUID 不能证明扩展身份，因此需要把 `~/.dsh/ext-bridge-token` 中的 bearer token 填入扩展设置（dsh 启动日志会报告该文件路径）。签名发布时可直接使用同一份 `dist-firefox/` 产物。

### 启动与使用

启动托管安装：

```sh
cd ~/.dsh/dsh-browser && pnpm start
```

使用源码 checkout 时，请在仓库根目录运行 `pnpm start`。待正式发布后，受支持的精确公开版本为：

```sh
npx @deepseek-ai/dsh@0.1.2-rc.1 web
```

Chrome 本机使用无需配置；Firefox 需要填写上述本地桥 token。打开任意 `http://` 或 `https://` 页面，点击 DeepSeek 鲸鱼图标，等待侧边栏显示**已连接**。已有标签页会在第一次操作时自动加载；浏览器受保护页面和扩展商店不受支持。

## 故障排查

- 未发现服务：启动 Desktop；自定义范围外端口在扩展设置中手动填写。
- 403：在 Desktop 中启用兼容模式和浏览器访问。扩展不会绕过此访问控制。
- 404：服务没有提供 bridge，检查 Desktop 版本或标准 web 的插件注册。
- 认证失败：检查桥 Token；握手超时：检查宿主与扩展协议兼容性。
- 被另一浏览器接管：自动重试停止，需要主动点击“重新检测”才能重新获取连接。
- 设置页显示当前地址、重新检测按钮和脱敏诊断。诊断不包含 Token、地址查询参数或页面内容。

Desktop 模式不需要运行 `pnpm start`。下方源码启动命令仅适用于标准 web。

## 开发

桥接插件和 Chrome/Firefox 扩展都属于本仓库 workspace；所有命令均在本仓库根目录执行。首次开发安装运行 `pnpm install`。

```sh
pnpm run build
pnpm run typecheck
pnpm run test
pnpm run check:runtime
pnpm run test:smoke
pnpm run test:publish
pnpm run test:git-install

pnpm --filter @yuxianglin/dsh-bridge-browser run build
pnpm --filter @yuxianglin/dsh-bridge-browser run typecheck
pnpm --filter @yuxianglin/dsh-bridge-browser run test

pnpm --filter dsh-browser-extension run build
pnpm --filter dsh-browser-extension run build:firefox
pnpm --filter dsh-browser-extension run test
```

注意：

- 启动前桥接插件必须已有 `lib/` 供 Loader 加载；`scripts/install.sh` 和根目录 `pnpm run build` 都会先构建插件再构建扩展。
- `@deepseek-ai/dsh` 与桥接插件的依赖固定在同一条经过验证的公开发布线上；升级时必须同时更新 manifest、锁文件并重跑根目录检查。

`check:runtime` 检查实际解析的 DSH 依赖和锁文件；`test:smoke` 使用临时 DSH home 启动真实 web 宿主，验证桥接和重启后的会话读取，无需模型密钥。`test:publish` 打包 bridge，用真实 `dsh plugin` 命令把该 tarball 注册进全新的 `web` profile 并启动宿主——与 `pnpm publish` 交付的是同一份字节。`test:git-install` 以 git 通道做同样的事：把本 checkout 全新 clone 一份，经 `dsh plugin --profile web add …#path:/packages/browser/bridge-browser` 注册，含 pnpm 对 git 依赖要求的 allowBuilds 放行。CI 在干净安装后运行这些检查；`publish-bridge.yml` 可在 `bridge-v*` 标签或手动触发时发布到 npm。

如果遇到 `cache.hydratePrepared is not a function`，更新仓库后重新运行 `pnpm install --frozen-lockfile` 和 `pnpm run build`，再重启 `pnpm start`。无需删除会话数据或清空全局缓存。

## 安全

- 桥路径在 `/api` 信任栅栏之外，自带 bearer token 认证。
- Chrome 扩展的本地 Origin 保留零配置回环访问；Firefox Origin 是每次安装生成的 UUID，必须携带 bearer token。
- 特权网关方法（`settings.*`/`credentials.*`/`host.open*`）对非回环来源一律拒绝。
- 单活动连接。浏览器页面管线为纯文本：只有可选的**浏览器开发者模式**（完整 CDP；默认关闭；仅 Chrome）能观察更深的 DOM/网络/控制台/性能状态，或经保存对话框把截图/PDF 导出为本地文件——捕获内容绝不发给模型，且侧栏关闭或受控页改绑即分离调试器。用户主动添加的对话图片交给 dsh 持久附件服务，密码和卡号值永不回传。
- 助手开始工作时会绑定当时的活动标签页（提交提示时绑定；直接调用浏览器工具时则在首次调用绑定）。用户手动切页后，后续浏览器操作会暂停，侧栏会询问让助手继续原页面还是跟随新页面；选择原页面后允许在后台继续，但扩展绝不静默改绑或切换用户正在看的页面。受控标签页关闭后也会暂停，直到用户显式选择当前页。
- 只有在侧栏打开、且页面共享不是「关闭」时才会捕获划选内容，密码和卡号字段永不读取。内容在发送之前始终留在扩展内部；移除、页面跳转或标签页关闭都会丢弃它；发送时与页面快照一样包在不可信内容边界内，来源标题和 URL 同样由页面提供，因此也放在边界之内。
- 网页文字会标记为不可信输入。默认「自动共享」只按需读取受控标签页且不额外弹窗；对隐私敏感时可选择「每次询问」，或用「关闭」完全阻断读取。在「每次询问」模式下，读取弹窗可以仅允许一次，也可以持久切回自动读取；之后仍可在设置中关闭。读取的页面文字会发送给当前选择的模型。
- 点击、输入、按键、导航、历史跳转和刷新默认失败关闭，必须由用户批准。免确认域名分两档：**对话期间免确认**（条目在设置中移除前一直保留，仅在侧栏对话开启时生效，关掉侧栏只是暂时不生效）与**永久免确认**（侧栏关闭也有效，在设置中显式管理）。显式跨域 `browser_navigate` 和未知目标的历史跳转始终重新询问。
