import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { ConfluenceProjectMappingStoreV1 } from '../src/confluence-project-mapping-store-v1.js';

const org = 'org-fixture';
const projectA = 'prj_00000000-0000-4000-8000-000000000010';
const projectB = 'prj_00000000-0000-4000-8000-000000000011';
const command = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

it('persists only stable numeric space ids and supports replay/list/remove without tool content', () => {
  const db = new Database(':memory:');
  try {
    const store = new ConfluenceProjectMappingStoreV1(db);
    const first = store.set(org, projectA, null, command, { cloud_id: '00000000-0000-4000-8000-000000000007', space_ids: ['123', '456'] });
    expect(first.mapping).toEqual({ cloud_id: '00000000-0000-4000-8000-000000000007', space_ids: ['123', '456'] });
    expect(store.replay(org, projectA, command)).toEqual(first);
    const second = store.set(org, projectB, null, 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', { cloud_id: '00000000-0000-4000-8000-000000000007', space_ids: ['789'] });
    expect(store.list(org)).toEqual([first, second]);
    const removed = store.set(org, projectA, first.revision, 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', null);
    expect(removed.mapping).toBeNull();
    expect(JSON.stringify(db.prepare('SELECT * FROM confluence_project_mapping_v1').all())).not.toContain('Confluence page body');
  } finally { db.close(); }
});
