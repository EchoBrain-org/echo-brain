import { Buffer } from 'node:buffer';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalJson,
  federationId,
  p256KeyId,
  sha256Digest,
} from '@echo-brain/federation-protocol';
import type { JsonValue, Sha256Digest } from '@echo-brain/federation-protocol';
import { organizationAuthorityPinSha256 } from '@echo-brain/organization-protocol';
import type { OrganizationAuthorityDescriptorV1 } from '@echo-brain/organization-protocol';
import { openAuthorityDatabase } from '../src/adapters/persistence/sqlite/open-database.js';
import { SqliteReviewerQueryAuditMaintenanceRepository } from '../src/adapters/persistence/sqlite/reviewer-query-audit-maintenance.js';
import { SqliteOrganizationAuthorityRepository } from '../src/adapters/persistence/sqlite/sqlite-authority-repository.js';
import {
  reviewerQueryAuditExportBytes,
  reviewerQueryAuditExportDocument,
  reviewerQueryAuditOutputPathSha256,
  reviewerQueryAuditRetainUntil,
} from '../src/application/reviewer-query-audit.js';
import type {
  ReviewerQueryAuditExportCommandV1,
  ReviewerQueryAuditExpiryCommandV1,
} from '../src/application/reviewer-query-audit.js';
import {
  REVIEWER_QUERY_AUDIT_EXPIRED_ACTION,
  REVIEWER_QUERY_AUDIT_EXPORT_ACTION,
  REVIEWER_QUERY_AUDIT_OPERATION,
} from '../src/application/ports/authority-repository.js';
import type {
  StoredAuthorityMembership,
  StoredReviewerQueryAuditEntry,
} from '../src/application/ports/authority-repository.js';
import {
  reviewerAllowAuditDetail,
  reviewerDenialAuditDetail,
} from '../src/application/reviewer-recent-decisions.js';

const temporaryDirectories: string[] = [];
const openedMaintenance: SqliteReviewerQueryAuditMaintenanceRepository[] = [];

