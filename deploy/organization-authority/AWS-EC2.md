# ECHO Authority on EC2: minimum v1 cutover

This moves the existing single-organization Authority to one Ubuntu ARM64 EC2
instance in AWS account `904560150024`, region `us-west-2`. Docker runs the
Authority and Caddy. Native `cloudflared` is the only public path. The security
group must have no inbound rules; Docker publishes the HTTP origin only at
`127.0.0.1:80`.

This is deliberately one host, one EBS volume, and one Tunnel replica. It is
not HA. Keep the Mac data only as a cold rollback copy. Its Compose stack and
Tunnel connector must remain stopped; after EC2 accepts traffic, refresh the
entire data generation before any Mac rollback.

## 1. Publish the exact image

Run on the Mac before the downtime window. Do not rebuild the release during
the migration.

```bash
set -euo pipefail
AWS_PROFILE=echo-prod
AWS_REGION=us-west-2
REGISTRY=904560150024.dkr.ecr.us-west-2.amazonaws.com
REPOSITORY=echo/organization-authority
SOURCE_IMAGE=echo-organization-authority:access-recovery-504ec74
RELEASE_TAG=access-recovery-504ec74
EXPECTED_DOCKER_IMAGE_ID=sha256:4d9382177d09163c914a2eabf0ddbf2af0ad5e56d1505e0dd4fb98919ca7aa1d
EXPECTED_ECR_DIGEST=sha256:4d9382177d09163c914a2eabf0ddbf2af0ad5e56d1505e0dd4fb98919ca7aa1d
aws_echo_prod() {
  env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY \
    -u AWS_SESSION_TOKEN -u AWS_SECURITY_TOKEN \
    aws --profile "$AWS_PROFILE" --region "$AWS_REGION" "$@"
}

[[ $(aws_echo_prod sts get-caller-identity --query Account --output text) == 904560150024 ]]

SOURCE_ID="$(docker image inspect "$SOURCE_IMAGE" --format '{{.Id}}')"
[[ $SOURCE_ID == "$EXPECTED_DOCKER_IMAGE_ID" ]]
[[ $(docker image inspect "$SOURCE_ID" --format '{{.Os}}/{{.Architecture}}') == linux/arm64 ]]
aws_echo_prod ecr get-login-password |
  docker login --username AWS --password-stdin "$REGISTRY"
docker tag "$SOURCE_ID" "$REGISTRY/$REPOSITORY:$RELEASE_TAG"
docker push "$REGISTRY/$REPOSITORY:$RELEASE_TAG"
DIGEST="$(aws_echo_prod ecr describe-images \
  --repository-name "$REPOSITORY" \
  --image-ids "imageTag=$RELEASE_TAG" \
  --query 'imageDetails[0].imageDigest' --output text)"
[[ $DIGEST == "$EXPECTED_ECR_DIGEST" ]]
PINNED_IMAGE="$REGISTRY/$REPOSITORY@$DIGEST"
docker pull "$PINNED_IMAGE"
[[ $(docker image inspect "$PINNED_IMAGE" --format '{{.Id}}') == "$EXPECTED_DOCKER_IMAGE_ID" ]]
printf 'ECHO_AUTHORITY_IMAGE=%s\n' "$PINNED_IMAGE"
docker logout "$REGISTRY"
```

`access-recovery-504ec74` is the current pinned production image. It predates
the locally implemented Job B readable-search capability and does **not**
contain `verify-readable-search-backup`. Do not add that command to this
image's cutover, backup, or restore requirements. The Job B-only procedure in
the restore boundary below applies only after a separately promoted
B-capable image has been deliberately selected; local baseline
`588b42828d5c811a4ae51b21e881139109e7e46d` is not that promotion and is not
deployed or released.

Record the ECR digest and Docker image ID separately. The EC2 `.env` must use
the digest-pinned ECR reference, never just a tag. The ECR repository is
immutable and scans on push.

## 2. Prepare EC2 without connecting the Tunnel

Copy `compose.yaml`, `compose.ec2.yaml`, `Caddyfile.ec2`,
`bootstrap-ubuntu-arm64.sh`, `cloudflared-echo-authority.service`, and
`install-cloudflare-tunnel-token.sh`, `asm-exec-structured-content.patch`, and
`restore-authority-state.sh` to the new host through Session Manager. Then run:

```bash
sudo ./bootstrap-ubuntu-arm64.sh
sudo install -o root -g echo-authority -m 0640 \
  compose.yaml compose.ec2.yaml Caddyfile.ec2 /srv/echo-authority/
```

The bootstrap installs Ubuntu's Docker, Compose, ECR credential helper, and AWS
CLI v2. It downloads Cloudflare's ARM64 `2026.7.3` package and verifies SHA-256
`d3ea7d22dd337b465da33d6bc1c4b3cfd381407447a2a7d29542c19783430db3`.
It also installs `asm-exec` from AWS Agent Toolkit commit
`171d4fba3bc404da3473f323c3e293b4a989f089`, verifies SHA-256
`d55eb38ad33a5b76f584ca180f633ecc120cf39b8fd29427ffbe11a8fbf19556`,
and applies the reviewed one-line compatibility patch for the AWS MCP server's
`structuredContent` response. The patched checksum is
`50fe3ed2dba8db65f29f4bfb7e382d8f9a95a0165f15153c7be2e28baeb30b6b`.
It installs the hardened Tunnel unit **disabled and stopped**, with no token.

Create the target environment using the digest printed in step 1:

```bash
sudo bash -c '
set -euo pipefail
cd /srv/echo-authority
AUTHORITY_UID="$(id -u echo-authority)"
AUTHORITY_GID="$(id -g echo-authority)"
IMAGE="904560150024.dkr.ecr.us-west-2.amazonaws.com/echo/organization-authority@sha256:REPLACE_WITH_DIGEST"
[[ $IMAGE == *@sha256:* ]]
umask 077
printf "%s\n" \
  "ECHO_AUTHORITY_HOST=authority.echobrain.org" \
  "ECHO_AUTHORITY_UID=$AUTHORITY_UID" \
  "ECHO_AUTHORITY_GID=$AUTHORITY_GID" \
  "ECHO_AUTHORITY_IMAGE=$IMAGE" > .env
docker compose --env-file .env -f compose.yaml -f compose.ec2.yaml config >/dev/null
docker compose --env-file .env -f compose.yaml -f compose.ec2.yaml pull
'
```

Do not create `/etc/cloudflared/tunnel.token` yet. The current rollback route is
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
MAC_DEPLOY=/Users/zhenye/Desktop/echo-brain/deploy/organization-authority
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
the reviewed restore script to one private S3 prefix:

```bash
BACKUP_BUCKET=echo-org1-prod-authority-backups-904560150024-us-west-2
AWS_PROFILE=echo-prod
AWS_REGION=us-west-2
INSTANCE_ID=i-REPLACE_WITH_INSTANCE_ID
aws_echo_prod() {
  env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY \
    -u AWS_SESSION_TOKEN -u AWS_SECURITY_TOKEN \
    aws --profile "$AWS_PROFILE" --region "$AWS_REGION" "$@"
}
[[ $(aws_echo_prod sts get-caller-identity --query Account --output text) == 904560150024 ]]
STAMP="$(basename "$ARCHIVE" .tar.gz | sed 's/^organization-authority-data-//')"
PREFIX="cutovers/$STAMP"
ARCHIVE_NAME="$(basename "$ARCHIVE")"
ARCHIVE_SHA256="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
aws_echo_prod s3 cp "$ARCHIVE" \
  "s3://$BACKUP_BUCKET/$PREFIX/$ARCHIVE_NAME" --sse AES256
aws_echo_prod s3 cp restore-authority-state.sh \
  "s3://$BACKUP_BUCKET/$PREFIX/restore-authority-state.sh" --sse AES256
```

Have Systems Manager download from S3 with the instance role and run the
reviewed restore script. This passes no AWS credential or bearer URL to EC2:

