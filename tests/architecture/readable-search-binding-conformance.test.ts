import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { canonicalJson } from '@echo-brain/federation-protocol';
import { describe, expect, it } from 'vitest';
import {
  organizationRecordItemContentBindingSha256,
  organizationRecordMemberProvenanceBindingSha256,
  organizationRecordReviewerProvenanceBindingSha256,
} from '../../services/organization-record/src/application/retrieval-policy-binding.js';
import {
  readableSearchContentBindingSha256,
  readableSearchProvenanceBindingSha256,
} from '../../services/organization-retrieval/src/application/upstream-input.js';
import type { RetrievalPermissionFact } from '../../services/organization-retrieval/src/application/contracts.js';

const REPO = resolve(import.meta.dirname, '../..');
const digest = (character: string): `sha256:${string}` =>
  `sha256:${character.repeat(64)}`;

const contentPreimage = Object.freeze({
  schema_version: 1,
  kind: 'organization-record-item-content-binding-v1',
  organization_id: 'org_vector',
  envelope_sha256: digest('1'),
  log_position: 7,
  record_hash: digest('2'),
  atom_id: digest('3'),
  atom_order: 1,
  signal_id_sha256: digest('4'),
  item_kind: 'action' as const,
  text_sha256: digest('5'),
});

const sharedProvenance = Object.freeze({
  organization_id: 'org_vector',
  envelope_sha256: digest('1'),
  log_position: 7,
  record_hash: digest('2'),
  policy_contract_sha256: digest('6'),
  release_draft_sha256: digest('7'),
  approval_presentation_sha256: digest('8'),
  semantic_intent_sha256: digest('9'),
  message_presentation_sha256: digest('a'),
  authorization_audit_event_id: 'aud_vector',
  authorization_audit_entry_sha256: digest('b'),
  authorization_proof_sha256: digest('c'),
  evaluated_at: '2026-08-14T00:00:00.000Z',
});

function fact(
  policy: 'organization-member-readable-v1' | 'restricted-reviewer-v1',
): RetrievalPermissionFact {
  const reviewer = policy === 'restricted-reviewer-v1';
  return Object.freeze({
    atom_id: contentPreimage.atom_id,
    organization_id: contentPreimage.organization_id,
    envelope_sha256: contentPreimage.envelope_sha256,
    log_position: contentPreimage.log_position,
    record_hash: contentPreimage.record_hash,
    atom_order: contentPreimage.atom_order,
    signal_id_sha256: contentPreimage.signal_id_sha256,
    item_kind: contentPreimage.item_kind,
    policy_id: policy,
    policy_contract_sha256: sharedProvenance.policy_contract_sha256,
    approval_actor_principal_id: reviewer ? 'prn_reviewer' : 'prn_approver',
    approval_actor_membership_id: reviewer ? 'mem_reviewer' : 'mem_approver',
    reviewer_principal_id: reviewer ? 'prn_reviewer' : null,
    reviewer_membership_id: reviewer ? 'mem_reviewer' : null,
    release_draft_sha256: sharedProvenance.release_draft_sha256,
    approval_presentation_sha256:
      sharedProvenance.approval_presentation_sha256,
    semantic_intent_sha256: sharedProvenance.semantic_intent_sha256,
    message_presentation_sha256:
      sharedProvenance.message_presentation_sha256,
    authorization_audit_event_id:
      sharedProvenance.authorization_audit_event_id,
    authorization_audit_entry_sha256:
      sharedProvenance.authorization_audit_entry_sha256,
    evaluated_at: sharedProvenance.evaluated_at,
    authorization_proof_sha256:
      sharedProvenance.authorization_proof_sha256,
    content_binding_sha256:
      'sha256:61da5c512a54c0151bc6947f9a70ad04ae040c64cfcbddbce69ad4076dbdb841',
    provenance_binding_sha256: reviewer
      ? 'sha256:61d7f7478e3d9f4fb764aef40abe407ef14068b9a0f1a34a99b333941da2dc21'
      : 'sha256:0564faaf0ee9c7f39eeee74974db959a6e04beac3dc030456d89f98d51ed7722',
  });
}

describe('readable-search trust binding conformance', () => {
  it('pins one exact content preimage across independent producer and consumer implementations', () => {
    const expected =
      'sha256:61da5c512a54c0151bc6947f9a70ad04ae040c64cfcbddbce69ad4076dbdb841';
    expect(canonicalJson(contentPreimage)).toBe(
      '{"atom_id":"sha256:3333333333333333333333333333333333333333333333333333333333333333","atom_order":1,"envelope_sha256":"sha256:1111111111111111111111111111111111111111111111111111111111111111","item_kind":"action","kind":"organization-record-item-content-binding-v1","log_position":7,"organization_id":"org_vector","record_hash":"sha256:2222222222222222222222222222222222222222222222222222222222222222","schema_version":1,"signal_id_sha256":"sha256:4444444444444444444444444444444444444444444444444444444444444444","text_sha256":"sha256:5555555555555555555555555555555555555555555555555555555555555555"}',
    );
    expect(organizationRecordItemContentBindingSha256(contentPreimage)).toBe(
      expected,
    );
    expect(readableSearchContentBindingSha256({
      fact: fact('organization-member-readable-v1'),
      text_sha256: contentPreimage.text_sha256,
    })).toBe(expected);
  });

  it('pins exact member and reviewer provenance vectors across the trust boundary', () => {
    const member = fact('organization-member-readable-v1');
    const reviewer = fact('restricted-reviewer-v1');
    const memberExpected =
      'sha256:0564faaf0ee9c7f39eeee74974db959a6e04beac3dc030456d89f98d51ed7722';
    const reviewerExpected =
      'sha256:61d7f7478e3d9f4fb764aef40abe407ef14068b9a0f1a34a99b333941da2dc21';
    expect(organizationRecordMemberProvenanceBindingSha256({
      ...sharedProvenance,
      approving_principal_id: member.approval_actor_principal_id,
      approving_membership_id: member.approval_actor_membership_id,
    })).toBe(memberExpected);
    expect(readableSearchProvenanceBindingSha256(member)).toBe(memberExpected);
    expect(organizationRecordReviewerProvenanceBindingSha256({
      ...sharedProvenance,
      reviewer_principal_id: reviewer.reviewer_principal_id!,
      reviewer_membership_id: reviewer.reviewer_membership_id!,
    })).toBe(reviewerExpected);
    expect(readableSearchProvenanceBindingSha256(reviewer)).toBe(
      reviewerExpected,
    );
  });

  it('forbids runtime object spread inside the V1 trust-digest constructors', () => {
    const files = [
      'services/organization-record/src/application/retrieval-policy-binding.ts',
      'services/organization-retrieval/src/application/upstream-input.ts',
      'services/organization-retrieval/src/application/manifests.ts',
      'services/organization-authority/src/application/organization-recording-policy-activation.ts',
    ];
    const violations: string[] = [];
    for (const relativePath of files) {
      const source = ts.createSourceFile(
        relativePath,
        readFileSync(resolve(REPO, relativePath), 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'canonicalSha256' &&
          node.arguments[0] !== undefined &&
          ts.isObjectLiteralExpression(node.arguments[0]) &&
          node.arguments[0].properties.some(ts.isSpreadAssignment)
        ) {
          const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          violations.push(`${relativePath}:${line}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(violations).toEqual([]);
  });
});
