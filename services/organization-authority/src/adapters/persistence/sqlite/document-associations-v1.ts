import type Database from 'better-sqlite3';
import { canonicalJson, canonicalSha256 } from '@echo-brain/federation-protocol';
import {
  validatePersonDocumentAssociateV1, validatePersonDocumentDissociateV1, validatePersonDocumentAssociationReceiptV1,
  type PersonDocumentAssociateV1, type PersonDocumentDissociateV1, type PersonDocumentAssociationReceiptV1,
} from '@echo-brain/organization-api';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';
import type { PersonDocumentAssociationRepositoryV1 } from '../../../application/ports/document-associations-v1.js';
import { assertPersonRequestNamespaceV1 } from './person-request-namespace-v1.js';

type AssociationRequest = PersonDocumentAssociateV1 | PersonDocumentDissociateV1;
type Operation = PersonDocumentAssociationReceiptV1['operation'];
type Grant = { project_id: string; project_membership_id: string; role: string };
type Document = { request_version: 1 | 2; document_id: string; principal_id: string; membership_id: string; membership_type: string; audience_kind: string; audience_project_id: string | null };
function fail(code: 'invalid_request' | 'not_found' | 'unauthorized' | 'conflict' | 'stale_access_state' | 'invalid_output' = 'not_found'): never {
  throw new AuthorityOperationError(code, 'Document association request failed');
}
function identity(actor: PersonAccessAuthorization): string {
  const { checked_at: _checked, ...binding } = actor; return canonicalJson(binding);
}