```bash
SOURCE_URL="https://$BACKUP_BUCKET.s3.$AWS_REGION.amazonaws.com/$PREFIX/"
PARAMETERS="$(jq -cn \
  --arg source_info "$(jq -cn --arg path "$SOURCE_URL" '{path:$path}')" \
  --arg command_line "sudo bash restore-authority-state.sh $ARCHIVE_NAME $ARCHIVE_SHA256" \
  '{sourceType:["S3"],sourceInfo:[$source_info],commandLine:[$command_line]}')"
COMMAND_ID="$(aws_echo_prod ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunRemoteScript \
  --comment 'Restore cold ECHO Authority state' \
  --parameters "$PARAMETERS" \
  --query 'Command.CommandId' --output text)"
aws_echo_prod ssm wait command-executed \
  --command-id "$COMMAND_ID" --instance-id "$INSTANCE_ID"
aws_echo_prod ssm get-command-invocation \
  --command-id "$COMMAND_ID" --instance-id "$INSTANCE_ID" \
  --query '{Status:Status,Output:StandardOutputContent,Error:StandardErrorContent}'
```

Require `Status` to be `Success`. The restore script independently checks the
Mac SHA-256, archive paths, SQLite sidecars, all four database integrity
results, and foreign keys. Transfer the complete `data/` directory as one
unit. Never copy selected SQLite files, credentials, or keys. Do not transfer
the runtime coordination volume or Caddy's old TLS volumes; EC2 Caddy is an
HTTP-only origin behind Cloudflare.

## 4. Validate the new origin while it is still private

On EC2:

```bash
sudo bash -c '
set -euo pipefail
cd /srv/echo-authority
compose() { docker compose --env-file .env -f compose.yaml -f compose.ec2.yaml "$@"; }
compose up -d --no-build --pull always --wait --wait-timeout 90
compose exec -T authority node services/organization-authority/dist/main.js status --config /echo/authority.json
[[ $(curl -sS -o /dev/null -w "%{http_code}" -H "Host: authority.echobrain.org" http://127.0.0.1/_echo/runtime-status) == 404 ]]
curl --fail --silent --show-error -H "Host: authority.echobrain.org" http://127.0.0.1/v1/authority-descriptor
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

In Cloudflare, change the existing `authority.echobrain.org` Tunnel origin to
`http://127.0.0.1:80` and set its HTTP Host header to
`authority.echobrain.org`. Remove the old `originServerName` and `caPool`; they
apply only to the old TLS origin. Use the existing remotely managed tunnel; do
not create a second hostname or connector on the Mac.

The EC2 role may read only the exact Secrets Manager secret
`echo/org1-prod/cloudflare-tunnel-token`. Resolve and install it only after the
private Authority validation in step 4 succeeds:

```bash
sudo /usr/local/sbin/install-echo-authority-tunnel-token
sudo stat -c 'token_mode=%a owner=%U group=%G size=%s' \
  /etc/cloudflared/tunnel.token
sudo systemctl enable --now cloudflared-echo-authority.service
```

The installer makes at most four resolution/install attempts, with 5, 10, and
15 second backoffs. It uses AWS Agent Toolkit's `asm-exec`; the resolved value
exists only in the child process environment and is written atomically to
`/etc/cloudflared/tunnel.token`, owned `root:cloudflared` with mode `0640`.
It never enters user data, command arguments, Git, shell history, clipboard,
logs, or this runbook. Do not continue if the installer fails.

Validate on EC2 and then from a separate machine:

```bash
sudo systemctl --no-pager --full status cloudflared-echo-authority.service
curl --fail --silent http://127.0.0.1:20241/metrics | grep cloudflared_tunnel_ha_connections
curl --fail --silent --show-error https://authority.echobrain.org/v1/authority-descriptor
```

From the separate machine, also pass this public-path cache release gate. The
malformed body deliberately exercises the fixed reviewer-recent-decisions `400`
without using an installation key. Unlike the optional pilot recent-decisions
route, the reviewer route is always composed. Both identical responses must
traverse Cloudflare, retain the origin's `no-store`, and remain a non-hit. Do
not accept a missing Cloudflare cache-status header as proof that the edge did
not cache the route.

