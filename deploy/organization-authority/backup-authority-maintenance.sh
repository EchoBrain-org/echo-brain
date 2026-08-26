#!/usr/bin/env bash
# Coordinate a bounded, current-host Authority outage with an external backup
# coordinator. This script deliberately does not call AWS or any backup API.
set -euo pipefail

DEPLOY_DIR="${ECHO_CLEAN_MAINTENANCE_DEPLOY_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)}"
RELEASE_TOOL="${ECHO_CLEAN_RELEASE_TOOL:-$DEPLOY_DIR/../release/clean-v1-release.py}"
if [[ ! -f "$RELEASE_TOOL" && -f "$DEPLOY_DIR/release/clean-v1-release.py" ]]; then
  RELEASE_TOOL="$DEPLOY_DIR/release/clean-v1-release.py"
fi
RUNTIME_PROFILE_TOOL="${ECHO_CLEAN_RUNTIME_PROFILE_TOOL:-$DEPLOY_DIR/../release/clean-v1-runtime-profile.py}"
if [[ ! -f "$RUNTIME_PROFILE_TOOL" && -f "$DEPLOY_DIR/release/clean-v1-runtime-profile.py" ]]; then
  RUNTIME_PROFILE_TOOL="$DEPLOY_DIR/release/clean-v1-runtime-profile.py"
fi
ENV_FILE="$DEPLOY_DIR/.env.clean-v1"
DATA_DIR="$DEPLOY_DIR/clean-data"
RELEASE_STATE_DIR="$DATA_DIR/release"
CURRENT_RECORD="$RELEASE_STATE_DIR/current.clean-v1.json"
CANDIDATE_RECORD="$RELEASE_STATE_DIR/candidate.clean-v1.json"
RUNTIME_PROFILE_STATE_DIR="$RELEASE_STATE_DIR/runtime-profiles"
ENVIRONMENT_STATE_DIR="$RELEASE_STATE_DIR/runtime-environments"
ACTIVE_RUNTIME_PROFILE="$RELEASE_STATE_DIR/runtime-profile.active"
OPERATION_LOCK_DIR="$DATA_DIR/.authority-operation-lock"
MAINTENANCE_DIR="$DATA_DIR/backup-maintenance"
STATUS_FILE="$MAINTENANCE_DIR/status.json"
OPERATION_LOCK_HELD=false
RESTART_REQUIRED=false
RESTART_PROVED=false
CLEANUP_RUNNING=false
OPERATION_ID=''
COORDINATOR_NONCE=''
MAINTAINER_STARTED_AT_EPOCH_SECONDS="$(date -u +%s)"
ACKNOWLEDGEMENT_DEADLINE_EPOCH_SECONDS=''

fail() { printf 'backup-authority-maintenance: %s\n' "$*" >&2; exit 1; }

usage() {
  cat >&2 <<'EOF'
usage:
  backup-authority-maintenance.sh preflight
  backup-authority-maintenance.sh maintain [--ack-timeout-seconds <1-3600>]
  backup-authority-maintenance.sh acknowledge --operation-id <id> --nonce <nonce>
  backup-authority-maintenance.sh status

Run maintain non-interactively under a transient systemd service so an SSM
command or terminal disconnect cannot kill the transaction, for example:
  systemd-run --unit=echo-authority-backup-maintenance --wait --collect \
    --service-type=exec --property=TimeoutStartSec=3900 \
    --property=TimeoutStopSec=300 \
    /srv/echo-authority-clean-v1/backup-authority-maintenance.sh \
    maintain --ack-timeout-seconds 900

The separate, external backup coordinator must read the emitted operation_id
and coordinator_nonce, finish its own backup action, then invoke acknowledge
with those exact values before the bounded timeout. This script never receives
cloud credentials and never invokes a backup API.
EOF
  exit 2
}

