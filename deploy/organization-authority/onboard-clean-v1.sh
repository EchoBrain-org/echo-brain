#!/usr/bin/env bash
# One-time clean-v1 Authority preparation plus resumable founder onboarding.
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
RELEASE_TOOL="$DEPLOY_DIR/../release/clean-v1-release.py"
FOUNDER_MAIN="services/organization-authority/dist/clean-founder-main.js"

fail() { printf 'onboard-clean-v1: %s\n' "$*" >&2; exit 1; }

usage() {
  cat >&2 <<'EOF'
usage:
  onboard-clean-v1.sh prepare \
    --release <canonical-release.json> \
    --organization-name <name> --owner-display-name <name> --owner-email <email> \
    --authority-host <dns-name> --slack-approval-channel-id <channel-id> \
    --oidc-config-file <private-file> --oidc-client-secret-file <private-file> \
    --slack-bot-token-file <private-file> --granola-credential-file <private-file> \
    --llm-credential-file <private-file>
  onboard-clean-v1.sh replace-rehearsal --confirm-no-live-users
  onboard-clean-v1.sh resume
  onboard-clean-v1.sh status
EOF
  exit 2
}

require_host_prerequisites() {
  command -v docker >/dev/null 2>&1 || fail 'Docker is not installed. Provision Docker, Cloudflare Tunnel, and registry access before using this wrapper.'
  docker compose version >/dev/null 2>&1 || fail 'Docker Compose v2 is unavailable. Provision Docker Compose before using this wrapper.'
  command -v python3 >/dev/null 2>&1 || fail 'python3 is required for canonical release validation.'
  [[ -f "$RELEASE_TOOL" ]] || fail 'clean-v1 release validator is missing from deploy/release.'
}

