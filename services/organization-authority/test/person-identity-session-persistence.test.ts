import { Buffer } from 'node:buffer';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  federationId,
  p256KeyId,
  sha256Digest,
} from '@echo-brain/federation-protocol';
import type { Sha256Digest } from '@echo-brain/federation-protocol';
import { organizationAuthorityPinSha256 } from '@echo-brain/organization-protocol';
import type { OrganizationAuthorityDescriptorV1 } from '@echo-brain/organization-protocol';
import { SqliteOrganizationAuthorityRepository } from '../src/adapters/persistence/sqlite/sqlite-authority-repository.js';
import type { StoredAuthorityMembership } from '../src/application/ports/authority-repository.js';

const directories: string[] = [];

const refreshContenderWorkerSource = `
  import { createHash } from 'node:crypto';
  import { parentPort, workerData } from 'node:worker_threads';

  const { SqliteOrganizationAuthorityRepository } = await import(
    workerData.repository_url
  );
  const { PersonIdentitySessionApplication } = await import(
    workerData.application_url
  );
  const repository = new SqliteOrganizationAuthorityRepository(
    workerData.database_path,
    { fileMustExist: true, allowInitialization: false },
  );
  let result;
  try {
    repository.initialize(workerData.initialization);
    const before = repository.read((transaction) =>
      transaction.personSessionCredential(workerData.refresh_token_sha256),
    );
    parentPort.postMessage({
      kind: 'ready',
      contender: workerData.contender,
      observed_live:
        before?.credential_kind === 'refresh' &&
        before.consumed_at === null &&
        before.revoked_at === null,
    });
    Atomics.wait(new Int32Array(workerData.start_gate), 0, 0);
    let randomSequence = 0;
    const application = new PersonIdentitySessionApplication(
      repository,
      workerData.oidc_configuration,
      {
        clock: { now: () => workerData.observed_at },
        random: {
          bytes: (purpose, length) => {
            const output = new Uint8Array(length);
            let offset = 0;
            while (offset < length) {
              const chunk = createHash('sha256')
                .update(
                  workerData.contender + ':' + purpose + ':' + randomSequence++,
                  'utf8',
                )
                .digest();
              const copied = Math.min(chunk.length, length - offset);
              output.set(chunk.subarray(0, copied), offset);
              offset += copied;
            }
            return output;
          },
        },
        hash: {
          sha256: (value) =>
            Uint8Array.from(createHash('sha256').update(value).digest()),
        },
        pkce_sealer: {
          seal: () => { throw new Error('unused PKCE sealer'); },
          unseal: () => { throw new Error('unused PKCE sealer'); },
        },
        oidc_provider: {
          redeemAuthorizationCode: async () => {
            throw new Error('unused OIDC provider');
          },
        },
      },
    );
    try {
      const session = application.refresh({
        refresh_token: workerData.raw_refresh_token,
      });
      result = {
        kind: 'result',
        contender: workerData.contender,
        outcome: 'issued',
        access_token: session.access_token,
        refresh_token: session.refresh_token,
      };
    } catch (error) {
      if (error?.code !== 'unauthorized') throw error;
      result = {
        kind: 'result',
        contender: workerData.contender,
        outcome: 'denied',
      };
    };
  } catch (error) {
    result = {
      kind: 'error',
      contender: workerData.contender,
      message: error instanceof Error ? error.stack ?? error.message : String(error),
    };
  } finally {
    repository.close();
  }
  parentPort.postMessage(result);
`;

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function descriptor(): OrganizationAuthorityDescriptorV1 {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' });
  if (!Buffer.isBuffer(publicKey)) throw new Error('test key export failed');
  return {
    schema_version: 1,
    kind: 'echo-organization-authority',
    authority_id: federationId('oau'),
    organization_id: federationId('org'),
    signing_key: {
      key_id: p256KeyId(publicKey),
      algorithm: 'ecdsa-p256-sha256-der-low-s',
      public_key_spki_der_base64: publicKey.toString('base64'),
    },
  };
}

function digest(raw: string): Sha256Digest {
  return sha256Digest(Buffer.from(raw, 'utf8'));
}

function rawDatabase<T>(
  path: string,
  operation: (database: Database.Database) => T,
): T {
  const database = new Database(path);
  database.pragma('foreign_keys = ON');
  try {
    return operation(database);
  } finally {
    database.close();
  }
}

