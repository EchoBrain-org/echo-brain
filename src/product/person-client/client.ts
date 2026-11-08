import { randomBytes, randomUUID } from "node:crypto";
import {
  PERSON_DOCUMENT_TRANSFER_DEADLINE_MS, isCanonicalPersonEmail, isExpectedPersonEmail, validateOrganizationPersonSession, validatePersonDocumentAssociateV1,
  validatePersonDocumentDissociateV1, validatePersonDocumentIdV1, validatePersonDocumentSearchV2, validatePersonListRequestV1, validatePersonOpenRequestV1,
  validatePersonQueryText, validatePersonSourceEvidenceReadRequestV1, validatePersonUpdateRequestId, validateProjectIdV1,
  type OrganizationDirectorySearchV1, type OrganizationPersonSessionV2, type PersonAnswerPreviousV1, type PersonAskCheckRequestV1, type PersonAskCheckV1,
  type PersonChangesV1, type PersonDiagnosticCaptureIdV1, type PersonDiagnosticsRequestV1, type PersonDiagnosticsResultsV1, type PersonDocumentAssociateV1,
  type PersonDocumentDissociateV1, type PersonDocumentSearchV2, type PersonListRequestV1, type PersonOpenRequestV1, type PersonProjectActivityV1,
  type PersonResearchEvalReadResponseV1, type PersonResearchEvalStartReceiptV1, type PersonResearchEvalStartRequestV1, type PersonRunsRequestV1,
  type PersonRunsResultsV1, type PersonSourceEvidenceReadRequestV1, type PersonToolSessionV1, type PersonUpdateSubmitV3, type ProjectIdV1, type ProjectPageRequestV2,
} from '@echo-brain/organization-api';
import { prepareDocumentSnapshot, resumeDocumentSnapshot, listDocumentSnapshots, abandonDocumentSnapshot, reconcileDocumentSnapshot, saveDocumentDownload, type DocumentFileUploadV2, type DocumentSnapshot } from './document-file.js';
import {
  CONTEXT_ROUTES,
  PersonAuthorityClient,
  DEFAULT_TIMEOUT_MS, ASK_TIMEOUT_MS, ASK_CHECK_TIMEOUT_MS,
  PersonAuthorityClientError,
  PersonContextMutationError,
  unknownContextMutation,
  unknownDocumentMutation,
  type EmployeeRosterV1,
  type PersonAnswerV8,
  type PersonEvidenceDeskV1,
  type PersonEvidenceSearchV1,
  type PersonAskSourceEvidenceV1,
  type PersonAskProgressSinkV3,
  type PersonLiveAnswerV3,
  type PersonListV1,
  type PersonOpenV1,
  type PersonRecordListV1,
  type PersonRecordSearchV2,
  type ContextReply,
  type ContextRouteName,
} from "./authority-client.js";
import {
  PersonClientSessionUnavailableError,
  PersonSessionStore,
  type PersonSessionEndedCode,
  type StoredPersonClientSessionV1,
} from "./session-store.js";
import {
  preflightPersonOnboardingInvitationOutput,
  writePersonOnboardingInvitation,
} from "./onboarding-invitation.js";
import { PersonSessionOperations } from './session-operations.js';

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
  /**
   * The one account a pinned run is for: under its lease, each operation is refused before its own request goes out as
   * another. A refresh the lease needs is not pinned; it renews whatever session is stored, as before.
   */
  readonly account?: { readonly authority: string; readonly membership_id: string };
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

export type EmployeeMutationErrorCode = "invalid_email" | "invalid_name" | "invitation_output_invalid" | "employee_already_exists" | "employee_onboarding_complete"
  | "owner_access_required" | "sign_in_required" | "reauthentication_required" | "invitation_save_failed" | "request_rejected" | "outcome_unknown";

export type EmployeeMutationOutcome = "not_submitted" | "rejected" | "committed" | "unknown";

export class EmployeeMutationError extends Error {
  constructor(public readonly code: EmployeeMutationErrorCode, public readonly mutation_outcome: EmployeeMutationOutcome, message: string) {
    super(message);
    this.name = "EmployeeMutationError";
  }
}

