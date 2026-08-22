#!/usr/bin/env bash
set -euo pipefail

CLOUDFLARED_VERSION=2026.7.3
CLOUDFLARED_SHA256=d3ea7d22dd337b465da33d6bc1c4b3cfd381407447a2a7d29542c19783430db3
AGENT_TOOLKIT_COMMIT=171d4fba3bc404da3473f323c3e293b4a989f089
ASM_EXEC_UPSTREAM_SHA256=d55eb38ad33a5b76f584ca180f633ecc120cf39b8fd29427ffbe11a8fbf19556
ASM_EXEC_PATCHED_SHA256=1fbb03673905a55fa4ace3bb80ecd383e75d81de72c40fab23c11b0a7c0f4e89
ECR_REGISTRY=904560150024.dkr.ecr.us-west-2.amazonaws.com
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
UNIT_SOURCE="$SCRIPT_DIR/cloudflared-echo-authority.service"
TOKEN_INSTALLER_SOURCE="$SCRIPT_DIR/install-cloudflare-tunnel-token.sh"
GRANOLA_INSTALLER_SOURCE="$SCRIPT_DIR/install-granola-organization-source.sh"
OPENROUTER_INSTALLER_SOURCE="$SCRIPT_DIR/install-openrouter-api-key.sh"
ASM_EXEC_PATCH_SOURCE="$SCRIPT_DIR/asm-exec-structured-content.patch"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

[[ ${EUID} -eq 0 ]] || fail 'run this script as root'
[[ $(uname -m) == aarch64 ]] || fail 'this bootstrap supports Ubuntu ARM64 only'
[[ -r /etc/os-release ]] || fail '/etc/os-release is missing'
# shellcheck disable=SC1091
. /etc/os-release
[[ ${ID:-} == ubuntu ]] || fail 'this bootstrap supports Ubuntu only'
[[ -f "$UNIT_SOURCE" ]] || fail "missing $UNIT_SOURCE"
[[ -f "$TOKEN_INSTALLER_SOURCE" ]] || fail "missing $TOKEN_INSTALLER_SOURCE"
[[ -f "$GRANOLA_INSTALLER_SOURCE" ]] || fail "missing $GRANOLA_INSTALLER_SOURCE"
[[ -f "$OPENROUTER_INSTALLER_SOURCE" ]] || fail "missing $OPENROUTER_INSTALLER_SOURCE"
[[ -f "$ASM_EXEC_PATCH_SOURCE" ]] || fail "missing $ASM_EXEC_PATCH_SOURCE"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  docker.io \
  docker-compose-v2 \
  amazon-ecr-credential-helper \
  patch \
  snapd \
  sqlite3

systemctl enable --now docker.service
dpkg --compare-versions "$(docker compose version --short)" ge 2.24.4 \
  || fail 'Docker Compose 2.24.4 or newer is required for the EC2 override'

getent group echo-authority >/dev/null 2>&1 || groupadd --system echo-authority
if ! id -u echo-authority >/dev/null 2>&1; then
  useradd --system --gid echo-authority --home-dir /nonexistent \
    --shell /usr/sbin/nologin echo-authority
fi
[[ $(id -gn echo-authority) == echo-authority ]] \
  || fail 'existing echo-authority user has an unexpected primary group'

getent group cloudflared >/dev/null 2>&1 || groupadd --system cloudflared
if ! id -u cloudflared >/dev/null 2>&1; then
  useradd --system --gid cloudflared --home-dir /var/lib/cloudflared \
    --shell /usr/sbin/nologin cloudflared
fi
[[ $(id -gn cloudflared) == cloudflared ]] \
  || fail 'existing cloudflared user has an unexpected primary group'

install -d -o root -g echo-authority -m 0750 /srv/echo-authority
install -d -o echo-authority -g echo-authority -m 0700 /srv/echo-authority/data
install -d -o root -g cloudflared -m 0750 /etc/cloudflared
install -d -o cloudflared -g cloudflared -m 0700 /var/lib/cloudflared

