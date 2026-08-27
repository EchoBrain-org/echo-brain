import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { applyAuthorityBaselineV1 } from "../src/adapters/persistence/sqlite/baseline.js";
import { CLEAN_LLM_PROCESSOR_RUNTIME_VERSION_V1 } from "../src/composition/clean-granola-source-admission.js";
import type {
  DecisionSet,
  MeetingDocument,
} from "../src/processing/core/index.js";
import { createGranolaLiveOnlyCursor } from "../src/processing/adapters/meeting-sources/granola/index.js";
import { selectGranolaPersonContentPolicyV1 } from "../src/processing/clean-v1/granola-person-content-policy.js";
import type {
  CleanActionableLiveCandidateV1,
  CleanLiveCandidateV1,
} from "../src/processing/clean-v1/live-only-source-cycle.js";
import {
  CleanLiveOnlySourceRevokedError,
  SqliteCleanLiveOnlySourceStateV1,
} from "../src/processing/clean-v1/sqlite-live-only-source-state.js";

const ADMITTED_AT = "2026-08-22T02:03:04.005Z";
const ADVANCED_AT = "2026-08-22T02:04:04.005Z";
const NEXT_CUTOFF = "2026-08-22T02:05:04.005Z";
const SHA = `sha256:${"a".repeat(64)}`;
const REVIEW_POLICY = selectGranolaPersonContentPolicyV1(undefined);
const RESTRICTED_REVIEW_POLICY = selectGranolaPersonContentPolicyV1({
  granola: {
    folder_membership: [{ id: "folder-r", name: "echo-restricted" }],
  },
});
const sourceCursor = createGranolaLiveOnlyCursor(ADMITTED_AT);
const nextCursor = createGranolaLiveOnlyCursor(NEXT_CUTOFF);
const databases: Database.Database[] = [];

function assertActionable(
  candidate: CleanLiveCandidateV1,
): asserts candidate is CleanActionableLiveCandidateV1 {
  if (candidate.disposition !== "actionable") {
    throw new Error("test expected an actionable candidate");
  }
}

const meeting: MeetingDocument = {
  schema_version: 1,
  id: "meeting-1",
  provenance: {
    source: {
      kind: "meeting-source",
      adapter_id: "granola",
      instance_id: "founder-granola",
      version: "2.2.0",
    },
    external_id: "note-1",
    canonical_revision: "sha256:note-1",
    observed_at: ADVANCED_AT,
    normalizer_version: "2.2.0",
  },
  capture: { state: "complete", components: [] },
  participants: [],
  content: [
    { id: "block-1", kind: "note", text: "Ship the cohort onboarding." },
  ],
  artifacts: [],
};

const decisions: DecisionSet = {
  schema_version: 1,
  meeting_id: meeting.id,
  meeting_revision: meeting.provenance.canonical_revision,
  processor: {
    kind: "decision-processor",
    adapter_id: "llm",
    instance_id: "founder-llm",
    version: CLEAN_LLM_PROCESSOR_RUNTIME_VERSION_V1,
  },
  generated_at: ADVANCED_AT,
  signals: [
    {
      id: "decision-1",
      kind: "decision",
      status: "decided",
      text: "Ship the cohort onboarding.",
      subject: null,
      confidence: 1,
      evidence: [{ meeting_id: "meeting-1", block_id: "block-1" }],
    },
  ],
};

