import { canonicalSha256 } from '@echo-brain/federation-protocol';
import type {
  RetrievalContentAtom,
  RetrievalLexicalDocument,
  RetrievalPermissionFact,
  RetrievalTermPosting,
  ReadableSearchGenerationSegment,
} from './contracts.js';
import { ReadableSearchValidationError } from './contracts.js';

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function compareRecordRows(
  left: { log_position: number; atom_order: number; atom_id: string },
  right: { log_position: number; atom_order: number; atom_id: string },
): number {
  return (
    left.log_position - right.log_position ||
    left.atom_order - right.atom_order ||
    compareUtf8(left.atom_id, right.atom_id)
  );
}

function assertUniqueOrdered<T>(
  rows: readonly T[],
  comparator: (left: T, right: T) => number,
  label: string,
): readonly T[] {
  const ordered = [...rows].sort(comparator);
  for (let index = 1; index < ordered.length; index += 1) {
    if (comparator(ordered[index - 1]!, ordered[index]!) === 0) {
      throw new ReadableSearchValidationError(`${label} contains duplicate root rows`);
    }
  }
  return Object.freeze(ordered);
}

export function readableSearchFactsRoot(
  segmentId: string,
  facts: readonly RetrievalPermissionFact[],
): `sha256:${string}` {
  const rows = assertUniqueOrdered(facts, compareRecordRows, 'facts').map((fact) => ({
    atom_id: fact.atom_id,
    organization_id: fact.organization_id,
    envelope_sha256: fact.envelope_sha256,
    log_position: fact.log_position,
    record_hash: fact.record_hash,
    atom_order: fact.atom_order,
    signal_id_sha256: fact.signal_id_sha256,
    item_kind: fact.item_kind,
    policy_id: fact.policy_id,
    policy_contract_sha256: fact.policy_contract_sha256,
    approval_actor_principal_id: fact.approval_actor_principal_id,
    approval_actor_membership_id: fact.approval_actor_membership_id,
    reviewer_principal_id: fact.reviewer_principal_id,
    reviewer_membership_id: fact.reviewer_membership_id,
    release_draft_sha256: fact.release_draft_sha256,
    approval_presentation_sha256: fact.approval_presentation_sha256,
    semantic_intent_sha256: fact.semantic_intent_sha256,
    message_presentation_sha256: fact.message_presentation_sha256,
    authorization_audit_event_id: fact.authorization_audit_event_id,
    authorization_audit_entry_sha256: fact.authorization_audit_entry_sha256,
    evaluated_at: fact.evaluated_at,
    authorization_proof_sha256: fact.authorization_proof_sha256,
    content_binding_sha256: fact.content_binding_sha256,
    provenance_binding_sha256: fact.provenance_binding_sha256,
  }));
  return canonicalSha256({
    schema_version: 1,
    kind: 'readable-search-segment-facts-root-v1',
    segment_id: segmentId,
    rows,
  });
}

export function readableSearchContentRoot(
  segmentId: string,
  atoms: readonly RetrievalContentAtom[],
): `sha256:${string}` {
  const rows = assertUniqueOrdered(atoms, compareRecordRows, 'content').map((atom) => ({
    atom_id: atom.atom_id,
    log_position: atom.log_position,
    record_hash: atom.record_hash,
    atom_order: atom.atom_order,
    item_kind: atom.item_kind,
    text: atom.text,
    text_sha256: atom.text_sha256,
    content_binding_sha256: atom.content_binding_sha256,
    provenance_binding_sha256: atom.provenance_binding_sha256,
  }));
  return canonicalSha256({
    schema_version: 1,
    kind: 'readable-search-segment-content-root-v1',
    segment_id: segmentId,
    rows,
  });
}

export function readableSearchLexicalRoot(input: {
  segment_id: string;
  documents: readonly RetrievalLexicalDocument[];
  postings: readonly RetrievalTermPosting[];
}): `sha256:${string}` {
  const documents = assertUniqueOrdered(input.documents, compareRecordRows, 'lexical documents').map(
    (document) => ({
      atom_id: document.atom_id,
      log_position: document.log_position,
      atom_order: document.atom_order,
      content_binding_sha256: document.content_binding_sha256,
    }),
  );
  const postings = assertUniqueOrdered(
    input.postings,
    (left, right) => compareUtf8(left.term, right.term) || compareUtf8(left.atom_id, right.atom_id),
    'lexical postings',
  ).map((posting) => ({
    term: posting.term,
    atom_id: posting.atom_id,
    term_frequency: posting.term_frequency,
  }));
  return canonicalSha256({
    schema_version: 1,
    kind: 'readable-search-segment-lexical-root-v1',
    segment_id: input.segment_id,
    documents,
    postings,
  });
}

export function readableSearchGenerationPlaneRoot(input: {
  plane: 'facts' | 'content' | 'lexical';
  segments: readonly ReadableSearchGenerationSegment[];
}): `sha256:${string}` {
  const segments = assertUniqueOrdered(
    input.segments,
    (left, right) => compareUtf8(left.segment_id, right.segment_id),
    `${input.plane} generation segments`,
  ).map((segment) => ({
    segment_id: segment.segment_id,
    segment_manifest_sha256: segment.segment_manifest_sha256,
    [`${input.plane}_root`]: segment[`${input.plane}_root`],
  }));
  return canonicalSha256({
    schema_version: 1,
    kind: `readable-search-${input.plane}-generation-root-v1`,
    segments,
  });
}
