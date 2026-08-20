#!/usr/bin/env bash
set -euo pipefail

AWS_REGION=us-west-2
SECRET_ID=echo/org1-prod/openrouter-api-key
API_KEY_REFERENCE="{{resolve:secretsmanager:${SECRET_ID}:SecretString:api_key}}"
ASM_EXEC=/usr/local/bin/asm-exec
TARGET_DIRECTORY=/srv/echo-authority/data/state/credentials/processing
TARGET_FILE="$TARGET_DIRECTORY/openrouter-api-key"
RESOLUTION_ATTEMPTS=4

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

validate_resolved_key() {
  [[ ${ECHO_OPENROUTER_API_KEY:-} =~ ^sk-or-v1-[A-Za-z0-9_-]{32,}$ ]] \
    || fail 'the resolved OpenRouter API key has an invalid format'
  [[ $ECHO_OPENROUTER_API_KEY != *'{{resolve:secretsmanager:'* ]] \
    || fail 'the OpenRouter API key reference was not resolved'
}

install_private_key() {
  local temporary_file
  temporary_file="$(mktemp "$TARGET_DIRECTORY/.openrouter-key.XXXXXX")"
  cleanup_private_key() {
    rm -f -- "$temporary_file"
  }
  trap cleanup_private_key EXIT
  umask 0077
  printf '%s' "$ECHO_OPENROUTER_API_KEY" > "$temporary_file"
  chown echo-authority:echo-authority "$temporary_file"
  chmod 0600 "$temporary_file"
  mv -f -- "$temporary_file" "$TARGET_FILE"
  trap - EXIT
}

run_resolved_action() {
  local resolved_action=$1
  local attempt delay

  for ((attempt = 1; attempt <= RESOLUTION_ATTEMPTS; attempt++)); do
    if "$ASM_EXEC" -- "$0" "$resolved_action"; then
      return 0
    fi
    ((attempt < RESOLUTION_ATTEMPTS)) \
      || fail "OpenRouter secret operation failed after $RESOLUTION_ATTEMPTS attempts"
    delay=$((attempt * 5))
    printf 'OpenRouter secret operation failed; retrying in %d seconds (%d/%d).\n' \
      "$delay" "$attempt" "$RESOLUTION_ATTEMPTS" >&2
    sleep "$delay"
  done
}

case ${1:-install} in
  --resolved-check)
    validate_resolved_key
    printf 'OpenRouter API key resolution succeeded.\n'
    ;;
  --resolved-install)
    [[ ${EUID} -eq 0 ]] || fail 'installation must run as root'
    validate_resolved_key
    install -d -o echo-authority -g echo-authority -m 0700 "$TARGET_DIRECTORY"
    install_private_key
    unset ECHO_OPENROUTER_API_KEY
    printf 'OpenRouter API key installed with private permissions.\n'
    ;;
  --check)
    [[ -x $ASM_EXEC ]] || fail "missing $ASM_EXEC"
    export AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION"
    export PATH="/snap/bin:$PATH"
    export ECHO_OPENROUTER_API_KEY="$API_KEY_REFERENCE"
    unset ASM_EXEC_MCP_ENDPOINT AWS_SECRETS_MANAGER_AGENT_ENDPOINT AWS_TOKEN
    run_resolved_action --resolved-check
    ;;
  install)
    [[ ${EUID} -eq 0 ]] || fail 'installation must run as root'
    [[ -x $ASM_EXEC ]] || fail "missing $ASM_EXEC"
    export AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION"
    export PATH="/snap/bin:$PATH"
    export ECHO_OPENROUTER_API_KEY="$API_KEY_REFERENCE"
    unset ASM_EXEC_MCP_ENDPOINT AWS_SECRETS_MANAGER_AGENT_ENDPOINT AWS_TOKEN
    run_resolved_action --resolved-install
    ;;
  *)
    fail 'usage: install-openrouter-api-key.sh [--check|install]'
    ;;
esac
