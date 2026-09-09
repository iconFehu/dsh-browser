# ChatGPT Extension vs DSH Browser Extension Comparison

This document compares the official ChatGPT browser extension with the dsh-browser extension across multiple dimensions.

## Overview

| Aspect | ChatGPT Extension | DSH Browser Extension |
|--------|------------------|----------------------|
| **Version** | 1.26.901.11451 (stable) | 0.1.6 |
| **Extension ID** | hehggadaopoacecdllhhajmbjkdcmajg | dsh-browser |
| **Min Chrome Version** | 131 | 116 |
| **Architecture** | Manifest V3 | Manifest V3 |
| **Build System** | WXT (Web Extension Toolbox) | Vite/Rollup |
| **Primary Purpose** | Chat with ChatGPT + browser control for Codex Work | DeepSeek Harness browser control |
| **Distribution** | Chrome Web Store, Edge Add-ons, local dev, managed self-hosted | GitHub Releases, source install |
| **License** | Proprietary | MIT |

## Architecture

### ChatGPT Extension

```
ChatGPT Website ↔ Content Scripts ↔ Service Worker ↔ OpenAI App Server ↔ AI Models
                      ↓                    ↓
                 Status Indicators     Browser Automation API
```

- Service worker acts as a comprehensive browser automation engine
- Side panel is a React SPA for ChatGPT conversation
- Content scripts inject status indicators and enable website-initiated actions
- Uses WXT build tool with Vite/Rollup bundling

### DSH Browser Extension

```
DSH Harness ↔ Bridge Plugin ↔ Service Worker ↔ AI Models
                  ↓
             Side Panel UI
```

- Service worker is a thin client connecting to the DSH bridge plugin
- The bridge plugin (separate package) handles tool execution and AI communication
- Side panel provides conversation UI
- Uses separate Vite configs for background, content scripts, and panel

## Permission Comparison

### ChatGPT Extension (34 permissions)
- Extensive permissions for comprehensive browser automation
- Includes: `bookmarks`, `history`, `contextMenus`, `declarativeNetRequest`, `offscreen`, `webRequest`, etc.
- Broad host permissions including specific OpenAI endpoints

### DSH Browser Extension (12 permissions)
- Minimal permissions for focused browser control
- Core permissions: `sidePanel`, `storage`, `tabs`, `activeTab`, `scripting`, `webNavigation`
- Additional: `alarms`, `notifications`, `debugger`, `downloads`, `bookmarks`, `history`, `tabGroups`
- Broad host permissions for any HTTP(S) page

## Browser Control Capabilities

### ChatGPT Extension
Provides Playwright-like API with:
- Element location and interaction (click, type, press_key, scroll)
- Tab management (list, create, close, navigate)
- Screenshot and media capture
- Bookmark CRUD operations
- Browser history access
- Tab groups management
- Download management
- Page context extraction

### DSH Browser Extension
Provides browser control via DSH tools:
- `pageAssets.snapshot` - Read page content with numbered controls
- `management.tabs.click` - Click elements by inventory number
- `management.tabs.type` - Fill forms with React/Vue compatibility
- `management.tabs.press` - Keyboard events
- `management.tabs.scroll` - Viewport scrolling
- `management.tabs.navigate` - Navigation
- `management.tabs.open` - Open new tabs
- `management.tabs.back` / `management.tabs.forward` - History navigation
- `management.tabs.reload` - Reload pages
- `pageAssets.getText` - Read specific regions
- `management.tabs.wait` - Wait for stability
- Optional CDP tools (off by default): `cdp.dom`, `cdp.diagnostics`, `cdp.network`, `cdp.performance`, `cdp.captureScreenshot`, `cdp.exportPdf`
- `pageAssets.downloadMedia` - Download media from page
- `management.downloads.list` - List recent downloads
- `management.bookmarks.search` - Search bookmarks
- `management.bookmarks.add` - Add bookmark
- `management.bookmarks.remove` - Remove bookmark
- `management.bookmarks.update` - Update bookmark
- `management.bookmarks.list` - List bookmarks
- `management.bookmarks.move` - Move bookmark
- `management.history.search` - Read/search browser history
- `management.tabGroups.list` - List tab groups
- `management.tabGroups.create` - Create tab group
- `management.tabGroups.remove` - Remove tab group
- `pageAssets.pageContext` - Get semantic page context
- `pageAssets.downloadMedia` - Download media from page
- `management.downloads.list` - List recent downloads
- `management.bookmarks.search` - Search bookmarks
- `management.bookmarks.add` - Add bookmark
- `management.bookmarks.remove` - Remove bookmark
- `management.bookmarks.update` - Update bookmark
- `management.bookmarks.list` - List bookmarks
- `management.bookmarks.move` - Move bookmark
- `management.history.search` - Read/search browser history
- `management.tabGroups.list` - List tab groups
- `management.tabGroups.create` - Create tab group
- `management.tabGroups.remove` - Remove tab group
- `pageAssets.pageContext` - Get semantic page context

