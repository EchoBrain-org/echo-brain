# Clean-v1 release and update loop

This directory contains the small release boundary used after the first live
organization release. It is deliberately an artifact-selection process, not a
schema migration or client fleet-management system.

## Release record

For each candidate, create exactly one non-secret JSON record containing the
source commit, immutable Authority image reference, Person-client package
version, HTTPS artifact location, artifact SHA-256, and compatibility class.
The only supported compatibility class is `clean-v1`.

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
{"authority_image":{"reference":"<aws-account-id>.dkr.ecr.us-west-2.amazonaws.com/echo-brain/authority@sha256:<64-lowercase-hex>"},"baseline_compatibility_class":"clean-v1","kind":"echo-clean-v1-release","person_client":{"artifact_sha256":"<64-lowercase-hex>","artifact_url":"https://downloads.example/echo-brain-person-client.tgz","package":"@echo-brain/person-client","version":"0.1.0-internal.1"},"release_id":"clean-v1-20260822-001","released_at":"2026-08-22T20:00:00Z","schema_version":1,"source_sha":"<40-lowercase-hex>"}
```

The angle-bracket text above is explanatory only; it is not valid record data.
The record contains neither an Authority credential nor an employee session,
invitation, Slack, Granola, or model secret.

## EC2 Authority replacement

Copy the release validator into the deployment directory beside the clean
Compose files, then copy the update command there. The same `stage` and
`promote` commands cover first deployment and ordinary replacement; do not
pre-install a `current.clean-v1.json` record by hand:

```sh
cd /srv/echo-authority-clean-v1
install -d -m 0755 release
install -m 0755 /absolute/reviewed/clean-v1-release.py release/clean-v1-release.py
install -m 0755 /absolute/reviewed/update-clean-v1.sh ./update-clean-v1.sh
install -d -m 0700 clean-data/release
python3 release/clean-v1-release.py validate /absolute/private/release.json
./update-clean-v1.sh stage --release /absolute/private/release.json
```

For this first stage only, the existing configured image may still be the
documented local development value. With no accepted record and no running
Authority, `stage` replaces it with the candidate's immutable digest itself.

For an ordinary baseline-preserving replacement, stage the exact candidate in
the same way. The command refuses floating images, a reused release ID, a
baseline mismatch, a stopped accepted runtime, or a runtime image digest that
does not match the accepted record. It pulls the candidate digest, starts it,
checks the actual running container image digest plus descriptor and safe setup
status, but does not accept it yet.

```sh
./update-clean-v1.sh stage --release /absolute/private/candidate-release.json
```

Perform one bounded post-update canary with the normal product surface: create
or edit one post-cutoff Granola note, approve one resulting Slack card, then
list and search that record with the packaged Person client. If it passes,
make the human confirmation explicit:

```sh
./update-clean-v1.sh promote --release /absolute/private/candidate-release.json --canary-passed
```

If it fails, restore only the prior **same-clean-v1** image and leave the
accepted record unchanged:

```sh
./update-clean-v1.sh rollback
```

For first deployment, a stage failure stops the candidate, marks the record
failed, and accepts nothing. The environment remains pointed at that failed
candidate; a later first stage replaces it with its own immutable digest. For a later
replacement, rollback must restart and re-check the prior exact digest before
claiming recovery; otherwise it reports recovery as unconfirmed.

`./update-clean-v1.sh status` inspects the actual running Authority container
and its image digest, not only `.env`; a stopped or drifted runtime fails. It
does not query SQLite or print credentials. A change that needs a schema
migration is not eligible for this loop; make an explicit migration decision
instead.

## First-cohort employee onboarding kit

The supported first-cohort employee path is one private macOS Apple-silicon
kit plus that employee's one-use invitation. The kit carries the exact Person
client and a pinned Node 22.22.1 runtime. The employee does not install Node,
npm, Homebrew, or a repository checkout and does not edit `PATH`.

From the accepted release record and exact Person-client artifact, create the
kit on a reviewed macOS arm64 build machine running Node 22.22.1:

```sh
npm run kit:person-onboarding -- \
  --release /absolute/private/current.clean-v1.json \
  --artifact /absolute/private/echo-brain-person-client-0.1.0-internal.1.tgz \
  --output /absolute/private/echo-person-onboarding-clean-v1-20260824-001.tar.gz
```

The builder binds the release record, client artifact, runtime version,
platform, architecture, and Node binary hashes in the kit manifest. It emits
the private archive and its SHA-256 receipt without replacing either. Keep the
receipt with the owner-side delivery record and transfer the kit through an
authenticated private channel. That channel is the first-cohort trust boundary:
the kit is internally hash-bound but is not yet Apple-signed or independently
signed by ECHO.

Immediately before onboarding, the signed-in owner issues or reissues the
employee's invitation and transfers that file privately. On the employee Mac:

1. Extract the kit.
2. Double-click `Start ECHO.command`.
3. Choose the invitation file when macOS asks.
4. Complete Google sign-in in the browser that opens.

The command verifies the kit, installs the versioned client under
`~/Library/Application Support/ECHO`, copies the selected invitation into a
temporary private file, completes the existing loopback login, and makes one
bounded permission-aware record request. It prints `phase: "ready"` only after
that request succeeds. Reinstalling the same kit preserves an existing Person
session. If `Start ECHO.command` sees any existing session, it stops instead of
silently applying a possibly different person's invitation; use the installed
client for the current person, or log out before onboarding another person.
The invitation remains separate because it is employee-bound, short-lived, and
may need reissue without rebuilding the release kit.

The first cohort supports macOS arm64 only. A signed and notarized graphical
installer is a later distribution improvement; it is not required for the
founder-assisted cohort.

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
version, whether a local session exists, its safe owner/employee membership
type, and the connected public Authority origin. It never prints the session,
refresh token, invitation grant, or IDs.

The default per-user prefix is `$HOME/.local`, so the installed `echo-brain`
normally lands in `$HOME/.local/bin`; the installer prints the one PATH command
needed when that bin directory is not active. Re-running `./install.sh` is the
V1 update mechanism. It replaces packaged code only; it leaves the employee's
private session state in place. There is no background updater, MDM integration,
public artifact bucket, signed download URL, or automatic rollback.
