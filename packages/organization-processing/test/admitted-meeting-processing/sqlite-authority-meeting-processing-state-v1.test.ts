import { afterEach, describe, expect, it } from "vitest";
import type {
  ActionableMeetingProcessingCandidateV1
} from "../../src/admitted-meeting-processing/meeting-processing-cycle-v1.js";
import { canonicalJson, canonicalSha256 } from "@echo-brain/federation-protocol";
import {
  AuthorityMeetingProcessingRevokedError,
  SqliteApprovalWorkflowStateV1,
  SqliteAuthorityMeetingProcessingStateV1,
} from "../../src/admitted-meeting-processing/sqlite-authority-meeting-processing-state-v1.js";
import type Database from "better-sqlite3";
import type { AdmittedMeetingProcessingAdmissionV1 } from "../../src/admitted-meeting-processing/meeting-processing-cycle-v1.js";
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

const PROJECT_A = "prj_00000000-0000-4000-8000-0000000000a1";
const PROJECT_B = "prj_00000000-0000-4000-8000-0000000000b1";
const PROJECT_C = "prj_00000000-0000-4000-8000-0000000000c1";
function addProjects(value: Database.Database, ...ids: readonly string[]) {
  for (const id of ids) value.prepare("INSERT INTO authority_projects_v1 VALUES (?, 'org_test', ?, 'active', ?, 'prn_test', 'mem_test', 'owner')").run(id, `Project ${id.slice(-2)}`, ADMITTED_AT);
}
/** A minimal frozen proposal snapshot; the outbox only pins its approval_id. */
function snapshotFor(candidate: ActionableMeetingProcessingCandidateV1) {
  return { approval_id: candidate.approval_id, kind: "fixture-proposal" };
}
/** One decision row as the approval core writes it. */
function insertDecision(value: Database.Database, approvalId: string, snapshotSha256: string, surface: "desktop" | "slack", action: "approve" | "reject") {
  const command_id = surface === "slack" ? `slack:${action}` : `desk-${action}`;
  const body = { request: { approval_id: approvalId, command_id, snapshot_sha256: snapshotSha256, action, project_ids: [], share_transcript: false, owners: [] }, surface,
    actor: { organization_id: "org_test", principal_id: "prn_test", membership_id: "mem_test" }, evidence: { kind: surface === "desktop" ? "person-session" : "slack-click", sha256: SHA },
    decided_at: ADVANCED_AT };
  value.prepare("INSERT INTO authority_approval_decisions_v1 (approval_id, command_id, surface, action, body_json) VALUES (?,?,?,?,?)").run(approvalId, command_id, surface, action, canonicalJson(body));
}
/** A semantic change of the fixture meeting on the same lineage. */
async function stageRevision(state: SqliteAuthorityMeetingProcessingStateV1, admission: AdmittedMeetingProcessingAdmissionV1, label: string) {
  const revised: MeetingDocument = { ...meeting, provenance: { ...meeting.provenance, canonical_revision: `sha256:note-${label}` },
    content: [{ id: "block-revised", kind: "note", text: `A ${label} revision.` }] };
  const successor = await state.stageCandidate({ admission, meeting: revised, review_policy: REVIEW_POLICY, decisions: { ...decisions, meeting_revision: revised.provenance.canonical_revision,
    signals: [{ ...decisions.signals[0]!, text: revised.content[0]!.text, evidence: [{ meeting_id: revised.id, block_id: "block-revised" }] }] } });
  assertActionable(successor);
  return successor;
}
/** The fixture meeting and decisions under another source meeting identity. */
async function stageOtherMeeting(state: SqliteAuthorityMeetingProcessingStateV1, admission: AdmittedMeetingProcessingAdmissionV1, suffix: string) {
  const other: MeetingDocument = { ...meeting, id: `meeting-${suffix}`, provenance: { ...meeting.provenance, external_id: `note-${suffix}`, canonical_revision: `sha256:note-${suffix}` } };
  const candidate = await state.stageCandidate({ admission, meeting: other, review_policy: REVIEW_POLICY, decisions: { ...decisions, meeting_id: other.id, meeting_revision: other.provenance.canonical_revision,
    signals: [{ ...decisions.signals[0]!, evidence: [{ meeting_id: other.id, block_id: "block-1" }] }] } });
  assertActionable(candidate);
  return candidate;
}
const rows = (value: Database.Database, table: string) => value.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get();

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
    expect(rows(value, "authority_live_source_candidates_v2")).toBe(0);
  });

  it.each([
    ["adapter", { source_adapter_id: "synthetic-fixture", assert_live_cursor: fixtureCursorPolicy.assert_live_cursor }, "llm", "admission adapter differs from its configured boundary"],
    ["processor", fixtureCursorPolicy, "synthetic-processor", "admission processor differs from its configured processor"],
  ] as const)("rejects an admitted source whose persisted %s differs from its configuration", async (_field, policy, processorAdapterId, message) => {
    const state = new SqliteAuthorityMeetingProcessingStateV1(database(), policy, processorAdapterId, undefined, FIXTURE_SOURCE_KEY);
    await expect(state.readAdmission()).rejects.toThrow(message);
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

    expect(rows(value, "authority_live_source_candidates_v2")).toBe(0);
  });

