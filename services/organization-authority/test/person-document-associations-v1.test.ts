import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalSha256, sha256Digest } from '@echo-brain/federation-protocol';
import type { PersonDocumentAssociateV1, PersonDocumentDissociateV1, PersonDocumentUploadMetadataV1 } from '@echo-brain/organization-api';
import { SqlitePersonDocumentRepositoryV1 } from '../src/adapters/persistence/sqlite/document-v1.js';
import { createPersonDocumentApplicationV1 } from '../src/application/document-v1.js';
import { SqliteProjectContextRepositoryV1 } from '../src/adapters/persistence/sqlite/project-context-v1.js';
import { createProjectContextApplicationV1 } from '../src/application/project-context-application-v1.js';
import { createOrganizationAuthorityHttpServer } from '../src/presentation/organization-authority-http-server.js';
import { createPersonDocumentUploadStagingV1 } from '../src/adapters/files/document-upload-staging-v1.js';
import { OWNER, MEMBER, RETURNED_MEMBER, PROJECT_ALPHA, PROJECT_BETA, PROJECT_CONTEXT_NOW, addMembership, authorization, insertLegacyTextV1, revokeMembership } from './fixtures/project-context-sqlite.js';

const databases: Database.Database[] = [];
const servers: ReturnType<typeof createOrganizationAuthorityHttpServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed; }
  databases.splice(0).forEach(db => db.close());
});
function setup() {
  const db = new Database(':memory:'); databases.push(db); db.pragma('foreign_keys=ON');
  db.exec(readFileSync(new URL('../../../packages/organization-authority-kernel/baselines/authority-baseline-v9.sql', import.meta.url), 'utf8'));
  db.prepare(`INSERT INTO authority_metadata(singleton,authority_id,organization_id,organization_display_name,descriptor_json,created_at,last_observed_at) VALUES (1,'oau_associations',?,'Associations','{}',?,?)`).run(OWNER.organization_id, PROJECT_CONTEXT_NOW, PROJECT_CONTEXT_NOW);
  db.prepare('INSERT INTO authority_project_authorization_state_v1(organization_id,revision,updated_at) VALUES (?,0,?)').run(OWNER.organization_id, PROJECT_CONTEXT_NOW);
  addMembership(db, OWNER, 'Owner', null); addMembership(db, MEMBER, 'Member', 'member@example.test');
  for (const project of [PROJECT_ALPHA, PROJECT_BETA]) {
    db.prepare('INSERT INTO authority_projects_v1(project_id,organization_id,name,created_at,creator_principal_id,creator_membership_id,creator_membership_type) VALUES (?,?,?,?,?,?,?)').run(project, OWNER.organization_id, project, PROJECT_CONTEXT_NOW, OWNER.principal_id, OWNER.membership_id, OWNER.membership_type);
    grant(db, project, OWNER, 'lead');
  }
  grant(db, PROJECT_ALPHA, MEMBER, 'member');
  const repository = new SqlitePersonDocumentRepositoryV1(db, () => PROJECT_CONTEXT_NOW);
  const app = createPersonDocumentApplicationV1({ repository, authenticate: token => authorization(token === 'member' ? MEMBER : token === 'returned' ? RETURNED_MEMBER : OWNER) });
  const bytes = Buffer.from('immutable SCOUT requirements');
  const upload = (token = 'owner', changes: Partial<PersonDocumentUploadMetadataV1> = {}) => app.upload(token, {
    schema_version: 1, kind: 'echo-person-document-upload-v1', request_id: randomUUID(), filename: 'SCOUT.md', title: 'SCOUT',
    content_length: bytes.length, sha256: sha256Digest(bytes), audience: { kind: 'team' }, project_id: null, ...changes,
  }, bytes);
  return { db, repository, app, bytes, upload };
}
function grant(db: Database.Database, project: string, actor: typeof OWNER, role: 'lead' | 'member') {
  db.prepare(`INSERT INTO authority_project_memberships_v1(project_membership_id,project_id,organization_id,principal_id,membership_id,membership_type,role,status,granted_at) VALUES (?,?,?,?,?,?,?,'active',?)`).run(`pgm_${randomUUID()}`, project, actor.organization_id, actor.principal_id, actor.membership_id, actor.membership_type, role, PROJECT_CONTEXT_NOW);
}
function associate(document_id: `doc_${string}`, project_id: typeof PROJECT_ALPHA | typeof PROJECT_BETA = PROJECT_ALPHA): PersonDocumentAssociateV1 {
  return { schema_version: 1, kind: 'echo-person-document-associate-v1', request_id: randomUUID(), document_id, project_id };
}
function dissociate(request: PersonDocumentAssociateV1): PersonDocumentDissociateV1 {
  return { ...request, kind: 'echo-person-document-dissociate-v1', request_id: randomUUID() };
}
function search(project_id: typeof PROJECT_ALPHA | typeof PROJECT_BETA) {
  return { schema_version: 1, kind: 'echo-person-document-search-v1', project_id, query: '', limit: 20, cursor: null };
}

