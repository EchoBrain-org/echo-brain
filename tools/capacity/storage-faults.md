# Storage-fault operator plan

`storage-faults.mjs` is a fail-closed dry planner. It does not load a kernel
module, create a device-mapper target, mount a filesystem, write a block, or
kill a candidate. Its output is always `not-run`.

On a dedicated Linux verifier host, first run:

```sh
node tools/capacity/storage-faults.mjs --dry-plan /dev/DEDICATED_DEVICE
```

The device must already be known to be disposable and unmounted. The planner
rejects the selected device and all descendants if any is mounted, including
the root filesystem. It also requires an already-loaded `dm_log_writes` target
and device-mapper control. Do not use `dm-flakey` as a replacement.

The actual fault executor is not implemented. Its reviewed Linux design must
put the state filesystem inside a disposable QEMU guest, with the virtual
disk using `cache=none`, and put `dm-log-writes` underneath that disk on the
verifier host. Keep the write log separate from the origin and preserve a clean
base image. `dm-log-writes` records writes and flush ordering; it does not itself
discard volatile writes or simulate power loss. A host process kill alone is
insufficient.

Run exactly the four V1 boundaries: acknowledged approval receipt,
acknowledged V4 append, committed active-generation pointer, and answer audit
before its first response byte. For each boundary, capture every acknowledged
effect identifier before the fault, terminate the entire guest, and replay the
write log only through the selected completed flush onto a fresh clone of the
clean base. Boot a new guest from that clone and read the real Authority and
Record databases. Retain the base, log and replay-prefix digests. Correctly
handle flush completion and FUA semantics; an arbitrary log prefix is not proof
that acknowledged writes reached durable storage.

Collect two controls from the same host and observer: a synced write survives
cold replay and an unsynced write is absent. Then pass the independently
collected evidence to `validateAcknowledgementOracle`. It verifies that each
acknowledged effect appears after recovery and that recovery has no duplicate
canonical append, invalid publication, or unexpected provider effect.

Remaining work includes implementing and validating this executor, then
collecting evidence on Linux. It requires dedicated disposable backing storage,
the relevant kernel target, QEMU, `dmsetup`, and a reviewed write-log replay
utility. Unit tests validate only the model and evidence shape. They do not
prove power-loss durability. See the
[kernel write-log semantics](https://docs.kernel.org/admin-guide/device-mapper/log-writes.html)
and [QEMU disk cache options](https://www.qemu.org/docs/master/system/invocation.html)
when implementing the executor.
