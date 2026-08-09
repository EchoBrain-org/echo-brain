#!/usr/bin/env bash
set -euo pipefail

CLOUDFLARED_VERSION=2026.7.3
CLOUDFLARED_SHA256=d3ea7d22dd337b465da33d6bc1c4b3cfd381407447a2a7d29542c19783430db3
ECR_REGISTRY=904560150024.dkr.ecr.us-west-2.amazonaws.com
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
UNIT_SOURCE="$SCRIPT_DIR/cloudflared-echo-authority.service"

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

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  docker.io \
  docker-compose-v2 \
  amazon-ecr-credential-helper \
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
  "$(cloudflared --version)" \
  'Bootstrap complete. The Authority and Cloudflare Tunnel are not running.' \
  'Do not create /etc/cloudflared/tunnel.token until the cold state transfer is validated.'
