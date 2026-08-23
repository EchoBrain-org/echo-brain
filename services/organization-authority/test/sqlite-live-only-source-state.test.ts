import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { applyAuthorityBaselineV1 } from "../src/adapters/persistence/sqlite/baseline.js";
import { CLEAN_LLM_PROCESSOR_RUNTIME_VERSION_V1 } from "../src/composition/clean-granola-source-admission.js";
import type {
  DecisionSet,
  MeetingDocument,
} from "../src/processing/core/index.js";
import { createGranolaLiveOnlyCursor } from "../src/processing/adapters/meeting-sources/granola/index.js";
import {
  CleanLiveOnlySourceRevokedError,
  SqliteCleanLiveOnlySourceStateV1,
} from "../src/processing/clean-v1/sqlite-live-only-source-state.js";

const ADMITTED_AT = "2026-08-22T02:03:04.005Z";
const ADVANCED_AT = "2026-08-22T02:04:04.005Z";
const NEXT_CUTOFF = "2026-08-22T02:05:04.005Z";
const SHA = `sha256:${"a".repeat(64)}`;
const sourceCursor = createGranolaLiveOnlyCursor(ADMITTED_AT);
const nextCursor = createGranolaLiveOnlyCursor(NEXT_CUTOFF);
const databases: Database.Database[] = [];

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
  content: [],
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
  signals: [],
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
    });
    expect(candidate).toMatchObject({
      candidate_id: expect.stringMatching(/^cnd_/),
      approval_id: expect.stringMatching(/^apr_/),
      stage_command_id: expect.stringMatching(/^pas_/),
      state: "queued",
    });
    await expect(
      state.stageCandidate({ admission: current, meeting, decisions }),
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
    });

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
    });
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
});
