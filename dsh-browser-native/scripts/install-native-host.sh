#!/usr/bin/env sh
set -eu
host_path="${DSH_NATIVE_HOST_PATH:-$(pwd)/dist/native-host.mjs}"
extension_id="${DSH_EXTENSION_ID:-REPLACE_WITH_EXTENSION_ID}"
if [ "$(uname -s)" = "Darwin" ]; then
  target="${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.dsh.browser.native.json"
else
  target="${XDG_CONFIG_HOME:-${HOME}/.config}/google-chrome/NativeMessagingHosts/com.dsh.browser.native.json"
fi
mkdir -p "$(dirname "$target")"
DSH_NATIVE_HOST_PATH="$host_path" DSH_EXTENSION_ID="$extension_id" DSH_NATIVE_MANIFEST_PATH="$target" node "$(dirname "$0")/install-native-host.mjs"
