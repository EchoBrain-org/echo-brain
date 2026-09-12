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
  RESTRICTED_REVIEWER_PERSON_POLICY_ID
} from "../src/application/person-policy-fact-contracts-v2.js";
import {
  createRecordPolicyFactProjectorRegistryV1,
  type RecordPolicyFactProjectorV1,
} from "../src/application/record-policy-fact-projection-v1.js";
import {
  OrganizationRecordAppenderV4,
  V4RecordIdempotencyConflictError,
  type V4RecordEnvelopeView
} from "../src/log/record-log-v4-append.js";
import { PersonRecordReaderV1 } from "../src/retrieve/person-record-reader-v1.js";
import {
  RecordRetrievalSourceSnapshotPortV1,
  type RecordRetrievalSourceVerifiedEnvelopeV1,
} from "../src/retrieve/record-retrieval-source-snapshot-v1.js";
import { COORDINATES, RECORD_INPUT_CODECS, appendInput, database, protocolAuthority, receiptFactory } from './fixtures/record-append-fixture.js';

describe("V4 organization-record append", () => {
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
      expect(await app.append(approved)).toMatchObject({
        outcome: "duplicate",
        position: first.position,
      });
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
      let oldest: { readonly record_sha256: Sha256Digest } | undefined;
      for (let index = 0; index < 101; index += 1) {
        const appended = await app.append(
          appendInput({
            authority,
            approval_id: `approval-exact-page-${index}`,
            policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
          }),
        );
        if (index === 0) oldest = appended;
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
      expect(oldest).toBeDefined();
      expect(reader.list({
        ...readerInput,
        principal_id: "principal-1",
        membership_id: "membership-1",
        record_sha256: oldest!.record_sha256,
      })).toMatchObject([{ position: 1, record_sha256: oldest!.record_sha256 }]);
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
