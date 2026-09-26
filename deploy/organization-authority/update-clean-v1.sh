#!/usr/bin/env bash
# Exact-image clean-v1 release staging. Schema changes require the named,
# stopped-state V5-to-V6 and V8-to-V9 migrations; ordinary stage never migrates.
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
RELEASE_TOOL="${ECHO_CLEAN_RELEASE_TOOL:-$DEPLOY_DIR/release/clean-v1-release.py}"
if [[ ! -f "$RELEASE_TOOL" && -f "$DEPLOY_DIR/../release/clean-v1-release.py" ]]; then
  RELEASE_TOOL="$DEPLOY_DIR/../release/clean-v1-release.py"
fi
RUNTIME_PROFILE_TOOL="${ECHO_CLEAN_RUNTIME_PROFILE_TOOL:-$DEPLOY_DIR/release/clean-v1-runtime-profile.py}"
if [[ ! -f "$RUNTIME_PROFILE_TOOL" && -f "$DEPLOY_DIR/../release/clean-v1-runtime-profile.py" ]]; then
  RUNTIME_PROFILE_TOOL="$DEPLOY_DIR/../release/clean-v1-runtime-profile.py"
fi
ENV_FILE="${ECHO_CLEAN_ENV_FILE:-$DEPLOY_DIR/.env.clean-v1}"
RUNTIME_CONFIG_DIR="${ECHO_CLEAN_RUNTIME_CONFIG_DIR:-$DEPLOY_DIR}"
RELEASE_STATE_DIR="${ECHO_CLEAN_RELEASE_STATE_DIR:-$DEPLOY_DIR/clean-data/release}"
STATE_DIR="${ECHO_CLEAN_STATE_DIR:-${RELEASE_STATE_DIR%/*}/state}"
CURRENT_RECORD="$RELEASE_STATE_DIR/current.clean-v1.json"
CANDIDATE_RECORD="$RELEASE_STATE_DIR/candidate.clean-v1.json"
RUNTIME_PROFILE_STATE_DIR="$RELEASE_STATE_DIR/runtime-profiles"
ENVIRONMENT_STATE_DIR="$RELEASE_STATE_DIR/runtime-environments"
CANARY_RECEIPT_DIR="$RELEASE_STATE_DIR/canary-receipts"
ACTIVE_RUNTIME_PROFILE="$RELEASE_STATE_DIR/runtime-profile.active"
OPERATION_LOCK_DIR="${ECHO_CLEAN_OPERATION_LOCK_DIR:-${RELEASE_STATE_DIR%/*}/.authority-operation-lock}"
ROLLBACK_READER_CAPABILITY_LABEL='org.echobrain.authority.state-capability.staging-synthetic-meeting-canary-v1'
STAGING_JOURNEY_TELEMETRY_CAPABILITY_LABEL='org.echobrain.authority.telemetry.staging-journey-v1'
OPERATION_LOCK_HELD=false
STAGING_RELEASE_GUARD_HELD=false

fail() { printf '%s\n' "$*" >&2; exit 1; }

release_operation_lock() {
  if [[ "$OPERATION_LOCK_HELD" == true ]]; then
    rm -f "$OPERATION_LOCK_DIR/owner-pid" >/dev/null 2>&1 || true
    rmdir "$OPERATION_LOCK_DIR" >/dev/null 2>&1 || true
    OPERATION_LOCK_HELD=false
  fi
  if [[ "$STAGING_RELEASE_GUARD_HELD" == true ]]; then
    rm -f "$DEPLOY_DIR/.staging-release-guard/owner-pid"
    rmdir "$DEPLOY_DIR/.staging-release-guard"
    STAGING_RELEASE_GUARD_HELD=false
  fi
}

acquire_operation_lock() {
  acquire_staging_release_guard
  if ! mkdir -m 0700 "$OPERATION_LOCK_DIR" 2>/dev/null; then
    release_operation_lock
    fail 'another Authority activation or release operation is already in progress; follow the README operation-lock recovery steps if its owner was interrupted'
  fi
  OPERATION_LOCK_HELD=true
  if ! (umask 077; printf '%s\n' "$$" > "$OPERATION_LOCK_DIR/owner-pid"); then
    release_operation_lock
    fail 'could not record the Authority operation lock owner'
  fi
}

acquire_staging_release_guard() {
  local guard="$DEPLOY_DIR/.staging-release-guard"
  # The reviewed runner owns this exact nested lock; ordinary human calls
  # acquire the same root-owned interlock for their entire operation.
  [[ "$OPERATION_LOCK_DIR" != "$guard/wrapper-lock" ]] || return 0
  mkdir -m 0700 "$guard" 2>/dev/null || fail 'a bounded staging release operation is in progress; preserve its root-owned guard'
  STAGING_RELEASE_GUARD_HELD=true
  if ! (umask 077; printf '%s\n' "$$" > "$guard/owner-pid"); then
    release_operation_lock
    fail 'could not record the root-owned staging release guard owner'
  fi
}

