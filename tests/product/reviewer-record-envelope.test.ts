import { Buffer } from 'node:buffer';
import { generateKeyPairSync, sign as signMessage } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalSha256,
  normalizeP256LowS,
  p256KeyId,
} from '@echo-brain/federation-protocol';
import type { P256SigningKeyDescriptor } from '@echo-brain/federation-protocol';
import type { CanonicalPayloadSigner } from '@echo-brain/organization-protocol';
import {
  organizationAuthorityPinSha256,
  projectReviewerReleaseDraft,
  reviewerApprovalPresentation,
  reviewerApprovalPresentationSha256,
  reviewerReleaseDraftSha256,
  validateOrganizationRecordEnvelope,
  verifyOrganizationAuthorityPin,
} from '@echo-brain/organization-protocol';
import type { OrganizationAuthorityDescriptorV1 } from '@echo-brain/organization-protocol';
import { ProtocolOrganizationRecordEnvelopeBuilder } from '../../src/product/organization/record/adapters/protocol-record-envelope-builder.js';
import type {
  OrganizationRecordAuthorizationEvidence,
  OrganizationRecordEnvelopeBuildInput,
} from '../../src/product/organization/record/index.js';
import type { ApprovalRequest } from '../../src/core/index.js';
import {
  DecisionNodeStore,
  decisionApprovalId,
} from '../../src/product/index.js';

const EVALUATED_AT = '2026-08-11T12:00:00.000Z';
const MEETING_ID = 'granola:meeting-2026-08-11';

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

const PROCESSING_KEY =
  'granola:primary:granola-2026-08-11:rev-1:structured-text:default:1.0.0';
const APPROVAL_ID = decisionApprovalId(PROCESSING_KEY);

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
        text: 'Ship the reviewer pilot on the eleventh.',
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
      generated_at: '2026-08-11T11:00:00.000Z',
    },
  };
}

const draft = projectReviewerReleaseDraft({
  approval_id: APPROVAL_ID,
  brief: brief(),
});
const presentation = reviewerApprovalPresentation({
  draft,
  approve_reaction: 'white_check_mark',
  reject_reaction: 'x',
});
const SEMANTIC_SHA256 = digest('semantic-intent');

function reviewerEvidence(
  overrides: Record<string, unknown> = {},
): OrganizationRecordAuthorizationEvidence {
  return {
    schema_version: 2,
    kind: 'echo-organization-authorization-evidence',
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
    reason_code: 'active_reviewer_restricted_notice_v1',
    principal_id: IDS.principal,
    membership_id: IDS.membership,
    adapter_binding_id: IDS.binding,
    permission_grant_id: IDS.grant,
    evaluated_at: EVALUATED_AT,
    authorization_audit_event_id: IDS.audit,
    authorization_audit_entry_sha256: digest('audit-entry'),
    reviewer_release_draft_sha256: reviewerReleaseDraftSha256(draft),
    approval_presentation_sha256:
      reviewerApprovalPresentationSha256(presentation),
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
      external_id: 'granola-2026-08-11',
    },
    meeting_id: MEETING_ID,
    brief: brief() as never,
    alternatives: [],
    links: { parent: null, supersedes: null },
    reviewed_at: EVALUATED_AT,
    reviewed_by: 'Reviewer One',
    reason: null,
    surface: 'slack-reviewer-v1',
    authorization: reviewerEvidence(),
    submitted_at: '2026-08-11T12:00:01.000Z',
    ...overrides,
  };
}

