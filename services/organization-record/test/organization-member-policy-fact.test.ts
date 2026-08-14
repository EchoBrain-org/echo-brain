import { afterAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { canonicalJson, sha256Digest } from '@echo-brain/federation-protocol';
import {
  createOrganizationMemberEligibilityCapabilityChannel,
  deriveOrganizationMemberReadableEligibilityProof,
  organizationMemberPolicyFactSetSha256,
  projectOrganizationMemberPolicyFacts,
  type OrganizationMemberReadableEnvelopeView,
} from '../src/append.js';
import { OrganizationRecordLogStore } from '../src/append.js';
import { createOrganizationRecordRetrievalBuildPort } from '../src/retrieval-build.js';
import { removeTemporaryDirectories, temporaryStateDirectory } from './support/fixtures.js';

afterAll(removeTemporaryDirectories);

const digest = (suffix: string) => `sha256:${suffix.repeat(64).slice(0, 64)}` as `sha256:${string}`;

const envelope: OrganizationMemberReadableEnvelopeView = {
  schema_version: 3,
  authority_id: 'oau_test',
  organization_id: 'org_test',
  envelope_id: 'rec_test',
  idempotency_key: 'a'.repeat(64),
  installation_id: 'ins_test',
  approving_principal_id: 'prn_approver',
  approving_membership_id: 'mem_approver',
  policy_contract_sha256: digest('1'),
  release_draft_sha256: digest('2'),
  approval_presentation_sha256: digest('3'),
  semantic_intent_sha256: digest('4'),
  message_presentation_sha256: digest('5'),
  authorization_audit_event_id: 'aud_test',
  authorization_audit_entry_sha256: digest('6'),
  evaluated_at: '2026-08-12T00:00:00.000Z',
  signals: [
    { id: 'signal-a', kind: 'decision', text: 'Ship the bounded slice.' },
    { id: 'signal-b', kind: 'rationale', text: 'It remains separately proven.' },
  ],
};

describe('organization-member-readable v3 fact plane', () => {
  it('projects exact text-free facts and binds content and provenance independently', () => {
    const input = {
      organization_id: 'org_test',
      log_position: 7,
      record_hash: digest('7'),
      envelope_sha256: digest('8'),
      envelope,
    } as const;
    const facts = projectOrganizationMemberPolicyFacts(input);
    expect(facts).toHaveLength(2);
    expect(facts[0]?.atom_order).toBe(0);
    expect(facts[1]?.atom_order).toBe(1);
    expect(facts[0]?.content_binding_sha256).not.toBe(facts[1]?.content_binding_sha256);
    expect(facts[0]?.provenance_binding_sha256).toBe(facts[1]?.provenance_binding_sha256);
    expect(organizationMemberPolicyFactSetSha256(facts)).toBe(
      organizationMemberPolicyFactSetSha256(projectOrganizationMemberPolicyFacts(input)),
    );
  });

  it('spends an opaque capability before comparison and rejects reuse', () => {
    const channel = createOrganizationMemberEligibilityCapabilityChannel();
    const proof = deriveOrganizationMemberReadableEligibilityProof({
      organization_id: 'org_test',
      canonical_envelope_sha256: digest('8'),
      envelope,
    });
    const capability = channel.issue(proof.preimage);
    expect(
      channel.consume(capability, {
        organization_id: 'org_test',
        envelope_id: 'rec_test',
        idempotency_key: 'a'.repeat(64),
        installation_id: 'ins_test',
        canonical_envelope_sha256: digest('8'),
      }).authorization_proof_sha256,
    ).toBe(proof.authorization_proof_sha256);
    expect(() =>
      channel.consume(capability, {
        organization_id: 'org_test', envelope_id: 'rec_test',
        idempotency_key: 'a'.repeat(64), installation_id: 'ins_test',
        canonical_envelope_sha256: digest('8'),
      }),
    ).toThrow(/already consumed/);
  });

  it('co-commits v3 facts and reproves an exact duplicate with a fresh capability', () => {
    const document = {
      kind: 'echo-organization-record-envelope', schema_version: 3,
      event_type: 'approval', envelope_id: 'rec_test', idempotency_key: 'a'.repeat(64),
      submitter: { installation_id: 'ins_test' },
      intent: { policy_id: 'organization-member-readable-v1', visibility: 'organization-member-readable' },
    } as const;
    const canonical_envelope = canonicalJson(document);
    const envelope_sha256 = sha256Digest(canonical_envelope);
    const validator = () => envelope;
    const log = OrganizationRecordLogStore.open(
      join(temporaryStateDirectory(), 'v3-log.sqlite'),
      { organization_id: 'org_test', authority_id: 'oau_test', organization_member_validator: validator },
    );
    const attempt = () => {
      const channel = createOrganizationMemberEligibilityCapabilityChannel();
      const proof = deriveOrganizationMemberReadableEligibilityProof({
        organization_id: 'org_test', canonical_envelope_sha256: envelope_sha256, envelope,
      });
      return {
        envelope: { envelope: document, envelope_id: 'rec_test', event_type: 'approval' as const, idempotency_key: 'a'.repeat(64), installation_id: 'ins_test' },
        canonical_envelope,
        envelope_sha256,
        organization_member_eligibility: { capability: channel.issue(proof.preimage), channel },
      };
    };
    try {
      expect(log.append(attempt()).outcome).toBe('appended');
      expect(log.database.prepare('SELECT COUNT(*) AS count FROM organization_member_readable_policy_fact').get()).toEqual({ count: 2 });
      expect(log.append(attempt()).outcome).toBe('duplicate');
      expect(log.database.prepare('SELECT COUNT(*) AS count FROM organization_record_log').get()).toEqual({ count: 1 });
    } finally {
      log.close();
    }
  });

  it('returns no v3 text until facts reproject, pins ordering, and rejects a wrong head', () => {
    const document = {
      kind: 'echo-organization-record-envelope', schema_version: 3,
      event_type: 'approval', envelope_id: 'rec_test', idempotency_key: 'a'.repeat(64),
      submitter: { installation_id: 'ins_test' },
      intent: { policy_id: 'organization-member-readable-v1', visibility: 'organization-member-readable' },
    } as const;
    const canonical_envelope = canonicalJson(document);
    const envelope_sha256 = sha256Digest(canonical_envelope);
    const log = OrganizationRecordLogStore.open(
      join(temporaryStateDirectory(), 'build-source.sqlite'),
      { organization_id: 'org_test', authority_id: 'oau_test', organization_member_validator: () => envelope },
    );
    try {
      const channel = createOrganizationMemberEligibilityCapabilityChannel();
      const proof = deriveOrganizationMemberReadableEligibilityProof({
        organization_id: 'org_test', canonical_envelope_sha256: envelope_sha256, envelope,
      });
      log.append({
        envelope: { envelope: document, envelope_id: 'rec_test', event_type: 'approval', idempotency_key: 'a'.repeat(64), installation_id: 'ins_test' },
        canonical_envelope, envelope_sha256,
        organization_member_eligibility: { capability: channel.issue(proof.preimage), channel },
      });
      const port = createOrganizationRecordRetrievalBuildPort(log.database, {
        organization_id: 'org_test', authority_id: 'oau_test',
        restricted_reviewer_policy_contract_sha256: digest('r'),
        reviewer_validator: () => { throw new Error('reviewer validator must not be used'); },
        organization_member_validator: () => envelope,
      });
      const batch = port.readAt(port.record_head);
      expect(batch.organization_member_items.map((item) => item.text)).toEqual([
        'Ship the bounded slice.', 'It remains separately proven.',
      ]);
      expect(batch.organization_member_items.map((item) => item.atom_order)).toEqual([0, 1]);
      expect(() => port.readAt({ position: 2, record_hash: port.record_head.record_hash })).toThrow(/captured immutable head/);
    } finally {
      log.close();
    }
  });

  it('fails before returning content when a v3 fact is missing', () => {
    const document = {
      kind: 'echo-organization-record-envelope', schema_version: 3,
      event_type: 'approval', envelope_id: 'rec_test', idempotency_key: 'a'.repeat(64),
      submitter: { installation_id: 'ins_test' },
      intent: { policy_id: 'organization-member-readable-v1', visibility: 'organization-member-readable' },
    } as const;
    const canonical_envelope = canonicalJson(document);
    const envelope_sha256 = sha256Digest(canonical_envelope);
    const log = OrganizationRecordLogStore.open(
      join(temporaryStateDirectory(), 'build-source-corrupt.sqlite'),
      { organization_id: 'org_test', authority_id: 'oau_test', organization_member_validator: () => envelope },
    );
    try {
      const channel = createOrganizationMemberEligibilityCapabilityChannel();
      const proof = deriveOrganizationMemberReadableEligibilityProof({
        organization_id: 'org_test', canonical_envelope_sha256: envelope_sha256, envelope,
      });
      log.append({
        envelope: { envelope: document, envelope_id: 'rec_test', event_type: 'approval', idempotency_key: 'a'.repeat(64), installation_id: 'ins_test' },
        canonical_envelope, envelope_sha256,
        organization_member_eligibility: { capability: channel.issue(proof.preimage), channel },
      });
      log.database.exec('DROP TRIGGER organization_member_readable_policy_fact_immutable_delete; DELETE FROM organization_member_readable_policy_fact');
      expect(() => createOrganizationRecordRetrievalBuildPort(log.database, {
        organization_id: 'org_test', authority_id: 'oau_test',
        restricted_reviewer_policy_contract_sha256: digest('r'),
        reviewer_validator: () => { throw new Error('unused'); },
        organization_member_validator: () => envelope,
      })).toThrow(/facts do not reproject/);
    } finally {
      log.close();
    }
  });
});