[[ -x /usr/bin/python3 || -x "$(command -v python3)" ]] || fail 'python3 is required'
[[ -f "$RELEASE_TOOL" ]] || fail 'clean-v1 release validator is missing'
[[ -f "$RUNTIME_PROFILE_TOOL" ]] || fail 'clean-v1 runtime profile validator is missing'
[[ -d "$RUNTIME_CONFIG_DIR" && ! -L "$RUNTIME_CONFIG_DIR" ]] || fail 'Authority runtime configuration directory is missing or unsafe'
[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || fail 'Authority deployment environment file is missing or unsafe'

compose_clean() {
  docker compose --env-file "$ENV_FILE" \
    -f "$RUNTIME_CONFIG_DIR/compose.clean-v1.yaml" \
    -f "$RUNTIME_CONFIG_DIR/compose.clean-v1.ec2.yaml" "$@"
}

field() { python3 "$RELEASE_TOOL" field "$1" "$2"; }
validate() { python3 "$RELEASE_TOOL" validate "$1" >/dev/null; }
profile_field() { python3 "$RUNTIME_PROFILE_TOOL" field "$1" "$2"; }
validate_profile() { python3 "$RUNTIME_PROFILE_TOOL" validate "$1" >/dev/null; }

ensure_state_directories() {
  python3 - "$RELEASE_STATE_DIR" "$RUNTIME_PROFILE_STATE_DIR" "$ENVIRONMENT_STATE_DIR" \
    "$RELEASE_STATE_DIR/history" "$RELEASE_STATE_DIR/failed" "$CANARY_RECEIPT_DIR" <<'PY'
import os, pathlib, stat, sys

for index, raw in enumerate(sys.argv[1:]):
    path = pathlib.Path(raw)
    try:
        state = path.lstat()
    except FileNotFoundError:
        parent = path.parent
        parent_state = parent.lstat()
        if stat.S_ISLNK(parent_state.st_mode) or not stat.S_ISDIR(parent_state.st_mode):
            raise SystemExit(str(parent) + ' is not a safe release-state parent directory')
        path.mkdir(mode=0o700)
        state = path.lstat()
    if stat.S_ISLNK(state.st_mode) or not stat.S_ISDIR(state.st_mode):
        raise SystemExit(str(path) + ' is not a safe release-state directory')
PY
}

# A missing or empty state directory is the explicit first-deployment case.
# Any populated state, including an unmanifested directory, belongs to the
# candidate runtime's complete verifier.  This wrapper deliberately owns no
# partial copy of that manifest or schema contract.
state_preflight_required() {
  python3 - "$STATE_DIR" <<'PY'
import pathlib, stat, sys

state_dir = pathlib.Path(sys.argv[1])
try:
    state = state_dir.lstat()
except FileNotFoundError:
    print("false")
    raise SystemExit(0)
if stat.S_ISLNK(state.st_mode) or not stat.S_ISDIR(state.st_mode):
    raise SystemExit("persisted Authority state directory is unsafe")
try:
    print("true" if next(state_dir.iterdir(), None) is not None else "false")
except OSError as error:
    raise SystemExit("could not inspect persisted Authority state: " + str(error))
PY
}

authority_runtime_identity() {
  python3 - "$ENV_FILE" <<'PY'
import pathlib, re, stat, sys

path = pathlib.Path(sys.argv[1])
state = path.lstat()
if not stat.S_ISREG(state.st_mode) or stat.S_ISLNK(state.st_mode) or state.st_mode & 0o077:
    raise SystemExit('Authority deployment environment must be a private regular file')
values = {}
for name in ('ECHO_CLEAN_AUTHORITY_UID', 'ECHO_CLEAN_AUTHORITY_GID'):
    rows = [line.split('=', 1)[1] for line in path.read_text(encoding='utf-8').splitlines() if line.startswith(name + '=')]
    if len(rows) != 1 or not re.fullmatch(r'[1-9][0-9]{0,9}', rows[0]) or int(rows[0]) > 4294967295:
        raise SystemExit('Authority deployment environment must contain one validated non-root ' + name)
    values[name] = rows[0]
print(values['ECHO_CLEAN_AUTHORITY_UID'] + ':' + values['ECHO_CLEAN_AUTHORITY_GID'])
PY
}

verify_candidate_state_lineage() {
  [[ "$(state_preflight_required)" == true ]] || return 0
  local image source runtime_identity
  image="$(field "$1" authority-image)"
  source="$(field "$1" source-sha)"
  runtime_identity="$(authority_runtime_identity)" || \
    fail 'could not obtain the validated Authority runtime UID/GID for lineage verification'
  docker pull "$image" || fail 'could not pull the immutable candidate Authority image for lineage verification'
  image_source_matches "$image" "$source" || \
    fail 'candidate Authority image source label does not match the release record before lineage verification'
  docker run --rm --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges --user "$runtime_identity" --workdir /app \
    --entrypoint node \
    --mount "type=bind,src=$STATE_DIR,dst=/echo-clean/state,readonly" \
    "$image" --input-type=module -e 'import { verifyAuthorityStateLineage } from "./packages/organization-authority-kernel/dist/composition/verify-authority-state-lineage.js"; import { verifyPersistedOpenRouterDecisionProcessorAdmissionV1 } from "./providers/openrouter/dist/verify-openrouter-decision-processor-admission-v1.js"; verifyAuthorityStateLineage("/echo-clean/state"); verifyPersistedOpenRouterDecisionProcessorAdmissionV1("/echo-clean/state");' || \
    fail 'candidate Authority image rejected persisted state lineage; if this is a pre-live rehearsal with no live users, use onboard-clean-v1.sh replace-rehearsal --confirm-no-live-users; otherwise use an explicit migration procedure'
}

current_image() {
  python3 - "$ENV_FILE" <<'PY'
import pathlib, re, stat, sys
path = pathlib.Path(sys.argv[1])
state = path.lstat()
if stat.S_ISLNK(state.st_mode) or not stat.S_ISREG(state.st_mode) or state.st_mode & 0o077:
    raise SystemExit('Authority deployment environment must be a private regular file')
rows = [line for line in path.read_text(encoding='utf-8').splitlines() if line.startswith('ECHO_CLEAN_AUTHORITY_IMAGE=')]
if len(rows) != 1:
    raise SystemExit('Authority deployment environment must contain exactly one ECHO_CLEAN_AUTHORITY_IMAGE')
value = rows[0].split('=', 1)[1]
if not re.fullmatch(r'[a-z0-9][a-z0-9.-]*(?:/[a-z0-9][a-z0-9._-]*)+@sha256:[0-9a-f]{64}', value):
    raise SystemExit('Authority image is not an immutable digest reference')
print(value)
PY
}

sha256_file() {
  python3 - "$1" <<'PY'
import hashlib, pathlib, stat, sys
path = pathlib.Path(sys.argv[1])
state = path.lstat()
if not stat.S_ISREG(state.st_mode) or stat.S_ISLNK(state.st_mode):
    raise SystemExit('runtime profile must be a regular file')
digest = hashlib.sha256()
with path.open('rb') as source:
    for chunk in iter(lambda: source.read(1024 * 1024), b''):
        digest.update(chunk)
print(digest.hexdigest())
PY
}

runtime_profile_path() {
  printf '%s/%s.profile\n' "$RUNTIME_PROFILE_STATE_DIR" "$(field "$1" release-id)"
}

environment_snapshot_path() {
  printf '%s/%s.env\n' "$ENVIRONMENT_STATE_DIR" "$(field "$1" release-id)"
}

verify_runtime_profile() {
  local record="$1" profile="$2" expected_sha expected_source
  validate_profile "$profile" || return 1
  expected_sha="$(field "$record" runtime-profile-sha256)"
  [[ "$(sha256_file "$profile")" == "$expected_sha" ]] || fail 'runtime profile SHA-256 does not match the release record'
  expected_source="$(field "$record" source-sha)"
  [[ "$(profile_field "$profile" source-sha)" == "$expected_source" ]] || fail 'runtime profile source_sha does not match the release record'
}

create_environment_snapshot() {
  local destination="$1" record="$2"
  python3 - "$ENV_FILE" "$destination" \
    "$(field "$record" authority-image)" \
    "$(field "$record" release-id)" \
    "$(field "$record" source-sha)" \
    "$(field "$record" runtime-profile-sha256)" \
    "$(field "$record" runtime-profile-version)" <<'PY'
import os, pathlib, stat, sys

source, destination = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
image, release_id, source_sha, profile_sha, profile_version = sys.argv[3:8]
state = source.lstat()
if not stat.S_ISREG(state.st_mode) or stat.S_ISLNK(state.st_mode) or state.st_mode & 0o077:
    raise SystemExit('Authority deployment environment must be a private regular file')
lines = source.read_text(encoding='utf-8').splitlines()
names = {
    'ECHO_CLEAN_AUTHORITY_IMAGE': image,
    'ECHO_CLEAN_RELEASE_ID': release_id,
    'ECHO_CLEAN_RELEASE_SOURCE_SHA': source_sha,
    'ECHO_CLEAN_RUNTIME_PROFILE_SHA256': profile_sha,
    'ECHO_CLEAN_RUNTIME_PROFILE_VERSION': profile_version,
}
for name in names:
    if sum(line.startswith(name + '=') for line in lines) > 1:
        raise SystemExit('Authority deployment environment has duplicate ' + name)
payload = [line for line in lines if not any(line.startswith(name + '=') for name in names)]
payload.extend(name + '=' + value for name, value in names.items())
destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
os.chmod(destination.parent, 0o700)
# tempfile.mkstemp reifies relative dirs through abspath, losing the pinned cwd.
temporary = destination.parent / ('.' + destination.name + '.' + os.urandom(16).hex())
fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
try:
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as output:
        output.write('\n'.join(payload) + '\n')
        output.flush(); os.fsync(output.fileno())
    if destination.exists():
        raise SystemExit('environment snapshot destination already exists')
    os.link(temporary, destination)
    os.unlink(temporary)
    directory = os.open(destination.parent, os.O_RDONLY)
    try: os.fsync(directory)
    finally: os.close(directory)
finally:
    if os.path.exists(temporary): os.unlink(temporary)
PY
}

activate_release_tuple() {
  local record="$1" profile env_snapshot stage_parent stage_dir
  profile="$(runtime_profile_path "$record")"
  env_snapshot="$(environment_snapshot_path "$record")"
  [[ -f "$profile" && ! -L "$profile" ]] || fail 'stored runtime profile is missing or unsafe'
  [[ -f "$env_snapshot" && ! -L "$env_snapshot" ]] || fail 'stored release environment snapshot is missing or unsafe'
  verify_runtime_profile "$record" "$profile"
  stage_parent="$(mktemp -d "$RUNTIME_CONFIG_DIR/.runtime-profile.XXXXXX")"
  stage_dir="$stage_parent/materialized"
  if ! python3 "$RUNTIME_PROFILE_TOOL" materialize "$profile" "$stage_dir"; then
    rm -rf "$stage_parent"
    fail 'could not materialize the selected runtime profile'
  fi
  if ! python3 - "$stage_dir" "$RUNTIME_CONFIG_DIR" "$env_snapshot" "$ENV_FILE" "$profile" "$ACTIVE_RUNTIME_PROFILE" <<'PY'
import os, pathlib, stat, sys

source_dir, deploy_dir = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
env_snapshot, env_file = pathlib.Path(sys.argv[3]), pathlib.Path(sys.argv[4])
profile, active_profile = pathlib.Path(sys.argv[5]), pathlib.Path(sys.argv[6])
names = ('compose.clean-v1.yaml', 'compose.clean-v1.ec2.yaml', 'Caddyfile.clean-v1', 'Caddyfile.clean-v1.ec2')

def regular(path, private=False):
    state = path.lstat()
    if not stat.S_ISREG(state.st_mode) or stat.S_ISLNK(state.st_mode) or (private and state.st_mode & 0o077):
        raise SystemExit(str(path) + ' is not a safe regular file')

regular(env_snapshot, private=True)
regular(profile)
for name in names:
    regular(source_dir / name)
if {path.name for path in source_dir.iterdir()} != set(names):
    raise SystemExit('runtime profile materialization contains an unexpected file set')

def replace_from(source, destination, mode):
    temporary = destination.parent / ('.' + destination.name + '.' + os.urandom(16).hex())
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'wb') as output, source.open('rb') as input:
            while chunk := input.read(1024 * 1024): output.write(chunk)
            output.flush(); os.fsync(output.fileno())
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)

