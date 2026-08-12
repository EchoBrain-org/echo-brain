import { chmodSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Digest } from '@echo-brain/federation-protocol';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import {
  inspectOrganizationRecordDatabaseSchema,
  openOrganizationRecordDatabase,
  ORGANIZATION_RECORD_DERIVED_DATABASE,
  ORGANIZATION_RECORD_LOG_DATABASE,
} from '../src/maintenance.js';
import type { OrganizationRecordDatabaseDefinition } from '../src/persistence/database-definition.js';
import {
  currentOrganizationRecordSchemaVersion,
  migrateOrganizationRecordDatabaseWithMigrations,
  organizationRecordMigrations,
  type OrganizationRecordMigration,
} from '../src/persistence/migrate.js';
import { removeTemporaryDirectories, temporaryStateDirectory } from './support/fixtures.js';

afterAll(removeTemporaryDirectories);

/**
 * The executable scope contract. Every table belongs to one externally
 * observable v1 behavior; a future table must name and test a new behavior
 * instead of claiming speculative future use.
 */
const LOG_TABLES_BY_OBSERVABLE_BEHAVIOR = {
  'opens only the intended organization record log': [
    'organization_record_log_metadata',
    'organization_record_schema_migrations',
  ],
  'appends one verifiable record per human act and never rewrites it': [
    'organization_record_log',
  ],
  'materializes a signed receipt once, recoverably, after the append commits': [
    'organization_record_signed_receipt',
  ],
  'activates one immutable notice-bound two-member permission pilot': [
    'organization_record_permission_pilot_activation',
  ],
  'indexes only notice-qualified post-activation approvals for the pilot read': [
    'organization_record_permission_pilot_eligibility',
  ],
  'indexes each released item of a verified reviewer-v2 approval, text-free, for its exact approving reviewer':
    ['organization_record_reviewer_policy_fact'],
} as const;

const DERIVED_TABLES_BY_OBSERVABLE_BEHAVIOR = {
  'opens only the intended organization derived store': [
    'organization_derived_metadata',
    'organization_record_schema_migrations',
  ],
  'follows the log from one cursor that advances with its own rows': [
    'organization_derived_cursor',
  ],
  'answers which decisions came from which approved meeting snapshot': [
    'organization_derived_atom',
    'organization_derived_meeting_snapshot',
    'organization_derived_participant_observation',
  ],
  'records rejection acts without candidate content': ['organization_derived_rejection'],
  'answers what supports what and who was listed or attended': [
    'organization_derived_edge',
  ],
  'defers a reviewer-v2 approval to permission-aware retrieval without deriving its content':
    ['organization_derived_reviewer_policy_exclusion'],
} as const;

const LOG_TABLES = Object.values(LOG_TABLES_BY_OBSERVABLE_BEHAVIOR).flat().sort();
const DERIVED_TABLES = Object.values(DERIVED_TABLES_BY_OBSERVABLE_BEHAVIOR).flat().sort();

const LOG_MIGRATION_SHA256 = [
  sha256Digest(
    readFileSync(
      new URL('../migrations/log/0001_organization_record_log.sql', import.meta.url),
      'utf8',
    ),
  ),
  sha256Digest(
    readFileSync(
      new URL('../migrations/log/0002_permission_pilot.sql', import.meta.url),
      'utf8',
    ),
  ),
  sha256Digest(
    readFileSync(
      new URL('../migrations/log/0003_reviewer_policy_fact.sql', import.meta.url),
      'utf8',
    ),
  ),
] as const;

function open(
  definition: OrganizationRecordDatabaseDefinition,
  filename: string,
): Database.Database {
  return openOrganizationRecordDatabase(
    join(temporaryStateDirectory(), filename),
    definition,
  );
}

