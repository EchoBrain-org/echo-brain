#!/usr/bin/env bash
set -euo pipefail

AWS_REGION=us-west-2
SECRET_ID=echo/org1-prod/granola-organization-source
API_KEY_REFERENCE="{{resolve:secretsmanager:${SECRET_ID}:SecretString:api_key}}"
OWNER_EMAIL_REFERENCE="{{resolve:secretsmanager:${SECRET_ID}:SecretString:owner_email}}"
SCOPE_REFERENCE="{{resolve:secretsmanager:${SECRET_ID}:SecretString:credential_scope}}"
ASM_EXEC=/usr/local/bin/asm-exec
TARGET_DIRECTORY=/srv/echo-authority/data/state/credentials
RESOLUTION_ATTEMPTS=4

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

validate_resolved_source() {
  [[ ${ECHO_GRANOLA_API_KEY:-} =~ ^grn_[A-Za-z0-9][A-Za-z0-9_-]{27,}$ ]] \
    || fail 'the resolved Granola API key has an invalid format'
  [[ ${ECHO_GRANOLA_OWNER_EMAIL:-} =~ ^[^[:space:]@]+@[^[:space:]@]+$ ]] \
    || fail 'the resolved Granola owner email is invalid'
  [[ $ECHO_GRANOLA_OWNER_EMAIL == "${ECHO_GRANOLA_OWNER_EMAIL,,}" ]] \
    || fail 'the resolved Granola owner email is not canonical lowercase'
  [[ ${ECHO_GRANOLA_CREDENTIAL_SCOPE:-} == organization ]] \
    || fail 'the resolved Granola credential is not organization-scoped'
  [[ $ECHO_GRANOLA_API_KEY != *'{{resolve:secretsmanager:'* ]] \
    || fail 'the Granola API key reference was not resolved'
  [[ $ECHO_GRANOLA_OWNER_EMAIL != *'{{resolve:secretsmanager:'* ]] \
    || fail 'the Granola owner email reference was not resolved'
  [[ $ECHO_GRANOLA_CREDENTIAL_SCOPE != *'{{resolve:secretsmanager:'* ]] \
    || fail 'the Granola credential-scope reference was not resolved'
}

install_private_value() {
  local value=$1
  local target=$2
  local temporary_file
  temporary_file="$(mktemp "$TARGET_DIRECTORY/.granola-source.XXXXXX")"
  cleanup_private_value() {
    rm -f -- "$temporary_file"
  }
  trap cleanup_private_value EXIT
  umask 0077
  printf '%s' "$value" > "$temporary_file"
  chown echo-authority:echo-authority "$temporary_file"
  chmod 0600 "$temporary_file"
  mv -f -- "$temporary_file" "$target"
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
      || fail "Granola source secret operation failed after $RESOLUTION_ATTEMPTS attempts"
    delay=$((attempt * 5))
    printf 'Granola source secret operation failed; retrying in %d seconds (%d/%d).\n' \
      "$delay" "$attempt" "$RESOLUTION_ATTEMPTS" >&2
    sleep "$delay"
  done
}

case ${1:-install} in
  --resolved-check)
    validate_resolved_source
    printf 'Granola organization source secret resolution succeeded.\n'
    ;;
  --resolved-install)
    [[ ${EUID} -eq 0 ]] || fail 'installation must run as root'
    validate_resolved_source
    install -d -o echo-authority -g echo-authority -m 0700 "$TARGET_DIRECTORY"
    install_private_value \
      "$ECHO_GRANOLA_API_KEY" \
      "$TARGET_DIRECTORY/granola-organization-api-key"
    install_private_value \
      "$ECHO_GRANOLA_OWNER_EMAIL" \
      "$TARGET_DIRECTORY/granola-organization-owner-email"
    install_private_value \
      "$ECHO_GRANOLA_CREDENTIAL_SCOPE" \
      "$TARGET_DIRECTORY/granola-organization-credential-scope"
    unset ECHO_GRANOLA_API_KEY ECHO_GRANOLA_OWNER_EMAIL \
      ECHO_GRANOLA_CREDENTIAL_SCOPE
    printf 'Granola organization source installed with private permissions.\n'
    ;;
  --check)
    [[ -x $ASM_EXEC ]] || fail "missing $ASM_EXEC"
    export AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION"
    export PATH="/snap/bin:$PATH"
    export ECHO_GRANOLA_API_KEY="$API_KEY_REFERENCE"
    export ECHO_GRANOLA_OWNER_EMAIL="$OWNER_EMAIL_REFERENCE"
    export ECHO_GRANOLA_CREDENTIAL_SCOPE="$SCOPE_REFERENCE"
    unset ASM_EXEC_MCP_ENDPOINT AWS_SECRETS_MANAGER_AGENT_ENDPOINT AWS_TOKEN
    run_resolved_action --resolved-check
    ;;
  install)
    [[ ${EUID} -eq 0 ]] || fail 'installation must run as root'
    [[ -x $ASM_EXEC ]] || fail "missing $ASM_EXEC"
    export AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION"
    export PATH="/snap/bin:$PATH"
    export ECHO_GRANOLA_API_KEY="$API_KEY_REFERENCE"
    export ECHO_GRANOLA_OWNER_EMAIL="$OWNER_EMAIL_REFERENCE"
    export ECHO_GRANOLA_CREDENTIAL_SCOPE="$SCOPE_REFERENCE"
    unset ASM_EXEC_MCP_ENDPOINT AWS_SECRETS_MANAGER_AGENT_ENDPOINT AWS_TOKEN
    run_resolved_action --resolved-install
    ;;
  *)
    fail 'usage: install-granola-organization-source.sh [--check|install]'
    ;;
esac