replace_from(env_snapshot, env_file, 0o600)
replace_from(profile, active_profile, 0o600)
for name in names:
    source, destination = source_dir / name, deploy_dir / name
    replace_from(source, destination, stat.S_IMODE(source.stat().st_mode))
directory = os.open(deploy_dir, os.O_RDONLY)
try: os.fsync(directory)
finally: os.close(directory)
PY
  then
    rm -rf "$stage_parent"
    fail 'could not activate the selected runtime profile'
  fi
  rm -rf "$stage_parent"
}

active_runtime_profile_matches() {
  local record="$1" expected_sha expected_source actual_sha actual_source
  [[ -f "$ACTIVE_RUNTIME_PROFILE" && ! -L "$ACTIVE_RUNTIME_PROFILE" ]] || fail 'runtime profile drifted from the accepted release record'
  validate_profile "$ACTIVE_RUNTIME_PROFILE" || fail 'runtime profile drifted from the accepted release record'
  expected_sha="$(field "$record" runtime-profile-sha256)"
  expected_source="$(field "$record" source-sha)"
  actual_sha="$(sha256_file "$ACTIVE_RUNTIME_PROFILE")" || fail 'runtime profile drifted from the accepted release record'
  actual_source="$(profile_field "$ACTIVE_RUNTIME_PROFILE" source-sha)" || fail 'runtime profile drifted from the accepted release record'
  [[ "$actual_sha" == "$expected_sha" && "$actual_source" == "$expected_source" ]] || fail 'runtime profile drifted from the accepted release record'
}

active_materialized_profile_matches() {
  local stage_parent stage_dir name
  stage_parent="$(mktemp -d "$RUNTIME_CONFIG_DIR/.runtime-profile-check.XXXXXX")"
  stage_dir="$stage_parent/materialized"
  if ! python3 "$RUNTIME_PROFILE_TOOL" materialize "$ACTIVE_RUNTIME_PROFILE" "$stage_dir"; then
    rm -rf "$stage_parent"
    fail 'runtime profile materialization drifted from the accepted release record'
  fi
  for name in Caddyfile.clean-v1 Caddyfile.clean-v1.ec2 compose.clean-v1.ec2.yaml compose.clean-v1.yaml; do
    if [[ ! -f "$RUNTIME_CONFIG_DIR/$name" || -L "$RUNTIME_CONFIG_DIR/$name" ]] || ! cmp -s "$stage_dir/$name" "$RUNTIME_CONFIG_DIR/$name"; then
      rm -rf "$stage_parent"
      fail 'runtime profile materialization drifted from the accepted release record'
    fi
  done
  rm -rf "$stage_parent"
}

stored_release_tuple_matches() {
  local record="$1" profile snapshot
  profile="$(runtime_profile_path "$record")"
  snapshot="$(environment_snapshot_path "$record")"
  [[ -f "$profile" && ! -L "$profile" ]] || fail 'stored runtime profile is missing or unsafe'
  verify_runtime_profile "$record" "$profile"
  [[ -f "$snapshot" && ! -L "$snapshot" ]] || fail 'release environment snapshot is missing or unsafe'
  python3 - "$snapshot" \
    "$(field "$record" authority-image)" \
    "$(field "$record" release-id)" \
    "$(field "$record" source-sha)" \
    "$(field "$record" runtime-profile-sha256)" \
    "$(field "$record" runtime-profile-version)" <<'PY'
import pathlib, stat, sys

path = pathlib.Path(sys.argv[1])
expected = dict(zip((
    'ECHO_CLEAN_AUTHORITY_IMAGE',
    'ECHO_CLEAN_RELEASE_ID',
    'ECHO_CLEAN_RELEASE_SOURCE_SHA',
    'ECHO_CLEAN_RUNTIME_PROFILE_SHA256',
    'ECHO_CLEAN_RUNTIME_PROFILE_VERSION',
), sys.argv[2:]))
state = path.lstat()
if not stat.S_ISREG(state.st_mode) or stat.S_ISLNK(state.st_mode) or state.st_mode & 0o077:
    raise SystemExit('release environment snapshot must be a private regular file')
lines = path.read_text(encoding='utf-8').splitlines()
for name, value in expected.items():
    if [line for line in lines if line.startswith(name + '=')] != [name + '=' + value]:
        raise SystemExit('release environment snapshot does not match the release record')
PY
}

active_environment_matches() {
  local record="$1" snapshot
  stored_release_tuple_matches "$record"
  snapshot="$(environment_snapshot_path "$record")"
  cmp -s "$ENV_FILE" "$snapshot" || fail 'release environment drifted from the accepted release record'
}

store_release_tuple() {
  local record="$1" supplied_profile="$2" stored_profile
  verify_runtime_profile "$record" "$supplied_profile"
  stored_profile="$(runtime_profile_path "$record")"
  copy_record "$supplied_profile" "$stored_profile" no-replace
  if ! create_environment_snapshot "$(environment_snapshot_path "$record")" "$record"; then
    remove_record "$stored_profile" || true
    return 1
  fi
}

remove_release_tuple() {
  local record="$1" profile env_snapshot
  profile="$(runtime_profile_path "$record")"
  env_snapshot="$(environment_snapshot_path "$record")"
  [[ ! -e "$profile" ]] || remove_record "$profile"
  [[ ! -e "$env_snapshot" ]] || remove_record "$env_snapshot"
}

copy_record() {
  local source="$1" destination="$2" mode="$3"
  python3 - "$source" "$destination" "$mode" <<'PY'
import os, pathlib, stat, sys
source, destination, mode = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3]
if mode not in {'no-replace', 'replace', 'idempotent-immutable'}:
    raise SystemExit('unsupported release record copy mode')
destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
os.chmod(destination.parent, 0o700)
data = source.read_bytes()
if mode == 'no-replace' and destination.exists():
    raise SystemExit('release record destination already exists')
if mode == 'idempotent-immutable' and (destination.exists() or destination.is_symlink()):
    state = destination.lstat()
    if (
        stat.S_ISLNK(state.st_mode) or
        not stat.S_ISREG(state.st_mode) or
        state.st_mode & 0o077 or
        destination.read_bytes() != data
    ):
        raise SystemExit('existing immutable release record is unsafe or does not match')
    raise SystemExit(0)
temporary = destination.parent / ('.' + destination.name + '.' + os.urandom(16).hex())
fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
try:
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, 'wb') as output:
        output.write(data); output.flush(); os.fsync(output.fileno())
    if mode in {'no-replace', 'idempotent-immutable'}:
        os.link(temporary, destination)
        os.unlink(temporary)
    else:
        os.replace(temporary, destination)
    directory = os.open(destination.parent, os.O_RDONLY)
    try: os.fsync(directory)
    finally: os.close(directory)
finally:
    if os.path.exists(temporary): os.unlink(temporary)
PY
}

remove_record() {
  python3 - "$1" <<'PY'
import os, pathlib, stat, sys
path = pathlib.Path(sys.argv[1])
state = path.lstat()
if not stat.S_ISREG(state.st_mode):
    raise SystemExit('release record removal target is unsafe')
os.unlink(path)
directory = os.open(path.parent, os.O_RDONLY)
try: os.fsync(directory)
finally: os.close(directory)
PY
}

