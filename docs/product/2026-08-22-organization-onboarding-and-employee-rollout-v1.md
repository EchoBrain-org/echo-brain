# Organization onboarding and employee rollout V1

**Status:** active sprint, scope revised 2026-08-22.

**Governing decision:**
[ADR-0006](../decisions/ADR-0006-permission-aware-clean-v1-completion.md).
N is already at least two. This sprint preserves the clean-state replacement
and the permission-aware Layer 1 through Layer 3 stack.

## Outcome

An operator can deploy one organization Authority through one resumable flow,
and an owner can invite or revoke an employee who signs in and reads from a
clean machine. Neither flow requires repository knowledge, generated database
IDs, direct SQLite access, or provider credentials on the employee machine.

The current EC2 plus Docker Compose deployment is the only server target for
this sprint. The employee machine runs the packaged Person client only; it is
not an enrolled machine and runs no ECHO daemon.

## Iteration contract

This sprint optimizes for a usable product and a short release loop, not for
compatibility machinery before customer state exists.

- Until the first live-user release, the clean genesis may be replaced and the
  founder may re-onboard. Do not add a forward migration or compatibility
  bridge merely to preserve rehearsal state.
- The first live-user release freezes one exact clean-v1 baseline compatibility
  class. After that point, ordinary fixes must be baseline-preserving
  application-image replacements. A later schema change requires an explicit
  migration decision; it must not silently weaken the pre-open schema check.
- One release record binds the source commit, immutable Authority image digest,
  Person-client version and SHA-256, and baseline compatibility class. Server
  and employee installation consume that record rather than a floating tag or
  repository checkout.
- A server application update retains the previous image digest, pulls and
  starts the new digest, checks setup/runtime status plus a bounded canary, and
  may roll back only to a release in the same baseline compatibility class.
- An employee update is an exact-checksum reinstall of the small packaged
  Person client. V1 adds version/status visibility, not a background updater,
  MDM integration, or fleet service.

Every product bug found during onboarding is fixed by building another exact
candidate and rerunning the same setup, install, status, and canary surfaces.
No bug should require direct SQLite work or generated-ID handoffs.

## Current candidate

The clean Authority already supports founder bootstrap, OIDC Person sessions,
founder Slack linking, verified organization Slack connection, stopped source
activation, live-only Granola polling, approval/rejection, Layer 1 append,
automatic Layer 2 reconciliation, and permission-aware Layer 3 list/search.

The candidate now adds the narrow onboarding product surface:

- one server `prepare` followed by the same repeatable `resume` command and a
  safe `status` view;
- founder bootstrap recovery from its durable non-secret setup plan, without
  re-entering organization, OIDC, origin, channel, or revision inputs;
- bounded Granola owner observation before activation; and
- owner-only employee list, invite, reissue, and revoke commands, with no
  generated-ID handoff.

The employee roster requires the canonical work email to be retained alongside
its lookup digest in fresh Authority state. It returns one current row per work
email: the active tenure when one exists, otherwise the latest revoked tenure.
Only the owner can read the projection, and it contains only email, display
name, membership state, and invitation state.

This changes the fresh Authority genesis bytes. There are no live users on the
pre-roster rehearsal baseline, so this candidate replaces that rehearsal state
through clean organization re-onboarding. It must not be applied to the old
rehearsal state as a baseline-preserving image update. The first accepted
live-user release freezes the new exact baseline hash. The supported server
runbook makes this recoverable with
`onboard-clean-v1.sh replace-rehearsal --confirm-no-live-users`, which stops and
archives rather than deletes the old rehearsal state before a new `prepare`.

Slack and Granola revision quirks remain ordinary integration-product work.
They do not expand this sprint unless they prevent setup from completing or
would cause the onboarding flow to report a false success.

## Supported flow

### 1. Organization server

Provide one resumable setup command with a non-secret status view over these
existing stages:

1. Authority origin, OIDC configuration, and clean-state readiness.
2. Slack bot credential plus a human-selected approval channel.
3. Founder invitation, browser OIDC login, and founder Slack link.
4. Organization-held Granola credential, canonical founder work email, and the
   retained LLM credential.
5. Granola owner preflight, live-only source activation, runtime start, and a
   post-cutoff canary.

