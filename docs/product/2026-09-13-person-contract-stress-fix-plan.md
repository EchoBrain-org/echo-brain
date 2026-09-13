# Person contract stress fixes

Status: prepared for implementation; no runtime fixes made.
Baseline: `285201113194682d1367973548c65146643802ea` (verified `origin/main`).
Branch: `fix/person-contract-stress-20260913`.
Worktree: `.worktrees/person-contract-stress-20260913`.
Tracking: Refs #113 and #53; coordinate qualification with #167 and #169.
Local evidence: `.sprint-local/README.md`; evidence files are excluded from Git.

## Collapse the observations into four fixes

Numbers below refer to the Desktop stress report, not GitHub issue numbers.

| Fix | Root cause | Original findings | Scope |
| --- | --- | --- | --- |
| F1 | The public contract exposes organization-wide snapshot metadata beyond caller-visible content. | 5 | Revise the public metadata contract and its consumers while retaining exact internal witnesses. |
| F2 | Generated answer status, text and citations can contradict the accepted output contract. | 2, 3 | Improve valid output reliability, preserving fail-closed validation. The observed 63/64-byte inputs passed input validation; there is no separate input-limit fix. |
| F3 | The CLI loses typed failure meaning and gives generic or unsupported explanations. | 1, 4; error-display aspect of 3 | Preserve Authority code/status, explain local validation, remove blanket stale-search attribution. |
| F4 | Status omits available build identity, and qualification mixed artifacts. | 9 | Expose existing packaged source identity and qualify one exact artifact on each supported platform. |

Findings 8 and the missing-help portion of 10 are small independent CLI polish
items in the final cleanup pass, not additional architectural fixes. Finding 6
is a harness/documentation correction. Finding 7 and the NUL portion of 10 are
process-launch limitations handled by the caller, not missing runtime features.
Do not open ten separate implementation tickets or count F2/F3 overlap twice.

## Evidence and constraints

Server correlation established Q4 answer-validation failures on both 4cd9401
and 2852011. The two long-term probes reached the same answer stage. Observed
classes were invalid insufficient-evidence text and invalid citation status,
marked non-retryable. Public code maps them to unavailable/503; the original
report did not retain a client-side HTTP 503 capture. This establishes the
failed rule, not whether every rejected answer was harmless paraphrasing.

Read [AGENTS.md](../../AGENTS.md), [ADR-0006](../decisions/ADR-0006-permission-aware-clean-v1-completion.md),
[ADR-0007](../decisions/ADR-0007-lean-layer-4-answer-composition-v1.md), and
[INV-PERMISSIONS-015](../invariants/INV-PERMISSIONS-015-layer-3-person-release-boundary.md).
ADR-0006 explicitly preserves public generation/head metadata: F1 is a design
revision, not removal of an accidentally added field. Prepare the concrete
replacement contract and its decision disposition before implementing that
change. Do not mark an unreviewed proposal accepted or silently rewrite history.

Keep current-Person authorization, caller-scoped Layer 3 release, exact internal
generation/head checks, final revalidation, request-local citations, and the
existing audit-before-release behavior. Provider-specific behavior remains in
its provider folder. Preserve the existing architecture gates and neutral ports.
This sprint adds no database migration, parallel legacy protocol, new installer,
new package, generic error framework, or retry policy. Existing #108 excludes
these non-retryable validation failures; #110 is a separate publication issue.

## Execution order and acceptance

Write the F1 contract proposal first so shared response shapes are settled.
Implement F3 to make failures diagnosable, then F2, F1 and F4, followed by cleanup
and exact-artifact qualification. Use focused commits in this one worktree.

### F1 - Public metadata and internal freshness

- [ ] Inventory public search/Ask shapes, TypeScript and Swift decoders, audit
  hashing, evaluation capture, and release-check consumers. Separate the
  internal pinned witness from the bytes ordinary callers need.
- [ ] Propose the smallest coordinated replacement for public global digest,
  append position and generation exposure. Keep authorized citation references.
  Explain how exact release/qualification evidence remains available under
  existing authorization. A caller must not choose its own owner scope.
- [ ] State how the change updates ADR-0006 and the current client contract.
  Do not introduce an owner bypass, simply null required fields, or substitute
  a globally changing opaque identifier and claim it eliminates correlation.
- [ ] Prove the whole employee response excludes restricted identifiers and
  hidden append counts, including restricted-latest and empty-result cases.
  Keep owner/employee content controls, stale-snapshot rejection, final
  authorization, and the exact returned-response audit digest covered.
- [ ] Update server, Person client, Swift decoder and affected acceptance
  consumers together; identify the minimum matching client release. Remove
  replaced serialization/decoder paths rather than preserving dual behavior.

Primary files: Authority `presentation/person-record-search-http-application.ts`,
`presentation/person-answer-http-application.ts`, `composition/person-record-search-route.ts`,
`composition/person-answer-route.ts`; Person `authority-client.ts`;
`product/echo-overlay/main.swift`. Check existing evaluation/release consumers
before changing them; no new evidence endpoint is presumed necessary.

### F2 - Reliable valid answer outcomes

- [ ] Reproduce the failure through the existing composition/route fixtures.
  Include valid abstention, insufficient status with substantive text,
  inconsistent citation status, unreleased citations, and 63/64-byte questions.
  Existing rejection tests are guards, not proof the user journey is reliable.
- [ ] Prepare the minimal neutral output-contract improvement. Prefer an
  unambiguous abstention result whose standard user text is rendered by the
  application. Distinguish a valid abstention from malformed/substantive output;
  preserve the #112/#171 contradiction guards. Demonstrate the chosen design
  with a failing behavior proof before changing generation/parsing code.