archive_candidate_as_failed() {
  local id
  id="$(field "$CANDIDATE_RECORD" release-id)"
  copy_record "$CANDIDATE_RECORD" "$RELEASE_STATE_DIR/failed/$id.json" idempotent-immutable || return 1
  remove_record "$CANDIDATE_RECORD"
}

service_is_stopped() {
  local service="$1" id running
  id="$(compose_clean ps -q "$service")" || return 1
  [[ -n "$id" ]] || return 0
  running="$(docker inspect --format '{{.State.Running}}' "$id")" || return 1
  [[ "$running" != true ]]
}

candidate_runtime_is_stopped() {
  service_is_stopped authority && service_is_stopped proxy
}

abort_first_deploy_candidate() {
  # The persisted candidate tuple, rather than the active cache, is the only
  # durable source of truth after an interrupted first activation. Restore it
  # before Compose is consulted, then require any running runtime to prove it.
  stored_release_tuple_matches "$CANDIDATE_RECORD"
  activate_release_tuple "$CANDIDATE_RECORD" || return 1
  if running_exact_release "$CANDIDATE_RECORD"; then
    compose_clean down || return 1
  elif ! candidate_runtime_is_stopped; then
    return 1
  fi
  archive_candidate_as_failed
}

release_id_unused() {
  local id="$1"
  [[ ! -e "$RELEASE_STATE_DIR/history/$id.json" && ! -e "$RELEASE_STATE_DIR/failed/$id.json" ]] || return 1
  [[ ! -e "$RUNTIME_PROFILE_STATE_DIR/$id.profile" && ! -e "$ENVIRONMENT_STATE_DIR/$id.env" ]] || return 1
  if [[ -f "$CURRENT_RECORD" ]] && [[ "$(field "$CURRENT_RECORD" release-id)" == "$id" ]]; then return 1; fi
  if [[ -f "$CANDIDATE_RECORD" ]] && [[ "$(field "$CANDIDATE_RECORD" release-id)" == "$id" ]]; then return 1; fi
}

running_container_id() {
  local service="$1" id
  id="$(compose_clean ps -q "$service")"
  [[ -n "$id" ]] || return 1
  [[ "$(docker inspect --format '{{.State.Running}}' "$id")" == true ]] || return 1
  printf '%s\n' "$id"
}

staging_journey_telemetry_environment_matches() {
  local expected_source="$1" expected_build_number="$2" encoded_environment="$3"
  python3 - "$expected_source" "$expected_build_number" "$encoded_environment" <<'PY'
import json, re, sys

source_sha, build_number, encoded_environment = sys.argv[1:]
if not re.fullmatch(r'[0-9a-f]{40}', source_sha):
    raise SystemExit(1)
if not re.fullmatch(r'[1-9][0-9]*', build_number) or int(build_number) > 9007199254740991:
    raise SystemExit(1)
try:
    environment = json.loads(encoded_environment)
except (TypeError, ValueError):
    raise SystemExit(1)
if not isinstance(environment, list) or not all(isinstance(entry, str) for entry in environment):
    raise SystemExit(1)
source_entries = [entry for entry in environment if entry.startswith('ECHO_SOURCE_SHA=')]
build_entries = [entry for entry in environment if entry.startswith('ECHO_BUILD_NUMBER=')]
capability_entries = [entry for entry in environment if entry.startswith('ECHO_STAGING_JOURNEY_TELEMETRY_V1=')]
if capability_entries != ['ECHO_STAGING_JOURNEY_TELEMETRY_V1=true']:
    raise SystemExit(1)
if source_entries != ['ECHO_SOURCE_SHA=' + source_sha]:
    raise SystemExit(1)
if build_entries != ['ECHO_BUILD_NUMBER=' + build_number]:
    raise SystemExit(1)
PY
}

staging_journey_telemetry_environment_disables() {
  [[ "$1" != *enabled* ]]
}

image_staging_journey_telemetry_identity_matches() {
  local image="$1" expected_source="$2" host capability_format telemetry_enabled_format capability build_number environment telemetry_enabled
  host="$(authority_host 2>/dev/null)" || return 1
  [[ "$host" == "authority-staging.echobrain.org" ]] || return 0
  capability_format='{{index .Config.Labels "'"$STAGING_JOURNEY_TELEMETRY_CAPABILITY_LABEL"'"}}'
  telemetry_enabled_format='{{range .Config.Env}}{{if eq . "ECHO_STAGING_JOURNEY_TELEMETRY_V1=true"}}enabled{{end}}{{end}}'
  capability="$(docker image inspect --format "$capability_format" "$image")" || return 1
  # Images accepted before telemetry V1 remain rollback-compatible and emit no
  # journey telemetry. New telemetry-capable images must prove both bindings.
  case "$capability" in
    true)
      build_number="$(docker image inspect --format '{{index .Config.Labels "org.echobrain.authority.build-number"}}' "$image")" || return 1
      environment="$(docker image inspect --format '{{json .Config.Env}}' "$image")" || return 1
      staging_journey_telemetry_environment_matches \
        "$expected_source" "$build_number" "$environment"
      ;;
    ''|'<no value>')
      telemetry_enabled="$(docker image inspect --format "$telemetry_enabled_format" "$image")" || return 1
      staging_journey_telemetry_environment_disables "$telemetry_enabled"
      ;;
    *) return 1 ;;
  esac
}

running_staging_journey_telemetry_identity_matches() {
  local container="$1" image="$2" expected_source="$3" host capability_format telemetry_enabled_format capability build_number environment telemetry_enabled
  host="$(authority_host 2>/dev/null)" || return 1
  [[ "$host" == "authority-staging.echobrain.org" ]] || return 0
  capability_format='{{index .Config.Labels "'"$STAGING_JOURNEY_TELEMETRY_CAPABILITY_LABEL"'"}}'
  telemetry_enabled_format='{{range .Config.Env}}{{if eq . "ECHO_STAGING_JOURNEY_TELEMETRY_V1=true"}}enabled{{end}}{{end}}'
  capability="$(docker image inspect --format "$capability_format" "$image")" || return 1
  case "$capability" in
    true)
      build_number="$(docker image inspect --format '{{index .Config.Labels "org.echobrain.authority.build-number"}}' "$image")" || return 1
      environment="$(docker inspect --format '{{json .Config.Env}}' "$container")" || return 1
      staging_journey_telemetry_environment_matches \
        "$expected_source" "$build_number" "$environment"
      ;;
    ''|'<no value>')
      telemetry_enabled="$(docker inspect --format "$telemetry_enabled_format" "$container")" || return 1
      staging_journey_telemetry_environment_disables "$telemetry_enabled"
      ;;
    *) return 1 ;;
  esac
}

