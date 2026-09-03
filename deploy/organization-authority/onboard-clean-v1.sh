#!/usr/bin/env bash
# One-time clean-v1 Authority preparation plus resumable initial-owner onboarding.
# This wrapper deliberately owns the two EC2 Compose profiles and only the
# fixed clean-data paths below. It never reads Authority SQLite files.
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DATA_DIR="$DEPLOY_DIR/clean-data"
PRIVATE_DIR="$DATA_DIR/private"
RELEASE_DIR="$DATA_DIR/release"
ENV_FILE="$DEPLOY_DIR/.env.clean-v1"
SETUP_FILE="$PRIVATE_DIR/onboard-clean-v1.conf"
RELEASE_FILE="$RELEASE_DIR/current.clean-v1.json"
CANDIDATE_FILE="$RELEASE_DIR/candidate.clean-v1.json"
RUNTIME_PROFILES_DIR="$RELEASE_DIR/runtime-profiles"
RUNTIME_ENVIRONMENTS_DIR="$RELEASE_DIR/runtime-environments"
ACTIVE_RUNTIME_PROFILE_FILE="$RELEASE_DIR/runtime-profile.active"
OPERATION_LOCK_DIR="$DATA_DIR/.authority-operation-lock"
RELEASE_TOOL="$DEPLOY_DIR/../release/clean-v1-release.py"
if [[ -f "$DEPLOY_DIR/release/clean-v1-release.py" ]]; then
  RELEASE_TOOL="$DEPLOY_DIR/release/clean-v1-release.py"
fi
RUNTIME_PROFILE_TOOL="$DEPLOY_DIR/../release/clean-v1-runtime-profile.py"
if [[ -f "$DEPLOY_DIR/release/clean-v1-runtime-profile.py" ]]; then
  RUNTIME_PROFILE_TOOL="$DEPLOY_DIR/release/clean-v1-runtime-profile.py"
fi
SETUP_COMMAND="services/organization-authority/dist/clean-founder-main.js"
RUNTIME_UID=''
RUNTIME_GID=''
EXECUTOR_UID=''
ACTIVATION_GRANOLA_SOURCE_BACKUP=''
ACTIVATION_LLM_SOURCE_BACKUP=''
ACTIVATION_GRANOLA_ACTIVE_BACKUP=''
ACTIVATION_LLM_ACTIVE_BACKUP=''
ACTIVATION_ROLLBACK_FAILURE_STAGE=''
ACTIVATION_CHILD_PID=''
OPERATION_LOCK_HELD=false
REHEARSAL_ARCHIVE=''
REHEARSAL_ARCHIVED_DATA=''
REHEARSAL_ROLLBACK_ARMED=false
REHEARSAL_RUNTIME_STOPPED=false
REHEARSAL_DATA_MUTATED=false

fail() { printf 'onboard-clean-v1: %s\n' "$*" >&2; exit 1; }

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

usage() {
  cat >&2 <<'EOF'
usage:
  onboard-clean-v1.sh doctor --input-dir <absolute-private-input-directory>
  onboard-clean-v1.sh prepare --input-dir <absolute-private-input-directory>
  onboard-clean-v1.sh activate-provider-credentials --input-dir <absolute-private-provider-directory>
  onboard-clean-v1.sh replace-rehearsal --confirm-no-live-users
  onboard-clean-v1.sh resume
  onboard-clean-v1.sh status
EOF
  exit 2
}

INPUT_MANIFEST_NAME='onboarding.clean-v1.json'
INPUT_RELEASE_NAME='release.json'
INPUT_RUNTIME_PROFILE_NAME='runtime-profile.json'
INPUT_OIDC_CONFIG_NAME='oidc-config.json'
INPUT_OIDC_SECRET_NAME='oidc-client-secret'
INPUT_SLACK_TOKEN_NAME='slack-bot-token'
INPUT_SLACK_SIGNING_SECRET_NAME='slack-signing-secret'
INPUT_GRANOLA_CREDENTIAL_NAME='granola-credential'
INPUT_LLM_CREDENTIAL_NAME='llm-credential'

input_dir=''
input_release=''
input_runtime_profile=''
input_oidc_config=''
input_oidc_secret=''
input_slack_token=''
input_slack_signing_secret=''
input_granola_credential=''
input_llm_credential=''
input_runtime_user=''
input_organization_name=''
input_owner_display_name=''
input_owner_email=''
input_authority_host=''
input_aws_region=''
input_channel=''

portable_stat_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"
}

portable_stat_uid() {
  stat -c '%u' "$1" 2>/dev/null || stat -f '%u' "$1"
}

require_input_dir_argument() {
  [[ $# -eq 2 && "$1" == --input-dir && "$2" = /* ]] || usage
  input_dir="$2"
}

read_input_manifest() {
  local manifest="$input_dir/$INPUT_MANIFEST_NAME"
  local value count=0
  while IFS= read -r value; do
    case "$count" in
      0) input_runtime_user="$value" ;;
      1) input_organization_name="$value" ;;
      2) input_owner_display_name="$value" ;;
      3) input_owner_email="$value" ;;
      4) input_authority_host="$value" ;;
      5) input_aws_region="$value" ;;
      6) input_channel="$value" ;;
      *) return 1 ;;
    esac
    count=$((count + 1))
  done < <(python3 - "$manifest" <<'PY'
import json
import re
import sys

path = sys.argv[1]
try:
    with open(path, encoding="utf-8") as source:
        value = json.load(source)
except Exception:
    raise SystemExit(1)

expected = {
    "kind",
    "schema_version",
    "runtime_user",
    "organization_name",
    "owner_display_name",
    "owner_email",
    "authority_host",
    "aws_region",
    "slack_approval_channel_id",
}
if not isinstance(value, dict) or set(value) != expected:
    raise SystemExit(1)
if value["kind"] != "echo-clean-v1-onboarding-input-v1" or value["schema_version"] != 1:
    raise SystemExit(1)

def text(key, maximum=200):
    item = value[key]
    if not isinstance(item, str) or not item or len(item) > maximum:
        raise SystemExit(1)
    if any(character in item for character in "\r\n\t=") or any(ord(character) < 32 for character in item):
        raise SystemExit(1)
    return item

runtime_user = text("runtime_user", 64)
organization_name = text("organization_name")
owner_display_name = text("owner_display_name")
owner_email = text("owner_email", 254)
authority_host = text("authority_host", 253)
aws_region = text("aws_region", 32)
channel = text("slack_approval_channel_id", 32)

if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.-]*", runtime_user):
    raise SystemExit(1)
if not re.fullmatch(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+", owner_email):
    raise SystemExit(1)
labels = authority_host.split(".")
if (
    len(authority_host) > 253
    or len(labels) < 2
    or any(
        not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
        for label in labels
    )
):
    raise SystemExit(1)
if not re.fullmatch(r"[CG][A-Z0-9]{8,}", channel):
    raise SystemExit(1)
if not re.fullmatch(r"[a-z]{2}(?:-[a-z0-9]+)+-[1-9][0-9]*", aws_region):
    raise SystemExit(1)

for item in (runtime_user, organization_name, owner_display_name, owner_email, authority_host, aws_region, channel):
    print(item)
PY
)
  [[ "$count" -eq 7 ]]
}

validate_input_oidc_callback() {
  python3 - "$input_oidc_config" "$input_authority_host" <<'PY'
import json
import sys

try:
    with open(sys.argv[1], encoding="utf-8") as source:
        value = json.load(source)
except Exception:
    raise SystemExit(1)

if not isinstance(value, dict) or value.get("redirect_uri") != f"https://{sys.argv[2]}/v2/session/oidc/callback":
    raise SystemExit(1)
PY
}

runtime_profile_digest() {
  python3 - "$1" <<'PY'
import hashlib
import os
import stat
import sys

path = sys.argv[1]
state = os.lstat(path)
if stat.S_ISLNK(state.st_mode) or not stat.S_ISREG(state.st_mode):
    raise SystemExit(1)
digest = hashlib.sha256()
with open(path, "rb") as source:
    for chunk in iter(lambda: source.read(128 * 1024), b""):
        digest.update(chunk)
print(digest.hexdigest())
PY
}

