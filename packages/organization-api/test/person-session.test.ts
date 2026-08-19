import {
  validateOrganizationPersonOidcBeginRequest,
  validateOrganizationPersonOidcBeginResponse,
  validateOrganizationPersonSession,
  validateOrganizationPersonSessionRefreshRequest,
} from '../src/index.js';
import { describe, expect, it } from 'vitest';

const id = (prefix: string, tail: string) =>
  `${prefix}_00000000-0000-4000-8000-${tail}`;

const SESSION = {
  organization_id: id('org', '000000000001'),
  principal_id: id('prn', '000000000002'),
  membership_id: id('mem', '000000000003'),
  membership_type: 'employee',
  identity_binding_id: id('oib', '000000000004'),
  session_family_id: id('psf', '000000000005'),
  access_token: 'A'.repeat(43),
  refresh_token: 'R'.repeat(43),
  access_expires_at: '2026-08-18T12:00:00.000Z',
  refresh_expires_at: '2026-08-25T00:00:00.000Z',
  hard_reauthentication_at: '2026-08-25T00:00:00.000Z',
} as const;

describe('Person session HTTP DTOs', () => {
  it('accepts only the two begin variants and exact issued pair', () => {
    expect(
      validateOrganizationPersonOidcBeginRequest({
        kind: 'existing_identity_login',
      }),
    ).toEqual({ kind: 'existing_identity_login' });
    expect(
      validateOrganizationPersonOidcBeginRequest({
        kind: 'identity_bootstrap',
        login_grant: 'G'.repeat(43),
      }),
    ).toMatchObject({ kind: 'identity_bootstrap' });
    expect(
      validateOrganizationPersonOidcBeginResponse({
        authorization_url: 'https://identity.example/authorize?state=opaque',
        expires_at: '2026-08-18T00:10:00.000Z',
      }),
    ).toMatchObject({ expires_at: '2026-08-18T00:10:00.000Z' });
    expect(validateOrganizationPersonSession(SESSION)).toEqual(SESSION);
    expect(
      validateOrganizationPersonSessionRefreshRequest({
        refresh_token: SESSION.refresh_token,
      }),
    ).toEqual({ refresh_token: SESSION.refresh_token });
  });

  it('rejects extra keys, malformed secrets, and inconsistent pairs', () => {
    expect(() =>
      validateOrganizationPersonOidcBeginRequest({
        kind: 'existing_identity_login',
        extra: true,
      }),
    ).toThrow(/unexpected shape/);
    expect(() =>
      validateOrganizationPersonSession({
        ...SESSION,
        refresh_token: SESSION.access_token,
      }),
    ).toThrow(/inconsistent/);
    expect(() =>
      validateOrganizationPersonSessionRefreshRequest({ refresh_token: 'short' }),
    ).toThrow(/invalid/);
  });
});
