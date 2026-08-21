import { Buffer } from 'node:buffer';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalSha256,
  federationId,
  p256KeyId,
  sha256Digest,
} from '@echo-brain/federation-protocol';
import { organizationAuthorityPinSha256 } from '@echo-brain/organization-protocol';
import type { OrganizationAuthorityDescriptorV1 } from '@echo-brain/organization-protocol';
import { SqliteOrganizationAuthorityRepository } from '../src/adapters/persistence/sqlite/sqlite-authority-repository.js';
import type { PersonReadAuthenticatedEvidence } from '../src/application/ports/authority-repository.js';

const directories: string[] = [];

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

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'echo-person-read-audit-'));
  directories.push(directory);
  const path = join(directory, 'authority.sqlite');
  const authority = descriptor();
  const repository = new SqliteOrganizationAuthorityRepository(path);
  repository.initialize({
    descriptor: authority,
    authority_pin_sha256: organizationAuthorityPinSha256(authority),
    organization_display_name: 'Person Read Company',
    initialized_at: '2026-08-18T00:00:00.000Z',
  });
  const principalId = federationId('prn');
  const authenticated: PersonReadAuthenticatedEvidence = {
    organization_id: authority.organization_id,
    principal_id: principalId,
    membership_id: federationId('mem'),
    membership_type: 'employee',
    identity_binding_id: `oib_${randomUUID()}`,
    session_family_id: `psf_${randomUUID()}`,
    access_credential_sha256: canonicalSha256({ access: 1 }),
    caller_binding_sha256: canonicalSha256({
      schema_version: 2,
      kind: 'person-read-caller-binding',
    }),
    person_state_sha256: canonicalSha256({ person: 1 }),
    session_state_sha256: canonicalSha256({ session: 1 }),
  };
  return { path, authority, repository, principalId, authenticated };
}