compose_clean() {
  docker compose --env-file "$ENV_FILE" \
    -f "$DEPLOY_DIR/compose.clean-v1.yaml" \
    -f "$DEPLOY_DIR/compose.clean-v1.ec2.yaml" "$@"
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

copy_exact_private() {
  local source="$1" destination="$2" label="$3"
  private_source "$source" "$label"
  if [[ -e "$destination" ]]; then
    [[ -f "$destination" && ! -L "$destination" ]] || fail "existing $label destination is unsafe"
    cmp -s "$source" "$destination" || fail "$label conflicts with the existing clean onboarding input"
    chmod 0600 "$destination"
    return
  fi
  install -m 0600 "$source" "$destination"
}

write_exact_private() {
  local destination="$1" value="$2" label="$3" temporary
  temporary="$(mktemp "$PRIVATE_DIR/.${label}.XXXXXX")"
  chmod 0600 "$temporary"
  printf '%s' "$value" > "$temporary"
  if [[ -e "$destination" ]]; then
    [[ -f "$destination" && ! -L "$destination" ]] || fail "existing $label destination is unsafe"
    cmp -s "$temporary" "$destination" || fail "$label conflicts with the existing clean onboarding input"
    chmod 0600 "$destination"
    rm -f "$temporary"
    return
  fi
  mv "$temporary" "$destination"
}

write_exact_file() {
  local destination="$1" content="$2" label="$3" temporary
  temporary="$(mktemp "${destination}.XXXXXX")"
  chmod 0600 "$temporary"
  printf '%s' "$content" > "$temporary"
  if [[ -e "$destination" ]]; then
    [[ -f "$destination" && ! -L "$destination" ]] || fail "existing $label is unsafe"
    cmp -s "$temporary" "$destination" || fail "$label conflicts with the existing clean onboarding configuration"
    chmod 0600 "$destination"
    rm -f "$temporary"
    return
  fi
  mv "$temporary" "$destination"
}

require_prepared() {
  [[ -f "$SETUP_FILE" && ! -L "$SETUP_FILE" ]] || fail 'run prepare first'
  [[ -f "$RELEASE_FILE" && ! -L "$RELEASE_FILE" ]] || fail 'clean release record is missing; run prepare again with the same record'
  [[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || fail 'clean Compose environment is missing; run prepare again with the same inputs'
  python3 "$RELEASE_TOOL" validate "$RELEASE_FILE" >/dev/null || fail 'persisted release record is no longer canonical clean-v1'
  for required in oidc-config.json oidc-client-secret slack-bot-token granola-credential-source granola-owner-email llm-credential-source; do
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

founder_status() {
  compose_clean run --rm --no-deps --entrypoint node authority \
    "$FOUNDER_MAIN" status --state-dir /echo-clean/state
}

next_step_from_status() {
  python3 -c 'import json, sys; value=json.load(sys.stdin); step=value.get("next_step"); assert isinstance(step, str); print(step)' \
    <<<"$1" || fail 'clean founder status was not the expected safe JSON'
}

status_boolean() {
  local status_json="$1" field="$2"
  python3 -c 'import json, sys; value=json.load(sys.stdin); result=value.get(sys.argv[1]); assert type(result) is bool; print("true" if result else "false")' \
    "$field" <<<"$status_json" || fail "clean founder status has no boolean $field"
}

start_runtime() {
  compose_clean up -d --no-build --wait --wait-timeout 90
}

running_authority() {
  [[ -n "$(compose_clean ps --status running -q authority)" ]]
}

print_status() {
  local status_json="$1"
  if running_authority; then
    printf 'authority_running=true\n'
  else
    printf 'authority_running=false\n'
  fi
  printf 'status_json=%s\n' "$status_json"
}

prepare() {
  local release='' organization_name='' owner_display_name='' owner_email='' authority_host='' channel='' oidc_config='' oidc_secret='' slack_token='' granola_credential='' llm_credential=''
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --release) release="${2:-}"; shift 2 ;;
      --organization-name) organization_name="${2:-}"; shift 2 ;;
      --owner-display-name) owner_display_name="${2:-}"; shift 2 ;;
      --owner-email) owner_email="${2:-}"; shift 2 ;;
      --authority-host) authority_host="${2:-}"; shift 2 ;;
      --slack-approval-channel-id) channel="${2:-}"; shift 2 ;;
      --oidc-config-file) oidc_config="${2:-}"; shift 2 ;;
      --oidc-client-secret-file) oidc_secret="${2:-}"; shift 2 ;;
      --slack-bot-token-file) slack_token="${2:-}"; shift 2 ;;
      --granola-credential-file) granola_credential="${2:-}"; shift 2 ;;
      --llm-credential-file) llm_credential="${2:-}"; shift 2 ;;
      *) usage ;;
    esac
  done
  [[ -n "$release" && -n "$organization_name" && -n "$owner_display_name" && -n "$owner_email" && -n "$authority_host" && -n "$channel" && -n "$oidc_config" && -n "$oidc_secret" && -n "$slack_token" && -n "$granola_credential" && -n "$llm_credential" ]] || usage
  require_host_prerequisites
  private_source "$release" 'release record'
  no_newline_value "$organization_name" 'organization name'
  no_newline_value "$owner_display_name" 'owner display name'
  no_newline_value "$owner_email" 'owner email'
  no_newline_value "$authority_host" 'Authority host'
  no_newline_value "$channel" 'Slack approval channel ID'
  python3 "$RELEASE_TOOL" validate "$release" >/dev/null
  install -d -m 0700 "$DATA_DIR" "$PRIVATE_DIR" "$RELEASE_DIR"
  chmod 0700 "$DATA_DIR" "$PRIVATE_DIR" "$RELEASE_DIR"
  copy_exact_private "$release" "$RELEASE_FILE" 'release record'
  local image uid gid authority_url setup env
  image="$(release_field authority-image)"
  uid="$(id -u)"
  gid="$(id -g)"
  authority_url="https://$authority_host"
  setup="organization_name=$organization_name
owner_display_name=$owner_display_name
owner_email=$owner_email
authority_host=$authority_host
authority_url=$authority_url
slack_approval_channel_id=$channel
release_id=$(release_field release-id)
authority_image=$image
artifact_revision=$(release_field source-sha)
authority_uid=$uid
authority_gid=$gid"
  env="ECHO_CLEAN_AUTHORITY_HOST=$authority_host
ECHO_CLEAN_AUTHORITY_URL=$authority_url
ECHO_CLEAN_AUTHORITY_UID=$uid
ECHO_CLEAN_AUTHORITY_GID=$gid
ECHO_CLEAN_AUTHORITY_IMAGE=$image
ECHO_CLEAN_SLACK_APPROVAL_CHANNEL_ID=$channel
ECHO_CLEAN_OWNER_EMAIL=$owner_email"
  write_exact_file "$SETUP_FILE" "$setup" 'setup configuration'
  write_exact_file "$ENV_FILE" "$env" 'Compose environment'
  copy_exact_private "$oidc_config" "$PRIVATE_DIR/oidc-config.json" 'OIDC configuration'
  copy_exact_private "$oidc_secret" "$PRIVATE_DIR/oidc-client-secret" 'OIDC client secret'
  copy_exact_private "$slack_token" "$PRIVATE_DIR/slack-bot-token" 'Slack bot token'
  copy_exact_private "$granola_credential" "$PRIVATE_DIR/granola-credential-source" 'Granola credential'
  copy_exact_private "$llm_credential" "$PRIVATE_DIR/llm-credential-source" 'LLM credential'
  write_exact_private "$PRIVATE_DIR/granola-owner-email" "$owner_email" 'Granola owner email'
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
    "$FOUNDER_MAIN" bootstrap \
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

