import type { Sha256Digest } from '@echo-brain/federation-protocol';
import type {
  PersonUpdateReceiptV3,
  PersonUpdateStatusResultV3,
  PersonUpdateSubmitV3,
  PersonUploadSearchV2,
  PersonUploadSearchResultV2,
  PersonUploadSearchResultV3,
  OrganizationDirectorySearchV1,
  OrganizationDirectoryV1,
  ProjectContextAssociateV1,
  ProjectContextBrowseV1,
  ProjectContextDissociateV1,
  ProjectContextSearchV1,
  ProjectContextSearchResultV2,
  ProjectCreateReceiptV1,
  ProjectCreateV1,
  ProjectArchiveV1,
  ProjectLeaveV1,
  ProjectRenameV1,
  ProjectSettingsReceiptV1,
  ProjectMemberAddV1,
  ProjectDirectorySearchV1,
  ProjectDirectoryV1,
  ProjectIdV1,
  ProjectMembersV1,
  ProjectMemberRemoveV1,
  ProjectMemberSetV1,
  ProjectMutationReceiptV1,
  ProjectPageRequestV2,
  ProjectRoleV1,
  ProjectSummaryV2,
  ProjectListV2,
} from '@echo-brain/organization-api';
import type { AuthorityPersonMembershipBinding } from '@echo-brain/organization-authority-kernel/application/ports/authority-repository';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';

/**
 * PC-00 contracts only. No implementation, route or project capability is
 * installed by this module. HTTP owns transport; the application authenticates
 * each call and validates unknown input before calling the repository.
 */
export interface ProjectContextApplicationV1 {
  createProject(accessToken: string, request: unknown): ProjectCreateReceiptV1;
  listProjectsV2(accessToken: string, request: unknown): ProjectListV2;
  readProjectV2(accessToken: string, projectId: unknown): ProjectSummaryV2;
  /** Current project members may see their project's active roster. */
  listMembers(accessToken: string, request: unknown): ProjectMembersV1;
  /** Lead-only directory for selecting active organization membership targets. */
  searchDirectory(accessToken: string, request: unknown): ProjectDirectoryV1;
  /**
   * The same active-member rows for any active member of the caller's
   * organization, with no project or lead grant (ADR-0016). It lets a person
   * pick people before a project exists.
   */
  searchOrganizationDirectory(accessToken: string, request: unknown): OrganizationDirectoryV1;
  /** Add as a member without changing an already-active project's role. */
  addMember(accessToken: string, request: unknown): ProjectMutationReceiptV1;
  setMember(accessToken: string, request: unknown): ProjectMutationReceiptV1;
  removeMember(accessToken: string, request: unknown): ProjectMutationReceiptV1;
  associateContext(accessToken: string, request: unknown): ProjectMutationReceiptV1;
  dissociateContext(accessToken: string, request: unknown): ProjectMutationReceiptV1;
  renameProject(accessToken: string, request: unknown): ProjectSettingsReceiptV1;
  archiveProject(accessToken: string, request: unknown): ProjectSettingsReceiptV1;
  leaveProject(accessToken: string, request: unknown): ProjectSettingsReceiptV1;
  searchV2(accessToken: string, request: unknown): ProjectContextSearchResultV2;
  submitUploadV3(accessToken: string, request: unknown): PersonUpdateReceiptV3;
  uploadStatusV3(accessToken: string, requestId: unknown): PersonUpdateStatusResultV3;
  /** The notes stored as V2, which no V3 read returns. */
  searchUploads(accessToken: string, request: unknown): PersonUploadSearchResultV2;
  searchUploadsV3(accessToken: string, request: unknown): PersonUploadSearchResultV3;
}

/** `project_list` is captured for its grants (records, the workspace), never released by a route. */
export type ProjectReadOperationV1 =
  | 'project_list' | 'project_list_v2' | 'project_read_v2' | 'members' | 'directory' | 'organization_directory'
  | 'search_v2'
  | 'upload_search'
  | 'upload_status_v3' | 'upload_search_v3';

