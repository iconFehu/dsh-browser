# Agent Note: npm publish and the three-way install split

Status: implemented

English | [中文](2026-09-06-npm-publish-three-way-install.zh.md)

## Problem

Installation grew into "one installer does everything": the Windows bundle and the shell/PowerShell installers download the whole workspace, build the bridge from source, register it into the local `web` profile, build the extension, and stage the unpacked directory for Chrome. Standard `dsh web` users who only need the bridge plus a Chrome load folder got no lighter path, and the bridge package was not publishable at all (`private: true`), so the CLI registration documented in `cordis.patch.yml` (`dsh plugin --profile web add`) could never fetch the plugin from npm.

## Decision

Deliver two independent components and keep the installer as an optional combiner:

- **Bridge plugin = CLI component.** `packages/browser/bridge-browser` becomes publishable as `@yuxianglin/dsh-bridge-browser@0.0.5`: `private: true` is removed, `publishConfig.access` is `public`, and a `prepack` script builds `lib/` (gitignored) so every `pnpm pack`/`publish` ships a fresh artifact. The published file set already covers `lib/*`, `src/*`, `cordis.patch.yml`, and the `./protocol`/`./src/*` exports.
- **Extension = browser component.** `extensions/dsh-browser` keeps shipping its prebuilt `dsh-browser-chrome-vX.Y.Z.zip` as a standalone GitHub Release asset; users load it unpacked from `chrome://extensions`. Firefox stays a source build this cycle.
- **Installers = optional combiner.** `scripts/install.ps1`/`install.sh` keep the offline/bundle flows for Desktop and source web installs, and their web-profile registration step now skips when `@yuxianglin/dsh-bridge-browser` is already present (`install-web.ps1` Step 2 and the matching `install.sh` block), so re-running after a CLI install is a no-op instead of a duplicate registration.
- **Docs.** The root and component READMEs present the three methods — A: `dsh plugin --profile web add -w @yuxianglin/dsh-bridge-browser@0.0.5`; B: download the extension ZIP and load it unpacked; C: `install.ps1` / `install.sh` — with an environment table (standard web / DSH Desktop / source) and drop the "no npm package published yet" caveat.

Package name and scope stay `@yuxianglin/dsh-bridge-browser` (registry-confirmed free); the `@iconfehu` name from the original proposal was rejected to avoid a whole-repo rename. Actual publishing is a manual maintainer step (`pnpm --filter @yuxianglin/dsh-bridge-browser publish --access public`, or the `publish-bridge.yml` workflow with an `NPM_TOKEN` secret) because it needs an npm account that owns the `@yuxianglin` scope.

## Alternatives considered

**Rename the package to `@iconfehu/dsh-bridge-browser`.** Matches the GitHub org and the original proposal, but ripples through `cordis.patch.yml`, source headers, installer constants, tests, and every README for no functional gain.

**Keep a single all-in-one installer as the only channel.** Leaves standard web users without a lightweight path and keeps `install-web.ps1`/`install.sh` (source, Node/pnpm required) as the sole way to register the bridge.

**Ship the extension through `dsh plugin`.** Crosses the component boundary: Chrome extensions are loaded by the browser, not by a harness profile.

## Verification

`pnpm run test:publish` (`scripts/smoke-publish.mjs`) packs the bridge with `pnpm pack`, registers the resulting tarball into a fresh temp-home `web` profile through the real `dsh plugin --profile web add -w file:…` path, boots a real web host, requires `/ext/bridge-config` plus a token-authenticated WS `hello`/`hello.ok` round trip and session RPCs, then exercises `dsh plugin … remove`. This proves the exact bytes npm would install. `runtime.yml` runs it in clean-install CI on Linux and Windows; `release.yml` runs it before packaging and adds PowerShell parse checks for the edited installers; `publish-bridge.yml` gates the workflow publish on it.

## Consequences

The `@yuxianglin` npm scope must be owned and authenticated for the first publish; the registry name was free at decision time and is verified again before each publish. Desktop and offline-bundle users are unaffected — their installer never touches npm. Online standard-web users can now register the bridge with one command and no Git/workspace. The installer's registered-from-source (`link:`) and CLI-registered-from-npm (`file:`/registry) modes coexist because the profile manifest keys both by the same package name; future dsh releases still require re-running the runtime smokes before a release tag.
