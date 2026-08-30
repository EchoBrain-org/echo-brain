import { readFile } from "node:fs/promises";
import { assertCanonicalMeetingDocument } from "../processing/core/index.js";
import type {
  AdapterConfig,
  AdapterConfigValidation,
  AdapterHealth,
  AdapterOperationContext,
  MeetingBatch,
  MeetingDocument,
  MeetingPullRequest,
  MeetingSourceAdapter,
} from "../processing/core/index.js";

export const syntheticMeetingSourceIdentityV1 = Object.freeze({
  kind: "meeting-source" as const,
  adapter_id: "synthetic-source",
  instance_id: "fixture",
  version: "1.0.0",
});

export interface SyntheticMeetingBlockV1 {
  readonly id: string;
  readonly kind: "note" | "transcript";
  readonly text: string;
}

type SyntheticExpectedSignalFieldsV1 = {
  readonly text: string;
  readonly subject: string | null;
};

export type SyntheticExpectedSignalV1 =
  | (SyntheticExpectedSignalFieldsV1 & { readonly kind: "decision" })
  | (SyntheticExpectedSignalFieldsV1 & { readonly kind: "action" })
  | (SyntheticExpectedSignalFieldsV1 & { readonly kind: "rationale" });

export interface SyntheticAnswerCompositionAtomV1 {
  /** Stable fixture-local handle used by quality expectations. */
  readonly id: string;
  readonly text: string;
  readonly policy_id:
    | "organization-member-readable-person-v2"
    | "restricted-reviewer-person-v2";
  /** The test harness models released-retrieval authorization with this list. */
  readonly readable_by_principal_ids: readonly string[];
  /** Small, explicit fixture search vocabulary. It is never passed to generation. */
  readonly search_terms: readonly string[];
}

export interface SyntheticAnswerCompositionCaseV1 {
  readonly id: string;
  readonly principal_id: string;
  readonly question: string;
  readonly expected_status: "answered" | "insufficient_evidence";
  /** Every listed atom must appear in the returned citations. */
  readonly required_citation_atom_ids: readonly string[];
  /** Stable wording expected from this deliberately unambiguous fixture. */
  readonly required_answer_substrings: readonly string[];
}

/**
 * Invented, provider-independent meeting input. It deliberately contains no
 * provider payload shape, credential reference, or production-record identifier.
 */
export interface SyntheticMeetingFixtureV1 {
  readonly id: string;
  readonly title: string;
  readonly owner_email: string;
  readonly blocks: readonly SyntheticMeetingBlockV1[];
  readonly expected_signals: readonly SyntheticExpectedSignalV1[];
}

export interface SyntheticMeetingQualityCorpusV1 {
  readonly schema_version: 1;
  readonly kind: "echo-synthetic-meeting-quality-corpus-v1";
  readonly fixtures: readonly SyntheticMeetingFixtureV1[];
  /** Compatibility field retained for existing evaluator corpora. */
  readonly layer4_atoms: readonly SyntheticAnswerCompositionAtomV1[];
  /** Compatibility field retained for existing evaluator corpora. */
  readonly layer4_cases: readonly SyntheticAnswerCompositionCaseV1[];
}

function corpusRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function uniqueNonEmptyStrings(
  value: unknown,
  label: string,
  allowEmpty = false,
): readonly string[] {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    !value.every(nonEmpty) ||
    new Set(value).size !== value.length
  ) {
    throw new Error(`${label} must be a ${allowEmpty ? "" : "non-empty "}unique string array`);
  }
  return value;
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(record).sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new Error(`${label} has an invalid shape`);
  }
}

