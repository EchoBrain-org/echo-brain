import {
  canonicalJson,
  parseCanonicalJson,
  sha256Digest,
} from "@echo-brain/federation-protocol";
import type { JsonObject, Sha256Digest } from "@echo-brain/federation-protocol";
import type Database from "better-sqlite3";
import {
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  createPersonPolicyFactProjectorV2,
  type PersonPolicyFactItemKindV2,
  type PersonPolicyIdV2,
} from "../application/person-policy-facts-v2.js";
import { derivedAtomIdentity } from "../application/atom-identity.js";
import {
  createRecordPolicyFactProjectorRegistryV1,
  type RecordPolicyFactEnvelopeV1,
  type RecordPolicyFactProjectorRegistryV1,
} from "../application/record-policy-fact-projection-v1.js";

type RecordEventKind = "approved" | "rejected";
type RecordAction = "approve" | "reject";

/**
 * The protocol-owned verifier is deliberately injected by Authority
 * composition. This workspace verifies no signatures and imports no durable
 * Organization Protocol shape; it only reads the already-proved V4 view.
 */
export interface RecordRetrievalSourceVerifiedEnvelopeV1
  extends RecordPolicyFactEnvelopeV1 {
  readonly body: RecordPolicyFactEnvelopeV1["body"] & {
    readonly event:
      | {
          readonly kind: "approved";
          readonly approved_snapshot: {
            readonly approved_payload: {
              readonly brief: {
                readonly decisions: readonly RecordRetrievalSourceSignalV1[];
                readonly actions: readonly RecordRetrievalSourceSignalV1[];
                readonly rationales: readonly RecordRetrievalSourceSignalV1[];
              };
            };
          };
        }
      | { readonly kind: "rejected" };
  };
}

export interface RecordRetrievalSourceSignalV1 {
  readonly id: string;
  readonly kind: PersonPolicyFactItemKindV2;
  readonly text: string;
}

export interface RecordRetrievalSourceSnapshotInputV1 {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  /** Must invoke the protocol's signature and V4 schema verifier. */
  readonly verify_envelope: (value: unknown) => RecordRetrievalSourceVerifiedEnvelopeV1;
  /** Explicit approval-protocol registry selected by composition. */
  readonly policy_projectors?: RecordPolicyFactProjectorRegistryV1;
}

export interface RecordRetrievalSourceHeadV1 {
  readonly position: number;
  readonly record_sha256: Sha256Digest;
}

export interface RecordRetrievalSourceRowV1 {
  readonly position: number;
  readonly envelope_id: string;
  readonly event_kind: RecordEventKind;
  readonly approval_id: string;
  readonly action: RecordAction;
  readonly semantic_idempotency_key: Sha256Digest;
  readonly envelope_sha256: Sha256Digest;
  readonly predecessor_position: number | null;
  readonly predecessor_record_sha256: Sha256Digest | null;
  readonly record_sha256: Sha256Digest;
  readonly classification:
    | {
        readonly kind: "approved";
        readonly policy_id: PersonPolicyIdV2;
        readonly atom_count: number;
      }
    | { readonly kind: "rejected" };
}

/** An atom released to the search index, with every immutable Person-v2 proof fact. */
export interface RecordRetrievalSourceAtomV1 {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly approval_id: string;
  readonly action: "approve";
  readonly policy_id: PersonPolicyIdV2;
  readonly policy_contract_sha256: Sha256Digest;
  readonly record_position: number;
  readonly record_sha256: Sha256Digest;
  readonly atom_order: number;
  readonly signal_id_sha256: Sha256Digest;
  readonly atom_id: Sha256Digest;
  readonly item_kind: PersonPolicyFactItemKindV2;
  readonly text: string;
  readonly audit_event_id: string;
  readonly audit_sequence: number;
  readonly audit_entry_sha256: Sha256Digest;
  readonly provider_action_sha256: Sha256Digest;
  readonly authorization_proof_sha256: Sha256Digest;
  readonly reviewer_principal_id: string | null;
  readonly reviewer_membership_id: string | null;
}

export interface RecordRetrievalSourceSnapshotV1 {
  readonly coordinates: {
    readonly authority_id: string;
    readonly organization_id: string;
    readonly state_lineage_id: string;
  };
  readonly head: RecordRetrievalSourceHeadV1 | null;
  /** Canonical bytes of the dense rows and atoms handed to a search index build. */
  readonly upstream_input_preimage: string;
  readonly upstream_input_sha256: Sha256Digest;
  readonly rows: readonly RecordRetrievalSourceRowV1[];
  readonly atoms: readonly RecordRetrievalSourceAtomV1[];
}

