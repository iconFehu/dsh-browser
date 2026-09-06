# Agent Note：npm 发布与三路安装拆分

Status: implemented

[English](2026-09-06-npm-publish-three-way-install.md) | 中文

## Problem

安装逐渐长成「一个安装器负责所有事情」：Windows 完整包与 shell/PowerShell 安装器都要下载整个 workspace、从源码构建桥插件、注册到本机 `web` profile、构建扩展并把解压目录备好给 Chrome。标准 `dsh web` 用户只是想要 bridge 加一个 Chrome 加载目录，却没有更轻的路径；而且 bridge 包根本不可发布（`private: true`），`cordis.patch.yml` 里写的 CLI 注册（`dsh plugin --profile web add`）永远无法从 npm 拉到该插件。

## Decision

按两个独立组件交付，安装器降级为可选组合器：

- **桥插件 = 命令行组件。** `packages/browser/bridge-browser` 变为可发布：`@yuxianglin/dsh-bridge-browser@0.0.5` 移除 `private: true`，`publishConfig.access` 设为 `public`，新增 `prepack` 脚本在每次 `pnpm pack`/`publish` 前构建被 gitignore 的 `lib/`，保证产物永远新鲜。发布文件集本就覆盖 `lib/*`、`src/*`、`cordis.patch.yml` 及 `./protocol`/`./src/*` exports。
- **扩展 = 浏览器组件。** `extensions/dsh-browser` 继续以独立 GitHub Release 资产发布预构建 `dsh-browser-chrome-vX.Y.Z.zip`；用户在 `chrome://extensions` 以「加载已解压的扩展程序」加载。Firefox 本轮仍为源码构建。
- **安装器 = 可选组合器。** `scripts/install.ps1`/`install.sh` 保留 Desktop 与源码 web 的离线/bundle 流程；其 web profile 注册步骤在 `@yuxianglin/dsh-bridge-browser` 已存在时跳过（`install-web.ps1` Step 2 与 `install.sh` 对应块），使 CLI 安装之后重跑安装器成为无害的 no-op，而非重复注册。
- **文档。** 根 README 与组件 README 呈现三种方式——A：`dsh plugin --profile web add -w @yuxianglin/dsh-bridge-browser@0.0.5`；B：下载扩展 ZIP 并解压加载；C：`install.ps1`/`install.sh`——配环境表（标准 web / DSH Desktop / 源码），并删除「尚未发布 npm 包」的提示。

包名与 scope 保持 `@yuxianglin/dsh-bridge-browser`（registry 实测未被占用）；原建议中的 `@iconfehu` 名字被否决，以免全仓库改名。实际发布是维护者的手动步骤（`pnpm --filter @yuxianglin/dsh-bridge-browser publish --access public`，或带 `NPM_TOKEN` secret 的 `publish-bridge.yml` 工作流），因为发布需要拥有 `@yuxianglin` scope 的 npm 账号。

## Alternatives considered

**改名 `@iconfehu/dsh-bridge-browser`。** 与 GitHub org 及原建议一致，但会波及 `cordis.patch.yml`、源码头注释、安装器常量、测试与全部 README，且无功能收益。

**单一全功能安装器作为唯一渠道。** 标准 web 用户没有轻量路径，`install-web.ps1`/`install.sh`（源码、需 Node/pnpm）成为注册 bridge 的唯一方式。

**把扩展塞进 `dsh plugin`。** 跨越组件边界：Chrome 扩展由浏览器加载，不属于 harness profile。

## Verification

`pnpm run test:publish`（`scripts/smoke-publish.mjs`）用 `pnpm pack` 打包 bridge，把产物 tarball 通过真实 `dsh plugin --profile web add -w file:…` 路径注册进全新临时 home 的 `web` profile，启动真实 web 宿主，要求 `/ext/bridge-config` 加 token 认证 WS `hello`/`hello.ok` 往返与 session RPC 成功，再执行 `dsh plugin … remove`。这证明 npm 将安装的正是这些字节。`runtime.yml` 在 Linux/Windows 干净安装 CI 中运行它；`release.yml` 在打包前运行并新增对已改安装器的 PowerShell 语法检查；`publish-bridge.yml` 用其把关工作流发布。

## Consequences

首次发布需要拥有并认证 `@yuxianglin` npm scope；决策时 registry 名称未被占用，每次发布前会再次确认。Desktop 与离线 bundle 用户不受影响——他们的安装器从不接触 npm。在线标准 web 用户现在一条命令即可注册 bridge，无需 Git/workspace。安装器的本地源码（`link:`）注册与 CLI 的 npm（`file:`/registry）注册并存，因为 profile manifest 两边都以同一包名为主键；未来 dsh 版本发布前仍需重跑运行时冒烟。
