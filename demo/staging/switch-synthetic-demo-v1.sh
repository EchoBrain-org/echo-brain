#!/usr/bin/env bash
set -euo pipefail

DEMO_ROOT="${ECHO_DEMO_ROOT:-/srv/echo-synthetic-demo-v1}"
CLEAN_ROOT="${ECHO_DEMO_CLEAN_ROOT:-/srv/echo-authority-clean-v1}"
BUNDLE_ROOT="${ECHO_DEMO_BUNDLE_ROOT:-$DEMO_ROOT/bundle}"
DEMO_DATA_ROOT="${ECHO_DEMO_DATA_ROOT:-$DEMO_ROOT/runtime}"
COMPOSE_FILE="$BUNDLE_ROOT/demo/staging/compose.synthetic-demo-v1.yaml"
FIXTURE_PREPARER="$BUNDLE_ROOT/demo/staging/prepare-fixtures.mjs"
DEMO_ENV="$DEMO_ROOT/private/runtime.env"
CLEAN_CONFIG="$CLEAN_ROOT/clean-data/private/onboard-clean-v1.conf"
CLEAN_PRIVATE="$CLEAN_ROOT/clean-data/private"
CLEAN_OPERATION_LOCK="$CLEAN_ROOT/clean-data/.authority-operation-lock"
DEMO_INTERLOCK="$CLEAN_OPERATION_LOCK/synthetic-demo-switchover-v1"
RESTORE_ARMED=false

fail() {
  printf 'synthetic-demo staging: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat >&2 <<'EOF'
usage:
  switch-synthetic-demo-v1.sh prepare --image <immutable-ecr-digest> --source-sha <40-hex>
  switch-synthetic-demo-v1.sh bootstrap
  switch-synthetic-demo-v1.sh start-setup
  switch-synthetic-demo-v1.sh setup-status
  switch-synthetic-demo-v1.sh start-demo
  switch-synthetic-demo-v1.sh preview-slack --image <immutable-ecr-digest> --source-sha <40-hex> --replay <absolute-json> --replay-sha <sha256:hex> (--meeting-id <id>|--all)
  switch-synthetic-demo-v1.sh restore-clean
  switch-synthetic-demo-v1.sh status
EOF
  exit 2
}

require_root() {
  [[ "$(id -u)" == 0 ]] || fail 'run only through a bounded root SSM command'
}

require_regular_file() {
  local path="$1" label="$2"
  [[ -f "$path" && ! -L "$path" ]] || fail "$label is missing or unsafe"
}

clean_value() {
  local key="$1" value count
  count="$(grep -c "^${key}=" "$CLEAN_CONFIG" || true)"
  [[ "$count" == 1 ]] || fail "accepted clean configuration has no unique $key"
  value="$(sed -n "s/^${key}=//p" "$CLEAN_CONFIG")"
  [[ -n "$value" && "$value" != *$'\n'* && "$value" != *$'\r'* ]] || \
    fail "accepted clean configuration has an invalid $key"
  printf '%s' "$value"
}

compose_demo() {
  docker compose --env-file "$DEMO_ENV" -f "$COMPOSE_FILE" "$@"
}

compose_clean() {
  docker compose --env-file "$CLEAN_ROOT/.env.clean-v1" \
    -f "$CLEAN_ROOT/compose.clean-v1.yaml" \
    -f "$CLEAN_ROOT/compose.clean-v1.ec2.yaml" "$@"
}

accepted_status() {
  local status
  status="$($CLEAN_ROOT/update-clean-v1.sh status)" || \
    fail 'accepted clean release status failed'
  python3 -c '
import json, sys
value = json.load(sys.stdin)
if value != {
    "ok": True,
    "accepted_release_present": True,
    "candidate_staged": False,
    "runtime_matches_accepted": True,
}:
    raise SystemExit(1)
' <<<"$status" || fail 'accepted clean release is not the exact healthy release without a candidate'
}