image_source_matches() {
  local image="$1" expected_source="$2"
  [[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" == "$expected_source" ]] || return 1
  image_staging_journey_telemetry_identity_matches "$image" "$expected_source"
}

accepted_image_can_read_staging_canary_state() {
  local image format
  image="$(field "$CURRENT_RECORD" authority-image)"
  format='{{index .Config.Labels "'"$ROLLBACK_READER_CAPABILITY_LABEL"'"}}'
  [[ "$(docker image inspect --format "$format" "$image")" == true ]]
}

running_exact_release() {
  local record="$1" expected expected_source expected_release expected_profile_sha authority_id proxy_id image_id
  expected="$(field "$record" authority-image)"
  expected_source="$(field "$record" source-sha)"
  expected_release="$(field "$record" release-id)"
  expected_profile_sha="$(field "$record" runtime-profile-sha256)"
  authority_id="$(running_container_id authority)" || return 1
  proxy_id="$(running_container_id proxy)" || return 1
  [[ "$(docker inspect --format '{{index .Config.Labels "io.echo-brain.release-id"}}' "$authority_id")" == "$expected_release" ]] || return 1
  [[ "$(docker inspect --format '{{index .Config.Labels "io.echo-brain.runtime-profile-sha256"}}' "$authority_id")" == "$expected_profile_sha" ]] || return 1
  [[ "$(docker inspect --format '{{index .Config.Labels "io.echo-brain.release-id"}}' "$proxy_id")" == "$expected_release" ]] || return 1
  [[ "$(docker inspect --format '{{index .Config.Labels "io.echo-brain.runtime-profile-sha256"}}' "$proxy_id")" == "$expected_profile_sha" ]] || return 1
  image_id="$(docker inspect --format '{{.Image}}' "$authority_id")"
  [[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
  # Drain all digests so an early match cannot SIGPIPE docker under pipefail.
  docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image_id" | grep -Fx "$expected" >/dev/null || return 1
  image_source_matches "$image_id" "$expected_source" || return 1
  running_staging_journey_telemetry_identity_matches \
    "$authority_id" "$image_id" "$expected_source"
}

safe_descriptor_check() {
  compose_clean exec -T authority node -e '
    fetch("http://127.0.0.1:39479/v1/authority-descriptor")
      .then(async (response) => {
        if (!response.ok) throw new Error("descriptor HTTP " + response.status);
        const body = await response.json();
        if (body?.authority_descriptor === undefined) throw new Error("descriptor shape");
      })
      .catch((error) => { console.error(error.message); process.exit(1); });
  '
}

safe_setup_status() {
  compose_clean exec -T authority node \
    services/organization-authority/dist/clean-founder-main.js \
    status --state-dir /echo-clean/state | python3 -c '
import json, sys
try:
    raw = sys.stdin.buffer.read(16385)
    status = json.loads(raw)
    if len(raw) > 16384 or not isinstance(status, dict) or status.get("schema_version") != 1 or status.get("kind") != "echo-clean-founder-setup-status-v1" or status.get("runtime_status") != "ready_to_start":
        raise ValueError()
except (ValueError, TypeError):
    raise SystemExit("Authority setup is not ready or returned invalid status")
sys.stdout.buffer.write(raw)
'
}

authority_host() {
  python3 - "$ENV_FILE" <<'PY'
import pathlib, re, stat, sys
path = pathlib.Path(sys.argv[1])
state = path.lstat()
if not stat.S_ISREG(state.st_mode) or stat.S_ISLNK(state.st_mode) or state.st_mode & 0o077:
    raise SystemExit('Authority deployment environment must be a private regular file')
rows = [line for line in path.read_text(encoding='utf-8').splitlines() if line.startswith('ECHO_CLEAN_AUTHORITY_HOST=')]
if len(rows) != 1 or not re.fullmatch(r'[a-z0-9][a-z0-9.-]*[a-z0-9]', rows[0].split('=', 1)[1]):
    raise SystemExit('Authority deployment environment must contain one valid ECHO_CLEAN_AUTHORITY_HOST')
print(rows[0].split('=', 1)[1])
PY
}

safe_public_descriptor_check() {
  local host descriptor_url
  host="$(authority_host)"
  descriptor_url="https://$host/v1/authority-descriptor"
  compose_clean exec -T authority node -e '
const url = process.argv[1];
Promise.all([
  fetch(url, { redirect: "error", signal: AbortSignal.timeout(10_000) }),
  fetch("http://127.0.0.1:39479/v1/authority-descriptor", {
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  }),
])
  .then(async ([publicResponse, localResponse]) => {
    if (!publicResponse.ok || !localResponse.ok) throw new Error("descriptor status");
    const [publicBody, localBody] = await Promise.all([
      publicResponse.text(),
      localResponse.text(),
    ]);
    if (publicBody !== localBody || JSON.parse(publicBody)?.authority_descriptor === undefined)
      throw new Error("descriptor identity");
  })
  .catch(() => process.exit(1));
' "$descriptor_url" >/dev/null 2>&1
}

validate_staging_canary_receipt() {
  local expected_release_id="$1" receipt="$2"
  python3 - "$expected_release_id" "$receipt" <<'PY'
import json, re, sys

expected_release_id, raw = sys.argv[1:]
if len(raw.encode("utf-8")) > 1024:
    raise SystemExit(1)
try:
    receipt = json.loads(raw)
except Exception:
    raise SystemExit(1)
if not isinstance(receipt, dict):
    raise SystemExit(1)
base = {"schema_version", "kind", "release_id", "approval_outcome"}
if (
    receipt.get("schema_version") != 1 or
    receipt.get("kind") != "echo-staging-synthetic-private-dm-canary-receipt-v1" or
    receipt.get("release_id") != expected_release_id or
    receipt.get("approval_outcome") not in {"staged", "delivery_pending", "quarantined", "not_actionable", "not_staged"}
):
    raise SystemExit(1)
if receipt["approval_outcome"] == "not_actionable":
    if set(receipt) != base:
        raise SystemExit(1)
else:
    if set(receipt) != base | {"approval_id"}:
        raise SystemExit(1)
    if not isinstance(receipt["approval_id"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", receipt["approval_id"]):
        raise SystemExit(1)
print(json.dumps(receipt, sort_keys=True, separators=(",", ":")))
PY
}

staging_canary_receipt_path() {
  printf '%s/%s.json\n' "$CANARY_RECEIPT_DIR" "$1"
}

persist_staging_canary_receipt() {
  local release_id="$1" receipt="$2" destination
  destination="$(staging_canary_receipt_path "$release_id")"
  python3 - "$destination" "$receipt" <<'PY'
import os, pathlib, stat, sys

destination, receipt = pathlib.Path(sys.argv[1]), (sys.argv[2] + "\n").encode("utf-8")
parent_state = destination.parent.lstat()
if stat.S_ISLNK(parent_state.st_mode) or not stat.S_ISDIR(parent_state.st_mode):
    raise SystemExit("canary receipt directory is unsafe")
if destination.exists() or destination.is_symlink():
    state = destination.lstat()
    if (
        stat.S_ISLNK(state.st_mode) or
        not stat.S_ISREG(state.st_mode) or
        state.st_mode & 0o077 or
        destination.read_bytes() != receipt
    ):
        raise SystemExit("existing canary receipt is unsafe or does not match")
    raise SystemExit(0)
temporary = destination.parent / ('.' + destination.name + '.' + os.urandom(16).hex())
fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
try:
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "wb") as output:
        output.write(receipt)
        output.flush()
        os.fsync(output.fileno())
    os.link(temporary, destination)
    os.unlink(temporary)
    directory = os.open(destination.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
PY
}

require_staged_canary_receipt() {
  local record="$1" release_id receipt_path receipt normalized outcome
  release_id="$(field "$record" release-id)"
  receipt_path="$(staging_canary_receipt_path "$release_id")"
  receipt="$(python3 - "$receipt_path" <<'PY'
import pathlib, stat, sys

path = pathlib.Path(sys.argv[1])
state = path.lstat()
if stat.S_ISLNK(state.st_mode) or not stat.S_ISREG(state.st_mode) or state.st_mode & 0o077:
    raise SystemExit("candidate canary receipt is unsafe")
data = path.read_bytes()
if len(data) > 1025:
    raise SystemExit("candidate canary receipt is too large")
try:
    print(data.decode("utf-8").rstrip("\n"))
except UnicodeDecodeError:
    raise SystemExit("candidate canary receipt is not UTF-8")
PY
  )" || fail 'routine promotion requires a private-DM canary receipt for the exact staged candidate'
  normalized="$(validate_staging_canary_receipt "$release_id" "$receipt")" || \
    fail 'routine promotion requires a valid private-DM canary receipt for the exact staged candidate'
  outcome="$(python3 - "$normalized" <<'PY'
import json, sys
print(json.loads(sys.argv[1])["approval_outcome"])
PY
  )"
  [[ "$outcome" == staged ]] || \
    fail 'routine promotion requires a staged private-DM canary for the exact candidate'
}

run_staging_private_dm_canary() {
  local record release_id host receipt normalized outcome
  if [[ -f "$CANDIDATE_RECORD" ]]; then
    record="$CANDIDATE_RECORD"
    if [[ -f "$CURRENT_RECORD" ]]; then
      validate "$CURRENT_RECORD"
      accepted_image_can_read_staging_canary_state || \
        fail 'staging canary requires the accepted Authority image to advertise staging-synthetic-meeting-canary rollback-read capability'
    fi
  elif [[ -f "$CURRENT_RECORD" ]]; then
    record="$CURRENT_RECORD"
  else
    fail 'staging canary requires a staged candidate or accepted release'
  fi
  validate "$record"
  active_runtime_profile_matches "$record"
  active_materialized_profile_matches
  active_environment_matches "$record"
  running_exact_release "$record" || \
    fail 'staging canary requires the exact selected release to be running'
  host="$(authority_host)" || fail 'staging canary could not verify the Authority host'
  [[ "$host" == "authority-staging.echobrain.org" ]] || \
    fail 'staging canary is available only on the exact Authority staging host'
  release_id="$(field "$record" release-id)"
  receipt="$(compose_clean exec -T authority node \
    services/organization-authority/dist/clean-live-main.js \
    staging-private-dm-canary --release-id "$release_id")" || \
    fail 'staging canary did not return a receipt'
  normalized="$(validate_staging_canary_receipt "$release_id" "$receipt")" || \
    fail 'staging canary returned an invalid receipt'
  outcome="$(python3 - "$normalized" <<'PY'
import json, sys
print(json.loads(sys.argv[1])["approval_outcome"])
PY
  )"
  case "$outcome" in
    staged)
      persist_staging_canary_receipt "$release_id" "$normalized" || \
        fail 'staging canary receipt could not be persisted safely'
      printf '%s\n' "$normalized"
      ;;
    delivery_pending)
      printf '%s\n' "$normalized"
      fail 'staging canary delivery is still pending; retry the canary command'
      ;;
    quarantined|not_actionable|not_staged)
      printf '%s\n' "$normalized"
      fail "staging canary did not stage a private approval card: $outcome"
      ;;
  esac
}

