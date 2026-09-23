import { assertPersonDocumentCapacityV1 } from './document-quota-v1.js';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { canonicalJson, canonicalSha256, type Sha256Digest } from '@echo-brain/federation-protocol';
import {
  validatePersonUpdateReceiptV2, validatePersonUpdateStatusV2, validatePersonUpdateSubmitV2,
  validatePersonUploadContentV2, validatePersonUploadContextId, validatePersonUploadSearchResultV2,
  validatePersonUploadSearchV2, validatePersonUpdateRequestId,
  validateProjectContextFeedV1, validateProjectContextReadV1, validateProjectContextSearchResultV1,
  validateProjectCreateReceiptV1, validateProjectListV1, validateProjectMembersV1,
  validateProjectContextBrowseV1, validateProjectContextSearchV1, validateProjectDirectorySearchV1,
  validateProjectDirectoryV1, validateProjectIdV1, validateProjectMutationReceiptV1,
  validateProjectPageRequestV1, validateProjectSummaryV1,
  type PersonUpdateReceiptV2, type PersonUpdateStatusV2, type PersonUpdateSubmitV2,
  type PersonUploadContentV2, type PersonUploadSearchV2, type PersonUploadSearchResultV2,
  type ProjectContextAssociateV1, type ProjectContextBrowseV1, type ProjectContextDissociateV1,
  type ProjectContextFeedV1, type ProjectContextReadV1, type ProjectContextSearchResultV1,
  type ProjectContextSearchV1, type ProjectCreateReceiptV1, type ProjectCreateV1,
  type ProjectDirectorySearchV1, type ProjectDirectoryV1, type ProjectIdV1, type ProjectListV1,
  type ProjectMembersV1, type ProjectMemberRemoveV1, type ProjectMemberSetV1,
  type ProjectMutationReceiptV1, type ProjectPageRequestV1, type ProjectRoleV1, type ProjectSummaryV1,
} from '@echo-brain/organization-api';
import type { AuthorityPersonMembershipBinding } from '@echo-brain/organization-authority-kernel/application/ports/authority-repository';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { projectCommandIdentityV1 } from '../../../application/project-context-command-v1.js';
import { assertPersonRequestNamespaceV1 } from './person-request-namespace-v1.js';
import type {
  ProjectAuthorizationScopeV1, ProjectAuthorizationSnapshotV1, ProjectContextReadTransactionV1,
  ProjectContextRepositoryV1, ProjectContextWriteTransactionV1, ProjectMembershipGrantV1,
  ProjectMutationV1, ProjectReadOperationV1, ProjectReadResponseV1,
} from '../../../application/ports/project-context-v1.js';
import {
  decodeProjectCursorV1, encodeProjectCursorV1, normalizeProjectSearchQueryV1,
  projectSearchTermsV1, type ProjectCursorScopeV1,
} from './project-context-cursor-v1.js';

type ProjectRow = {
  project_id: ProjectIdV1; organization_id: string; name: string; created_at: string;
  role: ProjectRoleV1;
};
type SourceRow = AuthorityPersonMembershipBinding & {
  request_id: string; context_id: string; payload_sha256: Sha256Digest; title: string; text: string;
  audience_kind: 'only_me' | 'team' | 'project'; audience_project_id: ProjectIdV1 | null;
  project_id: ProjectIdV1 | null; received_at: string; state: 'pending' | 'processing' | 'ready' | 'unavailable';
  search_hints: string; enrichment_sha256: Sha256Digest | null; attempts: number;
};
type Issued = { readonly response: ProjectReadResponseV1; readonly response_json: string; readonly operation: ProjectReadOperationV1 };
type InternalProjectStoreV1 = {
  readonly database: Database.Database;
  readonly now: () => string;
  readonly projectState: (actor: PersonAccessAuthorization) => { readonly grants: readonly ProjectMembershipGrantV1[]; readonly digest: Sha256Digest };
  readonly assertActive: (actor: AuthorityPersonMembershipBinding) => void;
  readonly issue: <T extends ProjectReadResponseV1>(snapshot: ProjectAuthorizationSnapshotV1, operation: ProjectReadOperationV1, response: T) => T;
  readonly release: <T extends ProjectReadResponseV1>(snapshot: ProjectAuthorizationSnapshotV1, actor: PersonAccessAuthorization, response: T) => T;
  readonly capture: (actor: PersonAccessAuthorization, scope: ProjectAuthorizationScopeV1) => ProjectAuthorizationSnapshotV1;
  readonly activeMembership: (membershipId: string) => AuthorityPersonMembershipBinding | undefined;
  readonly readable: (actor: AuthorityPersonMembershipBinding, grants: readonly ProjectMembershipGrantV1[], row: SourceRow) => boolean;
  readonly source: (id: string) => SourceRow | undefined;
  readonly sourceOwned: (actor: AuthorityPersonMembershipBinding, requestId: string) => SourceRow | undefined;
  readonly replay: <T extends ProjectCreateReceiptV1 | ProjectMutationReceiptV1 | PersonUpdateReceiptV2>(actor: AuthorityPersonMembershipBinding, mutation: ProjectMutationV1) => T | undefined;
  readonly record: (actor: AuthorityPersonMembershipBinding, mutation: ProjectMutationV1, value: ProjectCreateReceiptV1 | ProjectMutationReceiptV1 | PersonUpdateReceiptV2) => void;
  readonly validateSource: (row: SourceRow) => void;
};
let transactionActive = false;
const SELECT_SOURCE = `SELECT submission.*, work.state, work.search_hints, work.enrichment_sha256, work.attempts
  FROM authority_person_updates_v2 AS submission
  JOIN authority_person_update_work_v2 AS work USING (context_id)`;

