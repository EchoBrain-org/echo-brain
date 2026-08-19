# ECHO Authority on EC2: minimum v1 cutover

This moves the existing single-organization Authority to one Ubuntu ARM64 EC2
instance. Docker runs the Authority and Caddy. Native `cloudflared` is the only
public path. The security group must have no inbound rules; Docker publishes
the HTTP origin only at `127.0.0.1:80`.

This is deliberately one host, one EBS volume, and one Tunnel replica. It is
not HA. Keep the Mac data only as a cold rollback copy. Its Compose stack and
Tunnel connector must remain stopped; after EC2 accepts traffic, refresh the
entire data generation before any Mac rollback.

The account, Region, registry, repository, hostname, instance, backup bucket,
expected Authority and organization identities, monitoring topic, volume, and
secret identifiers are protected operator inputs. Keep them in a mode-0600
environment file outside the repository and load them without printing their
values. The commands below require `AWS_PROFILE`, `AWS_REGION`, `AWS_ACCOUNT_ID`,
`ECR_REGISTRY`, `ECR_REPOSITORY`, `AUTHORITY_HOST`, `BACKUP_BUCKET`,
`INSTANCE_ID`, `EXPECTED_AUTHORITY_ID`, `EXPECTED_ORGANIZATION_ID`,
`AUTHORITY_VOLUME_ID`, `TUNNEL_TOKEN_SECRET_ID`,
`GRANOLA_SOURCE_SECRET_ID`, `EXPECTED_RESTORE_SCRIPT_SHA256`,
`OPS_ALERTS_TOPIC_ID`, `PRIVATE_EVIDENCE_DIR`, and `ECHO_REPO_ROOT` when
applicable. The checked-in bootstrap and credential installers remain the
executable owners of their registry, Region, and dynamic-reference pins; the
runbook only compares those pins with protected operator inputs. Artifact
publication also requires `SOURCE_IMAGE`, `RELEASE_TAG`,
`EXPECTED_DOCKER_IMAGE_ID`, and
`EXPECTED_ECR_DIGEST` from reviewed private release evidence. Never copy their
resolved values into this runbook.

[`QUAL-20260814-194049-001`](../../docs/qualification/QUAL-20260814-194049-001-readable-search-minimum-v1.md)
immutably records one exact deployed, founder-live-qualified readable-search
run. It owns that run's source, image, state identities, and non-claims; it is
not a mutable pointer to the running deployment. Select any later artifact from
new reviewed release evidence and create new exact qualification evidence when
making a later promotion claim.

## 1. Publish the exact reviewed image

Run on the Mac before the downtime window. Do not rebuild the selected artifact
during the migration. Load the protected operator environment, then require
every value used below:

```bash
set -euo pipefail
: "${AWS_PROFILE:?load from protected operator environment}"
: "${AWS_REGION:?load from protected operator environment}"
: "${AWS_ACCOUNT_ID:?load from protected operator environment}"
: "${ECR_REGISTRY:?load from protected operator environment}"
: "${ECR_REPOSITORY:?load from protected operator environment}"
: "${TUNNEL_TOKEN_SECRET_ID:?load from protected operator environment}"
: "${GRANOLA_SOURCE_SECRET_ID:?load from protected operator environment}"
: "${ECHO_REPO_ROOT:?load from protected operator environment}"
: "${SOURCE_IMAGE:?load from reviewed private release evidence}"
: "${RELEASE_TAG:?load from reviewed private release evidence}"
: "${EXPECTED_DOCKER_IMAGE_ID:?load from reviewed private release evidence}"
: "${EXPECTED_ECR_DIGEST:?load from reviewed private release evidence}"
DEPLOY_ROOT="$(git -C "$ECHO_REPO_ROOT" rev-parse --show-toplevel)/deploy/organization-authority"
BOOTSTRAP="$DEPLOY_ROOT/bootstrap-ubuntu-arm64.sh"
TOKEN_INSTALLER="$DEPLOY_ROOT/install-cloudflare-tunnel-token.sh"
GRANOLA_INSTALLER="$DEPLOY_ROOT/install-granola-organization-source.sh"
[[ -f $BOOTSTRAP && -f $TOKEN_INSTALLER && -f $GRANOLA_INSTALLER ]]
[[ $ECR_REGISTRY == "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com" ]]
BOOTSTRAP_REGISTRY="$(sed -n 's/^ECR_REGISTRY=//p' "$BOOTSTRAP")"
INSTALLER_REGION="$(sed -n 's/^AWS_REGION=//p' "$TOKEN_INSTALLER")"
INSTALLER_REFERENCE="$(
  sed -n "s/^TOKEN_REFERENCE='\\(.*\\)'$/\\1/p" "$TOKEN_INSTALLER"
)"
GRANOLA_INSTALLER_REGION="$(sed -n 's/^AWS_REGION=//p' "$GRANOLA_INSTALLER")"
GRANOLA_INSTALLER_SECRET_ID="$(sed -n 's/^SECRET_ID=//p' "$GRANOLA_INSTALLER")"
GRANOLA_API_REFERENCE="$(
  sed -n 's/^API_KEY_REFERENCE="\(.*\)"$/\1/p' "$GRANOLA_INSTALLER"
)"
GRANOLA_OWNER_REFERENCE="$(
  sed -n 's/^OWNER_EMAIL_REFERENCE="\(.*\)"$/\1/p' "$GRANOLA_INSTALLER"
)"
GRANOLA_SCOPE_REFERENCE="$(
  sed -n 's/^SCOPE_REFERENCE="\(.*\)"$/\1/p' "$GRANOLA_INSTALLER"
)"
[[ $BOOTSTRAP_REGISTRY == "$ECR_REGISTRY" ]]
[[ $INSTALLER_REGION == "$AWS_REGION" ]]
[[ $INSTALLER_REFERENCE == "{{resolve:secretsmanager:${TUNNEL_TOKEN_SECRET_ID}}}" ]]
[[ $GRANOLA_INSTALLER_REGION == "$AWS_REGION" ]]
[[ $GRANOLA_INSTALLER_SECRET_ID == "$GRANOLA_SOURCE_SECRET_ID" ]]
[[ $GRANOLA_API_REFERENCE == '{{resolve:secretsmanager:${SECRET_ID}:SecretString:api_key}}' ]]
[[ $GRANOLA_OWNER_REFERENCE == '{{resolve:secretsmanager:${SECRET_ID}:SecretString:owner_email}}' ]]
[[ $GRANOLA_SCOPE_REFERENCE == '{{resolve:secretsmanager:${SECRET_ID}:SecretString:credential_scope}}' ]]
aws_operator() {
  env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY \
    -u AWS_SESSION_TOKEN -u AWS_SECURITY_TOKEN \
    aws --profile "$AWS_PROFILE" --region "$AWS_REGION" "$@"
}

[[ $(aws_operator sts get-caller-identity --query Account --output text) == "$AWS_ACCOUNT_ID" ]]

SOURCE_ID="$(docker image inspect "$SOURCE_IMAGE" --format '{{.Id}}')"
[[ $SOURCE_ID == "$EXPECTED_DOCKER_IMAGE_ID" ]]
[[ $(docker image inspect "$SOURCE_ID" --format '{{.Os}}/{{.Architecture}}') == linux/arm64 ]]
aws_operator ecr get-login-password |
  docker login --username AWS --password-stdin "$ECR_REGISTRY"
docker tag "$SOURCE_ID" "$ECR_REGISTRY/$ECR_REPOSITORY:$RELEASE_TAG"
docker push "$ECR_REGISTRY/$ECR_REPOSITORY:$RELEASE_TAG"
DIGEST="$(aws_operator ecr describe-images \
  --repository-name "$ECR_REPOSITORY" \
  --image-ids "imageTag=$RELEASE_TAG" \
  --query 'imageDetails[0].imageDigest' --output text)"
[[ $DIGEST == "$EXPECTED_ECR_DIGEST" ]]
PINNED_IMAGE="$ECR_REGISTRY/$ECR_REPOSITORY@$DIGEST"
docker pull "$PINNED_IMAGE"
[[ $(docker image inspect "$PINNED_IMAGE" --format '{{.Id}}') == "$EXPECTED_DOCKER_IMAGE_ID" ]]
printf 'ECHO_AUTHORITY_IMAGE=%s\n' "$PINNED_IMAGE"
docker logout "$ECR_REGISTRY"
```

