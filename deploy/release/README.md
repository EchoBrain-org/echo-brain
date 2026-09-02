# Organization Authority release and update procedure

This directory contains the small release boundary used after the first live
organization release. It is deliberately an artifact-selection process, not a
schema migration or client fleet-management system.

The runtime-profile field is current-only. A pre-beta Authority prepared with
an older release record has no compatibility bridge. `clean-v1` describes an
artifact replacement loop, not a database migration: it accepts only the
current provider-neutral Authority V4, private-approval control-plane V2, and
record-log V2 state lineage. For populated state, `stage` pulls the immutable
candidate and runs its state-lineage and admitted-processor verifiers in an
isolated read-only container before any runtime, configuration, or state
mutation. While there are no live users,
run `onboard-clean-v1.sh
replace-rehearsal --confirm-no-live-users`, then prepare the organization again
with the new release record and matching profile. Do not point this updater at
the older accepted record.

## Release record

For each candidate, create exactly one non-secret JSON record containing the
source commit, immutable Authority image reference, Person-client package
version and artifact, the reviewed Authority runtime profile, and compatibility
class. The only supported compatibility class is `clean-v1`.

Use the committed-source pack command first. Its JSON output supplies the
client version and SHA-256:

```sh
npm run pack:person-client -- /absolute/private/release-artifacts
```

Build the Authority image from that same committed source with the guarded
build command. It refuses a dirty worktree, derives the source SHA itself,
checks that the source stays unchanged during the build, and verifies the OCI
revision label. The release record's `source_sha` must be that exact value;
the deploy command checks the pulled image label before it starts the
container.

```sh
npm run build:authority-image -- echo-organization-authority:release-candidate
```

CI separately builds and exercises the Authority for Linux arm64 and records
its OCI source label. It has no registry credentials: publishing the image and
supplying the immutable ECR digest remain an explicit release-operator input.

Create the runtime profile from the four reviewed deployment files in the same
committed source, then validate and record its digest. This profile is a
canonical, non-secret capture of both Compose and Caddy files. The release
operator publishes or transfers it alongside the release record; CI never
pushes it or an image to a registry.

```sh
npm run profile:authority-deployment -- \
  deploy/organization-authority \
  /absolute/private/release-artifacts/runtime-profile.json
node tools/clean-v1-runtime-profile.mjs validate \
  /absolute/private/release-artifacts/runtime-profile.json
node tools/clean-v1-runtime-profile.mjs digest \
  /absolute/private/release-artifacts/runtime-profile.json
```

Create a non-secret draft record from the reviewed image digest and pack output,
then canonicalize it once. The output path must not already exist.

```sh
node tools/clean-v1-release.mjs create release-draft.json \
  /absolute/private/release-records/clean-v1-20260822-001.json
node tools/clean-v1-release.mjs validate \
  /absolute/private/release-records/clean-v1-20260822-001.json
```

Its canonical shape is:

```json
{
  "authority_image": {
    "reference": "<aws-account-id>.dkr.ecr.us-west-2.amazonaws.com/echo-brain/authority@sha256:<64-lowercase-hex>"
  },
  "baseline_compatibility_class": "clean-v1",
  "kind": "echo-clean-v1-release",
  "person_client": {
    "artifact_sha256": "<64-lowercase-hex>",
    "artifact_url": "https://downloads.example/echo-brain-person-client.tgz",
    "package": "@echo-brain/person-client",
    "version": "0.1.0-internal.1"
  },
  "release_id": "clean-v1-20260822-001",
  "released_at": "2026-08-22T20:00:00Z",
  "runtime_profile": {
    "artifact_sha256": "<64-lowercase-hex>",
    "artifact_url": "https://downloads.example/echo-brain-authority-runtime-profile.json",
    "profile_version": "clean-v1-profile-1"
  },
  "schema_version": 1,
  "source_sha": "<40-lowercase-hex>"
}
```

The angle-bracket text above is explanatory only; it is not valid record data.
The record contains neither an Authority credential nor an employee session,
invitation, Slack, Granola, or model secret.

## EC2 Authority replacement

Keep the three operator lanes separate:

- A new organization uses `onboard-clean-v1.sh prepare` and `resume` for the
  one-time initial-owner setup and finalization.
- An existing organization uses this replacement loop. It preserves identity,
  Slack, provider credentials, private state, and approved records.
- A new employee receives the client kit and a fresh invitation; that does not
  restart initial-owner setup or replace the Authority.

Copy the release validators and operational commands from the exact reviewed
source checkout into the deployment directory beside the clean Compose files.
Before copying, compare the SHA-256 of each source file with the private review
receipt for that source commit. For a normal update, do not edit or pre-install
`current.clean-v1.json` by hand:

```sh
cd /srv/echo-authority-clean-v1
install -d -m 0755 release
install -m 0755 /absolute/reviewed/clean-v1-release.py release/clean-v1-release.py
install -m 0755 /absolute/reviewed/clean-v1-runtime-profile.py release/clean-v1-runtime-profile.py
install -m 0755 /absolute/reviewed/update-clean-v1.sh ./update-clean-v1.sh
install -o root -g root -m 0755 \
  /absolute/reviewed/backup-authority-maintenance.sh \
  ./backup-authority-maintenance.sh
install -d -m 0700 clean-data/release
sha256sum ./backup-authority-maintenance.sh
python3 release/clean-v1-release.py validate /absolute/private/release.json
python3 release/clean-v1-runtime-profile.py validate /absolute/private/runtime-profile.json
./update-clean-v1.sh stage --release /absolute/private/release.json \
  --runtime-profile /absolute/private/runtime-profile.json
```

The printed maintenance-script digest must equal the reviewed receipt before
the script is used. It is root-owned host tooling, not application state:
release rollback does not replace or remove it. Replace or remove it only as a
separately reviewed host-tooling change, and record the old and new digests in
the private operator receipt.

For an ordinary baseline-preserving replacement, stage the exact candidate in
the same way. The command refuses floating images, a reused release ID, a
baseline mismatch, a stopped accepted runtime, or a runtime image digest that
does not match the accepted record. It pulls the candidate digest, starts it,
checks the actual running container image digest plus descriptor and safe setup
status, but does not accept it yet.

```sh
./update-clean-v1.sh stage --release /absolute/private/candidate-release.json \
  --runtime-profile /absolute/private/candidate-runtime-profile.json
```

Run the bounded private-DM canary through the selected running release. It
prefers a staged candidate, otherwise uses the accepted release. It refuses any
host except Authority staging, verifies the exact running release, and calls
only the in-container private socket. The printed receipt has only the release
identity, outcome, and opaque approval identity. A `delivery_pending` outcome
is safe to retry; every release uses one stable canary and one Slack message.
Only `staged` succeeds. Other outcomes stop the command without creating
promotion evidence. During a replacement, the accepted image must also
advertise `org.echobrain.authority.state-capability.staging-synthetic-meeting-canary-v1=true`
before the candidate can create synthetic canary state, so the rollback image
can read that state if recovery is needed.

Approve the resulting private card. Then use the packaged Person client to
search for that exact release ID and ask one cited question before making the
existing human promotion confirmation explicit:

```sh
./update-clean-v1.sh canary
echo-brain person records --query '<candidate-release-id> private owner approval delivery'
echo-brain person ask --question 'What did we decide for synthetic staging release <candidate-release-id>?'
./update-clean-v1.sh promote --release /absolute/private/candidate-release.json --canary-passed
```

The canary command stores a private receipt bound to the exact selected release.
Every candidate staged by the update tool requires its own `staged` receipt
before promotion. The `--canary-passed` flag remains the operator's explicit
confirmation that the card was approved and both permission-aware reads
succeeded; a receipt from the currently accepted release cannot promote a
different candidate.

If it fails, restore the prior **same-clean-v1** image, runtime profile, and
environment tuple and leave the accepted record unchanged:

```sh
./update-clean-v1.sh rollback
```

For a first deployment, where no accepted release record exists yet, the same
command is an abort: it stops the staged candidate before archiving that
candidate as failed and does not create an accepted record. After it succeeds,
stage the next candidate with a new release ID.

The operation lock prevents concurrent changes. The environment, active
profile, and four materialized deployment files are replaced individually, so
a host power loss or `SIGKILL` during activation can leave a mixed local cache.
The staged candidate record remains the recovery marker: inspect with `status`,
then run `rollback` to rematerialize and verify the complete accepted tuple
before retrying. Do not edit individual tuple files to recover.

For a replacement, rollback must restart and re-check the prior exact image,
profile, and public descriptor before claiming recovery; otherwise it reports
recovery as unconfirmed.

`./update-clean-v1.sh status` inspects the actual running Authority container
and its image digest, not only `.env`; a stopped or drifted runtime fails. It
does not query SQLite or print credentials. A change that needs a schema
migration is not eligible for this loop; make an explicit migration decision
instead. If persisted state is older or otherwise not that exact V4/V2/V2
lineage, `stage` refuses before activating or recording the candidate. It does
not attempt to repair, infer, or migrate the state.

## First-cohort employee onboarding kit

The supported first-cohort employee path is one private macOS Apple-silicon
kit plus that employee's one-use invitation. The kit carries the exact Person
client, the matching `ECHO.app` hotkey overlay, and a pinned Node 22.22.1
runtime. The employee does not install Node, npm, Homebrew, or a repository
checkout and does not edit `PATH`.

From the accepted release record and exact Person-client artifact, create the
kit on a reviewed macOS arm64 build machine running Node 22.22.1:

```sh
npm run kit:person-onboarding -- \
  --release /absolute/private/current.clean-v1.json \
  --artifact /absolute/private/echo-brain-person-client-0.1.0-internal.1.tgz \
  --app /absolute/private/ECHO.app.zip \
  --output /absolute/private/echo-person-onboarding-clean-v1-20260824-001.tar.gz
```

