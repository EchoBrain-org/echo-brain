import type {
  OrganizationPersonOidcBeginRequestV2,
  OrganizationPersonOidcBeginResponseV2,
  OrganizationPersonSessionRefreshRequestV2,
  OrganizationPersonSessionV2,
} from './contracts.js';
import {
  asRecord,
  assertExactKeys,
  assertId,
  assertPatternString,
  assertTimestamp,
  fail,
} from './validation.js';

const OPAQUE_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function assertOpaqueSecret(value: unknown, label: string): void {
  assertPatternString(value, label, 43, OPAQUE_SECRET_PATTERN);
}

export function validateOrganizationPersonOidcBeginRequest(
  value: unknown,
): OrganizationPersonOidcBeginRequestV2 {
  const label = 'Person OIDC begin request';
  const record = asRecord(value, label);
  if (record.kind === 'existing_identity_login') {
    assertExactKeys(record, ['kind'], label);
    return record as unknown as OrganizationPersonOidcBeginRequestV2;
  }
  assertExactKeys(record, ['kind', 'login_grant'], label);
  if (record.kind !== 'identity_bootstrap') {
    fail(`${label} kind is unsupported`);
  }
  assertOpaqueSecret(record.login_grant, `${label} login_grant`);
  return record as unknown as OrganizationPersonOidcBeginRequestV2;
}

export function validateOrganizationPersonOidcBeginResponse(
  value: unknown,
): OrganizationPersonOidcBeginResponseV2 {
  const label = 'Person OIDC begin response';
  const record = asRecord(value, label);
  assertExactKeys(record, ['authorization_url', 'expires_at'], label);
  assertPatternString(
    record.authorization_url,
    `${label} authorization_url`,
    16 * 1024,
    /^https:\/\/[^\s]+$/,
  );
  const Url = (
    globalThis as unknown as {
      URL?: new (input: string) => {
        protocol: string;
        username: string;
        password: string;
        hash: string;
      };
    }
  ).URL;
  if (Url === undefined) {
    fail(`${label} authorization_url is invalid`);
  }
  let url: InstanceType<typeof Url>;
  try {
    url = new Url(record.authorization_url as string);
  } catch {
    fail(`${label} authorization_url is invalid`);
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== ''
  ) {
    fail(`${label} authorization_url is invalid`);
  }
  assertTimestamp(record.expires_at, `${label} expires_at`);
  return record as unknown as OrganizationPersonOidcBeginResponseV2;
}

export function validateOrganizationPersonSession(
  value: unknown,
): OrganizationPersonSessionV2 {
  const label = 'Person session';
  const record = asRecord(value, label);
  assertExactKeys(
    record,
    [
      'organization_id',
      'principal_id',
      'membership_id',
      'membership_type',
      'identity_binding_id',
      'session_family_id',
      'access_token',
      'refresh_token',
      'access_expires_at',
      'refresh_expires_at',
      'hard_reauthentication_at',
    ],
    label,
  );
  assertId(record.organization_id, 'org', `${label} organization_id`);
  assertId(record.principal_id, 'prn', `${label} principal_id`);
  assertId(record.membership_id, 'mem', `${label} membership_id`);
  if (record.membership_type !== 'owner' && record.membership_type !== 'employee') {
    fail(`${label} membership_type is unsupported`);
  }
  assertId(record.identity_binding_id, 'oib', `${label} identity_binding_id`);
  assertId(record.session_family_id, 'psf', `${label} session_family_id`);
  assertOpaqueSecret(record.access_token, `${label} access_token`);
  assertOpaqueSecret(record.refresh_token, `${label} refresh_token`);
  assertTimestamp(record.access_expires_at, `${label} access_expires_at`);
  assertTimestamp(record.refresh_expires_at, `${label} refresh_expires_at`);
  assertTimestamp(
    record.hard_reauthentication_at,
    `${label} hard_reauthentication_at`,
  );
  if (
    record.access_token === record.refresh_token ||
    Date.parse(record.access_expires_at as string) >
      Date.parse(record.refresh_expires_at as string) ||
    record.refresh_expires_at !== record.hard_reauthentication_at
  ) {
    fail(`${label} credential pair is inconsistent`);
  }
  return record as unknown as OrganizationPersonSessionV2;
}

export function validateOrganizationPersonSessionRefreshRequest(
  value: unknown,
): OrganizationPersonSessionRefreshRequestV2 {
  const label = 'Person session refresh request';
  const record = asRecord(value, label);
  assertExactKeys(record, ['refresh_token'], label);
  assertOpaqueSecret(record.refresh_token, `${label} refresh_token`);
  return record as unknown as OrganizationPersonSessionRefreshRequestV2;
}