export type ProjectMutationV1 =
  | { readonly operation: 'create'; readonly request: ProjectCreateV1 }
  | { readonly operation: 'member_set'; readonly request: ProjectMemberAddV1 | ProjectMemberSetV1 }
  | { readonly operation: 'member_remove'; readonly request: ProjectMemberRemoveV1 }
  | { readonly operation: 'associate'; readonly request: ProjectContextAssociateV1 }
  | { readonly operation: 'dissociate'; readonly request: ProjectContextDissociateV1 }
  | { readonly operation: 'rename'; readonly request: ProjectRenameV1 }
  | { readonly operation: 'archive'; readonly request: ProjectArchiveV1 }
  | { readonly operation: 'leave'; readonly request: ProjectLeaveV1 }
  | { readonly operation: 'upload_submit_v3'; readonly request: PersonUpdateSubmitV3 };

/** Trusted application input. Never decoded from a Person's JSON or session. */
export type ProjectAuthorizationScopeV1 =
  | { readonly operation: 'project_list' | 'project_list_v2' | 'upload_search' }
  | { readonly operation: 'upload_search_v3' }
  | { readonly operation: 'project_read_v2' | 'members' | 'search_v2'; readonly project_id: ProjectIdV1 }
  /** Directory authorization requires the current project's lead grant. */
  | { readonly operation: 'directory'; readonly project_id: ProjectIdV1 }
  /** Any active member of the caller's own organization; no project grant. */
  | { readonly operation: 'organization_directory' }
  | { readonly operation: 'upload_status_v3'; readonly request_id: string }
  | ProjectMutationV1;

export interface ProjectMembershipGrantV1 {
  readonly project_id: ProjectIdV1;
  /** Fresh grant ID on project rejoin, even within the same organization tenure. */
  readonly project_membership_id: string;
  readonly organization_id: string;
  readonly principal_id: string;
  readonly membership_id: string;
  readonly role: ProjectRoleV1;
}

/**
 * Private release witness. The digest commits the relevant project/grant,
 * audience, association and current organization-membership state, including
 * the authorized set for list/search. It is NEVER a public response field or
 * an opaque public surrogate for hidden/global activity (ADR-0012).
 *
 * A selected project and a different audience project require both grants.
 * Generic reads of Only me/Team originals do not require the association's
 * project grant and must not reveal that association.
 */
export interface ProjectAuthorizationSnapshotV1 {
  readonly person: Readonly<PersonAccessAuthorization>;
  readonly scope: ProjectAuthorizationScopeV1;
  readonly project_state_sha256: Sha256Digest;
  readonly grants: readonly ProjectMembershipGrantV1[];
}

export type ProjectReadResponseV1 =
  | ProjectListV2 | ProjectSummaryV2 | ProjectMembersV1 | ProjectDirectoryV1 | OrganizationDirectoryV1
  | ProjectContextSearchResultV2
  | PersonUploadSearchResultV2
  | PersonUpdateStatusResultV3 | PersonUploadSearchResultV3;

/**
 * PC-01 implements these operations over a single SQLite snapshot. All reads
 * select permitted candidates BEFORE matching, scoring, pagination or excerpts.
 * Missing/inaccessible identifiers have the same not_found result. PC-02 owns
 * the application policy and final current-session check.
 */
export interface ProjectContextReadTransactionV1 {
  captureAuthorization(actor: PersonAccessAuthorization, scope: ProjectAuthorizationScopeV1): ProjectAuthorizationSnapshotV1;
  listProjectsV2(snapshot: ProjectAuthorizationSnapshotV1, request: ProjectPageRequestV2): ProjectListV2;
  readProjectV2(snapshot: ProjectAuthorizationSnapshotV1, projectId: ProjectIdV1): ProjectSummaryV2;
  /** Member-readable active project roster; no revoked grants. */
  listMembers(snapshot: ProjectAuthorizationSnapshotV1, request: ProjectContextBrowseV1): ProjectMembersV1;
  /** Requires a current target-project lead grant before inspecting candidates. */
  searchDirectory(snapshot: ProjectAuthorizationSnapshotV1, request: ProjectDirectorySearchV1): ProjectDirectoryV1;
  /** The snapshot person's own organization only; requires active membership. */
  searchOrganizationDirectory(snapshot: ProjectAuthorizationSnapshotV1, request: OrganizationDirectorySearchV1): OrganizationDirectoryV1;
  searchV2(snapshot: ProjectAuthorizationSnapshotV1, request: ProjectContextSearchV1): ProjectContextSearchResultV2;
  uploadStatusV3(snapshot: ProjectAuthorizationSnapshotV1, requestId: string): PersonUpdateStatusResultV3;
  searchUploads(snapshot: ProjectAuthorizationSnapshotV1, request: PersonUploadSearchV2): PersonUploadSearchResultV2;
  searchUploadsV3(snapshot: ProjectAuthorizationSnapshotV1, request: PersonUploadSearchV2): PersonUploadSearchResultV3;
  /**
   * Compare current session/person and project state, validate the response kind
   * against the admitted operation, and derive the digest/count from this exact
   * validated response (never from caller-supplied audit fields). Commit the
   * minimized audit before returning an immutable response copy for release.
   * The application returns that copy unchanged. No await/provider call may
   * intervene. Stale state or failed audit throws and releases nothing.
   * The caller resolves its current session here, not before selection.
   */
  revalidateAndAuditRelease<Response extends ProjectReadResponseV1>(snapshot: ProjectAuthorizationSnapshotV1, currentActor: PersonAccessAuthorization, response: Response): Response;
}

