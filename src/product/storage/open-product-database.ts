import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  loadMigrations,
  migrate,
} from '../../infrastructure/sqlite/migrate.js';

const PRODUCT_MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  'migrations',
);

export type ProductDatabaseDurability = 'operational' | 'evidence';

export interface OpenProductDatabaseOptions {
  durability: ProductDatabaseDurability;
}

export function currentProductDatabaseSchemaVersion(): number {
  return loadMigrations(PRODUCT_MIGRATIONS_DIR).at(-1)?.version ?? 0;
}

/**
 * Open existing product state for query-only inspection. This never creates a
 * database, changes its journal/durability policy, or runs migrations. SQLite
 * may still use its ordinary WAL coordination companions while a live writer
 * exists; callers must describe the guarantee as no product-state writes.
 */
export function openReadOnlyProductDatabase(
  databasePath: string,
): Database.Database | null {
  if (databasePath === ':memory:') {
    throw new Error('read-only product database inspection requires a file');
  }
  if (!existsSync(databasePath)) return null;
  const parent = lstatSync(dirname(databasePath));
  if (
    parent.isSymbolicLink() ||
    !parent.isDirectory() ||
    parent.uid !== process.getuid?.() ||
    (parent.mode & 0o777) !== 0o700
  ) {
    throw new Error(
      'product database parent must be a private directory owned by the current user',
    );
  }
  for (const path of [
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`,
  ]) {
    if (!existsSync(path)) continue;
    const state = lstatSync(path);
    if (
      state.isSymbolicLink() ||
      !state.isFile() ||
      state.uid !== process.getuid?.() ||
      (state.mode & 0o777) !== 0o600
    ) {
      throw new Error(
        'product database and its companions must be private regular files owned by the current user',
      );
    }
  }
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
    timeout: 5_000,
  });
  try {
    database.pragma('query_only = ON');
    database.pragma('trusted_schema = OFF');
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
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
