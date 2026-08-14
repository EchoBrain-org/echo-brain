import { sha256Digest } from '@echo-brain/federation-protocol';
import type Database from 'better-sqlite3';
import type { OrganizationRecordLogRow, Sha256Digest } from '../application/contracts.js';
import {
  isOrganizationMemberReadableEnvelopeDocument,
  organizationMemberPolicyFactSetSha256,
  projectOrganizationMemberPolicyFacts,
  readOrganizationMemberReadableEnvelope,
  type OrganizationMemberReadableEnvelopeValidator,
  type OrganizationRecordOrganizationMemberPolicyFactRow,
} from '../application/organization-member-policy-fact.js';
import {
  isReviewerRestrictedEnvelopeDocument,
  projectReviewerPolicyFacts,
  readCanonicalRecordEnvelope,
  readReviewerRestrictedEnvelope,
  reviewerPolicyFactSetSha256,
  type OrganizationRecordReviewerPolicyFactRow,
  type ReviewerRestrictedEnvelopeValidator,
} from '../application/reviewer-policy-fact.js';
import { toOrganizationRecordLogRow, type RawOrganizationRecordLogRow } from '../application/log-row.js';
import { verifyOrganizationRecordChain } from '../log/chain-verification.js';
import { readOrganizationMemberPolicyFactsAtPosition } from '../log/organization-member-policy-fact.js';
import { readReviewerPolicyFactsAtPosition } from '../log/reviewer-policy-fact.js';
import {
  organizationRecordItemContentBindingSha256,
  organizationRecordReviewerProvenanceBindingSha256,
} from '../application/retrieval-policy-binding.js';

/** Immutable Layer 1 head captured when the stopped builder port opens. */
export interface RetrievalBuildRecordHead {
  readonly position: number;
  readonly record_hash: Sha256Digest | null;
}

export interface RetrievalBuildReviewerItem {
  readonly policy_id: 'restricted-reviewer-v1';
  readonly log_position: number;
  readonly record_hash: Sha256Digest;
  readonly envelope_sha256: Sha256Digest;
  readonly atom_order: number;
  readonly atom_id: Sha256Digest;
  readonly signal_id_sha256: Sha256Digest;
  readonly item_kind: 'decision' | 'action' | 'rationale';
  readonly text: string;
  readonly text_sha256: Sha256Digest;
  /** Closed v2 approval bindings revalidated from the canonical envelope. */
  readonly release_draft_sha256: Sha256Digest;
  readonly approval_presentation_sha256: Sha256Digest;
  readonly message_presentation_sha256: Sha256Digest;
  readonly evaluated_at: string;
  /** Reprojected, text-free bindings for the one released content row. */
  readonly content_binding_sha256: Sha256Digest;
  readonly provenance_binding_sha256: Sha256Digest;
  /** Complete append-atomic fact, reproven before text becomes reachable. */
  readonly provenance: OrganizationRecordReviewerPolicyFactRow;
}

export interface RetrievalBuildOrganizationMemberItem {
  readonly policy_id: 'organization-member-readable-v1';
  readonly log_position: number;
  readonly record_hash: Sha256Digest;
  readonly envelope_sha256: Sha256Digest;
  readonly atom_order: number;
  readonly atom_id: Sha256Digest;
  readonly signal_id_sha256: Sha256Digest;
  readonly item_kind: 'decision' | 'action' | 'rationale';
  readonly text: string;
  readonly text_sha256: Sha256Digest;
  /** Complete append-atomic fact, including content/provenance bindings. */
  readonly provenance: OrganizationRecordOrganizationMemberPolicyFactRow;
}

export interface RetrievalBuildBatch {
  readonly record_head: RetrievalBuildRecordHead;
  /** One ordered, text-free classification for every canonical log row. */
  readonly row_classifications: readonly RetrievalBuildRowClassification[];
  readonly reviewer_items: readonly RetrievalBuildReviewerItem[];
  readonly organization_member_items: readonly RetrievalBuildOrganizationMemberItem[];
}

interface RetrievalBuildClassifiedRow {
  readonly log_position: number;
  readonly record_hash: Sha256Digest;
  readonly envelope_sha256: Sha256Digest;
}

export interface RetrievalBuildLegacyExcludedRow
  extends RetrievalBuildClassifiedRow {
  readonly classification: 'legacy-schema-v1-excluded';
  readonly items: readonly [];
}

export interface RetrievalBuildReviewerAdmittedRow
  extends RetrievalBuildClassifiedRow {
  readonly classification: 'restricted-reviewer-v2-admitted';
}

export interface RetrievalBuildOrganizationMemberAdmittedRow
  extends RetrievalBuildClassifiedRow {
  readonly classification: 'organization-member-readable-v3-admitted';
}

export type RetrievalBuildRowClassification =
  | RetrievalBuildLegacyExcludedRow
  | RetrievalBuildReviewerAdmittedRow
  | RetrievalBuildOrganizationMemberAdmittedRow;

/**
 * Stopped-builder-only source surface.  It exposes neither a database handle
 * nor general log rows: canonical text is released only after this factory has
 * checked the whole chain and exact fact reprojection for every admitted row.
 */
