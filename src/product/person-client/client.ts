import { validatePersonDocumentAssociateV1, validatePersonDocumentDissociateV1, type PersonDocumentAssociateV1, type PersonDocumentDissociateV1 } from '@echo-brain/organization-api';
import { validatePersonDocumentIdV1, validatePersonDocumentSearchV1, validatePersonDocumentSearchV2, type PersonDocumentSearchV1, type PersonDocumentSearchV2 } from '@echo-brain/organization-api';
import { prepareDocumentSnapshot, resumeDocumentSnapshot, listDocumentSnapshots, abandonDocumentSnapshot, reconcileDocumentSnapshot, saveDocumentDownload, type DocumentFileUpload, type DocumentFileUploadV2, type DocumentSnapshot } from './document-file.js';
import { validatePersonUploadContextId } from '@echo-brain/organization-api';
import { validatePersonUpdateRequestId } from '@echo-brain/organization-api';
import { validatePersonQueryText } from '@echo-brain/organization-api';
import { validatePersonSourceEvidenceReadRequestV1, type PersonSourceEvidenceReadRequestV1 } from '@echo-brain/organization-api';
import type { PersonToolSessionV1 } from '@echo-brain/organization-api';
import {
  validateProjectPageRequestV1, validateProjectCreateV1, validateProjectIdV1,
  validateProjectContextBrowseV1, validateProjectDirectorySearchV1,
  validateProjectMemberAddV1, validateProjectMemberSetV1, validateProjectMemberRemoveV1, validateProjectContextAssociateV1, validateProjectContextDissociateV1,
  validateProjectContextSearchV1, validateProjectContextReadRequestV1, validatePersonUpdateSubmitV2, validatePersonUploadSearchV2,
  type ProjectPageRequestV1, type ProjectCreateV1, type ProjectContextBrowseV1, type ProjectDirectorySearchV1,
  type ProjectMemberAddV1, type ProjectMemberSetV1, type ProjectMemberRemoveV1, type ProjectContextAssociateV1, type ProjectContextDissociateV1,
  type ProjectContextSearchV1, type ProjectContextReadRequestV1, type PersonUpdateSubmitV2, type PersonUploadSearchV2, type ProjectIdV1,
} from '@echo-brain/organization-api';
import { validatePersonUpdateSubmitV3, validatePersonUploadSearchV3, type PersonUpdateSubmitV3, type PersonUploadSearchV3 } from '@echo-brain/organization-api';
import { validateOrganizationDirectorySearchV1, type OrganizationDirectorySearchV1 } from '@echo-brain/organization-api';
import { randomBytes, randomUUID } from "node:crypto";
import { isCanonicalPersonEmail, isExpectedPersonEmail, validateOrganizationPersonSession, type OrganizationPersonMeetingIngestionExclusionSelectorV2, type OrganizationPersonSessionV2 } from "@echo-brain/organization-api";
import {
  PersonAuthorityClient,
  PersonAuthorityClientError,
  PersonContextMutationError,
  unknownContextMutation,
  unknownDocumentMutation,
  type EmployeeRosterV1,
  type PersonAnswerV3,
  type PersonAskSourceEvidenceV1,
  type PersonRecordListV1,
  type PersonRecordSearchV2,
} from "./authority-client.js";
import {
  createPersonMeetingIngestionExclusionChangeRequest,
  createPersonMeetingIngestionExclusionListRequest,
} from "./person-api-request-builders.js";
import {
  PersonClientSessionUnavailableError,
  PersonSessionStore,
  type StoredPersonClientSessionV1,
} from "./session-store.js";
import {
  preflightPersonOnboardingInvitationOutput,
  writePersonOnboardingInvitation,
} from "./onboarding-invitation.js";

interface PersonOidcLoopbackHandoff {
  readonly url: string;
  readonly token: string;
}

export interface PersonClientOptions {
  readonly home_directory: string;
  readonly fetch?: typeof fetch;
  readonly allow_insecure_loopback?: boolean;
  readonly now?: () => string;
  readonly random_bytes?: (size: number) => Uint8Array;
  readonly random_uuid?: () => string;
}

export interface PersonClientSessionSummary {
  readonly authority_origin: string;
  readonly authority_id: string;
  readonly organization_id: string;
  readonly principal_id: string;
  readonly membership_id: string;
  readonly display_name: string;
  readonly membership_type: "owner" | "employee";
  readonly access_expires_at: string;
  readonly hard_reauthentication_at: string;
}

export type EmployeeMutationErrorCode =
  | "invalid_email"
  | "invalid_name"
  | "invitation_output_invalid"
  | "employee_already_exists"
  | "employee_onboarding_complete"
  | "owner_access_required"
  | "sign_in_required"
  | "invitation_save_failed"
  | "request_rejected"
  | "outcome_unknown";