require_regular_file() {
  local path="$1" label="$2" private="${3:-false}"
  [[ -f "$path" && ! -L "$path" ]] || fail "$label is missing or unsafe"
  if [[ "$private" == true ]]; then
    local mode
    mode="$(stat -c '%a' "$path" 2>/dev/null || stat -f '%Lp' "$path")"
    [[ "$mode" =~ ^[0-7]*[0-7][0-7]$ && $(( 8#$mode & 077 )) -eq 0 ]] || \
      fail "$label must be private"
  fi
}

require_directory() {
  local path="$1" label="$2"
  [[ -d "$path" && ! -L "$path" ]] || fail "$label is missing or unsafe"
}

ensure_maintenance_dir() {
  require_directory "$DATA_DIR" 'clean data directory'
  if [[ -e "$MAINTENANCE_DIR" || -L "$MAINTENANCE_DIR" ]]; then
    require_directory "$MAINTENANCE_DIR" 'backup maintenance directory'
  else
    mkdir -m 0700 "$MAINTENANCE_DIR" || fail 'could not create backup maintenance directory'
  fi
  chmod 0700 "$MAINTENANCE_DIR" || fail 'could not secure backup maintenance directory'
}

refuse_unresolved_maintenance_state() {
  [[ -e "$STATUS_FILE" || -L "$STATUS_FILE" ]] || return 0
  if ! python3 - "$STATUS_FILE" <<'PY'
import json, pathlib, stat, sys
try:
    path = pathlib.Path(sys.argv[1])
    status = path.lstat()
    if stat.S_ISLNK(status.st_mode) or not stat.S_ISREG(status.st_mode):
        raise ValueError('unsafe')
    value = json.loads(path.read_text(encoding='utf-8'))
    state = value.get('state')
    if state == 'recovery_required':
        raise RuntimeError('recovery_required')
    if state in ('preflight_complete', 'awaiting_external_ack', 'external_acknowledged', 'ack_timeout', 'restart_proof_failed'):
        raise RuntimeError('unresolved')
except RuntimeError as error:
    if str(error) == 'recovery_required':
        raise SystemExit('a previous backup maintenance restart requires deliberate recovery; do not start another transaction')
    raise SystemExit('a previous backup maintenance transaction is unresolved; recover its lock and runtime before retrying')
except Exception:
    raise SystemExit('backup maintenance status is unavailable or unsafe')
PY
  then
    return 1
  fi
}

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

write_status() {
  local state="$1" reason="${2:-}"
  if ! python3 - "$STATUS_FILE" "$OPERATION_ID" "$COORDINATOR_NONCE" "$state" "$reason" \
    "$ACKNOWLEDGEMENT_DEADLINE_EPOCH_SECONDS" "$$" "$MAINTAINER_STARTED_AT_EPOCH_SECONDS" 2>/dev/null <<'PY'
import json, os, pathlib, stat, sys, tempfile

try:
    path = pathlib.Path(sys.argv[1])
    operation_id, nonce, state, reason = sys.argv[2:6]
    if path.exists():
        status = path.lstat()
        if stat.S_ISLNK(status.st_mode) or not stat.S_ISREG(status.st_mode):
            raise ValueError('unsafe')
    deadline = int(sys.argv[6]) if sys.argv[6] else None
    payload = {
        'schema_version': 1,
        'operation_id': operation_id,
        'coordinator_nonce': nonce,
        'maintainer_pid': int(sys.argv[7]),
        'maintainer_started_at_epoch_seconds': int(sys.argv[8]),
        'acknowledgement_deadline_epoch_seconds': deadline,
        'state': state,
        'reason': reason or None,
    }
    fd, temporary = tempfile.mkstemp(prefix='.status.', dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as output:
            json.dump(payload, output, sort_keys=True, separators=(',', ':'))
            output.write('\n')
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try: os.fsync(directory)
        finally: os.close(directory)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)
except Exception:
    raise SystemExit(1)
PY
  then
    fail 'could not write backup maintenance status'
  fi
}

new_operation_identity() {
  command -v od >/dev/null 2>&1 || fail 'od is required to create a unique maintenance operation identity'
  OPERATION_ID="backup-$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
  COORDINATOR_NONCE="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
  [[ "$OPERATION_ID" =~ ^backup-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{24}$ ]] || fail 'could not create a safe maintenance operation ID'
  [[ "$COORDINATOR_NONCE" =~ ^[0-9a-f]{48}$ ]] || fail 'could not create a safe coordinator nonce'
  [[ ! -e "$MAINTENANCE_DIR/$OPERATION_ID.ack" && ! -L "$MAINTENANCE_DIR/$OPERATION_ID.ack" ]] || \
    fail 'a collision with a prior acknowledgement was detected; retry the maintenance transaction'
}

compose_clean() {
  docker compose --env-file "$ENV_FILE" \
    -f "$DEPLOY_DIR/compose.clean-v1.yaml" \
    -f "$DEPLOY_DIR/compose.clean-v1.ec2.yaml" "$@"
}

field() { python3 "$RELEASE_TOOL" field "$1" "$2"; }
validate_record() { python3 "$RELEASE_TOOL" validate "$1" >/dev/null; }
profile_field() { python3 "$RUNTIME_PROFILE_TOOL" field "$1" "$2"; }

runtime_profile_path() {
  printf '%s/%s.profile\n' "$RUNTIME_PROFILE_STATE_DIR" "$(field "$CURRENT_RECORD" release-id)"
}

environment_snapshot_path() {
  printf '%s/%s.env\n' "$ENVIRONMENT_STATE_DIR" "$(field "$CURRENT_RECORD" release-id)"
}

sha256_file() {
  python3 - "$1" <<'PY'
import hashlib, pathlib, stat, sys
path = pathlib.Path(sys.argv[1])
status = path.lstat()
if stat.S_ISLNK(status.st_mode) or not stat.S_ISREG(status.st_mode):
    raise SystemExit('runtime profile is unsafe')
digest = hashlib.sha256()
with path.open('rb') as source:
    for chunk in iter(lambda: source.read(1024 * 1024), b''):
        digest.update(chunk)
print(digest.hexdigest())
PY
}

env_value() {
  python3 - "$ENV_FILE" "$1" <<'PY'
import pathlib, re, stat, sys
path = pathlib.Path(sys.argv[1])
name = sys.argv[2]
status = path.lstat()
if stat.S_ISLNK(status.st_mode) or not stat.S_ISREG(status.st_mode) or status.st_mode & 0o077:
    raise SystemExit('clean Authority environment must be a private regular file')
values = [line.split('=', 1)[1] for line in path.read_text(encoding='utf-8').splitlines()
          if line.startswith(name + '=')]
if len(values) != 1 or not values[0] or '\n' in values[0] or '\r' in values[0]:
    raise SystemExit('clean Authority environment must contain exactly one ' + name)
print(values[0])
PY
}

verify_runtime_profile() {
  local profile="$1" expected_sha expected_source
  require_regular_file "$profile" 'stored runtime profile' true
  python3 "$RUNTIME_PROFILE_TOOL" validate "$profile" >/dev/null 2>&1 || \
    fail 'stored runtime profile is not canonical clean-v1'
  expected_sha="$(field "$CURRENT_RECORD" runtime-profile-sha256)"
  expected_source="$(field "$CURRENT_RECORD" source-sha)"
  [[ "$(sha256_file "$profile")" == "$expected_sha" ]] || \
    fail 'stored runtime profile SHA-256 does not match the accepted release record'
  [[ "$(profile_field "$profile" source-sha)" == "$expected_source" ]] || \
    fail 'stored runtime profile source SHA does not match the accepted release record'
}

stored_release_tuple_matches() {
  local profile snapshot
  profile="$(runtime_profile_path)"
  snapshot="$(environment_snapshot_path)"
  verify_runtime_profile "$profile"
  require_regular_file "$snapshot" 'release environment snapshot' true
  cmp -s "$ENV_FILE" "$snapshot" || \
    fail 'clean Authority environment drifted from the accepted release snapshot'
}

active_materialized_profile_matches() {
  local stage_parent stage_dir name
  stage_parent="$(mktemp -d "$DEPLOY_DIR/.runtime-profile-check.XXXXXX")" || \
    fail 'could not prepare active runtime profile verification'
  stage_dir="$stage_parent/materialized"
  if ! python3 "$RUNTIME_PROFILE_TOOL" materialize "$ACTIVE_RUNTIME_PROFILE" "$stage_dir" >/dev/null 2>&1; then
    rm -rf "$stage_parent"
    fail 'active runtime profile could not be materialized safely'
  fi
  for name in Caddyfile.clean-v1 Caddyfile.clean-v1.ec2 compose.clean-v1.ec2.yaml compose.clean-v1.yaml; do
    if [[ ! -f "$DEPLOY_DIR/$name" || -L "$DEPLOY_DIR/$name" ]] || ! cmp -s "$stage_dir/$name" "$DEPLOY_DIR/$name"; then
      rm -rf "$stage_parent"
      fail 'deployed runtime profile files drifted from the accepted release materialization'
    fi
  done
  rm -rf "$stage_parent" || fail 'could not remove runtime profile verification workspace'
}

verify_preconditions() {
  command -v docker >/dev/null 2>&1 || fail 'Docker is not installed'
  command -v python3 >/dev/null 2>&1 || fail 'python3 is required'
  [[ -f "$RELEASE_TOOL" && ! -L "$RELEASE_TOOL" ]] || fail 'clean-v1 release validator is missing or unsafe'
  [[ -f "$RUNTIME_PROFILE_TOOL" && ! -L "$RUNTIME_PROFILE_TOOL" ]] || fail 'clean-v1 runtime profile validator is missing or unsafe'
  require_regular_file "$ENV_FILE" 'clean Authority environment' true
  require_regular_file "$DEPLOY_DIR/compose.clean-v1.yaml" 'base Compose profile'
  require_regular_file "$DEPLOY_DIR/compose.clean-v1.ec2.yaml" 'EC2 Compose profile'
  require_regular_file "$CURRENT_RECORD" 'accepted release record' true
  [[ ! -e "$CANDIDATE_RECORD" && ! -L "$CANDIDATE_RECORD" ]] || \
    fail 'a candidate release is staged; promote or roll it back before backup maintenance'
  require_regular_file "$ACTIVE_RUNTIME_PROFILE" 'active runtime profile' true
  validate_record "$CURRENT_RECORD" || fail 'accepted release record is not canonical clean-v1'
  [[ "$(env_value ECHO_CLEAN_AUTHORITY_IMAGE)" == "$(field "$CURRENT_RECORD" authority-image)" ]] || \
    fail 'environment image does not match the accepted release record'
  [[ "$(env_value ECHO_CLEAN_RELEASE_ID)" == "$(field "$CURRENT_RECORD" release-id)" ]] || \
    fail 'environment release ID does not match the accepted release record'
  [[ "$(env_value ECHO_CLEAN_RELEASE_SOURCE_SHA)" == "$(field "$CURRENT_RECORD" source-sha)" ]] || \
    fail 'environment source SHA does not match the accepted release record'
  [[ "$(env_value ECHO_CLEAN_RUNTIME_PROFILE_SHA256)" == "$(field "$CURRENT_RECORD" runtime-profile-sha256)" ]] || \
    fail 'environment runtime profile SHA-256 does not match the accepted release record'
  python3 "$RUNTIME_PROFILE_TOOL" validate "$ACTIVE_RUNTIME_PROFILE" >/dev/null || \
    fail 'active runtime profile is not canonical clean-v1'
  [[ "$(sha256_file "$ACTIVE_RUNTIME_PROFILE")" == "$(field "$CURRENT_RECORD" runtime-profile-sha256)" ]] || \
    fail 'active runtime profile SHA-256 does not match the accepted release record'
  [[ "$(profile_field "$ACTIVE_RUNTIME_PROFILE" source-sha)" == "$(field "$CURRENT_RECORD" source-sha)" ]] || \
    fail 'active runtime profile source SHA does not match the accepted release record'
  stored_release_tuple_matches
  active_materialized_profile_matches
}

running_container_id() {
  local service="$1" id
  id="$(compose_clean ps -q "$service")"
  [[ -n "$id" ]] || return 1
  [[ "$(docker inspect --format '{{.State.Running}}' "$id")" == true ]] || return 1
  printf '%s\n' "$id"
}

running_exact_release() {
  local expected expected_source expected_release expected_profile_sha authority_id proxy_id image_id
  expected="$(field "$CURRENT_RECORD" authority-image)"
  expected_source="$(field "$CURRENT_RECORD" source-sha)"
  expected_release="$(field "$CURRENT_RECORD" release-id)"
  expected_profile_sha="$(field "$CURRENT_RECORD" runtime-profile-sha256)"
  authority_id="$(running_container_id authority)" || return 1
  proxy_id="$(running_container_id proxy)" || return 1
  [[ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$authority_id")" == healthy ]] || return 1
  [[ "$(docker inspect --format '{{index .Config.Labels "io.echo-brain.release-id"}}' "$authority_id")" == "$expected_release" ]] || return 1
  [[ "$(docker inspect --format '{{index .Config.Labels "io.echo-brain.runtime-profile-sha256"}}' "$authority_id")" == "$expected_profile_sha" ]] || return 1
  [[ "$(docker inspect --format '{{index .Config.Labels "io.echo-brain.release-id"}}' "$proxy_id")" == "$expected_release" ]] || return 1
  [[ "$(docker inspect --format '{{index .Config.Labels "io.echo-brain.runtime-profile-sha256"}}' "$proxy_id")" == "$expected_profile_sha" ]] || return 1
  image_id="$(docker inspect --format '{{.Image}}' "$authority_id")"
  [[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
  docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image_id" | grep -Fqx "$expected" || return 1
  [[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_id")" == "$expected_source" ]]
}

require_complete_onboarding() {
  local status_json next_step
  status_json="$(compose_clean exec -T authority node services/organization-authority/dist/clean-founder-main.js status --state-dir /echo-clean/state)" || \
    fail 'could not read onboarding status from the healthy Authority'
  next_step="$(python3 -c 'import json,sys; value=json.load(sys.stdin); step=value.get("next_step"); assert isinstance(step,str); print(step)' <<<"$status_json")" || \
    fail 'Authority onboarding status was not the expected safe JSON'
  [[ "$next_step" == complete ]] || fail 'Authority onboarding is active; complete or recover it before backup maintenance'
}

safe_local_descriptor_check() {
  compose_clean exec -T authority node -e '
fetch("http://127.0.0.1:39479/v1/authority-descriptor", { signal: AbortSignal.timeout(10_000) })
  .then(async (response) => {
    if (!response.ok || (await response.json())?.authority_descriptor === undefined)
      throw new Error("local descriptor");
  })
  .catch(() => process.exit(1));
'
}

safe_public_descriptor_check() {
  local host descriptor_url
  host="$(env_value ECHO_CLEAN_AUTHORITY_HOST)"
  [[ "$host" =~ ^[a-z0-9][a-z0-9.-]*[a-z0-9]$ ]] || fail 'clean Authority host is invalid'
  descriptor_url="https://$host/v1/authority-descriptor"
  compose_clean exec -T authority node -e '
const url = process.argv[1];
Promise.all([
  fetch(url, { redirect: "error", signal: AbortSignal.timeout(10_000) }),
  fetch("http://127.0.0.1:39479/v1/authority-descriptor", { redirect: "error", signal: AbortSignal.timeout(10_000) }),
])
  .then(async ([publicResponse, localResponse]) => {
    if (!publicResponse.ok || !localResponse.ok) throw new Error("descriptor status");
    const [publicBody, localBody] = await Promise.all([publicResponse.text(), localResponse.text()]);
    if (publicBody !== localBody || JSON.parse(publicBody)?.authority_descriptor === undefined)
      throw new Error("descriptor identity");
  })
  .catch(() => process.exit(1));
' "$descriptor_url" >/dev/null 2>&1
}

verify_running_release() {
  running_exact_release || return 1
  safe_local_descriptor_check || return 1
  safe_public_descriptor_check
}

preflight() {
  [[ $# -eq 0 ]] || usage
  ensure_maintenance_dir
  refuse_unresolved_maintenance_state
  acquire_operation_lock
  trap 'release_operation_lock' EXIT
  verify_preconditions
  verify_running_release || fail 'Authority is not healthy on the exact accepted tuple with matching local and public descriptors'
  require_complete_onboarding
  release_operation_lock
  trap - EXIT
  printf 'maintenance_preflight_ready=true\n'
}

verify_services_absent() {
  [[ -z "$(compose_clean ps -aq authority)" ]] || return 1
  [[ -z "$(compose_clean ps -aq proxy)" ]]
}

restart_and_prove() {
  # --pull never is intentional: recovery must use only the already verified image.
  compose_clean up -d --no-build --pull never --wait --wait-timeout 90 authority proxy || return 1
  compose_clean restart proxy || return 1
  compose_clean up -d --no-build --pull never --wait --wait-timeout 90 authority proxy || return 1
  verify_running_release
}

ack_path() { printf '%s/%s.ack\n' "$MAINTENANCE_DIR" "$OPERATION_ID"; }

acknowledgement_is_current() {
  local path
  path="$(ack_path)"
  [[ -f "$path" && ! -L "$path" ]] || return 1
  python3 - "$path" "$OPERATION_ID" "$COORDINATOR_NONCE" 2>/dev/null <<'PY'
import pathlib, stat, sys
try:
    path = pathlib.Path(sys.argv[1])
    status = path.lstat()
    if stat.S_ISLNK(status.st_mode) or not stat.S_ISREG(status.st_mode) or status.st_mode & 0o077:
        raise ValueError('unsafe')
    expected = 'operation_id=' + sys.argv[2] + '\ncoordinator_nonce=' + sys.argv[3] + '\n'
    if path.read_text(encoding='utf-8') != expected:
        raise ValueError('mismatch')
except Exception:
    raise SystemExit(1)
PY
}

wait_for_acknowledgement() {
  local now
  while true; do
    now="$(date -u +%s)"
    [[ "$now" =~ ^[0-9]+$ ]] || return 1
    (( now < ACKNOWLEDGEMENT_DEADLINE_EPOCH_SECONDS )) || return 1
    if acknowledgement_is_current; then
      write_status 'external_acknowledged'
      return 0
    fi
    sleep 1
  done
}

complete_or_recover_on_exit() {
  local original_status="${1:-1}" restart_status=0
  if [[ "$CLEANUP_RUNNING" == true ]]; then return; fi
  CLEANUP_RUNNING=true
  trap - EXIT HUP INT TERM
  if [[ "$RESTART_REQUIRED" == true && "$RESTART_PROVED" != true ]]; then
    if restart_and_prove; then
      RESTART_PROVED=true
      write_status 'recovered_after_interruption' "exit_status=$original_status" || restart_status=1
    else
      write_status 'recovery_required' "restart_proof_failed_after_exit_status=$original_status" || true
      # Preserve the shared lock as an explicit fail-closed recovery marker.
      OPERATION_LOCK_HELD=false
      exit 1
    fi
  fi
  release_operation_lock
  if (( restart_status != 0 )); then
    exit "$restart_status"
  fi
  exit "$original_status"
}

signal_exit() { exit "$1"; }

maintain() {
  local timeout_seconds=900
  if [[ $# -eq 2 && "$1" == --ack-timeout-seconds ]]; then
    timeout_seconds="$2"
  elif [[ $# -ne 0 ]]; then
    usage
  fi
  [[ "$timeout_seconds" =~ ^[0-9]+$ ]] && (( timeout_seconds >= 1 && timeout_seconds <= 3600 )) || \
    fail 'ack timeout must be an integer from 1 through 3600 seconds'

  ensure_maintenance_dir
  refuse_unresolved_maintenance_state
  acquire_operation_lock
  trap 'complete_or_recover_on_exit "$?"' EXIT
  trap 'signal_exit 129' HUP
  trap 'signal_exit 130' INT
  trap 'signal_exit 143' TERM
  verify_preconditions
  verify_running_release || fail 'Authority is not healthy on the exact accepted tuple with matching local and public descriptors'
  require_complete_onboarding
  new_operation_identity
  write_status 'preflight_complete'
  # Set this before requesting the stop: a failed/interrupted down can be partial.
  RESTART_REQUIRED=true
  compose_clean down --remove-orphans || fail 'could not stop and remove the Authority and proxy for backup maintenance'
  verify_services_absent || fail 'Authority or proxy remains present after the maintenance stop'
  sync
  local acknowledgement_started_at
  acknowledgement_started_at="$(date -u +%s)"
  [[ "$acknowledgement_started_at" =~ ^[0-9]+$ ]] || fail 'could not establish the external acknowledgement deadline'
  ACKNOWLEDGEMENT_DEADLINE_EPOCH_SECONDS=$((acknowledgement_started_at + timeout_seconds))
  write_status 'awaiting_external_ack'
  printf 'operation_id=%s\ncoordinator_nonce=%s\nacknowledgement_deadline_epoch_seconds=%s\nack_path=%s\n' \
    "$OPERATION_ID" "$COORDINATOR_NONCE" "$ACKNOWLEDGEMENT_DEADLINE_EPOCH_SECONDS" "$(ack_path)"
  if ! wait_for_acknowledgement "$timeout_seconds"; then
    write_status 'ack_timeout'
    fail 'external backup coordinator acknowledgement did not arrive before the bounded timeout'
  fi
  if ! restart_and_prove; then
    write_status 'restart_proof_failed'
    fail 'Authority restart proof failed after external backup acknowledgement'
  fi
  RESTART_PROVED=true
  write_status 'complete'
  printf 'maintenance_complete=true\noperation_id=%s\n' "$OPERATION_ID"
}

acknowledge() {
  [[ $# -eq 4 && "$1" == --operation-id && "$3" == --nonce ]] || usage
  local operation_id="$2" nonce="$4"
  [[ "$operation_id" =~ ^backup-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{24}$ ]] || fail 'operation ID is invalid'
  [[ "$nonce" =~ ^[0-9a-f]{48}$ ]] || fail 'coordinator nonce is invalid'
  ensure_maintenance_dir
  if ! python3 - "$STATUS_FILE" "$MAINTENANCE_DIR/$operation_id.ack" "$operation_id" "$nonce" <<'PY'
import json, os, pathlib, stat, sys, time
try:
    status_path, ack_path = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
    operation_id, nonce = sys.argv[3:]
    status = status_path.lstat()
    if stat.S_ISLNK(status.st_mode) or not stat.S_ISREG(status.st_mode):
        raise ValueError('unavailable')
    payload = json.loads(status_path.read_text(encoding='utf-8'))
    if (payload.get('schema_version') != 1 or payload.get('state') != 'awaiting_external_ack' or
            payload.get('operation_id') != operation_id or payload.get('coordinator_nonce') != nonce):
        raise ValueError('mismatch')
    deadline = payload.get('acknowledgement_deadline_epoch_seconds')
    maintainer_pid = payload.get('maintainer_pid')
    maintainer_started = payload.get('maintainer_started_at_epoch_seconds')
    if (type(deadline) is not int or type(maintainer_pid) is not int or maintainer_pid <= 0 or
            type(maintainer_started) is not int or maintainer_started <= 0):
        raise ValueError('unavailable')
    if int(time.time()) >= deadline:
        raise ValueError('late')
    try:
        fd = os.open(ack_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        raise ValueError('exists')
    try:
        os.write(fd, ('operation_id=' + operation_id + '\ncoordinator_nonce=' + nonce + '\n').encode())
        os.fsync(fd)
    finally:
        os.close(fd)
    directory = os.open(ack_path.parent, os.O_RDONLY)
    try: os.fsync(directory)
    finally: os.close(directory)
except ValueError as error:
    if str(error) == 'mismatch':
        raise SystemExit('acknowledgement does not match the current waiting operation')
    if str(error) == 'exists':
        raise SystemExit('acknowledgement already exists for this operation')
    if str(error) == 'late':
        raise SystemExit('acknowledgement deadline has passed for this operation')
    raise SystemExit('backup maintenance acknowledgement is unavailable or unsafe')
except Exception:
    raise SystemExit('backup maintenance acknowledgement is unavailable or unsafe')
PY
  then
    fail 'could not record external backup coordinator acknowledgement'
  fi
  printf 'acknowledged_operation_id=%s\n' "$operation_id"
}

status() {
  ensure_maintenance_dir
  [[ -f "$STATUS_FILE" && ! -L "$STATUS_FILE" ]] || fail 'no backup maintenance status exists'
  cat "$STATUS_FILE"
}

case "${1:-}" in
  preflight) shift; preflight "$@" ;;
  maintain) shift; maintain "$@" ;;
  acknowledge) shift; acknowledge "$@" ;;
  status) [[ $# -eq 1 ]] || usage; status ;;
  *) usage ;;
esac
