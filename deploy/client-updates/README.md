# CLI update staging feed

This dedicated hosting stack prepares an HTTPS endpoint for the signed
[CLI update feed](../../docs/features/client-updates-v1.md). It is separate from
the Authority staging stack and onboarding-transfer storage. Creating the
endpoint does not publish a release, enroll a client, or authorize a candidate.

The S3-only target is the repository-pinned staging account, region `us-west-2`,
stack `echo-client-update-staging-s3-v1`, using the `echo-prod` IAM Identity Center
profile. The stack contains only an encrypted, versioned S3 bucket and its bucket
policy. The bucket is retained on deletion or replacement. There are no
CloudFront, IAM, DNS, Authority-host, provider-secret, or onboarding resources.

This release-file host intentionally permits public HTTPS reads of `feed.json`
and `artifacts/*`. This is an exception to the private-bucket default: bucket
`BlockPublicPolicy` and `RestrictPublicBuckets` are false, while public ACLs remain
blocked and ignored and bucket ownership is enforced. The policy grants no
public listing or writing and denies all insecure transport. Account-level
public-access restrictions still apply; this stack never changes them.

CloudFormation generates the bucket name. The feed uses its regional S3 REST
endpoint over HTTPS, without website hosting, a custom hostname, or redirects.
The existing updater accepts this endpoint and still verifies release signatures.

## Prepare and review hosting

From a clean committed checkout, create a plan in an operator-owned mode-0700
directory outside the checkout:

```sh
npm run client-update:staging -- plan --hosting s3 \
  --output /absolute/private/feed-hosting-s3.json
```

Planning creates a CloudFormation change set and captures its exact template
digest, resource inventory, source commit, and change-set ARN in a mode-0600
receipt. It provisions no bucket. Review that named change set before execution.
Planning may use a committed feature branch; execution
requires that exact source to be merged into fetched `origin/main`.
If the result is `planning`, repeat `plan --hosting s3` with the same output path
to collect the existing change set after AWS finishes validation. Do not choose
a new receipt for the same operation.

After the human approves the exact change set, use the unchanged receipt:

```sh
npm run client-update:staging -- execute \
  --receipt /absolute/private/feed-hosting-s3.json \
  --approve-change-set '<exact-reviewed-change-set-ARN>'
npm run client-update:staging -- status --receipt /absolute/private/feed-hosting-s3.json
```

Preserve an executing or unconfirmed receipt and inspect its existing operation;
do not create a competing deployment or remove a lock to bypass uncertainty.
Execution and status infer the hosting lane from the receipt. The resulting
S3 outputs identify the bucket and HTTPS `feed_url`; no DNS or certificate setup
is needed.

## Existing CloudFront operation

The original `staging-feed-v1.template.json` and CloudFront receipt format remain
supported for inspecting the existing `echo-client-update-staging-v1` operation.
That stack reached `ROLLBACK_COMPLETE` because AWS required account verification
before creating CloudFront resources. Its retained bucket was confirmed private
and empty. Preserve that stack, bucket, and receipt unchanged: do not delete or
reuse them, reset the receipt, or retry an uncertain execution.

The new S3-only plan has its own stack identity and independently scoped receipt.
It supersedes the failed hosting path after the prior rollback is confirmed and
requires review of its own exact change set. Approval for the old CloudFront
change set does not approve the new resources. This is not a recovery operation
on the failed stack. Existing CloudFront receipts stay bound to their original
template and resource inventory.

## Sign and publish the first release

Only `feed.json` and `artifacts/*` are publicly readable. The `s3:GetObject`
permission permits HTTPS GET/HEAD downloads. At publication, set
`Cache-Control: no-store` on the feed and
`Cache-Control: public,max-age=31536000,immutable` on content-addressed artifacts.
Upload their original bytes without content encoding or website redirects. Do
not overwrite an artifact key or upload private records, session state,
invitations, or signing keys.

