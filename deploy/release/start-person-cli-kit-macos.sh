#!/usr/bin/env bash
# macOS arm64 installer for the offline ECHO Person-client CLI kit.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
NODE="$SCRIPT_DIR/node"
VERIFY="$SCRIPT_DIR/verify-person-onboarding-kit.mjs"
RELEASE_TOOL="$SCRIPT_DIR/clean-v1-release.mjs"

fail() { printf 'ECHO CLI setup: %s\n' "$*" >&2; exit 1; }
usage() { printf 'usage: Start-ECHO.sh --install-only\n' >&2; exit 2; }

require_safe_owned_directory() {
  local path="$1" label="$2"
  [[ ! -L "$path" && -d "$path" ]] || fail "$label must be a directory, not a symbolic link"
  [[ "$(/usr/bin/stat -f '%u' "$path")" == "$(/usr/bin/id -u)" ]] || fail "$label must be owned by the current user"
}

require_private_directory() {
  require_safe_owned_directory "$1" "$2"
  [[ "$(/usr/bin/stat -f '%Lp' "$1")" == 700 ]] || fail "$2 must have mode 0700"
}

require_safe_regular_file() {
  local path="$1" label="$2"
  [[ ! -L "$path" && -f "$path" ]] || fail "$label must be a regular file, not a symbolic link"
}

