#!/usr/bin/env bash
# Provision the replaceable Ubuntu ARM64 part of one Authority host.
#
# This script intentionally does not install Authority state, provider inputs, or
# a Cloudflare Tunnel token. It accepts only non-secret infrastructure identity;
# the token is resolved later by asm-exec from Secrets Manager.
set -euo pipefail

CLOUDFLARED_VERSION=2026.7.3
CLOUDFLARED_SHA256=d3ea7d22dd337b465da33d6bc1c4b3cfd381407447a2a7d29542c19783430db3
AGENT_TOOLKIT_COMMIT=171d4fba3bc404da3473f323c3e293b4a989f089
ASM_EXEC_UPSTREAM_SHA256=d55eb38ad33a5b76f584ca180f633ecc120cf39b8fd29427ffbe11a8fbf19556
ASM_EXEC_PATCHED_SHA256=1fbb03673905a55fa4ace3bb80ecd383e75d81de72c40fab23c11b0a7c0f4e89

AUTHORITY_UID=999
AUTHORITY_GID=988
DEPLOY_DIR=/srv/echo-authority-clean-v1
DATA_DIR="$DEPLOY_DIR/clean-data"
DATA_VOLUME_LABEL=echo-auth-data
VOLUME_INITIALIZATION_MARKER=.echo-authority-volume-initialization-v1
VOLUME_INITIALIZATION_SCHEMA=echo-authority-volume-initialization-v1
CONFIG_DIR=/etc/echo-authority
CONFIG_FILE="$CONFIG_DIR/host-bootstrap.conf"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
UNIT_SOURCE="$SCRIPT_DIR/cloudflared-echo-authority.service"
TOKEN_INSTALLER_SOURCE="$SCRIPT_DIR/install-cloudflare-tunnel-token.sh"
ONBOARD_SOURCE="$SCRIPT_DIR/onboard-clean-v1.sh"
UPDATER_SOURCE="$SCRIPT_DIR/update-clean-v1.sh"
RESTORER_SOURCE="$SCRIPT_DIR/restore-clean-v1-host.sh"
RELEASE_VALIDATOR_SOURCE="$SCRIPT_DIR/clean-v1-release.py"
RUNTIME_PROFILE_VALIDATOR_SOURCE="$SCRIPT_DIR/clean-v1-runtime-profile.py"

AWS_REGION=
TUNNEL_SECRET_REFERENCE=
ECR_REGISTRY=
DATA_VOLUME_ID=
DATA_DEVICE=
INITIALIZE_BLANK_DATA_VOLUME=false

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat >&2 <<'USAGE'
usage: bootstrap-ubuntu-arm64.sh [options]

Required on the first run (or supplied by a root-owned config file):
  --region <aws-region>
  --tunnel-secret-arn <exact Secrets Manager ARN>
    or --tunnel-secret-reference <{{resolve:secretsmanager:...}}>
  --ecr-registry <registry-host>
  --data-volume-id <vol-...>

Optional:
  --data-device </dev/...>              Verify this attached device against the volume ID.
  --initialize-blank-data-volume        Format an otherwise signature-free volume as ext4.

No raw Cloudflare Tunnel token is accepted by this script. Install it later with
install-echo-authority-tunnel-token, which resolves the configured dynamic
Secrets Manager reference only at runtime through asm-exec.
USAGE
  exit 2
}

validate_region() {
  [[ $1 =~ ^[a-z]{2}(-[a-z0-9]+)+-[0-9]+$ ]] || fail 'AWS Region has an unsafe shape'
}

validate_ecr_registry() {
  [[ $1 =~ ^([0-9]{12}\.dkr\.)?ecr\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$ ]] \
    || fail 'ECR registry must be an AWS ECR registry hostname'
  [[ $1 == *".ecr.$AWS_REGION.amazonaws.com" || $1 == *".ecr.$AWS_REGION.amazonaws.com.cn" ]] \
    || fail 'ECR registry Region must match the supplied AWS Region'
}

