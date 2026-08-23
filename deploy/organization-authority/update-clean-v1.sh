#!/usr/bin/env bash
# Exact-image clean-v1 release staging. It never runs a schema migration.
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
RELEASE_TOOL="${ECHO_CLEAN_RELEASE_TOOL:-$DEPLOY_DIR/release/clean-v1-release.py}"
if [[ ! -f "$RELEASE_TOOL" && -f "$DEPLOY_DIR/../release/clean-v1-release.py" ]]; then
  RELEASE_TOOL="$DEPLOY_DIR/../release/clean-v1-release.py"
fi
ENV_FILE="${ECHO_CLEAN_ENV_FILE:-$DEPLOY_DIR/.env.clean-v1}"
RELEASE_STATE_DIR="${ECHO_CLEAN_RELEASE_STATE_DIR:-$DEPLOY_DIR/clean-data/release}"
CURRENT_RECORD="$RELEASE_STATE_DIR/current.clean-v1.json"
CANDIDATE_RECORD="$RELEASE_STATE_DIR/candidate.clean-v1.json"

fail() { printf '%s\n' "$*" >&2; exit 1; }
[[ -x /usr/bin/python3 || -x "$(command -v python3)" ]] || fail 'python3 is required'
[[ -f "$RELEASE_TOOL" ]] || fail 'clean-v1 release validator is missing'
[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || fail 'clean Authority environment file is missing or unsafe'

compose_clean() {
  docker compose --env-file "$ENV_FILE" \
    -f "$DEPLOY_DIR/compose.clean-v1.yaml" \
    -f "$DEPLOY_DIR/compose.clean-v1.ec2.yaml" "$@"
}

field() { python3 "$RELEASE_TOOL" field "$1" "$2"; }
validate() { python3 "$RELEASE_TOOL" validate "$1" >/dev/null; }

current_image() {
  python3 - "$ENV_FILE" <<'PY'
import pathlib, re, stat, sys
path = pathlib.Path(sys.argv[1])
state = path.stat()
if stat.S_ISLNK(state.st_mode) or not stat.S_ISREG(state.st_mode) or state.st_mode & 0o077:
    raise SystemExit('clean Authority environment must be a private regular file')
rows = [line for line in path.read_text(encoding='utf-8').splitlines() if line.startswith('ECHO_CLEAN_AUTHORITY_IMAGE=')]
if len(rows) != 1:
    raise SystemExit('clean Authority environment must contain exactly one ECHO_CLEAN_AUTHORITY_IMAGE')
value = rows[0].split('=', 1)[1]
if not re.fullmatch(r'[a-z0-9][a-z0-9.-]*(?:/[a-z0-9][a-z0-9._-]*)+@sha256:[0-9a-f]{64}', value):
    raise SystemExit('clean Authority image is not an immutable digest reference')
print(value)
PY
}

replace_image() {
  python3 - "$ENV_FILE" "$1" <<'PY'
import os, pathlib, re, stat, sys, tempfile
path, image = pathlib.Path(sys.argv[1]), sys.argv[2]
if not re.fullmatch(r'[a-z0-9][a-z0-9.-]*(?:/[a-z0-9][a-z0-9._-]*)+@sha256:[0-9a-f]{64}', image):
    raise SystemExit('replacement image is not an immutable digest reference')
state = path.stat()
if stat.S_ISLNK(state.st_mode) or not stat.S_ISREG(state.st_mode) or state.st_mode & 0o077:
    raise SystemExit('clean Authority environment must be a private regular file')
lines = path.read_text(encoding='utf-8').splitlines()
if sum(line.startswith('ECHO_CLEAN_AUTHORITY_IMAGE=') for line in lines) != 1:
    raise SystemExit('clean Authority environment must contain exactly one ECHO_CLEAN_AUTHORITY_IMAGE')
payload = '\n'.join(('ECHO_CLEAN_AUTHORITY_IMAGE=' + image) if line.startswith('ECHO_CLEAN_AUTHORITY_IMAGE=') else line for line in lines) + '\n'
fd, temporary = tempfile.mkstemp(prefix='.env.clean-v1.', dir=path.parent)
try:
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as output:
        output.write(payload); output.flush(); os.fsync(output.fileno())
    os.replace(temporary, path)
    directory = os.open(path.parent, os.O_RDONLY)
    try: os.fsync(directory)
    finally: os.close(directory)
finally:
    if os.path.exists(temporary): os.unlink(temporary)
PY
}

copy_record() {
  local source="$1" destination="$2" mode="$3"
  python3 - "$source" "$destination" "$mode" <<'PY'
import os, pathlib, sys, tempfile
source, destination, mode = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3]
destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
os.chmod(destination.parent, 0o700)
data = source.read_bytes()
if mode == 'no-replace' and destination.exists():
    raise SystemExit('release record destination already exists')
fd, temporary = tempfile.mkstemp(prefix='.' + destination.name + '.', dir=destination.parent)
try:
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, 'wb') as output:
        output.write(data); output.flush(); os.fsync(output.fileno())
    if mode == 'no-replace':
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
  copy_record "$CANDIDATE_RECORD" "$RELEASE_STATE_DIR/failed/$id.json" no-replace || return 1
  remove_record "$CANDIDATE_RECORD"
}

