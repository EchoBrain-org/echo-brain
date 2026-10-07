import { afterEach, describe, expect, it } from "vitest";
import type {
  ActionableMeetingProcessingCandidateV1
} from "../../src/admitted-meeting-processing/meeting-processing-cycle-v1.js";
import {
  AuthorityMeetingProcessingRevokedError,
  SqliteAuthorityMeetingProcessingStateV1,
} from "../../src/admitted-meeting-processing/sqlite-authority-meeting-processing-state-v1.js";
import type {
  DecisionSet,
  MeetingDocument,
} from "../../src/core/index.js";
import { ADMITTED_AT, ADVANCED_AT, assertActionable, database, databases, decisions, FIXTURE_PROCESSOR_VERSION, FIXTURE_SOURCE_KEY, fixtureCursorPolicy, meeting, NEXT_CUTOFF, nextCursor, REVIEW_POLICY, SHA, sourceCursor } from './fixtures/sqlite-meeting-state.js';
afterEach(() => { for (const value of databases.splice(0)) value.close(); });

function stateFixture() {
  const value = database();
  const state = new SqliteAuthorityMeetingProcessingStateV1(
    value,
    fixtureCursorPolicy,
    "llm",
    () => ADVANCED_AT,
    FIXTURE_SOURCE_KEY,
  );
  return { value, state };
}

async function actionableFixture() {
  const { value, state } = stateFixture();
  const current = await state.readAdmission();
  const candidate = await state.stageCandidate({
    admission: current,
    meeting,
    decisions,
    review_policy: REVIEW_POLICY,
  });
  assertActionable(candidate);
  return { value, state, current, candidate };
}

