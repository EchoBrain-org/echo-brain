import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openProductDatabase } from '../../src/product/storage/open-product-database.js';

const PRODUCT_MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL('../../src/product/storage/migrations/', import.meta.url),
);
const PRODUCT_TABLES = [
  'core_approvals',
  'core_decision_sets',
  'core_delivery_receipts',
  'core_meeting_documents',
  'core_processed_markers',
  'core_source_cursors',
  'federated_chain_heads',
  'federated_outbox_events',
  'federated_processor_attributions',
  'federated_source_attributions',
  'organization_access_high_watermarks',
  'organization_authority_connections',
  'organization_authority_pins',
  'organization_enrollments',
];
const temporaryDirectories: string[] = [];

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), 'echo-product-migration-'));
  temporaryDirectories.push(directory);
  return join(directory, 'state.sqlite');
}

function tableNames(database: Database.Database): string[] {
  return (
    database
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>
  ).map(({ name }) => name);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('machine product database migrations', () => {
  it('installs schema v7 with the complete product-state inventory', () => {
    const path = temporaryDatabase();
    openProductDatabase(path, { durability: 'operational' }).close();

    const database = new Database(path, { readonly: true });
    expect(database.pragma('user_version', { simple: true })).toBe(7);
    expect(tableNames(database)).toEqual(PRODUCT_TABLES);
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE name LIKE 'idx_events_%'",
        )
        .all(),
    ).toEqual([]);
    database.close();
  });

  it('upgrades v3, removes retired event data, and preserves owned state', () => {
    const path = temporaryDatabase();
    const legacy = new Database(path);
    for (const filename of [
      '0001_initial.sql',
      '0002_core_state.sql',
      '0003_federated_founder_identity.sql',
    ]) {
      legacy.exec(
        readFileSync(join(PRODUCT_MIGRATIONS_DIRECTORY, filename), 'utf8'),
      );
    }
    legacy.pragma('user_version = 3');
    legacy
      .prepare(
        `INSERT INTO events (id, source, timestamp, content)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        'legacy-event-1',
        'test:legacy',
        '2026-07-16T17:05:00.000Z',
        'retired capture data',
      );
    legacy
      .prepare(
        `INSERT INTO core_source_cursors (
           source_adapter_id, source_instance_id, source_version, cursor
         ) VALUES (?, ?, ?, ?)`,
      )
      .run('source-alpha', 'primary', '1.0.0', 'cursor-v3');
    legacy
      .prepare(
        `INSERT INTO federated_chain_heads (
           installation_id, last_sequence, last_event_hash, updated_at
         ) VALUES (?, ?, ?, ?)`,
      )
      .run('installation-v3', 0, null, '2026-07-16T17:06:00.000Z');
    legacy.close();

    openProductDatabase(path, { durability: 'operational' }).close();

    const database = new Database(path, { readonly: true });
    expect(database.pragma('user_version', { simple: true })).toBe(7);
    expect(tableNames(database)).toEqual(PRODUCT_TABLES);
    expect(
      database
        .prepare(
          `SELECT cursor FROM core_source_cursors
           WHERE source_adapter_id = ? AND source_instance_id = ? AND source_version = ?`,
        )
        .get('source-alpha', 'primary', '1.0.0'),
    ).toEqual({ cursor: 'cursor-v3' });
    expect(
      database
        .prepare(
          `SELECT last_sequence FROM federated_chain_heads
           WHERE installation_id = ?`,
        )
        .get('installation-v3'),
    ).toEqual({ last_sequence: 0 });
    database.close();
  });
});
