# echo-brain (local DEV extraction candidate)

`echo-brain` is the standalone, client-local **meeting-to-brief** product boundary for
ECHO's Team decision wedge. This repository was materialized by an attended, one-time
source extraction from a pinned commit of the `Project_echo` monorepo. It is a local
DEV candidate only.

- `authority: false` — `Project_echo` remains the source, backup, and active authority.
- `maturity: DEV` — a successful build, install, or offline selftest does **not** advance
  the candidate beyond DEV and does **not** prove that a real meeting ran.
- Source SHA: `2971310441b69735cbe759293abd8c4d044bf347`
- Extraction item: `2026-07-13-133-local-echo-brain-source-extraction`

## What this repository is

Every production TypeScript module, the product boundary (`product/source-boundary.v1.json`),
and the eight pinned `tests/product` files were copied **byte-for-byte** from the pinned
`Project_echo` commit through a sanitized Git object envelope. `product/npm-shrinkwrap.json` and
the runtime-config schema were relocated without content change. `product/package.template.json`
was relocated to `package.json` with exactly one founder-adjudicated transform — the npm `10.9.4`
engine pin (the sole entry in `provenance/extraction-policy.v1.json`'s `transform_allowlist`,
verified semantically by the operator audit). The `provenance/` tree records deterministic
file-level provenance for every tracked blob; the `tools/check-*.mjs` verifiers re-check that
provenance, the product boundary, and the
dependency partition locally.

The eight pinned `tests/product` files are preserved as **byte-parity evidence** and are
inventoried in `provenance/test-parity.v1.json`. They exercise the item-132 in-repo
qualification tooling (`tools/product/*.mjs`, CI workflows) via runtime path construction and
are **not** part of this repository's executed suite. The executed suite is
`tests/migration/**` plus `tests/product/end-to-end-synthetic.test.ts`.

## Standalone identity, not byte relocation

`README.md` is an explicitly authored target-only file so it can state standalone identity
without pretending byte relocation from any source README.

## Local DEV commands

The runtime dependency tree (`ajv`, `better-sqlite3`) is pinned by the committed
`npm-shrinkwrap.json`. `package.json` pins Node 22.22.1 and npm 10.9.4 in `engines`.

The build/test/lint toolchain is **not** a runtime dependency and is **not committed to this
repository**. It is provisioned out-of-band with recorded registry integrity digests in
`provenance/dependency-toolchain.v1.json`: TypeScript and the `@types/*` build inputs
(`javascript_clis` + `build_inputs`) for the `verify-artifact` compile, the Vitest runner, and
ESLint for the lint gate. The lint gate runs ESLint via an explicit `--config` against a scratch
flat config that is **not** committed here; the config's exact bytes and SHA-256 are recorded in
the Project_echo migration record (`raw/internal/migrations/2026-07-13-133-echo-brain.md`), and
its digest is named in `provenance/dependency-toolchain.v1.json` under `lint`. There is no
committed linter or lint configuration in this repository. All verification runs offline under a
network-denial sandbox with the pinned Node 22.22.1 / npm 10.9.4 toolchain.

The installed CLI exposes `validate-config`, `selftest`, and `run`. `selftest` is offline and
reports the rank-3 production brain adapter as pending; it keeps `wedge_executed: false` and
never claims the wedge ran. `run` fails closed until that adapter exists.

## Inherited debt (unchanged from source)

This boundary does not absorb, relabel, or waive the generic `echoctl`/platform debts recorded
in the source `product/README.md`: the generic release-doctor omission, Windows onboarding
`EBUSY`/filesystem-event failures, and the macOS/Ubuntu Node 22 packaging races remain owned by
their source-side owners. Phase 1 is macOS-only.

## Next gates (no transition performed here)

This repository performs no remote creation, publication, deployment, client install, credential
change, real meeting, or maturity advancement. Cutover to authoritative status requires a
separate founder-approved proposal after parity acceptance, per the source graduation pipeline
(`DEV -> FOUNDER LIVE -> QUALIFIED -> CLIENT LIVE`).