function database(): Database.Database {
  const value = new Database(":memory:");
  applyAuthorityBaselineV1(value);
  value
    .prepare(
      `INSERT INTO authority_metadata
       VALUES (1, 'oau_test', 'org_test', 'Test', '{}', ?, ?)`,
    )
    .run(ADMITTED_AT, ADMITTED_AT);
  value
    .prepare(
      `INSERT INTO authority_principals
       VALUES ('prn_test', 'org_test', 'Founder', ?)`,
    )
    .run(ADMITTED_AT);
  value
    .prepare(
      `INSERT INTO authority_memberships (
         membership_id, organization_id, principal_id, membership_type, status,
         provisioned_at, revoked_at, revocation_reason, employee_email_sha256
       ) VALUES ('mem_test', 'org_test', 'prn_test', 'owner', 'active', ?, NULL, NULL, NULL)`,
    )
    .run(ADMITTED_AT);
  value
    .prepare(
      `INSERT INTO authority_clean_granola_source_admission_v1 (
         singleton, organization_id, principal_id, membership_id,
         membership_type, source_instance_id, source_adapter_version,
         normalizer_version, owner_email_sha256,
         owner_observation_assurance, owner_observed_at,
         source_credential_reference_sha256, cursor, cutoff_at,
         processor_instance_id, processor_adapter_version,
         processor_configuration_sha256,
         processor_credential_reference_sha256, semantic_input_sha256,
         admitted_at
       ) VALUES (1, 'org_test', 'prn_test', 'mem_test', 'owner',
                 'founder-granola', '2.2.0', '2.2.0', ?,
                 'provider_record_owner_observed', ?, ?, ?, ?,
                 'founder-llm', ?, ?, ?, ?, ?)`,
    )
    .run(
      SHA,
      ADMITTED_AT,
      SHA,
      sourceCursor,
      ADMITTED_AT,
      CLEAN_LLM_PROCESSOR_RUNTIME_VERSION_V1,
      SHA,
      SHA,
      SHA,
      ADMITTED_AT,
    );
  databases.push(value);
  return value;
}

afterEach(() => {
  for (const value of databases.splice(0)) value.close();
});

