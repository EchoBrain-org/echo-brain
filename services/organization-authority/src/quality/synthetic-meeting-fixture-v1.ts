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

export interface SyntheticLayer4AtomV1 {
  /** Stable fixture-local handle used by quality expectations. */
  readonly id: string;
  readonly text: string;
  readonly policy_id:
    | "organization-member-readable-person-v2"
    | "restricted-reviewer-person-v2";
  /** The test harness models Layer 3's authorization result with this list. */
  readonly readable_by_principal_ids: readonly string[];
  /** Small, explicit fixture search vocabulary. It is never passed to Layer 4. */
  readonly search_terms: readonly string[];
}

export interface SyntheticLayer4CaseV1 {
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
 * provider payload shape, credential reference, or live-record identifier.
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
  readonly layer4_atoms: readonly SyntheticLayer4AtomV1[];
  readonly layer4_cases: readonly SyntheticLayer4CaseV1[];
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
    layer4_atoms: Object.freeze<SyntheticLayer4AtomV1[]>([
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
    layer4_cases: Object.freeze<SyntheticLayer4CaseV1[]>([
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