The builder rejects an overlay whose embedded build identity does not match the
release source SHA, exact Person-client version, macOS, and arm64. The manifest
hash-binds that exact app archive alongside the release record, client artifact,
runtime version, platform, architecture, and Node binary. It emits the private
archive and its SHA-256 receipt without replacing either. Keep the receipt with
the owner-side delivery record and transfer the kit through an authenticated
private channel. That channel is the first-cohort trust boundary: the kit is
internally hash-bound but is not yet independently signed by ECHO.

Immediately before onboarding, the signed-in owner issues or reissues the
employee's invitation and transfers that file privately. On the employee Mac:

1. Extract the kit.
2. Double-click `Start ECHO.command`.
3. Choose the invitation file when macOS asks.
4. Complete Google sign-in in the browser that opens.

The command verifies the kit, installs the versioned client under
`~/Library/Application Support/ECHO`, and validates then installs the matching
overlay at `~/Applications/ECHO.app`. A different valid prior ECHO app is moved
to a private backup before the new bundle is atomically switched into place;
an invalid or non-ECHO bundle is left untouched. The command never launches or
foregrounds the overlay. It copies the selected invitation into a temporary
private file, completes the existing loopback login, and makes one bounded
permission-aware record request. It prints `phase: "ready"` only after that
request succeeds. Reinstalling the same kit preserves an existing Person
session. If `Start ECHO.command` sees any existing session, it stops instead of
silently applying a possibly different person's invitation; use the installed
client for the current person, or log out before onboarding another person.

This rehearsal's membership display name is carried in the server-issued
session and shown by the overlay. It is a required session field, so use a
fresh invitation and onboarding flow after this release instead of reusing an
older local session.
The invitation remains separate because it is employee-bound, short-lived, and
may need reissue without rebuilding the release kit. Authority remains the
source of truth for invitation validity so modest client clock skew cannot
reject a valid invitation. If Authority rejects an unused invitation, the
client makes one bounded existing-identity login attempt without the invitation
grant; if no identity exists, it stops before opening Google and tells the
employee to request a reissued invitation.

The first cohort supports macOS arm64 only. A signed and notarized graphical
installer is a later distribution improvement; it is not required for the
operator-assisted cohort.

## Advanced client-only install or reinstall

The lower-level offline bundle remains available for development and recovery.
Create it from the accepted canonical release record
and the exact client artifact. Use a staged candidate only on the explicitly
designated canary machine before promotion. The bundle builder rejects a
noncanonical record, a mismatched artifact checksum, or a packaged build
identity whose version/source commit does not match that record. Its output
directory must be a canonical, current-user-owned directory with mode `0700`.

```sh
npm run bundle:person-client -- \
  --release /absolute/private/current.clean-v1.json \
  --artifact /absolute/private/echo-brain-person-client-0.1.0-internal.1.tgz \
  --output /absolute/private/echo-brain-person-client-clean-v1-20260822-001.tar.gz
```

The builder atomically publishes each of the archive and its detached
`<bundle>.sha256` sidecar without replacing an existing file. Transfer both
privately. The owner must send the exact 64-character archive digest through
the employee's private invitation channel (or an equivalently authenticated
private channel). That out-of-band owner transfer is the trust boundary; the
sidecar is a transfer receipt, not an authority to trust a newly received
archive.

Before extraction, the employee verifies the received archive against the
digest sent by the owner. On an employee machine with Node 22.22.1 and npm
10.9.4:

```sh
export EXPECTED_BUNDLE_SHA256='exact-64-lowercase-hex-from-owner'
test "$(cat echo-brain-person-client-clean-v1-20260822-001.tar.gz.sha256)" = \
  "$EXPECTED_BUNDLE_SHA256  echo-brain-person-client-clean-v1-20260822-001.tar.gz"
printf '%s  %s\n' "$EXPECTED_BUNDLE_SHA256" \
  echo-brain-person-client-clean-v1-20260822-001.tar.gz | shasum -a 256 -c -
tar -xzf echo-brain-person-client-clean-v1-20260822-001.tar.gz
cd echo-brain-person-client-clean-v1-20260822-001
./install.sh
```

The archive contains exactly the canonical release record, exact client
artifact, release validator, checksum installer, and this zero-argument
wrapper. It contains no Authority image, server state, provider configuration,
or credentials. The installer verifies the release record and artifact
SHA-256 before npm is allowed to unpack it, installs with scripts, audit,
funding notices, and registry access disabled, checks the exact Node/npm
versions, installed package version, and non-secret packaged build identity
against the release source commit, then runs
`echo-brain person status`. That status output contains only the installed
version, whether a local session exists, the server-issued membership display
name and safe owner/employee membership type, and the connected public
Authority origin. It never prints the session, refresh token, invitation grant,
or IDs.

The default per-user prefix is `$HOME/.local`, so the installed `echo-brain`
normally lands in `$HOME/.local/bin`; the installer prints the one PATH command
needed when that bin directory is not active. Re-running `./install.sh` is the
V1 update mechanism. It replaces packaged code only; it leaves the employee's
private session state in place. There is no background updater, MDM integration,
public artifact bucket, signed download URL, or automatic rollback.
