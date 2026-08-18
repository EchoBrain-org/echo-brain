import { Buffer } from 'node:buffer';
import { generateKeyPairSync, sign as signMessage } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalSha256,
  normalizeP256LowS,
  p256KeyId,
} from '@echo-brain/federation-protocol';
import type { P256SigningKeyDescriptor } from '@echo-brain/federation-protocol';
import {
  organizationAuthorityPinSha256,
  organizationMemberReadableApprovalPresentation,
  organizationMemberReadableApprovalPresentationSha256,
  organizationMemberReadablePolicyContractSha256,
  organizationMemberReadableReleaseDraftSha256,
  projectOrganizationMemberReadableReleaseDraft,
  validateOrganizationRecordEnvelope,
  verifyOrganizationAuthorityPin,
} from '@echo-brain/organization-protocol';
import type {
  CanonicalPayloadSigner,
  OrganizationAuthorityDescriptorV1,
} from '@echo-brain/organization-protocol';
import { ProtocolOrganizationRecordEnvelopeBuilder } from '@echo-brain/organization-authority/processing/record/protocol-record-envelope-builder.js';
import type {
  OrganizationRecordAuthorizationEvidence,
  OrganizationRecordEnvelopeBuildInput,
} from '../../src/product/organization/record/index.js';
import { decisionApprovalId } from '../../src/product/index.js';

const EVALUATED_AT = '2026-08-12T12:00:00.000Z';
const MEETING_ID = 'granola:meeting-2026-08-12';
const PROCESSING_KEY =
  'granola:primary:granola-2026-08-12:rev-1:structured-text:default:1.0.0';
const APPROVAL_ID = decisionApprovalId(PROCESSING_KEY);

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
  audit: id('aud', 1),
} as const;

function digest(seed: string): `sha256:${string}` {
  return canonicalSha256(seed);
}

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

function brief(): Record<string, unknown> {
  return {
    schema_version: 1,
    id: 'brief-1',
    meeting: { id: MEETING_ID, title: 'Pricing review', participants: [] },
    decisions: [
      {
        id: 'signal-decision-1',
        kind: 'decision',
        text: 'Ship the organization-member pilot on the twelfth.',
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
      generated_at: '2026-08-12T11:00:00.000Z',
    },
  };
}

const draft = projectOrganizationMemberReadableReleaseDraft({
  approval_id: APPROVAL_ID,
  brief: brief(),
});
const presentation = organizationMemberReadableApprovalPresentation({
  draft,
  approve_reaction: 'white_check_mark',
  reject_reaction: 'x',
});
const SEMANTIC_SHA256 = digest('semantic-intent');

function memberEvidence(
  overrides: Record<string, unknown> = {},
): OrganizationRecordAuthorizationEvidence {
  return {
    schema_version: 3,
    kind: 'echo-organization-authorization-evidence',
    policy_id: 'organization-member-readable-v1',
    policy_contract_sha256: organizationMemberReadablePolicyContractSha256(),
    authority_id: IDS.authority,
    organization_id: IDS.organization,
    enrollment_id: IDS.enrollment,
    installation_id: IDS.installation,
    request_id: IDS.request,
    approval_id: APPROVAL_ID,
    action: 'approve',
    request_sha256: digest('request'),
    provider_event_sha256: digest('provider-event'),
    allowed: true,
    reason_code: 'active_organization_member_readable_notice_v1',
    principal_id: IDS.principal,
    membership_id: IDS.membership,
    adapter_binding_id: IDS.binding,
    permission_grant_id: IDS.grant,
    evaluated_at: EVALUATED_AT,
    authorization_audit_event_id: IDS.audit,
    authorization_audit_entry_sha256: digest('audit-entry'),
    release_draft_sha256: organizationMemberReadableReleaseDraftSha256(draft),
    approval_presentation_sha256:
      organizationMemberReadableApprovalPresentationSha256(presentation),
    semantic_intent_sha256: SEMANTIC_SHA256,
    message_presentation_sha256: digest('message-presentation'),
    ...overrides,
  } as unknown as OrganizationRecordAuthorizationEvidence;
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
      external_id: 'granola-2026-08-12',
    },
    meeting_id: MEETING_ID,
    brief: brief() as never,
    alternatives: [],
    links: { parent: null, supersedes: null },
    reviewed_at: EVALUATED_AT,
    reviewed_by: 'Reviewer One',
    reason: null,
    surface: 'slack-organization-member-readable-v1',
    authorization: memberEvidence(),
    submitted_at: '2026-08-12T12:00:01.000Z',
    ...overrides,
  };
}

describe('organization-member record envelope v3', () => {
  const authorityKey = generatedKey();
  const descriptor: OrganizationAuthorityDescriptorV1 = {
    schema_version: 1,
    kind: 'echo-organization-authority',
    authority_id: IDS.authority,
    organization_id: IDS.organization,
    signing_key: authorityKey.descriptor,
  };
  const installation = generatedKey();
  const builder = new ProtocolOrganizationRecordEnvelopeBuilder({
    pinnedAuthority: verifyOrganizationAuthorityPin(
      descriptor,
      organizationAuthorityPinSha256(descriptor),
    ),
    installationSigningKey: installation.descriptor,
    sign: installation.sign,
  });

  it('builds a signed v3 envelope whose payload reproduces the authorized release', async () => {
    const built = await builder.build(buildInput());
    const envelope = validateOrganizationRecordEnvelope(built.envelope);

    expect(envelope.schema_version).toBe(3);
    expect(envelope.event_type).toBe('approval');
    if (envelope.schema_version !== 3) throw new Error('expected v3');
    expect(envelope.payload.surface).toBe(
      'slack-organization-member-readable-v1',
    );
    expect(envelope.intent).toEqual({
      schema_version: 1,
      visibility: 'organization-member-readable',
      policy_id: 'organization-member-readable-v1',
      policy_contract_sha256: organizationMemberReadablePolicyContractSha256(),
      provenance: {
        kind: 'approval-surface-confirmation-v1',
        semantic_intent_sha256: SEMANTIC_SHA256,
      },
    });
    expect(envelope.reviewer.authorization.release_draft_sha256).toBe(
      organizationMemberReadableReleaseDraftSha256(draft),
    );
  });

  it('refuses a payload that no longer reproduces the authorized release', async () => {
    const altered = brief();
    (
      (altered['decisions'] as Record<string, unknown>[])[0] as Record<
        string,
        unknown
      >
    )['text'] = 'Ship something else entirely.';

    await expect(
      builder.build(buildInput({ brief: altered as never })),
    ).rejects.toThrow(/does not reproduce the approved release draft/);
  });

  it('refuses rejection and time bindings that contradict the authorization', async () => {
    await expect(
      builder.build(buildInput({ event_type: 'rejection' })),
    ).rejects.toThrow(/schema version 3 admits approval only/);
    await expect(
      builder.build(buildInput({ reviewed_at: '2026-08-12T12:00:05.000Z' })),
    ).rejects.toThrow(/approval time binding is invalid/);
    await expect(
      builder.build(buildInput({ submitted_at: '2026-08-12T11:59:59.000Z' })),
    ).rejects.toThrow(/approval time binding is invalid/);
  });

  it('refuses a policy contract other than the built-in member-readable contract', async () => {
    await expect(
      builder.build(
        buildInput({
          authorization: memberEvidence({
            policy_contract_sha256: digest('another-policy'),
          }),
        }),
      ),
    ).rejects.toThrow(/policy contract is unsupported/);
  });
});