interface StoredRecordRow {
  readonly position: number;
  readonly envelope_id: string;
  readonly event_kind: RecordEventKind;
  readonly approval_id: string;
  readonly action: RecordAction;
  readonly semantic_idempotency_key: Sha256Digest;
  readonly canonical_envelope: string;
  readonly envelope_sha256: Sha256Digest;
  readonly predecessor_position: number | null;
  readonly predecessor_record_sha256: Sha256Digest | null;
  readonly record_sha256: Sha256Digest;
}

interface StoredFactRow {
  readonly fact_family: "member" | "reviewer";
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly approval_id: string;
  readonly action: "approve";
  readonly policy_id: PersonPolicyIdV2;
  readonly policy_contract_sha256: Sha256Digest;
  readonly record_position: number;
  readonly record_sha256: Sha256Digest;
  readonly atom_order: number;
  readonly signal_id_sha256: Sha256Digest;
  readonly atom_id: Sha256Digest;
  readonly item_kind: PersonPolicyFactItemKindV2;
  readonly audit_event_id: string;
  readonly audit_sequence: number;
  readonly audit_entry_sha256: Sha256Digest;
  readonly provider_action_sha256: Sha256Digest;
  readonly authorization_proof_sha256: Sha256Digest;
  readonly reviewer_principal_id: string | null;
  readonly reviewer_membership_id: string | null;
}

interface MaterializedSnapshot {
  readonly metadata:
    | {
        readonly authority_id: string;
        readonly organization_id: string;
        readonly state_lineage_id: string;
      }
    | undefined;
  readonly records: readonly StoredRecordRow[];
  readonly facts: readonly StoredFactRow[];
}

function invalid(message: string): never {
  throw new Error(`record retrieval-source snapshot is invalid: ${message}`);
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    invalid(`${label} must be text`);
  return value;
}

function requiredDigest(value: unknown, label: string): Sha256Digest {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    invalid(`${label} must be a sha256 digest`);
  }
  return value as Sha256Digest;
}

function requiredPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    invalid(`${label} must be a positive safe integer`);
  }
  return value as number;
}

function requiredAtomOrder(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    invalid(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) invalid(`${label} does not match`);
}

function expectedSignals(
  envelope: RecordRetrievalSourceVerifiedEnvelopeV1,
): readonly RecordRetrievalSourceSignalV1[] {
  if (envelope.body.event.kind !== "approved") return Object.freeze([]);
  const grouped: ReadonlyArray<
    readonly [PersonPolicyFactItemKindV2, readonly RecordRetrievalSourceSignalV1[]]
  > = [
    [
      "decision",
      envelope.body.event.approved_snapshot.approved_payload.brief.decisions,
    ],
    [
      "action",
      envelope.body.event.approved_snapshot.approved_payload.brief.actions,
    ],
    [
      "rationale",
      envelope.body.event.approved_snapshot.approved_payload.brief.rationales,
    ],
  ];
  const ids = new Set<string>();
  const signals: RecordRetrievalSourceSignalV1[] = [];
  for (const [kind, values] of grouped) {
    for (const signal of values) {
      requiredText(signal.id, "approved signal id");
      requiredText(signal.text, "approved signal text");
      assertEqual(signal.kind, kind, "approved signal kind");
      if (ids.has(signal.id)) invalid("approved signal IDs must be unique");
      ids.add(signal.id);
      signals.push(signal);
    }
  }
  return Object.freeze(signals);
}