export type EmployeeMutationOutcome =
  | "not_submitted"
  | "rejected"
  | "committed"
  | "unknown";

export class EmployeeMutationError extends Error {
  constructor(
    public readonly code: EmployeeMutationErrorCode,
    public readonly mutation_outcome: EmployeeMutationOutcome,
    message: string,
  ) {
    super(message);
    this.name = "EmployeeMutationError";
  }
}

function employeeRequestFailure(
  error: unknown,
  conflictCode: "employee_already_exists" | "employee_onboarding_complete" | undefined,
): EmployeeMutationError {
  if (error instanceof EmployeeMutationError) return error;
  if (error instanceof PersonClientSessionUnavailableError) {
    return new EmployeeMutationError("sign_in_required", "not_submitted", error.message);
  }
  if (error instanceof PersonAuthorityClientError) {
    // Status alone cannot establish a rejected mutation. The Authority
    // client's error code is validated from its error envelope; malformed
    // error bodies retain their HTTP status but are `invalid_response`.
    if (error.code === "conflict" && error.status === 409 && conflictCode !== undefined) {
      return new EmployeeMutationError(
        conflictCode,
        "rejected",
        conflictCode === "employee_onboarding_complete"
          ? "Employee identity onboarding is already complete; use person login with the Authority URL on the employee machine."
          : error.message,
      );
    }
    if (error.code === "unauthorized" && error.status === 401) {
      // The employee-management request itself reached the Authority. A
      // current session may have lost owner eligibility between the local
      // check and this write, so this is a rejected write, not a preflight.
      return new EmployeeMutationError("owner_access_required", "rejected", error.message);
    }
    if (
      error.status !== null &&
      error.status < 500 &&
      error.code !== "invalid_response"
    ) {
      return new EmployeeMutationError("request_rejected", "rejected", error.message);
    }
  }
  return new EmployeeMutationError(
    "outcome_unknown",
    "unknown",
    error instanceof Error ? error.message : "Employee request outcome is unknown",
  );
}

function employeeSessionFailure(error: unknown): EmployeeMutationError {
  if (error instanceof EmployeeMutationError) return error;
  if (
    error instanceof PersonClientSessionUnavailableError ||
    (error instanceof PersonAuthorityClientError &&
      error.code === "unauthorized" &&
      error.status === 401)
  ) {
    return new EmployeeMutationError("sign_in_required", "not_submitted", error.message);
  }
  return new EmployeeMutationError(
    "outcome_unknown",
    "not_submitted",
    error instanceof Error ? error.message : "Employee request could not start",
  );
}

function validateEmployeeDisplayName(name: string): void {
  if (
    name.length < 1 ||
    name.length > 200 ||
    name !== name.trim() ||
    name !== name.normalize("NFC") ||
    /[\u0000-\u001f\u007f]/.test(name)
  ) {
    throw new EmployeeMutationError(
      "invalid_name",
      "not_submitted",
      "Employee name is invalid",
    );
  }
}

function summary(
  stored: StoredPersonClientSessionV1,
): PersonClientSessionSummary {
  return Object.freeze({
    authority_origin: stored.authority_origin,
    authority_id: stored.authority_id,
    organization_id: stored.session.organization_id,
    principal_id: stored.session.principal_id,
    membership_id: stored.session.membership_id,
    display_name: stored.session.display_name,
    membership_type: stored.session.membership_type,
    access_expires_at: stored.session.access_expires_at,
    hard_reauthentication_at: stored.session.hard_reauthentication_at,
  });
}

function assertRefreshIdentity(
  previous: OrganizationPersonSessionV2,
  next: OrganizationPersonSessionV2,
): void {
  for (const key of [
    "organization_id",
    "principal_id",
    "membership_id",
    "membership_type",
    "identity_binding_id",
    "session_family_id",
    "hard_reauthentication_at",
  ] as const) {
    if (previous[key] !== next[key]) {
      throw new PersonClientSessionUnavailableError(`Person session refresh changed ${key}; sign in again`);
    }
  }
  if (previous.refresh_token === next.refresh_token) {
    throw new PersonClientSessionUnavailableError("Person session refresh did not rotate its refresh token; sign in again");
  }
}

export class PersonClient {
  private readonly store: PersonSessionStore;
  private readonly now: () => string;
  private readonly randomBytes: (size: number) => Uint8Array;
  private readonly randomUuid: () => string;

  constructor(private readonly options: PersonClientOptions) {
    this.store = new PersonSessionStore(options.home_directory);
    this.now = options.now ?? (() => new Date().toISOString());
    this.randomBytes = options.random_bytes ?? randomBytes;
    this.randomUuid = options.random_uuid ?? randomUUID;
  }

  private authority(origin: string): PersonAuthorityClient {
    return new PersonAuthorityClient({
      authority_origin: origin,
      ...(this.options.fetch === undefined
        ? {}
        : { fetch: this.options.fetch }),
      allow_insecure_loopback: this.options.allow_insecure_loopback === true,
    });
  }