Use the output URL in the public bootstrap configuration. The release signer
keeps the Ed25519 private key outside the artifact bucket and client kit. The
local signer generates a dedicated Ed25519 key without printing private bytes.
Use an existing operator-owned mode-0700 parent outside every checkout; the
new signer directory must not exist, and paths must have no symlink ancestors:

```sh
npm run client-update:sign -- init --directory /absolute/private/new-staging-signer
```

Keep `private-key.pkcs8.der` in that private directory. `signer.json` contains
only the public key and its fingerprint. Copy its `public_key_spki` into the
bootstrap configuration with the deployed S3 `feed_url`, intended channel,
sequence floor, `automatic: true`, and `installation: "cli-kit"`. No client,
kit, feed, repository or publication receipt receives the private key.

Run the [feed preparation command](../../docs/features/client-updates-v1.md#preparing-an-approved-feed)
with the exact accepted release and platform kit. Keep the prepared bundle,
authorization and receipts in private mode-0700 directories with mode-0600
files. Preview signing before approving its exact manifest digest:

```sh
npm run client-update:sign -- sign \
  --directory /absolute/private/new-staging-signer \
  --prepared /absolute/private/new-feed-bundle \
  --authorization /absolute/private/founder-authorization.json \
  --signature /absolute/private/new-manifest.sig
```

After review, repeat that command with `--approve-manifest <manifest-sha256>`.
Existing user authorization for the same release, channel and operation remains
valid. The signer revalidates the release, kits, founder authorization and pinned
public key; it signs the original manifest bytes and writes a new detached
signature exclusively. Run `client-update-feed.mjs seal` with that signature
and the same authorization to create `feed.json`.

From a reviewed, clean committed checkout, prepare the first publication:

```sh
npm run client-update:publish -- plan \
  --hosting-receipt /absolute/private/feed-hosting-s3.json \
  --prepared /absolute/private/new-feed-bundle \
  --authorization /absolute/private/founder-authorization.json \
  --output /absolute/private/first-publication.json
npm run client-update:publish -- execute \
  --receipt /absolute/private/first-publication.json \
  --approve-manifest '<exact-reviewed-manifest-sha256>'
npm run client-update:publish -- status \
  --receipt /absolute/private/first-publication.json
```

This publisher supports only the first release in the dedicated S3 stack. It
rechecks the account, completed hosting receipt, deployed template, resources,
outputs and versioning. The receipt binds the tooling commit, local input
digests, manifest and exact object inventory. Only content-addressed ZIPs and
`feed.json` can be uploaded. Conditional creates refuse existing keys; an
authenticated 403 never means an object is absent. Artifacts are uploaded and
verified over public HTTPS before the signed feed is uploaded last. Original
bytes, metadata, S3 version IDs and feed signatures are verified again.
Before each new object write, execution requires enough remaining manifest
validity for the bounded upload and verification operations: 24 minutes before
the first write, then eight minutes per remaining new object. It revalidates the
exact sealed inputs and freshness immediately before writing the feed, after
the potentially slow object-existence check. Insufficient validity stops the
write; an expired feed is never intentionally published as a recovery action.

Keep an `unconfirmed` receipt and run `status` against it. Status only inspects
objects; it never uploads. If an attempted write is verified, status can permit
execution to continue with remaining unattempted objects. It never repeats an
attempted PUT. An absent or mismatched attempted object requires investigation;
do not create another receipt, remove locks or overwrite objects to bypass it.
Status can inspect expired signed metadata while retaining signature, release,
authorization, artifact and remote-version checks. Its `metadata_fresh` field
separates current installability from verified historical object publication:
`state: "succeeded"` with `metadata_fresh: false` confirms the uploaded bytes,
but clients still reject that expired feed. Status cannot authorize an expired
write or renew metadata. Signing, sealing and publication remain strict about
freshness. Receipts remain bound to their exact tooling commit; never edit an
old receipt's source binding to run newer tooling against it.
## Replace an existing feed

The original first-publication receipt remains historical evidence for its
original bytes. Do not run its `status` action after replacing `feed.json`: that
receipt intentionally pins the former feed version and would correctly report a
different current feed as unconfirmed.

Use the separate replacement lane only after a new release has passed its own
Authority canary, authenticated record and cited Ask checks, final release
decision, and release-bound authorization. Reuse the enrolled client's existing
bootstrap configuration, including its `feed_url`, channel, public key, and
`installation: "cli-kit"`. Its signed sequence must be strictly greater than
the currently published feed. The lane adds no signer-rotation, channel-change,
rollback, deletion, or hosting-replacement command.

Obtain the expected predecessor SHA-256 from the preserved succeeded most-recent
publication or replacement receipt's `hashes.feed.json` field. For the first
A-to-B update this is the first-publication receipt. It is an explicit human
review binding, not a value inferred from a mutable endpoint. From a reviewed
clean checkout, prepare a distinct replacement receipt:

```sh
npm run client-update:publish -- replace-plan \
  --hosting-receipt /absolute/private/feed-hosting-s3.json \
  --prepared /absolute/private/B-feed-bundle \
  --authorization /absolute/private/B-founder-authorization.json \
  --expected-predecessor '<exact-64-lowercase-hex-feed-sha256>' \
  --output /absolute/private/B-feed-replacement.json
npm run client-update:publish -- replace-execute \
  --receipt /absolute/private/B-feed-replacement.json \
  --approve-manifest '<exact-reviewed-B-manifest-sha256>'
npm run client-update:publish -- replace-status \
  --receipt /absolute/private/B-feed-replacement.json
```

Planning verifies the predecessor's authenticated S3 metadata, public raw bytes,
signature, pinned key, channel, sequence, VersionId, ETag, and the explicit
predecessor SHA. It allows an expired predecessor only for this historical
verification; the successor must still be fresh. Existing artifact keys are
reused only after their authenticated metadata and anonymous HTTPS bytes match
the new signed digest exactly. New artifact keys remain conditional creates.

Before every new artifact write and immediately before the final feed write,
the lane rechecks the predecessor. The one allowed `feed.json` overwrite uses
S3 `PutObject --if-match <predecessor-ETag>`; an ETag mismatch or concurrent
write leaves the replacement receipt unconfirmed and never triggers another
PUT. AWS documents `If-Match` as an ETag condition that fails if the current
ETag differs, including competing writes ([conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)).
S3 `PutObject` has no VersionId compare-and-swap parameter, so VersionId is an
additional preflight/audit binding; a byte-identical ABA replacement with the
same ETag cannot be distinguished by this API.

If a PUT result is lost, use only `replace-status`. It verifies the exact new
feed and immutable artifacts without writing; it can reconcile a completed
write, but a missing, changed, or ambiguous remote object remains unconfirmed.
Do not create another replacement receipt, remove a lock, retry an attempted
PUT, or use an unconditional upload to force progress.

## Enroll the Mac CLI

An existing ZIP-delivered Mac client needs one trusted standalone CLI kit
installation before enrollment. Its command is
`~/Library/Application Support/ECHO/cli/bin/echo-brain`. Configure that exact
command only after the hosted feed has been verified. The separate application
and legacy paired command remain outside this CLI update channel.

```sh
"$HOME/Library/Application Support/ECHO/cli/bin/echo-brain" update configure \
  --file /absolute/private/new-feed-bundle/bootstrap-config.json
"$HOME/Library/Application Support/ECHO/cli/bin/echo-brain" update --check
"$HOME/Library/Application Support/ECHO/cli/bin/echo-brain" update --status
```

These commands show readable messages in a terminal. Scripts can request the
existing structured result with `update --check --json` or `update --status --json`;
piped output also remains JSON. `--status` shows saved state, while `--check`
contacts the feed without installing an update.

When the installed client already matches the first published release,
`current` proves feed retrieval, signature verification and release matching.
It does not prove installation of a different release. Preserve the existing
Person session and verify authenticated reads after enrollment.

Live acceptance requires a Mac on release A to start a normal Person command,
automatically install signed release B, and complete authenticated document
reads with the existing session. Local packaging and updater tests do not
establish that live acceptance has occurred.