function denied(code: 'not_found' | 'unauthorized' | 'conflict' | 'stale_access_state' | 'rate_limited' = 'not_found'): never {
  throw new AuthorityOperationError(code, 'request failed');
}
function immutable<T>(value: T): T {
  const freeze = (item: unknown): unknown => {
    if (item === null || typeof item !== 'object') return item;
    for (const child of Object.values(item as Record<string, unknown>)) freeze(child);
    return Object.freeze(item);
  };
  return freeze(JSON.parse(canonicalJson(value))) as T;
}
function withoutCheckedAt(actor: PersonAccessAuthorization): string {
  const { checked_at: _checked, ...rest } = actor;
  return canonicalJson(rest);
}
function audience(row: SourceRow) {
  return row.audience_kind === 'project'
    ? { kind: 'project' as const, project_id: row.audience_project_id! }
    : { kind: row.audience_kind };
}
function sourceContextId(actor: AuthorityPersonMembershipBinding, requestId: string): string {
  return `ctx_${canonicalSha256({ schema_version: 2, kind: 'echo-person-update-source-v2', organization_id: actor.organization_id, membership_id: actor.membership_id, request_id: requestId }).slice(7)}`;
}
function score(row: SourceRow, terms: readonly string[]): number | undefined {
  const original = normalizeProjectSearchQueryV1(`${row.title}\n${row.text}`);
  const hints = normalizeProjectSearchQueryV1(row.search_hints);
  if (!terms.every(term => original.includes(term) || hints.includes(term))) return undefined;
  return terms.reduce((n, term) => n + (original.includes(term) ? 2 : 1), 0);
}
function binary(a: string, b: string): number { return Buffer.compare(Buffer.from(a), Buffer.from(b)); }

export class SqliteProjectContextRepositoryV1 implements ProjectContextRepositoryV1 {
  private readonly issued = new WeakMap<ProjectAuthorizationSnapshotV1, Issued>();
  constructor(private readonly database: Database.Database, private readonly now: () => string = () => new Date().toISOString()) {
    if (![7, 8].includes(database.pragma('user_version', { simple: true }) as number) || database.pragma('foreign_keys', { simple: true }) !== 1) {
      throw new Error('Project context requires Authority V7 with foreign keys enabled');
    }
  }

