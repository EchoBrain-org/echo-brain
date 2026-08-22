import {
  canonicalJson,
  parseCanonicalJson,
  sha256Digest,
} from "@echo-brain/federation-protocol";
import type { JsonObject, Sha256Digest } from "@echo-brain/federation-protocol";
import type Database from "better-sqlite3";
import {
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
  projectPersonPolicyFactsV2,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  type ReprovedPersonPolicyD2WitnessV2,
  type PersonHumanActResolutionRefV1View,
  type PersonPolicyEventV4View,
  type StructurallyVerifiedPersonPolicyRecordV4View,
} from "../application/person-policy-facts-v2.js";

type Action = "approve" | "reject";
type EventKind = "approved" | "rejected";

export interface V4RecordEnvelopeView {
  readonly body: {
    readonly envelope_id: string;
    readonly authority_id: string;
    readonly organization_id: string;
    readonly state_lineage_id: string;
    readonly semantic_idempotency_key: Sha256Digest;
    readonly predecessor_position: number | null;
    readonly predecessor_record_sha256: Sha256Digest | null;
    /** Full V4 values may carry more fields; only this structural D3 view is read. */
    readonly human_act_resolution_ref: PersonHumanActResolutionRefV1View;
    readonly event: PersonPolicyEventV4View;
  };
  readonly record_sha256: Sha256Digest;
}

export interface V4RecordEnvelopeFactory {
  /** Creates the complete protocol-owned V4 envelope. */
  create(input: {
    readonly position: number;
    readonly predecessor_position: number | null;
    readonly predecessor_record_sha256: Sha256Digest | null;
  }): Promise<JsonObject>;
  /** Must be backed by the organization-protocol V4 verifier at composition. */
  verify(value: unknown): V4RecordEnvelopeView & JsonObject;
}

export interface V4ReceiptFactory {
  /** Builds the unsigned, deterministic Receipt V2 body that is committed with the record. */
  createSeed(input: {
    readonly envelope: V4RecordEnvelopeView & JsonObject;
    readonly position: number;
    readonly issued_at: string;
    readonly policy_fact_outcome:
      | { readonly kind: "none" }
      | {
          readonly kind: "appended";
          readonly policy_id:
            | typeof RESTRICTED_REVIEWER_PERSON_POLICY_ID
            | typeof ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID;
        };
  }): JsonObject;
  /** Signs a Receipt V2 wrapper for the exact committed seed. */
  sign(input: {
    readonly envelope: V4RecordEnvelopeView & JsonObject;
    readonly receipt_seed: JsonObject;
  }): Promise<JsonObject>;
  /** Must be backed by the organization-protocol Receipt V2 verifier at composition. */
  verify(input: {
    readonly receipt: unknown;
    readonly envelope: V4RecordEnvelopeView & JsonObject;
  }): JsonObject;
}

export interface AppendV4RecordInput {
  readonly approval_id: string;
  readonly action: Action;
  readonly semantic_idempotency_key: Sha256Digest;
  readonly receipt_issued_at: string;
  readonly d2_witness: ReprovedPersonPolicyD2WitnessV2;
  readonly envelope_factory: V4RecordEnvelopeFactory;
  readonly receipt_factory: V4ReceiptFactory;
}

export interface AppendedV4Record {
  readonly outcome: "appended" | "duplicate";
  readonly position: number;
  readonly envelope_id: string;
  readonly envelope_sha256: Sha256Digest;
  readonly record_sha256: Sha256Digest;
  readonly receipt: JsonObject;
}

interface StoredRecord {
  readonly position: number;
  readonly envelope_id: string;
  readonly event_kind: EventKind;
  readonly approval_id: string;
  readonly action: Action;
  readonly semantic_idempotency_key: Sha256Digest;
  readonly canonical_envelope: string;
  readonly envelope_sha256: Sha256Digest;
  readonly record_sha256: Sha256Digest;
  readonly receipt_payload: string;
}

class V4RecordIdempotencyConflictError extends Error {
  constructor() {
    super(
      "organization record V4 semantic idempotency key was reused with different input",
    );
    this.name = "V4RecordIdempotencyConflictError";
  }
}

