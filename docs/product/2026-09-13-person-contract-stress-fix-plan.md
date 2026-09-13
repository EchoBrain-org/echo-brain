# Person contract stress fix disposition

Branch: `fix/person-contract-stress-20260913`.
Baseline: `285201113194682d1367973548c65146643802ea`.
Planning commit: `7e49c3d`. Tracking: Refs #113/#53; qualification #167/#169.
Detailed red/green proofs, corrected triage and artifact receipts remain ignored
in `.sprint-local/`. This is implementation and offline verification, not release
authorization. No merge, deploy, host operation or live session use is included.

| Group | Implemented disposition | Source and retained guards |
| --- | --- | --- |
| F1 | Proposed ADR-0012 replaces public search/Ask global metadata with coordinated V2 shapes. TypeScript and Swift consumers require the matching contract. | Authority search release retains the exact pointer/head; Ask consumes that internal witness. Final authorization, stale-state rejection, audit-before-release and exact public-response digests remain covered. Restricted-latest and empty employee search responses disclose no hidden head. |
| F2 | One model choice: `answer: null` or a text/citations object. Only a valid null renders the fixed abstention. | Existing composition/route tests cover supported negative conclusions, synthesis, citations, contradiction prompts and valid 63/64-byte questions. Malformed output fails closed without retries, revalidation or audit release. |
| F3 | Preserve structured Authority code/status; centralize bounded query validation in the neutral organization API. | Composed CLI tests cover Ask and every records path, normalization/size/term rules, unauthorized/unavailable errors, safe unknown failures and stderr/nonzero exits. Employee mutation outcomes retain their meaning. |
| F4 | Status exposes existing client source SHA/kind in either sign-in state. Existing kit smoke accepts an exact shared release/tarball and reports their hashes. | Package-reader/status and installer tests distinguish same-version sources. Native account decoder validates client provenance. Serving Authority identity must come from independent operator evidence. |

The contract remains **proposed**, not accepted: see
[ADR-0012](../decisions/ADR-0012-person-public-response-privacy.md).
ADR-0006's accepted historical contract has not been silently rewritten.
The minimum matching client supports `echo-clean-person-record-search-v2` and
`echo-clean-person-answer-v2`; exact source/tarball identity, not the reused
product version, identifies the candidate.

Cleanup completed: removed global public metadata serialization/decoding and
the unused Swift head decoder; removed the old Ask outcome negotiation; retired
model status/text normalization paths and redundant old-shape tests; removed
the blanket “catching up” rewrite and duplicate query-text validation helpers.
Kept request-local citation, audit, authorization, temporal/negative/conditional
and failure guards. Completed `tools --help`, retained provider help and added
a bounded negative-limit parser correction. Updated the existing core checkpoint
to match public digests against internal audit/pointer evidence and migrated its
deterministic model fixture. The existing rehearsal evaluator now requires both
process streams, exit, signal and launch-error evidence. It cannot turn NUL or
oversized-argv launch failures into Authority outages or successful answers.

The one-off Mac-pinned checker is retired as a supported qualification workflow;
its user-owned Desktop script and historical evidence were not deleted. Use the
[existing candidate qualification procedure](../../deploy/release/README.md#person-contract-candidate-qualification)
and [rehearsal capture contract](../../demo/README.md) instead. No additional
installer, identity store, provider path, input-file mechanism or retry policy
was added.

Offline proof uses independently installed dependencies (`npm ci`), focused
red/green tests, the persisted core checkpoint, compiled Mac decoders, disposable
installer checks, exact-source Mac package smoke, and `npm run check` at the final
implementation head. Native Linux is skipped on Mac; mocked Linux shell/header
checks are not native qualification.

Still owed: explicit contract review, one canonical release and identical Person
tarball on both native targets, employee repetitions on the employee device and
owner controls on the owner device, with correlated serving Authority image,
internal generation/head and returned-response audit digest. Preserve failures
as well as successes, including Q4 and the valid 63/64-byte questions. Offline
schema proofs do not establish live model reliability. Reconcile #113/#53 and
#167/#169 acceptance only when that evidence exists; #108, #110 and #191 remain
separate. No extra input-limit defect was established.
