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

Build the Authority image from that same committed source with its source SHA
embedded as the OCI revision label. The release record's `source_sha` must be
that exact value; the deploy command checks the pulled image label before it
starts the container.

```sh
SOURCE_SHA="$(git rev-parse HEAD)"
docker build --build-arg ECHO_SOURCE_SHA="$SOURCE_SHA" \
  -f deploy/organization-authority/Dockerfile \
  -t echo-organization-authority:release-candidate .
docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
  echo-organization-authority:release-candidate
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
{"authority_image":{"reference":"123456789012.dkr.ecr.us-west-2.amazonaws.com/echo-brain/authority@sha256:<64-lowercase-hex>"},"baseline_compatibility_class":"clean-v1","kind":"echo-clean-v1-release","person_client":{"artifact_sha256":"<64-lowercase-hex>","artifact_url":"https://downloads.example/echo-brain-person-client.tgz","package":"@echo-brain/person-client","version":"0.1.0-internal.1"},"release_id":"clean-v1-20260822-001","released_at":"2026-08-22T20:00:00Z","schema_version":1,"source_sha":"<40-lowercase-hex>"}
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
cd /srv/echo-authority
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

## Employee client install or reinstall

Give employees the accepted `current.clean-v1.json` record and its exact
artifact through the normal private distribution channel. Use a staged
candidate record only on the explicitly designated canary machine before
promotion. Distribute this small release-helper directory as one unit: both
`clean-v1-release.py` and `install-person-client-clean-v1.sh` must be siblings.
On a machine with Node 22.22.1 and npm 10.9.4, run the copied installer. It
needs no repository checkout, server access, generated IDs, or provider
credentials.

```sh
install -d -m 0700 "$HOME/echo-brain-release-helper"
install -m 0755 /absolute/private/clean-v1-release.py "$HOME/echo-brain-release-helper/clean-v1-release.py"
install -m 0755 /absolute/private/install-person-client-clean-v1.sh "$HOME/echo-brain-release-helper/install-person-client-clean-v1.sh"
"$HOME/echo-brain-release-helper/install-person-client-clean-v1.sh" \
  --release /absolute/private/current.clean-v1.json
```

The default per-user prefix is `$HOME/.local`, so the installed `echo-brain`
normally lands in `$HOME/.local/bin`. Pass `--prefix /absolute/prefix` only
when the organization has a different standard per-user prefix; the installer
prints the one PATH command needed when that bin directory is not active.

For an offline/private transfer, add `--artifact /absolute/path/client.tgz`.
The installer verifies the record, verifies the artifact SHA-256 before npm is
allowed to unpack it, installs with scripts, audit, funding notices, and
registry access disabled, checks the exact Node/npm versions, installed package
version, and non-secret packaged build identity against the release source
commit, then runs
`echo-brain person status`. That status output contains only the installed
version, whether a local session exists, its safe owner/employee membership
type, and the connected public Authority origin. It never prints the session,
refresh token, invitation grant, or IDs.

Re-running the same command is the V1 update mechanism. It replaces packaged
code only; it leaves the employee's private session state in place. There is no
background updater, MDM integration, or automatic rollback.
