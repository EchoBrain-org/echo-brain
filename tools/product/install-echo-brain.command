#!/bin/sh

set -eu

unset NODE_OPTIONS NODE_PATH

SCRIPT_DIR=$(CDPATH= cd -- "$(/usr/bin/dirname -- "$0")" && pwd -P)
EXPECTED_NODE=22.22.1
SELECTED_NODE=
ARCHIVE_MODE=false
for argument in "$@"; do
  case "$argument" in
    --archive | --expected-archive-sha256)
      ARCHIVE_MODE=true
      ;;
  esac
done

try_node() {
  candidate=$1
  if [ ! -x "$candidate" ]; then
    return 1
  fi
  if "$candidate" -e 'process.exit(process.platform === "darwin" && process.arch === "arm64" && process.versions.node === "22.22.1" ? 0 : 1)' >/dev/null 2>&1; then
    SELECTED_NODE=$candidate
    return 0
  fi
  return 1
}

if [ "${ECHO_BRAIN_NODE:-}" != "" ]; then
  if ! try_node "$ECHO_BRAIN_NODE"; then
    echo "Echo Brain requires ECHO_BRAIN_NODE to be darwin/arm64 Node $EXPECTED_NODE." >&2
    exit 1
  fi
else
  try_node "$HOME/.nvm/versions/node/v$EXPECTED_NODE/bin/node" || true
  if [ "$SELECTED_NODE" = "" ]; then
    try_node "/opt/homebrew/bin/node" || true
  fi
  if [ "$SELECTED_NODE" = "" ]; then
    try_node "/usr/local/bin/node" || true
  fi
  if [ "$SELECTED_NODE" = "" ] && command -v node >/dev/null 2>&1; then
    try_node "$(command -v node)" || true
  fi
fi

if [ "$SELECTED_NODE" = "" ]; then
  echo "Echo Brain requires native darwin/arm64 Node $EXPECTED_NODE." >&2
  echo "A client-grade installer will bundle this runtime; the founder beta currently expects it to be installed." >&2
  exit 1
fi

SELECTED_NODE_DIR=$(CDPATH= cd -- "$(/usr/bin/dirname -- "$SELECTED_NODE")" && pwd -P)
PATH="$SELECTED_NODE_DIR:/usr/bin:/bin:/usr/sbin:/sbin"
export PATH

if [ "$ARCHIVE_MODE" = true ]; then
  exec "$SELECTED_NODE" "$SCRIPT_DIR/install-archive.mjs" "$@"
fi

BUNDLE_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd -P)
exec "$SELECTED_NODE" "$SCRIPT_DIR/install-bundle.mjs" --bundle-root "$BUNDLE_ROOT" "$@"
