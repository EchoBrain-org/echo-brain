# Landed-contract and complexity review — 2026-09-11

The provider-neutral processing architecture survives, but the whole product does not yet meet the stronger claim that providers are interchangeable without changes outside their adapters. Provider code is spread across multiple folders and packages. There are concrete boundary leaks, unused code and tests, and documentation that no longer describes the implementation. CI is healthy and reasonably fast; staging's maintenance surface is the larger complexity concern.

The original diagnosis below describes the pinned September 11 baseline. The remediation section records the subsequent cleanup. Raw evidence remains available at the linked historical commit and in the original review worktree; generated inventories are not part of the maintained source tree.

**Scope and confidence**

- Reviewed landed `main` at `3b663a74ec5d64e2f99b80ca590429df1415e02d`, fetched from origin on September 11.
- Window: August 28 through September 11, 2026, starting at `d75fd8c147e66f3139e25d8e09ee7d2545a1da9a`. There are 68 first-parent landing commits and 719 changed paths. See [the complete landing inventory](https://github.com/EchoBrain-org/echo-brain/blob/35b653e25c965ed3491ccfdfb3ce836781a55da4/review-evidence/landed-commits.tsv) and [changed paths](https://github.com/EchoBrain-org/echo-brain/blob/35b653e25c965ed3491ccfdfb3ce836781a55da4/review-evidence/changed-files.tsv).
- Recovered the July 17 architecture at `5086d53`, then followed accepted amendments rather than treating superseded founder-only, local-processing, or no-search restrictions as current requirements.
- Inventoried the complete change window and examined the relevant provider dependency paths, policy contracts, retrieval/scoring boundaries, telemetry, build/CI, staging tooling, and test ownership. This is a targeted architecture review, not a claim to have manually audited every changed line or every permission path.
- Unmerged local branches and edits are excluded. The review branch and validation checkout both start from the same pinned landed commit.
- ECHO supplied recent work and historical review pointers, with input caps, truncated excerpts, and an unconsumed search cursor. Its context was partial and was journaled against runtime beta.10. Findings below rely on repository source, Git history, executable probes, and GitHub CI evidence.
- No live AWS, SSM, staging, or provider verification was performed. Staging conclusions concern the implementation and recorded CI, not the state of a running host.

**Answers to the review questions**

| Question | Diagnosis |
| --- | --- |
| Did the architecture contracts survive? | The core seams and permission-aware retrieval design remain. Provider isolation and current-only cleanup have gaps; decision documentation has drifted. No new access-widening defect was established in the paths inspected. |
| Is it provider agnostic? | At the processing/orchestration seam, substantially yes. Across policy implementation, Person tooling, and shared diagnostics, only partially. A complete second-provider qualification is still missing. |
| Is each provider in one folder? | No. The current invariant explicitly permits multiple declared roots. Slack has seven roots in the product manifest alone, plus implementation in control-plane, API, and record packages. |
| Is CI lean? | Operationally reasonable: latest ten main runs passed; latest completed in 6m55s. Expensive suites and unconditional scope offer optimization opportunities, but a CI redesign is not the first priority. |
| Is staging lean? | Its safety boundaries are purposeful. Its diagnostic and release-tool maintenance surface is substantial and should stop expanding without measured benefit. |
| Dead code or redundant tests? | Yes: an unused V1 telemetry writer with four writer-only tests, plus six unused installation-era API types. Some architecture tests also duplicate executable checks with source-string assertions. |
| Overengineering? | The strongest candidates are duplicated telemetry contract vocabularies, source/wording assertions, and the growing diagnostic surface. Permission fences, durable retry handling, artifact binding, and platform install proofs have concrete purposes. |

**Contract baseline**

The [July 17 core-and-adapters contract](https://github.com/EchoBrain-org/echo-brain/blob/5086d53/docs/architecture/core-and-adapters.md) says that no vendor defines the core domain model, adapters own external payload mapping, and composition selects providers. It does not state a literal one-directory-per-provider requirement.

[INV-ADAPTERS-005](docs/invariants/INV-ADAPTERS-005-provider-semantics-at-boundary.md) makes the stronger semantic rule explicit: provider payloads, cursors, identity grammar, transport metadata and presentation references terminate inside adapters or selecting bundles. It specifically includes approval policy among the neutral consumers. It permits several declared roots per provider and labels enforcement partial. The documented portability claim excludes replacing SQLite, Node primitives, key custody, or the OIDC protocol itself.

[ADR-0006](docs/decisions/ADR-0006-permission-aware-clean-v1-completion.md) preserves current-only V4, the two Person visibility policies, automatic derived-generation reconciliation, final authorization fences, and one minimized Person read-audit store. [ADR-0007](docs/decisions/ADR-0007-lean-layer-4-answer-composition-v1.md) bounds answer composition to one retrieval batch and at most two model calls. [ADR-0010](docs/decisions/ADR-0010-disposable-related-atom-projection-v1.md) explicitly authorizes the later disposable related-atom projection; its existence is not, by itself, unauthorized graph overengineering.

The accepted server migration and hosted-operation amendments changed earlier custody and deployment decisions. [ADR-0009](docs/decisions/ADR-0009-retained-authority-data-volume-boundary.md) justifies keeping organization state separate from replaceable host material. The accepted staging observability sprint and its September 8 extension explain the later journey sidecar and opt-in development content capture. Those should not be reported as violations of superseded scope statements.

**Findings, ordered by remediation value**

**F1 — Medium: private approval policy embeds Slack identity semantics outside the declared provider roots.**

Evidence: [private-approval-policy-resolution-v1.ts](packages/organization-control-plane/src/application/private-approval-policy-resolution-v1.ts), especially lines 41–59, 80–111 and 251–287. Its pending, authorization, and terminal resolution contracts carry Slack-specific identity links. Validation requires `provider === "slack"` and a Slack `U`/`W` subject format. This code entered with the private approval implementation on August 28 (`1e4285c`), before the subsequent provider-boundary cleanup, and remains today.

Executable evidence: the same otherwise-valid pending approval is accepted with `provider: "slack"` and rejected with `provider: "fixture-provider"`, with the error `assigned_owner_slack_identity_link.provider must be slack`.

This does not prove that the neutral Authority runtime cannot load another approval bundle: it can, and an existing test exercises that seam. It means the current policy resolver is a Slack implementation masquerading as shared application policy, and cannot be reused by another surface without modification or duplication. Its implementation root is also absent from the product provider-root registry.

Smallest correction: distinguish provider-independent policy resolution from Slack proof validation, and register or relocate the Slack implementation under explicit provider ownership. Preserve the exact human identity, tenure, frozen approval commitments, and reproof. Do not rename persisted commitments in place; use the repository's explicit versioning procedure if durable bytes must change. A new plugin framework is unnecessary.

**F2 — Medium: the new generic Person tools API is a single-Slack contract.**

Evidence: [person-tools.ts](packages/organization-api/src/person-tools.ts), lines 13–44. `OrganizationPersonToolV2.provider` is the literal `slack`; the list permits at most one item; validation parses Slack workspace and user ID formats. This was introduced by `8add7d9`, landed in PR #175 on September 10. Slack disconnect and browser-link support extend the same product surface.

Executable evidence: a valid Slack result passes; changing only its provider to `fixture-provider` fails with `Person tool state is invalid`. A second provider cannot simply supply a bundle and appear in this API. Shared API/client changes would be necessary.

Smallest correction: decide whether this is intentionally a Slack-specific endpoint or the generic tool inventory. For the generic inventory, keep provider IDs and account references opaque and move provider validation to provider-owned code. Preserve unavailable/revoked-state privacy behavior. No generic capability registry or speculative providers are needed. Changing a closed public response contract needs explicit compatibility treatment.

**F3 — Medium: shared core telemetry now understands provider response formats.**

Evidence: [core-runtime-observation-v1.ts](services/organization-authority/src/shared/core-runtime-observation-v1.ts), lines 5–40 and 170–203. The shared module contains a Slack phase, fixed provider/model vocabularies, and `observeCoreModelUsageV1(payload)`, which reads raw `usage.prompt_tokens`, `completion_tokens`, and Anthropic-style aliases. [llm-provider.ts](services/organization-authority/src/processing/adapters/decision-processors/llm/llm-provider.ts) calls this parser before returning the provider response. This arrived in the September 9 observability work (`e139134`, PR #152).

Executable evidence: the shared parser records tokens for a chat-completions-shaped response but records no token fields for `{prompt_eval_count: 12, eval_count: 5}`, the response shape handled by the existing Ollama adapter. Successful extraction subsequently supplies normalized token counts, so this probe is not a claim that all successful Ollama telemetry is broken. It exposes provider-sensitive handling before adapter validation, including the failure-observation path.

Smallest correction: normalize usage inside each provider adapter and give shared telemetry a typed, nullable usage object. Keep finite diagnostic categories and an `other` fallback where cardinality requires them, but own the provider-to-category mapping at the edge. Shared observation code should not inspect raw provider payloads.

**F4 — Medium: the provider gate misses these files because coverage is opt-in.**

Evidence: [product/source-boundary.v1.json](product/source-boundary.v1.json), `provider_neutral_paths`, and [check-architecture-boundaries.mjs](tools/check-architecture-boundaries.mjs), lines 1177–1206. The semantic-name check visits only listed neutral paths. The new shared observation module, generic Person tools API, and control-plane policy resolver are absent. Provider ownership discovery is also concentrated on the Authority adapter tree and a short list of implemented interface names.

Executable evidence: an unchanged source snapshot passes the architecture checker. Adding those three existing files to the neutral-path list, without changing their source, produces eight provider-identifier violations. The temporary snapshot was deleted after the probe.

This is the gap between a green boundary test and the broader architectural claim. The invariant already acknowledges partial enforcement, so the finding is incomplete coverage rather than a claim that the checker promises a hostile-code sandbox.

Smallest correction: cover neutral directories by default and make provider-owned exceptions explicit across workspaces. Retain the existing negative import/bridge tests; add one regression for an ordinary new shared file. Avoid expanding the checker into a general JavaScript data-flow engine.

**F5 — Low: current cleanup left an unused writer, redundant writer tests, and obsolete API types.**

The production staging transport invokes only `formatStagingJourneyContentRecordsV2` at [staging-journey-telemetry-transport-v1.ts:275](services/organization-authority/src/composition/staging/observability/staging-journey-telemetry-transport-v1.ts). `formatStagingJourneyContentRecordV1` at [the content formatter](services/organization-authority/src/composition/staging/observability/staging-journey-content-telemetry-v1.ts), line 166, has no production caller. Its callers are exclusively the four tests in [staging-journey-content-telemetry-v1.test.ts](services/organization-authority/test/composition/staging/observability/staging-journey-content-telemetry-v1.test.ts). V2 replaced the writer in the September 9 work.

Delete the unused V1 writer, its exclusive bounding/serialization helpers and writer-only tests. Retain shared types/helpers still needed by V2 and retain Explorer support for reading historical V1 records. Historical log readability does not require retaining an obsolete runtime writer.

Separately, [organization-api contracts](packages/organization-api/src/contracts.ts), lines 233–309, and [its public index](packages/organization-api/src/index.ts), lines 33–38, still declare and export six `OrganizationInstallationSlackIdentityLink*V1` types. Repository references resolve only to those declarations and exports. They predate the review window and survived the cleanup, despite the current-only contract and removal of installation-signed linking. Remove these obsolete type exports rather than implying a supported installation API.

Do not treat the old reaction tables as an equivalent easy deletion. `69128ec` explicitly retained them in the frozen V1 SQL baseline. Removing them requires a deliberate schema revision. This review found no active code callers for the retired pending-approval tables, but their exact-schema tests still protect installed schema identity.

**F6 — Low: contract documentation is no longer a reliable current-state index.**

[ADR-0011](docs/decisions/ADR-0011-bm25-lexical-scoring-v1.md), line 12, and [the decision index](docs/decisions/README.md) still say `proposed`, while the active analyzer implements BM25 and PR #154 is merged. The PR has an approved review, so this is not evidence that the implementation lacked human authorization. It is an unresolved disposition record for a change ADR-0007 says needs a decision.

[The control-plane architecture document](docs/architecture/organization-control-plane.md) also describes retained installation compatibility and migration-ledger behavior, names historical migrations, and says Slack OAuth redirect is not needed. The current implementation uses frozen baselines and now has the optional browser-link flow. Historical explanation and current instructions are mixed.

Correct the decision status using the actual acceptance evidence; do not fabricate an acceptance date or signer. Rewrite the current architecture description around the current path and label retained history. The passing documentation check validates structure and links, not agreement with runtime behavior.

**F7 — Low: some tests pin implementation text rather than independently protecting behavior.**

Examples: [organization-authority-deployment-profile.test.ts](tests/architecture/organization-authority-deployment-profile.test.ts), starting at line 426, checks shell function names, exact messages, source fragments and paths. [organization-authority-release-record.test.ts](tests/architecture/organization-authority-release-record.test.ts), lines 682–700, checks canary wording and source tokens such as `.authority-operation-lock`; later cases execute lock and candidate-admission behavior. Some Dockerfile source assertions overlap the actual image checks in CI.

These can fail on harmless restructuring, while the presence of a string cannot establish execution order or effective enforcement. They are candidates for selective removal after mapping each assertion to a real behavioral test. They are not evidence that the entire architecture suite is redundant. Keep static assertions for boundaries that need static enforcement, and keep the executable negative cases.

**Provider layout and the smallest useful consolidation**

The manifest declares five Granola roots, three OpenRouter roots, and seven Slack roots. Additional Slack code resides in organization-control-plane, organization-api, and organization-record. Counting every provider-name occurrence would also count comments and explicit product configuration, so it is not a reliable measure of semantic leakage.

Two distinct goals should be recorded separately: provider semantics must terminate at the edge, and provider-owned code should be easy to navigate. A practical next structure is one provider-owned subtree per relevant workspace, with explicit thin composition entrypoints. If the intended rule is literally one physical root for each provider across the whole repository, that is a stronger new packaging decision. Document it before a large cross-workspace move. Fix F1–F4 first; moving files without fixing the policy/API contracts would only conceal the coupling.

**CI evidence and optimization order**

The [reviewed CI run](https://github.com/EchoBrain-org/echo-brain/actions/runs/34629839791) tests exactly `3b663a7`. The last ten main runs retrieved were all successful. The latest workflow ran from 17:49:22Z to 17:56:17Z: 6m55s including scheduling and aggregation. [Raw summarized evidence](https://github.com/EchoBrain-org/echo-brain/blob/35b653e25c965ed3491ccfdfb3ce836781a55da4/review-evidence/ci.json) records the exact runs, jobs, steps and suites.

| Latest job/step | Observed duration |
| --- | --- |
| General `check` job | 6m43s |
| `npm run check` step | 5m03s |
| Core checkpoint step | 1m04s |
| macOS ARM64 package job | 1m38s |
| Authority ARM64 container job | 1m00s |
| Infrastructure validation job | 27s |

The Linux suite reported 1,931 passed tests and 59 skipped tests across 159 passed files and two skipped files. The separate macOS native fixture step passed 63 tests across three files. These counts overlap across platform jobs and must not be added as a unique-test count. Vitest time was 281.92s.

The slowest Linux suites were workspace boundaries (125.266s), release records (89.283s), and deployment profiles (79.139s). Their summed 293.688s is suite time, not workflow wall time: two Vitest workers overlap execution. Optimizing fixture copying/process startup and redundant assertions here is more promising than removing the fast container or infrastructure proofs.

There are four substantive CI jobs and one aggregate required check, with pinned tools/actions, PR cancellation, native platform checks, and container caching. Those are useful foundations. Every PR and main push runs all jobs; no path-based selection exists. That was already true at the start of the review window. A later optimization could keep full main/release validation while selecting affected PR lanes, with explicit handling in the required-check aggregator. This is optional efficiency work, not a current correctness finding.

Do not delete the independent BM25 oracle as a duplicate scorer: it verifies engine agreement independently. Do not discard restart/replay, private-statistics isolation, membership revocation, exact-generation release, or packaged clean-install tests because nearby unit tests exist.

**Staging complexity and overengineering assessment**

Nine directly related telemetry and Explorer files total 5,180 source lines: Ask telemetry, approval telemetry, its SQLite sidecar, shared journey/core observation contracts, content formatting, metrics, transport and the Explorer handler. This excludes their tests and infrastructure definitions. The sidecar has six tables and restart/attempt reconciliation. The Explorer separately restates the core phase vocabulary. That is a substantial maintenance surface for two immediate journeys.

The complexity has recorded causes: the September 8 observability document reports a 31.534s worker-gate wait, a 61.212s search preparation step, and 353.841s initial card delivery across retries. Removing correlation and failure visibility would recreate a demonstrated operational problem. The sidecar is deliberately separate and disposable; non-staging runtime tests prove its absence, and observer failures are designed not to control business outcomes.

The best reduction is to remove the obsolete writer, share the event vocabulary across producer and Explorer, and keep one producer/transport path. Require evidence before adding more trace schemas, dashboards, durable telemetry state, or generic orchestration layers. The recorded overhead experiment uses an empty corpus and an in-memory writer; it cannot establish CloudWatch cost or representative staging overhead. Measure the actual rehearsal before declaring the diagnostic surface cheap or excessive.

Release checks for immutable artifacts, current-host reuse, retained-volume ownership, unknown remote outcomes, human Slack approval, and final candidate acceptance protect different failure modes. Keep those boundaries. Consolidate duplicate validation implementations only where parity can be preserved; the Node/Python split also serves different build and host environments. This review does not recommend weakening release checks to shorten the operator path.

**Positive evidence and limits**

- The Authority runtime receives source, processor, approval, external-identity and generation bundles rather than selecting providers in its processing cycle. The private-approval runtime test loads conforming fake bundles and a non-Slack ingress route; this proves composition seams, not end-to-end qualification of a second real provider.
- Record policy projection has an injected registry and opaque resolution references. Provider-specific record interpretation is separable from the canonical record path.
- BM25 computes statistics from the union of admitted segments. A regression verifies that private-segment statistics cannot alter a member's rankings. The independent oracle and evaluation lane should be retained.
- Answer composition consumes released atoms through the request-local Layer 3 boundary, with bounded retrieval and final revalidation/audit. No iterative agent retrieval loop or direct lower-layer storage dependency was established in the inspected answer path.
- The recent cleanup did remove substantial legacy reaction-approval, alias and Phase-1 quality surfaces. F5 identifies leftovers, not an absence of cleanup.

**Recommended work sequence**

1. Fix provider ownership and gate coverage together: separate Slack proof validation from shared policy, isolate provider usage mapping, resolve the generic tools contract, and add ordinary-new-file coverage. Preserve all authorization and immutable-byte semantics.
2. Delete the unused telemetry writer and four exclusive tests; remove the six obsolete API type exports; correct current architecture and decision records. This is the smallest maintenance win.
3. Profile and simplify the three expensive test suites. Remove only assertions whose behavior is independently covered. Share fixture setup without weakening isolation.
4. Consolidate the telemetry contract vocabulary and assess its cost on a representative rehearsal. Avoid a broader observability or release framework.
5. Qualify one genuinely different provider through the existing seams before strengthening the product's portability claim. The test should preserve policy, canonical records and processing behavior, not merely compile a second adapter.

The full local `npm run check` passed on the pinned source: architecture, documentation, lint, build, types, and all 161 test files; 1,989 tests passed and one was skipped. Vitest took 280.99s. The test process emitted a non-failing SIGINT listener warning, recorded without attributing an uninvestigated cause. Validation results and reproducible probe outputs are retained in [review-evidence](https://github.com/EchoBrain-org/echo-brain/blob/35b653e25c965ed3491ccfdfb3ce836781a55da4/review-evidence/), including `scope.json` and `validation.txt`.

## Remediation pass — 2026-09-11

This section records what the same-day cleanup pass changed in this review worktree, what it deliberately left alone, and the additional dead surface an independent export scan found beyond F5. Every removal below was verified by reference search before deletion and by the full local gate afterwards; see [remediation-validation.txt](https://github.com/EchoBrain-org/echo-brain/blob/35b653e25c965ed3491ccfdfb3ce836781a55da4/review-evidence/remediation-validation.txt).

**Own pass: additional findings**

The [dead-export scan](https://github.com/EchoBrain-org/echo-brain/blob/35b653e25c965ed3491ccfdfb3ce836781a55da4/review-evidence/dead-export-scan.txt) listed 103 exported values that no other file references. Most are constants or helpers still used inside their own module and were left alone. The scan also exposed a stale port that the diagnosis above did not reach:

- **The Authority repository port was two-thirds fiction.** [authority-repository.ts](services/organization-authority/src/application/ports/authority-repository.ts) declared `AuthorityReadTransaction`, `AuthorityWriteTransaction`, and `OrganizationAuthorityRepository` with eleven methods that had no implementation and no caller, plus the complete reviewer-query, readable-search-query, Person-read-decision, and meeting-ingestion-exclusion audit vocabularies, three unenforced 180-day retention constants, and a never-emitted `permission.readable_search_generation_published` action. The only repository is the Person session store, which implements the separate `PersonSessionRepository` port. The session application reached the stale type only through `as unknown as AuthorityWriteTransaction` casts inside `withAuthenticatedWrite` and `createPersonReadAuthorizationPort`, both of which threw unconditionally for that store and were called by nothing except a test asserting the throw. The port now carries only the entity types the session store actually reads and writes.
- **A no-op legacy audit hook.** `PersonSessionWriteTransaction.appendAudit?` existed "for the legacy repository only"; no repository implemented it, so the login-grant audit call in the session application never executed. Removed with the hook and its `supports_full_person_authorization_transactions` flag.
- **Smaller leftovers.** The retired `runCleanSlackConnectCli` aliases the control-plane README already said were gone, an `Echo-Enrollment` auth scheme, an unserved `/v2/admin/memberships` path constant, two thin V1 wrappers over the generic retrieval baseline installer, an unused delivery-envelope validator, two unused protocol validators with their private regexes, an unused credential-scope reader, and an unused OpenRouter default timeout.

**What changed**

1. F5: deleted `formatStagingJourneyContentRecordV1`, its private bounding and serialization helpers, the V1 record type and bounds, and the four writer-only tests. The V2 chunked writer, its identity validation, and the Explorer's reading of historical records are unchanged. Removed the six `OrganizationInstallationSlackIdentityLink*V1` types and their public re-exports.
2. F3: `observeCoreModelUsageV1` no longer exists in shared telemetry. The provider-to-usage mapping now lives in [llm-provider.ts](services/organization-authority/src/processing/adapters/decision-processors/llm/llm-provider.ts) inside the declared `llm` adapter root, and it reads Ollama's `prompt_eval_count`/`eval_count` shape as well as the chat-completions shape. A new test proves a rejected Ollama body still carries its token counts on the failed `model_call` observation, which was the failure-path gap the probe exposed.
3. F6: ADR-0011 is `accepted` with `reviewed_ref` set to the PR #154 merge commit, which carried an approved review; the decision index agrees. The control-plane architecture document was rewritten around the current path: five entry points, the three current behaviors, the browser-link and disconnect flows, the composed frozen baseline with no migration runner, the eight live tables against the nine retired-but-frozen ones, and a short retired-paths section so older design documents stay explainable. The stale component-map row was corrected to match.
4. The dead surfaces listed under the own pass above.

Net: 24 files, +304/−1632 lines before the evidence files.

**Deliberately not changed, with the reason**

- **F1 (Slack semantics in the private approval resolver).** The pending, authorization, and resolution contracts are frozen, digested commitments. Separating provider-neutral policy from Slack proof validation changes persisted bytes or requires a parallel contract version, which is a design change with a versioning procedure, not a cleanup edit. The architecture document now states the coupling and the constraint explicitly.
- **F2 (single-Slack Person tools contract).** Under the lean governance rule, the honest fix today is to document it as a Slack-specific inventory rather than to generalize a closed public response contract for a provider that does not exist. Documented; code unchanged.
- **F4 (opt-in gate coverage).** Widening `provider_neutral_paths` to cover shared directories by default surfaces the F1–F3 leaks as eight checker failures. With F3 fixed, the shared observation module can be added to the neutral list once the fixed provider/model category vocabularies are also moved behind the adapter edge; F1 and F2 still block the other two files. Do this together with F1.
- **F7 (source-string assertions).** Roughly 100 `toContain` assertions across the deployment-profile and release-record suites each need mapping to a behavioral test before removal. That mapping is real work with real risk to release safety and was not attempted here.
- **The retired V1 control-plane tables and the `federation-protocol` package name.** The tables are protected by the frozen baseline digest and exact-schema tests; the package name is stale but 160 files import its canonical-JSON and digest helpers, so a rename is churn without lean-down value.
- **Exports used only inside their own module.** Unexporting them changes nothing at runtime and touches many files for no maintenance gain.

**Next in order**

1. Fix F1 and F4 together, then add the shared observation module and the Person tools API to the neutral-path list.
2. Profile the three expensive architecture suites; the snapshot copies in the coherent-worktree fixture dominate, not assertion count.
3. Only after a representative staging rehearsal, decide whether the telemetry vocabulary duplication between producer and Explorer is worth consolidating.
