import { Buffer } from 'node:buffer';
import {
  createHash,
  generateKeyPairSync,
  sign as signMessage,
} from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalSha256,
  normalizeP256LowS,
  p256KeyId,
} from '@echo-brain/federation-protocol';
import type { P256SigningKeyDescriptor } from '@echo-brain/federation-protocol';
import {
  organizationAuthorityPinSha256,
  validateOrganizationRecordEnvelope,
  verifyOrganizationAuthorityPin,
} from '@echo-brain/organization-protocol';
import type {
  CanonicalPayloadSigner,
  OrganizationAuthorityDescriptorV1,
  OrganizationRecordDecisionBriefV1,
  OrganizationRecordReviewerAuthorizationV1,
} from '@echo-brain/organization-protocol';
import { ProtocolOrganizationRecordEnvelopeBuilder } from '../src/processing/record/protocol-record-envelope-builder.js';
import type { OrganizationRecordEnvelopeBuildInput } from '../src/processing/record/ports.js';

const NOW = '2026-08-19T12:00:00.000Z';
const MEETING_ID = 'granola:meeting-2026-08-19';
const PROCESSING_KEY =
  'processing:v1:["granola","primary","meeting-2026-08-19","rev-1","structured-text","default","1.0.0"]';

function id(prefix: string, suffix: number): string {
  return `${prefix}_00000000-0000-4000-8000-${suffix
    .toString()
    .padStart(12, '0')}`;
}

const IDS = {
  authority: id('oau', 1),
  organization: id('org', 1),
  principal: id('prn', 1),
  membership: id('mem', 1),
  installation: id('ins', 1),
  enrollment: id('enr', 1),
  binding: id('bnd', 1),
  grant: id('pgr', 1),
  request: id('pcr', 1),
} as const;

function approvalId(processingKey: string): string {
  return createHash('sha256').update(processingKey, 'utf8').digest('hex');
}

const APPROVAL_ID = approvalId(PROCESSING_KEY);

function generatedKey(): {
  descriptor: P256SigningKeyDescriptor;
  sign: CanonicalPayloadSigner;
} {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  if (!Buffer.isBuffer(der)) throw new Error('unexpected key export');
  return {
    descriptor: {
      key_id: p256KeyId(der),
      algorithm: 'ecdsa-p256-sha256-der-low-s',
      public_key_spki_der_base64: der.toString('base64'),
    },
    sign: async (bytes) =>
      normalizeP256LowS(
        signMessage('sha256', bytes, { key: privateKey, dsaEncoding: 'der' }),
      ),
  };
}

function evidence(
  action: 'approve' | 'reject',
  idempotencyKey = APPROVAL_ID,
): OrganizationRecordReviewerAuthorizationV1 {
  return {
    schema_version: 1,
    kind: 'echo-organization-authorization-evidence',
    authority_id: IDS.authority,
    organization_id: IDS.organization,
    enrollment_id: IDS.enrollment,
    installation_id: IDS.installation,
    request_id: IDS.request,
    approval_id: idempotencyKey,
    action,
    request_sha256: canonicalSha256('request'),
    provider_event_sha256: canonicalSha256('provider-event'),
    allowed: true,
    reason_code: 'active_membership_and_direct_grant',
    principal_id: IDS.principal,
    membership_id: IDS.membership,
    adapter_binding_id: IDS.binding,
    permission_grant_id: IDS.grant,
    evaluated_at: NOW,
  };
}

function brief(): OrganizationRecordDecisionBriefV1 {
  return {
    schema_version: 1,
    id: 'brief-1',
    meeting: { id: MEETING_ID, participants: [] },
    decisions: [
      {
        id: 'signal-1',
        kind: 'decision',
        text: 'Ship the server-side record foundation.',
        subject: null,
        confidence: null,
        evidence: [{ meeting_id: MEETING_ID, block_id: 'block-1' }],
        status: 'decided',
      },
    ],
    actions: [],
    rationales: [],
    provenance: {
      meeting_revision: 'rev-1',
      processor: {
        kind: 'decision-processor',
        adapter_id: 'structured-text',
        instance_id: 'default',
        version: '1.0.0',
      },
      generated_at: NOW,
    },
  };
}