function employeeRequestFailure(error: unknown, conflictCode: "employee_already_exists" | "employee_onboarding_complete" | undefined): EmployeeMutationError {
  if (error instanceof EmployeeMutationError) return error;
  if (error instanceof PersonClientSessionUnavailableError) return new EmployeeMutationError("sign_in_required", "not_submitted", error.message);
  if (error instanceof PersonAuthorityClientError) {
    // Status alone cannot establish a rejected mutation. The Authority
    // client's error code is validated from its error envelope; malformed
    // error bodies retain their HTTP status but are `invalid_response`.
    if (error.code === "conflict" && error.status === 409 && conflictCode !== undefined) {
      return new EmployeeMutationError(conflictCode, "rejected", conflictCode === "employee_onboarding_complete"
        ? "Employee identity onboarding is already complete; use person login with the Authority URL on the employee machine." : error.message);
    }
    // The employee-management request itself reached the Authority. A
    // current session may have lost owner eligibility between the local
    // check and this write, so this is a rejected write, not a preflight.
    if (error.code === "unauthorized" && error.status === 401) return new EmployeeMutationError("owner_access_required", "rejected", error.message);
    if (error.status !== null && error.status < 500 && error.code !== "invalid_response") return new EmployeeMutationError("request_rejected", "rejected", error.message);
  }
  return new EmployeeMutationError("outcome_unknown", "unknown", error instanceof Error ? error.message : "Employee request outcome is unknown");
}

function employeeSessionFailure(error: unknown): EmployeeMutationError {
  if (error instanceof EmployeeMutationError) return error;
  if (error instanceof PersonClientSessionUnavailableError) return new EmployeeMutationError(error.code ?? "sign_in_required", "not_submitted", error.message);
  if (error instanceof PersonAuthorityClientError && error.code === "unauthorized" && error.status === 401) {
    return new EmployeeMutationError("sign_in_required", "not_submitted", error.message);
  }
  return new EmployeeMutationError("outcome_unknown", "not_submitted", error instanceof Error ? error.message : "Employee request could not start");
}

function validateEmployeeDisplayName(name: string): void {
  if (name.length < 1 || name.length > 200 || name !== name.trim() || name !== name.normalize("NFC") || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new EmployeeMutationError("invalid_name", "not_submitted", "Employee name is invalid");
  }
}

function invitationOutputPath(path: string): string {
  try { return preflightPersonOnboardingInvitationOutput(path); }
  catch (error) { throw new EmployeeMutationError("invitation_output_invalid", "not_submitted", (error as Error).message); }
}

/** Preserve the public query error type before transport schema validation. */
function validateAskInput(question: string, scope: ProjectIdV1 | undefined): void {
  validatePersonQueryText(question);
  if (scope !== undefined) validateProjectIdV1(scope, 'Ask project_id');
}

/** A refreshed session is the same account; another sign-in is not. */
function sameAccount(current: StoredPersonClientSessionV1, stored: StoredPersonClientSessionV1): boolean {
  return current.authority_origin === stored.authority_origin &&
    current.authority_id === stored.authority_id &&
    current.session.organization_id === stored.session.organization_id &&
    current.session.principal_id === stored.session.principal_id &&
    current.session.membership_id === stored.session.membership_id &&
    current.session.session_family_id === stored.session.session_family_id;
}

function summary(stored: StoredPersonClientSessionV1): PersonClientSessionSummary {
  const { session } = stored;
  return Object.freeze({ authority_origin: stored.authority_origin, authority_id: stored.authority_id, organization_id: session.organization_id,
    principal_id: session.principal_id, membership_id: session.membership_id, display_name: session.display_name, membership_type: session.membership_type,
    access_expires_at: session.access_expires_at, hard_reauthentication_at: session.hard_reauthentication_at });
}

