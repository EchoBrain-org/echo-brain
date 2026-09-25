import {
  validateOrganizationDirectorySearchV1,
  validatePersonUpdateRequestId,
  validatePersonUpdateSubmitV2,
  validatePersonUpdateSubmitV3,
  validatePersonUploadContextId,
  validatePersonUploadSearchV2,
  validateProjectContextAssociateV1,
  validateProjectContextBrowseV1,
  validateProjectContextDissociateV1,
  validateProjectContextSearchV1,
  validateProjectCreateV1,
  validateProjectMemberAddV1,
  validateProjectDirectorySearchV1,
  validateProjectIdV1,
  validateProjectMemberRemoveV1,
  validateProjectMemberSetV1,
  validateProjectPageRequestV1,
  type OrganizationDirectoryV1,
  type PersonUpdateReceiptV2,
  type PersonUpdateReceiptV3,
  type PersonUpdateStatusV2,
  type PersonUpdateStatusV3,
  type PersonUploadContentV2,
  type PersonUploadContentV3,
  type PersonUploadSearchResultV2,
  type PersonUploadSearchResultV3,
  type ProjectContextFeedV1,
  type ProjectContextFeedV2,
  type ProjectContextReadV1,
  type ProjectContextReadV2,
  type ProjectContextSearchResultV1,
  type ProjectContextSearchResultV2,
  type ProjectCreateReceiptV1,
  type ProjectDirectoryV1,
  type ProjectListV1,
  type ProjectMembersV1,
  type ProjectMutationReceiptV1,
  type ProjectSummaryV1,
} from '@echo-brain/organization-api';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type {
  ProjectAuthorizationScopeV1,
  ProjectContextApplicationV1,
  ProjectContextReadTransactionV1,
  ProjectContextRepositoryV1,
  ProjectContextWriteTransactionV1,
  ProjectReadResponseV1,
} from './ports/project-context-v1.js';

export interface ProjectContextApplicationDependenciesV1 {
  readonly authenticate: (accessToken: string) => PersonAccessAuthorization;
  readonly repository: ProjectContextRepositoryV1;
}

/**
 * Authority-owned V1 application boundary.  It authenticates and validates
 * before creating a transaction-local scope; callers cannot supply either.
 */
export class ProjectContextApplication implements ProjectContextApplicationV1 {
  constructor(private readonly dependencies: ProjectContextApplicationDependenciesV1) {}

