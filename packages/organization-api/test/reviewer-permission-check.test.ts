import { Buffer } from 'node:buffer';
import { generateKeyPairSync, sign as signMessage } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  canonicalSha256,
  normalizeP256LowS,
  p256KeyId,
  type P256SigningKeyDescriptor,
} from '@echo-brain/federation-protocol';
import {
  RESTRICTED_REVIEWER_ALLOW_REASON_CODE,
  RESTRICTED_REVIEWER_POLICY_ID,
} from '@echo-brain/organization-protocol';
import {
  MAX_ORGANIZATION_REVIEWER_RECENT_DECISIONS_ITEMS,
  ORGANIZATION_API_PERMISSION_CHECKS_PATH,
  ORGANIZATION_API_REVIEWER_RECENT_DECISIONS_PATH,
  ORGANIZATION_REVIEWER_RECENT_DECISIONS_WITNESS,
  REVIEWER_PERMISSION_DENIAL_REASON_CODES,
  canonicalOrganizationReviewerPermissionCheckDecisionBytes,
  createOrganizationReviewerPermissionCheckRequest,
  createOrganizationReviewerRecentDecisionsRequest,
  organizationReviewerPermissionProviderEventSha256,
  validateOrganizationReviewerPermissionCheckDecision,
  validateOrganizationReviewerPermissionCheckRequest,
  validateOrganizationReviewerRecentDecisionsRequest,
  validateOrganizationReviewerRecentDecisionsResponse,
  verifyOrganizationReviewerPermissionCheckRequest,
  verifyOrganizationReviewerRecentDecisionsRequest,
  type CreateOrganizationReviewerPermissionCheckRequestInput,
} from '../src/index.js';

function installationKey(): {
  descriptor: P256SigningKeyDescriptor;
  sign(bytes: Buffer): Promise<Buffer>;
} {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' });
  if (!Buffer.isBuffer(publicKey)) throw new Error('test key export failed');
  return {
    descriptor: {
      key_id: p256KeyId(publicKey),
      algorithm: 'ecdsa-p256-sha256-der-low-s',
      public_key_spki_der_base64: publicKey.toString('base64'),
    },
    async sign(bytes: Buffer): Promise<Buffer> {
      return normalizeP256LowS(
        signMessage('sha256', bytes, {
          key: pair.privateKey,
          dsaEncoding: 'der',
        }),
      );
    },
  };
}

const digest = (character: string): `sha256:${string}` =>
  `sha256:${character.repeat(64)}`;

const IDS = {
  authority: 'oau_00000000-0000-4000-8000-000000000001',
  organization: 'org_00000000-0000-4000-8000-000000000001',
  enrollment: 'enr_00000000-0000-4000-8000-000000000001',
  installation: 'ins_00000000-0000-4000-8000-000000000001',
  principal: 'prn_00000000-0000-4000-8000-000000000001',
  membership: 'mem_00000000-0000-4000-8000-000000000001',
  binding: 'bnd_00000000-0000-4000-8000-000000000001',
  grant: 'pgr_00000000-0000-4000-8000-000000000001',
  audit: 'aud_00000000-0000-4000-8000-000000000001',
} as const;

function requestInput(
  key: P256SigningKeyDescriptor,
): CreateOrganizationReviewerPermissionCheckRequestInput {
  return {
    request_id: 'pcr_00000000-0000-4000-8000-000000000001',
    authority_id: IDS.authority,
    authority_key_id: digest('a'),
    organization_id: IDS.organization,
    enrollment_id: IDS.enrollment,
    installation_id: IDS.installation,
    installation_signing_key: key,
    provider: 'slack',
    provider_issuer: 'https://slack.com',
    provider_tenant_kind: 'workspace',
    provider_tenant_id: 'T012ABCDEF',
    provider_enterprise_id: null,
    provider_connection_subject_id: 'U012BOTUSER',
    provider_connection_bot_id: 'B012BOTID',
    provider_connection_app_id: 'A012APPID',
    provider_subject_kind: 'human_user',
    provider_subject_id: 'U012REVIEWER',
    adapter_kind: 'approval-surface',
    adapter_id: 'slack-reactions',
    adapter_instance_id: 'default',
    adapter_version: '1.0.0',
    approval_id: 'b'.repeat(64),
    channel_id: 'C012CHANNEL',
    message_ts: '1754900000.000100',
    reaction_name: 'white_check_mark',
    approve_reaction: 'white_check_mark',
    reject_reaction: 'x',
    reviewer_release_draft_sha256: digest('c'),
    approval_presentation_sha256: digest('d'),
    requested_at: '2026-08-11T12:00:00.000Z',
  };
}

