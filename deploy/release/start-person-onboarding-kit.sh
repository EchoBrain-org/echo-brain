#!/usr/bin/env bash
# One-action first-cohort employee install, sign-in, and permission-aware smoke.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
NODE="$SCRIPT_DIR/node"
VERIFY="$SCRIPT_DIR/verify-person-onboarding-kit.mjs"
RELEASE_TOOL="$SCRIPT_DIR/clean-v1-release.mjs"

fail() { printf 'ECHO setup: %s\n' "$*" >&2; exit 1; }

require_safe_owned_directory_or_absent() {
  local path="$1"
  [[ ! -L "$path" ]] || fail 'an ECHO application path is a symbolic link'
  if [[ -e "$path" ]]; then
    [[ -d "$path" ]] || fail 'an ECHO application path is not a directory'
    [[ "$(stat -f '%u' "$path")" == "$(id -u)" ]] || \
      fail 'an ECHO application directory is owned by another user'
  fi
}

require_private_owned_directory() {
  local path="$1"
  require_safe_owned_directory_or_absent "$path"
  [[ -d "$path" && "$(stat -f '%Lp' "$path")" == 700 ]] || \
    fail 'an ECHO application directory is not private'
}

require_safe_owned_regular_file_or_absent() {
  local path="$1"
  [[ ! -L "$path" ]] || fail 'an ECHO application file is a symbolic link'
  if [[ -e "$path" ]]; then
    [[ -f "$path" ]] || fail 'an ECHO application file is not a regular file'
    [[ "$(stat -f '%u' "$path")" == "$(id -u)" ]] || \
      fail 'an ECHO application file is owned by another user'
  fi
}

