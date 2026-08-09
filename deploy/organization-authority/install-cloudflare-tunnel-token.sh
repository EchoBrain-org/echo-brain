#!/usr/bin/env bash
set -euo pipefail

AWS_REGION=us-west-2
TOKEN_REFERENCE='{{resolve:secretsmanager:echo/org1-prod/cloudflare-tunnel-token}}'
ASM_EXEC=/usr/local/bin/asm-exec
TARGET=/etc/cloudflared/tunnel.token
RESOLUTION_ATTEMPTS=4

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
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

case ${1:-install} in
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
    [[ -x $ASM_EXEC ]] || fail "missing $ASM_EXEC"
    export AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION"
    export PATH="/snap/bin:$PATH"
    export ECHO_CLOUDFLARE_TUNNEL_TOKEN="$TOKEN_REFERENCE"
    unset ASM_EXEC_MCP_ENDPOINT AWS_SECRETS_MANAGER_AGENT_ENDPOINT AWS_TOKEN
    run_resolved_action --resolved-check
    ;;
  install)
    [[ ${EUID} -eq 0 ]] || fail 'installation must run as root'
    [[ -x $ASM_EXEC ]] || fail "missing $ASM_EXEC"
    export AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION"
    export PATH="/snap/bin:$PATH"
    export ECHO_CLOUDFLARE_TUNNEL_TOKEN="$TOKEN_REFERENCE"
    unset ASM_EXEC_MCP_ENDPOINT AWS_SECRETS_MANAGER_AGENT_ENDPOINT AWS_TOKEN
    run_resolved_action --resolved-install
    ;;
  *)
    fail 'usage: install-cloudflare-tunnel-token.sh [--check|install]'
    ;;
esac
