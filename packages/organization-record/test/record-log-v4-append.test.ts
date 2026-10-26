import {
  canonicalJson,
  parseCanonicalJson,
  sha256Digest,
  type JsonObject,
  type Sha256Digest
} from "@echo-brain/federation-protocol";
import { describe, expect, it } from "vitest";
import {
  createOrganizationRecordReceiptV2
} from "../../../packages/organization-protocol/src/organization-record-receipt-v2.js";
import {
  organizationMemberReadablePersonPolicyContractSha256
} from "../../../packages/organization-protocol/src/person-content-policy-v2.js";
import {
  verifyOrganizationRecordEnvelopeV4
} from "../../../packages/organization-protocol/src/record-envelope-v4.js";
import {
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
  PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID
} from "../src/application/person-policy-fact-contracts-v2.js";
import {
  createRecordPolicyFactProjectorRegistryV1,
  type RecordPolicyFactProjectorV1,
} from "../src/application/record-policy-fact-projection-v1.js";
import {
  OrganizationRecordAppenderV4,
  V4RecordIdempotencyConflictError,
  type V4ReceiptFactory,
  type V4RecordEnvelopeView
} from "../src/log/record-log-v4-append.js";
import { PersonRecordReaderV1 } from "../src/retrieve/person-record-reader-v1.js";
import { derivedAtomIdentity } from "../src/application/atom-identity.js";
import {
  RecordRetrievalSourceSnapshotPortV1,
  type RecordRetrievalSourceVerifiedEnvelopeV1,
} from "../src/retrieve/record-retrieval-source-snapshot-v1.js";
import {
  ORGANIZATION_RECORD_LOG_BASELINE_SCHEMA_VERSION_V6,
  applyOrganizationRecordLogBaselineV6,
  organizationRecordLogBaselineSha256V6,
} from "../src/persistence/record-log-baseline.js";
import { openOrganizationRecordDatabase } from "../src/persistence/open-organization-record-database.js";
import { COORDINATES, RECORD_INPUT_CODECS, appendInput, authorizationWitness, database, humanAct, protocolAuthority, receiptFactory } from './fixtures/record-append-fixture.js';

describe("organization record log baseline V6", () => {
  it("creates fresh immutable project audience and association facts, and no transcript grant", () => {
    const db = openOrganizationRecordDatabase(":memory:");
    try {
      applyOrganizationRecordLogBaselineV6(db);
      expect(db.pragma("user_version", { simple: true })).toBe(
        ORGANIZATION_RECORD_LOG_BASELINE_SCHEMA_VERSION_V6,
      );
      expect(organizationRecordLogBaselineSha256V6()).toMatch(
        /^sha256:[0-9a-f]{64}$/,
      );
      expect(
        db.prepare(
          `SELECT name FROM sqlite_master
            WHERE type = 'table' AND name IN (
              'organization_record_project_members_readable_person_record_fact',
              'organization_record_project_association_v1',
              'organization_record_meeting_transcript_grant_v1'
            ) ORDER BY name`,
        ).all(),
      ).toEqual([{ name: "organization_record_project_association_v1" }, { name: "organization_record_project_members_readable_person_record_fact" }]);
    } finally {
      db.close();
    }
  });

  it("never relabels occupied state as a V6 lineage", () => {
    const occupied = openOrganizationRecordDatabase(":memory:");
    const current = openOrganizationRecordDatabase(":memory:");
    try {
      occupied.exec("CREATE TABLE occupied (id INTEGER PRIMARY KEY)");
      occupied.pragma("user_version = 1");
      expect(() => applyOrganizationRecordLogBaselineV6(occupied)).toThrow(
        "completely empty database",
      );
      applyOrganizationRecordLogBaselineV6(current);
      expect(() => applyOrganizationRecordLogBaselineV6(current)).toThrow(
        "completely empty database",
      );
    } finally {
      occupied.close();
      current.close();
    }
  });
});