[[ $# -le 1 ]] || fail 'open Start ECHO.command or pass one invitation file path'
[[ -n "${HOME:-}" && "$HOME" = /* ]] || fail 'a normal macOS user HOME is required'
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || \
  fail 'this first-cohort kit supports macOS on Apple silicon only'
[[ -f "$NODE" && ! -L "$NODE" && -x "$NODE" ]] || fail 'the bundled Node runtime is unavailable'
[[ -f "$VERIFY" && ! -L "$VERIFY" ]] || fail 'the kit verifier is unavailable'
[[ -f "$RELEASE_TOOL" && ! -L "$RELEASE_TOOL" ]] || fail 'the release verifier is unavailable'

"$NODE" "$VERIFY" "$SCRIPT_DIR" >/dev/null
"$NODE" "$RELEASE_TOOL" validate "$SCRIPT_DIR/release.json" >/dev/null

invitation="${1:-}"
if [[ -z "$invitation" ]]; then
  command -v osascript >/dev/null 2>&1 || fail 'choose the invitation by passing its file path to Start ECHO.command'
  invitation="$(osascript -e 'POSIX path of (choose file with prompt "Choose your ECHO invitation file")')" || \
    fail 'no invitation was selected'
fi
[[ "$invitation" = /* ]] || fail 'the invitation path must be absolute'
[[ -f "$invitation" && ! -L "$invitation" ]] || fail 'the invitation must be a regular file'

release_id="$("$NODE" "$RELEASE_TOOL" field "$SCRIPT_DIR/release.json" release-id)"
expected_version="$("$NODE" "$RELEASE_TOOL" field "$SCRIPT_DIR/release.json" client-version)"
application_root="$HOME/Library/Application Support/ECHO"
releases_root="$application_root/releases"
bin_root="$application_root/bin"
raycast_root="$application_root/raycast"
release_root="$releases_root/$release_id"
require_safe_owned_directory_or_absent "$application_root"
require_safe_owned_directory_or_absent "$releases_root"
require_safe_owned_directory_or_absent "$bin_root"
require_safe_owned_directory_or_absent "$raycast_root"
install -d -m 0700 "$application_root" "$releases_root" "$bin_root" "$raycast_root"
chmod 0700 "$application_root" "$releases_root" "$bin_root" "$raycast_root"
require_private_owned_directory "$application_root"
require_private_owned_directory "$releases_root"
require_private_owned_directory "$bin_root"
require_private_owned_directory "$raycast_root"

if [[ ! -e "$release_root" ]]; then
  staging="$(mktemp -d "$releases_root/.${release_id}.XXXXXXXX")"
  cleanup_staging() { rm -rf -- "$staging"; }
  trap cleanup_staging EXIT
  chmod 0700 "$staging"
  install -m 0755 "$NODE" "$staging/node"
  install -m 0755 "$VERIFY" "$staging/verify-person-onboarding-kit.mjs"
  install -m 0755 "$RELEASE_TOOL" "$staging/clean-v1-release.mjs"
  install -m 0600 "$SCRIPT_DIR/release.json" "$staging/release.json"
  install -m 0600 "$SCRIPT_DIR/kit-manifest.v1.json" "$staging/kit-manifest.v1.json"
  install -m 0600 "$SCRIPT_DIR/person-client.tgz" "$staging/person-client.tgz"
  tar -xzf "$staging/person-client.tgz" -C "$staging"
  [[ -f "$staging/package/dist/main.js" && ! -L "$staging/package/dist/main.js" ]] || \
    fail 'the Person-client entrypoint is missing from the kit'
  [[ -f "$staging/package/dist/raycast-cli-main.js" && ! -L "$staging/package/dist/raycast-cli-main.js" ]] || \
    fail 'the Raycast helper is missing from the kit'
  "$staging/node" "$staging/verify-person-onboarding-kit.mjs" "$staging" >/dev/null
  [[ "$("$staging/node" "$staging/package/dist/main.js" --version)" == "$expected_version" ]] || \
    fail 'the Person-client version does not match the release'
  mv "$staging" "$release_root"
  trap - EXIT
else
  require_private_owned_directory "$release_root"
  "$release_root/node" "$release_root/verify-person-onboarding-kit.mjs" "$release_root" >/dev/null
  [[ "$("$release_root/node" "$release_root/package/dist/main.js" --version)" == "$expected_version" ]] || \
    fail 'the installed Person-client version does not match the release'
  [[ -f "$release_root/package/dist/raycast-cli-main.js" && ! -L "$release_root/package/dist/raycast-cli-main.js" ]] || \
    fail 'the installed Raycast helper is unavailable'
fi

wrapper_pending="$(mktemp "$bin_root/.echo-brain.XXXXXXXX")"
chmod 0700 "$wrapper_pending"
printf '#!/usr/bin/env bash\nexec %q %q "$@"\n' \
  "$release_root/node" "$release_root/package/dist/main.js" > "$wrapper_pending"
chmod 0700 "$wrapper_pending"
mv -f "$wrapper_pending" "$bin_root/echo-brain"

invitation_root="$(mktemp -d "$application_root/.invitation.XXXXXXXX")"
cleanup_invitation() { rm -rf -- "$invitation_root"; }
trap cleanup_invitation EXIT
chmod 0700 "$invitation_root"
install -m 0600 "$invitation" "$invitation_root/invitation.json"

"$release_root/node" "$release_root/package/dist/main.js" person start \
  --invitation "$invitation_root/invitation.json"

raycast_command="$raycast_root/ask-echo.sh"
require_safe_owned_regular_file_or_absent "$raycast_command"
raycast_command_pending="$(mktemp "$raycast_root/.ask-echo.XXXXXXXX")"
chmod 0700 "$raycast_command_pending"
printf '%s\n' \
  '#!/bin/bash' \
  '# Required parameters:' \
  '# @raycast.schemaVersion 1' \
  '# @raycast.title Ask ECHO' \
  '# @raycast.mode fullOutput' \
  '# @raycast.argument1 { "type": "text", "placeholder": "Ask ECHO a question" }' \
  '' > "$raycast_command_pending"
printf '[[ $# -eq 1 && -n "$1" ]] || exit 64\nexec %q %q %q "$1"\n' \
  "$release_root/node" \
  "$release_root/package/dist/raycast-cli-main.js" \
  "$bin_root/echo-brain" >> "$raycast_command_pending"
chmod 0700 "$raycast_command_pending"
mv -f "$raycast_command_pending" "$raycast_command"

printf 'ECHO is ready. Your command is: %s\n' "$bin_root/echo-brain"
printf 'Raycast: add this Script Commands directory: %s\n' "$raycast_root"
printf 'Then assign a hotkey to "Ask ECHO" in Raycast Settings > Extensions.\n'