function buildInput(
  overrides: Partial<OrganizationRecordEnvelopeBuildInput> = {},
): OrganizationRecordEnvelopeBuildInput {
  return {
    event_type: 'approval',
    approval_id: APPROVAL_ID,
    source: {
      adapter_id: 'granola',
      instance_id: 'primary',
      external_id: 'meeting-2026-08-19',
    },
    meeting_id: MEETING_ID,
    brief: brief(),
    alternatives: [],
    links: { parent: null, supersedes: null },
    reviewed_at: NOW,
    reviewed_by: 'Founder',
    reason: null,
    surface: 'slack-reactions',
    authorization: evidence('approve'),
    submitted_at: NOW,
    ...overrides,
  };
}

function fixture() {
  const authorityKey = generatedKey();
  const descriptor: OrganizationAuthorityDescriptorV1 = {
    schema_version: 1,
    kind: 'echo-organization-authority',
    authority_id: IDS.authority,
    organization_id: IDS.organization,
    signing_key: authorityKey.descriptor,
  };
  const installationKey = generatedKey();
  let nextId = 1;
  return {
    installationKey,
    builder: new ProtocolOrganizationRecordEnvelopeBuilder({
      pinnedAuthority: verifyOrganizationAuthorityPin(
        descriptor,
        organizationAuthorityPinSha256(descriptor),
      ),
      installationSigningKey: installationKey.descriptor,
      sign: installationKey.sign,
      nextEnvelopeId: () => id('rec', nextId++),
    }),
  };
}

describe('protocol organization record envelope builder', () => {
  it('maps an approved processing result onto a protocol-valid approval', async () => {
    const { builder, installationKey } = fixture();
    const built = await builder.build(buildInput());
    const envelope = validateOrganizationRecordEnvelope(built.envelope);

    expect(envelope.event_type).toBe('approval');
    if (envelope.event_type !== 'approval') throw new Error('expected approval');
    expect(built.idempotency_key).toBe(APPROVAL_ID);
    expect(envelope.payload).toMatchObject({
      brief: brief(),
      source: buildInput().source,
      alternatives: [],
      links: null,
      reviewed_at: NOW,
      surface: 'slack-reactions',
    });
    expect(envelope.intent).toEqual({
      restricted: true,
      reconsider_after: null,
    });
    expect(envelope.reviewer.principal_id).toBe(IDS.principal);
    expect(envelope.submitter.installation_id).toBe(IDS.installation);
    expect(envelope.integrity.key_id).toBe(installationKey.descriptor.key_id);
  });

  it('maps rejection without leaking the rejected brief or alternatives', async () => {
    const { builder } = fixture();
    const built = await builder.build(
      buildInput({
        event_type: 'rejection',
        brief: null,
        reason: 'Needs another pass.',
        authorization: evidence('reject'),
      }),
    );
    const envelope = validateOrganizationRecordEnvelope(built.envelope);

    expect(envelope.event_type).toBe('rejection');
    if (envelope.event_type !== 'rejection') throw new Error('expected rejection');
    expect(envelope.payload).toEqual({
      source: buildInput().source,
      meeting_id: MEETING_ID,
      rejected_at: NOW,
      reason: 'Needs another pass.',
      reconsider_after: null,
    });
    expect(envelope).not.toHaveProperty('intent');
  });

  it('keeps processing-key-derived idempotency stable across envelope retries', async () => {
    const { builder } = fixture();
    const first = await builder.build(buildInput());
    const retry = await builder.build(buildInput());
    const changedProcessingKey = PROCESSING_KEY.replace('rev-1', 'rev-2');
    const changedApprovalId = approvalId(changedProcessingKey);
    const changed = await builder.build(
      buildInput({
        approval_id: changedApprovalId,
        authorization: evidence('approve', changedApprovalId),
      }),
    );

    expect(first.envelope_id).not.toBe(retry.envelope_id);
    expect(first.idempotency_key).toBe(APPROVAL_ID);
    expect(retry.idempotency_key).toBe(first.idempotency_key);
    expect(changed.idempotency_key).toBe(changedApprovalId);
    expect(changed.idempotency_key).not.toBe(first.idempotency_key);
  });
});
