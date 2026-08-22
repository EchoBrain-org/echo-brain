import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  openAndMigrateAuthorityDatabase,
  openAuthorityDatabase,
} from '../src/adapters/persistence/sqlite/open-database.js';
import { SqliteOrganizationAuthorityRepository } from '../src/adapters/persistence/sqlite/sqlite-authority-repository.js';

const AUTHORITY_TABLES = [
  'authority_access_lease_requests',
  'authority_access_states',
  'authority_audit_log',
  'authority_enrollment_grants',
  'authority_enrollments',
  'authority_internal_live_releases',
  'authority_internal_live_update_receipts',
  'authority_member_exclusion_read_audit',
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
  'authority_processing_approval_presentation_contracts',
  'authority_processing_approval_publications',
  'authority_processing_approval_resolution_metadata',
  'authority_processing_candidates',
  'authority_processing_delivery_receipts',
  'authority_processing_frozen_record_envelopes',
  'authority_processing_member_exclusions',
  'authority_processing_processed_markers',
  'authority_processing_resolutions',
  'authority_processing_slack_delivery_attempts',
  'authority_processing_slots',
  'authority_processing_source_configuration_bindings',
  'authority_processing_source_cursors',
  'authority_processing_source_owner_bindings',
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
    openAndMigrateAuthorityDatabase(path).close();

    const database = new Database(path, { readonly: true });
    expect(database.pragma('user_version', { simple: true })).toBe(19);
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
        'upstream_assertion_issued_at',
        'bootstrap_initial_login_attempt_id',
      ]),
    );
    expect(attemptColumns.map(({ name }) => name)).not.toContain('consumed_at');
    expect(attemptColumns.map(({ name }) => name)).not.toContain(
      'upstream_auth_time',
    );
    const loginGrantColumns = database.pragma(
      'table_xinfo(authority_person_login_grants)',
    ) as Array<{ name: string; notnull: number }>;
    expect(loginGrantColumns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'expected_email_sha256',
          notnull: 1,
        }),
      ]),
    );
    const processingColumns = Object.fromEntries(
      [
        'authority_processing_source_owner_bindings',
        'authority_processing_source_configuration_bindings',
        'authority_processing_source_cursors',
        'authority_processing_candidates',
        'authority_processing_slots',
        'authority_processing_resolutions',
        'authority_processing_approval_presentation_contracts',
        'authority_processing_approval_publications',
        'authority_processing_approval_resolution_metadata',
        'authority_processing_frozen_record_envelopes',
        'authority_processing_processed_markers',
        'authority_processing_delivery_receipts',
        'authority_processing_slack_delivery_attempts',
        'authority_processing_member_exclusions',
      ].map((table) => [
        table,
        (
          database.pragma(`table_info(${table})`) as Array<{ name: string }>
        ).map(({ name }) => name),
      ]),
    );
    expect(processingColumns).toEqual({
      authority_processing_source_owner_bindings: [
        'source_adapter_id',
        'source_instance_id',
        'organization_id',
        'principal_id',
        'membership_id',
        'membership_type',
        'bound_at',
      ],
      authority_processing_source_configuration_bindings: [
        'source_adapter_id',
        'source_instance_id',
        'owner_email_sha256',
        'credential_scope',
        'credential_reference_sha256',
        'bound_at',
      ],
      authority_processing_source_cursors: [
        'source_adapter_id',
        'source_instance_id',
        'source_version',
        'cursor',
        'updated_at',
      ],
      authority_processing_candidates: [
        'processing_key',
        'source_adapter_id',
        'source_instance_id',
        'source_version',
        'external_id',
        'meeting_revision',
        'meeting_id',
        'raw_document_sha256',
        'raw_document_json',
        'admitted_at',
      ],
      authority_processing_slots: [
        'processing_key',
        'slot_name',
        'document_sha256',
        'document_json',
        'request_order_at',
        'request_approval_id',
        'created_at',
      ],
      authority_processing_resolutions: [
        'processing_key',
        'terminal_status',
        'resolution_sha256',
        'resolution_json',
        'resolved_at',
        'retain_until',
      ],
      authority_processing_approval_presentation_contracts: [
        'processing_key',
        'approval_id',
        'contract_mode',
        'contract_sha256',
        'contract_json',
        'created_at',
      ],
      authority_processing_approval_publications: [
        'processing_key',
        'approval_id',
        'surface',
        'reference_sha256',
        'reference_json',
        'published_at',
      ],
      authority_processing_approval_resolution_metadata: [
        'processing_key',
        'approval_id',
        'surface',
        'metadata_sha256',
        'metadata_json',
        'created_at',
      ],
      authority_processing_frozen_record_envelopes: [
        'processing_key',
        'approval_id',
        'envelope_id',
        'event_type',
        'envelope_sha256',
        'envelope_json',
        'created_at',
      ],
      authority_processing_processed_markers: [
        'processing_key',
        'source_adapter_id',
        'source_instance_id',
        'processed_at',
      ],
      authority_processing_delivery_receipts: [
        'receipt_sequence',
        'envelope_id',
        'processing_key',
        'idempotency_key',
        'envelope_sha256',
        'receipt_sha256',
        'status',
        'recorded_at',
        'retryable',
      ],
      authority_processing_slack_delivery_attempts: [
        'idempotency_key',
        'status',
        'channel_id',
        'message_ts',
        'recorded_at',
        'message',
      ],
      authority_processing_member_exclusions: [
        'organization_id',
        'principal_id',
        'membership_id',
        'membership_type',
        'source_adapter_id',
        'source_instance_id',
        'scope_kind',
        'external_id',
        'created_at',
      ],
    });
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

    openAndMigrateAuthorityDatabase(path).close();
    const upgraded = new Database(path);
    expect(upgraded.pragma('user_version', { simple: true })).toBe(19);
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

  it('rejects partial Slack delivery attempt states at the migration boundary', () => {
    const path = databasePath();
    openAndMigrateAuthorityDatabase(path).close();
    const database = new Database(path);
    const insert = database.prepare(
      `INSERT INTO authority_processing_slack_delivery_attempts (
         idempotency_key, status, channel_id, message_ts, recorded_at, message
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const recordedAt = '2026-08-20T00:00:00.000Z';
    const overlongKey = `${'k'.repeat(8192)} `;
    const overlongValue = `${'v'.repeat(4096)} `;

    for (const values of [
      [null, 'unknown', null, null, recordedAt, 'unknown'],
      ['   ', 'unknown', null, null, recordedAt, 'unknown'],
      [overlongKey, 'unknown', null, null, recordedAt, 'unknown'],
      ['unknown-null-message', 'unknown', null, null, recordedAt, null],
      ['unknown-blank-message', 'unknown', null, null, recordedAt, '   '],
      ['unknown-long-message', 'unknown', null, null, recordedAt, overlongValue],
      ['unknown-provider-id', 'unknown', 'C123', null, recordedAt, 'unknown'],
      ['delivered-null-channel', 'delivered', null, '1700.100000', recordedAt, null],
      ['delivered-blank-channel', 'delivered', '   ', '1700.100000', recordedAt, null],
      ['delivered-long-channel', 'delivered', overlongValue, '1700.100000', recordedAt, null],
      ['delivered-null-ts', 'delivered', 'C123', null, recordedAt, null],
      ['delivered-blank-ts', 'delivered', 'C123', '   ', recordedAt, null],
      ['delivered-long-ts', 'delivered', 'C123', overlongValue, recordedAt, null],
      ['delivered-message', 'delivered', 'C123', '1700.100000', recordedAt, 'unexpected'],
    ] as const) {
      expect(() => insert.run(...values)).toThrow();
    }
    database.close();
  });

  it('is idempotent at the current schema version', () => {
    const path = databasePath();
    openAndMigrateAuthorityDatabase(path).close();
    expect(() => openAndMigrateAuthorityDatabase(path).close()).not.toThrow();
  });

  it('keeps readable-search publication state strict and query decisions isolated', () => {
    const path = databasePath();
    openAndMigrateAuthorityDatabase(path).close();
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
    future.pragma('user_version = 20');
    future.close();

    expect(() => openAndMigrateAuthorityDatabase(path)).toThrow(
      'newer than supported schema 19',
    );
  });
});

describe('organization authority opening is split from migration', () => {
  it('opens a fresh database without installing any schema', () => {
    const path = databasePath();
    const database = openAuthorityDatabase(path);
    try {
      expect(database.pragma('user_version', { simple: true })).toBe(0);
      expect(
        database
          .prepare(
            `SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'`,
          )
          .all(),
      ).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('never upgrades an older schema on open', () => {
    const path = databasePath();
    const legacy = new Database(path);
    legacy.exec('CREATE TABLE legacy_only (id INTEGER PRIMARY KEY) STRICT');
    legacy.pragma('user_version = 1');
    legacy.close();

    const database = openAuthorityDatabase(path, { fileMustExist: true });
    try {
      expect(database.pragma('user_version', { simple: true })).toBe(1);
      expect(
        database
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
          )
          .pluck()
          .all(),
      ).toEqual(['legacy_only']);
    } finally {
      database.close();
    }
  });

  it('opens a future schema without judging it; only migration rejects it', () => {
    const path = databasePath();
    const future = new Database(path);
    future.pragma('user_version = 99');
    future.close();

    const database = openAuthorityDatabase(path, { fileMustExist: true });
    try {
      expect(database.pragma('user_version', { simple: true })).toBe(99);
    } finally {
      database.close();
    }
    expect(() => openAndMigrateAuthorityDatabase(path)).toThrow(
      'newer than supported schema 19',
    );
  });
});