function tableNames(database: Database.Database): string[] {
  return (
    database
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
}

describe('organization record migrations', () => {
  it('applies contiguous migrations and stamps the application id', () => {
    for (const [definition, filename, expectedTables] of [
      [ORGANIZATION_RECORD_LOG_DATABASE, 'log.sqlite', LOG_TABLES],
      [ORGANIZATION_RECORD_DERIVED_DATABASE, 'derived.sqlite', DERIVED_TABLES],
    ] as const) {
      const database = open(definition, filename);
      try {
        const migrations = organizationRecordMigrations(definition);
        expect(migrations.map((migration) => migration.version)).toEqual(
          migrations.map((_, index) => index + 1),
        );
        expect(database.pragma('user_version', { simple: true })).toBe(
          currentOrganizationRecordSchemaVersion(definition),
        );
        expect(database.pragma('application_id', { simple: true })).toBe(
          definition.application_id,
        );
        expect(tableNames(database)).toEqual(expectedTables);
        expect(inspectOrganizationRecordDatabaseSchema(database, definition)).toBe(
          migrations.length,
        );
      } finally {
        database.close();
      }
    }
  });

  it('lists every migration as a boundary runtime asset', () => {
    // The repo-wide architecture check enumerates flat `migrations/` roots and
    // does not descend into this workspace's per-database series, so the
    // packaging guarantee is asserted here instead.
    const manifest = JSON.parse(
      readFileSync(new URL('../source-boundary.v1.json', import.meta.url), 'utf8'),
    ) as { runtime_assets: string[] };
    const declared = [...manifest.runtime_assets].sort();
    const present = ['derived', 'log']
      .flatMap((series) =>
        readdirSync(new URL(`../migrations/${series}/`, import.meta.url))
          .filter((file) => file.endsWith('.sql'))
          .map((file) => `services/organization-record/migrations/${series}/${file}`),
      )
      .sort();
    expect(declared).toEqual(present);
  });

  it('pins the log migration checksums', () => {
    expect(
      organizationRecordMigrations(ORGANIZATION_RECORD_LOG_DATABASE).map(
        (migration) => migration.sha256,
      ),
    ).toEqual([...LOG_MIGRATION_SHA256]);
  });

  it('keeps DELETE journaling and the shared pragma set', () => {
    const database = open(ORGANIZATION_RECORD_LOG_DATABASE, 'pragmas.sqlite');
    try {
      // A stopped database must be inspectable read-only without WAL/SHM
      // sidecars, and state-backup refuses WAL sidecars.
      expect(database.pragma('journal_mode', { simple: true })).toBe('delete');
      expect(database.pragma('trusted_schema', { simple: true })).toBe(0);
      expect(database.pragma('temp_store', { simple: true })).toBe(2);
      expect(database.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(database.pragma('synchronous', { simple: true })).toBe(2);
    } finally {
      database.close();
    }
  });

  it('refuses a database that belongs to the other record charter', () => {
    const path = join(temporaryStateDirectory(), 'log.sqlite');
    const log = openOrganizationRecordDatabase(path, ORGANIZATION_RECORD_LOG_DATABASE);
    log.close();
    expect(() =>
      openOrganizationRecordDatabase(path, ORGANIZATION_RECORD_DERIVED_DATABASE),
    ).toThrow(/not an organization record derived database/);
  });

  it('refuses a world-readable database file and then a non-empty uninitialized one', () => {
    const path = join(temporaryStateDirectory(), 'foreign.sqlite');
    const foreign = new Database(path);
    foreign.exec('CREATE TABLE someone_elses_table (id INTEGER PRIMARY KEY) STRICT');
    foreign.close();
    expect(() =>
      openOrganizationRecordDatabase(path, ORGANIZATION_RECORD_LOG_DATABASE),
    ).toThrow(/current-user 0600 regular file/);
    chmodSync(path, 0o600);
    expect(() =>
      openOrganizationRecordDatabase(path, ORGANIZATION_RECORD_LOG_DATABASE),
    ).toThrow(/refusing to claim a non-empty uninitialized/);
  });

  it('rejects a tampered migration ledger', () => {
    const path = join(temporaryStateDirectory(), 'tampered.sqlite');
    const database = openOrganizationRecordDatabase(
      path,
      ORGANIZATION_RECORD_LOG_DATABASE,
    );
    database.exec(
      `DROP TRIGGER organization_record_schema_migrations_immutable_update;
       UPDATE organization_record_schema_migrations SET migration_sha256 = 'sha256:0'`,
    );
    expect(() =>
      inspectOrganizationRecordDatabaseSchema(database, ORGANIZATION_RECORD_LOG_DATABASE),
    ).toThrow(/identity or checksum is invalid/);
    database.close();
  });

  it('rejects a schema newer than this build supports', () => {
    const path = join(temporaryStateDirectory(), 'newer.sqlite');
    const database = openOrganizationRecordDatabase(
      path,
      ORGANIZATION_RECORD_LOG_DATABASE,
    );
    database.pragma('user_version = 99');
    expect(() =>
      migrateOrganizationRecordDatabaseWithMigrations(
        database,
        ORGANIZATION_RECORD_LOG_DATABASE,
        organizationRecordMigrations(ORGANIZATION_RECORD_LOG_DATABASE),
      ),
    ).toThrow(/is newer than supported schema/);
    database.close();
  });

  it('applies a later migration onto an existing database', () => {
    const definition = ORGANIZATION_RECORD_LOG_DATABASE;
    const path = join(temporaryStateDirectory(), 'upgrade.sqlite');
    const database = openOrganizationRecordDatabase(path, definition);
    const applied = organizationRecordMigrations(definition);
    const nextSql = 'CREATE TABLE organization_record_future (id INTEGER PRIMARY KEY) STRICT;\n';
    const next: OrganizationRecordMigration = {
      version: applied.length + 1,
      filename: `000${applied.length + 1}_organization_record_future.sql`,
      sql: nextSql,
      sha256: sha256Digest(nextSql),
    };
    migrateOrganizationRecordDatabaseWithMigrations(database, definition, [
      ...applied,
      next,
    ]);
    expect(database.pragma('user_version', { simple: true })).toBe(next.version);
    expect(tableNames(database)).toContain('organization_record_future');
    database.close();
  });

  it('rejects non-contiguous migration series', () => {
    const definition = ORGANIZATION_RECORD_LOG_DATABASE;
    const path = join(temporaryStateDirectory(), 'gap.sqlite');
    const database = openOrganizationRecordDatabase(path, definition);
    const applied = organizationRecordMigrations(definition);
    expect(() =>
      migrateOrganizationRecordDatabaseWithMigrations(database, definition, [
        ...applied,
        {
          version: applied.length + 2,
          filename: '0009_organization_record_gap.sql',
          sql: 'CREATE TABLE organization_record_gap (id INTEGER PRIMARY KEY) STRICT;',
          sha256: sha256Digest('gap'),
        },
      ]),
    ).toThrow();
    database.close();
  });
});

describe('organization record log immutability triggers', () => {
  const seed = {
    position: 1,
    envelope_id: 'ore_1',
    event_type: 'approval',
    installation_id: 'ins_alpha',
    idempotency_key: 'k1',
    canonical_envelope: '{}',
    envelope_sha256: `sha256:${'1'.repeat(64)}`,
    receipt_payload: '{}',
    previous_record_hash: null,
    record_hash: `sha256:${'2'.repeat(64)}`,
    recorded_at: '2026-08-07T12:00:00.000Z',
  };

  function seeded(): Database.Database {
    const database = open(ORGANIZATION_RECORD_LOG_DATABASE, 'immutable.sqlite');
    database
      .prepare(
        `INSERT INTO organization_record_log (
           position, envelope_id, event_type, installation_id, idempotency_key,
           canonical_envelope, envelope_sha256, receipt_payload,
           previous_record_hash, record_hash, recorded_at
         ) VALUES (@position, @envelope_id, @event_type, @installation_id, @idempotency_key,
           @canonical_envelope, @envelope_sha256, @receipt_payload,
           @previous_record_hash, @record_hash, @recorded_at)`,
      )
      .run(seed);
    return database;
  }

  it('rejects update and delete through ordinary code paths', () => {
    const database = seeded();
    try {
      expect(() =>
        database.exec(`UPDATE organization_record_log SET recorded_at = 'later'`),
      ).toThrow(/append-only/);
      expect(() => database.exec(`DELETE FROM organization_record_log`)).toThrow(
        /cannot be deleted/,
      );
      expect(database.prepare(`SELECT COUNT(*) AS n FROM organization_record_log`).get()).toEqual(
        { n: 1 },
      );
    } finally {
      database.close();
    }
  });

  it('rejects a non-contiguous insertion', () => {
    const database = seeded();
    try {
      expect(() =>
        database
          .prepare(
            `INSERT INTO organization_record_log (
               position, envelope_id, event_type, installation_id, idempotency_key,
               canonical_envelope, envelope_sha256, receipt_payload,
               previous_record_hash, record_hash, recorded_at
             ) VALUES (@position, @envelope_id, @event_type, @installation_id, @idempotency_key,
               @canonical_envelope, @envelope_sha256, @receipt_payload,
               @previous_record_hash, @record_hash, @recorded_at)`,
          )
          // Position 3 with a null predecessor satisfies the chain-link
          // trigger, so only the contiguity trigger can reject it. SQLite
          // leaves the firing order of same-event triggers undefined.
          .run({
            ...seed,
            position: 3,
            envelope_id: 'ore_3',
            idempotency_key: 'k3',
            record_hash: `sha256:${'3'.repeat(64)}`,
            previous_record_hash: null,
          }),
      ).toThrow(/positions must be contiguous/);
    } finally {
      database.close();
    }
  });

  it('rejects an insertion that breaks the predecessor link', () => {
    const database = seeded();
    try {
      expect(() =>
        database
          .prepare(
            `INSERT INTO organization_record_log (
               position, envelope_id, event_type, installation_id, idempotency_key,
               canonical_envelope, envelope_sha256, receipt_payload,
               previous_record_hash, record_hash, recorded_at
             ) VALUES (@position, @envelope_id, @event_type, @installation_id, @idempotency_key,
               @canonical_envelope, @envelope_sha256, @receipt_payload,
               @previous_record_hash, @record_hash, @recorded_at)`,
          )
          .run({
            ...seed,
            position: 2,
            envelope_id: 'ore_2',
            idempotency_key: 'k2',
            record_hash: `sha256:${'4'.repeat(64)}`,
            previous_record_hash: null,
          }),
      ).toThrow(/predecessor hash must match/);
    } finally {
      database.close();
    }
  });

  it('keeps the signed receipt create-once', () => {
    const database = seeded();
    try {
      const insert = database.prepare(
        `INSERT INTO organization_record_signed_receipt (position, signed_receipt, materialized_at)
         VALUES (?, ?, ?)`,
      );
      insert.run(1, '{"a":1}', '2026-08-07T12:00:01.000Z');
      expect(() => insert.run(1, '{"a":2}', '2026-08-07T12:00:02.000Z')).toThrow(
        /UNIQUE constraint failed|PRIMARY KEY/,
      );
      expect(() =>
        database.exec(`UPDATE organization_record_signed_receipt SET signed_receipt = '{}'`),
      ).toThrow(/create-once/);
      expect(() =>
        database.exec(`DELETE FROM organization_record_signed_receipt`),
      ).toThrow(/cannot be deleted/);
    } finally {
      database.close();
    }
  });

  it('refuses a signed receipt for a position the log does not hold', () => {
    const database = seeded();
    try {
      expect(() =>
        database
          .prepare(
            `INSERT INTO organization_record_signed_receipt (position, signed_receipt, materialized_at)
             VALUES (?, ?, ?)`,
          )
          .run(9, '{}', '2026-08-07T12:00:01.000Z'),
      ).toThrow(/FOREIGN KEY/);
    } finally {
      database.close();
    }
  });
});
