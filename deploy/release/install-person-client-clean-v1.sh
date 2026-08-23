#!/usr/bin/env bash
# Install one checksum-verified Person-client release without a repository checkout.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
RELEASE_TOOL="$SCRIPT_DIR/clean-v1-release.py"

fail() { printf '%s\n' "$*" >&2; exit 1; }
usage() {
  cat >&2 <<'EOF'
usage: install-person-client-clean-v1.sh --release <canonical-release.json> [--prefix <absolute-prefix>] [--artifact <local.tgz>]

Without --artifact, the script downloads the HTTPS artifact URL from the release
record. It always verifies the release-record SHA-256 before npm installs it.
EOF
  exit 2
}

release=''
[[ -n "${HOME:-}" ]] || fail 'HOME is required for the default per-user install prefix'
prefix="$HOME/.local"
artifact=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --release) release="${2:-}"; shift 2 ;;
    --prefix) prefix="${2:-}"; shift 2 ;;
    --artifact) artifact="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done

[[ -n "$release" && -n "$prefix" ]] || usage
[[ "$prefix" == /* && "$prefix" != / ]] || fail '--prefix must be an absolute non-root path'
[[ -f "$RELEASE_TOOL" ]] || fail 'clean-v1 release validator is missing'
[[ -f "$release" && ! -L "$release" ]] || fail '--release must be a regular file'
python3 "$RELEASE_TOOL" validate "$release" >/dev/null

expected_sha="$(python3 "$RELEASE_TOOL" field "$release" client-sha256)"
expected_version="$(python3 "$RELEASE_TOOL" field "$release" client-version)"
expected_source_sha="$(python3 "$RELEASE_TOOL" field "$release" source-sha)"
artifact_url="$(python3 "$RELEASE_TOOL" field "$release" client-url)"
[[ "$(node --version)" == 'v22.22.1' ]] || fail 'Person client requires Node.js v22.22.1'
[[ "$(npm --version)" == '10.9.4' ]] || fail 'Person client requires npm 10.9.4'
temporary="$(mktemp -d "${TMPDIR:-/tmp}/echo-person-client.XXXXXXXX")"
chmod 0700 "$temporary"
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT

if [[ -n "$artifact" ]]; then
  [[ -f "$artifact" && ! -L "$artifact" ]] || fail '--artifact must be a regular file'
  archive="$artifact"
else
  archive="$temporary/person-client.tgz"
  curl --fail --location --proto '=https' --tlsv1.2 --output "$archive" "$artifact_url"
fi

if command -v shasum >/dev/null; then
  actual_sha="$(shasum -a 256 "$archive" | awk '{print $1}')"
else
  actual_sha="$(sha256sum "$archive" | awk '{print $1}')"
fi
[[ "$actual_sha" == "$expected_sha" ]] || fail 'Person-client artifact SHA-256 does not match the release record'

mkdir -p "$prefix"
npm install --global --prefix "$prefix" --ignore-scripts --no-audit --no-fund --offline "$archive"
installed_version="$($prefix/bin/echo-brain --version)"
[[ "$installed_version" == "$expected_version" ]] || fail 'installed Person-client version does not match the release record'
python3 - "$prefix/lib/node_modules/@echo-brain/person-client/dist/build-identity.v1.json" "$expected_version" "$expected_source_sha" <<'PY'
import json, pathlib, re, sys
path = pathlib.Path(sys.argv[1])
try:
    value = json.loads(path.read_text(encoding='utf-8'))
except (OSError, json.JSONDecodeError):
    raise SystemExit('installed Person-client build identity is unavailable')
if (
    not isinstance(value, dict)
    or sorted(value) != ['kind', 'product_version', 'schema_version', 'source_kind', 'source_sha']
    or value.get('schema_version') != 1
    or value.get('kind') != 'echo-packaged-build-identity'
    or value.get('product_version') != sys.argv[2]
    or value.get('source_kind') != 'materialized-commit'
    or value.get('source_sha') != sys.argv[3]
    or not re.fullmatch(r'[0-9a-f]{40}', str(value.get('source_sha', '')))
):
    raise SystemExit('installed Person-client build identity does not match the release record')
PY

case ":${PATH:-}:" in
  *":$prefix/bin:"*) ;;
  *)
    printf 'Person client installed. Add this once, then open a new shell: export PATH="%s/bin:$PATH"\n' "$prefix" >&2
    ;;
esac

# This status command is deliberately non-secret: it reports package version,
# whether a local session exists, and only its connected public Authority origin.
"$prefix/bin/echo-brain" person status