function asObject(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function eventForAction(action: Action): EventKind {
  return action === "approve" ? "approved" : "rejected";
}

/**
 * Private new-lineage append application. Protocol validation/signing stays at
 * the Authority boundary; this module owns only log serialization, durable
 * seed storage, and the D3 projector's append-atomic persistence.
 */
export class OrganizationRecordV4AppendApplication {
  private appendTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly database: Database.Database,
    private readonly coordinates: {
      readonly authority_id: string;
      readonly organization_id: string;
      readonly state_lineage_id: string;
    },
  ) {
    const metadata = database
      .prepare(
        `SELECT authority_id, organization_id, state_lineage_id
           FROM organization_record_log_metadata WHERE singleton = 1`,
      )
      .get() as
      | {
          readonly authority_id: string;
          readonly organization_id: string;
          readonly state_lineage_id: string;
        }
      | undefined;
    if (
      metadata === undefined ||
      metadata.authority_id !== coordinates.authority_id ||
      metadata.organization_id !== coordinates.organization_id ||
      metadata.state_lineage_id !== coordinates.state_lineage_id
    ) {
      throw new Error(
        "organization record V4 log metadata does not match its coordinates",
      );
    }
  }

  append(input: AppendV4RecordInput): Promise<AppendedV4Record> {
    const appended = this.appendTail.then(() => this.appendSerialized(input));
    this.appendTail = appended.then(
      () => undefined,
      () => undefined,
    );
    return appended;
  }

  private async appendSerialized(
    input: AppendV4RecordInput,
  ): Promise<AppendedV4Record> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database
        .prepare(
          `SELECT position, envelope_id, event_kind, approval_id, action,
                  semantic_idempotency_key, canonical_envelope, envelope_sha256,
                  record_sha256, receipt_payload
             FROM organization_record_log WHERE approval_id = ? AND action = ?`,
        )
        .get(input.approval_id, input.action) as StoredRecord | undefined;
      if (existing !== undefined) {
        if (
          existing.semantic_idempotency_key !== input.semantic_idempotency_key
        ) {
          throw new V4RecordIdempotencyConflictError();
        }
        this.database.exec("COMMIT");
        return await this.withReceipt(
          existing,
          input.receipt_factory,
          "duplicate",
        );
      }
      const semanticExisting = this.database
        .prepare(
          `SELECT position FROM organization_record_log
             WHERE semantic_idempotency_key = ?`,
        )
        .get(input.semantic_idempotency_key) as
        { readonly position: number } | undefined;
      if (semanticExisting !== undefined) {
        throw new V4RecordIdempotencyConflictError();
      }

      const head = this.database
        .prepare(
          `SELECT position, record_sha256 FROM organization_record_log
           ORDER BY position DESC LIMIT 1`,
        )
        .get() as
        | { readonly position: number; readonly record_sha256: Sha256Digest }
        | undefined;
      const position = (head?.position ?? 0) + 1;
      const predecessor_position = head?.position ?? null;
      const predecessor_record_sha256 = head?.record_sha256 ?? null;
      const envelope = input.envelope_factory.verify(
        await input.envelope_factory.create({
          position,
          predecessor_position,
          predecessor_record_sha256,
        }),
      );
      this.assertEnvelope(
        envelope,
        input,
        position,
        predecessor_position,
        predecessor_record_sha256,
      );
      const canonical_envelope = canonicalJson(envelope);
      const envelope_sha256 = sha256Digest(canonical_envelope);
      const projected = projectPersonPolicyFactsV2({
        envelope: this.personPolicyView(envelope),
        record_position: position,
        witness: input.d2_witness,
      });
      const receipt_seed = input.receipt_factory.createSeed({
        envelope,
        position,
        issued_at: input.receipt_issued_at,
        policy_fact_outcome: projected.policy_fact_outcome,
      });
      const receipt_payload = canonicalJson(receipt_seed);
      this.insertRecord({
        position,
        input,
        envelope,
        canonical_envelope,
        envelope_sha256,
        predecessor_position,
        predecessor_record_sha256,
        receipt_payload,
      });
      this.insertFacts(projected.facts);
      this.database.exec("COMMIT");
      return await this.withReceipt(
        {
          position,
          envelope_id: envelope.body.envelope_id,
          event_kind: envelope.body.event.kind,
          approval_id: input.approval_id,
          action: input.action,
          semantic_idempotency_key: input.semantic_idempotency_key,
          canonical_envelope,
          envelope_sha256,
          record_sha256: envelope.record_sha256,
          receipt_payload,
        },
        input.receipt_factory,
        "appended",
      );
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  private assertEnvelope(
    envelope: V4RecordEnvelopeView,
    input: AppendV4RecordInput,
    position: number,
    predecessor_position: number | null,
    predecessor_record_sha256: Sha256Digest | null,
  ): void {
    const body = envelope.body;
    if (
      body.authority_id !== this.coordinates.authority_id ||
      body.organization_id !== this.coordinates.organization_id ||
      body.state_lineage_id !== this.coordinates.state_lineage_id ||
      body.semantic_idempotency_key !== input.semantic_idempotency_key ||
      body.human_act_resolution_ref.approval_id !== input.approval_id ||
      body.human_act_resolution_ref.action !== input.action ||
      body.event.kind !== eventForAction(input.action) ||
      body.predecessor_position !== predecessor_position ||
      body.predecessor_record_sha256 !== predecessor_record_sha256 ||
      position < 1
    ) {
      throw new Error(
        "created V4 record envelope does not match its append allocation",
      );
    }
  }

  private insertRecord(input: {
    readonly position: number;
    readonly input: AppendV4RecordInput;
    readonly envelope: V4RecordEnvelopeView & JsonObject;
    readonly canonical_envelope: string;
    readonly envelope_sha256: Sha256Digest;
    readonly predecessor_position: number | null;
    readonly predecessor_record_sha256: Sha256Digest | null;
    readonly receipt_payload: string;
  }): void {
    this.database
      .prepare(
        `INSERT INTO organization_record_log (
           position, envelope_id, event_kind, approval_id, action,
           semantic_idempotency_key, canonical_envelope, envelope_sha256,
           predecessor_position, predecessor_record_sha256, record_sha256,
           receipt_payload, receipt_issued_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.position,
        input.envelope.body.envelope_id,
        input.envelope.body.event.kind,
        input.input.approval_id,
        input.input.action,
        input.input.semantic_idempotency_key,
        input.canonical_envelope,
        input.envelope_sha256,
        input.predecessor_position,
        input.predecessor_record_sha256,
        input.envelope.record_sha256,
        input.receipt_payload,
        input.input.receipt_issued_at,
      );
  }

  /**
   * The protocol V4 body deliberately contains more durable commitments than
   * the D3 Person projector reads. Copy exactly that projector's structural
   * view so its strict shape validation remains meaningful.
   */
  private personPolicyView(
    envelope: V4RecordEnvelopeView,
  ): StructurallyVerifiedPersonPolicyRecordV4View {
    const reference = envelope.body.human_act_resolution_ref;
    const human_act_resolution_ref: PersonHumanActResolutionRefV1View = {
      authority_id: reference.authority_id,
      organization_id: reference.organization_id,
      state_lineage_id: reference.state_lineage_id,
      approval_id: reference.approval_id,
      action: reference.action,
      policy_id: reference.policy_id,
      policy_contract_sha256: reference.policy_contract_sha256,
      audit_event_id: reference.audit_event_id,
      audit_sequence: reference.audit_sequence,
      audit_entry_sha256: reference.audit_entry_sha256,
      provider_action_kind: reference.provider_action_kind,
      provider_action_schema_version: reference.provider_action_schema_version,
      provider_action_sha256: reference.provider_action_sha256,
      authorization_proof_sha256: reference.authorization_proof_sha256,
    };
    const event = envelope.body.event;
    const projectedEvent: PersonPolicyEventV4View =
      event.kind === "rejected"
        ? { kind: "rejected" }
        : {
            kind: "approved",
            approved_snapshot: {
              approved_payload: {
                brief: {
                  decisions:
                    event.approved_snapshot.approved_payload.brief.decisions.map(
                      (signal) => ({ id: signal.id, kind: signal.kind }),
                    ),
                  actions:
                    event.approved_snapshot.approved_payload.brief.actions.map(
                      (signal) => ({ id: signal.id, kind: signal.kind }),
                    ),
                  rationales:
                    event.approved_snapshot.approved_payload.brief.rationales.map(
                      (signal) => ({ id: signal.id, kind: signal.kind }),
                    ),
                },
              },
            },
          };
    return {
      record_sha256: envelope.record_sha256,
      body: {
        authority_id: envelope.body.authority_id,
        organization_id: envelope.body.organization_id,
        state_lineage_id: envelope.body.state_lineage_id,
        human_act_resolution_ref,
        event: projectedEvent,
      },
    };
  }

  private insertFacts(
    facts: ReturnType<typeof projectPersonPolicyFactsV2>["facts"],
  ): void {
    for (const fact of facts) {
      const common = [
        fact.authority_id,
        fact.organization_id,
        fact.state_lineage_id,
        fact.approval_id,
        fact.action,
        fact.policy_id,
        fact.policy_contract_sha256,
        fact.record_position,
        fact.record_sha256,
        fact.atom_order,
        fact.signal_id_sha256,
        fact.atom_id,
        fact.item_kind,
        fact.audit_event_id,
        fact.audit_sequence,
        fact.audit_entry_sha256,
        fact.provider_action_sha256,
        fact.authorization_proof_sha256,
      ];
      if (fact.policy_id === RESTRICTED_REVIEWER_PERSON_POLICY_ID) {
        this.database
          .prepare(
            `INSERT INTO organization_record_restricted_reviewer_person_fact (
             authority_id, organization_id, state_lineage_id, approval_id, action,
             policy_id, policy_contract_sha256, record_position, record_sha256,
             atom_order, signal_id_sha256, atom_id, item_kind, audit_event_id,
             audit_sequence, audit_entry_sha256, provider_action_sha256,
             authorization_proof_sha256, reviewer_principal_id, reviewer_membership_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            ...common,
            fact.reviewer_principal_id,
            fact.reviewer_membership_id,
          );
      } else {
        this.database
          .prepare(
            `INSERT INTO organization_record_member_readable_person_fact (
             authority_id, organization_id, state_lineage_id, approval_id, action,
             policy_id, policy_contract_sha256, record_position, record_sha256,
             atom_order, signal_id_sha256, atom_id, item_kind, audit_event_id,
             audit_sequence, audit_entry_sha256, provider_action_sha256,
             authorization_proof_sha256
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(...common);
      }
    }
  }

  private async withReceipt(
    row: StoredRecord,
    receiptFactory: V4ReceiptFactory,
    outcome: AppendedV4Record["outcome"],
  ): Promise<AppendedV4Record> {
    const stored = this.database
      .prepare(
        "SELECT signed_receipt FROM organization_record_signed_receipt WHERE position = ?",
      )
      .get(row.position) as { readonly signed_receipt: string } | undefined;
    const envelope = asObject(
      parseCanonicalJson(row.canonical_envelope),
      "stored V4 envelope",
    ) as V4RecordEnvelopeView & JsonObject;
    const seed = asObject(
      parseCanonicalJson(row.receipt_payload),
      "stored Receipt V2 seed",
    );
    let receipt: JsonObject;
    if (stored === undefined) {
      const signed = await receiptFactory.sign({
        envelope,
        receipt_seed: seed,
      });
      receipt = receiptFactory.verify({ receipt: signed, envelope });
      const body = asObject(receipt.body, "signed Receipt V2 body");
      if (canonicalJson(body) !== row.receipt_payload) {
        throw new Error(
          "signed Receipt V2 does not bind the committed receipt seed",
        );
      }
      this.database
        .prepare(
          `INSERT INTO organization_record_signed_receipt (
             position, signed_receipt, materialized_at
           ) VALUES (?, ?, ?)
           ON CONFLICT (position) DO NOTHING`,
        )
        .run(row.position, canonicalJson(receipt), new Date().toISOString());
      const winner = this.database
        .prepare(
          "SELECT signed_receipt FROM organization_record_signed_receipt WHERE position = ?",
        )
        .get(row.position) as { readonly signed_receipt: string } | undefined;
      if (winner === undefined)
        throw new Error("signed Receipt V2 was not stored");
      receipt = receiptFactory.verify({
        receipt: parseCanonicalJson(winner.signed_receipt),
        envelope,
      });
    } else {
      receipt = receiptFactory.verify({
        receipt: parseCanonicalJson(stored.signed_receipt),
        envelope,
      });
    }
    if (
      canonicalJson(asObject(receipt.body, "verified Receipt V2 body")) !==
      row.receipt_payload
    ) {
      throw new Error(
        "verified Receipt V2 does not bind the committed receipt seed",
      );
    }
    return Object.freeze({
      outcome,
      position: row.position,
      envelope_id: row.envelope_id,
      envelope_sha256: row.envelope_sha256,
      record_sha256: row.record_sha256,
      receipt,
    });
  }
}

export { V4RecordIdempotencyConflictError };
