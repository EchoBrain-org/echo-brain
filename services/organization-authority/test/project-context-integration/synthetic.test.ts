import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { SyntheticProjectHarness } from './synthetic-harness.js';

let h: SyntheticProjectHarness;
beforeEach(() => { h = new SyntheticProjectHarness(); });
afterEach(() => h.close());

describe('PC-06 synthetic table-delta invariant with real V9 custody', () => {
  it('adds only original custody/work/receipt/association/audit rows, with no meeting, approval or second queue', async () => {
    const counts = () => {
      const tables = h.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[];
      return Object.fromEntries(tables.map(({ name }) => [name, (h.database.prepare(`SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}"`).get() as { n: number }).n]));
    };
    const alpha = h.create('Synthetic Alpha');
    const before = counts();
    const receipt = h.submit(h.draft(alpha, { kind: 'project', project_id: alpha }));
    await h.enrich(receipt.context_id, async () => 'zenith');
    const after = counts();
    expect(Object.keys(after)).toEqual(Object.keys(before));
    const changed = Object.keys(after).filter(name => after[name] !== before[name]);
    expect(changed.sort()).toEqual([
      'authority_person_updates_v2', 'authority_person_update_work_v2',
      'authority_person_update_audience_projects_v1',
      'authority_project_command_receipts_v1', 'authority_project_context_associations_v1',
      'authority_project_read_audit_v1',
    ].sort());
    const operations = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/project-context-v1/operations.json', import.meta.url), 'utf8'));
    expect(JSON.stringify(operations)).not.toMatch(/\/ask|MeetingDocument|\/approval|\/records/);
  });
});