  createProject(accessToken: string, value: unknown): ProjectCreateReceiptV1 {
    const actor = this.authenticate(accessToken); const request = this.input(() => validateProjectCreateV1(value));
    return this.write(actor, { operation: 'create', request }, (transaction, snapshot) => transaction.createProject(snapshot, request));
  }
  listProjects(accessToken: string, value: unknown): ProjectListV1 {
    const actor = this.authenticate(accessToken); const request = this.input(() => validateProjectPageRequestV1(value));
    return this.read(accessToken, actor, { operation: 'project_list' }, (transaction, snapshot) => transaction.listProjects(snapshot, request));
  }
  readProject(accessToken: string, value: unknown): ProjectSummaryV1 {
    const actor = this.authenticate(accessToken); const projectId = this.input(() => validateProjectIdV1(value));
    return this.read(accessToken, actor, { operation: 'project_read', project_id: projectId }, (transaction, snapshot) => transaction.readProject(snapshot, projectId));
  }
  listMembers(accessToken: string, value: unknown): ProjectMembersV1 {
    const actor = this.authenticate(accessToken); const request = this.input(() => validateProjectContextBrowseV1(value));
    return this.read(accessToken, actor, { operation: 'members', project_id: request.project_id }, (transaction, snapshot) => transaction.listMembers(snapshot, request));
  }
  searchDirectory(accessToken: string, value: unknown): ProjectDirectoryV1 {
    const actor = this.authenticate(accessToken); const request = this.input(() => validateProjectDirectorySearchV1(value));
    return this.read(accessToken, actor, { operation: 'directory', project_id: request.project_id }, (transaction, snapshot) => transaction.searchDirectory(snapshot, request));
  }
  /** Any active member may search their own organization; see ADR-0016. */
  searchOrganizationDirectory(accessToken: string, value: unknown): OrganizationDirectoryV1 {
    const actor = this.authenticate(accessToken); const request = this.input(() => validateOrganizationDirectorySearchV1(value));
    return this.read(accessToken, actor, { operation: 'organization_directory' }, (transaction, snapshot) => transaction.searchOrganizationDirectory(snapshot, request));
  }
  addMember(accessToken: string, value: unknown): ProjectMutationReceiptV1 {
    const actor = this.authenticate(accessToken); const request = this.input(() => validateProjectMemberAddV1(value));
    return this.write(actor, { operation: 'member_set', request }, (transaction, snapshot) => transaction.addMember(snapshot, request));
  }
  setMember(accessToken: string, value: unknown): ProjectMutationReceiptV1 {
    const actor = this.authenticate(accessToken); const request = this.input(() => validateProjectMemberSetV1(value));
    return this.write(actor, { operation: 'member_set', request }, (transaction, snapshot) => transaction.setMember(snapshot, request));
  }
  removeMember(accessToken: string, value: unknown): ProjectMutationReceiptV1 {
    const actor = this.authenticate(accessToken); const request = this.input(() => validateProjectMemberRemoveV1(value));
    return this.write(actor, { operation: 'member_remove', request }, (transaction, snapshot) => transaction.removeMember(snapshot, request));
  }
  associateContext(accessToken: string, value: unknown): ProjectMutationReceiptV1 {
    const actor = this.authenticate(accessToken); const request = this.input(() => validateProjectContextAssociateV1(value));
    return this.write(actor, { operation: 'associate', request }, (transaction, snapshot) => transaction.associateContext(snapshot, request));
  }
  dissociateContext(accessToken: string, value: unknown): ProjectMutationReceiptV1 {
    const actor = this.authenticate(accessToken); const request = this.input(() => validateProjectContextDissociateV1(value));
    return this.write(actor, { operation: 'dissociate', request }, (transaction, snapshot) => transaction.dissociateContext(snapshot, request));
  }
  feedV2(accessToken: string, value: unknown): ProjectContextFeedV2 {
    const actor = this.authenticate(accessToken); const request = this.input(() => validateProjectContextBrowseV1(value));
    return this.read(accessToken, actor, { operation: 'feed_v2', project_id: request.project_id }, (transaction, snapshot) => transaction.feedV2(snapshot, request));
  }
  feed(accessToken: string, value: unknown): ProjectContextFeedV1 {
    const actor = this.authenticate(accessToken); const request = this.input(() => validateProjectContextBrowseV1(value));
    return this.read(accessToken, actor, { operation: 'feed', project_id: request.project_id }, (transaction, snapshot) => transaction.feed(snapshot, request));
  }
  searchV2(accessToken: string, value: unknown): ProjectContextSearchResultV2 {
    const actor = this.authenticate(accessToken); const request = this.input(() => validateProjectContextSearchV1(value));
    return this.read(accessToken, actor, { operation: 'search_v2', project_id: request.project_id }, (transaction, snapshot) => transaction.searchV2(snapshot, request));
  }
  search(accessToken: string, value: unknown): ProjectContextSearchResultV1 {
    const actor = this.authenticate(accessToken); const request = this.input(() => validateProjectContextSearchV1(value));
    return this.read(accessToken, actor, { operation: 'search', project_id: request.project_id }, (transaction, snapshot) => transaction.search(snapshot, request));
  }
  readContextV2(accessToken: string, project: unknown, context: unknown): ProjectContextReadV2 {
    const actor = this.authenticate(accessToken); const projectId = this.input(() => validateProjectIdV1(project)); const contextId = this.input(() => validatePersonUploadContextId(context));
    return this.read(accessToken, actor, { operation: 'context_read_v2', project_id: projectId, context_id: contextId }, (transaction, snapshot) => transaction.readContextV2(snapshot, projectId, contextId));
  }
  readContext(accessToken: string, project: unknown, context: unknown): ProjectContextReadV1 {
    const actor = this.authenticate(accessToken); const projectId = this.input(() => validateProjectIdV1(project)); const contextId = this.input(() => validatePersonUploadContextId(context));
    return this.read(accessToken, actor, { operation: 'context_read', project_id: projectId, context_id: contextId }, (transaction, snapshot) => transaction.readContext(snapshot, projectId, contextId));
  }
  submitUpload(accessToken: string, value: unknown): PersonUpdateReceiptV2 {
    const actor = this.authenticate(accessToken); const request = this.input(() => validatePersonUpdateSubmitV2(value));
    return this.write(actor, { operation: 'upload_submit', request }, (transaction, snapshot) => transaction.submitUpload(snapshot, request));
  }
  submitUploadV3(accessToken: string, value: unknown): PersonUpdateReceiptV3 {
    const actor = this.authenticate(accessToken); const request = this.input(() => validatePersonUpdateSubmitV3(value));
    return this.write(actor, { operation: 'upload_submit_v3', request }, (transaction, snapshot) => transaction.submitUploadV3(snapshot, request));
  }
  uploadStatus(accessToken: string, value: unknown): PersonUpdateStatusV2 {
    const actor = this.authenticate(accessToken); const requestId = this.input(() => validatePersonUpdateRequestId(value));
    return this.read(accessToken, actor, { operation: 'upload_status', request_id: requestId }, (transaction, snapshot) => transaction.uploadStatus(snapshot, requestId));
  }
  uploadStatusV3(accessToken: string, value: unknown): PersonUpdateStatusV3 {
    const actor = this.authenticate(accessToken); const requestId = this.input(() => validatePersonUpdateRequestId(value));
    return this.read(accessToken, actor, { operation: 'upload_status_v3', request_id: requestId }, (transaction, snapshot) => transaction.uploadStatusV3(snapshot, requestId));
  }
  readUpload(accessToken: string, value: unknown): PersonUploadContentV2 {
    const actor = this.authenticate(accessToken); const contextId = this.input(() => validatePersonUploadContextId(value));
    return this.read(accessToken, actor, { operation: 'upload_read', context_id: contextId }, (transaction, snapshot) => transaction.readUpload(snapshot, contextId));
  }
  readUploadV3(accessToken: string, value: unknown): PersonUploadContentV3 {
    const actor = this.authenticate(accessToken); const contextId = this.input(() => validatePersonUploadContextId(value));
    return this.read(accessToken, actor, { operation: 'upload_read_v3', context_id: contextId }, (transaction, snapshot) => transaction.readUploadV3(snapshot, contextId));
  }
  searchUploads(accessToken: string, value: unknown): PersonUploadSearchResultV2 {
    const actor = this.authenticate(accessToken); const request = this.input(() => validatePersonUploadSearchV2(value));
    return this.read(accessToken, actor, { operation: 'upload_search' }, (transaction, snapshot) => transaction.searchUploads(snapshot, request));
  }
  searchUploadsV3(accessToken: string, value: unknown): PersonUploadSearchResultV3 {
    const actor = this.authenticate(accessToken); const request = this.input(() => validatePersonUploadSearchV2(value));
    return this.read(accessToken, actor, { operation: 'upload_search_v3' }, (transaction, snapshot) => transaction.searchUploadsV3(snapshot, request));
  }