clean_is_stopped() {
  [[ -z "$(compose_clean ps --status running -q authority)" ]] && \
    [[ -z "$(compose_clean ps --status running -q proxy)" ]]
}

demo_is_stopped() {
  [[ -z "$(compose_demo --profile setup --profile demo --profile preview ps --status running -q)" ]]
}

demo_source_sha() {
  local source_sha count
  count="$(grep -c '^ECHO_DEMO_SOURCE_SHA=' "$DEMO_ENV" || true)"
  [[ "$count" == 1 ]] || fail 'demo runtime environment has no unique source SHA'
  source_sha="$(sed -n 's/^ECHO_DEMO_SOURCE_SHA=//p' "$DEMO_ENV")"
  [[ "$source_sha" =~ ^[0-9a-f]{40}$ ]] || fail 'demo runtime environment source SHA is invalid'
  printf '%s' "$source_sha"
}

replay_sha256() {
  local path="$1"
  python3 - "$path" <<'PY'
import hashlib
import sys
with open(sys.argv[1], "rb") as handle:
    print("sha256:" + hashlib.file_digest(handle, "sha256").hexdigest())
PY
}

demo_interlock_held() {
  [[ -d "$CLEAN_OPERATION_LOCK" && ! -L "$CLEAN_OPERATION_LOCK" ]] && \
    [[ -f "$DEMO_INTERLOCK" && ! -L "$DEMO_INTERLOCK" ]] && \
    [[ "$(cat "$DEMO_INTERLOCK")" == "$(demo_source_sha)" ]]
}

acquire_demo_interlock() {
  [[ ! -e "$CLEAN_OPERATION_LOCK" ]] || fail 'another Authority operation is active'
  mkdir -m 0700 "$CLEAN_OPERATION_LOCK" || fail 'could not acquire the Authority switchover interlock'
  umask 077
  if ! printf '%s\n' "$(demo_source_sha)" >"$DEMO_INTERLOCK"; then
    [[ ! -e "$DEMO_INTERLOCK" ]] || unlink "$DEMO_INTERLOCK" >/dev/null 2>&1 || true
    rmdir "$CLEAN_OPERATION_LOCK" >/dev/null 2>&1 || true
    fail 'could not record the Authority switchover interlock'
  fi
}

release_demo_interlock() {
  demo_interlock_held || fail 'the synthetic-demo switchover interlock is missing or unsafe'
  [[ "$(find "$CLEAN_OPERATION_LOCK" -mindepth 1 -maxdepth 1 -printf '%f\n')" == \
    'synthetic-demo-switchover-v1' ]] || \
    fail 'the Authority operation lock contains unexpected state'
  unlink "$DEMO_INTERLOCK" || fail 'could not remove the synthetic-demo switchover marker'
  rmdir "$CLEAN_OPERATION_LOCK" || fail 'could not release the Authority switchover interlock'
}