replace_rehearsal() {
  [[ $# -eq 1 && "$1" == --confirm-no-live-users ]] || usage
  require_host_prerequisites
  require_prepared
  [[ -d "$DATA_DIR" && ! -L "$DATA_DIR" ]] || \
    fail 'clean rehearsal data directory is unsafe'
  compose_clean down --remove-orphans
  local archive_root="$DEPLOY_DIR/retired-rehearsals" archive
  archive="$archive_root/$(date -u +%Y%m%dT%H%M%SZ)"
  install -d -m 0700 "$archive_root"
  [[ ! -e "$archive" ]] || fail 'a rehearsal archive already exists for this second; retry later'
  install -d -m 0700 "$archive"
  mv "$DATA_DIR" "$archive/clean-data"
  mv "$ENV_FILE" "$archive/.env.clean-v1"
  printf 'rehearsal_replaced=true\narchive=%s\nnext_action=Run prepare with the new exact release and onboarding inputs.\n' "$archive"
}

resume_bootstrap() {
  local slack_connected="$1"
  if [[ "$slack_connected" == true ]]; then
    compose_clean run --rm --no-deps --entrypoint node authority \
      "$FOUNDER_MAIN" resume --state-dir /echo-clean/state
    return
  fi
  compose_clean run --rm --no-deps --entrypoint node authority \
    "$FOUNDER_MAIN" resume --state-dir /echo-clean/state \
    < "$PRIVATE_DIR/slack-bot-token"
}

install_credentials() {
  compose_clean run --rm --no-deps --entrypoint node authority \
    "$FOUNDER_MAIN" credentials-install \
    --state-dir /echo-clean/state \
    --granola-credential-file /echo-clean/private/granola-credential-source \
    --granola-owner-email-file /echo-clean/private/granola-owner-email \
    --llm-credential-file /echo-clean/private/llm-credential-source
}

finalize() {
  compose_clean run --rm --no-deps --entrypoint node authority \
    "$FOUNDER_MAIN" finalize --state-dir /echo-clean/state
}

resume() {
  require_host_prerequisites
  require_prepared
  ensure_image
  local status_json step loops=0
  while (( loops < 5 )); do
    status_json="$(founder_status)"
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
        local founder_invitation="$DATA_DIR/state/onboarding/founder-person-invitation.json"
        [[ -f "$founder_invitation" && ! -L "$founder_invitation" ]] || \
          fail 'founder invitation is missing from the expected clean state path'
        printf 'ACTION: Privately transfer %s to the founder machine, preserve mode 0600, then run echo-brain person login --invitation <transferred-absolute-path>.\n' "$founder_invitation"
        print_status "$(founder_status)"
        return
        ;;
      complete_founder_slack_link)
        start_runtime
        printf 'ACTION: On the founder machine, run echo-brain person slack-link and complete its one-time Slack code exchange.\n'
        print_status "$(founder_status)"
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
        ;;
      ready_to_start)
        start_runtime
        printf 'CANARY: create one new Granola note with a unique marker; approve its Slack card; then run echo-brain person records --limit 20 and echo-brain person records --query <marker>. Reject a second card and confirm it appears in neither result.\n'
        print_status "$(founder_status)"
        return
        ;;
      recover_setup_plan)
        fail 'clean founder state exists without a recoverable setup plan; stop and recover the clean state before retrying'
        ;;
      *) fail "unexpected clean founder next_step: $step" ;;
    esac
    ((loops += 1))
  done
  fail 'onboarding did not reach a human-action or ready stage after five durable transitions'
}

status() {
  require_host_prerequisites
  require_prepared
  require_image_present
  print_status "$(founder_status)"
}

case "${1:-}" in
  prepare) shift; prepare "$@" ;;
  replace-rehearsal) shift; replace_rehearsal "$@" ;;
  resume) [[ $# -eq 1 ]] || usage; resume ;;
  status) [[ $# -eq 1 ]] || usage; status ;;
  *) usage ;;
esac
