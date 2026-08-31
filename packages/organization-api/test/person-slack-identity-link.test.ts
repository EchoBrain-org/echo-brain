import { Buffer } from 'node:buffer';
import { canonicalJson } from '@echo-brain/federation-protocol';
import { describe, expect, it } from 'vitest';
import {
  ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_CHALLENGES_PATH,
  ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_COMPLETIONS_PATH,
  canonicalOrganizationPersonSlackIdentityLinkBeginRequestBytes,
  canonicalOrganizationPersonSlackIdentityLinkCompleteRequestBytes,
  validateOrganizationPersonSlackIdentityLinkBeginRequest,
  validateOrganizationPersonSlackIdentityLinkBeginResponse,
  validateOrganizationPersonSlackIdentityLinkCompleteRequest,
  validateOrganizationPersonSlackIdentityLinkResult,
} from '../src/index.js';

const AUTHORITY_ID = 'oau_00000000-0000-4000-8000-000000000001';
const ORGANIZATION_ID = 'org_00000000-0000-4000-8000-000000000001';
const PRINCIPAL_ID = 'prn_00000000-0000-4000-8000-000000000001';

const BEGIN = {
  request_id: 'psb_00000000-0000-4000-8000-000000000001',
  challenge_code_sha256:
    'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
} as const;

const COMPLETE = {
  request_id: 'psc_00000000-0000-4000-8000-000000000001',
  challenge_attempt_id: 'cat_00000000-0000-4000-8000-000000000001',
  challenge_message_ts: '1721678400.123456',
  challenge_code: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
} as const;

const OLD_BEGIN_ENVELOPE = {
  schema_version: 2,
  kind: 'echo-organization-person-slack-link-begin-request',
  authority_id: AUTHORITY_ID,
  organization_id: ORGANIZATION_ID,
  subject_principal_id: PRINCIPAL_ID,
  http_method: 'POST',
  http_path: ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_CHALLENGES_PATH,
} as const;

const OLD_COMPLETE_ENVELOPE = {
  ...OLD_BEGIN_ENVELOPE,
  kind: 'echo-organization-person-slack-link-complete-request',
  http_path: ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_COMPLETIONS_PATH,
} as const;

describe('organization Person Slack identity link', () => {
  it('validates distinct canonical Person begin and complete requests', () => {
    expect(validateOrganizationPersonSlackIdentityLinkBeginRequest(BEGIN)).toEqual(BEGIN);
    expect(validateOrganizationPersonSlackIdentityLinkCompleteRequest(COMPLETE)).toEqual(
      COMPLETE,
    );
    expect(
      Buffer.from(canonicalOrganizationPersonSlackIdentityLinkBeginRequestBytes(BEGIN)).toString(),
    ).toBe(canonicalJson(BEGIN));
    expect(
      Buffer.from(
        canonicalOrganizationPersonSlackIdentityLinkCompleteRequestBytes(COMPLETE),
      ).toString(),
    ).toBe(canonicalJson(COMPLETE));
  });

  it('rejects every removed identity and route envelope field', () => {
    for (const [key, value] of Object.entries(OLD_BEGIN_ENVELOPE)) {
      expect(() =>
        validateOrganizationPersonSlackIdentityLinkBeginRequest({
          ...BEGIN,
          [key]: value,
        }),
      ).toThrow('unexpected shape');
    }
    for (const [key, value] of Object.entries(OLD_COMPLETE_ENVELOPE)) {
      expect(() =>
        validateOrganizationPersonSlackIdentityLinkCompleteRequest({
          ...COMPLETE,
          [key]: value,
        }),
      ).toThrow('unexpected shape');
    }
  });

  it('does not accept installation, adapter, expected-subject, or secret fields', () => {
    for (const extra of [
      { installation_id: 'ins_00000000-0000-4000-8000-000000000001' },
      { adapter_id: 'slack-reactions' },
      { expected_provider_subject_id: 'U12345678' },
      { slack_bot_token: 'secret' },
    ]) {
      expect(() =>
        validateOrganizationPersonSlackIdentityLinkCompleteRequest({
          ...COMPLETE,
          ...extra,
        }),
      ).toThrow('unexpected shape');
    }
  });

  it('refuses malformed request IDs and challenge input', () => {
    expect(() =>
      validateOrganizationPersonSlackIdentityLinkCompleteRequest({
        ...COMPLETE,
        request_id: 'slc_00000000-0000-4000-8000-000000000001',
      }),
    ).toThrow('request_id');
    expect(() =>
      validateOrganizationPersonSlackIdentityLinkCompleteRequest({
        ...COMPLETE,
        challenge_code: `${COMPLETE.challenge_code}=`,
      }),
    ).toThrow('canonical unpadded base64url');
  });

  it('validates identity-only V2 responses', () => {
    const begun = {
      schema_version: 2,
      kind: 'echo-organization-person-slack-link-begin-response',
      challenge_attempt_id: COMPLETE.challenge_attempt_id,
      provider: 'slack',
      provider_tenant_id: 'T12345678',
      channel_id: 'C12345678',
      challenge_message_ts: COMPLETE.challenge_message_ts,
      expires_at: '2026-08-18T12:15:00.000Z',
    } as const;
    expect(validateOrganizationPersonSlackIdentityLinkBeginResponse(begun)).toEqual(begun);

    const result = {
      schema_version: 2,
      kind: 'echo-organization-person-slack-link-result',
      identity_link_id: 'clm_00000000-0000-4000-8000-000000000001',
      connection_id: 'con_00000000-0000-4000-8000-000000000001',
      organization_id: ORGANIZATION_ID,
      principal_id: PRINCIPAL_ID,
      membership_id: 'mem_00000000-0000-4000-8000-000000000001',
      provider: 'slack',
      provider_tenant_id: 'T12345678',
      provider_subject_id: 'U12345678',
      channel_id: 'C12345678',
      linked_at: '2026-08-18T12:02:00.000Z',
      identity_link_created: true,
    } as const;
    expect(validateOrganizationPersonSlackIdentityLinkResult(result)).toEqual(result);
    expect(() =>
      validateOrganizationPersonSlackIdentityLinkResult({
        ...result,
        adapter_binding_id: 'bnd_00000000-0000-4000-8000-000000000001',
      }),
    ).toThrow('unexpected shape');
  });
});