  private currentTime(): number {
    const value = Date.parse(this.now());
    if (!Number.isFinite(value))
      throw new Error("Person client clock is invalid");
    return value;
  }

  private requestId(
    prefix: string,
  ): string {
    if (!/^[a-z][a-z0-9]{0,15}$/.test(prefix)) throw new Error("Person request identifier prefix is invalid");
    return `${prefix}_${this.randomUuid()}`;
  }

  async beginLogin(
    authorityOrigin: string,
    loginGrant?: string,
    loopbackHandoff?: PersonOidcLoopbackHandoff,
    loginHint?: string,
  ) {
    return await this.authority(authorityOrigin).beginOidcLogin(
      loginGrant === undefined
        ? {
            kind: "existing_identity_login",
            ...(loopbackHandoff === undefined
              ? {}
              : { loopback_handoff: loopbackHandoff }),
          }
        : {
            kind: "identity_bootstrap",
            login_grant: loginGrant,
            ...(loginHint === undefined ? {} : { login_hint: loginHint }),
            ...(loopbackHandoff === undefined
              ? {}
              : { loopback_handoff: loopbackHandoff }),
          },
    );
  }

  async installSession(
    authorityOrigin: string,
    value: unknown,
  ): Promise<PersonClientSessionSummary> {
    const session = validateOrganizationPersonSession(value);
    if (this.currentTime() >= Date.parse(session.hard_reauthentication_at)) {
      throw new Error("Person session is already past hard reauthentication");
    }
    const descriptor = await this.authority(authorityOrigin).descriptor();
    if (
      descriptor.authority_descriptor.organization_id !==
      session.organization_id
    ) {
      throw new Error("Person session belongs to another organization");
    }
    return summary(
      this.store.install(
        authorityOrigin,
        descriptor.authority_descriptor.authority_id,
        session,
      ),
    );
  }

  sessionSummary(): PersonClientSessionSummary {
    return summary(this.store.read());
  }

  async refresh(): Promise<PersonClientSessionSummary> {
    const claimed = this.store.claimRefresh();
    let next: OrganizationPersonSessionV2;
    try {
      if (
        this.currentTime() >=
        Date.parse(claimed.stored.session.hard_reauthentication_at)
      ) {
        throw new PersonClientSessionUnavailableError(
          "Person session requires authentication again",
        );
      }
      next = await this.authority(claimed.stored.authority_origin).refresh(
        claimed.stored.session.refresh_token,
      );
      assertRefreshIdentity(claimed.stored.session, next);
    } catch (error) {
      // Only a request that never left this machine (no connection at all,
      // as when the network is not up yet) puts the claimed session back: the
      // refresh token is certainly unused. Any other failure is ambiguous or
      // final, and ADR-0002 never replays an ambiguous refresh: the claim is
      // released and the store is left plainly signed out.
      const refused =
        error instanceof PersonAuthorityClientError &&
        ((error.code === "unauthorized" && error.status === 401) ||
          (error.code === "invalid_request" && error.status === 400));
      const unsent = error instanceof PersonAuthorityClientError && error.unsent;
      this.store.releaseRefresh(claimed, unsent);
      if (refused) {
        throw new PersonClientSessionUnavailableError(
          "Person session refresh was refused; sign in again",
          { cause: error },
        );
      }
      throw error;
    }
    return summary(this.store.completeRefresh(claimed, next));
  }

  private async accessSession(): Promise<StoredPersonClientSessionV1> {
    const stored = this.store.read();
    if (this.currentTime() < Date.parse(stored.session.access_expires_at)) {
      return stored;
    }
    await this.refresh();
    return this.store.read();
  }

  private assertCurrentSession(stored: StoredPersonClientSessionV1): void {
    const current = this.store.read();
    if (
      current.authority_origin !== stored.authority_origin ||
      current.authority_id !== stored.authority_id ||
      current.session.organization_id !== stored.session.organization_id ||
      current.session.principal_id !== stored.session.principal_id ||
      current.session.membership_id !== stored.session.membership_id ||
      current.session.session_family_id !== stored.session.session_family_id
    ) {
      throw new Error("Person tool operation did not match the current account");
    }
  }

  private async employeeManagementSession(): Promise<StoredPersonClientSessionV1> {
    let stored: StoredPersonClientSessionV1;
    try {
      stored = await this.accessSession();
    } catch (error) {
      throw employeeSessionFailure(error);
    }
    if (stored.session.membership_type !== "owner") {
      throw new EmployeeMutationError(
        "owner_access_required",
        "not_submitted",
        "Employee management requires owner access",
      );
    }
    return stored;
  }

