import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { SqliteProjectContextRepositoryV1 } from '../src/adapters/persistence/sqlite/project-context-v1.js';
import { createProjectContextApplicationV1 } from '../src/application/project-context-application-v1.js';
import { OWNER, PROJECT_CONTEXT_NOW, authorization, projectContextDatabase } from './fixtures/project-context-sqlite.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const database of databases.splice(0)) if (database.open) database.close(); });

const create = {
  schema_version: 1 as const,
  kind: 'echo-project-create-v1' as const,
  request_id: '00000000-0000-4000-8000-000000000001',
  name: 'Launch',
};

describe('ProjectContextApplicationV1', () => {
  it('authenticates and validates before forming the repository-owned create scope', () => {
    const database = projectContextDatabase(); databases.push(database);
    const authenticate = (token: string) => {
      if (token !== 'good') throw new AuthorityOperationError('unauthorized', 'request failed');
      return authorization(OWNER);
    };
    const application = createProjectContextApplicationV1({
      authenticate,
      repository: new SqliteProjectContextRepositoryV1(database, () => PROJECT_CONTEXT_NOW),
    });

    expect(() => application.createProject('bad', create)).toThrow(expect.objectContaining({ code: 'unauthorized' }));
    expect(() => application.createProject('good', { ...create, authorization_revision: 'caller' })).toThrow(expect.objectContaining({ code: 'invalid_request' }));
    expect(application.createProject('good', create)).toMatchObject({ request_id: create.request_id, state: 'created' });
  });

  it('reauthenticates in the final release transaction and releases no selected bytes after a changed session', () => {
    const database = projectContextDatabase(); databases.push(database);
    const repository = new SqliteProjectContextRepositoryV1(database, () => PROJECT_CONTEXT_NOW);
    const stable = createProjectContextApplicationV1({ authenticate: () => authorization(OWNER), repository });
    stable.createProject('token', create);
    let calls = 0;
    const application = createProjectContextApplicationV1({
      authenticate: () => authorization(OWNER, { session_state_sha256: canonicalSha256({ session: ++calls }) }),
      repository,
    });

    expect(() => application.listProjects('token', {})).toThrow(expect.objectContaining<Partial<AuthorityOperationError>>({ code: 'stale_access_state' }));
    expect(database.prepare('SELECT count(*) AS n FROM authority_project_read_audit_v1').get()).toEqual({ n: 0 });
  });
});