function materialize(database: Database.Database): MaterializedSnapshot {
  database.exec("BEGIN");
  try {
    const metadata = database
      .prepare(
        `SELECT authority_id, organization_id, state_lineage_id
           FROM organization_record_log_metadata WHERE singleton = 1`,
      )
      .get() as MaterializedSnapshot["metadata"];
    const records = database
      .prepare(
        `SELECT position, envelope_id, event_kind, approval_id, action,
                semantic_idempotency_key, canonical_envelope, envelope_sha256,
                predecessor_position, predecessor_record_sha256, record_sha256
           FROM organization_record_log ORDER BY position ASC`,
      )
      .all() as StoredRecordRow[];
    const facts = database
      .prepare(
        `SELECT 'member' AS fact_family,
                authority_id, organization_id, state_lineage_id, approval_id,
                action, policy_id, policy_contract_sha256, record_position,
                record_sha256, atom_order, signal_id_sha256, atom_id, item_kind,
                audit_event_id, audit_sequence, audit_entry_sha256,
                provider_action_sha256, authorization_proof_sha256,
                NULL AS reviewer_principal_id, NULL AS reviewer_membership_id
           FROM organization_record_member_readable_person_fact
         UNION ALL
         SELECT 'reviewer' AS fact_family,
                authority_id, organization_id, state_lineage_id, approval_id,
                action, policy_id, policy_contract_sha256, record_position,
                record_sha256, atom_order, signal_id_sha256, atom_id, item_kind,
                audit_event_id, audit_sequence, audit_entry_sha256,
                provider_action_sha256, authorization_proof_sha256,
                reviewer_principal_id, reviewer_membership_id
           FROM organization_record_restricted_reviewer_person_fact
         ORDER BY record_position ASC, atom_order ASC, fact_family ASC`,
      )
      .all() as StoredFactRow[];
    database.exec("COMMIT");
    return { metadata, records, facts };
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

function asJsonObject(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${label} must be a JSON object`);
  }
  return value as JsonObject;
}

/**
 * A V4-only, permission-neutral retrieval-source snapshot port. It makes no live
 * membership decision: it carries the exact immutable policy facts which the
 * search index builder will scope before indexing.
 */
export class RecordRetrievalSourceSnapshotPortV1 {
  constructor(
    private readonly database: Database.Database,
    private readonly defaultPolicyProjectors: RecordPolicyFactProjectorRegistryV1 =
      createRecordPolicyFactProjectorRegistryV1([
        createPersonPolicyFactProjectorV2(),
      ]),
  ) {}

  snapshot(input: RecordRetrievalSourceSnapshotInputV1): RecordRetrievalSourceSnapshotV1 {
    requiredText(input.authority_id, "authority_id");
    requiredText(input.organization_id, "organization_id");
    requiredText(input.state_lineage_id, "state_lineage_id");
    if (typeof input.verify_envelope !== "function") {
      invalid("verify_envelope must be a function");
    }

    const source = materialize(this.database);
    if (source.metadata === undefined) invalid("log metadata is absent");
    assertEqual(
      source.metadata.authority_id,
      input.authority_id,
      "metadata authority_id",
    );
    assertEqual(
      source.metadata.organization_id,
      input.organization_id,
      "metadata organization_id",
    );
    assertEqual(
      source.metadata.state_lineage_id,
      input.state_lineage_id,
      "metadata state_lineage_id",
    );

    const factsByPosition = new Map<number, StoredFactRow[]>();
    for (const fact of source.facts) {
      const group = factsByPosition.get(fact.record_position) ?? [];
      group.push(fact);
      factsByPosition.set(fact.record_position, group);
    }

    const atoms: RecordRetrievalSourceAtomV1[] = [];
    const rows: RecordRetrievalSourceRowV1[] = [];
    let prior: StoredRecordRow | undefined;
    for (const [index, row] of source.records.entries()) {
      const position = requiredPositiveInteger(row.position, "record position");
      assertEqual(position, index + 1, "record position density");
      const canonical = requiredText(
        row.canonical_envelope,
        "canonical envelope",
      );
      const parsed = asJsonObject(
        parseCanonicalJson(canonical),
        "canonical envelope",
      );
      assertEqual(canonicalJson(parsed), canonical, "canonical envelope bytes");
      const envelope = input.verify_envelope(parsed);
      const body = envelope.body;
      const reference = body.human_act_resolution_ref;

      assertEqual(
        body.authority_id,
        input.authority_id,
        "envelope authority_id",
      );
      assertEqual(
        body.organization_id,
        input.organization_id,
        "envelope organization_id",
      );
      assertEqual(
        body.state_lineage_id,
        input.state_lineage_id,
        "envelope state_lineage_id",
      );
      assertEqual(
        reference.authority_id,
        input.authority_id,
        "resolution authority_id",
      );
      assertEqual(
        reference.organization_id,
        input.organization_id,
        "resolution organization_id",
      );
      assertEqual(
        reference.state_lineage_id,
        input.state_lineage_id,
        "resolution state_lineage_id",
      );
      assertEqual(row.envelope_id, body.envelope_id, "row envelope_id");
      assertEqual(row.event_kind, body.event.kind, "row event_kind");
      assertEqual(row.approval_id, reference.approval_id, "row approval_id");
      assertEqual(row.action, reference.action, "row action");
      assertEqual(
        row.semantic_idempotency_key,
        body.semantic_idempotency_key,
        "row semantic idempotency key",
      );
      assertEqual(
        row.envelope_sha256,
        sha256Digest(canonical),
        "row envelope digest",
      );
      assertEqual(
        row.record_sha256,
        envelope.record_sha256,
        "row record digest",
      );
      assertEqual(
        row.predecessor_position,
        body.predecessor_position,
        "row predecessor position",
      );
      assertEqual(
        row.predecessor_record_sha256,
        body.predecessor_record_sha256,
        "row predecessor digest",
      );
      assertEqual(
        body.event.kind === "approved",
        reference.action === "approve",
        "event/action join",
      );
      assertEqual(
        body.event.kind === "rejected",
        reference.action === "reject",
        "rejection/action join",
      );

      const predecessorPosition = prior?.position ?? null;
      const predecessorHash = prior?.record_sha256 ?? null;
      assertEqual(
        row.predecessor_position,
        predecessorPosition,
        "dense predecessor position",
      );
      assertEqual(
        row.predecessor_record_sha256,
        predecessorHash,
        "dense predecessor record digest",
      );

      const recordFacts = factsByPosition.get(position) ?? [];
      const signals = expectedSignals(envelope);
      if (body.event.kind === "rejected") {
        if (recordFacts.length !== 0)
          invalid("rejection must contribute no Person atoms");
        rows.push(
          Object.freeze({
            position,
            envelope_id: requiredText(row.envelope_id, "row envelope_id"),
            event_kind: "rejected",
            approval_id: requiredText(row.approval_id, "row approval_id"),
            action: "reject",
            semantic_idempotency_key: requiredDigest(
              row.semantic_idempotency_key,
              "row semantic idempotency key",
            ),
            envelope_sha256: requiredDigest(
              row.envelope_sha256,
              "row envelope digest",
            ),
            predecessor_position: row.predecessor_position,
            predecessor_record_sha256: row.predecessor_record_sha256,
            record_sha256: requiredDigest(
              row.record_sha256,
              "row record digest",
            ),
            classification: Object.freeze({ kind: "rejected" }),
          }),
        );
        prior = row;
        continue;
      }

      if (recordFacts.length !== signals.length) {
        invalid(
          "approved record Person facts do not exactly cover its signals",
        );
      }
      const binding = (input.policy_projectors ?? this.defaultPolicyProjectors)
        .policyBinding(envelope);
      const expectedFamily =
        binding.policy_id === RESTRICTED_REVIEWER_PERSON_POLICY_ID
          ? "reviewer"
          : "member";
      let reviewerPrincipal: string | null = null;
      let reviewerMembership: string | null = null;
      for (const [atomOrder, signal] of signals.entries()) {
        const fact = recordFacts[atomOrder];
        if (fact === undefined)
          invalid("approved record is missing a Person fact");
        assertEqual(fact.fact_family, expectedFamily, "Person fact family");
        assertEqual(
          fact.authority_id,
          input.authority_id,
          "Person fact authority_id",
        );
        assertEqual(
          fact.organization_id,
          input.organization_id,
          "Person fact organization_id",
        );
        assertEqual(
          fact.state_lineage_id,
          input.state_lineage_id,
          "Person fact state_lineage_id",
        );
        assertEqual(
          fact.approval_id,
          reference.approval_id,
          "Person fact approval_id",
        );
        assertEqual(fact.action, "approve", "Person fact action");
        assertEqual(
          fact.policy_id,
          binding.policy_id,
          "Person fact policy_id",
        );
        assertEqual(
          fact.policy_contract_sha256,
          binding.policy_contract_sha256,
          "Person fact policy contract",
        );
        assertEqual(
          fact.record_position,
          position,
          "Person fact record position",
        );
        assertEqual(
          fact.record_sha256,
          row.record_sha256,
          "Person fact record digest",
        );
        assertEqual(
          requiredAtomOrder(fact.atom_order, "Person fact atom order"),
          atomOrder,
          "Person fact atom order",
        );
        assertEqual(
          fact.signal_id_sha256,
          sha256Digest(signal.id),
          "Person fact signal digest",
        );
        assertEqual(
          fact.atom_id,
          derivedAtomIdentity(row.record_sha256, signal.id),
          "Person fact atom identity",
        );
        assertEqual(fact.item_kind, signal.kind, "Person fact item kind");
        assertEqual(
          fact.audit_event_id,
          reference.audit_event_id,
          "Person fact audit event ID",
        );
        assertEqual(
          fact.audit_sequence,
          reference.audit_sequence,
          "Person fact audit sequence",
        );
        assertEqual(
          fact.audit_entry_sha256,
          reference.audit_entry_sha256,
          "Person fact audit digest",
        );
        assertEqual(
          fact.provider_action_sha256,
          reference.provider_action_sha256,
          "Person fact provider action digest",
        );
        assertEqual(
          fact.authorization_proof_sha256,
          reference.authorization_proof_sha256,
          "Person fact authorization proof digest",
        );
        if (expectedFamily === "reviewer") {
          const principal = requiredText(
            fact.reviewer_principal_id,
            "reviewer fact principal",
          );
          const membership = requiredText(
            fact.reviewer_membership_id,
            "reviewer fact membership",
          );
          if (reviewerPrincipal === null) {
            reviewerPrincipal = principal;
            reviewerMembership = membership;
          } else {
            assertEqual(
              principal,
              reviewerPrincipal,
              "reviewer fact principal tuple",
            );
            assertEqual(
              membership,
              reviewerMembership,
              "reviewer fact membership tuple",
            );
          }
        } else if (
          fact.reviewer_principal_id !== null ||
          fact.reviewer_membership_id !== null
        ) {
          invalid("member-readable fact must not carry a reviewer tuple");
        }
        atoms.push(
          Object.freeze({
            authority_id: input.authority_id,
            organization_id: input.organization_id,
            state_lineage_id: input.state_lineage_id,
            approval_id: reference.approval_id,
            action: "approve",
            policy_id: binding.policy_id,
            policy_contract_sha256: binding.policy_contract_sha256,
            record_position: position,
            record_sha256: row.record_sha256,
            atom_order: atomOrder,
            signal_id_sha256: fact.signal_id_sha256,
            atom_id: fact.atom_id,
            item_kind: signal.kind,
            text: signal.text,
            audit_event_id: reference.audit_event_id,
            audit_sequence: reference.audit_sequence,
            audit_entry_sha256: reference.audit_entry_sha256,
            provider_action_sha256: reference.provider_action_sha256,
            authorization_proof_sha256: reference.authorization_proof_sha256,
            reviewer_principal_id: reviewerPrincipal,
            reviewer_membership_id: reviewerMembership,
          }),
        );
      }
      rows.push(
        Object.freeze({
          position,
          envelope_id: requiredText(row.envelope_id, "row envelope_id"),
          event_kind: "approved",
          approval_id: requiredText(row.approval_id, "row approval_id"),
          action: "approve",
          semantic_idempotency_key: requiredDigest(
            row.semantic_idempotency_key,
            "row semantic idempotency key",
          ),
          envelope_sha256: requiredDigest(
            row.envelope_sha256,
            "row envelope digest",
          ),
          predecessor_position: row.predecessor_position,
          predecessor_record_sha256: row.predecessor_record_sha256,
          record_sha256: requiredDigest(row.record_sha256, "row record digest"),
          classification: Object.freeze({
            kind: "approved",
            policy_id: binding.policy_id,
            atom_count: signals.length,
          }),
        }),
      );
      prior = row;
    }

    for (const position of factsByPosition.keys()) {
      if (position < 1 || position > source.records.length) {
        invalid("Person fact refers to an absent record");
      }
    }
    const coordinates = Object.freeze({
      authority_id: input.authority_id,
      organization_id: input.organization_id,
      state_lineage_id: input.state_lineage_id,
    });
    const frozenRows = Object.freeze(rows);
    const frozenAtoms = Object.freeze(atoms);
    const upstream_input_preimage = canonicalJson({
      schema_version: 1,
      // Legacy digest-domain literal: renaming it would invalidate existing generations.
      kind: "echo-clean-v4-layer1-snapshot-input",
      coordinates,
      rows: frozenRows,
      atoms: frozenAtoms,
    });
    return Object.freeze({
      coordinates,
      head:
        prior === undefined
          ? null
          : Object.freeze({
              position: prior.position,
              record_sha256: prior.record_sha256,
            }),
      upstream_input_preimage,
      upstream_input_sha256: sha256Digest(upstream_input_preimage),
      rows: frozenRows,
      atoms: frozenAtoms,
    });
  }
}