accepted_public_descriptor() {
  local descriptor_url
  descriptor_url="https://$(clean_value authority_host)/v1/authority-descriptor"
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

wait_for_accepted_public_descriptor() {
  local attempt
  for attempt in $(seq 1 18); do
    if accepted_public_descriptor; then
      return
    fi
    [[ "$attempt" == 18 ]] || sleep 5
  done
  return 1
}

restore_clean_runtime() {
  if ! demo_interlock_held; then
    [[ ! -e "$CLEAN_OPERATION_LOCK" ]] || \
      fail 'another Authority operation is active; accepted clean runtime was not started'
    acquire_demo_interlock
  fi
  if [[ -f "$DEMO_ENV" && ! -L "$DEMO_ENV" ]]; then
    compose_demo --profile setup --profile demo --profile preview down --remove-orphans >/dev/null || \
      fail 'demo teardown failed; accepted clean runtime was not started'
    demo_is_stopped || fail 'demo containers are still running; accepted clean runtime was not started'
  fi
  compose_clean up -d --no-build --wait --wait-timeout 90 || \
    fail 'accepted clean runtime did not restart under the switchover interlock'
  wait_for_accepted_public_descriptor || fail 'accepted clean public descriptor was not restored'
  release_demo_interlock
  accepted_status
}

restore_on_exit() {
  local exit_status="${1:-1}"
  trap - EXIT HUP INT TERM
  if [[ "$RESTORE_ARMED" == true ]]; then
    if restore_clean_runtime; then
      printf 'synthetic-demo staging: interrupted transition restored the accepted clean runtime\n' >&2
    else
      printf 'synthetic-demo staging: interrupted transition requires manual recovery\n' >&2
    fi
  fi
  exit "$exit_status"
}

arm_restore() {
  RESTORE_ARMED=true
  trap 'restore_on_exit "$?"' EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

disarm_restore() {
  RESTORE_ARMED=false
  trap - EXIT HUP INT TERM
}

prepare() {
  [[ "${1:-}" == '--image' && -n "${2:-}" && "${3:-}" == '--source-sha' && -n "${4:-}" && $# -eq 4 ]] || usage
  local image="$2" source_sha="$4" runtime_user runtime_uid runtime_gid
  local authority_host owner_email temporary_env image_label image_platform

  [[ "$source_sha" =~ ^[0-9a-f]{40}$ ]] || fail 'source SHA must be exactly 40 lowercase hex characters'
  [[ "$image" =~ ^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com/echo/organization-authority@sha256:[0-9a-f]{64}$ ]] || \
    fail 'image must be the immutable organization-authority ECR digest'
  require_regular_file "$COMPOSE_FILE" 'demo Compose file'
  require_regular_file "$FIXTURE_PREPARER" 'fixture preparer'
  require_regular_file "$CLEAN_CONFIG" 'accepted clean configuration'
  accepted_status
  [[ ! -e "$CLEAN_OPERATION_LOCK" ]] || \
    fail 'another Authority operation is active'

  runtime_user="$(clean_value runtime_user)"
  runtime_uid="$(id -u "$runtime_user")"
  runtime_gid="$(id -g "$runtime_user")"
  [[ "$runtime_uid" != 0 && "$runtime_gid" != 0 ]] || fail 'demo runtime identity must be non-root'
  authority_host="$(clean_value authority_host)"
  owner_email="$(clean_value owner_email)"

  docker pull "$image" >/dev/null
  image_label="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image")"
  image_platform="$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")"
  [[ "$image_label" == "$source_sha" ]] || fail 'image revision label does not match the source SHA'
  [[ "$image_platform" == 'linux/arm64' ]] || fail 'demo image is not linux/arm64'

  [[ ! -e "$DEMO_DATA_ROOT/state" && ! -e "$DEMO_DATA_ROOT/meetings" && ! -e "$DEMO_ENV" ]] || \
    fail 'an isolated demo rehearsal already exists; preserve and archive it before creating another'
  install -d -o "$runtime_uid" -g "$runtime_gid" -m 0700 "$DEMO_DATA_ROOT"
  install -d -o "$runtime_uid" -g "$runtime_gid" -m 0700 "$DEMO_DATA_ROOT/meetings"
  install -d -o root -g root -m 0700 "$DEMO_ROOT/private"
  docker run --rm --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges \
    --user "$runtime_uid:$runtime_gid" \
    --mount "type=bind,src=$BUNDLE_ROOT,dst=/echo-demo/bundle,readonly" \
    --mount "type=bind,src=$DEMO_DATA_ROOT/meetings,dst=/echo-demo/meetings" \
    --entrypoint node \
    "$image" \
    /echo-demo/bundle/demo/staging/prepare-fixtures.mjs \
    --source /echo-demo/bundle/demo/meetings \
    --output /echo-demo/meetings \
    --owner "$owner_email"

  temporary_env="$DEMO_ROOT/private/.runtime.env.installing"
  umask 077
  {
    printf 'ECHO_DEMO_AUTHORITY_IMAGE=%s\n' "$image"
    printf 'ECHO_DEMO_SOURCE_SHA=%s\n' "$source_sha"
    printf 'ECHO_DEMO_RELEASE_ID=synthetic-demo-%s\n' "${source_sha:0:12}"
    printf 'ECHO_DEMO_UID=%s\n' "$runtime_uid"
    printf 'ECHO_DEMO_GID=%s\n' "$runtime_gid"
    printf 'ECHO_DEMO_ROOT=%s\n' "$DEMO_ROOT"
    printf 'ECHO_DEMO_DATA_ROOT=%s\n' "$DEMO_DATA_ROOT"
    printf 'ECHO_DEMO_CLEAN_ROOT=%s\n' "$CLEAN_ROOT"
    printf 'ECHO_DEMO_BUNDLE_ROOT=%s\n' "$BUNDLE_ROOT"
    printf 'ECHO_DEMO_AUTHORITY_HOST=%s\n' "$authority_host"
  } >"$temporary_env"
  chmod 0600 "$temporary_env"
  mv "$temporary_env" "$DEMO_ENV"
  compose_demo --profile setup --profile demo config >/dev/null
  printf 'prepared=true\nsource_sha=%s\nimage=%s\nnext_action=Run bootstrap while clean-live remains active.\n' \
    "$source_sha" "$image"
}

bootstrap() {
  [[ $# -eq 0 ]] || usage
  accepted_status
  require_regular_file "$DEMO_ENV" 'demo runtime environment'
  local organization_name owner_display_name owner_email authority_host channel
  organization_name="$(clean_value organization_name)"
  owner_display_name="$(clean_value owner_display_name)"
  owner_email="$(clean_value owner_email)"
  authority_host="$(clean_value authority_host)"
  channel="$(clean_value slack_approval_channel_id)"
  require_regular_file "$CLEAN_PRIVATE/slack-bot-token" 'Slack bot token source'

  compose_demo --profile setup run --rm --no-deps --entrypoint node setup-authority \
    services/organization-authority/dist/clean-founder-main.js bootstrap \
    --state-dir /echo-demo/state \
    --organization-name "$organization_name" \
    --owner-display-name "$owner_display_name" \
    --owner-email "$owner_email" \
    --authority-url "https://$authority_host" \
    --oidc-config /echo-source-private/oidc-config.json \
    --slack-approval-channel-id "$channel" \
    --artifact-revision "$(sed -n 's/^ECHO_DEMO_SOURCE_SHA=//p' "$DEMO_ENV")" \
    <"$CLEAN_PRIVATE/slack-bot-token"
  printf 'bootstrapped=true\nnext_action=Run start-setup, then complete the owner OIDC login and Slack link.\n'
}

start_setup() {
  [[ $# -eq 0 ]] || usage
  accepted_status
  require_regular_file "$DEMO_DATA_ROOT/state/onboarding/clean-founder-v1.json" 'demo setup manifest'
  acquire_demo_interlock
  arm_restore
  compose_clean stop proxy authority >/dev/null || fail 'could not stop the accepted clean runtime'
  clean_is_stopped || fail 'accepted clean runtime did not stop'
  compose_demo --profile setup up -d --no-build --wait --wait-timeout 90 \
    setup-authority setup-proxy || fail 'demo setup runtime failed'
  disarm_restore
  printf 'setup_runtime_ready=true\n'
  printf 'invitation_path=%s\n' "$DEMO_DATA_ROOT/state/onboarding/founder-person-invitation.json"
  printf 'next_action=Securely transfer the new invitation, complete owner login and Slack link, then run setup-status.\n'
}

setup_status() {
  [[ $# -eq 0 ]] || usage
  demo_interlock_held || fail 'the synthetic-demo switchover interlock is not held'
  clean_is_stopped || fail 'setup status requires the accepted clean runtime to remain stopped'
  compose_demo --profile setup exec -T setup-authority node \
    services/organization-authority/dist/clean-founder-main.js status \
    --state-dir /echo-demo/state
}

start_demo() {
  [[ $# -eq 0 ]] || usage
  demo_interlock_held || fail 'the synthetic-demo switchover interlock is not held'
  clean_is_stopped || fail 'demo start refuses to run while the accepted clean runtime is active'
  arm_restore
  local status readiness attempt
  status="$(compose_demo --profile setup exec -T setup-authority node \
    services/organization-authority/dist/clean-founder-main.js status \
    --state-dir /echo-demo/state)"
  python3 -c '
import json, sys
value = json.load(sys.stdin)
required = (
    value.get("genesis_published") is True
    and value.get("founder_oidc_bound") is True
    and value.get("founder_slack_link_active") is True
    and value.get("slack_connected") is True
    and value.get("granola_admission_present") is False
)
raise SystemExit(0 if required else 1)
' <<<"$status" || fail 'demo owner onboarding is incomplete or Granola was admitted'

  if ! compose_demo --profile setup down --remove-orphans >/dev/null; then
    fail 'demo setup runtime did not stop'
  fi
  if ! compose_demo --profile setup run --rm --no-deps --entrypoint node setup-authority \
    services/organization-authority/dist/clean-founder-main.js credentials-install \
    --state-dir /echo-demo/state \
    --granola-credential-file /echo-source-private/granola-credential \
    --granola-owner-email-file /echo-source-private/granola-owner-email \
    --llm-credential-file /echo-source-private/llm-credential; then
    fail 'demo credential installation failed'
  fi
  status="$(compose_demo --profile setup run --rm --no-deps --entrypoint node setup-authority \
    services/organization-authority/dist/clean-founder-main.js status \
    --state-dir /echo-demo/state)"
  python3 -c '
import json, sys
value = json.load(sys.stdin)
required = (
    value.get("founder_oidc_bound") is True
    and value.get("founder_slack_link_active") is True
    and value.get("granola_credentials_valid") is True
    and value.get("granola_admission_present") is False
)
raise SystemExit(0 if required else 1)
' <<<"$status" || fail 'demo credential state is incomplete or Granola was admitted'
  if ! compose_demo --profile demo run --rm --no-deps --entrypoint node demo-authority \
    services/organization-authority/dist/synthetic-demo-main.js admit \
    --state-dir /echo-demo/state \
    --meetings-dir /echo-demo/meetings; then
    fail 'synthetic source admission failed'
  fi

  if ! compose_demo --profile demo up -d --no-build --wait --wait-timeout 90 \
    demo-authority demo-proxy; then
    fail 'synthetic demo failed health checks'
  fi
  readiness=''
  for attempt in $(seq 1 30); do
    readiness="$(compose_demo --profile demo logs --no-color demo-authority 2>&1 || true)"
    if grep -q '"kind":"echo-synthetic-demo-runtime-ready-v1","processing":"active"' <<<"$readiness"; then
      printf 'demo_runtime_ready=true\nprocessing=active\n'
      printf 'next_action=Run the live Slack and Ask ECHO rehearsal, then restore-clean.\n'
      disarm_restore
      return
    fi
    sleep 1
  done
  fail 'synthetic demo did not report active processing'
}

preview_slack() {
  [[ "${1:-}" == '--image' && -n "${2:-}" && "${3:-}" == '--source-sha' && -n "${4:-}" && \
    "${5:-}" == '--replay' && -n "${6:-}" && "${7:-}" == '--replay-sha' && -n "${8:-}" ]] || usage
  local image="$2" source_sha="$4" replay="$6" replay_sha="$8" mode="${9:-}" meeting_id="${10:-}"
  [[ "$image" =~ ^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com/echo/organization-authority@sha256:[0-9a-f]{64}$ ]] || \
    fail 'image must be the immutable organization-authority ECR digest'
  [[ "$source_sha" =~ ^[0-9a-f]{40}$ ]] || fail 'source SHA must be exactly 40 lowercase hex characters'
  [[ "$replay_sha" =~ ^sha256:[0-9a-f]{64}$ ]] || fail 'replay SHA must be sha256 plus 64 lowercase hex characters'
  [[ -f "$replay" && ! -L "$replay" && "$replay" = /* ]] || fail 'replay must be an absolute regular file'
  if [[ "$mode" == '--meeting-id' && -n "$meeting_id" && $# -eq 10 ]]; then
    :
  elif [[ "$mode" == '--all' && $# -eq 9 ]]; then
    :
  else
    usage
  fi
  require_regular_file "$DEMO_ENV" 'demo runtime environment'
  [[ "$replay_sha" == "$(replay_sha256 "$replay")" ]] || fail 'replay SHA does not match the replay file'
  [[ ! -e "$CLEAN_OPERATION_LOCK" ]] || fail 'another Authority operation is active'
  accepted_status
  accepted_public_descriptor || fail 'accepted clean runtime is not healthy'
  demo_is_stopped || fail 'Slack preview requires all demo containers to be stopped'
  local image_label image_platform
  docker pull "$image" >/dev/null
  image_label="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image")"
  image_platform="$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")"
  [[ "$image_label" == "$source_sha" ]] || fail 'image revision label does not match the source SHA'
  [[ "$image_platform" == 'linux/arm64' ]] || fail 'demo image is not linux/arm64'
  local preview_output
  if ! preview_output="$(ECHO_DEMO_PREVIEW_IMAGE="$image" ECHO_DEMO_PREVIEW_SOURCE_SHA="$source_sha" ECHO_DEMO_REPLAY_PATH="$replay" compose_demo --profile preview run --rm --no-deps slack-card-preview \
    --state-dir /echo-demo/state --replay /echo-demo/replay.json --replay-sha "$replay_sha" \
    "$mode" ${meeting_id:+"$meeting_id"} 2>/dev/null)"; then
    fail 'Slack preview did not complete'
  fi
  python3 -c '
import json, sys
value = json.load(sys.stdin)
if (set(value) != {"kind", "posted_card_count", "replay_sha256", "card_batch_sha256"} or
    value.get("kind") != "echo-synthetic-demo-slack-card-preview-v1" or
    not isinstance(value.get("posted_card_count"), int) or value["posted_card_count"] < 1 or
    any(not isinstance(value.get(key), str) or len(value[key]) != 71 or not value[key].startswith("sha256:")
        for key in ("replay_sha256", "card_batch_sha256"))):
    raise SystemExit(1)
' <<<"$preview_output" || fail 'Slack preview returned an unsafe receipt'
  accepted_status
  accepted_public_descriptor || fail 'accepted clean runtime changed during Slack preview'
  demo_is_stopped || fail 'Slack preview left a demo container running'
  printf '%s\n' "$preview_output"
}

restore_clean() {
  [[ $# -eq 0 ]] || usage
  arm_restore
  restore_clean_runtime
  disarm_restore
  printf 'clean_runtime_restored=true\n'
}

status() {
  [[ $# -eq 0 ]] || usage
  if [[ -f "$DEMO_ENV" && ! -L "$DEMO_ENV" ]]; then
    compose_demo --profile setup --profile demo --profile preview ps --all
  else
    printf 'demo_prepared=false\n'
  fi
  if demo_interlock_held; then
    printf 'clean_runtime_status=switched_out\n'
  elif "$CLEAN_ROOT/update-clean-v1.sh" status; then
    printf 'clean_runtime_status=accepted\n'
  else
    printf 'clean_runtime_status=stopped_or_unhealthy\n'
  fi
}

require_root
require_regular_file "$CLEAN_ROOT/update-clean-v1.sh" 'accepted release updater'
command -v docker >/dev/null 2>&1 || fail 'Docker is unavailable'
command -v python3 >/dev/null 2>&1 || fail 'python3 is unavailable'

command="${1:-}"
shift || true
case "$command" in
  prepare) prepare "$@" ;;
  bootstrap) bootstrap "$@" ;;
  start-setup) start_setup "$@" ;;
  setup-status) setup_status "$@" ;;
  start-demo) start_demo "$@" ;;
  preview-slack) preview_slack "$@" ;;
  restore-clean) restore_clean "$@" ;;
  status) status "$@" ;;
  *) usage ;;
esac