function assertRefreshIdentity(previous: OrganizationPersonSessionV2, next: OrganizationPersonSessionV2): void {
  for (const key of ["organization_id", "principal_id", "membership_id", "membership_type", "identity_binding_id", "session_family_id", "hard_reauthentication_at"] as const) {
    if (previous[key] !== next[key]) throw new PersonClientSessionUnavailableError(`Person session refresh changed ${key}; sign in again`, { code: "sign_in_required" });
  }
  if (previous.refresh_token === next.refresh_token) {
    throw new PersonClientSessionUnavailableError("Person session refresh did not rotate its refresh token; sign in again", { code: "sign_in_required" });
  }
}

export class PersonClient {
  private readonly store: PersonSessionStore;
  private readonly operations: PersonSessionOperations;
  private readonly now: () => string;
  private readonly randomBytes: (size: number) => Uint8Array;
  private readonly randomUuid: () => string;

  constructor(private readonly options: PersonClientOptions) {
    this.store = new PersonSessionStore(options.home_directory);
    this.operations = new PersonSessionOperations(this.store.paths.directory);
    this.now = options.now ?? (() => new Date().toISOString());
    this.randomBytes = options.random_bytes ?? randomBytes;
    this.randomUuid = options.random_uuid ?? randomUUID;
  }

  private authority(origin: string): PersonAuthorityClient {
    return new PersonAuthorityClient({ authority_origin: origin, ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
      allow_insecure_loopback: this.options.allow_insecure_loopback === true });
  }

  private currentTime(): number {
    const value = Date.parse(this.now());
    if (!Number.isFinite(value)) throw new Error("Person client clock is invalid");
    return value;
  }

  /** The signed-in session, refused unless it is the account this client is pinned to. */
  private readPinned(): StoredPersonClientSessionV1 {
    const stored = this.store.read();
    const pin = this.options.account;
    if (pin !== undefined && (stored.authority_origin !== pin.authority || stored.session.membership_id !== pin.membership_id)) {
      throw new PersonAuthorityClientError('stale_access_state', null, 'Person account changed during the request');
    }
    return stored;
  }

  private requestId(prefix: string): string {
    if (!/^[a-z][a-z0-9]{0,15}$/.test(prefix)) throw new Error("Person request identifier prefix is invalid");
    return `${prefix}_${this.randomUuid()}`;
  }

  async beginLogin(authorityOrigin: string, loginGrant?: string, loopbackHandoff?: PersonOidcLoopbackHandoff, loginHint?: string) {
    const handoff = loopbackHandoff === undefined ? {} : { loopback_handoff: loopbackHandoff };
    return await this.authority(authorityOrigin).beginOidcLogin(loginGrant === undefined
      ? { kind: "existing_identity_login", ...handoff }
      : { kind: "identity_bootstrap", login_grant: loginGrant, ...(loginHint === undefined ? {} : { login_hint: loginHint }), ...handoff });
  }

  async installSession(authorityOrigin: string, value: unknown): Promise<PersonClientSessionSummary> {
    const session = validateOrganizationPersonSession(value);
    if (this.currentTime() >= Date.parse(session.hard_reauthentication_at)) throw new Error("Person session is already past hard reauthentication");
    const descriptor = await this.authority(authorityOrigin).descriptor();
    if (descriptor.authority_descriptor.organization_id !== session.organization_id) throw new Error("Person session belongs to another organization");
    return summary(this.store.install(authorityOrigin, descriptor.authority_descriptor.authority_id, session));
  }

  sessionSummary(): PersonClientSessionSummary {
    return summary(this.store.read());
  }

  /** Signed out by a refresh here: why, and the organization it was for. Null otherwise. */
  sessionEnded(): { readonly reason: PersonSessionEndedCode; readonly authority_origin: string } | null {
    const ended = this.store.readEnded();
    return ended === null ? null : Object.freeze({ reason: ended.reason, authority_origin: ended.authority_origin });
  }