/** Validates the closed, invented evaluation contract before any adapter runs. */
export function validateSyntheticMeetingQualityCorpusV1(
  value: unknown,
): asserts value is SyntheticMeetingQualityCorpusV1 {
  const corpus = corpusRecord(value, "synthetic quality corpus");
  const expectedKeys = ["fixtures", "kind", "layer4_atoms", "layer4_cases", "schema_version"];
  const actualKeys = Object.keys(corpus).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index]) ||
    corpus.schema_version !== 1 ||
    corpus.kind !== "echo-synthetic-meeting-quality-corpus-v1" ||
    !Array.isArray(corpus.fixtures) ||
    !Array.isArray(corpus.layer4_atoms) ||
    !Array.isArray(corpus.layer4_cases)
  ) {
    throw new Error("synthetic quality corpus has an invalid top-level shape");
  }

  const fixtures = corpus.fixtures.map((fixture, index) =>
    corpusRecord(fixture, `synthetic fixture ${index}`),
  );
  uniqueNonEmptyStrings(fixtures.map((fixture) => fixture.id), "synthetic fixture ids");
  for (const fixture of fixtures) {
    exactKeys(fixture, ["blocks", "expected_signals", "id", "owner_email", "title"], "synthetic fixture");
    if (!nonEmpty(fixture.title) || !nonEmpty(fixture.owner_email)) {
      throw new Error("synthetic fixture is invalid");
    }
    if (!Array.isArray(fixture.blocks) || fixture.blocks.length === 0) {
      throw new Error("synthetic fixture blocks must be a non-empty array");
    }
    const blocks = fixture.blocks.map((block, index) =>
      corpusRecord(block, `synthetic fixture block ${index}`),
    );
    uniqueNonEmptyStrings(blocks.map((block) => block.id), "synthetic fixture block ids");
    for (const block of blocks) {
      exactKeys(block, ["id", "kind", "text"], "synthetic fixture block");
      if (!nonEmpty(block.text) || (block.kind !== "note" && block.kind !== "transcript")) {
        throw new Error("synthetic fixture block is invalid");
      }
    }
    if (!Array.isArray(fixture.expected_signals)) {
      throw new Error("synthetic fixture expected signals must be an array");
    }
    for (const signal of fixture.expected_signals) {
      const expected = corpusRecord(signal, "synthetic fixture expected signal");
      exactKeys(expected, ["kind", "subject", "text"], "synthetic fixture expected signal");
      if (
        !nonEmpty(expected.text) ||
        (expected.subject !== null && !nonEmpty(expected.subject)) ||
        (expected.kind !== "decision" && expected.kind !== "action" && expected.kind !== "rationale")
      ) {
        throw new Error("synthetic fixture expected signal is invalid");
      }
    }
  }

  const atoms = corpus.layer4_atoms.map((atom, index) =>
    corpusRecord(atom, `synthetic answer-composition atom ${index}`),
  );
  uniqueNonEmptyStrings(
    atoms.map((atom) => atom.id),
    "synthetic answer-composition atom ids",
  );
  const atomById = new Map(atoms.map((atom) => [atom.id as string, atom]));
  for (const atom of atoms) {
    exactKeys(
      atom,
      ["id", "policy_id", "readable_by_principal_ids", "search_terms", "text"],
      "synthetic answer-composition atom",
    );
    if (
      !nonEmpty(atom.text) ||
      (atom.policy_id !== "organization-member-readable-person-v2" &&
        atom.policy_id !== "restricted-reviewer-person-v2")
    ) {
      throw new Error("synthetic answer-composition atom is invalid");
    }
    uniqueNonEmptyStrings(atom.readable_by_principal_ids, "synthetic answer-composition atom readable principal ids");
    uniqueNonEmptyStrings(atom.search_terms, "synthetic answer-composition atom search terms");
  }

  const cases = corpus.layer4_cases.map((qualityCase, index) =>
    corpusRecord(qualityCase, `synthetic answer-composition case ${index}`),
  );
  uniqueNonEmptyStrings(cases.map((qualityCase) => qualityCase.id), "synthetic answer-composition case ids");
  for (const qualityCase of cases) {
    exactKeys(
      qualityCase,
      ["expected_status", "id", "principal_id", "question", "required_answer_substrings", "required_citation_atom_ids"],
      "synthetic answer-composition case",
    );
    if (
      !nonEmpty(qualityCase.principal_id) ||
      !nonEmpty(qualityCase.question) ||
      (qualityCase.expected_status !== "answered" &&
        qualityCase.expected_status !== "insufficient_evidence")
    ) {
      throw new Error("synthetic answer-composition case is invalid");
    }
    const citationIds = uniqueNonEmptyStrings(
      qualityCase.required_citation_atom_ids,
      "synthetic answer-composition required citation atom ids",
      true,
    );
    uniqueNonEmptyStrings(
      qualityCase.required_answer_substrings,
      "synthetic answer-composition required answer substrings",
    );
    if (
      qualityCase.expected_status === "answered" && citationIds.length === 0 ||
      qualityCase.expected_status === "insufficient_evidence" && citationIds.length !== 0
    ) {
      throw new Error("synthetic answer-composition case has invalid withheld citation expectations");
    }
    for (const citationId of citationIds) {
      const atom = atomById.get(citationId);
      if (atom === undefined) {
        throw new Error(`synthetic answer-composition citation atom id does not resolve exactly once: ${citationId}`);
      }
      const readableByPrincipalIds = uniqueNonEmptyStrings(
        atom.readable_by_principal_ids,
        "synthetic answer-composition atom readable principal ids",
      );
      if (!readableByPrincipalIds.includes(qualityCase.principal_id as string)) {
        throw new Error(`synthetic answer-composition case requires a withheld citation atom: ${citationId}`);
      }
    }
  }
}

