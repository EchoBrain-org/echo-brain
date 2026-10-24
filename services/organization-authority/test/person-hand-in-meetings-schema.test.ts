import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson, canonicalSha256 } from '@echo-brain/federation-protocol';
import { applyAuthorityBaseline } from '@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/baseline';
import { openAuthorityDatabase } from '@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/open-authority-database';
import { seedOwner } from './fixtures/authority-admission-seed.js';

const NOW = '2026-10-24T00:00:00.000Z';
const HAND_IN = 'pms_hand_in', OTHER = 'pms_other';
const meeting = { title: 'Supplier sync', notes: 'Decision: move the pilot to Friday.', transcript: '' };
const digest = canonicalSha256(meeting);
const row = { source_key: HAND_IN, external_id: `hand-in-${digest.slice(7)}`, payload_json: canonicalJson(meeting), payload_sha256: digest, submitted_at: NOW };

const databases: ReturnType<typeof openAuthorityDatabase>[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

/** An Authority with one owner, a hand-in source and a source of another meeting tool. */
function opened() {
  const database = openAuthorityDatabase(':memory:');
  databases.push(database);
  applyAuthorityBaseline(database);
  seedOwner(database, NOW);
  for (const [sourceKey, adapter] of [[HAND_IN, 'person-hand-in-meeting'], [OTHER, 'granola-person-mcp']] as const) {
    const semantic = canonicalSha256({ sourceKey });
    database.prepare(`INSERT INTO authority_live_source_admission_v2 (source_key, organization_id, principal_id, membership_id, membership_type,
      source_adapter_id, source_adapter_version, source_adapter_instance_id, normalizer_version, source_custodian_sha256, source_custodian_assurance,
      source_custodian_observed_at, source_credential_reference_sha256, initial_cursor, cutoff_at, processor_adapter_id, processor_adapter_version,
      processor_instance_id, processor_configuration_sha256, processor_credential_reference_sha256, semantic_input_sha256, admitted_at)
      VALUES (?, 'org_1', 'prn_1', 'mem_1', 'owner', ?, '1.0.0', 'fixture-instance', '1.0.0', ?, 'person_hand_in', ?, ?, 'fixture-cursor', ?,
        'llm', '1.0.0', 'processor', ?, ?, ?, ?)`).run(sourceKey, adapter, digest, NOW, digest, NOW, digest, digest, semantic, NOW);
    database.prepare("INSERT INTO authority_person_meeting_sources_v2 VALUES (?, ?, 'off', NULL, NULL, 0)").run(sourceKey, digest);
  }
  return database;
}
const insert = (database: ReturnType<typeof opened>, value: Readonly<Record<keyof typeof row, string>>) => database.prepare(`INSERT INTO authority_person_hand_in_meetings_v1
  (source_key, external_id, payload_json, payload_sha256, submitted_at) VALUES (@source_key, @external_id, @payload_json, @payload_sha256, @submitted_at)`).run(value);

describe('Authority V15 handed-in meetings', () => {
  it('keeps one payload per hand-in source and content-derived id, and never changes or deletes it', () => {
    const database = opened();
    insert(database, row);
    expect(() => insert(database, row)).toThrow(/UNIQUE|PRIMARY KEY/);
    expect(() => database.prepare('UPDATE authority_person_hand_in_meetings_v1 SET submitted_at = ?').run('2026-10-25T00:00:00.000Z')).toThrow('handed-in meeting is immutable');
    expect(() => database.prepare('UPDATE authority_person_hand_in_meetings_v1 SET payload_json = ?').run('{}')).toThrow('handed-in meeting is immutable');
    expect(() => database.prepare('DELETE FROM authority_person_hand_in_meetings_v1').run()).toThrow('handed-in meeting deletion is denied');
    expect(database.prepare('SELECT * FROM authority_person_hand_in_meetings_v1').all()).toEqual([row]);
    expect((database.pragma('table_info(authority_person_hand_in_meetings_v1)') as { name: string }[]).map(column => column.name))
      .toEqual(['source_key', 'external_id', 'payload_json', 'payload_sha256', 'submitted_at']);
  });

  it.each([
    ['another meeting tool\'s source', { source_key: OTHER }, 'requires a hand-in source'],
    ['an unknown source', { source_key: 'pms_unknown' }, 'requires a hand-in source'],
    ['an id its digest does not derive', { external_id: `hand-in-${'0'.repeat(64)}` }, 'CHECK'],
    ['an id of another shape', { external_id: 'synthetic-custom-supplier' }, 'CHECK'],
    ['a digest that is not sha256 hex', { payload_sha256: `sha256:${'G'.repeat(64)}`, external_id: `hand-in-${'G'.repeat(64)}` }, 'CHECK'],
    ['a payload that is not a JSON object', { payload_json: '["Supplier sync"]' }, 'CHECK'],
    ['a payload over 60 KiB', { payload_json: JSON.stringify({ notes: 'n'.repeat(61440) }) }, 'CHECK'],
    ['a time that is not a time', { submitted_at: 'yesterday' }, 'CHECK'],
  ])('refuses %s', (_name, value, error) => {
    const database = opened();
    expect(() => insert(database, { ...row, ...value })).toThrow(error);
    expect(database.prepare('SELECT count(*) FROM authority_person_hand_in_meetings_v1').pluck().get()).toBe(0);
  });
});
