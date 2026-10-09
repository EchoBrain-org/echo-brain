import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { SqlitePersonAgenticAskAuditV1 } from '../../src/adapters/persistence/sqlite/person-agentic-ask-audit-v1.js';
import { applyAuthorityBaselineV14 } from '@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/baseline';
import { openAuthorityDatabase } from '@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/open-authority-database';
import type { PersonLiveEvidenceReleaseV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
const context = { authority_id: 'authority-fixture', organization_id: 'organization-fixture', state_lineage_id: 'lineage-fixture', principal_id: 'person-fixture', membership_id: 'membership-fixture', session_family_id: 'session-fixture', request_id: 'request-fixture' };
const release: PersonLiveEvidenceReleaseV1 = { schema_version: 1, operation: 'search', binding: { organization_id: context.organization_id, principal_id: context.principal_id, membership_id: context.membership_id, tool_id: 'jira', external_subject_id: 'account-fixture', external_scope_id: 'site-fixture', read_grant_sha256: canonicalSha256({ grant: 1 }) }, coordinates: [{ object_id: '10001' }], value_digests: [canonicalSha256({ minimized_released_value: 1 })], citations: [{ kind: 'ticket', tool_id: 'jira', external_scope_id: 'site-fixture', ticket_id: '10001', permalink: 'https://echo-fixture.atlassian.net/browse/ECHO-1', text_sha256: canonicalSha256({ released_bytes: 'fixture' }) }] };
describe('live release audit in existing Authority immutable storage', () => {
  it('commits repeated identical releases in one request as separate immutable receipts at the same timestamp', async () => {
    const db = openAuthorityDatabase(':memory:'); applyAuthorityBaselineV14(db);
    try {
      const audit = new SqlitePersonAgenticAskAuditV1(db, () => '2026-10-01T00:00:00.000Z').forLiveRequest(context);
      const first = await audit.record(release);
      const second = await audit.record(release);
      expect(second).not.toBe(first);
      const rows = db.prepare('SELECT row_sha256, body_json FROM authority_person_read_decision_audit_v2 ORDER BY rowid').all() as { row_sha256: string; body_json: string }[];
      expect(rows).toHaveLength(2);
      const bodies = rows.map(row => JSON.parse(row.body_json));
      expect(bodies.map(body => body.release_sequence)).toEqual([1, 2]);
      expect(bodies[0]).toEqual({ ...bodies[1], release_sequence: 1 });
      expect(rows.map(row => canonicalSha256(JSON.parse(row.body_json)))).toEqual([first, second]);
      expect(() => db.prepare('UPDATE authority_person_read_decision_audit_v2 SET body_json=? WHERE row_sha256=?').run('{}', first)).toThrow();
    } finally { db.close(); }
  });
  it('commits current Person/tenure/grant and ticket coordinates/digests without presentation or provider-private bytes', async () => {
    const db = openAuthorityDatabase(':memory:'); applyAuthorityBaselineV14(db);
    try {
      const audit = new SqlitePersonAgenticAskAuditV1(db, () => '2026-10-01T00:00:00.000Z').forLiveRequest({ ...context, secret: 'never-context-extra' } as typeof context);
      const receipt = await audit.record({ ...release, text: 'never-body', cursor: 'never-cursor', reference: 'never-nango-ref' } as PersonLiveEvidenceReleaseV1);
      const row = db.prepare('SELECT * FROM authority_person_read_decision_audit_v2 WHERE row_sha256=?').get(receipt) as { body_json: string };
      const body = JSON.parse(row.body_json);
      expect(canonicalSha256(body)).toBe(receipt);
      expect(body).toMatchObject({ ...context, binding: release.binding, citations: [{ kind: 'ticket', coordinates: { object_id: '10001' }, released_value_sha256: release.value_digests[0], text_sha256: release.citations[0]!.text_sha256, citation_sha256: canonicalSha256(release.citations[0]) }] });
      for (const hidden of ['never-', 'permalink', 'browse', 'cursor', 'reference', 'text":']) expect(row.body_json).not.toContain(hidden);
      expect(() => db.prepare('DELETE FROM authority_person_read_decision_audit_v2').run()).toThrow();
    } finally { db.close(); }
  });
  it('refuses another Person and propagates persistence failure before issuing a receipt', async () => {
    const db = openAuthorityDatabase(':memory:'); applyAuthorityBaselineV14(db);
    const audit = new SqlitePersonAgenticAskAuditV1(db).forLiveRequest(context);
    await expect(audit.record({ ...release, binding: { ...release.binding, principal_id: 'someone-else' } })).rejects.toThrow('binding');
    expect(db.prepare('SELECT * FROM authority_person_read_decision_audit_v2').all()).toEqual([]);
    db.close(); await expect(audit.record(release)).rejects.toThrow();
  });
});
