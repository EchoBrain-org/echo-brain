import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { migrate } from '../../infrastructure/sqlite/migrate.js';

const PRODUCT_MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  'migrations',
);

export type ProductDatabaseDurability = 'operational' | 'evidence';

export interface OpenProductDatabaseOptions {
  durability: ProductDatabaseDurability;
}

/**
 * Open the installation-scoped product database with one security, SQLite,
 * and schema policy. Domain stores still own their statements and invariants.
 */
export function openProductDatabase(
  databasePath: string,
  options: OpenProductDatabaseOptions,
): Database.Database {
  if (databasePath !== ':memory:') {
    mkdirSync(dirname(databasePath), { recursive: true });
    if (existsSync(databasePath)) {
      const state = lstatSync(databasePath);
      if (state.isSymbolicLink() || !state.isFile()) {
        throw new Error('product database must be a regular file');
      }
    }
  }

  const database = new Database(databasePath);
  try {
    if (databasePath !== ':memory:') chmodSync(databasePath, 0o600);
    database.pragma('journal_mode = WAL');
    database.pragma(
      `synchronous = ${options.durability === 'evidence' ? 'FULL' : 'NORMAL'}`,
    );
    database.pragma('foreign_keys = ON');
    database.pragma('busy_timeout = 5000');
    migrate(database, PRODUCT_MIGRATIONS_DIR);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
