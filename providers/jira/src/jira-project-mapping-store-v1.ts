import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { canonicalJson } from '@echo-brain/federation-protocol';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { validateJiraProjectMappingV1, type JiraProjectMappingV1 } from '@echo-brain/provider-jira-client/organization-api/jira-project-mapping-v1';

/** Latest project configuration only. No tool content, credentials or change history. */
export class JiraProjectMappingStoreV1 {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS jira_project_mapping_v1 (
      organization_id TEXT NOT NULL, project_id TEXT NOT NULL, body_json TEXT NOT NULL,
      command_sha256 TEXT NOT NULL, PRIMARY KEY(organization_id, project_id));`);
  }
  read(organization: string, project: string): JiraProjectMappingV1 {
    const row = this.db.prepare('SELECT body_json FROM jira_project_mapping_v1 WHERE organization_id=? AND project_id=?').get(organization, project) as { body_json: string } | undefined;
    const result = validateJiraProjectMappingV1(row === undefined ? { schema_version: 1, project_id: project, revision: null, mapping: null } : JSON.parse(row.body_json));
    if (result.project_id !== project) throw new AuthorityOperationError('invalid_output', 'Jira project setting is invalid');
    return result;
  }
  replay(organization: string, project: string, command: string): JiraProjectMappingV1 | undefined {
    const row = this.db.prepare('SELECT command_sha256 FROM jira_project_mapping_v1 WHERE organization_id=? AND project_id=?').get(organization, project) as { command_sha256: string } | undefined;
    return row?.command_sha256 === command ? this.read(organization, project) : undefined;
  }
  set(organization: string, project: string, expected: string | null, command: string, mapping: JiraProjectMappingV1['mapping']): JiraProjectMappingV1 {
    return this.db.transaction(() => {
      const replay = this.replay(organization, project, command);
      if (replay !== undefined) return replay;
      if (this.read(organization, project).revision !== expected) throw new AuthorityOperationError('conflict', 'Jira project setting changed; reload it');
      const result = validateJiraProjectMappingV1({ schema_version: 1, project_id: project, revision: randomUUID(), mapping });
      this.db.prepare('INSERT INTO jira_project_mapping_v1 VALUES(?,?,?,?) ON CONFLICT(organization_id, project_id) DO UPDATE SET body_json=excluded.body_json, command_sha256=excluded.command_sha256').run(organization, project, canonicalJson(result), command);
      return result;
    }).immediate();
  }
}
