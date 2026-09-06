#!/usr/bin/env bash
# Reconstruct the replaceable host half of an already accepted clean-v1
# Authority. Organization state stays on the retained clean-data volume; this
# script never creates, changes, or reads a credential value.
set -euo pipefail

AUTHORITY_UID=999
AUTHORITY_GID=988
DEFAULT_DEPLOY_DIR=/srv/echo-authority-clean-v1

DEPLOY_DIR=$DEFAULT_DEPLOY_DIR
COMMAND=resume
STAGING_RELEASE_GUARD_HELD=false

fail() {
  printf 'restore-clean-v1-host: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat >&2 <<'USAGE'
usage: restore-clean-v1-host.sh [materialize|resume] [--deploy-dir </absolute/path>]

materialize: reconstruct only the root-volume environment and runtime-profile
             files from the accepted retained release tuple.
resume:      materialize, then run the installed onboarding wrapper and require
             terminal-green status.

For an entirely unprepared retained volume, materialize is a successful no-op
but resume is refused. A partial, candidate, symlinked, permission-unsafe, or
tuple-drifted volume is refused.
USAGE
  exit 2
}

regular_file() {
  [[ -f $1 && ! -L $1 ]]
}

private_regular_file() {
  regular_file "$1" && [[ $(stat -c '%a' "$1") == 600 ]]
}

safe_directory() {
  [[ -d $1 && ! -L $1 ]]
}

require_authority_identity() {
  [[ $(id -u echo-authority 2>/dev/null) == "$AUTHORITY_UID" ]] || \
    fail "echo-authority must have fixed UID $AUTHORITY_UID"
  [[ $(id -g echo-authority 2>/dev/null) == "$AUTHORITY_GID" ]] || \
    fail "echo-authority must have fixed GID $AUTHORITY_GID"
}

require_data_root() {
  safe_directory "$DATA_DIR" || fail 'clean-data root is missing or unsafe'
  [[ $(stat -c '%u:%g:%a' "$DATA_DIR") == "$AUTHORITY_UID:$AUTHORITY_GID:700" ]] || \
    fail 'clean-data root must be owned by fixed Authority UID/GID with mode 0700'
}