export const syntheticMeetingQualityCorpusV1: SyntheticMeetingQualityCorpusV1 =
  Object.freeze({
    schema_version: 1,
    kind: "echo-synthetic-meeting-quality-corpus-v1",
    fixtures: Object.freeze<SyntheticMeetingFixtureV1[]>([
      {
        id: "synthetic-owner-approval-v1",
        title: "Synthetic approval workflow review",
        owner_email: "owner@example.test",
        blocks: [
          {
            id: "note-decision",
            kind: "note",
            text: "Decision: send each approval card as a private message to the meeting owner.",
          },
          {
            id: "note-action",
            kind: "note",
            text: "Action: Avery will test the owner-only default by 2026-09-01.",
          },
          {
            id: "note-rationale",
            kind: "note",
            text: "Rationale: private review keeps unapproved meeting context out of team channels.",
          },
        ],
        expected_signals: [
          {
            kind: "decision",
            text: "send each approval card as a private message to the meeting owner",
            subject: "approval-card-delivery",
          },
          {
            kind: "action",
            text: "test the owner-only default",
            subject: "owner-only-default",
          },
          {
            kind: "rationale",
            text: "private review keeps unapproved meeting context out of team channels",
            subject: "approval-card-delivery",
          },
        ],
      },
      {
        id: "synthetic-proposal-only-v1",
        title: "Synthetic proposal discussion",
        owner_email: "owner@example.test",
        blocks: [
          {
            id: "transcript-proposal",
            kind: "transcript",
            text: "We could make approval cards visible to the team, but no decision was made.",
          },
        ],
        expected_signals: [],
      },
    ]),
    layer4_atoms: Object.freeze<SyntheticAnswerCompositionAtomV1[]>([
      {
        id: "owner-only-approval-default",
        text: "Approval cards default to Only me until the meeting owner chooses a wider policy.",
        policy_id: "restricted-reviewer-person-v2",
        readable_by_principal_ids: ["owner"],
        search_terms: ["approval", "default", "phrase", "visibility"],
      },
      {
        id: "team-approved-records",
        text: "Records approved with the Team policy are readable by organization members.",
        policy_id: "organization-member-readable-person-v2",
        readable_by_principal_ids: ["owner", "member"],
        search_terms: ["team", "policy", "records", "members", "read"],
      },
    ]),
    layer4_cases: Object.freeze<SyntheticAnswerCompositionCaseV1[]>([
      {
        id: "owner-can-answer-default",
        principal_id: "owner",
        question: "What exact approval default phrase is stated?",
        expected_status: "answered",
        required_citation_atom_ids: ["owner-only-approval-default"],
        required_answer_substrings: ["only me"],
      },
      {
        id: "member-cannot-answer-owner-default",
        principal_id: "member",
        question: "What exact approval default phrase is stated?",
        expected_status: "insufficient_evidence",
        required_citation_atom_ids: [],
        required_answer_substrings: ["insufficient accessible evidence"],
      },
      {
        id: "member-can-answer-team-policy",
        principal_id: "member",
        question: "Under the Team policy, who can read records?",
        expected_status: "answered",
        required_citation_atom_ids: ["team-approved-records"],
        required_answer_substrings: ["organization members"],
      },
    ]),
  } as const);

const SYNTHETIC_CURSOR_PREFIX = "synthetic-source:fixture:v1:";

function cursorOffset(
  cursor: string | undefined,
  expected_prefix: string,
  adapter_label: string,
): number {
  if (cursor === undefined) return 0;
  if (!cursor.startsWith(expected_prefix)) {
    throw new Error(`${adapter_label} cursor has an unsupported format`);
  }
  const offset = Number(cursor.slice(expected_prefix.length));
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error(`${adapter_label} cursor has an invalid offset`);
  }
  return offset;
}

