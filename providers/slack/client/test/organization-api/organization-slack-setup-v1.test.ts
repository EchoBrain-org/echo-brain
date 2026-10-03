import { describe, expect, it } from 'vitest';
import {
  validateOrganizationSlackInstallAttemptRequestV1,
  validateOrganizationSlackInstallBeginRequestV1,
  validateOrganizationSlackInstallBeginResponseV1,
  validateOrganizationSlackInstallStatusResponseV1,
  validateOrganizationSlackSetupRequestV1,
  validateOrganizationSlackSetupResponseV1,
} from '../../src/organization-api/organization-slack-setup-v1.js';

const ATTEMPT_ID = 'ssi_00000000-0000-4000-8000-000000000001';
const SETUP = { request_id: 'oss_00000000-0000-4000-8000-000000000001', configuration_token: 'xoxe.xoxp-1-config-token-value' };
const EXISTING_APP = { app_id: 'A0C6AEG49TQ', client_id: '123456789.987654321', client_secret: 'synthetic-client-secret', signing_secret: 'synthetic-signing-secret' };
const BEGIN = { request_id: 'osi_00000000-0000-4000-8000-000000000001' };
const SETUP_RESPONSE = { schema_version: 1, kind: 'echo-organization-slack-setup-v1', app_id: 'A0APP1', organization_setup: 'app_created' };
const BEGUN = {
  schema_version: 1, kind: 'echo-organization-slack-install-v1', attempt_id: ATTEMPT_ID,
  connect_link: 'https://connect.nango.dev/?session_token=opaque', expires_at: '2026-09-30T00:10:00.000Z',
};
const PENDING = {
  schema_version: 1, kind: 'echo-organization-slack-install-status-v1', attempt_id: ATTEMPT_ID,
  status: 'pending', failure_reason: null, result: null,
};
const COMPLETE = { ...PENDING, status: 'complete', result: { kind: 'created', workspace_id: 'T01' } };
const REFUSED = { ...PENDING, status: 'failed', failure_reason: 'already_connected' };

function thrown(run: () => unknown): string {
  try { run(); } catch (error) { return error instanceof Error ? error.message : String(error); }
  throw new Error('expected a validation failure');
}

