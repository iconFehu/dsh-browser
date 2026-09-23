# dsh Browser Control [![dshfind](https://dshfind.com/api/badge/Lum1104/dsh-browser?lang=zh)](https://dshfind.com/zh/plugins/Lum1104/dsh-browser?ref=badge)

**English** | [中文](README.zh.md)

<img width="1701" height="897" alt="dsh Browser Control" src="https://github.com/user-attachments/assets/3b1f3a25-f962-4e02-a9ef-d23e0d01fc8e" />

Connect [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) to the Chrome or Firefox tabs you are already using. The model can read page content, operate controls, navigate, and manage tabs while preserving your login state, session, and cookies. A side panel or sidebar provides the conversation UI.

`dsh` is DeepSeek AI's open-source, plugin-based agent harness. This repository provides a companion browser bridge plugin and Chrome/Firefox MV3 extension as one standalone pnpm workspace.

Browser operation remains text-only: pages become structured text with a numbered inventory of interactive elements, and the model addresses those elements by number. dsh 0.1.5 multimodal chat is separate from that page channel—the side panel accepts PNG, JPEG, WebP, and GIF attachments when the host advertises image support, while browser tools still never capture screenshots.

> [!IMPORTANT]
> The workspace pins dsh 0.1.5-rc.2, the minimum supported runtime. Older DSH releases are not supported.

## Quick install

The standard `dsh plugin` command alone cannot install this project. The integration contains both a dsh bridge plugin and a browser extension. The one-line installer currently sets up the Chrome build.

macOS and Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/Lum1104/dsh-browser/refs/heads/main/scripts/install.sh | bash
```

Windows, in PowerShell:

```powershell
$s="$env:TEMP\dsh-install.ps1"; irm https://raw.githubusercontent.com/Lum1104/dsh-browser/refs/heads/main/scripts/install.ps1 -OutFile $s; powershell -NoProfile -ExecutionPolicy Bypass -File $s
```

When the installer opens `chrome://extensions`, follow its instructions to load or reload **dsh Browser Assistant**. If dsh is already running, restart it after installation. See [Detailed installation and usage](#detailed-installation-and-usage) for prerequisites, startup commands, updates, and developer installation.