describe('Person read decision audit persistence', () => {
  it('appends all operations with exact retention, response digest, and nullable or exact caller evidence', () => {
    const context = setup();
    const fixedUnauthorized = Buffer.from('{"error":"unauthorized"}', 'utf8');
    const reviewerResponse = Buffer.from('{"decisions":[]}', 'utf8');
    const searchResponse = Buffer.from('{"results":[]}', 'utf8');
    const unauthenticated = context.repository.write(
      '2026-08-18T00:00:01.000Z',
      (transaction) =>
        transaction.appendPersonReadDecisionAudit({
          operation: 'recent_decisions',
          request_sha256: canonicalSha256({ operation: 'recent_decisions' }),
          response_bytes: fixedUnauthorized,
          asserted_subject_principal_id: context.principalId,
          decision: 'deny',
          reason_code: 'person_or_session_inactive',
          authenticated: null,
        }),
    );
    expect(unauthenticated).toMatchObject({
      audit_sequence: 1,
      occurred_at: '2026-08-18T00:00:01.000Z',
      retain_until: '2027-02-14T00:00:01.000Z',
      authority_id: context.authority.authority_id,
      organization_id: context.authority.organization_id,
      operation: 'recent_decisions',
      response_sha256: sha256Digest(fixedUnauthorized),
      decision: 'deny',
      reason_code: 'person_or_session_inactive',
      authenticated: null,
    });

    const allowed = context.repository.write(
      '2026-08-18T00:00:02.000Z',
      (transaction) =>
        transaction.appendPersonReadDecisionAudit({
          operation: 'reviewer_recent_decisions',
          request_sha256: canonicalSha256({
            operation: 'reviewer_recent_decisions',
          }),
          response_bytes: reviewerResponse,
          asserted_subject_principal_id: context.principalId,
          decision: 'allow',
          reason_code: 'active_person_session',
          authenticated: context.authenticated,
        }),
    );
    expect(allowed).toMatchObject({
      audit_sequence: 2,
      occurred_at: '2026-08-18T00:00:02.000Z',
      retain_until: '2027-02-14T00:00:02.000Z',
      operation: 'reviewer_recent_decisions',
      response_sha256: sha256Digest(reviewerResponse),
      decision: 'allow',
      reason_code: 'active_person_session',
      authenticated: context.authenticated,
    });

    const finalDenial = context.repository.write(
      '2026-08-18T00:00:03.000Z',
      (transaction) =>
        transaction.appendPersonReadDecisionAudit({
          operation: 'readable_search',
          request_sha256: canonicalSha256({ operation: 'readable_search' }),
          response_bytes: searchResponse,
          asserted_subject_principal_id: context.principalId,
          decision: 'deny',
          reason_code: 'authorization_state_changed',
          authenticated: context.authenticated,
        }),
    );
    expect(finalDenial).toMatchObject({
      audit_sequence: 3,
      operation: 'readable_search',
      response_sha256: sha256Digest(searchResponse),
      reason_code: 'authorization_state_changed',
      authenticated: context.authenticated,
    });

    const pilotDenial = context.repository.write(
      '2026-08-18T00:00:04.000Z',
      (transaction) =>
        transaction.appendPersonReadDecisionAudit({
          operation: 'recent_decisions',
          request_sha256: canonicalSha256({ operation: 'recent_decisions' }),
          response_bytes: fixedUnauthorized,
          asserted_subject_principal_id: context.principalId,
          decision: 'deny',
          reason_code: 'operation_not_permitted',
          authenticated: context.authenticated,
        }),
    );
    expect(pilotDenial).toMatchObject({
      audit_sequence: 4,
      reason_code: 'operation_not_permitted',
      authenticated: context.authenticated,
    });

    expect(() =>
      context.repository.write(
        '2026-08-18T00:00:05.000Z',
        (transaction) =>
          transaction.appendPersonReadDecisionAudit({
            operation: 'readable_search',
            request_sha256: canonicalSha256({ operation: 'readable_search' }),
            response_bytes: fixedUnauthorized,
            asserted_subject_principal_id: federationId('prn'),
            decision: 'allow',
            reason_code: 'active_person_session',
            authenticated: context.authenticated,
          }),
      ),
    ).toThrow('asserted subject relationship is invalid');
    context.repository.close();

    const database = new Database(context.path, { readonly: true });
    expect(
      database
        .prepare(
          `SELECT authenticated_principal_id, authenticated_membership_id,
                  authenticated_membership_type, identity_binding_id,
                  session_family_id, access_credential_sha256,
                  caller_binding_sha256, person_state_sha256,
                  session_state_sha256
             FROM authority_person_read_decision_audit
            WHERE audit_sequence = 1`,
        )
        .get(),
    ).toEqual({
      authenticated_principal_id: null,
      authenticated_membership_id: null,
      authenticated_membership_type: null,
      identity_binding_id: null,
      session_family_id: null,
      access_credential_sha256: null,
      caller_binding_sha256: null,
      person_state_sha256: null,
      session_state_sha256: null,
    });
    expect(
      database
        .prepare(
          `SELECT authenticated_principal_id, authenticated_membership_id,
                  authenticated_membership_type, identity_binding_id,
                  session_family_id, access_credential_sha256,
                  caller_binding_sha256, person_state_sha256,
                  session_state_sha256
             FROM authority_person_read_decision_audit
            WHERE audit_sequence = 2`,
        )
        .get(),
    ).toEqual({
      authenticated_principal_id: context.authenticated.principal_id,
      authenticated_membership_id: context.authenticated.membership_id,
      authenticated_membership_type: context.authenticated.membership_type,
      identity_binding_id: context.authenticated.identity_binding_id,
      session_family_id: context.authenticated.session_family_id,
      access_credential_sha256:
        context.authenticated.access_credential_sha256,
      caller_binding_sha256: context.authenticated.caller_binding_sha256,
      person_state_sha256: context.authenticated.person_state_sha256,
      session_state_sha256: context.authenticated.session_state_sha256,
    });
    database.close();
  });

  it('rejects malformed direct rows and every direct mutation or deletion', () => {
    const context = setup();
    context.repository.write('2026-08-18T00:00:01.000Z', (transaction) => {
      transaction.appendPersonReadDecisionAudit({
        operation: 'recent_decisions',
        request_sha256: canonicalSha256({ operation: 'recent_decisions' }),
        response_bytes: Buffer.from('denied', 'utf8'),
        asserted_subject_principal_id: context.principalId,
        decision: 'deny',
        reason_code: 'person_or_session_inactive',
        authenticated: null,
      });
    });
    context.repository.close();

    const database = new Database(context.path);
    database.pragma('foreign_keys = ON');
    const directInsert = database.prepare(
      `INSERT INTO authority_person_read_decision_audit (
         occurred_at, retain_until, authority_id, organization_id,
         operation, request_sha256, response_sha256,
         asserted_subject_principal_id, decision, reason_code,
         authenticated_principal_id, authenticated_membership_id,
         authenticated_membership_type, identity_binding_id,
         session_family_id, access_credential_sha256,
         caller_binding_sha256, person_state_sha256, session_state_sha256
       ) VALUES (?, ?, ?, ?, 'recent_decisions', ?, ?, ?, 'deny',
                 'person_or_session_inactive', ?, NULL, NULL, NULL, NULL,
                 NULL, NULL, NULL, NULL)`,
    );
    expect(() =>
      directInsert.run(
        '2026-08-18T00:01:00.000Z',
        '2027-02-14T00:01:00.000Z',
        context.authority.authority_id,
        context.authority.organization_id,
        canonicalSha256({ malformed: 'partial-authentication' }),
        canonicalSha256({ response: 'denied' }),
        context.principalId,
        context.authenticated.principal_id,
      ),
    ).toThrow();
    expect(() =>
      directInsert.run(
        '2026-08-18T00:01:00.000Z',
        '2027-02-14T00:01:00.001Z',
        context.authority.authority_id,
        context.authority.organization_id,
        'not-a-digest',
        canonicalSha256({ response: 'denied' }),
        context.principalId,
        null,
      ),
    ).toThrow();
    expect(() =>
      database
        .prepare(
          `UPDATE authority_person_read_decision_audit
              SET decision = 'allow' WHERE audit_sequence = 1`,
        )
        .run(),
    ).toThrow('Person read decision audit is immutable');
    expect(() =>
      database
        .prepare(
          `DELETE FROM authority_person_read_decision_audit
            WHERE audit_sequence = 1`,
        )
        .run(),
    ).toThrow('Person read decision audit entry deletion is denied');
    database.close();
  });
});