require_absolute_safe_path() {
  local path="$1" label="$2"
  [[ "$path" = /* && "$path" != *$'\n'* && "/$path/" != *'/../'* ]] || fail "$label must be an absolute safe path"
}

ensure_owned_directory_chain() {
  local target="$1" label="$2" part cursor='' owner owned=0
  require_absolute_safe_path "$target" "$label"
  IFS=/ read -r -a parts <<< "${target#/}"
  for part in "${parts[@]}"; do
    [[ -n "$part" && "$part" != . && "$part" != .. ]] || continue
    cursor="$cursor/$part"
    if [[ -e "$cursor" || -L "$cursor" ]]; then
      [[ ! -L "$cursor" && -d "$cursor" ]] || fail "$label path component must be a directory, not a symbolic link"
      owner="$(/usr/bin/stat -f '%u' "$cursor")"
      if [[ "$owner" == "$(/usr/bin/id -u)" ]]; then owned=1
      elif [[ "$owned" == 1 ]]; then fail "$label path component must be owned by the current user"
      fi
    else
      [[ "$owned" == 1 ]] || fail "$label must be within an existing current-user-owned directory"
      /bin/mkdir -m 0700 "$cursor" || fail "could not create $label; check destination permissions and free disk space"
    fi
  done
  [[ "$owned" == 1 ]] || fail "$label must be owned by the current user"
}

validate_macos_arm64() {
  [[ "$(/usr/bin/uname -s)" == Darwin && "$(/usr/bin/uname -m)" == arm64 ]] || fail 'this kit supports macOS on Apple silicon only'
  local macos_version
  macos_version="$(/usr/bin/sw_vers -productVersion)"
  [[ "$macos_version" =~ ^([0-9]+)\. ]] || fail 'could not determine macOS version'
  (( BASH_REMATCH[1] >= 14 )) || fail 'macOS 14 or later is required by ECHO CLI; update macOS before installing'
}

validate_macos_arm64_node_header() {
  require_safe_regular_file "$NODE" 'the bundled Node runtime'
  [[ -x "$NODE" ]] || fail 'the bundled Node runtime is not executable'
  local bytes
  read -r -a bytes <<< "$(LC_ALL=C /usr/bin/od -An -v -t u1 -N 16 "$NODE")"
  # Thin little-endian Mach-O 64: arm64 (all), MH_EXECUTE.
  [[ ${#bytes[@]} -eq 16 && ${bytes[0]} == 207 && ${bytes[1]} == 250 && ${bytes[2]} == 237 && ${bytes[3]} == 254 && \
     ${bytes[4]} == 12 && ${bytes[5]} == 0 && ${bytes[6]} == 0 && ${bytes[7]} == 1 && \
     ${bytes[8]} == 0 && ${bytes[9]} == 0 && ${bytes[10]} == 0 && ${bytes[11]} == 0 && \
     ${bytes[12]} == 2 && ${bytes[13]} == 0 && ${bytes[14]} == 0 && ${bytes[15]} == 0 ]] || \
    fail 'the bundled Node runtime is not a 64-bit arm64 Mach-O executable'
}

validate_client_archive_layout() {
  local archive="$1" entry mode entries modes
  entries="$(/usr/bin/tar -tzf "$archive")" || fail 'the Person-client archive cannot be read'
  while IFS= read -r entry; do
    [[ -n "$entry" && "$entry" != /* && "$entry" != *'//' && \
       "$entry" != *'/../'* && "$entry" != ../* && \
       ( "$entry" == package || "$entry" == package/* ) ]] || fail 'the Person-client archive has an unsafe layout'
  done <<< "$entries"
  modes="$(/usr/bin/tar -tvzf "$archive")" || fail 'the Person-client archive cannot be read'
  while IFS= read -r mode; do
    [[ "${mode:0:1}" == - || "${mode:0:1}" == d ]] || fail 'the Person-client archive contains a non-regular entry'
  done <<< "$modes"
}

expected_wrapper_sha256=''
if [[ $# -eq 3 && "$1" == --install-only && "$2" == --expected-wrapper-sha256 ]]; then
  [[ "$3" =~ ^[a-f0-9]{64}$ ]] || usage
  expected_wrapper_sha256="$3"
  set -- --install-only
fi
[[ $# -eq 1 && "$1" == --install-only ]] || usage
[[ -n "${HOME:-}" && "$HOME" = /* ]] || fail 'a normal macOS user HOME is required'
validate_macos_arm64
validate_macos_arm64_node_header

runtime_version="$("$NODE" --version 2>/dev/null)" || fail 'the bundled Node runtime cannot start; re-extract the approved kit'
[[ "$runtime_version" == v22.22.1 ]] || fail 'the bundled Node version is wrong; re-extract the approved kit'
for required in "$VERIFY" "$RELEASE_TOOL" "$SCRIPT_DIR/release.json" "$SCRIPT_DIR/kit-manifest.v1.json" \
  "$SCRIPT_DIR/person-client.tgz" "$SCRIPT_DIR/build-identity.v1.json"; do
  require_safe_regular_file "$required" 'a required kit artifact'
done
"$NODE" "$VERIFY" "$SCRIPT_DIR" >/dev/null || fail 'the CLI kit verification failed; re-extract the approved kit and verify the owner-provided archive checksum'
"$NODE" "$RELEASE_TOOL" validate "$SCRIPT_DIR/release.json" >/dev/null || fail 'the release record verification failed'

release_id="$("$NODE" "$RELEASE_TOOL" field "$SCRIPT_DIR/release.json" release-id)"
expected_version="$("$NODE" "$RELEASE_TOOL" field "$SCRIPT_DIR/release.json" client-version)"
[[ "$release_id" =~ ^clean-v1-[a-z0-9][a-z0-9.-]*$ ]] || fail 'the release record has an invalid release ID'
trap 'fail "installation could not write or extract files; check destination permissions and free disk space, then retry"' ERR

# This root is intentionally disjoint from the native ECHO app and its session data.
root="$HOME/Library/Application Support/ECHO/cli"
ensure_owned_directory_chain "$root" 'the ECHO CLI data root'
/bin/chmod 0700 "$root"
require_private_directory "$root" 'the ECHO CLI data root'
releases_root="$root/releases"
bin_root="$root/bin"
ensure_owned_directory_chain "$releases_root" 'the ECHO CLI releases directory'
ensure_owned_directory_chain "$bin_root" 'the ECHO CLI command directory'
/bin/chmod 0700 "$releases_root" "$bin_root"
require_private_directory "$releases_root" 'the ECHO CLI releases directory'
require_private_directory "$bin_root" 'the ECHO CLI command directory'

install_lock="$root/.installer-lock"
/bin/mkdir -m 0700 "$install_lock" 2>/dev/null || fail 'another or interrupted ECHO CLI setup owns the installer lock'
staging=''
pending_wrapper=''
cleanup() {
  [[ -z "$staging" || ! -d "$staging" ]] || /bin/rm -rf -- "$staging"
  [[ -z "$pending_wrapper" || ! -f "$pending_wrapper" ]] || /bin/rm -f -- "$pending_wrapper"
  /bin/rmdir "$install_lock" 2>/dev/null || true
}
trap cleanup EXIT

if [[ -n "$expected_wrapper_sha256" ]]; then
  require_safe_regular_file "$bin_root/echo-brain" 'the active ECHO CLI command'
  actual_wrapper_sha256="$(/usr/bin/shasum -a 256 "$bin_root/echo-brain")"
  [[ "${actual_wrapper_sha256%% *}" == "$expected_wrapper_sha256" ]] || fail 'the active ECHO CLI release changed during download; check again'
fi

release_root="$releases_root/$release_id"
if [[ -e "$release_root" || -L "$release_root" ]]; then
  require_private_directory "$release_root" 'the installed CLI release directory'
  for artifact in node verify-person-onboarding-kit.mjs clean-v1-release.mjs release.json kit-manifest.v1.json person-client.tgz build-identity.v1.json; do
    require_safe_regular_file "$release_root/$artifact" 'an installed CLI release artifact'
    /usr/bin/cmp -s "$SCRIPT_DIR/$artifact" "$release_root/$artifact" || fail 'the installed release ID belongs to different release artifacts'
  done
  [[ -d "$release_root/package" && ! -L "$release_root/package" && -z "$(/usr/bin/find "$release_root/package" -type l -print -quit)" && -f "$release_root/package/dist/main.js" && ! -L "$release_root/package/dist/main.js" ]] || fail 'the installed Person-client entrypoint is missing'
  staging="$(/usr/bin/mktemp -d "$releases_root/.verify.${release_id}.XXXXXXXX")"
  /bin/chmod 0700 "$staging"
  validate_client_archive_layout "$release_root/person-client.tgz"
  /usr/bin/tar -xzf "$release_root/person-client.tgz" -C "$staging" || fail 'the retained Person-client artifact could not be extracted'
  [[ -d "$staging/package" && ! -L "$staging/package" && -z "$(/usr/bin/find "$staging/package" -type l -print -quit)" ]] || fail 'the retained Person-client artifact has an invalid package entrypoint'
  /usr/bin/diff -qr "$staging/package" "$release_root/package" >/dev/null || fail 'the installed Person-client payload does not match its release artifact'
  /bin/rm -rf -- "$staging"; staging=''
else
  staging="$(/usr/bin/mktemp -d "$releases_root/.${release_id}.XXXXXXXX")"
  /bin/chmod 0700 "$staging"
  /usr/bin/install -m 0755 "$NODE" "$staging/node"
  /usr/bin/install -m 0755 "$VERIFY" "$staging/verify-person-onboarding-kit.mjs"
  /usr/bin/install -m 0755 "$RELEASE_TOOL" "$staging/clean-v1-release.mjs"
  for artifact in release.json kit-manifest.v1.json person-client.tgz build-identity.v1.json; do /usr/bin/install -m 0600 "$SCRIPT_DIR/$artifact" "$staging/$artifact"; done
  validate_client_archive_layout "$staging/person-client.tgz"
  /usr/bin/tar -xzf "$staging/person-client.tgz" -C "$staging" || fail 'the Person-client archive could not be extracted'
  [[ -d "$staging/package" && -z "$(/usr/bin/find "$staging/package" -type l -print -quit)" && -f "$staging/package/dist/main.js" && ! -L "$staging/package/dist/main.js" ]] || fail 'the Person-client archive has an invalid package entrypoint'
  [[ "$("$staging/node" "$staging/package/dist/main.js" --version)" == "$expected_version" ]] || fail 'the Person-client version does not match the release'
  printf '%s\n' "$release_id" > "$staging/.echo-owned-release-v1"; /bin/chmod 0600 "$staging/.echo-owned-release-v1"
  /bin/mv "$staging" "$release_root"; staging=''
fi

wrapper="$bin_root/echo-brain"
if [[ -e "$wrapper" || -L "$wrapper" ]]; then
  require_safe_regular_file "$wrapper" 'the existing ECHO CLI command'
  [[ "$(/usr/bin/stat -f '%u' "$wrapper")" == "$(/usr/bin/id -u)" ]] || fail 'the existing ECHO CLI command must be owned by the current user'
fi
pending_wrapper="$(/usr/bin/mktemp "$bin_root/.echo-brain.XXXXXXXX")"
printf '#!/usr/bin/env bash\nexec %q %q "$@"\n' "$release_root/node" "$release_root/package/dist/main.js" > "$pending_wrapper"
/bin/chmod 0700 "$pending_wrapper"
/bin/mv "$pending_wrapper" "$wrapper" || fail 'the ECHO CLI command could not be activated'
trap - ERR
printf 'Bundled Node: %s\n' "$runtime_version"
printf 'ECHO CLI installed: %q\n' "$wrapper"
printf 'To use it by name in this shell: export PATH=%q:"$PATH"\n' "$bin_root"
