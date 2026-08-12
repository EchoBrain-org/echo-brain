import { Buffer } from 'node:buffer';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { federationId, p256KeyId, sha256Digest } from '@echo-brain/federation-protocol';
import type { JsonValue, Sha256Digest } from '@echo-brain/federation-protocol';
import { organizationAuthorityPinSha256 } from '@echo-brain/organization-protocol';
import type { OrganizationAuthorityDescriptorV1 } from '@echo-brain/organization-protocol';
import { SqliteOrganizationAuthorityRepository } from '../src/adapters/persistence/sqlite/sqlite-authority-repository.js';
import { SqliteReadableSearchQueryAuditMaintenanceRepository } from '../src/adapters/persistence/sqlite/readable-search-query-audit-maintenance.js';
import {
  readableSearchQueryAuditOutputPathSha256,
  validateReadableSearchQueryAuditMaintenanceCommand,
} from '../src/application/readable-search-query-audit-maintenance.js';
import { readableSearchQueryAuditRetainUntil } from '../src/application/readable-search-persistence.js';

const directories: string[] = [];
const maintenance: SqliteReadableSearchQueryAuditMaintenanceRepository[] = [];
afterEach(() => { for (const item of maintenance.splice(0)) item.close(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const digest = (c: string): Sha256Digest => `sha256:${c.repeat(64)}`;
const id = (prefix: 'sqa' | 'adm') => `${prefix}_${randomUUID()}`;

function descriptor(): OrganizationAuthorityDescriptorV1 {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' });
  if (!Buffer.isBuffer(publicKey)) throw new Error('key export failed');
  return { schema_version: 1, kind: 'echo-organization-authority', authority_id: federationId('oau'), organization_id: federationId('org'), signing_key: { key_id: p256KeyId(publicKey), algorithm: 'ecdsa-p256-sha256-der-low-s', public_key_spki_der_base64: publicKey.toString('base64') } };
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'echo-readable-maintenance-')); directories.push(directory);
  const authority = descriptor(); const path = join(directory, 'authority.sqlite'); const repository = new SqliteOrganizationAuthorityRepository(path);
  repository.initialize({ descriptor: authority, authority_pin_sha256: organizationAuthorityPinSha256(authority), organization_display_name: 'Example', maximum_active_lease_ttl_ms: 300_000, initialized_at: '2026-01-01T00:00:00.000Z' });
  const owner = { organization_id: authority.organization_id, principal_id: federationId('prn'), membership_id: federationId('mem'), display_name: 'Owner', membership_type: 'owner' as const, status: 'active' as const, provisioned_at: '2026-01-01T00:00:00.000Z', revoked_at: null, revocation_reason: null, admin_command_id: id('adm'), admin_command_sha256: digest('1') };
  repository.write('2026-01-01T00:00:00.000Z', (transaction) => transaction.insertMembership(owner));
  const open = () => { const item = SqliteReadableSearchQueryAuditMaintenanceRepository.open({ database_path: path, trust: { descriptor: authority, authority_pin_sha256: organizationAuthorityPinSha256(authority), organization_display_name: 'Example', maximum_active_lease_ttl_ms: 300_000 } }); maintenance.push(item); return item; };
  return { authority, owner, path, repository, open };
}

function detail(at: string): JsonValue {
  const response = Buffer.from('{"schema_version":1,"contract_id":"permission-aware-readable-search-v1","items":[]}');
  return { schema_version: 1, kind: 'readable-search-query-decision-audit-detail-v1', request_id: 'osq_00000000-0000-4000-8000-000000000001', request_sha256: digest('1'), requester: { principal_id: 'prn_00000000-0000-4000-8000-000000000001', membership_id: 'mem_00000000-0000-4000-8000-000000000001', membership_type: 'employee', enrollment_id: 'enr_00000000-0000-4000-8000-000000000001', installation_id: 'ins_00000000-0000-4000-8000-000000000001' }, decision: 'allow', reason_code: 'active_member_with_scoped_policy_paths', evaluation_complete: true, retrieval_contract_sha256: digest('2'), policy_contracts: [{ policy_id: 'organization-member-readable-v1', policy_contract_sha256: digest('3') }, { policy_id: 'restricted-reviewer-v1', policy_contract_sha256: digest('4') }], person_state_sha256: digest('5'), scope_binding_sha256: digest('6'), generation: { generation_id: digest('7'), manifest_sha256: digest('8') }, record_head: { position: 1, record_hash: digest('9') }, returned_atom_ids: [], returned_record_hashes: [], returned_policy_ids: [], evaluated_at: at, response_sha256: sha256Digest(response) };
}

function append(context: ReturnType<typeof fixture>, at: string) {
  const response = Buffer.from('{"schema_version":1,"contract_id":"permission-aware-readable-search-v1","items":[]}');
  return context.repository.write(at, (transaction) => transaction.appendReadableSearchQueryAudit({ decision: 'allow', reason_code: 'active_member_with_scoped_policy_paths', detail: detail(at), response_bytes: response }));
}

function exportCommand(context: ReturnType<typeof fixture>, requestedAt: string, commandId = id('sqa')) {
  return { schema_version: 1 as const, kind: 'echo-authority-readable-search-query-audit-export-command' as const, command_id: commandId, authority_id: context.authority.authority_id, organization_id: context.authority.organization_id, owner_principal_id: context.owner.principal_id, owner_membership_id: context.owner.membership_id, requested_at: requestedAt, reason: 'retention review', from_inclusive: '2026-01-01T00:00:00.000Z', until_exclusive: '2026-01-02T00:00:00.000Z', output_path_sha256: readableSearchQueryAuditOutputPathSha256('/private/readable-export.json') };
}
function expiryCommand(context: ReturnType<typeof fixture>, requestedAt: string, commandId = id('sqa')) {
  return { schema_version: 1 as const, kind: 'echo-authority-readable-search-query-audit-expiry-command' as const, command_id: commandId, authority_id: context.authority.authority_id, organization_id: context.authority.organization_id, owner_principal_id: context.owner.principal_id, owner_membership_id: context.owner.membership_id, requested_at: requestedAt, reason: 'scheduled retention expiry' };
}
function raw<T>(path: string, operation: (database: Database.Database) => T): T { const database = new Database(path); try { return operation(database); } finally { database.close(); } }

describe('stopped readable-search query-audit maintenance', () => {
  it('accepts only the closed command documents and does not admit an expiry cutoff', () => {
    const context = fixture();
    expect(() => validateReadableSearchQueryAuditMaintenanceCommand({ ...expiryCommand(context, '2026-01-01T00:00:00.000Z'), cutoff: '2027-01-01T00:00:00.000Z' })).toThrow('exact closed set');
    expect(() => validateReadableSearchQueryAuditMaintenanceCommand({ ...exportCommand(context, '2026-01-01T00:00:00.000Z'), until_exclusive: '2026-02-02T00:00:00.000Z' })).toThrow('at most 31 days');
    context.repository.close();
  });

  it('selects the exact half-open export range and retries the immutable receipt without a time sample', () => {
    const context = fixture(); append(context, '2026-01-01T12:00:00.123Z'); context.repository.close(); const command = exportCommand(context, '2026-01-02T00:00:00.000Z'); let samples = 0;
    const first = context.open().authorizeExport(command, () => { samples += 1; return '2026-01-02T00:00:00.000Z'; });
    expect(samples).toBe(1); expect(JSON.parse(Buffer.from(first.export_bytes ?? []).toString()).rows).toHaveLength(1);
    const retry = maintenance[0]!.authorizeExport(command, () => { samples += 1; return '2030-01-01T00:00:00.000Z'; });
    expect(samples).toBe(1); expect(retry.control_event).toEqual(first.control_event);
  });

  it('denies a receipt retry after its exact owner is revoked before reconstructing bytes', () => {
    const context = fixture(); append(context, '2026-01-01T12:00:00.123Z'); context.repository.close();
    const command = exportCommand(context, '2026-01-02T00:00:00.000Z'); const store = context.open();
    const first = store.authorizeExport(command, () => '2026-01-02T00:00:00.000Z');
    expect(first.export_bytes).not.toBeNull();
    raw(context.path, (database) => {
      database.prepare(`UPDATE authority_memberships SET status = 'revoked', revoked_at = ?, revocation_reason = ? WHERE membership_id = ?`).run(
        '2026-01-02T00:00:01.000Z', 'owner access revoked after export', context.owner.membership_id,
      );
    });
    let retryTimeSamples = 0;
    expect(() => store.authorizeExport(command, () => { retryTimeSamples += 1; return '2030-01-01T00:00:00.000Z'; })).toThrow('exact current active owner');
    expect(retryTimeSamples).toBe(0);
    raw(context.path, (database) => expect(database.prepare("SELECT COUNT(*) AS total FROM authority_audit_log WHERE action = 'permission.readable_search_query_audit_export_authorized'").get()).toEqual({ total: 1 }));
  });

  it('expires all-and-only exact-millisecond due rows with no caller cutoff and restores default deny', () => {
    const context = fixture(); const old = append(context, '2026-01-01T00:00:00.123Z'); const future = append(context, '2026-01-01T00:00:00.124Z'); context.repository.close(); const cutoff = readableSearchQueryAuditRetainUntil(old.occurred_at);
    const event = context.open().expire(expiryCommand(context, cutoff), () => cutoff); expect(event.action).toBe('permission.readable_search_query_audit_expired');
    raw(context.path, (database) => { expect(database.prepare('SELECT audit_sequence FROM authority_readable_search_query_audit').all()).toEqual([{ audit_sequence: future.audit_sequence }]); expect(() => database.prepare('DELETE FROM authority_readable_search_query_audit').run()).toThrow('deletion is denied'); });
  });

  it('rolls back an expiry trigger swap if its exact default-deny trigger was tampered with', () => {
    const context = fixture(); const row = append(context, '2026-01-01T00:00:00.123Z'); context.repository.close(); const cutoff = readableSearchQueryAuditRetainUntil(row.occurred_at);
    raw(context.path, (database) => database.exec("DROP TRIGGER authority_readable_search_query_audit_delete_denied; CREATE TRIGGER authority_readable_search_query_audit_delete_denied BEFORE DELETE ON authority_readable_search_query_audit BEGIN SELECT RAISE(ABORT, 'tampered'); END;"));
    expect(() => context.open().expire(expiryCommand(context, cutoff), () => cutoff)).toThrow('exact schema trigger');
    raw(context.path, (database) => expect(database.prepare('SELECT COUNT(*) AS total FROM authority_readable_search_query_audit').get()).toEqual({ total: 1 }));
  });

  it('enforces cross-action command conflict and immutable control receipts', () => {
    const context = fixture(); context.repository.close(); const command = exportCommand(context, '2026-01-02T00:00:00.000Z'); const store = context.open(); store.authorizeExport(command, () => '2026-01-02T00:00:00.000Z');
    expect(() => store.expire(expiryCommand(context, '2026-01-02T00:00:00.000Z', command.command_id), () => '2026-01-02T00:00:00.000Z')).toThrow('other governed operation');
    expect(() => store.authorizeExport({ ...command, reason: 'different approved reason' }, () => '2026-01-02T00:00:00.000Z')).toThrow('different command bytes');
    raw(context.path, (database) => { expect(() => database.prepare("UPDATE authority_audit_log SET subject_id = subject_id WHERE action = 'permission.readable_search_query_audit_export_authorized'").run()).toThrow('immutable'); expect(() => database.prepare("DELETE FROM authority_audit_log WHERE action = 'permission.readable_search_query_audit_export_authorized'").run()).toThrow('cannot be deleted'); });
  });

  it('keeps stopped maintenance off the online repository surface', () => {
    const surface = Object.getOwnPropertyNames(SqliteOrganizationAuthorityRepository.prototype);
    for (const name of ['authorizeExport', 'expire', 'auditBetween', 'due', 'append']) expect(surface).not.toContain(name);
  });
});
