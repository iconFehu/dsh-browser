# dsh Browser Control Extension (Chrome and Firefox MV3)

Windows Desktop prebuilt installation and the three install methods live in the [main setup guide](https://github.com/iconFehu/dsh-browser#quick-install): CLI registration for standard web, the prebuilt extension ZIP, and the one-command installers.

English | [中文](README.zh.md)

The **browser-operation end** of dsh: the model reads and operates the browser page you have open — extract content, click elements, fill forms, scroll, and navigate, all in the real page with your login state preserved. The side panel is the conversation entry.

**Two explicit channels**: browser pages are still rendered as structured text (a numbered interactive-element inventory), so browser tools never take screenshots. Separately, a dsh 0.1.2 host can advertise multimodal image limits; the side panel then accepts PNG, JPEG, WebP, and GIF attachments and renders their durable history references.

## What the model can do

| Capability | Action | Notes |
|---|---|---|
| Read page | `browser_snapshot` | Title/URL/main text/numbered inventory/form fields (sensitive values masked); `delta: true` returns only changes |
| Click element | `browser_click` | Click by inventory number (links/buttons/checkboxes…), React/Vue compatible |
| Fill forms | `browser_type` | Type text; `replace` clears first |
| Keys | `browser_press` | Enter/Tab/Escape/arrows etc. |
| Scroll | `browser_scroll` | Viewport scrolling (up/down/top/bottom) |
| Navigate | `browser_navigate` / `browser_open_tab` / `browser_back` / `browser_forward` / `browser_reload` | Navigation inside the controlled tab, or open a URL in a new tab and follow it |
| Read region | `browser_get_text` | Lazy-loaded content / partial text |
| Wait | `browser_wait` | Page load and render-settle detection |
| Chat with images | `session.prompt` / `session.attachment` | Host-gated image selection, image-only sends, and durable history previews |
| Quote what you highlight | side panel composer | The text you select in the page becomes a quote in the composer and rides along with your next message |

## Architecture

```
side panel (React) ◄─port─► background SW/event page ◄─WS─► dsh bridge plugin
                                 │
                  tabs.sendMessage (DSH_ACTION, DSH_SELECTION_WATCH)
                                 ▲ DSH_SELECTION
                                 ▼
                        content script (snapshot/actions/privacy/selection)
```

- **background** (`src/background/`): bridge connection (token auth + exponential-backoff reconnect + keepalive), gateway RPC client, and **fail-closed tool dispatch to a user-controlled tab**.
- **content script** (`src/content/`): text-only snapshot (readability main text + numbered interactive inventory + form fields), **stable element numbers** (`data-dsh-el`), delta changes, click/type/press/scroll/navigate actions, sensitive-field masking, and a debounced selection watcher that stays disarmed until a side panel is open and page sharing is not `off`.
- **panel** (`src/panel/`): React conversation UI (resumable session/history/live events/settings); host-advertised image limits gate image selection and preflight checks, durable attachments render through session-authorized reads, messages render as sanitized Markdown, `ask_user_question` requests render as answerable cards, manual tab switches render a control-handoff strip, an active turn exposes a standard stop control, and a highlighted page passage renders as a removable quote that the next prompt carries inside the untrusted-content boundary.
- **Protocol**: `protocol.ts` in the `@yuxianglin/dsh-bridge-browser` workspace package is the single source of truth, shared by both ends through the package's source export.

## Build

```sh
pnpm install
pnpm --filter dsh-browser-extension run build
pnpm --filter dsh-browser-extension run build:firefox
pnpm --filter dsh-browser-extension run test
```

Run these commands from the repository root. Chrome outputs to `extensions/dsh-browser/dist/`; Firefox outputs to `extensions/dsh-browser/dist-firefox/`.

## Install and use

The extension is a **browser component**: it is installed by loading an unpacked directory (Chrome) or a temporary add-on (Firefox) — never through an npm command. The bridge plugin it talks to is a separate component registered with `dsh` on the command line.

1. **Load the extension (Chrome, Method B).** Download the prebuilt `dsh-browser-chrome-vX.Y.Z.zip` matching your release from [Releases](https://github.com/iconFehu/dsh-browser/releases) — each release tag pins its archive. Extract it to a stable folder, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select that folder. To update, re-extract the newer ZIP over the same folder and click **Reload** on the extension card; the extension also checks published releases itself.

   The one-command installer (Method C) automates the same outcome for the standard `web` runtime: it downloads a managed workspace to `~/.dsh/dsh-browser`, builds the bridge plugin, registers it in the local `web` profile, builds the extension, copies the output to the stable directory `~/.dsh/browser-extension`, and opens `chrome://extensions`:

   ```sh
   curl -fsSL https://github.com/iconFehu/dsh-browser/releases/latest/download/install.sh | bash
   ```

   On Windows run `powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1` (Desktop) or `.\install.ps1 -Runtime Web` from the complete bundle. A cloned checkout uses the same installer without downloading or overwriting source files: `git clone https://github.com/iconFehu/dsh-browser.git && cd dsh-browser && ./scripts/install.sh` (Windows: `.\scripts\install.ps1`). Registration is skipped when the profile already lists the plugin, so re-running after a CLI install is safe.

   Firefox: build it from a checkout (`pnpm --filter dsh-browser-extension run build:firefox`), then load `extensions/dsh-browser/dist-firefox/manifest.json` via `about:debugging#/runtime/this-firefox`.

2. **Start dsh with the bridge plugin mounted**. Standard web users register the bridge once (main guide, Method A):

   ```sh
   npx @deepseek-ai/dsh@0.1.2-rc.1 plugin --profile web add -w @yuxianglin/dsh-bridge-browser@0.0.5
   ```

   then start the pinned runtime:

   ```sh
   npx @deepseek-ai/dsh@0.1.2-rc.1 web
   ```

   Managed-install and checkout users instead run `pnpm start` from `~/.dsh/dsh-browser` or the repository root. Both commands load the same bundle from the local `web` profile. Port 3080 is used by default; append `--port <port>` when it is occupied.

   **DSH Desktop users**: the Desktop app assigns a random local Web port by default (`dsh-desktop.port: 0`), so port-based auto-discovery cannot predict it. Pin the port to `43189` in Desktop settings (see the [deepseek-harness-desktop user guide](https://github.com/anywhere-labs/deepseek-harness-desktop/blob/master/docs/user-guide.en.md)); auto-discovery covers that port. Alternatively, enter `http://127.0.0.1:<port>` manually in the side-panel settings.

   Loading or reloading the extension is passive: it does not probe local ports or open a WebSocket until the side panel is opened. A healthy connection established by the user may remain available for background approvals after the panel closes, but it will not reconnect without an open panel if it drops or another browser replaces it.

3. **Use it**: open a normal `http://` or `https://` page and click the DeepSeek whale icon. Both builds auto-discover local dsh. Chrome loopback connections need no address or token; Firefox must be given the token from `~/.dsh/ext-bridge-token` because a `moz-extension://` UUID is not an add-on identity. Chat directly or click "Read page" first.

Pages that were already open before extension installation or reload are instrumented automatically on the first action, so they do not require a manual refresh. Browser-internal and protected pages such as `chrome://` and the Chrome Web Store cannot be read or operated.

For extension-only development, load `extensions/dsh-browser/dist/` from `chrome://extensions`, or run `build:firefox` and load `extensions/dsh-browser/dist-firefox/manifest.json` from `about:debugging#/runtime/this-firefox`. Rebuild and reload after code changes.

## Why browser operation stays text-only

- **Snapshot as the view**: the model's entire view of the page is structured text (title/URL/main/numbered elements/forms), budgeted at 32k chars by default (plugin-configurable, negotiated to the extension via `hello.ok`).
- **Page text is untrusted input**: snapshots and targeted text reads are enclosed in a fresh nonce-bound trust marker and explicitly tell the model never to treat page-authored commands as instructions. This is defense in depth; extension-side action approval is the enforcement boundary.
- **Stable numbering**: element numbers persist across snapshots (WeakMap + `data-dsh-el`), so the model can say "click 7"; a large page change explicitly reports "numbers reindexed".
- **Delta mode**: `browser_snapshot({delta:true})` returns only changed element numbers, saving tokens.
- **Privacy**: password/credit-card values always render as `••••` and never leave the page; accessible names never use a sensitive field's current value.
- **Tab affinity**: prompt submission binds the active tab before the model starts working; a direct browser-tool call also performs the initial bind when needed. A manual tab/window switch pauses later tools and asks whether the assistant should stay on the original tab or follow the newly visible one. Staying permits explicit background operation without changing the user's visible tab; following resets page-reference state. A closed controlled tab fails closed until the user selects the current page, and a switch withdraws any open action approval.
- **Proportional approval**: the default `auto` mode lets the model read the controlled tab without an extra prompt; `ask` restores per-read confirmation and `off` blocks reads. In `ask` mode, the read dialog can allow one read or persistently switch back to `auto`, which remains reversible in Settings. State-changing tools still fail closed and show their exact origin plus a redacted action summary. The user may deny, allow once, or trust one origin for the current side-panel session; temporary trust clears when the last panel closes or the service worker restarts. Permanent trust is managed explicitly in Settings. If the panel is closed, an approval remains pending for up to 60 seconds and, when enabled, a system notification opens the panel for review. The panel restores the requesting session before showing a session-scoped approval. Caller cancellation or bridge timeout withdraws any open approval before an action can run.
- **Conversation continuity**: reopening the panel resumes the most recently active browser conversation by default, falling back to the latest non-empty durable session before creating a new one. This can be disabled in Settings.

## Permissions

Chrome uses `sidePanel`; Firefox uses `sidebar_action`. Both request `storage` (settings and recent-session continuity), `notifications` (optional reminders for approvals received while the panel is closed), `tabs` + `activeTab` + `scripting` (observe tab changes and inject/message the explicitly controlled tab, including lazy recovery for pages opened before install), `webNavigation` (enumerate and bind messages to that tab's frame documents), `alarms` (background keepalive), and `http/https` (content-script injection on normal pages). Firefox's AMO manifest declares the browsing activity, website content/activity, and personal communications that the add-on sends to the configured dsh/model service. The extension never changes the visible tab or silently follows a manual switch; background operation happens only after the user chooses to stay on the original tab.

## Known limitations

- Only one extension connection at a time. An unopened browser profile never claims it; if another open panel replaces a live connection, the replaced client yields instead of starting a reconnect fight.
- Tab affinity is global to that extension connection rather than per chat session.
- Accessible cross-origin iframes are snapshotted and operated with stable `(frame, index)` addresses. Restricted or short-lived frames are reported as unavailable without failing the whole page snapshot.
- Captcha/image-only controls cannot be handled — the tool result reports "elements with no accessible name" and asks the user to complete that step manually.
- No automatic token rotation.
- Synthetic `browser_press` events do not trigger browser-native default actions such as Tab focus movement, arrow-key scrolling, or Enter activation; use manual input when a workflow depends on those defaults.
- `browser_wait` considers page load plus a fixed quiet window, but does not observe continuously changing DOM state; a live-updating SPA may be reported as stable.