export interface OrganizationRecordRetrievalBuildPort {
  readonly record_head: RetrievalBuildRecordHead;
  readAt(head: RetrievalBuildRecordHead): RetrievalBuildBatch;
}

export interface CreateOrganizationRecordRetrievalBuildPortInput {
  readonly organization_id: string;
  readonly authority_id: string;
  /** Fixed reviewer-v1 contract supplied by Authority composition. */
  readonly restricted_reviewer_policy_contract_sha256: Sha256Digest;
  readonly reviewer_validator: ReviewerRestrictedEnvelopeValidator;
  readonly organization_member_validator: OrganizationMemberReadableEnvelopeValidator;
}

function frozenHead(row: OrganizationRecordLogRow | undefined): RetrievalBuildRecordHead {
  return Object.freeze({ position: row?.position ?? 0, record_hash: row?.record_hash ?? null });
}

function sameHead(left: RetrievalBuildRecordHead, right: RetrievalBuildRecordHead): boolean {
  return left.position === right.position && left.record_hash === right.record_hash;
}

function fail(message: string): never {
  throw new Error(`organization retrieval-build source is unavailable: ${message}`);
}

interface ReviewerRetrievalBindingItem {
  readonly policy_id: 'restricted-reviewer-v1';
  readonly log_position: number;
  readonly record_hash: Sha256Digest;
  readonly envelope_sha256: Sha256Digest;
  readonly atom_order: number;
  readonly atom_id: Sha256Digest;
  readonly signal_id_sha256: Sha256Digest;
  readonly item_kind: RetrievalBuildReviewerItem['item_kind'];
  readonly text: string;
  readonly text_sha256: Sha256Digest;
  readonly release_draft_sha256: Sha256Digest;
  readonly approval_presentation_sha256: Sha256Digest;
  readonly message_presentation_sha256: Sha256Digest;
  readonly evaluated_at: string;
}

function readRows(database: Database.Database): readonly OrganizationRecordLogRow[] {
  return Object.freeze(
    (database.prepare('SELECT * FROM organization_record_log ORDER BY position').all() as RawOrganizationRecordLogRow[])
      .map(toOrganizationRecordLogRow)
      .map((row) => Object.freeze(row)),
  );
}

/**
 * Captures a complete, fact-qualified snapshot.  No method reads SQLite after
 * this point, so a later append cannot change or widen a pinned builder input.
 */