  async logout(): Promise<void> {
    const claimed = this.store.claimLogout();
    try {
      await this.authority(claimed.authority_origin).logout(
        claimed.session.access_token,
      );
    } catch (error) {
      // A membership revocation has already invalidated this credential. The
      // Authority's explicit 401 is therefore a successful terminal result
      // for local sign-out. Transport and server failures remain visible.
      if (
        !(
          error instanceof PersonAuthorityClientError &&
          error.code === "unauthorized" &&
          error.status === 401
        )
      ) {
        throw error;
      }
    } finally {
      this.store.finishLogout();
    }
  }

  private async withContextSession<T>(
    operation: (authority: PersonAuthorityClient, accessToken: string) => Promise<T>,
    mutation?: { request_id: string; upload?: boolean },
  ): Promise<T> {
    let stored: StoredPersonClientSessionV1;
    try {
      stored = await this.accessSession();
    } catch (error) {
      if (mutation === undefined) throw error;
      throw new PersonContextMutationError(
        error instanceof PersonClientSessionUnavailableError ? 'sign_in_required' : 'unavailable',
        error instanceof PersonAuthorityClientError ? error.status : null,
        'Person request could not start. Retain the same request ID and draft.', mutation.request_id, 'not_submitted');
    }
    const result = await operation(this.authority(stored.authority_origin), stored.session.access_token);
    try {
      this.assertCurrentSession(stored);
    } catch {
      if (mutation !== undefined) throw unknownContextMutation(mutation.request_id, mutation.upload === true, null);
      throw new PersonAuthorityClientError('stale_access_state', null, 'Person account changed during the request');
    }
    return result;
  }

  private documentBinding(stored: StoredPersonClientSessionV1): string {
    return JSON.stringify([stored.authority_origin, stored.authority_id, stored.session.organization_id, stored.session.membership_id]);
  }

  private assertDocumentAccount(stored: StoredPersonClientSessionV1, requestId: string, expected: { expected_authority?: string; expected_membership_id?: string }): void {
    if ((expected.expected_authority !== undefined || expected.expected_membership_id !== undefined) &&
        (expected.expected_authority !== stored.authority_origin || expected.expected_membership_id !== stored.session.membership_id)) {
      throw new PersonContextMutationError('stale_access_state', null, 'The signed-in account changed before the document operation. Restore the selected account before retrying.', requestId, 'not_submitted');
    }
  }

  private async submitDocumentSnapshot(stored: StoredPersonClientSessionV1, snapshot: DocumentSnapshot) {
    let submitted = false;
    try {
      this.assertCurrentSession(stored);
      submitted = true;
      const receipt = await this.authority(stored.authority_origin).uploadDocument(stored.session.access_token, snapshot);
      try { this.assertCurrentSession(stored); } catch { throw unknownDocumentMutation(snapshot.metadata.request_id, null); }
      try { snapshot.remove(); } catch { /* A retained successful snapshot can be safely reconciled later. */ }
      return receipt;
    } catch (error) {
      if (!snapshot.reused && (!submitted || (error instanceof PersonContextMutationError && error.mutation_outcome === 'not_submitted'))) snapshot.remove();
      throw error;
    }
  }

  async uploadDocument(input: DocumentFileUpload | DocumentFileUploadV2) {
    validatePersonUpdateRequestId(input.request_id);
    const stored = await this.accessSession();
    this.assertDocumentAccount(stored, input.request_id, input);
    return this.submitDocumentSnapshot(stored, prepareDocumentSnapshot(this.options.home_directory, this.documentBinding(stored), input));
  }

  async uploadDocumentV2(input: DocumentFileUploadV2) {
    return this.uploadDocument(input);
  }

  async retryDocument(requestId: string, expected: { expected_authority?: string; expected_membership_id?: string } = {}) {
    validatePersonUpdateRequestId(requestId);
    const stored = await this.accessSession();
    this.assertDocumentAccount(stored, requestId, expected);
    return this.submitDocumentSnapshot(stored, resumeDocumentSnapshot(this.options.home_directory, this.documentBinding(stored), requestId));
  }

  pendingDocuments() {
    const stored = this.store.read();
    const snapshots = listDocumentSnapshots(this.options.home_directory, this.documentBinding(stored));
    this.assertCurrentSession(stored);
    return { schema_version: 1, kind: 'echo-person-document-pending-v1', snapshots };
  }

  abandonDocument(requestId: string, expected: { expected_authority?: string; expected_membership_id?: string } = {}) {
    validatePersonUpdateRequestId(requestId);
    const stored = this.store.read();
    this.assertDocumentAccount(stored, requestId, expected);
    this.assertCurrentSession(stored);
    const removed = abandonDocumentSnapshot(this.options.home_directory, this.documentBinding(stored), requestId);
    this.assertCurrentSession(stored);
    return { schema_version: 1, kind: 'echo-person-document-abandoned-v1', request_id: requestId,
      local_snapshot_removed: removed, authority_outcome: 'unchanged' };
  }

