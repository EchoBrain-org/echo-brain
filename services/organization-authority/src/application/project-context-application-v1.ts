import {
  validateOrganizationDirectorySearchV1,
  validatePersonUpdateRequestId,
  validatePersonUpdateSubmitV3,
  validateProjectContextAssociateV1,
  validateProjectContextBrowseV1,
  validateProjectContextDissociateV1,
  validateProjectCreateV1,
  validateProjectArchiveV1,
  validateProjectLeaveV1,
  validateProjectRenameV1,
  validateProjectMemberAddV1,
  validateProjectDirectorySearchV1,
  validateProjectIdV1,
  validateProjectMemberRemoveV1,
  validateProjectMemberSetV1,
  validateProjectPageRequestV2,
} from '@echo-brain/organization-api';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type {
  ProjectAuthorizationScopeV1,
  ProjectAuthorizationSnapshotV1,
  ProjectContextApplicationV1,
  ProjectContextReadTransactionV1,
  ProjectContextRepositoryV1,
  ProjectContextWriteTransactionV1,
  ProjectReadResponseV1,
} from './ports/project-context-v1.js';

interface ProjectContextApplicationDependenciesV1 {
  readonly authenticate: (accessToken: string) => PersonAccessAuthorization;
  readonly repository: ProjectContextRepositoryV1;
}

/**
 * Authority-owned V1 application boundary, one table of operations. Each authenticates, then validates, before creating
 * a transaction-local scope; callers cannot supply either.
 */
export function createProjectContextApplicationV1(dependencies: ProjectContextApplicationDependenciesV1): ProjectContextApplicationV1 {
  const input = <R>(validate: (value: unknown) => R, value: unknown): R => {
    try { return validate(value); } catch { throw new AuthorityOperationError('invalid_request', 'request failed'); }
  };
  const write = <R, T>(validate: (value: unknown) => R, scope: (request: R) => ProjectAuthorizationScopeV1,
    run: (transaction: ProjectContextWriteTransactionV1, snapshot: ProjectAuthorizationSnapshotV1, request: R) => T) => (accessToken: string, value: unknown): T => {
    const actor = dependencies.authenticate(accessToken); const request = input(validate, value);
    return dependencies.repository.withWriteTransaction(transaction => run(transaction, transaction.captureAuthorization(actor, scope(request)), request));
  };
  const read = <R, T extends ProjectReadResponseV1>(validate: (value: unknown) => R, scope: (request: R) => ProjectAuthorizationScopeV1,
    select: (transaction: ProjectContextReadTransactionV1, snapshot: ProjectAuthorizationSnapshotV1, request: R) => T) => (accessToken: string, value: unknown): T => {
    const actor = dependencies.authenticate(accessToken); const request = input(validate, value);
    return dependencies.repository.withReadTransaction(transaction => {
      const snapshot = transaction.captureAuthorization(actor, scope(request));
      const response = select(transaction, snapshot, request);
      // This is deliberately inside the same synchronous transaction as the
      // repository's release audit. No await or external call can intervene.
      return transaction.revalidateAndAuditRelease(snapshot, dependencies.authenticate(accessToken), response);
    });
  };
  return Object.freeze({
    createProject: write(validateProjectCreateV1, request => ({ operation: 'create', request }), (t, s, request) => t.createProject(s, request)),
    listProjectsV2: read(validateProjectPageRequestV2, () => ({ operation: 'project_list_v2' }), (t, s, request) => t.listProjectsV2(s, request)),
    readProjectV2: read(validateProjectIdV1, project_id => ({ operation: 'project_read_v2', project_id }), (t, s, projectId) => t.readProjectV2(s, projectId)),
    listMembers: read(validateProjectContextBrowseV1, request => ({ operation: 'members', project_id: request.project_id }), (t, s, request) => t.listMembers(s, request)),
    searchDirectory: read(validateProjectDirectorySearchV1, request => ({ operation: 'directory', project_id: request.project_id }), (t, s, request) => t.searchDirectory(s, request)),
    /** Any active member may search their own organization; see ADR-0016. */
    searchOrganizationDirectory: read(validateOrganizationDirectorySearchV1, () => ({ operation: 'organization_directory' }), (t, s, request) => t.searchOrganizationDirectory(s, request)),
    addMember: write(validateProjectMemberAddV1, request => ({ operation: 'member_set', request }), (t, s, request) => t.addMember(s, request)),
    setMember: write(validateProjectMemberSetV1, request => ({ operation: 'member_set', request }), (t, s, request) => t.setMember(s, request)),
    removeMember: write(validateProjectMemberRemoveV1, request => ({ operation: 'member_remove', request }), (t, s, request) => t.removeMember(s, request)),
    associateContext: write(validateProjectContextAssociateV1, request => ({ operation: 'associate', request }), (t, s, request) => t.associateContext(s, request)),
    dissociateContext: write(validateProjectContextDissociateV1, request => ({ operation: 'dissociate', request }), (t, s, request) => t.dissociateContext(s, request)),
    renameProject: write(validateProjectRenameV1, request => ({ operation: 'rename', request }), (t, s, request) => t.renameProject(s, request)),
    archiveProject: write(validateProjectArchiveV1, request => ({ operation: 'archive', request }), (t, s, request) => t.archiveProject(s, request)),
    leaveProject: write(validateProjectLeaveV1, request => ({ operation: 'leave', request }), (t, s, request) => t.leaveProject(s, request)),
    submitUploadV3: write(validatePersonUpdateSubmitV3, request => ({ operation: 'upload_submit_v3', request }), (t, s, request) => t.submitUploadV3(s, request)),
    uploadStatusV3: read(validatePersonUpdateRequestId, request_id => ({ operation: 'upload_status_v3', request_id }), (t, s, requestId) => t.uploadStatusV3(s, requestId)),
  });
}