start_and_check() {
  local record="$1" expected expected_source
  expected="$(field "$record" authority-image)"
  expected_source="$(field "$record" source-sha)"
  compose_clean pull authority || return 1
  image_source_matches "$expected" "$expected_source" || return 1
  compose_clean up -d --no-build --wait --wait-timeout 90 || return 1
  compose_clean restart proxy || return 1
  compose_clean up -d --no-build --wait --wait-timeout 90 authority proxy || return 1
  running_exact_release "$record" || return 1
  safe_descriptor_check || return 1
  safe_setup_status || return 1
  safe_public_descriptor_check
}

# Staging-only, explicitly named conversions. The journal and both state
# directories survive failure. Never run an older image against converted data.
migration_kind() {
  local requested="${1:-}" found='' kind parent operation release_id
  case "$requested" in ''|v5-to-v6|v8-to-v9) ;; *) return 1 ;; esac
  release_id="$(field "$CANDIDATE_RECORD" release-id)" || return 1
  for kind in v5-to-v6 v8-to-v9; do
    parent="$RELEASE_STATE_DIR/state-$kind"
    [[ ! -L "$parent" && ( ! -e "$parent" || -d "$parent" ) ]] || return 1
    operation="$parent/$release_id"
    if [[ -e "$operation" || -L "$operation" ]]; then
      [[ -z "$found" ]] || return 1
      found="$kind"
    fi
  done
  if [[ -n "$requested" ]]; then
    [[ -z "$found" || "$found" == "$requested" ]] || return 1
    printf '%s\n' "$requested"
  else
    printf '%s\n' "${found:-none}"
  fi
}

migration_state() {
  local kind
  kind="$(migration_kind "${2:-}")" || return 1
  case "$1" in
    restore|check|complete|promote)
      [[ "$kind" != none ]] || return 0 ;;
  esac
  python3 - "$1" "$STATE_DIR" "$RELEASE_STATE_DIR" "$CURRENT_RECORD" "$CANDIDATE_RECORD" "$(authority_runtime_identity)" "$kind" <<'ECHO_STATE_MIGRATION_PY'
import hashlib, json, os, pathlib, shutil, stat, sys, uuid

def require(value):
    if not value:
        raise ValueError('migration precondition')

def sync(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try: os.fsync(fd)
    finally: os.close(fd)

def identity(path):
    try: info = path.lstat()
    except FileNotFoundError: return None
    require(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode))
    return [info.st_dev, info.st_ino]

def private(path, directory=False):
    info = path.lstat()
    require((stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)) and info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) == (0o700 if directory else 0o600))
    require(directory or (info.st_nlink == 1 and info.st_size <= 2 * 1024 * 1024))

def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''): result.update(chunk)
    return result.hexdigest()

def inventory(root):
    result, size = {}, 0
    def visit(path):
        nonlocal size
        info = path.lstat()
        require(info.st_uid == uid and info.st_gid == gid and info.st_dev == original[0] and not info.st_mode & 0o022)
        relative = str(path.relative_to(root))
        require(len(result) < 4096 and len(relative.encode()) <= 1024)
        if stat.S_ISDIR(info.st_mode):
            result[relative] = ['directory', stat.S_IMODE(info.st_mode)]
            for child in sorted(path.iterdir()): visit(child)
        else:
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1)
            size += info.st_size
            require(size <= 1024 * 1024 * 1024)
            result[relative] = ['file', stat.S_IMODE(info.st_mode), info.st_size, digest(path)]
    visit(root)
    require('authority.sqlite' in result and result['authority.sqlite'][0] == 'file')
    return result, size

def save():
    temporary = operation / ('.journal-' + str(uuid.uuid4()))
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(journal, stream, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
            stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, journal_path); sync(operation)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)

def move(source, target):
    require(not target.exists() and not target.is_symlink())
    os.rename(source, target); sync(source.parent); sync(target.parent)