is_blank_data_volume() {
  # ext4 creates lost+found, so it is the only permitted directory entry on a
  # volume which has never been prepared. Anything else is evidence of a
  # partial or prepared organization and must be classified explicitly below.
  local entry
  shopt -s nullglob dotglob
  local entries=("$DATA_DIR"/*)
  shopt -u nullglob dotglob
  for entry in "${entries[@]}"; do
    [[ $(basename -- "$entry") == lost+found && -d $entry && ! -L $entry ]] || return 1
  done
  return 0
}

require_prepared_state_shape() {
  local directory
  for directory in "$PRIVATE_DIR" "$STATE_DIR" \
    "$RUNTIME_PROFILES_DIR" "$RUNTIME_ENVIRONMENTS_DIR"; do
    safe_directory "$directory" || fail 'retained clean-data is partial or contains an unsafe state directory'
    [[ $(stat -c '%u:%g:%a' "$directory") == "$AUTHORITY_UID:$AUTHORITY_GID:700" ]] || \
      fail 'retained clean-data state directory has an unexpected Authority UID/GID or mode'
  done
  safe_directory "$RELEASE_DIR" || \
    fail 'retained clean-data is partial or contains an unsafe state directory'
  [[ $(stat -c '%u:%g:%a' "$RELEASE_DIR") == '0:0:700' ]] || \
    fail 'retained release directory must preserve its root-owned control boundary'
  private_regular_file "$SETUP_FILE" || fail 'retained onboarding setup file is missing or unsafe'
  [[ $(stat -c '%u:%g' "$SETUP_FILE") == "$AUTHORITY_UID:$AUTHORITY_GID" ]] || \
    fail 'retained onboarding setup file has an unexpected Authority UID/GID'
  private_regular_file "$RELEASE_FILE" || fail 'accepted retained release record is missing or unsafe'
  [[ $(stat -c '%u:%g' "$RELEASE_FILE") == '0:0' ]] || \
    fail 'accepted retained release record must preserve its root-owned control boundary'
  private_regular_file "$ACTIVE_RUNTIME_PROFILE" || fail 'active retained runtime profile is missing or unsafe'
  [[ $(stat -c '%u:%g' "$ACTIVE_RUNTIME_PROFILE") == '0:0' ]] || \
    fail 'active retained runtime profile must preserve its root-owned control boundary'
}

require_no_candidate_or_operation() {
  [[ "$STAGING_RELEASE_GUARD_HELD" == true ]] || \
    fail 'a bounded staging release operation is in progress; preserve its root-owned guard'
  [[ ! -e $CANDIDATE_FILE && ! -L $CANDIDATE_FILE ]] || \
    fail 'a candidate release is present; resolve it with update-clean-v1.sh before rebuilding this host'
  [[ ! -e $OPERATION_LOCK_DIR && ! -L $OPERATION_LOCK_DIR ]] || \
    fail 'an Authority operation lock is present; follow the documented lock recovery procedure before rebuilding this host'
}

release_field() {
  python3 "$RELEASE_TOOL" field "$RELEASE_FILE" "$1"
}

validate_retained_tuple() {
  local release_id profile snapshot snapshot_owner expected_sha expected_source
  python3 "$RELEASE_TOOL" validate "$RELEASE_FILE" >/dev/null || \
    fail 'accepted retained release record is not canonical clean-v1'
  release_id="$(release_field release-id)"
  profile="$RUNTIME_PROFILES_DIR/$release_id.profile"
  snapshot="$RUNTIME_ENVIRONMENTS_DIR/$release_id.env"
  private_regular_file "$profile" || fail 'accepted retained runtime profile is missing or unsafe'
  private_regular_file "$snapshot" || fail 'accepted retained runtime environment is missing or unsafe'
  [[ $(stat -c '%u:%g' "$profile") == '0:0' ]] || \
    fail 'accepted retained runtime profile must preserve its root-owned control boundary'
  snapshot_owner=$(stat -c '%u:%g' "$snapshot")
  [[ $snapshot_owner == '0:0' || $snapshot_owner == "$AUTHORITY_UID:$AUTHORITY_GID" ]] || \
    fail 'accepted retained runtime environment has an unexpected control owner'
  python3 "$RUNTIME_PROFILE_TOOL" validate "$profile" >/dev/null || \
    fail 'accepted retained runtime profile is not canonical clean-v1'
  python3 "$RUNTIME_PROFILE_TOOL" validate "$ACTIVE_RUNTIME_PROFILE" >/dev/null || \
    fail 'active retained runtime profile is not canonical clean-v1'
  cmp -s "$profile" "$ACTIVE_RUNTIME_PROFILE" || \
    fail 'active retained runtime profile differs from the accepted release tuple'
  expected_sha="$(release_field runtime-profile-sha256)"
  expected_source="$(release_field source-sha)"
  [[ $(sha256sum "$profile" | awk '{print $1}') == "$expected_sha" ]] || \
    fail 'accepted retained runtime profile digest differs from the accepted release tuple'
  [[ $(python3 "$RUNTIME_PROFILE_TOOL" field "$profile" source-sha) == "$expected_source" ]] || \
    fail 'accepted retained runtime profile source differs from the accepted release tuple'
  if ! python3 - "$snapshot" "$SETUP_FILE" \
    "$(release_field authority-image)" "$release_id" "$expected_source" \
    "$expected_sha" "$(release_field runtime-profile-version)" \
    "$AUTHORITY_UID" "$AUTHORITY_GID" <<'PY'
import pathlib
import stat
import sys

snapshot, setup = map(pathlib.Path, sys.argv[1:3])
image, release_id, source_sha, profile_sha, profile_version, uid, gid = sys.argv[3:]

def private_regular(path, label):
    state = path.lstat()
    if (not stat.S_ISREG(state.st_mode) or stat.S_ISLNK(state.st_mode)
            or stat.S_IMODE(state.st_mode) != 0o600):
        raise SystemExit(label + ' must be a private regular file')

def exact_values(path, expected, label):
    rows = path.read_text(encoding='utf-8').splitlines()
    for key, value in expected.items():
        if [row for row in rows if row.startswith(key + '=')] != [key + '=' + value]:
            raise SystemExit(label + ' does not match the accepted release tuple')

private_regular(snapshot, 'retained runtime environment')
private_regular(setup, 'retained onboarding setup')
exact_values(snapshot, {
    'ECHO_CLEAN_AUTHORITY_IMAGE': image,
    'ECHO_CLEAN_RELEASE_ID': release_id,
    'ECHO_CLEAN_RELEASE_SOURCE_SHA': source_sha,
    'ECHO_CLEAN_RUNTIME_PROFILE_SHA256': profile_sha,
    'ECHO_CLEAN_RUNTIME_PROFILE_VERSION': profile_version,
}, 'retained runtime environment')
exact_values(setup, {
    'runtime_user': 'echo-authority',
    'authority_uid': uid,
    'authority_gid': gid,
}, 'retained onboarding setup')
PY
  then
    fail 'retained runtime environment or onboarding setup is unsafe or tuple-drifted'
  fi
  ACCEPTED_PROFILE=$profile
  ACCEPTED_ENVIRONMENT=$snapshot
}

materialize_root_volume_files() {
  local stage_parent stage_directory
  stage_parent="$(mktemp -d "$DEPLOY_DIR/.retained-runtime-profile.XXXXXX")" || \
    fail 'could not create a private runtime-profile staging directory'
  stage_directory="$stage_parent/materialized"
  trap 'rm -rf -- "$stage_parent"' RETURN
  python3 "$RUNTIME_PROFILE_TOOL" materialize "$ACCEPTED_PROFILE" "$stage_directory" || \
    fail 'could not materialize the accepted retained runtime profile'
  if ! python3 - "$stage_directory" "$DEPLOY_DIR" "$ACCEPTED_ENVIRONMENT" <<'PY'
import os
import pathlib
import stat
import sys
import tempfile

source_dir, deploy_dir, environment = map(pathlib.Path, sys.argv[1:])
names = (
    'Caddyfile.clean-v1',
    'Caddyfile.clean-v1.ec2',
    'compose.clean-v1.ec2.yaml',
    'compose.clean-v1.yaml',
)

def regular(path, label, private=False):
    state = path.lstat()
    if (not stat.S_ISREG(state.st_mode) or stat.S_ISLNK(state.st_mode)
            or (private and stat.S_IMODE(state.st_mode) != 0o600)):
        raise SystemExit(label + ' is not a safe regular file')

regular(environment, 'retained runtime environment', private=True)
if {path.name for path in source_dir.iterdir()} != set(names):
    raise SystemExit('runtime profile materialization contains an unexpected file set')
for name in names:
    regular(source_dir / name, 'materialized runtime-profile file', private=True)

sources = {'.env.clean-v1': environment}
sources.update({name: source_dir / name for name in names})
destinations = {name: deploy_dir / name for name in sources}
present = []
for name, destination in destinations.items():
    try:
        state = destination.lstat()
    except FileNotFoundError:
        present.append(False)
        continue
    if (not stat.S_ISREG(state.st_mode) or stat.S_ISLNK(state.st_mode)
            or stat.S_IMODE(state.st_mode) != 0o600 or state.st_uid != 0 or state.st_gid != 0):
        raise SystemExit('existing deployment runtime file is unsafe: ' + name)
    present.append(True)
if any(present) and not all(present):
    raise SystemExit('deployment runtime files are partial; refusing to fabricate a mixed host state')
if all(present):
    for name, source in sources.items():
        if source.read_bytes() != destinations[name].read_bytes():
            raise SystemExit('deployment runtime file drifts from the accepted retained tuple: ' + name)
    raise SystemExit(0)

temporary_paths = []
try:
    for name, source in sources.items():
        descriptor, temporary = tempfile.mkstemp(prefix='.' + name + '.', dir=deploy_dir)
        temporary_paths.append(temporary)
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, 'wb') as output, source.open('rb') as input:
            while chunk := input.read(1024 * 1024):
                output.write(chunk)
            output.flush()
            os.fsync(output.fileno())
    for (name, _), temporary in zip(sources.items(), temporary_paths):
        os.replace(temporary, destinations[name])
    directory = os.open(deploy_dir, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
finally:
    for temporary in temporary_paths:
        if os.path.exists(temporary):
            os.unlink(temporary)
PY
  then
    fail 'could not materialize the accepted retained runtime profile into a safe deployment directory'
  fi
  trap - RETURN
  rm -rf -- "$stage_parent"
}

restore_or_no_op() {
  require_authority_identity
  require_data_root
  if is_blank_data_volume; then
    printf '{"ok":true,"state":"unprepared","action":"no_op"}\n'
    return 10
  fi
  require_prepared_state_shape
  require_no_candidate_or_operation
  validate_retained_tuple
  materialize_root_volume_files
  printf '{"ok":true,"state":"accepted_tuple_materialized","release_id":"%s"}\n' \
    "$(release_field release-id)"
  return 0
}

while [[ $# -gt 0 ]]; do
  case $1 in
    materialize|resume)
      [[ $COMMAND == resume ]] || usage
      COMMAND=$1
      shift
      ;;
    --deploy-dir)
      [[ $# -ge 2 && $2 == /* && $2 != *$'\n'* ]] || usage
      DEPLOY_DIR=${2%/}
      shift 2
      ;;
    --help|-h) usage ;;
    *) usage ;;
  esac
done

[[ ${EUID} -eq 0 ]] || fail 'run this restore command as root'
[[ $DEPLOY_DIR == /* && -d $DEPLOY_DIR && ! -L $DEPLOY_DIR ]] || \
  fail 'deployment directory is missing or unsafe'
DATA_DIR="$DEPLOY_DIR/clean-data"
PRIVATE_DIR="$DATA_DIR/private"
RELEASE_DIR="$DATA_DIR/release"
STATE_DIR="$DATA_DIR/state"
RUNTIME_PROFILES_DIR="$RELEASE_DIR/runtime-profiles"
RUNTIME_ENVIRONMENTS_DIR="$RELEASE_DIR/runtime-environments"
SETUP_FILE="$PRIVATE_DIR/onboard-clean-v1.conf"
RELEASE_FILE="$RELEASE_DIR/current.clean-v1.json"
CANDIDATE_FILE="$RELEASE_DIR/candidate.clean-v1.json"
ACTIVE_RUNTIME_PROFILE="$RELEASE_DIR/runtime-profile.active"
OPERATION_LOCK_DIR="$DATA_DIR/.authority-operation-lock"
RELEASE_TOOL="$DEPLOY_DIR/release/clean-v1-release.py"
RUNTIME_PROFILE_TOOL="$DEPLOY_DIR/release/clean-v1-runtime-profile.py"
ONBOARD_TOOL="$DEPLOY_DIR/onboard-clean-v1.sh"
ACCEPTED_PROFILE=''
ACCEPTED_ENVIRONMENT=''

[[ -f $RELEASE_TOOL && ! -L $RELEASE_TOOL ]] || fail 'installed release validator is missing or unsafe'
[[ -f $RUNTIME_PROFILE_TOOL && ! -L $RUNTIME_PROFILE_TOOL ]] || fail 'installed runtime-profile validator is missing or unsafe'

release_staging_guard() {
  if [[ $STAGING_RELEASE_GUARD_HELD == true ]]; then
    rm -f "$DEPLOY_DIR/.staging-release-guard/owner-pid"
    rmdir "$DEPLOY_DIR/.staging-release-guard"
    STAGING_RELEASE_GUARD_HELD=false
  fi
}
mkdir -m 0700 "$DEPLOY_DIR/.staging-release-guard" 2>/dev/null || \
  fail 'a bounded staging release operation is in progress; preserve its root-owned guard'
STAGING_RELEASE_GUARD_HELD=true
trap 'release_staging_guard' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
(umask 077; printf '%s\n' "$$" > "$DEPLOY_DIR/.staging-release-guard/owner-pid")

if restore_or_no_op; then
  restored=true
else
  status=$?
  [[ $status -eq 10 ]] || exit "$status"
  restored=false
fi

if [[ $COMMAND == materialize ]]; then
  exit 0
fi
[[ $restored == true ]] || fail 'retained host resume requires an accepted release tuple'

[[ -x $ONBOARD_TOOL && ! -L $ONBOARD_TOOL ]] || fail 'installed onboarding wrapper is missing or unsafe'
# The onboarding wrapper acquires this same interlock before any mutation.
release_staging_guard
"$ONBOARD_TOOL" resume
status_output="$("$ONBOARD_TOOL" status)" || fail 'onboarding status failed after retained-host restore'
printf '%s\n' "$status_output"
grep -Fqx 'terminal_green=true' <<<"$status_output" || \
  fail 'retained host was reconstructed, but the Authority is not terminal green'
