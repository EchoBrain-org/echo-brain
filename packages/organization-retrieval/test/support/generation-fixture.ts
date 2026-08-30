import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalSha256, sha256Digest } from '@echo-brain/federation-protocol';
import type {
  ReadableSearchAdmittedAtom,
  ReadableSearchStoppedBuildInput,
  ReadableSearchUpstreamInputRootPreimageV1,
} from '../../src/application/readable-search-contracts.js';

export const digest = (value: string): `sha256:${string}` => sha256Digest(value);

export function atom(input: {
  atom_id: string;
  policy_id?: 'organization-member-readable-v1' | 'restricted-reviewer-v1';
  text: string;
  position?: number;
  reviewer_principal_id?: string;
  reviewer_membership_id?: string;
}): ReadableSearchAdmittedAtom {
  const policyId = input.policy_id ?? 'organization-member-readable-v1';
  const reviewer = policyId === 'restricted-reviewer-v1';
  const position = input.position ?? 1;
  const atomId = digest(input.atom_id);
  const envelopeSha256 = digest(`env${input.atom_id}`);
  const recordHash = digest(`record${position}`);
  const signalIdSha256 = digest(`signal${input.atom_id}`);
  const textSha256 = sha256Digest(input.text);
  const policyContractSha256 = digest(reviewer ? 'reviewer' : 'member');
  const reviewerPrincipalId = reviewer
    ? (input.reviewer_principal_id ?? 'prn_reviewer')
    : null;
  const reviewerMembershipId = reviewer
    ? (input.reviewer_membership_id ?? 'mem_reviewer')
    : null;
  const approvalActorPrincipalId = reviewerPrincipalId ?? 'prn_actor';
  const approvalActorMembershipId = reviewerMembershipId ?? 'mem_actor';
  const releaseDraftSha256 = digest(`draft${input.atom_id}`);
  const approvalPresentationSha256 = digest(`presentation${input.atom_id}`);
  const semanticIntentSha256 = digest(`intent${input.atom_id}`);
  const messagePresentationSha256 = digest(`message${input.atom_id}`);
  const authorizationAuditEntrySha256 = digest(`audit${input.atom_id}`);
  const authorizationProofSha256 = digest(`proof${input.atom_id}`);
  const evaluatedAt = '2026-01-01T00:00:00.000Z';
  const contentBindingSha256 = canonicalSha256({
    schema_version: 1,
    kind: 'organization-record-item-content-binding-v1',
    organization_id: 'org_test',
    envelope_sha256: envelopeSha256,
    log_position: position,
    record_hash: recordHash,
    atom_id: atomId,
    atom_order: 0,
    signal_id_sha256: signalIdSha256,
    item_kind: 'decision',
    text_sha256: textSha256,
  });
  const sharedProvenance = {
    schema_version: 1,
    kind: 'organization-record-policy-provenance-binding-v1',
    organization_id: 'org_test',
    envelope_sha256: envelopeSha256,
    log_position: position,
    record_hash: recordHash,
    policy_id: policyId,
    policy_contract_sha256: policyContractSha256,
  } as const;
  const provenanceBindingSha256 = canonicalSha256({
    ...sharedProvenance,
    ...(reviewer
      ? {
          reviewer_principal_id: reviewerPrincipalId,
          reviewer_membership_id: reviewerMembershipId,
        }
      : {
          approving_principal_id: approvalActorPrincipalId,
          approving_membership_id: approvalActorMembershipId,
        }),
    release_draft_sha256: releaseDraftSha256,
    approval_presentation_sha256: approvalPresentationSha256,
    semantic_intent_sha256: semanticIntentSha256,
    message_presentation_sha256: messagePresentationSha256,
    authorization_audit_event_id: `aud_${input.atom_id}`,
    authorization_audit_entry_sha256: authorizationAuditEntrySha256,
    authorization_proof_sha256: authorizationProofSha256,
    evaluated_at: evaluatedAt,
  });
  return {
    fact: {
      atom_id: atomId, organization_id: 'org_test', envelope_sha256: envelopeSha256,
      log_position: position, record_hash: recordHash, atom_order: 0,
      signal_id_sha256: signalIdSha256, item_kind: 'decision', policy_id: policyId,
      policy_contract_sha256: policyContractSha256,
      approval_actor_principal_id: approvalActorPrincipalId,
      approval_actor_membership_id: approvalActorMembershipId,
      reviewer_principal_id: reviewerPrincipalId,
      reviewer_membership_id: reviewerMembershipId,
      release_draft_sha256: releaseDraftSha256,
      approval_presentation_sha256: approvalPresentationSha256,
      semantic_intent_sha256: semanticIntentSha256,
      message_presentation_sha256: messagePresentationSha256,
      authorization_audit_event_id: `aud_${input.atom_id}`,
      authorization_audit_entry_sha256: authorizationAuditEntrySha256,
      evaluated_at: evaluatedAt,
      authorization_proof_sha256: authorizationProofSha256,
      content_binding_sha256: contentBindingSha256,
      provenance_binding_sha256: provenanceBindingSha256,
    },
    text: input.text,
    text_sha256: textSha256,
  };
}

export function buildInput(directory: string, atoms: readonly ReadableSearchAdmittedAtom[]): ReadableSearchStoppedBuildInput {
  const recordHead = { position: 3, record_hash: digest('head') } as const;
  const rows: ReadableSearchUpstreamInputRootPreimageV1['rows'] = Object.freeze(
    Array.from({ length: recordHead.position }, (_, offset) => {
      const position = offset + 1;
      const facts = atoms
        .filter((candidate) => candidate.fact.log_position === position)
        .map((candidate) => candidate.fact)
        .sort((left, right) => left.atom_order - right.atom_order);
      if (facts.length === 0) {
        return Object.freeze({
          classification: 'legacy-schema-v1-excluded' as const,
          log_position: position,
          record_hash: position === recordHead.position
            ? recordHead.record_hash
            : digest(`legacy-record-${position}`),
          envelope_sha256: digest(`legacy-envelope-${position}`),
          items: Object.freeze([]),
        });
      }
      const first = facts[0]!;
      const classification = first.policy_id === 'restricted-reviewer-v1'
        ? 'restricted-reviewer-v2-admitted' as const
        : 'organization-member-readable-v3-admitted' as const;
      return Object.freeze({
        classification,
        log_position: position,
        record_hash: first.record_hash,
        envelope_sha256: first.envelope_sha256,
        items: Object.freeze(facts),
      });
    }),
  );
  const upstreamInputPreimage: ReadableSearchUpstreamInputRootPreimageV1 = Object.freeze({
    schema_version: 1,
    kind: 'readable-search-upstream-input-root-v1',
    organization_id: 'org_test',
    input_contract_version: 1,
    record_head: recordHead,
    rows,
  });
  return {
    state_directory: directory,
    organization_id: 'org_test',
    record_head: recordHead,
    upstream_input_preimage: upstreamInputPreimage,
    retrieval_contract_sha256: digest('contract'),
    organization_member_policy_contract_sha256: digest('member'),
    restricted_reviewer_policy_contract_sha256: digest('reviewer'),
    analyzer: {
      analyzer_id: 'echo-unicode-alnum-frequency-v1', analyzer_contract_sha256: digest('analyzer-contract'),
      analyzer_source_sha256: digest('analyzer-source'), node_version: '22.22.1', unicode_version: '16.0', icu_version: '76.1',
    },
    source_revision: 'source-1', builder_artifact_sha256: digest('builder'), sqlite_version: '3.50.4', atoms,
  };
}

export function stateDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'echo-retrieval-generation-'));
}

export function removeStateDirectory(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
}