validate_volume_id() {
  [[ $1 =~ ^vol-[0-9a-f]{8,17}$ ]] || fail 'data volume ID has an unsafe shape'
}

reference_from_arn() {
  local secret_arn=$1
  [[ $secret_arn =~ ^arn:(aws|aws-us-gov|aws-cn):secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$ ]] \
    || fail 'tunnel secret ARN must be an exact Secrets Manager secret ARN'
  printf '{{resolve:secretsmanager:%s:SecretString:token}}' "$secret_arn"
}

validate_secret_reference() {
  [[ $1 =~ ^\{\{resolve:secretsmanager:arn:(aws|aws-us-gov|aws-cn):secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+:SecretString:token\}\}$ ]] \
    || fail 'tunnel secret reference must select the token JSON key from one exact Secrets Manager ARN'
}

config_value() {
  local key=$1 file=$2 matches value
  matches="$(awk -F= -v key="$key" '$1 == key { print $0 }' "$file")"
  [[ $(printf '%s\n' "$matches" | sed '/^$/d' | wc -l | tr -d ' ') -le 1 ]] \
    || fail "configuration contains more than one $key entry"
  value=${matches#*=}
  printf '%s' "$value"
}

validate_existing_config() {
  [[ -f $CONFIG_FILE && ! -L $CONFIG_FILE ]] || fail 'configuration file must be a regular non-symlink file'
  [[ $(stat -c '%u:%a' "$CONFIG_FILE") == '0:600' ]] \
    || fail 'configuration file must be owned by root with mode 0600'
}

load_config() {
  [[ -e $CONFIG_FILE ]] || return 0
  validate_existing_config
  [[ -n $AWS_REGION ]] || AWS_REGION=$(config_value AWS_REGION "$CONFIG_FILE")
  [[ -n $TUNNEL_SECRET_REFERENCE ]] || TUNNEL_SECRET_REFERENCE=$(config_value TUNNEL_SECRET_REFERENCE "$CONFIG_FILE")
  [[ -n $ECR_REGISTRY ]] || ECR_REGISTRY=$(config_value ECR_REGISTRY "$CONFIG_FILE")
  [[ -n $DATA_VOLUME_ID ]] || DATA_VOLUME_ID=$(config_value DATA_VOLUME_ID "$CONFIG_FILE")
  [[ -n $DATA_DEVICE ]] || DATA_DEVICE=$(config_value DATA_DEVICE "$CONFIG_FILE")
}

write_config_if_needed() {
  local temporary
  install -d -o root -g root -m 0700 "$CONFIG_DIR"
  temporary="$(mktemp "$CONFIG_DIR/.host-bootstrap.conf.XXXXXX")"
  trap 'rm -f -- "$temporary"' RETURN
  cat >"$temporary" <<EOF
AWS_REGION=$AWS_REGION
TUNNEL_SECRET_REFERENCE=$TUNNEL_SECRET_REFERENCE
ECR_REGISTRY=$ECR_REGISTRY
DATA_VOLUME_ID=$DATA_VOLUME_ID
DATA_DEVICE=$DATA_DEVICE
EOF
  chmod 0600 "$temporary"
  chown root:root "$temporary"
  if [[ -e $CONFIG_FILE ]]; then
    validate_existing_config
    cmp -s "$temporary" "$CONFIG_FILE" \
      || fail 'existing host bootstrap configuration differs; review it instead of replacing it'
  else
    install -o root -g root -m 0600 "$temporary" "$CONFIG_FILE"
  fi
  trap - RETURN
  rm -f -- "$temporary"
}

ensure_fixed_authority_identity() {
  local existing_group existing_user
  existing_group=$(getent group "$AUTHORITY_GID" | cut -d: -f1 || true)
  [[ -z $existing_group || $existing_group == echo-authority ]] \
    || fail "GID $AUTHORITY_GID is already assigned to $existing_group"
  getent group echo-authority >/dev/null 2>&1 \
    || groupadd --gid "$AUTHORITY_GID" --system echo-authority
  [[ $(getent group echo-authority | cut -d: -f3) == "$AUTHORITY_GID" ]] \
    || fail 'echo-authority group does not have the required fixed GID'

  existing_user=$(getent passwd "$AUTHORITY_UID" | cut -d: -f1 || true)
  [[ -z $existing_user || $existing_user == echo-authority ]] \
    || fail "UID $AUTHORITY_UID is already assigned to $existing_user"
  id -u echo-authority >/dev/null 2>&1 \
    || useradd --uid "$AUTHORITY_UID" --gid "$AUTHORITY_GID" --system \
      --home-dir /nonexistent --shell /usr/sbin/nologin echo-authority
  [[ $(id -u echo-authority) == "$AUTHORITY_UID" && $(id -g echo-authority) == "$AUTHORITY_GID" ]] \
    || fail 'echo-authority does not have the required fixed UID/GID'
}

ensure_cloudflared_identity() {
  getent group cloudflared >/dev/null 2>&1 || groupadd --system cloudflared
  id -u cloudflared >/dev/null 2>&1 || useradd --system --gid cloudflared \
    --home-dir /var/lib/cloudflared --shell /usr/sbin/nologin cloudflared
  [[ $(id -gn cloudflared) == cloudflared ]] \
    || fail 'existing cloudflared user has an unexpected primary group'
}

resolve_data_device() {
  local expected_serial actual_device actual_serial
  expected_serial=${DATA_VOLUME_ID//-/}
  if [[ -n $DATA_DEVICE ]]; then
    [[ -b $DATA_DEVICE && ! -L $DATA_DEVICE ]] || fail 'configured data device must be a block-device path, not a symlink'
    actual_device=$(readlink -f -- "$DATA_DEVICE")
  else
    actual_device=$(lsblk -dn -o PATH,SERIAL | awk -v wanted="$expected_serial" '
      { serial=$2; gsub("-", "", serial); if (serial == wanted) print $1 }
    ')
    [[ $(printf '%s\n' "$actual_device" | sed '/^$/d' | wc -l | tr -d ' ') -eq 1 ]] \
      || fail 'could not resolve exactly one attached data device from the supplied EBS volume ID'
  fi
  [[ $(lsblk -dn -o TYPE "$actual_device") == disk ]] \
    || fail 'data device must be the whole EBS disk, not a partition'
  actual_serial=$(lsblk -dn -o SERIAL "$actual_device" | tr -d '-')
  [[ $actual_serial == "$expected_serial" ]] \
    || fail 'attached data device serial does not match the supplied EBS volume ID'
  printf '%s' "$actual_device"
}

assert_not_root_device() {
  local candidate=$1 root_source root_parent candidate_parent
  root_source=$(findmnt -n -o SOURCE /)
  root_parent=$(lsblk -no PKNAME "$root_source" 2>/dev/null || true)
  candidate_parent=$(lsblk -no PKNAME "$candidate" 2>/dev/null || true)
  [[ -n $root_parent ]] || root_parent=$(basename "$root_source")
  [[ -n $candidate_parent ]] || candidate_parent=$(basename "$candidate")
  [[ $root_parent != "$candidate_parent" ]] || fail 'refusing to use the root device as Authority data volume'
}

ensure_fstab_mount() {
  local device=$1 uuid expected temporary
  uuid=$(blkid -o value -s UUID "$device" || true)
  [[ -n $uuid ]] || fail 'data device does not have a filesystem UUID'
  expected="UUID=$uuid $DATA_DIR ext4 nofail,noexec,nodev,nosuid,x-systemd.device-timeout=120 0 2"
  if awk -v target="$DATA_DIR" -v expected="$expected" '$0 !~ /^[[:space:]]*#/ && $2 == target { found=1; if ($0 != expected) bad=1 } END { exit (found && !bad) ? 0 : 1 }' /etc/fstab; then
    return 0
  fi
  if awk -v target="$DATA_DIR" '$0 !~ /^[[:space:]]*#/ && $2 == target { found=1 } END { exit found ? 0 : 1 }' /etc/fstab; then
    fail 'existing /etc/fstab entry for Authority data path does not match the supplied data volume'
  fi
  temporary=$(mktemp /etc/.fstab.echo-authority.XXXXXX)
  cp /etc/fstab "$temporary"
  printf '%s\n' "$expected" >>"$temporary"
  chmod 0644 "$temporary"
  chown root:root "$temporary"
  mv -f -- "$temporary" /etc/fstab
}

write_volume_initialization_seed() {
  local seed_dir=$1 marker="$seed_dir/$VOLUME_INITIALIZATION_MARKER"
  printf 'schema=%s\ndata_volume_id=%s\n' \
    "$VOLUME_INITIALIZATION_SCHEMA" "$DATA_VOLUME_ID" >"$marker"
  chmod 0600 "$marker"
  chown root:root "$marker"
}

finish_pending_volume_initialization() {
  local marker="$DATA_DIR/$VOLUME_INITIALIZATION_MARKER"
  local expected_body marker_body marker_size root_state unexpected
  [[ $INITIALIZE_BLANK_DATA_VOLUME == true ]] \
    || fail 'unfinished blank data volume initialization requires --initialize-blank-data-volume'
  [[ -f $marker && ! -L $marker ]] \
    || fail 'blank data volume initialization marker is missing or unsafe'
  [[ $(stat -c '%u:%g:%a' "$marker") == '0:0:600' ]] \
    || fail 'blank data volume initialization marker permissions are unsafe'
  expected_body="schema=$VOLUME_INITIALIZATION_SCHEMA"$'\n'"data_volume_id=$DATA_VOLUME_ID"
  marker_body=$(cat -- "$marker")
  marker_size=$(stat -c '%s' "$marker")
  [[ $marker_body == "$expected_body" && $marker_size -eq $((${#expected_body} + 1)) ]] \
    || fail 'blank data volume initialization marker does not match this volume'
  [[ -d $DATA_DIR/lost+found && ! -L $DATA_DIR/lost+found ]] \
    || fail 'blank data volume does not contain the expected lost+found directory'
  [[ $(stat -c '%u:%g:%a' "$DATA_DIR/lost+found") == '0:0:700' ]] \
    || fail 'blank data volume lost+found permissions are unsafe'
  [[ -z $(find "$DATA_DIR/lost+found" -mindepth 1 -print -quit) ]] \
    || fail 'blank data volume lost+found directory is not empty'
  unexpected=$(find "$DATA_DIR" -mindepth 1 -maxdepth 1 \
    ! -name lost+found ! -name "$VOLUME_INITIALIZATION_MARKER" -print -quit)
  [[ -z $unexpected ]] \
    || fail 'blank data volume contains state outside its initialization marker'
  root_state=$(stat -c '%u:%g:%a' "$DATA_DIR")
  [[ $root_state == '0:0:755' || $root_state == "$AUTHORITY_UID:$AUTHORITY_GID:755" \
    || $root_state == "$AUTHORITY_UID:$AUTHORITY_GID:700" ]] \
    || fail 'blank data volume root is outside the allowed initialization states'
  chown "$AUTHORITY_UID:$AUTHORITY_GID" "$DATA_DIR"
  chmod 0700 "$DATA_DIR"
  [[ $(stat -c '%u:%g:%a' "$DATA_DIR") == "$AUTHORITY_UID:$AUTHORITY_GID:700" ]] \
    || fail 'blank data volume ownership initialization did not complete'
  rm -f -- "$marker"
}

mount_data_volume() {
  local device=$1 filesystem filesystem_label initialization_seed mounted_source signature
  [[ -d $DATA_DIR && ! -L $DATA_DIR ]] || fail 'Authority data mount path must be an existing non-symlink directory'
  if mountpoint -q "$DATA_DIR"; then
    mounted_source=$(findmnt -n -o SOURCE --target "$DATA_DIR")
    [[ $(readlink -f -- "$mounted_source") == $(readlink -f -- "$device") ]] \
      || fail 'Authority data path is already mounted from an unexpected device'
  else
    [[ -z $(findmnt -rn -S "$device" -o TARGET 2>/dev/null || true) ]] \
      || fail 'supplied data device is already mounted elsewhere'
    [[ -z $(find "$DATA_DIR" -mindepth 1 -maxdepth 1 -print -quit) ]] \
      || fail 'refusing to mount over non-empty root-volume Authority data path'
    filesystem=$(blkid -o value -s TYPE "$device" || true)
    if [[ -z $filesystem ]]; then
      [[ $INITIALIZE_BLANK_DATA_VOLUME == true ]] \
        || fail 'blank data volume requires --initialize-blank-data-volume before formatting'
      signature=$(wipefs -n "$device" || true)
      [[ -z $signature ]] || fail 'refusing to format a device that contains an unrecognized signature'
      initialization_seed=$(mktemp -d /run/echo-authority-volume-init.XXXXXX)
      trap '[[ -z ${initialization_seed:-} ]] || rm -rf -- "$initialization_seed"' RETURN
      write_volume_initialization_seed "$initialization_seed"
      mkfs.ext4 -F -L "$DATA_VOLUME_LABEL" \
        -E root_owner=0:0,root_perms=0755 -d "$initialization_seed" "$device" >/dev/null
      rm -rf -- "$initialization_seed"
      initialization_seed=
      trap - RETURN
      filesystem=ext4
    fi
    [[ $filesystem == ext4 ]] || fail 'Authority data volume must use ext4'
    ensure_fstab_mount "$device"
    mount -o noexec,nodev,nosuid "$device" "$DATA_DIR"
  fi
  [[ $(findmnt -n -o FSTYPE --target "$DATA_DIR") == ext4 ]] \
    || fail 'Authority data path is not an ext4 mount'
  filesystem_label=$(blkid -o value -s LABEL "$device" || true)
  [[ $filesystem_label == "$DATA_VOLUME_LABEL" ]] \
    || fail 'Authority data volume has an unexpected filesystem label'
  ensure_fstab_mount "$device"
  if [[ -e $DATA_DIR/$VOLUME_INITIALIZATION_MARKER ]]; then
    finish_pending_volume_initialization
  fi
  [[ $(stat -c '%u:%g:%a' "$DATA_DIR") == "$AUTHORITY_UID:$AUTHORITY_GID:700" ]] \
    || fail 'mounted Authority data root has unexpected ownership; refusing to rewrite existing state ownership'
}

install_docker_mount_guard() {
  local guard_dir=/usr/local/libexec
  local guard="$guard_dir/echo-authority-require-data-volume"
  local dropin_dir=/etc/systemd/system/docker.service.d
  local dropin="$dropin_dir/echo-authority-data-volume.conf"
  local temporary
  install -d -o root -g root -m 0755 "$guard_dir"
  temporary="$(mktemp "$guard_dir/.echo-authority-require-data-volume.XXXXXX")"
  cat >"$temporary" <<'GUARD'
#!/usr/bin/env bash
set -euo pipefail

config=/etc/echo-authority/host-bootstrap.conf
data_dir=/srv/echo-authority-clean-v1/clean-data
expected_uid=999
expected_gid=988

fail() {
  printf 'echo-authority Docker mount guard: %s\n' "$*" >&2
  exit 1
}

[[ -f $config && ! -L $config ]] || fail 'host bootstrap configuration is missing or unsafe'
[[ $(stat -c '%u:%a' "$config") == '0:600' ]] || fail 'host bootstrap configuration permissions are unsafe'
volume_id=$(awk -F= '$1 == "DATA_VOLUME_ID" { print $2 }' "$config")
[[ $volume_id =~ ^vol-[0-9a-f]{8,17}$ ]] || fail 'configured data volume ID is unsafe'
mountpoint -q "$data_dir" || fail 'Authority data volume is not mounted'
[[ $(findmnt -n -o FSTYPE --target "$data_dir") == ext4 ]] || fail 'Authority data volume is not ext4'
source=$(findmnt -n -o SOURCE --target "$data_dir")
device=$(readlink -f -- "$source")
[[ -b $device ]] || fail 'Authority data mount source is not a block device'
serial=$(lsblk -dn -o SERIAL "$device" | tr -d '-')
[[ $serial == "${volume_id//-/}" ]] || fail 'Authority data mount source does not match configured EBS volume'
[[ $(stat -c '%u:%g:%a' "$data_dir") == "$expected_uid:$expected_gid:700" ]] \
  || fail 'Authority data mount ownership or mode is unsafe'
GUARD
  install -o root -g root -m 0755 "$temporary" "$guard"
  rm -f -- "$temporary"
  install -d -o root -g root -m 0755 "$dropin_dir"
  temporary="$(mktemp "$dropin_dir/.echo-authority-data-volume.XXXXXX")"
  cat >"$temporary" <<EOF
[Unit]
RequiresMountsFor=$DATA_DIR

[Service]
ExecStartPre=$guard
EOF
  install -o root -g root -m 0644 "$temporary" "$dropin"
  rm -f -- "$temporary"
}

install_asm_exec() {
  local temporary=$1 asm_exec="$temporary/asm-exec"
  curl --fail --location --proto '=https' --tlsv1.2 --output "$asm_exec" \
    "https://raw.githubusercontent.com/aws/agent-toolkit-for-aws/${AGENT_TOOLKIT_COMMIT}/plugins/aws-core/skills/aws-secrets-manager/references/asm-exec"
  printf '%s  %s\n' "$ASM_EXEC_UPSTREAM_SHA256" "$asm_exec" | sha256sum --check --status \
    || fail 'upstream asm-exec checksum mismatch'
  patch --batch --forward "$asm_exec" <<'PATCH'
--- asm-exec
+++ asm-exec
@@ -196 +196 @@
-    resp = urllib.request.urlopen(req, timeout=10)
+    resp = urllib.request.urlopen(req, timeout=30)
@@ -203,7 +203,7 @@
         if "SecretString" in payload:
             return payload["SecretString"]
         # call_aws may nest the CLI output under a results/output key
-        for key in ("result", "results", "output", "stdout"):
+        for key in ("result", "results", "output", "stdout", "structuredContent"):
             if key in payload:
                 nested = payload[key]
                 if isinstance(nested, str):
PATCH
  printf '%s  %s\n' "$ASM_EXEC_PATCHED_SHA256" "$asm_exec" | sha256sum --check --status \
    || fail 'patched asm-exec checksum mismatch'
  install -o root -g root -m 0755 "$asm_exec" /usr/local/bin/asm-exec
}

install_cloudflared() {
  local temporary=$1 package="$temporary/cloudflared-linux-arm64.deb"
  curl --fail --location --proto '=https' --tlsv1.2 --output "$package" \
    "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-arm64.deb"
  printf '%s  %s\n' "$CLOUDFLARED_SHA256" "$package" | sha256sum --check --status \
    || fail 'cloudflared package checksum mismatch'
  apt-get install -y --no-install-recommends "$package"
  cloudflared --version | grep -Fq "cloudflared version $CLOUDFLARED_VERSION" \
    || fail 'unexpected cloudflared version after installation'
}

install_ecr_helper_config() {
  local temporary=$1 config="$temporary/docker-config.json"
  install -d -o root -g root -m 0700 /root/.docker
  printf '{\n  "credHelpers": {\n    "%s": "ecr-login"\n  }\n}\n' "$ECR_REGISTRY" >"$config"
  if [[ -e /root/.docker/config.json ]] && ! cmp -s "$config" /root/.docker/config.json; then
    fail '/root/.docker/config.json already exists with different settings; merge the ECR helper manually'
  fi
  install -o root -g root -m 0600 "$config" /root/.docker/config.json
}

install_control_file() {
  local source=$1 destination=$2 mode=$3 label=$4
  [[ -f $source && ! -L $source ]] || fail "$label source is missing or unsafe from the verified host bundle"
  if [[ -e $destination || -L $destination ]]; then
    [[ -f $destination && ! -L $destination ]] || fail "existing $label destination is unsafe"
    cmp -s "$source" "$destination" || \
      fail "existing $label differs from the verified host bundle; review it instead of replacing it"
    chown root:root "$destination"
    chmod "$mode" "$destination"
    return
  fi
  install -o root -g root -m "$mode" "$source" "$destination"
}

install_authority_application_control_material() {
  # These are the only non-secret application files a blank host needs before
  # an operator runs initial onboarding. Runtime files are materialized later
  # from an accepted retained tuple, never copied from the host bundle.
  install -d -o root -g root -m 0755 "$DEPLOY_DIR/release"
  install_control_file "$ONBOARD_SOURCE" "$DEPLOY_DIR/onboard-clean-v1.sh" 0755 'onboarding wrapper'
  install_control_file "$UPDATER_SOURCE" "$DEPLOY_DIR/update-clean-v1.sh" 0755 'release update wrapper'
  install_control_file "$RESTORER_SOURCE" "$DEPLOY_DIR/restore-clean-v1-host.sh" 0755 'retained-host restore wrapper'
  install_control_file "$RELEASE_VALIDATOR_SOURCE" "$DEPLOY_DIR/release/clean-v1-release.py" 0755 'release validator'
  install_control_file "$RUNTIME_PROFILE_VALIDATOR_SOURCE" "$DEPLOY_DIR/release/clean-v1-runtime-profile.py" 0755 'runtime-profile validator'
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --region)
      [[ $# -ge 2 ]] || usage
      AWS_REGION=$2
      shift 2
      ;;
    --tunnel-secret-arn)
      [[ $# -ge 2 && -z $TUNNEL_SECRET_REFERENCE ]] || usage
      TUNNEL_SECRET_REFERENCE=$(reference_from_arn "$2")
      shift 2
      ;;
    --tunnel-secret-reference)
      [[ $# -ge 2 && -z $TUNNEL_SECRET_REFERENCE ]] || usage
      TUNNEL_SECRET_REFERENCE=$2
      shift 2
      ;;
    --ecr-registry)
      [[ $# -ge 2 ]] || usage
      ECR_REGISTRY=$2
      shift 2
      ;;
    --data-volume-id)
      [[ $# -ge 2 ]] || usage
      DATA_VOLUME_ID=$2
      shift 2
      ;;
    --data-device)
      [[ $# -ge 2 ]] || usage
      DATA_DEVICE=$2
      shift 2
      ;;
    --initialize-blank-data-volume)
      INITIALIZE_BLANK_DATA_VOLUME=true
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

[[ ${EUID} -eq 0 ]] || fail 'run this script as root'
[[ $(uname -m) == aarch64 ]] || fail 'this bootstrap supports Ubuntu ARM64 only'
[[ -r /etc/os-release ]] || fail '/etc/os-release is missing'
# shellcheck disable=SC1091
. /etc/os-release
[[ ${ID:-} == ubuntu ]] || fail 'this bootstrap supports Ubuntu only'
for required_source in \
  "$UNIT_SOURCE" "$TOKEN_INSTALLER_SOURCE" "$ONBOARD_SOURCE" "$UPDATER_SOURCE" \
  "$RESTORER_SOURCE" "$RELEASE_VALIDATOR_SOURCE" "$RUNTIME_PROFILE_VALIDATOR_SOURCE"; do
  [[ -f $required_source && ! -L $required_source ]] \
    || fail 'bootstrap source directory is missing required verified host-bundle control material'
done

load_config
[[ -n $AWS_REGION && -n $TUNNEL_SECRET_REFERENCE && -n $ECR_REGISTRY && -n $DATA_VOLUME_ID ]] \
  || fail 'region, tunnel secret reference, ECR registry, and data volume ID are required'
validate_region "$AWS_REGION"
validate_secret_reference "$TUNNEL_SECRET_REFERENCE"
validate_ecr_registry "$ECR_REGISTRY"
validate_volume_id "$DATA_VOLUME_ID"
[[ -z $DATA_DEVICE || $DATA_DEVICE == /dev/* ]] || fail 'data device must be an absolute /dev path'
write_config_if_needed

export DEBIAN_FRONTEND=noninteractive
# Do not leave a package-installed or previously enabled Docker unit able to
# start containers before the detached Authority data volume is verified below.
systemctl disable --now docker.socket >/dev/null 2>&1 || true
systemctl disable --now docker.service >/dev/null 2>&1 || true
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl docker.io docker-compose-v2 amazon-ecr-credential-helper \
  e2fsprogs patch snapd sqlite3
# Package post-install hooks may have started Docker again. Stop it until its
# data-volume precondition is installed and systemd has reloaded it.
systemctl disable --now docker.socket >/dev/null 2>&1 || true
systemctl disable --now docker.service >/dev/null 2>&1 || true
dpkg --compare-versions "$(docker compose version --short)" ge 2.24.4 \
  || fail 'Docker Compose 2.24.4 or newer is required for the EC2 override'

ensure_fixed_authority_identity
ensure_cloudflared_identity
[[ ! -L $DEPLOY_DIR && ! -L $DATA_DIR ]] \
  || fail 'Authority deployment and data paths must not be symlinks'
install -d -o root -g root -m 0755 "$DEPLOY_DIR"
install -d -o root -g root -m 0755 "$DATA_DIR"
install -d -o root -g cloudflared -m 0750 /etc/cloudflared
install -d -o cloudflared -g cloudflared -m 0700 /var/lib/cloudflared

data_device=$(resolve_data_device)
assert_not_root_device "$data_device"
mount_data_volume "$data_device"
install_authority_application_control_material
install_docker_mount_guard
systemctl daemon-reload
systemctl enable --now docker.service

temporary_dir=$(mktemp -d)
trap 'rm -rf -- "$temporary_dir"' EXIT
if ! snap list aws-cli >/dev/null 2>&1; then
  snap install aws-cli --classic
fi
/snap/bin/aws --version >/dev/null
install_asm_exec "$temporary_dir"
install_cloudflared "$temporary_dir"
install_ecr_helper_config "$temporary_dir"

systemctl disable --now cloudflared.service >/dev/null 2>&1 || true
systemctl is-active --quiet cloudflared.service \
  && fail 'package-provided cloudflared.service is unexpectedly active'
install -o root -g root -m 0644 "$UNIT_SOURCE" /etc/systemd/system/cloudflared-echo-authority.service
install -o root -g root -m 0700 "$TOKEN_INSTALLER_SOURCE" /usr/local/sbin/install-echo-authority-tunnel-token
systemctl daemon-reload
systemctl disable --now cloudflared-echo-authority.service >/dev/null 2>&1 || true
systemctl is-active --quiet cloudflared-echo-authority.service \
  && fail 'Authority Cloudflare Tunnel must remain stopped until token installation'

printf '%s\n' \
  "Docker $(docker version --format '{{.Server.Version}}')" \
  "Docker Compose $(docker compose version --short)" \
  "$(/snap/bin/aws --version)" \
  "$(cloudflared --version)" \
  "asm-exec $(sha256sum /usr/local/bin/asm-exec | cut -d ' ' -f 1)" \
  "Authority data volume $DATA_VOLUME_ID is mounted at $DATA_DIR" \
  'Bootstrap complete. The Authority and Cloudflare Tunnel are not running.'