tmp_dir="$(mktemp -d)"
trap 'rm -rf -- "$tmp_dir"' EXIT

if ! snap list aws-cli >/dev/null 2>&1; then
  snap install aws-cli --classic
fi
/snap/bin/aws --version >/dev/null

asm_exec="$tmp_dir/asm-exec"
curl --fail --location --proto '=https' --tlsv1.2 \
  --output "$asm_exec" \
  "https://raw.githubusercontent.com/aws/agent-toolkit-for-aws/${AGENT_TOOLKIT_COMMIT}/plugins/aws-core/skills/aws-secrets-manager/references/asm-exec"
printf '%s  %s\n' "$ASM_EXEC_UPSTREAM_SHA256" "$asm_exec" | sha256sum --check --status \
  || fail 'upstream asm-exec checksum mismatch'
patch --batch --forward "$asm_exec" "$ASM_EXEC_PATCH_SOURCE"
printf '%s  %s\n' "$ASM_EXEC_PATCHED_SHA256" "$asm_exec" | sha256sum --check --status \
  || fail 'patched asm-exec checksum mismatch'
install -o root -g root -m 0755 "$asm_exec" /usr/local/bin/asm-exec

cloudflared_deb="$tmp_dir/cloudflared-linux-arm64.deb"
curl --fail --location --proto '=https' --tlsv1.2 \
  --output "$cloudflared_deb" \
  "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-arm64.deb"
printf '%s  %s\n' "$CLOUDFLARED_SHA256" "$cloudflared_deb" | sha256sum --check --status \
  || fail 'cloudflared package checksum mismatch'
apt-get install -y --no-install-recommends "$cloudflared_deb"
cloudflared --version | grep -Fq "cloudflared version $CLOUDFLARED_VERSION" \
  || fail 'unexpected cloudflared version after installation'

systemctl disable --now cloudflared.service >/dev/null 2>&1 || true
if systemctl is-active --quiet cloudflared.service; then
  fail 'package-provided cloudflared.service is unexpectedly active'
fi

install -o root -g root -m 0644 "$UNIT_SOURCE" \
  /etc/systemd/system/cloudflared-echo-authority.service
install -o root -g root -m 0700 "$TOKEN_INSTALLER_SOURCE" \
  /usr/local/sbin/install-echo-authority-tunnel-token
install -o root -g root -m 0700 "$GRANOLA_INSTALLER_SOURCE" \
  /usr/local/sbin/install-echo-authority-granola-source
install -o root -g root -m 0700 "$OPENROUTER_INSTALLER_SOURCE" \
  /usr/local/sbin/install-echo-authority-openrouter-key
systemctl daemon-reload
systemctl disable cloudflared-echo-authority.service >/dev/null 2>&1 || true
systemctl stop cloudflared-echo-authority.service >/dev/null 2>&1 || true

install -d -o root -g root -m 0700 /root/.docker
docker_config="$tmp_dir/docker-config.json"
printf '{\n  "credHelpers": {\n    "%s": "ecr-login"\n  }\n}\n' \
  "$ECR_REGISTRY" > "$docker_config"
if [[ -e /root/.docker/config.json ]] && \
   ! cmp -s "$docker_config" /root/.docker/config.json; then
  fail '/root/.docker/config.json already exists with different settings; merge the ECR helper manually'
fi
install -o root -g root -m 0600 "$docker_config" /root/.docker/config.json

printf '%s\n' \
  "Docker $(docker version --format '{{.Server.Version}}')" \
  "Docker Compose $(docker compose version --short)" \
  "$(/snap/bin/aws --version)" \
  "$(cloudflared --version)" \
  "asm-exec $(sha256sum /usr/local/bin/asm-exec | cut -d ' ' -f 1)" \
  'Bootstrap complete. The Authority and Cloudflare Tunnel are not running.' \
  'Do not create /etc/cloudflared/tunnel.token until the cold state transfer is validated.'
