# Synthetic demo staging switchover

This lane runs the synthetic-demo composition on the existing disposable staging
hostname without changing the accepted clean-live state or deployment files. It
is permitted only after an operator confirms there are no live staging users and
accepts a temporary outage.

The switchover uses:

- an immutable ARM64 Authority image whose OCI revision label equals the source
  commit;
- `/srv/echo-synthetic-demo-v1/runtime/state`, never `clean-data/state`;
- a personalized four-file meeting directory mounted read-only;
- the existing staging hostname and provider application only during the
  exclusive switchover window; and
- an explicit restore command that restarts and verifies the accepted release.

The stock clean finalization command must not run against demo state. It admits
Granola into the singleton meeting-source slot. `start-demo` instead verifies the
owner bindings, installs the already-staged provider credentials through the
normal validator, and invokes `echo-synthetic-demo admit`.

## Operator sequence

Build and publish the exact integrated demo commit, use the resulting ECR digest, then
transfer an archive containing only `demo/staging/` and `demo/meetings/` to
`/srv/echo-synthetic-demo-v1/bundle`. Record and verify the archive SHA-256 during
transfer. Never include `demo/expectations.json` in the runtime bundle.

Run every host action through a bounded SSM Run Command:

```sh
cd /srv/echo-synthetic-demo-v1/bundle

demo/staging/switch-synthetic-demo-v1.sh prepare \
  --image '<immutable-ecr-digest>' \
  --source-sha '<40-character-source-sha>'

# The accepted runtime remains active during these one-off setup calls.
demo/staging/switch-synthetic-demo-v1.sh bootstrap

# This begins the approved temporary staging outage. A failed start restores the
# accepted runtime automatically.
demo/staging/switch-synthetic-demo-v1.sh start-setup
```

Securely transfer the newly generated initial-owner invitation without printing
its contents into logs or an AI session. Complete the owner browser login and the
one-time Slack identity link against the staging hostname. Then check:

```sh
demo/staging/switch-synthetic-demo-v1.sh setup-status
```

Proceed only when the status reports `founder_oidc_bound`,
`founder_slack_link_active`, and `slack_connected` as `true`, while
`granola_admission_present` remains `false`:

```sh
demo/staging/switch-synthetic-demo-v1.sh start-demo
```

`start-demo` is successful only when the real entrypoint logs
`echo-synthetic-demo-runtime-ready-v1` with `processing: "active"`. Follow
`demo/RUNBOOK.md`, capture the evaluator input outside the runtime, and restore
the accepted service at the end or at any human pause:

```sh
demo/staging/switch-synthetic-demo-v1.sh restore-clean
```

The restore command stops only the demo Compose project, restarts the accepted
Compose tuple while retaining the switchover interlock, and matches its public
and local descriptors before releasing that lock. It then requires the accepted
release status to match its record with no staged candidate. It preserves demo
state and meetings for later evidence or explicit archival; it never deletes
either tree.