export function createOrganizationRecordRetrievalBuildPort(
  database: Database.Database,
  input: CreateOrganizationRecordRetrievalBuildPortInput,
): OrganizationRecordRetrievalBuildPort {
  const binding = Object.freeze({ ...input });
  const rows = readRows(database);
  const chain = verifyOrganizationRecordChain({
    organization_id: binding.organization_id,
    authority_id: binding.authority_id,
    rows: () => rows,
  });
  if (chain.failures.length > 0) fail(`record chain failed verification at ${chain.failures[0]!.position}`);
  const record_head = frozenHead(rows.at(-1));
  const row_classifications: RetrievalBuildRowClassification[] = [];
  const reviewer_items: RetrievalBuildReviewerItem[] = [];
  const organization_member_items: RetrievalBuildOrganizationMemberItem[] = [];

  for (const row of rows) {
    let document: ReturnType<typeof readCanonicalRecordEnvelope>;
    try {
      document = readCanonicalRecordEnvelope(row);
    } catch (error) {
      fail(`canonical record ${row.position} is unreadable: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (isReviewerRestrictedEnvelopeDocument(document)) {
      let envelope;
      try {
        envelope = readReviewerRestrictedEnvelope(document, binding.reviewer_validator);
      } catch (error) {
        fail(`reviewer record ${row.position} failed validation: ${error instanceof Error ? error.message : String(error)}`);
      }
      const expected = projectReviewerPolicyFacts({
        envelope,
        log_position: row.position,
        record_hash: row.record_hash,
        organization_id: binding.organization_id,
        canonical_envelope_sha256: row.envelope_sha256,
      });
      const actual = readReviewerPolicyFactsAtPosition(database, row.position);
      if (reviewerPolicyFactSetSha256(actual) !== reviewerPolicyFactSetSha256(expected)) {
        fail(`reviewer record ${row.position} facts do not reproject`);
      }
      for (const [index, fact] of actual.entries()) {
        const signal = envelope.signals[index];
        if (signal === undefined || fact.atom_order !== index ||
          fact.atom_id !== expected[index]?.atom_id ||
          fact.signal_id_sha256 !== sha256Digest(signal.id)) {
          fail(`reviewer record ${row.position} facts do not bind released item ${index}`);
        }
        const item = {
          policy_id: 'restricted-reviewer-v1' as const, log_position: row.position,
          record_hash: row.record_hash, envelope_sha256: row.envelope_sha256,
          atom_order: fact.atom_order, atom_id: fact.atom_id,
          signal_id_sha256: fact.signal_id_sha256, item_kind: signal.kind,
          text: signal.text, text_sha256: sha256Digest(signal.text),
          release_draft_sha256: envelope.reviewer_release_draft_sha256,
          approval_presentation_sha256: envelope.approval_presentation_sha256,
          message_presentation_sha256: envelope.message_presentation_sha256,
          evaluated_at: envelope.evaluated_at,
        } satisfies ReviewerRetrievalBindingItem;
        const content_binding_sha256 =
          organizationRecordItemContentBindingSha256({
            organization_id: binding.organization_id,
            envelope_sha256: item.envelope_sha256,
            log_position: item.log_position,
            record_hash: item.record_hash,
            atom_id: item.atom_id,
            atom_order: item.atom_order,
            signal_id_sha256: item.signal_id_sha256,
            item_kind: item.item_kind,
            text_sha256: item.text_sha256,
          });
        const provenance = Object.freeze({ ...fact });
        reviewer_items.push(Object.freeze({
          ...item,
          content_binding_sha256,
          provenance_binding_sha256:
            organizationRecordReviewerProvenanceBindingSha256({
              organization_id: binding.organization_id,
              envelope_sha256: item.envelope_sha256,
              log_position: item.log_position,
              record_hash: item.record_hash,
              policy_contract_sha256:
                binding.restricted_reviewer_policy_contract_sha256,
              reviewer_principal_id: provenance.reviewer_principal_id,
              reviewer_membership_id: provenance.reviewer_membership_id,
              release_draft_sha256: item.release_draft_sha256,
              approval_presentation_sha256:
                item.approval_presentation_sha256,
              semantic_intent_sha256: provenance.semantic_intent_sha256,
              message_presentation_sha256:
                item.message_presentation_sha256,
              authorization_audit_event_id:
                provenance.authorization_audit_event_id,
              authorization_audit_entry_sha256:
                provenance.authorization_audit_entry_sha256,
              authorization_proof_sha256:
                provenance.authorization_proof_sha256,
              evaluated_at: item.evaluated_at,
            }),
          provenance,
        }));
      }
      row_classifications.push(Object.freeze({
        classification: 'restricted-reviewer-v2-admitted',
        log_position: row.position,
        record_hash: row.record_hash,
        envelope_sha256: row.envelope_sha256,
      }));
      continue;
    }
    if (isOrganizationMemberReadableEnvelopeDocument(document)) {
      let envelope;
      try {
        envelope = readOrganizationMemberReadableEnvelope(document, binding.organization_member_validator);
      } catch (error) {
        fail(`organization-member record ${row.position} failed validation: ${error instanceof Error ? error.message : String(error)}`);
      }
      const expected = projectOrganizationMemberPolicyFacts({
        organization_id: binding.organization_id,
        log_position: row.position,
        record_hash: row.record_hash,
        envelope_sha256: row.envelope_sha256,
        envelope,
      });
      const actual = readOrganizationMemberPolicyFactsAtPosition(database, row.position);
      if (organizationMemberPolicyFactSetSha256(actual) !== organizationMemberPolicyFactSetSha256(expected)) {
        fail(`organization-member record ${row.position} facts do not reproject`);
      }
      for (const [index, fact] of actual.entries()) {
        const signal = envelope.signals[index];
        if (signal === undefined || fact.atom_order !== index ||
          fact.atom_id !== expected[index]?.atom_id ||
          fact.signal_id_sha256 !== sha256Digest(signal.id)) {
          fail(`organization-member record ${row.position} facts do not bind released item ${index}`);
        }
        organization_member_items.push(Object.freeze({
          policy_id: 'organization-member-readable-v1', log_position: row.position,
          record_hash: row.record_hash, envelope_sha256: row.envelope_sha256,
          atom_order: fact.atom_order, atom_id: fact.atom_id,
          signal_id_sha256: fact.signal_id_sha256, item_kind: signal.kind,
          text: signal.text, text_sha256: sha256Digest(signal.text), provenance: Object.freeze({ ...fact }),
        }));
      }
      row_classifications.push(Object.freeze({
        classification: 'organization-member-readable-v3-admitted',
        log_position: row.position,
        record_hash: row.record_hash,
        envelope_sha256: row.envelope_sha256,
      }));
      continue;
    }
    // Only known legacy v1 records are excluded. An unsupported future
    // version must halt instead of silently leaving a hole in the input root.
    if (document['schema_version'] !== 1) {
      fail(`unsupported envelope schema version ${String(document['schema_version'])} at ${row.position}`);
    }
    row_classifications.push(Object.freeze({
      classification: 'legacy-schema-v1-excluded',
      log_position: row.position,
      record_hash: row.record_hash,
      envelope_sha256: row.envelope_sha256,
      items: Object.freeze([] as const),
    }));
  }
  const batch: RetrievalBuildBatch = Object.freeze({
    record_head,
    row_classifications: Object.freeze(row_classifications),
    reviewer_items: Object.freeze(reviewer_items),
    organization_member_items: Object.freeze(organization_member_items),
  });
  return Object.freeze({
    record_head,
    readAt(head: RetrievalBuildRecordHead): RetrievalBuildBatch {
      if (!sameHead(head, record_head)) fail('requested head differs from the captured immutable head');
      return batch;
    },
  });
}