- [ ] Keep one planner, one authorized retrieval batch and at most one answer
  generation. Do not retry these failures, loosen citation validation, turn
  outages into insufficient evidence, or add question-specific exceptions.
- [ ] Keep public failures bounded and safe, with truthful diagnostics through
  F3. Correlate a bounded exact-candidate employee repetition and owner positive
  control after implementation; retain failures as well as successes.

Primary files: `packages/organization-authority-kernel/src/answer-composition/retrieval-grounded-answer-composition.ts`,
Authority `composition/person-answer-route.ts` and `composition/ask-journey-telemetry-v1.ts`.
Use existing composition, route, telemetry and rehearsal-evaluator tests.

### F3 - Preserve failure meaning

- [ ] Reproduce typed errors through the actual composed CLI. Preserve the
  existing Authority code and HTTP status for Ask and all records paths;
  retain employee-mutation outcome semantics.
- [ ] Remove the mapping of every search unavailable error to “catching up.”
  Use that explanation only with a real stale-generation discriminator.
- [ ] Give local Ask/search validation failures bounded rule-specific codes
  and actionable text. Retain matching server enforcement and current bounds:
  240 code points, 1–32 unique normalized terms, 64 UTF-8 bytes per term;
  list limit 1–100, search limit 1–10. Do not echo raw user input in errors.
- [ ] Cover malformed input, unauthorized, unavailable and safe unknown-error
  handling in the existing CLI tests. Keep success stdout, error stderr and
  nonzero failure exits; do not expose provider bodies or hidden record facts.

Primary files: `src/product/person-client/{authority-client,commands,client}.ts`;
Authority HTTP validation only if needed. Preserve neutral dependency direction
when reusing validation rules; do not import a server implementation into a client.

### F4 - Exact build identity and qualification

- [ ] Expose the source SHA/source kind already read by `package-identity.ts`
  in signed-in and signed-out status, with decoder/help updates where needed.
  Keep product version distinct from build/release identity. A client build
  never proves which Authority image served a request.
- [ ] Extend existing package/status/installer proofs with two artifacts sharing
  a product version but having different source identities. Do not add another
  identity store or infer verified provenance from an installation path.
- [ ] Use the same canonical release and exact Person tarball for the existing
  Mac and Linux kit lanes. Update or retire the one-off Mac-pinned checker after
  its behavior is covered by the existing supported evaluation path.
- [ ] Record employee checks on the employee device and owner controls on the
  owner device using identified matching artifacts. No session copying or
  substitution of an owner for an employee. This worktree contains no credentials.

Primary files: Person `package-identity.ts`, `commands.ts`;
`product/echo-overlay/account.swift`; existing packaging/kit tests and
`deploy/release/README.md`. Add provenance to diagnostics, not routine UI clutter.

## Cleanup and completion

- [ ] Complete `tools --help`; preserve composed provider-command help. Improve
  the negative-limit explanation with a bounded parser change if practical.
- [ ] Correct the harness to inspect both streams and the exit code, and capture
  process-launch failures. Do not add stdin/file input for oversized or NUL argv.
- [ ] Remove replaced error rewrites, metadata projections/decoders, duplicate
  validation helpers, and tests that exist only for behavior deliberately retired.
  Retain behavioral privacy, authorization, audit, citation and failure guards.
- [ ] Update the existing contract/help/release documents. Consolidate obsolete
  helper scripts after coverage exists; do not delete user Desktop files or
  older evidence as part of repository cleanup.
- [ ] Keep detailed stress reports, log extracts and temporary probes outside
  the PR. Replace this plan's completed detail with a short disposition/source
  map before merge; retain only useful contract and validation documentation.
- [ ] Reconcile #113/#53 and relevant #167/#169 acceptance once evidence exists.
  #191 remains separate; do not fold unrelated staging-wrapper work into this sprint.

## Verification and handoff

Planning checkout is source-only: Node 22.22.1 and npm 10.9.4 verified; independent
dependencies are deliberately not installed yet. Start implementation with
`npm ci --no-audit --no-fund`; never symlink another worktree's dependencies.
For each runtime fix: focused failing proof, smallest fix, then focused pass.
Existing test locations:

- `tests/person-client/person-client.test.ts`, `person-client-help.test.ts`,
  `person-tool-fragments.test.ts`.
- `packages/organization-authority-kernel/test/answer-composition/retrieval-grounded-answer-composition.test.ts`.
- `services/organization-authority/test/person-record-search-route.test.ts`,
  `person-answer-route.test.ts`, `answer-composition/person-answer-composition-audit.test.ts`.
- `tests/architecture/retrieval-answer-composition-boundary.test.ts`, relevant
  Mac decoder, package, Linux kit and installer proofs.

Use `npm run build` then focused `npx vitest run --config vitest.config.ts <paths>`;
run `node --test demo/test/rehearsal-evaluator.test.mjs` if that evaluator changes.
Before review, run `npm run check` at the final head and any affected native
decoder/kit proof. Do not duplicate CI jobs or add tests that merely repeat code.

Live qualification follows the existing [operator playbook](../operations/PB-OPERATIONS-001-authority-operator-lane.md).
This plan is not release acceptance. Candidate 2852011 remains staged but not
finally accepted; production is unchanged. Record a future candidate's actual
source/build, permissions, outcomes and failures rather than carrying forward
the old canary or owner-only checks as proof of these fixes.