describe("SQLite clean live-only source state", () => {
  it("materializes one progress row from the immutable admission and advances it by CAS", async () => {
    const value = database();
    const state = new SqliteCleanLiveOnlySourceStateV1(
      value,
      () => ADVANCED_AT,
    );

    await expect(state.readAdmission()).resolves.toMatchObject({
      source: { cursor: sourceCursor, cutoff_at: ADMITTED_AT },
      processor: {
        instance_id: "founder-llm",
        version: CLEAN_LLM_PROCESSOR_RUNTIME_VERSION_V1,
      },
    });
    expect(
      value
        .prepare(
          `SELECT admission_semantic_input_sha256, cursor, cursor_version, updated_at
             FROM authority_clean_granola_source_progress_v1`,
        )
        .get(),
    ).toEqual({
      admission_semantic_input_sha256: SHA,
      cursor: sourceCursor,
      cursor_version: 0,
      updated_at: ADMITTED_AT,
    });

    await expect(
      state.advanceCursor({
        expected_cursor: sourceCursor,
        next_cursor: nextCursor,
      }),
    ).resolves.toBe("advanced");
    await expect(
      state.advanceCursor({
        expected_cursor: sourceCursor,
        next_cursor: nextCursor,
      }),
    ).resolves.toBe("state_drift");
    expect(
      value
        .prepare(
          `SELECT cursor, cursor_version, updated_at
             FROM authority_clean_granola_source_progress_v1`,
        )
        .get(),
    ).toEqual({
      cursor: nextCursor,
      cursor_version: 1,
      updated_at: ADVANCED_AT,
    });
  });

  it("will not initialize or advance a source after its owner is revoked", async () => {
    const value = database();
    const state = new SqliteCleanLiveOnlySourceStateV1(
      value,
      () => ADVANCED_AT,
    );
    await state.readAdmission();
    value
      .prepare(
        `UPDATE authority_memberships
            SET status = 'revoked', revoked_at = ?, revocation_reason = 'founder-reset'
          WHERE membership_id = 'mem_test'`,
      )
      .run(ADVANCED_AT);

    await expect(
      state.advanceCursor({
        expected_cursor: sourceCursor,
        next_cursor: nextCursor,
      }),
    ).resolves.toBe("revoked");
    await expect(state.readAdmission()).rejects.toBeInstanceOf(
      CleanLiveOnlySourceRevokedError,
    );
  });

  it("keeps the progress row narrowly mutable", async () => {
    const value = database();
    const state = new SqliteCleanLiveOnlySourceStateV1(
      value,
      () => ADVANCED_AT,
    );
    await state.readAdmission();
    expect(() =>
      value
        .prepare(
          `UPDATE authority_clean_granola_source_progress_v1
              SET admission_semantic_input_sha256 = ?`,
        )
        .run(`sha256:${"b".repeat(64)}`),
    ).toThrow("only permits ordered cursor advances");
    expect(() =>
      value
        .prepare(`DELETE FROM authority_clean_granola_source_progress_v1`)
        .run(),
    ).toThrow("progress deletion is denied");
  });

  it("freezes one candidate before the post-once Slack/D2 handoff", async () => {
    const value = database();
    const state = new SqliteCleanLiveOnlySourceStateV1(
      value,
      () => ADVANCED_AT,
    );
    const current = await state.readAdmission();
    const candidate = await state.stageCandidate({
      admission: current,
      meeting,
      decisions,
      review_policy: REVIEW_POLICY,
    });
    assertActionable(candidate);
    expect(candidate).toMatchObject({
      candidate_id: expect.stringMatching(/^cnd_/),
      approval_id: expect.stringMatching(/^apr_/),
      stage_command_id: expect.stringMatching(/^pas_/),
      state: "queued",
      review_policy_id: REVIEW_POLICY.policy_id,
      review_policy_contract_sha256:
        REVIEW_POLICY.policy_contract_sha256,
      review_policy_consequence_text:
        REVIEW_POLICY.policy_consequence_text,
      review_policy_consequence_sha256:
        REVIEW_POLICY.policy_consequence_sha256,
    });
    await expect(
      state.stageCandidate({ admission: current, meeting, decisions, review_policy: REVIEW_POLICY }),
    ).resolves.toEqual(candidate);
    const posted = state.recordPostedApprovalCard({
      candidate_id: candidate.candidate_id,
      provider_message_ts: "1724292304.005000",
      frozen_card_sha256: `sha256:${"c".repeat(64)}`,
      approved_snapshot: {
        kind: "approved",
        candidate_id: candidate.candidate_id,
      },
    });
    expect(posted.state).toBe("posted");
    const staged = state.markControlPlaneStaged({
      candidate_id: candidate.candidate_id,
      control_approval_sha256: `sha256:${"e".repeat(64)}`,
    });
    expect(staged).toMatchObject({
      state: "staged",
      approval_id: candidate.approval_id,
    });
    expect(state.readCandidateByApprovalId(candidate.approval_id)).toEqual(
      staged,
    );
    expect(state.listStagedApprovalIds()).toEqual([candidate.approval_id]);
    expect(
      state.readFrozenCandidateForApproval(candidate.approval_id),
    ).toMatchObject({
      candidate_id: candidate.candidate_id,
      meeting,
      decisions,
      approved_snapshot: {
        kind: "approved",
        candidate_id: candidate.candidate_id,
      },
    });
    expect(
      state.recordV4Receipt({
        approval_id: candidate.approval_id,
        control_approval_sha256: `sha256:${"e".repeat(64)}`,
        receipt: { kind: "v4-receipt", position: 1 },
      }),
    ).toMatchObject({ approval_id: candidate.approval_id });
    expect(state.listStagedApprovalIds()).toEqual([]);
  });

  it("rejects display text that differs from the canonical D2 policy commitment", async () => {
    const value = database();
    const state = new SqliteCleanLiveOnlySourceStateV1(value, () => ADVANCED_AT);
    const current = await state.readAdmission();

    await expect(
      state.stageCandidate({
        admission: current,
        meeting,
        decisions,
        review_policy: {
          ...REVIEW_POLICY,
          policy_consequence_text:
            RESTRICTED_REVIEW_POLICY.policy_consequence_text,
        },
      }),
    ).rejects.toThrow(
      "clean Granola review policy must match its canonical content policy",
    );
  });

  it("deduplicates retries by admitted configuration and source revision while preserving the first audit snapshot", async () => {
    const value = database();
    const state = new SqliteCleanLiveOnlySourceStateV1(
      value,
      () => ADVANCED_AT,
    );
    const initialAdmission = await state.readAdmission();
    const original = await state.stageCandidate({
      admission: initialAdmission,
      meeting,
      decisions,
      review_policy: REVIEW_POLICY,
    });
    assertActionable(original);

    await state.advanceCursor({
      expected_cursor: sourceCursor,
      next_cursor: nextCursor,
    });
    const advancedAdmission = await state.readAdmission();
    await expect(
      state.readFrozenCandidateForSourceRevision({
        external_id: meeting.provenance.external_id,
        canonical_revision: meeting.provenance.canonical_revision,
      }),
    ).resolves.toMatchObject({
      admission: { source: { cursor: sourceCursor } },
      meeting,
      decisions,
    });
    await expect(
      state.readFrozenCandidateForSourceRevision({
        external_id: meeting.provenance.external_id,
        canonical_revision: "sha256:note-2",
      }),
    ).resolves.toBeUndefined();
    const retriedMeeting: MeetingDocument = {
      ...meeting,
      provenance: {
        ...meeting.provenance,
        observed_at: NEXT_CUTOFF,
      },
      content: [
        {
          id: "block-1",
          kind: "note",
          text: "A later provider observation of the same revision.",
        },
      ],
    };
    const retriedDecisions: DecisionSet = {
      ...decisions,
      generated_at: NEXT_CUTOFF,
      signals: [
        {
          id: "decision-1",
          kind: "decision",
          status: "decided",
          text: "A later LLM observation of the same revision.",
          subject: null,
          confidence: 1,
          evidence: [{ meeting_id: meeting.id, block_id: "block-1" }],
        },
      ],
    };

    await expect(
      state.stageCandidate({
        admission: advancedAdmission,
        meeting: retriedMeeting,
        decisions: retriedDecisions,
        review_policy: REVIEW_POLICY,
      }),
    ).resolves.toEqual(original);
    expect(
      value
        .prepare(
          `SELECT COUNT(*) AS count FROM authority_clean_live_candidates_v1`,
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(
      value
        .prepare(
          `SELECT COUNT(*) AS count FROM authority_clean_live_approval_outbox_v1`,
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(state.readFrozenCandidateForApproval(original.approval_id)).toMatchObject({
      admission: { source: { cursor: sourceCursor } },
      meeting,
      decisions,
    });

    const revisedMeeting: MeetingDocument = {
      ...retriedMeeting,
      provenance: {
        ...retriedMeeting.provenance,
        canonical_revision: "sha256:note-2",
      },
    };
    const revisedDecisions: DecisionSet = {
      ...retriedDecisions,
      meeting_revision: revisedMeeting.provenance.canonical_revision,
    };
    const revised = await state.stageCandidate({
      admission: advancedAdmission,
      meeting: revisedMeeting,
      decisions: revisedDecisions,
      review_policy: REVIEW_POLICY,
    });
    assertActionable(revised);
    expect(revised).not.toEqual(original);
    expect(
      value
        .prepare(
          `SELECT COUNT(*) AS count FROM authority_clean_live_candidates_v1`,
        )
        .get(),
    ).toEqual({ count: 2 });
    expect(
      value
        .prepare(
          `SELECT COUNT(*) AS count FROM authority_clean_live_approval_outbox_v1`,
        )
        .get(),
    ).toEqual({ count: 2 });
  });

  it("records a folder-only provider revision without creating another review round", async () => {
    const value = database();
    const state = new SqliteCleanLiveOnlySourceStateV1(value, () => ADVANCED_AT);
    const current = await state.readAdmission();
    const first = await state.stageCandidate({ admission: current, meeting, decisions, review_policy: REVIEW_POLICY });
    assertActionable(first);
    const folderOnly: MeetingDocument = {
      ...meeting,
      provenance: { ...meeting.provenance, canonical_revision: "sha256:note-folder" },
      extensions: { granola: { folder_membership: [{ id: "folder-1", name: "notes" }] } },
    };
    const duplicate = await state.stageCandidate({
      admission: current,
      meeting: folderOnly,
      decisions: { ...decisions, meeting_revision: folderOnly.provenance.canonical_revision },
      review_policy: REVIEW_POLICY,
    });
    const posted = state.recordPostedApprovalCard({
      candidate_id: first.candidate_id,
      provider_message_ts: "1724292304.005000",
      frozen_card_sha256: `sha256:${"c".repeat(64)}`,
      approved_snapshot: { kind: "approved", candidate_id: first.candidate_id },
    });
    const staged = state.markControlPlaneStaged({
      candidate_id: posted.candidate_id,
      control_approval_sha256: `sha256:${"e".repeat(64)}`,
    });
    expect(duplicate).toMatchObject({
      disposition: "coalesced",
      state: "coalesced",
      review_lineage_id: first.review_lineage_id,
      review_round: first.review_round,
    });
    expect(state.approvalIsCurrent(staged.approval_id)).toBe(true);
    expect(state.listStagedApprovalIds()).toEqual([staged.approval_id]);
  });

  it("coalesces a meeting-time-only revision into the existing review round", async () => {
    const value = database();
    const state = new SqliteCleanLiveOnlySourceStateV1(value, () => ADVANCED_AT);
    const current = await state.readAdmission();
    const first = await state.stageCandidate({
      admission: current,
      meeting,
      decisions,
      review_policy: REVIEW_POLICY,
    });
    assertActionable(first);
    const timeOnly: MeetingDocument = {
      ...meeting,
      provenance: {
        ...meeting.provenance,
        canonical_revision: "sha256:note-time-only",
      },
      time: { actual_start_at: "2026-08-22T01:04:04.005Z" },
    };

    const duplicate = await state.stageCandidate({
      admission: current,
      meeting: timeOnly,
      decisions: {
        ...decisions,
        meeting_revision: timeOnly.provenance.canonical_revision,
      },
      review_policy: REVIEW_POLICY,
    });

    expect(duplicate).toMatchObject({
      disposition: "coalesced",
      state: "coalesced",
      review_lineage_id: first.review_lineage_id,
      review_round: first.review_round,
    });
    expect(
      value
        .prepare(
          `SELECT COUNT(*) AS count FROM authority_clean_live_approval_outbox_v1`,
        )
        .get(),
    ).toEqual({ count: 1 });
  });

  it("opens a new immutable review round for a semantic or policy-boundary change", async () => {
    const value = database();
    const state = new SqliteCleanLiveOnlySourceStateV1(value, () => ADVANCED_AT);
    const current = await state.readAdmission();
    const first = await state.stageCandidate({ admission: current, meeting, decisions, review_policy: REVIEW_POLICY });
    assertActionable(first);
    const edited: MeetingDocument = {
      ...meeting,
      provenance: { ...meeting.provenance, canonical_revision: "sha256:note-edit" },
    };
    const second = await state.stageCandidate({
      admission: current,
      meeting: edited,
      decisions: {
        ...decisions,
        meeting_revision: edited.provenance.canonical_revision,
        signals: [{
          id: "decision-edit", kind: "decision", status: "decided", text: "Changed decision.",
          subject: null, confidence: 1,
          evidence: [{ meeting_id: "meeting-1", block_id: "block-1" }],
        }],
      },
      review_policy: REVIEW_POLICY,
    });
    assertActionable(second);
    const restricted: MeetingDocument = {
      ...edited,
      provenance: { ...edited.provenance, canonical_revision: "sha256:note-policy" },
      extensions: { granola: { folder_membership: [{ id: "folder-r", name: "echo-restricted" }] } },
    };
    const third = await state.stageCandidate({
      admission: current,
      meeting: restricted,
      decisions: {
        ...decisions,
        meeting_revision: restricted.provenance.canonical_revision,
      },
      review_policy: RESTRICTED_REVIEW_POLICY,
    });
    assertActionable(third);
    expect(second).toMatchObject({
      state: "queued", review_lineage_id: first.review_lineage_id, review_round: 2,
    });
    expect(third).toMatchObject({
      state: "queued", review_lineage_id: first.review_lineage_id, review_round: 3,
    });
    expect(
      state.readFrozenCandidateForApproval(first.approval_id)?.meeting,
    ).toEqual(meeting);
  });

  it("records no-signals revisions, supersedes unresolved work, and reproves the exact revision", async () => {
    const value = database();
    const state = new SqliteCleanLiveOnlySourceStateV1(value, () => ADVANCED_AT);
    const current = await state.readAdmission();
    const first = await state.stageCandidate({
      admission: current,
      meeting,
      decisions,
      review_policy: REVIEW_POLICY,
    });
    assertActionable(first);
    const noSignalsMeeting: MeetingDocument = {
      ...meeting,
      provenance: {
        ...meeting.provenance,
        canonical_revision: "sha256:note-no-signals",
      },
    };
    const noSignals = await state.stageCandidate({
      admission: current,
      meeting: noSignalsMeeting,
      decisions: {
        ...decisions,
        meeting_revision: noSignalsMeeting.provenance.canonical_revision,
        signals: [],
      },
      review_policy: REVIEW_POLICY,
    });
    expect(noSignals).toMatchObject({
      disposition: "no_signals",
      state: "no_signals",
      review_round: first.review_round + 1,
      superseded_approval_id: first.approval_id,
    });
    expect(state.approvalIsCurrent(first.approval_id)).toBe(false);
    expect(state.readSupersededApprovalCard(first.approval_id)).toMatchObject({
      superseded_by_candidate_id: noSignals.candidate_id,
    });
    await expect(
      state.readFrozenCandidateForSourceRevision({
        external_id: noSignalsMeeting.provenance.external_id,
        canonical_revision: noSignalsMeeting.provenance.canonical_revision,
      }),
    ).resolves.toMatchObject({
      candidate_id: noSignals.candidate_id,
      disposition: "no_signals",
      decisions: { signals: [] },
    });
  });

  it("retains a Slack post that returns after its queued candidate was superseded", async () => {
    const value = database();
    const state = new SqliteCleanLiveOnlySourceStateV1(value, () => ADVANCED_AT);
    const current = await state.readAdmission();
    const first = await state.stageCandidate({
      admission: current,
      meeting,
      decisions,
      review_policy: REVIEW_POLICY,
    });
    assertActionable(first);
    const revisedMeeting: MeetingDocument = {
      ...meeting,
      provenance: {
        ...meeting.provenance,
        canonical_revision: "sha256:note-during-post",
      },
    };
    await state.stageCandidate({
      admission: current,
      meeting: revisedMeeting,
      decisions: {
        ...decisions,
        meeting_revision: revisedMeeting.provenance.canonical_revision,
        signals: [
          {
            ...decisions.signals[0]!,
            id: "decision-during-post",
            text: "A revision arrived while Slack was posting.",
          },
        ],
      },
      review_policy: REVIEW_POLICY,
    });
    const latePost = {
      candidate_id: first.candidate_id,
      provider_message_ts: "1724292304.005000",
      frozen_card_sha256: `sha256:${"c".repeat(64)}`,
      approved_snapshot: { kind: "approved", candidate_id: first.candidate_id },
    };

    expect(state.recordPostedApprovalCard(latePost)).toMatchObject({
      state: "superseded",
      provider_message_ts: latePost.provider_message_ts,
    });
    expect(state.recordPostedApprovalCard(latePost)).toMatchObject({
      state: "superseded",
      provider_message_ts: latePost.provider_message_ts,
    });
    expect(state.readSupersededApprovalCard(first.approval_id)).toMatchObject({
      provider_message_ts: latePost.provider_message_ts,
    });
    expect(state.readCandidateByApprovalId(first.approval_id)).toMatchObject({
      approved_snapshot_json: expect.any(String),
      approved_snapshot_sha256: expect.stringMatching(/^sha256:/),
    });
    expect(() =>
      state.recordPostedApprovalCard({
        ...latePost,
        provider_message_ts: "1724292304.006000",
      }),
    ).toThrow("conflicts with its durable outbox");
  });

  it("preserves a resolved approval while opening independent work for a semantic revision", async () => {
    const value = database();
    const state = new SqliteCleanLiveOnlySourceStateV1(value, () => ADVANCED_AT);
    const current = await state.readAdmission();
    const first = await state.stageCandidate({
      admission: current,
      meeting,
      decisions,
      review_policy: REVIEW_POLICY,
    });
    assertActionable(first);
    state.recordPostedApprovalCard({
      candidate_id: first.candidate_id,
      provider_message_ts: "1724292304.005000",
      frozen_card_sha256: `sha256:${"c".repeat(64)}`,
      approved_snapshot: { kind: "approved", candidate_id: first.candidate_id },
    });
    const staged = state.markControlPlaneStaged({
      candidate_id: first.candidate_id,
      control_approval_sha256: `sha256:${"e".repeat(64)}`,
    });
    state.recordV4Receipt({
      approval_id: first.approval_id,
      control_approval_sha256: staged.control_approval_sha256!,
      receipt: { kind: "v4-receipt", position: 1 },
    });
    const revisedMeeting: MeetingDocument = {
      ...meeting,
      provenance: { ...meeting.provenance, canonical_revision: "sha256:note-after-receipt" },
    };
    const revised = await state.stageCandidate({
      admission: current,
      meeting: revisedMeeting,
      decisions: {
        ...decisions,
        meeting_revision: revisedMeeting.provenance.canonical_revision,
        signals: [{
          id: "decision-after-receipt", kind: "decision", status: "decided",
          text: "A new decision after the first approval.", subject: null,
          confidence: 1,
          evidence: [{ meeting_id: "meeting-1", block_id: "block-1" }],
        }],
      },
      review_policy: REVIEW_POLICY,
    });
    assertActionable(revised);
    expect(revised).toMatchObject({ disposition: "actionable", review_round: 2 });
    expect(state.readCandidateByApprovalId(first.approval_id)).toMatchObject({
      state: "staged",
      superseded_by_candidate_id: null,
    });
    expect(state.approvalIsCurrent(first.approval_id)).toBe(false);
  });

  it("records and recovers D2 work that commits across supersession", async () => {
    const value = database();
    const state = new SqliteCleanLiveOnlySourceStateV1(value, () => ADVANCED_AT);
    const current = await state.readAdmission();
    const first = await state.stageCandidate({
      admission: current,
      meeting,
      decisions,
      review_policy: REVIEW_POLICY,
    });
    assertActionable(first);
    state.recordPostedApprovalCard({
      candidate_id: first.candidate_id,
      provider_message_ts: "1724292304.005000",
      frozen_card_sha256: `sha256:${"c".repeat(64)}`,
      approved_snapshot: { kind: "approved", candidate_id: first.candidate_id },
    });
    const controlApprovalSha256 = `sha256:${"e".repeat(64)}`;
    const revisedMeeting: MeetingDocument = {
      ...meeting,
      provenance: {
        ...meeting.provenance,
        canonical_revision: "sha256:note-before-receipt",
      },
    };
    await state.stageCandidate({
      admission: current,
      meeting: revisedMeeting,
      decisions: {
        ...decisions,
        meeting_revision: revisedMeeting.provenance.canonical_revision,
        signals: [
          {
            ...decisions.signals[0]!,
            id: "decision-before-receipt",
            text: "A newer decision before the first V4 receipt.",
          },
        ],
      },
      review_policy: REVIEW_POLICY,
    });
    const staged = state.markControlPlaneStaged({
      candidate_id: first.candidate_id,
      control_approval_sha256: controlApprovalSha256,
    });

    expect(staged).toMatchObject({
      state: "superseded",
      control_approval_sha256: controlApprovalSha256,
    });
    expect(state.listStagedApprovalIds()).toEqual([]);
    expect(state.listV4RecoveryApprovalIds()).toEqual([first.approval_id]);
    expect(state.readFrozenCandidateForApproval(first.approval_id)).toMatchObject({
      state: "superseded",
      candidate_id: first.candidate_id,
    });
    expect(
      state.recordV4Receipt({
        approval_id: first.approval_id,
        control_approval_sha256: staged.control_approval_sha256!,
        receipt: { kind: "v4-receipt", position: 1 },
      }),
    ).toMatchObject({ approval_id: first.approval_id });
    expect(state.listV4RecoveryApprovalIds()).toEqual([]);
  });

  it("keeps separate source meetings on independent review lineages", async () => {
    const value = database();
    const state = new SqliteCleanLiveOnlySourceStateV1(value, () => ADVANCED_AT);
    const current = await state.readAdmission();
    const first = await state.stageCandidate({
      admission: current,
      meeting,
      decisions,
      review_policy: REVIEW_POLICY,
    });
    assertActionable(first);
    const otherMeeting: MeetingDocument = {
      ...meeting,
      id: "meeting-2",
      provenance: {
        ...meeting.provenance,
        external_id: "note-2",
        canonical_revision: "sha256:note-2",
      },
    };
    const other = await state.stageCandidate({
      admission: current,
      meeting: otherMeeting,
      decisions: {
        ...decisions,
        meeting_id: otherMeeting.id,
        meeting_revision: otherMeeting.provenance.canonical_revision,
        signals: [{
          ...decisions.signals[0]!,
          evidence: [{ meeting_id: otherMeeting.id, block_id: "block-1" }],
        }],
      },
      review_policy: REVIEW_POLICY,
    });
    assertActionable(other);
    expect(other).toMatchObject({ disposition: "actionable", review_round: 1 });
    expect(other.review_lineage_id).not.toBe(first.review_lineage_id);
    expect(state.approvalIsCurrent(first.approval_id)).toBe(true);
    expect(state.approvalIsCurrent(other.approval_id)).toBe(true);
  });
});
