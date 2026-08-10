#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

[[ ${EUID} -eq 0 ]] || fail 'run this script as root'
[[ $# -eq 2 ]] || fail 'usage: restore-authority-state.sh ARCHIVE SHA256'

archive_name=$1
expected_sha256=$2
[[ $archive_name == organization-authority-data-*.tar.gz ]] \
  || fail 'unexpected archive name'
[[ $archive_name != */* ]] || fail 'archive name must not contain a path'
[[ $expected_sha256 =~ ^[0-9a-f]{64}$ ]] || fail 'invalid SHA-256'

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
archive="$script_dir/$archive_name"
target=/srv/echo-authority
[[ -f $archive ]] || fail "missing $archive"
[[ -d $target/data ]] || fail "missing $target/data"
[[ -z $(find "$target/data" -mindepth 1 -print -quit) ]] \
  || fail 'target data directory is not empty'

printf '%s  %s\n' "$expected_sha256" "$archive" | sha256sum --check --status \
  || fail 'archive checksum mismatch'
tar -tzf "$archive" >/dev/null || fail 'archive listing failed'
while IFS= read -r entry; do
  case "$entry" in
    data | data/ | data/*) ;;
    *) fail "archive entry is outside data/: $entry" ;;
  esac
  case "/$entry/" in
    */../*) fail "archive entry traverses a parent: $entry" ;;
  esac
done < <(tar -tzf "$archive")

tar -xzf "$archive" --directory "$target" --no-same-owner
chown -R echo-authority:echo-authority "$target/data"
chmod 0700 "$target/data"

! find "$target/data" -type l -print -quit | grep -q . \
  || fail 'restored data contains a symbolic link'
! find "$target/data/state" -type f \
  \( -name '*-wal' -o -name '*-shm' -o -name '*-journal' \) \
  -print -quit | grep -q . \
  || fail 'restored data contains a SQLite sidecar'

for db in "$target"/data/state/{authority,integrations,record-log,record-derived}.sqlite; do
  [[ -f $db ]] || fail "missing $db"
  [[ $(sqlite3 -batch "file:$db?mode=ro&immutable=1" \
    'PRAGMA integrity_check;') == ok ]] || fail "integrity check failed: $db"
  [[ -z $(sqlite3 -batch "file:$db?mode=ro&immutable=1" \
    'PRAGMA foreign_key_check;') ]] || fail "foreign key check failed: $db"
done

printf 'Restored and verified %s at %s\n' "$archive_name" "$target/data"
