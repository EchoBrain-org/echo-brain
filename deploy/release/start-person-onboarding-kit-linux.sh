#!/usr/bin/env bash
# Linux x64 glibc installer for the offline ECHO Person-client kit.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
NODE="$SCRIPT_DIR/node"
VERIFY="$SCRIPT_DIR/verify-person-onboarding-kit.mjs"
RELEASE_TOOL="$SCRIPT_DIR/clean-v1-release.mjs"

fail() { printf 'ECHO setup: %s\n' "$*" >&2; exit 1; }
usage() {
  printf 'usage: Start-ECHO.sh --install-only | /absolute/path/to/person-invitation.json\n' >&2
  exit 2
}

require_safe_owned_directory() {
  local path="$1" label="$2"
  [[ ! -L "$path" && -d "$path" ]] || fail "$label must be a directory, not a symbolic link"
  [[ "$(stat -c '%u' "$path")" == "$(id -u)" ]] || fail "$label must be owned by the current user"
}

require_private_directory() {
  require_safe_owned_directory "$1" "$2"
  [[ "$(stat -c '%a' "$1")" == 700 ]] || fail "$2 must have mode 0700"
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
      owner="$(stat -c '%u' "$cursor")"
      if [[ "$owner" == "$(id -u)" ]]; then owned=1
      elif [[ "$owned" == 1 ]]; then
        fail "$label path component must be owned by the current user"
      fi
    else
      [[ "$owned" == 1 ]] || fail "$label must be within an existing current-user-owned directory"
      mkdir -m 0700 "$cursor" || fail "could not create $label"
    fi
  done
  [[ "$owned" == 1 ]] || fail "$label must be owned by the current user"
}