The command may wrap the current stopped bootstrap/finalize boundary. It must
explain the next human action and resume from the first incomplete stage. It
must not print a secret, bearer, invitation grant, or OIDC callback body.

The operator supplies only ordinary human inputs:

- organization and founder names;
- founder work email;
- public Authority origin and OIDC client configuration;
- Slack bot token and selected approval channel;
- organization-held Granola API key and the same founder work email; and
- the retained LLM provider key.

Generated Authority, organization, principal, membership, connection, source,
and adapter IDs remain internal.

### 2. Provider preflight

Reuse the current Slack verification. Surface its safe result: exact workspace,
app/bot identity, required scopes, selected public active channel, and bot
membership. A wrong workspace, missing scope, invalid channel, or absent bot
membership fails before activation with an actionable message.

Add one bounded Granola metadata observation before activation. It proves that
the credential can observe an accessible record owned by the canonical founder
email and persists only the non-secret result and verification time. It does
not ingest that record. Activation still creates a fresh live-only cutoff.

V1 does not use Granola folders or spaces as an intake filter: the source still
admits every eligible post-cutoff note owned by the configured founder. One
exact folder name may classify the admitted note's read audience as described
below. Existing notes remain outside the cutoff.

The canary proves that a card can be approved and the resulting record can be
listed and searched. Duplicate or presentation anomalies are reported as
product warnings and can be fixed by an image update; they are not a reason to
rebuild the onboarding architecture.

### Granola record visibility marker

By default, a post-cutoff Granola note produces an
`organization-member-readable-person-v2` candidate: every current active owner
or employee may read it after approval. To make a candidate reviewer-only, put
the note in a Granola folder named exactly `echo-restricted`. The frozen source
snapshot then selects the existing `restricted-reviewer-person-v2` policy: only
the exact approving owner and that owner's current membership tenure may read
it. The rule accepts any folder membership with that exact case-sensitive name;
titles never select policy. The Slack approval card shows the selected policy's
full consequence immediately before its approve or reject instruction, so
approval is informed. A later folder move may create a new source revision but
does not reinterpret an already posted card or approved record.

### 3. Employee lifecycle

Add the narrow owner-authenticated clean-live operations needed to:

- create one new principal with an `employee` membership and expected work
  email;
- issue or safely reissue a one-time Person invitation for that exact active
  membership; and
- revoke that exact membership tenure.

A thin CLI is the V1 operator surface. No browser administrator console or
generic role system is required.

The owner checks the current human-readable roster at any time with:

```sh
echo-brain person employee list
```

The employee receives the invitation through a private out-of-band channel,
runs the packaged `echo-brain person login --invitation ...` flow, and then uses
`echo-brain person records` with or without `--query`. The login handoff must be
human-readable and must not require copying raw callback JSON. Slack linking is
not required for read-only employee access.

### Employee rehearsal commands

On the owner's machine, create a private, existing output directory before
issuing an invitation. The invitation leaf must not already exist:

```sh
INVITATION_DIR="$HOME/.local/share/echo-brain/invitations"
mkdir -p "$INVITATION_DIR"
chmod 700 "$INVITATION_DIR"

echo-brain person employee invite \
  --name 'Employee Name' \
  --email employee@example.com \
  --out "$INVITATION_DIR/employee-onboarding.json"
```

The command reports the canonical private output path, never the invitation
grant. Send that one file to the employee through a private out-of-band channel.
The client accepts a macOS `/tmp/...` spelling when its existing parent resolves
to a current-user `0700` directory; `/tmp` itself is not private and is rejected.
Do not use a relative path, a root path, a symlinked invitation leaf, or an
existing output file.

On the receiving machine, keep the file private before login:

```sh
RECEIVED_DIR="$HOME/.local/share/echo-brain/onboarding"
install -d -m 0700 "$RECEIVED_DIR"
install -m 0600 /absolute/path/to/received-file \
  "$RECEIVED_DIR/employee-onboarding.json"
```

On the employee machine, install the exact released Person-client artifact, then
run the browser-assisted login and both allowed read paths:

```sh
echo-brain person login --invitation /absolute/private/employee-onboarding.json
echo-brain person status
echo-brain person records --limit 20
echo-brain person records --query 'known member-readable marker'
```

