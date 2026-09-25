# CLI update staging feed

This dedicated hosting stack prepares an HTTPS endpoint for the signed
[CLI update feed](../../docs/features/client-updates-v1.md). It is separate from
the Authority staging stack and onboarding-transfer storage. Creating the
endpoint does not publish a release, enroll a client, or authorize a candidate.

The fixed target is account `904560150024`, region `us-west-2`, stack
`echo-client-update-staging-v1`, using the `echo-prod` IAM Identity Center profile.
The stack contains a private, encrypted, versioned S3 bucket, a bucket policy,
CloudFront distribution, origin access control, and artifact cache policy.
The bucket is retained on deletion or replacement. There are no IAM, DNS,
Authority-host, provider-secret, or onboarding resources.

## Prepare and review hosting

From a clean committed checkout, create a plan in an operator-owned mode-0700
directory outside the checkout:

```sh
npm run client-update:staging -- plan --output /absolute/private/feed-hosting.json
```

Planning creates a CloudFormation change set and captures its exact template
digest, resource inventory, source commit, and change-set ARN in a mode-0600
receipt. It provisions no bucket or distribution. Review that named change set
before execution. Planning may use a committed feature branch; execution
requires that exact source to be merged into fetched `origin/main`.

After the human approves the exact change set, use the unchanged receipt:

```sh
npm run client-update:staging -- execute \
  --receipt /absolute/private/feed-hosting.json \
  --approve-change-set '<exact-reviewed-change-set-ARN>'
npm run client-update:staging -- status --receipt /absolute/private/feed-hosting.json
```

Preserve an executing or unconfirmed receipt and inspect its existing operation;
do not create a competing deployment or remove a lock to bypass uncertainty.
The resulting outputs identify the bucket, distribution, and HTTPS `feed_url`.
The default CloudFront hostname needs no DNS or certificate setup.

## Publication and Mac enrollment remain separate

Only `feed.json` and `artifacts/*` are readable through the distribution.
Downloads allow HTTPS GET/HEAD. The feed is not cached; content-addressed
artifacts are cached for one year. Neither path compresses or redirects
responses. Do not overwrite an artifact key or upload private records, session
state, invitations, or signing keys.

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
