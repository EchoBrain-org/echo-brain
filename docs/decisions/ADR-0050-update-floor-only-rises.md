---
schema_version: 1
id: ADR-0050
kind: decision
title: The update floor only rises, and the desktop says when updates are off
component_ids:
  - CMP-PERSON-CLIENT
  - CMP-OPERATIONS-RELEASE
created_at: 2026-10-27
reviewed_at: 2026-10-27
reviewed_ref: 4dff2d8c05e183b08b4242f88e8d0e235479d87c
status: accepted
supersedes: []
superseded_by: []
updates:
  - ADR-0035
---

# ADR-0050: The update floor only rises, and the desktop says when updates are off

On 2026-10-25 a raised update floor switched off the desktop updater on the
founder's Mac, with only a log line to say so. On 2026-10-27 the founder chose
option C below for the floor, the feed publisher and the desktop. The founder
accepted this record the same day, after checking the result on the desktop
in the first staging release that carries it
([evidence](#migration-rollback-and-evidence)). Acceptance does not mean the
change is qualified beyond that release.

## Context and options

Under [ADR-0035](ADR-0035-desktop-updates-from-the-signed-feed.md) the desktop
pins the update bootstrap of the first build it runs, as the CLI pins its
configuration. The pin was every field but `automatic`. It included the
sequence floor, `minimum_sequence`, so changing the floor took a separately
reviewed bootstrap.

On 2026-10-25 a staging build raised its bootstrap's `minimum_sequence` from 1
to 20. The live feed was at sequence 19 and named the older, incompatible
2026-10-23 build. The update core offers any release the feed names that
differs from the running one, even an older one. With the higher floor,
clients running the staging build would refuse that feed and never be offered
the older build. Two side effects followed:

- The desktop updater on the founder's Mac switched itself off at 08:33 UTC.
  The new floor no longer matched the pin, so the launch failed with
  `already_configured`. The only sign was a line in desktop.log:
  `update off already_configured`.
- The next feed publish was refused with `predecessor_feed_invalid`. The
  replacement lane verified the live sequence-19 feed against the new bundle's
  floor of 20.

The feed sequence is ECHO's only way to order releases. Every release carries
product version `0.1.0-internal.1`, and the signed manifest has no build date.
Clients reject manifest fields they don't know, so one can't be added. A build
says "feeds below N are older than me" only through its floor.

Options considered:

- **A: the floor only rises.** A newer build from the same publisher raises
  the stored floor instead of being refused, and the publisher can replace a
  feed below the new floor. On its own it leaves any other updater that can't
  start, such as one in a build from another publisher, with only a log line.
- **B: only show Updates are off.** This fails on its own: a raised floor
  would show the row on every staged Mac, and the publisher would still refuse
  the next feed.
- **C: both.** Chosen by the founder on 2026-10-27.

Also rejected:

- **Accept any new bootstrap.** An older build's key, or a build that names
  another feed, could then replace the pinned publisher.
- **Order releases by version or date.** There is no data for it without
  breaking installed clients: every release carries the same version, and a
  build date would be a manifest field they reject.

## Decision and consequences

Adopt option C, the founder's choice.

- **The pin is the publisher.** It is every update config field except
  `automatic` and `minimum_sequence`: `schema_version`, `kind`, `channel`,
  `feed_url`, `public_key_spki` and `installation`. This is the pin that
  ADR-0035 says a later app cannot change. A config whose pin differs from the
  stored one still fails with `already_configured` and changes nothing on disk.
- **The floor only rises.** A build from the same publisher with a higher floor
  raises the stored one, and a build with a lower floor keeps it. The effective
  floor is the largest any build of this publisher has carried. A raise keeps
  the anti-rollback checkpoint, and updates stay on. A feed below the floor
  fails with `stale_metadata`. An offer saved from such a feed is not offered
  again: an automatic check inside the hour reports `not_due`, and
  `update --status` reports `not_checked`.
- **The publisher checks the live feed without the new floor.** The replacement
  lane still verifies the live feed's signature, pinned key, channel and
  artifact origin, but not against the new bundle's floor: the feed it
  replaces is older by design. The new feed must still be above the live one
  and at or above its own floor.
- **Release rule.** A build that will run ahead of the live feed sets its floor
  to the live feed's sequence plus one
  ([coordinated release](../../deploy/release/README.md#prepare-the-transition-before-staging)).
  It then refuses the live feed instead of offering that feed's older release
  as a new version. Until the build's own feed is published, any replacement
  of the live feed, including an expiry refresh or a rollback, is at or above
  that floor and is offered to seats running the build. So publish the build's
  feed before any other replacement of the live feed, or expect those seats to
  be offered the live release.
- **The desktop says when updates are off.** A quiet sidebar row reads
  **Updates are off**. It can't be clicked and never installs anything. It
  shows only when the updater should run in this packaged release but couldn't
  start: the launch failed, or the release-bound client's `client-update.js`
  didn't load. The launch fails, for example, with `already_configured` for a
  build from another publisher, or with `invalid_update_state` when an updater
  file such as `floor.json` is damaged. `updaterSetup` refusals still show
  nothing: a development, smoke or test build, an unsupported platform or
  installation, a missing or invalid identity, or no `pkexec`.
- **Logs keep codes only.** Error codes and log lines keep their names and
  format, for example `update off already_configured` and
  `update check stale_metadata` in desktop.log.

### Consequences

- `echo-brain update configure --file` now raises the floor, and ignores a
  lower one, where it failed with `already_configured` before.
- A raised floor lives in `updater/floor.json`, stamped like `state.json`.
  `config.json` keeps the floor it was first pinned with, and `state.json`
  keeps its stamp. So a build from before this change still reads both and
  keeps updating; it ignores the raised floor. An older desktop also compares
  its bootstrap, floor included, with `config.json` at launch, so this holds
  for one that carries the first floor.
- Builds already installed keep today's behavior until they update, since each
  runs the update core it shipped with. An older desktop whose floor differs
  from the first still switches its updater off with only a log line, as on
  2026-10-25. With its updater off it cannot update itself, so it needs one
  manual reinstall.
- Protection from older releases depends on the release rule, since nothing
  else orders releases. A build ahead of the live feed whose floor is not above
  it is offered that feed's older release as a new version. On the CLI the
  floor rises only through `update configure --file`: the Linux kit installer
  keeps an existing enrollment as it is.
- The Linux root helper already checks the installed build's own floor, from
  the root-owned identity, besides its machine-wide checkpoint. It does not
  read `floor.json`.
- Moving a desktop to another publisher still needs an operator's separately
  reviewed bootstrap change. The row now makes the refusal visible.

## Migration, rollback, and evidence

- **No data migration.** `config.json` and `state.json` keep today's format
  and stamps. `floor.json` appears only when a higher floor is configured.
- **Rollback** is a revert. Builds without this change ignore `floor.json`.
  After a revert the pin again includes the floor, so a desktop whose build
  carries another floor than its `config.json` switches its updater off, as
  on 2026-10-25. Builds made after a revert must carry the floor that seats
  were first pinned with.
- **Local evidence:**
  - update core (`tests/person-client/client-update.test.ts`): a higher floor
    goes to `floor.json` and leaves `config.json` and `state.json` byte for
    byte; a lower one changes nothing; another key, feed, channel or
    installation still fails with `already_configured` and changes nothing,
    even with a higher floor; both files keep the formats older builds read;
    `floor.json` only rises, and one with another stamp or malformed fails
    with `invalid_update_state`; after a raise, through the CLI and the app's
    adapter, the saved offer is not offered again and a feed below the floor
    fails with `stale_metadata`;
  - publisher (`tests/architecture/client-update-publish.test.ts`): a bundle
    whose floor is above the live feed plans, executes and verifies its
    replacement;
  - desktop updater (`product/echo-desktop/test/unit/update.test.ts`): with
    the real core, a newer build's floor of 20 goes to `floor.json`, updates
    stay on, and the sequence-19 feed offers nothing; a build from another
    publisher shows **Updates are off** and logs
    `update off already_configured`; a check never replaces the row, and
    install refuses it;
  - desktop row (`unit/sidebar.test.ts`, `unit/update-row.test.ts` and the
    end-to-end `e2e/update.spec.ts` under `product/echo-desktop/test/`): the
    row reads **Updates are off**, is `aria-disabled`, and a click installs
    nothing.
- **Staging evidence** from release
  `clean-v1-20261028-ask-sidebar-updates-f2c236f`, the first with this change:
  - The replacement lane replaced the live sequence-19 feed with the
    release's sequence-20 feed, whose floor is 20. Before this change, a
    replacement over the same sequence-19 feed was refused with
    `predecessor_feed_invalid`.
  - The founder's Mac, whose desktop updater had been off since 2026-10-25,
    needed the one manual reinstall. After it, `floor.json` held 20,
    `config.json` kept 1, and against the sequence-19 feed desktop.log showed
    `update check stale_metadata` instead of offering the older release.
  - Once the sequence-20 feed was published, the desktop's next check logged
    `update check current`, and the Mac CLI's `update --check` reported
    `current`.
  - The founder checked the installed desktop, whose sidebar shows no
    **Updates are off** row, and accepted this record.