describe('person identity and session persistence', () => {
  it('persists an exact bootstrap identity and supports one-use rotation and terminal revocation across restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'echo-person-session-'));
    directories.push(directory);
    const path = join(directory, 'authority.sqlite');
    const authority = descriptor();
    const pin = organizationAuthorityPinSha256(authority);
    const repository = new SqliteOrganizationAuthorityRepository(path);
    repository.initialize({
      descriptor: authority,
      authority_pin_sha256: pin,
      organization_display_name: 'Example Company',
      initialized_at: '2026-08-18T00:00:00.000Z',
    });
    const membership: StoredAuthorityMembership = {
      organization_id: authority.organization_id,
      principal_id: federationId('prn'),
      membership_id: federationId('mem'),
      display_name: 'Owner',
      membership_type: 'owner',
      status: 'active',
      provisioned_at: '2026-08-18T00:00:00.000Z',
      revoked_at: null,
      revocation_reason: null,
      admin_command_id: `adm_${randomUUID()}`,
      admin_command_sha256: digest('membership command'),
    };
    const otherMembership: StoredAuthorityMembership = {
      ...membership,
      principal_id: federationId('prn'),
      membership_id: federationId('mem'),
      display_name: 'Other person',
      admin_command_id: `adm_${randomUUID()}`,
      admin_command_sha256: digest('other membership command'),
    };
    repository.write('2026-08-18T00:00:00.000Z', (transaction) => {
      transaction.insertMembership(membership);
      transaction.insertMembership(otherMembership);
    });
    expect(() =>
      rawDatabase(path, (database) =>
        database
          .prepare(
            `INSERT INTO authority_person_login_grants (
               login_grant_sha256, grant_purpose, organization_id,
               principal_id, membership_id, membership_type, expected_issuer,
               oidc_configuration_sha256, issued_at, expires_at, consumed_at
             ) VALUES (?, 'oidc_identity_bootstrap', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            digest('preconsumed grant insertion'),
            membership.organization_id,
            membership.principal_id,
            membership.membership_id,
            membership.membership_type,
            'https://issuer.example/',
            digest('OIDC configuration v1'),
            '2026-08-18T00:00:00.000Z',
            '2026-08-18T00:15:00.000Z',
            '2026-08-18T00:00:00.000Z',
          ),
      ),
    ).toThrow('person login grant must begin pending');

    const rawGrant = 'raw-login-grant-never-store';
    const rawState = 'raw-oidc-state-never-store';
    const rawNonce = 'raw-oidc-nonce-never-store';
    const rawVerifier = 'raw-pkce-verifier-never-store';
    const rawAccess1 = Buffer.alloc(32, 0xa1).toString('base64url');
    const rawRefresh1 = Buffer.alloc(32, 0xb1).toString('base64url');
    const issuer = 'https://issuer.example/';
    const configurationSha256 = digest('OIDC configuration v1');
    const tenantSha256 = digest('tenant constraint v1');
    const grantSha256 = digest(rawGrant);
    const stateSha256 = digest(rawState);
    const familyId = `psf_${randomUUID()}`;
    const bindingId = `oib_${randomUUID()}`;
    const loginAttemptId = `ola_${randomUUID()}`;
    const firstClaimId = `olc_${randomUUID()}`;
    const competingClaimId = `olc_${randomUUID()}`;
    const callbackClaimId = `olc_${randomUUID()}`;

    expect(() =>
      repository.write('2026-08-18T00:00:00.000Z', (transaction) => {
        transaction.insertPersonLoginGrant({
          login_grant_sha256: digest('wrong lifetime grant'),
          grant_purpose: 'oidc_identity_bootstrap',
          organization_id: membership.organization_id,
          principal_id: membership.principal_id,
          membership_id: membership.membership_id,
          membership_type: membership.membership_type,
          expected_issuer: issuer,
          oidc_configuration_sha256: configurationSha256,
          expires_at: '2026-08-18T00:15:01.000Z',
        });
      }),
    ).toThrow('exactly fifteen minutes');

    repository.write('2026-08-18T00:00:01.000Z', (transaction) => {
      transaction.insertPersonLoginGrant({
        login_grant_sha256: grantSha256,
        grant_purpose: 'oidc_identity_bootstrap',
        organization_id: membership.organization_id,
        principal_id: membership.principal_id,
        membership_id: membership.membership_id,
        membership_type: membership.membership_type,
        expected_issuer: issuer,
        oidc_configuration_sha256: configurationSha256,
        expires_at: '2026-08-18T00:15:01.000Z',
      });
    });
    expect(() =>
      rawDatabase(path, (database) =>
        database
          .prepare(
            `INSERT INTO authority_oidc_login_attempts (
               login_attempt_id, issuer, attempt_purpose, client_id,
               redirect_uri, tenant_constraint_sha256,
               oidc_configuration_sha256, login_grant_sha256, state_sha256,
               nonce_sha256, pkce_verifier_seal_key_id,
               pkce_verifier_sealed, created_at, expires_at,
               redemption_claim_id, redemption_claimed_at, terminal_outcome,
               completed_at, resolved_identity_binding_id, upstream_assertion_issued_at
             ) VALUES (
               ?, ?, 'existing_identity_login', 'echo-browser-client',
               'https://authority.example/auth/oidc/callback', ?, ?, NULL, ?, ?,
               NULL, NULL, ?, ?, NULL, NULL, 'denied', ?, NULL, NULL
             )`,
          )
          .run(
            `ola_${randomUUID()}`,
            issuer,
            tenantSha256,
            configurationSha256,
            digest('terminal initial state'),
            digest('terminal initial nonce'),
            '2026-08-18T00:00:30.000Z',
            '2026-08-18T00:10:30.000Z',
            '2026-08-18T00:00:31.000Z',
          ),
      ),
    ).toThrow('OIDC login attempt must begin pending and unclaimed');
    expect(() =>
      repository.write('2026-08-18T00:00:30.000Z', (transaction) => {
        transaction.insertOidcLoginAttempt({
          login_attempt_id: `ola_${randomUUID()}`,
          issuer,
          attempt_purpose: 'existing_identity_login',
          client_id: 'echo-browser-client',
          redirect_uri: 'https://authority.example/auth/oidc/callback',
          tenant_constraint_sha256: tenantSha256,
          oidc_configuration_sha256: configurationSha256,
          login_grant_sha256: null,
          state_sha256: digest('wrong lifetime state'),
          nonce_sha256: digest('wrong lifetime nonce'),
          sealed_pkce_verifier: {
            key_id: 'test-seal-key-v1',
            sealed_bytes: createHash('sha512')
              .update('wrong lifetime verifier', 'utf8')
              .digest(),
          },
          expires_at: '2026-08-18T00:10:31.000Z',
        });
      }),
    ).toThrow('exactly ten minutes');
    repository.write('2026-08-18T00:01:00.000Z', (transaction) => {
      transaction.insertOidcLoginAttempt({
        login_attempt_id: loginAttemptId,
        issuer,
        attempt_purpose: 'identity_bootstrap',
        client_id: 'echo-browser-client',
        redirect_uri: 'https://authority.example/auth/oidc/callback',
        tenant_constraint_sha256: tenantSha256,
        oidc_configuration_sha256: configurationSha256,
        login_grant_sha256: grantSha256,
        state_sha256: stateSha256,
        nonce_sha256: digest(rawNonce),
        sealed_pkce_verifier: {
          key_id: 'test-seal-key-v1',
          sealed_bytes: createHash('sha512')
            .update(rawVerifier, 'utf8')
            .digest(),
        },
        expires_at: '2026-08-18T00:11:00.000Z',
      });
    });
    expect(() =>
      repository.write('2026-08-18T00:01:01.000Z', (transaction) => {
        transaction.insertOidcLoginAttempt({
          login_attempt_id: `ola_${randomUUID()}`,
          issuer,
          attempt_purpose: 'identity_bootstrap',
          client_id: 'echo-browser-client',
          redirect_uri: 'https://authority.example/auth/oidc/callback',
          tenant_constraint_sha256: tenantSha256,
          oidc_configuration_sha256: configurationSha256,
          login_grant_sha256: grantSha256,
          state_sha256: digest('competing bootstrap state'),
          nonce_sha256: digest('competing bootstrap nonce'),
          sealed_pkce_verifier: {
            key_id: 'test-seal-key-v1',
            sealed_bytes: createHash('sha512')
              .update('competing bootstrap verifier', 'utf8')
              .digest(),
          },
          expires_at: '2026-08-18T00:11:01.000Z',
        });
      }),
    ).toThrow();

    repository.write('2026-08-18T00:01:30.000Z', (transaction) => {
      expect(
        transaction.claimOidcLoginAttempt(stateSha256, firstClaimId),
      ).toMatchObject({
        redemption_claim_id: firstClaimId,
        redemption_claimed_at: '2026-08-18T00:01:30.000Z',
        terminal_outcome: null,
      });
      expect(
        transaction.claimOidcLoginAttempt(stateSha256, competingClaimId),
      ).toBeUndefined();
      expect(
        transaction.releaseOidcLoginAttemptClaim(
          stateSha256,
          competingClaimId,
        ),
      ).toBe(false);
      expect(
        transaction.completeOidcLoginAttempt(
          stateSha256,
          competingClaimId,
          { outcome: 'denied' },
        ),
      ).toBeUndefined();
    });
    repository.write('2026-08-18T00:01:31.000Z', (transaction) => {
      expect(
        transaction.releaseOidcLoginAttemptClaim(stateSha256, firstClaimId),
      ).toBe(true);
      expect(
        transaction.claimOidcLoginAttempt(stateSha256, callbackClaimId),
      ).toMatchObject({
        redemption_claim_id: callbackClaimId,
        pkce_verifier_seal_key_id: 'test-seal-key-v1',
      });
      expect(
        transaction.completeOidcLoginAttempt(
          stateSha256,
          firstClaimId,
          { outcome: 'denied' },
        ),
      ).toBeUndefined();
    });

    expect(() =>
      rawDatabase(path, (database) =>
        database
          .prepare(
            `INSERT INTO authority_oidc_identity_bindings (
               identity_binding_id, issuer, subject,
               tenant_constraint_sha256, oidc_configuration_sha256,
               initial_login_attempt_id, initial_login_grant_sha256,
               organization_id, principal_id, membership_id, membership_type,
               status, bound_at, revoked_at, revocation_reason
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, NULL)`,
          )
          .run(
            `oib_${randomUUID()}`,
            issuer,
            'premature-subject',
            tenantSha256,
            configurationSha256,
            loginAttemptId,
            grantSha256,
            membership.organization_id,
            membership.principal_id,
            membership.membership_id,
            membership.membership_type,
            '2026-08-18T00:01:01.000Z',
          ),
      ),
    ).toThrow('requires a successful exact bootstrap attempt');

    repository.write('2026-08-18T00:02:00.000Z', (transaction) => {
      expect(
        transaction.completeOidcLoginAttempt(
          stateSha256,
          callbackClaimId,
          {
            outcome: 'succeeded',
            resolved_identity_binding_id: bindingId,
            upstream_assertion_issued_at: '2026-08-18T00:01:30.000Z',
          },
        ),
      ).toMatchObject({
        terminal_outcome: 'succeeded',
        completed_at: '2026-08-18T00:02:00.000Z',
        pkce_verifier_seal_key_id: null,
        pkce_verifier_sealed: null,
      });
      transaction.insertOidcIdentityBinding({
        identity_binding_id: bindingId,
        issuer,
        subject: 'opaque-provider-subject-123',
        tenant_constraint_sha256: tenantSha256,
        oidc_configuration_sha256: configurationSha256,
        initial_login_attempt_id: loginAttemptId,
        initial_login_grant_sha256: grantSha256,
        organization_id: membership.organization_id,
        principal_id: membership.principal_id,
        membership_id: membership.membership_id,
        membership_type: membership.membership_type,
      });
      transaction.insertPersonSessionFamily({
        session_family_id: familyId,
        identity_binding_id: bindingId,
        authentication_login_attempt_id: loginAttemptId,
        organization_id: membership.organization_id,
        principal_id: membership.principal_id,
        membership_id: membership.membership_id,
        membership_type: membership.membership_type,
        upstream_assertion_issued_at: '2026-08-18T00:01:30.000Z',
        tenant_constraint_sha256: tenantSha256,
        oidc_configuration_sha256: configurationSha256,
        hard_reauthentication_at: '2026-08-25T00:01:30.000Z',
      });
      transaction.insertPersonSessionCredential({
        session_credential_id: `psc_${randomUUID()}`,
        session_family_id: familyId,
        credential_kind: 'access',
        rotation_sequence: 1,
        token_sha256: digest(rawAccess1),
        expires_at: '2026-08-18T12:02:00.000Z',
      });
      transaction.insertPersonSessionCredential({
        session_credential_id: `psc_${randomUUID()}`,
        session_family_id: familyId,
        credential_kind: 'refresh',
        rotation_sequence: 1,
        token_sha256: digest(rawRefresh1),
        expires_at: '2026-08-25T00:01:30.000Z',
      });
    });

    expect(() =>
      rawDatabase(path, (database) =>
        database
          .prepare(
            `INSERT INTO authority_person_session_credentials (
               session_credential_id, session_family_id, credential_kind,
               rotation_sequence, token_sha256, issued_at, expires_at,
               consumed_at, revoked_at, revocation_reason
             ) VALUES (?, ?, 'access', 2, ?, ?, ?, NULL, ?, ?)`,
          )
          .run(
            `psc_${randomUUID()}`,
            familyId,
            digest('pre-revoked access credential'),
            '2026-08-18T00:02:02.000Z',
            '2026-08-18T12:02:02.000Z',
            '2026-08-18T00:02:02.000Z',
            'inserted already revoked',
          ),
      ),
    ).toThrow('person session credential must begin live');

    for (const kind of ['access', 'refresh'] as const) {
      expect(() =>
        repository.write('2026-08-18T00:02:00.500Z', (transaction) => {
          transaction.insertPersonSessionCredential({
            session_credential_id: `psc_${randomUUID()}`,
            session_family_id: familyId,
            credential_kind: kind,
            rotation_sequence: 2,
            token_sha256: digest(`wrong ${kind} lifetime`),
            expires_at:
              kind === 'access'
                ? '2026-08-18T12:02:00.000Z'
                : '2026-08-25T00:01:29.000Z',
          });
        }),
      ).toThrow('lifetime differs from policy');
    }

    const mismatchedGrantSha256 = digest('mismatched tuple grant');
    repository.write('2026-08-18T00:02:01.000Z', (transaction) => {
      transaction.insertPersonLoginGrant({
        login_grant_sha256: mismatchedGrantSha256,
        grant_purpose: 'oidc_identity_bootstrap',
        organization_id: membership.organization_id,
        principal_id: membership.principal_id,
        membership_id: membership.membership_id,
        membership_type: membership.membership_type,
        expected_issuer: issuer,
        oidc_configuration_sha256: configurationSha256,
        expires_at: '2026-08-18T00:17:01.000Z',
      });
      expect(
        transaction.consumePersonLoginGrant(mismatchedGrantSha256),
      ).toBeDefined();
    });
    expect(() =>
      rawDatabase(path, (database) =>
        database
          .prepare(
            `INSERT INTO authority_oidc_identity_bindings (
               identity_binding_id, issuer, subject,
               tenant_constraint_sha256, oidc_configuration_sha256,
               initial_login_attempt_id, initial_login_grant_sha256,
               organization_id, principal_id, membership_id, membership_type,
               status, bound_at, revoked_at, revocation_reason
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, NULL)`,
          )
          .run(
            `oib_${randomUUID()}`,
            issuer,
            'wrong-person-subject',
            tenantSha256,
            configurationSha256,
            `ola_${randomUUID()}`,
            mismatchedGrantSha256,
            otherMembership.organization_id,
            otherMembership.principal_id,
            otherMembership.membership_id,
            otherMembership.membership_type,
            '2026-08-18T00:02:02.000Z',
          ),
      ),
    ).toThrow('requires a successful exact bootstrap attempt');
    for (const operation of [
      (database: Database.Database) =>
        database
          .prepare(
            `UPDATE authority_oidc_identity_bindings
                SET subject = 'retargeted-subject'
              WHERE identity_binding_id = ?`,
          )
          .run(bindingId),
      (database: Database.Database) =>
        database
          .prepare(
            `UPDATE authority_oidc_login_attempts
                SET terminal_outcome = NULL, completed_at = NULL,
                    resolved_identity_binding_id = NULL,
                    upstream_assertion_issued_at = NULL
              WHERE state_sha256 = ?`,
          )
          .run(stateSha256),
      (database: Database.Database) =>
        database
          .prepare(
            `UPDATE authority_person_login_grants
                SET consumed_at = NULL
              WHERE login_grant_sha256 = ?`,
          )
          .run(grantSha256),
      (database: Database.Database) =>
        database
          .prepare(
            `UPDATE authority_person_session_families
                SET hard_reauthentication_at = '2026-08-26T00:01:30.000Z'
              WHERE session_family_id = ?`,
          )
          .run(familyId),
    ]) {
      expect(() => rawDatabase(path, operation)).toThrow();
    }
    for (const kind of ['access', 'refresh'] as const) {
      expect(() =>
        rawDatabase(path, (database) =>
          database
            .prepare(
              `INSERT INTO authority_person_session_credentials (
                 session_credential_id, session_family_id, credential_kind,
                 rotation_sequence, token_sha256, issued_at, expires_at,
                 consumed_at, revoked_at, revocation_reason
               ) VALUES (?, ?, ?, 99, ?, ?, ?, NULL, NULL, NULL)`,
            )
            .run(
              `psc_${randomUUID()}`,
              familyId,
              kind,
              digest(`second live ${kind}`),
              '2026-08-18T00:02:02.000Z',
              kind === 'access'
                ? '2026-08-18T12:02:02.000Z'
                : '2026-08-25T00:01:30.000Z',
            ),
        ),
      ).toThrow();
    }

    expect(() =>
      repository.write('2026-08-18T00:02:01.000Z', (transaction) => {
        transaction.insertOidcIdentityBinding({
          identity_binding_id: `oib_${randomUUID()}`,
          issuer,
          subject: 'opaque-provider-subject-123',
          tenant_constraint_sha256: tenantSha256,
          oidc_configuration_sha256: configurationSha256,
          initial_login_attempt_id: loginAttemptId,
          initial_login_grant_sha256: grantSha256,
          organization_id: membership.organization_id,
          principal_id: membership.principal_id,
          membership_id: membership.membership_id,
          membership_type: membership.membership_type,
        });
      }),
    ).toThrow();

    const rotatedConfigurationSha256 = digest('OIDC configuration v2');
    const rotatedTenantSha256 = digest('tenant constraint v2');
    const rotatedStateSha256 = digest('rotated configuration login state');
    const rotatedAttemptId = `ola_${randomUUID()}`;
    const rotatedFamilyId = `psf_${randomUUID()}`;
    const rotatedClaimId = `olc_${randomUUID()}`;
    repository.write('2026-08-18T00:02:10.000Z', (transaction) => {
      transaction.insertOidcLoginAttempt({
        login_attempt_id: rotatedAttemptId,
        issuer,
        attempt_purpose: 'existing_identity_login',
        client_id: 'echo-browser-client-v2',
        redirect_uri: 'https://authority.example/auth/oidc/callback',
        tenant_constraint_sha256: rotatedTenantSha256,
        oidc_configuration_sha256: rotatedConfigurationSha256,
        login_grant_sha256: null,
        state_sha256: rotatedStateSha256,
        nonce_sha256: digest('rotated configuration login nonce'),
        sealed_pkce_verifier: {
          key_id: 'test-seal-key-v2',
          sealed_bytes: createHash('sha512')
            .update('rotated configuration verifier', 'utf8')
            .digest(),
        },
        expires_at: '2026-08-18T00:12:10.000Z',
      });
    });
    repository.write('2026-08-18T00:02:11.000Z', (transaction) => {
      expect(
        transaction.claimOidcLoginAttempt(
          rotatedStateSha256,
          rotatedClaimId,
        ),
      ).toBeDefined();
    });
    expect(() =>
      repository.write('2026-08-18T00:03:20.000Z', (transaction) => {
        transaction.completeOidcLoginAttempt(
          rotatedStateSha256,
          rotatedClaimId,
          {
            outcome: 'succeeded',
            resolved_identity_binding_id: bindingId,
            upstream_assertion_issued_at: '2026-08-18T00:04:20.001Z',
          },
        );
      }),
    ).toThrow('outside the accepted skew');
    expect(() =>
      repository.write('2026-08-18T00:03:20.000Z', (transaction) => {
        transaction.completeOidcLoginAttempt(
          rotatedStateSha256,
          rotatedClaimId,
          {
            outcome: 'succeeded',
            resolved_identity_binding_id: bindingId,
            upstream_assertion_issued_at: '2026-08-18T00:03:20.000Z',
          },
        );
        transaction.insertPersonSessionFamily({
          session_family_id: rotatedFamilyId,
          identity_binding_id: bindingId,
          authentication_login_attempt_id: rotatedAttemptId,
          organization_id: membership.organization_id,
          principal_id: membership.principal_id,
          membership_id: membership.membership_id,
          membership_type: membership.membership_type,
          upstream_assertion_issued_at: '2026-08-18T00:03:20.000Z',
          tenant_constraint_sha256: rotatedTenantSha256,
          oidc_configuration_sha256: rotatedConfigurationSha256,
          hard_reauthentication_at: '2026-08-25T00:03:21.000Z',
        });
      }),
    ).toThrow('family times are inconsistent');
    repository.write('2026-08-18T00:03:20.000Z', (transaction) => {
      expect(
        transaction.completeOidcLoginAttempt(
          rotatedStateSha256,
          rotatedClaimId,
          {
            outcome: 'succeeded',
            resolved_identity_binding_id: bindingId,
            upstream_assertion_issued_at: '2026-08-18T00:03:20.000Z',
          },
        ),
      ).toBeDefined();
      transaction.insertPersonSessionFamily({
        session_family_id: rotatedFamilyId,
        identity_binding_id: bindingId,
        authentication_login_attempt_id: rotatedAttemptId,
        organization_id: membership.organization_id,
        principal_id: membership.principal_id,
        membership_id: membership.membership_id,
        membership_type: membership.membership_type,
        upstream_assertion_issued_at: '2026-08-18T00:03:20.000Z',
        tenant_constraint_sha256: rotatedTenantSha256,
        oidc_configuration_sha256: rotatedConfigurationSha256,
        hard_reauthentication_at: '2026-08-25T00:03:20.000Z',
      });
    });

    const reusedBindingGrantSha256 = digest('reused binding bootstrap grant');
    const reusedBindingStateSha256 = digest('reused binding bootstrap state');
    const reusedBindingAttemptId = `ola_${randomUUID()}`;
    const reusedBindingClaimId = `olc_${randomUUID()}`;
    repository.write('2026-08-18T00:03:21.000Z', (transaction) => {
      transaction.insertPersonLoginGrant({
        login_grant_sha256: reusedBindingGrantSha256,
        grant_purpose: 'oidc_identity_bootstrap',
        organization_id: membership.organization_id,
        principal_id: membership.principal_id,
        membership_id: membership.membership_id,
        membership_type: membership.membership_type,
        expected_issuer: issuer,
        oidc_configuration_sha256: configurationSha256,
        expires_at: '2026-08-18T00:18:21.000Z',
      });
    });
    repository.write('2026-08-18T00:03:22.000Z', (transaction) => {
      transaction.insertOidcLoginAttempt({
        login_attempt_id: reusedBindingAttemptId,
        issuer,
        attempt_purpose: 'identity_bootstrap',
        client_id: 'echo-browser-client',
        redirect_uri: 'https://authority.example/auth/oidc/callback',
        tenant_constraint_sha256: tenantSha256,
        oidc_configuration_sha256: configurationSha256,
        login_grant_sha256: reusedBindingGrantSha256,
        state_sha256: reusedBindingStateSha256,
        nonce_sha256: digest('reused binding bootstrap nonce'),
        sealed_pkce_verifier: {
          key_id: 'test-seal-key-v1',
          sealed_bytes: createHash('sha512')
            .update('reused binding bootstrap verifier', 'utf8')
            .digest(),
        },
        expires_at: '2026-08-18T00:13:22.000Z',
      });
    });
    repository.write('2026-08-18T00:03:23.000Z', (transaction) => {
      expect(
        transaction.claimOidcLoginAttempt(
          reusedBindingStateSha256,
          reusedBindingClaimId,
        ),
      ).toBeDefined();
    });
    const succeedReusedBindingAttempt = (database: Database.Database) =>
      database
        .prepare(
          `UPDATE authority_oidc_login_attempts
              SET terminal_outcome = 'succeeded', completed_at = ?,
                  resolved_identity_binding_id = ?, upstream_assertion_issued_at = ?,
                  redemption_claim_id = NULL, redemption_claimed_at = NULL,
                  pkce_verifier_seal_key_id = NULL,
                  pkce_verifier_sealed = NULL
            WHERE state_sha256 = ?`,
        )
        .run(
          '2026-08-18T00:03:24.000Z',
          bindingId,
          '2026-08-18T00:03:24.000Z',
          reusedBindingStateSha256,
        );
    expect(() => rawDatabase(path, succeedReusedBindingAttempt)).toThrow(
      /FOREIGN KEY constraint failed/,
    );
    expect(() =>
      rawDatabase(path, (database) => {
        database.exec('BEGIN');
        try {
          succeedReusedBindingAttempt(database);
          database
            .prepare(
              `INSERT INTO authority_person_session_families (
                 session_family_id, organization_id, principal_id,
                 membership_id, membership_type, identity_binding_id,
                 authentication_login_attempt_id, created_at,
                 upstream_assertion_issued_at, tenant_constraint_sha256,
                 oidc_configuration_sha256, hard_reauthentication_at,
                 status, revoked_at, revocation_reason
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                         'active', NULL, NULL)`,
            )
            .run(
              `psf_${randomUUID()}`,
              membership.organization_id,
              membership.principal_id,
              membership.membership_id,
              membership.membership_type,
              bindingId,
              reusedBindingAttemptId,
              '2026-08-18T00:03:24.000Z',
              '2026-08-18T00:03:24.000Z',
              tenantSha256,
              configurationSha256,
              '2026-08-25T00:03:24.000Z',
            );
          database.exec('COMMIT');
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
      }),
    ).toThrow('person session family requires a successful exact login attempt');
    repository.write('2026-08-18T00:03:24.000Z', (transaction) => {
      expect(
        transaction.completeOidcLoginAttempt(
          reusedBindingStateSha256,
          reusedBindingClaimId,
          { outcome: 'denied' },
        ),
      ).toMatchObject({ terminal_outcome: 'denied' });
    });

    const startGate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const workerUrl = new URL(
      `data:text/javascript,${encodeURIComponent(refreshContenderWorkerSource)}`,
    );
    const repositoryUrl = new URL(
      '../dist/adapters/persistence/sqlite/sqlite-authority-repository.js',
      import.meta.url,
    ).href;
    const applicationUrl = new URL(
      '../dist/application/person-identity-sessions.js',
      import.meta.url,
    ).href;
    const contenderInput = (contender: 'a' | 'b') => ({
      contender,
      database_path: path,
      repository_url: repositoryUrl,
      application_url: applicationUrl,
      start_gate: startGate,
      observed_at: '2026-08-18T00:03:30.000Z',
      refresh_token_sha256: digest(rawRefresh1),
      raw_refresh_token: rawRefresh1,
      oidc_configuration: {
        issuer,
        client_id: 'echo-browser-client',
        redirect_uri: 'https://authority.example/auth/oidc/callback',
        tenant: { kind: 'issuer' },
        id_token_algorithms: ['ES256'],
      },
      initialization: {
        descriptor: authority,
        authority_pin_sha256: pin,
        organization_display_name: 'Example Company',
        initialized_at: '2026-08-18T00:03:29.000Z',
      },
    });
    const contenders = [
      new Worker(workerUrl, {
        workerData: contenderInput('a'),
      }),
      new Worker(workerUrl, {
        workerData: contenderInput('b'),
      }),
    ];
    const exitEvents = contenders.map((worker) => once(worker, 'exit'));
    const readyEvents = contenders.map((worker) => once(worker, 'message'));
    const ready = (await Promise.all(readyEvents)).map(
      ([message]) => message as {
        kind: string;
        contender: string;
        observed_live: boolean;
      },
    );
    expect(ready).toEqual(
      expect.arrayContaining([
        { kind: 'ready', contender: 'a', observed_live: true },
        { kind: 'ready', contender: 'b', observed_live: true },
      ]),
    );
    const resultEvents = contenders.map((worker) => once(worker, 'message'));
    Atomics.store(new Int32Array(startGate), 0, 1);
    Atomics.notify(new Int32Array(startGate), 0, contenders.length);
    const contenderResults = (await Promise.all(resultEvents)).map(
      ([message]) => message as {
        kind: string;
        contender: 'a' | 'b';
        outcome?: string;
        message?: string;
        access_token?: string;
        refresh_token?: string;
      },
    );
    expect(contenderResults).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({ kind: 'error' }),
      ]),
    );
    expect(contenderResults.map(({ outcome }) => outcome).sort()).toEqual([
      'denied',
      'issued',
    ]);
    expect((await Promise.all(exitEvents)).map(([code]) => code)).toEqual([
      0,
      0,
    ]);
    const winner = contenderResults.find(
      ({ outcome }) => outcome === 'issued',
    );
    if (winner === undefined) throw new Error('refresh race lacked a winner');
    if (
      typeof winner.access_token !== 'string' ||
      typeof winner.refresh_token !== 'string'
    ) {
      throw new Error('refresh race winner lacked issued credentials');
    }
    const rawAccess2 = winner.access_token;
    const rawRefresh2 = winner.refresh_token;
    const afterContenders = repository.read((transaction) => ({
      family: transaction.personSessionFamily(familyId),
      credentials: transaction.personSessionCredentialsForFamily(familyId),
    }));
    expect(afterContenders.family).toMatchObject({
      status: 'revoked',
      revoked_at: '2026-08-18T00:03:30.000Z',
      revocation_reason: 'refresh_credential_replay',
    });
    expect(afterContenders.credentials).toHaveLength(4);
    expect(
      afterContenders.credentials.every(
        ({ revoked_at }) => revoked_at === '2026-08-18T00:03:30.000Z',
      ),
    ).toBe(true);
    expect(
      afterContenders.credentials.find(
        ({ token_sha256 }) => token_sha256 === digest(rawRefresh1),
      ),
    ).toMatchObject({ consumed_at: '2026-08-18T00:03:30.000Z' });
    expect(
      afterContenders.credentials.find(
        ({ token_sha256 }) => token_sha256 === digest(rawAccess2),
      ),
    ).toMatchObject({ credential_kind: 'access', rotation_sequence: 2 });
    expect(
      afterContenders.credentials.find(
        ({ token_sha256 }) => token_sha256 === digest(rawRefresh2),
      ),
    ).toMatchObject({ credential_kind: 'refresh', rotation_sequence: 2 });
    expect(() =>
      rawDatabase(path, (database) =>
        database
          .prepare(
            `UPDATE authority_person_session_credentials
                SET consumed_at = NULL
              WHERE token_sha256 = ?`,
          )
          .run(digest(rawRefresh1)),
      ),
    ).toThrow();
    expect(
      repository.write('2026-08-18T00:03:31.000Z', (transaction) =>
        transaction.consumePersonSessionRefreshCredential(digest(rawRefresh1)),
      ),
    ).toBeUndefined();
    repository.write('2026-08-18T00:04:00.000Z', (transaction) => {
      expect(
        transaction.revokeOidcIdentityBinding(
          bindingId,
          'operator revoked browser session',
        ),
      ).toBe(true);
    });
    expect(() =>
      rawDatabase(path, (database) =>
        database
          .prepare(
            `UPDATE authority_person_session_families
                SET status = 'active', revoked_at = NULL,
                    revocation_reason = NULL
              WHERE session_family_id = ?`,
          )
          .run(familyId),
      ),
    ).toThrow();
    expect(() =>
      rawDatabase(path, (database) =>
        database
          .prepare(
            `UPDATE authority_person_session_credentials
                SET consumed_at = '2026-08-18T00:04:01.000Z'
              WHERE token_sha256 = ?`,
          )
          .run(digest(rawRefresh2)),
      ),
    ).toThrow('person session credential mutation is denied');

    const boundaryGrantSha256 = digest('expiry-boundary-grant');
    const boundaryStateSha256 = digest('expiry-boundary-state');
    const boundaryClaimId = `olc_${randomUUID()}`;
    repository.write('2026-08-18T00:04:10.000Z', (transaction) => {
      transaction.insertPersonLoginGrant({
        login_grant_sha256: boundaryGrantSha256,
        grant_purpose: 'oidc_identity_bootstrap',
        organization_id: membership.organization_id,
        principal_id: membership.principal_id,
        membership_id: membership.membership_id,
        membership_type: membership.membership_type,
        expected_issuer: issuer,
        oidc_configuration_sha256: configurationSha256,
        expires_at: '2026-08-18T00:19:10.000Z',
      });
    });
    repository.write('2026-08-18T00:04:20.000Z', (transaction) => {
      transaction.insertOidcLoginAttempt({
        login_attempt_id: `ola_${randomUUID()}`,
        issuer,
        attempt_purpose: 'identity_bootstrap',
        client_id: 'echo-browser-client',
        redirect_uri: 'https://authority.example/auth/oidc/callback',
        tenant_constraint_sha256: tenantSha256,
        oidc_configuration_sha256: configurationSha256,
        login_grant_sha256: boundaryGrantSha256,
        state_sha256: boundaryStateSha256,
        nonce_sha256: digest('expiry-boundary-nonce'),
        sealed_pkce_verifier: {
          key_id: 'test-seal-key-v1',
          sealed_bytes: createHash('sha512')
            .update('expiry-boundary-verifier', 'utf8')
            .digest(),
        },
        expires_at: '2026-08-18T00:14:20.000Z',
      });
    });
    repository.write('2026-08-18T00:04:30.000Z', (transaction) => {
      expect(
        transaction.claimOidcLoginAttempt(
          boundaryStateSha256,
          boundaryClaimId,
        ),
      ).toBeDefined();
    });
    const lateGrantSha256 = digest('late bootstrap grant');
    const lateStateSha256 = digest('late bootstrap state');
    const lateClaimId = `olc_${randomUUID()}`;
    repository.write('2026-08-18T00:04:40.000Z', (transaction) => {
      transaction.insertPersonLoginGrant({
        login_grant_sha256: lateGrantSha256,
        grant_purpose: 'oidc_identity_bootstrap',
        organization_id: membership.organization_id,
        principal_id: membership.principal_id,
        membership_id: membership.membership_id,
        membership_type: membership.membership_type,
        expected_issuer: issuer,
        oidc_configuration_sha256: configurationSha256,
        expires_at: '2026-08-18T00:19:40.000Z',
      });
    });
    repository.write('2026-08-18T00:10:40.000Z', (transaction) => {
      transaction.insertOidcLoginAttempt({
        login_attempt_id: `ola_${randomUUID()}`,
        issuer,
        attempt_purpose: 'identity_bootstrap',
        client_id: 'echo-browser-client',
        redirect_uri: 'https://authority.example/auth/oidc/callback',
        tenant_constraint_sha256: tenantSha256,
        oidc_configuration_sha256: configurationSha256,
        login_grant_sha256: lateGrantSha256,
        state_sha256: lateStateSha256,
        nonce_sha256: digest('late bootstrap nonce'),
        sealed_pkce_verifier: {
          key_id: 'test-seal-key-v1',
          sealed_bytes: createHash('sha512')
            .update('late bootstrap verifier', 'utf8')
            .digest(),
        },
        expires_at: '2026-08-18T00:20:40.000Z',
      });
      expect(
        transaction.oidcLoginAttemptForLoginGrant(lateGrantSha256),
      ).toMatchObject({ state_sha256: lateStateSha256 });
    });
    repository.write('2026-08-18T00:10:41.000Z', (transaction) => {
      expect(
        transaction.claimOidcLoginAttempt(lateStateSha256, lateClaimId),
      ).toBeDefined();
    });
    repository.close();

    const reopened = new SqliteOrganizationAuthorityRepository(path, {
      fileMustExist: true,
      allowInitialization: false,
    });
    reopened.initialize({
      descriptor: authority,
      authority_pin_sha256: pin,
      organization_display_name: 'Example Company',
      initialized_at: '2026-08-18T00:14:20.000Z',
    });
    const pendingAfterRestart = reopened.read((transaction) =>
      transaction.oidcLoginAttempt(boundaryStateSha256),
    );
    expect(pendingAfterRestart).toMatchObject({
      terminal_outcome: null,
      completed_at: null,
      redemption_claim_id: boundaryClaimId,
      redemption_claimed_at: '2026-08-18T00:04:30.000Z',
      pkce_verifier_seal_key_id: 'test-seal-key-v1',
    });
    expect(pendingAfterRestart?.pkce_verifier_sealed).toEqual(
      Uint8Array.from(
        createHash('sha512')
          .update('expiry-boundary-verifier', 'utf8')
          .digest(),
      ),
    );
    expect(
      reopened.write('2026-08-18T00:14:20.000Z', (transaction) =>
        transaction.expireOidcLoginAttempts(1),
      ),
    ).toBe(1);
    expect(
      reopened.read((transaction) =>
        transaction.personLoginGrant(boundaryGrantSha256),
      ),
    ).toMatchObject({ consumed_at: '2026-08-18T00:14:20.000Z' });
    const persisted = reopened.read((transaction) => ({
      attempt: transaction.oidcLoginAttempt(stateSha256),
      grant: transaction.personLoginGrant(grantSha256),
      binding: transaction.oidcIdentityBinding(
        issuer,
        'opaque-provider-subject-123',
      ),
      family: transaction.personSessionFamily(familyId),
      credentials: transaction.personSessionCredentialsForFamily(familyId),
    }));
    expect(persisted.attempt).toMatchObject({
      terminal_outcome: 'succeeded',
      completed_at: '2026-08-18T00:02:00.000Z',
      pkce_verifier_seal_key_id: null,
      pkce_verifier_sealed: null,
    });
    expect(persisted.grant?.consumed_at).toBe('2026-08-18T00:02:00.000Z');
    expect(persisted.binding).toMatchObject({
      identity_binding_id: bindingId,
      organization_id: membership.organization_id,
      principal_id: membership.principal_id,
      membership_id: membership.membership_id,
      status: 'revoked',
      revoked_at: '2026-08-18T00:04:00.000Z',
    });
    expect(persisted.family).toMatchObject({
      status: 'revoked',
      revoked_at: '2026-08-18T00:03:30.000Z',
      revocation_reason: 'refresh_credential_replay',
    });
    expect(persisted.credentials).toHaveLength(4);
    expect(persisted.credentials.every((row) => row.revoked_at !== null)).toBe(
      true,
    );
    expect(
      persisted.credentials.find(
        (row) => row.token_sha256 === digest(rawRefresh1),
      ),
    ).toMatchObject({
      consumed_at: '2026-08-18T00:03:30.000Z',
      revoked_at: '2026-08-18T00:03:30.000Z',
    });
    expect(
      reopened.write('2026-08-18T00:14:21.000Z', (transaction) => ({
        attempt: transaction.completeOidcLoginAttempt(
          stateSha256,
          callbackClaimId,
          { outcome: 'denied' },
        ),
        grant: transaction.consumePersonLoginGrant(grantSha256),
      })),
    ).toEqual({ attempt: undefined, grant: undefined });
    expect(
      reopened.read((transaction) =>
        transaction.oidcLoginAttemptForLoginGrant(lateGrantSha256),
      ),
    ).toMatchObject({
      terminal_outcome: null,
      redemption_claim_id: lateClaimId,
      pkce_verifier_seal_key_id: 'test-seal-key-v1',
    });
    reopened.close();

    rawDatabase(path, (database) =>
      database
        .prepare(
          `UPDATE authority_oidc_login_attempts
              SET terminal_outcome = 'expired', completed_at = ?,
                  redemption_claim_id = NULL, redemption_claimed_at = NULL,
                  pkce_verifier_seal_key_id = NULL,
                  pkce_verifier_sealed = NULL
            WHERE state_sha256 = ?`,
        )
        .run('2026-08-18T00:20:40.000Z', lateStateSha256),
    );
    expect(
      rawDatabase(path, (database) =>
        database
          .prepare(
            `SELECT terminal_outcome, completed_at, redemption_claim_id,
                    redemption_claimed_at, pkce_verifier_seal_key_id,
                    pkce_verifier_sealed
               FROM authority_oidc_login_attempts
              WHERE state_sha256 = ?`,
          )
          .get(lateStateSha256),
      ),
    ).toMatchObject({
      terminal_outcome: 'expired',
      completed_at: '2026-08-18T00:20:40.000Z',
      redemption_claim_id: null,
      redemption_claimed_at: null,
      pkce_verifier_seal_key_id: null,
      pkce_verifier_sealed: null,
    });
    expect(
      rawDatabase(path, (database) =>
        database
          .prepare(
            `SELECT consumed_at FROM authority_person_login_grants
              WHERE login_grant_sha256 = ?`,
          )
          .get(lateGrantSha256),
      ),
    ).toEqual({ consumed_at: null });

    expect(() =>
      rawDatabase(path, (database) =>
        database
          .prepare(
            `DELETE FROM authority_oidc_login_attempts
              WHERE state_sha256 = ?`,
          )
          .run(boundaryStateSha256),
      ),
    ).toThrow('OIDC login attempt deletion is denied');

    const database = new Database(path, { readonly: true });
    const secretColumnNames = database
      .prepare(
        `SELECT name FROM pragma_table_info('authority_oidc_login_attempts')
         UNION ALL
         SELECT name FROM pragma_table_info('authority_person_login_grants')
         UNION ALL
         SELECT name FROM pragma_table_info('authority_person_session_credentials')`,
      )
      .all() as Array<{ name: string }>;
    expect(secretColumnNames.map(({ name }) => name)).not.toEqual(
      expect.arrayContaining([
        'state',
        'nonce',
        'pkce_verifier',
        'login_grant',
        'access_token',
        'refresh_token',
        'token',
      ]),
    );
    expect(
      database
        .prepare(
          `SELECT pkce_verifier_seal_key_id, pkce_verifier_sealed
             FROM authority_oidc_login_attempts WHERE state_sha256 = ?`,
        )
        .get(stateSha256),
    ).toEqual({
      pkce_verifier_seal_key_id: null,
      pkce_verifier_sealed: null,
    });
    const storedTokens = database
      .prepare(
        `SELECT token_sha256 FROM authority_person_session_credentials
         ORDER BY token_sha256`,
      )
      .all() as Array<{ token_sha256: string }>;
    expect(storedTokens.every(({ token_sha256 }) => token_sha256.startsWith('sha256:'))).toBe(true);
    expect(JSON.stringify(storedTokens)).not.toContain(rawAccess1);
    expect(JSON.stringify(storedTokens)).not.toContain(rawRefresh1);
    expect(JSON.stringify(storedTokens)).not.toContain(rawVerifier);
    const storedGrantDigests = database
      .prepare(`SELECT login_grant_sha256 FROM authority_person_login_grants`)
      .pluck()
      .all();
    expect(storedGrantDigests).toContain(grantSha256);
    expect(storedGrantDigests).not.toContain(rawGrant);
    database.close();

    const rawDatabaseBytes = readFileSync(path);
    for (const rawSecret of [
      rawGrant,
      rawState,
      rawNonce,
      rawVerifier,
      rawAccess1,
      rawRefresh1,
      rawAccess2,
      rawRefresh2,
      'mismatched tuple grant',
      'expiry-boundary-grant',
      'expiry-boundary-state',
      'expiry-boundary-nonce',
      'expiry-boundary-verifier',
      'second live access',
      'second live refresh',
    ]) {
      expect(rawDatabaseBytes.includes(Buffer.from(rawSecret, 'utf8'))).toBe(
        false,
      );
    }
  });

  it('burns a verified denied bootstrap after membership revocation and cascades that revocation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'echo-person-denial-'));
    directories.push(directory);
    const path = join(directory, 'authority.sqlite');
    const authority = descriptor();
    const repository = new SqliteOrganizationAuthorityRepository(path);
    repository.initialize({
      descriptor: authority,
      authority_pin_sha256: organizationAuthorityPinSha256(authority),
      organization_display_name: 'Denial Company',
      initialized_at: '2026-08-18T01:00:00.000Z',
    });
    const membership: StoredAuthorityMembership = {
      organization_id: authority.organization_id,
      principal_id: federationId('prn'),
      membership_id: federationId('mem'),
      display_name: 'Employee',
      membership_type: 'employee',
      status: 'active',
      provisioned_at: '2026-08-18T01:00:00.000Z',
      revoked_at: null,
      revocation_reason: null,
      admin_command_id: `adm_${randomUUID()}`,
      admin_command_sha256: digest('denial membership command'),
    };
    repository.write('2026-08-18T01:00:00.000Z', (transaction) => {
      transaction.insertMembership(membership);
    });

    const issuer = 'https://issuer.example/';
    const configurationSha256 = digest('denial OIDC configuration');
    const tenantSha256 = digest('denial tenant constraint');
    const firstGrantSha256 = digest('first bootstrap grant');
    const firstStateSha256 = digest('first bootstrap state');
    const firstAttemptId = `ola_${randomUUID()}`;
    const firstAttemptClaimId = `olc_${randomUUID()}`;
    const bindingId = `oib_${randomUUID()}`;
    const familyId = `psf_${randomUUID()}`;
    repository.write('2026-08-18T01:00:01.000Z', (transaction) => {
      transaction.insertPersonLoginGrant({
        login_grant_sha256: firstGrantSha256,
        grant_purpose: 'oidc_identity_bootstrap',
        organization_id: membership.organization_id,
        principal_id: membership.principal_id,
        membership_id: membership.membership_id,
        membership_type: membership.membership_type,
        expected_issuer: issuer,
        oidc_configuration_sha256: configurationSha256,
        expires_at: '2026-08-18T01:15:01.000Z',
      });
    });
    repository.write('2026-08-18T01:00:10.000Z', (transaction) => {
      transaction.insertOidcLoginAttempt({
        login_attempt_id: firstAttemptId,
        issuer,
        attempt_purpose: 'identity_bootstrap',
        client_id: 'echo-browser-client',
        redirect_uri: 'https://authority.example/auth/oidc/callback',
        tenant_constraint_sha256: tenantSha256,
        oidc_configuration_sha256: configurationSha256,
        login_grant_sha256: firstGrantSha256,
        state_sha256: firstStateSha256,
        nonce_sha256: digest('first bootstrap nonce'),
        sealed_pkce_verifier: {
          key_id: 'test-seal-key-v1',
          sealed_bytes: createHash('sha512')
            .update('first sealed verifier', 'utf8')
            .digest(),
        },
        expires_at: '2026-08-18T01:10:10.000Z',
      });
    });
    repository.write('2026-08-18T01:00:20.000Z', (transaction) => {
      expect(
        transaction.claimOidcLoginAttempt(
          firstStateSha256,
          firstAttemptClaimId,
        ),
      ).toBeDefined();
    });
    repository.write('2026-08-18T01:01:00.000Z', (transaction) => {
      expect(transaction.consumePersonLoginGrant(firstGrantSha256)).toBeDefined();
      expect(
        transaction.completeOidcLoginAttempt(
          firstStateSha256,
          firstAttemptClaimId,
          {
            outcome: 'succeeded',
            resolved_identity_binding_id: bindingId,
            upstream_assertion_issued_at: '2026-08-18T01:00:10.000Z',
          },
        ),
      ).toBeDefined();
      transaction.insertOidcIdentityBinding({
        identity_binding_id: bindingId,
        issuer,
        subject: 'membership-cascade-subject',
        tenant_constraint_sha256: tenantSha256,
        oidc_configuration_sha256: configurationSha256,
        initial_login_attempt_id: firstAttemptId,
        initial_login_grant_sha256: firstGrantSha256,
        organization_id: membership.organization_id,
        principal_id: membership.principal_id,
        membership_id: membership.membership_id,
        membership_type: membership.membership_type,
      });
      transaction.insertPersonSessionFamily({
        session_family_id: familyId,
        identity_binding_id: bindingId,
        authentication_login_attempt_id: firstAttemptId,
        organization_id: membership.organization_id,
        principal_id: membership.principal_id,
        membership_id: membership.membership_id,
        membership_type: membership.membership_type,
        upstream_assertion_issued_at: '2026-08-18T01:00:10.000Z',
        tenant_constraint_sha256: tenantSha256,
        oidc_configuration_sha256: configurationSha256,
        hard_reauthentication_at: '2026-08-25T01:00:10.000Z',
      });
      transaction.insertPersonSessionCredential({
        session_credential_id: `psc_${randomUUID()}`,
        session_family_id: familyId,
        credential_kind: 'access',
        rotation_sequence: 1,
        token_sha256: digest('membership cascade access'),
        expires_at: '2026-08-18T13:01:00.000Z',
      });
      transaction.insertPersonSessionCredential({
        session_credential_id: `psc_${randomUUID()}`,
        session_family_id: familyId,
        credential_kind: 'refresh',
        rotation_sequence: 1,
        token_sha256: digest('membership cascade refresh'),
        expires_at: '2026-08-25T01:00:10.000Z',
      });
    });

    const deniedGrantSha256 = digest('verified denied grant');
    const deniedStateSha256 = digest('verified denied state');
    const deniedClaimId = `olc_${randomUUID()}`;
    const directlyDeniedGrantSha256 = digest('directly denied grant');
    const directlyDeniedStateSha256 = digest('directly denied state');
    const directlyDeniedClaimId = `olc_${randomUUID()}`;
    repository.write('2026-08-18T01:01:10.000Z', (transaction) => {
      transaction.insertPersonLoginGrant({
        login_grant_sha256: deniedGrantSha256,
        grant_purpose: 'oidc_identity_bootstrap',
        organization_id: membership.organization_id,
        principal_id: membership.principal_id,
        membership_id: membership.membership_id,
        membership_type: membership.membership_type,
        expected_issuer: issuer,
        oidc_configuration_sha256: configurationSha256,
        expires_at: '2026-08-18T01:16:10.000Z',
      });
    });
    repository.write('2026-08-18T01:01:20.000Z', (transaction) => {
      transaction.insertOidcLoginAttempt({
        login_attempt_id: `ola_${randomUUID()}`,
        issuer,
        attempt_purpose: 'identity_bootstrap',
        client_id: 'echo-browser-client',
        redirect_uri: 'https://authority.example/auth/oidc/callback',
        tenant_constraint_sha256: tenantSha256,
        oidc_configuration_sha256: configurationSha256,
        login_grant_sha256: deniedGrantSha256,
        state_sha256: deniedStateSha256,
        nonce_sha256: digest('verified denied nonce'),
        sealed_pkce_verifier: {
          key_id: 'test-seal-key-v1',
          sealed_bytes: createHash('sha512')
            .update('verified denied verifier', 'utf8')
            .digest(),
        },
        expires_at: '2026-08-18T01:11:20.000Z',
      });
    });
    repository.write('2026-08-18T01:01:25.000Z', (transaction) => {
      expect(
        transaction.consumePersonLoginGrant(deniedGrantSha256),
      ).toMatchObject({ consumed_at: '2026-08-18T01:01:25.000Z' });
    });
    repository.write('2026-08-18T01:01:30.000Z', (transaction) => {
      expect(
        transaction.claimOidcLoginAttempt(
          deniedStateSha256,
          deniedClaimId,
        ),
      ).toBeDefined();
    });
    repository.write('2026-08-18T01:01:31.000Z', (transaction) => {
      transaction.insertPersonLoginGrant({
        login_grant_sha256: directlyDeniedGrantSha256,
        grant_purpose: 'oidc_identity_bootstrap',
        organization_id: membership.organization_id,
        principal_id: membership.principal_id,
        membership_id: membership.membership_id,
        membership_type: membership.membership_type,
        expected_issuer: issuer,
        oidc_configuration_sha256: configurationSha256,
        expires_at: '2026-08-18T01:16:31.000Z',
      });
    });
    repository.write('2026-08-18T01:01:32.000Z', (transaction) => {
      transaction.insertOidcLoginAttempt({
        login_attempt_id: `ola_${randomUUID()}`,
        issuer,
        attempt_purpose: 'identity_bootstrap',
        client_id: 'echo-browser-client',
        redirect_uri: 'https://authority.example/auth/oidc/callback',
        tenant_constraint_sha256: tenantSha256,
        oidc_configuration_sha256: configurationSha256,
        login_grant_sha256: directlyDeniedGrantSha256,
        state_sha256: directlyDeniedStateSha256,
        nonce_sha256: digest('directly denied nonce'),
        sealed_pkce_verifier: {
          key_id: 'test-seal-key-v1',
          sealed_bytes: createHash('sha512')
            .update('directly denied verifier', 'utf8')
            .digest(),
        },
        expires_at: '2026-08-18T01:11:32.000Z',
      });
    });
    rawDatabase(path, (database) =>
      database
        .prepare(
          `UPDATE authority_person_login_grants
              SET consumed_at = ?
            WHERE login_grant_sha256 = ?`,
        )
        .run(
          '2026-08-18T01:01:32.500Z',
          directlyDeniedGrantSha256,
        ),
    );
    repository.write('2026-08-18T01:01:33.000Z', (transaction) => {
      expect(
        transaction.claimOidcLoginAttempt(
          directlyDeniedStateSha256,
          directlyDeniedClaimId,
        ),
      ).toBeDefined();
    });
    expect(() =>
      rawDatabase(path, (database) =>
        database
          .prepare(
            `UPDATE authority_oidc_login_attempts
                SET terminal_outcome = 'succeeded', completed_at = ?,
                    resolved_identity_binding_id = ?, upstream_assertion_issued_at = ?,
                    redemption_claim_id = NULL, redemption_claimed_at = NULL,
                    pkce_verifier_seal_key_id = NULL,
                    pkce_verifier_sealed = NULL
              WHERE state_sha256 = ?`,
          )
          .run(
            '2026-08-18T01:01:34.000Z',
            bindingId,
            '2026-08-18T01:01:34.000Z',
            directlyDeniedStateSha256,
          ),
      ),
    ).toThrow('terminal bootstrap attempt requires exact login grant disposition');

    repository.write('2026-08-18T01:02:00.000Z', (transaction) => {
      expect(
        transaction.revokeMembership(
          membership.membership_id,
          '2026-08-18T01:02:00.000Z',
          'employment ended',
        ),
      ).toBe(true);
    });
    const cascade = repository.read((transaction) => ({
      family: transaction.personSessionFamily(familyId),
      credentials: transaction.personSessionCredentialsForFamily(familyId),
    }));
    expect(cascade.family).toMatchObject({
      status: 'revoked',
      revoked_at: '2026-08-18T01:02:00.000Z',
      revocation_reason: 'employment ended',
    });
    expect(cascade.credentials).toHaveLength(2);
    expect(
      cascade.credentials.every(
        (credential) =>
          credential.revoked_at === '2026-08-18T01:02:00.000Z' &&
          credential.revocation_reason === 'employment ended',
      ),
    ).toBe(true);

    repository.write('2026-08-18T01:03:00.000Z', (transaction) => {
      expect(
        transaction.completeOidcLoginAttempt(
          deniedStateSha256,
          deniedClaimId,
          { outcome: 'denied' },
        ),
      ).toMatchObject({
        terminal_outcome: 'denied',
        completed_at: '2026-08-18T01:03:00.000Z',
        resolved_identity_binding_id: null,
        upstream_assertion_issued_at: null,
        pkce_verifier_seal_key_id: null,
        pkce_verifier_sealed: null,
      });
    });
    expect(
      repository.read((transaction) => ({
        grant: transaction.personLoginGrant(deniedGrantSha256),
        attempt: transaction.oidcLoginAttempt(deniedStateSha256),
      })),
    ).toMatchObject({
      grant: { consumed_at: '2026-08-18T01:01:25.000Z' },
      attempt: {
        terminal_outcome: 'denied',
        completed_at: '2026-08-18T01:03:00.000Z',
      },
    });
    repository.close();

    rawDatabase(path, (database) =>
      database
        .prepare(
          `UPDATE authority_oidc_login_attempts
              SET terminal_outcome = 'denied', completed_at = ?,
                  redemption_claim_id = NULL, redemption_claimed_at = NULL,
                  pkce_verifier_seal_key_id = NULL,
                  pkce_verifier_sealed = NULL
            WHERE state_sha256 = ?`,
        )
        .run('2026-08-18T01:03:01.000Z', directlyDeniedStateSha256),
    );
    expect(
      rawDatabase(path, (database) =>
        database
          .prepare(
            `SELECT consumed_at FROM authority_person_login_grants
              WHERE login_grant_sha256 = ?`,
          )
          .get(directlyDeniedGrantSha256),
      ),
    ).toEqual({ consumed_at: '2026-08-18T01:01:32.500Z' });
    expect(
      rawDatabase(path, (database) =>
        database
          .prepare(
            `SELECT terminal_outcome, completed_at, redemption_claim_id,
                    redemption_claimed_at, pkce_verifier_seal_key_id,
                    pkce_verifier_sealed
               FROM authority_oidc_login_attempts
              WHERE state_sha256 = ?`,
          )
          .get(directlyDeniedStateSha256),
      ),
    ).toMatchObject({
      terminal_outcome: 'denied',
      completed_at: '2026-08-18T01:03:01.000Z',
      redemption_claim_id: null,
      redemption_claimed_at: null,
      pkce_verifier_seal_key_id: null,
      pkce_verifier_sealed: null,
    });

    expect(() =>
      rawDatabase(path, (database) =>
        database
          .prepare(
            `UPDATE authority_oidc_login_attempts
                SET terminal_outcome = 'expired',
                    completed_at = '2026-08-18T01:11:20.000Z'
              WHERE state_sha256 = ?`,
          )
          .run(deniedStateSha256),
      ),
    ).toThrow('OIDC login attempt mutation is denied');
    expect(() =>
      rawDatabase(path, (database) =>
        database
          .prepare(
            `DELETE FROM authority_oidc_login_attempts
              WHERE state_sha256 = ?`,
          )
          .run(deniedStateSha256),
      ),
    ).toThrow('OIDC login attempt deletion is denied');
  });
});
