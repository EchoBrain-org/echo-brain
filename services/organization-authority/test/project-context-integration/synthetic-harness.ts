import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { applyAuthorityBaselineV9 } from '@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/baseline';
import {
  validatePersonUpdateSubmitV2,
  type PersonUpdateSubmitV2, type PersonUploadAudienceV2, type ProjectIdV1,
} from '@echo-brain/organization-api';
import type { AuthorityPersonMembershipBinding } from '@echo-brain/organization-authority-kernel/application/ports/authority-repository';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';
import { SqliteProjectContextRepositoryV1 } from '../../src/adapters/persistence/sqlite/project-context-v1.js';
import { SqliteProjectUploadEnrichmentAuthorizationV1 } from '../../src/adapters/persistence/sqlite/project-upload-enrichment-v1.js';
import type {
  ProjectAuthorizationScopeV1, ProjectAuthorizationSnapshotV1,
  ProjectContextReadTransactionV1, ProjectReadResponseV1,
} from '../../src/application/ports/project-context-v1.js';
import { addMembership, authorization, PROJECT_CONTEXT_NOW } from '../fixtures/project-context-sqlite.js';
import { PEOPLE, SCENARIO } from '../../../../tests/fixtures/project-context-integration/scenario.js';

export { PEOPLE };

function scenarioDatabase(path: string): Database.Database {
  const database = new Database(path);
  database.pragma('foreign_keys = ON');
  applyAuthorityBaselineV9(database);
  database.prepare(`INSERT INTO authority_metadata
    (singleton, authority_id, organization_id, organization_display_name, descriptor_json, created_at, last_observed_at)
    VALUES (1, 'oau_00000000-0000-4000-8000-000000000006', ?, 'PC06 synthetic', '{}', ?, ?)`)
    .run(PEOPLE.alice.organization_id, PROJECT_CONTEXT_NOW, PROJECT_CONTEXT_NOW);
  database.prepare('INSERT INTO authority_project_authorization_state_v1 (organization_id, revision, updated_at) VALUES (?, 0, ?)')
    .run(PEOPLE.alice.organization_id, PROJECT_CONTEXT_NOW);
  return database;
}

/**
 * PC-01 SQLite + frozen codecs are real. Person authentication, delivery, and
 * worker completion are explicitly synthetic seams, not PC-02/03/04/05 code.
 * No HTTP server, scheduler, provider, installed client or host is started.
 */
export class SyntheticProjectHarness {
  readonly root = mkdtempSync(join(tmpdir(), 'echo-pc06-'));
  readonly path = join(this.root, 'authority.sqlite');
  database: Database.Database = scenarioDatabase(this.path);
  repository = new SqliteProjectContextRepositoryV1(this.database, () => PROJECT_CONTEXT_NOW);
  eligibility = new SqliteProjectUploadEnrichmentAuthorizationV1(this.database);
  private sequence = 0;

  constructor() {
    for (const [name, person] of Object.entries(PEOPLE)) {
      addMembership(this.database, person, name, `${name}@example.test`);
    }
  }

  requestId(): string { return `00000000-0000-4000-8000-${String(++this.sequence).padStart(12, '0')}`; }

  restart(): void {
    this.database.close();
    this.database = new Database(this.path);
    this.database.pragma('foreign_keys = ON');
    this.repository = new SqliteProjectContextRepositoryV1(this.database, () => PROJECT_CONTEXT_NOW);
    this.eligibility = new SqliteProjectUploadEnrichmentAuthorizationV1(this.database);
  }

  close(): void {
    if (this.database.open) this.database.close();
    rmSync(this.root, { recursive: true, force: true });
  }

  create(name: string, actor = PEOPLE.alice) {
    const request = { schema_version: 1 as const, kind: 'echo-project-create-v1' as const, request_id: this.requestId(), name };
    return this.repository.withWriteTransaction(tx => tx.createProject(
      tx.captureAuthorization(authorization(actor), { operation: 'create', request }), request,
    )).project_id;
  }

  draft(project_id: ProjectIdV1 | null, audience: PersonUploadAudienceV2, original = SCENARIO.originals.team as { title: string; text: string }): PersonUpdateSubmitV2 {
    return validatePersonUpdateSubmitV2({ schema_version: 2, kind: 'echo-person-update-submit-v2', request_id: this.requestId(), ...original, project_id, audience });
  }

  submit(input: unknown, actor = PEOPLE.alice) {
    const request = validatePersonUpdateSubmitV2(input);
    return this.repository.withWriteTransaction(tx => tx.submitUpload(
      tx.captureAuthorization(authorization(actor), { operation: 'upload_submit', request }), request,
    ));
  }

  read<T extends ProjectReadResponseV1>(
    actor: AuthorityPersonMembershipBinding,
    scope: ProjectAuthorizationScopeV1,
    select: (tx: ProjectContextReadTransactionV1, snapshot: ProjectAuthorizationSnapshotV1) => T,
    beforeRelease: () => void = () => {},
    currentActor: () => PersonAccessAuthorization = () => authorization(actor),
  ): T {
    return this.repository.withReadTransaction(tx => {
      const snapshot = tx.captureAuthorization(authorization(actor), scope);
      const selected = select(tx, snapshot);
      beforeRelease();
      return tx.revalidateAndAuditRelease(snapshot, currentActor(), selected);
    });
  }

  original(actor: AuthorityPersonMembershipBinding, context_id: string, project_id?: ProjectIdV1) {
    return project_id === undefined
      ? this.read(actor, { operation: 'upload_read', context_id }, (tx, scope) => tx.readUpload(scope, context_id))
      : this.read(actor, { operation: 'context_read', context_id, project_id }, (tx, scope) => tx.readContext(scope, project_id, context_id));
  }

  /** Fault seam only: models PC-02's future atomic eligibility/commit binding. */
  async enrich(contextId: string, model: (source: { title: string; text: string }) => Promise<string>): Promise<'ready' | 'unavailable' | 'ineligible'> {
    const snapshot = this.eligibility.capture(contextId);
    if (!snapshot) return 'ineligible';
    const source = this.original(snapshot.uploader, contextId);
    this.database.prepare("UPDATE authority_person_update_work_v2 SET state = 'processing', attempts = attempts + 1 WHERE context_id = ?").run(contextId);
    try {
      const hints = await model({ title: source.title, text: source.text });
      this.database.transaction(() => {
        this.eligibility.assertCurrent(snapshot);
        this.database.prepare("UPDATE authority_person_update_work_v2 SET state = 'ready', search_hints = ?, enrichment_sha256 = ? WHERE context_id = ?")
          .run(hints, canonicalSha256(hints), contextId);
      })();
      return 'ready';
    } catch {
      this.database.prepare("UPDATE authority_person_update_work_v2 SET state = 'unavailable', search_hints = '', enrichment_sha256 = NULL WHERE context_id = ?").run(contextId);
      return 'unavailable';
    }
  }
}
