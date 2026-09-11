#!/usr/bin/env bash
# One-action first-cohort employee install, sign-in, and permission-aware smoke.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
NODE="$SCRIPT_DIR/node"
VERIFY="$SCRIPT_DIR/verify-person-onboarding-kit.mjs"
RELEASE_TOOL="$SCRIPT_DIR/clean-v1-release.mjs"
APP_ARCHIVE="$SCRIPT_DIR/ECHO.app.zip"

fail() { printf 'ECHO setup: %s\n' "$*" >&2; exit 1; }

# The graphical installer reads an enumerated reason, never a diagnostic string.
fail_reason() {
  local reason="$1"
  shift
  if [[ "${install_only:-0}" == 1 ]]; then
    printf '{"ok":false,"phase":"install-failed","reason":"%s"}\n' "$reason"
  fi
  fail "$@"
}

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
  [[ ! -L "$path" ]] || fail 'an ECHO command path is a symbolic link'
  if [[ -e "$path" ]]; then
    [[ -f "$path" ]] || fail 'an ECHO command path is not a regular file'
    [[ "$(stat -f '%u' "$path")" == "$(id -u)" ]] || \
      fail 'an ECHO command file is owned by another user'
  fi
}

require_safe_owned_app_or_absent() {
  local path="$1"
  [[ ! -L "$path" ]] || fail 'the ECHO application is a symbolic link'
  if [[ -e "$path" ]]; then
    [[ -d "$path" ]] || fail 'the ECHO application path is not an app bundle'
    [[ "$(stat -f '%u' "$path")" == "$(id -u)" ]] || \
      fail 'the ECHO application is owned by another user'
    [[ -f "$path/Contents/Info.plist" && ! -L "$path/Contents/Info.plist" ]] || \
      fail 'the installed ECHO application has an invalid Info.plist'
    [[ -f "$path/Contents/MacOS/ECHO" && ! -L "$path/Contents/MacOS/ECHO" && \
       -x "$path/Contents/MacOS/ECHO" ]] || \
      fail 'the installed ECHO application has an invalid executable'
  fi
}

validate_overlay_identity() {
  local app="$1"
  local source_sha="$2"
  local product_version="$3"
  "$NODE" -e '
    const { readFileSync } = require("node:fs");
    const [app, sourceSha, productVersion] = process.argv.slice(1);
    let identity;
    try {
      identity = JSON.parse(readFileSync(`${app}/Contents/Resources/build-identity.v1.json`, "utf8"));
    } catch {
      process.exit(1);
    }
    const keys = ["architecture", "kind", "platform", "product_version", "schema_version", "source_sha"];
    if (identity === null || typeof identity !== "object" || Array.isArray(identity) ||
      JSON.stringify(Object.keys(identity).sort()) !== JSON.stringify(keys) ||
      identity.schema_version !== 1 || identity.kind !== "echo-overlay-build-identity-v1" ||
      identity.product_version !== productVersion || identity.source_sha !== sourceSha ||
      identity.platform !== "darwin" || identity.architecture !== "arm64") process.exit(1);
  ' "$app" "$source_sha" "$product_version" || \
    fail 'the ECHO application identity does not match this release'
}