describe("SQLite admitted meeting-processing state", () => {
  it("keeps personal source progress and approval delivery isolated in the shared tables", async () => {
    const { value, state, candidate } = await actionableFixture();
    const columns = (value.pragma('table_info(authority_live_source_admission_v2)') as { name: string }[]).map(row => row.name).filter(name => name !== 'source_key');
    const first = value.prepare('SELECT * FROM authority_live_source_admission_v2').get() as Record<string, unknown>;
    value.prepare(`INSERT INTO authority_live_source_admission_v2 (${columns.join(',')}, source_key) VALUES (${columns.map(() => '?').join(',')}, ?)`)
      .run(...columns.map(column => column === 'semantic_input_sha256' ? `sha256:${'b'.repeat(64)}` : column === 'source_adapter_instance_id' ? 'second-person-source' : column === 'singleton' ? 2 : first[column]), 'second');
    const second = new SqliteAuthorityMeetingProcessingStateV1(value, fixtureCursorPolicy, 'llm', () => ADVANCED_AT, 'second');
    const admission = await second.readAdmission();
    expect(admission.source.instance_id).toBe('second-person-source');
    expect(second.listPendingApprovalDeliveries()).toEqual([]);
    expect(second.readFrozenCandidateForApproval(candidate.approval_id)).toBeUndefined();
    expect(await second.advanceCursor({ expected_cursor: sourceCursor, next_cursor: nextCursor })).toBe('advanced');
    expect((await state.readAdmission()).source.cursor).toBe(sourceCursor);
    expect(state.listPendingApprovalDeliveries()).toHaveLength(1);
  });
  it("fences source custody with current identity and owner membership inside the retaining transaction", async () => {
    const value = database();
    const state = new SqliteAuthorityMeetingProcessingStateV1(value, fixtureCursorPolicy, "llm", undefined, FIXTURE_SOURCE_KEY);
    await state.readAdmission();
    const identity = meeting.provenance.source;
    expect(() => state.assertCurrentSourceAdmission(identity)).toThrow("custody transaction");
    expect(() => value.transaction(() => state.assertCurrentSourceAdmission(identity))()).not.toThrow();
    expect(() => value.transaction(() => state.assertCurrentSourceAdmission({ ...identity, instance_id: "different" }))()).toThrow("current admitted source identity");
    expect(() => value.transaction(() => state.assertCurrentSourceAdmission({ ...identity, version: "future" }))()).toThrow("current admitted source identity");
    value.prepare("UPDATE authority_memberships SET status='revoked',revoked_at=?,revocation_reason='founder-reset' WHERE membership_id='mem_test'").run(ADVANCED_AT);
    expect(() => value.transaction(() => state.assertCurrentSourceAdmission(identity))()).toThrow(AuthorityMeetingProcessingRevokedError);
    expect(value.prepare("SELECT count(*) FROM authority_live_source_candidates_v2").pluck().get()).toBe(0);
  });

  it("rejects an admitted source whose persisted adapter differs from the configured boundary", async () => {
    const value = database();
    const state = new SqliteAuthorityMeetingProcessingStateV1(value, {
      source_adapter_id: "synthetic-fixture",
      assert_live_cursor: fixtureCursorPolicy.assert_live_cursor,
    }, "llm", undefined, FIXTURE_SOURCE_KEY);

    await expect(state.readAdmission()).rejects.toThrow(
      "admission adapter differs from its configured boundary",
    );
  });

  it("rejects an admitted source whose persisted processor differs from the configured processor", async () => {
    const value = database();
    const state = new SqliteAuthorityMeetingProcessingStateV1(
      value,
      fixtureCursorPolicy,
      "synthetic-processor",
      undefined,
      FIXTURE_SOURCE_KEY,
    );

    await expect(state.readAdmission()).rejects.toThrow(
      "admission processor differs from its configured processor",
    );
  });

  it("rejects foreign admission identity and malformed canonical payloads before persistence", async () => {
    const { value, state } = stateFixture();
    const current = await state.readAdmission();

    await expect(
      state.stageCandidate({
        admission: {
          ...current,
          source: { ...current.source, adapter_id: "synthetic-source" },
        },
        meeting,
        decisions,
        review_policy: REVIEW_POLICY,
      }),
    ).rejects.toThrow(
      "meeting-processing candidate differs from the current admitted source state",
    );

    const malformedMeeting = {
      ...meeting,
      content: [meeting.content[0]!, meeting.content[0]!],
    } as MeetingDocument;
    await expect(
      state.stageCandidate({
        admission: current,
        meeting: malformedMeeting,
        decisions,
        review_policy: REVIEW_POLICY,
      }),
    ).rejects.toThrow("meeting content block ids must be unique");

    expect(
      value.prepare("SELECT count(*) FROM authority_live_source_candidates_v2")
        .pluck()
        .get(),
    ).toBe(0);
  });

it.each(["approved", "rejected"] as const)(
    "keeps a completed %s private approval terminal when a later revision arrives",
    async (outcome) => {
      const { value, state, current, candidate: first } = await actionableFixture();

      // This source-state boundary does not need a full private-assignment
      // fixture; constrain the FK exception to the terminal receipt insert.
      value.pragma("foreign_keys = OFF");
      try {
        value
          .prepare(
            `INSERT INTO authority_private_approval_terminal_receipts_v3 (
               approval_id, candidate_id, outcome, resolution_json,
               resolution_sha256, v4_receipt_json, v4_receipt_sha256,
               card_render_state, card_rendered_at, recorded_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, 'unrendered', NULL, ?)`,
          )
          .run(
            first.approval_id,
            first.candidate_id,
            outcome,
            JSON.stringify({ approval_id: first.approval_id, outcome }),
            `sha256:${outcome === "approved" ? "a".repeat(64) : "b".repeat(64)}`,
            outcome === "approved" ? "{}" : null,
            outcome === "approved" ? `sha256:${"c".repeat(64)}` : null,
            ADVANCED_AT,
          );
      } finally {
        value.pragma("foreign_keys = ON");
      }

      const revised: MeetingDocument = {
        ...meeting,
        provenance: {
          ...meeting.provenance,
          canonical_revision: `sha256:note-terminal-${outcome}`,
        },
        content: [
          {
            id: "block-terminal",
            kind: "note",
            text: `A ${outcome} terminal must remain final.`,
          },
        ],
      };
      const successor = await state.stageCandidate({
        admission: current,
        meeting: revised,
        decisions: {
          ...decisions,
          meeting_revision: revised.provenance.canonical_revision,
          signals: [
            {
              ...decisions.signals[0]!,
              text: revised.content[0]!.text,
              evidence: [{ meeting_id: revised.id, block_id: "block-terminal" }],
            },
          ],
        },
        review_policy: REVIEW_POLICY,
      });
      assertActionable(successor);

      expect(state.readCandidateByApprovalId(first.approval_id)).toMatchObject({
        state: "queued",
        superseded_by_candidate_id: null,
      });
      expect(state.readCandidateByApprovalId(successor.approval_id)).toMatchObject({
        state: "queued",
      });
    },
  );

  it("freezes exactly one durable post intent", async () => {
    const { state, candidate } = await actionableFixture();
    const prepared = state.prepareApprovalPost({
      candidate_id: candidate.candidate_id,
      frozen_card_sha256: `sha256:${"c".repeat(64)}`,
      approved_snapshot: { candidate_id: candidate.candidate_id },
    });
    expect(prepared).toMatchObject({
      created: true,
      outbox: { state: "posting", post_started_at: ADVANCED_AT },
    });
    expect(
      state.prepareApprovalPost({
        candidate_id: candidate.candidate_id,
        frozen_card_sha256: `sha256:${"c".repeat(64)}`,
        approved_snapshot: { candidate_id: candidate.candidate_id },
      }),
    ).toMatchObject({
      created: false,
      outbox: { state: "posting", post_started_at: ADVANCED_AT },
    });
    expect(
      state.releaseApprovalPostAttempt({
        candidate_id: candidate.candidate_id,
        post_started_at: ADVANCED_AT,
      }),
    ).toMatchObject({
      state: "queued",
      frozen_card_sha256: null,
      approved_snapshot_json: null,
      post_started_at: null,
    });
    expect(
      state.releaseApprovalPostAttempt({
        candidate_id: candidate.candidate_id,
        post_started_at: ADVANCED_AT,
      }),
    ).toMatchObject({ state: "queued" });
    expect(
      state.prepareApprovalPost({
        candidate_id: candidate.candidate_id,
        frozen_card_sha256: `sha256:${"c".repeat(64)}`,
        approved_snapshot: { candidate_id: candidate.candidate_id },
      }),
    ).toMatchObject({
      created: true,
      outbox: { state: "posting", post_started_at: ADVANCED_AT },
    });
  });

  it("durably fences an unrepresentable approval package without retrying delivery", async () => {
    const { state, current, candidate } = await actionableFixture();

    const expected = {
      candidate_id: candidate.candidate_id,
      reason_code: "approval_package_unrepresentable",
      quarantined_at: ADVANCED_AT,
    } as const;
    expect(
      state.quarantineApprovalDelivery({
        candidate_id: candidate.candidate_id,
        reason_code: "approval_package_unrepresentable",
      }),
    ).toEqual(expected);
    expect(
      state.quarantineApprovalDelivery({
        candidate_id: candidate.candidate_id,
        reason_code: "approval_package_unrepresentable",
      }),
    ).toEqual(expected);
    expect(state.readApprovalDeliveryQuarantine(candidate.candidate_id)).toEqual(
      expected,
    );
    expect(state.listPendingApprovalDeliveries()).toEqual([]);
    expect(state.approvalIsCurrent(candidate.approval_id)).toBe(false);
    expect(state.readFrozenCandidateForApproval(candidate.approval_id)).toBeUndefined();
    expect(() =>
      state.prepareApprovalPost({
        candidate_id: candidate.candidate_id,
        frozen_card_sha256: `sha256:${"c".repeat(64)}`,
        approved_snapshot: { candidate_id: candidate.candidate_id },
      }),
    ).toThrow(/approval delivery is quarantined/);
    expect(state.readCandidateByApprovalId(candidate.approval_id)).toMatchObject({
      state: "queued",
    });

    const revisedMeeting: MeetingDocument = {
      ...meeting,
      provenance: {
        ...meeting.provenance,
        canonical_revision: "sha256:note-2",
      },
      content: [
        { id: "block-2", kind: "note", text: "Ship the revised onboarding." },
      ],
    };
    const successor = await state.stageCandidate({
      admission: current,
      meeting: revisedMeeting,
      decisions: {
        ...decisions,
        meeting_revision: revisedMeeting.provenance.canonical_revision,
        signals: [{
          ...decisions.signals[0]!,
          text: revisedMeeting.content[0]!.text,
          evidence: [{ meeting_id: revisedMeeting.id, block_id: "block-2" }],
        }],
      },
      review_policy: REVIEW_POLICY,
    });
    assertActionable(successor);
    expect(state.readCandidateByApprovalId(candidate.approval_id)).toMatchObject({
      state: "superseded",
      superseded_by_candidate_id: successor.candidate_id,
    });
    expect(state.listPendingApprovalDeliveries()).toHaveLength(1);
    expect(state.listPendingApprovalDeliveries()[0]?.candidate_id).toBe(
      successor.candidate_id,
    );
  });

  it("lists only current actionable approvals that still need delivery", async () => {
    let tick = 0;
    const state = new SqliteAuthorityMeetingProcessingStateV1(
      database(),
      fixtureCursorPolicy,
      "llm",
      () => new Date(Date.parse(ADVANCED_AT) + tick++ * 1_000).toISOString(),
      FIXTURE_SOURCE_KEY,
    );
    const current = await state.readAdmission();
    const forMeeting = (suffix: string): MeetingDocument => ({
      ...meeting,
      id: `meeting-${suffix}`,
      provenance: {
        ...meeting.provenance,
        external_id: `note-${suffix}`,
        canonical_revision: `sha256:note-${suffix}`,
      },
      content: [
        {
          id: `block-${suffix}`,
          kind: "note",
          text: `Decision ${suffix}.`,
        },
      ],
    });
    const forDecisions = (candidateMeeting: MeetingDocument): DecisionSet => ({
      ...decisions,
      meeting_id: candidateMeeting.id,
      meeting_revision: candidateMeeting.provenance.canonical_revision,
      signals: [
        {
          ...decisions.signals[0]!,
          id: `decision-${candidateMeeting.id}`,
          text: candidateMeeting.content[0]!.text,
          evidence: [
            {
              meeting_id: candidateMeeting.id,
              block_id: candidateMeeting.content[0]!.id,
            },
          ],
        },
      ],
    });
    const stage = async (suffix: string) => {
      const candidateMeeting = forMeeting(suffix);
      const candidate = await state.stageCandidate({
        admission: current,
        meeting: candidateMeeting,
        decisions: forDecisions(candidateMeeting),
        review_policy: REVIEW_POLICY,
      });
      assertActionable(candidate);
      return candidate;
    };

    let providerMessage = 5;
    const stageOut = (
      candidate: ActionableMeetingProcessingCandidateV1,
      token: string,
    ) => {
      const frozen_card_sha256 = `sha256:${token.repeat(64)}`;
      const approved_snapshot = { candidate_id: candidate.candidate_id };
      const prepared = state.prepareApprovalPost({
        candidate_id: candidate.candidate_id,
        frozen_card_sha256,
        approved_snapshot,
      });
      state.recordPostedApprovalCard({
        candidate_id: candidate.candidate_id,
        post_started_at: prepared.outbox.post_started_at!,
        presentation_external_id: `1724292304.00${providerMessage++}000`,
        frozen_card_sha256,
        approved_snapshot,
      });
      state.markControlPlaneStaged({
        candidate_id: candidate.candidate_id,
        control_approval_sha256: `sha256:${token.repeat(64)}`,
      });
    };

    const queued = await stage("queued");
    const posting = await stage("posting");
    state.prepareApprovalPost({
      candidate_id: posting.candidate_id,
      frozen_card_sha256: `sha256:${"p".repeat(64)}`,
      approved_snapshot: { candidate_id: posting.candidate_id },
    });
    const posted = await stage("posted");
    const postedDigest = `sha256:${"d".repeat(64)}`;
    const postedSnapshot = { candidate_id: posted.candidate_id };
    const postedPrepared = state.prepareApprovalPost({
      candidate_id: posted.candidate_id,
      frozen_card_sha256: postedDigest,
      approved_snapshot: postedSnapshot,
    });
    state.recordPostedApprovalCard({
      candidate_id: posted.candidate_id,
      post_started_at: postedPrepared.outbox.post_started_at!,
      presentation_external_id: "1724292304.004000",
      frozen_card_sha256: postedDigest,
      approved_snapshot: postedSnapshot,
    });

    const stale = await stage("stale");
    const staleRevision = forMeeting("stale-revision");
    const staleHead = await state.stageCandidate({
      admission: current,
      meeting: {
        ...staleRevision,
        provenance: {
          ...staleRevision.provenance,
          external_id: "note-stale",
        },
      },
      decisions: {
        ...forDecisions(staleRevision),
        meeting_revision: "sha256:note-stale-revision",
        signals: [
          {
            ...forDecisions(staleRevision).signals[0]!,
            text: "A changed stale decision.",
          },
        ],
      },
      review_policy: REVIEW_POLICY,
    });
    assertActionable(staleHead);
    stageOut(staleHead, "h");

    const staged = await stage("staged");
    stageOut(staged, "s");

    const coalescedBase = await stage("coalesced");
    stageOut(coalescedBase, "b");
    const coalescedSource = forMeeting("coalesced");
    const coalescedMeeting: MeetingDocument = {
      ...coalescedSource,
      provenance: {
        ...coalescedSource.provenance,
        canonical_revision: "sha256:note-coalesced-revision",
      },
      time: { actual_start_at: "2026-08-22T01:04:04.005Z" },
    };
    const coalesced = await state.stageCandidate({
      admission: current,
      meeting: coalescedMeeting,
      decisions: {
        ...forDecisions(coalescedMeeting),
      },
      review_policy: REVIEW_POLICY,
    });

    expect(
      state
        .listPendingApprovalDeliveries()
        .map(({ approval_id }) => approval_id),
    ).toEqual([queued.approval_id, posting.approval_id, posted.approval_id]);
    expect(state.listPendingApprovalDeliveries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          candidate_id: queued.candidate_id,
          state: "queued",
        }),
        expect.objectContaining({
          candidate_id: posting.candidate_id,
          state: "posting",
        }),
        expect.objectContaining({
          candidate_id: posted.candidate_id,
          state: "posted",
        }),
      ]),
    );
    expect(state.readCandidateByApprovalId(stale.approval_id)).toMatchObject({
      state: "superseded",
    });
    expect(coalesced).toMatchObject({ disposition: "coalesced" });
  });

  it("materializes one progress row from the immutable admission and advances it by CAS", async () => {
    const { value, state } = stateFixture();

    await expect(state.readAdmission()).resolves.toMatchObject({
      source: { cursor: sourceCursor, cutoff_at: ADMITTED_AT },
      processor: {
        instance_id: "founder-llm",
        version: FIXTURE_PROCESSOR_VERSION,
      },
    });
    expect(
      value
        .prepare(
          `SELECT admission_semantic_input_sha256, cursor, cursor_version, updated_at
             FROM authority_live_source_progress_v2`,
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
             FROM authority_live_source_progress_v2`,
        )
        .get(),
    ).toEqual({
      cursor: nextCursor,
      cursor_version: 1,
      updated_at: ADVANCED_AT,
    });
  });

  it("will not initialize or advance a source after its owner is revoked", async () => {
    const { value, state } = stateFixture();
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
      AuthorityMeetingProcessingRevokedError,
    );
  });

  it("keeps the progress row narrowly mutable", async () => {
    const { value, state } = stateFixture();
    await state.readAdmission();
    expect(() =>
      value
        .prepare(
          `UPDATE authority_live_source_progress_v2
              SET admission_semantic_input_sha256 = ?`,
        )
        .run(`sha256:${"b".repeat(64)}`),
    ).toThrow("only permits ordered cursor advances");
    expect(() =>
      value
        .prepare(`DELETE FROM authority_live_source_progress_v2`)
        .run(),
    ).toThrow("progress deletion is denied");
  });

  it("freezes one candidate before the post-once Slack/D2 handoff", async () => {
    const { value, state, current, candidate } = await actionableFixture();
    expect(candidate).toMatchObject({
      candidate_id: expect.stringMatching(/^cnd_/),
      approval_id: expect.stringMatching(/^apr_/),
      stage_command_id: expect.stringMatching(/^pas_/),
      state: "queued",
      review_policy_id: REVIEW_POLICY.policy_id,
      review_policy_contract_sha256: REVIEW_POLICY.policy_contract_sha256,
      review_policy_consequence_text: REVIEW_POLICY.policy_consequence_text,
      review_policy_consequence_sha256: REVIEW_POLICY.policy_consequence_sha256,
    });
    expect(state.readDurableCardStagedAt(candidate.approval_id)).toBeNull();
    await expect(
      state.stageCandidate({
        admission: current,
        meeting,
        decisions,
        review_policy: REVIEW_POLICY,
      }),
    ).resolves.toEqual(candidate);
    const prepared = state.prepareApprovalPost({
      candidate_id: candidate.candidate_id,
      frozen_card_sha256: `sha256:${"c".repeat(64)}`,
      approved_snapshot: {
        kind: "approved",
        candidate_id: candidate.candidate_id,
      },
    });
    const posted = state.recordPostedApprovalCard({
      candidate_id: candidate.candidate_id,
      post_started_at: prepared.outbox.post_started_at!,
      presentation_external_id: "1724292304.005000",
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
    expect(state.readDurableCardStagedAt(candidate.approval_id)).toBe(ADVANCED_AT);
    expect(state.readCandidateByApprovalId(candidate.approval_id)).toEqual(
      staged,
    );
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
    value.exec("DROP TRIGGER authority_live_approval_outbox_v2_ordered_transition");
    value
      .prepare("UPDATE authority_live_approval_outbox_v2 SET updated_at = '2026-08-22 02:04:04'")
      .run();
    expect(() => state.readDurableCardStagedAt(candidate.approval_id)).toThrow(
      "timestamp must be UTC milliseconds",
    );
  });

  it("rejects a candidate policy that differs from the provider-neutral default", async () => {
    const { state } = stateFixture();
    const current = await state.readAdmission();

    await expect(
      state.stageCandidate({
        admission: current,
        meeting,
        decisions,
        review_policy: {
          ...REVIEW_POLICY,
          policy_consequence_text: "Wrong visibility text.",
        },
      }),
    ).rejects.toThrow(
      "admitted V1 review policy must equal the fixed restricted default",
    );
  });

  it("deduplicates retries by admitted configuration and source revision while preserving the first audit snapshot", async () => {
    const { value, state } = stateFixture();
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
          `SELECT COUNT(*) AS count FROM authority_live_source_candidates_v2`,
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(
      value
        .prepare(
          `SELECT COUNT(*) AS count FROM authority_live_approval_outbox_v2`,
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(
      state.readFrozenCandidateForApproval(original.approval_id),
    ).toMatchObject({
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
          `SELECT COUNT(*) AS count FROM authority_live_source_candidates_v2`,
        )
        .get(),
    ).toEqual({ count: 2 });
    expect(
      value
        .prepare(
          `SELECT COUNT(*) AS count FROM authority_live_approval_outbox_v2`,
        )
        .get(),
    ).toEqual({ count: 2 });
  });

  it("records a folder-only provider revision without creating another review round", async () => {
    const { state, current, candidate: first } = await actionableFixture();
    const folderOnly: MeetingDocument = {
      ...meeting,
      provenance: {
        ...meeting.provenance,
        canonical_revision: "sha256:note-folder",
      },
      extensions: {
        "fixture-source": { folder_membership: [{ id: "folder-1", name: "notes" }] },
      },
    };
    const duplicate = await state.stageCandidate({
      admission: current,
      meeting: folderOnly,
      decisions: {
        ...decisions,
        meeting_revision: folderOnly.provenance.canonical_revision,
      },
      review_policy: REVIEW_POLICY,
    });
    state.prepareApprovalPost({
      candidate_id: first.candidate_id,
      frozen_card_sha256: `sha256:${"c".repeat(64)}`,
      approved_snapshot: { kind: "approved", candidate_id: first.candidate_id },
    });
    const posted = state.recordPostedApprovalCard({
      candidate_id: first.candidate_id,
      post_started_at: ADVANCED_AT,
      presentation_external_id: "1724292304.005000",
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
    });
    expect(state.approvalIsCurrent(staged.approval_id)).toBe(true);
  });

  it("coalesces a meeting-time-only revision into the existing review round", async () => {
    const { value, state, current, candidate: first } = await actionableFixture();
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
    });
    expect(
      value
        .prepare(
          `SELECT COUNT(*) AS count FROM authority_live_approval_outbox_v2`,
        )
        .get(),
    ).toEqual({ count: 1 });
  });

  it("opens a new immutable review round for a semantic change", async () => {
    const { state, current, candidate: first } = await actionableFixture();
    const edited: MeetingDocument = {
      ...meeting,
      provenance: {
        ...meeting.provenance,
        canonical_revision: "sha256:note-edit",
      },
    };
    const second = await state.stageCandidate({
      admission: current,
      meeting: edited,
      decisions: {
        ...decisions,
        meeting_revision: edited.provenance.canonical_revision,
        signals: [
          {
            id: "decision-edit",
            kind: "decision",
            status: "decided",
            text: "Changed decision.",
            subject: null,
            confidence: 1,
            evidence: [{ meeting_id: "meeting-1", block_id: "block-1" }],
          },
        ],
      },
      review_policy: REVIEW_POLICY,
    });
    assertActionable(second);
    const restricted: MeetingDocument = {
      ...edited,
      provenance: {
        ...edited.provenance,
        canonical_revision: "sha256:note-policy",
      },
      extensions: {
        "fixture-source": {
          folder_membership: [{ id: "folder-r", name: "echo-restricted" }],
        },
      },
    };
    const third = await state.stageCandidate({
      admission: current,
      meeting: restricted,
      decisions: {
        ...decisions,
        meeting_revision: restricted.provenance.canonical_revision,
      },
      review_policy: REVIEW_POLICY,
    });
    assertActionable(third);
    expect(second).toMatchObject({
      state: "queued", review_lineage_id: first.review_lineage_id,
    });
    expect(third).toMatchObject({
      state: "queued", review_lineage_id: first.review_lineage_id,
    });
    expect(
      state.readFrozenCandidateForApproval(first.approval_id)?.meeting,
    ).toEqual(meeting);
  });

  it("records no-signals revisions, supersedes unresolved work, and revalidates the exact revision", async () => {
    const { state, current, candidate: first } = await actionableFixture();
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
    });
    expect(state.approvalIsCurrent(first.approval_id)).toBe(false);
    expect(state.readCandidateByApprovalId(first.approval_id)).toMatchObject({
      superseded_by_candidate_id: noSignals.candidate_id,
      state: "superseded",
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
    const { state, current, candidate: first } = await actionableFixture();
    state.prepareApprovalPost({
      candidate_id: first.candidate_id,
      frozen_card_sha256: `sha256:${"c".repeat(64)}`,
      approved_snapshot: { kind: "approved", candidate_id: first.candidate_id },
    });
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
    expect(state.listPendingSupersededApprovalCards()).toContainEqual(
      expect.objectContaining({
        approval_id: first.approval_id,
        presentation_external_id: null,
        post_started_at: ADVANCED_AT,
      }),
    );
    const latePost = {
      candidate_id: first.candidate_id,
      post_started_at: ADVANCED_AT,
      presentation_external_id: "1724292304.005000",
      frozen_card_sha256: `sha256:${"c".repeat(64)}`,
      approved_snapshot: { kind: "approved", candidate_id: first.candidate_id },
    };

    expect(state.recordPostedApprovalCard(latePost)).toMatchObject({
      state: "superseded",
      presentation_external_id: latePost.presentation_external_id,
    });
    expect(state.recordPostedApprovalCard(latePost)).toMatchObject({
      state: "superseded",
      presentation_external_id: latePost.presentation_external_id,
    });
    expect(state.listPendingSupersededApprovalCards()).toContainEqual(
      expect.objectContaining({
        approval_id: first.approval_id,
        presentation_external_id: latePost.presentation_external_id,
      }),
    );
    expect(state.readCandidateByApprovalId(first.approval_id)).toMatchObject({
      approved_snapshot_json: expect.any(String),
      approved_snapshot_sha256: expect.stringMatching(/^sha256:/),
    });
    expect(() =>
      state.recordPostedApprovalCard({
        ...latePost,
        presentation_external_id: "1724292304.006000",
      }),
    ).toThrow("conflicts with its durable outbox");
  });

  it("releases a superseded post attempt after a definitive provider rejection", async () => {
    const { state, current, candidate: first } = await actionableFixture();
    state.prepareApprovalPost({
      candidate_id: first.candidate_id,
      frozen_card_sha256: `sha256:${"c".repeat(64)}`,
      approved_snapshot: { candidate_id: first.candidate_id },
    });
    const revisedMeeting: MeetingDocument = {
      ...meeting,
      provenance: {
        ...meeting.provenance,
        canonical_revision: "sha256:definitive-post-failure",
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
            id: "decision-after-definitive-failure",
            text: "Retry only the provider-rejected post.",
          },
        ],
      },
      review_policy: REVIEW_POLICY,
    });

    expect(
      state.releaseApprovalPostAttempt({
        candidate_id: first.candidate_id,
        post_started_at: ADVANCED_AT,
      }),
    ).toMatchObject({
      state: "superseded",
      presentation_external_id: null,
      frozen_card_sha256: null,
      approved_snapshot_json: null,
      post_started_at: null,
    });
    expect(state.listPendingSupersededApprovalCards()).not.toContainEqual(
      expect.objectContaining({ approval_id: first.approval_id }),
    );
    expect(
      state.releaseApprovalPostAttempt({
        candidate_id: first.candidate_id,
        post_started_at: ADVANCED_AT,
      }),
    ).toMatchObject({
      state: "superseded",
      post_started_at: null,
    });
  });

  it("releases only the exact unresolved delivery attempt", async () => {
    const { state, candidate } = await actionableFixture();
    state.prepareApprovalPost({
      candidate_id: candidate.candidate_id,
      frozen_card_sha256: `sha256:${"c".repeat(64)}`,
      approved_snapshot: { candidate_id: candidate.candidate_id },
    });

    expect(() =>
      state.releaseApprovalPostAttempt({
        candidate_id: candidate.candidate_id,
        post_started_at: "2026-08-22T02:05:03.000Z",
      }),
    ).toThrow("is stale");
    expect(
      state.readCandidateByApprovalId(candidate.approval_id),
    ).toMatchObject({
      state: "posting",
      post_started_at: ADVANCED_AT,
    });

    state.recordPostedApprovalCard({
      candidate_id: candidate.candidate_id,
      post_started_at: ADVANCED_AT,
      presentation_external_id: "1724292304.005000",
      frozen_card_sha256: `sha256:${"c".repeat(64)}`,
      approved_snapshot: { candidate_id: candidate.candidate_id },
    });
    expect(() =>
      state.releaseApprovalPostAttempt({
        candidate_id: candidate.candidate_id,
        post_started_at: ADVANCED_AT,
      }),
    ).toThrow("is externally visible");
  });

  it("rejects a late post result after the same approval starts a new attempt", async () => {
    let now = ADVANCED_AT;
    const state = new SqliteAuthorityMeetingProcessingStateV1(
      database(),
      fixtureCursorPolicy,
      "llm",
      () => now,
      FIXTURE_SOURCE_KEY,
    );
    const current = await state.readAdmission();
    const candidate = await state.stageCandidate({
      admission: current,
      meeting,
      decisions,
      review_policy: REVIEW_POLICY,
    });
    assertActionable(candidate);
    const frozen_card_sha256 = `sha256:${"c".repeat(64)}`;
    const approved_snapshot = { candidate_id: candidate.candidate_id };
    const firstAttempt = state.prepareApprovalPost({
      candidate_id: candidate.candidate_id,
      frozen_card_sha256,
      approved_snapshot,
    });
    const firstStartedAt = firstAttempt.outbox.post_started_at!;

    state.releaseApprovalPostAttempt({
      candidate_id: candidate.candidate_id,
      post_started_at: firstStartedAt,
    });
    now = NEXT_CUTOFF;
    const secondAttempt = state.prepareApprovalPost({
      candidate_id: candidate.candidate_id,
      frozen_card_sha256,
      approved_snapshot,
    });
    const secondStartedAt = secondAttempt.outbox.post_started_at!;
    expect(secondStartedAt).not.toBe(firstStartedAt);

    expect(() =>
      state.recordPostedApprovalCard({
        candidate_id: candidate.candidate_id,
        post_started_at: firstStartedAt,
        presentation_external_id: "1724292304.005000",
        frozen_card_sha256,
        approved_snapshot,
      }),
    ).toThrow("post result is stale");
    expect(
      state.readCandidateByApprovalId(candidate.approval_id),
    ).toMatchObject({
      state: "posting",
      post_started_at: secondStartedAt,
      presentation_external_id: null,
    });
  });

  it("retains every stale posted card through an A-to-B-to-C no-signals lineage", async () => {
    const { state, current, candidate: first } = await actionableFixture();
    state.prepareApprovalPost({
      candidate_id: first.candidate_id,
      frozen_card_sha256: `sha256:${"a".repeat(64)}`,
      approved_snapshot: { candidate_id: first.candidate_id },
    });
    state.recordPostedApprovalCard({
      candidate_id: first.candidate_id,
      post_started_at: ADVANCED_AT,
      presentation_external_id: "1724292304.005000",
      frozen_card_sha256: `sha256:${"a".repeat(64)}`,
      approved_snapshot: { candidate_id: first.candidate_id },
    });
    const revisedMeeting: MeetingDocument = {
      ...meeting,
      provenance: {
        ...meeting.provenance,
        canonical_revision: "sha256:note-b",
      },
    };
    const second = await state.stageCandidate({
      admission: current,
      meeting: revisedMeeting,
      decisions: {
        ...decisions,
        meeting_revision: revisedMeeting.provenance.canonical_revision,
        signals: [{ ...decisions.signals[0]!, id: "decision-b", text: "B" }],
      },
      review_policy: REVIEW_POLICY,
    });
    assertActionable(second);
    state.prepareApprovalPost({
      candidate_id: second.candidate_id,
      frozen_card_sha256: `sha256:${"b".repeat(64)}`,
      approved_snapshot: { candidate_id: second.candidate_id },
    });
    state.recordPostedApprovalCard({
      candidate_id: second.candidate_id,
      post_started_at: ADVANCED_AT,
      presentation_external_id: "1724292304.006000",
      frozen_card_sha256: `sha256:${"b".repeat(64)}`,
      approved_snapshot: { candidate_id: second.candidate_id },
    });
    const noSignalsMeeting: MeetingDocument = {
      ...revisedMeeting,
      provenance: {
        ...revisedMeeting.provenance,
        canonical_revision: "sha256:note-c",
      },
    };
    const third = await state.stageCandidate({
      admission: current,
      meeting: noSignalsMeeting,
      decisions: {
        ...decisions,
        meeting_revision: noSignalsMeeting.provenance.canonical_revision,
        signals: [],
      },
      review_policy: REVIEW_POLICY,
    });
    expect(third.disposition).toBe("no_signals");

    const stale = state.listPendingSupersededApprovalCards();
    expect(stale).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          approval_id: first.approval_id,
          superseded_by_candidate_id: second.candidate_id,
        }),
        expect.objectContaining({
          approval_id: second.approval_id,
          superseded_by_candidate_id: third.candidate_id,
        }),
      ]),
    );
    for (const card of stale) {
      if (card.presentation_external_id === null) {
        throw new Error("posted stale fixture has no provider timestamp");
      }
      const postedCard = {
        approval_id: card.approval_id,
        presentation_external_id: card.presentation_external_id,
      };
      state.recordSupersededApprovalCardTombstoned(postedCard);
      state.recordSupersededApprovalCardTombstoned(postedCard);
    }
    expect(state.listPendingSupersededApprovalCards()).toEqual([]);
    expect(state.readCandidateByApprovalId(first.approval_id)).toMatchObject({
      state: "superseded",
      tombstoned_at: ADVANCED_AT,
    });
    expect(state.readCandidateByApprovalId(second.approval_id)).toMatchObject({
      state: "superseded",
      tombstoned_at: ADVANCED_AT,
    });
  });

  it("rejects impossible supersession evidence transitions", async () => {
    const { value, state, current, candidate: first } = await actionableFixture();
    const otherMeeting: MeetingDocument = {
      ...meeting,
      id: "meeting-other",
      provenance: {
        ...meeting.provenance,
        external_id: "note-other",
        canonical_revision: "sha256:note-other",
      },
    };
    const queued = await state.stageCandidate({
      admission: current,
      meeting: otherMeeting,
      decisions: {
        ...decisions,
        meeting_id: otherMeeting.id,
        meeting_revision: otherMeeting.provenance.canonical_revision,
        signals: [
          {
            ...decisions.signals[0]!,
            evidence: [{ meeting_id: otherMeeting.id, block_id: "block-1" }],
          },
        ],
      },
      review_policy: REVIEW_POLICY,
    });
    assertActionable(queued);
    expect(() =>
      value
        .prepare(
          `UPDATE authority_live_approval_outbox_v2
          SET state = 'superseded', provider_message_ts = '1724292304.005000',
              frozen_card_sha256 = ?, approved_snapshot_json = '{}',
              approved_snapshot_sha256 = ?, superseded_by_candidate_id = ?,
              superseded_at = ?, updated_at = ?
        WHERE candidate_id = ?`,
        )
        .run(
          `sha256:${"a".repeat(64)}`,
          `sha256:${"b".repeat(64)}`,
          first.candidate_id,
          ADVANCED_AT,
          ADVANCED_AT,
          queued.candidate_id,
        ),
    ).toThrow("only permits queued-posting-posted-staged-superseded");

    const directQueuedPost = {
      candidate_id: queued.candidate_id,
      post_started_at: ADVANCED_AT,
      presentation_external_id: "1724292304.005001",
      frozen_card_sha256: `sha256:${"c".repeat(64)}`,
      approved_snapshot: { candidate_id: queued.candidate_id },
    };
    expect(() => state.recordPostedApprovalCard(directQueuedPost)).toThrow(
      "conflicts with its durable outbox",
    );
    state.prepareApprovalPost({
      candidate_id: directQueuedPost.candidate_id,
      frozen_card_sha256: directQueuedPost.frozen_card_sha256,
      approved_snapshot: directQueuedPost.approved_snapshot,
    });
    state.recordPostedApprovalCard(directQueuedPost);
    expect(() =>
      value
        .prepare(
          `UPDATE authority_live_approval_outbox_v2
          SET state = 'superseded', control_approval_sha256 = ?,
              superseded_by_candidate_id = ?, superseded_at = ?, updated_at = ?
        WHERE candidate_id = ?`,
        )
        .run(
          `sha256:${"d".repeat(64)}`,
          first.candidate_id,
          ADVANCED_AT,
          ADVANCED_AT,
          queued.candidate_id,
        ),
    ).toThrow("only permits queued-posting-posted-staged-superseded");
  });

  it("keeps separate source meetings on independent review lineages", async () => {
    const { state, current, candidate: first } = await actionableFixture();
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
        signals: [
          {
            ...decisions.signals[0]!,
            evidence: [{ meeting_id: otherMeeting.id, block_id: "block-1" }],
          },
        ],
      },
      review_policy: REVIEW_POLICY,
    });
    assertActionable(other);
    expect(other).toMatchObject({ disposition: "actionable" });
    expect(other.review_lineage_id).not.toBe(first.review_lineage_id);
    expect(state.approvalIsCurrent(first.approval_id)).toBe(true);
    expect(state.approvalIsCurrent(other.approval_id)).toBe(true);
  });
});