it.each([["desktop", "approve"], ["desktop", "reject"], ["slack", "approve"], ["slack", "reject"]] as const)(
    "keeps a proposal decided on %s (%s) when a later revision arrives",
    async (surface, action) => {
      const { value, state, current, candidate: first } = await actionableFixture();
      const frozen = state.freezeProposal({ candidate_id: first.candidate_id, approved_snapshot: snapshotFor(first), suggested_project_ids: [] });
      insertDecision(value, first.approval_id, frozen.approved_snapshot_sha256!, surface, action);

      const successor = await stageRevision(state, current, `terminal-${surface}-${action}`);

      expect(state.readCandidateByApprovalId(first.approval_id)).toMatchObject({
        state: "staged",
        approved_snapshot_sha256: frozen.approved_snapshot_sha256,
        superseded_by_candidate_id: null,
      });
      expect(state.readCandidateByApprovalId(successor.approval_id)).toMatchObject({
        state: "queued",
      });
      expect(() => value.prepare(`UPDATE authority_live_approval_outbox_v2 SET state = 'superseded', superseded_by_candidate_id = ?,
        superseded_at = ?, updated_at = ? WHERE approval_id = ?`).run(successor.candidate_id, ADVANCED_AT, ADVANCED_AT, first.approval_id))
        .toThrow("a decided approval proposal is final");
    },
  );

  it("freezes a proposal once with its suggestions", async () => {
    const { value, state, candidate } = await actionableFixture();
    addProjects(value, PROJECT_A, PROJECT_B);
    const snapshot = snapshotFor(candidate);
    for (const invalid of [
      { approved_snapshot: { ...snapshot, approval_id: "apr_other" }, suggested_project_ids: [] },
      { approved_snapshot: snapshot, suggested_project_ids: [PROJECT_B, PROJECT_A] },
      { approved_snapshot: snapshot, suggested_project_ids: [PROJECT_A, PROJECT_A] },
      { approved_snapshot: snapshot, suggested_project_ids: Array.from({ length: 21 }, (_, i) => `prj_${i}`) },
    ]) {
      expect(() => state.freezeProposal({ candidate_id: candidate.candidate_id, ...invalid })).toThrow("approval proposal freeze input is invalid");
    }
    expect(() => state.freezeProposal({ candidate_id: candidate.candidate_id, approved_snapshot: snapshot, suggested_project_ids: [PROJECT_C] }))
      .toThrow("suggested projects must be sorted, unique, existing projects");
    const frozen = state.freezeProposal({ candidate_id: candidate.candidate_id, approved_snapshot: snapshot, suggested_project_ids: [PROJECT_A, PROJECT_B] });
    expect(frozen).toMatchObject({
      state: "staged",
      approved_snapshot_json: canonicalJson(snapshot),
      approved_snapshot_sha256: canonicalSha256(snapshot),
      suggested_project_ids: [PROJECT_A, PROJECT_B],
    });
    expect(state.readFrozenCandidateForApproval(candidate.approval_id)).toMatchObject({
      approved_snapshot: snapshot,
      suggested_project_ids: [PROJECT_A, PROJECT_B],
    });
    expect(state.listPendingApprovalDeliveries()).toEqual([]);
    expect(() => value.prepare("UPDATE authority_live_approval_outbox_v2 SET suggested_projects_json = ? WHERE approval_id = ?")
      .run(JSON.stringify([PROJECT_A]), candidate.approval_id)).toThrow("only permits queued-staged-superseded");
  });

  it("returns a staged proposal unchanged for the same snapshot and refuses another", async () => {
    const { value, state, candidate } = await actionableFixture();
    addProjects(value, PROJECT_A);
    const snapshot = snapshotFor(candidate);
    const frozen = state.freezeProposal({ candidate_id: candidate.candidate_id, approved_snapshot: snapshot, suggested_project_ids: [PROJECT_A] });
    expect(state.freezeProposal({ candidate_id: candidate.candidate_id, approved_snapshot: snapshot, suggested_project_ids: [] })).toEqual(frozen);
    expect(() => state.freezeProposal({ candidate_id: candidate.candidate_id, approved_snapshot: { ...snapshot, kind: "changed" }, suggested_project_ids: [PROJECT_A] }))
      .toThrow("approval proposal conflicts with its frozen snapshot");
    expect(state.readCandidateByApprovalId(candidate.approval_id)).toEqual(frozen);
  });

  it("returns a superseded proposal unchanged", async () => {
    const { state, current, candidate } = await actionableFixture();
    const successor = await stageRevision(state, current, "superseding");
    const superseded = state.readCandidateByApprovalId(candidate.approval_id)!;
    expect(superseded).toMatchObject({ state: "superseded", superseded_by_candidate_id: successor.candidate_id, approved_snapshot_json: null, suggested_project_ids: null });
    expect(state.freezeProposal({ candidate_id: candidate.candidate_id, approved_snapshot: snapshotFor(candidate), suggested_project_ids: [] })).toEqual(superseded);
  });

  it("supersedes an undecided frozen proposal and keeps its snapshot", async () => {
    const { value, state, current, candidate } = await actionableFixture();
    addProjects(value, PROJECT_A);
    const frozen = state.freezeProposal({ candidate_id: candidate.candidate_id, approved_snapshot: snapshotFor(candidate), suggested_project_ids: [PROJECT_A] });
    const successor = await stageRevision(state, current, "after-freeze");
    expect(state.readCandidateByApprovalId(candidate.approval_id)).toMatchObject({
      state: "superseded",
      superseded_by_candidate_id: successor.candidate_id,
      approved_snapshot_json: frozen.approved_snapshot_json,
      approved_snapshot_sha256: frozen.approved_snapshot_sha256,
      suggested_project_ids: [PROJECT_A],
    });
    expect(state.approvalIsCurrent(candidate.approval_id)).toBe(false);
    expect(state.listPendingApprovalDeliveries().map(item => item.approval_id)).toEqual([successor.approval_id]);
  });

  it("lists only current actionable approvals that still need a frozen proposal", async () => {
    let tick = 0;
    const value = database();
    const state = new SqliteAuthorityMeetingProcessingStateV1(
      value,
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
      content: [{ id: `block-${suffix}`, kind: "note", text: `Decision ${suffix}.` }],
    });
    const forDecisions = (candidateMeeting: MeetingDocument): DecisionSet => ({
      ...decisions,
      meeting_id: candidateMeeting.id,
      meeting_revision: candidateMeeting.provenance.canonical_revision,
      signals: [{
        ...decisions.signals[0]!,
        id: `decision-${candidateMeeting.id}`,
        text: candidateMeeting.content[0]!.text,
        evidence: [{ meeting_id: candidateMeeting.id, block_id: candidateMeeting.content[0]!.id }],
      }],
    });
    const stage = async (suffix: string) => {
      const candidateMeeting = forMeeting(suffix);
      const candidate = await state.stageCandidate({ admission: current, meeting: candidateMeeting, decisions: forDecisions(candidateMeeting), review_policy: REVIEW_POLICY });
      assertActionable(candidate);
      return candidate;
    };
    const freeze = (candidate: ActionableMeetingProcessingCandidateV1) =>
      state.freezeProposal({ candidate_id: candidate.candidate_id, approved_snapshot: snapshotFor(candidate), suggested_project_ids: [] });

    const queued = await stage("queued");
    const later = await stage("later");
    const stale = await stage("stale");
    const staleRevision = forMeeting("stale-revision");
    const staleHead = await state.stageCandidate({
      admission: current,
      meeting: { ...staleRevision, provenance: { ...staleRevision.provenance, external_id: "note-stale" } },
      decisions: {
        ...forDecisions(staleRevision),
        meeting_revision: "sha256:note-stale-revision",
        signals: [{ ...forDecisions(staleRevision).signals[0]!, text: "A changed stale decision." }],
      },
      review_policy: REVIEW_POLICY,
    });
    assertActionable(staleHead);
    freeze(staleHead);
    freeze(await stage("staged"));
    const coalescedBase = await stage("coalesced");
    freeze(coalescedBase);
    const coalescedSource = forMeeting("coalesced");
    const coalesced = await state.stageCandidate({
      admission: current,
      meeting: { ...coalescedSource, provenance: { ...coalescedSource.provenance, canonical_revision: "sha256:note-coalesced-revision" }, time: { actual_start_at: "2026-08-22T01:04:04.005Z" } },
      decisions: { ...forDecisions(coalescedSource), meeting_revision: "sha256:note-coalesced-revision" },
      review_policy: REVIEW_POLICY,
    });

    expect(state.listPendingApprovalDeliveries().map(({ approval_id }) => approval_id)).toEqual([queued.approval_id, later.approval_id]);
    expect(state.listPendingApprovalDeliveries({ limit: 1 }).map(({ approval_id }) => approval_id)).toEqual([queued.approval_id]);
    expect(state.listPendingApprovalDeliveries({ source_key: FIXTURE_SOURCE_KEY })).toHaveLength(2);
    expect(state.listPendingApprovalDeliveries({ source_key: "pms_other" })).toEqual([]);
    expect(state.listPendingApprovalDeliveries()[0]).toMatchObject({ candidate_id: queued.candidate_id, state: "queued", meeting: forMeeting("queued") });
    expect(state.readCandidateByApprovalId(stale.approval_id)).toMatchObject({ state: "superseded" });
    expect(coalesced).toMatchObject({ disposition: "coalesced" });
    value.prepare("UPDATE authority_memberships SET status = 'revoked', revoked_at = ?, revocation_reason = 'fixture' WHERE membership_id = 'mem_test'").run(ADVANCED_AT);
    expect(state.listPendingApprovalDeliveries()).toEqual([]);
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

  it("runs the after-advance hook inside a successful advance only, and rolls the advance back when it throws", async () => {
    const value = database();
    const seen: unknown[] = [];
    let fail = true;
    const state = new SqliteAuthorityMeetingProcessingStateV1(value, fixtureCursorPolicy, "llm", () => ADVANCED_AT, FIXTURE_SOURCE_KEY, () => {}, (transition) => {
      seen.push({ ...transition, in_transaction: value.inTransaction });
      if (fail) throw new Error("hook refused");
    });
    await state.readAdmission();
    const cursor = () => value.prepare("SELECT cursor FROM authority_live_source_progress_v2").pluck().get();
    await expect(state.advanceCursor({ expected_cursor: sourceCursor, next_cursor: nextCursor })).rejects.toThrow("hook refused");
    expect(cursor()).toBe(sourceCursor);
    fail = false;
    await expect(state.advanceCursor({ expected_cursor: sourceCursor, next_cursor: nextCursor })).resolves.toBe("advanced");
    await expect(state.advanceCursor({ expected_cursor: sourceCursor, next_cursor: nextCursor })).resolves.toBe("state_drift");
    expect(cursor()).toBe(nextCursor);
    expect(seen).toEqual([
      { expected_cursor: sourceCursor, next_cursor: nextCursor, in_transaction: true },
      { expected_cursor: sourceCursor, next_cursor: nextCursor, in_transaction: true },
    ]);
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

  it("freezes one candidate before the approval core's proposal freeze", async () => {
    const { state, current, candidate } = await actionableFixture();
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
    expect(candidate).not.toHaveProperty("durable_staged_at");
    await expect(
      state.stageCandidate({
        admission: current,
        meeting,
        decisions,
        review_policy: REVIEW_POLICY,
      }),
    ).resolves.toEqual(candidate);
    const staged = state.freezeProposal({ candidate_id: candidate.candidate_id, approved_snapshot: snapshotFor(candidate), suggested_project_ids: [] });
    expect(staged).toMatchObject({ state: "staged", approval_id: candidate.approval_id });
    expect(state.readCandidateByApprovalId(candidate.approval_id)).toEqual(staged);
    expect(state.readFrozenCandidateForApproval(candidate.approval_id)).toMatchObject({
      candidate_id: candidate.candidate_id,
      meeting,
      decisions,
      approved_snapshot: snapshotFor(candidate),
    });
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
      signals: [{ ...decisions.signals[0]!, text: "A later LLM observation of the same revision." }],
    };

    await expect(
      state.stageCandidate({
        admission: advancedAdmission,
        meeting: retriedMeeting,
        decisions: retriedDecisions,
        review_policy: REVIEW_POLICY,
      }),
    ).resolves.toEqual(original);
    expect(rows(value, "authority_live_source_candidates_v2")).toBe(1);
    expect(rows(value, "authority_live_approval_outbox_v2")).toBe(1);
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
    expect(rows(value, "authority_live_source_candidates_v2")).toBe(2);
    expect(rows(value, "authority_live_approval_outbox_v2")).toBe(2);
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
    const staged = state.freezeProposal({ candidate_id: first.candidate_id, approved_snapshot: snapshotFor(first), suggested_project_ids: [] });
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
    expect(rows(value, "authority_live_approval_outbox_v2")).toBe(1);
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
        signals: [{ ...decisions.signals[0]!, id: "decision-edit", text: "Changed decision." }],
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

  it("rejects impossible proposal transitions", async () => {
    const { value, state, current, candidate: first } = await actionableFixture();
    const queued = await stageOtherMeeting(state, current, "other");
    const update = (sql: string, ...args: unknown[]) => () => value.prepare(`UPDATE authority_live_approval_outbox_v2 SET ${sql} WHERE candidate_id = ?`).run(...args, queued.candidate_id);
    const snapshot = canonicalJson(snapshotFor(queued));
    expect(update("state = 'superseded', approved_snapshot_json = ?, approved_snapshot_sha256 = ?, suggested_projects_json = '[]', superseded_by_candidate_id = ?, superseded_at = ?, updated_at = ?",
      snapshot, canonicalSha256(snapshotFor(queued)), first.candidate_id, ADVANCED_AT, ADVANCED_AT)).toThrow("only permits queued-staged-superseded");
    expect(update("state = 'staged', updated_at = ?", ADVANCED_AT)).toThrow("CHECK constraint failed");
    expect(update("state = 'staged', approved_snapshot_json = '{}', approved_snapshot_sha256 = ?, suggested_projects_json = '[]', updated_at = ?",
      canonicalSha256({}), ADVANCED_AT)).toThrow("CHECK constraint failed");
    state.freezeProposal({ candidate_id: queued.candidate_id, approved_snapshot: snapshotFor(queued), suggested_project_ids: [] });
    expect(update("state = 'queued', approved_snapshot_json = NULL, approved_snapshot_sha256 = NULL, suggested_projects_json = NULL, updated_at = ?", ADVANCED_AT))
      .toThrow("only permits queued-staged-superseded");
    expect(update("approved_snapshot_json = ?, approved_snapshot_sha256 = ?, updated_at = ?", canonicalJson({ ...snapshotFor(queued), kind: "x" }), canonicalSha256({ ...snapshotFor(queued), kind: "x" }), ADVANCED_AT))
      .toThrow("only permits queued-staged-superseded");
    expect(update("state = 'superseded', superseded_by_candidate_id = ?, superseded_at = ?, updated_at = ?", queued.candidate_id, ADVANCED_AT, ADVANCED_AT))
      .toThrow("CHECK constraint failed");
    expect(update("state = 'superseded', approved_snapshot_json = NULL, approved_snapshot_sha256 = NULL, suggested_projects_json = NULL, superseded_by_candidate_id = ?, superseded_at = ?, updated_at = ?",
      first.candidate_id, ADVANCED_AT, ADVANCED_AT)).toThrow("only permits queued-staged-superseded");
    update("state = 'superseded', superseded_by_candidate_id = ?, superseded_at = ?, updated_at = ?", first.candidate_id, ADVANCED_AT, ADVANCED_AT)();
    expect(update("state = 'staged', superseded_by_candidate_id = NULL, superseded_at = NULL, updated_at = ?", ADVANCED_AT)).toThrow("only permits queued-staged-superseded");
    expect(update("state = 'superseded', updated_at = ?", ADVANCED_AT)).toThrow("only permits queued-staged-superseded");
  });

  it("SqliteApprovalWorkflowStateV1 reads proposals across configured sources and hides unconfigured ones", async () => {
    const { value, state, candidate: first } = await actionableFixture();
    const columns = (value.pragma("table_info(authority_live_source_admission_v2)") as { name: string }[]).map(row => row.name).filter(name => name !== "source_key");
    const row = value.prepare("SELECT * FROM authority_live_source_admission_v2").get() as Record<string, unknown>;
    value.prepare(`INSERT INTO authority_live_source_admission_v2 (${columns.join(",")}, source_key) VALUES (${columns.map(() => "?").join(",")}, ?)`)
      .run(...columns.map(column => column === "semantic_input_sha256" ? `sha256:${"b".repeat(64)}` : column === "source_adapter_id" ? "other-source" : column === "source_adapter_instance_id" ? "second-person-source" : row[column]), "pms_second");
    const otherPolicy = { source_adapter_id: "other-source", assert_live_cursor: fixtureCursorPolicy.assert_live_cursor };
    const second = new SqliteAuthorityMeetingProcessingStateV1(value, otherPolicy, "llm", () => ADVANCED_AT, "pms_second");
    const secondAdmission = await second.readAdmission();
    const secondMeeting: MeetingDocument = { ...meeting, id: "meeting-second", provenance: { ...meeting.provenance, source: { ...meeting.provenance.source, adapter_id: "other-source", instance_id: "second-person-source" }, external_id: "note-second" } };
    const secondDecisions: DecisionSet = { ...decisions, meeting_id: secondMeeting.id, signals: [{ ...decisions.signals[0]!, evidence: [{ meeting_id: secondMeeting.id, block_id: "block-1" }] }] };
    const other = await second.stageCandidate({ admission: secondAdmission, meeting: secondMeeting, decisions: secondDecisions, review_policy: REVIEW_POLICY });
    assertActionable(other);

    expect(() => new SqliteApprovalWorkflowStateV1(value, { source_cursor_policies: [fixtureCursorPolicy, fixtureCursorPolicy], processor_adapter_id: "llm" }))
      .toThrow("distinct source adapters");
    const one = new SqliteApprovalWorkflowStateV1(value, { source_cursor_policies: [fixtureCursorPolicy], processor_adapter_id: "llm", now: () => ADVANCED_AT });
    expect(one.readCandidateByApprovalId(first.approval_id)).toEqual(state.readCandidateByApprovalId(first.approval_id));
    expect(one.readCandidateByApprovalId(other.approval_id)).toBeUndefined();
    expect(one.readFrozenCandidateForApproval(other.approval_id)).toBeUndefined();
    expect(one.listPendingApprovalDeliveries().map(item => item.approval_id)).toEqual([first.approval_id]);
    expect(() => one.freezeProposal({ candidate_id: other.candidate_id, approved_snapshot: snapshotFor(other), suggested_project_ids: [] }))
      .toThrow("approval proposal source is not configured in this runtime");
    expect(one.readCandidateByApprovalId("apr_" + "0".repeat(64))).toBeUndefined();

    const both = new SqliteApprovalWorkflowStateV1(value, { source_cursor_policies: [fixtureCursorPolicy, otherPolicy], processor_adapter_id: "llm", now: () => ADVANCED_AT });
    expect(both.listPendingApprovalDeliveries().map(item => item.approval_id).sort()).toEqual([first.approval_id, other.approval_id].sort());
    expect(both.listPendingApprovalDeliveries({ source_key: "pms_second" }).map(item => item.approval_id)).toEqual([other.approval_id]);
    expect(both.freezeProposal({ candidate_id: other.candidate_id, approved_snapshot: snapshotFor(other), suggested_project_ids: [] })).toMatchObject({ state: "staged" });
    expect(second.readCandidateByApprovalId(other.approval_id)).toMatchObject({ state: "staged" });
    expect(both.readFrozenCandidateForApproval(first.approval_id)).toMatchObject({ meeting, decisions, approved_snapshot: null });
  });

  it("keeps separate source meetings on independent review lineages", async () => {
    const { state, current, candidate: first } = await actionableFixture();
    const other = await stageOtherMeeting(state, current, "2");
    expect(other.review_lineage_id).not.toBe(first.review_lineage_id);
    expect(state.approvalIsCurrent(first.approval_id)).toBe(true);
    expect(state.approvalIsCurrent(other.approval_id)).toBe(true);
  });
});