The owner then revokes the membership and the employee repeats the last two
commands. Both must deny access; the owner's list/search continue to work:

```sh
echo-brain person employee revoke --email employee@example.com
```

Use `echo-brain person --help`, `echo-brain person login --help`, and
`echo-brain person employee invite --help` for the supported local command
forms. Reissue uses the same private output rule:

```sh
echo-brain person employee reissue \
  --email employee@example.com \
  --out "$INVITATION_DIR/employee-onboarding-reissue.json"
```

Reissue is only for an active employee whose initial bootstrap is still being
completed; it invalidates the prior pending grant. Reinstalling the exact
Person-client package preserves an existing local session. On a new or replaced
machine after identity binding, install the client and run
`echo-brain person login --authority-url https://<authority-host>`; no new
invitation is needed. After membership revocation, onboarding the person again
uses `employee invite` and creates a new tenure. `person status` describes the
installed client and locally stored session; the owner roster and an actual
records request are the authoritative current membership checks.

## Acceptance

The sprint is complete when all of the following pass against one candidate:

1. A fresh fake-provider rehearsal can stop and resume at every setup stage,
   and reaches `processing: active` only after Slack verification, founder
   identity/linking, Granola owner observation, and live-only activation.
2. The setup status contains no secret bytes, grants, bearers, note content, or
   model content and gives one actionable next step for every incomplete stage.
3. One real organization rehearsal deploys the current EC2/Compose target,
   completes the post-cutoff Granola-to-Slack canary, approves one record, and
   reads it through both Layer 1 listing and Layer 2 search.
4. The owner creates an employee invitation without generated-ID handoffs. A
   clean employee machine installs the packaged client, completes browser OIDC,
   and obtains its session without pasting raw callback JSON. It holds only
   its invitation/session state, never server,
   Slack, Granola, or LLM credentials.
5. The employee reads organization-member-readable content through listing and
   search, cannot read another person's restricted-reviewer content, and loses
   both read paths after membership revocation. The founder's allowed paths
   continue to work.
6. Layer 2-backed Layer 3 search responses retain request-level generation/head
   metadata and per-item atom, record, and policy identity. Layer 1 listing
   retains its existing record envelope, position, and record-hash contract.
   Layer 2 remains append/startup driven and is never built by a query.
7. Invitation email mismatch, expiry, reuse, foreign Authority, and revoked
   membership deny without creating a session or releasing content.
8. `npm run check`, the boundary scan, packaged Person-client smoke, and the
   Layer 4 exclusion remain green.
9. One release record identifies the exact Authority image, source commit,
   Person-client artifact/version/SHA-256, and clean-v1 compatibility class.
   The EC2 operator can apply a baseline-preserving image replacement, observe
   health and the next action, and retain the prior compatible digest without
   reading SQLite or generated IDs.
10. A clean employee machine can install or reinstall the exact Person-client
    artifact after checking its SHA-256, then report the installed version and
    connected Authority without exposing its local session.

## Hard exclusions

- no Layer 4 prompt, model, agent, tool, stream, answer, or citation path;
- no V4 envelope, Layer 1, Layer 2, Layer 3 policy, release-fence, response, or
  current read-audit redesign;
- no historical import, backfill, compatibility bridge, or old-state reader;
- no general Granola folder/space intake filtering or historical replay;
- no employee installation identity, signing key, lease, local database,
  server daemon, or provider secret;
- no employee Slack approval capability in this sprint;
- no browser admin console, SCIM, generic RBAC/policy engine, multi-tenancy,
  multi-cloud deployer, HA, MDM, or fleet updater;
- no automatic schema migration, compatibility bridge, or cross-baseline
  rollback after the first live-user baseline is frozen;
- no general retry framework or broad Slack, Granola, or LLM product-bug
  cleanup; and
- no broad legacy-deletion tranche beyond code directly replaced by the new
  supported onboarding path.

## Sequence

1. Land the resumable server wrapper, founder resume, and owner employee roster.
2. Run fake-provider organization plus two-Person permission acceptance.
3. Rehearse one real organization server and one clean employee machine using
   the second employee OIDC identity.
4. Bind the accepted image and Person client into one release record; rehearse
   one baseline-preserving server update and one verified client reinstall.
5. Only after this exit, resume broad legacy deletion and migration closure.