  async refresh(signal?: AbortSignal): Promise<PersonClientSessionSummary> {
    signal?.throwIfAborted();
    this.store.assertSessionPresent();
    return this.operations.refresh(() => this.store.tryClaimRefresh(), async claimed => {
      let next: OrganizationPersonSessionV2;
      try {
        if (
          this.currentTime() >=
          Date.parse(claimed.stored.session.hard_reauthentication_at)
        ) {
          throw new PersonClientSessionUnavailableError(
            "Person session requires authentication again",
            { code: "reauthentication_required" },
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
        // The weekly sign-in passed, or the Authority refused or answered for
        // another session: status says why until someone signs in or out.
        const ended = refused ? "sign_in_required"
          : error instanceof PersonClientSessionUnavailableError ? error.code : undefined;
        this.store.releaseRefresh(claimed, unsent, ended);
        if (refused) {
          throw new PersonClientSessionUnavailableError(
            "Person session refresh was refused; sign in again",
            { cause: error, code: "sign_in_required" },
          );
        }
        throw error;
      }
      return summary(this.store.completeRefresh(claimed, next));
    }, signal);
  }

  /** Keep the credential alive until the entire request (including its stream) ends. */
  private async withSession<T>(operation: (stored: StoredPersonClientSessionV1) => Promise<T>, signal?: AbortSignal, headroomMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    this.store.assertSessionPresent();
    let refreshed = false;
    while (true) {
      const result = await this.operations.read(async () => {
        const stored = this.readPinned();
        if (Date.parse(stored.session.access_expires_at) - this.currentTime() < headroomMs) {
          if (refreshed) throw new PersonClientSessionUnavailableError('Refreshed Person session is too short for this request');
          return { kind: 'refresh' as const };
        }
        return { kind: 'result' as const, value: await operation(stored) };
      }, signal);
      if (result.kind === 'result') return result.value;
      // Never wait for a refresh while holding our own read lease.
      await this.refresh(signal);
      refreshed = true;
    }
  }

  private assertCurrentSession(stored: StoredPersonClientSessionV1): void {
    if (!sameAccount(this.store.read(), stored)) {
      throw new Error("Person tool operation did not match the current account");
    }
  }

  private async withEmployeeSession<T>(operation: (stored: StoredPersonClientSessionV1) => Promise<T>): Promise<T> {
    let started = false;
    try {
      return await this.withSession(async stored => {
        if (stored.session.membership_type !== "owner") throw new EmployeeMutationError("owner_access_required", "not_submitted", "Employee management requires owner access");
        started = true;
        return operation(stored);
      });
    } catch (error) {
      if (!started) throw employeeSessionFailure(error);
      throw error;
    }
  }

  async logout(): Promise<void> {
    const claimed = this.store.claimLogout();
    try {
      await this.authority(claimed.authority_origin).logout(claimed.session.access_token);
    } catch (error) {
      // A membership revocation has already invalidated this credential. The
      // Authority's explicit 401 is therefore a successful terminal result
      // for local sign-out. Transport and server failures remain visible.
      if (!(error instanceof PersonAuthorityClientError && error.code === "unauthorized" && error.status === 401)) throw error;
    } finally {
      this.store.finishLogout();
    }
  }

  private async withContextSession<T>(
    operation: (authority: PersonAuthorityClient, accessToken: string) => Promise<T>,
    mutation?: { request_id: string; upload?: boolean },
  ): Promise<T> {
    let started = false;
    try {
      return await this.withSession(async stored => {
        started = true;
        const result = await operation(this.authority(stored.authority_origin), stored.session.access_token);
        try { this.assertCurrentSession(stored); }
        catch {
          if (mutation !== undefined) throw unknownContextMutation(mutation.request_id, mutation.upload === true, null);
          throw new PersonAuthorityClientError('stale_access_state', null, 'Person account changed during the request');
        }
        return result;
      });
    } catch (error) {
      if (started || mutation === undefined) throw error;
      throw new PersonContextMutationError(
        error instanceof PersonClientSessionUnavailableError ? 'sign_in_required' : 'unavailable',
        error instanceof PersonAuthorityClientError ? error.status : null,
        'Person request could not start. Retain the same request ID and draft.', mutation.request_id, 'not_submitted');
    }
  }

  private async withReadSession<T>(
    operation: (authority: PersonAuthorityClient, accessToken: string) => Promise<T>,
    signal?: AbortSignal,
    headroomMs = DEFAULT_TIMEOUT_MS,
  ): Promise<T> {
    return this.withSession(async stored => {
      const result = await operation(this.authority(stored.authority_origin), stored.session.access_token);
      this.assertCurrentSession(stored);
      return result;
    }, signal, headroomMs);
  }

  private documentBinding(stored: StoredPersonClientSessionV1): string {
    return JSON.stringify([stored.authority_origin, stored.authority_id, stored.session.organization_id, stored.session.membership_id]);
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

  async uploadDocumentV2(input: DocumentFileUploadV2) {
    validatePersonUpdateRequestId(input.request_id);
    return this.withSession(async stored => this.submitDocumentSnapshot(stored, prepareDocumentSnapshot(this.options.home_directory, this.documentBinding(stored), input)),
      undefined, PERSON_DOCUMENT_TRANSFER_DEADLINE_MS + 2 * DEFAULT_TIMEOUT_MS);
  }

  async retryDocument(requestId: string) {
    validatePersonUpdateRequestId(requestId);
    return this.withSession(async stored => this.submitDocumentSnapshot(stored, resumeDocumentSnapshot(this.options.home_directory, this.documentBinding(stored), requestId)),
      undefined, PERSON_DOCUMENT_TRANSFER_DEADLINE_MS + 2 * DEFAULT_TIMEOUT_MS);
  }

  pendingDocuments() {
    const stored = this.readPinned();
    const snapshots = listDocumentSnapshots(this.options.home_directory, this.documentBinding(stored));
    this.assertCurrentSession(stored);
    return { schema_version: 1, kind: 'echo-person-document-pending-v1', snapshots };
  }

  abandonDocument(requestId: string) {
    validatePersonUpdateRequestId(requestId);
    const stored = this.readPinned();
    this.assertCurrentSession(stored);
    const removed = abandonDocumentSnapshot(this.options.home_directory, this.documentBinding(stored), requestId);
    this.assertCurrentSession(stored);
    return { schema_version: 1, kind: 'echo-person-document-abandoned-v1', request_id: requestId,
      local_snapshot_removed: removed, authority_outcome: 'unchanged' };
  }

  async changeDocumentAssociation(value: PersonDocumentAssociateV1 | PersonDocumentDissociateV1) {
    const request = value.kind === 'echo-person-document-associate-v1' ? validatePersonDocumentAssociateV1(value) : validatePersonDocumentDissociateV1(value);
    return this.withSession(async stored => {
      const result = await this.authority(stored.authority_origin).changeDocumentAssociation(stored.session.access_token, request);
      try { this.assertCurrentSession(stored); } catch { throw unknownContextMutation(request.request_id, false, null); }
      return result;
    });
  }

  async documentStatusV2(requestId: string) {
    validatePersonUpdateRequestId(requestId);
    return this.withSession(async stored => {
      const receipt = await this.authority(stored.authority_origin).documentStatusV2(stored.session.access_token, requestId);
      this.assertCurrentSession(stored);
      try { reconcileDocumentSnapshot(this.options.home_directory, this.documentBinding(stored), receipt); }
      catch { /* Status remains useful even if local snapshot cleanup is unavailable. */ }
      return receipt;
    });
  }

  async searchDocumentsV2(input: PersonDocumentSearchV2) {
    const request = validatePersonDocumentSearchV2(input);
    return this.withContextSession((authority, token) => authority.searchDocumentsV2(token, request));
  }

  async downloadDocumentV2(documentId: string, outputPath: string, projectId?: string) {
    validatePersonDocumentIdV1(documentId);
    return this.withSession(async stored => {
      const authority = this.authority(stored.authority_origin);
      const metadata = await authority.documentMetadataV2(stored.session.access_token, documentId, projectId);
      this.assertCurrentSession(stored);
      const response = await authority.documentOriginalV2(stored.session.access_token, documentId, projectId);
      const output = await saveDocumentDownload(response, outputPath, metadata, () => this.assertCurrentSession(stored));
      return { document_id: documentId, output_path: output, content_length: metadata.content_length, sha256: metadata.sha256 };
    }, undefined, PERSON_DOCUMENT_TRANSFER_DEADLINE_MS + 2 * DEFAULT_TIMEOUT_MS);
  }

  /**
   * One project-context route (CONTEXT_ROUTES): its request is validated before the session is used, and a mutation's
   * outcome is never left unsaid (PersonContextMutationError).
   */
  async context<K extends ContextRouteName>(name: K, value: unknown): Promise<ContextReply<K>> {
    const selected = CONTEXT_ROUTES[name];
    const request = selected.request(value);
    return this.withContextSession((authority, token) => authority.context(token, name, request),
      selected.mutation === undefined ? undefined : { request_id: (request as { readonly request_id: string }).request_id, upload: selected.mutation === 'upload' });
  }

  projectsV2(value: ProjectPageRequestV2 = {}) { return this.context('projectsV2', value); }
  organizationDirectory(value: OrganizationDirectorySearchV1 = {}) { return this.context('organizationDirectory', value); }
  submitUpdateV3(value: PersonUpdateSubmitV3) { return this.context('submitUpdateV3', value); }
  updateStatusV3(requestId: string) { return this.context('updateStatusV3', requestId); }

  async records(limit?: number, query?: string, recordSha256?: `sha256:${string}`): Promise<PersonRecordListV1 | PersonRecordSearchV2> {
    return this.withSession(async stored => query !== undefined
      ? await this.authority(stored.authority_origin).searchRecords(stored.session.access_token, query, limit)
      : await this.authority(stored.authority_origin).records(stored.session.access_token, limit, recordSha256));
  }

  /**
   * The Ask `person ask` asks, `POST /v7/person/ask`, in every scope: all
   * request-advertised live evidence sources, ECHO's shared follow-ups
   * (ADR-0040), and the asker's projects, people, tools and tool containers
   * (research tool contract v1). It may carry the asker's previous turn
   * (ADR-0047) and a diagnostic capture. It is the one streamed Ask
   * (askWithLiveProgress) with its steps unread.
   */
  async askWithLiveSources(question: string, scope?: ProjectIdV1, signal?: AbortSignal, captureId?: PersonDiagnosticCaptureIdV1,
    previous?: PersonAnswerPreviousV1): Promise<PersonAnswerV8> {
    return (await this.askWithLiveProgress(question, scope, signal, () => undefined, previous, captureId)).result;
  }

  /**
   * Every Ask, in Ask progress V3 (ADR-0039): each step event reaches
   * `onProgress` as it arrives, and may name a follow-up, a project, a
   * person, a tool or a tool container; the answer carries its receipt only
   * when the Authority streamed. A JSON answer comes back without progress or a
   * receipt.
   *
   * A step is passed on only while the account that asked is the signed-in
   * one. Another account stops the Ask at once. A step that arrives while no
   * session can be read (a refresh elsewhere, or a sign-out) is withheld, and
   * the final account check decides, as it does for every read. A client
   * pinned to its account (`account`, as the desktop's runs are) is never
   * asked for as another: a session another sign-in installed first is
   * refused before the Ask is sent, so no step of that account reaches it.
   */
  async askWithLiveProgress(question: string, scope: ProjectIdV1 | undefined, signal: AbortSignal | undefined,
    onProgress: PersonAskProgressSinkV3, previous?: PersonAnswerPreviousV1, captureId?: PersonDiagnosticCaptureIdV1): Promise<PersonLiveAnswerV3> {
    validateAskInput(question, scope);
    return this.withSession(async stored => {
      const authority = this.authority(stored.authority_origin);
      const token = stored.session.access_token;
      const forward: PersonAskProgressSinkV3 = event => {
        let current: StoredPersonClientSessionV1;
        try { current = this.store.read(); } catch (error) {
          if (error instanceof PersonClientSessionUnavailableError) return;
          throw error;
        }
        if (!sameAccount(current, stored)) throw new Error("Person tool operation did not match the current account");
        onProgress(event);
      };
      const answer = await authority.askV7WithProgress(token, question, scope, signal, forward, previous, captureId);
      this.assertCurrentSession(stored);
      return answer;
    }, signal, ASK_TIMEOUT_MS + DEFAULT_TIMEOUT_MS);
  }

  /** Prepare before starting work so the capture remains readable even if the product response is lost. */
  async diagnostics<K extends PersonDiagnosticsRequestV1['operation']>(value: Extract<PersonDiagnosticsRequestV1, { readonly operation: K }>, signal?: AbortSignal): Promise<PersonDiagnosticsResultsV1[K]> {
    return this.withReadSession((authority, token) => authority.diagnostics(token, value, signal), signal, ASK_TIMEOUT_MS + DEFAULT_TIMEOUT_MS);
  }

  /** Staging-only research evaluation (research loop evaluation v1); no CLI command exposes it. */
  async startResearchEval(value: PersonResearchEvalStartRequestV1, signal?: AbortSignal): Promise<PersonResearchEvalStartReceiptV1> {
    return this.withReadSession((authority, token) => authority.startResearchEval(token, value, signal), signal, ASK_TIMEOUT_MS + DEFAULT_TIMEOUT_MS);
  }

  async readResearchEval(runId: string, signal?: AbortSignal): Promise<PersonResearchEvalReadResponseV1> {
    return this.withReadSession((authority, token) => authority.readResearchEval(token, runId, signal), signal, ASK_TIMEOUT_MS + DEFAULT_TIMEOUT_MS);
  }

  /** What moved in this person's own view, one fingerprint per area (ADR-0036). */
  async changes(signal?: AbortSignal): Promise<PersonChangesV1> {
    return this.withReadSession((authority, token) => authority.changes(token, signal), signal);
  }

  /** When each of this person's active projects last had news from someone else (Ask timeline v1, C2). */
  async projectActivity(signal?: AbortSignal): Promise<PersonProjectActivityV1> {
    return this.withReadSession((authority, token) => authority.projectActivity(token, signal), signal);
  }

  async runs<K extends PersonRunsRequestV1['operation']>(value: Extract<PersonRunsRequestV1, { readonly operation: K }>, signal?: AbortSignal): Promise<PersonRunsResultsV1[K]> {
    return this.withReadSession((authority, token) => authority.runs(token, value, signal), signal);
  }

  /** Whether each source old answers cited is the same, changed, unreadable or unknown now (ADR-0047). */
  async askCheck(value: PersonAskCheckRequestV1, signal?: AbortSignal): Promise<PersonAskCheckV1> {
    return this.withReadSession((authority, token) => authority.askCheck(token, value, signal), signal, ASK_CHECK_TIMEOUT_MS);
  }

  /**
   * One evidence desk search under a new authenticated, scope-bound request. No command runs it: the research-loop
   * evaluation finds approved meetings' record citations with it (tools/evals/research-loop/lib/bindings.mjs).
   */
  async evidenceSearch(value: PersonEvidenceSearchV1, signal?: AbortSignal): Promise<PersonEvidenceDeskV1> {
    return this.withReadSession((authority, token) => authority.evidenceSearch(token, value, signal), signal);
  }

  /** One model-free list page under a fresh authenticated read (ADR-0024). */
  async list(value: PersonListRequestV1, signal?: AbortSignal): Promise<PersonListV1> {
    const request = validatePersonListRequestV1(value);
    return this.withReadSession((authority, token) => authority.list(token, request, signal), signal);
  }

  /** Opens one ref from a list row or an Ask citation under the caller's current access. */
  async open(value: PersonOpenRequestV1, signal?: AbortSignal): Promise<PersonOpenV1> {
    const request = validatePersonOpenRequestV1(value);
    return this.withReadSession((authority, token) => authority.open(token, request, signal), signal);
  }

  async askSourceEvidence(value: PersonSourceEvidenceReadRequestV1): Promise<PersonAskSourceEvidenceV1> {
    const request = validatePersonSourceEvidenceReadRequestV1(value);
    return this.withReadSession((authority, token) => authority.askSourceEvidence(token, request), undefined, ASK_TIMEOUT_MS + DEFAULT_TIMEOUT_MS);
  }

  async withToolSession<T>(operation: (session: PersonToolSessionV1) => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    return this.withSession(async stored => {
      signal?.throwIfAborted();
      const result = await operation(Object.freeze({
        identity: Object.freeze({ organization_id: stored.session.organization_id, membership_id: stored.session.membership_id }),
        transport: this.authority(stored.authority_origin).toolTransport(stored.session.access_token, signal),
        request_id: (prefix: string) => this.requestId(prefix),
        random_bytes: (size: number) => this.randomBytes(size),
      }));
      signal?.throwIfAborted();
      this.assertCurrentSession(stored);
      return result;
    }, signal);
  }

  async tools() {
    return this.withSession(async stored => {
      const result = await this.authority(stored.authority_origin).tools(stored.session.access_token);
      const current = this.store.read();
      if (result.organization_id !== stored.session.organization_id || result.membership_id !== stored.session.membership_id ||
          current.authority_origin !== stored.authority_origin || current.session.membership_id !== stored.session.membership_id ||
          current.session.session_family_id !== stored.session.session_family_id) {
        throw new Error("Connected tools did not match the current account");
      }
      return result;
    });
  }

  async employees(): Promise<EmployeeRosterV1> {
    return this.withSession(async stored => await this.authority(stored.authority_origin).employees(stored.session.access_token));
  }

  async inviteEmployee(input: { name: string; email: string; output_path: string }): Promise<{ output_path: string; expires_at: string }> {
    validateEmployeeDisplayName(input.name);
    if (!isExpectedPersonEmail(input.email)) throw new EmployeeMutationError("invalid_email", "not_submitted", "Employee email must be a canonical lowercase mailbox");
    return this.issueEmployeeInvitation(invitationOutputPath(input.output_path), input.email, "invite",
      stored => this.authority(stored.authority_origin).inviteEmployee({ name: input.name, email: input.email }, stored.session.access_token));
  }

  async reissueEmployee(input: { email: string; output_path: string }): Promise<{ output_path: string; expires_at: string }> {
    if (!isCanonicalPersonEmail(input.email)) throw new EmployeeMutationError("invalid_email", "not_submitted", "Employee email must be a canonical durable identity");
    return this.issueEmployeeInvitation(invitationOutputPath(input.output_path), input.email, "reissue",
      stored => this.authority(stored.authority_origin).reissueEmployee({ email: input.email }, stored.session.access_token));
  }

  async revokeEmployee(email: string): Promise<void> {
    if (!isCanonicalPersonEmail(email)) throw new EmployeeMutationError("invalid_email", "not_submitted", "Employee email must be a canonical durable identity");
    return this.withEmployeeSession(async stored => {
      try { await this.authority(stored.authority_origin).revokeEmployee({ email }, stored.session.access_token); }
      catch (error) { throw employeeRequestFailure(error, undefined); }
    });
  }

  /** An owner's one-time invitation, issued under the owner's session and saved privately; a reissued legacy identity gets a v1 file. */
  private async issueEmployeeInvitation(outputPath: string, email: string, mode: "invite" | "reissue",
    issue: (stored: StoredPersonClientSessionV1) => Promise<{ login_grant: string; expires_at: string }>): Promise<{ output_path: string; expires_at: string }> {
    return this.withEmployeeSession(async stored => {
      try {
        const issued = await issue(stored);
        // A different local writer can win after preflight. O_EXCL leaves its
        // file untouched; the owner can safely reissue the one-time grant.
        try {
          writePersonOnboardingInvitation(outputPath, mode === "invite" || isExpectedPersonEmail(email)
            ? { schema_version: 2, kind: "echo-person-onboarding-invitation", authority_url: stored.authority_origin, login_grant: issued.login_grant,
              expires_at: issued.expires_at, expected_email: email }
            : { schema_version: 1, kind: "echo-person-onboarding-invitation", authority_url: stored.authority_origin, login_grant: issued.login_grant,
              expires_at: issued.expires_at });
        } catch (error) {
          throw new EmployeeMutationError("invitation_save_failed", "committed", error instanceof Error ? error.message : "Employee invitation could not be saved");
        }
        return Object.freeze({ output_path: outputPath, expires_at: issued.expires_at });
      } catch (error) {
        throw employeeRequestFailure(error, mode === "invite" ? "employee_already_exists" : "employee_onboarding_complete");
      }
    });
  }
}
