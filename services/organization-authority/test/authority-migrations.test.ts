import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openAuthorityDatabase } from '../src/adapters/persistence/sqlite/open-database.js';
import { SqliteOrganizationAuthorityRepository } from '../src/adapters/persistence/sqlite/sqlite-authority-repository.js';

const AUTHORITY_TABLES = [
  'authority_access_lease_requests',
  'authority_access_states',
  'authority_audit_log',
  'authority_enrollment_grants',
  'authority_enrollments',
  'authority_internal_live_releases',
  'authority_internal_live_update_receipts',
  'authority_memberships',
  'authority_metadata',
  'authority_oidc_identity_bindings',
  'authority_oidc_login_attempts',
  'authority_organization_member_recording_activation',
  'authority_person_login_grants',
  'authority_person_read_decision_audit',
  'authority_person_session_credentials',
  'authority_person_session_families',
  'authority_principals',
  'authority_query_decision_audit',
  'authority_readable_search_active_generation',
  'authority_readable_search_query_audit',
];
const temporaryDirectories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'echo-authority-migration-'));
  temporaryDirectories.push(directory);
  return join(directory, 'authority.sqlite');
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('organization authority database migrations', () => {
  it('installs the complete current schema on a fresh database', () => {
    const path = databasePath();
    openAuthorityDatabase(path).close();

    const database = new Database(path, { readonly: true });
    expect(database.pragma('user_version', { simple: true })).toBe(10);
    const tables = database
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    expect(tables.map(({ name }) => name)).toEqual(AUTHORITY_TABLES);
    expect(
      tables
        .map(({ name }) => name)
        .filter(
          (name) =>
            name.startsWith('authority_person_') ||
            name.startsWith('authority_oidc_'),
        ),
    ).toEqual([
      'authority_oidc_identity_bindings',
      'authority_oidc_login_attempts',
      'authority_person_login_grants',
      'authority_person_read_decision_audit',
      'authority_person_session_credentials',
      'authority_person_session_families',
    ]);
    const attemptColumns = database.pragma(
      'table_xinfo(authority_oidc_login_attempts)',
    ) as Array<{ name: string }>;
    expect(attemptColumns.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'terminal_outcome',
        'completed_at',
        'redemption_claim_id',
        'redemption_claimed_at',
        'resolved_identity_binding_id',
        'upstream_auth_time',
        'bootstrap_initial_login_attempt_id',
      ]),
    );
    expect(attemptColumns.map(({ name }) => name)).not.toContain('consumed_at');
    for (const table of [
      'authority_memberships',
      'authority_enrollment_grants',
    ]) {
      const columns = database.pragma(`table_info(${table})`) as Array<{
        name: string;
      }>;
      expect(columns.map(({ name }) => name)).toEqual(
        expect.arrayContaining(['admin_command_id', 'admin_command_sha256']),
      );
    }
    database.close();
  });

  it('upgrades populated legacy data without changing legacy rows or inventing command metadata', () => {
    const path = databasePath();
    const legacy = new Database(path);
    legacy.exec(
      readFileSync(
        new URL('../migrations/0001_single_org_authority.sql', import.meta.url),
        'utf8',
      ),
    );
    legacy.exec(`
      INSERT INTO authority_metadata (
        singleton, authority_id, organization_id, organization_display_name,
        authority_pin_sha256, descriptor_json, created_at, last_observed_at
      ) VALUES (
        1,
        'oau_00000000-0000-4000-8000-000000000001',
        'org_00000000-0000-4000-8000-000000000001',
        'Migration Company',
        'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '{}',
        '2026-07-22T00:00:00.000Z',
        '2026-07-22T00:00:00.000Z'
      );
      INSERT INTO authority_principals (
        principal_id, organization_id, display_name, provisioned_at
      ) VALUES (
        'prn_00000000-0000-4000-8000-000000000001',
        'org_00000000-0000-4000-8000-000000000001',
        'Legacy Employee',
        '2026-07-22T00:00:00.000Z'
      );
      INSERT INTO authority_memberships (
        membership_id, organization_id, principal_id, membership_type,
        status, provisioned_at, revoked_at, revocation_reason
      ) VALUES (
        'mem_00000000-0000-4000-8000-000000000001',
        'org_00000000-0000-4000-8000-000000000001',
        'prn_00000000-0000-4000-8000-000000000001',
        'employee',
        'active',
        '2026-07-22T00:00:00.000Z',
        NULL,
        NULL
      );
      INSERT INTO authority_enrollment_grants (
        grant_sha256, authority_id, organization_id, principal_id,
        membership_id, issued_at, expires_at, consumed_at, request_sha256
      ) VALUES (
        'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        'oau_00000000-0000-4000-8000-000000000001',
        'org_00000000-0000-4000-8000-000000000001',
        'prn_00000000-0000-4000-8000-000000000001',
        'mem_00000000-0000-4000-8000-000000000001',
        '2026-07-22T00:00:00.000Z',
        '2026-07-22T01:00:00.000Z',
        NULL,
        NULL
      );
    `);
    legacy.pragma('user_version = 1');
    legacy.close();

    openAuthorityDatabase(path).close();
    const upgraded = new Database(path);
    expect(upgraded.pragma('user_version', { simple: true })).toBe(10);
    const tables = upgraded
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    expect(tables.map(({ name }) => name)).toEqual(AUTHORITY_TABLES);
    expect(
      upgraded
        .prepare(
          `SELECT admin_command_id, admin_command_sha256
           FROM authority_memberships`,
        )
        .get(),
    ).toEqual({ admin_command_id: null, admin_command_sha256: null });
    expect(
      upgraded
        .prepare(
          `SELECT integrations_control_plane_id,
                  integrations_marker_sha256,
                  integrations_installed_at
           FROM authority_metadata WHERE singleton = 1`,
        )
        .get(),
    ).toEqual({
      integrations_control_plane_id: null,
      integrations_marker_sha256: null,
      integrations_installed_at: null,
    });
    // A legacy upgrade must leave the record store unanchored. That absence is
    // the only evidence maintenance has that this directory predates the record
    // databases and may therefore create them.
    expect(
      upgraded
        .prepare(
          `SELECT record_marker_sha256, record_installed_at
           FROM authority_metadata WHERE singleton = 1`,
        )
        .get(),
    ).toEqual({ record_marker_sha256: null, record_installed_at: null });
    expect(
      upgraded
        .prepare(
          `SELECT admin_command_id, admin_command_sha256
           FROM authority_enrollment_grants`,
        )
        .get(),
    ).toEqual({ admin_command_id: null, admin_command_sha256: null });
    expect(() =>
      upgraded
        .prepare(
          `INSERT INTO authority_memberships (
             membership_id, organization_id, principal_id, membership_type,
             status, provisioned_at, revoked_at, revocation_reason,
             admin_command_id, admin_command_sha256
           ) VALUES (?, ?, ?, 'employee', 'active', ?, NULL, NULL, NULL, NULL)`,
        )
        .run(
          'mem_00000000-0000-4000-8000-000000000002',
          'org_00000000-0000-4000-8000-000000000001',
          'prn_00000000-0000-4000-8000-000000000001',
          '2026-07-22T00:01:00.000Z',
        ),
    ).toThrow('membership admin command metadata is invalid');
    expect(() =>
      upgraded
        .prepare(
          `INSERT INTO authority_memberships (
             membership_id, organization_id, principal_id, membership_type,
             status, provisioned_at, revoked_at, revocation_reason,
             admin_command_id, admin_command_sha256
           ) VALUES (?, ?, ?, 'employee', 'active', ?, NULL, NULL, ?, ?)`,
        )
        .run(
          'mem_00000000-0000-4000-8000-000000000004',
          'org_00000000-0000-4000-8000-000000000001',
          'prn_00000000-0000-4000-8000-000000000001',
          '2026-07-22T00:01:00.000Z',
          'adm_-0000000-0000-4000-8000-000000000004',
          `sha256:${'d'.repeat(64)}`,
        ),
    ).toThrow('membership admin command metadata is invalid');
    expect(() =>
      upgraded
        .prepare(
          `INSERT INTO authority_memberships (
             membership_id, organization_id, principal_id, membership_type,
             status, provisioned_at, revoked_at, revocation_reason,
             admin_command_id, admin_command_sha256
           ) VALUES (?, ?, ?, 'employee', 'active', ?, NULL, NULL, ?, ?)`,
        )
        .run(
          'mem_00000000-0000-4000-8000-000000000003',
          'org_00000000-0000-4000-8000-000000000001',
          'prn_00000000-0000-4000-8000-000000000001',
          '2026-07-22T00:01:00.000Z',
          'adm_00000000-0000-4000-8000-000000000003',
          `sha256:${'g'.repeat(64)}`,
        ),
    ).toThrow('membership admin command metadata is invalid');
    expect(() =>
      upgraded
        .prepare(
          `INSERT INTO authority_enrollment_grants (
             grant_sha256, authority_id, organization_id, principal_id,
             membership_id, issued_at, expires_at, consumed_at, request_sha256,
             admin_command_id, admin_command_sha256
           ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)`,
        )
        .run(
          `sha256:${'c'.repeat(64)}`,
          'oau_00000000-0000-4000-8000-000000000001',
          'org_00000000-0000-4000-8000-000000000001',
          'prn_00000000-0000-4000-8000-000000000001',
          'mem_00000000-0000-4000-8000-000000000001',
          '2026-07-22T00:01:00.000Z',
          '2026-07-22T01:01:00.000Z',
        ),
    ).toThrow('enrollment grant admin command metadata is invalid');
    upgraded
      .prepare(
        `UPDATE authority_metadata
         SET integrations_control_plane_id = ?,
             integrations_marker_sha256 = ?,
             integrations_installed_at = ?
         WHERE singleton = 1`,
      )
      .run(
        'ocp_00000000-0000-4000-8000-000000000001',
        `sha256:${'e'.repeat(64)}`,
        '2026-07-22T00:02:00.000Z',
      );
    expect(() =>
      upgraded
        .prepare(
          `UPDATE authority_metadata
           SET integrations_control_plane_id = ?
           WHERE singleton = 1`,
        )
        .run('ocp_00000000-0000-4000-8000-000000000002'),
    ).toThrow('installation anchor is immutable');
    upgraded.close();
  });

  it('is idempotent at the current schema version', () => {
    const path = databasePath();
    openAuthorityDatabase(path).close();
    expect(() => openAuthorityDatabase(path).close()).not.toThrow();
  });

  it('keeps readable-search publication state strict and query decisions isolated', () => {
    const path = databasePath();
    openAuthorityDatabase(path).close();
    const database = new Database(path);
    const digest = `sha256:${'a'.repeat(64)}`;

    database
      .prepare(
        `INSERT INTO authority_readable_search_active_generation (
           singleton, organization_id, generation_id, manifest_sha256,
           retrieval_contract_sha256, record_head_position, record_head_hash,
           published_at
         ) VALUES (1, ?, ?, ?, ?, 0, NULL, ?)`,
      )
      .run(
        'org_00000000-0000-4000-8000-000000000001',
        digest,
        digest,
        digest,
        '2026-07-22T00:00:00.000Z',
      );
    expect(() =>
      database
        .prepare(
          `INSERT INTO authority_readable_search_active_generation (
             singleton, organization_id, generation_id, manifest_sha256,
             retrieval_contract_sha256, record_head_position, record_head_hash,
             published_at
           ) VALUES (2, ?, ?, ?, ?, 0, NULL, ?)`,
        )
        .run(
          'org_00000000-0000-4000-8000-000000000001',
          digest,
          digest,
          digest,
          '2026-07-22T00:00:00.000Z',
        ),
    ).toThrow();
    expect(() =>
      database
        .prepare(
          `UPDATE authority_readable_search_active_generation
             SET record_head_hash = ? WHERE singleton = 1`,
        )
        .run(digest),
    ).toThrow();

    database
      .prepare(
        `INSERT INTO authority_readable_search_query_audit (
           occurred_at, retain_until, operation, decision, reason_code,
           detail_json
         ) VALUES (?, ?, 'permission.readable_search_decided', 'deny',
           'installation_access_expired', '{}')`,
      )
      .run('2026-07-22T00:00:00.000Z', '2027-01-18T00:00:00.000Z');
    expect(() =>
      database
        .prepare(
          `INSERT INTO authority_readable_search_query_audit (
             occurred_at, retain_until, operation, decision, reason_code,
             detail_json
           ) VALUES (?, ?, 'permission.readable_search_decided', 'allow',
             'installation_access_expired', '{}')`,
        )
        .run('2026-07-22T00:00:00.000Z', '2027-01-18T00:00:00.000Z'),
    ).toThrow();
    expect(() =>
      database
        .prepare(
          'UPDATE authority_readable_search_query_audit SET decision = \'allow\'',
        )
        .run(),
    ).toThrow('readable search query audit is immutable');
    expect(() =>
      database
        .prepare('DELETE FROM authority_readable_search_query_audit')
        .run(),
    ).toThrow('readable search query audit entry deletion is denied');
    database.close();
  });

  it('does not create a missing database when an existing file is required', () => {
    const path = databasePath();

    expect(
      () =>
        new SqliteOrganizationAuthorityRepository(path, {
          fileMustExist: true,
        }),
    ).toThrow();
    expect(existsSync(path)).toBe(false);
  });

  it('rejects a database newer than this authority binary', () => {
    const path = databasePath();
    const future = new Database(path);
    future.pragma('user_version = 11');
    future.close();

    expect(() => openAuthorityDatabase(path)).toThrow(
      'newer than supported schema 10',
    );
  });
});
