import { Buffer } from 'node:buffer';
import { canonicalJson } from '@echo-brain/federation-protocol';
import { describe, expect, it } from 'vitest';
import {
  ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_CHALLENGES_PATH,
  validateOrganizationPersonTools,
  ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_COMPLETIONS_PATH,
  canonicalOrganizationPersonSlackIdentityLinkBeginRequestBytes,
  canonicalOrganizationPersonSlackIdentityLinkCompleteRequestBytes,
  validateOrganizationPersonSlackIdentityLinkBeginRequest,
  validateOrganizationPersonSlackIdentityLinkBeginResponse,
  validateOrganizationPersonSlackIdentityLinkCompleteRequest,
  validateOrganizationPersonSlackIdentityLinkResult,
  validateOrganizationPersonSlackBrowserLinkAttemptRequest,
  validateOrganizationPersonSlackBrowserLinkBeginRequest,
  validateOrganizationPersonSlackBrowserLinkBeginResponse,
  validateOrganizationPersonSlackBrowserLinkStatusResponse,
} from '../src/index.js';

const AUTHORITY_ID = 'oau_00000000-0000-4000-8000-000000000001';
const ORGANIZATION_ID = 'org_00000000-0000-4000-8000-000000000001';
const PRINCIPAL_ID = 'prn_00000000-0000-4000-8000-000000000001';

const BEGIN = {
  recipient_user_id: "U12345679",
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
      channel_id: 'D12345678',
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
      channel_id: 'D12345678',
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

describe('authenticated Person tools status', () => {
  const response = { schema_version: 2, kind: 'echo-organization-person-tools', organization_id: ORGANIZATION_ID,
    membership_id: 'mem_00000000-0000-4000-8000-000000000001', tools: [] };
  it('accepts absent and enabled tools with separate personal state', () => {
    expect(validateOrganizationPersonTools(response)).toEqual(response);
    for (const personal_status of ['unlinked', 'linked', 'revoked']) {
      expect(() => validateOrganizationPersonTools({ ...response, tools: [{ provider: 'slack', availability: 'enabled', personal_status,
        workspace_id: 'T123ABC', account_id: personal_status === 'linked' ? 'U123ABC' : null }] })).not.toThrow();
    }
  });
  it('rejects stale identities, unexpected provider data, and oversized lists', () => {
    const tool = { provider: 'slack', availability: 'enabled', personal_status: 'linked', workspace_id: 'T123ABC', account_id: 'U123ABC' };
    for (const invalid of [{ ...tool, availability: 'unavailable' }, { ...tool, personal_status: 'unlinked' },
      { ...tool, personal_status: 'unknown' }, { ...tool, token: 'synthetic' }, { ...tool, account_id: 'raw response' }]) {
      expect(() => validateOrganizationPersonTools({ ...response, tools: [invalid] })).toThrow();
    }
    expect(() => validateOrganizationPersonTools({ ...response, tools: [tool, tool] })).toThrow();
  });
});

describe('Person Slack browser link', () => {
  const attempt_id = 'sbl_00000000-0000-4000-8000-000000000001';
  it('admits only its compact begin, attempt, and safe status contracts', () => {
    expect(validateOrganizationPersonSlackBrowserLinkBeginRequest({ request_id: BEGIN.request_id })).toEqual({ request_id: BEGIN.request_id });
    expect(validateOrganizationPersonSlackBrowserLinkAttemptRequest({ attempt_id })).toEqual({ attempt_id });
    expect(validateOrganizationPersonSlackBrowserLinkBeginResponse({ schema_version: 1, kind: 'echo-person-slack-browser-link-v1', attempt_id,
      authorization_url: 'https://slack.com/openid/connect/authorize?opaque=1', expires_at: '2026-09-10T22:05:00.000Z' })).toMatchObject({ attempt_id });
    expect(validateOrganizationPersonSlackBrowserLinkStatusResponse({ schema_version: 1, kind: 'echo-person-slack-browser-link-status-v1', attempt_id,
      status: 'failed', failure_reason: 'identity_conflict' })).toMatchObject({ status: 'failed' });
  });
  it('rejects unsafe URLs, raw provider fields, and inconsistent failure state', () => {
    const response = { schema_version: 1, kind: 'echo-person-slack-browser-link-v1', attempt_id,
      authorization_url: 'https://slack.com/openid/connect/authorize', expires_at: '2026-09-10T22:05:00.000Z' };
    for (const invalid of [
      { ...response, authorization_url: 'http://slack.com/openid/connect/authorize' },
      { ...response, authorization_url: 'https://user:secret@slack.com/openid/connect/authorize' },
      { ...response, state: 'secret-state' },
    ]) expect(() => validateOrganizationPersonSlackBrowserLinkBeginResponse(invalid)).toThrow();
    expect(() => validateOrganizationPersonSlackBrowserLinkStatusResponse({ schema_version: 1, kind: 'echo-person-slack-browser-link-status-v1', attempt_id,
      status: 'complete', failure_reason: 'provider_rejected' })).toThrow();
  });
});
