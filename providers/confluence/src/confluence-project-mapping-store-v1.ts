import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { canonicalJson } from '@echo-brain/federation-protocol';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { validateConfluenceProjectMappingV1, type ConfluenceProjectMappingV1 } from '@echo-brain/provider-confluence-client/organization-api/confluence-project-mapping-v1';

/** Latest project configuration only. No tool content, credentials or change history. */
export class ConfluenceProjectMappingStoreV1 {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS confluence_project_mapping_v1 (
      organization_id TEXT NOT NULL, project_id TEXT NOT NULL, body_json TEXT NOT NULL,
      command_sha256 TEXT NOT NULL, PRIMARY KEY(organization_id, project_id));`);
  }
  read(organization: string, project: string): ConfluenceProjectMappingV1 {
    const row = this.db.prepare('SELECT body_json FROM confluence_project_mapping_v1 WHERE organization_id=? AND project_id=?').get(organization, project) as { body_json: string } | undefined;
    const result = validateConfluenceProjectMappingV1(row === undefined ? { schema_version: 1, project_id: project, revision: null, mapping: null } : JSON.parse(row.body_json));
    if (result.project_id !== project) throw new AuthorityOperationError('invalid_output', 'Confluence project setting is invalid');
    return result;
  }
  /** Returns configuration only, never provider content or a credential. */
  list(organization: string): readonly ConfluenceProjectMappingV1[] {
    const rows = this.db.prepare('SELECT body_json FROM confluence_project_mapping_v1 WHERE organization_id=? ORDER BY project_id ASC').all(organization) as readonly { body_json: string }[];
    return Object.freeze(rows.map(row => validateConfluenceProjectMappingV1(JSON.parse(row.body_json))));
  }
  replay(organization: string, project: string, command: string): ConfluenceProjectMappingV1 | undefined {
    const row = this.db.prepare('SELECT command_sha256 FROM confluence_project_mapping_v1 WHERE organization_id=? AND project_id=?').get(organization, project) as { command_sha256: string } | undefined;
    return row?.command_sha256 === command ? this.read(organization, project) : undefined;
  }
  set(organization: string, project: string, expected: string | null, command: string, mapping: ConfluenceProjectMappingV1['mapping']): ConfluenceProjectMappingV1 {
    return this.db.transaction(() => {
      const replay = this.replay(organization, project, command);
      if (replay !== undefined) return replay;
      if (this.read(organization, project).revision !== expected) throw new AuthorityOperationError('conflict', 'Confluence project setting changed; reload it');
      const result = validateConfluenceProjectMappingV1({ schema_version: 1, project_id: project, revision: randomUUID(), mapping });
      this.db.prepare('INSERT INTO confluence_project_mapping_v1 VALUES(?,?,?,?) ON CONFLICT(organization_id, project_id) DO UPDATE SET body_json=excluded.body_json, command_sha256=excluded.command_sha256').run(organization, project, canonicalJson(result), command);
      return result;
    }).immediate();
  }
}