runtime_profile_field() {
  python3 "$RUNTIME_PROFILE_TOOL" field "$1" "$2"
}

validate_runtime_profile_tuple() {
  local record="$1" profile="$2" expected_digest expected_source actual_digest actual_source
  python3 "$RUNTIME_PROFILE_TOOL" validate "$profile" >/dev/null || return 1
  expected_digest="$(python3 "$RELEASE_TOOL" field "$record" runtime-profile-sha256)" || return 1
  actual_digest="$(runtime_profile_digest "$profile")" || return 1
  [[ "$actual_digest" == "$expected_digest" ]] || return 1
  expected_source="$(python3 "$RELEASE_TOOL" field "$record" source-sha)" || return 1
  actual_source="$(runtime_profile_field "$profile" source-sha)" || return 1
  [[ "$actual_source" == "$expected_source" ]]
}

runtime_identity_is_valid() {
  local runtime_user="$1" uid
  [[ "$runtime_user" =~ ^[A-Za-z_][A-Za-z0-9_.-]*$ ]] || return 1
  id "$runtime_user" >/dev/null 2>&1 || return 1
  uid="$(id -u "$runtime_user")" || return 1
  [[ "$uid" != 0 ]]
}

runtime_executor_can_prepare() {
  local runtime_user="$1" uid gid
  uid="$(id -u "$runtime_user")" || return 1
  gid="$(id -g "$runtime_user")" || return 1
  [[ "$(id -u)" == 0 || ( "$(id -u)" == "$uid" && "$(id -g)" == "$gid" ) ]]
}

safe_directory_target() {
  local path="$1"
  [[ ! -e "$path" && ! -L "$path" ]] && return 0
  [[ -d "$path" && ! -L "$path" ]]
}

