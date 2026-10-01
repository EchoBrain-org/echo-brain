import { describe, expect, it } from 'vitest';
import {
  validateOrganizationSlackAppCredentialsRequestV1,
  validateOrganizationSlackInstallAttemptRequestV1,
  validateOrganizationSlackInstallBeginRequestV1,
  validateOrganizationSlackInstallBeginResponseV1,
  validateOrganizationSlackInstallStatusResponseV1,
  validateOrganizationSlackRecipeResponseV1,
  validateOrganizationSlackSetupRequestV1,
  validateOrganizationSlackSetupResponseV1,
} from '../../src/organization-api/organization-slack-setup-v1.js';

const ATTEMPT_ID = 'ssi_00000000-0000-4000-8000-000000000001';
const SECRET = 'client-secret-value-never-echoed';
const SETUP = { request_id: 'oss_00000000-0000-4000-8000-000000000001', configuration_token: 'xoxe.xoxp-1-config-token-value' };
const CREDENTIALS = {
  request_id: 'osc_00000000-0000-4000-8000-000000000001', app_id: 'A0APP1', client_id: '1234.5678',
  client_secret: SECRET, signing_secret: 'signing-secret-value',
};
const BEGIN = { request_id: 'osi_00000000-0000-4000-8000-000000000001', confirm_replacement: false };
const SETUP_RESPONSE = { schema_version: 1, kind: 'echo-organization-slack-setup-v1', app_id: 'A0APP1', organization_setup: 'app_created' };
const RECIPE = { schema_version: 1, kind: 'echo-organization-slack-recipe-v1', manifest: { display_information: { name: 'ECHO' } } };
const BEGUN = {
  schema_version: 1, kind: 'echo-organization-slack-install-v1', attempt_id: ATTEMPT_ID,
  connect_link: 'https://connect.nango.dev/?session_token=opaque', expires_at: '2026-09-30T00:10:00.000Z',
};
const PENDING = {
  schema_version: 1, kind: 'echo-organization-slack-install-status-v1', attempt_id: ATTEMPT_ID,
  status: 'pending', failure_reason: null, outstanding_approvals: null, result: null,
};
const COMPLETE = { ...PENDING, status: 'complete', result: { kind: 'created', workspace_id: 'T01', person_links_revoked: 0 } };
const REFUSED = { ...PENDING, status: 'failed', failure_reason: 'approvals_outstanding', outstanding_approvals: 2 };

function thrown(run: () => unknown): string {
  try { run(); } catch (error) { return error instanceof Error ? error.message : String(error); }
  throw new Error('expected a validation failure');
}