try:
    action, raw_state, raw_release, raw_accepted, raw_candidate, runtime_identity, migration = sys.argv[1:]
    require(migration in ('v5-to-v6', 'v8-to-v9'))
    uid, gid = map(int, runtime_identity.split(':'))
    state = pathlib.Path(os.path.abspath(raw_state))
    release = pathlib.Path(raw_release)
    absolute_release = pathlib.Path(os.path.abspath(raw_release))
    require(state.parent == absolute_release.parent and state.name == 'state' and absolute_release.name == 'release')
    require(identity(release) == identity(absolute_release))
    # All existing ancestors must be real directories; the runner pins release.
    for path in (absolute_release, *absolute_release.parents): require(identity(path) is not None)
    private(release, True)
    accepted, candidate = pathlib.Path(raw_accepted), pathlib.Path(raw_candidate)
    private(accepted); private(candidate)
    candidate_record = json.loads(candidate.read_bytes())
    release_id = candidate_record['release_id']
    import re
    require(re.fullmatch(r'clean-v1-[a-z0-9][a-z0-9-]{2,63}', release_id) is not None)
    parent = release / ('state-' + migration)
    operation = parent / release_id
    journal_path = operation / 'journal.json'
    next_state, backup, failed = (operation / name for name in ('next-state', 'accepted-state', 'failed-state'))
    if action != 'prepare' and not operation.exists() and not operation.is_symlink():
        # Ordinary releases have no migration journal.
        require(action in ('restore', 'check', 'complete', 'promote'))
        raise SystemExit(0)
    if action == 'prepare':
        require(not operation.exists() and not operation.is_symlink())
        if not parent.exists(): parent.mkdir(mode=0o700); sync(release)
        private(parent, True)
        original = identity(state)
        require(original is not None and original[0] == release.stat().st_dev)
        entries, size = inventory(state)
        require(len(json.dumps(entries, ensure_ascii=False).encode()) <= 1024 * 1024)
        require(shutil.disk_usage(state).free >= size * 2 + 64 * 1024 * 1024)
        operation.mkdir(mode=0o700); sync(parent)
        next_state.mkdir(mode=0o700); os.chown(next_state, uid, gid); sync(operation)
        journal = {'schema_version': 1, 'kind': 'echo-staging-state-' + migration + '-v1', 'accepted_sha256': digest(accepted), 'candidate_sha256': digest(candidate), 'state': str(state), 'original': original, 'converted': identity(next_state), 'phase': 'copying', 'inventory': entries}
        save()
        # Copy each role, private key, manifest and sidecar. Only the Authority
        # database is rebuilt by the candidate's exact offline copier.
        for relative, entry in entries.items():
            if relative == '.' or relative in ('authority.sqlite', 'authority.sqlite-wal', 'authority.sqlite-shm'): continue
            source, target = state / relative, next_state / relative
            if entry[0] == 'directory':
                target.mkdir(mode=entry[1]); target.chmod(entry[1])
            else:
                with source.open('rb') as src, target.open('xb') as dst:
                    shutil.copyfileobj(src, dst, 1024 * 1024)
                    os.fchmod(dst.fileno(), entry[1]); dst.flush(); os.fsync(dst.fileno())
            os.chown(target, uid, gid)
        for relative, entry in reversed(list(entries.items())):
            if entry[0] == 'directory': sync(next_state / relative)
        require(inventory(state)[0] == entries)
        journal['phase'] = 'copied'; save()
        print(os.path.abspath(next_state))
        raise SystemExit(0)
    private(parent, True); private(operation, True); private(journal_path)
    journal = json.loads(journal_path.read_bytes())
    require(journal['schema_version'] == 1 and journal['kind'] == 'echo-staging-state-' + migration + '-v1' and journal['state'] == str(state) and journal['candidate_sha256'] == digest(candidate))
    promoted = digest(accepted) == digest(candidate)
    require(journal['accepted_sha256'] == digest(accepted) or (promoted and action in ('check', 'promote')))
    original, converted = journal['original'], journal['converted']
    require(original != converted)
    live, old, new, archived = map(identity, (state, backup, next_state, failed))
    if action == 'cutover':
        require(journal['phase'] == 'copied' and live == original and new == converted and old is None and archived is None)
        require(inventory(state)[0] == journal['inventory'])
        # SQLite FULL sync protects DB pages; also persist the new file's final
        # metadata and directory entry before the live-directory rename.
        fd = os.open(next_state / 'authority.sqlite', os.O_RDONLY | os.O_NOFOLLOW)
        try: os.fsync(fd)
        finally: os.close(fd)
        sync(next_state)
        journal['phase'] = 'switching'; save()
        move(state, backup)
        move(next_state, state)
        journal['phase'] = 'switched'; save()
    elif action == 'ready':
        require(journal['phase'] == 'switched' and live == converted and old == original and new is None and archived is None)
        journal['phase'] = 'ready'; save()
    elif action in ('check', 'promote'):
        require(journal['phase'] in ('ready', 'promoted') and live == converted and old == original and new is None and archived is None)
        if action == 'promote':
            require(promoted)
            journal['phase'] = 'promoted'; save()
    elif action == 'restore':
        require(not promoted and journal['phase'] != 'promoted')
        # Recognize both interrupted rename windows by recorded inode identity.
        # Unknown paths or replacements are refused, never removed to proceed.
        require(live in (None, original, converted) and old in (None, original) and new in (None, converted) and archived in (None, converted))
        require(sum(x == original for x in (live, old)) == 1)
        require(sum(x == converted for x in (live, new, archived)) == 1)
        journal['phase'] = 'restoring'; save()
        if live == converted: move(state, failed); live = None
        if new == converted: move(next_state, failed)
        if live is None: move(backup, state)
        require(identity(state) == original and identity(failed) == converted and identity(backup) is None and identity(next_state) is None)
        journal['phase'] = 'restored'; save()
    elif action == 'complete':
        require(journal['phase'] == 'restored' and live == original and archived == converted and old is None and new is None)
        journal['phase'] = 'rolled_back'; save()
    else: require(False)
except SystemExit:
    raise
except Exception:
    raise SystemExit('state migration refused; preserve its journal and state directories')
ECHO_STATE_MIGRATION_PY
}

stage_migrated_state() {
  local next_state image source runtime_identity kind copy_function
  kind="$1"
  case "$kind" in
    v5-to-v6) copy_function=copyAuthorityV5ToV6 ;;
    v8-to-v9) copy_function=copyAuthorityV8ToV9 ;;
    *) return 1 ;;
  esac
  compose_clean down || return 1
  candidate_runtime_is_stopped || return 1
  next_state="$(migration_state prepare "$kind")" || return 1
  image="$(field "$CANDIDATE_RECORD" authority-image)" || return 1
  source="$(field "$CANDIDATE_RECORD" source-sha)" || return 1
  runtime_identity="$(authority_runtime_identity)" || return 1
  docker pull "$image" || return 1
  image_source_matches "$image" "$source" || return 1
  docker run --rm --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges --user "$runtime_identity" --workdir /app \
    --entrypoint node \
    --mount "type=bind,src=$STATE_DIR,dst=/source,readonly" \
    --mount "type=bind,src=$next_state,dst=/candidate" \
    "$image" --input-type=module -e "import Database from 'better-sqlite3'; import { chmodSync, existsSync } from 'node:fs'; import { $copy_function } from './packages/organization-authority-kernel/dist/adapters/persistence/sqlite/authority-$kind.js'; if (existsSync('/candidate/authority.sqlite')) throw new Error('output exists'); const source = new Database('/source/authority.sqlite', { readonly:true, fileMustExist:true }); const target = new Database('/candidate/authority.sqlite'); try { target.pragma('foreign_keys = ON'); target.pragma('synchronous = FULL'); $copy_function(source,target); } finally { target.close(); source.close(); } chmodSync('/candidate/authority.sqlite',0o600);" >/dev/null 2>&1 || return 1
  (STATE_DIR="$next_state"; verify_candidate_state_lineage "$CANDIDATE_RECORD") >/dev/null 2>&1 || return 1
  migration_state cutover
}

restore_accepted() {
  local accepted_record="$1"
  local kind
  kind="$(migration_kind)" || return 1
  if [[ "$kind" != none ]]; then
    compose_clean down || return 1
    candidate_runtime_is_stopped || return 1
    migration_state restore || return 1
  fi
  activate_release_tuple "$accepted_record" || return 1
  start_and_check "$accepted_record" || return 1
  migration_state complete
}

usage() {
  cat >&2 <<'EOF'
usage:
  update-clean-v1.sh stage --release <canonical-release.json> --runtime-profile <canonical-profile.json>
  update-clean-v1.sh stage-v5-to-v6 --release <canonical-release.json> --runtime-profile <canonical-profile.json>
  update-clean-v1.sh stage-v8-to-v9 --release <canonical-release.json> --runtime-profile <canonical-profile.json>
  update-clean-v1.sh canary
  update-clean-v1.sh promote --release <canonical-release.json> --canary-passed
  update-clean-v1.sh rollback
  update-clean-v1.sh status
EOF
  exit 2
}

command="${1:-}"
acquire_operation_lock
trap 'release_operation_lock' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
ensure_state_directories || fail 'Authority release-state directories are missing or unsafe'
if [[ -f "$CANDIDATE_RECORD" ]]; then
  case "$command" in
    canary|promote|status) migration_state check || fail 'migration is incomplete; preserve state and recover through rollback' ;;
  esac
