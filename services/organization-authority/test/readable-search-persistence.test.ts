import { Buffer } from 'node:buffer';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  federationId,
  p256KeyId,
  sha256Digest,
} from '@echo-brain/federation-protocol';
import type { JsonValue, Sha256Digest } from '@echo-brain/federation-protocol';
import { organizationAuthorityPinSha256 } from '@echo-brain/organization-protocol';
import type { OrganizationAuthorityDescriptorV1 } from '@echo-brain/organization-protocol';
import { SqliteOrganizationAuthorityRepository } from '../src/adapters/persistence/sqlite/sqlite-authority-repository.js';
import {
  ReadableSearchPersistenceIntegrityError,
  createReadableSearchGenerationPublishedAudit,
  readableSearchQueryAuditRetainUntil,
  validateReadableSearchGenerationPublishedAuditDetail,
} from '../src/application/readable-search-persistence.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function digest(character: string): Sha256Digest {
  return `sha256:${character.repeat(64)}`;
}

function descriptor(): OrganizationAuthorityDescriptorV1 {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' });
  if (!Buffer.isBuffer(publicKey)) throw new Error('test key export failed');
  return {
    schema_version: 1,
    kind: 'echo-organization-authority',
    authority_id: federationId('oau'),
    organization_id: federationId('org'),
    signing_key: {
      key_id: p256KeyId(publicKey),
      algorithm: 'ecdsa-p256-sha256-der-low-s',
      public_key_spki_der_base64: publicKey.toString('base64'),
    },
  };
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'echo-readable-search-'));
  directories.push(directory);
  const authority = descriptor();
  const repository = new SqliteOrganizationAuthorityRepository(
    join(directory, 'authority.sqlite'),
  );
  repository.initialize({
    descriptor: authority,
    authority_pin_sha256: organizationAuthorityPinSha256(authority),
    organization_display_name: 'Example Company',
    initialized_at: '2026-08-12T00:00:00.000Z',
  });
  return { authority, repository };
}

function allowDetail(evaluatedAt: string): JsonValue {
  return {
    schema_version: 1,
    kind: 'readable-search-query-decision-audit-detail-v1',
    request_id: 'osq_00000000-0000-4000-8000-000000000001',
    request_sha256: digest('1'),
    requester: {
      principal_id: 'prn_00000000-0000-4000-8000-000000000001',
      membership_id: 'mem_00000000-0000-4000-8000-000000000001',
      membership_type: 'employee',
      enrollment_id: 'enr_00000000-0000-4000-8000-000000000001',
      installation_id: 'ins_00000000-0000-4000-8000-000000000001',
    },
    decision: 'allow',
    reason_code: 'active_member_with_scoped_policy_paths',
    evaluation_complete: true,
    retrieval_contract_sha256: digest('2'),
    policy_contracts: [
      {
        policy_id: 'organization-member-readable-v1',
        policy_contract_sha256: digest('3'),
      },
      {
        policy_id: 'restricted-reviewer-v1',
        policy_contract_sha256: digest('4'),
      },
    ],
    person_state_sha256: digest('5'),
    scope_binding_sha256: digest('6'),
    generation: { generation_id: digest('7'), manifest_sha256: digest('8') },
    record_head: { position: 4, record_hash: digest('9') },
    returned_atom_ids: [digest('a')],
    returned_record_hashes: [digest('b')],
    returned_policy_ids: ['organization-member-readable-v1'],
    evaluated_at: evaluatedAt,
    response_sha256: sha256Digest(Buffer.from('{"schema_version":1,"contract_id":"permission-aware-readable-search-v1","items":[]}', 'utf8')),
  };
}

