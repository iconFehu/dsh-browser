# dsh Browser Control

**English** | [中文](README.zh.md)

<img width="1701" height="897" alt="dsh Browser Control" src="https://github.com/user-attachments/assets/3b1f3a25-f962-4e02-a9ef-d23e0d01fc8e" />

Connect [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) to the Chrome or Firefox tab you are already using. The model can read page content, click controls, fill forms, scroll, and navigate while preserving your login state, session, and cookies. A side panel or sidebar provides the conversation UI.

`dsh` is DeepSeek AI's open-source, plugin-based agent harness. This repository provides a companion browser bridge plugin and Chrome/Firefox MV3 extension as one standalone pnpm workspace.

Browser operation remains text-only: pages become structured text with a numbered inventory of interactive elements, and the model addresses those elements by number. dsh 0.1.2 multimodal chat is separate from that page channel—the side panel accepts PNG, JPEG, WebP, and GIF attachments when the host advertises image support, while browser tools still never capture screenshots.

> [!IMPORTANT]
> The workspace pins dsh 0.1.2-rc.1, the minimum supported runtime. Older DSH releases are not supported.

## Quick install

Two independent components, each installed its own way:

| Component | What it is | How it installs |
|---|---|---|
| **Bridge plugin** — `@yuxianglin/dsh-bridge-browser` | dsh plugin that mounts the token-authenticated `/ext/bridge` and the text-only `browser_*` tools | Command line: `dsh plugin --profile web add` |
| **Chrome/Firefox extension** | MV3 side panel that drives your controlled tab through the bridge | Browser: load an unpacked folder from `chrome://extensions` |

| Environment | Bridge plugin | Extension |
|---|---|---|
| Standard `dsh web` | Method A (CLI) or Method C | Method B or C |
| DSH Desktop (bridge built in) | none — Desktop provides its own bridge | Method B or C |

### Method A — pure CLI (standard dsh web)

Requires Node.js with the pinned dsh CLI and the published bridge package:

```sh
npx @deepseek-ai/dsh@0.1.2-rc.1 plugin --profile web add -w @yuxianglin/dsh-bridge-browser@0.0.5
npx @deepseek-ai/dsh@0.1.2-rc.1 web
```

To remove:

```sh
npx @deepseek-ai/dsh@0.1.2-rc.1 plugin --profile web remove @yuxianglin/dsh-bridge-browser
```

> [!NOTE]
> Method A needs `@yuxianglin/dsh-bridge-browser@0.0.5` published to the npm registry. Until the first publish lands, use Method C, or register the `*.tgz` shipped inside the release bundle the same way (`dsh plugin --profile web add -w file:…`).

### Method B — install the extension ZIP

