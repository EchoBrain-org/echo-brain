import { Buffer } from 'node:buffer';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalJson,
  p256KeyId,
  type Sha256Digest,
} from '@echo-brain/federation-protocol';
import { organizationAuthorityPinSha256 } from '@echo-brain/organization-protocol';
import type { OrganizationAuthorityDescriptorV1 } from '@echo-brain/organization-protocol';
import { SqlitePersonMemberExclusionMutationPort } from '../src/adapters/persistence/sqlite/sqlite-person-member-exclusion-mutation-port.js';
import { SqliteOrganizationAuthorityRepository } from '../src/adapters/persistence/sqlite/sqlite-authority-repository.js';
import { OrganizationAuthorityAdminQueries } from '../src/application/admin-queries.js';
import {
  PersonMemberExclusionSourceDeniedError,
  type PersonMemberExclusionMutation,
} from '../src/application/person-member-exclusions.js';
import type { StoredAuthorityMembership } from '../src/application/ports/authority-repository.js';

const NOW = '2026-08-18T00:00:00.000Z';
const AUTHORITY_ID = 'oau_00000000-0000-4000-8000-000000000001';
const ORGANIZATION_ID = 'org_00000000-0000-4000-8000-000000000001';
const OWNER_PRINCIPAL_ID = 'prn_00000000-0000-4000-8000-000000000001';
const OWNER_MEMBERSHIP_ID = 'mem_00000000-0000-4000-8000-000000000001';
const OTHER_PRINCIPAL_ID = 'prn_00000000-0000-4000-8000-000000000002';
const OTHER_MEMBERSHIP_ID = 'mem_00000000-0000-4000-8000-000000000002';
const SOURCE_ADAPTER_ID = 'sentinel-sensitive-source';
const SOURCE_INSTANCE_ID = 'sentinel-private-instance';
const EXTERNAL_ID = 'sentinel-private-meeting';

const temporaryDirectories: string[] = [];
const repositories: SqliteOrganizationAuthorityRepository[] = [];

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function digest(seed: string): Sha256Digest {
  return `sha256:${seed.repeat(64)}` as Sha256Digest;
}

function descriptor(): OrganizationAuthorityDescriptorV1 {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicBytes = pair.publicKey.export({ format: 'der', type: 'spki' });
  if (!Buffer.isBuffer(publicBytes)) throw new Error('test key export failed');
  return {
    schema_version: 1,
    kind: 'echo-organization-authority',
    authority_id: AUTHORITY_ID,
    organization_id: ORGANIZATION_ID,
    signing_key: {
      key_id: p256KeyId(publicBytes),
      algorithm: 'ecdsa-p256-sha256-der-low-s',
      public_key_spki_der_base64: publicBytes.toString('base64'),
    },
  };
}

function membership(input: {
  principal_id: string;
  membership_id: string;
  display_name: string;
  command_digest_seed: string;
}): StoredAuthorityMembership {
  return {
    organization_id: ORGANIZATION_ID,
    principal_id: input.principal_id,
    membership_id: input.membership_id,
    display_name: input.display_name,
    membership_type: 'employee',
    status: 'active',
    provisioned_at: NOW,
    revoked_at: null,
    revocation_reason: null,
    admin_command_id: `adm_${input.membership_id.slice(4)}`,
    admin_command_sha256: digest(input.command_digest_seed),
  };
}

function mutation(
  overrides: Partial<PersonMemberExclusionMutation> = {},
): PersonMemberExclusionMutation {
  return {
    organization_id: ORGANIZATION_ID,
    principal_id: OWNER_PRINCIPAL_ID,
    membership_id: OWNER_MEMBERSHIP_ID,
    membership_type: 'employee',
    selector: {
      scope: 'source',
      source_adapter_id: SOURCE_ADAPTER_ID,
      source_instance_id: SOURCE_INSTANCE_ID,
    },
    excluded: true,
    ...overrides,
  };
}

