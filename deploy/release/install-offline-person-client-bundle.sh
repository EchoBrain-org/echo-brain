#!/usr/bin/env bash
# Install the exact client carried by an offline clean-v1 employee bundle.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

if [[ $# -ne 0 ]]; then
  printf '%s\n' 'usage: ./install.sh' >&2
  exit 2
fi

exec "$SCRIPT_DIR/install-person-client-clean-v1.sh" \
  --release "$SCRIPT_DIR/release.json" \
  --artifact "$SCRIPT_DIR/person-client.tgz"