> [!IMPORTANT]
> The unscoped [`dsh-browser`](https://www.npmjs.com/package/dsh-browser) package on npm belongs to a different project and is not affiliated with this repository. This project is not currently published as an npm package; use the installer above.

## Performance

In a paired 60-run end-to-end benchmark on August 18, 2026, both backends completed all 30 assigned runs successfully, while dsh Browser Control required fewer model/tool round trips and finished faster:

| Backend | Success | Mean end-to-end latency | Mean browser tool calls |
|---|---:|---:|---:|
| **dsh Browser Control** | **30/30** | **5.32 s** | **3.4** |
| Matched Playwright baseline | 30/30 | 6.67 s | 4.7 |

The paired Playwright / extension duration ratio was **1.24** (95% CI **1.16–1.34**): Playwright took about 24% longer, or equivalently, dsh Browser Control reduced latency by about 20% and saved 1.35 seconds per task on average. The suite used six browser tasks, five deterministic seeds, the same DSH profile and model (`deepseek-v4-flash`), and independently validated page state. See the [benchmark methodology and reproduction guide](benchmark/README.md).

## Core capabilities

The model sees seven high-level capability tools. Each call names a `method` (and, for `management`, a `namespace`), for example `management` with `namespace=tabs, method=list`.

| Capability | Methods wired end to end | Notes |
|---|---|---|
| `pageAssets` | `snapshot` / `getText` | Structured text snapshot (title, URL, main text, numbered controls, masked form fields; `delta: true` returns only changes), or plain text from the page or a selector |
| `management` | `tabs.click` / `type` / `press` / `scroll` / `wait` / `back` / `forward` | Operate numbered targets from the latest snapshot (React/Vue-compatible input; `replace` clears first), send keys, scroll, wait for the page to settle, and move through history |
| `management` | `tabs.list` / `open` / `navigate` / `activate` / `reload` / `close` | List tabs with stable IDs and active/controlled state, open a URL (`active:false` keeps the current tab in front), navigate the controlled tab, follow a listed tab without activating it, or close one listed tab |
| `management` (Chrome) | `bookmarks.search` / `create` / `update` / `delete`, `history.search`, `downloads.list`, `tabGroups.list` / `create` / `ungroup` | Browser API operations; state-changing ones require approval |
| `cdp` (Chrome, opt-in) | `call` with an allowlisted method, `events` | Observation only, behind **Browser developer mode** in Settings: deep DOM read, network and performance metrics, diagnostics, and screenshot/PDF export as a local save dialog |
| `management` | `windows.list`, `tabs.update`, `tabGroups.update`, `downloads.cancel`, `events` | Window list, pin/mute/activate a tab, edit a tab group, cancel a download (these three need approval), and long-poll a browser change log that carries ids only, never titles or URLs |
| `browserAuth` | `request` | Sign-in handoff: the side panel asks you to sign in on the page yourself and choose “I've signed in”. Your credentials never reach the model, which only gets a status (`submitted`, `declined`, `expired`, `origin_changed`, …). Unrestricted control never answers this for you |
| `pageAssets` | `list` / `bundle` | List the images, fonts, stylesheets, and media a page loaded (follows page-sharing settings); an approved bundle saves the selected files to `Downloads/dsh-browser-assets/…`, and the model receives file names and counts, never contents |
| `viewport` (Chrome, opt-in) | `get` / `set` / `reset` | Responsive testing through the same CDP attachment as `cdp`, so it requires **Browser developer mode**; `set` needs approval, and the override disappears when the panel closes or the debugger detaches |
| `visibility` | `get` / `set` | Read whether the browser window is visible, or show/minimize it (approval required) |
| `botDetection` | `report` | Tells you the page is blocked by a CAPTCHA or access denial so you can resolve it; the extension never tries to solve or bypass it |

WebMCP stays internal, as in ChatGPT's extension: tools that a page registers control both their definition and their result, so they are not offered to the model.
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

Requirements: Node.js `^22.19` or `>=24`, Corepack/pnpm, and Chrome 116+ or Firefox 140+. Windows additionally needs Windows PowerShell 5.1, which ships with Windows, or PowerShell 7+.

### Install or update

For a managed installation, run:

```sh
curl -fsSL https://raw.githubusercontent.com/Lum1104/dsh-browser/refs/heads/main/scripts/install.sh | bash
```

or, on Windows:

```powershell
$s="$env:TEMP\dsh-install.ps1"; irm https://raw.githubusercontent.com/Lum1104/dsh-browser/refs/heads/main/scripts/install.ps1 -OutFile $s; powershell -NoProfile -ExecutionPolicy Bypass -File $s
```

The installer downloads `main`, builds and registers the bridge plugin, builds the Chrome extension into `~/.dsh/browser-extension`, and opens `chrome://extensions`. On the first install, load that directory as an unpacked extension; on updates, click **Reload**. Restart dsh if it is already running.

`scripts/install.sh` covers macOS and Linux, and `scripts/install.ps1` covers Windows; both write the same managed workspace and the same install metadata. The installer copies the extension path to the clipboard when a clipboard tool is available (`pbcopy`, `wl-copy`, `xclip`, `xsel`, or PowerShell's `Set-Clipboard`), and prints the path either way. When no Chrome or Chromium install is found, it prints the command that installs one; set `DSH_INSTALL_BROWSER=1` to let the installer attempt that install itself.

The Windows command downloads `install.ps1` and runs it rather than piping it into `Invoke-Expression`: the script is UTF-8 with a byte order mark so Windows PowerShell renders its Chinese output, and `Invoke-Expression` rejects a leading mark. Local checkout paths may contain spaces; the installer registers the bridge through a profile-local directory junction so the package spec never contains the absolute Windows path.

To install the current branch from a source checkout instead:

```sh
git clone https://github.com/Lum1104/dsh-browser.git
cd dsh-browser
./scripts/install.sh
```

On Windows, run `.\scripts\install.ps1` from the checkout instead. After pulling or switching revisions, rerun the installer and reload the extension.

For DSH Desktop on Windows, a tagged release also publishes a prebuilt `dsh-browser-windows.zip`. Extract it and run `powershell -NoProfile -ExecutionPolicy Bypass -File .\install-desktop.ps1`. It needs no Git, Node, or pnpm, verifies the SHA-256 checksum, and installs the extension to `~/.dsh/browser-extension`. Then enable compatibility mode and browser access in Desktop settings and leave the extension's bridge address empty. To build that bundle locally, run `pnpm run build` and then `.\scripts\package-release.ps1`.

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

From a source checkout, run `pnpm start` in the repository root. The exact supported public runtime is:

```sh
npx @deepseek-ai/dsh@0.1.5-rc.2 web
```

Local Chrome use requires no configuration; Firefox requires the local bridge token described above. Open a page, click the DeepSeek whale icon, and wait for **Connected**. Existing HTTP(S) tabs are instrumented on the first action. On browser-protected pages and extension stores, the model can read tab metadata and use browser-level HTTP(S) navigation, back, forward, and reload, but it cannot inspect or operate the protected page DOM.

## Troubleshooting

**Side panel stays "Not connected"**

- Make sure dsh web is running locally (default `http://127.0.0.1:3080`).
- Verify the bridge is loaded: open `http://127.0.0.1:3080/ext/bridge-config`. It should return JSON such as `{"wsUrl":"ws://127.0.0.1:3080/ext/bridge"}`. If it returns a web page instead of JSON, the running dsh predates the bridge registration — restart dsh and refresh the page; the extension reconnects on its own.
- The extension probes ports 3080, 3081, 3090, and 14389 automatically. If dsh runs on another port — or you use a remote `--host 0.0.0.0` deployment — set the address (and bridge token) in the panel settings. Firefox always requires the token.

## Development

The bridge plugin and Chrome/Firefox extension are both members of this repository's workspace. Run all commands from the repository root. For the first development installation, run `pnpm install`.

```sh
pnpm run build
pnpm run typecheck
pnpm run test
pnpm run check:runtime
pnpm run test:smoke

pnpm --filter @yuxianglin/dsh-bridge-browser run build
pnpm --filter @yuxianglin/dsh-bridge-browser run typecheck
pnpm --filter @yuxianglin/dsh-bridge-browser run test

pnpm --filter dsh-browser-extension run build
pnpm --filter dsh-browser-extension run build:firefox
pnpm --filter dsh-browser-extension run test
```

Notes:

- The bridge plugin must have a built `lib/` before startup because the loader consumes it; both `scripts/install.sh` and the root `pnpm run build` build the plugin before the extension.
- The bridge build copies its browser client with Node.js `copyFileSync`, so the same package script works without a Unix `cp` executable.
- The dependencies of `@deepseek-ai/dsh` and the bridge plugin are pinned to the same tested public release line. An upgrade must update the manifests and lockfile together and rerun the root checks.

`check:runtime` checks the resolved DSH dependencies and lockfile; `test:smoke` starts the real web host in a temporary DSH home and verifies the bridge and session reads after a restart, without model credentials. CI runs these checks after a clean installation.

If you encounter `cache.hydratePrepared is not a function`, update the repository, rerun `pnpm install --frozen-lockfile` and `pnpm run build`, then restart `pnpm start`. Session data and the global package cache can be kept.

## Security

- The bridge path sits outside the `/api` trust boundary and performs its own bearer-token authentication.
- Local Chrome extension origins retain zero-configuration loopback access; Firefox origins are per-install UUIDs and must present the bearer token.
- Privileged gateway methods such as `settings.*`, `credentials.*`, and `host.open*` reject non-loopback sources.
- The browser-page pipeline is text-only and never captures screenshots; explicitly attached chat images use dsh's durable attachment service. Password and payment-card values never leave the page.
- When work begins, the assistant binds to the active tab (at prompt submission, or at the first direct browser-tool call). If you switch tabs manually, later browser actions pause and the side panel asks whether the assistant should continue on the original tab or follow the new one. Choosing the original tab permits background operation; the extension never silently retargets or changes your visible tab. Closing the controlled tab also pauses tools until you explicitly select the current page.
- Text you highlight is captured only while a side panel is open and page sharing is not `off`, and never from password or payment-card fields. It stays inside the extension until you send the message, is dropped when you dismiss it or its page navigates or closes, and reaches the model inside the same untrusted-content boundary as page snapshots — including its source title and URL, which the page also controls.
- Page-authored text is wrapped as untrusted input. The default `auto` mode reads only the controlled tab without an extra prompt; privacy-sensitive users can select `ask` for per-read confirmation or `off` to block reads entirely. In `ask` mode, the read dialog can allow one read or persistently switch back to `auto`; this can be reversed in Settings. Read page text is sent to the selected model.
- Click, type, keypress, navigation, history, and reload calls fail closed until the user approves them. There are two trust tiers, both managed in Settings: chat-scoped domains (added with “No confirmation while chatting” in an approval dialog) skip confirmation only while a side panel is open and stay stored until removed; permanently allowed domains apply even with the panel closed. Explicit cross-origin `management.tabs.navigate` calls and unknown history destinations always prompt again.
- **Allow unrestricted browser control** is an explicit global opt-in. It becomes active only after the setting is saved successfully; while enabled, page reads, page actions, and tab list/follow/close operations run without approval prompts. Calls capture their access mode when received, so enabling unrestricted control never retroactively elevates an existing restricted call. Disabling it takes effect immediately, cancels calls that have not dispatched an action, waits for already-dispatched browser operations to settle, and only then saves the restrictive setting. A rapid re-enable remains restricted until that revocation finishes, and concurrent saves persist in request order. Browser-protected DOM content remains inaccessible in either mode.
