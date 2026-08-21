import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  unlinkSync,
} from 'node:fs';
import { dirname } from 'node:path';
import {
  inspectOrganizationControlDatabaseReadOnly,
  type OrganizationControlDatabaseIdentity,
} from './inspect-database.js';
import { openAndMigrateOrganizationControlDatabase } from './open-database.js';

export interface InitializeOrganizationControlDatabaseInput {
  readonly organization_id: string;
  readonly authority_id: string;
  readonly authority_descriptor_sha256: `sha256:${string}`;
  readonly created_at: string;
}

export function initializeOrganizationControlDatabase(
  databasePath: string,
  input: InitializeOrganizationControlDatabaseInput,
): OrganizationControlDatabaseIdentity {
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  let descriptor: number;
  try {
    descriptor = openSync(databasePath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('organization control database already exists');
    }
    throw error;
  }
  const created = fstatSync(descriptor);
  closeSync(descriptor);

  try {
    const database = openAndMigrateOrganizationControlDatabase(databasePath, {
      fileMustExist: true,
    });
    try {
      database
        .prepare(
          `INSERT INTO organization_control_plane_metadata (
             singleton, control_plane_id, organization_id, authority_id,
             authority_descriptor_sha256, created_at
           ) VALUES (1, ?, ?, ?, ?, ?)`,
        )
        .run(
          `ocp_${randomUUID()}`,
          input.organization_id,
          input.authority_id,
          input.authority_descriptor_sha256,
          input.created_at,
        );
    } finally {
      database.close();
    }
    return inspectOrganizationControlDatabaseReadOnly(databasePath);
  } catch (error) {
    try {
      const current = lstatSync(databasePath);
      if (
        !current.isSymbolicLink() &&
        current.isFile() &&
        current.dev === created.dev &&
        current.ino === created.ino
      ) {
        unlinkSync(databasePath);
      }
    } catch {}
    throw error;
  }
}