  withReadTransaction<T>(operation: (transaction: ProjectContextReadTransactionV1) => T): T {
    return this.transaction(false, operation as (transaction: ProjectContextReadTransactionV1 | ProjectContextWriteTransactionV1) => T);
  }
  withWriteTransaction<T>(operation: (transaction: ProjectContextWriteTransactionV1) => T): T {
    return this.transaction(true, operation as (transaction: ProjectContextReadTransactionV1 | ProjectContextWriteTransactionV1) => T);
  }
  private transaction<T>(write: boolean, operation: (transaction: ProjectContextReadTransactionV1 | ProjectContextWriteTransactionV1) => T): T {
    if (this.database.inTransaction || transactionActive) throw new Error('project context transaction is not reentrant');
    transactionActive = true;
    let tx: ProjectTransaction | undefined;
    try {
      this.database.exec('BEGIN IMMEDIATE');
      tx = new ProjectTransaction(this.internalStore(), write);
      if (operation.constructor.name === 'AsyncFunction') throw new Error('project context transaction callback must be synchronous');
      const result = operation(tx as ProjectContextWriteTransactionV1);
      if (result !== null && (typeof result === 'object' || typeof result === 'function') && typeof (result as { then?: unknown }).then === 'function') {
        void Promise.resolve(result).catch(() => undefined);
        throw new Error('project context transaction callback must be synchronous');
      }
      tx.assertCommittable(); tx.close(); this.database.exec('COMMIT'); return result;
    } catch (error) {
      tx?.close(); try { this.database.exec('ROLLBACK'); } catch {}
      throw error;
    } finally { transactionActive = false; }
  }
  private internalStore(): InternalProjectStoreV1 {
    return Object.freeze({ database: this.database, now: this.now, projectState: this.projectState.bind(this), assertActive: this.assertActive.bind(this), issue: this.issue.bind(this), release: this.release.bind(this), capture: this.capture.bind(this), activeMembership: this.activeMembership.bind(this), readable: this.readable.bind(this), source: this.source.bind(this), sourceOwned: this.sourceOwned.bind(this), replay: this.replay.bind(this), record: this.record.bind(this), validateSource: this.validateSource.bind(this) });
  }
  private projectState(actor: PersonAccessAuthorization): { readonly grants: readonly ProjectMembershipGrantV1[]; readonly digest: Sha256Digest } {
    this.assertActive(actor);
    const revision = this.database.prepare('SELECT revision FROM authority_project_authorization_state_v1 WHERE organization_id = ?').get(actor.organization_id) as { revision: number } | undefined;
    if (revision === undefined) throw new Error('project authorization state is missing');
    const grants = this.database.prepare(`SELECT grant.project_id, grant.project_membership_id, grant.organization_id, grant.principal_id, grant.membership_id, grant.role
      FROM authority_project_memberships_v1 AS grant
      JOIN authority_memberships AS organization_membership
        ON organization_membership.membership_id = grant.membership_id
       AND organization_membership.organization_id = grant.organization_id
       AND organization_membership.principal_id = grant.principal_id
       AND organization_membership.membership_type = grant.membership_type
      WHERE grant.organization_id = ? AND grant.membership_id = ? AND grant.principal_id = ?
        AND grant.status = 'active' AND organization_membership.status = 'active'
      ORDER BY grant.project_id, grant.project_membership_id`).all(actor.organization_id, actor.membership_id, actor.principal_id) as ProjectMembershipGrantV1[];
    return { grants: immutable(grants), digest: canonicalSha256({ revision: revision.revision, grants, person_state_sha256: actor.person_state_sha256 }) };
  }
  private assertActive(actor: AuthorityPersonMembershipBinding): void {
    const current = this.database.prepare(`SELECT 1 FROM authority_memberships
      WHERE organization_id = ? AND principal_id = ? AND membership_id = ? AND membership_type = ? AND status = 'active'`)
      .get(actor.organization_id, actor.principal_id, actor.membership_id, actor.membership_type);
    if (current === undefined) denied('unauthorized');
  }
  private issue<T extends ProjectReadResponseV1>(snapshot: ProjectAuthorizationSnapshotV1, operation: ProjectReadOperationV1, response: T): T {
    const copy = immutable(response);
    this.issued.set(snapshot, { operation, response: copy, response_json: canonicalJson(copy) });
    return copy;
  }
  private release<T extends ProjectReadResponseV1>(snapshot: ProjectAuthorizationSnapshotV1, actor: PersonAccessAuthorization, response: T): T {
    const issued = this.issued.get(snapshot);
    if (issued === undefined || issued.operation !== readOperation(snapshot.scope) || issued.response !== response || issued.response_json !== canonicalJson(response)) {
      throw new AuthorityOperationError('invalid_output', 'request failed');
    }
    if (withoutCheckedAt(actor) !== withoutCheckedAt(snapshot.person)) denied('stale_access_state');
    const current = this.capture(actor, snapshot.scope);
    if (current.project_state_sha256 !== snapshot.project_state_sha256) denied('stale_access_state');
    const released_count = count(response);
    const audit = {
      schema_version: 1, kind: 'echo-project-read-audit-v1', audit_id: randomUUID(),
      organization_id: actor.organization_id, principal_id: actor.principal_id, membership_id: actor.membership_id,
      session_family_id: actor.session_family_id, operation: issued.operation,
      authorization_sha256: canonicalSha256({ actor: JSON.parse(withoutCheckedAt(actor)), project_state_sha256: current.project_state_sha256 }),
      response_sha256: canonicalSha256(response), released_count, checked_at: actor.checked_at,
    };
    this.database.prepare('INSERT INTO authority_project_read_audit_v1 (row_sha256, body_json, recorded_at) VALUES (?, ?, ?)')
      .run(canonicalSha256(audit), canonicalJson(audit), actor.checked_at);
    return immutable(response);
  }
  private capture(actor: PersonAccessAuthorization, scope: ProjectAuthorizationScopeV1): ProjectAuthorizationSnapshotV1 {
    const state = this.projectState(actor);
    const grants = state.grants;
    const project = projectOf(scope);
    if (isReadScope(scope) && project !== undefined && !grants.some(grant => grant.project_id === project)) denied();
    if (scope.operation === 'directory' && !grants.some(grant => grant.project_id === scope.project_id && grant.role === 'lead')) denied();
    return immutable({ person: immutable(actor), scope: immutable(scope), project_state_sha256: state.digest, grants });
  }
  private activeMembership(membershipId: string): AuthorityPersonMembershipBinding | undefined {
    return this.database.prepare(`SELECT organization_id, principal_id, membership_id, membership_type FROM authority_memberships WHERE membership_id = ? AND status = 'active'`)
      .get(membershipId) as AuthorityPersonMembershipBinding | undefined;
  }
  private readable(actor: AuthorityPersonMembershipBinding, grants: readonly ProjectMembershipGrantV1[], row: SourceRow): boolean {
    if (row.organization_id !== actor.organization_id) return false;
    if (row.audience_kind === 'only_me') return row.membership_id === actor.membership_id;
    if (row.audience_kind === 'team') return true;
    return grants.some(grant => grant.project_id === row.audience_project_id);
  }
  private source(id: string): SourceRow | undefined {
    return this.database.prepare(`${SELECT_SOURCE} WHERE submission.context_id = ?`).get(id) as SourceRow | undefined;
  }
  private sourceOwned(actor: AuthorityPersonMembershipBinding, requestId: string): SourceRow | undefined {
    const row = this.database.prepare(`${SELECT_SOURCE} WHERE submission.organization_id = ? AND submission.membership_id = ? AND submission.request_id = ?`).get(actor.organization_id, actor.membership_id, requestId) as SourceRow | undefined;
    if (row !== undefined) this.validateSource(row);
    return row;
  }
  private receipts(actor: AuthorityPersonMembershipBinding, requestId: string) {
    return this.database.prepare(`SELECT operation, command_sha256, receipt_json, receipt_sha256 FROM authority_project_command_receipts_v1
      WHERE organization_id = ? AND membership_id = ? AND request_id = ?`).get(actor.organization_id, actor.membership_id, requestId) as { operation: ProjectMutationV1['operation']; command_sha256: Sha256Digest; receipt_json: string; receipt_sha256: Sha256Digest } | undefined;
  }
  private replay<T extends ProjectCreateReceiptV1 | ProjectMutationReceiptV1 | PersonUpdateReceiptV2>(actor: AuthorityPersonMembershipBinding, mutation: ProjectMutationV1): T | undefined {
    const identity = projectCommandIdentityV1(actor, mutation);
    assertPersonRequestNamespaceV1(this.database, actor, identity.request_id, 'project');
    const stored = this.receipts(actor, identity.request_id);
    if (stored === undefined) return undefined;
    if (stored.operation !== mutation.operation || stored.command_sha256 !== identity.command_sha256 || canonicalSha256(JSON.parse(stored.receipt_json)) !== stored.receipt_sha256) denied('conflict');
    return receipt(stored.operation, JSON.parse(stored.receipt_json)) as T;
  }
  private record(actor: AuthorityPersonMembershipBinding, mutation: ProjectMutationV1, value: ProjectCreateReceiptV1 | ProjectMutationReceiptV1 | PersonUpdateReceiptV2): void {
    const identity = projectCommandIdentityV1(actor, mutation);
    const body = immutable(value);
    this.database.prepare(`INSERT INTO authority_project_command_receipts_v1
      (organization_id, principal_id, membership_id, membership_type, request_id, operation, command_sha256, receipt_json, receipt_sha256, committed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(actor.organization_id, actor.principal_id, actor.membership_id, actor.membership_type, identity.request_id, mutation.operation, identity.command_sha256, canonicalJson(body), canonicalSha256(body), this.now());
  }
  private validateSource(row: SourceRow): void {
    const request = validatePersonUpdateSubmitV2({ schema_version: 2, kind: 'echo-person-update-submit-v2', request_id: row.request_id, title: row.title, text: row.text, project_id: row.project_id, audience: audience(row) });
    if (canonicalSha256(request) !== row.payload_sha256 || sourceContextId(row, row.request_id) !== row.context_id) throw new Error('project upload payload integrity failure');
    validatePersonUpdateReceiptV2({ schema_version: 2, kind: 'echo-person-update-receipt-v2', request_id: row.request_id, context_id: row.context_id, received_at: row.received_at, project_id: row.project_id, audience: audience(row), state: 'received' });
  }
}

class ProjectTransaction implements ProjectContextWriteTransactionV1 {
  private live = true;
  private rollbackOnly = false;
  private readonly snapshots = new WeakSet<object>();
  constructor(private readonly store: InternalProjectStoreV1, private readonly write: boolean) {}
  close(): void { this.live = false; }
  assertCommittable(): void { if (this.rollbackOnly) throw new Error('project context transaction must roll back'); }
  private open(): void { if (!this.live) throw new Error('project context transaction escaped'); }
  private writable(): void { this.open(); if (!this.write) throw new Error('project context read transaction cannot mutate'); }
  /** A caught mutation error must not let its earlier SQLite statements commit. */
  private mutate<T>(operation: () => T): T {
    this.writable();
    this.store.database.exec('SAVEPOINT project_context_mutation');
    try {
      const result = operation();
      this.store.database.exec('RELEASE SAVEPOINT project_context_mutation');
      return result;
    } catch (error) {
      try {
        this.store.database.exec('ROLLBACK TO SAVEPOINT project_context_mutation');
        this.store.database.exec('RELEASE SAVEPOINT project_context_mutation');
      } catch {
        this.rollbackOnly = true;
        this.close();
      }
      throw error;
    }
  }
  captureAuthorization(actor: PersonAccessAuthorization, scope: ProjectAuthorizationScopeV1): ProjectAuthorizationSnapshotV1 {
    this.open();
    const snapshot = this.store.capture(actor, scope);
    this.snapshots.add(snapshot);
    return snapshot;
  }
  private input<T>(validate: () => T): T {
    try { return validate(); }
    catch { throw new AuthorityOperationError('invalid_request', 'request failed'); }
  }
  activeMembership(membershipId: string): AuthorityPersonMembershipBinding | undefined { this.writable(); return this.store.activeMembership(membershipId); }
  listProjects(snapshot: ProjectAuthorizationSnapshotV1, request: ProjectPageRequestV1): ProjectListV1 {
    this.open(); this.require(snapshot, 'project_list');
    const input = this.input(() => validateProjectPageRequestV1(request));
    const limit = input.limit ?? 10; const scope = cursorScope(snapshot, limit);
    const position = decodeProjectCursorV1(input.cursor, scope);
    const rows = this.store.database.prepare(`SELECT project.project_id, project.organization_id, project.name, project.created_at, grant.role
      FROM authority_projects_v1 AS project JOIN authority_project_memberships_v1 AS grant
      ON grant.project_id = project.project_id AND grant.organization_id = project.organization_id
      JOIN authority_memberships AS membership ON membership.membership_id = grant.membership_id AND membership.status = 'active'
      WHERE project.organization_id = ? AND grant.membership_id = ? AND grant.status = 'active'
      ORDER BY project.created_at DESC, project.project_id ASC`).all(snapshot.person.organization_id, snapshot.person.membership_id) as ProjectRow[];
    const remaining = after(rows, position, row => [row.created_at, row.project_id]);
    const page = remaining.slice(0, limit);
    const response = validateProjectListV1({ schema_version: 1, kind: 'echo-project-list-v1', items: page.map(row => ({ schema_version: 1, kind: 'echo-project-summary-v1', project_id: row.project_id, name: row.name, created_at: row.created_at, role: row.role })), next_cursor: next(remaining, page, limit) ? encodeProjectCursorV1(scope, [page.at(-1)!.created_at, page.at(-1)!.project_id]) : null });
    return this.store.issue(snapshot, 'project_list', response);
  }
  readProject(snapshot: ProjectAuthorizationSnapshotV1, projectId: ProjectIdV1): ProjectSummaryV1 {
    this.open(); const input = this.input(() => validateProjectIdV1(projectId)); this.require(snapshot, 'project_read', input);
    const row = this.project(snapshot.person, input); if (row === undefined) denied();
    return this.store.issue(snapshot, 'project_read', validateProjectSummaryV1({ schema_version: 1, kind: 'echo-project-summary-v1', ...row }));
  }
  listMembers(snapshot: ProjectAuthorizationSnapshotV1, request: ProjectContextBrowseV1): ProjectMembersV1 {
    this.open(); const input = this.input(() => validateProjectContextBrowseV1(request)); this.require(snapshot, 'members', input.project_id);
    const limit = input.limit ?? 10; const scope = cursorScope(snapshot, limit); const position = decodeProjectCursorV1(input.cursor, scope);
    const rows = this.members(input.project_id);
    const remaining = after(rows, position, row => [row.display_name, row.membership_id], false);
    const page = remaining.slice(0, limit);
    return this.store.issue(snapshot, 'members', validateProjectMembersV1({ schema_version: 1, kind: 'echo-project-members-v1', project_id: input.project_id, items: page.map(row => ({ membership_id: row.membership_id, display_name: row.display_name, role: row.role })), next_cursor: next(remaining, page, limit) ? encodeProjectCursorV1(scope, [page.at(-1)!.display_name, page.at(-1)!.membership_id]) : null }));
  }
  searchDirectory(snapshot: ProjectAuthorizationSnapshotV1, request: ProjectDirectorySearchV1): ProjectDirectoryV1 {
    this.open(); const input = this.input(() => validateProjectDirectorySearchV1(request)); this.require(snapshot, 'directory', input.project_id);
    const limit = input.limit ?? 10; const scope = cursorScope(snapshot, limit, input.query); const position = decodeProjectCursorV1(input.cursor, scope);
    const terms = projectSearchTermsV1(input.query);
    const rows = (this.store.database.prepare(`SELECT membership.membership_id, principal.display_name FROM authority_memberships AS membership JOIN authority_principals AS principal USING (principal_id)
      WHERE membership.organization_id = ? AND membership.status = 'active' ORDER BY principal.display_name ASC, membership.membership_id ASC`).all(snapshot.person.organization_id) as { membership_id: string; display_name: string }[])
      .filter(row => terms.every(term => normalizeProjectSearchQueryV1(row.display_name).includes(term)));
    const remaining = after(rows, position, row => [row.display_name, row.membership_id], false);
    const page = remaining.slice(0, limit);
    return this.store.issue(snapshot, 'directory', validateProjectDirectoryV1({ schema_version: 1, kind: 'echo-project-directory-v1', project_id: input.project_id, items: page, next_cursor: next(remaining, page, limit) ? encodeProjectCursorV1(scope, [page.at(-1)!.display_name, page.at(-1)!.membership_id]) : null }));
  }
  feed(snapshot: ProjectAuthorizationSnapshotV1, request: ProjectContextBrowseV1): ProjectContextFeedV1 {
    this.open(); const input = this.input(() => validateProjectContextBrowseV1(request)); this.require(snapshot, 'feed', input.project_id);
    const limit = input.limit ?? 10; const scope = cursorScope(snapshot, limit); const pos = decodeProjectCursorV1(input.cursor, scope);
    const rows = this.projectSources(snapshot, input.project_id).sort((a,b) => b.received_at.localeCompare(a.received_at) || a.context_id.localeCompare(b.context_id));
    const remaining = after(rows, pos, row => [row.received_at, row.context_id]);
    const page = remaining.slice(0, limit);
    return this.store.issue(snapshot, 'feed', validateProjectContextFeedV1({ schema_version: 1, kind: 'echo-project-context-feed-v1', project_id: input.project_id, items: page.map(item), next_cursor: next(remaining, page, limit) ? encodeProjectCursorV1(scope, [page.at(-1)!.received_at, page.at(-1)!.context_id]) : null }));
  }
  search(snapshot: ProjectAuthorizationSnapshotV1, request: ProjectContextSearchV1): ProjectContextSearchResultV1 {
    this.open(); const input = this.input(() => validateProjectContextSearchV1(request)); this.require(snapshot, 'search', input.project_id);
    const limit = input.limit ?? 10; const scope = cursorScope(snapshot, limit, input.query); const pos = decodeProjectCursorV1(input.cursor, scope);
    const terms = projectSearchTermsV1(input.query);
    const rows = this.projectSources(snapshot, input.project_id).flatMap(row => { const n = score(row, terms); return n === undefined ? [] : [{ row, score: n }]; })
      .sort((a,b) => b.score - a.score || b.row.received_at.localeCompare(a.row.received_at) || a.row.context_id.localeCompare(b.row.context_id));
    const remaining = after(rows, pos, value => [value.score, value.row.received_at, value.row.context_id]);
    const page = remaining.slice(0, limit);
    return this.store.issue(snapshot, 'search', validateProjectContextSearchResultV1({ schema_version: 1, kind: 'echo-project-context-search-result-v1', project_id: input.project_id, items: page.map(value => item(value.row)), next_cursor: next(remaining, page, limit) ? encodeProjectCursorV1(scope, [page.at(-1)!.score, page.at(-1)!.row.received_at, page.at(-1)!.row.context_id]) : null }));
  }
  readContext(snapshot: ProjectAuthorizationSnapshotV1, projectId: ProjectIdV1, contextId: string): ProjectContextReadV1 {
    this.open(); const input = this.input(() => ({ project_id: validateProjectIdV1(projectId), context_id: validatePersonUploadContextId(contextId) })); this.require(snapshot, 'context_read', input.project_id); if (snapshot.scope.operation !== 'context_read' || snapshot.scope.context_id !== input.context_id) throw new Error('project context scope mismatch');
    const row = this.projectSources(snapshot, input.project_id).find(value => value.context_id === input.context_id); if (row === undefined) denied();
    return this.store.issue(snapshot, 'context_read', validateProjectContextReadV1({ schema_version: 1, kind: 'echo-project-context-read-v1', project_id: input.project_id, context_id: row.context_id, received_at: row.received_at, title: row.title, text: row.text, audience: audience(row) }));
  }
  uploadStatus(snapshot: ProjectAuthorizationSnapshotV1, requestId: string): PersonUpdateStatusV2 {
    this.open(); const input = this.input(() => validatePersonUpdateRequestId(requestId)); this.require(snapshot, 'upload_status'); if (snapshot.scope.operation !== 'upload_status' || snapshot.scope.request_id !== input) throw new Error('project context scope mismatch'); const row = this.store.sourceOwned(snapshot.person, input); if (row === undefined) denied();
    return this.store.issue(snapshot, 'upload_status', validatePersonUpdateStatusV2({ schema_version: 2, kind: 'echo-person-update-status-v2', request_id: row.request_id, context_id: row.context_id, received_at: row.received_at, project_id: row.project_id, audience: audience(row), status: 'stored', metadata: row.state }));
  }
  readUpload(snapshot: ProjectAuthorizationSnapshotV1, contextId: string): PersonUploadContentV2 {
    this.open(); const input = this.input(() => validatePersonUploadContextId(contextId)); this.require(snapshot, 'upload_read'); if (snapshot.scope.operation !== 'upload_read' || snapshot.scope.context_id !== input) throw new Error('project context scope mismatch'); const row = this.store.source(input); if (row === undefined || !this.store.readable(snapshot.person, snapshot.grants, row)) denied(); this.store.validateSource(row);
    return this.store.issue(snapshot, 'upload_read', validatePersonUploadContentV2({ schema_version: 2, kind: 'echo-person-upload-content-v2', context_id: row.context_id, received_at: row.received_at, audience: audience(row), title: row.title, text: row.text }));
  }
  searchUploads(snapshot: ProjectAuthorizationSnapshotV1, request: PersonUploadSearchV2): PersonUploadSearchResultV2 {
    this.open(); const input = this.input(() => validatePersonUploadSearchV2(request)); this.require(snapshot, 'upload_search'); const terms = projectSearchTermsV1(input.query);
    const rows = (this.store.database.prepare(`${SELECT_SOURCE} WHERE submission.organization_id = ? ORDER BY submission.received_at DESC, submission.context_id ASC LIMIT 1000`).all(snapshot.person.organization_id) as SourceRow[])
      .filter(row => { if (!this.store.readable(snapshot.person, snapshot.grants, row)) return false; this.store.validateSource(row); return true; })
      .flatMap(row => { const n = score(row, terms); return n === undefined ? [] : [{ row, score: n }]; })
      .sort((a,b) => b.score-a.score || b.row.received_at.localeCompare(a.row.received_at) || a.row.context_id.localeCompare(b.row.context_id)).slice(0, input.limit ?? 10);
    return this.store.issue(snapshot, 'upload_search', validatePersonUploadSearchResultV2({ schema_version: 2, kind: 'echo-person-upload-search-v2', results: rows.map(({row}) => ({ context_id: row.context_id, received_at: row.received_at, audience: audience(row), title: row.title, excerpt: [...row.text.trim()].slice(0, 300).join('') })) }));
  }
  revalidateAndAuditRelease<Response extends ProjectReadResponseV1>(snapshot: ProjectAuthorizationSnapshotV1, currentActor: PersonAccessAuthorization, response: Response): Response { this.open(); this.known(snapshot); return this.store.release(snapshot, currentActor, response); }

  createProject(snapshot: ProjectAuthorizationSnapshotV1, request: ProjectCreateV1): ProjectCreateReceiptV1 {
    return this.mutate(() => {
      this.writable(); this.require(snapshot, 'create'); const mutation = { operation: 'create' as const, request };
      const replay = this.replay(snapshot, mutation) as ProjectCreateReceiptV1 | undefined; if (replay) return replay;
      const project_id = `prj_${randomUUID()}` as ProjectIdV1; const created_at = this.store.now();
      this.store.database.prepare(`INSERT INTO authority_projects_v1 (project_id, organization_id, name, created_at, creator_principal_id, creator_membership_id, creator_membership_type) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(project_id, snapshot.person.organization_id, request.name, created_at, snapshot.person.principal_id, snapshot.person.membership_id, snapshot.person.membership_type);
      this.store.database.prepare(`INSERT INTO authority_project_memberships_v1 (project_membership_id, project_id, organization_id, principal_id, membership_id, membership_type, role, status, granted_at) VALUES (?, ?, ?, ?, ?, ?, 'lead', 'active', ?)`).run(`pgm_${randomUUID()}`, project_id, snapshot.person.organization_id, snapshot.person.principal_id, snapshot.person.membership_id, snapshot.person.membership_type, created_at);
      const result = validateProjectCreateReceiptV1({ schema_version: 1, kind: 'echo-project-create-receipt-v1', request_id: request.request_id, project_id, created_at, state: 'created' });
      this.store.record(snapshot.person, mutation, result); return result;
    });
  }
  setMember(snapshot: ProjectAuthorizationSnapshotV1, request: ProjectMemberSetV1): ProjectMutationReceiptV1 {
    return this.mutate(() => {
      this.writable(); this.require(snapshot, 'member_set', request.project_id); const mutation = { operation: 'member_set' as const, request }; this.store.assertActive(snapshot.person);
      const replay = this.replay(snapshot, mutation) as ProjectMutationReceiptV1 | undefined; if (replay) return replay;
      this.requireLead(snapshot, request.project_id); const target = this.store.activeMembership(request.membership_id); if (!target || target.organization_id !== snapshot.person.organization_id) denied();
      const existing = this.store.database.prepare(`SELECT project_membership_id, role FROM authority_project_memberships_v1 WHERE project_id = ? AND membership_id = ? AND status = 'active'`).get(request.project_id, target.membership_id) as { project_membership_id:string; role:ProjectRoleV1 } | undefined;
      if (existing) {
        if (existing.role !== request.role) {
          if (existing.role === 'lead' && request.role === 'member') this.lastLead(request.project_id, target.membership_id);
          this.store.database.prepare('UPDATE authority_project_memberships_v1 SET role = ? WHERE project_membership_id = ?').run(request.role, existing.project_membership_id);
        }
      } else this.store.database.prepare(`INSERT INTO authority_project_memberships_v1 (project_membership_id, project_id, organization_id, principal_id, membership_id, membership_type, role, status, granted_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`).run(`pgm_${randomUUID()}`, request.project_id, target.organization_id, target.principal_id, target.membership_id, target.membership_type, request.role, this.store.now());
      const result = mutationReceipt(request, this.store.now()); this.store.record(snapshot.person, mutation, result); return result;
    });
  }
  removeMember(snapshot: ProjectAuthorizationSnapshotV1, request: ProjectMemberRemoveV1): ProjectMutationReceiptV1 {
    return this.mutate(() => {
      this.writable(); this.require(snapshot, 'member_remove', request.project_id); const mutation = { operation: 'member_remove' as const, request }; this.store.assertActive(snapshot.person);
      const replay = this.replay(snapshot, mutation) as ProjectMutationReceiptV1 | undefined; if (replay) return replay;
      this.requireLead(snapshot, request.project_id); const target = this.store.activeMembership(request.membership_id); if (!target || target.organization_id !== snapshot.person.organization_id) denied();
      const row = this.store.database.prepare(`SELECT project_membership_id, role FROM authority_project_memberships_v1 WHERE project_id = ? AND membership_id = ? AND status = 'active'`).get(request.project_id, target.membership_id) as {project_membership_id:string;role:ProjectRoleV1}|undefined;
      if (row) { if (row.role === 'lead') this.lastLead(request.project_id, target.membership_id); this.store.database.prepare(`UPDATE authority_project_memberships_v1 SET status = 'revoked', revoked_at = ? WHERE project_membership_id = ?`).run(this.store.now(), row.project_membership_id); }
      const result = mutationReceipt(request, this.store.now()); this.store.record(snapshot.person, mutation, result); return result;
    });
  }
  associateContext(snapshot: ProjectAuthorizationSnapshotV1, request: ProjectContextAssociateV1): ProjectMutationReceiptV1 {
    return this.mutate(() => {
      this.writable(); const mutation={operation:'associate' as const,request}; this.store.assertActive(snapshot.person);
      const replay=this.replay(snapshot,mutation) as ProjectMutationReceiptV1 | undefined; if(replay)return replay;
      this.require(snapshot,'associate',request.project_id); if (!snapshot.grants.some(grant => grant.project_id === request.project_id)) denied(); const row=this.store.source(request.context_id); if(!row || row.membership_id!==snapshot.person.membership_id || !this.store.readable(snapshot.person,snapshot.grants,row)) denied(); this.store.validateSource(row);
      const existing=this.store.database.prepare('SELECT project_id FROM authority_project_context_associations_v1 WHERE context_id = ?').get(row.context_id) as {project_id:ProjectIdV1}|undefined;
      if(existing && existing.project_id!==request.project_id) denied('conflict');
      if(!existing)this.store.database.prepare(`INSERT INTO authority_project_context_associations_v1 (context_id, project_id, organization_id, associator_principal_id, associator_membership_id, associator_membership_type, associated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(row.context_id,request.project_id,snapshot.person.organization_id,snapshot.person.principal_id,snapshot.person.membership_id,snapshot.person.membership_type,this.store.now());
      const result=mutationReceipt(request,this.store.now());this.store.record(snapshot.person,mutation,result);return result;
    });
  }
  dissociateContext(snapshot: ProjectAuthorizationSnapshotV1, request: ProjectContextDissociateV1): ProjectMutationReceiptV1 {
    return this.mutate(() => {
      this.writable(); this.require(snapshot, 'dissociate', request.project_id); const mutation={operation:'dissociate' as const,request}; this.store.assertActive(snapshot.person);
      const replay=this.replay(snapshot,mutation) as ProjectMutationReceiptV1 | undefined;if(replay)return replay;
      const row=this.store.source(request.context_id);if(!row || !this.store.readable(snapshot.person,snapshot.grants,row))denied();this.store.validateSource(row);
      const existing=this.store.database.prepare('SELECT project_id FROM authority_project_context_associations_v1 WHERE context_id = ?').get(row.context_id) as {project_id:ProjectIdV1}|undefined;
      if(existing && existing.project_id!==request.project_id)denied();
      const uploader=row.membership_id===snapshot.person.membership_id;const lead=snapshot.grants.some(g=>g.project_id===request.project_id&&g.role==='lead');if(!uploader&&!lead)denied();
      if(existing)this.store.database.prepare('DELETE FROM authority_project_context_associations_v1 WHERE context_id = ?').run(row.context_id);
      const result=mutationReceipt(request,this.store.now());this.store.record(snapshot.person,mutation,result);return result;
    });
  }
  submitUpload(snapshot: ProjectAuthorizationSnapshotV1, request: PersonUpdateSubmitV2): PersonUpdateReceiptV2 {
    return this.mutate(() => {
      this.writable(); const mutation={operation:'upload_submit' as const,request}; this.store.assertActive(snapshot.person);
      const replay=this.replay(snapshot,mutation) as PersonUpdateReceiptV2 | undefined;if(replay)return replay;
      this.require(snapshot,'upload_submit');
      const selectedProjects = [request.project_id, request.audience.kind === 'project' ? request.audience.project_id : null].filter((id): id is ProjectIdV1 => id !== null);
      if (selectedProjects.some(id => !snapshot.grants.some(grant => grant.project_id === id))) denied();
      assertPersonDocumentCapacityV1(this.store.database,snapshot.person,Buffer.byteLength(request.text),'legacy_text');
      const received_at=this.store.now(); const context_id=sourceContextId(snapshot.person,request.request_id);
      const audience_project_id=request.audience.kind==='project'?request.audience.project_id:null;
      this.store.database.prepare(`INSERT INTO authority_person_updates_v2 (organization_id, principal_id, membership_id, membership_type, request_id, context_id, payload_sha256, title, text, audience_kind, audience_project_id, project_id, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(snapshot.person.organization_id,snapshot.person.principal_id,snapshot.person.membership_id,snapshot.person.membership_type,request.request_id,context_id,canonicalSha256(request),request.title,request.text,request.audience.kind,audience_project_id,request.project_id,received_at);
      this.store.database.prepare(`INSERT INTO authority_person_update_work_v2 (context_id, state, retry_at) VALUES (?, 'pending', ?)`).run(context_id,received_at);
      if(request.project_id!==null)this.store.database.prepare(`INSERT INTO authority_project_context_associations_v1 (context_id, project_id, organization_id, associator_principal_id, associator_membership_id, associator_membership_type, associated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(context_id,request.project_id,snapshot.person.organization_id,snapshot.person.principal_id,snapshot.person.membership_id,snapshot.person.membership_type,received_at);
      const result=validatePersonUpdateReceiptV2({schema_version:2,kind:'echo-person-update-receipt-v2',request_id:request.request_id,context_id,received_at,project_id:request.project_id,audience:request.audience,state:'received'});
      this.store.record(snapshot.person,mutation,result);return result;
    });
  }
  private known(snapshot: ProjectAuthorizationSnapshotV1): void { if (!this.snapshots.has(snapshot)) throw new Error('project context snapshot escaped or was forged'); }
  private replay(snapshot: ProjectAuthorizationSnapshotV1, mutation: ProjectMutationV1): ProjectCreateReceiptV1 | ProjectMutationReceiptV1 | PersonUpdateReceiptV2 | undefined {
    this.known(snapshot);
    if (!('request' in snapshot.scope) || snapshot.scope.operation !== mutation.operation || canonicalJson(snapshot.scope.request) !== canonicalJson(mutation.request)) throw new Error('project context mutation scope mismatch');
    this.store.assertActive(snapshot.person);
    const replay = this.store.replay(snapshot.person, mutation);
    if (replay !== undefined) return replay;
    const current = this.store.capture(snapshot.person, snapshot.scope);
    if (current.project_state_sha256 !== snapshot.project_state_sha256) denied('stale_access_state');
    return undefined;
  }
  private require(snapshot: ProjectAuthorizationSnapshotV1, operation: ProjectAuthorizationScopeV1['operation'], projectId?: ProjectIdV1): void { this.known(snapshot); if(snapshot.scope.operation!==operation || (projectId!==undefined && projectOf(snapshot.scope)!==projectId)) throw new Error('project context scope mismatch'); }
  private requireLead(snapshot: ProjectAuthorizationSnapshotV1, projectId: ProjectIdV1): void { if(!snapshot.grants.some(g=>g.project_id===projectId&&g.role==='lead'))denied(); }
  private project(actor: AuthorityPersonMembershipBinding, projectId: ProjectIdV1): Omit<ProjectRow,'organization_id'>|undefined { return this.store.database.prepare(`SELECT project.project_id,project.name,project.created_at,grant.role FROM authority_projects_v1 project JOIN authority_project_memberships_v1 grant ON grant.project_id=project.project_id AND grant.organization_id=project.organization_id JOIN authority_memberships membership ON membership.membership_id=grant.membership_id AND membership.status='active' WHERE project.project_id=? AND project.organization_id=? AND grant.membership_id=? AND grant.status='active'`).get(projectId,actor.organization_id,actor.membership_id) as Omit<ProjectRow,'organization_id'>|undefined; }
  private members(projectId:ProjectIdV1): {membership_id:string;display_name:string;role:ProjectRoleV1}[]{return this.store.database.prepare(`SELECT grant.membership_id,principal.display_name,grant.role FROM authority_project_memberships_v1 grant JOIN authority_memberships membership ON membership.membership_id=grant.membership_id AND membership.status='active' JOIN authority_principals principal ON principal.principal_id=grant.principal_id WHERE grant.project_id=? AND grant.status='active' ORDER BY principal.display_name ASC,grant.membership_id ASC`).all(projectId) as {membership_id:string;display_name:string;role:ProjectRoleV1}[];}
  private projectSources(snapshot:ProjectAuthorizationSnapshotV1,projectId:ProjectIdV1):SourceRow[]{return(this.store.database.prepare(`${SELECT_SOURCE} JOIN authority_project_context_associations_v1 association ON association.context_id=submission.context_id WHERE association.project_id=? AND association.organization_id=?`).all(projectId,snapshot.person.organization_id) as SourceRow[]).filter(row=>{if(!this.store.readable(snapshot.person,snapshot.grants,row))return false;this.store.validateSource(row);return true;});}
  private lastLead(projectId:ProjectIdV1,_membershipId:string):void{const n=(this.store.database.prepare(`SELECT count(*) AS n FROM authority_project_memberships_v1 grant JOIN authority_memberships membership ON membership.membership_id=grant.membership_id AND membership.status='active' WHERE grant.project_id=? AND grant.status='active' AND grant.role='lead'`).get(projectId) as {n:number}).n;if(n<=1)denied('conflict');}
}
function readOperation(scope: ProjectAuthorizationScopeV1): ProjectReadOperationV1 {
  const reads = ['project_list', 'project_read', 'members', 'directory', 'feed', 'search', 'context_read', 'upload_status', 'upload_read', 'upload_search'];
  if (reads.includes(scope.operation)) return scope.operation as ProjectReadOperationV1;
  throw new Error('mutation cannot release');
}
function projectOf(scope:ProjectAuthorizationScopeV1):ProjectIdV1|undefined {
  if ('project_id' in scope) return scope.project_id;
  return 'request' in scope && 'project_id' in scope.request ? scope.request.project_id ?? undefined : undefined;
}
function isReadScope(scope: ProjectAuthorizationScopeV1): boolean {
  return ['project_list', 'project_read', 'members', 'directory', 'feed', 'search', 'context_read', 'upload_status', 'upload_read', 'upload_search'].includes(scope.operation);
}
function count(response: ProjectReadResponseV1): number {
  if ('items' in response) return response.items.length;
  if ('results' in response) return response.results.length;
  return 1;
}
function item(row: SourceRow) {
  return { context_id: row.context_id, received_at: row.received_at, title: row.title, excerpt: [...row.text.trim()].slice(0, 300).join(''), audience: audience(row) };
}
function receipt(operation: ProjectMutationV1['operation'], body: unknown) {
  if (operation === 'create') return validateProjectCreateReceiptV1(body);
  if (operation === 'upload_submit') return validatePersonUpdateReceiptV2(body);
  return validateProjectMutationReceiptV1(body);
}
function mutationReceipt(request: ProjectMemberSetV1 | ProjectMemberRemoveV1 | ProjectContextAssociateV1 | ProjectContextDissociateV1, received_at: string): ProjectMutationReceiptV1 {
  const memberOperation = request.kind.includes('member');
  const operation = memberOperation
    ? (request.kind.includes('set') ? 'member_set' : 'member_remove')
    : (request.kind.includes('dissociate') ? 'dissociate' : 'associate');
  return validateProjectMutationReceiptV1({
    schema_version: 1,
    kind: 'echo-project-mutation-receipt-v1',
    request_id: request.request_id,
    project_id: request.project_id,
    operation,
    ...(memberOperation ? { membership_id: (request as ProjectMemberSetV1).membership_id } : { context_id: (request as ProjectContextAssociateV1).context_id }),
    received_at,
    state: 'applied',
  });
}
function cursorScope(snapshot: ProjectAuthorizationSnapshotV1, limit: number | undefined, query?: string): ProjectCursorScopeV1 {
  return { operation: readOperation(snapshot.scope) as ProjectCursorScopeV1['operation'], ...('project_id' in snapshot.scope ? { project_id: snapshot.scope.project_id } : {}), ...(query === undefined ? {} : { canonical_query: normalizeProjectSearchQueryV1(query) }), limit: limit ?? 10, organization_id: snapshot.person.organization_id, membership_id: snapshot.person.membership_id };
}
function after<T>(rows: readonly T[], position: readonly (string | number)[] | undefined, coordinates: (row: T) => readonly (string | number)[], firstDescending = true): T[] {
  if (position === undefined) return [...rows];
  return rows.filter(row => {
    const keys = coordinates(row);
    for (let i = 0; i < keys.length; i += 1) {
      const left = keys[i]!;
      const right = position[i]!;
      const comparison = typeof left === 'number' && typeof right === 'number' ? left - right : binary(String(left), String(right));
      if (comparison === 0) continue;
      const descending = i === 0 ? firstDescending : keys.length === 3 && i === 1;
      return descending ? comparison < 0 : comparison > 0;
    }
    return false;
  });
}
function next<T>(remaining: readonly T[], page: readonly T[], limit: number): boolean { return page.length === limit && remaining.length > page.length; }