describe('reviewer permission check request', () => {
  it('signs a content-free schema-v2 request bound to the exact operation', async () => {
    const key = installationKey();
    const request = await createOrganizationReviewerPermissionCheckRequest(
      requestInput(key.descriptor),
      key.sign,
    );
    expect(request.schema_version).toBe(2);
    expect(request.action).toBe('approve');
    expect(request.policy_id).toBe(RESTRICTED_REVIEWER_POLICY_ID);
    expect(request.http_method).toBe('POST');
    expect(request.http_path).toBe(ORGANIZATION_API_PERMISSION_CHECKS_PATH);
    expect(request.provider_event_sha256).toBe(
      organizationReviewerPermissionProviderEventSha256(request),
    );
    expect(
      verifyOrganizationReviewerPermissionCheckRequest(
        request,
        key.descriptor,
      ),
    ).toEqual(request);

    // No content, and no meeting or processing identity, is on the wire.
    for (const key_ of Object.keys(request)) {
      expect(key_).not.toMatch(/title|text|signal|meeting|processing|draft$/);
    }
  });

  it('rejects a rejection action, a duplicate pair, and a mismatched selection', async () => {
    const key = installationKey();
    const request = await createOrganizationReviewerPermissionCheckRequest(
      requestInput(key.descriptor),
      key.sign,
    );
    expect(() =>
      validateOrganizationReviewerPermissionCheckRequest({
        ...request,
        action: 'reject',
      }),
    ).toThrow('schema version 2 authorizes approval only');
    expect(() =>
      validateOrganizationReviewerPermissionCheckRequest({
        ...request,
        reject_reaction: 'white_check_mark',
      }),
    ).toThrow('approve and reject reactions must be distinct');
    expect(() =>
      validateOrganizationReviewerPermissionCheckRequest({
        ...request,
        reaction_name: 'x',
      }),
    ).toThrow('selected reaction must be the frozen approve reaction');
    expect(() =>
      validateOrganizationReviewerPermissionCheckRequest({
        ...request,
        policy_id: 'pilot-member-readable-v1',
      }),
    ).toThrow('policy_id is unsupported');
    expect(() =>
      validateOrganizationReviewerPermissionCheckRequest({
        ...request,
        http_path: '/v1/reviewer-recent-decisions',
      }),
    ).toThrow('HTTP operation is unsupported');
  });

  it('rejects hidden properties instead of treating them as a closed wire object', async () => {
    const key = installationKey();
    const request = await createOrganizationReviewerPermissionCheckRequest(
      requestInput(key.descriptor),
      key.sign,
    );
    const withHiddenField = { ...request } as Record<string, unknown>;
    Object.defineProperty(withHiddenField, 'hidden_content', {
      value: 'must never be ignored',
      enumerable: false,
    });

    expect(() =>
      validateOrganizationReviewerPermissionCheckRequest(withHiddenField),
    ).toThrow('must contain only enumerable data properties');
  });

  it('binds every frozen field into the provider event digest', async () => {
    const key = installationKey();
    const request = await createOrganizationReviewerPermissionCheckRequest(
      requestInput(key.descriptor),
      key.sign,
    );
    for (const field of [
      'approve_reaction',
      'reject_reaction',
      'reviewer_release_draft_sha256',
      'approval_presentation_sha256',
      'policy_id',
      'http_path',
    ] as const) {
      const mutated = {
        ...request,
        [field]:
          field === 'approve_reaction'
            ? 'heavy_check_mark'
            : field === 'reject_reaction'
              ? 'no_entry'
              : field === 'policy_id'
                ? 'other-policy'
                : field === 'http_path'
                  ? '/v1/other'
                  : digest('9'),
      };
      expect(() =>
        validateOrganizationReviewerPermissionCheckRequest(mutated),
      ).toThrow();
    }
  });
});