describe('SqlitePersonMemberExclusionMutationPort', () => {
  it('changes only an exact owned binding and leaves every admin projection content-blind', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'echo-member-exclusion-'));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, 'authority.sqlite');
    const authorityDescriptor = descriptor();
    const repository = new SqliteOrganizationAuthorityRepository(databasePath);
    repositories.push(repository);
    repository.initialize({
      descriptor: authorityDescriptor,
      authority_pin_sha256: organizationAuthorityPinSha256(authorityDescriptor),
      organization_display_name: 'Example Company',
      initialized_at: NOW,
    });
    const owner = membership({
      principal_id: OWNER_PRINCIPAL_ID,
      membership_id: OWNER_MEMBERSHIP_ID,
      display_name: 'Owning Member',
      command_digest_seed: '1',
    });
    const other = membership({
      principal_id: OTHER_PRINCIPAL_ID,
      membership_id: OTHER_MEMBERSHIP_ID,
      display_name: 'Other Member',
      command_digest_seed: '2',
    });
    repository.write(NOW, (transaction) => {
      transaction.insertMembership(owner);
      transaction.insertMembership(other);
    });

    const seed = new Database(databasePath);
    seed.pragma('foreign_keys = ON');
    seed
      .prepare(
        `INSERT INTO authority_processing_source_owner_bindings (
           source_adapter_id, source_instance_id, organization_id,
           principal_id, membership_id, membership_type, bound_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        SOURCE_ADAPTER_ID,
        SOURCE_INSTANCE_ID,
        ORGANIZATION_ID,
        OWNER_PRINCIPAL_ID,
        OWNER_MEMBERSHIP_ID,
        'employee',
        NOW,
      );
    seed.close();

    const port = new SqlitePersonMemberExclusionMutationPort(
      databasePath,
      () => NOW,
    );
    const source = mutation();
    const meeting = mutation({
      selector: {
        scope: 'meeting',
        source_adapter_id: SOURCE_ADAPTER_ID,
        source_instance_id: SOURCE_INSTANCE_ID,
        external_id: EXTERNAL_ID,
      },
    });

    await port.change(source);
    await port.change(source);
    await port.change(meeting);
    await port.change(meeting);

    const inspect = new Database(databasePath, { readonly: true });
    expect(
      inspect
        .prepare(
          `SELECT scope_kind, external_id
             FROM authority_processing_member_exclusions
            ORDER BY scope_kind, external_id`,
        )
        .all(),
    ).toEqual([
      { scope_kind: 'meeting', external_id: EXTERNAL_ID },
      { scope_kind: 'source', external_id: '' },
    ]);

    const admin = new OrganizationAuthorityAdminQueries(repository, {
      now: () => NOW,
    });
    const serializedAdminViews = canonicalJson({
      overview: admin.overview(),
      memberships: admin.memberships(),
      installations: admin.installations(),
      enrollment_grants: admin.enrollmentGrants(),
      audit: admin.audit(),
    } as never);
    expect(serializedAdminViews).not.toContain(SOURCE_ADAPTER_ID);
    expect(serializedAdminViews).not.toContain(SOURCE_INSTANCE_ID);
    expect(serializedAdminViews).not.toContain(EXTERNAL_ID);

    const failures: Error[] = [];
    for (const denied of [
      mutation({
        selector: {
          scope: 'source',
          source_adapter_id: SOURCE_ADAPTER_ID,
          source_instance_id: 'unknown-source-instance',
        },
      }),
      mutation({
        principal_id: OTHER_PRINCIPAL_ID,
        membership_id: OTHER_MEMBERSHIP_ID,
      }),
    ]) {
      try {
        await port.change(denied);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        failures.push(error);
      }
    }
    expect(failures).toHaveLength(2);
    expect(failures).toEqual([
      expect.any(PersonMemberExclusionSourceDeniedError),
      expect.any(PersonMemberExclusionSourceDeniedError),
    ]);
    expect(failures.map(({ name, message }) => ({ name, message }))).toEqual([
      {
        name: 'PersonMemberExclusionSourceDeniedError',
        message: 'member exclusion source is unavailable',
      },
      {
        name: 'PersonMemberExclusionSourceDeniedError',
        message: 'member exclusion source is unavailable',
      },
    ]);
    expect(
      inspect
        .prepare(
          `SELECT source_adapter_id, source_instance_id, principal_id,
                  membership_id
             FROM authority_processing_source_owner_bindings`,
        )
        .all(),
    ).toEqual([
      {
        source_adapter_id: SOURCE_ADAPTER_ID,
        source_instance_id: SOURCE_INSTANCE_ID,
        principal_id: OWNER_PRINCIPAL_ID,
        membership_id: OWNER_MEMBERSHIP_ID,
      },
    ]);

    await port.change(mutation({ excluded: false }));
    await port.change(mutation({ excluded: false }));
    await port.change(mutation({ ...meeting, excluded: false }));
    await port.change(mutation({ ...meeting, excluded: false }));
    expect(
      inspect
        .prepare(
          'SELECT COUNT(*) AS count FROM authority_processing_member_exclusions',
        )
        .get(),
    ).toEqual({ count: 0 });
    inspect.close();
  });
});