fi
case "$command" in
  stage|stage-v5-to-v6|stage-v8-to-v9)
    [[ "${2:-}" == '--release' && -n "${3:-}" && "${4:-}" == '--runtime-profile' && -n "${5:-}" && $# -eq 5 ]] || usage
    candidate="$(cd "$(dirname "$3")" && pwd -P)/$(basename "$3")"
    supplied_profile="$(cd "$(dirname "$5")" && pwd -P)/$(basename "$5")"
    validate "$candidate"
    verify_runtime_profile "$candidate" "$supplied_profile"
    candidate_id="$(field "$candidate" release-id)"
    release_id_unused "$candidate_id" || fail 'release_id was already used by current, candidate, history, or failed state'
    [[ ! -e "$CANDIDATE_RECORD" ]] || fail 'a candidate is already staged; promote or roll it back first'
    first_deploy=false
    if [[ -f "$CURRENT_RECORD" ]]; then
      validate "$CURRENT_RECORD"
      [[ "$(field "$candidate" baseline-class)" == "$(field "$CURRENT_RECORD" baseline-class)" ]] || fail 'candidate baseline is not compatible with the current release'
      [[ "$(field "$candidate" authority-image)" != "$(field "$CURRENT_RECORD" authority-image)" ]] || fail 'candidate image equals the current release image'
      stored_release_tuple_matches "$CURRENT_RECORD"
      active_runtime_profile_matches "$CURRENT_RECORD"
      active_materialized_profile_matches
      active_environment_matches "$CURRENT_RECORD"
      [[ "$(current_image)" == "$(field "$CURRENT_RECORD" authority-image)" ]] || fail 'environment image does not match the current accepted release record'
      running_exact_release "$CURRENT_RECORD" || fail 'current accepted release is stopped or runtime image drifted'
    else
      first_deploy=true
      if running_container_id authority >/dev/null; then
        fail 'first deployment refuses to replace an unrecorded running Authority'
      fi
    fi
    if [[ "$command" != stage ]]; then
      [[ "$first_deploy" == false && "$(authority_host)" == authority-staging.echobrain.org ]] || fail 'state migration requires an accepted staging host'
      verify_candidate_state_lineage "$CURRENT_RECORD"
    else
      verify_candidate_state_lineage "$candidate"
    fi
    store_release_tuple "$candidate" "$supplied_profile"
    if ! copy_record "$candidate" "$CANDIDATE_RECORD" no-replace; then
      remove_release_tuple "$candidate" || true
      fail 'could not persist the staged candidate release record'
    fi
    if { [[ "$command" == stage ]] || stage_migrated_state "${command#stage-}"; } && activate_release_tuple "$CANDIDATE_RECORD" && start_and_check "$CANDIDATE_RECORD"; then
      if [[ "$command" != stage ]]; then
        migration_state ready || fail 'migration readiness is unconfirmed; retain the candidate and recover through rollback'
      fi
      printf '{"ok":true,"stage":"candidate_ready","accepted_release_present":%s,"next_action":"Run one bounded post-update canary, stop for founder Slack approval and the exact candidate-client record and answer checks, then promote with --canary-passed or run rollback."}\n' "$([[ "$first_deploy" == true ]] && printf false || printf true)"
      exit 0
    fi
    if [[ "$first_deploy" == true ]]; then
      compose_clean down || fail 'first deployment failed and candidate stop could not be confirmed'
      archive_candidate_as_failed || fail 'first deployment candidate was stopped but could not be marked failed; leave it staged and retry rollback'
      fail 'first deployment candidate failed health/setup checks; candidate was stopped and no release was accepted'
    fi
    restore_accepted "$CURRENT_RECORD" || fail 'candidate failed and rollback also failed; candidate remains staged so recovery can be retried'
    archive_candidate_as_failed || fail 'candidate recovery was verified but the candidate could not be marked failed; leave it staged and retry rollback'
    fail 'candidate failed health/setup checks; previous accepted release tuple was restored and verified'
    ;;
  canary)
    [[ $# -eq 1 ]] || usage
    run_staging_private_dm_canary
    ;;
  promote)
    [[ "${2:-}" == '--release' && -n "${3:-}" && "${4:-}" == '--canary-passed' && $# -eq 4 ]] || usage
    candidate="$(cd "$(dirname "$3")" && pwd -P)/$(basename "$3")"
    validate "$candidate"
    [[ -f "$CANDIDATE_RECORD" ]] || fail 'no staged candidate to promote'
    cmp -s "$candidate" "$CANDIDATE_RECORD" || fail 'promotion record does not match the staged candidate'
    require_staged_canary_receipt "$CANDIDATE_RECORD"
    active_runtime_profile_matches "$CANDIDATE_RECORD"
    active_materialized_profile_matches
    active_environment_matches "$CANDIDATE_RECORD"
    running_exact_release "$CANDIDATE_RECORD" || fail 'candidate is stopped or runtime image drifted'
    safe_public_descriptor_check || fail 'candidate public descriptor is unavailable; roll back instead of promoting'
    if [[ -f "$CURRENT_RECORD" ]]; then
      validate "$CURRENT_RECORD"
      if cmp -s "$CURRENT_RECORD" "$CANDIDATE_RECORD"; then
        migration_state promote || fail 'migration promotion journal could not be completed'
        remove_record "$CANDIDATE_RECORD"
        printf '{"ok":true,"stage":"promoted","baseline_compatibility_class":"clean-v1","idempotent":true}\n'
        exit 0
      fi
      [[ "$(field "$candidate" baseline-class)" == "$(field "$CURRENT_RECORD" baseline-class)" ]] || fail 'candidate baseline is not compatible with the current release'
      stored_release_tuple_matches "$CURRENT_RECORD"
      copy_record "$CURRENT_RECORD" "$RELEASE_STATE_DIR/history/$(field "$CURRENT_RECORD" release-id).json" idempotent-immutable
      copy_record "$CANDIDATE_RECORD" "$CURRENT_RECORD" replace
    else
      copy_record "$CANDIDATE_RECORD" "$CURRENT_RECORD" no-replace || fail 'could not accept first deployment candidate'
      remove_record "$CANDIDATE_RECORD"
      printf '{"ok":true,"stage":"promoted","baseline_compatibility_class":"clean-v1","first_deploy":true}\n'
      exit 0
    fi
    migration_state promote || fail 'migration promotion journal could not be completed'
    remove_record "$CANDIDATE_RECORD"
    printf '{"ok":true,"stage":"promoted","baseline_compatibility_class":"clean-v1","first_deploy":false}\n'
    ;;
  rollback)
    [[ $# -eq 1 ]] || usage
    [[ -f "$CANDIDATE_RECORD" ]] || fail 'rollback requires a staged candidate'
    validate "$CANDIDATE_RECORD"
    if [[ ! -e "$CURRENT_RECORD" && ! -L "$CURRENT_RECORD" ]]; then
      if ! abort_first_deploy_candidate; then
        fail 'first deployment candidate is stopped or runtime image drifted; leave it staged and investigate before retrying rollback'
      fi
      printf '{"ok":true,"stage":"aborted","baseline_compatibility_class":"clean-v1","first_deploy":true}\n'
      exit 0
    fi
    [[ -f "$CURRENT_RECORD" ]] || fail 'accepted current release record is unsafe'
    validate "$CURRENT_RECORD"
    if cmp -s "$CURRENT_RECORD" "$CANDIDATE_RECORD"; then
      migration_state promote || fail 'migration promotion journal could not be completed'
      remove_record "$CANDIDATE_RECORD"
      printf '{"ok":true,"stage":"already_promoted","baseline_compatibility_class":"clean-v1"}\n'
      exit 0
    fi
    [[ "$(field "$CURRENT_RECORD" baseline-class)" == "$(field "$CANDIDATE_RECORD" baseline-class)" ]] || fail 'candidate baseline is not compatible with the accepted release'
    stored_release_tuple_matches "$CURRENT_RECORD"
    restore_accepted "$CURRENT_RECORD" || fail 'rollback failed; candidate remains staged and runtime recovery is unconfirmed'
    archive_candidate_as_failed || fail 'rollback recovery was verified but the candidate could not be marked failed; leave it staged and retry rollback'
    printf '{"ok":true,"stage":"rolled_back","baseline_compatibility_class":"clean-v1"}\n'
    ;;
  status)
    [[ $# -eq 1 ]] || usage
    if [[ -f "$CANDIDATE_RECORD" ]]; then
      accepted=false
      if [[ -e "$CURRENT_RECORD" || -L "$CURRENT_RECORD" ]]; then
        validate "$CURRENT_RECORD"
        accepted=true
      fi
      validate "$CANDIDATE_RECORD"
      active_runtime_profile_matches "$CANDIDATE_RECORD"
      active_materialized_profile_matches
      active_environment_matches "$CANDIDATE_RECORD"
      running_exact_release "$CANDIDATE_RECORD" || fail 'candidate is stopped or runtime image drifted'
      printf '{"ok":true,"accepted_release_present":%s,"candidate_staged":true,"runtime_matches_staged_candidate":true}\n' "$accepted"
      exit 0
    fi
    [[ -f "$CURRENT_RECORD" ]] || fail 'no accepted or staged release record is available'
    validate "$CURRENT_RECORD"
    active_runtime_profile_matches "$CURRENT_RECORD"
    active_materialized_profile_matches
    active_environment_matches "$CURRENT_RECORD"
    running_exact_release "$CURRENT_RECORD" || fail 'accepted release is stopped or runtime image drifted'
    printf '{"ok":true,"accepted_release_present":true,"candidate_staged":false,"runtime_matches_accepted":true}\n'
    ;;
  *) usage ;;
esac