  async changeDocumentAssociation(value: PersonDocumentAssociateV1 | PersonDocumentDissociateV1,
    expected: { expected_authority?: string; expected_membership_id?: string } = {}) {
    const request = value.kind === 'echo-person-document-associate-v1' ? validatePersonDocumentAssociateV1(value) : validatePersonDocumentDissociateV1(value);
    const stored = await this.accessSession();
    this.assertDocumentAccount(stored, request.request_id, expected);
    const result = await this.authority(stored.authority_origin).changeDocumentAssociation(stored.session.access_token, request);
    try { this.assertCurrentSession(stored); } catch { throw unknownContextMutation(request.request_id, false, null); }
    return result;
  }

  async documentStatus(requestId: string) {
    validatePersonUpdateRequestId(requestId);
    const stored = await this.accessSession();
    const receipt = await this.authority(stored.authority_origin).documentStatus(stored.session.access_token, requestId);
    this.assertCurrentSession(stored);
    try { reconcileDocumentSnapshot(this.options.home_directory, JSON.stringify([stored.authority_origin, stored.authority_id, stored.session.organization_id, stored.session.membership_id]), receipt); }
    catch { /* Status remains useful even if local snapshot cleanup is unavailable. */ }
    return receipt;
  }

  async documentStatusV2(requestId: string) {
    validatePersonUpdateRequestId(requestId);
    const stored = await this.accessSession();
    const receipt = await this.authority(stored.authority_origin).documentStatusV2(stored.session.access_token, requestId);
    this.assertCurrentSession(stored);
    try { reconcileDocumentSnapshot(this.options.home_directory, this.documentBinding(stored), receipt); }
    catch { /* Status remains useful even if local snapshot cleanup is unavailable. */ }
    return receipt;
  }

  async readDocument(documentId: string, cursor?: string, projectId?: string) {
    validatePersonDocumentIdV1(documentId);
    if (cursor !== undefined && (!/^[A-Za-z0-9_-]+$/.test(cursor) || cursor.length > 1024)) throw new Error('Document cursor is invalid');
    return this.withContextSession(async (authority, token) => {
      let metadata = await authority.documentMetadata(token, documentId, projectId);
      for (let attempt = 0; attempt < 3; attempt++) {
        const text = await authority.documentText(token, documentId, cursor, projectId);
        if (metadata.document_id !== text.document_id || metadata.sha256 !== text.original_sha256) throw new PersonAuthorityClientError('invalid_response', 200, 'Document text provenance did not match its original.');
        if (metadata.extractor === text.extractor && metadata.extraction_state === text.extraction_state) return { metadata, text };
        // Extraction can finish between the two reads. Refresh the metadata under the
        // same current session instead of returning a pair native clients must reject.
        const refreshed = await authority.documentMetadata(token, documentId, projectId);
        if (refreshed.document_id !== metadata.document_id || refreshed.sha256 !== metadata.sha256 ||
            refreshed.request_id !== metadata.request_id || refreshed.content_length !== metadata.content_length) {
          throw new PersonAuthorityClientError('invalid_response', 200, 'Document original changed while loading its text.');
        }
        metadata = refreshed;
        if (metadata.extractor === text.extractor && metadata.extraction_state === text.extraction_state) return { metadata, text };
      }
      throw new PersonAuthorityClientError('unavailable', null, 'Document extraction changed while loading. Retry the read.');
    });
  }

