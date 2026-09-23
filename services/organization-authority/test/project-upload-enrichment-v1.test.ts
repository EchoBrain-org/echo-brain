import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { SqliteProjectUploadEnrichmentAuthorizationV1 } from '../src/adapters/persistence/sqlite/project-upload-enrichment-v1.js';
import type { ProjectUploadEnrichmentSnapshotV1 } from '../src/application/ports/project-context-v1.js';
import {
  MEMBER,
  OWNER,
  PROJECT_ALPHA,
  PROJECT_BETA,
  PROJECT_CONTEXT_NOW,
  addMembership,
  projectContextDatabase,
  revokeMembership,
} from './fixtures/project-context-sqlite.js';

const databases: Database.Database[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) if (database.open) database.close();
});

const CONTEXT = `ctx_${'a'.repeat(64)}`;
const REJOINED_OWNER = {
  ...OWNER,
  membership_id: 'mem_33333333-3333-4333-8333-333333333333',
} as const;

function open(): Database.Database {
  const database = projectContextDatabase();
  databases.push(database);
  return database;
}

function addProject(database: Database.Database, projectId: string = PROJECT_ALPHA): void {
  database.prepare(`
    INSERT INTO authority_projects_v1
      (project_id, organization_id, name, created_at, creator_principal_id, creator_membership_id, creator_membership_type)
    VALUES (?, ?, 'Project', ?, ?, ?, ?)
  `).run(projectId, OWNER.organization_id, PROJECT_CONTEXT_NOW, OWNER.principal_id, OWNER.membership_id, OWNER.membership_type);
}

function grantProjectMembership(
  database: Database.Database,
  projectId: string,
  actor = OWNER,
  id = 'pgm_11111111-1111-4111-8111-111111111111',
): void {
  database.prepare(`
    INSERT INTO authority_project_memberships_v1
      (project_membership_id, project_id, organization_id, principal_id, membership_id, membership_type, role, status, granted_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, 'member', 'active', ?, NULL)
  `).run(id, projectId, actor.organization_id, actor.principal_id, actor.membership_id, actor.membership_type, PROJECT_CONTEXT_NOW);
}

function addUpload(
  database: Database.Database,
  audience: 'only_me' | 'team' | 'project',
  audienceProjectId: string | null = null,
): void {
  database.prepare(`
    INSERT INTO authority_person_updates_v2
      (organization_id, principal_id, membership_id, membership_type, request_id, request_version, context_id, payload_sha256,
       title, text, audience_kind, audience_project_id, audience_project_ids_json, submitted_association_project_ids_json, project_id, received_at)
    VALUES (?, ?, ?, ?, '00000000-0000-4000-8000-000000000001', 2, ?, 'sha256:${'a'.repeat(64)}',
            'Original', 'The original body is immutable.', ?, ?, ?, '[]', NULL, ?)
  `).run(OWNER.organization_id, OWNER.principal_id, OWNER.membership_id, OWNER.membership_type, CONTEXT, audience, audienceProjectId, audienceProjectId === null ? '[]' : JSON.stringify([audienceProjectId]), PROJECT_CONTEXT_NOW);
}
function addProjectsAudienceUpload(database: Database.Database, projectIds: readonly string[]): void {
  database.prepare(`
    INSERT INTO authority_person_updates_v2
      (organization_id, principal_id, membership_id, membership_type, request_id, request_version, context_id, payload_sha256,
       title, text, audience_kind, audience_project_id, audience_project_ids_json, submitted_association_project_ids_json, project_id, received_at)
    VALUES (?, ?, ?, ?, '00000000-0000-4000-8000-000000000001', 3, ?, 'sha256:${'a'.repeat(64)}',
            'Original', 'The original body is immutable.', 'projects', NULL, ?, '[]', NULL, ?)
  `).run(OWNER.organization_id, OWNER.principal_id, OWNER.membership_id, OWNER.membership_type, CONTEXT, JSON.stringify(projectIds), PROJECT_CONTEXT_NOW);
}

function expectDenied(action: () => void): void {
  expect(action).toThrow(expect.objectContaining<Partial<AuthorityOperationError>>({ code: 'unauthorized' }));
}