describe('reviewer permission check decision', () => {
  const allow = {
    schema_version: 2,
    kind: 'echo-organization-permission-check-decision',
    request_sha256: digest('1'),
    provider_event_sha256: digest('2'),
    allowed: true,
    reason_code: RESTRICTED_REVIEWER_ALLOW_REASON_CODE,
    principal_id: IDS.principal,
    membership_id: IDS.membership,
    adapter_binding_id: IDS.binding,
    permission_grant_id: IDS.grant,
    evaluated_at: '2026-08-11T12:00:00.000Z',
    authorization_audit_event_id: IDS.audit,
    authorization_audit_entry_sha256: digest('3'),
    reviewer_release_draft_sha256: digest('4'),
    approval_presentation_sha256: digest('5'),
    semantic_intent_sha256: digest('6'),
    message_presentation_sha256: digest('7'),
  } as const;

  it('requires every proof field and the one reviewer reason for an allow', () => {
    expect(validateOrganizationReviewerPermissionCheckDecision(allow)).toEqual(
      allow,
    );
    expect(() =>
      validateOrganizationReviewerPermissionCheckDecision({
        ...allow,
        reason_code: 'active_membership_and_direct_grant',
      }),
    ).toThrow('allow reason_code is unsupported');
    for (const field of [
      'authorization_audit_event_id',
      'authorization_audit_entry_sha256',
      'semantic_intent_sha256',
      'message_presentation_sha256',
      'adapter_binding_id',
      'permission_grant_id',
    ] as const) {
      expect(() =>
        validateOrganizationReviewerPermissionCheckDecision({
          ...allow,
          [field]: null,
        }),
      ).toThrow();
    }
  });

  it('nulls every proof and actor field on a closed denial reason', () => {
    for (const reason of REVIEWER_PERMISSION_DENIAL_REASON_CODES) {
      const denial = {
        ...allow,
        allowed: false,
        reason_code: reason,
        principal_id: null,
        membership_id: null,
        adapter_binding_id: null,
        permission_grant_id: null,
        authorization_audit_event_id: null,
        authorization_audit_entry_sha256: null,
        reviewer_release_draft_sha256: null,
        approval_presentation_sha256: null,
        semantic_intent_sha256: null,
        message_presentation_sha256: null,
      };
      expect(
        validateOrganizationReviewerPermissionCheckDecision(denial),
      ).toEqual(denial);
      expect(() =>
        validateOrganizationReviewerPermissionCheckDecision({
          ...denial,
          semantic_intent_sha256: digest('8'),
        }),
      ).toThrow('denial must null every proof and actor field');
    }
    expect(() =>
      validateOrganizationReviewerPermissionCheckDecision({
        ...allow,
        allowed: false,
        reason_code: 'active_membership_and_direct_grant',
        principal_id: null,
        membership_id: null,
        adapter_binding_id: null,
        permission_grant_id: null,
        authorization_audit_event_id: null,
        authorization_audit_entry_sha256: null,
        reviewer_release_draft_sha256: null,
        approval_presentation_sha256: null,
        semantic_intent_sha256: null,
        message_presentation_sha256: null,
      }),
    ).toThrow('denial reason_code is unsupported');
  });

  it('serializes both allowed and denied closed decisions as their exact bounded canonical bytes', () => {
    const denial = {
      ...allow,
      allowed: false,
      reason_code: 'provider_identity_mismatch',
      principal_id: null,
      membership_id: null,
      adapter_binding_id: null,
      permission_grant_id: null,
      authorization_audit_event_id: null,
      authorization_audit_entry_sha256: null,
      reviewer_release_draft_sha256: null,
      approval_presentation_sha256: null,
      semantic_intent_sha256: null,
      message_presentation_sha256: null,
    } as const;
    for (const decision of [allow, denial]) {
      expect(
        Buffer.from(
          canonicalOrganizationReviewerPermissionCheckDecisionBytes(decision),
        ).toString('utf8'),
      ).toBe(canonicalJson(decision));
    }
  });
});

describe('reviewer recent decisions request and response', () => {
  it('signs a target-free read bound to its exact operation', async () => {
    const key = installationKey();
    const request = await createOrganizationReviewerRecentDecisionsRequest(
      {
        request_id: 'rrd_00000000-0000-4000-8000-000000000001',
        authority_id: IDS.authority,
        authority_key_id: digest('a'),
        organization_id: IDS.organization,
        enrollment_id: IDS.enrollment,
        installation_id: IDS.installation,
        installation_signing_key: key.descriptor,
        requested_at: '2026-08-11T12:00:00.000Z',
      },
      key.sign,
    );
    expect(request.http_path).toBe(
      ORGANIZATION_API_REVIEWER_RECENT_DECISIONS_PATH,
    );
    expect(
      verifyOrganizationReviewerRecentDecisionsRequest(request, key.descriptor),
    ).toEqual(request);
    expect(canonicalSha256(request)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(() =>
      validateOrganizationReviewerRecentDecisionsRequest({
        ...request,
        limit: 10,
      }),
    ).toThrow('has an unexpected shape');
  });

  it('closes the response to four keys and bounded reviewer items', () => {
    const response = {
      schema_version: 1,
      items: [
        { kind: 'decision', text: 'Ship the reviewer pilot.' },
        { kind: 'decision', text: 'Ship the reviewer pilot.' },
      ],
      policy_id: RESTRICTED_REVIEWER_POLICY_ID,
      witness: ORGANIZATION_REVIEWER_RECENT_DECISIONS_WITNESS,
    };
    // Equal kind/text pairs from distinct facts are allowed.
    expect(validateOrganizationReviewerRecentDecisionsResponse(response)).toEqual(
      response,
    );
    expect(() =>
      validateOrganizationReviewerRecentDecisionsResponse({
        ...response,
        total: 2,
      }),
    ).toThrow('has an unexpected shape');
    expect(() =>
      validateOrganizationReviewerRecentDecisionsResponse({
        ...response,
        items: [{ kind: 'decision', text: 'x', atom_id: digest('1') }],
      }),
    ).toThrow('has an unexpected shape');
    expect(() =>
      validateOrganizationReviewerRecentDecisionsResponse({
        ...response,
        items: Array.from(
          { length: MAX_ORGANIZATION_REVIEWER_RECENT_DECISIONS_ITEMS + 1 },
          () => ({ kind: 'decision', text: 'x' }),
        ),
      }),
    ).toThrow('exceeds the maximum item count');
    expect(() =>
      validateOrganizationReviewerRecentDecisionsResponse({
        ...response,
        witness: 'Allowed.',
      }),
    ).toThrow('version, policy, or witness is unsupported');
    expect(() =>
      validateOrganizationReviewerRecentDecisionsResponse({
        ...response,
        items: [{ kind: 'decision', text: 'two\nlines' }],
      }),
    ).toThrow('text is invalid');
  });
});