export interface ProjectContextWriteTransactionV1 extends ProjectContextReadTransactionV1 {
  /** Active organization membership only; never look up a target by email/name. */
  activeMembership(membershipId: string): AuthorityPersonMembershipBinding | undefined;
  /**
   * Every mutation rechecks its snapshot and target organization membership in
   * the write transaction. Request replay is keyed by organization + membership
   * + request_id, with the complete operation/payload commitment. A changed
   * command conflicts; identical retry returns its immutable committed receipt.
   * Replays never restore membership, associations or enrichment work.
   */
  createProject(snapshot: ProjectAuthorizationSnapshotV1, request: ProjectCreateV1): ProjectCreateReceiptV1;
  addMember(snapshot: ProjectAuthorizationSnapshotV1, request: ProjectMemberAddV1): ProjectMutationReceiptV1;
  setMember(snapshot: ProjectAuthorizationSnapshotV1, request: ProjectMemberSetV1): ProjectMutationReceiptV1;
  removeMember(snapshot: ProjectAuthorizationSnapshotV1, request: ProjectMemberRemoveV1): ProjectMutationReceiptV1;
  associateContext(snapshot: ProjectAuthorizationSnapshotV1, request: ProjectContextAssociateV1): ProjectMutationReceiptV1;
  dissociateContext(snapshot: ProjectAuthorizationSnapshotV1, request: ProjectContextDissociateV1): ProjectMutationReceiptV1;
  renameProject(snapshot: ProjectAuthorizationSnapshotV1, request: ProjectRenameV1): ProjectSettingsReceiptV1;
  archiveProject(snapshot: ProjectAuthorizationSnapshotV1, request: ProjectArchiveV1): ProjectSettingsReceiptV1;
  leaveProject(snapshot: ProjectAuthorizationSnapshotV1, request: ProjectLeaveV1): ProjectSettingsReceiptV1;
  /** Atomically commits exact original, initial coordinates, receipt and work. */
  submitUploadV3(snapshot: ProjectAuthorizationSnapshotV1, request: PersonUpdateSubmitV3): PersonUpdateReceiptV3;
}

export interface ProjectContextRepositoryV1 {
  /**
   * The callback is synchronous and must not escape its transaction. The
   * implementation rejects async/thenable callbacks, nested transactions and
   * cross-handle calls; no transaction callback may perform network I/O.
   * Read transactions permit only the required release-audit append.
   */
  withReadTransaction<T>(operation: (transaction: ProjectContextReadTransactionV1) => T): T;
  withWriteTransaction<T>(operation: (transaction: ProjectContextWriteTransactionV1) => T): T;
}

/** Existing serialized upload worker consumes this check; no new scheduler. */
export interface ProjectUploadEnrichmentAuthorizationV1 {
  /**
   * Resolve current exact uploader tenure and (for project audience) its
   * current audience-project grant immediately before source/model handoff.
   * Association is not permission. Revalidate before storing derived hints;
   * revocation cancels enrichment, leaving the immutable original accessible
   * to its remaining permitted readers.
   */
  capture(contextId: string): ProjectUploadEnrichmentSnapshotV1 | undefined;
  assertCurrent(snapshot: ProjectUploadEnrichmentSnapshotV1): void;
}

export interface ProjectUploadEnrichmentSnapshotV1 {
  readonly context_id: string;
  readonly uploader: AuthorityPersonMembershipBinding;
  readonly authorization_sha256: Sha256Digest;
}