/** Mutates only the project relationship; original custody and audience are immutable. */
export class SqlitePersonDocumentAssociationRepositoryV1 implements PersonDocumentAssociationRepositoryV1 {
  constructor(private readonly database: Database.Database, private readonly now: () => string = () => new Date().toISOString()) {}
  associate(actor: PersonAccessAuthorization, request: PersonDocumentAssociateV1, reauthenticate: () => PersonAccessAuthorization): PersonDocumentAssociationReceiptV1 {
    return this.mutate(actor, 'associate', request, reauthenticate);
  }
  dissociate(actor: PersonAccessAuthorization, request: PersonDocumentDissociateV1, reauthenticate: () => PersonAccessAuthorization): PersonDocumentAssociationReceiptV1 {
    return this.mutate(actor, 'dissociate', request, reauthenticate);
  }
  private grants(actor: PersonAccessAuthorization): readonly Grant[] {
    const active = this.database.prepare(`SELECT 1 FROM authority_memberships WHERE organization_id=? AND principal_id=? AND membership_id=? AND membership_type=? AND status='active'`).get(actor.organization_id, actor.principal_id, actor.membership_id, actor.membership_type);
    if (!active) fail('unauthorized');
    return this.database.prepare(`SELECT project_id,project_membership_id,role FROM authority_project_memberships_v1 WHERE organization_id=? AND principal_id=? AND membership_id=? AND membership_type=? AND status='active' ORDER BY project_id,project_membership_id`).all(actor.organization_id, actor.principal_id, actor.membership_id, actor.membership_type) as Grant[];
  }
  private transaction<T>(operation: () => T): T {
    if (this.database.inTransaction) throw new Error('Document association transaction is not reentrant');
    this.database.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.database.exec('COMMIT'); return result; }
    catch (error) { try { this.database.exec('ROLLBACK'); } catch {} throw error; }
  }
  private relationships(documentId: string): readonly string[] {
    return (this.database.prepare('SELECT project_id FROM authority_person_document_associations_v1 WHERE document_id=? ORDER BY project_id').all(documentId) as { project_id: string }[]).map(row => row.project_id);
  }
  private authorizationRevision(organizationId: string): number {
    const state = this.database.prepare('SELECT revision FROM authority_project_authorization_state_v1 WHERE organization_id=?').get(organizationId) as { revision: number } | undefined;
    if (!state) fail('stale_access_state');
    return state.revision;
  }
  private mutate(actor: PersonAccessAuthorization, operation: Operation, input: AssociationRequest, reauthenticate: () => PersonAccessAuthorization): PersonDocumentAssociationReceiptV1 {
    let request: AssociationRequest;
    try { request = operation === 'associate' ? validatePersonDocumentAssociateV1(input) : validatePersonDocumentDissociateV1(input); }
    catch { return fail('invalid_request'); }
    return this.transaction(() => {
      const grants = this.grants(actor);
      assertPersonRequestNamespaceV1(this.database, actor, request.request_id, 'document_association');
      const command = canonicalSha256({ schema_version: 1, kind: 'echo-person-document-association-command-v1',
        actor: { organization_id: actor.organization_id, principal_id: actor.principal_id, membership_id: actor.membership_id, membership_type: actor.membership_type }, operation, request });
      const prior = this.database.prepare(`SELECT principal_id,membership_type,operation,command_sha256,receipt_json,receipt_sha256 FROM authority_person_document_association_receipts_v1 WHERE organization_id=? AND membership_id=? AND request_id=?`).get(actor.organization_id, actor.membership_id, request.request_id) as { principal_id: string; membership_type: string; operation: string; command_sha256: string; receipt_json: string; receipt_sha256: string } | undefined;
      let result: PersonDocumentAssociationReceiptV1;
      if (prior) {
        if (prior.principal_id !== actor.principal_id || prior.membership_type !== actor.membership_type || prior.operation !== operation || prior.command_sha256 !== command) fail('conflict');
        try {
          const decoded: unknown = JSON.parse(prior.receipt_json);
          if (canonicalSha256(decoded) !== prior.receipt_sha256) fail('invalid_output');
          result = validatePersonDocumentAssociationReceiptV1(decoded);
          if (result.request_id !== request.request_id || result.document_id !== request.document_id || result.project_id !== request.project_id || result.operation !== operation) fail('invalid_output');
        } catch { return fail('invalid_output'); }
      } else {
        const document = this.database.prepare('SELECT request_version,document_id,principal_id,membership_id,membership_type,audience_kind,audience_project_id FROM authority_person_documents_v1 WHERE organization_id=? AND document_id=?').get(actor.organization_id, request.document_id) as Document | undefined;
        if (!document) fail();
        const uploader = document.principal_id === actor.principal_id && document.membership_id === actor.membership_id && document.membership_type === actor.membership_type;
        const readable = document.audience_kind === 'team' || (document.audience_kind === 'only_me' && uploader) || (document.audience_kind === 'project' && grants.some(grant => grant.project_id === document.audience_project_id)) ||
          (document.audience_kind === 'projects' && grants.some(grant => this.database.prepare('SELECT 1 FROM authority_person_document_audience_projects_v1 WHERE document_id=? AND project_id=? AND organization_id=?').get(document.document_id, grant.project_id, actor.organization_id) !== undefined));
        if (!readable) fail();
        const existing = this.relationships(request.document_id);
        if (operation === 'associate') {
          if (!grants.some(grant => grant.project_id === request.project_id)) fail();
          if (!uploader) fail();
          if (document.request_version === 1 && existing.some(id => id !== request.project_id)) fail('conflict');
          if (!existing.includes(request.project_id) && existing.length >= 20) fail('conflict');
          if (!existing.includes(request.project_id)) this.database.prepare('INSERT INTO authority_person_document_associations_v1(document_id,project_id,organization_id,associated_at) VALUES (?,?,?,?)').run(request.document_id, request.project_id, actor.organization_id, this.now());
        } else {
          if (!uploader && !grants.some(grant => grant.project_id === request.project_id && grant.role === 'lead')) fail();
          if (document.request_version === 1 && existing.some(id => id !== request.project_id)) fail();
          if (existing.includes(request.project_id)) this.database.prepare('DELETE FROM authority_person_document_associations_v1 WHERE document_id=? AND project_id=?').run(request.document_id, request.project_id);
        }
        result = validatePersonDocumentAssociationReceiptV1({ schema_version: 1, kind: 'echo-person-document-association-receipt-v1', request_id: request.request_id, document_id: request.document_id, project_id: request.project_id, operation, received_at: this.now(), state: 'applied' });
        this.database.prepare(`INSERT INTO authority_person_document_association_receipts_v1(organization_id,principal_id,membership_id,membership_type,request_id,operation,command_sha256,receipt_json,receipt_sha256,committed_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(actor.organization_id, actor.principal_id, actor.membership_id, actor.membership_type, request.request_id, operation, command, canonicalJson(result), canonicalSha256(result), result.received_at);
      }
      const relationships = canonicalJson(this.relationships(request.document_id));
      const revision = this.authorizationRevision(actor.organization_id);
      const current = reauthenticate();
      if (identity(current) !== identity(actor) || canonicalSha256(this.grants(current)) !== canonicalSha256(grants) ||
          this.authorizationRevision(actor.organization_id) !== revision || canonicalJson(this.relationships(request.document_id)) !== relationships) fail('stale_access_state');
      return Object.freeze(result);
    });
  }
}
