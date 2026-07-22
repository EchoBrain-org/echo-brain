# Manual N=2 pilot

**Status:** experimental, artifact-bound walkthrough

> This is a historical walkthrough for the frozen pre-promotion pilot. The
> normal product build no longer emits `src/experimental/n2` or its assets.
> Current source changes are validated with `npm run check:experimental`; use
> only a separately preserved pilot artifact for the commands below. Do not
> treat that artifact as the stable employee product or organization service.

This runbook exercises one organization authority and two independently keyed
installations. It uses development file-backed keys, synthetic records, and
manual JSON file exchange. It does not install or qualify the normal
meeting-to-decision runtime.

There are two lanes:

- **Operator A** owns the authority state and installation A.
- **Teammate B** owns installation B and must retain that local state directory.

Start with new, empty state directories. State created by the earlier
challenge/proof and per-event-receipt pilot is intentionally incompatible; it
has no migration path in this disposable experiment and must be archived rather
than reused.

Run every command from the built pilot artifact's `app` directory. The examples
put state and exchange files in its parent directory.

## Prerequisites on both Macs

The pilot requires macOS, Node.js `22.22.1`, npm `10.9.4`, and internet access
for the one-time dependency installation. If Node and npm are absent, paste this
complete command into Terminal:

```sh
curl -fsSL https://nodejs.org/dist/v22.22.1/node-v22.22.1.pkg -o /tmp/node-v22.22.1.pkg && \
  sudo /usr/sbin/installer -pkg /tmp/node-v22.22.1.pkg -target / && \
  hash -r && node --version && npm --version
```

`sudo` requests the Mac login password; Terminal does not display characters as
they are typed. Success ends by printing Node `v22.22.1` and npm `10.9.4`. From
`app`, install only runtime dependencies:

```sh
npm ci --omit=dev
```

Keep the extracted folder in place for the whole walkthrough.

## Terminal and retry rules

- A pathname pasted on its own line is treated as a command. For example,
  pasting `/Users/.../receipt.json` alone produces `permission denied`. Move and
  rename an attachment in Finder, or put its quoted path directly after the
  corresponding `--request`, `--receipt`, `--batch`, or `--response` flag.
- Once a command prints a JSON line containing `"ok":true`, that command
  succeeded. A later shell error does not undo it; do not rerun blindly.
- Exact retry means resending the existing request or batch bytes. Do not rerun
  `join-prepare` or `record-create` to manufacture replacement bytes.
- If an expected output file already exists after success, use that file. A
  different document must never overwrite an occupied output path.
- Never delete `owner-state` or `teammate-state` to clear an error. Preserve the
  directory and send the exact Terminal output to the operator.

## File handoffs

Only the named exchange artifacts move between Macs. Never send an installation
state directory.

| Step                   | Direction | File                                                 |
| ---------------------- | --------- | ---------------------------------------------------- |
| Invite                 | A to B    | `teammate-invite.json` with the built `app` artifact |
| Join                   | B to A    | `teammate-request.json`                              |
| Enrollment             | A to B    | `teammate-enrollment-receipt.json`                   |
| Initial ingest         | B to A    | `teammate-batch-1.json`                              |
| Initial result         | A to B    | `teammate-response-1.json`                           |
| Post-revocation ingest | B to A    | `teammate-batch-2.json`                              |
| Post-revocation result | A to B    | `teammate-response-2.json`                           |

Each ingest response contains exactly one authority-signed
`OrganizationBatchReceipt` for the submitted batch.

## Lane A: initialize the authority and owner installation

On Operator A's Mac, initialize a fresh authority:

```sh
node dist/experimental/n2/manual-onboarding.js authority-init \
  --state ../authority-state \
  --organization-name "Pilot organization" \
  --owner-name "Owner A"
```

Create and accept the owner installation locally:

```sh
node dist/experimental/n2/manual-onboarding.js invite-create \
  --state ../authority-state \
  --membership-type owner \
  --out ../owner-invite.json

node dist/experimental/n2/manual-onboarding.js join-prepare \
  --state ../owner-state \
  --invite ../owner-invite.json \
  --device-class byod \
  --out ../owner-request.json

node dist/experimental/n2/manual-onboarding.js enrollment-complete \
  --state ../authority-state \
  --request ../owner-request.json \
  --out ../owner-enrollment-receipt.json

node dist/experimental/n2/manual-onboarding.js enrollment-accept \
  --state ../owner-state \
  --request ../owner-request.json \
  --receipt ../owner-enrollment-receipt.json
```

Save the `installation_id` printed by owner `join-prepare`; it is needed for
revocation. Enrollment is complete when the final command prints `"ok":true`.

## Lane A: invite teammate B

Create B's provisioned membership and invitation:

```sh
node dist/experimental/n2/manual-onboarding.js invite-create \
  --state ../authority-state \
  --membership-type employee \
  --name "Teammate B" \
  --out ../teammate-invite.json
```

Send B the built artifact and `teammate-invite.json`. Do not include
`authority-state`, `owner-state`, or any owner artifacts.

## Lane B: create the signed enrollment request