afterEach(() => {
  for (const repository of openedMaintenance.splice(0)) repository.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function digest(seed: number): Sha256Digest {
  return `sha256:${seed.toString(16).padStart(64, '0')}`;
}

function localId(prefix: 'rrd' | 'qac'): string {
  return `${prefix}_${randomUUID()}`;
}

function authorityDescriptor(): OrganizationAuthorityDescriptorV1 {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicBytes = pair.publicKey.export({ format: 'der', type: 'spki' });
  if (!Buffer.isBuffer(publicBytes)) throw new Error('test key export failed');
  return {
    schema_version: 1,
    kind: 'echo-organization-authority',
    authority_id: federationId('oau'),
    organization_id: federationId('org'),
    signing_key: {
      key_id: p256KeyId(publicBytes),
      algorithm: 'ecdsa-p256-sha256-der-low-s',
      public_key_spki_der_base64: publicBytes.toString('base64'),
    },
  };
}

interface Fixture {
  readonly path: string;
  readonly descriptor: OrganizationAuthorityDescriptorV1;
  readonly owner: StoredAuthorityMembership;
  readonly repository: SqliteOrganizationAuthorityRepository;
  maintenance(): SqliteReviewerQueryAuditMaintenanceRepository;
}

function fixture(initializedAt = '2026-01-01T00:00:00.000Z'): Fixture {
  const directory = mkdtempSync(join(tmpdir(), 'echo-authority-query-audit-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'authority.sqlite');
  const descriptor = authorityDescriptor();
  const repository = new SqliteOrganizationAuthorityRepository(path);
  repository.initialize({
    descriptor,
    authority_pin_sha256: organizationAuthorityPinSha256(descriptor),
    organization_display_name: 'Example Company',
    maximum_active_lease_ttl_ms: 5 * 60 * 1000,
    initialized_at: initializedAt,
  });
  const owner: StoredAuthorityMembership = {
    organization_id: descriptor.organization_id,
    principal_id: federationId('prn'),
    membership_id: federationId('mem'),
    display_name: 'Owner',
    membership_type: 'owner',
    status: 'active',
    provisioned_at: initializedAt,
    revoked_at: null,
    revocation_reason: null,
    admin_command_id: `adm_${randomUUID()}`,
    admin_command_sha256: digest(0x01),
  };
  repository.write(initializedAt, (transaction) => {
    transaction.insertMembership(owner);
  });
  return {
    path,
    descriptor,
    owner,
    repository,
    maintenance: () => {
      const opened = SqliteReviewerQueryAuditMaintenanceRepository.open({
        database_path: path,
        trust: {
          descriptor,
          authority_pin_sha256: organizationAuthorityPinSha256(descriptor),
          organization_display_name: 'Example Company',
          maximum_active_lease_ttl_ms: 5 * 60 * 1000,
        },
      });
      openedMaintenance.push(opened);
      return opened;
    },
  };
}

const REQUESTER = Object.freeze({
  principal_id: federationId('prn'),
  membership_id: federationId('mem'),
  enrollment_id: federationId('enr'),
  installation_id: federationId('ins'),
});

const ALLOW_RESPONSE_BYTES = Buffer.from(
  '{"items":[],"policy_id":"restricted-reviewer-v1","schema_version":1}',
  'utf8',
);
const DENIAL_RESPONSE_BYTES = Buffer.from(
  '{"error":{"code":"unauthorized","message":"authorization failed"}}',
  'utf8',
);

function allowDetail(evaluatedAt: string): JsonValue {
  return reviewerAllowAuditDetail({
    request_id: localId('rrd'),
    request_sha256: digest(0x11),
    requester: REQUESTER,
    person_state_sha256: digest(0x22),
    record_head: { position: 4, record_hash: digest(0x33) },
    returned_atom_ids: [digest(0x44)],
    returned_record_hashes: [digest(0x55)],
    evaluated_at: evaluatedAt,
    response_sha256: sha256Digest(ALLOW_RESPONSE_BYTES),
  });
}

function appendAllow(
  repository: SqliteOrganizationAuthorityRepository,
  occurredAt: string,
): StoredReviewerQueryAuditEntry {
  return repository.write(occurredAt, (transaction) =>
    transaction.appendReviewerQueryAudit({
      decision: 'allow',
      reason_code: 'active_exact_reviewer_membership',
      detail: allowDetail(occurredAt),
      response_bytes: ALLOW_RESPONSE_BYTES,
    }),
  );
}

function appendDenial(
  repository: SqliteOrganizationAuthorityRepository,
  occurredAt: string,
): StoredReviewerQueryAuditEntry {
  return repository.write(occurredAt, (transaction) =>
    transaction.appendReviewerQueryAudit({
      decision: 'deny',
      reason_code: 'installation_access_expired',
      detail: reviewerDenialAuditDetail({
        request_id: localId('rrd'),
        request_sha256: digest(0x66),
        requester: REQUESTER,
        reason_code: 'installation_access_expired',
        person_state_sha256: digest(0x77),
        evaluated_at: occurredAt,
        response_sha256: sha256Digest(DENIAL_RESPONSE_BYTES),
      }),
      response_bytes: DENIAL_RESPONSE_BYTES,
    }),
  );
}

function exportCommand(
  context: Fixture,
  requestedAt: string,
  id = localId('qac'),
): ReviewerQueryAuditExportCommandV1 {
  return {
    schema_version: 1,
    kind: 'echo-authority-reviewer-query-audit-export-command',
    command_id: id,
    authority_id: context.descriptor.authority_id,
    organization_id: context.descriptor.organization_id,
    owner_principal_id: context.owner.principal_id,
    owner_membership_id: context.owner.membership_id,
    requested_at: requestedAt,
    reason: 'auditor request',
    from_inclusive: '2026-01-01T00:00:00.000Z',
    until_exclusive: '2026-01-02T00:00:00.000Z',
    output_path_sha256: reviewerQueryAuditOutputPathSha256(
      '/private/audit-export.json',
    ),
  };
}

function expiryCommand(
  context: Fixture,
  requestedAt: string,
  id = localId('qac'),
): ReviewerQueryAuditExpiryCommandV1 {
  return {
    schema_version: 1,
    kind: 'echo-authority-reviewer-query-audit-expiry-command',
    command_id: id,
    authority_id: context.descriptor.authority_id,
    organization_id: context.descriptor.organization_id,
    owner_principal_id: context.owner.principal_id,
    owner_membership_id: context.owner.membership_id,
    requested_at: requestedAt,
    reason: 'scheduled retention expiry',
  };
}

function rawDatabase<T>(path: string, operation: (db: Database.Database) => T): T {
  const database = new Database(path);
  try {
    return operation(database);
  } finally {
    database.close();
  }
}

describe('reviewer query audit persistence', () => {
  it('installs the separate table, retention index, immutable guards, and no cutoff table', () => {
    const context = fixture();
    const database = openAuthorityDatabase(context.path, { fileMustExist: true });
    try {
      const names = database
        .prepare(
          `SELECT type, name FROM sqlite_schema
            WHERE name LIKE 'authority_query_decision_audit%'
               OR name LIKE 'authority_audit_log_reviewer_query%'
            ORDER BY type, name`,
        )
        .all();
      expect(names).toEqual(
        expect.arrayContaining([
          { type: 'table', name: 'authority_query_decision_audit' },
          {
            type: 'index',
            name: 'authority_query_decision_audit_retention',
          },
          {
            type: 'trigger',
            name: 'authority_query_decision_audit_delete_denied',
          },
          {
            type: 'trigger',
            name: 'authority_query_decision_audit_immutable_update',
          },
        ]),
      );
      expect(
        database
          .prepare(
            `SELECT name FROM sqlite_schema
              WHERE name LIKE '%expiry_cutoff%'`,
          )
          .all(),
      ).toEqual([]);
    } finally {
      database.close();
      context.repository.close();
    }
  });

  it('uses the transaction time, exact 180-day retention, and stays out of generic admin views', () => {
    const context = fixture();
    const at = '2026-01-01T00:00:00.123Z';
    const stored = appendAllow(context.repository, at);
    expect(stored).toMatchObject({
      occurred_at: at,
      retain_until: reviewerQueryAuditRetainUntil(at),
      operation: REVIEWER_QUERY_AUDIT_OPERATION,
      decision: 'allow',
    });
    context.repository.read((transaction) => {
      expect(transaction.recentAuditBefore(undefined, 100)).toEqual([]);
      expect(transaction.adminCounts(at).audit_entries).toBe(0);
    });
    context.repository.close();
  });

  it('binds the exact prepared response digest and denial shape', () => {
    const context = fixture();
    expect(() =>
      context.repository.write('2026-01-01T00:00:00.100Z', (transaction) =>
        transaction.appendReviewerQueryAudit({
          decision: 'allow',
          reason_code: 'active_exact_reviewer_membership',
          detail: allowDetail('2026-01-01T00:00:00.100Z'),
          response_bytes: Buffer.from('different'),
        }),
      ),
    ).toThrow('response_sha256');
    const denial = appendDenial(
      context.repository,
      '2026-01-01T00:00:00.200Z',
    );
    expect(Object.keys(denial.detail as object)).not.toContain('record_head');
    expect(Object.keys(denial.detail as object)).not.toContain(
      'returned_atom_ids',
    );
    context.repository.close();
  });

  it('denies direct deletion and mutation even after retention elapses', () => {
    const context = fixture();
    appendAllow(context.repository, '2026-01-01T00:00:00.123Z');
    context.repository.close();
    rawDatabase(context.path, (database) => {
      expect(() =>
        database.prepare('DELETE FROM authority_query_decision_audit').run(),
      ).toThrow('deletion is denied');
      expect(() =>
        database
          .prepare(
            `UPDATE authority_query_decision_audit SET reason_code = reason_code`,
          )
          .run(),
      ).toThrow('immutable');
    });
  });
});

describe('closed stopped-state reviewer query audit maintenance', () => {
  it('authorizes exact canonical export bytes and retries without sampling time or adding a receipt', () => {
    const context = fixture();
    const row = appendAllow(context.repository, '2026-01-01T12:00:00.000Z');
    context.repository.close();
    const command = exportCommand(context, '2026-01-02T00:00:00.000Z');
    const maintenance = context.maintenance();
    let samples = 0;
    const first = maintenance.authorizeExport(command, () => {
      samples += 1;
      return '2026-01-02T00:00:00.000Z';
    });
    expect(samples).toBe(1);
    expect(first.control_event.action).toBe(REVIEWER_QUERY_AUDIT_EXPORT_ACTION);
    expect(Buffer.from(first.export_bytes ?? [])).toEqual(
      reviewerQueryAuditExportBytes(
        reviewerQueryAuditExportDocument(command, [row]),
      ),
    );

    const retry = maintenance.authorizeExport(command, () => {
      samples += 1;
      return '2030-01-01T00:00:00.000Z';
    });
    expect(samples).toBe(1);
    expect(retry.control_event).toEqual(first.control_event);
    expect(Buffer.from(retry.export_bytes ?? [])).toEqual(
      Buffer.from(first.export_bytes ?? []),
    );
    rawDatabase(context.path, (database) => {
      expect(
        (
          database
            .prepare(
              `SELECT COUNT(*) AS total FROM authority_audit_log
                WHERE action = ?`,
            )
            .get(REVIEWER_QUERY_AUDIT_EXPORT_ACTION) as { total: number }
        ).total,
      ).toBe(1);
    });
  });

  it('denies a receipt retry after its exact owner is revoked before reconstructing bytes', () => {
    const context = fixture();
    appendAllow(context.repository, '2026-01-01T12:00:00.000Z');
    context.repository.close();
    const command = exportCommand(context, '2026-01-02T00:00:00.000Z');
    const maintenance = context.maintenance();
    const first = maintenance.authorizeExport(
      command,
      () => '2026-01-02T00:00:00.000Z',
    );
    expect(first.export_bytes).not.toBeNull();

    rawDatabase(context.path, (database) => {
      database
        .prepare(
          `UPDATE authority_memberships
             SET status = 'revoked', revoked_at = ?, revocation_reason = ?
           WHERE membership_id = ?`,
        )
        .run(
          '2026-01-02T00:00:01.000Z',
          'owner access revoked after export',
          context.owner.membership_id,
        );
    });

    let retryTimeSamples = 0;
    expect(() =>
      maintenance.authorizeExport(command, () => {
        retryTimeSamples += 1;
        return '2030-01-01T00:00:00.000Z';
      }),
    ).toThrow('exact current active owner');
    expect(retryTimeSamples).toBe(0);
    rawDatabase(context.path, (database) => {
      expect(
        (
          database
            .prepare(
              `SELECT COUNT(*) AS total FROM authority_audit_log
                WHERE action = ?`,
            )
            .get(REVIEWER_QUERY_AUDIT_EXPORT_ACTION) as { total: number }
        ).total,
      ).toBe(1);
    });
  });

  it('rejects stale first execution, a future range, wrong owner, and command-id reuse', () => {
    const context = fixture();
    context.repository.close();
    const maintenance = context.maintenance();
    const stale = exportCommand(context, '2026-01-01T00:00:00.000Z');
    expect(() =>
      maintenance.authorizeExport(stale, () => '2026-01-02T00:00:00.000Z'),
    ).toThrow('freshness');

    const future = {
      ...exportCommand(context, '2026-01-01T23:59:00.000Z'),
      until_exclusive: '2026-01-03T00:00:00.000Z',
    } as ReviewerQueryAuditExportCommandV1;
    expect(() =>
      maintenance.authorizeExport(future, () => '2026-01-02T00:00:00.000Z'),
    ).toThrow('future');

    const wrongOwner = {
      ...exportCommand(context, '2026-01-01T23:59:00.000Z'),
      owner_principal_id: federationId('prn'),
    } as ReviewerQueryAuditExportCommandV1;
    expect(() =>
      maintenance.authorizeExport(
        wrongOwner,
        () => '2026-01-02T00:00:00.000Z',
      ),
    ).toThrow('exact current active owner');

    const command = exportCommand(context, '2026-01-01T23:59:00.000Z');
    maintenance.authorizeExport(command, () => '2026-01-02T00:00:00.000Z');
    expect(() =>
      maintenance.expire(
        expiryCommand(context, '2026-01-01T23:59:00.000Z', command.command_id),
        () => '2026-01-02T00:00:00.000Z',
      ),
    ).toThrow('other governed operation');
  });

  it('expires all-and-only due rows atomically and restores the direct-delete guard', () => {
    const context = fixture();
    const old = appendAllow(context.repository, '2026-01-01T00:00:00.123Z');
    const future = appendAllow(context.repository, '2026-01-02T00:00:00.124Z');
    context.repository.close();
    const cutoff = reviewerQueryAuditRetainUntil(old.occurred_at);
    const maintenance = context.maintenance();
    const event = maintenance.expire(expiryCommand(context, cutoff), () => cutoff);
    expect(event.action).toBe(REVIEWER_QUERY_AUDIT_EXPIRED_ACTION);
    const detail = JSON.parse(event.detail_json) as Record<string, unknown>;
    expect(detail).toMatchObject({ cutoff, row_count: 1, retention_days: 180 });
    rawDatabase(context.path, (database) => {
      expect(
        database
          .prepare(
            `SELECT audit_sequence FROM authority_query_decision_audit
              ORDER BY audit_sequence`,
          )
          .all(),
      ).toEqual([{ audit_sequence: future.audit_sequence }]);
      expect(() =>
        database.prepare('DELETE FROM authority_query_decision_audit').run(),
      ).toThrow('deletion is denied');
      expect(
        (
          database
            .prepare(
              `SELECT COUNT(*) AS total FROM authority_audit_log
                WHERE action = ?`,
            )
            .get(REVIEWER_QUERY_AUDIT_EXPIRED_ACTION) as { total: number }
        ).total,
      ).toBe(1);
    });
  });

  it('keeps control receipts immutable', () => {
    const context = fixture();
    context.repository.close();
    const command = exportCommand(context, '2026-01-02T00:00:00.000Z');
    context
      .maintenance()
      .authorizeExport(command, () => '2026-01-02T00:00:00.000Z');
    rawDatabase(context.path, (database) => {
      expect(() =>
        database
          .prepare(
            `UPDATE authority_audit_log SET subject_id = subject_id
              WHERE action = ?`,
          )
          .run(REVIEWER_QUERY_AUDIT_EXPORT_ACTION),
      ).toThrow('immutable');
      expect(() =>
        database
          .prepare('DELETE FROM authority_audit_log WHERE action = ?')
          .run(REVIEWER_QUERY_AUDIT_EXPORT_ACTION),
      ).toThrow('cannot be deleted');
    });
  });

  it('does not expose maintenance powers on the online repository', () => {
    const surface = Object.getOwnPropertyNames(
      SqliteOrganizationAuthorityRepository.prototype,
    );
    expect(surface).not.toContain('authorizeExport');
    expect(surface).not.toContain('expire');
    expect(surface).not.toContain('auditBetween');
    expect(surface).not.toContain('expireDueEntries');
    const context = fixture();
    context.repository.close();
    expect(canonicalJson(context.descriptor).length).toBeGreaterThan(0);
  });
});