release_id_unused() {
  local id="$1"
  [[ ! -e "$RELEASE_STATE_DIR/history/$id.json" && ! -e "$RELEASE_STATE_DIR/failed/$id.json" ]] || return 1
  if [[ -f "$CURRENT_RECORD" ]] && [[ "$(field "$CURRENT_RECORD" release-id)" == "$id" ]]; then return 1; fi
  if [[ -f "$CANDIDATE_RECORD" ]] && [[ "$(field "$CANDIDATE_RECORD" release-id)" == "$id" ]]; then return 1; fi
}

running_container_id() {
  local id
  id="$(compose_clean ps -q authority)"
  [[ -n "$id" ]] || return 1
  [[ "$(docker inspect --format '{{.State.Running}}' "$id")" == true ]] || return 1
  printf '%s\n' "$id"
}

image_source_matches() {
  local image="$1" expected_source="$2"
  [[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" == "$expected_source" ]]
}

running_exact_release() {
  local record="$1" expected expected_source id image_id
  expected="$(field "$record" authority-image)"
  expected_source="$(field "$record" source-sha)"
  id="$(running_container_id)" || return 1
  image_id="$(docker inspect --format '{{.Image}}' "$id")"
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

start_and_check() {
  local record="$1" expected expected_source
  expected="$(field "$record" authority-image)"
  expected_source="$(field "$record" source-sha)"
  compose_clean pull authority || return 1
  image_source_matches "$expected" "$expected_source" || return 1
  compose_clean up -d --no-build --wait --wait-timeout 90 || return 1
  running_exact_release "$record" || return 1
  safe_descriptor_check || return 1
  safe_setup_status || return 1
}

restore_accepted() {
  local accepted_record="$1"
  replace_image "$(field "$accepted_record" authority-image)" || return 1
  start_and_check "$accepted_record"
}

usage() {
  cat >&2 <<'EOF'
usage:
  update-clean-v1.sh stage --release <canonical-release.json>
  update-clean-v1.sh promote --release <canonical-release.json> --canary-passed
  update-clean-v1.sh rollback
  update-clean-v1.sh status
EOF
  exit 2
}

command="${1:-}"
case "$command" in
  stage)
    [[ "${2:-}" == '--release' && -n "${3:-}" && $# -eq 3 ]] || usage
    candidate="$(cd "$(dirname "$3")" && pwd -P)/$(basename "$3")"
    validate "$candidate"
    candidate_id="$(field "$candidate" release-id)"
    release_id_unused "$candidate_id" || fail 'release_id was already used by current, candidate, history, or failed state'
    [[ ! -e "$CANDIDATE_RECORD" ]] || fail 'a candidate is already staged; promote or roll it back first'
    first_deploy=false
    if [[ -f "$CURRENT_RECORD" ]]; then
      validate "$CURRENT_RECORD"
      [[ "$(field "$candidate" baseline-class)" == "$(field "$CURRENT_RECORD" baseline-class)" ]] || fail 'candidate baseline is not compatible with the current release'
      [[ "$(field "$candidate" authority-image)" != "$(field "$CURRENT_RECORD" authority-image)" ]] || fail 'candidate image equals the current release image'
      [[ "$(current_image)" == "$(field "$CURRENT_RECORD" authority-image)" ]] || fail 'environment image does not match the current accepted release record'
      running_exact_release "$CURRENT_RECORD" || fail 'current accepted release is stopped, source-unbound, or runtime image drifted'
      previous_image="$(field "$CURRENT_RECORD" authority-image)"
    else
      first_deploy=true
      if running_container_id >/dev/null; then
        fail 'first deployment refuses to replace an unrecorded running Authority'
      fi
    fi
    copy_record "$candidate" "$CANDIDATE_RECORD" no-replace
    if replace_image "$(field "$candidate" authority-image)" && start_and_check "$CANDIDATE_RECORD"; then
      printf '{"ok":true,"stage":"candidate_ready","accepted_release_present":%s,"next_action":"Run one bounded post-update canary, then promote with --canary-passed or run rollback."}\n' "$([[ "$first_deploy" == true ]] && printf false || printf true)"
      exit 0
    fi
    if [[ "$first_deploy" == true ]]; then
      archive_candidate_as_failed || fail 'first deployment candidate failed and could not be marked failed; do not continue automatically'
      compose_clean down || fail 'first deployment failed and candidate stop could not be confirmed'
      fail 'first deployment candidate failed health/setup checks; candidate was stopped and no release was accepted'
    fi
    restore_accepted "$CURRENT_RECORD" || fail 'candidate failed and rollback also failed; candidate remains staged so recovery can be retried'
    archive_candidate_as_failed || fail 'candidate recovery was verified but the candidate could not be marked failed; leave it staged and retry rollback'
    fail 'candidate failed health/setup checks; previous compatible image was restored and verified'
    ;;
  promote)
    [[ "${2:-}" == '--release' && -n "${3:-}" && "${4:-}" == '--canary-passed' && $# -eq 4 ]] || usage
    candidate="$(cd "$(dirname "$3")" && pwd -P)/$(basename "$3")"
    validate "$candidate"
    [[ -f "$CANDIDATE_RECORD" ]] || fail 'no staged candidate to promote'
    cmp -s "$candidate" "$CANDIDATE_RECORD" || fail 'promotion record does not match the staged candidate'
    running_exact_release "$CANDIDATE_RECORD" || fail 'candidate is stopped, source-unbound, or runtime image drifted'
    if [[ -f "$CURRENT_RECORD" ]]; then
      validate "$CURRENT_RECORD"
      if cmp -s "$CURRENT_RECORD" "$CANDIDATE_RECORD"; then
        remove_record "$CANDIDATE_RECORD"
        printf '{"ok":true,"stage":"promoted","baseline_compatibility_class":"clean-v1","idempotent":true}\n'
        exit 0
      fi
      [[ "$(field "$candidate" baseline-class)" == "$(field "$CURRENT_RECORD" baseline-class)" ]] || fail 'candidate baseline is not compatible with the current release'
      copy_record "$CURRENT_RECORD" "$RELEASE_STATE_DIR/history/$(field "$CURRENT_RECORD" release-id).json" no-replace
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
    [[ -f "$CURRENT_RECORD" && -f "$CANDIDATE_RECORD" ]] || fail 'rollback requires an accepted current release and a staged candidate'
    validate "$CURRENT_RECORD"; validate "$CANDIDATE_RECORD"
    if cmp -s "$CURRENT_RECORD" "$CANDIDATE_RECORD"; then
      remove_record "$CANDIDATE_RECORD"
      printf '{"ok":true,"stage":"already_promoted","baseline_compatibility_class":"clean-v1"}\n'
      exit 0
    fi
    [[ "$(field "$CURRENT_RECORD" baseline-class)" == "$(field "$CANDIDATE_RECORD" baseline-class)" ]] || fail 'candidate baseline is not compatible with the accepted release'
    restore_accepted "$CURRENT_RECORD" || fail 'rollback failed; candidate remains staged and runtime recovery is unconfirmed'
    archive_candidate_as_failed || fail 'rollback recovery was verified but the candidate could not be marked failed; leave it staged and retry rollback'
    printf '{"ok":true,"stage":"rolled_back","baseline_compatibility_class":"clean-v1"}\n'
    ;;
  status)
    [[ $# -eq 1 ]] || usage
    if [[ -f "$CANDIDATE_RECORD" ]]; then
      validate "$CANDIDATE_RECORD"
      accepted=false
      if [[ -e "$CURRENT_RECORD" || -L "$CURRENT_RECORD" ]]; then
        validate "$CURRENT_RECORD"
        accepted=true
      fi
      running_exact_release "$CANDIDATE_RECORD" || fail 'candidate is stopped, source-unbound, or runtime image drifted'
      printf '{"ok":true,"accepted_release_present":%s,"candidate_staged":true,"runtime_matches_staged_candidate":true}\n' "$accepted"
      exit 0
    fi
    [[ -f "$CURRENT_RECORD" ]] || fail 'no accepted or staged release record is available'
    validate "$CURRENT_RECORD"
    running_exact_release "$CURRENT_RECORD" || fail 'accepted release is stopped, source-unbound, or runtime image drifted'
    printf '{"ok":true,"accepted_release_present":true,"candidate_staged":false,"runtime_matches_accepted":true}\n'
    ;;
  *) usage ;;
esac