After placing `teammate-invite.json` beside `app`, Teammate B runs:

```sh
node dist/experimental/n2/manual-onboarding.js join-prepare \
  --state ../teammate-state \
  --invite ../teammate-invite.json \
  --device-class byod \
  --out ../teammate-request.json
```

This creates B's local installation key and an installation-signed enrollment
request. B sends only `teammate-request.json` to A and keeps
`teammate-state` in place.

## Lane A: complete B's enrollment

After placing the received request beside `app`, Operator A runs:

```sh
node dist/experimental/n2/manual-onboarding.js enrollment-complete \
  --state ../authority-state \
  --request ../teammate-request.json \
  --out ../teammate-enrollment-receipt.json
```

An exact retry with the identical signed request returns the existing authority
result. A sends `teammate-enrollment-receipt.json` to B.

## Lane B: accept enrollment

After placing the receipt beside `app`, Teammate B runs:

```sh
node dist/experimental/n2/manual-onboarding.js enrollment-accept \
  --state ../teammate-state \
  --request ../teammate-request.json \
  --receipt ../teammate-enrollment-receipt.json
```

Success prints `"ok":true`. B is now independently enrolled.

## Initial ingest from A

Operator A creates one synthetic record, packages the pending event, asks the
authority to ingest it, and verifies the single batch receipt locally:

```sh
node dist/experimental/n2/manual-onboarding.js record-create \
  --state ../owner-state \
  --text "Installation A initial N=2 record."

node dist/experimental/n2/manual-onboarding.js batch-create \
  --state ../owner-state \
  --out ../owner-batch-1.json

node dist/experimental/n2/manual-onboarding.js authority-ingest \
  --state ../authority-state \
  --batch ../owner-batch-1.json \
  --out ../owner-response-1.json

node dist/experimental/n2/manual-onboarding.js receipt-accept \
  --state ../owner-state \
  --response ../owner-response-1.json
```

The batch disposition must be accepted and A's acknowledged sequence must be
`1`.

## Initial ingest from B

Teammate B creates and packages one synthetic record:

```sh
node dist/experimental/n2/manual-onboarding.js record-create \
  --state ../teammate-state \
  --text "Installation B initial N=2 record."

node dist/experimental/n2/manual-onboarding.js batch-create \
  --state ../teammate-state \
  --out ../teammate-batch-1.json
```

B sends `teammate-batch-1.json` to A. Operator A places it beside `app` and
runs:

```sh
node dist/experimental/n2/manual-onboarding.js authority-ingest \
  --state ../authority-state \
  --batch ../teammate-batch-1.json \
  --out ../teammate-response-1.json
```

The response must contain one accepted batch receipt. A sends
`teammate-response-1.json` to B, who runs:

```sh
node dist/experimental/n2/manual-onboarding.js receipt-accept \
  --state ../teammate-state \
  --response ../teammate-response-1.json
```

B's acknowledged sequence must be `1`.

## Revoke A and prove that A stops

Operator A replaces the quoted placeholder with the owner installation ID saved
from `join-prepare`, then revokes A:

```sh
node dist/experimental/n2/manual-onboarding.js authority-revoke-installation \
  --state ../authority-state \
  --installation-id "OWNER_INSTALLATION_ID" \
  --reason "Manual N=2 revocation check."
```

A then attempts one more synthetic batch:

```sh
node dist/experimental/n2/manual-onboarding.js record-create \
  --state ../owner-state \
  --text "Installation A must not advance after revocation."

node dist/experimental/n2/manual-onboarding.js batch-create \
  --state ../owner-state \
  --out ../owner-batch-2.json

node dist/experimental/n2/manual-onboarding.js authority-ingest \
  --state ../authority-state \
  --batch ../owner-batch-2.json \
  --out ../owner-response-2.json

node dist/experimental/n2/manual-onboarding.js receipt-accept \
  --state ../owner-state \
  --response ../owner-response-2.json
```

The batch disposition must be rejected and A's acknowledged sequence must
remain `1`.

## Prove that B still advances

Teammate B creates the post-revocation batch:

```sh
node dist/experimental/n2/manual-onboarding.js record-create \
  --state ../teammate-state \
  --text "Installation B remains active after A was revoked."

node dist/experimental/n2/manual-onboarding.js batch-create \
  --state ../teammate-state \
  --out ../teammate-batch-2.json
```

B sends `teammate-batch-2.json` to A. Operator A runs:

```sh
node dist/experimental/n2/manual-onboarding.js authority-ingest \
  --state ../authority-state \
  --batch ../teammate-batch-2.json \
  --out ../teammate-response-2.json
```

The response must contain one accepted batch receipt. A sends
`teammate-response-2.json` to B, who runs:

```sh
node dist/experimental/n2/manual-onboarding.js receipt-accept \
  --state ../teammate-state \
  --response ../teammate-response-2.json
```

The N=2 walkthrough passes when A remains acknowledged at sequence `1` after
revocation while B reaches sequence `2`.

The trust boundary and historical human evidence are described in
[Organization authority foundation](../architecture/organization-authority-foundation.md).
