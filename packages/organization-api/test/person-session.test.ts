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
  display_name: 'Example Person',
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

  it('accepts an optional canonical login_hint on the bootstrap variant only', () => {
    expect(
      validateOrganizationPersonOidcBeginRequest({
        kind: 'identity_bootstrap',
        login_grant: 'G'.repeat(43),
        login_hint: 'founder@example.com',
      }),
    ).toMatchObject({ login_hint: 'founder@example.com' });
    expect(
      validateOrganizationPersonOidcBeginRequest({
        kind: 'identity_bootstrap',
        login_grant: 'G'.repeat(43),
        login_hint: `${'a'.repeat(64)}@example.com`,
      }),
    ).toMatchObject({ login_hint: `${'a'.repeat(64)}@example.com` });
    expect(
      validateOrganizationPersonOidcBeginRequest({
        kind: 'identity_bootstrap',
        login_grant: 'G'.repeat(43),
        login_hint: 'founder@example.com',
        loopback_handoff: {
          url: `http://127.0.0.1:49152/${'P'.repeat(43)}`,
          token: 'T'.repeat(43),
        },
      }),
    ).toMatchObject({ login_hint: 'founder@example.com' });
    // Not canonical, so it could never match a stored digest anyway. Reject it
    // at the edge rather than carrying it into the session application.
    expect(() =>
      validateOrganizationPersonOidcBeginRequest({
        kind: 'identity_bootstrap',
        login_grant: 'G'.repeat(43),
        login_hint: 'Founder@Example.com',
      }),
    ).toThrow(/login_hint is invalid/);
    for (const login_hint of [
      "founder;$(id)@example.com",
      "founder`id`@example.com",
      "founder..name@example.com",
      "founder@localhost",
      "founder@example",
      "founder@-example.com",
      `${'a'.repeat(65)}@example.com`,
      `a@${'a'.repeat(64)}.com`,
    ]) {
      expect(() =>
        validateOrganizationPersonOidcBeginRequest({
          kind: 'identity_bootstrap',
          login_grant: 'G'.repeat(43),
          login_hint,
        }),
      ).toThrow(/login_hint is invalid/);
    }
    expect(() =>
      validateOrganizationPersonOidcBeginRequest({
        kind: 'identity_bootstrap',
        login_grant: 'G'.repeat(43),
        login_hint: 'no-at-sign',
      }),
    ).toThrow(/login_hint is invalid/);
    // A hint has no meaning without a grant to check it against.
    expect(() =>
      validateOrganizationPersonOidcBeginRequest({
        kind: 'existing_identity_login',
        login_hint: 'founder@example.com',
      }),
    ).toThrow(/unexpected shape/);
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
      validateOrganizationPersonSession({
        ...SESSION,
        display_name: ' Example Person',
      }),
    ).toThrow(/display_name is invalid/);
    expect(() =>
      validateOrganizationPersonSessionRefreshRequest({ refresh_token: 'short' }),
    ).toThrow(/invalid/);
  });
});