Record the ECR digest, Docker image ID, and `PINNED_IMAGE` in private release
evidence. The EC2 `.env` must use the digest-pinned ECR reference, never just a
tag. The ECR repository is immutable and scans on push. Readable-search
maintenance applies only when the selected exact image exposes those commands
and its reviewed evidence names compatible state; never infer capability from
a historical tag.

## 2. Prepare EC2 without connecting the Tunnel

Copy `compose.yaml`, `compose.ec2.yaml`, `Caddyfile.ec2`,
`bootstrap-ubuntu-arm64.sh`, `cloudflared-echo-authority.service`,
`install-cloudflare-tunnel-token.sh`,
`install-granola-organization-source.sh`,
`asm-exec-structured-content.patch`, and `restore-authority-state.sh` to the
new host through Session Manager. Then run:

```bash
set -euo pipefail
sudo ./bootstrap-ubuntu-arm64.sh
sudo install -o root -g echo-authority -m 0640 \
  compose.yaml compose.ec2.yaml Caddyfile.ec2 /srv/echo-authority/
```

The bootstrap installs Ubuntu's Docker, Compose, ECR credential helper, and AWS
CLI v2. It downloads and verifies the exact Cloudflare ARM64 package and
`asm-exec` revision pinned in `bootstrap-ubuntu-arm64.sh`, applies the checked-in
compatibility patch, verifies the patched bytes, and installs the hardened
Tunnel unit **disabled and stopped**, with no token. It also installs the
Granola source installer without resolving or writing a credential. The script
is the single source for those version and digest pins; do not copy them into
this runbook.

Create the target environment using `PINNED_IMAGE` from the private release
record and `AUTHORITY_HOST` from the protected operator environment:

```bash
set -euo pipefail
: "${PINNED_IMAGE:?load from private release evidence}"
: "${AUTHORITY_HOST:?load from protected operator environment}"
[[ $AUTHORITY_HOST =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]]
[[ $PINNED_IMAGE =~ ^[a-z0-9.-]+(/[a-z0-9._-]+)+@sha256:[0-9a-f]{64}$ ]]
AUTHORITY_UID="$(id -u echo-authority)"
AUTHORITY_GID="$(id -g echo-authority)"
STAGED_ENV="$(mktemp)"
trap 'rm -f -- "$STAGED_ENV"' EXIT
umask 077
printf "%s\n" \
  "ECHO_AUTHORITY_HOST=$AUTHORITY_HOST" \
  "ECHO_AUTHORITY_UID=$AUTHORITY_UID" \
  "ECHO_AUTHORITY_GID=$AUTHORITY_GID" \
  "ECHO_AUTHORITY_IMAGE=$PINNED_IMAGE" > "$STAGED_ENV"
sudo install -o root -g echo-authority -m 0600 \
  "$STAGED_ENV" /srv/echo-authority/.env
rm -f -- "$STAGED_ENV"
trap - EXIT
sudo bash -c '
  set -euo pipefail
  cd /srv/echo-authority
  docker compose --env-file .env -f compose.yaml -f compose.ec2.yaml config >/dev/null
  docker compose --env-file .env -f compose.yaml -f compose.ec2.yaml pull
'
```

Do not create `/etc/cloudflared/tunnel.token` yet. The pre-cutover rollback route is
`https://localhost:443`, with HTTP Host and TLS server name `localhost`, TLS
verification enabled, and the Mac `data/caddy-local-root.crt` as `caPool`.
Confirm those values and confirm in the Cloudflare dashboard that the Mac is
the only connector before freezing state.

## 3. Cold-copy all Authority state

There must never be two independent copies accepting traffic. At the start of
the downtime window, unload the existing Mac Tunnel first, then stop the entire
Mac Compose stack:

```bash
set -euo pipefail
: "${ECHO_REPO_ROOT:?load from protected operator environment}"
MAC_DEPLOY="$(git -C "$ECHO_REPO_ROOT" rev-parse --show-toplevel)/deploy/organization-authority"
[[ -d $MAC_DEPLOY ]]
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.cloudflare.cloudflared.plist"
! pgrep -f '[c]loudflared tunnel run'
cd "$MAC_DEPLOY"
compose() { docker compose --env-file .env -f compose.yaml "$@"; }
AUTHORITY_CONTAINER="$(compose ps -q authority)"
[[ -n $AUTHORITY_CONTAINER ]]
compose stop
[[ $(docker inspect --format '{{.State.Status}}' "$AUTHORITY_CONTAINER") == exited ]]
[[ $(docker inspect --format '{{.State.ExitCode}}' "$AUTHORITY_CONTAINER") == 0 ]]
compose run --rm --no-deps authority \
  status --config /echo/authority.json
compose down
[[ -z $(compose ps -q) ]]

! find data/state -type f \
  \( -name '*-wal' -o -name '*-shm' -o -name '*-journal' \) \
  -print -quit | grep -q .
for db in data/state/{authority,integrations,record-log,record-derived}.sqlite; do
  [[ -f $db ]]
  [[ $(sqlite3 -batch "file:$db?mode=ro&immutable=1" \
    'PRAGMA integrity_check;') == ok ]]
  [[ -z $(sqlite3 -batch "file:$db?mode=ro&immutable=1" \
    'PRAGMA foreign_key_check;') ]]
done
! find data -type l -print -quit | grep -q .

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE="$HOME/organization-authority-data-$STAMP.tar.gz"
(umask 077; COPYFILE_DISABLE=1 tar -czf "$ARCHIVE" data)
chmod 0600 "$ARCHIVE"
tar -tzf "$ARCHIVE" >/dev/null
shasum -a 256 "$ARCHIVE" | tee "$ARCHIVE.sha256"
```

Do not restart either Mac process after the snapshot. Upload the archive and
reviewed restore script to one private, versioned S3 prefix, then derive the
Systems Manager source URL from that same bucket, Region, and key prefix. This
passes no AWS credential or bearer URL to EC2:

```bash
set -euo pipefail
: "${ARCHIVE:?set to the exact cold archive from the prior step}"
: "${BACKUP_BUCKET:?load from protected operator environment}"
: "${AWS_PROFILE:?load from protected operator environment}"
: "${AWS_REGION:?load from protected operator environment}"
: "${AWS_ACCOUNT_ID:?load from protected operator environment}"
: "${INSTANCE_ID:?load from protected operator environment}"
: "${ECHO_REPO_ROOT:?load from protected operator environment}"
: "${EXPECTED_RESTORE_SCRIPT_SHA256:?load from reviewed private recovery evidence}"
[[ -f $ARCHIVE ]]
[[ $BACKUP_BUCKET =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]]
RESTORE_SCRIPT="$(git -C "$ECHO_REPO_ROOT" rev-parse --show-toplevel)/deploy/organization-authority/restore-authority-state.sh"
[[ -f $RESTORE_SCRIPT ]]
[[ $EXPECTED_RESTORE_SCRIPT_SHA256 =~ ^[0-9a-f]{64}$ ]]
RESTORE_SCRIPT_SHA256="$(shasum -a 256 "$RESTORE_SCRIPT" | awk '{print $1}')"
[[ $RESTORE_SCRIPT_SHA256 == "$EXPECTED_RESTORE_SCRIPT_SHA256" ]]
aws_operator() {
  env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY \
    -u AWS_SESSION_TOKEN -u AWS_SECURITY_TOKEN \
    aws --profile "$AWS_PROFILE" --region "$AWS_REGION" "$@"
}
[[ $(aws_operator sts get-caller-identity --query Account --output text) == "$AWS_ACCOUNT_ID" ]]
BUCKET_REGION="$(aws_operator s3api get-bucket-location \
  --bucket "$BACKUP_BUCKET" --query LocationConstraint --output text)"
[[ $BUCKET_REGION != None ]] || BUCKET_REGION=us-east-1
[[ $BUCKET_REGION == "$AWS_REGION" ]]
[[ $(aws_operator s3api get-bucket-versioning \
  --bucket "$BACKUP_BUCKET" --query Status --output text) == Enabled ]]
STAMP="$(basename "$ARCHIVE" .tar.gz | sed 's/^organization-authority-data-//')"
PREFIX="cutovers/$STAMP"
ARCHIVE_NAME="$(basename "$ARCHIVE")"
ARCHIVE_SHA256="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
[[ $ARCHIVE_NAME =~ ^organization-authority-data-[0-9]{8}T[0-9]{6}Z\.tar\.gz$ ]]
[[ $ARCHIVE_SHA256 =~ ^[0-9a-f]{64}$ ]]
ARCHIVE_VERSION="$(aws_operator s3api put-object \
  --bucket "$BACKUP_BUCKET" \
  --key "$PREFIX/$ARCHIVE_NAME" \
  --body "$ARCHIVE" \
  --expected-bucket-owner "$AWS_ACCOUNT_ID" \
  --server-side-encryption AES256 \
  --query VersionId --output text)"
SCRIPT_VERSION="$(aws_operator s3api put-object \
  --bucket "$BACKUP_BUCKET" \
  --key "$PREFIX/restore-authority-state.sh" \
  --body "$RESTORE_SCRIPT" \
  --expected-bucket-owner "$AWS_ACCOUNT_ID" \
  --server-side-encryption AES256 \
  --query VersionId --output text)"
[[ -n $ARCHIVE_VERSION && $ARCHIVE_VERSION != None && $ARCHIVE_VERSION != null ]]
[[ -n $SCRIPT_VERSION && $SCRIPT_VERSION != None && $SCRIPT_VERSION != null ]]
SOURCE_URL="https://${BACKUP_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${PREFIX}/"
RESTORE_COMMAND="printf '%s  %s\\n' '$EXPECTED_RESTORE_SCRIPT_SHA256' restore-authority-state.sh | sha256sum --check --status && sudo bash restore-authority-state.sh $ARCHIVE_NAME $ARCHIVE_SHA256"
PARAMETERS="$(jq -cn \
  --arg source_info "$(jq -cn --arg path "$SOURCE_URL" '{path:$path}')" \
  --arg command_line "$RESTORE_COMMAND" \
  '{sourceType:["S3"],sourceInfo:[$source_info],commandLine:[$command_line]}')"
COMMAND_ID="$(aws_operator ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunRemoteScript \
  --comment 'Restore cold ECHO Authority state' \
  --parameters "$PARAMETERS" \
  --query 'Command.CommandId' --output text)"
aws_operator ssm wait command-executed \
  --command-id "$COMMAND_ID" --instance-id "$INSTANCE_ID"
STATUS="$(aws_operator ssm get-command-invocation \
  --command-id "$COMMAND_ID" --instance-id "$INSTANCE_ID" \
  --query Status --output text)"
[[ $STATUS == Success ]]
printf 'archive_version=%s script_version=%s script_sha256=%s command_id=%s status=%s\n' \
  "$ARCHIVE_VERSION" "$SCRIPT_VERSION" "$RESTORE_SCRIPT_SHA256" \
  "$COMMAND_ID" "$STATUS"
```

Retain the two object Version IDs, archive and restore-script SHA-256 values,
command ID, and successful status in private cutover evidence. Inspect failed
command output only through
private Systems Manager incident tooling; do not paste it into tracked docs.
The restore script independently checks the Mac SHA-256, archive paths, SQLite
sidecars, all four database integrity results, and foreign keys. Transfer the
complete `data/` directory as one unit. Never copy selected SQLite files,
credentials, or keys. Do not transfer the runtime coordination volume or
Caddy's old TLS volumes; EC2 Caddy is an HTTP-only origin behind Cloudflare.

## 4. Validate the new origin while it is still private

On EC2:

```bash
sudo bash -c '
set -euo pipefail
cd /srv/echo-authority
mapfile -t AUTHORITY_HOST_LINES < <(sed -n "s/^ECHO_AUTHORITY_HOST=//p" .env)
[[ ${#AUTHORITY_HOST_LINES[@]} -eq 1 ]]
ECHO_AUTHORITY_HOST="${AUTHORITY_HOST_LINES[0]}"
[[ $ECHO_AUTHORITY_HOST =~ ^[A-Za-z0-9.-]+$ ]]
compose() { docker compose --env-file .env -f compose.yaml -f compose.ec2.yaml "$@"; }
compose up -d --no-build --pull always --wait --wait-timeout 90
compose exec -T authority node services/organization-authority/dist/main.js status --config /echo/authority.json
[[ $(curl -sS -o /dev/null -w "%{http_code}" -H "Host: $ECHO_AUTHORITY_HOST" http://127.0.0.1/_echo/runtime-status) == 404 ]]
curl --fail --silent --show-error -H "Host: $ECHO_AUTHORITY_HOST" http://127.0.0.1/v1/authority-descriptor
docker port "$(compose ps -q authority)"
'
```

`docker port` must show only `127.0.0.1:80`. If local validation fails, keep
the Tunnel stopped and either repair EC2 or use the pre-cutover rollback below.

After private validation succeeds, remove only the downloaded archive and
restore-script copies from the recorded SSM command staging directory. Retain
the source archive in the private, versioned, SSE-S3 backup bucket as a
recovery artifact. It contains the Authority signing key and administrator and
proxy credentials, so bucket read access is Authority-control access. Do not
delete any S3 object version until a newer quiesced archive and snapshot have
both passed recovery validation.