validate_linux_x64_glibc() {
  [[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || \
    fail 'this kit supports Linux x86_64 only'
  local libc
  libc="$(getconf GNU_LIBC_VERSION 2>/dev/null || true)"
  [[ "$libc" == glibc\ * ]] || fail 'this kit supports glibc Linux only; musl is unsupported'
}

validate_linux_x64_node_header() {
  require_safe_regular_file "$NODE" 'the bundled Node runtime'
  [[ -x "$NODE" ]] || fail 'the bundled Node runtime is not executable'
  local bytes
  read -r -a bytes <<< "$(LC_ALL=C od -An -v -w20 -t u1 -N 20 "$NODE")"
  [[ ${#bytes[@]} -eq 20 && ${bytes[0]} == 127 && ${bytes[1]} == 69 && \
     ${bytes[2]} == 76 && ${bytes[3]} == 70 && ${bytes[4]} == 2 && \
     ${bytes[5]} == 1 && ${bytes[18]} == 62 && ${bytes[19]} == 0 ]] || \
    fail 'the bundled Node runtime is not a little-endian 64-bit x86_64 ELF executable'
}

validate_client_archive_layout() {
  local archive="$1" entry mode
  while IFS= read -r entry; do
    [[ -n "$entry" && "$entry" != /* && "$entry" != *'//' && \
       "$entry" != *'/../'* && "$entry" != ../* && \
       ( "$entry" == package || "$entry" == package/* ) ]] || \
      fail 'the Person-client archive has an unsafe layout'
  done < <(tar -tzf "$archive")
  while IFS= read -r mode; do
    [[ "${mode:0:1}" == - || "${mode:0:1}" == d ]] || \
      fail 'the Person-client archive contains a non-regular entry'
  done < <(tar -tvzf "$archive")
}

[[ $# -eq 1 ]] || usage
install_only=0
invitation=''
if [[ "$1" == --install-only ]]; then
  install_only=1
else
  invitation="$1"
  [[ "$invitation" = /* && -f "$invitation" && ! -L "$invitation" ]] || usage
fi

[[ -n "${HOME:-}" && "$HOME" = /* ]] || fail 'a normal Linux user HOME is required'
validate_linux_x64_glibc
validate_linux_x64_node_header
for required in "$VERIFY" "$RELEASE_TOOL" "$SCRIPT_DIR/release.json" \
  "$SCRIPT_DIR/kit-manifest.v1.json" "$SCRIPT_DIR/person-client.tgz" \
  "$SCRIPT_DIR/build-identity.v1.json"; do
  require_safe_regular_file "$required" 'a required kit artifact'
done

# Check the ELF header before launching a potentially wrong-architecture runtime.
# The owner's authenticated archive checksum establishes the kit's origin.
"$NODE" "$VERIFY" "$SCRIPT_DIR" >/dev/null || fail 'the onboarding kit verification failed'
"$NODE" "$RELEASE_TOOL" validate "$SCRIPT_DIR/release.json" >/dev/null || \
  fail 'the release record verification failed'

release_id="$("$NODE" "$RELEASE_TOOL" field "$SCRIPT_DIR/release.json" release-id)"
expected_version="$("$NODE" "$RELEASE_TOOL" field "$SCRIPT_DIR/release.json" client-version)"
root="${XDG_DATA_HOME:-$HOME/.local/share}/echo/person"
ensure_owned_directory_chain "$root" 'the ECHO data root'
chmod 0700 "$root"
require_private_directory "$root" 'the ECHO data root'
releases_root="$root/releases"
bin_root="$root/bin"
ensure_owned_directory_chain "$releases_root" 'the ECHO releases directory'
ensure_owned_directory_chain "$bin_root" 'the ECHO command directory'
chmod 0700 "$releases_root" "$bin_root"
require_private_directory "$releases_root" 'the ECHO releases directory'
require_private_directory "$bin_root" 'the ECHO command directory'

install_lock="$root/.installer-lock"
mkdir -m 0700 "$install_lock" 2>/dev/null || fail 'another or interrupted ECHO setup owns the installer lock'
staging=''
pending_wrapper=''
cleanup() {
  [[ -z "$staging" || ! -d "$staging" ]] || rm -rf -- "$staging"
  [[ -z "$pending_wrapper" || ! -f "$pending_wrapper" ]] || rm -f -- "$pending_wrapper"
  rmdir "$install_lock" 2>/dev/null || true
}
trap cleanup EXIT

release_root="$releases_root/$release_id"
if [[ -e "$release_root" || -L "$release_root" ]]; then
  require_private_directory "$release_root" 'the installed release directory'
  for artifact in node verify-person-onboarding-kit.mjs clean-v1-release.mjs release.json \
    kit-manifest.v1.json person-client.tgz build-identity.v1.json; do
    require_safe_regular_file "$release_root/$artifact" 'an installed release artifact'
    cmp -s "$SCRIPT_DIR/$artifact" "$release_root/$artifact" || \
      fail 'the installed release ID belongs to different release artifacts'
  done
  [[ -d "$release_root/package" && ! -L "$release_root/package" && \
     -z "$(find "$release_root/package" -type l -print -quit)" && \
     -f "$release_root/package/dist/main.js" && ! -L "$release_root/package/dist/main.js" ]] || \
    fail 'the installed Person-client entrypoint is missing'
  staging="$(mktemp -d "$releases_root/.verify.${release_id}.XXXXXXXX")"
  chmod 0700 "$staging"
  validate_client_archive_layout "$release_root/person-client.tgz"
  tar -xzf "$release_root/person-client.tgz" -C "$staging" || \
    fail 'the retained Person-client artifact could not be extracted'
  [[ -d "$staging/package" && ! -L "$staging/package" && \
     -z "$(find "$staging/package" -type l -print -quit)" ]] || \
    fail 'the retained Person-client artifact has an invalid package entrypoint'
  diff -qr "$staging/package" "$release_root/package" >/dev/null || \
    fail 'the installed Person-client payload does not match its release artifact'
  rm -rf -- "$staging"
  staging=''
else
  staging="$(mktemp -d "$releases_root/.${release_id}.XXXXXXXX")"
  chmod 0700 "$staging"
  install -m 0755 "$NODE" "$staging/node"
  install -m 0755 "$VERIFY" "$staging/verify-person-onboarding-kit.mjs"
  install -m 0755 "$RELEASE_TOOL" "$staging/clean-v1-release.mjs"
  for artifact in release.json kit-manifest.v1.json person-client.tgz build-identity.v1.json; do
    install -m 0600 "$SCRIPT_DIR/$artifact" "$staging/$artifact"
  done
  validate_client_archive_layout "$staging/person-client.tgz"
  tar -xzf "$staging/person-client.tgz" -C "$staging" || fail 'the Person-client archive could not be extracted'
  [[ -d "$staging/package" && -z "$(find "$staging/package" -type l -print -quit)" && \
     -f "$staging/package/dist/main.js" && ! -L "$staging/package/dist/main.js" ]] || \
    fail 'the Person-client archive has an invalid package entrypoint'
  [[ "$("$staging/node" "$staging/package/dist/main.js" --version)" == "$expected_version" ]] || \
    fail 'the Person-client version does not match the release'
  printf '%s\n' "$release_id" > "$staging/.echo-owned-release-v1"
  chmod 0600 "$staging/.echo-owned-release-v1"
  mv "$staging" "$release_root"
  staging=''
fi

wrapper="$bin_root/echo-brain"
if [[ -e "$wrapper" || -L "$wrapper" ]]; then
  require_safe_regular_file "$wrapper" 'the existing ECHO command'
  [[ "$(stat -c '%u' "$wrapper")" == "$(id -u)" ]] || \
    fail 'the existing ECHO command must be owned by the current user'
fi
pending_wrapper="$(mktemp "$bin_root/.echo-brain.XXXXXXXX")"
printf '#!/usr/bin/env bash\nexec %q %q "$@"\n' \
  "$release_root/node" "$release_root/package/dist/main.js" > "$pending_wrapper"
chmod 0700 "$pending_wrapper"
mv "$pending_wrapper" "$wrapper" || fail 'the ECHO command could not be activated'

printf 'ECHO installed: %q\n' "$wrapper"
printf 'To use it by name in this shell: export PATH=%q:"$PATH"\n' "$bin_root"
if [[ "$install_only" == 1 ]]; then exit 0; fi

status="$("$wrapper" person status)" || fail 'could not determine the existing ECHO session; refusing to sign in'
session_state="$("$release_root/node" -e '
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => input += chunk);
  process.stdin.on("end", () => {
    try {
      const status = JSON.parse(input);
      if (status?.kind === "echo-person-client-status-v1" && status.signed_in === false) process.stdout.write("signed-out");
      else if (status?.kind === "echo-person-client-status-v1" && status.signed_in === true) process.stdout.write("signed-in");
      else process.exitCode = 1;
    } catch { process.exitCode = 1; }
  });
' <<< "$status")" || fail 'could not validate the existing ECHO session; refusing to sign in'
[[ "$session_state" == signed-out ]] || fail 'an ECHO session already exists; use echo-brain person login after logging out if you intend to change accounts'
"$wrapper" person login --invitation "$invitation"