describe('organization Slack setup contract v1', () => {
  it('accepts the documented shapes', () => {
    expect(validateOrganizationSlackSetupRequestV1(SETUP)).toEqual(SETUP);
    expect(validateOrganizationSlackAppCredentialsRequestV1(CREDENTIALS)).toEqual(CREDENTIALS);
    expect(validateOrganizationSlackInstallBeginRequestV1(BEGIN)).toEqual(BEGIN);
    expect(validateOrganizationSlackInstallAttemptRequestV1({ attempt_id: ATTEMPT_ID })).toEqual({ attempt_id: ATTEMPT_ID });
    expect(validateOrganizationSlackSetupResponseV1(SETUP_RESPONSE)).toEqual(SETUP_RESPONSE);
    expect(validateOrganizationSlackSetupResponseV1({ ...SETUP_RESPONSE, organization_setup: 'connected' })).toMatchObject({ organization_setup: 'connected' });
    expect(validateOrganizationSlackRecipeResponseV1(RECIPE)).toEqual(RECIPE);
    expect(validateOrganizationSlackInstallBeginResponseV1(BEGUN)).toEqual(BEGUN);
    for (const status of [PENDING, COMPLETE, REFUSED, { ...PENDING, status: 'cancelled' }, { ...PENDING, status: 'expired' },
      { ...PENDING, status: 'failed', failure_reason: 'workspace_mismatch' }]) {
      expect(validateOrganizationSlackInstallStatusResponseV1(status)).toEqual(status);
    }
  });

  it('rejects an extra key on every document', () => {
    const documents: [(value: unknown) => unknown, Record<string, unknown>][] = [
      [validateOrganizationSlackSetupRequestV1, SETUP], [validateOrganizationSlackAppCredentialsRequestV1, CREDENTIALS],
      [validateOrganizationSlackInstallBeginRequestV1, BEGIN], [validateOrganizationSlackInstallAttemptRequestV1, { attempt_id: ATTEMPT_ID }],
      [validateOrganizationSlackSetupResponseV1, SETUP_RESPONSE], [validateOrganizationSlackRecipeResponseV1, RECIPE],
      [validateOrganizationSlackInstallBeginResponseV1, BEGUN], [validateOrganizationSlackInstallStatusResponseV1, COMPLETE],
    ];
    for (const [validate, value] of documents) expect(() => validate({ ...value, extra: true })).toThrow(/unexpected shape/);
    expect(() => validateOrganizationSlackInstallStatusResponseV1({ ...COMPLETE, result: { ...COMPLETE.result, extra: 1 } })).toThrow(/unexpected shape/);
  });

  it('bounds the configuration token and the app credentials without echoing them', () => {
    for (const token of ['short-token', 'x'.repeat(513), 'has a space in the token', 'tab\tinside-the-token-value']) {
      expect(thrown(() => validateOrganizationSlackSetupRequestV1({ ...SETUP, configuration_token: token }))).not.toContain(token);
    }
    expect(validateOrganizationSlackSetupRequestV1({ ...SETUP, configuration_token: 'x'.repeat(512) })).toBeTruthy();
    const badSecret = `${SECRET} with space`;
    expect(thrown(() => validateOrganizationSlackAppCredentialsRequestV1({ ...CREDENTIALS, client_secret: badSecret }))).not.toContain(SECRET);
    expect(() => validateOrganizationSlackAppCredentialsRequestV1({ ...CREDENTIALS, app_id: 'not-an-app' })).toThrow();
    expect(() => validateOrganizationSlackAppCredentialsRequestV1({ ...CREDENTIALS, client_id: 'abc' })).toThrow();
    expect(() => validateOrganizationSlackSetupRequestV1({ ...SETUP, request_id: 'osc_00000000-0000-4000-8000-000000000001' })).toThrow();
  });

  it('requires an https connect link and a boolean confirmation', () => {
    expect(() => validateOrganizationSlackInstallBeginResponseV1({ ...BEGUN, connect_link: 'http://connect.nango.dev/' })).toThrow();
    expect(() => validateOrganizationSlackInstallBeginResponseV1({ ...BEGUN, connect_link: 'javascript:alert(1)' })).toThrow();
    expect(() => validateOrganizationSlackInstallBeginRequestV1({ ...BEGIN, confirm_replacement: 'yes' })).toThrow();
  });

  it('keeps failure, count and result consistent with the status', () => {
    expect(() => validateOrganizationSlackInstallStatusResponseV1({ ...PENDING, failure_reason: 'provider_rejected' })).toThrow();
    expect(() => validateOrganizationSlackInstallStatusResponseV1({ ...PENDING, status: 'failed' })).toThrow();
    expect(() => validateOrganizationSlackInstallStatusResponseV1({ ...REFUSED, outstanding_approvals: null })).toThrow();
    expect(() => validateOrganizationSlackInstallStatusResponseV1({ ...PENDING, outstanding_approvals: 1 })).toThrow();
    expect(() => validateOrganizationSlackInstallStatusResponseV1({ ...COMPLETE, result: null })).toThrow();
    expect(() => validateOrganizationSlackInstallStatusResponseV1({ ...PENDING, result: COMPLETE.result })).toThrow();
    expect(() => validateOrganizationSlackInstallStatusResponseV1({ ...COMPLETE, result: { ...COMPLETE.result, kind: 'moved' } })).toThrow();
    expect(() => validateOrganizationSlackInstallStatusResponseV1({ ...COMPLETE, result: { ...COMPLETE.result, person_links_revoked: -1 } })).toThrow();
  });
});
