import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalJson, canonicalSha256 } from '@echo-brain/federation-protocol';
import { applyAuthorityBaselineV7, applyAuthorityBaselineV8, authorityBaselineSha256V7, authorityBaselineSha256V8 } from '@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/baseline';
import { copyAuthorityV7ToV8 } from '@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/authority-v7-to-v8';

const roots: string[] = [];
const databases: Database.Database[] = [];
const NOW = '2026-09-23T00:00:00.000Z';
const DONE = '2026-09-23T00:00:01.000Z';
const id = (prefix: string, n = '1') => `${prefix}_${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const ORG = id('org');
const AUTHORITY = id('oau');
const OWNER = { organization_id: ORG, principal_id: id('prn'), membership_id: id('mem'), membership_type: 'owner' } as const;
const SHA = canonicalSha256('synthetic-fixture');
const MANIFEST_SQL = `CREATE TABLE echo_state_lineage_manifest (
         singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
         manifest_json TEXT NOT NULL,
         manifest_sha256 TEXT NOT NULL
       ) STRICT`;

afterEach(() => { for (const database of databases.splice(0)) if (database.open) database.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function open(path = ':memory:', readonly = false): Database.Database {
  const database = new Database(path, { readonly }); databases.push(database); database.pragma('foreign_keys = ON'); return database;
}
function insert(database: Database.Database, table: string, row: Record<string, unknown>): void {
  const keys = Object.keys(row);
  database.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(row));
}
function fixture(): { path: string; source: Database.Database } {
  const root = mkdtempSync(join(tmpdir(), 'echo-v7-v8-')); roots.push(root);
  const path = join(root, 'v7.sqlite'); const source = open(path); applyAuthorityBaselineV7(source);
  source.transaction(() => {
    // Fixture restores valid final rows, including consumed credentials, exactly
    // as a stopped snapshot would contain them. Every pinned trigger returns.
    source.pragma('defer_foreign_keys = ON');
    const triggers = source.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'").all() as { name: string; sql: string }[];
    for (const trigger of triggers) source.exec(`DROP TRIGGER ${trigger.name}`);
    insert(source, 'authority_metadata', { singleton: 1, authority_id: AUTHORITY, organization_id: ORG, organization_display_name: 'Synthetic organization', descriptor_json: '{}', created_at: NOW, last_observed_at: NOW });
    insert(source, 'authority_principals', { principal_id: OWNER.principal_id, organization_id: ORG, display_name: 'PM fixture', provisioned_at: NOW });
    insert(source, 'authority_memberships', { ...OWNER, status: 'active', provisioned_at: NOW });
    insert(source, 'authority_project_authorization_state_v1', { organization_id: ORG, revision: 1, updated_at: NOW });
    insert(source, 'authority_projects_v1', { project_id: id('prj'), organization_id: ORG, name: 'SCOUT fixture', created_at: NOW, creator_principal_id: OWNER.principal_id, creator_membership_id: OWNER.membership_id, creator_membership_type: 'owner' });
    insert(source, 'authority_project_memberships_v1', { project_membership_id: id('pgm'), project_id: id('prj'), ...OWNER, role: 'lead', status: 'active', granted_at: NOW });
    for (const version of [1, 2]) {
      const request_id = id('req', String(version)).slice(4);
      const request = { schema_version: version, kind: `echo-person-update-submit-v${version}`, request_id, title: 'Original fixture', text: 'Keep exact CRLF\r\n雪', ...(version === 1 ? { visibility: 'team' } : { audience: { kind: 'project', project_id: id('prj') }, project_id: id('prj') }) };
      const context_id = `ctx_${canonicalSha256({ ...(version === 2 ? { schema_version: 2, kind: 'echo-person-update-source-v2' } : {}), organization_id: ORG, membership_id: OWNER.membership_id, request_id }).slice(7)}`;
      insert(source, `authority_person_updates_v${version}`, { ...OWNER, request_id, context_id, payload_sha256: canonicalSha256(request), title: request.title, text: request.text, received_at: NOW, ...(version === 1 ? { visibility: 'team' } : { audience_kind: 'project', audience_project_id: id('prj'), project_id: id('prj') }) });
      insert(source, `authority_person_update_work_v${version}`, { context_id, state: 'pending', retry_at: NOW });
    }
    insert(source, 'authority_project_context_associations_v1', { context_id: source.prepare('SELECT context_id FROM authority_person_updates_v2').pluck().get(), project_id: id('prj'), organization_id: ORG, associator_principal_id: OWNER.principal_id, associator_membership_id: OWNER.membership_id, associator_membership_type: 'owner', associated_at: NOW });
    insert(source, 'authority_project_command_receipts_v1', { ...OWNER, request_id: 'fixture-receipt', operation: 'upload_submit', command_sha256: SHA, receipt_json: '{"saved":true}', receipt_sha256: canonicalSha256({ saved: true }), committed_at: NOW });
    insert(source, 'authority_person_upload_read_audit_v1', { row_sha256: SHA, body_json: '{"synthetic":true}', recorded_at: NOW });
    insert(source, 'authority_person_login_grants', { ...OWNER, login_grant_sha256: SHA, grant_purpose: 'oidc_identity_bootstrap', expected_issuer: 'https://issuer.example.test', oidc_configuration_sha256: SHA, expected_email_sha256: SHA, issued_at: NOW, expires_at: '2026-09-23T00:15:00.000Z', consumed_at: DONE });
    const login = { issuer: 'https://issuer.example.test', client_id: 'fixture-client', redirect_uri: 'https://authority.example.test/callback', tenant_constraint_sha256: SHA, oidc_configuration_sha256: SHA, created_at: NOW, expires_at: '2026-09-23T00:10:00.000Z' };
    insert(source, 'authority_oidc_login_attempts', { ...login, login_attempt_id: id('ola'), attempt_purpose: 'identity_bootstrap', login_grant_sha256: SHA, state_sha256: canonicalSha256('state-complete'), nonce_sha256: canonicalSha256('nonce-complete'), terminal_outcome: 'succeeded', completed_at: DONE, resolved_identity_binding_id: id('oib'), upstream_assertion_issued_at: NOW });
    insert(source, 'authority_oidc_login_attempts', { ...login, login_attempt_id: id('ola', '2'), attempt_purpose: 'existing_identity_login', state_sha256: canonicalSha256('state-pending'), nonce_sha256: canonicalSha256('nonce-pending'), pkce_verifier_seal_key_id: 'synthetic-key-id', pkce_verifier_sealed: Buffer.alloc(64, 0xa5) });
    insert(source, 'authority_oidc_identity_bindings', { ...OWNER, identity_binding_id: id('oib'), issuer: login.issuer, subject: 'synthetic-person', tenant_constraint_sha256: SHA, oidc_configuration_sha256: SHA, initial_login_attempt_id: id('ola'), initial_login_grant_sha256: SHA, status: 'active', bound_at: DONE });
    insert(source, 'authority_person_session_families', { ...OWNER, session_family_id: id('psf'), identity_binding_id: id('oib'), authentication_login_attempt_id: id('ola'), created_at: DONE, upstream_assertion_issued_at: NOW, tenant_constraint_sha256: SHA, oidc_configuration_sha256: SHA, hard_reauthentication_at: '2026-09-30T00:00:00.000Z', status: 'active' });
    insert(source, 'authority_person_session_credentials', { session_credential_id: id('psc'), session_family_id: id('psf'), credential_kind: 'refresh', rotation_sequence: 1, token_sha256: canonicalSha256('synthetic-noncredential'), issued_at: DONE, expires_at: '2026-09-23T01:00:00.000Z', consumed_at: '2026-09-23T00:01:00.000Z' });
    for (const trigger of triggers) source.exec(trigger.sql);
    source.exec(MANIFEST_SQL);
    const manifest = { schema_version: 1, kind: 'echo-state-lineage-database-manifest-v1', role: 'authority', authority_id: AUTHORITY, organization_id: ORG, state_lineage_id: 'synthetic-v7-v8-lineage', database_schema_version: 7, schema_sha256: authorityBaselineSha256V7(), created_at: NOW, creating_artifact_revision: 'synthetic-test' };
    insert(source, 'echo_state_lineage_manifest', { singleton: 1, manifest_json: canonicalJson(manifest), manifest_sha256: canonicalSha256(manifest) });
  })();
  expect(source.pragma('foreign_key_check')).toEqual([]);
  return { path, source };
}
function objects(database: Database.Database) { return database.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name != 'echo_state_lineage_manifest' ORDER BY type,name").all(); }

describe('offline Authority V7 to V8', () => {
  it('preserves original bytes, project state, receipts, audits, sessions and pending sealed BLOBs', () => {
    const f = fixture();
    const rows = new Map((f.source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'echo_state_lineage_manifest'").all() as { name: string }[]).map(({ name }) => [name, f.source.prepare(`SELECT * FROM ${name}`).all()]));
    f.source.close(); const before = readFileSync(f.path); const source = open(f.path, true); const target = open();
    copyAuthorityV7ToV8(source, target);
    expect(readFileSync(f.path)).toEqual(before);
    for (const [name, expected] of rows) expect(target.prepare(`SELECT * FROM ${name}`).all(), name).toEqual(expected);
    expect(target.pragma('user_version', { simple: true })).toBe(8);
    expect(target.pragma('foreign_key_check')).toEqual([]);
    const fresh = open(); applyAuthorityBaselineV8(fresh); expect(objects(target)).toEqual(objects(fresh));
    const manifest = JSON.parse(target.prepare('SELECT manifest_json FROM echo_state_lineage_manifest').pluck().get() as string);
    expect(manifest).toMatchObject({ database_schema_version: 8, schema_sha256: authorityBaselineSha256V8(), state_lineage_id: 'synthetic-v7-v8-lineage' });
    expect(() => target.prepare('UPDATE authority_person_updates_v2 SET text = ?').run('changed')).toThrow('immutable');
    expect(() => copyAuthorityV7ToV8(source, target)).toThrow('empty output');
  });
  it.each(['schema', 'manifest', 'binding', 'foreign-key'])('refuses %s drift without writing any output', mode => {
    const f = fixture();
    if (mode === 'schema') f.source.exec('CREATE TABLE injected (id INTEGER PRIMARY KEY)');
    if (mode === 'manifest') f.source.prepare('UPDATE echo_state_lineage_manifest SET manifest_sha256 = ?').run(canonicalSha256('wrong'));
    if (mode === 'binding') {
      const previous = JSON.parse(f.source.prepare('SELECT manifest_json FROM echo_state_lineage_manifest').pluck().get() as string);
      const wrong = { ...previous, organization_id: id('org', '2') };
      f.source.prepare('UPDATE echo_state_lineage_manifest SET manifest_json = ?, manifest_sha256 = ?').run(canonicalJson(wrong), canonicalSha256(wrong));
    }
    if (mode === 'foreign-key') { f.source.pragma('foreign_keys = OFF'); f.source.prepare("INSERT INTO authority_person_update_work_v1(context_id,state,retry_at) VALUES ('missing','pending',?)").run(NOW); }
    f.source.close(); const target = open();
    expect(() => copyAuthorityV7ToV8(open(f.path, true), target)).toThrow();
    expect(target.prepare('SELECT count(*) FROM sqlite_master').pluck().get()).toBe(0);
    expect(target.pragma('user_version', { simple: true })).toBe(0);
  });
  it('rolls target DDL and data back if copying cannot complete', () => {
    const f = fixture(); f.source.close(); const source = open(f.path, true); const target = open();
    // Exhaust the target's page budget during schema/copy work. The output
    // must remain empty, rather than an apparently initialized partial V8.
    target.pragma('max_page_count = 4');
    expect(() => copyAuthorityV7ToV8(source, target)).toThrow();
    expect(target.prepare('SELECT count(*) FROM sqlite_master').pluck().get()).toBe(0);
    expect(target.pragma('user_version', { simple: true })).toBe(0);
  });
  it('publishes one private offline output without replacing the stopped source or an existing output', () => {
    const f = fixture(); f.source.close(); const before = readFileSync(f.path); const output = join(f.path, '..', 'v8.sqlite');
    const tool = new URL('../../../tools/copy-authority-v7-to-v8.mjs', import.meta.url);
    const run = () => spawnSync(process.execPath, [tool.pathname, f.path, output], { encoding: 'utf8', timeout: 30_000 });
    const first = run(); expect(first.status, first.stderr).toBe(0); expect(first.stdout).toContain('input preserved');
    expect(statSync(output).mode & 0o777).toBe(0o600);
    const copied = readFileSync(output); expect(open(output, true).pragma('user_version', { simple: true })).toBe(8);
    expect(run().status).not.toBe(0); expect(readFileSync(output)).toEqual(copied); expect(readFileSync(f.path)).toEqual(before);
  });
  it('refuses writable source handles and disabled output foreign keys', () => {
    const f = fixture(); expect(() => copyAuthorityV7ToV8(f.source, open())).toThrow('read-only'); f.source.close();
    const target = open(); target.pragma('foreign_keys = OFF'); expect(() => copyAuthorityV7ToV8(open(f.path, true), target)).toThrow('foreign keys');
  });
});