validate_thin_arm64_executable() {
  "$NODE" -e '
    const { closeSync, constants, openSync, readSync } = require("node:fs");
    let descriptor;
    try {
      descriptor = openSync(process.argv[1], constants.O_RDONLY | constants.O_NOFOLLOW);
      // Mach-O 64-bit, arm64 (all), MH_EXECUTE; FAT and arm64e are not this release.
      const header = Buffer.alloc(16);
      if (readSync(descriptor, header, 0, header.length, 0) !== header.length ||
          header.readUInt32LE(0) !== 0xfeedfacf ||
          header.readUInt32LE(4) !== 0x0100000c ||
          header.readUInt32LE(8) !== 0 || header.readUInt32LE(12) !== 2) process.exitCode = 1;
    } catch {
      process.exitCode = 1;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  ' "$1"
}

[[ $# -le 1 ]] || fail 'open Start ECHO.command or pass one invitation file path'
install_only=0
if [[ "${1:-}" == --install-only ]]; then install_only=1; shift; fi
[[ -n "${HOME:-}" && "$HOME" = /* ]] || fail 'a normal macOS user HOME is required'
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || \
  fail_reason unsupported-mac 'this first-cohort kit supports macOS on Apple silicon only'
[[ -f "$NODE" && ! -L "$NODE" && -x "$NODE" ]] || fail 'the bundled Node runtime is unavailable'
[[ -f "$VERIFY" && ! -L "$VERIFY" ]] || fail 'the kit verifier is unavailable'
[[ -f "$RELEASE_TOOL" && ! -L "$RELEASE_TOOL" ]] || fail 'the release verifier is unavailable'
[[ -f "$APP_ARCHIVE" && ! -L "$APP_ARCHIVE" ]] || fail 'the ECHO application archive is unavailable'

"$NODE" "$VERIFY" "$SCRIPT_DIR" >/dev/null
"$NODE" "$RELEASE_TOOL" validate "$SCRIPT_DIR/release.json" >/dev/null

invitation="${1:-}"
if [[ "$install_only" == 0 && -z "$invitation" ]]; then
  command -v osascript >/dev/null 2>&1 || fail 'choose the invitation by passing its file path to Start ECHO.command'
  invitation="$(osascript -e 'POSIX path of (choose file with prompt "Choose your ECHO invitation file")')" || \
    fail 'no invitation was selected'
fi
if [[ "$install_only" == 0 ]]; then
  [[ "$invitation" = /* ]] || fail 'the invitation path must be absolute'
  [[ -f "$invitation" && ! -L "$invitation" ]] || fail 'the invitation must be a regular file'
fi

release_id="$("$NODE" "$RELEASE_TOOL" field "$SCRIPT_DIR/release.json" release-id)"
expected_version="$("$NODE" "$RELEASE_TOOL" field "$SCRIPT_DIR/release.json" client-version)"
expected_source_sha="$("$NODE" "$RELEASE_TOOL" field "$SCRIPT_DIR/release.json" source-sha)"
application_root="$HOME/Library/Application Support/ECHO"
releases_root="$application_root/releases"
bin_root="$application_root/bin"
release_root="$releases_root/$release_id"
require_safe_owned_directory_or_absent "$application_root"
require_safe_owned_directory_or_absent "$releases_root"
require_safe_owned_directory_or_absent "$bin_root"
install -d -m 0700 "$application_root" "$releases_root" "$bin_root"
chmod 0700 "$application_root" "$releases_root" "$bin_root"
require_private_owned_directory "$application_root"
require_private_owned_directory "$releases_root"
require_private_owned_directory "$bin_root"

# Serialize installers so retention cannot remove another activation's recovery.
install_lock="$application_root/.installer-lock"
mkdir -m 0700 "$install_lock" 2>/dev/null || \
  fail_reason setup-in-progress 'another or interrupted ECHO setup owns the installer lock'
cleanup_lock() { rmdir "$install_lock"; }
trap cleanup_lock EXIT

if [[ ! -e "$release_root" ]]; then
  staging="$(mktemp -d "$releases_root/.${release_id}.XXXXXXXX")"
  cleanup_staging() { rm -rf -- "$staging"; }
  trap 'cleanup_staging; cleanup_lock' EXIT
  chmod 0700 "$staging"
  install -m 0755 "$NODE" "$staging/node"
  install -m 0755 "$VERIFY" "$staging/verify-person-onboarding-kit.mjs"
  install -m 0755 "$RELEASE_TOOL" "$staging/clean-v1-release.mjs"
  install -m 0600 "$SCRIPT_DIR/release.json" "$staging/release.json"
  install -m 0600 "$SCRIPT_DIR/kit-manifest.v1.json" "$staging/kit-manifest.v1.json"
  install -m 0600 "$SCRIPT_DIR/person-client.tgz" "$staging/person-client.tgz"
  install -m 0600 "$APP_ARCHIVE" "$staging/ECHO.app.zip"
  tar -xzf "$staging/person-client.tgz" -C "$staging"
  [[ -f "$staging/package/dist/main.js" && ! -L "$staging/package/dist/main.js" ]] || \
    fail 'the Person-client entrypoint is missing from the kit'
  "$staging/node" "$staging/verify-person-onboarding-kit.mjs" "$staging" >/dev/null
  [[ "$("$staging/node" "$staging/package/dist/main.js" --version)" == "$expected_version" ]] || \
    fail 'the Person-client version does not match the release'
  printf '%s\n' "$release_id" > "$staging/.echo-owned-release-v1"
  chmod 0600 "$staging/.echo-owned-release-v1"
  mv "$staging" "$release_root"
  trap cleanup_lock EXIT
else
  require_private_owned_directory "$release_root"
  /usr/bin/cmp -s "$SCRIPT_DIR/release.json" "$release_root/release.json" && \
    /usr/bin/cmp -s "$SCRIPT_DIR/kit-manifest.v1.json" "$release_root/kit-manifest.v1.json" || \
    fail 'the installed release ID belongs to different release artifacts'
  "$release_root/node" "$release_root/verify-person-onboarding-kit.mjs" "$release_root" >/dev/null
  [[ "$("$release_root/node" "$release_root/package/dist/main.js" --version)" == "$expected_version" ]] || \
    fail 'the installed Person-client version does not match the release'
fi

applications_root="$HOME/Applications"
overlay_backups_root="$application_root/overlay-backups"
require_safe_owned_directory_or_absent "$applications_root"
install -d -m 0755 "$applications_root"
require_safe_owned_directory_or_absent "$overlay_backups_root"
install -d -m 0700 "$overlay_backups_root"
chmod 0700 "$overlay_backups_root"
require_private_owned_directory "$overlay_backups_root"
app_destination="$applications_root/ECHO.app"
require_safe_owned_app_or_absent "$app_destination"

overlay_staging="$(mktemp -d "$applications_root/.ECHO.app.XXXXXXXX")"
cleanup_overlay() {
  rm -rf -- "$overlay_staging"
  if [[ -n "${wrapper_pending:-}" && -f "$wrapper_pending" ]]; then rm -f -- "$wrapper_pending"; fi
  # Failed moves/rollbacks can leave empty transaction slots; never remove a
  # nonempty slot here because it may still hold the only recoverable pair.
  if [[ -n "${backup_slot:-}" ]]; then rmdir "$backup_slot" 2>/dev/null || true; fi
  if [[ -n "${wrapper_backup_root:-}" ]]; then rmdir "$wrapper_backup_root" 2>/dev/null || true; fi
}
trap 'cleanup_overlay; cleanup_lock' EXIT
chmod 0700 "$overlay_staging"
/usr/bin/ditto -x -k "$APP_ARCHIVE" "$overlay_staging"
[[ "$(find "$overlay_staging" -mindepth 1 -maxdepth 1 -print | wc -l | tr -d ' ')" == 1 ]] || \
  fail_reason download-damaged 'the ECHO application archive has an invalid top-level layout'
staged_app="$overlay_staging/ECHO.app"
[[ -d "$staged_app" && ! -L "$staged_app" ]] || fail 'the ECHO application bundle is missing'
[[ -z "$(find "$staged_app" -type l -print -quit)" ]] || \
  fail_reason download-damaged 'the ECHO application bundle contains a symbolic link'
[[ -f "$staged_app/Contents/Info.plist" && ! -L "$staged_app/Contents/Info.plist" ]] || \
  fail_reason download-damaged 'the ECHO application Info.plist is missing'
[[ -f "$staged_app/Contents/MacOS/ECHO" && ! -L "$staged_app/Contents/MacOS/ECHO" && \
   -x "$staged_app/Contents/MacOS/ECHO" ]] || fail 'the ECHO application executable is missing'
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$staged_app/Contents/Info.plist")" == \
   'org.echobrain.echo-overlay' ]] || fail 'the ECHO application bundle identifier is invalid'
/usr/bin/codesign --verify --deep --strict "$staged_app" || \
  fail_reason download-damaged 'the ECHO application signature is invalid'
validate_thin_arm64_executable "$staged_app/Contents/MacOS/ECHO" || \
  fail_reason download-damaged 'the ECHO application executable is not arm64-only'
validate_overlay_identity "$staged_app" "$expected_source_sha" "$expected_version"

wrapper_destination="$bin_root/echo-brain"
require_safe_owned_regular_file_or_absent "$wrapper_destination"
wrapper_pending="$(mktemp "$bin_root/.echo-brain.XXXXXXXX")"
chmod 0700 "$wrapper_pending"
printf '#!/usr/bin/env bash\nexec %q %q "$@"\n' \
  "$release_root/node" "$release_root/package/dist/main.js" > "$wrapper_pending"
chmod 0700 "$wrapper_pending"

app_was_present=0
app_needs_activation=1
app_backup=''
if [[ -e "$app_destination" ]]; then
  app_was_present=1
  /usr/bin/codesign --verify --deep --strict "$app_destination" || \
    fail 'the installed ECHO application signature is invalid'
  [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app_destination/Contents/Info.plist")" == \
     'org.echobrain.echo-overlay' ]] || fail 'a different application occupies ~/Applications/ECHO.app'
  [[ -z "$(find "$app_destination" -type l -print -quit)" ]] || \
    fail 'the installed ECHO application contains a symbolic link'
  if /usr/bin/diff -qr "$staged_app" "$app_destination" >/dev/null; then
    app_needs_activation=0
  else
    backup_slot="$(mktemp -d "$overlay_backups_root/previous.XXXXXXXX")"
    chmod 0700 "$backup_slot"
    backup_app="$backup_slot/ECHO.app"
    app_backup="$backup_app"
  fi
fi

wrapper_was_present=0
wrapper_backup=''
if [[ -e "$wrapper_destination" ]]; then
  wrapper_was_present=1
  wrapper_backup_root="$(mktemp -d "$bin_root/.echo-brain.previous.XXXXXXXX")"
  chmod 0700 "$wrapper_backup_root"
  wrapper_backup="$wrapper_backup_root/echo-brain"
fi

# Resolve the prior wrapper by exact bytes, without sourcing or executing it.
# Unknown/legacy wrappers are preserved but never authorize release pruning.
previous_release=''
if [[ "$wrapper_was_present" == 1 ]]; then
  for candidate in "$releases_root"/*; do
    [[ -d "$candidate" && ! -L "$candidate" ]] || continue
    printf '#!/usr/bin/env bash\nexec %q %q "$@"\n' \
      "$candidate/node" "$candidate/package/dist/main.js" > "$overlay_staging/expected-wrapper"
    if /usr/bin/cmp -s "$overlay_staging/expected-wrapper" "$wrapper_destination"; then
      previous_release="${candidate##*/}"
      break
    fi
  done
fi

if [[ "$wrapper_was_present" != "$app_was_present" ]] || \
   [[ "$wrapper_was_present" == 1 && -z "$previous_release" ]]; then
  fail_reason existing-install-mismatch 'the existing ECHO app and command are not a recognized installed pair'
fi
if [[ -n "$previous_release" ]]; then
  prior_record="$releases_root/$previous_release/release.json"
  prior_source="$("$NODE" "$RELEASE_TOOL" field "$prior_record" source-sha)"
  prior_version="$("$NODE" "$RELEASE_TOOL" field "$prior_record" client-version)"
  validate_overlay_identity "$app_destination" "$prior_source" "$prior_version"
fi

# Defer catchable cancellation until a coherent pair is restored or committed.
# The filesystem transitions below must not be interrupted by a shell exit.
interrupted=0
trap 'interrupted=1' HUP INT TERM

# Activate the already-validated desktop app and CLI as one recoverable pair.
# Nothing active changes until both the release root and desktop app are staged.
if [[ "$wrapper_was_present" == 1 ]]; then
  mv "$wrapper_destination" "$wrapper_backup"
fi
if [[ "$app_needs_activation" == 1 ]]; then
  if [[ "$app_was_present" == 1 ]]; then
    if ! mv "$app_destination" "$app_backup"; then
      if [[ "$wrapper_was_present" == 1 ]]; then
        mv "$wrapper_backup" "$wrapper_destination" || \
          fail 'the ECHO application activation failed and the prior ECHO command could not be restored'
      fi
      fail 'the ECHO application activation failed; the prior app and command were restored'
    fi
  fi
  if ! mv "$staged_app" "$app_destination"; then
    if [[ "$app_was_present" == 1 ]]; then
      mv "$app_backup" "$app_destination" || \
        fail 'the ECHO application activation failed and automatic rollback also failed'
    fi
    if [[ "$wrapper_was_present" == 1 ]]; then
      mv "$wrapper_backup" "$wrapper_destination" || \
        fail 'the ECHO application activation failed and the prior ECHO command could not be restored'
    fi
    fail 'the ECHO application activation failed; the prior app was restored'
  fi
fi

if ! mv "$wrapper_pending" "$wrapper_destination"; then
  # Restore the app first. If that cannot complete, keep the new wrapper active
  # so the active pair remains new rather than silently mixing releases.
  if [[ "$app_needs_activation" == 1 ]]; then
    failed_app="$overlay_staging/failed-ECHO.app"
    if ! mv "$app_destination" "$failed_app"; then
      mv "$wrapper_pending" "$wrapper_destination" || \
        fail 'pair activation failed and the new ECHO command could not be restored'
      fail 'pair activation failed; the new matched app and command remain active'
    fi
    if [[ "$app_was_present" == 1 ]] && ! mv "$app_backup" "$app_destination"; then
      mv "$failed_app" "$app_destination" || \
        fail 'pair activation failed and neither matched application could be restored'
      mv "$wrapper_pending" "$wrapper_destination" || \
        fail 'pair activation failed and the new ECHO command could not be restored'
      fail 'pair activation failed; the new matched app and command remain active'
    fi
  fi
  if [[ "$wrapper_was_present" == 1 ]]; then
    mv "$wrapper_backup" "$wrapper_destination" || \
      fail 'pair activation failed and the prior ECHO command could not be restored'
  fi
  fail_reason activation-failed 'pair activation failed; the prior app and command were restored'
fi

restore_prior_pair_after_retirement_failure() {
  local failed_app="$overlay_staging/failed-ECHO.app"
  local failed_wrapper="$overlay_staging/failed-echo-brain"
  if ! mv "$wrapper_destination" "$failed_wrapper"; then
    fail 'overlay retirement failed and the new ECHO command could not be set aside'
  fi
  if ! mv "$app_destination" "$failed_app"; then
    mv "$failed_wrapper" "$wrapper_destination" || \
      fail 'overlay retirement failed and the new matched pair could not be restored'
    fail 'overlay retirement failed; the new matched app and command remain installed'
  fi
  if ! mv "$app_backup" "$app_destination"; then
    mv "$failed_app" "$app_destination" || \
      fail 'overlay retirement failed and neither matched application could be restored'
    mv "$failed_wrapper" "$wrapper_destination" || \
      fail 'overlay retirement failed and the new ECHO command could not be restored'
    fail 'overlay retirement failed; the new matched app and command remain installed'
  fi
  if [[ "$wrapper_was_present" == 1 ]] && ! mv "$wrapper_backup" "$wrapper_destination"; then
    mv "$app_destination" "$app_backup" || \
      fail 'overlay retirement failed and the prior application could not be set aside'
    mv "$failed_app" "$app_destination" || \
      fail 'overlay retirement failed and the new application could not be restored'
    mv "$failed_wrapper" "$wrapper_destination" || \
      fail 'overlay retirement failed and the new ECHO command could not be restored'
    fail 'overlay retirement failed; the new matched app and command remain installed'
  fi
  fail_reason app-running 'the running ECHO application could not be stopped; the prior app and command were restored'
}

# A changed bundle cannot remain active while its prior process owns the status
# item and exclusive hotkey. Run the new, validated bundle's scoped maintenance
# mode only after the pair is installed; a refusal rolls both artifacts back.
if [[ "$app_needs_activation" == 1 && "$app_was_present" == 1 ]] && \
   ! "$app_destination/Contents/MacOS/ECHO" --quit-running-overlay; then
  restore_prior_pair_after_retirement_failure
fi

# Retire only this transaction's temporary backups after an archived matched
# rollback pair is durable. Same-release reinstalls keep the previous distinct pair.
# Ownership markers limit retention to artifacts created by this installer.
"$NODE" --input-type=module - "$application_root" "$release_id" "$previous_release" \
  "$app_backup" "$wrapper_backup" "$app_destination" "$interrupted" <<'RETENTION'
import { lstatSync, readFileSync, readdirSync, writeFileSync, renameSync, rmSync, mkdtempSync, chmodSync, fsyncSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
const [root, current, previous, appBackup, wrapperBackup, app, interrupted] = process.argv.slice(2);
const releases = join(root, "releases");
const backups = join(root, "overlay-backups");
const uid = process.getuid();
const digest = path => createHash("sha256").update(readFileSync(path)).digest("hex");
const safeName = name => typeof name === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) && name !== "..";
const owned = (path, directory) => {
  try {
    const stat = lstatSync(path);
    return stat.uid === uid && !stat.isSymbolicLink() &&
      (directory ? stat.isDirectory() && (stat.mode & 0o777) === 0o700 : stat.isFile());
  } catch { return false; }
};
// Never recursively delete a tree containing foreign-owned nodes or links.
const safeTree = path => {
  const stat = lstatSync(path);
  return stat.uid === uid && !stat.isSymbolicLink() &&
    (stat.isDirectory() ? readdirSync(path).every(name => safeTree(join(path, name))) : stat.isFile());
};
const releaseOwned = name => {
  const path = join(releases, name);
  const marker = join(path, ".echo-owned-release-v1");
  return safeName(name) && owned(path, true) && owned(marker, false) &&
    readFileSync(marker, "utf8") === `${name}\n` && safeTree(path);
};
const retained = () => readdirSync(backups).flatMap(name => {
  const path = join(backups, name);
  if (!/^previous\.[a-zA-Z0-9]+$/.test(name) || !owned(path, true)) return [];
  const marker = join(path, "pair.v1.json");
  const archive = join(path, "pair.tar.gz");
  if (!owned(marker, false) || !owned(archive, false) ||
      readdirSync(path).sort().join(",") !== "pair.tar.gz,pair.v1.json") return [];
  try {
    const record = JSON.parse(readFileSync(marker, "utf8"));
    if (record.kind !== "echo-installer-rollback-v1" || !safeName(record.release) ||
        record.sha256 !== digest(archive)) return [];
    return [{ path, release: record.release, time: lstatSync(marker).mtimeMs }];
  } catch { return []; }
});
try {
  let keep;
  if (previous && previous !== current && wrapperBackup) {
    const slot = mkdtempSync(join(backups, "previous."));
    chmodSync(slot, 0o700);
    const pending = join(slot, "pair.pending.tar.gz");
    // tar preserves bundle metadata and the exact prior supported wrapper.
    execFileSync("tar", ["-czf", pending, "-C", join(appBackup || app, ".."), "ECHO.app",
      "-C", join(wrapperBackup, ".."), "echo-brain"], { stdio: "ignore" });
    chmodSync(pending, 0o600);
    const fd = openSync(pending, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(pending, join(slot, "pair.tar.gz"));
    writeFileSync(join(slot, "pair.v1.json"), JSON.stringify({
      kind: "echo-installer-rollback-v1", release: previous, sha256: digest(join(slot, "pair.tar.gz")),
    }) + "\n", { mode: 0o600, flag: "wx", flush: true });
    keep = slot;
  }
  // These exact paths were allocated and validated by this invocation.
  if (appBackup) rmSync(join(appBackup, ".."), { recursive: true });
  if (wrapperBackup) rmSync(join(wrapperBackup, ".."), { recursive: true });
  if (interrupted === "1") process.exit(0);
  const slots = retained().sort((a, b) => b.time - a.time || a.path.localeCompare(b.path));
  keep ??= slots[0]?.path;
  const rollback = slots.find(slot => slot.path === keep);
  for (const slot of slots) if (slot.path !== keep) rmSync(slot.path, { recursive: true });
  if (readdirSync(backups).some(name => join(backups, name) !== keep) ||
      readdirSync(join(root, "bin")).some(name => name !== "echo-brain")) process.exit(0);
  for (const name of readdirSync(releases)) {
    if (name !== current && name !== rollback?.release && releaseOwned(name))
      rmSync(join(releases, name), { recursive: true });
  }
} catch {
  console.error("ECHO setup: matched pair installed; private rollback cleanup could not complete");
  process.exit(1);
}
RETENTION
trap - HUP INT TERM
[[ "$interrupted" == 0 ]] || fail 'setup was interrupted; the new matched app and command remain installed'

if [[ "$install_only" == 1 ]]; then
  printf '{"ok":true,"phase":"installed"}\n'
  exit 0
fi

invitation_root="$(mktemp -d "$application_root/.invitation.XXXXXXXX")"
cleanup_invitation() { rm -rf -- "$invitation_root"; }
trap 'cleanup_invitation; cleanup_overlay; cleanup_lock' EXIT
chmod 0700 "$invitation_root"
install -m 0600 "$invitation" "$invitation_root/invitation.json"

"$release_root/node" "$release_root/package/dist/main.js" person start \
  --invitation "$invitation_root/invitation.json"

printf 'ECHO is ready. Your command is: %s\n' "$bin_root/echo-brain"
printf 'ECHO is installed at: %s (launch it through the approved local UI path)\n' "$app_destination"
