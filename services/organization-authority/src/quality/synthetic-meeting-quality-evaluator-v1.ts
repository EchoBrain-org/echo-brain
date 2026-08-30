import {
  createRetrievalGroundedAnswerComposition,
  type StructuredGenerationPort,
} from "../answer-composition/retrieval-grounded-answer-composition.js";
import {
  assertCanonicalDecisionSet,
  assertCanonicalMeetingBatch,
  assertCanonicalMeetingDocument,
} from "../processing/core/index.js";
import type {
  DecisionProcessorAdapter,
  ExtractedSignal,
  MeetingSourceAdapter,
} from "../processing/core/index.js";
import {
  SyntheticMeetingSourceAdapterV1,
  syntheticMeetingQualityDocumentsV1,
  syntheticMeetingQualityCorpusV1,
  validateSyntheticMeetingQualityCorpusV1,
  type SyntheticExpectedSignalV1,
  type SyntheticMeetingQualityCorpusV1,
} from "./synthetic-meeting-fixture-v1.js";
import {
  SyntheticFixtureReleasedRetrievalPortV1,
  syntheticFixtureAtomIdV1,
} from "./synthetic-answer-composition-fixture-port-v1.js";

export interface SyntheticExtractionCaseResultV1 {
  readonly fixture_id: string;
  /** Counts only. Never report model-produced fixture text to a shell caller. */
  readonly missing_count: number;
  readonly unexpected_count: number;
}

export interface SyntheticExtractionExpectationV1 {
  readonly meeting_id: string;
  readonly expected_signals: readonly SyntheticExpectedSignalV1[];
}

export interface SyntheticAnswerCompositionCaseResultV1 {
  readonly case_id: string;
  readonly principal_id: string;
  readonly expected_status: "answered" | "insufficient_evidence";
  readonly actual_status: "answered" | "insufficient_evidence";
  readonly missing_required_citation_atom_ids: readonly string[];
  readonly missing_required_answer_substrings: readonly string[];
  /** Released retrieval admitted a withheld fixture atom into composition. */
  readonly withheld_text_released: boolean;
  /** Bounded diagnostic: the evaluator never emits withheld fixture text. */
  readonly withheld_text_detected_in: readonly ("released_context" | "composed_answer")[];
}

export interface SyntheticMeetingQualityEvaluationV1 {
  readonly schema_version: 1;
  readonly kind: "echo-synthetic-meeting-quality-evaluation-v1";
  readonly source_adapter_id: string;
  readonly processor_adapter_id: string;
  readonly extraction: {
    readonly cases: readonly SyntheticExtractionCaseResultV1[];
    readonly processed_meeting_count: number;
    readonly scored_meeting_count: number;
    readonly missing_count: number;
    readonly unexpected_count: number;
  };
  /** Compatibility field retained for existing machine-readable reports. */
  readonly layer4: {
    readonly cases: readonly SyntheticAnswerCompositionCaseResultV1[];
    readonly status_mismatch_count: number;
    readonly missing_required_citation_count: number;
    readonly missing_required_answer_substring_count: number;
    readonly withheld_text_release_count: number;
    readonly withheld_text_detection_count: number;
  };
  /** A single gate for CI or a pre-staging shell wrapper. */
  readonly passed: boolean;
}

export interface SyntheticMeetingQualityEvaluatorInputV1 {
  /** Defaults to the in-memory adapter for the supplied corpus. */
  readonly source?: MeetingSourceAdapter;
  readonly processor: DecisionProcessorAdapter;
  readonly planner: StructuredGenerationPort;
  readonly answerer: StructuredGenerationPort;
  readonly generation_adapter_id: string;
  readonly planner_model: string;
  readonly answer_model: string;
  readonly corpus?: SyntheticMeetingQualityCorpusV1;
  /**
   * Optional thin overlay for an existing synthetic corpus. This permits the
   * Phase 1 replay corpus to remain the source of mass meeting inputs rather
   * than duplicating it in this evaluator.
   */
  readonly extraction_expectations?: readonly SyntheticExtractionExpectationV1[];
  readonly timeout_ms?: number;
}