  async readDocumentV2(documentId: string, cursor?: string, projectId?: string) {
    validatePersonDocumentIdV1(documentId);
    if (cursor !== undefined && (!/^[A-Za-z0-9_-]+$/.test(cursor) || cursor.length > 1024)) throw new Error('Document cursor is invalid');
    return this.withContextSession(async (authority, token) => {
      let metadata = await authority.documentMetadataV2(token, documentId, projectId);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const text = await authority.documentTextV2(token, documentId, cursor, projectId);
        if (metadata.document_id !== text.document_id || metadata.sha256 !== text.original_sha256) throw new PersonAuthorityClientError('invalid_response', 200, 'Document text provenance did not match its original.');
        if (metadata.extractor === text.extractor && metadata.extraction_state === text.extraction_state) return { metadata, text };
        const refreshed = await authority.documentMetadataV2(token, documentId, projectId);
        if (refreshed.document_id !== metadata.document_id || refreshed.sha256 !== metadata.sha256 || refreshed.request_id !== metadata.request_id || refreshed.content_length !== metadata.content_length) throw new PersonAuthorityClientError('invalid_response', 200, 'Document original changed while loading its text.');
        metadata = refreshed;
        if (metadata.extractor === text.extractor && metadata.extraction_state === text.extraction_state) return { metadata, text };
      }
      throw new PersonAuthorityClientError('unavailable', null, 'Document extraction changed while loading. Retry the read.');
    });
  }

  async searchDocuments(input: PersonDocumentSearchV1) {
    const request = validatePersonDocumentSearchV1(input);
    return this.withContextSession((authority, token) => authority.searchDocuments(token, request));
  }

  async searchDocumentsV2(input: PersonDocumentSearchV2) {
    const request = validatePersonDocumentSearchV2(input);
    return this.withContextSession((authority, token) => authority.searchDocumentsV2(token, request));
  }

  async downloadDocument(documentId: string, outputPath: string, projectId?: string) {
    validatePersonDocumentIdV1(documentId);
    const stored = await this.accessSession();
    const authority = this.authority(stored.authority_origin);
    const metadata = await authority.documentMetadata(stored.session.access_token, documentId, projectId);
    this.assertCurrentSession(stored);
    const response = await authority.documentOriginal(stored.session.access_token, documentId, projectId);
    const output = await saveDocumentDownload(response, outputPath, metadata, () => this.assertCurrentSession(stored));
    return { document_id: documentId, output_path: output, content_length: metadata.content_length, sha256: metadata.sha256 };
  }

  async downloadDocumentV2(documentId: string, outputPath: string, projectId?: string) {
    validatePersonDocumentIdV1(documentId);
    const stored = await this.accessSession();
    const authority = this.authority(stored.authority_origin);
    const metadata = await authority.documentMetadataV2(stored.session.access_token, documentId, projectId);
    this.assertCurrentSession(stored);
    const response = await authority.documentOriginalV2(stored.session.access_token, documentId, projectId);
    const output = await saveDocumentDownload(response, outputPath, metadata, () => this.assertCurrentSession(stored));
    return { document_id: documentId, output_path: output, content_length: metadata.content_length, sha256: metadata.sha256 };
  }

  async projects(value: ProjectPageRequestV1 = {}) {
    const request = validateProjectPageRequestV1(value);
    return this.withContextSession((authority, token) => authority.projects(token, request));
  }

  async createProject(value: ProjectCreateV1) {
    const request = validateProjectCreateV1(value);
    return this.withContextSession((authority, token) => authority.createProject(token, request), request);
  }

  async readProject(projectId: string) {
    const project = validateProjectIdV1(projectId);
    return this.withContextSession((authority, token) => authority.readProject(token, project));
  }

  async projectMembers(value: ProjectContextBrowseV1) {
    const request = validateProjectContextBrowseV1(value);
    return this.withContextSession((authority, token) => authority.projectMembers(token, request));
  }

  async projectDirectory(value: ProjectDirectorySearchV1) {
    const request = validateProjectDirectorySearchV1(value);
    return this.withContextSession((authority, token) => authority.projectDirectory(token, request));
  }

  async organizationDirectory(value: OrganizationDirectorySearchV1 = {}) {
    const request = validateOrganizationDirectorySearchV1(value);
    return this.withContextSession((authority, token) => authority.organizationDirectory(token, request));
  }

  async addProjectMember(value: ProjectMemberAddV1) {
    const request = validateProjectMemberAddV1(value);
    return this.withContextSession((authority, token) => authority.addProjectMember(token, request), request);
  }

  async setProjectMember(value: ProjectMemberSetV1) {
    const request = validateProjectMemberSetV1(value);
    return this.withContextSession((authority, token) => authority.setProjectMember(token, request), request);
  }

  async removeProjectMember(value: ProjectMemberRemoveV1) {
    const request = validateProjectMemberRemoveV1(value);
    return this.withContextSession((authority, token) => authority.removeProjectMember(token, request), request);
  }

  async associateProjectContext(value: ProjectContextAssociateV1) {
    const request = validateProjectContextAssociateV1(value);
    return this.withContextSession((authority, token) => authority.associateProjectContext(token, request), request);
  }

  async dissociateProjectContext(value: ProjectContextDissociateV1) {
    const request = validateProjectContextDissociateV1(value);
    return this.withContextSession((authority, token) => authority.dissociateProjectContext(token, request), request);
  }

  async projectFeed(value: ProjectContextBrowseV1) {
    const request = validateProjectContextBrowseV1(value);
    return this.withContextSession((authority, token) => authority.projectFeed(token, request));
  }

  async searchProjectContext(value: ProjectContextSearchV1) {
    const request = validateProjectContextSearchV1(value);
    return this.withContextSession((authority, token) => authority.searchProjectContext(token, request));
  }

  async readProjectContext(value: ProjectContextReadRequestV1) {
    const request = validateProjectContextReadRequestV1(value);
    return this.withContextSession((authority, token) => authority.readProjectContext(token, request));
  }

  async projectFeedV2(value: ProjectContextBrowseV1) {
    const request = validateProjectContextBrowseV1(value);
    return this.withContextSession((authority, token) => authority.projectFeedV2(token, request));
  }

  async searchProjectContextV2(value: ProjectContextSearchV1) {
    const request = validateProjectContextSearchV1(value);
    return this.withContextSession((authority, token) => authority.searchProjectContextV2(token, request));
  }

  async readProjectContextV2(value: ProjectContextReadRequestV1) {
    const request = validateProjectContextReadRequestV1(value);
    return this.withContextSession((authority, token) => authority.readProjectContextV2(token, request));
  }

  async submitUpdateV2(value: PersonUpdateSubmitV2) {
    // Copy and freeze before session refresh can yield. No reread, retry, or
    // request-ID generation may change this attempt's original or coordinates.
    const request = validatePersonUpdateSubmitV2(value);
    Object.freeze(request.audience);
    Object.freeze(request);
    return this.withContextSession((authority, token) => authority.submitUpdateV2(token, request), { request_id: request.request_id, upload: true });
  }

  async updateStatusV2(requestId: string) {
    validatePersonUpdateRequestId(requestId);
    return this.withContextSession((authority, token) => authority.updateStatusV2(token, requestId));
  }

  async readUploadV2(contextId: string) {
    validatePersonUploadContextId(contextId);
    return this.withContextSession((authority, token) => authority.readUploadV2(token, contextId));
  }

  async searchUploadsV2(value: PersonUploadSearchV2) {
    const request = validatePersonUploadSearchV2(value);
    return this.withContextSession((authority, token) => authority.searchUploadsV2(token, request));
  }

  async submitUpdateV3(value: PersonUpdateSubmitV3) {
    const request = validatePersonUpdateSubmitV3(value);
    return this.withContextSession((authority, token) => authority.submitUpdateV3(token, request), { request_id: request.request_id, upload: true });
  }

  async updateStatusV3(requestId: string) {
    validatePersonUpdateRequestId(requestId);
    return this.withContextSession((authority, token) => authority.updateStatusV3(token, requestId));
  }

  async readUploadV3(contextId: string) {
    validatePersonUploadContextId(contextId);
    return this.withContextSession((authority, token) => authority.readUploadV3(token, contextId));
  }

  async searchUploadsV3(value: PersonUploadSearchV3) {
    const request = validatePersonUploadSearchV3(value);
    return this.withContextSession((authority, token) => authority.searchUploadsV3(token, request));
  }

  async records(
    limit?: number,
    query?: string,
    recordSha256?: `sha256:${string}`,
  ): Promise<PersonRecordListV1 | PersonRecordSearchV2> {
    const stored = await this.accessSession();
    if (query !== undefined) {
      return await this.authority(stored.authority_origin).searchRecords(
        stored.session.access_token,
        query,
        limit,
      );
    }
    return await this.authority(stored.authority_origin).records(
      stored.session.access_token,
      limit,
      recordSha256,
    );
  }

  async ask(question: string, projectId?: ProjectIdV1): Promise<PersonAnswerV3> {
    // Preserve the public query error type before transport schema validation.
    validatePersonQueryText(question);
    if (projectId !== undefined) validateProjectIdV1(projectId, 'Ask project_id');
    const stored = await this.accessSession();
    const result = await this.authority(stored.authority_origin).ask(
      stored.session.access_token,
      question,
      projectId,
    );
    this.assertCurrentSession(stored);
    return result;
  }

  async askSourceEvidence(value: PersonSourceEvidenceReadRequestV1): Promise<PersonAskSourceEvidenceV1> {
    const request = validatePersonSourceEvidenceReadRequestV1(value);
    const stored = await this.accessSession();
    const result = await this.authority(stored.authority_origin).askSourceEvidence(
      stored.session.access_token,
      request,
    );
    this.assertCurrentSession(stored);
    return result;
  }

  async changeMeetingIngestionExclusion(
    excluded: boolean,
    selector: OrganizationPersonMeetingIngestionExclusionSelectorV2,
  ): Promise<void> {
    const stored = await this.accessSession();
    await this.authority(stored.authority_origin).changeMeetingIngestionExclusion(
      createPersonMeetingIngestionExclusionChangeRequest(
        stored,
        this.requestId("mex"),
        excluded,
        selector,
      ),
      stored.session.access_token,
    );
  }

  async meetingIngestionExclusions(
    sourceAdapterId: string,
    sourceInstanceId: string,
  ) {
    const stored = await this.accessSession();
    return await this.authority(
      stored.authority_origin,
    ).meetingIngestionExclusions(
      createPersonMeetingIngestionExclusionListRequest(
        stored,
        this.requestId("mex"),
        sourceAdapterId,
        sourceInstanceId,
      ),
      stored.session.access_token,
    );
  }

  async withToolSession<T>(operation: (session: PersonToolSessionV1) => Promise<T>): Promise<T> {
    const stored = await this.accessSession();
    const result = await operation(Object.freeze({
      identity: Object.freeze({ organization_id: stored.session.organization_id, membership_id: stored.session.membership_id }),
      transport: this.authority(stored.authority_origin).toolTransport(stored.session.access_token),
      request_id: (prefix: string) => this.requestId(prefix),
      random_bytes: (size: number) => this.randomBytes(size),
    }));
    this.assertCurrentSession(stored);
    return result;
  }

  async tools() {
    const stored = await this.accessSession();
    const result = await this.authority(stored.authority_origin).tools(stored.session.access_token);
    const current = this.store.read();
    if (result.organization_id !== stored.session.organization_id || result.membership_id !== stored.session.membership_id ||
        current.authority_origin !== stored.authority_origin || current.session.membership_id !== stored.session.membership_id ||
        current.session.session_family_id !== stored.session.session_family_id) {
      throw new Error("Connected tools did not match the current account");
    }
    return result;
  }

  async employees(): Promise<EmployeeRosterV1> {
    const stored = await this.accessSession();
    return await this.authority(stored.authority_origin).employees(
      stored.session.access_token,
    );
  }

  async inviteEmployee(input: {
    name: string;
    email: string;
    output_path: string;
  }): Promise<{ output_path: string; expires_at: string }> {
    validateEmployeeDisplayName(input.name);
    if (!isExpectedPersonEmail(input.email)) {
      throw new EmployeeMutationError(
        "invalid_email",
        "not_submitted",
        "Employee email must be a canonical lowercase mailbox",
      );
    }
    let outputPath: string;
    try {
      outputPath = preflightPersonOnboardingInvitationOutput(input.output_path);
    } catch (error) {
      throw new EmployeeMutationError(
        "invitation_output_invalid",
        "not_submitted",
        (error as Error).message,
      );
    }
    const stored = await this.employeeManagementSession();
    try {
      return await this.issueEmployeeInvitation(outputPath, input.email, "invite", () =>
        this.authority(stored.authority_origin).inviteEmployee(
          { name: input.name, email: input.email },
          stored.session.access_token,
        ), stored.authority_origin);
    } catch (error) {
      throw employeeRequestFailure(error, "employee_already_exists");
    }
  }

  async reissueEmployee(input: {
    email: string;
    output_path: string;
  }): Promise<{ output_path: string; expires_at: string }> {
    if (!isCanonicalPersonEmail(input.email)) {
      throw new EmployeeMutationError(
        "invalid_email",
        "not_submitted",
        "Employee email must be a canonical durable identity",
      );
    }
    let outputPath: string;
    try {
      outputPath = preflightPersonOnboardingInvitationOutput(input.output_path);
    } catch (error) {
      throw new EmployeeMutationError(
        "invitation_output_invalid",
        "not_submitted",
        (error as Error).message,
      );
    }
    const stored = await this.employeeManagementSession();
    try {
      return await this.issueEmployeeInvitation(
        outputPath,
        input.email,
        "reissue",
        () =>
          this.authority(stored.authority_origin).reissueEmployee(
            { email: input.email },
            stored.session.access_token,
          ),
        stored.authority_origin,
      );
    } catch (error) {
      throw employeeRequestFailure(error, "employee_onboarding_complete");
    }
  }

  async revokeEmployee(email: string): Promise<void> {
    if (!isCanonicalPersonEmail(email)) {
      throw new EmployeeMutationError(
        "invalid_email",
        "not_submitted",
        "Employee email must be a canonical durable identity",
      );
    }
    const stored = await this.employeeManagementSession();
    try {
      await this.authority(stored.authority_origin).revokeEmployee(
        { email },
        stored.session.access_token,
      );
    } catch (error) {
      throw employeeRequestFailure(error, undefined);
    }
  }

  private async issueEmployeeInvitation(
    outputPath: string,
    email: string,
    mode: "invite" | "reissue",
    issue: () => Promise<{ login_grant: string; expires_at: string }>,
    authorityOrigin: string,
  ): Promise<{ output_path: string; expires_at: string }> {
    const issued = await issue();
    // A different local writer can win after preflight. O_EXCL leaves its
    // file untouched; the owner can safely reissue the one-time grant.
    try {
      writePersonOnboardingInvitation(
        outputPath,
        mode === "invite" || isExpectedPersonEmail(email)
          ? {
            schema_version: 2,
            kind: "echo-person-onboarding-invitation",
            authority_url: authorityOrigin,
            login_grant: issued.login_grant,
            expires_at: issued.expires_at,
            expected_email: email,
          }
          : {
            schema_version: 1,
            kind: "echo-person-onboarding-invitation",
            authority_url: authorityOrigin,
            login_grant: issued.login_grant,
            expires_at: issued.expires_at,
          },
      );
    } catch (error) {
      throw new EmployeeMutationError(
        "invitation_save_failed",
        "committed",
        error instanceof Error ? error.message : "Employee invitation could not be saved",
      );
    }
    return Object.freeze({ output_path: outputPath, expires_at: issued.expires_at });
  }
}