1. Download `dsh-browser-chrome-v0.1.4.zip` from [Releases](https://github.com/iconFehu/dsh-browser/releases) — each release tag pins its matching archive.
2. Extract it to a stable folder.
3. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select that folder.

To update, re-extract the newer ZIP over the same folder and click **Reload** on the extension card. The extension itself also checks published releases.

### Method C — one-command installer (combines both)

**Windows + DSH Desktop (recommended):** download **dsh-browser-windows.zip** from [Releases](https://github.com/iconFehu/dsh-browser/releases), extract the entire bundle, then run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

Desktop installation uses prebuilt files without Git, Node or pnpm and does not register another Desktop bridge. On first use, enable developer mode at `chrome://extensions`, choose **Load unpacked**, and select the directory printed by the installer. Start DSH Desktop, select **compatibility mode**, and enable **browser access** in its settings. Leave the extension bridge address empty and open its sidebar to connect automatically. First-time Chrome loading and Desktop access settings require user interaction.

**macOS / Linux and standard dsh web** (source install): requires Node.js `^22.19` or `>=24`, pnpm, and Chrome 116+ or Firefox 140+:

```sh
curl -fsSL https://github.com/iconFehu/dsh-browser/releases/latest/download/install.sh | bash
```

For standard web on Windows, run `powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Runtime Web` from the complete bundle. It needs development dependencies and builds/registers the bridge in the web profile, skipping registration when the bridge is already present.

## Performance

In a paired 60-run end-to-end benchmark on August 18, 2026, both backends completed all 30 assigned runs successfully, while dsh Browser Control required fewer model/tool round trips and finished faster:

| Backend | Success | Mean end-to-end latency | Mean browser tool calls |
|---|---:|---:|---:|
| **dsh Browser Control** | **30/30** | **5.32 s** | **3.4** |
| Matched Playwright baseline | 30/30 | 6.67 s | 4.7 |

The paired Playwright / extension duration ratio was **1.24** (95% CI **1.16–1.34**): Playwright took about 24% longer, or equivalently, dsh Browser Control reduced latency by about 20% and saved 1.35 seconds per task on average. The suite used six browser tasks, five deterministic seeds, the same DSH profile and model (`deepseek-v4-flash`), and independently validated page state. See the [benchmark methodology and reproduction guide](benchmark/README.md).

## Core capabilities

| Capability | Tool | Notes |
|---|---|---|
| Read page | `browser_snapshot` | Structured text snapshot: title, URL, main text, numbered controls, and masked form fields; `delta: true` returns only changes |
| Click element | `browser_click` | Click links, buttons, checkboxes, and other controls by inventory number |
| Fill forms | `browser_type` | React/Vue-compatible input; `replace` clears the field first |
| Press keys | `browser_press` | Keyboard events such as Enter, Tab, Escape, and arrow keys |
| Scroll | `browser_scroll` | Viewport scrolling: up, down, top, and bottom |
| Navigate | `browser_navigate` / `browser_open_tab` / `browser_back` / `browser_forward` / `browser_reload` | Navigation inside the controlled tab, or open a URL in a new tab and follow it |
| Read region | `browser_get_text` | Lazy-loaded or partial page text |
| Wait for stability | `browser_wait` | Page-load and render-settle detection |
| Send images | `session.prompt` / `session.attachment` | Host-capability-gated image drafts, image-only prompts, and durable history previews |
| Quote a selection | side panel composer | Text you highlight in the page appears in the composer and is sent with your next message as fenced, attributed page content |

## Repository layout

```
packages/browser/bridge-browser/
  cordis.patch.yml
extensions/dsh-browser/
scripts/install.sh
scripts/install.ps1
```

## Why this design

- **Your real browser, not a headless copy**: the model works in the page you already have open, retaining logins, sessions, and cookies.
- **A text-first page interface**: numbered controls, stable IDs across snapshots, delta updates, and masked sensitive values make pages operable without screenshots; user-attached chat images use dsh's separate multimodal message path.
- **Pointing instead of describing**: highlight the passage you mean and the side panel quotes it, so "explain this" needs no page tour. The quote is captured only while a panel is open, and nothing is sent until you send the message.
- **A narrow privacy boundary**: passwords and payment-card values are always rendered as `••••` and never leave the page.
- **A guarded bridge**: authenticated handshakes protect remote connections, privileged gateway methods reject non-loopback callers, and the extension binds tools to one user-controlled tab.

## Detailed installation and usage

### Install or update

Windows Desktop installation requires Windows PowerShell 5.1+, Chrome 116+, and a compatible DSH Desktop bridge. Local inspection confirmed that Desktop 2.0.5 starts at port `43120`. Discovery checks `43120–43152`, then historical ports and standard web; the last authenticated Desktop address is preferred. A manual address overrides discovery.

The default directory is `~/.dsh/browser-extension`; set `DSH_HOME` or `-DshHome` to change its root. A complete bundle works offline. The installer validates SHA-256 and required extension files, backs up existing managed files, and restores them on failure. Successful updates retain and print the backup path. Unmanaged directories are preserved and cause installation to stop.

To update, download and extract the complete ZIP, rerun the installer, and click Reload in Chrome. The extension checks published GitHub Releases rather than main. Each installer pins its release; Desktop users can explicitly select another release with `-Version`.

Source development:

```sh
git clone https://github.com/iconFehu/dsh-browser.git
cd dsh-browser
pnpm install --frozen-lockfile
pnpm build
```

For source web installation on Windows run `.\scripts\install.ps1 -Runtime Web`; on macOS/Linux run `./scripts/install.sh`. Local checkouts use their own source; remote installations pin a release tag. To package Desktop locally, run `.\scripts\package-release.ps1` and use the complete bundle in `release`.

### Firefox source build

Firefox uses a separate MV3 manifest, event-page background, and sidebar. Build it from a checkout, then open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select `extensions/dsh-browser/dist-firefox/manifest.json`:

```sh
pnpm install
pnpm --filter dsh-browser-extension run build:firefox
```

The bridge address is still auto-discovered. Firefox's `moz-extension://` UUID does not authenticate an add-on, so copy the bearer token from `~/.dsh/ext-bridge-token` into the extension settings (the dsh startup log reports that file's path). Signed distribution can package the same `dist-firefox/` output.

### Start and use

Start the managed installation with:

```sh
cd ~/.dsh/dsh-browser && pnpm start
```

From a source checkout, run `pnpm start` in the repository root. Once it is published, the exact supported public runtime is:

```sh
npx @deepseek-ai/dsh@0.1.2-rc.1 web
```

Local Chrome use requires no configuration; Firefox requires the local bridge token described above. Open an `http://` or `https://` page, click the DeepSeek whale icon, and wait for **Connected**. Existing tabs are instrumented on the first action; protected browser pages and extension stores are not supported.

## Troubleshooting

- No service found: start Desktop, or manually enter a custom port outside the discovery range.
- HTTP 403: enable Desktop compatibility mode and browser access. The extension does not bypass this control.
- HTTP 404: check Desktop compatibility or register the bridge plugin for standard web.
- Authentication failure: check the bridge token. Handshake timeout: check host/extension compatibility.
- Replaced connection: automatic retry stops; use Detect again to explicitly reclaim the bridge.
- Settings show the current address, retry and redacted diagnostics. Reports omit tokens, URL queries and page content.

Desktop does not require `pnpm start`. Source startup commands apply only to standard web.

## Development

The bridge plugin and Chrome/Firefox extension are both members of this repository's workspace. Run all commands from the repository root. For the first development installation, run `pnpm install`.

```sh
pnpm run build
pnpm run typecheck
pnpm run test
pnpm run check:runtime
pnpm run test:smoke
pnpm run test:publish

pnpm --filter @yuxianglin/dsh-bridge-browser run build
pnpm --filter @yuxianglin/dsh-bridge-browser run typecheck
pnpm --filter @yuxianglin/dsh-bridge-browser run test

pnpm --filter dsh-browser-extension run build
pnpm --filter dsh-browser-extension run build:firefox
pnpm --filter dsh-browser-extension run test
```

Notes:

- The bridge plugin must have a built `lib/` before startup because the loader consumes it; both `scripts/install.sh` and the root `pnpm run build` build the plugin before the extension.
- The dependencies of `@deepseek-ai/dsh` and the bridge plugin are pinned to the same tested public release line. An upgrade must update the manifests and lockfile together and rerun the root checks.

`check:runtime` checks the resolved DSH dependencies and lockfile; `test:smoke` starts the real web host in a temporary DSH home and verifies the bridge and session reads after a restart, without model credentials. `test:publish` packs the bridge, registers that tarball into a fresh `web` profile with the real `dsh plugin` command, and boots a host against it — the same bytes `pnpm publish` ships. CI runs these checks after a clean installation; `publish-bridge.yml` can publish to npm from a `bridge-v*` tag or manual dispatch.

If you encounter `cache.hydratePrepared is not a function`, update the repository, rerun `pnpm install --frozen-lockfile` and `pnpm run build`, then restart `pnpm start`. Session data and the global package cache can be kept.

## Security

- The bridge path sits outside the `/api` trust boundary and performs its own bearer-token authentication.
- Local Chrome extension origins retain zero-configuration loopback access; Firefox origins are per-install UUIDs and must present the bearer token.
- Privileged gateway methods such as `settings.*`, `credentials.*`, and `host.open*` reject non-loopback sources.
- The browser-page pipeline is text-only and never captures screenshots; explicitly attached chat images use dsh's durable attachment service. Password and payment-card values never leave the page.
- When work begins, the assistant binds to the active tab (at prompt submission, or at the first direct browser-tool call). If you switch tabs manually, later browser actions pause and the side panel asks whether the assistant should continue on the original tab or follow the new one. Choosing the original tab permits background operation; the extension never silently retargets or changes your visible tab. Closing the controlled tab also pauses tools until you explicitly select the current page.
- Text you highlight is captured only while a side panel is open and page sharing is not `off`, and never from password or payment-card fields. It stays inside the extension until you send the message, is dropped when you dismiss it or its page navigates or closes, and reaches the model inside the same untrusted-content boundary as page snapshots — including its source title and URL, which the page also controls.
- Page-authored text is wrapped as untrusted input. The default `auto` mode reads only the controlled tab without an extra prompt; privacy-sensitive users can select `ask` for per-read confirmation or `off` to block reads entirely. In `ask` mode, the read dialog can allow one read or persistently switch back to `auto`; this can be reversed in Settings. Read page text is sent to the selected model.
- Click, type, keypress, navigation, history, and reload calls fail closed until the user approves them. An origin may be trusted for the current side-panel session (cleared when the last panel closes or the service worker restarts), while permanent trust is managed explicitly in Settings. Explicit cross-origin `browser_navigate` calls and unknown history destinations always prompt again.
