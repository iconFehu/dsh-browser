# Agent Note: Browser developer mode (full CDP, Codex-aligned)

Status: implemented

English | [中文](2026-09-06-browser-developer-mode-cdp.zh.md)

## Problem

The content-script pipeline reads and operates pages text-only. Pages with open shadow DOM or sandboxed/uninjectable cross-origin iframes could not be fully read, console/network failures were invisible to the model, and there was no way to capture a page (screenshot/PDF) for debugging. Chrome exposes the full Chrome DevTools Protocol through the `debugger` permission, but that is a high-risk capability (it can expose cookies, tokens, and other browser internals), so it must not be ambient.

## Decision

Add a **browser developer mode (full CDP)** layer mirroring Codex's developer-mode posture:

- **Off by default.** A Settings switch `cdpEnabled` (default `false`, Chrome-only rendering) gates everything; the Chrome manifest adds `debugger` and `downloads`; the Firefox manifest does not (its tool calls answer `feature-unavailable`).
- **Observation only.** Clicks, typing, scrolling and navigation keep the high-level content-script pipeline untouched — Codex's division of labor. CDP attaches to the controlled tab purely to observe: `cdp.dom` (deep per-frame text incl. open shadow DOM and uninjectable iframes, no inventory), `cdp.diagnostics` (console/Log/network failures), `cdp.network` (request list; `includeBodies` fetches capped `Network.getResponseBody` text with a sensitive-data warning), `cdp.performance` (counter deltas), and `cdp.captureScreenshot`/`cdp.exportPdf` (PNG/PDF via `Page.captureScreenshot`/`Page.printToPDF`, exported through a **save dialog** to a local file).
- **Text stays text.** Observation output is bounded and wrapped in the untrusted-content boundary; captures are saved locally and never enter the model channel. A future dsh multimodal tool-result channel could inline captures; the v1 contract does not.
- **Lifecycle.** `cdp/manager.ts` attaches lazily when an observation tool runs, requiring developer mode + an open panel + an http(s) controlled tab; it detaches when the panel closes, the switch turns off, or the controlled tab closes, is replaced, or navigates off http(s). Attaching pauses the user's own DevTools for that tab, which the Settings copy warns about.
- **Errors never fall back silently.** Gated/unsupported cases return the new `feature-unavailable` tool error code.

## Alternatives considered

**Full CDP access always on.** Matches "developer mode" only in name; ambient browser-level debugging on the user's everyday Chrome would detach their DevTools on every chat and contradict the Codex/OpenAI default-off warning posture.

**CDP-driven input.** Earlier drafts routed click/type/press through CDP `Input.*`; the Codex comparison concluded high-level APIs should own input, so this layer is observation-only and the synthetic-key limitation stays documented.

**Captures into the session attachment channel.** Chat images use dsh's attachment service; plumbing CDP captures there from the service worker would need a new host contract. Local save-dialog exports keep v1 self-contained and user-visible.

## Verification

`tests/cdp.spec.ts` drives the attach state machine and event buffers with a fake debugger adapter (gating, attach/enable domains, panel/switch detach, tab switch, console/Log/network capture incl. cancellation, base64 bodies, performance baselines, other-tab isolation). `tests/cdp-tools.spec.ts` covers tool dispatch with a fake manager (refusals, attach-failure mapping, authorization outcomes, renderers inside the untrusted boundary, deep-DOM reads, screenshot export via a downloads stub). `tests/manifests.spec.ts` asserts the Chrome/Firefox permission split. Extension typecheck and 376 tests, bridge typecheck, and the root build are green.

## Consequences

The Chrome Web Store listing shows `debugger` and `downloads` warnings; the extension is honest about their scope (developer mode only). Users debugging web apps get DevTools-grade observation without leaving the chat. Future work: inline captures via a multimodal tool-result channel, per-request origin pinning for response bodies, and enterprise pinning of `cdpEnabled` (mirroring Codex's managed-config flag).
