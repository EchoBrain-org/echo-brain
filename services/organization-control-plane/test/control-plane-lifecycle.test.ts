import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  initializeOrganizationControlDatabase,
  inspectOpenOrganizationControlDatabase,
  inspectOrganizationControlDatabaseForServe,
  inspectOrganizationControlDatabaseReadOnly,
  openAndMigrateOrganizationControlDatabase,
  openOrganizationControlDatabaseReadOnly,
} from '../src/index.js';

const temporaryDirectories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'echo-integrations-state-'));
  temporaryDirectories.push(directory);
  return join(directory, 'integrations.sqlite');
}

function digest(label: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(label).digest('hex')}`;
}

const IDENTITY = {
  organization_id: 'org_00000000-0000-4000-8000-000000000001',
  authority_id: 'oau_00000000-0000-4000-8000-000000000001',
  authority_descriptor_sha256: digest('authority descriptor'),
  created_at: '2026-07-29T20:00:00.000Z',
} as const;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('organization integrations database lifecycle', () => {
  it('initializes one pinned private database and inspects it read-only', () => {
    const path = databasePath();
    const initialized = initializeOrganizationControlDatabase(path, IDENTITY);
    expect(initialized).toMatchObject(IDENTITY);
    expect(initialized.control_plane_id).toMatch(
      /^ocp_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(statSync(path).mode & 0o777).toBe(0o600);

    const before = statSync(path);
    expect(inspectOrganizationControlDatabaseReadOnly(path)).toEqual(
      initialized,
    );
    expect(inspectOrganizationControlDatabaseForServe(path)).toEqual(
      initialized,
    );
    const after = statSync(path);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(
      readdirSync(dirname(path)).filter((name) =>
        name.startsWith('integrations.sqlite-'),
      ),
    ).toEqual([]);

    const opened = openAndMigrateOrganizationControlDatabase(path, {
      fileMustExist: true,
    });
    expect(inspectOpenOrganizationControlDatabase(opened)).toEqual(initialized);
    opened.close();

    const readOnly = openOrganizationControlDatabaseReadOnly(path);
    try {
      expect(inspectOpenOrganizationControlDatabase(readOnly)).toEqual(initialized);
      expect(() =>
        readOnly.exec('DELETE FROM organization_control_plane_metadata'),
      ).toThrow(/readonly|read-only/);
    } finally {
      readOnly.close();
    }
  });

  it('never claims or replaces an existing path', () => {
    const path = databasePath();
    const initialized = initializeOrganizationControlDatabase(path, IDENTITY);
    expect(() =>
      initializeOrganizationControlDatabase(path, {
        ...IDENTITY,
        organization_id: 'org_00000000-0000-4000-8000-000000000002',
      }),
    ).toThrow('already exists');
    expect(inspectOrganizationControlDatabaseReadOnly(path)).toEqual(
      initialized,
    );
  });

  it('does not leave a claimed path when initialization is invalid', () => {
    const path = databasePath();
    expect(() =>
      initializeOrganizationControlDatabase(path, {
        ...IDENTITY,
        organization_id: 'invalid',
      }),
    ).toThrow();
    expect(existsSync(path)).toBe(false);
  });

  it('rejects missing, uninitialized, and non-private state', () => {
    const path = databasePath();
    expect(() => inspectOrganizationControlDatabaseReadOnly(path)).toThrow();
    expect(existsSync(path)).toBe(false);

    const database = openAndMigrateOrganizationControlDatabase(path);
    database.close();
    expect(() => inspectOrganizationControlDatabaseReadOnly(path)).toThrow(
      'identity is missing or invalid',
    );
  });
});
