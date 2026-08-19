import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { readAuthorityProcessingSourceRuntimeBinding } from '../../../../src/adapters/persistence/sqlite/processing-source-runtime-binding.js';
import { SqliteAuthorityProcessingStore } from '../../../../src/processing/storage/sqlite-authority-processing-store.js';

const directories: string[] = [];
const ORGANIZATION_ID = 'org_00000000-0000-4000-8000-000000000001';
const PRINCIPAL_ID = 'prn_00000000-0000-4000-8000-000000000001';
const MEMBERSHIP_ID = 'mem_00000000-0000-4000-8000-000000000001';
const OWNER_DIGEST = `sha256:${'c'.repeat(64)}` as const;
const CREDENTIAL_DIGEST = `sha256:${'d'.repeat(64)}` as const;

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function authorityDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), 'echo-processing-runtime-'));
  directories.push(directory);
  const path = join(directory, 'authority.sqlite');
  const migrated = new SqliteAuthorityProcessingStore(
    path,
    {
      organization_id: ORGANIZATION_ID,
      principal_id: PRINCIPAL_ID,
      membership_id: MEMBERSHIP_ID,
      membership_type: 'owner',
      source_adapter_id: 'granola',
      source_instance_id: 'primary',
    },
    { bindingMode: 'require-existing' },
  );
  migrated.close();
  const database = new Database(path);
  database.pragma('foreign_keys = ON');
  database.exec(`
    INSERT INTO authority_metadata (
      singleton, authority_id, organization_id, organization_display_name,
      authority_pin_sha256, descriptor_json, created_at, last_observed_at
    ) VALUES (
      1, 'oau_00000000-0000-4000-8000-000000000001',
      '${ORGANIZATION_ID}', 'Runtime Company',
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      '{}', '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z'
    );
    INSERT INTO authority_principals (
      principal_id, organization_id, display_name, provisioned_at
    ) VALUES (
      '${PRINCIPAL_ID}', '${ORGANIZATION_ID}', 'Founder',
      '2026-08-19T00:00:00.000Z'
    );
    INSERT INTO authority_memberships (
      membership_id, organization_id, principal_id, membership_type,
      status, provisioned_at, revoked_at, revocation_reason,
      admin_command_id, admin_command_sha256
    ) VALUES (
      '${MEMBERSHIP_ID}', '${ORGANIZATION_ID}', '${PRINCIPAL_ID}', 'owner',
      'active', '2026-08-19T00:00:00.000Z', NULL, NULL,
      'adm_00000000-0000-4000-8000-000000000001',
      'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    );
  `);
  database.close();
  return path;
}

describe('Authority processing source runtime binding', () => {
  it('returns only the one active configured Granola source', async () => {
    const path = authorityDatabase();
    expect(
      readAuthorityProcessingSourceRuntimeBinding(path, ORGANIZATION_ID),
    ).toBeNull();

    const store = new SqliteAuthorityProcessingStore(
      path,
      {
        organization_id: ORGANIZATION_ID,
        principal_id: PRINCIPAL_ID,
        membership_id: MEMBERSHIP_ID,
        membership_type: 'owner',
        source_adapter_id: 'granola',
        source_instance_id: 'primary',
      },
      {
        bindingMode: 'provision',
        fileMustExist: true,
        sourceConfiguration: {
          owner_email_sha256: OWNER_DIGEST,
          credential_scope: 'organization',
          credential_reference_sha256: CREDENTIAL_DIGEST,
        },
        now: () => '2026-08-19T00:01:00.000Z',
      },
    );
    await store.initialize();
    store.close();

    expect(
      readAuthorityProcessingSourceRuntimeBinding(path, ORGANIZATION_ID),
    ).toEqual({
      organization_id: ORGANIZATION_ID,
      principal_id: PRINCIPAL_ID,
      membership_id: MEMBERSHIP_ID,
      membership_type: 'owner',
      source_adapter_id: 'granola',
      source_instance_id: 'primary',
      owner_email_sha256: OWNER_DIGEST,
      credential_scope: 'organization',
      credential_reference_sha256: CREDENTIAL_DIGEST,
    });
  });
});