describe('reviewer record envelope v2', () => {
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

  it('builds a signed envelope v2 whose payload reproduces the approved draft', async () => {
    const built = await builder.build(buildInput());
    const envelope = validateOrganizationRecordEnvelope(built.envelope);
    expect(envelope.schema_version).toBe(2);
    expect(envelope.event_type).toBe('approval');
    if (envelope.schema_version !== 2) throw new Error('expected v2');
    expect(envelope.payload.surface).toBe('slack-reviewer-v1');
    expect(envelope.intent).toEqual({
      schema_version: 1,
      visibility: 'restricted',
      policy_id: 'restricted-reviewer-v1',
      provenance: {
        kind: 'approval-surface-confirmation-v1',
        semantic_intent_sha256: SEMANTIC_SHA256,
      },
    });
    expect(envelope.reviewer.authorization.reviewer_release_draft_sha256).toBe(
      reviewerReleaseDraftSha256(draft),
    );
  });

  it('refuses a payload that no longer reprojects to the approved draft', async () => {
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

  it('refuses a reviewer rejection and a mismatched action time', async () => {
    await expect(
      builder.build(buildInput({ event_type: 'rejection' })),
    ).rejects.toThrow(/schema version 2 admits approval only/);
    await expect(
      builder.build(buildInput({ reviewed_at: '2026-08-11T12:00:05.000Z' })),
    ).rejects.toThrow(/reviewed_at must be the authority evaluation time/);
    await expect(
      builder.build(buildInput({ submitted_at: '2026-08-11T11:59:59.000Z' })),
    ).rejects.toThrow(/submitted_at precedes the approval/);
  });

  it('refuses an envelope whose intent was desynchronized from its evidence', async () => {
    const built = await builder.build(buildInput());
    const envelope = built.envelope as unknown as Record<string, unknown>;
    expect(() =>
      validateOrganizationRecordEnvelope({
        ...envelope,
        intent: {
          schema_version: 1,
          visibility: 'restricted',
          policy_id: 'restricted-reviewer-v1',
          provenance: {
            kind: 'approval-surface-confirmation-v1',
            semantic_intent_sha256: digest('other-semantic'),
          },
        },
      }),
    ).toThrow(/does not quote the authorized semantic intent/);
    expect(() =>
      validateOrganizationRecordEnvelope({
        ...envelope,
        intent: { restricted: true, reconsider_after: null },
      }),
    ).toThrow(/has an unexpected shape/);
  });
});

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

function request(): ApprovalRequest {
  return {
    processing_key: PROCESSING_KEY,
    requested_at: '2026-08-11T11:00:00.000Z',
    meeting: {
      schema_version: 1,
      id: MEETING_ID,
      title: 'Pricing review',
      capture: { state: 'complete', components: [] },
      participants: [],
      content: [],
      artifacts: [],
      provenance: {
        source: {
          kind: 'meeting-source',
          adapter_id: 'granola',
          instance_id: 'primary',
          version: '1',
        },
        external_id: 'granola-2026-08-11',
        canonical_revision: 'rev-1',
        observed_at: '2026-08-11T10:15:00.000Z',
        normalizer_version: '1',
        source_updated_at: '2026-08-11T10:15:00.000Z',
      },
    },
    decisions: {
      schema_version: 1,
      meeting_id: MEETING_ID,
      meeting_revision: 'rev-1',
      processor: {
        kind: 'decision-processor',
        adapter_id: 'structured-text',
        instance_id: 'default',
        version: '1.0.0',
      },
      generated_at: '2026-08-11T11:00:00.000Z',
      signals: [],
    },
    brief: brief(),
  } as unknown as ApprovalRequest;
}

async function stagedStore(): Promise<DecisionNodeStore> {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-resolve-'));
  roots.push(root);
  const store = new DecisionNodeStore(root, {
    now: () => '2026-08-11T13:00:00.000Z',
  });
  await store.ensureRequested(request());
  await store.freezeApprovalPresentationContract({
    approvalId: APPROVAL_ID,
    contract: {
      schema_version: 1,
      kind: 'echo-slack-approval-presentation-contract',
      mode: 'restricted-reviewer-v1',
      adapter_id: 'slack-reactions',
      adapter_instance_id: 'default',
      adapter_version: '1.0.0',
      channel_id: 'C012CHANNEL',
      reviewer_slack_user_id: 'U012REVIEWER',
      reviewer_name: 'Reviewer One',
      credential_ref: 'env:ECHO_SLACK_BOT_TOKEN',
      credential_fingerprint_sha256: digest('credential'),
      approve_reaction: 'white_check_mark',
      reject_reaction: 'x',
      reviewer_release_draft_sha256: reviewerReleaseDraftSha256(draft),
      approval_presentation_sha256:
        reviewerApprovalPresentationSha256(presentation),
    },
  });
  return store;
}

describe('reviewer resolution', () => {
  const metadata = { authorization: reviewerEvidence() } as never;

  it('records the authority evaluation time instead of the local clock', async () => {
    const store = await stagedStore();
    const resolved = await store.resolve({
      approvalId: APPROVAL_ID,
      status: 'approved',
      reviewedBy: 'Reviewer One',
      surface: 'slack-reviewer-v1',
      reviewedAt: EVALUATED_AT,
      metadata,
    });
    expect(resolved.reviewed_at).toBe(EVALUATED_AT);
    expect(resolved.resolved_surface).toBe('slack-reviewer-v1');
    expect(Object.keys(resolved.resolved_metadata ?? {})).toEqual([
      'authorization',
    ]);
  });

  it('refuses a reviewer resolution that omits or contradicts the evaluation time', async () => {
    const store = await stagedStore();
    await expect(
      store.resolve({
        approvalId: APPROVAL_ID,
        status: 'approved',
        reviewedBy: 'Reviewer One',
        surface: 'slack-reviewer-v1',
        metadata,
      }),
    ).rejects.toThrow(/exact authority evidence/);
    await expect(
      store.resolve({
        approvalId: APPROVAL_ID,
        status: 'approved',
        reviewedBy: 'Reviewer One',
        surface: 'slack-reviewer-v1',
        reviewedAt: '2026-08-11T12:00:09.000Z',
        metadata,
      }),
    ).rejects.toThrow(/frozen presentation contract/);
    await expect(
      store.resolve({
        approvalId: APPROVAL_ID,
        status: 'approved',
        reviewedBy: 'Reviewer One',
        surface: 'slack-reviewer-v1',
        reviewedAt: EVALUATED_AT,
        metadata: {
          authorization: reviewerEvidence(),
          slack: { channel_id: 'C1' },
        } as never,
      }),
    ).rejects.toThrow(/exact authority evidence/);
  });

  it('rejects an evaluation time on a non-reviewer resolution', async () => {
    const store = await stagedStore();
    await expect(
      store.resolve({
        approvalId: APPROVAL_ID,
        status: 'approved',
        reviewedBy: 'Reviewer One',
        surface: 'slack',
        reviewedAt: EVALUATED_AT,
      }),
    ).rejects.toThrow(/only a reviewer resolution may supply an evaluation time/);
  });

  it('accepts the identical reviewer retry and refuses a divergent one', async () => {
    const store = await stagedStore();
    const input = {
      approvalId: APPROVAL_ID,
      status: 'approved' as const,
      reviewedBy: 'Reviewer One',
      surface: 'slack-reviewer-v1',
      reviewedAt: EVALUATED_AT,
      metadata,
    };
    await store.resolve(input);
    await expect(store.resolve(input)).resolves.toMatchObject({
      reviewed_at: EVALUATED_AT,
    });
    await expect(
      store.resolve({ ...input, reviewedAt: '2026-08-11T12:00:09.000Z' }),
    ).rejects.toThrow();
    await expect(
      store.resolve({
        ...input,
        metadata: {
          authorization: reviewerEvidence({ request_id: id('pcr', 2) }),
        } as never,
      }),
    ).rejects.toThrow(/already approved/);
  });
});