## 5. Move the public route

In Cloudflare, change the existing `$AUTHORITY_HOST` Tunnel origin to
`http://127.0.0.1:80` and set its HTTP Host header to the exact same protected
hostname. Remove the old `originServerName` and `caPool`; they apply only to
the old TLS origin. Use the existing remotely managed tunnel; do not create a
second hostname or connector on the Mac.

The EC2 role may read only the exact Secrets Manager resource identified by
protected operator input `TUNNEL_TOKEN_SECRET_ID`. Verify that the reviewed
installer's dynamic reference resolves that same identifier without printing
either the identifier or value; step 1 performs that comparison. Resolve and
install the token only after the private Authority validation in step 4
succeeds. The fail-closed sequence stops ingress and removes any old token
before attempting resolution, so an install failure cannot start with stale
credentials:

```bash
sudo bash -c '
set -euo pipefail
systemctl disable --now cloudflared-echo-authority.service
! systemctl is-active --quiet cloudflared-echo-authority.service
! pgrep -x cloudflared >/dev/null
rm -f -- /etc/cloudflared/tunnel.token
/usr/local/sbin/install-echo-authority-tunnel-token
[[ -s /etc/cloudflared/tunnel.token ]]
[[ $(stat -c "%a:%U:%G" /etc/cloudflared/tunnel.token) == 640:root:cloudflared ]]
systemctl enable --now cloudflared-echo-authority.service
systemctl is-active --quiet cloudflared-echo-authority.service
'
```

The installer makes at most four resolution/install attempts, with 5, 10, and
15 second backoffs. It uses AWS Agent Toolkit's `asm-exec`; the resolved value
exists only in the child process environment and is written atomically to
`/etc/cloudflared/tunnel.token`, owned `root:cloudflared` with mode `0640`.
It never enters user data, command arguments, Git, shell history, clipboard,
logs, or this runbook. Do not continue if the installer fails.

Validate the connector on EC2:

```bash
sudo bash -c '
set -euo pipefail
systemctl is-active --quiet cloudflared-echo-authority.service
systemctl --no-pager --full status cloudflared-echo-authority.service
curl --fail --silent http://127.0.0.1:20241/metrics |
  grep -Eq "^cloudflared_tunnel_ha_connections 4(\\.0+)?$"
'
```

Then, from a separate machine, fetch the public descriptor and pass this
public-path cache release gate. The
malformed body deliberately exercises the fixed reviewer-recent-decisions `400`
without using an installation key. Unlike the optional pilot recent-decisions
route, the reviewer route is always composed. Both identical responses must
traverse Cloudflare, retain the origin's `no-store`, and remain a non-hit. Do
not accept a missing Cloudflare cache-status header as proof that the edge did
not cache the route.

```bash
set -euo pipefail
: "${AUTHORITY_HOST:?load from protected operator environment}"
: "${EXPECTED_AUTHORITY_ID:?load from private operator evidence}"
: "${EXPECTED_ORGANIZATION_ID:?load from private operator evidence}"
curl --fail --silent --show-error \
  "https://$AUTHORITY_HOST/v1/authority-descriptor" |
  jq -e --arg authority "$EXPECTED_AUTHORITY_ID" \
    --arg organization "$EXPECTED_ORGANIZATION_ID" \
    '.authority_descriptor.authority_id == $authority and
     .authority_descriptor.organization_id == $organization' >/dev/null
PROBE_DIR="$(mktemp -d)"
chmod 0700 "$PROBE_DIR"
trap 'rm -rf -- "$PROBE_DIR"' EXIT

for ATTEMPT in 1 2; do
  STATUS="$(curl --silent --show-error \
    --request POST \
    --header 'Content-Type: application/json' \
    --data-binary '{' \
    --dump-header "$PROBE_DIR/headers-$ATTEMPT" \
    --output "$PROBE_DIR/body-$ATTEMPT" \
    --write-out '%{http_code}' \
    "https://$AUTHORITY_HOST/v1/reviewer-recent-decisions")"
  [[ $STATUS == 400 ]]
  grep -Eiq '^cf-ray:' "$PROBE_DIR/headers-$ATTEMPT"
  grep -Eiq '^cache-control:[[:space:]]*no-store[[:space:]]*$' \
    "$PROBE_DIR/headers-$ATTEMPT"
  grep -Eiq '^cf-cache-status:' "$PROBE_DIR/headers-$ATTEMPT"
  ! grep -Eiq \
    '^cf-cache-status:[[:space:]]*(hit|stale|updating|revalidated)([[:space:]]|$)' \
    "$PROBE_DIR/headers-$ATTEMPT"
  ! grep -Eiq '^age:' "$PROBE_DIR/headers-$ATTEMPT"
  jq -e \
    '.error == {"code":"invalid_request","message":"request is invalid"}' \
    "$PROBE_DIR/body-$ATTEMPT" >/dev/null
done
```

This probe is a live release gate, not a substitute for the origin HTTP tests.
Record the two `CF-Cache-Status` values with the cutover evidence. Stop the
release if either response is cache-hit-like, lacks `Cache-Control: no-store`,
or does not carry Cloudflare evidence.

The metrics must settle at four HA connections for this one connector, and the
Cloudflare dashboard must show only the intended EC2 connector.

The public descriptor must match `EXPECTED_AUTHORITY_ID` and
`EXPECTED_ORGANIZATION_ID` from independently retained private operator
evidence. Finally run one real read/refresh check from Founder before declaring
the infrastructure move complete. Validate each other active installation when
that machine is available; do not promote the next client release until every
active installation is qualified.

Once EC2 is accepted as the live owner, persistently disable the old Mac
connector so a reboot cannot create a second Tunnel replica:

```bash
launchctl disable "gui/$(id -u)/com.cloudflare.cloudflared"
```

## Conditional organization-member recording activation

This section applies only after a readable-search-capable image with the
activation command has been selected and the complete stopped Authority state
has been archived and snapshotted. An image without that command has no
organization-member recording activation even if it can validate that policy.
Do not edit `authority.json` or `authority-initialization.v1.json` to add it.

Keep the Tunnel stopped, stop the whole Compose stack, and place the reviewed
mode-0600 canonical activation command at
`data/operator/activate-organization-member-recording.json`. Its `rpa_`
identity, Authority and organization IDs, initialized runtime-config and
manifest digests, current active owner tuple, exact member-readable target
policy, fresh timestamp, and reason must all match the stopped deployment. The
target approval-surface instance must already be an exact active
`slack-reactions` binding to the current Slack organization tool; its public
configuration pins Slack identity, channel, and reactions rather than the
product-local `presentation_mode`. Then run:

```bash
sudo bash -c '
set -euo pipefail
cd /srv/echo-authority
compose() { docker compose --env-file .env -f compose.yaml -f compose.ec2.yaml "$@"; }
compose down
compose run --rm --no-deps authority \
  activate-organization-member-recording \
  --config /echo/authority.json \
  --command /echo/operator/activate-organization-member-recording.json
compose run --rm --no-deps authority \
  status --config /echo/authority.json
compose up -d --no-build --wait --wait-timeout 90
compose exec -T authority node services/organization-authority/dist/main.js \
  status --config /echo/authority.json
'
```