function fixtureDocument(
  fixture: SyntheticMeetingFixtureV1,
  source: MeetingSourceAdapter["identity"],
): MeetingDocument {
  const ownerParticipantId = "owner";
  return {
    schema_version: 1,
    id: fixture.id,
    title: fixture.title,
    lifecycle: "completed",
    capture: {
      state: "complete",
      components: [
        { kind: "metadata", state: "available" },
        { kind: "notes", state: "available" },
        { kind: "transcript", state: "available" },
      ],
    },
    participants: [
      {
        id: ownerParticipantId,
        display_name: "Synthetic meeting owner",
        identities: [{ kind: "email", value: fixture.owner_email }],
        roles: ["organizer"],
      },
    ],
    content: fixture.blocks.map((block, sequence) => ({
      id: block.id,
      kind: block.kind,
      text: block.text,
      sequence,
      origin: "human",
    })),
    artifacts: [],
    context: {
      owner_participant_id: ownerParticipantId,
      calendar: { organizer_participant_id: ownerParticipantId },
      labels: ["synthetic-quality-evaluation"],
    },
    provenance: {
      source,
      external_id: fixture.id,
      canonical_revision: "fixture-revision-1",
      observed_at: "2026-08-29T00:00:00.000Z",
      normalizer_version: "synthetic-fixture-normalizer-v1",
      metadata: { fixture: true, fixture_version: 1 },
    },
  };
}

/**
 * Converts the compact built-in fixtures into the same canonical meeting
 * documents accepted by every meeting-source adapter.
 */
export function syntheticMeetingQualityDocumentsV1(
  fixtures: readonly SyntheticMeetingFixtureV1[] =
    syntheticMeetingQualityCorpusV1.fixtures,
): readonly MeetingDocument[] {
  return Object.freeze(
    fixtures.map((fixture) =>
      fixtureDocument(fixture, syntheticMeetingSourceIdentityV1),
    ),
  );
}

/**
 * Loads the existing Phase 1 synthetic replay corpus without changing its
 * payloads. This is intentionally a local file input: evaluators never call a
 * meeting provider and never write a state store.
 */
export async function loadSyntheticReplayMeetingsV1(
  corpus_path: string,
): Promise<readonly MeetingDocument[]> {
  const value: unknown = JSON.parse(await readFile(corpus_path, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("synthetic replay corpus must be an object");
  }
  const batches = (value as { readonly batches?: unknown }).batches;
  if (!Array.isArray(batches) || batches.length === 0) {
    throw new Error("synthetic replay corpus has no batches");
  }
  const meetings: MeetingDocument[] = [];
  for (const entry of batches) {
    const batch =
      typeof entry === "object" && entry !== null && !Array.isArray(entry)
        ? (entry as { readonly batch?: unknown }).batch
        : undefined;
    const candidateMeetings =
      typeof batch === "object" && batch !== null && !Array.isArray(batch)
        ? (batch as { readonly meetings?: unknown }).meetings
        : undefined;
    if (!Array.isArray(candidateMeetings) || candidateMeetings.length !== 1) {
      throw new Error("synthetic replay corpus batch must contain one meeting");
    }
    const meeting = candidateMeetings[0];
    if (
      typeof meeting !== "object" ||
      meeting === null ||
      Array.isArray(meeting) ||
      typeof (meeting as { readonly id?: unknown }).id !== "string"
    ) {
      throw new Error("synthetic replay corpus meeting is invalid");
    }
    assertCanonicalMeetingDocument(meeting, syntheticMeetingSourceIdentityV1);
    meetings.push(meeting);
  }
  return Object.freeze(meetings);
}

/** Opaque in-memory source for built-in or file-backed synthetic meetings. */
export class SyntheticMeetingSourceAdapterV1 implements MeetingSourceAdapter {
  readonly identity = syntheticMeetingSourceIdentityV1;

  constructor(private readonly meetings: readonly MeetingDocument[]) {}

  validateConfig(config: AdapterConfig): AdapterConfigValidation {
    return config.adapter_id === this.identity.adapter_id
      ? { ok: true, errors: [] }
      : { ok: false, errors: ["adapter_id must identify the synthetic source"] };
  }

  async healthCheck(_context?: AdapterOperationContext): Promise<AdapterHealth> {
    return {
      status: "healthy",
      checked_at: "2026-08-29T00:00:00.000Z",
      message: "local synthetic meeting corpus",
    };
  }

  async pull(request: MeetingPullRequest): Promise<MeetingBatch> {
    const offset = cursorOffset(
      request.cursor,
      SYNTHETIC_CURSOR_PREFIX,
      "synthetic source",
    );
    if (offset > this.meetings.length) {
      throw new Error("synthetic source cursor is beyond the corpus");
    }
    const limit = request.limit ?? this.meetings.length;
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error("synthetic source pull limit must be a positive integer");
    }
    const end = Math.min(this.meetings.length, offset + limit);
    return {
      meetings: this.meetings.slice(offset, end),
      ...(end === this.meetings.length
        ? {}
        : { next_cursor: `${SYNTHETIC_CURSOR_PREFIX}${end}` }),
    };
  }
}