describe("V4 organization-record append", () => {
  it("refuses a record that shares a meeting transcript, and append-atomically stores project audience and association facts", async () => {
    const db = database();
    try {
      const semantic = sha256Digest("project-facts-semantic-key");
      const envelope: V4RecordEnvelopeView & JsonObject = {
        record_sha256: sha256Digest("project-facts-record"),
        body: {
          schema_version: 4, kind: "echo-organization-record-envelope-v4",
          envelope_id: "envelope-project-facts", ...COORDINATES,
          semantic_idempotency_key: semantic, predecessor_position: null,
          predecessor_record_sha256: null,
          human_act_resolution_ref: {
            ...COORDINATES, approval_id: "approval-project-facts", action: "approve",
            policy_id: PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID,
            policy_contract_sha256: sha256Digest("project-policy-contract"),
            audience_project_ids: ["prj_alpha", "prj_beta"],
            association_project_ids: ["prj_alpha", "prj_beta"],
            audit_event_id: "audit-project-facts", audit_sequence: 1,
            audit_entry_sha256: sha256Digest("audit-project-facts"),
            provider_action_kind: "test-project-action-v1", provider_action_schema_version: 1,
            provider_action_sha256: sha256Digest("action-project-facts"),
            authorization_proof_sha256: sha256Digest("proof-project-facts"),
          },
          event: { kind: "approved", approved_snapshot: { approved_payload: { brief: { decisions: [], actions: [], rationales: [] } } } },
        },
      } as V4RecordEnvelopeView & JsonObject;
      const projectors = createRecordPolicyFactProjectorRegistryV1([{
        id: "test-project-action-v1",
        matches: () => true,
        project: () => ({ facts: [], policy_fact_outcome: { kind: "appended", policy_id: PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID } }),
        policyBinding: () => ({ policy_id: PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID, policy_contract_sha256: sha256Digest("project-policy-contract") }),
      }]);
      const app = new OrganizationRecordAppenderV4(db, COORDINATES, projectors);
      const append = (appended: V4RecordEnvelopeView & JsonObject) => app.append({
        approval_id: "approval-project-facts", action: "approve", semantic_idempotency_key: semantic,
        receipt_issued_at: "2026-08-21T12:02:00.000Z", authorization_witness: {},
        envelope_factory: { create: async () => appended, verify: () => appended },
        receipt_factory: {
          createSeed: ({ envelope: receiptEnvelope, position, issued_at }) => ({ schema_version: 2, kind: "echo-organization-record-receipt-v2", ...COORDINATES, envelope_id: receiptEnvelope.body.envelope_id, semantic_idempotency_key: semantic, event_kind: "approved", record_position: position, record_sha256: receiptEnvelope.record_sha256, predecessor_record_sha256: null, record_head_position: position, record_head_sha256: receiptEnvelope.record_sha256, issued_at }),
          sign: async ({ receipt_seed }) => ({ body: receipt_seed as JsonObject }), verify: ({ receipt }) => receipt as JsonObject,
        },
      });
      // No record shares a meeting transcript (ADR-0046): one that claims to is refused whole.
      const shared = { ...envelope, body: { ...envelope.body, human_act_resolution_ref: { ...envelope.body.human_act_resolution_ref, share_transcript: true } } } as unknown as V4RecordEnvelopeView & JsonObject;
      await expect(append(shared)).rejects.toThrow("never shares a meeting transcript");
      expect(db.prepare("SELECT count(*) FROM organization_record_log").pluck().get()).toBe(0);
      await append(envelope);
      expect(db.prepare("SELECT project_id FROM organization_record_project_members_readable_person_record_fact ORDER BY project_id").all()).toEqual([{ project_id: "prj_alpha" }, { project_id: "prj_beta" }]);
      expect(db.prepare("SELECT project_id FROM organization_record_project_association_v1 ORDER BY project_id").all()).toEqual([{ project_id: "prj_alpha" }, { project_id: "prj_beta" }]);
      expect(
        new PersonRecordReaderV1(db).list({
          ...COORDINATES,
          principal_id: "principal-current",
          membership_id: "membership-current",
          project_ids: ["prj_alpha", ...Array.from({ length: 20 }, (_, index) => `prj_other_${index}`)],
        }),
      ).toHaveLength(1);
    } finally { db.close(); }
  });

  it("files a record its approver alone reads in projects with association facts only (ADR-0049), and refuses one that names an audience or another policy", async () => {
    const db = database();
    try {
      const approver = { principal_id: "principal-approver", membership_id: "membership-approver" };
      const signal = "decision-private-0";
      const restrictedContract = sha256Digest("restricted-policy-contract");
      /** One approved record under `policy_id`, with these audience and association projects and one decision. */
      const envelopeOf = (name: string, policy_id: string, audience: readonly string[], association: readonly string[]) => ({
        record_sha256: sha256Digest(`${name}-record`),
        body: {
          schema_version: 4, kind: "echo-organization-record-envelope-v4", envelope_id: `envelope-${name}`, ...COORDINATES,
          semantic_idempotency_key: sha256Digest(`${name}-semantic`), predecessor_position: null, predecessor_record_sha256: null,
          human_act_resolution_ref: {
            ...COORDINATES, approval_id: `approval-${name}`, action: "approve", policy_id, policy_contract_sha256: restrictedContract,
            audience_project_ids: [...audience], association_project_ids: [...association],
            audit_event_id: `audit-${name}`, audit_sequence: 1, audit_entry_sha256: sha256Digest(`audit-${name}`),
            provider_action_kind: "test-private-action-v1", provider_action_schema_version: 1,
            provider_action_sha256: sha256Digest(`action-${name}`), authorization_proof_sha256: sha256Digest(`proof-${name}`),
          },
          event: { kind: "approved", approved_snapshot: { approved_payload: { brief: { decisions: [{ id: signal, kind: "decision", text: "Keep the supplier reserve." }], actions: [], rationales: [] } } } },
        },
      }) as unknown as V4RecordEnvelopeView & JsonObject;
      const projectors = (policy_id: typeof RESTRICTED_REVIEWER_PERSON_POLICY_ID | typeof ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID) => createRecordPolicyFactProjectorRegistryV1([{
        id: "test-private-action-v1",
        matches: () => true,
        // The reviewer facts are written after the association rows, so the baseline binds those rows through the envelope.
        project: ({ envelope, record_position }) => {
          const ref = envelope.body.human_act_resolution_ref;
          return {
            policy_fact_outcome: { kind: "appended", policy_id },
            facts: policy_id !== RESTRICTED_REVIEWER_PERSON_POLICY_ID ? [] : [{
              ...COORDINATES, approval_id: ref.approval_id, action: "approve", policy_id, policy_contract_sha256: restrictedContract,
              record_position, record_sha256: envelope.record_sha256, atom_order: 0, signal_id_sha256: sha256Digest(signal),
              atom_id: derivedAtomIdentity(envelope.record_sha256, signal), item_kind: "decision", audit_event_id: ref.audit_event_id,
              audit_sequence: ref.audit_sequence, audit_entry_sha256: ref.audit_entry_sha256, provider_action_sha256: ref.provider_action_sha256,
              authorization_proof_sha256: ref.authorization_proof_sha256, reviewer_principal_id: approver.principal_id, reviewer_membership_id: approver.membership_id,
            }],
          } as never;
        },
        policyBinding: () => ({ policy_id, policy_contract_sha256: restrictedContract }),
      }]);
      const append = (envelope: V4RecordEnvelopeView & JsonObject, policy_id: Parameters<typeof projectors>[0] = RESTRICTED_REVIEWER_PERSON_POLICY_ID) =>
        new OrganizationRecordAppenderV4(db, COORDINATES, projectors(policy_id)).append({
          approval_id: envelope.body.human_act_resolution_ref.approval_id, action: "approve", semantic_idempotency_key: envelope.body.semantic_idempotency_key,
          receipt_issued_at: "2026-08-21T12:02:00.000Z", authorization_witness: {},
          envelope_factory: {
            create: async (allocation) => ({ ...envelope, body: { ...envelope.body, ...allocation } }) as never,
            verify: (value) => value as V4RecordEnvelopeView & JsonObject,
          },
          receipt_factory: {
            createSeed: ({ envelope: receiptEnvelope, position, issued_at }) => ({ schema_version: 2, kind: "echo-organization-record-receipt-v2", ...COORDINATES, envelope_id: receiptEnvelope.body.envelope_id, semantic_idempotency_key: receiptEnvelope.body.semantic_idempotency_key, event_kind: "approved", record_position: position, record_sha256: receiptEnvelope.record_sha256, predecessor_record_sha256: receiptEnvelope.body.predecessor_record_sha256, record_head_position: position, record_head_sha256: receiptEnvelope.record_sha256, issued_at }),
            sign: async ({ receipt_seed }) => ({ body: receipt_seed as JsonObject }), verify: ({ receipt }) => receipt as JsonObject,
          },
        });
      const records = () => db.prepare("SELECT count(*) FROM organization_record_log").pluck().get();
      // An approver-only record that names an audience project, or a member-readable one filed in a project, is refused whole.
      await expect(append(envelopeOf("audience", RESTRICTED_REVIEWER_PERSON_POLICY_ID, ["prj_alpha"], ["prj_alpha"]))).rejects.toThrow("cannot select projects");
      await expect(append(envelopeOf("member", ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID, [], ["prj_alpha"]), ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID)).rejects.toThrow("cannot select projects");
      expect(records()).toBe(0);
      const kept = await append(envelopeOf("private", RESTRICTED_REVIEWER_PERSON_POLICY_ID, [], ["prj_alpha", "prj_beta"]));
      expect(db.prepare("SELECT project_id FROM organization_record_project_association_v1 WHERE record_position = 1 ORDER BY project_id").pluck().all()).toEqual(["prj_alpha", "prj_beta"]);
      expect(db.prepare("SELECT count(*) FROM organization_record_project_members_readable_person_record_fact").pluck().get()).toBe(0);
      expect(db.prepare("SELECT reviewer_principal_id FROM organization_record_restricted_reviewer_person_fact").pluck().all()).toEqual([approver.principal_id]);
      // Its approver reads it in each project it is filed in; another member of those projects never does, in any scope.
      const reader = new PersonRecordReaderV1(db);
      const scoped = (who: { readonly principal_id: string; readonly membership_id: string }, project_id?: string) =>
        reader.list({ ...COORDINATES, ...who, project_ids: ["prj_alpha", "prj_beta", "prj_gamma"], ...(project_id === undefined ? {} : { project_id }) }).map(row => row.record_sha256);
      for (const project_id of [undefined, "prj_alpha", "prj_beta"]) expect(scoped(approver, project_id)).toEqual([kept.record_sha256]);
      expect(scoped(approver, "prj_gamma")).toEqual([]);
      for (const project_id of [undefined, "prj_alpha", "prj_beta"]) expect(scoped({ principal_id: "principal-member", membership_id: "membership-member" }, project_id)).toEqual([]);
      // The baseline itself: a filed row needs the project its approver-only approval names, or a project audience.
      const insert = (position: number, record_sha256: string, project_id: string) =>
        db.prepare("INSERT INTO organization_record_project_association_v1 (record_position, record_sha256, project_id) VALUES (?, ?, ?)").run(position, record_sha256, project_id);
      expect(() => insert(1, kept.record_sha256, "prj_gamma")).toThrow("project association is not bound to its approved project audience or approver");
      // The snapshot carries the association on the approver's own atom, which keeps no audience.
      const snapshot = new RecordRetrievalSourceSnapshotPortV1(db).snapshot({ ...COORDINATES, policy_projectors: projectors(RESTRICTED_REVIEWER_PERSON_POLICY_ID),
        verify_envelope: (value) => value as RecordRetrievalSourceVerifiedEnvelopeV1 });
      expect(snapshot.atoms).toMatchObject([{ policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID, reviewer_principal_id: approver.principal_id, audience_project_ids: [], association_project_ids: ["prj_alpha", "prj_beta"] }]);
      // A member-readable record is never filed in a project it has no audience in.
      const member = await append(envelopeOf("member-unfiled", ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID, [], []), ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID);
      expect(() => insert(2, member.record_sha256, "prj_alpha")).toThrow("project association is not bound to its approved project audience or approver");
    } finally { db.close(); }
  });

  it("uses the same append and retrieval-source path with a non-Slack policy projector", async () => {
    const db = database();
    try {
      const semantic = sha256Digest("synthetic-projector-semantic-key");
      const envelope: V4RecordEnvelopeView & JsonObject = {
        record_sha256: sha256Digest("synthetic-projector-record"),
        body: {
          schema_version: 4,
          kind: "echo-organization-record-envelope-v4",
          envelope_id: "envelope-synthetic-projector",
          ...COORDINATES,
          semantic_idempotency_key: semantic,
          predecessor_position: null,
          predecessor_record_sha256: null,
          human_act_resolution_ref: {
            kind: "test-local-approval-v1",
            ...COORDINATES,
            approval_id: "approval-synthetic-projector",
            action: "approve",
            audit_event_id: "audit-synthetic-projector",
            audit_sequence: 1,
            audit_entry_sha256: sha256Digest("audit-synthetic-projector"),
            provider_action_kind: "test-local-action-v1",
            provider_action_schema_version: 1,
            provider_action_sha256: sha256Digest("action-synthetic-projector"),
            authorization_proof_sha256: sha256Digest("proof-synthetic-projector"),
          },
          event: {
            kind: "approved",
            approved_snapshot: {
              approved_payload: {
                brief: { decisions: [], actions: [], rationales: [] },
              },
            },
          },
        },
      } as V4RecordEnvelopeView & JsonObject;
      const fakeProjector: RecordPolicyFactProjectorV1 = {
        id: "test-local-approval-v1",
        matches: (candidate) =>
          (candidate.body.human_act_resolution_ref as { readonly kind?: unknown })
            .kind ===
          "test-local-approval-v1",
        project: () => ({
          facts: [],
          policy_fact_outcome: {
            kind: "appended",
            policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
          },
        }),
        policyBinding: () => ({
          policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
          policy_contract_sha256:
            organizationMemberReadablePersonPolicyContractSha256(),
        }),
      };
      const projectors = createRecordPolicyFactProjectorRegistryV1([
        fakeProjector,
      ]);
      const app = new OrganizationRecordAppenderV4(
        db,
        COORDINATES,
        projectors,
      );
      await app.append({
        approval_id: "approval-synthetic-projector",
        action: "approve",
        semantic_idempotency_key: semantic,
        receipt_issued_at: "2026-08-21T12:02:00.000Z",
        authorization_witness: { test: true },
        envelope_factory: {
          create: async () => envelope,
          verify: () => envelope,
        },
        receipt_factory: {
          createSeed: ({ envelope: receiptEnvelope, position, issued_at }) => ({
            schema_version: 2,
            kind: "echo-organization-record-receipt-v2",
            authority_id: COORDINATES.authority_id,
            organization_id: COORDINATES.organization_id,
            state_lineage_id: COORDINATES.state_lineage_id,
            envelope_id: receiptEnvelope.body.envelope_id,
            semantic_idempotency_key:
              receiptEnvelope.body.semantic_idempotency_key,
            event_kind: receiptEnvelope.body.event.kind,
            record_position: position,
            record_sha256: receiptEnvelope.record_sha256,
            predecessor_record_sha256:
              receiptEnvelope.body.predecessor_record_sha256,
            record_head_position: position,
            record_head_sha256: receiptEnvelope.record_sha256,
            issued_at,
          }),
          sign: async ({ receipt_seed }) => ({
            body: receipt_seed as JsonObject,
          }),
          verify: ({ receipt }) => receipt as JsonObject,
        },
      });
      const snapshot = new RecordRetrievalSourceSnapshotPortV1(db).snapshot({
        ...COORDINATES,
        policy_projectors: projectors,
        verify_envelope: () =>
          envelope as RecordRetrievalSourceVerifiedEnvelopeV1,
      });
      expect(snapshot.rows[0]?.classification).toEqual({
        kind: "approved",
        policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
        atom_count: 0,
      });
    } finally {
      db.close();
    }
  });

  it("uses real V4 and Receipt V2 verification before persisting approval facts", async () => {
    const db = database();
    try {
      const authority = protocolAuthority();
      const app = new OrganizationRecordAppenderV4(db, COORDINATES);
      const result = await app.append(
        appendInput({
          authority,
          signal_count: 11,
          policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
        }),
      );
      expect(result).toMatchObject({ outcome: "appended", position: 1 });
      const row = db
        .prepare(
          `SELECT canonical_envelope, envelope_sha256, record_sha256, receipt_payload FROM organization_record_log WHERE position = 1`,
        )
        .get() as {
        canonical_envelope: string;
        envelope_sha256: Sha256Digest;
        record_sha256: Sha256Digest;
        receipt_payload: string;
      };
      expect(row.envelope_sha256).toBe(sha256Digest(row.canonical_envelope));
      expect(row.envelope_sha256).not.toBe(row.record_sha256);
      expect(canonicalJson(result.receipt.body as JsonObject)).toBe(
        row.receipt_payload,
      );
      expect(
        db
          .prepare(
            "SELECT atom_order FROM organization_record_member_readable_person_fact ORDER BY atom_order",
          )
          .all(),
      ).toEqual(
        Array.from({ length: 11 }, (_, atom_order) => ({ atom_order })),
      );
    } finally {
      db.close();
    }
  });

  it("commits a real rejected V4 record without Person facts", async () => {
    const db = database();
    try {
      const authority = protocolAuthority();
      const app = new OrganizationRecordAppenderV4(db, COORDINATES);
      expect(
        (
          await app.append(
            appendInput({
              authority,
              approval_id: "approval-rejected",
              action: "reject",
            }),
          )
        ).outcome,
      ).toBe("appended");
      expect(
        db
          .prepare(
            "SELECT count(*) AS count FROM organization_record_member_readable_person_fact",
          )
          .get(),
      ).toEqual({ count: 0 });
      expect(
        db
          .prepare(
            "SELECT count(*) AS count FROM organization_record_restricted_reviewer_person_fact",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("releases approved records only through a matching current Person fact", async () => {
    const db = database();
    try {
      const authority = protocolAuthority();
      const app = new OrganizationRecordAppenderV4(db, COORDINATES);
      const approved = appendInput({
        authority,
        approval_id: "approval-reader",
        policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID,
      });
      const first = await app.append(approved);
      await app.append(
        appendInput({
          authority,
          approval_id: "approval-reader-rejected",
          action: "reject",
        }),
      );
      const reader = new PersonRecordReaderV1(db);
      expect(
        reader.list({
          ...COORDINATES,
          principal_id: "principal-1",
          membership_id: "membership-1",
        }),
      ).toMatchObject([
        {
          position: 1,
          approval_id: "approval-reader",
          record_sha256: first.record_sha256,
        },
      ]);
      expect(
        reader.list({
          ...COORDINATES,
          principal_id: "principal-other",
          membership_id: "membership-other",
        }),
      ).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("finds an old readable record by digest without widening restricted or missing reads", async () => {
    const db = database();
    try {
      const authority = protocolAuthority();
      const app = new OrganizationRecordAppenderV4(db, COORDINATES);
      const oldest = await app.append(
        appendInput({
          authority,
          approval_id: "approval-exact-page-0",
          policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
        }),
      );
      // Unsigned member-readable filler pushes the oldest record past a full page.
      const unsignedReceipt: V4ReceiptFactory = {
        ...receiptFactory(authority, { sign_calls: { value: 0 } }),
        sign: async ({ receipt_seed }) => ({ body: receipt_seed }),
        verify: ({ receipt }) => receipt as JsonObject,
      };
      for (let index = 1; index < 101; index += 1) {
        const approval_id = `approval-exact-page-${index}`;
        const human = humanAct(approval_id, "approve", ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID, 1);
        await app.append({
          approval_id,
          action: "approve",
          semantic_idempotency_key: human.semantic_idempotency_key,
          receipt_issued_at: "2026-08-21T12:02:00.000Z",
          authorization_witness: authorizationWitness(human),
          envelope_factory: {
            create: async (allocation) => ({
              record_sha256: sha256Digest(approval_id),
              body: {
                schema_version: 4, kind: "echo-organization-record-envelope-v4",
                envelope_id: `envelope-${approval_id}`, ...COORDINATES,
                semantic_idempotency_key: human.semantic_idempotency_key,
                predecessor_position: allocation.predecessor_position,
                predecessor_record_sha256: allocation.predecessor_record_sha256,
                human_act_resolution_ref: human.human_act_resolution_ref,
                event: human.event,
              },
            }) as unknown as JsonObject,
            verify: (value) => value as V4RecordEnvelopeView & JsonObject,
          },
          receipt_factory: unsignedReceipt,
        });
      }
      const restricted = await app.append(
        appendInput({
          authority,
          approval_id: "approval-exact-restricted",
          policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID,
        }),
      );
      const reader = new PersonRecordReaderV1(db);
      const readerInput = {
        ...COORDINATES,
        principal_id: "principal-other",
        membership_id: "membership-other",
      };
      expect(reader.list({ ...readerInput, limit: 100 }).map((r) => r.position)).not.toContain(1);
      expect(reader.list({
        ...readerInput,
        principal_id: "principal-1",
        membership_id: "membership-1",
        record_sha256: oldest.record_sha256,
      })).toMatchObject([{ position: 1, record_sha256: oldest.record_sha256 }]);
      expect(reader.list({ ...readerInput, record_sha256: restricted.record_sha256 })).toEqual([]);
      expect(reader.list({ ...readerInput, record_sha256: sha256Digest("missing-exact-record") })).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("materializes a verified dense retrieval-source snapshot for both person policies", async () => {
    const db = database();
    try {
      const authority = protocolAuthority();
      const app = new OrganizationRecordAppenderV4(db, COORDINATES);
      const member = await app.append(
        appendInput({
          authority,
          approval_id: "approval-member-snapshot",
          policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
          signal_counts: { decisions: 1, actions: 1, rationales: 1 },
        }),
      );
      const restricted = await app.append(
        appendInput({
          authority,
          approval_id: "approval-reviewer-snapshot",
          policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID,
        }),
      );
      const rejected = await app.append(
        appendInput({
          authority,
          approval_id: "approval-rejected-snapshot",
          action: "reject",
        }),
      );
      const snapshot = new RecordRetrievalSourceSnapshotPortV1(db).snapshot({
        ...COORDINATES,
        verify_envelope: (value) =>
          verifyOrganizationRecordEnvelopeV4(
            value,
            authority.pinned,
            COORDINATES.state_lineage_id, RECORD_INPUT_CODECS,
          ) as unknown as RecordRetrievalSourceVerifiedEnvelopeV1,
      });

      expect(snapshot.head).toEqual({
        position: 3,
        record_sha256: rejected.record_sha256,
      });
      expect(snapshot.rows).toMatchObject([
        {
          position: 1,
          record_sha256: member.record_sha256,
          classification: {
            kind: "approved",
            policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
            atom_count: 3,
          },
        },
        {
          position: 2,
          record_sha256: restricted.record_sha256,
          classification: {
            kind: "approved",
            policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID,
            atom_count: 1,
          },
        },
        {
          position: 3,
          classification: { kind: "rejected" },
        },
      ]);
      expect(snapshot.atoms.map((atom) => atom.text)).toEqual([
        "Decision 0",
        "Action 0",
        "Rationale 0",
        "Decision 0",
      ]);
      expect(
        snapshot.atoms
          .slice(0, 3)
          .every(
            (atom) =>
              atom.reviewer_principal_id === null &&
              atom.reviewer_membership_id === null &&
              atom.provider_action_sha256.startsWith("sha256:") &&
              atom.authorization_proof_sha256.startsWith("sha256:"),
          ),
      ).toBe(true);
      expect(snapshot.atoms[3]).toMatchObject({
        reviewer_principal_id: "principal-1",
        reviewer_membership_id: "membership-1",
      });
      expect(snapshot.upstream_input_sha256).toBe(
        sha256Digest(snapshot.upstream_input_preimage),
      );
    } finally {
      db.close();
    }
  });

  it("rejects a tampered append-atomic Person fact during a V4 snapshot", async () => {
    const db = database();
    try {
      const authority = protocolAuthority();
      const app = new OrganizationRecordAppenderV4(db, COORDINATES);
      await app.append(
        appendInput({
          authority,
          policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
        }),
      );
      db.exec(
        "DROP TRIGGER organization_record_member_readable_person_fact_immutable_update",
      );
      db.prepare(
        `UPDATE organization_record_member_readable_person_fact
            SET provider_action_sha256 = ? WHERE record_position = 1`,
      ).run(sha256Digest("tampered-provider-action"));
      expect(() =>
        new RecordRetrievalSourceSnapshotPortV1(db).snapshot({
          ...COORDINATES,
          verify_envelope: (value) =>
            verifyOrganizationRecordEnvelopeV4(
              value,
              authority.pinned,
              COORDINATES.state_lineage_id, RECORD_INPUT_CODECS,
            ) as unknown as RecordRetrievalSourceVerifiedEnvelopeV1,
        }),
      ).toThrow("provider action digest");
    } finally {
      db.close();
    }
  });

  it("returns an exact retry without creating another signed V4 envelope or receipt", async () => {
    const db = database();
    try {
      const authority = protocolAuthority();
      const app = new OrganizationRecordAppenderV4(db, COORDINATES);
      const envelope_calls = { value: 0 };
      const sign_calls = { value: 0 };
      const input = appendInput({
        authority,
        envelope_calls,
        receipt: receiptFactory(authority, { sign_calls }),
      });
      const first = await app.append(input);
      expect(await app.append(input)).toEqual({
        ...first,
        outcome: "duplicate",
      });
      expect(envelope_calls.value).toBe(1);
      expect(sign_calls.value).toBe(1);
    } finally {
      db.close();
    }
  });

  it("rejects a reused semantic key before another V4 envelope is created", async () => {
    const db = database();
    try {
      const authority = protocolAuthority();
      const app = new OrganizationRecordAppenderV4(db, COORDINATES);
      const first = appendInput({ authority });
      await app.append(first);
      const calls = { value: 0 };
      await expect(
        app.append(
          appendInput({
            authority,
            approval_id: "other-approval",
            semantic_idempotency_key: first.semantic_idempotency_key,
            envelope_calls: calls,
          }),
        ),
      ).rejects.toBeInstanceOf(V4RecordIdempotencyConflictError);
      expect(calls.value).toBe(0);
    } finally {
      db.close();
    }
  });

  it("recovers a real Receipt V2 after signer failure without another record or seed", async () => {
    const db = database();
    try {
      const authority = protocolAuthority();
      const app = new OrganizationRecordAppenderV4(db, COORDINATES);
      const input = appendInput({
        authority,
        receipt: receiptFactory(authority, {
          sign_calls: { value: 0 },
          fail_sign: true,
        }),
      });
      await expect(app.append(input)).rejects.toThrow(
        "signer stopped after append commit",
      );
      const committed = db
        .prepare(
          "SELECT receipt_payload FROM organization_record_log WHERE position = 1",
        )
        .get() as { receipt_payload: string };
      const recovered = await new OrganizationRecordAppenderV4(
        db,
        COORDINATES,
      ).append(appendInput({ authority }));
      expect(recovered.outcome).toBe("duplicate");
      expect(canonicalJson(recovered.receipt.body as JsonObject)).toBe(
        committed.receipt_payload,
      );
      expect(
        db
          .prepare("SELECT count(*) AS count FROM organization_record_log")
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it("rejects a malformed pre-stored receipt instead of returning it on recovery", async () => {
    const db = database();
    try {
      const authority = protocolAuthority();
      const app = new OrganizationRecordAppenderV4(db, COORDINATES);
      const input = appendInput({
        authority,
        receipt: receiptFactory(authority, {
          sign_calls: { value: 0 },
          fail_sign: true,
        }),
      });
      await expect(app.append(input)).rejects.toThrow(
        "signer stopped after append commit",
      );
      db.prepare(
        `INSERT INTO organization_record_signed_receipt (position, signed_receipt, materialized_at) VALUES (1, ?, '2026-08-21T12:03:00.000Z')`,
      ).run('{"body":{}}');
      await expect(
        new OrganizationRecordAppenderV4(db, COORDINATES).append(
          appendInput({ authority }),
        ),
      ).rejects.toThrow();
    } finally {
      db.close();
    }
  });

  it("rejects a valid Receipt V2 that differs from the committed deterministic seed", async () => {
    const db = database();
    try {
      const authority = protocolAuthority();
      const app = new OrganizationRecordAppenderV4(db, COORDINATES);
      const input = appendInput({
        authority,
        receipt: receiptFactory(authority, {
          sign_calls: { value: 0 },
          fail_sign: true,
        }),
      });
      await expect(app.append(input)).rejects.toThrow(
        "signer stopped after append commit",
      );
      const row = db
        .prepare(
          "SELECT canonical_envelope FROM organization_record_log WHERE position = 1",
        )
        .get() as { canonical_envelope: string };
      const wrongSeedReceipt = await createOrganizationRecordReceiptV2(
        {
          envelope: parseCanonicalJson(row.canonical_envelope) as never,
          record_position: 1,
          issued_at: "2026-08-21T12:04:00.000Z",
        },
        authority.pinned,
        COORDINATES.state_lineage_id,
        authority.sign, RECORD_INPUT_CODECS,
      );
      db.prepare(
        `INSERT INTO organization_record_signed_receipt (position, signed_receipt, materialized_at)
        VALUES (1, ?, '2026-08-21T12:04:00.000Z')`,
      ).run(canonicalJson(wrongSeedReceipt));
      await expect(
        new OrganizationRecordAppenderV4(db, COORDINATES).append(
          appendInput({ authority }),
        ),
      ).rejects.toThrow("committed receipt seed");
    } finally {
      db.close();
    }
  });
});