The activation is an immutable, one-way Authority journal entry layered over
the unchanged initialization baseline. Repeating the exact command returns
the existing receipt; different bytes or a second target are refused. This
does not switch a product installation. Reconfigure each stopped producer
separately, where its local frozen-card preflight must pass before it can emit
organization-member-readable cards.

## Founder-live one-meeting ingress gate

This is the minimum live-processing rung. It proves only server-owned source
pull, deterministic extraction, durable admission, and pending approval. It is
not a daemon, approval resolver, record append, delivery, client cutover, or
release. The command pulls at most one meeting and is unavailable while
`serve` owns the Authority singleton.

Use only an organization-owned Granola workspace/admin credential. The old
machine's personal credential is not eligible. A Granola workspace admin must
create or select the key under **Settings → Connectors → Workspace API keys**,
not the separate personal **API keys** page. This is a hard live gate: retain a
non-secret admin provenance record naming the workspace, the Workspace API keys
page, the selected key entry or creation event, the approving admin, and the
review time. Do not retain the key value or any key fragment. Both credential
types pass the same local `grn_` format check, and the `credential_scope` file
cannot prove provenance; `credential_scope=organization` is an assertion
checked against the admin record. Stop before secret installation if that
record is absent or ambiguous. See
[Granola's API documentation](https://docs.granola.ai/help-center/sharing/integrations/granola-api#workspace-api-keys).

Workspace keys expose only public workspace notes and notes in spaces where
**Allow Granola API access** is enabled; they cannot read private notes or
unshared private folders. Put the intended canary meeting in a deliberately
API-enabled space (or the public Team space), and record that non-secret space
selection with the provenance evidence. Otherwise `no_meeting` can mean the
workspace correctly withheld the note rather than that source ingestion is
broken.

In the AWS Console, create or rotate the JSON secret identified by protected
input `GRANOLA_SOURCE_SECRET_ID`; its exact keys are `api_key`, `owner_email`,
and `credential_scope`. `owner_email` must be the canonical lowercase work
address on the exact active consumed OIDC grant and membership; it selects the
member whose meetings may be admitted and is not a Workspace API key owner.
`credential_scope` must be the literal `organization`. Enter values only in the
Console's protected secret-value surface. Never put them in AWS CLI arguments,
shell history, Compose environment, logs, this runbook, or operator evidence.

The EC2 instance role may have `secretsmanager:GetSecretValue` only on the exact
Granola secret ARN in addition to the independently scoped Tunnel secret. It
does not need `ListSecrets`. If the secret uses a customer-managed KMS key,
allow `kms:Decrypt` only on that key and only through the regional Secrets
Manager service. Keep the reviewed policy and exact resource ARNs in private
infrastructure evidence. Do not call `GetSecretValue` to test the policy and do
not read the Secrets Manager Agent directly. The installed helper uses
`asm-exec` dynamic references so plaintext exists only in its child process.

On EC2, use a root Session Manager shell. Run the installer first, then verify
only file structure and permissions. The three resolved values are written
without a trailing newline to fixed private files; do not `cat`, hash, or print
them:

```bash
set -euo pipefail
/usr/local/sbin/install-echo-authority-granola-source --check
/usr/local/sbin/install-echo-authority-granola-source install

CREDENTIAL_DIRECTORY=/srv/echo-authority/data/state/credentials
for name in \
  granola-organization-api-key \
  granola-organization-owner-email \
  granola-organization-credential-scope; do
  path="$CREDENTIAL_DIRECTORY/$name"
  [[ -f $path && ! -L $path && -s $path ]]
  [[ $(stat -c '%a:%U:%G' "$path") == 600:echo-authority:echo-authority ]]
done
```

The corresponding fixed container paths are
`/echo/state/credentials/granola-organization-api-key`,
`/echo/state/credentials/granola-organization-owner-email`, and
`/echo/state/credentials/granola-organization-credential-scope`. The processing
command has no owner-email, credential-scope, or API-key argument.

Before the first processing write, stop public ingress and quiesce every
container. Capture the existing Authority container before stopping it so its
clean exit can be proved. Keep the stack stopped through the snapshot gate:

```bash
set -euo pipefail
systemctl disable --now cloudflared-echo-authority.service
! systemctl is-enabled --quiet cloudflared-echo-authority.service
! systemctl is-active --quiet cloudflared-echo-authority.service
! pgrep -x cloudflared >/dev/null

cd /srv/echo-authority
compose() { docker compose --env-file .env -f compose.yaml -f compose.ec2.yaml "$@"; }
AUTHORITY_CONTAINER="$(compose ps -q authority)"
[[ -n $AUTHORITY_CONTAINER ]]
compose stop
[[ -z $(compose ps -q --status running) ]]
[[ $(docker inspect --format '{{.State.Status}}' "$AUTHORITY_CONTAINER") == exited ]]
[[ $(docker inspect --format '{{.State.ExitCode}}' "$AUTHORITY_CONTAINER") == 0 ]]

EVIDENCE_DIRECTORY=/root/echo-authority-private-evidence
install -d -o root -g root -m 0700 "$EVIDENCE_DIRECTORY"
CHECKPOINT_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
STATUS_RECEIPT="$EVIDENCE_DIRECTORY/pre-one-meeting-status-$CHECKPOINT_STAMP.json"
SEARCH_RECEIPT="$EVIDENCE_DIRECTORY/pre-one-meeting-search-$CHECKPOINT_STAMP.json"
umask 077
compose run --rm --no-deps authority \
  status --config /echo/authority.json > "$STATUS_RECEIPT"
jq -e '
  .schema_version == 1 and
  .kind == "echo-organization-authority-status" and
  .ok == true and .initialized == true and
  .running == false and .healthy == false
' "$STATUS_RECEIPT" >/dev/null

compose run --rm --no-deps authority \
  verify-readable-search-backup --config /echo/authority.json \
  > "$SEARCH_RECEIPT"
jq -e '
  .schema_version == 1 and
  .kind == "echo-organization-authority-readable-search-backup-verification" and
  (.status == "verified" or .status == "not_built")
' "$SEARCH_RECEIPT" >/dev/null

! find data/state -type f \
  \( -name '*-wal' -o -name '*-shm' -o -name '*-journal' \) \
  -print -quit | grep -q .
! find data -type l -print -quit | grep -q .
mapfile -d '' DATABASES < <(
  find data/state -type f -name '*.sqlite' -print0 | sort -z
)
(( ${#DATABASES[@]} > 0 ))
for database in "${DATABASES[@]}"; do
  [[ $(sqlite3 -batch "file:$database?mode=ro&immutable=1" \
    'PRAGMA integrity_check;') == ok ]]
  [[ -z $(sqlite3 -batch "file:$database?mode=ro&immutable=1" \
    'PRAGMA foreign_key_check;') ]]
done
! find data/state -type f \
  \( -name '*-wal' -o -name '*-shm' -o -name '*-journal' \) \
  -print -quit | grep -q .
sync
```

Do not continue unless the status receipt is exactly stopped and the
readable-search receipt is `verified` or `not_built`. From a separate
authenticated operator shell, verify the one attached EBS volume is the
protected `AUTHORITY_VOLUME_ID`, create its checkpoint, wait for completion,
and save the verification outside the repository and Authority state:

```bash
set -euo pipefail
: "${AWS_PROFILE:?load from protected operator environment}"
: "${AWS_REGION:?load from protected operator environment}"
: "${AWS_ACCOUNT_ID:?load from protected operator environment}"
: "${INSTANCE_ID:?load from protected operator environment}"
: "${AUTHORITY_VOLUME_ID:?load from protected infrastructure evidence}"
: "${PRIVATE_EVIDENCE_DIR:?load from protected operator environment}"
[[ $INSTANCE_ID =~ ^i-[0-9a-f]+$ ]]
[[ $AUTHORITY_VOLUME_ID =~ ^vol-[0-9a-f]+$ ]]
[[ $PRIVATE_EVIDENCE_DIR == /* && -d $PRIVATE_EVIDENCE_DIR && ! -L $PRIVATE_EVIDENCE_DIR ]]
aws_operator() {
  env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY \
    -u AWS_SESSION_TOKEN -u AWS_SECURITY_TOKEN \
    aws --profile "$AWS_PROFILE" --region "$AWS_REGION" "$@"
}
[[ $(aws_operator sts get-caller-identity --query Account --output text) == "$AWS_ACCOUNT_ID" ]]

INSTANCE_JSON="$(aws_operator ec2 describe-instances \
  --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].{InstanceId:InstanceId,State:State.Name,BlockDeviceMappings:BlockDeviceMappings}' \
  --output json)"
jq -e --arg instance "$INSTANCE_ID" '
  .InstanceId == $instance and .State == "running" and
  (.BlockDeviceMappings | length) == 1
' <<< "$INSTANCE_JSON" >/dev/null
ACTUAL_VOLUME_ID="$(jq -r '.BlockDeviceMappings[0].Ebs.VolumeId' <<< "$INSTANCE_JSON")"
[[ $ACTUAL_VOLUME_ID == "$AUTHORITY_VOLUME_ID" ]]

VOLUME_JSON="$(aws_operator ec2 describe-volumes \
  --volume-ids "$AUTHORITY_VOLUME_ID" --query 'Volumes[0]' --output json)"
jq -e --arg volume "$AUTHORITY_VOLUME_ID" --arg instance "$INSTANCE_ID" '
  .VolumeId == $volume and .State == "in-use" and .Encrypted == true and
  (.KmsKeyId | type) == "string" and
  ([.Attachments[] |
    select(.InstanceId == $instance and .State == "attached")] | length) == 1
' <<< "$VOLUME_JSON" >/dev/null
VOLUME_SIZE="$(jq -r '.Size' <<< "$VOLUME_JSON")"

CHECKPOINT_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TAG_SPECIFICATIONS="$(jq -cn --arg name "echo-authority-pre-one-meeting-$CHECKPOINT_STAMP" '
  [{ResourceType:"snapshot",Tags:[
    {Key:"Name",Value:$name},
    {Key:"Purpose",Value:"pre-one-meeting-canary"}
  ]}]
')"
SNAPSHOT_ID="$(aws_operator ec2 create-snapshot \
  --volume-id "$AUTHORITY_VOLUME_ID" \
  --description "ECHO Authority pre-one-meeting checkpoint $CHECKPOINT_STAMP" \
  --tag-specifications "$TAG_SPECIFICATIONS" \
  --query SnapshotId --output text)"
[[ $SNAPSHOT_ID =~ ^snap-[0-9a-f]+$ ]]
aws_operator ec2 wait snapshot-completed --snapshot-ids "$SNAPSHOT_ID"
SNAPSHOT_JSON="$(aws_operator ec2 describe-snapshots \
  --snapshot-ids "$SNAPSHOT_ID" --query 'Snapshots[0]' --output json)"
jq -e \
  --arg snapshot "$SNAPSHOT_ID" \
  --arg volume "$AUTHORITY_VOLUME_ID" \
  --arg owner "$AWS_ACCOUNT_ID" \
  --argjson size "$VOLUME_SIZE" '
    .SnapshotId == $snapshot and .VolumeId == $volume and
    .OwnerId == $owner and .State == "completed" and
    .Progress == "100%" and .Encrypted == true and
    (.KmsKeyId | type) == "string" and .VolumeSize == $size
  ' <<< "$SNAPSHOT_JSON" >/dev/null

umask 077
EVIDENCE_FILE="$PRIVATE_EVIDENCE_DIR/pre-one-meeting-checkpoint-$CHECKPOINT_STAMP.json"
jq -n \
  --arg recorded_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg account_id "$AWS_ACCOUNT_ID" \
  --arg region "$AWS_REGION" \
  --arg instance_id "$INSTANCE_ID" \
  --arg volume_id "$AUTHORITY_VOLUME_ID" \
  --arg snapshot_id "$SNAPSHOT_ID" \
  --argjson volume_size "$VOLUME_SIZE" \
  '{schema_version:1,kind:"echo-authority-pre-one-meeting-checkpoint",
    recorded_at:$recorded_at,account_id:$account_id,region:$region,
    instance_id:$instance_id,volume_id:$volume_id,snapshot_id:$snapshot_id,
    volume_size_gib:$volume_size,state:"completed",progress:"100%",
    encrypted:true}' > "$EVIDENCE_FILE"
chmod 0600 "$EVIDENCE_FILE"
```

If snapshot creation, waiting, or exact verification fails, keep both the stack
and Tunnel stopped. A pending or in-progress snapshot is not the checkpoint.

After the snapshot is verified, return to the stopped EC2 root shell. Load the
exact active Person/source tuple from protected operator evidence. Owner email,
credential scope, and API key deliberately do not appear here:

```bash
set -euo pipefail
cd /srv/echo-authority
compose() { docker compose --env-file .env -f compose.yaml -f compose.ec2.yaml "$@"; }
[[ -z $(compose ps -q --status running) ]]
! systemctl is-active --quiet cloudflared-echo-authority.service
: "${PROCESSING_PRINCIPAL_ID:?load from protected operator evidence}"
: "${PROCESSING_MEMBERSHIP_ID:?load from protected operator evidence}"
: "${PROCESSING_MEMBERSHIP_TYPE:?load from protected operator evidence}"
: "${PROCESSING_SOURCE_INSTANCE:?load from protected operator evidence}"
[[ $PROCESSING_MEMBERSHIP_TYPE == owner || $PROCESSING_MEMBERSHIP_TYPE == employee ]]

EVIDENCE_DIRECTORY=/root/echo-authority-private-evidence
[[ -d $EVIDENCE_DIRECTORY && ! -L $EVIDENCE_DIRECTORY ]]
RUN_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_RECEIPT="$EVIDENCE_DIRECTORY/one-meeting-$RUN_STAMP.json"
RUN_ERROR="$EVIDENCE_DIRECTORY/one-meeting-$RUN_STAMP.stderr"
umask 077
run_one_meeting() {
  compose run --rm --no-deps authority \
    process-one-meeting \
    --config /echo/authority.json \
    --principal-id "$PROCESSING_PRINCIPAL_ID" \
    --membership-id "$PROCESSING_MEMBERSHIP_ID" \
    --membership-type "$PROCESSING_MEMBERSHIP_TYPE" \
    --source-instance "$PROCESSING_SOURCE_INSTANCE"
}
if ! run_one_meeting > "$RUN_RECEIPT" 2> "$RUN_ERROR"; then
  printf '%s\n' 'one-meeting command failed; keep the stack and Tunnel stopped' >&2
  exit 1
fi

jq -e --arg source "$PROCESSING_SOURCE_INSTANCE" '
  .schema_version == 1 and
  .kind == "echo-organization-authority-one-meeting-run" and
  .source == {adapter_id:"granola",instance_id:$source} and
  .decision_processor.adapter_id == "structured-text" and
  (.decision_processor.instance_id | type) == "string" and
  (.decision_processor.instance_id | length) > 0 and
  (.source_binding.owner == "provisioned" or .source_binding.owner == "existing") and
  (.source_binding.configuration == "provisioned" or
    .source_binding.configuration == "existing") and
  .ok == true and .failure_count == 0 and .failure_stages == [] and
  .meetings_processed == 0 and .meetings_skipped == 0 and
  .meetings_rejected == 0 and .meetings_dead_lettered == 0 and
  .deliveries == 0 and
  (
    (.outcome == "pending_created" and .meetings_seen == 1 and
      .meetings_pending == 1 and .cursor_advanced == false and
      (.pending_approval_ids | length) == 1 and
      (.pending_approval_ids[0] | type) == "string" and
      (.pending_approval_ids[0] | length) > 0) or
    (.outcome == "no_meeting" and .meetings_seen == 0 and
      .meetings_pending == 0 and
      (.cursor_advanced | type) == "boolean" and
      .pending_approval_ids == []) or
    (.outcome == "pending_exists" and .meetings_seen == 0 and
      .meetings_pending == 1 and .cursor_advanced == false and
      (.pending_approval_ids | length) == 1 and
      (.pending_approval_ids[0] | type) == "string" and
      (.pending_approval_ids[0] | length) > 0)
  )
' "$RUN_RECEIPT" >/dev/null
OUTCOME="$(jq -r '.outcome' "$RUN_RECEIPT")"
if [[ $OUTCOME == pending_exists ]]; then
  : "${PRIOR_PENDING_RECEIPT:?set to the prior private one-meeting receipt}"
  [[ -f $PRIOR_PENDING_RECEIPT && ! -L $PRIOR_PENDING_RECEIPT ]]
  PRIOR_APPROVAL_ID="$(jq -er '
    select(.outcome == "pending_created" or .outcome == "pending_exists") |
    .pending_approval_ids |
    select(length == 1) |
    .[0] |
    select(type == "string" and length > 0)
  ' "$PRIOR_PENDING_RECEIPT")"
  jq -e --arg approval "$PRIOR_APPROVAL_ID" \
    '.pending_approval_ids == [$approval]' "$RUN_RECEIPT" >/dev/null
fi
```

The outcome rubric is exact:

- `pending_created` is the one-meeting admission: one seen, zero processed,
  skipped, rejected, dead-lettered, and delivered; one pending; no cursor
  advance or failures; exactly one opaque approval ID. While still stopped,
  rerun the same command once and require `pending_exists`, zero seen, and the
  same approval ID. That exact-artifact retry returns before provider contact.
- `no_meeting` is a safe bounded page with no pending ID and no delivery or
  failure. The cursor may or may not advance. It is not a live-meeting
  qualification; another bounded run is permitted while stopped.
- `pending_exists` is acceptable only as retry evidence for an approval ID
  already retained in the prior private receipt. It does not admit or qualify a
  new meeting.
- Any other output, nonzero exit, missing receipt, or failed assertion fails the
  gate. Keep the stack and Tunnel stopped. Do not edit or delete processing
  rows; minimum-V1 recovery is replacement from the whole pre-write snapshot.

For a new `pending_created`, execute and validate the one intentional retry:

```bash
if [[ $OUTCOME == pending_created ]]; then
  FIRST_APPROVAL_ID="$(jq -r '.pending_approval_ids[0]' "$RUN_RECEIPT")"
  RETRY_RECEIPT="$EVIDENCE_DIRECTORY/one-meeting-retry-$RUN_STAMP.json"
  RETRY_ERROR="$EVIDENCE_DIRECTORY/one-meeting-retry-$RUN_STAMP.stderr"
  if ! run_one_meeting > "$RETRY_RECEIPT" 2> "$RETRY_ERROR"; then
    printf '%s\n' 'one-meeting retry failed; keep the stack and Tunnel stopped' >&2
    exit 1
  fi
  jq -e --arg source "$PROCESSING_SOURCE_INSTANCE" \
    --arg approval "$FIRST_APPROVAL_ID" '
      .schema_version == 1 and
      .kind == "echo-organization-authority-one-meeting-run" and
      .source == {adapter_id:"granola",instance_id:$source} and
      .outcome == "pending_exists" and .ok == true and
      .meetings_seen == 0 and .meetings_processed == 0 and
      .meetings_skipped == 0 and .meetings_pending == 1 and
      .meetings_rejected == 0 and .meetings_dead_lettered == 0 and
      .deliveries == 0 and .cursor_advanced == false and
      .failure_count == 0 and .failure_stages == [] and
      .pending_approval_ids == [$approval]
    ' "$RETRY_RECEIPT" >/dev/null
fi
```

The receipts deliberately contain no title, transcript, summary, participant,
owner email, provider meeting ID, credential, or failure message. Keep them and
the command stderr mode `0600` in private evidence; do not paste either into a
tracked file or chat.

After an accepted outcome, start `authority` and `proxy` while ingress remains
off, prove private health, and only then enable the Tunnel. Do not reverse this
order:

```bash
set -euo pipefail
cd /srv/echo-authority
compose() { docker compose --env-file .env -f compose.yaml -f compose.ec2.yaml "$@"; }
! systemctl is-active --quiet cloudflared-echo-authority.service
compose up -d --no-build --wait --wait-timeout 90
PRIVATE_STATUS="$(
  compose exec -T authority node \
    services/organization-authority/dist/main.js \
    status --config /echo/authority.json
)"
jq -e '
  .schema_version == 1 and
  .kind == "echo-organization-authority-status" and
  .ok == true and .initialized == true and
  .running == true and .healthy == true
' <<< "$PRIVATE_STATUS" >/dev/null
mapfile -t AUTHORITY_HOST_LINES < <(sed -n 's/^ECHO_AUTHORITY_HOST=//p' .env)
[[ ${#AUTHORITY_HOST_LINES[@]} -eq 1 ]]
ECHO_AUTHORITY_HOST="${AUTHORITY_HOST_LINES[0]}"
[[ $ECHO_AUTHORITY_HOST =~ ^[A-Za-z0-9.-]+$ ]]
curl --fail --silent --show-error \
  -H "Host: $ECHO_AUTHORITY_HOST" \
  http://127.0.0.1/v1/authority-descriptor >/dev/null

systemctl enable --now cloudflared-echo-authority.service
systemctl is-enabled --quiet cloudflared-echo-authority.service
systemctl is-active --quiet cloudflared-echo-authority.service
for attempt in {1..12}; do
  if curl --fail --silent http://127.0.0.1:20241/metrics |
    grep -Eq '^cloudflared_tunnel_ha_connections 4(\.0+)?$'; then
    break
  fi
  (( attempt < 12 )) || exit 1
  sleep 5
done
```

There is no processing service to disable after the run: the command exits and
the normal runtime has no processing loop. A pending candidate is durable and
is not retention-eligible until a later audited approval or rejection resolves
it. Do not run a second meeting after `pending_created` until approval and
in-process record-delivery stages are intentionally composed and tested.

## Minimum operating checkpoint

After the first successful public refresh:

- Briefly stop cloudflared and the Compose stack, require the Authority
  container to exit with code 0, run `sync`, and request one encrypted EBS
  snapshot before immediately restarting both layers. Keep each quiesced
  snapshot until a newer quiesced checkpoint passes a restore drill.
- Record each quiesced snapshot identifier and isolated restore-drill outcome
  only in private immutable operator evidence. A runbook sentence is not proof
  that a checkpoint remains current or recovery-grade.
- Enable one EBS Data Lifecycle Manager policy for the exact Authority volume
  tags in protected operator configuration. Run daily and retain seven
  snapshots. These scheduled snapshots are a secondary, crash-consistent safety
  net; the quiesced snapshot and complete stopped-state archive remain the
  recovery-grade checkpoints. Do not treat any checkpoint as readable-search
  recovery-grade until the stopped verifier succeeds for that checkpoint.
- Monitor `https://$AUTHORITY_HOST/v1/authority-descriptor` with an HTTPS string
  check for `EXPECTED_AUTHORITY_ID` from private evidence. Alarm after two of
  three one-minute health periods fail, and treat missing data as unhealthy.
- Route alarm and recovery notifications through the protected
  `OPS_ALERTS_TOPIC_ID`. The subscription must be confirmed before alerts can
  be delivered.

Do not add a CloudWatch Agent, dashboard, database replica, automatic failover,
or cross-region copy for this v1 pilot.

## Restore boundary

A snapshot or archive restore is a point-in-time replacement, not a merge. It
rewinds all Authority state to the checkpoint, including memberships,
installations, revocations, access-state heads, audit rows, the
organization-record tail, the readable-search active pointer, and any retained
retrieval generations.

The isolated attachment drill above does not authorize booting directly from a
restored snapshot: that root contains an enabled Tunnel service and its token.
Before a real restore, persistently disable and stop the current connector. A
restored boot volume must have the connector disabled or masked offline, or
outbound connectivity blocked, before its first boot.

Keep the restored Authority stopped. If, and only if, the selected exact image
is readable-search-capable, run its verifier before starting the Authority
privately or doing external reconciliation:

```bash
sudo bash -c '
set -euo pipefail
cd /srv/echo-authority
! systemctl is-enabled --quiet cloudflared-echo-authority.service
! systemctl is-active --quiet cloudflared-echo-authority.service
! pgrep -x cloudflared >/dev/null
compose() { docker compose --env-file .env -f compose.yaml -f compose.ec2.yaml "$@"; }
[[ -z $(compose ps -q --status running) ]]
compose run --rm --no-deps authority \
  verify-readable-search-backup --config /echo/authority.json
'
```

It returns `verified` only when the active pointer matches the restored record
head and its complete generation manifests/roots and runtime contract admit;
it returns `not_built` when no active pointer exists, and rejects staging
directories, SQLite sidecars, or every other mixed state. A missing generation
may be rebuilt only from verified current Layer 1 while stopped. If the verifier
rejects an intended stale pointer/head, keep the process offline, retain any
pre-rebuild copy only as an unverified incident snapshot, run the stopped
rebuild, and rerun verification before reconciliation. A stale generation
cannot serve as a historical prefix. This gate applies only to an image whose
reviewed release evidence includes readable search.

Once the conditional readable-search verification has succeeded, or does not
apply to the selected image, start the restored Authority privately. List
memberships and installations and compare them with a separately retained
incident or operator record. The restored audit log is not sufficient evidence
because it was rewound with the database. Treat every restored active
membership and installation as unverified until the Founder confirms it;
reapply every known membership or installation revocation before reconnecting
public ingress.

Keep the completed evidence in the incident or deployment record outside
`/srv/echo-authority/data` so restored state cannot overwrite it. Record:

- the restored artifact digest, checkpoint time, operator, and validation time;
- proof that the Tunnel and every other ingress path remained disabled while
  the restored process was inspected;
- each current Person root: membership, enrollment, installation, access-lease
  expiry, and revocation state, compared with independently retained operator
  evidence;
- the current integration authorization-audit chain and each reviewer proof
  referenced by a reviewer-policy fact; for a readable-search-capable image,
  also retain the organization-member-readable policy proof family;
- the complete organization-record chain and applicable client-held record or
  access receipts and heads; for a readable-search-capable image, also retain
  both policy-fact admissions, active pointer, exact record head, generation
  manifest/roots, and analyzer/retrieval contract identity;
- for a readable-search-capable image, writable readable-search query-audit
  storage and applicable stopped export or expiry receipts; and
- the Founder or trusted operator's explicit release decision.

A mismatch, missing fact, incomplete audit proof, unexplained valid-prefix
rollback, or unavailable client receipt keeps the reviewer route and public
ingress offline. For a readable-search-capable image, an invalid or stale
generation also keeps its route offline. The restore script's archive, SQLite
integrity, and foreign-key checks, plus stopped readable-search verification
when applicable, do not prove that a rolled-back Person or authorization state
is current. There is intentionally no automatic reconciliation command: the
release evidence must remain outside the state being restored. Completing this
restore establishes no founder-live, client-live, or release qualification and
does not renew or transfer the immutable result of an earlier qualification
report. Any new promotion claim requires exact evidence for the restored
artifact, configuration, state, and environment.

`installation access-recover` is not a remedy when restoring the Authority
makes a client newer than the server. Use a newer checkpoint, or revoke and
replace the stale installation with a newly bootstrapped and enrolled identity.
Keep access recovery only for its documented central-ahead/client-behind case:
active membership and enrollment, active Authority access, a gap of at least
two heads, and an expired current head. It must never reactivate a revoked
membership or installation.

## Rollback boundary

- **Before the EC2 Tunnel starts:** stop the EC2 Compose stack, restore the
  recorded Cloudflare origin settings, start the unchanged Mac Compose stack,
  then deliberately re-enable and start the Mac connector:
  `launchctl enable "gui/$(id -u)/com.cloudflare.cloudflared"`, followed by
  `launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.cloudflare.cloudflared.plist"`.
  Use that cold copy only if private cutover evidence proves it remained stopped
  and unchanged throughout the attempted move.
- **After the EC2 Tunnel starts:** the Mac copy is stale as soon as any request
  can write state. Never simply reconnect it. Run
  `sudo systemctl disable --now cloudflared-echo-authority.service`, verify the
  EC2 connector is gone, and stop Compose cleanly. Cold-copy the entire latest
  EC2 `data/` generation back to the Mac, verify its checksum, start and
  validate the Mac Authority privately, and restore the old Cloudflare origin
  settings. Only then run
  `launchctl enable "gui/$(id -u)/com.cloudflare.cloudflared"` and bootstrap
  the Mac Tunnel.

At every boundary, one Tunnel connector and one Authority state owner is the
maximum. If that cannot be proved, keep both sides stopped.
