#!/usr/bin/env bash
# Exact-image clean-v1 release staging. It never runs a schema migration.
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
OPERATION_LOCK_HELD=false

fail() { printf '%s\n' "$*" >&2; exit 1; }

release_operation_lock() {
  if [[ "$OPERATION_LOCK_HELD" == true ]]; then
    rm -f "$OPERATION_LOCK_DIR/owner-pid" >/dev/null 2>&1 || true
    rmdir "$OPERATION_LOCK_DIR" >/dev/null 2>&1 || true
    OPERATION_LOCK_HELD=false
  fi
}

acquire_operation_lock() {
  if ! mkdir -m 0700 "$OPERATION_LOCK_DIR" 2>/dev/null; then
    fail 'another Authority activation or release operation is already in progress; follow the README operation-lock recovery steps if its owner was interrupted'
  fi
  OPERATION_LOCK_HELD=true
  if ! (umask 077; printf '%s\n' "$$" > "$OPERATION_LOCK_DIR/owner-pid"); then
    release_operation_lock
    fail 'could not record the Authority operation lock owner'
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
    "$image" --input-type=module -e 'import { verifyAuthorityStateLineage } from "./services/organization-authority/dist/composition/verify-authority-state-lineage.js"; verifyAuthorityStateLineage("/echo-clean/state");' || \
    fail 'candidate Authority image rejected persisted state lineage; run an explicit replacement or migration procedure instead'
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
import os, pathlib, stat, sys, tempfile

source, destination = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
image, release_id, source_sha, profile_sha, profile_version = sys.argv[3:]
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
fd, temporary = tempfile.mkstemp(prefix='.' + destination.name + '.', dir=destination.parent)
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
import os, pathlib, stat, sys, tempfile

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
    fd, temporary = tempfile.mkstemp(prefix='.' + destination.name + '.', dir=destination.parent)
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
import os, pathlib, stat, sys, tempfile
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
fd, temporary = tempfile.mkstemp(prefix='.' + destination.name + '.', dir=destination.parent)
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

image_source_matches() {
  local image="$1" expected_source="$2"
  [[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" == "$expected_source" ]]
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
  docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image_id" | grep -Fqx "$expected" || return 1
  image_source_matches "$image_id" "$expected_source"
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
    status --state-dir /echo-clean/state
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
    receipt.get("approval_outcome") not in {"staged", "delivery_pending", "not_actionable", "not_staged"}
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
import os, pathlib, stat, sys, tempfile

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
fd, temporary = tempfile.mkstemp(prefix="." + destination.name + ".", dir=destination.parent)
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
    not_actionable|not_staged)
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

restore_accepted() {
  local accepted_record="$1"
  activate_release_tuple "$accepted_record" || return 1
  start_and_check "$accepted_record"
}

usage() {
  cat >&2 <<'EOF'
usage:
  update-clean-v1.sh stage --release <canonical-release.json> --runtime-profile <canonical-profile.json>
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
case "$command" in
  stage)
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
    verify_candidate_state_lineage "$candidate"
    store_release_tuple "$candidate" "$supplied_profile"
    if ! copy_record "$candidate" "$CANDIDATE_RECORD" no-replace; then
      remove_release_tuple "$candidate" || true
      fail 'could not persist the staged candidate release record'
    fi
    if activate_release_tuple "$CANDIDATE_RECORD" && start_and_check "$CANDIDATE_RECORD"; then
      printf '{"ok":true,"stage":"candidate_ready","accepted_release_present":%s,"next_action":"Run one bounded post-update canary, then promote with --canary-passed or run rollback."}\n' "$([[ "$first_deploy" == true ]] && printf false || printf true)"
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