/**
 * Ground truth for every Phase 1 replay meeting. Review outcomes are not an
 * extraction label: edited and rejected candidates must still be identified
 * correctly before the later approval gate decides whether to publish them.
 */
function expectedTriple(
  meeting_id: string,
  decision: string,
  action: string,
  rationale: string,
): SyntheticExtractionExpectationV1 {
  return Object.freeze({
    meeting_id,
    expected_signals: Object.freeze([
      Object.freeze({ kind: "decision" as const, text: decision, subject: null }),
      Object.freeze({ kind: "action" as const, text: action, subject: null }),
      Object.freeze({ kind: "rationale" as const, text: rationale, subject: null }),
    ]),
  });
}

export const phaseOneSyntheticExtractionExpectationsV1: readonly SyntheticExtractionExpectationV1[] =
  Object.freeze([
    expectedTriple("synthetic-dr-01", "Adopt a two-stage release review for the authority migration.", "Document the reviewer checklist before rollout.", "A staged review keeps irreversible changes behind an explicit gate."),
    expectedTriple("synthetic-dr-02", "Keep organization record submission asynchronous from local delivery.", "Add separate operator reporting for submission failures.", "Independent egress paths prevent a remote outage from blocking local work."),
    expectedTriple("synthetic-dr-03", "Use canonical revisions as the boundary for meeting reprocessing.", "Increment the revision whenever normalized content changes.", "Stable revisions make retries idempotent while preserving meaningful updates."),
    expectedTriple("synthetic-dr-04", "Require source identity to match every replay fixture.", "Reject mixed-source batches in the fixture reader.", "Provenance mismatch would invalidate parity evidence."),
    expectedTriple("synthetic-dr-05", "Freeze approved briefs before any delivery attempt.", "Hash the approved brief into the delivery idempotency key.", "A retry must deliver the reviewed artifact rather than a recomputed one."),
    expectedTriple("synthetic-dr-06", "Keep the synthetic replay path offline.", "Fail the test if global fetch is called.", "Band B must not contact meeting, Slack, or record services."),
    expectedTriple("synthetic-dr-07", "Publish the replay report as canonical Phase 1 evidence.", "Attach the canonical replay-green tag.", "The deterministic processor produced matching output."),
    expectedTriple("synthetic-dr-08", "Count synthetic approvals toward reviewer capacity.", "Include fixture outcomes in the thirty-day metric.", "Synthetic resolutions exercise the same approval interface."),
    expectedTriple("synthetic-dr-09-r1", "Delete the machine delivery path immediately after one replay.", "Remove the machine writer in the next commit.", "A single replay appears sufficient."),
    expectedTriple("synthetic-dr-09-r2", "Delete the machine delivery path immediately after synthetic replay.", "Schedule deletion before real-corpus validation.", "Synthetic parity appears sufficient for cutover."),
    expectedTriple("synthetic-pp-01", "Sequence relocation before person authentication work.", "Finish the processing checkpoint before opening Phase 2.", "A stable module boundary reduces authentication rework."),
    expectedTriple("synthetic-pp-02", "Use one commit per green migration unit.", "Run the complete check before pushing each unit.", "Small verified commits preserve useful rollback points."),
    expectedTriple("synthetic-pp-03", "Reserve the canonical replay checkpoint for real meeting batches.", "Use the synthetic-green tag for engineering completion.", "Invented fixtures cannot establish real-corpus coverage."),
    expectedTriple("synthetic-pp-04", "Run a fresh workspace rebuild before each checkpoint tag.", "Remove build artifacts and rebuild every workspace.", "A warm cache can conceal missing exports or generated files."),
    expectedTriple("synthetic-pp-05", "Keep rollback checkpoints on the migration branch.", "Record exact commit and tag identifiers in the ledger.", "Recovery needs immutable references rather than prose alone."),
    expectedTriple("synthetic-pp-06", "Treat identity-provider selection as a Phase 2 configuration decision.", "Keep Phase 1 replay provider-neutral.", "Fixture processing does not require a person authentication vendor."),
    expectedTriple("synthetic-pp-07", "Merge the migration branch directly into main after Band B.", "Skip a separate owner review checkpoint.", "The synthetic test suite is already green."),
    expectedTriple("synthetic-pp-08", "Retire the JSONL outbox during Phase 1.", "Delete its adapter after the synthetic replay.", "The organization record path will eventually replace local output."),
    expectedTriple("synthetic-pp-09", "Start the production daemon during fixture replay.", "Run the launch agent against the synthetic corpus.", "Production scheduling would make the replay more realistic."),
    expectedTriple("synthetic-pp-10", "Reuse production Slack credentials in the synthetic harness.", "Resolve fixture approvals through the production channel.", "Production reactions would exercise the existing surface."),
    expectedTriple("synthetic-cd-01", "Offer a clear explanation when a decision is withheld.", "Include the reviewer reason in the rejection record.", "Operators need to distinguish policy refusal from pipeline failure."),
    expectedTriple("synthetic-cd-02", "Show the source meeting and revision on every review card.", "Bind the presentation to the canonical provenance fields.", "Reviewers need enough context to detect a stale candidate."),
    expectedTriple("synthetic-cd-03", "Preserve edited decision text with its original evidence links.", "Change only the declared decision field during review.", "An edit should remain traceable to the immutable meeting snapshot."),
    expectedTriple("synthetic-cd-04", "Report delivery failures separately from approval failures.", "Preserve the failed stage in the cycle result.", "Remediation depends on whether review or transport failed."),
    expectedTriple("synthetic-cd-05", "Keep rejected candidate content out of organization records.", "Record only the source, meeting identifier, time, and reason.", "A rejection is an act, not a release of the candidate brief."),
    expectedTriple("synthetic-cd-06", "Keep synthetic labels visible in replay reports.", "Mark every fixture outcome as capacity-ineligible.", "Test activity must never be mistaken for human review."),
    expectedTriple("synthetic-cd-07", "Expose all pending meeting content to every organization member.", "Add pending candidates to the shared search index.", "Broad visibility would accelerate review."),
    expectedTriple("synthetic-cd-08", "Store fixture transcripts indefinitely for support debugging.", "Keep every replay corpus in the repository.", "Historical fixtures simplify future regression analysis."),
    expectedTriple("synthetic-cd-09", "Automatically approve any decision older than forty-eight hours.", "Resolve aged cards without a reviewer action.", "Queue age is more important than an explicit release decision."),
    expectedTriple("synthetic-cd-10", "Treat a missing reviewer identity as an anonymous approval.", "Persist the release without principal attribution.", "The approved content matters more than who released it."),
  ]);