function denyDetail(evaluatedAt: string): JsonValue {
  const allowed = allowDetail(evaluatedAt) as Record<string, unknown>;
  const {
    scope_binding_sha256: _scope,
    generation: _generation,
    record_head: _head,
    returned_atom_ids: _ids,
    returned_record_hashes: _hashes,
    returned_policy_ids: _policies,
    ...denied
  } = allowed;
  return {
    ...denied,
    decision: 'deny',
    reason_code: 'installation_access_expired',
    response_sha256: sha256Digest(
      Buffer.from('{"error":{"code":"unauthorized","message":"authorization failed"}}', 'utf8'),
    ),
  };
}

describe('readable-search Authority persistence', () => {
  it('publishes one closed active-generation pointer at transaction time', () => {
    const { authority, repository } = fixture();
    expect(repository.read((transaction) => transaction.activeReadableSearchGeneration())).toBeNull();
    const published = repository.write('2026-08-12T00:01:00.000Z', (transaction) =>
      transaction.publishReadableSearchActiveGeneration({
        organization_id: authority.organization_id,
        generation_id: digest('1'),
        manifest_sha256: digest('2'),
        retrieval_contract_sha256: digest('3'),
        record_head_position: 0,
        record_head_hash: null,
      }),
    );
    expect(published.published_at).toBe('2026-08-12T00:01:00.000Z');
    expect(
      repository.read((transaction) => transaction.activeReadableSearchGeneration()),
    ).toEqual(published);
    const replaced = repository.write('2026-08-12T00:02:00.000Z', (transaction) =>
      transaction.publishReadableSearchActiveGeneration({
        organization_id: authority.organization_id,
        generation_id: digest('4'),
        manifest_sha256: digest('5'),
        retrieval_contract_sha256: digest('6'),
        record_head_position: 1,
        record_head_hash: digest('7'),
      }),
    );
    expect(replaced.generation_id).toBe(digest('4'));
    expect(replaced.published_at).toBe('2026-08-12T00:02:00.000Z');
    repository.close();
  });

  it('binds a closed publication audit to the pointer transaction and rolls both back together', () => {
    const { authority, repository } = fixture();
    const publication = {
      organization_id: authority.organization_id,
      generation_id: digest('1'),
      manifest_sha256: digest('2'),
      retrieval_contract_sha256: digest('3'),
      record_head_position: 0,
      record_head_hash: null,
    } as const;
    const publishedAt = '2026-08-12T00:01:00.000Z';
    const audit = createReadableSearchGenerationPublishedAudit({
      publication,
      prior_generation: null,
      published_at: publishedAt,
    });
    expect(audit).toMatchObject({
      occurred_at: publishedAt,
      actor_kind: 'admin',
      action: 'permission.readable_search_generation_published',
      subject_id: authority.organization_id,
    });
    expect(validateReadableSearchGenerationPublishedAuditDetail(audit.detail)).toEqual(
      audit.detail,
    );
    expect(() =>
      validateReadableSearchGenerationPublishedAuditDetail({
        ...audit.detail as Record<string, unknown>,
        unexpected: true,
      }),
    ).toThrow(ReadableSearchPersistenceIntegrityError);

    expect(() =>
      repository.write(publishedAt, (transaction) => {
        transaction.publishReadableSearchActiveGeneration(publication);
        transaction.appendAudit(audit);
        throw new Error('force transaction rollback');
      }),
    ).toThrow('force transaction rollback');
    expect(repository.read((transaction) => transaction.activeReadableSearchGeneration())).toBeNull();
    expect(repository.read((transaction) => transaction.recentAuditBefore(undefined, 10))).toEqual([]);

    const stored = repository.write(publishedAt, (transaction) => {
      const pointer = transaction.publishReadableSearchActiveGeneration(publication);
      transaction.appendAudit(audit);
      return pointer;
    });
    const storedAudit = repository.read(
      (transaction) => transaction.recentAuditBefore(undefined, 1)[0],
    );
    expect(storedAudit).toMatchObject({
      occurred_at: stored.published_at,
      action: audit.action,
      subject_id: authority.organization_id,
    });
    expect(
      validateReadableSearchGenerationPublishedAuditDetail(storedAudit?.detail),
    ).toMatchObject({
      publication,
      prior_generation: null,
      published_at: stored.published_at,
    });
    repository.close();
  });

  it('rejects malformed or cross-organization active-generation publications', () => {
    const { authority, repository } = fixture();
    expect(() =>
      repository.write('2026-08-12T00:01:00.000Z', (transaction) =>
        transaction.publishReadableSearchActiveGeneration({
          organization_id: authority.organization_id,
          generation_id: digest('1'),
          manifest_sha256: digest('2'),
          retrieval_contract_sha256: digest('3'),
          record_head_position: 1,
          record_head_hash: null,
        }),
      ),
    ).toThrow(ReadableSearchPersistenceIntegrityError);
    expect(() =>
      repository.write('2026-08-12T00:01:00.000Z', (transaction) =>
        transaction.publishReadableSearchActiveGeneration({
          organization_id: 'org_00000000-0000-4000-8000-000000000001',
          generation_id: digest('1'),
          manifest_sha256: digest('2'),
          retrieval_contract_sha256: digest('3'),
          record_head_position: 0,
          record_head_hash: null,
        }),
      ),
    ).toThrow(/another organization/);
    repository.close();
  });

  it('writes only validated exact-byte query decisions with transaction-owned retention', () => {
    const { repository } = fixture();
    const body = Buffer.from(
      '{"schema_version":1,"contract_id":"permission-aware-readable-search-v1","items":[]}',
      'utf8',
    );
    const occurredAt = '2026-08-12T00:01:00.000Z';
    const stored = repository.write(occurredAt, (transaction) =>
      transaction.appendReadableSearchQueryAudit({
        decision: 'allow',
        reason_code: 'active_member_with_scoped_policy_paths',
        detail: allowDetail(occurredAt),
        response_bytes: body,
      }),
    );
    expect(stored.occurred_at).toBe(occurredAt);
    expect(stored.retain_until).toBe(readableSearchQueryAuditRetainUntil(occurredAt));
    expect(stored.detail).toEqual(allowDetail(occurredAt));
    const deniedAt = '2026-08-12T00:02:00.000Z';
    const denied = repository.write(deniedAt, (transaction) =>
      transaction.appendReadableSearchQueryAudit({
        decision: 'deny',
        reason_code: 'installation_access_expired',
        detail: denyDetail(deniedAt),
        response_bytes: Buffer.from('{"error":{"code":"unauthorized","message":"authorization failed"}}'),
      }),
    );
    expect(denied.decision).toBe('deny');
    repository.close();
  });

  it('rejects audit details that drift from prepared bytes, time, or closed shape', () => {
    const { repository } = fixture();
    const occurredAt = '2026-08-12T00:01:00.000Z';
    const body = Buffer.from('{"schema_version":1,"contract_id":"permission-aware-readable-search-v1","items":[]}');
    expect(() =>
      repository.write(occurredAt, (transaction) =>
        transaction.appendReadableSearchQueryAudit({
          decision: 'allow',
          reason_code: 'active_member_with_scoped_policy_paths',
          detail: {
            ...(allowDetail(occurredAt) as Record<string, unknown>),
            evaluated_at: '2026-08-12T00:00:00.000Z',
          },
          response_bytes: body,
        }),
      ),
    ).toThrow(ReadableSearchPersistenceIntegrityError);
    expect(() =>
      repository.write(occurredAt, (transaction) =>
        transaction.appendReadableSearchQueryAudit({
          decision: 'allow',
          reason_code: 'active_member_with_scoped_policy_paths',
          detail: {
            ...(allowDetail(occurredAt) as Record<string, unknown>),
            unexpected: true,
          },
          response_bytes: body,
        }),
      ),
    ).toThrow(ReadableSearchPersistenceIntegrityError);
    repository.close();
  });
});