describe('SQLite project upload enrichment authorization V1', () => {
  it('pins every immutable projects-audience grant and fails closed if any one is revoked', () => {
    const database = open();
    addProject(database, PROJECT_ALPHA); addProject(database, PROJECT_BETA);
    grantProjectMembership(database, PROJECT_ALPHA, OWNER, 'pgm_11111111-1111-4111-8111-111111111111');
    grantProjectMembership(database, PROJECT_BETA, OWNER, 'pgm_22222222-2222-4222-8222-222222222222');
    addProjectsAudienceUpload(database, [PROJECT_ALPHA, PROJECT_BETA]);
    const authorization = new SqliteProjectUploadEnrichmentAuthorizationV1(database);
    const snapshot = authorization.capture(CONTEXT)!;
    expect(snapshot).toMatchObject({ context_id: CONTEXT, uploader: OWNER });
    database.prepare("UPDATE authority_project_memberships_v1 SET status = 'revoked', revoked_at = ? WHERE project_id = ? AND membership_id = ?")
      .run(PROJECT_CONTEXT_NOW, PROJECT_BETA, OWNER.membership_id);
    expectDenied(() => authorization.assertCurrent(snapshot));
  });
  it('captures the active uploader tenure and exact project-audience grant', () => {
    const database = open();
    addProject(database); grantProjectMembership(database, PROJECT_ALPHA); addUpload(database, 'project', PROJECT_ALPHA);
    const authorization = new SqliteProjectUploadEnrichmentAuthorizationV1(database);

    const snapshot = authorization.capture(CONTEXT);
    expect(snapshot).toMatchObject({ context_id: CONTEXT, uploader: OWNER });
    expect(snapshot?.authorization_sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(() => authorization.assertCurrent(snapshot!)).not.toThrow();
  });

  it('fails closed when a project-audience grant is revoked after capture without changing the original', () => {
    const database = open();
    addProject(database); grantProjectMembership(database, PROJECT_ALPHA); addUpload(database, 'project', PROJECT_ALPHA);
    const authorization = new SqliteProjectUploadEnrichmentAuthorizationV1(database);
    const snapshot = authorization.capture(CONTEXT)!;
    const original = database.prepare('SELECT text, audience_kind, audience_project_id FROM authority_person_updates_v2 WHERE context_id = ?').get(CONTEXT);

    database.prepare(`UPDATE authority_project_memberships_v1 SET status = 'revoked', revoked_at = ? WHERE project_id = ? AND membership_id = ?`)
      .run(PROJECT_CONTEXT_NOW, PROJECT_ALPHA, OWNER.membership_id);
    expect(authorization.capture(CONTEXT)).toBeUndefined();
    expectDenied(() => authorization.assertCurrent(snapshot));
    expect(database.prepare('SELECT text, audience_kind, audience_project_id FROM authority_person_updates_v2 WHERE context_id = ?').get(CONTEXT)).toEqual(original);
  });

  it('does not treat a same-principal rejoin as the uploader tenure or its project grant', () => {
    const database = open();
    addProject(database); grantProjectMembership(database, PROJECT_ALPHA); addUpload(database, 'project', PROJECT_ALPHA);
    const authorization = new SqliteProjectUploadEnrichmentAuthorizationV1(database);
    const snapshot = authorization.capture(CONTEXT)!;

    revokeMembership(database, OWNER);
    addMembership(database, REJOINED_OWNER, 'Owner returned', null);
    grantProjectMembership(database, PROJECT_ALPHA, REJOINED_OWNER, 'pgm_22222222-2222-4222-8222-222222222222');

    expect(authorization.capture(CONTEXT)).toBeUndefined();
    expectDenied(() => authorization.assertCurrent(snapshot));
  });

  it('rejects a stale project grant even when the same uploader tenure is granted again', () => {
    const database = open();
    addProject(database); grantProjectMembership(database, PROJECT_ALPHA); addUpload(database, 'project', PROJECT_ALPHA);
    const authorization = new SqliteProjectUploadEnrichmentAuthorizationV1(database);
    const stale = authorization.capture(CONTEXT)!;

    database.prepare(`UPDATE authority_project_memberships_v1 SET status = 'revoked', revoked_at = ? WHERE project_id = ? AND membership_id = ?`)
      .run(PROJECT_CONTEXT_NOW, PROJECT_ALPHA, OWNER.membership_id);
    grantProjectMembership(database, PROJECT_ALPHA, OWNER, 'pgm_33333333-3333-4333-8333-333333333333');

    expectDenied(() => authorization.assertCurrent(stale));
    expect(() => authorization.assertCurrent(authorization.capture(CONTEXT)!)).not.toThrow();
  });

  it('does not invalidate an eligible project upload for an unrelated project-role change', () => {
    const database = open();
    addProject(database); grantProjectMembership(database, PROJECT_ALPHA); addUpload(database, 'project', PROJECT_ALPHA);
    const authorization = new SqliteProjectUploadEnrichmentAuthorizationV1(database);
    const snapshot = authorization.capture(CONTEXT)!;

    database.prepare(`UPDATE authority_project_memberships_v1 SET role = 'lead' WHERE project_id = ? AND membership_id = ?`)
      .run(PROJECT_ALPHA, OWNER.membership_id);
    expect(() => authorization.assertCurrent(snapshot)).not.toThrow();
  });

  it('freezes and issues snapshots, rejecting copies or forged identity/digest', () => {
    const database = open();
    addProject(database); grantProjectMembership(database, PROJECT_ALPHA); addUpload(database, 'project', PROJECT_ALPHA);
    const authorization = new SqliteProjectUploadEnrichmentAuthorizationV1(database);
    const snapshot = authorization.capture(CONTEXT)!;
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.uploader)).toBe(true);
    expect(() => { (snapshot.uploader as { membership_id: string }).membership_id = MEMBER.membership_id; }).toThrow();

    const copied: ProjectUploadEnrichmentSnapshotV1 = { ...snapshot };
    const forgedDigest: ProjectUploadEnrichmentSnapshotV1 = { ...snapshot, authorization_sha256: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' };
    const forgedUploader: ProjectUploadEnrichmentSnapshotV1 = { ...snapshot, uploader: MEMBER };
    expectDenied(() => authorization.assertCurrent(copied));
    expectDenied(() => authorization.assertCurrent(forgedDigest));
    expectDenied(() => authorization.assertCurrent(forgedUploader));
  });

  it.each(['only_me', 'team'] as const)('keeps %s eligibility independent from association and unrelated project grants', audience => {
    const database = open();
    addProject(database, PROJECT_ALPHA); addProject(database, PROJECT_BETA);
    grantProjectMembership(database, PROJECT_ALPHA); addUpload(database, audience);
    const authorization = new SqliteProjectUploadEnrichmentAuthorizationV1(database);
    const snapshot = authorization.capture(CONTEXT)!;

    database.prepare(`
      INSERT INTO authority_project_context_associations_v1
        (context_id, project_id, organization_id, associator_principal_id, associator_membership_id, associator_membership_type, associated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(CONTEXT, PROJECT_BETA, OWNER.organization_id, OWNER.principal_id, OWNER.membership_id, OWNER.membership_type, PROJECT_CONTEXT_NOW);
    database.prepare(`UPDATE authority_project_memberships_v1 SET status = 'revoked', revoked_at = ? WHERE project_id = ? AND membership_id = ?`)
      .run(PROJECT_CONTEXT_NOW, PROJECT_ALPHA, OWNER.membership_id);

    expect(() => authorization.assertCurrent(snapshot)).not.toThrow();
  });

  it.each(['only_me', 'team'] as const)('fails closed for %s when the uploader organization tenure is revoked', audience => {
    const database = open();
    addUpload(database, audience);
    const authorization = new SqliteProjectUploadEnrichmentAuthorizationV1(database);
    const snapshot = authorization.capture(CONTEXT)!;

    revokeMembership(database, OWNER);
    expect(authorization.capture(CONTEXT)).toBeUndefined();
    expectDenied(() => authorization.assertCurrent(snapshot));
  });

  it('does not authorize missing, V1, wrong-version, or foreign-key-disabled state as a V2 enrichment source', () => {
    const database = open();
    const authorization = new SqliteProjectUploadEnrichmentAuthorizationV1(database);
    expect(authorization.capture(CONTEXT)).toBeUndefined();
    database.pragma('user_version = 6');
    expect(() => new SqliteProjectUploadEnrichmentAuthorizationV1(database)).toThrow('V9');
    database.pragma('user_version = 9');
    database.pragma('foreign_keys = OFF');
    expect(() => new SqliteProjectUploadEnrichmentAuthorizationV1(database)).toThrow('foreign keys');
  });
});