describe('organization Slack setup contract v1', () => {
  it('accepts an explicitly selected existing app with bounded credentials', () => {
    const request = { ...SETUP, existing_app: EXISTING_APP };
    const validated = validateOrganizationSlackSetupRequestV1(request);
    expect(validated).toEqual(request);
    expect(validated.existing_app).not.toBe(EXISTING_APP);
    expect(Object.isFrozen(validated.existing_app)).toBe(true);
    expect(validateOrganizationSlackSetupRequestV1({ ...SETUP, existing_app: { ...EXISTING_APP,
      client_id: `${'1'.repeat(32)}.${'2'.repeat(32)}`, client_secret: 'x'.repeat(255), signing_secret: 'x'.repeat(8) } })).toBeTruthy();
  });

  it('rejects malformed adoption credentials and unknown fields without disclosing supplied values', () => {
    const invalid = [
      undefined, null, [],
      { ...EXISTING_APP, app_id: 'private-invalid-app' },
      { ...EXISTING_APP, app_id: 'A'.repeat(65) },
      { ...EXISTING_APP, client_id: 'private-invalid-client' },
      { ...EXISTING_APP, client_id: `${'1'.repeat(33)}.2` },
      { ...EXISTING_APP, client_secret: 'short' },
      { ...EXISTING_APP, client_secret: 'x'.repeat(256) },
      { ...EXISTING_APP, signing_secret: 'private signing secret' },
      { ...EXISTING_APP, signing_secret: 'private\tsigning-secret' },
      { ...EXISTING_APP, signing_secret: undefined },
      { app_id: EXISTING_APP.app_id, client_id: EXISTING_APP.client_id, client_secret: EXISTING_APP.client_secret },
      { ...EXISTING_APP, extra: 'private-extra-value' },
    ];
    for (const existing_app of invalid) {
      const error = thrown(() => validateOrganizationSlackSetupRequestV1({ ...SETUP, existing_app }));
      for (const candidate of [...Object.values(EXISTING_APP), 'private-invalid-app', 'private-invalid-client', 'private signing secret', 'private-extra-value']) {
        expect(error).not.toContain(candidate);
      }
    }
    const hidden = { ...EXISTING_APP };
    Object.defineProperty(hidden, 'hidden', { value: 'private-hidden-value' });
    expect(() => validateOrganizationSlackSetupRequestV1({ ...SETUP, existing_app: hidden })).toThrow();
    let getterRan = false;
    const accessor = { ...EXISTING_APP };
    Object.defineProperty(accessor, 'client_secret', { enumerable: true, get: () => { getterRan = true; return 'private-getter-value'; } });
    expect(() => validateOrganizationSlackSetupRequestV1({ ...SETUP, existing_app: accessor })).toThrow();
    expect(getterRan).toBe(false);
  });

  it('accepts the documented shapes', () => {
    expect(validateOrganizationSlackSetupRequestV1(SETUP)).toEqual(SETUP);
    expect(validateOrganizationSlackInstallBeginRequestV1(BEGIN)).toEqual(BEGIN);
    expect(validateOrganizationSlackInstallAttemptRequestV1({ attempt_id: ATTEMPT_ID })).toEqual({ attempt_id: ATTEMPT_ID });
    expect(validateOrganizationSlackSetupResponseV1(SETUP_RESPONSE)).toEqual(SETUP_RESPONSE);
    expect(validateOrganizationSlackSetupResponseV1({ ...SETUP_RESPONSE, organization_setup: 'connected' })).toMatchObject({ organization_setup: 'connected' });
    expect(validateOrganizationSlackInstallBeginResponseV1(BEGUN)).toEqual(BEGUN);
    for (const status of [PENDING, COMPLETE, REFUSED, { ...PENDING, status: 'cancelled' }, { ...PENDING, status: 'expired' },
      { ...PENDING, status: 'failed', failure_reason: 'workspace_mismatch' }, { ...COMPLETE, result: { kind: 'reconnected', workspace_id: 'T01' } }]) {
      expect(validateOrganizationSlackInstallStatusResponseV1(status)).toEqual(status);
    }
  });

  it('rejects an extra key on every document', () => {
    const documents: [(value: unknown) => unknown, Record<string, unknown>][] = [
      [validateOrganizationSlackSetupRequestV1, SETUP],
      [validateOrganizationSlackInstallBeginRequestV1, BEGIN], [validateOrganizationSlackInstallAttemptRequestV1, { attempt_id: ATTEMPT_ID }],
      [validateOrganizationSlackSetupResponseV1, SETUP_RESPONSE],
      [validateOrganizationSlackInstallBeginResponseV1, BEGUN], [validateOrganizationSlackInstallStatusResponseV1, COMPLETE],
    ];
    for (const [validate, value] of documents) expect(() => validate({ ...value, extra: true })).toThrow(/unexpected shape/);
    expect(() => validateOrganizationSlackInstallStatusResponseV1({ ...COMPLETE, result: { ...COMPLETE.result, extra: 1 } })).toThrow(/unexpected shape/);
  });

  it('bounds the configuration token without echoing it', () => {
    for (const token of ['short-token', 'x'.repeat(513), 'has a space in the token', 'tab\tinside-the-token-value']) {
      expect(thrown(() => validateOrganizationSlackSetupRequestV1({ ...SETUP, configuration_token: token }))).not.toContain(token);
    }
    expect(validateOrganizationSlackSetupRequestV1({ ...SETUP, configuration_token: 'x'.repeat(512) })).toBeTruthy();
    expect(() => validateOrganizationSlackSetupRequestV1({ ...SETUP, request_id: 'osc_00000000-0000-4000-8000-000000000001' })).toThrow();
  });

  it('requires an https connect link', () => {
    expect(() => validateOrganizationSlackInstallBeginResponseV1({ ...BEGUN, connect_link: 'http://connect.nango.dev/' })).toThrow();
    expect(() => validateOrganizationSlackInstallBeginResponseV1({ ...BEGUN, connect_link: 'javascript:alert(1)' })).toThrow();
  });

  it('keeps failure and result consistent with the status', () => {
    expect(() => validateOrganizationSlackInstallStatusResponseV1({ ...PENDING, failure_reason: 'provider_rejected' })).toThrow();
    expect(() => validateOrganizationSlackInstallStatusResponseV1({ ...PENDING, status: 'failed' })).toThrow();
    expect(() => validateOrganizationSlackInstallStatusResponseV1({ ...COMPLETE, result: null })).toThrow();
    expect(() => validateOrganizationSlackInstallStatusResponseV1({ ...PENDING, result: COMPLETE.result })).toThrow();
    expect(() => validateOrganizationSlackInstallStatusResponseV1({ ...COMPLETE, result: { ...COMPLETE.result, kind: 'moved' } })).toThrow();
    expect(() => validateOrganizationSlackInstallStatusResponseV1({ ...COMPLETE, failure_reason: null, result: { ...COMPLETE.result, person_links_revoked: 0 } })).toThrow();
  });
});