function signature(signal: Pick<ExtractedSignal, "kind" | "text" | "subject">): string {
  return JSON.stringify([signal.kind, signal.subject, signal.text]);
}

function normalizedFixtureText(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function extractionExpectationIndex(
  expectations: readonly SyntheticExtractionExpectationV1[],
): ReadonlyMap<string, SyntheticExtractionExpectationV1> {
  const index = new Map<string, SyntheticExtractionExpectationV1>();
  for (const expectation of expectations) {
    if (
      typeof expectation.meeting_id !== "string" ||
      expectation.meeting_id.length === 0 ||
      !Array.isArray(expectation.expected_signals) ||
      index.has(expectation.meeting_id)
    ) {
      throw new Error("synthetic extraction expectations are invalid or duplicated");
    }
    for (const signal of expectation.expected_signals) {
      if (
        (signal.kind !== "decision" && signal.kind !== "action" && signal.kind !== "rationale") ||
        typeof signal.text !== "string" ||
        signal.text.length === 0 ||
        (signal.subject !== null && typeof signal.subject !== "string")
      ) {
        throw new Error("synthetic extraction expectation signal is invalid");
      }
    }
    index.set(expectation.meeting_id, expectation);
  }
  return index;
}

async function evaluateExtraction(
  source: MeetingSourceAdapter,
  processor: DecisionProcessorAdapter,
  expectations: readonly SyntheticExtractionExpectationV1[],
): Promise<SyntheticMeetingQualityEvaluationV1["extraction"]> {
  const byId = extractionExpectationIndex(expectations);
  const cases: SyntheticExtractionCaseResultV1[] = [];
  const scoredIds = new Set<string>();
  const seenMeetingIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let processedMeetingCount = 0;
  do {
    const batch = await source.pull({ limit: 100, ...(cursor === undefined ? {} : { cursor }) });
    assertCanonicalMeetingBatch(batch);
    for (const meeting of batch.meetings) {
      assertCanonicalMeetingDocument(meeting, source.identity);
      if (seenMeetingIds.has(meeting.id)) {
        throw new Error("synthetic source returned a duplicate meeting id");
      }
      seenMeetingIds.add(meeting.id);
      processedMeetingCount += 1;
      const decisionSet = await processor.extract(meeting, {
        processor_version: processor.identity.version,
        input_fingerprint: `synthetic-eval:${meeting.id}`,
      });
      assertCanonicalDecisionSet(decisionSet, meeting, processor.identity);
      const expectation = byId.get(meeting.id);
      if (expectation === undefined) {
        throw new Error("synthetic source meeting has no explicit extraction expectation");
      }
      scoredIds.add(meeting.id);
      const expected = new Set(expectation.expected_signals.map(signature));
      const observed = new Set(decisionSet.signals.map(signature));
      cases.push(Object.freeze({
        fixture_id: expectation.meeting_id,
        missing_count: [...expected].filter((value) => !observed.has(value)).length,
        unexpected_count: [...observed].filter((value) => !expected.has(value)).length,
      }));
    }
    cursor = batch.next_cursor;
    if (cursor !== undefined && (cursor.length === 0 || seenCursors.has(cursor))) {
      throw new Error("synthetic source returned an invalid cursor sequence");
    }
    if (cursor !== undefined) seenCursors.add(cursor);
  } while (cursor !== undefined);
  if (scoredIds.size !== byId.size) {
    throw new Error("synthetic extraction expectation did not match a source meeting");
  }
  return Object.freeze({
    cases: Object.freeze(cases),
    processed_meeting_count: processedMeetingCount,
    scored_meeting_count: cases.length,
    missing_count: cases.reduce((total, result) => total + result.missing_count, 0),
    unexpected_count: cases.reduce((total, result) => total + result.unexpected_count, 0),
  });
}

async function evaluateAnswerComposition(
  input: Required<Pick<SyntheticMeetingQualityEvaluatorInputV1,
    "planner" | "answerer" | "generation_adapter_id" | "planner_model" | "answer_model">> &
    Pick<SyntheticMeetingQualityEvaluatorInputV1, "timeout_ms"> & {
      readonly corpus: SyntheticMeetingQualityCorpusV1;
    },
): Promise<SyntheticMeetingQualityEvaluationV1["layer4"]> {
  const cases: SyntheticAnswerCompositionCaseResultV1[] = [];
  const atomsById = new Map(input.corpus.layer4_atoms.map((atom) => [atom.id, atom]));
  for (const qualityCase of input.corpus.layer4_cases) {
    const releasedRetrieval = new SyntheticFixtureReleasedRetrievalPortV1({
      principal_id: qualityCase.principal_id,
      atoms: input.corpus.layer4_atoms,
    });
    const answer = createRetrievalGroundedAnswerComposition({
      planner: input.planner,
      answerer: input.answerer,
      released_retrieval: releasedRetrieval,
      audit: { append: () => undefined },
      generation_adapter_id: input.generation_adapter_id,
      planner_model: input.planner_model,
      answer_model: input.answer_model,
      ...(input.timeout_ms === undefined ? {} : { timeout_ms: input.timeout_ms }),
    });
    const result = await answer.answer({ question: qualityCase.question });
    const cited = new Set(result.citations.map((citation) => citation.atom_id));
    const required = qualityCase.required_citation_atom_ids.map((atomId) => {
      const atom = atomsById.get(atomId);
      if (atom === undefined) {
        throw new Error(`synthetic answer-composition citation atom id is unknown: ${atomId}`);
      }
      return syntheticFixtureAtomIdV1(atom);
    });
    const withheldText = input.corpus.layer4_atoms
      .filter((atom) => !atom.readable_by_principal_ids.includes(qualityCase.principal_id))
      .map((atom) => atom.text);
    // The read port is the authorization boundary. Inspect only the atoms it
    // actually released while composing this in-memory answer.
    const releasedTextSet = new Set(
      releasedRetrieval.releases.flatMap((release) =>
        release.released_atoms.map((atom) => atom.text),
      ),
    );
    const normalizedAnswer = normalizedFixtureText(result.answer);
    const withheldTextDetectedIn: ("released_context" | "composed_answer")[] = [];
    if (withheldText.some((text) => releasedTextSet.has(text))) {
      withheldTextDetectedIn.push("released_context");
    }
    if (withheldText.some((text) => normalizedAnswer.includes(normalizedFixtureText(text)))) {
      withheldTextDetectedIn.push("composed_answer");
    }
    cases.push(Object.freeze({
      case_id: qualityCase.id,
      principal_id: qualityCase.principal_id,
      expected_status: qualityCase.expected_status,
      actual_status: result.citations.length === 0 ? "insufficient_evidence" : "answered",
      missing_required_citation_atom_ids: Object.freeze(
        required.filter((atomId) => !cited.has(atomId)),
      ),
      missing_required_answer_substrings: Object.freeze(
        qualityCase.required_answer_substrings.filter(
          (expected) => !normalizedAnswer.includes(expected.toLocaleLowerCase("en-US")),
        ),
      ),
      withheld_text_released: withheldTextDetectedIn.includes("released_context"),
      withheld_text_detected_in: Object.freeze(withheldTextDetectedIn),
    }));
  }
  return Object.freeze({
    cases: Object.freeze(cases),
    status_mismatch_count: cases.filter((value) => value.expected_status !== value.actual_status).length,
    missing_required_citation_count: cases.reduce(
      (total, value) => total + value.missing_required_citation_atom_ids.length,
      0,
    ),
    missing_required_answer_substring_count: cases.reduce(
      (total, value) => total + value.missing_required_answer_substrings.length,
      0,
    ),
    withheld_text_release_count: cases.filter((value) => value.withheld_text_released).length,
    withheld_text_detection_count: cases.filter(
      (value) => value.withheld_text_detected_in.length > 0,
    ).length,
  });
}

/**
 * Runs a no-write synthetic corpus against injected real adapters. The caller
 * owns credentials and model construction; this module owns only invented
 * fixtures, scoring, and the permission-aware release-to-composition boundary.
 */
export async function evaluateSyntheticMeetingQualityV1(
  input: SyntheticMeetingQualityEvaluatorInputV1,
): Promise<SyntheticMeetingQualityEvaluationV1> {
  const corpus = input.corpus ?? syntheticMeetingQualityCorpusV1;
  validateSyntheticMeetingQualityCorpusV1(corpus);
  const source =
    input.source ??
    new SyntheticMeetingSourceAdapterV1(
      syntheticMeetingQualityDocumentsV1(corpus.fixtures),
    );
  const extraction = await evaluateExtraction(
    source,
    input.processor,
    input.extraction_expectations ?? corpus.fixtures.map((fixture) => ({
      meeting_id: fixture.id,
      expected_signals: fixture.expected_signals,
    })),
  );
  const answerComposition = await evaluateAnswerComposition({
    planner: input.planner,
    answerer: input.answerer,
    generation_adapter_id: input.generation_adapter_id,
    planner_model: input.planner_model,
    answer_model: input.answer_model,
    corpus,
    ...(input.timeout_ms === undefined ? {} : { timeout_ms: input.timeout_ms }),
  });
  return Object.freeze({
    schema_version: 1,
    kind: "echo-synthetic-meeting-quality-evaluation-v1",
    source_adapter_id: source.identity.adapter_id,
    processor_adapter_id: input.processor.identity.adapter_id,
    extraction,
    layer4: answerComposition,
    passed:
      extraction.missing_count === 0 &&
      extraction.unexpected_count === 0 &&
      answerComposition.status_mismatch_count === 0 &&
      answerComposition.missing_required_citation_count === 0 &&
      answerComposition.missing_required_answer_substring_count === 0 &&
      answerComposition.withheld_text_detection_count === 0,
  });
}