describe('document project associations', () => {
  it('refuses V8 at both current runtime adapters before attempting V9 queries', () => {
    const db = new Database(':memory:'); databases.push(db); db.pragma('foreign_keys=ON');
    db.exec(readFileSync(new URL('../../../packages/organization-authority-kernel/baselines/authority-baseline-v8.sql', import.meta.url), 'utf8'));
    expect(() => new SqlitePersonDocumentRepositoryV1(db)).toThrow('Documents require Authority V9');
    expect(() => new SqliteProjectContextRepositoryV1(db)).toThrow('Project context requires Authority V9');
  });

  it('keeps independent modern project links, immutable audience and exact replay while removing only the requested link', () => {
    const { app, db, bytes } = setup();
    const input = { schema_version: 2 as const, kind: 'echo-person-document-upload-v2' as const, request_id: randomUUID(),
      filename: 'SCOUT.md', title: 'SCOUT', content_length: bytes.length, sha256: sha256Digest(bytes),
      audience: { kind: 'projects' as const, project_ids: [PROJECT_ALPHA, PROJECT_BETA] }, association_project_ids: [PROJECT_ALPHA, PROJECT_BETA] };
    const saved = app.uploadV2('owner', input, bytes);
    const initial = db.prepare('SELECT receipt_json FROM authority_person_document_receipts_v1 WHERE request_id=?').get(saved.request_id);
    const removal = dissociate(associate(saved.document_id));
    expect(app.dissociate('owner', removal).state).toBe('applied');
    expect(db.prepare('SELECT project_id FROM authority_person_document_associations_v1 WHERE document_id=?').all(saved.document_id)).toEqual([{ project_id: PROJECT_BETA }]);
    expect(app.readV2('member', saved.document_id).audience).toEqual(input.audience);
    expect(app.readV2('member', saved.document_id).association_project_ids).toEqual([]);
    expect(() => app.readV2('member', saved.document_id, { project_id: PROJECT_ALPHA })).toThrow(expect.objectContaining({ code: 'not_found' }));
    const addition = associate(saved.document_id);
    app.associate('owner', addition);
    expect(app.dissociate('owner', removal).state).toBe('applied'); // Old receipt must not delete a newer association.
    expect(db.prepare('SELECT project_id FROM authority_person_document_associations_v1 WHERE document_id=? ORDER BY project_id').all(saved.document_id)).toEqual([{ project_id: PROJECT_ALPHA }, { project_id: PROJECT_BETA }]);
    expect(app.readV2('member', saved.document_id, { project_id: PROJECT_ALPHA }).document_id).toBe(saved.document_id);
    expect(db.prepare('SELECT receipt_json FROM authority_person_document_receipts_v1 WHERE request_id=?').get(saved.request_id)).toEqual(initial);
    expect(app.uploadV2('owner', input, bytes)).toEqual(saved);
  });
  it('allows the modern uploader to add a second private project link without widening audience', () => {
    const { app, db, bytes } = setup();
    const saved = app.uploadV2('owner', { schema_version: 2, kind: 'echo-person-document-upload-v2', request_id: randomUUID(),
      filename: 'private.md', title: 'Private', content_length: bytes.length, sha256: sha256Digest(bytes),
      audience: { kind: 'only_me' }, association_project_ids: [PROJECT_ALPHA] }, bytes);
    app.associate('owner', associate(saved.document_id, PROJECT_BETA));
    expect(db.prepare('SELECT count(*) n FROM authority_person_document_associations_v1 WHERE document_id=?').get(saved.document_id)).toEqual({ n: 2 });
    expect(() => app.readV2('member', saved.document_id)).toThrow(expect.objectContaining({ code: 'not_found' }));
    expect(() => app.dissociate('member', dissociate(associate(saved.document_id)))).toThrow(expect.objectContaining({ code: 'not_found' }));
  });

  it('exposes bounded HTTP association commands with response identity checks and no audience mutation', async () => {
    const { app, upload } = setup(); const saved = upload();
    const server = createOrganizationAuthorityHttpServer({ descriptor: {} as never, sessions: {} as never, oidc_provider: {} as never, expected_issuer: 'https://issuer.example', person_documents: app, document_upload_staging: createPersonDocumentUploadStagingV1() });
    servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test address');
    const origin = `http://127.0.0.1:${address.port}`;
    const request = associate(saved.document_id);
    const send = (body: unknown, action = 'associate', documentId = saved.document_id, token = 'owner') => fetch(`${origin}/v1/person/documents/${documentId}/${action}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    const attached = await send(request); expect(attached.status).toBe(200); expect(await attached.json()).toMatchObject({ document_id: saved.document_id, operation: 'associate', request_id: request.request_id, state: 'applied' });
    for (const response of [await send({ ...request, audience: { kind: 'project', project_id: PROJECT_ALPHA } }), await send(request, 'dissociate'), await send(request, 'associate', `doc_${'a'.repeat(64)}`), await send(JSON.stringify(request).replace('"schema_version":1', '"schema_version":1,"schema_version":1')), await send('x'.repeat(4097))]) {
      expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } });
    }
    expect((await send(dissociate(request), 'dissociate', saved.document_id, 'member')).status).toBe(404);
    const removed = await send(dissociate(request), 'dissociate'); expect(removed.status).toBe(200); expect(await removed.json()).toMatchObject({ operation: 'dissociate', state: 'applied' });
    expect(app.read('member', saved.document_id)).toMatchObject({ project_id: null, audience: { kind: 'team' } });
    const validAssociate = app.associate;
    app.associate = (token, input) => ({ ...validAssociate(token, input), project_id: PROJECT_BETA });
    const next = associate(saved.document_id); const mismatch = await send(next);
    expect(mismatch.status).toBe(502); expect(await mismatch.json()).toMatchObject({ error: { code: 'invalid_output' } });
    app.associate = validAssociate;
    expect((await send(next)).status).toBe(200);
  });
  it('associates and dissociates originals without changing their audience or initial receipt', () => {
    const { app, db, upload, bytes } = setup(); const saved = upload(); const request = associate(saved.document_id);
    const initialReceipt = db.prepare('SELECT receipt_json FROM authority_person_document_receipts_v1 WHERE request_id=?').get(saved.request_id);
    const receipt = app.associate('owner', request);
    expect(receipt).toEqual({ schema_version: 1, kind: 'echo-person-document-association-receipt-v1', request_id: request.request_id, document_id: saved.document_id, project_id: PROJECT_ALPHA, operation: 'associate', received_at: PROJECT_CONTEXT_NOW, state: 'applied' });
    expect(app.associate('owner', request)).toEqual(receipt);
    expect(app.read('member', saved.document_id)).toMatchObject({ project_id: PROJECT_ALPHA, audience: { kind: 'team' } });
    expect(app.search('member', search(PROJECT_ALPHA)).documents.map(x => x.document_id)).toEqual([saved.document_id]);
    expect(() => app.associate('owner', associate(saved.document_id, PROJECT_BETA))).toThrow(expect.objectContaining({ code: 'conflict' }));
    const removed = app.dissociate('owner', dissociate(request)); expect(removed.operation).toBe('dissociate');
    expect(app.search('member', search(PROJECT_ALPHA)).documents).toEqual([]);
    expect(app.read('member', saved.document_id)).toMatchObject({ project_id: null, audience: { kind: 'team' } });
    expect(app.original('member', saved.document_id).bytes).toEqual(bytes);
    app.associate('owner', associate(saved.document_id, PROJECT_BETA));
    expect(app.read('owner', saved.document_id).project_id).toBe(PROJECT_BETA);
    expect(db.prepare('SELECT receipt_json FROM authority_person_document_receipts_v1 WHERE request_id=?').get(saved.request_id)).toEqual(initialReceipt);
    expect(db.prepare('SELECT project_id,audience_kind FROM authority_person_documents_v1 WHERE document_id=?').get(saved.document_id)).toEqual({ project_id: null, audience_kind: 'team' });
  });
  it('keeps associated private content private and checks uploader, current grants and readable audience', () => {
    const { app, upload } = setup(); const privateDoc = upload('owner', { audience: { kind: 'only_me' } });
    app.associate('owner', associate(privateDoc.document_id));
    expect(app.search('member', search(PROJECT_ALPHA)).documents).toEqual([]);
    expect(() => app.dissociate('member', dissociate(associate(privateDoc.document_id)))).toThrow(expect.objectContaining({ code: 'not_found' }));
    const memberPrivate = upload('member', { audience: { kind: 'only_me' } });
    app.associate('member', associate(memberPrivate.document_id));
    expect(() => app.read('owner', memberPrivate.document_id)).toThrow(expect.objectContaining({ code: 'not_found' }));
    expect(() => app.dissociate('owner', dissociate(associate(memberPrivate.document_id)))).toThrow(expect.objectContaining({ code: 'not_found' }));
    const team = upload();
    expect(() => app.associate('member', associate(team.document_id))).toThrow(expect.objectContaining({ code: 'not_found' }));
    const owned = upload('member');
    expect(() => app.associate('member', associate(owned.document_id, PROJECT_BETA))).toThrow(expect.objectContaining({ code: 'not_found' }));
    app.associate('member', associate(owned.document_id));
    expect(app.dissociate('owner', dissociate(associate(owned.document_id))).state).toBe('applied');
  });
  it('lets an uploader unlink a team document after leaving the associated project', () => {
    const { app, db, upload } = setup(); const saved = upload('member'); const attached = associate(saved.document_id);
    app.associate('member', attached);
    db.prepare(`UPDATE authority_project_memberships_v1 SET status='revoked',revoked_at=? WHERE membership_id=? AND project_id=?`).run(PROJECT_CONTEXT_NOW, MEMBER.membership_id, PROJECT_ALPHA);
    expect(app.dissociate('member', dissociate(attached))).toMatchObject({ operation: 'dissociate', state: 'applied' });
    expect(app.search('owner', search(PROJECT_ALPHA)).documents).toEqual([]);
  });
  it('replays only the same actor tenure minimal receipt after project removal, never a changed command', () => {
    const { app, db, upload } = setup(); const saved = upload('member', { audience: { kind: 'project', project_id: PROJECT_ALPHA } }); const request = associate(saved.document_id);
    const receipt = app.associate('member', request);
    db.prepare(`UPDATE authority_project_memberships_v1 SET status='revoked',revoked_at=? WHERE membership_id=? AND project_id=?`).run(PROJECT_CONTEXT_NOW, MEMBER.membership_id, PROJECT_ALPHA);
    expect(app.associate('member', request)).toEqual(receipt);
    expect(() => app.associate('member', { ...request, project_id: PROJECT_BETA })).toThrow(expect.objectContaining({ code: 'conflict' }));
    expect(() => app.dissociate('member', { ...request, kind: 'echo-person-document-dissociate-v1' })).toThrow(expect.objectContaining({ code: 'conflict' }));
    expect(() => app.read('member', saved.document_id)).toThrow(expect.objectContaining({ code: 'not_found' }));
    revokeMembership(db, MEMBER); addMembership(db, RETURNED_MEMBER, 'Returned', 'member@example.test'); grant(db, PROJECT_ALPHA, RETURNED_MEMBER, 'member');
    expect(() => app.associate('member', request)).toThrow(expect.objectContaining({ code: 'unauthorized' }));
    expect(() => app.associate('returned', request)).toThrow(expect.objectContaining({ code: 'not_found' }));
  });
  it('rolls back association and receipt if authentication changes before commit', () => {
    const { repository, db, upload } = setup(); const saved = upload();
    expect(() => repository.associate(authorization(OWNER), associate(saved.document_id), () => authorization(OWNER, { session_state_sha256: canonicalSha256('changed') }))).toThrow(expect.objectContaining({ code: 'stale_access_state' }));
    expect(db.prepare('SELECT count(*) n FROM authority_person_document_associations_v1').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) n FROM authority_person_document_association_receipts_v1').get()).toEqual({ n: 0 });
    expect(() => repository.associate(authorization(OWNER), associate(saved.document_id), () => {
      db.prepare(`UPDATE authority_project_memberships_v1 SET role='member' WHERE membership_id=? AND project_id=? AND status='active'`).run(OWNER.membership_id, PROJECT_ALPHA);
      return authorization(OWNER);
    })).toThrow(expect.objectContaining({ code: 'stale_access_state' }));
    expect(db.prepare('SELECT count(*) n FROM authority_person_document_associations_v1').get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT role FROM authority_project_memberships_v1 WHERE membership_id=? AND project_id=? AND status='active'`).get(OWNER.membership_id, PROJECT_ALPHA)).toEqual({ role: 'lead' });
    db.exec(`CREATE TRIGGER fail_document_association_receipt BEFORE INSERT ON authority_person_document_association_receipts_v1 BEGIN SELECT RAISE(ABORT,'receipt write failed'); END;`);
    expect(() => repository.associate(authorization(OWNER), associate(saved.document_id), () => authorization(OWNER))).toThrow('receipt write failed');
    expect(db.prepare('SELECT count(*) n FROM authority_person_document_associations_v1').get()).toEqual({ n: 0 });
  });
  it('shares request identities with document uploads and project commands in both directions and with retained legacy uploads', () => {
    const { app, db, upload, bytes } = setup(); const saved = upload();
    const projects = createProjectContextApplicationV1({ authenticate: () => authorization(OWNER), repository: new SqliteProjectContextRepositoryV1(db, () => PROJECT_CONTEXT_NOW) });
    const create = (request_id: string) => projects.createProject('owner', { schema_version: 1, kind: 'echo-project-create-v1', request_id, name: 'Shared namespace' });
    const text = (request_id: string) => insertLegacyTextV1(db, OWNER, { request_id, title: 'Legacy', text: 'text', visibility: 'team' });
    expect(() => app.associate('owner', { ...associate(saved.document_id), request_id: saved.request_id })).toThrow(expect.objectContaining({ code: 'conflict' }));
    const projectRequest = randomUUID(); create(projectRequest); expect(() => app.associate('owner', { ...associate(saved.document_id), request_id: projectRequest })).toThrow(expect.objectContaining({ code: 'conflict' }));
    const textRequest = randomUUID(); text(textRequest); expect(() => app.associate('owner', { ...associate(saved.document_id), request_id: textRequest })).toThrow(expect.objectContaining({ code: 'conflict' }));
    const request = associate(saved.document_id); app.associate('owner', request);
    expect(() => create(request.request_id)).toThrow(expect.objectContaining({ code: 'conflict' }));
    expect(() => app.upload('owner', { schema_version: 1, kind: 'echo-person-document-upload-v1', request_id: request.request_id, filename: 'SCOUT.md', title: 'SCOUT', content_length: bytes.length, sha256: sha256Digest(bytes), audience: { kind: 'team' }, project_id: null }, bytes)).toThrow(expect.objectContaining({ code: 'conflict' }));
  });
});
