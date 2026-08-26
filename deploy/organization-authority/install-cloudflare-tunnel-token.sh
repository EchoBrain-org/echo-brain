#!/usr/bin/env bash
set -euo pipefail

CONFIG_FILE=/etc/echo-authority/host-bootstrap.conf
AWS_REGION=
TOKEN_REFERENCE=
ASM_EXEC=/usr/local/bin/asm-exec
TARGET=/etc/cloudflared/tunnel.token
RESOLUTION_ATTEMPTS=4

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat >&2 <<'USAGE'
usage: install-cloudflare-tunnel-token.sh [--region <aws-region> --tunnel-secret-reference <dynamic-reference>] [--check|install]

The installer accepts only a Secrets Manager dynamic reference, never a raw
Tunnel token. By default it reads the Authority host bootstrap configuration;
the reference is passed to asm-exec and resolved only inside its short-lived
child process.
USAGE
  exit 2
}

validate_region() {
  [[ $1 =~ ^[a-z]{2}(-[a-z0-9]+)+-[0-9]+$ ]] || fail 'AWS Region has an unsafe shape'
}

validate_reference() {
  [[ $1 =~ ^\{\{resolve:secretsmanager:arn:(aws|aws-us-gov|aws-cn):secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+:SecretString:token\}\}$ ]] \
    || fail 'Tunnel secret reference must select the token JSON key from one exact Secrets Manager ARN'
}

config_value() {
  local key=$1 matches value
  matches="$(awk -F= -v key="$key" '$1 == key { print $0 }' "$CONFIG_FILE")"
  [[ $(printf '%s\n' "$matches" | sed '/^$/d' | wc -l | tr -d ' ') -le 1 ]] \
    || fail "Tunnel configuration contains more than one $key entry"
  value=${matches#*=}
  printf '%s' "$value"
}

load_config() {
  if [[ ! -e $CONFIG_FILE ]]; then
    [[ -n $AWS_REGION && -n $TOKEN_REFERENCE ]] && return 0
    fail 'Authority host bootstrap configuration is missing and no complete explicit configuration was supplied'
  fi
  [[ -f $CONFIG_FILE && ! -L $CONFIG_FILE ]] \
    || fail 'Authority host bootstrap configuration must be a regular non-symlink file'
  [[ $(stat -c '%u:%a' "$CONFIG_FILE") == '0:600' ]] \
    || fail 'Authority host bootstrap configuration must be owned by root with mode 0600'
  [[ -n $AWS_REGION ]] || AWS_REGION=$(config_value AWS_REGION)
  [[ -n $TOKEN_REFERENCE ]] || TOKEN_REFERENCE=$(config_value TUNNEL_SECRET_REFERENCE)
}

load_and_validate_config() {
  load_config
  validate_region "$AWS_REGION"
  validate_reference "$TOKEN_REFERENCE"
}

validate_resolved_token() {
  [[ -n ${ECHO_CLOUDFLARE_TUNNEL_TOKEN:-} ]] \
    || fail 'the resolved Tunnel token is empty'
  [[ $ECHO_CLOUDFLARE_TUNNEL_TOKEN != *'{{resolve:secretsmanager:'* ]] \
    || fail 'the Tunnel token reference was not resolved'
}

run_resolved_action() {
  local resolved_action=$1
  local attempt delay

  for ((attempt = 1; attempt <= RESOLUTION_ATTEMPTS; attempt++)); do
    if "$ASM_EXEC" -- "$0" "$resolved_action"; then
      return 0
    fi
    ((attempt < RESOLUTION_ATTEMPTS)) \
      || fail "Cloudflare Tunnel secret operation failed after $RESOLUTION_ATTEMPTS attempts"
    delay=$((attempt * 5))
    printf 'Cloudflare Tunnel secret operation failed; retrying in %d seconds (%d/%d).\n' \
      "$delay" "$attempt" "$RESOLUTION_ATTEMPTS" >&2
    sleep "$delay"
  done
}

action=install
while [[ $# -gt 0 ]]; do
  case $1 in
    --region)
      [[ $# -ge 2 ]] || usage
      AWS_REGION=$2
      shift 2
      ;;
    --tunnel-secret-reference)
      [[ $# -ge 2 ]] || usage
      TOKEN_REFERENCE=$2
      shift 2
      ;;
    --check)
      action=--check
      shift
      ;;
    --resolved-check)
      action=--resolved-check
      shift
      ;;
    --resolved-install)
      action=--resolved-install
      shift
      ;;
    install)
      action=install
      shift
      ;;
    --help|-h)
      usage
      ;;
    *)
      usage
      ;;
  esac
done

case $action in
  --resolved-check)
    validate_resolved_token
    printf 'Cloudflare Tunnel secret resolution succeeded.\n'
    ;;
  --resolved-install)
    [[ ${EUID} -eq 0 ]] || fail 'installation must run as root'
    validate_resolved_token
    getent group cloudflared >/dev/null 2>&1 \
      || fail 'cloudflared group is missing'
    install -d -o root -g cloudflared -m 0750 "$(dirname -- "$TARGET")"
    temporary_file="$(mktemp "$(dirname -- "$TARGET")/.tunnel.token.XXXXXX")"
    cleanup() {
      rm -f -- "$temporary_file"
    }
    trap cleanup EXIT
    umask 0077
    printf '%s\n' "$ECHO_CLOUDFLARE_TUNNEL_TOKEN" > "$temporary_file"
    unset ECHO_CLOUDFLARE_TUNNEL_TOKEN
    [[ -s $temporary_file ]] || fail 'the staged Tunnel token is empty'
    chown root:cloudflared "$temporary_file"
    chmod 0640 "$temporary_file"
    mv -f -- "$temporary_file" "$TARGET"
    trap - EXIT
    printf 'Cloudflare Tunnel token installed with private permissions.\n'
    ;;
  --check)
    load_and_validate_config
    [[ -x $ASM_EXEC ]] || fail "missing $ASM_EXEC"
    export AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION"
    export PATH="/snap/bin:$PATH"
    export ECHO_CLOUDFLARE_TUNNEL_TOKEN="$TOKEN_REFERENCE"
    unset ASM_EXEC_MCP_ENDPOINT AWS_SECRETS_MANAGER_AGENT_ENDPOINT AWS_TOKEN
    run_resolved_action --resolved-check
    ;;
  install)
    load_and_validate_config
    [[ ${EUID} -eq 0 ]] || fail 'installation must run as root'
    [[ -x $ASM_EXEC ]] || fail "missing $ASM_EXEC"
    export AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION"
    export PATH="/snap/bin:$PATH"
    export ECHO_CLOUDFLARE_TUNNEL_TOKEN="$TOKEN_REFERENCE"
    unset ASM_EXEC_MCP_ENDPOINT AWS_SECRETS_MANAGER_AGENT_ENDPOINT AWS_TOKEN
    run_resolved_action --resolved-install
    ;;
  *)
    usage
    ;;
esac
