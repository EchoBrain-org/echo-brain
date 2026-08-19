import { Buffer } from 'node:buffer';
import { canonicalJson } from '@echo-brain/federation-protocol';
import { describe, expect, it } from 'vitest';
import {
  ORGANIZATION_API_PERSON_SLACK_LINK_CHALLENGES_PATH,
  ORGANIZATION_API_PERSON_SLACK_LINK_COMPLETIONS_PATH,
  canonicalOrganizationPersonSlackLinkBeginRequestBytes,
  canonicalOrganizationPersonSlackLinkCompleteRequestBytes,
  validateOrganizationPersonSlackLinkBeginRequest,
  validateOrganizationPersonSlackLinkBeginResponse,
  validateOrganizationPersonSlackLinkCompleteRequest,
  validateOrganizationPersonSlackLinkResult,
} from '../src/index.js';

const IDENTITY = {
  authority_id: 'oau_00000000-0000-4000-8000-000000000001',
  organization_id: 'org_00000000-0000-4000-8000-000000000001',
  subject_principal_id: 'prn_00000000-0000-4000-8000-000000000001',
} as const;

const BEGIN = {
  schema_version: 2,
  kind: 'echo-organization-person-slack-link-begin-request',
  request_id: 'psb_00000000-0000-4000-8000-000000000001',
  ...IDENTITY,
  http_method: 'POST',
  http_path: ORGANIZATION_API_PERSON_SLACK_LINK_CHALLENGES_PATH,
  challenge_code_sha256:
    'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
} as const;

const COMPLETE = {
  schema_version: 2,
  kind: 'echo-organization-person-slack-link-complete-request',
  request_id: 'psc_00000000-0000-4000-8000-000000000001',
  ...IDENTITY,
  http_method: 'POST',
  http_path: ORGANIZATION_API_PERSON_SLACK_LINK_COMPLETIONS_PATH,
  challenge_attempt_id: 'cat_00000000-0000-4000-8000-000000000001',
  challenge_message_ts: '1721678400.123456',
  challenge_code: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
} as const;

describe('organization Person Slack identity link', () => {
  it('validates distinct canonical Person begin and complete requests', () => {
    expect(validateOrganizationPersonSlackLinkBeginRequest(BEGIN)).toEqual(BEGIN);
    expect(validateOrganizationPersonSlackLinkCompleteRequest(COMPLETE)).toEqual(
      COMPLETE,
    );
    expect(
      Buffer.from(canonicalOrganizationPersonSlackLinkBeginRequestBytes(BEGIN)).toString(),
    ).toBe(canonicalJson(BEGIN));
    expect(
      Buffer.from(
        canonicalOrganizationPersonSlackLinkCompleteRequestBytes(COMPLETE),
      ).toString(),
    ).toBe(canonicalJson(COMPLETE));
  });

  it('does not accept installation, adapter, expected-subject, or secret fields', () => {
    for (const extra of [
      { installation_id: 'ins_00000000-0000-4000-8000-000000000001' },
      { adapter_id: 'slack-reactions' },
      { expected_provider_subject_id: 'U12345678' },
      { slack_bot_token: 'secret' },
    ]) {
      expect(() =>
        validateOrganizationPersonSlackLinkCompleteRequest({
          ...COMPLETE,
          ...extra,
        }),
      ).toThrow('unexpected shape');
    }
  });

  it('refuses cross-route, cross-subject, and malformed challenge input', () => {
    expect(() =>
      validateOrganizationPersonSlackLinkBeginRequest({
        ...BEGIN,
        http_path: ORGANIZATION_API_PERSON_SLACK_LINK_COMPLETIONS_PATH,
      }),
    ).toThrow('unsupported');
    expect(() =>
      validateOrganizationPersonSlackLinkCompleteRequest({
        ...COMPLETE,
        request_id: 'slc_00000000-0000-4000-8000-000000000001',
      }),
    ).toThrow('request_id');
    expect(() =>
      validateOrganizationPersonSlackLinkCompleteRequest({
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
    expect(validateOrganizationPersonSlackLinkBeginResponse(begun)).toEqual(begun);

    const result = {
      schema_version: 2,
      kind: 'echo-organization-person-slack-link-result',
      identity_link_id: 'clm_00000000-0000-4000-8000-000000000001',
      connection_id: 'con_00000000-0000-4000-8000-000000000001',
      organization_id: IDENTITY.organization_id,
      principal_id: IDENTITY.subject_principal_id,
      membership_id: 'mem_00000000-0000-4000-8000-000000000001',
      provider: 'slack',
      provider_tenant_id: 'T12345678',
      provider_subject_id: 'U12345678',
      channel_id: 'C12345678',
      linked_at: '2026-08-18T12:02:00.000Z',
      identity_link_created: true,
    } as const;
    expect(validateOrganizationPersonSlackLinkResult(result)).toEqual(result);
    expect(() =>
      validateOrganizationPersonSlackLinkResult({
        ...result,
        adapter_binding_id: 'bnd_00000000-0000-4000-8000-000000000001',
      }),
    ).toThrow('unexpected shape');
  });
});