check_input_dir() {
  [[ "$input_dir" = /* && -d "$input_dir" && ! -L "$input_dir" ]] || return 1
  [[ "$(portable_stat_uid "$input_dir")" == "$(id -u)" ]] || return 1
  [[ "$(portable_stat_mode "$input_dir")" == 700 ]] || return 1

  local name path
  local -a expected=(
    "$INPUT_MANIFEST_NAME"
    "$INPUT_RELEASE_NAME"
    "$INPUT_RUNTIME_PROFILE_NAME"
    "$INPUT_OIDC_CONFIG_NAME"
    "$INPUT_OIDC_SECRET_NAME"
    "$INPUT_SLACK_TOKEN_NAME"
    "$INPUT_SLACK_SIGNING_SECRET_NAME"
    "$INPUT_GRANOLA_CREDENTIAL_NAME"
    "$INPUT_LLM_CREDENTIAL_NAME"
  )
  for name in "${expected[@]}"; do
    path="$input_dir/$name"
    [[ -f "$path" && ! -L "$path" ]] || return 1
    [[ "$(portable_stat_uid "$path")" == "$(id -u)" ]] || return 1
    [[ "$(portable_stat_mode "$path")" == 600 ]] || return 1
  done
  shopt -s nullglob dotglob
  local entries=("$input_dir"/*)
  shopt -u nullglob dotglob
  [[ ${#entries[@]} -eq ${#expected[@]} ]] || return 1

  input_release="$input_dir/$INPUT_RELEASE_NAME"
  input_runtime_profile="$input_dir/$INPUT_RUNTIME_PROFILE_NAME"
  input_oidc_config="$input_dir/$INPUT_OIDC_CONFIG_NAME"
  input_oidc_secret="$input_dir/$INPUT_OIDC_SECRET_NAME"
  input_slack_token="$input_dir/$INPUT_SLACK_TOKEN_NAME"
  input_slack_signing_secret="$input_dir/$INPUT_SLACK_SIGNING_SECRET_NAME"
  input_granola_credential="$input_dir/$INPUT_GRANOLA_CREDENTIAL_NAME"
  input_llm_credential="$input_dir/$INPUT_LLM_CREDENTIAL_NAME"
  return 0
}

check_provider_activation_input_dir() {
  [[ "$input_dir" = /* && -d "$input_dir" && ! -L "$input_dir" ]] || return 1
  [[ "$(portable_stat_uid "$input_dir")" == "$(id -u)" ]] || return 1
  [[ "$(portable_stat_mode "$input_dir")" == 700 ]] || return 1

  local name path
  local -a expected=(
    "$INPUT_GRANOLA_CREDENTIAL_NAME"
    "$INPUT_LLM_CREDENTIAL_NAME"
  )
  for name in "${expected[@]}"; do
    path="$input_dir/$name"
    [[ -f "$path" && ! -L "$path" ]] || return 1
    [[ "$(portable_stat_uid "$path")" == "$(id -u)" ]] || return 1
    [[ "$(portable_stat_mode "$path")" == 600 ]] || return 1
  done
  shopt -s nullglob dotglob
  local entries=("$input_dir"/*)
  shopt -u nullglob dotglob
  [[ ${#entries[@]} -eq ${#expected[@]} ]] || return 1

  input_granola_credential="$input_dir/$INPUT_GRANOLA_CREDENTIAL_NAME"
  input_llm_credential="$input_dir/$INPUT_LLM_CREDENTIAL_NAME"
  python3 - "$input_granola_credential" "$input_llm_credential" <<'PY'
import re
import sys

def credential(path):
    try:
        value = open(path, "rb").read()
    except Exception:
        raise SystemExit(1)
    if not 32 <= len(value) <= 4096 or any(byte < 0x21 or byte > 0x7e for byte in value):
        raise SystemExit(1)
    return value.decode("ascii")

granola = credential(sys.argv[1])
credential(sys.argv[2])
if re.fullmatch(r"grn_[A-Za-z0-9][A-Za-z0-9_-]*", granola) is None:
    raise SystemExit(1)
PY
}

doctor_json() {
  local ok="$1" code="$2" next_action="$3"
  [[ "$ok" == true || "$ok" == false ]] || return 1
  [[ "$code" =~ ^[a-z0-9_]+$ ]] || return 1
  [[ "$next_action" != *'"'* && "$next_action" != *'\\'* ]] || return 1
  printf '{"ok":%s,"code":"%s","next_action":"%s"}\n' \
    "$ok" "$code" "$next_action"
}

doctor() {
  require_input_dir_argument "$@"
  if ! command -v docker >/dev/null 2>&1; then doctor_json false docker_missing 'Install Docker, then rerun doctor.'; return; fi
  if ! docker compose version >/dev/null 2>&1; then doctor_json false docker_compose_missing 'Install Docker Compose v2, then rerun doctor.'; return; fi
  if ! command -v python3 >/dev/null 2>&1; then doctor_json false python3_missing 'Install python3, then rerun doctor.'; return; fi
  if [[ ! -f "$RELEASE_TOOL" ]]; then doctor_json false release_validator_missing 'Install the clean-v1 release validator, then rerun doctor.'; return; fi
  if [[ ! -f "$RUNTIME_PROFILE_TOOL" ]]; then doctor_json false runtime_profile_validator_missing 'Install the clean-v1 runtime profile validator, then rerun doctor.'; return; fi
  if ! command -v systemctl >/dev/null 2>&1; then doctor_json false systemctl_missing 'Provision the supported EC2 host, then rerun doctor.'; return; fi
  if ! systemctl is-active --quiet cloudflared-echo-authority.service >/dev/null 2>&1; then doctor_json false cloudflared_inactive 'Start cloudflared-echo-authority.service, then rerun doctor.'; return; fi
  if [[ ! -d "$input_dir" || -L "$input_dir" || "$input_dir" != /* ]]; then doctor_json false input_dir_invalid 'Create an absolute private input directory with mode 0700.'; return; fi
  if [[ "$(portable_stat_uid "$input_dir")" != "$(id -u)" || "$(portable_stat_mode "$input_dir")" != 700 ]]; then doctor_json false input_dir_permissions_invalid 'Make the input directory current-executor-owned with mode 0700.'; return; fi
  if ! check_input_dir; then doctor_json false input_files_invalid 'Use exactly the documented current-executor-owned regular files with mode 0600.'; return; fi
  if ! read_input_manifest; then doctor_json false input_manifest_invalid 'Use the exact manifest schema and safe ordinary values from the committed example.'; return; fi
  if ! runtime_identity_is_valid "$input_runtime_user"; then doctor_json false runtime_user_invalid 'Create a non-root runtime user and run as root or that runtime user.'; return; fi
  if ! runtime_executor_can_prepare "$input_runtime_user"; then doctor_json false runtime_executor_invalid 'Run prepare as root or as the selected runtime user.'; return; fi
  if ! python3 "$RELEASE_TOOL" validate "$input_release" >/dev/null 2>&1; then doctor_json false release_invalid 'Replace release.json with a canonical clean-v1 release record.'; return; fi
  if ! validate_runtime_profile_tuple "$input_release" "$input_runtime_profile" >/dev/null 2>&1; then doctor_json false runtime_profile_invalid 'Replace runtime-profile.json with the exact canonical profile named by release.json.'; return; fi
  if ! validate_input_oidc_callback >/dev/null 2>&1; then doctor_json false oidc_callback_invalid 'Set oidc-config.json redirect_uri to the exact Authority callback URL.'; return; fi
  if ! safe_directory_target "$DATA_DIR"; then doctor_json false clean_data_path_invalid 'Remove or repair the unsafe clean-data path before preparing.'; return; fi
  if ! safe_directory_target "$PRIVATE_DIR"; then doctor_json false clean_private_path_invalid 'Remove or repair the unsafe clean private-input path before preparing.'; return; fi
  if ! safe_directory_target "$RELEASE_DIR"; then doctor_json false clean_release_path_invalid 'Remove or repair the unsafe clean release path before preparing.'; return; fi
  if ! safe_directory_target "$RUNTIME_PROFILES_DIR"; then doctor_json false clean_runtime_profiles_path_invalid 'Remove or repair the unsafe deployment runtime-profiles path before preparing.'; return; fi
  if ! safe_directory_target "$RUNTIME_ENVIRONMENTS_DIR"; then doctor_json false clean_runtime_environments_path_invalid 'Remove or repair the unsafe deployment runtime-environments path before preparing.'; return; fi
  doctor_json true ready 'Run prepare with the same input directory.'
}

require_host_prerequisites() {
  command -v docker >/dev/null 2>&1 || fail 'Docker is not installed. Provision Docker, Cloudflare Tunnel, and registry access before using this wrapper.'
  docker compose version >/dev/null 2>&1 || fail 'Docker Compose v2 is unavailable. Provision Docker Compose before using this wrapper.'
  command -v python3 >/dev/null 2>&1 || fail 'python3 is required for canonical release validation.'
  [[ -f "$RELEASE_TOOL" ]] || fail 'clean-v1 release validator is missing from deploy/release.'
  [[ -f "$RUNTIME_PROFILE_TOOL" ]] || fail 'clean-v1 runtime profile validator is missing from deploy/release.'
}

compose_clean() {
  docker compose --env-file "$ENV_FILE" \
    -f "$DEPLOY_DIR/compose.clean-v1.yaml" \
    -f "$DEPLOY_DIR/compose.clean-v1.ec2.yaml" "$@"
}

activation_compose_quiet() {
  local status=0
  docker compose --env-file "$ENV_FILE" \
    -f "$DEPLOY_DIR/compose.clean-v1.yaml" \
    -f "$DEPLOY_DIR/compose.clean-v1.ec2.yaml" "$@" >/dev/null 2>&1 &
  ACTIVATION_CHILD_PID=$!
  wait "$ACTIVATION_CHILD_PID" || status=$?
  ACTIVATION_CHILD_PID=''
  return "$status"
}

release_field() { python3 "$RELEASE_TOOL" field "$RELEASE_FILE" "$1"; }

private_source() {
  local path="$1" label="$2"
  [[ "$path" = /* ]] || fail "$label must be an absolute file path"
  [[ -f "$path" && ! -L "$path" ]] || fail "$label must be a regular, non-symlink file"
}

no_newline_value() {
  local value="$1" label="$2"
  [[ -n "$value" && "$value" != *$'\n'* && "$value" != *$'\r'* ]] || fail "$label must be one non-empty line"
}

select_runtime_identity() {
  local runtime_user="$1"
  [[ "$runtime_user" =~ ^[A-Za-z_][A-Za-z0-9_.-]*$ ]] || \
    fail 'runtime user must be a local operating-system account name'
  id "$runtime_user" >/dev/null 2>&1 || \
    fail "runtime user does not exist on this server: $runtime_user"
  RUNTIME_UID="$(id -u "$runtime_user")"
  RUNTIME_GID="$(id -g "$runtime_user")"
  [[ "$RUNTIME_UID" != 0 ]] || \
    fail 'runtime user must be a non-root operating-system account'
  EXECUTOR_UID="$(id -u)"
  if [[ "$EXECUTOR_UID" != 0 && ( "$EXECUTOR_UID" != "$RUNTIME_UID" || "$(id -g)" != "$RUNTIME_GID" ) ]]; then
    fail 'prepare must run as root or as the selected runtime user'
  fi
}

require_safe_directory_target() {
  local path="$1" label="$2"
  if [[ -e "$path" || -L "$path" ]]; then
    [[ -d "$path" && ! -L "$path" ]] || fail "$label is not a safe directory"
  fi
}

own_for_runtime() {
  local path="$1"
  if [[ "$EXECUTOR_UID" == 0 ]]; then
    chown "$RUNTIME_UID:$RUNTIME_GID" "$path"
  fi
}

copy_exact_private() {
  local source="$1" destination="$2" label="$3" ownership="${4:-runtime}"
  private_source "$source" "$label"
  if [[ -e "$destination" ]]; then
    [[ -f "$destination" && ! -L "$destination" ]] || fail "existing $label destination is unsafe"
    cmp -s "$source" "$destination" || fail "$label conflicts with the existing clean onboarding input"
    chmod 0600 "$destination"
    if [[ "$ownership" == runtime ]]; then
      own_for_runtime "$destination"
    fi
    return
  fi
  install -m 0600 "$source" "$destination"
  if [[ "$ownership" == runtime ]]; then
    own_for_runtime "$destination"
  fi
}

write_exact_private() {
  local destination="$1" value="$2" label="$3" temporary
  temporary="$(mktemp "$PRIVATE_DIR/.${label}.XXXXXX")"
  chmod 0600 "$temporary"
  printf '%s' "$value" > "$temporary"
  own_for_runtime "$temporary"
  if [[ -e "$destination" ]]; then
    [[ -f "$destination" && ! -L "$destination" ]] || fail "existing $label destination is unsafe"
    cmp -s "$temporary" "$destination" || fail "$label conflicts with the existing clean onboarding input"
    chmod 0600 "$destination"
    own_for_runtime "$destination"
    rm -f "$temporary"
    return
  fi
  mv "$temporary" "$destination"
}

write_exact_file() {
  local destination="$1" content="$2" label="$3" ownership="${4:-host}" temporary
  temporary="$(mktemp "${destination}.XXXXXX")"
  chmod 0600 "$temporary"
  printf '%s' "$content" > "$temporary"
  if [[ "$ownership" == runtime ]]; then
    own_for_runtime "$temporary"
  fi
  if [[ -e "$destination" ]]; then
    [[ -f "$destination" && ! -L "$destination" ]] || fail "existing $label is unsafe"
    cmp -s "$temporary" "$destination" || fail "$label conflicts with the existing clean onboarding configuration"
    chmod 0600 "$destination"
    if [[ "$ownership" == runtime ]]; then
      own_for_runtime "$destination"
    fi
    rm -f "$temporary"
    return
  fi
  mv "$temporary" "$destination"
}

materialize_runtime_profile() {
  local profile="$1" release_id="$2" staging filename destination
  staging="$RELEASE_DIR/.runtime-profile-materialized-$release_id"
  [[ ! -e "$staging" && ! -L "$staging" ]] || \
    fail 'runtime profile materialization staging path already exists'
  python3 "$RUNTIME_PROFILE_TOOL" materialize "$profile" "$staging" || \
    fail 'could not materialize the canonical runtime profile'

  for filename in Caddyfile.clean-v1 Caddyfile.clean-v1.ec2 compose.clean-v1.ec2.yaml compose.clean-v1.yaml; do
    destination="$DEPLOY_DIR/$filename"
    [[ -f "$staging/$filename" && ! -L "$staging/$filename" ]] || \
      fail 'materialized runtime profile is incomplete'
    if [[ -e "$destination" || -L "$destination" ]]; then
      [[ -f "$destination" && ! -L "$destination" ]] || \
        fail "deployment runtime profile target is unsafe: $filename"
    fi
  done

  for filename in Caddyfile.clean-v1 Caddyfile.clean-v1.ec2 compose.clean-v1.ec2.yaml compose.clean-v1.yaml; do
    install -m 0600 "$staging/$filename" "$DEPLOY_DIR/$filename" || \
      fail "could not install runtime profile file: $filename"
  done
  rm -f "$staging"/Caddyfile.clean-v1 \
    "$staging"/Caddyfile.clean-v1.ec2 \
    "$staging"/compose.clean-v1.ec2.yaml \
    "$staging"/compose.clean-v1.yaml
  rmdir "$staging" || fail 'could not remove runtime profile materialization staging directory'
}

environment_value() {
  local file="$1" key="$2" value
  [[ -f "$file" && ! -L "$file" ]] || return 1
  value="$(sed -n "s/^${key}=//p" "$file")"
  [[ -n "$value" ]] || return 1
  printf '%s\n' "$value"
}

accepted_runtime_profile_path() {
  printf '%s/%s.profile\n' "$RUNTIME_PROFILES_DIR" "$(release_field release-id)"
}

accepted_runtime_environment_path() {
  printf '%s/%s.env\n' "$RUNTIME_ENVIRONMENTS_DIR" "$(release_field release-id)"
}

runtime_profile_files_match_deployment() {
  python3 - "$ACTIVE_RUNTIME_PROFILE_FILE" "$DEPLOY_DIR" <<'PY'
import json
import os
import stat
import sys

profile_path, deployment = sys.argv[1:]
with open(profile_path, encoding="utf-8") as source:
    profile = json.load(source)
for filename, contents in profile["files"].items():
    path = os.path.join(deployment, filename)
    state = os.lstat(path)
    if stat.S_ISLNK(state.st_mode) or not stat.S_ISREG(state.st_mode):
        raise SystemExit(1)
    with open(path, "rb") as source:
        if source.read() != contents.encode("utf-8"):
            raise SystemExit(1)
PY
}

runtime_profile_matches_prepared_tuple() {
  local profile environment expected_digest expected_release
  profile="$(accepted_runtime_profile_path)" || return 1
  environment="$(accepted_runtime_environment_path)" || return 1
  [[ -f "$profile" && ! -L "$profile" ]] || return 1
  [[ -f "$ACTIVE_RUNTIME_PROFILE_FILE" && ! -L "$ACTIVE_RUNTIME_PROFILE_FILE" ]] || return 1
  [[ -f "$environment" && ! -L "$environment" ]] || return 1
  validate_runtime_profile_tuple "$RELEASE_FILE" "$profile" || return 1
  validate_runtime_profile_tuple "$RELEASE_FILE" "$ACTIVE_RUNTIME_PROFILE_FILE" || return 1
  cmp -s "$profile" "$ACTIVE_RUNTIME_PROFILE_FILE" || return 1
  cmp -s "$environment" "$ENV_FILE" || return 1
  expected_digest="$(release_field runtime-profile-sha256)" || return 1
  expected_release="$(release_field release-id)" || return 1
  [[ "$(environment_value "$ENV_FILE" ECHO_CLEAN_RUNTIME_PROFILE_SHA256)" == "$expected_digest" ]] || return 1
  [[ "$(environment_value "$ENV_FILE" ECHO_CLEAN_RELEASE_ID)" == "$expected_release" ]] || return 1
  runtime_profile_files_match_deployment
}

require_prepared() {
  [[ -f "$SETUP_FILE" && ! -L "$SETUP_FILE" ]] || fail 'run prepare first'
  [[ -f "$RELEASE_FILE" && ! -L "$RELEASE_FILE" ]] || fail 'clean release record is missing; run prepare again with the same record'
  [[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || fail 'clean Compose environment is missing; run prepare again with the same inputs'
  python3 "$RELEASE_TOOL" validate "$RELEASE_FILE" >/dev/null || fail 'persisted release record is no longer canonical clean-v1'
  runtime_profile_matches_prepared_tuple || fail 'prepared runtime profile tuple is missing, noncanonical, or drifted from the accepted release'
  for required in oidc-config.json oidc-client-secret slack-bot-token slack-signing-secret granola-credential-source granola-owner-email llm-credential-source; do
    [[ -f "$PRIVATE_DIR/$required" && ! -L "$PRIVATE_DIR/$required" ]] || fail "fixed private input is missing: $required"
  done
}

ensure_image() {
  local image
  image="$(release_field authority-image)"
  if ! docker image inspect "$image" >/dev/null 2>&1; then
    compose_clean pull authority
  fi
}

require_image_present() {
  local image
  image="$(release_field authority-image)"
  docker image inspect "$image" >/dev/null 2>&1 || \
    fail 'accepted Authority image is not present locally; run resume to pull it explicitly'
}

setup_status() {
  compose_clean run --rm --no-deps --pull never --entrypoint node authority \
    "$SETUP_COMMAND" status --state-dir /echo-clean/state
}

staged_candidate_present() {
  [[ -e "$CANDIDATE_FILE" || -L "$CANDIDATE_FILE" ]] || return 1
  [[ -f "$CANDIDATE_FILE" && ! -L "$CANDIDATE_FILE" ]] || \
    fail 'staged clean-v1 candidate record is unsafe'
  python3 "$RELEASE_TOOL" validate "$CANDIDATE_FILE" >/dev/null || \
    fail 'staged clean-v1 candidate record is not canonical'
}

next_step_from_status() {
  python3 -c 'import json, sys; value=json.load(sys.stdin); step=value.get("next_step"); assert isinstance(step, str); print(step)' \
    <<<"$1" || fail 'initial-owner setup status was not the expected safe JSON'
}

status_boolean() {
  local status_json="$1" field="$2"
  python3 -c 'import json, sys; value=json.load(sys.stdin); result=value.get(sys.argv[1]); assert type(result) is bool; print("true" if result else "false")' \
    "$field" <<<"$status_json" || fail "initial-owner setup status has no boolean $field"
}

start_runtime() {
  compose_clean up -d --no-build --wait --wait-timeout 90
}

public_descriptor_healthy() {
  local descriptor_url
  descriptor_url="$(setup_value authority_url)/v1/authority-descriptor"
  activation_compose_quiet exec -T authority node -e '
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

wait_for_public_descriptor() {
  local attempts=0
  while (( attempts < 18 )); do
    if public_descriptor_healthy; then
      return 0
    fi
    ((attempts += 1))
    if (( attempts < 18 )); then
      sleep 5
    fi
  done
  return 1
}

running_authority() {
  local id
  id="$(compose_clean ps -q authority 2>/dev/null)" || return 1
  [[ -n "$id" ]] || return 1
  [[ "$(docker inspect --format '{{.State.Running}}' "$id" 2>/dev/null)" == true ]]
}

healthy_authority() {
  local id
  id="$(compose_clean ps -q authority 2>/dev/null)" || return 1
  [[ -n "$id" ]] || return 1
  [[ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id" 2>/dev/null)" == healthy ]]
}

authority_uses_accepted_image() {
  local id expected_image expected_source running_image_id
  id="$(compose_clean ps -q authority 2>/dev/null)" || return 1
  [[ -n "$id" ]] || return 1
  expected_image="$(release_field authority-image)"
  expected_source="$(release_field source-sha)"
  running_image_id="$(docker inspect --format '{{.Image}}' "$id" 2>/dev/null)" || return 1
  [[ "$running_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
  docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' \
    "$running_image_id" 2>/dev/null | grep -Fqx "$expected_image" || return 1
  [[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$running_image_id" 2>/dev/null)" == "$expected_source" ]]
}

service_uses_accepted_runtime_profile() {
  local service="$1" id expected_release expected_digest
  id="$(compose_clean ps -q "$service" 2>/dev/null)" || return 1
  [[ -n "$id" ]] || return 1
  expected_release="$(release_field release-id)" || return 1
  expected_digest="$(release_field runtime-profile-sha256)" || return 1
  [[ "$(docker inspect --format '{{index .Config.Labels "io.echo-brain.release-id"}}' "$id" 2>/dev/null)" == "$expected_release" ]] || return 1
  [[ "$(docker inspect --format '{{index .Config.Labels "io.echo-brain.runtime-profile-sha256"}}' "$id" 2>/dev/null)" == "$expected_digest" ]]
}

runtime_uses_accepted_runtime_profile() {
  runtime_profile_matches_prepared_tuple && \
    service_uses_accepted_runtime_profile authority && \
    service_uses_accepted_runtime_profile proxy
}

terminal_green() {
  local status_json="$1"
  [[ "$(next_step_from_status "$status_json")" == complete ]] || return 1
  running_authority && healthy_authority && authority_uses_accepted_image && runtime_uses_accepted_runtime_profile
}

print_status() {
  local status_json="$1"
  if running_authority; then
    printf 'authority_running=true\n'
  else
    printf 'authority_running=false\n'
  fi
  if healthy_authority; then
    printf 'authority_healthy=true\n'
  else
    printf 'authority_healthy=false\n'
  fi
  if authority_uses_accepted_image; then
    printf 'authority_exact_accepted_image=true\n'
  else
    printf 'authority_exact_accepted_image=false\n'
  fi
  if runtime_uses_accepted_runtime_profile; then
    printf 'runtime_exact_accepted_profile=true\n'
  else
    printf 'runtime_exact_accepted_profile=false\n'
  fi
  if terminal_green "$status_json"; then
    printf 'terminal_green=true\n'
  else
    printf 'terminal_green=false\n'
  fi
  printf 'status_json=%s\n' "$status_json"
}

print_staged_candidate_status() {
  printf 'release_state=staged_candidate\n'
  printf 'authority_exact_accepted_image=false\n'
  printf 'runtime_exact_accepted_profile=false\n'
  printf 'terminal_green=false\n'
  printf 'next_action=Run update-clean-v1.sh status, then promote the candidate or roll it back.\n'
}

prepare() {
  require_input_dir_argument "$@"
  local doctor_result
  doctor_result="$(doctor --input-dir "$input_dir")"
  [[ "$doctor_result" == '{"ok":true,'* ]] || fail 'doctor did not report this input directory ready; run doctor directly for its safe next action'
  # Doctor runs the complete preflight. Read the same fixed sources again in
  # this process before persisting them, so prepare never accepts a different
  # shape than the one it just checked.
  check_input_dir && read_input_manifest && validate_runtime_profile_tuple "$input_release" "$input_runtime_profile" && validate_input_oidc_callback || \
    fail 'input directory changed after doctor; rerun prepare'
  require_host_prerequisites
  select_runtime_identity "$input_runtime_user"
  python3 "$RELEASE_TOOL" validate "$input_release" >/dev/null
  # The shared lock lives under clean-data. The successful doctor check above
  # proved this parent safe; create only that parent before serializing the
  # first preparation.
  require_safe_directory_target "$DATA_DIR" 'clean data path'
  install -d -m 0700 "$DATA_DIR"
  chmod 0700 "$DATA_DIR"
  acquire_operation_lock
  trap 'release_operation_lock' EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  require_safe_directory_target "$DATA_DIR" 'clean data path'
  require_safe_directory_target "$PRIVATE_DIR" 'clean private-input path'
  require_safe_directory_target "$RELEASE_DIR" 'clean release path'
  require_safe_directory_target "$RUNTIME_PROFILES_DIR" 'deployment runtime-profiles path'
  require_safe_directory_target "$RUNTIME_ENVIRONMENTS_DIR" 'deployment runtime-environments path'
  install -d -m 0700 "$DATA_DIR" "$PRIVATE_DIR" "$RELEASE_DIR" \
    "$RUNTIME_PROFILES_DIR" "$RUNTIME_ENVIRONMENTS_DIR"
  chmod 0700 "$DATA_DIR" "$PRIVATE_DIR" "$RELEASE_DIR" \
    "$RUNTIME_PROFILES_DIR" "$RUNTIME_ENVIRONMENTS_DIR"
  own_for_runtime "$DATA_DIR"
  own_for_runtime "$PRIVATE_DIR"
  own_for_runtime "$RUNTIME_PROFILES_DIR"
  own_for_runtime "$RUNTIME_ENVIRONMENTS_DIR"
  copy_exact_private "$input_release" "$RELEASE_FILE" 'release record' host
  local image uid gid authority_url setup env release_id runtime_profile_sha256 runtime_profile_version runtime_profile_path runtime_environment_path
  image="$(release_field authority-image)"
  release_id="$(release_field release-id)"
  runtime_profile_sha256="$(runtime_profile_digest "$input_runtime_profile")"
  runtime_profile_version="$(release_field runtime-profile-version)"
  runtime_profile_path="$RUNTIME_PROFILES_DIR/$release_id.profile"
  runtime_environment_path="$RUNTIME_ENVIRONMENTS_DIR/$release_id.env"
  uid="$RUNTIME_UID"
  gid="$RUNTIME_GID"
  authority_url="https://$input_authority_host"
  setup="runtime_user=$input_runtime_user
organization_name=$input_organization_name
owner_display_name=$input_owner_display_name
owner_email=$input_owner_email
authority_host=$input_authority_host
authority_url=$authority_url
aws_region=$input_aws_region
authority_log_group=/echo-brain/authority/$input_authority_host
slack_approval_channel_id=$input_channel
release_id=$release_id
authority_image=$image
artifact_revision=$(release_field source-sha)
runtime_profile_sha256=$runtime_profile_sha256
authority_uid=$uid
authority_gid=$gid"
  env="ECHO_CLEAN_AUTHORITY_HOST=$input_authority_host
ECHO_CLEAN_AUTHORITY_URL=$authority_url
ECHO_CLEAN_AUTHORITY_UID=$uid
ECHO_CLEAN_AUTHORITY_GID=$gid
ECHO_CLEAN_AUTHORITY_IMAGE=$image
ECHO_CLEAN_RELEASE_ID=$release_id
ECHO_CLEAN_RELEASE_SOURCE_SHA=$(release_field source-sha)
ECHO_CLEAN_RUNTIME_PROFILE_SHA256=$runtime_profile_sha256
ECHO_CLEAN_RUNTIME_PROFILE_VERSION=$runtime_profile_version
ECHO_CLEAN_AWS_REGION=$input_aws_region
ECHO_CLEAN_AUTHORITY_LOG_GROUP=/echo-brain/authority/$input_authority_host
ECHO_CLEAN_SLACK_APPROVAL_CHANNEL_ID=$input_channel
ECHO_CLEAN_OWNER_EMAIL=$input_owner_email"
  write_exact_file "$SETUP_FILE" "$setup" 'setup configuration' runtime
  write_exact_file "$ENV_FILE" "$env" 'Compose environment'
  write_exact_file "$runtime_environment_path" "$env" 'runtime environment snapshot' runtime
  copy_exact_private "$input_runtime_profile" "$runtime_profile_path" 'runtime profile' host
  copy_exact_private "$input_runtime_profile" "$ACTIVE_RUNTIME_PROFILE_FILE" 'active runtime profile' host
  copy_exact_private "$input_oidc_config" "$PRIVATE_DIR/oidc-config.json" 'OIDC configuration'
  copy_exact_private "$input_oidc_secret" "$PRIVATE_DIR/oidc-client-secret" 'OIDC client secret'
  copy_exact_private "$input_slack_token" "$PRIVATE_DIR/slack-bot-token" 'Slack bot token'
  copy_exact_private "$input_slack_signing_secret" "$PRIVATE_DIR/slack-signing-secret" 'Slack signing secret'
  copy_exact_private "$input_granola_credential" "$PRIVATE_DIR/granola-credential-source" 'Granola credential'
  copy_exact_private "$input_llm_credential" "$PRIVATE_DIR/llm-credential-source" 'LLM credential'
  write_exact_private "$PRIVATE_DIR/granola-owner-email" "$input_owner_email" 'Granola owner email'
  materialize_runtime_profile "$ACTIVE_RUNTIME_PROFILE_FILE" "$release_id"
  # This render is intentionally offline: prepare never builds or pulls an image.
  compose_clean config >/dev/null
  printf 'prepared=true\nnext_action=Run onboard-clean-v1.sh resume on this server.\n'
}

setup_value() {
  local key="$1" value
  value="$(sed -n "s/^${key}=//p" "$SETUP_FILE")"
  [[ -n "$value" ]] || fail "setup configuration is missing $key"
  printf '%s\n' "$value"
}

bootstrap() {
  compose_clean run --rm --no-deps --entrypoint node authority \
    "$SETUP_COMMAND" bootstrap \
    --state-dir /echo-clean/state \
    --organization-name "$(setup_value organization_name)" \
    --owner-display-name "$(setup_value owner_display_name)" \
    --owner-email "$(setup_value owner_email)" \
    --authority-url "$(setup_value authority_url)" \
    --oidc-config /echo-clean/private/oidc-config.json \
    --slack-approval-channel-id "$(setup_value slack_approval_channel_id)" \
    --artifact-revision "$(setup_value artifact_revision)" \
    < "$PRIVATE_DIR/slack-bot-token"
}

replace_rehearsal_rollback_on_exit() {
  local exit_status="${1:-1}" restored=true restarted=true archived_environment
  trap - EXIT HUP INT TERM
  archived_environment="$REHEARSAL_ARCHIVE/.env.clean-v1"
  if [[ "$REHEARSAL_ROLLBACK_ARMED" == true ]]; then
    if [[ "$REHEARSAL_DATA_MUTATED" == true ]]; then
      if ! find "$DATA_DIR" -xdev -depth -mindepth 1 \
        ! -path "$OPERATION_LOCK_DIR" \
        ! -path "$OPERATION_LOCK_DIR/*" \
        -delete ||
        ! cp -a -x "$REHEARSAL_ARCHIVED_DATA/." "$DATA_DIR/"; then
        restored=false
      fi
    fi
    if [[ -f "$archived_environment" && ! -L "$archived_environment" ]]; then
      if [[ -e "$ENV_FILE" || -L "$ENV_FILE" ]]; then
        if [[ ! -f "$ENV_FILE" || -L "$ENV_FILE" ]] ||
          ! cmp -s "$archived_environment" "$ENV_FILE"; then
          restored=false
        fi
      elif ! mv "$archived_environment" "$ENV_FILE"; then
        restored=false
      fi
    elif [[ ! -f "$ENV_FILE" || -L "$ENV_FILE" ]]; then
      restored=false
    fi
    if [[ "$restored" == true && "$REHEARSAL_RUNTIME_STOPPED" == true ]]; then
      if ! start_runtime ||
        ! running_authority ||
        ! healthy_authority ||
        ! authority_uses_accepted_image ||
        ! runtime_uses_accepted_runtime_profile; then
        restarted=false
      fi
    fi
    if [[ "$restored" == true && "$restarted" == true ]] &&
      [[ -n "$REHEARSAL_ARCHIVE" ]] && ! rm -rf -- "$REHEARSAL_ARCHIVE"; then
      restored=false
    fi
    if [[ "$restored" == true && "$restarted" == true ]]; then
      printf 'onboard-clean-v1: live data and environment were restored and the prior runtime was restarted after interrupted rehearsal replacement\n' >&2
    else
      printf 'onboard-clean-v1: interrupted rehearsal replacement requires recovery from %s\n' "$REHEARSAL_ARCHIVE" >&2
    fi
  fi
  release_operation_lock
  exit "$exit_status"
}

disarm_rehearsal_rollback() {
  REHEARSAL_ROLLBACK_ARMED=false
  trap - HUP INT TERM
  trap 'release_operation_lock' EXIT
}

replace_rehearsal() {
  [[ $# -eq 1 && "$1" == --confirm-no-live-users ]] || usage
  acquire_operation_lock
  trap 'replace_rehearsal_rollback_on_exit "$?"' EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  require_host_prerequisites
  [[ -d "$DATA_DIR" && ! -L "$DATA_DIR" ]] || \
    fail 'clean rehearsal data directory is unsafe'
  command -v mountpoint >/dev/null 2>&1 || \
    fail 'mountpoint is required to verify the retained rehearsal data volume'
  mountpoint -q "$DATA_DIR" || \
    fail 'clean rehearsal data directory is not the retained data mount'
  [[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || \
    fail 'clean rehearsal environment file is unsafe'
  REHEARSAL_ROLLBACK_ARMED=true
  REHEARSAL_RUNTIME_STOPPED=true
  compose_clean down --remove-orphans
  local archive_root="$DEPLOY_DIR/retired-rehearsals" archive archived_data
  archive="$archive_root/$(date -u +%Y%m%dT%H%M%SZ)"
  archived_data="$archive/clean-data"
  install -d -m 0700 "$archive_root"
  [[ ! -e "$archive" ]] || fail 'a rehearsal archive already exists for this second; retry later'
  install -d -m 0700 "$archive" "$archived_data"
  if ! cp -a -x "$DATA_DIR/." "$archived_data/" ||
    ! diff -qr "$DATA_DIR" "$archived_data" >/dev/null; then
    rm -rf -- "$archive"
    fail 'could not verify the rehearsal data archive; live data was left unchanged'
  fi
  rm -f "$archived_data/.authority-operation-lock/owner-pid"
  if [[ -d "$archived_data/.authority-operation-lock" ]] &&
    ! rmdir "$archived_data/.authority-operation-lock"; then
    rm -rf -- "$archive"
    fail 'the copied operation lock was not exact; live data was left unchanged'
  fi
  REHEARSAL_ARCHIVE="$archive"
  REHEARSAL_ARCHIVED_DATA="$archived_data"
  if ! mv "$ENV_FILE" "$archive/.env.clean-v1"; then
    fail 'could not archive the rehearsal environment; automatic rollback will run'
  fi
  REHEARSAL_DATA_MUTATED=true
  if ! find "$DATA_DIR" -xdev -depth -mindepth 1 \
    ! -path "$OPERATION_LOCK_DIR" \
    ! -path "$OPERATION_LOCK_DIR/*" \
    -delete; then
    fail 'could not clear the retired rehearsal; automatic rollback will run'
  fi
  disarm_rehearsal_rollback
  printf 'rehearsal_replaced=true\narchive=%s\nnext_action=Run prepare with the new exact release and onboarding inputs.\n' "$archive"
}

resume_bootstrap() {
  local slack_connected="$1"
  if [[ "$slack_connected" == true ]]; then
    compose_clean run --rm --no-deps --entrypoint node authority \
      "$SETUP_COMMAND" resume --state-dir /echo-clean/state
    return
  fi
  compose_clean run --rm --no-deps --entrypoint node authority \
    "$SETUP_COMMAND" resume --state-dir /echo-clean/state \
    < "$PRIVATE_DIR/slack-bot-token"
}

install_credentials() {
  compose_clean run --rm --no-deps --entrypoint node authority \
    "$SETUP_COMMAND" credentials-install \
    --state-dir /echo-clean/state \
    --granola-credential-file /echo-clean/private/granola-credential-source \
    --granola-owner-email-file /echo-clean/private/granola-owner-email \
    --llm-credential-file /echo-clean/private/llm-credential-source
}

install_credentials_quiet() {
  activation_compose_quiet run --rm --no-deps --entrypoint node authority \
    "$SETUP_COMMAND" credentials-install \
    --state-dir /echo-clean/state \
    --granola-credential-file /echo-clean/private/granola-credential-source \
    --granola-owner-email-file /echo-clean/private/granola-owner-email \
    --llm-credential-file /echo-clean/private/llm-credential-source
}

require_runtime_private_file() {
  local path="$1" label="$2"
  [[ -f "$path" && ! -L "$path" ]] || fail "$label destination is unsafe"
  [[ "$(portable_stat_uid "$path")" == "$RUNTIME_UID" ]] || \
    fail "$label destination is not runtime-user-owned"
  [[ "$(portable_stat_mode "$path")" == 600 ]] || \
    fail "$label destination is not mode 0600"
}

replace_runtime_private() {
  local source="$1" destination="$2" label="$3" temporary
  local destination_directory="${destination%/*}"
  temporary="$(mktemp "$destination_directory/.${label}.XXXXXX" 2>/dev/null)" || return 1
  if ! install -m 0600 "$source" "$temporary" >/dev/null 2>&1; then
    rm -f "$temporary" >/dev/null 2>&1 || true
    return 1
  fi
  if [[ "$EXECUTOR_UID" == 0 ]] && \
    ! chown "$RUNTIME_UID:$RUNTIME_GID" "$temporary" >/dev/null 2>&1; then
    rm -f "$temporary" >/dev/null 2>&1 || true
    return 1
  fi
  if ! mv -f "$temporary" "$destination" >/dev/null 2>&1; then
    rm -f "$temporary" >/dev/null 2>&1 || true
    return 1
  fi
}

backup_runtime_private() {
  local source="$1" backup="$2"
  install -m 0600 "$source" "$backup" >/dev/null 2>&1 || return 1
  if [[ "$EXECUTOR_UID" == 0 ]]; then
    chown "$RUNTIME_UID:$RUNTIME_GID" "$backup" >/dev/null 2>&1 || return 1
  fi
}

restore_provider_backups() {
  local granola_source_backup="$1" llm_source_backup="$2"
  local granola_active_backup="$3" llm_active_backup="$4"
  local granola_source_destination="$PRIVATE_DIR/granola-credential-source"
  local llm_source_destination="$PRIVATE_DIR/llm-credential-source"
  local active_directory="$DATA_DIR/state/credentials"
  replace_runtime_private \
      "$granola_source_backup" "$granola_source_destination" 'granola-credential' &&
    replace_runtime_private \
      "$llm_source_backup" "$llm_source_destination" 'llm-credential' &&
    replace_runtime_private \
      "$granola_active_backup" "$active_directory/granola-credential" 'granola-active' &&
    replace_runtime_private \
      "$llm_active_backup" "$active_directory/llm-credential" 'llm-active'
}

provider_rollback_and_verify() {
  ACTIVATION_ROLLBACK_FAILURE_STAGE=''
  if ! activation_compose_quiet down; then
    ACTIVATION_ROLLBACK_FAILURE_STAGE='stop'
    return 1
  fi
  if ! restore_provider_backups \
      "$ACTIVATION_GRANOLA_SOURCE_BACKUP" \
      "$ACTIVATION_LLM_SOURCE_BACKUP" \
      "$ACTIVATION_GRANOLA_ACTIVE_BACKUP" \
      "$ACTIVATION_LLM_ACTIVE_BACKUP"; then
    ACTIVATION_ROLLBACK_FAILURE_STAGE='restore'
    return 1
  fi
  if ! activation_compose_quiet up -d --no-build --wait --wait-timeout 90; then
    ACTIVATION_ROLLBACK_FAILURE_STAGE='start'
    return 1
  fi
  if ! running_authority; then
    ACTIVATION_ROLLBACK_FAILURE_STAGE='running'
    return 1
  fi
  if ! healthy_authority; then
    ACTIVATION_ROLLBACK_FAILURE_STAGE='health'
    return 1
  fi
  if ! authority_uses_accepted_image; then
    ACTIVATION_ROLLBACK_FAILURE_STAGE='image'
    return 1
  fi
  if ! wait_for_public_descriptor; then
    ACTIVATION_ROLLBACK_FAILURE_STAGE='descriptor'
    return 1
  fi
  return 0
}

remove_provider_rollback_copies() {
  rm -f \
    "$ACTIVATION_GRANOLA_SOURCE_BACKUP" \
    "$ACTIVATION_LLM_SOURCE_BACKUP" \
    "$ACTIVATION_GRANOLA_ACTIVE_BACKUP" \
    "$ACTIVATION_LLM_ACTIVE_BACKUP" >/dev/null 2>&1
}

disarm_provider_rollback() {
  trap - HUP INT TERM
  trap 'release_operation_lock' EXIT
}

activation_signal_exit() {
  local exit_status="$1"
  trap - HUP INT TERM
  if [[ "$ACTIVATION_CHILD_PID" =~ ^[0-9]+$ ]] && \
    kill -0 "$ACTIVATION_CHILD_PID" >/dev/null 2>&1; then
    kill -TERM "$ACTIVATION_CHILD_PID" >/dev/null 2>&1 || true
    wait "$ACTIVATION_CHILD_PID" >/dev/null 2>&1 || true
  fi
  ACTIVATION_CHILD_PID=''
  exit "$exit_status"
}

activation_rollback_on_exit() {
  local exit_status="${1:-1}"
  trap - EXIT HUP INT TERM
  if provider_rollback_and_verify >/dev/null 2>&1; then
    remove_provider_rollback_copies || true
    printf 'onboard-clean-v1: provider credential activation was interrupted; previous credentials were restored and verified\n' >&2
  else
    printf 'onboard-clean-v1: provider credential activation was interrupted; automatic rollback could not be verified at stage=%s and rollback copies were retained\n' "$ACTIVATION_ROLLBACK_FAILURE_STAGE" >&2
  fi
  release_operation_lock
  exit "$exit_status"
}

arm_provider_rollback() {
  ACTIVATION_GRANOLA_SOURCE_BACKUP="$1"
  ACTIVATION_LLM_SOURCE_BACKUP="$2"
  ACTIVATION_GRANOLA_ACTIVE_BACKUP="$3"
  ACTIVATION_LLM_ACTIVE_BACKUP="$4"
  trap 'activation_rollback_on_exit "$?"' EXIT
  trap 'activation_signal_exit 129' HUP
  trap 'activation_signal_exit 130' INT
  trap 'activation_signal_exit 143' TERM
}

activate_provider_credentials() {
  require_input_dir_argument "$@"
  require_host_prerequisites
  require_prepared
  acquire_operation_lock
  trap 'release_operation_lock' EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  if staged_candidate_present; then
    fail 'a candidate release is staged; finish its promotion or rollback before activating provider credentials'
  fi
  if ! check_provider_activation_input_dir; then
    fail 'provider activation input must contain exactly current-executor-owned mode-0600 granola-credential and llm-credential files in a mode-0700 directory'
  fi
  select_runtime_identity "$(setup_value runtime_user)"
  local granola_source_destination="$PRIVATE_DIR/granola-credential-source"
  local llm_source_destination="$PRIVATE_DIR/llm-credential-source"
  local active_directory="$DATA_DIR/state/credentials"
  local granola_active_destination="$active_directory/granola-credential"
  local llm_active_destination="$active_directory/llm-credential"
  require_runtime_private_file "$granola_source_destination" 'Granola credential source'
  require_runtime_private_file "$llm_source_destination" 'LLM credential source'
  require_runtime_private_file "$granola_active_destination" 'active Granola credential'
  require_runtime_private_file "$llm_active_destination" 'active LLM credential'
  require_image_present
  local status_json
  status_json="$(setup_status)"
  terminal_green "$status_json" || \
    fail 'provider credentials can activate only on a complete, healthy Authority using the accepted image'

  local granola_source_backup llm_source_backup
  local granola_active_backup llm_active_backup
  if ! granola_source_backup="$(mktemp "$PRIVATE_DIR/.granola-source.previous.XXXXXX" 2>/dev/null)" ||
    ! llm_source_backup="$(mktemp "$PRIVATE_DIR/.llm-source.previous.XXXXXX" 2>/dev/null)" ||
    ! granola_active_backup="$(mktemp "$active_directory/.granola-active.previous.XXXXXX" 2>/dev/null)" ||
    ! llm_active_backup="$(mktemp "$active_directory/.llm-active.previous.XXXXXX" 2>/dev/null)"; then
    rm -f "${granola_source_backup:-}" "${llm_source_backup:-}" \
      "${granola_active_backup:-}" "${llm_active_backup:-}" >/dev/null 2>&1 || true
    fail 'could not prepare private provider-credential rollback copies'
  fi
  if ! backup_runtime_private "$granola_source_destination" "$granola_source_backup" ||
    ! backup_runtime_private "$llm_source_destination" "$llm_source_backup" ||
    ! backup_runtime_private "$granola_active_destination" "$granola_active_backup" ||
    ! backup_runtime_private "$llm_active_destination" "$llm_active_backup"; then
    rm -f "$granola_source_backup" "$llm_source_backup" \
      "$granola_active_backup" "$llm_active_backup" >/dev/null 2>&1 || true
    fail 'could not prepare private provider-credential rollback copies'
  fi

  arm_provider_rollback \
    "$granola_source_backup" "$llm_source_backup" \
    "$granola_active_backup" "$llm_active_backup"

  if ! activation_compose_quiet down; then
    disarm_provider_rollback
    rm -f "$granola_source_backup" "$llm_source_backup" \
      "$granola_active_backup" "$llm_active_backup" >/dev/null 2>&1 || true
    fail 'could not stop the healthy Authority before provider-credential activation'
  fi

  local installed=false
  if replace_runtime_private \
      "$input_granola_credential" "$granola_source_destination" 'granola-credential' &&
    replace_runtime_private \
      "$input_llm_credential" "$llm_source_destination" 'llm-credential' &&
    install_credentials_quiet; then
    installed=true
  fi

  if [[ "$installed" == true ]] && \
    activation_compose_quiet up -d --no-build --wait --wait-timeout 90 && \
    running_authority && \
    healthy_authority && \
    authority_uses_accepted_image && \
    wait_for_public_descriptor; then
    disarm_provider_rollback
    if ! remove_provider_rollback_copies; then
      fail 'provider credentials activated, but private rollback copies could not be removed'
    fi
    printf 'provider_credentials_activated=true\n'
    printf 'release_id=%s\n' "$(release_field release-id)"
    printf 'authority_healthy=true\n'
    printf 'authority_exact_accepted_image=true\n'
    printf 'public_descriptor_healthy=true\n'
    return
  fi

  if provider_rollback_and_verify; then
    disarm_provider_rollback
    if ! remove_provider_rollback_copies; then
      fail 'provider credential activation failed; previous credentials were restored and verified, but private rollback copies could not be removed'
    fi
    fail 'provider credential activation failed; previous credentials were restored and verified'
  fi
  disarm_provider_rollback
  fail "provider credential activation failed; automatic rollback could not be verified at stage=$ACTIVATION_ROLLBACK_FAILURE_STAGE and rollback copies were retained"
}

finalize() {
  compose_clean run --rm --no-deps --entrypoint node authority \
    "$SETUP_COMMAND" finalize --state-dir /echo-clean/state
}

slack_interactivity_request_url() {
  printf '%s/v2/integrations/slack/interactions\n' "$(setup_value authority_url)"
}

print_slack_interactivity_action() {
  printf 'ACTION: In Slack App settings, enable Interactivity & Shortcuts, set Request URL to %s, and save it. Then create the bounded canary and rerun onboard-clean-v1.sh resume.\n' \
    "$(slack_interactivity_request_url)"
}

resume() {
  acquire_operation_lock
  trap 'release_operation_lock' EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  require_host_prerequisites
  require_prepared
  if staged_candidate_present; then
    fail 'a candidate release is staged; use update-clean-v1.sh status, then promote or roll it back before resuming accepted onboarding'
  fi
  ensure_image
  local status_json step loops=0
  while (( loops < 5 )); do
    status_json="$(setup_status)"
    step="$(next_step_from_status "$status_json")"
    case "$step" in
      run_bootstrap)
        bootstrap
        start_runtime
        ;;
      resume_bootstrap)
        resume_bootstrap "$(status_boolean "$status_json" slack_connected)"
        start_runtime
        ;;
      complete_founder_browser_login)
        start_runtime
        local initial_owner_invitation="$DATA_DIR/state/onboarding/founder-person-invitation.json" client_sha256 client_version release_id source_sha
        [[ -f "$initial_owner_invitation" && ! -L "$initial_owner_invitation" ]] || \
          fail 'initial-owner invitation is missing from the expected clean state path'
        client_sha256="$(release_field client-sha256)"
        client_version="$(release_field client-version)"
        release_id="$(release_field release-id)"
        source_sha="$(release_field source-sha)"
        printf 'ACTION: Privately transfer invitation %s, canonical accepted release record %s, and the verified Person onboarding kit matching that release to the initial-owner machine; preserve the invitation mode 0600. Do not use a preexisting global echo-brain command. Run "<release-matched-kit>/Start ECHO.command" <transferred-absolute-path>. If that kit reports an existing ECHO session and this invitation is for a different person, run "$HOME/Library/Application Support/ECHO/bin/echo-brain" person logout, then retry that same kit command.\n' \
          "$initial_owner_invitation" "$RELEASE_FILE"
        printf 'RELEASE-MATCHED-KIT: release_id=%s source_sha=%s client_version=%s client_artifact_sha256=%s\n' \
          "$release_id" "$source_sha" "$client_version" "$client_sha256"
        printf 'KIT-BUILD: If no verified kit was supplied, use a reviewed checkout at source_sha above and deploy/release/README.md. Obtain the artifact only from the privately transferred accepted release record, verify its SHA-256, build the macOS-arm64 kit with `npm run kit:person-onboarding -- --release <accepted-release.json> --artifact <exact-client.tgz> --app <matching-ECHO.app.zip> --output <private-kit.tar.gz>`, then use its Start ECHO.command command.\n'
        print_status "$(setup_status)"
        return
        ;;
      complete_founder_slack_link)
        start_runtime
        printf 'ACTION: On the initial-owner machine, run "$HOME/Library/Application Support/ECHO/bin/echo-brain" person slack-link and complete its one-time Slack code exchange.\n'
        print_status "$(setup_status)"
        return
        ;;
      install_provider_credentials)
        compose_clean down
        install_credentials
        ;;
      run_finalize)
        compose_clean down
        finalize
        start_runtime
        print_slack_interactivity_action
        print_status "$(setup_status)"
        return
        ;;
      ready_to_start)
        start_runtime
        printf 'CANARY: on the exact staging host, run ./update-clean-v1.sh canary; approve its private Slack card; then run "$HOME/Library/Application Support/ECHO/bin/echo-brain" person records --limit 20 and "$HOME/Library/Application Support/ECHO/bin/echo-brain" person records --query "SYNTHETIC STAGING CANARY". Rerun onboard-clean-v1.sh resume, then onboard-clean-v1.sh status. The staging-only synthetic receipt is release-bound; terminal green still requires one positive Layer 1 read and one positive Layer 2 search after the approved record and current generation.\n'
        print_status "$(setup_status)"
        return
        ;;
      complete)
        start_runtime
        status_json="$(setup_status)"
        terminal_green "$status_json" || \
          fail 'durable canary evidence is complete, but Authority is not running, healthy, and on the accepted image'
        printf 'onboarding_complete=true\n'
        print_status "$status_json"
        return
        ;;
      recover_setup_plan)
        fail 'initial-owner setup state exists without a recoverable setup plan; stop and recover the clean state before retrying'
        ;;
      *) fail "unexpected initial-owner setup next_step: $step" ;;
    esac
    ((loops += 1))
  done
  fail 'onboarding did not reach a human-action or ready stage after five durable transitions'
}

status() {
  require_host_prerequisites
  require_prepared
  if staged_candidate_present; then
    print_staged_candidate_status
    return
  fi
  require_image_present
  local status_json
  status_json="$(setup_status)"
  print_status "$status_json"
}

case "${1:-}" in
  doctor) shift; doctor "$@" ;;
  prepare) shift; prepare "$@" ;;
  activate-provider-credentials) shift; activate_provider_credentials "$@" ;;
  replace-rehearsal) shift; replace_rehearsal "$@" ;;
  resume) [[ $# -eq 1 ]] || usage; resume ;;
  status) [[ $# -eq 1 ]] || usage; status ;;
  *) usage ;;
esac
