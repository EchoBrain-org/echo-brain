import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { sha256Digest } from '@echo-brain/federation-protocol';
import { SqlitePersonDocumentRepositoryV1 } from '../src/adapters/persistence/sqlite/document-v1.js';
import { createPersonDocumentApplicationV1 } from '../src/application/document-v1.js';
import { SqliteProjectContextRepositoryV1 } from '../src/adapters/persistence/sqlite/project-context-v1.js';
import { createProjectContextApplicationV1 } from '../src/application/project-context-application-v1.js';
import { OWNER, PROJECT_CONTEXT_NOW, authorization, projectContextDatabase } from './fixtures/project-context-sqlite.js';

const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));
const requestId = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;

describe('project archive document fences', () => {
  it('preserves existing documents and exact replays while rejecting new archived coordinates', () => {
    const database = projectContextDatabase(); databases.push(database);
    const projects = createProjectContextApplicationV1({
      authenticate: () => authorization(OWNER),
      repository: new SqliteProjectContextRepositoryV1(database, () => PROJECT_CONTEXT_NOW),
    });
    const documents = createPersonDocumentApplicationV1({
      authenticate: () => authorization(OWNER),
      repository: new SqlitePersonDocumentRepositoryV1(database, () => PROJECT_CONTEXT_NOW),
    });
    const alpha = projects.createProject('owner', { schema_version: 1, kind: 'echo-project-create-v1', request_id: requestId(1), name: 'Archive target' });
    const beta = projects.createProject('owner', { schema_version: 1, kind: 'echo-project-create-v1', request_id: requestId(2), name: 'Still active' });
    const bytes = Buffer.from('retained original bytes');
    const upload = (request_id: string, project_id: typeof alpha.project_id | null, title: string) => ({
      schema_version: 1 as const, kind: 'echo-person-document-upload-v1' as const, request_id, filename: 'evidence.txt', title,
      content_length: bytes.byteLength, sha256: sha256Digest(bytes), audience: project_id === null ? { kind: 'only_me' as const } : { kind: 'project' as const, project_id }, project_id,
    });
    const existingRequest = upload(requestId(3), alpha.project_id, 'Existing archived evidence');
    const existing = documents.upload('owner', existingRequest, bytes);
    const privateDocument = documents.upload('owner', upload(requestId(4), null, 'Private evidence'), bytes);
    projects.archiveProject('owner', { schema_version: 1, kind: 'echo-project-archive-v1', request_id: requestId(5), project_id: alpha.project_id, archived: true });

    expect(documents.original('owner', existing.document_id, { project_id: alpha.project_id }).bytes).toEqual(bytes);
    expect(documents.upload('owner', existingRequest, bytes)).toEqual(existing);
    expect(() => documents.upload('owner', upload(requestId(6), alpha.project_id, 'Blocked evidence'), bytes)).toThrow(expect.objectContaining({ code: 'not_found' }));
    expect(() => documents.associate('owner', { schema_version: 1, kind: 'echo-person-document-associate-v1', request_id: requestId(7), document_id: privateDocument.document_id, project_id: alpha.project_id })).toThrow(expect.objectContaining({ code: 'not_found' }));
    expect(documents.upload('owner', upload(requestId(8), beta.project_id, 'Active evidence'), bytes)).toMatchObject({ state: 'saved' });
  });
});
