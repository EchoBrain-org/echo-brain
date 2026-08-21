import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { assertAuthorityProcessingOwnerEmailBinding } from '../src/adapters/persistence/sqlite/processing-source-identity.js';
import { personLoginGrantExpectedEmailSha256 } from '../src/domain/person-email-binding.js';

const directories: string[] = [];
const BINDING = {
  organization_id: 'org_00000000-0000-4000-8000-000000000001',
  principal_id: 'prn_00000000-0000-4000-8000-000000000001',
  membership_id: 'mem_00000000-0000-4000-8000-000000000001',
  membership_type: 'employee' as const,
};
const OWNER_EMAIL = 'founder@example.com';
const BOUND_AT = '2026-08-19T20:00:00.000Z';

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function identityDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), 'echo-processing-identity-'));
  directories.push(directory);
  const path = join(directory, 'authority.sqlite');
  const database = new Database(path);
  database.exec(`
    CREATE TABLE authority_memberships (
      membership_id TEXT,
      organization_id TEXT,
      principal_id TEXT,
      membership_type TEXT,
      status TEXT
    );
    CREATE TABLE authority_person_login_grants (
      login_grant_sha256 TEXT,
      organization_id TEXT,
      principal_id TEXT,
      membership_id TEXT,
      membership_type TEXT,
      expected_email_sha256 TEXT,
      consumed_at TEXT
    );
    CREATE TABLE authority_oidc_identity_bindings (
      initial_login_grant_sha256 TEXT,
      organization_id TEXT,
      principal_id TEXT,
      membership_id TEXT,
      membership_type TEXT,
      status TEXT,
      bound_at TEXT
    );
  `);
  database
    .prepare(
      `INSERT INTO authority_memberships VALUES (?, ?, ?, ?, 'active')`,
    )
    .run(
      BINDING.membership_id,
      BINDING.organization_id,
      BINDING.principal_id,
      BINDING.membership_type,
    );
  const grantSha256 = `sha256:${'a'.repeat(64)}`;
  database
    .prepare(
      `INSERT INTO authority_person_login_grants
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      grantSha256,
      BINDING.organization_id,
      BINDING.principal_id,
      BINDING.membership_id,
      BINDING.membership_type,
      personLoginGrantExpectedEmailSha256(OWNER_EMAIL),
      BOUND_AT,
    );
  database
    .prepare(
      `INSERT INTO authority_oidc_identity_bindings
       VALUES (?, ?, ?, ?, ?, 'active', ?)`,
    )
    .run(
      grantSha256,
      BINDING.organization_id,
      BINDING.principal_id,
      BINDING.membership_id,
      BINDING.membership_type,
      BOUND_AT,
    );
  database.close();
  return path;
}

describe('Authority processing source identity', () => {
  it('accepts only the exact active identity bootstrap email', () => {
    const path = identityDatabase();
    expect(
      assertAuthorityProcessingOwnerEmailBinding(
        path,
        BINDING,
        OWNER_EMAIL,
      ),
    ).toBe(personLoginGrantExpectedEmailSha256(OWNER_EMAIL));

    expect(() =>
      assertAuthorityProcessingOwnerEmailBinding(
        path,
        BINDING,
        'different@example.com',
      ),
    ).toThrow('does not match an active approved Person identity');
  });
});
