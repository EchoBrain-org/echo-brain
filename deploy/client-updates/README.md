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

## Publication and Mac enrollment remain separate

Only `feed.json` and `artifacts/*` are publicly readable. The `s3:GetObject`
permission permits HTTPS GET/HEAD downloads. At publication, set
`Cache-Control: no-store` on the feed and
`Cache-Control: public,max-age=31536000,immutable` on content-addressed artifacts.
Upload their original bytes without content encoding or website redirects. Do
not overwrite an artifact key or upload private records, session state,
invitations, or signing keys.

Use the output URL in the public bootstrap configuration. The release signer
keeps the Ed25519 private key outside the artifact bucket and client kit. Follow
the existing feed `prepare` and `seal` commands with the exact approved release,
Mac CLI kit, detached signature, and digest-bound founder authorization. Upload
verified immutable artifacts first, verify their HTTPS bytes, and publish the
sealed feed last through a reviewed publication operation. This hosting CLI
does not yet implement that upload operation or provision signing keys.

An existing ZIP-delivered Mac client needs one trusted standalone CLI kit
installation before enrollment. Its command is
`~/Library/Application Support/ECHO/cli/bin/echo-brain`. Configure that exact
command only after the hosted feed has been verified. The separate application
and legacy paired command remain outside this CLI update channel.

Live acceptance requires a Mac on release A to start a normal Person command,
automatically install signed release B, and complete authenticated document
reads with the existing session. Local packaging and updater tests do not
establish that live acceptance has occurred.