```bash
set -euo pipefail
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
    https://authority.echobrain.org/v1/reviewer-recent-decisions)"
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

The public descriptor must retain Authority
`oau_c96b9811-ab11-4c46-96ea-14ccd3bbc2c7` and organization
`org_2f851bb7-34aa-4989-bb44-b42372f28149`. Finally run one real read/refresh
check from Founder before declaring the infrastructure move complete. Validate
each other active installation when that machine is available; do not promote
the next client release until every active installation is qualified.

Once EC2 is accepted as the live owner, persistently disable the old Mac
connector so a reboot cannot create a second Tunnel replica:

```bash
launchctl disable "gui/$(id -u)/com.cloudflare.cloudflared"
```

## Conditional Job B activation

This section applies only after a B-capable image has been selected and the
complete stopped Authority state has been archived and snapshotted. An older
Authority has no organization-member recording activation even though its
image can validate that policy. Do not edit `authority.json` or
`authority-initialization.v1.json` to add it.

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

## Minimum operating checkpoint

After the first successful public refresh:

- Briefly stop cloudflared and the Compose stack, require the Authority
  container to exit with code 0, run `sync`, and request one encrypted EBS
  snapshot before immediately restarting both layers. Keep each quiesced
  snapshot until a newer quiesced checkpoint passes a restore drill.
- Current evidence: quiesced snapshot `snap-0f238691b65a7039e` passed an
  isolated restore drill:
  an encrypted temporary volume was restored and mounted, the exact Authority
  image started with no network, no published ports, no Caddy, and no
  mounted Tunnel token or running cloudflared process, Authority status was
  healthy, and shutdown completed cleanly. The temporary container, volume,
  and instance-side SSM archive and restore script were deleted.
- Enable one EBS Data Lifecycle Manager policy for volumes tagged
  `Project=echo-brain`, `Service=echo-authority`, `Environment=prod`, and
  `Backup=true`. Run daily and retain seven snapshots. These scheduled
  snapshots are a secondary, crash-consistent safety net; the quiesced snapshot
  and complete stopped-state archive remain the existing recovery-grade
  checkpoints. They predate the readable-search baseline: do not treat either
  as B recovery-grade until the stopped verifier succeeds for that checkpoint.
- Monitor `https://authority.echobrain.org/v1/authority-descriptor` with an
  HTTPS string check for the exact Authority ID above. Alarm after two of three
  one-minute health periods fail, and treat missing data as unhealthy.
- Route alarm and recovery notifications through the
  `echo-org1-prod-ops-alerts` SNS topic. The email subscription must be
  confirmed before alerts can be delivered.

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

Keep the restored Authority stopped. If, and only if, this restore uses a
separately promoted B-capable image, run the Job B verifier before starting the
Authority privately or doing external reconciliation:

```bash
compose run --rm --no-deps authority \
  verify-readable-search-backup --config /echo/authority.json
```

It returns `verified` only when the active pointer matches the restored record
head and its complete generation manifests/roots and runtime contract admit;
it returns `not_built` when no active pointer exists, and rejects staging
directories, SQLite sidecars, or every other mixed state. A missing generation
may be rebuilt only from verified current Layer 1 while stopped. If the verifier
rejects an intended stale pointer/head, keep the process offline, retain any
pre-rebuild copy only as an unverified incident snapshot, run the stopped
rebuild, and rerun verification before reconciliation. A stale generation
cannot serve as a historical prefix. This is a conditional B validation gate,
not a requirement for the pinned `access-recovery-504ec74` image.

Once the conditional B verification has succeeded, or does not apply because
the selected image is not B-capable, start the restored Authority privately.
List memberships and installations and compare them with a separately retained
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
  referenced by a reviewer-policy fact; for a separately promoted B-capable
  image, also retain the organization-member-readable policy proof family;
- the complete organization-record chain and applicable client-held record or
  access receipts and heads; for a separately promoted B-capable image, also
  retain both policy-fact admissions, active pointer, exact record head,
  generation manifest/roots, and analyzer/retrieval contract identity;
- for a separately promoted B-capable image, writable readable-search
  query-audit storage and applicable stopped export or expiry receipts; and
- the Founder or trusted operator's explicit release decision.

A mismatch, missing fact, incomplete audit proof, unexplained valid-prefix
rollback, or unavailable client receipt keeps the reviewer route and public
ingress offline. For a separately promoted B-capable image, an invalid or stale
readable-search generation also keeps its route offline. The restore script's
archive, SQLite integrity, and foreign-key checks, plus the conditional stopped
B verification when applicable, do not prove that a rolled-back Person or
authorization state is current. There is intentionally no automatic
reconciliation command: the release evidence must remain outside the state
being restored. Nothing in this baseline runbook claims founder-live or
release qualification.

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
  Its cold snapshot is still current.
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