  private authenticate(accessToken: string): PersonAccessAuthorization { return this.dependencies.authenticate(accessToken); }
  private input<T>(validate: () => T): T { try { return validate(); } catch { throw new AuthorityOperationError('invalid_request', 'request failed'); } }
  private write<T>(actor: PersonAccessAuthorization, scope: ProjectAuthorizationScopeV1, operation: (transaction: ProjectContextWriteTransactionV1, snapshot: ReturnType<ProjectContextWriteTransactionV1['captureAuthorization']>) => T): T {
    return this.dependencies.repository.withWriteTransaction(transaction => operation(transaction, transaction.captureAuthorization(actor, scope)));
  }
  private read<T extends ProjectReadResponseV1>(accessToken: string, actor: PersonAccessAuthorization, scope: ProjectAuthorizationScopeV1, select: (transaction: ProjectContextReadTransactionV1, snapshot: ReturnType<ProjectContextReadTransactionV1['captureAuthorization']>) => T): T {
    return this.dependencies.repository.withReadTransaction(transaction => {
      const snapshot = transaction.captureAuthorization(actor, scope);
      const response = select(transaction, snapshot);
      // This is deliberately inside the same synchronous transaction as the
      // repository's release audit. No await or external call can intervene.
      return transaction.revalidateAndAuditRelease(snapshot, this.authenticate(accessToken), response);
    });
  }
}

export function createProjectContextApplicationV1(dependencies: ProjectContextApplicationDependenciesV1): ProjectContextApplicationV1 {
  return new ProjectContextApplication(dependencies);
}