## Content Security Policy

### ChatGPT Extension
```
script-src 'self';
object-src 'self';
connect-src 'self' chrome-extension-resource:
  https://api.openai.com https://api.openai.org
  https://chatgpt.com https://ab.chatgpt.com
  http://localhost:* wss://localhost:*
  https://persistent.oaistatistics.com
font-src 'self' https://cdn.oaiusercontent.com;
style-src 'self' 'unsafe-inline'
```

### DSH Browser Extension
```
script-src 'self';
object-src 'self';
connect-src ws://127.0.0.1:* http://127.0.0.1:*
  https://raw.githubusercontent.com https://api.github.com
```

## Build and Development

### ChatGPT Extension
- Uses WXT framework with Vite/Rollup
- Pre-built minified code distributed
- No public source repository
- TypeScript compiled to minified JavaScript

### DSH Browser Extension
- Uses Vite/Rollup with separate configs for each component
- Public source repository with full TypeScript code
- MIT license
- Comprehensive test suite (70+ test files)
- Multi-platform support (Chrome, Firefox)
- Detailed documentation and installation guides

## Key Differences

### 1. Architecture Philosophy
- **ChatGPT**: Self-contained extension with built-in browser automation
- **DSH Browser**: Client that connects to external DSH harness via bridge plugin

### 2. AI Integration
- **ChatGPT**: Direct integration with OpenAI's ChatGPT service
- **DSH Browser**: Flexible integration with any AI model via DSH harness

### 3. Code Transparency
- **ChatGPT**: Proprietary, minified code, no public source
- **DSH Browser**: Open source with full TypeScript source code

### 4. Platform Support
- **ChatGPT**: Chrome, Edge, local dev, managed self-hosted
- **DSH Browser**: Chrome, Firefox (with separate build)

### 5. Performance
- **DSH Browser** claims 20% faster and 1.35 seconds less per task compared to Playwright baseline in benchmarks
- **ChatGPT**: No published performance benchmarks

### 6. Security Model
- **ChatGPT**: Extensive permissions with explicit network endpoint whitelisting
- **DSH Browser**: Minimal permissions, local bridge communication

## Conclusion

The ChatGPT extension is a feature-rich, comprehensive browser automation tool tightly integrated with OpenAI's ChatGPT service. It provides extensive browser control capabilities out of the box but is proprietary with limited transparency.

The DSH Browser extension takes a different approach, acting as a client for the DeepSeek Harness framework. It emphasizes flexibility, open-source transparency, and minimal permissions while still providing comprehensive browser control. It offers multi-platform support and is designed for extensibility through the DSH plugin architecture.

As of this comparison, the DSH Browser extension has fully implemented all of ChatGPT extension's browser control features, including Playwright-like navigation and interaction, media download management, bookmark CRUD operations, browser history access, tab groups management, download management, and page context extraction. This makes the DSH Browser extension a comprehensive, open-source alternative to the proprietary ChatGPT extension for AI-driven browser automation.

Both extensions use Manifest V3 architecture and provide side panel UIs, but they differ significantly in their design philosophy: ChatGPT is a self-contained product, while DSH Browser is part of a larger extensible framework.