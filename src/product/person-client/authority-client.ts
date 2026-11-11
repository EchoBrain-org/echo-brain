import { Buffer } from "node:buffer";
import { canonicalJson } from "@echo-brain/federation-protocol";
import {
  MAX_ORGANIZATION_API_BODY_BYTES, ORGANIZATION_API_AUTHORITY_DESCRIPTOR_PATH, ORGANIZATION_API_PERSON_OIDC_BEGIN_PATH, ORGANIZATION_API_PERSON_SESSION_REFRESH_PATH,
  ORGANIZATION_API_PERSON_SESSION_REVOCATIONS_PATH, ORGANIZATION_API_PERSON_TOOLS_PATH_V4, PERSON_ANSWER_PATH_V7, PERSON_ASK_CHECK_LIMITS_V1, PERSON_ASK_CHECK_PATH_V1,
  PERSON_ASK_CLIENT_NOW_HEADER_V1, PERSON_ASK_PROGRESS_CONTENT_TYPE_V1, PERSON_ASK_PROGRESS_STREAM_MAX_BYTES_V1, PERSON_ASK_TIME_ZONE_HEADER_V1, PERSON_CHANGES_ROUTE_V1,
  PERSON_DIRECTORY_PATH_V1, PERSON_DOCUMENTS_PATH_V2, PERSON_DOCUMENT_JSON_MAX_BYTES, PERSON_DOCUMENT_TRANSFER_DEADLINE_MS, PERSON_EMPLOYEES_PATH_V1,
  PERSON_LIST_PATH_V1, PERSON_LIST_RESPONSE_MAX_BYTES_V1, PERSON_OPEN_PATH_V1, PERSON_OPEN_RESPONSE_MAX_BYTES_V1, PERSON_PROJECTS_PATH_V1,
  PERSON_PROJECTS_PATH_V2, PERSON_PROJECT_ACTIVITY_PATH_V1, PERSON_PROJECT_ARCHIVE_PATH_V1, PERSON_PROJECT_LEAVE_PATH_V1, PERSON_PROJECT_RENAME_PATH_V1, PERSON_RECORDS_PATH_V1,
  PERSON_RESEARCH_EVAL_MAX_RESPONSE_BYTES_V1, PERSON_RESEARCH_EVAL_READ_PATH_V1, PERSON_RESEARCH_EVAL_START_PATH_V1, PERSON_RUNS_MAX_RESPONSE_BYTES_V1, PERSON_RUNS_PATH_V1,
  PERSON_SOURCE_EVIDENCE_PATH_V1, PERSON_TOOL_COLLECTION_RESPONSE_MAX_BYTES_V1,
  PERSON_TOOL_REQUEST_MAX_BYTES_V1, PERSON_UPDATES_PATH_V3, PROJECT_CONTEXT_RESPONSE_MAX_BYTES, PersonQueryInputError, createPersonAskProgressDecoderV3,
  isOrganizationApiValidationError, validateEmployeeInvitationV1, validateEmployeeRequestV1, validateEmployeeRosterV1, validateOrganizationApiError,
  validateOrganizationAuthorityDescriptorResponse, validateOrganizationDirectorySearchV1, validateOrganizationDirectoryV1, validateOrganizationPersonOidcBeginRequest,
  validateOrganizationPersonOidcBeginResponse, validateOrganizationPersonSession, validateOrganizationPersonSessionRefreshRequest, validateOrganizationPersonToolsV4,
  validatePersonAnswerRequestV3, validatePersonAskCheckRequestV1, validatePersonAskCheckV1, validatePersonChangesV1,
  validatePersonDocumentAssociateV1, validatePersonDocumentAssociationReceiptV1,
  validatePersonDocumentDissociateV1, validatePersonDocumentIdV1, validatePersonDocumentMetadataV2, validatePersonDocumentSearchResultV2, validatePersonDocumentSearchV2,
  validatePersonDocumentStatusV2, validatePersonDocumentUploadMetadataV2, validatePersonDocumentUploadResultV2,
  validatePersonListRequestV1, validatePersonListResponseV1, validatePersonOpenRequestV1, validatePersonOpenResponseV1,
  validatePersonProjectActivityV1, validatePersonRecordListV1, validatePersonRecordSearchRequestV2, validatePersonRecordSearchV2, validatePersonResearchEvalReadRequestV1,
  validatePersonResearchEvalReadResponseV1, validatePersonResearchEvalStartReceiptV1, validatePersonResearchEvalStartRequestV1, validatePersonRunsRequestV1,
  validatePersonRunsResultV1, validatePersonSourceEvidenceReadRequestV1, validatePersonSourceEvidenceV1, validatePersonUpdateReceiptV3, validatePersonUpdateRequestId,
  validatePersonUpdateStatusResultV3, validatePersonUpdateSubmitV3, validatePersonUploadSearchResultV3,
  validatePersonUploadSearchV3, validateProjectArchiveV1, validateProjectContextAssociateV1, validateProjectContextBrowseV1, validateProjectContextDissociateV1,
  validateProjectContextSearchResultV2, validateProjectContextSearchV1, validateProjectCreateReceiptV1, validateProjectCreateV1, validateProjectDirectorySearchV1,
  validateProjectDirectoryV1, validateProjectIdV1, validateProjectLeaveV1, validateProjectListV2, validateProjectMemberAddV1, validateProjectMemberRemoveV1,
  validateProjectMemberSetV1, validateProjectMembersV1, validateProjectMutationReceiptV1, validateProjectPageRequestV2, validateProjectRenameV1,
  validateProjectSettingsReceiptV1, validateProjectSummaryV2,
  type EmployeeInvitationV1, type EmployeeRosterV1, type OrganizationAuthorityDescriptorResponseV1, type OrganizationPersonOidcBeginRequestV2,
  type OrganizationPersonOidcBeginResponseV2, type OrganizationPersonSessionV2, type PersonAnswerPreviousV1, type PersonAnswerResponseV8 as OrganizationPersonAnswerV8,
  type PersonAskCheckRequestV1, type PersonAskCheckV1, type PersonAskProgressStepEventV3, type PersonAskProgressTerminalEventV3, type PersonAskReceiptV3,
  type PersonChangesV1, type PersonDocumentAssociateV1,
  type PersonDocumentDissociateV1, type PersonDocumentSearchV2, type PersonListRequestV1,
  type PersonListResponseV1, type PersonOpenRequestV1, type PersonOpenResponseV1, type PersonProjectActivityV1, type PersonRecordListV1, type PersonRecordSearchV2,
  type PersonResearchEvalReadResponseV1, type PersonResearchEvalStartReceiptV1, type PersonResearchEvalStartRequestV1, type PersonRunsRequestV1, type PersonRunsResultsV1,
  type PersonSourceEvidenceReadRequestV1, type PersonSourceEvidenceV1, type PersonToolGetRequestV1, type PersonToolJsonRequestV1, type PersonToolTransportV1,
  type PersonUpdateSubmitV3, type ProjectIdV1,
} from "@echo-brain/organization-api";
import type { DocumentSnapshot } from './document-file.js';

export const DEFAULT_TIMEOUT_MS = 15_000;
export const ASK_TIMEOUT_MS = 135_000;
/** The Ask source check answers within its own 15 seconds; the client waits twice that. */
export const ASK_CHECK_TIMEOUT_MS = 30_000;
const MAXIMUM_ORDINARY_RESPONSE_BYTES = 64 * 1024;
const MAXIMUM_RECORDS_RESPONSE_BYTES = 512 * 1024;
export type { EmployeeRosterV1, PersonRecordListItemV1, PersonRecordListV1, PersonRecordSearchItemV1, PersonRecordSearchV2 } from '@echo-brain/organization-api';

/**
 * The Ask's answer, on `/v7`: it may cite live tickets and pages, follow-ups (ADR-0040), and projects, people, tools and
 * tool containers (research tool contract v1).
 */
export type PersonAnswerV8 = OrganizationPersonAnswerV8;
export type PersonAskSourceEvidenceV1 = PersonSourceEvidenceV1;
export type PersonListV1 = PersonListResponseV1;
export type PersonOpenV1 = PersonOpenResponseV1;

/** A streamed Ask's answer (ADR-0039): the V8 answer, with its V3 receipt. */
export interface PersonLiveAnswerV3 {
  readonly result: PersonAnswerV8;
  readonly receipt: PersonAskReceiptV3;
}
/**
 * Receives each step of a streamed Ask in progress V3, as it arrives,
 * synchronously and in order: its reads may name follow-ups, projects, people,
 * tools and tool containers.
 */
export type PersonAskProgressSinkV3 = (event: PersonAskProgressStepEventV3) => void;

export class PersonAuthorityClientError extends Error {
  /** The request never left this machine: no connection was made. */
  readonly unsent: boolean;

  constructor(public readonly code: string, public readonly status: number | null, message: string, options: { readonly unsent?: boolean } = {}) {
    super(message);
    this.name = "PersonAuthorityClientError";
    this.unsent = options.unsent === true;
  }
}

/**
 * Failures before any connection exists, judged by the step that failed: the
 * same code from a read or write on a connected socket may follow sent bytes.
 */
const CONNECT_FAILURES = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ENETDOWN", "EADDRNOTAVAIL"]);
const LOOKUP_FAILURES = new Set(["ENOTFOUND", "EAI_AGAIN"]);

function neverSent(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) return false;
  const { code, syscall, cause, errors } = error as { code?: unknown; syscall?: unknown; cause?: unknown; errors?: unknown };
  // Every address tried (an aggregate copies its first code, not its step).
  if (Array.isArray(errors) && errors.length > 0) {
    return errors.every((entry) => neverSent(entry, depth + 1));
  }
  if (code === "UND_ERR_CONNECT_TIMEOUT") return true;
  if (typeof code === "string" && typeof syscall === "string") {
    if (CONNECT_FAILURES.has(code)) return syscall === "connect";
    if (LOOKUP_FAILURES.has(code)) return syscall === "getaddrinfo" || syscall.startsWith("query");
  }
  return neverSent(cause, depth + 1);
}

/** The one mutation-outcome error of project context, updates and documents: whether the change was submitted. */
export class PersonContextMutationError extends PersonAuthorityClientError {
  constructor(
    code: string,
    status: number | null,
    message: string,
    public readonly request_id: string,
    public readonly mutation_outcome: 'not_submitted' | 'unknown',
  ) {
    super(code, status, message);
    this.name = 'PersonContextMutationError';
  }
}

export function unknownContextMutation(requestId: string, upload: boolean, status: number | null): PersonContextMutationError {
  return new PersonContextMutationError('outcome_unknown', status,
    upload
      ? 'Submission outcome is unknown. Check updates status-v3 with the same request ID, or retry the exact file and title with the same request ID.'
      : 'Mutation outcome is unknown. Retain the same request ID and exact request for reconciliation or replay.',
    requestId, 'unknown');
}

export function unknownDocumentMutation(requestId: string, status: number | null): PersonContextMutationError {
  return new PersonContextMutationError('outcome_unknown', status,
    'Document submission outcome is unknown. Its exact file snapshot is retained. Check documents status-v2 with the same request ID, or retry the exact command.', requestId, 'unknown');
}

export interface PersonAuthorityClientOptions {
  readonly authority_origin: string;
  readonly fetch?: typeof fetch;
  readonly timeout_ms?: number;
  /** Test/development only. */
  readonly allow_insecure_loopback?: boolean;
}

function normalizeOrigin(value: string, allowInsecureLoopback: boolean): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Person Authority origin is invalid"); }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || (url.pathname !== "" && url.pathname !== "/") ||
      (url.protocol !== "https:" && !(allowInsecureLoopback && url.protocol === "http:" && loopback))) {
    throw new Error("Person Authority must be one HTTPS origin");
  }
  url.pathname = "/";
  return url;
}

/** At most `maximumBytes` of a JSON reply's body, as UTF-8 text (a streamed Ask is read by readAskProgressStream). */
async function readBoundedBody(response: Response, maximumBytes: number): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new PersonAuthorityClientError("response_too_large", response.status, "Person Authority response exceeded its bound");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new PersonAuthorityClientError("invalid_response", response.status, `Person Authority returned invalid UTF-8: ${String(error)}`);
  }
}

function parsedJson(text: string, status: number): unknown {
  try { return JSON.parse(text) as unknown; } catch { throw new PersonAuthorityClientError("invalid_response", status, "Person Authority returned invalid JSON"); }
}

function parsedContextJson(text: string, status: number): unknown {
  const value = parsedJson(text, status);
  // Member order and JSON whitespace are not wire requirements. Duplicate
  // members (including escaped equivalent names) are ambiguous and rejected.
  const objects: (Set<string> | undefined)[] = [];
  for (const token of text.matchAll(/"(?:[^"\\]|\\[\s\S])*"(\s*:)?|[{}[\]]/g)) {
    if (token[0] === '{') objects.push(new Set());
    else if (token[0] === '[') objects.push(undefined);
    else if (token[0] === '}' || token[0] === ']') objects.pop();
    else if (token[1] !== undefined) {
      const key = JSON.parse(token[0].slice(0, -token[1].length)) as string;
      const keys = objects.at(-1)!;
      if (keys.has(key)) throw new PersonAuthorityClientError('invalid_response', status, 'Person Authority returned duplicate JSON members');
      keys.add(key);
    }
  }
  return value;
}

function isJsonResponse(response: Response): boolean {
  return /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get("content-type") ?? "");
}

/** `PERSON_ASK_PROGRESS_CONTENT_TYPE_V1`; any other reply to an Ask is an error from before its stream started. */
function isAskProgressStream(response: Response): boolean {
  return /^text\/event-stream(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get("content-type") ?? "");
}

function requestSignal(timeoutMs: number, signal: AbortSignal | undefined): AbortSignal {
  return signal === undefined ? AbortSignal.timeout(timeoutMs) : AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]);
}

/** A cancellation, timeout or lost connection mid-stream fails as it would before the headers. */
function lostAskStream(): PersonAuthorityClientError {
  return new PersonAuthorityClientError("transport_failed", null, "Person Authority request failed");
}

/**
 * Reads a streamed Ask (ADR-0039) to its end with the progress V3 decoder, hands
 * each step event to `onProgress` as it arrives, and returns the one terminal
 * event. Fails closed: a malformed frame or event, invalid UTF-8, or an end
 * without exactly one terminal event is `invalid_response`, and a stream past
 * its byte bound is `response_too_large`. Either failure cancels the body, so
 * the Authority sees the disconnect and stops the Ask.
 */
async function readAskProgressStream(response: Response, signal: AbortSignal, onProgress: PersonAskProgressSinkV3): Promise<PersonAskProgressTerminalEventV3> {
  if (response.status !== 200 || response.body === null) {
    throw new PersonAuthorityClientError("invalid_response", response.status, "Person Authority returned a malformed progress stream");
  }
  const reader = response.body.getReader();
  // A fetch whose body outlives its signal still stops: cancelling ends a pending read.
  const cancel = () => { reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  const frames = createPersonAskProgressDecoderV3();
  const decode = (chunk: Uint8Array | undefined) => {
    try {
      if (chunk !== undefined) return frames.push(utf8.decode(chunk, { stream: true }));
      const events = frames.push(utf8.decode());
      frames.end();
      return events;
    } catch (error) {
      if (!(error instanceof TypeError) && !isOrganizationApiValidationError(error)) throw error;
      throw new PersonAuthorityClientError("invalid_response", response.status, "Person Authority returned a malformed progress stream");
    }
  };
  let terminal: PersonAskProgressTerminalEventV3 | undefined;
  let size = 0;
  try {
    // Nothing is handed on once the request is cancelled, even from bytes already received.
    if (signal.aborted) throw lostAskStream();
    for (;;) {
      const next = await reader.read().catch(() => { throw lostAskStream(); });
      if (signal.aborted) throw lostAskStream();
      if (!next.done) {
        size += next.value.byteLength;
        if (size > PERSON_ASK_PROGRESS_STREAM_MAX_BYTES_V1) {
          throw new PersonAuthorityClientError("response_too_large", response.status, "Person Authority response exceeded its bound");
        }
      }
      for (const event of decode(next.done ? undefined : next.value)) {
        // The decoder refuses anything after the terminal event, so a step event always precedes it.
        if (event.type === "answer" || event.type === "error") terminal = event;
        else onProgress(event);
      }
      if (next.done) break;
    }
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  return terminal!;
}

type AskScope = ProjectIdV1 | undefined;

/** The Ask's V3 request, which may carry the asker's previous turn (ADR-0047). */
function askRequest(question: string, scope: AskScope, previous?: PersonAnswerPreviousV1) {
  return validatePersonAnswerRequestV3({ schema_version: 3, question,
    ...(scope === undefined ? {} : { project_id: scope }),
    ...(previous === undefined ? {} : { previous }) });
}

/** Every Ask sends the client's clock and time zone. */
function askHeaders(): Readonly<Record<string, string>> {
  return { [PERSON_ASK_CLIENT_NOW_HEADER_V1]: new Date().toISOString(), [PERSON_ASK_TIME_ZONE_HEADER_V1]: Intl.DateTimeFormat().resolvedOptions().timeZone };
}

/**
 * Every Ask answer must echo the requested scope, and only an answer to an Ask that sent the previous turn may name its
 * question, say what is different since or ask which one (ADR-0047).
 */
function inAskScope<T extends { readonly scope: unknown }>(response: T, scope: AskScope, previous?: PersonAnswerPreviousV1): T {
  const expectedScope = scope === undefined ? { kind: 'global' } : { kind: 'project', project_id: scope };
  if (canonicalJson(response.scope) !== canonicalJson(expectedScope)) {
    throw new PersonAuthorityClientError('invalid_response', 200, 'Person Authority returned different Ask scope');
  }
  if (previous === undefined && ['question', 'since', 'choices'].some(key => Object.hasOwn(response, key))) {
    throw new PersonAuthorityClientError('invalid_response', 200, 'Person Authority answered a previous turn the Ask did not send');
  }
  return response;
}

/** Error codes of the closed project/V2 and document families. */
const CLOSED_CONTEXT_ERROR_CODES: ReadonlySet<string> = new Set([
  'invalid_request', 'conflict', 'invalid_output', 'not_found', 'stale_access_state', 'unauthorized', 'rate_limited', 'quota_exceeded', 'unavailable',
]);

function validateSuccess<T>(value: unknown, status: number, validate: (input: unknown) => T): T {
  try {
    return validate(value);
  } catch (error) {
    if (!isOrganizationApiValidationError(error)) throw error;
    throw new PersonAuthorityClientError("invalid_response", status, "Person Authority returned a malformed response");
  }
}

/** What a closed family (project context, documents) says when its reply is not one of its own. */
interface ClosedFamily {
  readonly not_json: string;
  readonly noncanonical: string;
  readonly rejected: string;
  readonly unexpected_status: string;
  /** A document reply that is not JSON is dropped unread. */
  readonly cancel: boolean;
}
const CONTEXT_FAMILY: ClosedFamily = Object.freeze({ not_json: 'Person Authority returned a non-JSON response', noncanonical: 'Person Authority returned a noncanonical error',
  rejected: 'Person Authority rejected the request', unexpected_status: 'Person Authority returned an unexpected status', cancel: false });
const DOCUMENT_FAMILY: ClosedFamily = Object.freeze({ not_json: 'Document response was not JSON.', noncanonical: 'Document error response was invalid.',
  rejected: 'Document request was rejected.', unexpected_status: 'Document response status was unexpected.', cancel: true });

/**
 * A closed family's reply: canonical JSON within `maximumBytes`, an error only with one of the family's codes (thrown
 * as `rejected` makes it, by default the family's rejection), and success only with `expectedStatus`.
 */
async function closedReply<T>(response: Response, family: ClosedFamily, maximumBytes: number, validate: (value: unknown) => T, expectedStatus: number,
  rejected: (code: string) => PersonAuthorityClientError = code => new PersonAuthorityClientError(code, response.status, family.rejected)): Promise<T> {
  if (!isJsonResponse(response)) {
    if (family.cancel) await response.body?.cancel();
    throw new PersonAuthorityClientError('invalid_response', response.status, family.not_json);
  }
  const value = parsedContextJson(await readBoundedBody(response, maximumBytes), response.status);
  if (!response.ok) {
    const failure = validateSuccess(value, response.status, validateOrganizationApiError);
    // The generic API envelope permits extension codes; these closed families cannot infer rejection from one.
    if (!CLOSED_CONTEXT_ERROR_CODES.has(failure.error.code)) throw new PersonAuthorityClientError('invalid_response', response.status, family.noncanonical);
    throw rejected(failure.error.code);
  }
  if (response.status !== expectedStatus) throw new PersonAuthorityClientError('invalid_response', response.status, family.unexpected_status);
  return validateSuccess(value, response.status, validate);
}

/**
 * A project-context route (project context v1, its V2 reads and V3 updates): its request, its closed reply and how the
 * reply is bound to the request. A GET route carries its request in its path. A mutation carries its request ID, so its
 * outcome is never left unsaid (PersonContextMutationError); an upload's unknown outcome says how to check it.
 */
interface ContextRoute<Q, R> {
  readonly request: (value: unknown) => Q;
  readonly path: (request: Q) => string;
  readonly get?: true;
  readonly status?: number;
  readonly mutation?: 'change' | 'upload';
  readonly response: (value: unknown) => R;
  readonly matches: (response: R, request: Q) => boolean;
}
const route = <Q, R>(value: ContextRoute<Q, R>): ContextRoute<Q, R> => Object.freeze(value);
const fits = (items: readonly unknown[], request: { readonly limit?: number }) => items.length <= (request.limit ?? 10);
/** A change's receipt is for its request, in its project. */
const applied = (result: { readonly request_id: string; readonly project_id: string }, request: { readonly request_id: string; readonly project_id: string }) =>
  result.request_id === request.request_id && result.project_id === request.project_id;

/** Every project-context route, by the name callers ask for it with. */
export const CONTEXT_ROUTES = Object.freeze({
  projectsV2: route({ request: validateProjectPageRequestV2, get: true, response: validateProjectListV2,
    path: request => `${PERSON_PROJECTS_PATH_V2}?${new URLSearchParams({ limit: String(request.limit), status: request.status ?? 'active', ...(request.cursor === undefined ? {} : { cursor: request.cursor }) })}`,
    matches: (result, request) => fits(result.items, request) && result.items.every(item => item.status === (request.status ?? 'active')) }),
  createProject: route({ request: validateProjectCreateV1, path: () => PERSON_PROJECTS_PATH_V1, status: 201, mutation: 'change', response: validateProjectCreateReceiptV1,
    matches: (result, request) => result.request_id === request.request_id }),
  readProjectV2: route({ request: validateProjectIdV1, path: project => `${PERSON_PROJECTS_PATH_V2}/${project}`, get: true, response: validateProjectSummaryV2,
    matches: (result, project) => result.project_id === project }),
  renameProject: route({ request: validateProjectRenameV1, path: () => PERSON_PROJECT_RENAME_PATH_V1, mutation: 'change', response: validateProjectSettingsReceiptV1,
    matches: (result, request) => result.operation === 'rename' && applied(result, request) }),
  archiveProject: route({ request: validateProjectArchiveV1, path: () => PERSON_PROJECT_ARCHIVE_PATH_V1, mutation: 'change', response: validateProjectSettingsReceiptV1,
    matches: (result, request) => result.operation === 'archive' && applied(result, request) }),
  leaveProject: route({ request: validateProjectLeaveV1, path: () => PERSON_PROJECT_LEAVE_PATH_V1, mutation: 'change', response: validateProjectSettingsReceiptV1,
    matches: (result, request) => result.operation === 'leave' && applied(result, request) }),
  projectMembers: route({ request: validateProjectContextBrowseV1, path: () => `${PERSON_PROJECTS_PATH_V1}/members`, response: validateProjectMembersV1,
    matches: (result, request) => result.project_id === request.project_id && fits(result.items, request) }),
  projectDirectory: route({ request: validateProjectDirectorySearchV1, path: () => `${PERSON_PROJECTS_PATH_V1}/directory`, response: validateProjectDirectoryV1,
    matches: (result, request) => result.project_id === request.project_id && fits(result.items, request) }),
  /** Active people in the signed-in person's own organization; no project needed. */
  organizationDirectory: route({ request: validateOrganizationDirectorySearchV1, path: () => PERSON_DIRECTORY_PATH_V1, response: validateOrganizationDirectoryV1,
    matches: (result, request) => fits(result.items, request) }),
  addProjectMember: route({ request: validateProjectMemberAddV1, path: () => `${PERSON_PROJECTS_PATH_V1}/members/add`, mutation: 'change', response: validateProjectMutationReceiptV1,
    matches: (result, request) => result.operation === 'member_set' && result.membership_id === request.membership_id && applied(result, request) }),
  setProjectMember: route({ request: validateProjectMemberSetV1, path: () => `${PERSON_PROJECTS_PATH_V1}/members/set`, mutation: 'change', response: validateProjectMutationReceiptV1,
    matches: (result, request) => result.operation === 'member_set' && result.membership_id === request.membership_id && applied(result, request) }),
  removeProjectMember: route({ request: validateProjectMemberRemoveV1, path: () => `${PERSON_PROJECTS_PATH_V1}/members/remove`, mutation: 'change', response: validateProjectMutationReceiptV1,
    matches: (result, request) => result.operation === 'member_remove' && result.membership_id === request.membership_id && applied(result, request) }),
  associateProjectContext: route({ request: validateProjectContextAssociateV1, path: () => `${PERSON_PROJECTS_PATH_V1}/context/associate`, mutation: 'change',
    response: validateProjectMutationReceiptV1, matches: (result, request) => result.operation === 'associate' && result.context_id === request.context_id && applied(result, request) }),
  dissociateProjectContext: route({ request: validateProjectContextDissociateV1, path: () => `${PERSON_PROJECTS_PATH_V1}/context/dissociate`, mutation: 'change',
    response: validateProjectMutationReceiptV1, matches: (result, request) => result.operation === 'dissociate' && result.context_id === request.context_id && applied(result, request) }),
  searchProjectContextV2: route({ request: validateProjectContextSearchV1, path: () => `${PERSON_PROJECTS_PATH_V2}/context/search`, response: validateProjectContextSearchResultV2,
    matches: (result, request) => result.project_id === request.project_id && fits(result.items, request) }),
  submitUpdateV3: route({ request: validatePersonUpdateSubmitV3, path: () => PERSON_UPDATES_PATH_V3, status: 202, mutation: 'upload', response: validatePersonUpdateReceiptV3,
    matches: (result, request) => result.request_id === request.request_id &&
      canonicalJson(result.association_project_ids) === canonicalJson(request.association_project_ids) && canonicalJson(result.audience) === canonicalJson(request.audience) }),
  updateStatusV3: route({ request: validatePersonUpdateRequestId, path: requestId => `${PERSON_UPDATES_PATH_V3}/${requestId}`, get: true, response: validatePersonUpdateStatusResultV3,
    matches: (result, requestId) => result.request_id === requestId }),
  searchUploadsV3: route({ request: validatePersonUploadSearchV3, path: () => `${PERSON_UPDATES_PATH_V3}/search`, response: validatePersonUploadSearchResultV3,
    matches: (result, request) => fits(result.results, request) }),
});
export type ContextRouteName = keyof typeof CONTEXT_ROUTES;
export type ContextReply<K extends ContextRouteName> = ReturnType<(typeof CONTEXT_ROUTES)[K]['response']>;

interface JsonRequest {
  readonly path: string;
  readonly body: unknown;
  readonly validate_request: (value: unknown) => unknown;
  readonly access_token?: string;
  readonly method?: "POST" | "PUT";
  readonly headers?: Readonly<Record<string, string>>;
  /** Only a tool's bounded request (a custom staging meeting) passes the ordinary body bound. */
  readonly maximum_request_bytes?: number;
}

/** A bodied request's validated canonical JSON, within its bound. */
function requestBody(input: Pick<JsonRequest, 'body' | 'validate_request' | 'maximum_request_bytes'>): string {
  const body = canonicalJson(input.validate_request(input.body));
  if (Buffer.byteLength(body) > (input.maximum_request_bytes ?? MAX_ORGANIZATION_API_BODY_BYTES)) throw new Error("Person Authority request exceeds its body bound");
  return body;
}

export class PersonAuthorityClient {
  private readonly origin: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: PersonAuthorityClientOptions) {
    this.origin = normalizeOrigin(options.authority_origin, options.allow_insecure_loopback === true);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) throw new Error("Person Authority timeout must be positive");
  }

  private async send(path: string, init: Omit<RequestInit, "redirect" | "signal">, timeoutMs = this.timeoutMs, signal?: AbortSignal): Promise<Response> {
    return this.sendUntil(path, init, requestSignal(timeoutMs, signal));
  }

  /** `deadline` is the request's whole timeout and cancellation, which a streamed body is read under too. */
  private async sendUntil(path: string, init: Omit<RequestInit, "redirect" | "signal">, deadline: AbortSignal): Promise<Response> {
    try {
      return await this.fetchImpl(new URL(path, this.origin), { ...init, redirect: "error", signal: deadline });
    } catch (error) {
      throw new PersonAuthorityClientError("transport_failed", null, "Person Authority request failed", { unsent: neverSent(error) });
    }
  }

  private async json<T>(input: JsonRequest & {
    readonly validate_response: (value: unknown) => T;
    readonly maximum_response_bytes?: number;
    readonly expected_status?: number;
    readonly timeout_ms?: number;
    /** A caller cancellation disconnects the request; the timeout still applies. */
    readonly signal?: AbortSignal;
  }): Promise<T> {
    const response = await this.post(input, requestSignal(input.timeout_ms ?? this.timeoutMs, input.signal));
    const value = await this.jsonValue(response, input.maximum_response_bytes ?? MAXIMUM_ORDINARY_RESPONSE_BYTES, input.expected_status);
    return validateSuccess(value, response.status, input.validate_response);
  }

  /** Sends one validated, bounded JSON request; reading the reply is the caller's. */
  private async post(input: JsonRequest, deadline: AbortSignal): Promise<Response> {
    const body = requestBody(input);
    return this.sendUntil(input.path, { method: input.method ?? "POST", headers: { accept: "application/json", "content-type": "application/json",
      ...(input.access_token === undefined ? {} : { authorization: `Bearer ${input.access_token}` }), ...input.headers }, body }, deadline);
  }

  private async jsonValue(response: Response, maximumBytes: number, expectedStatus?: number): Promise<unknown> {
    if (!isJsonResponse(response)) throw new PersonAuthorityClientError("invalid_response", response.status, "Person Authority returned a non-JSON response");
    const value = parsedJson(await readBoundedBody(response, maximumBytes), response.status);
    if (!response.ok) {
      let code = "request_failed";
      try {
        code = validateOrganizationApiError(value).error.code;
      } catch {
        throw new PersonAuthorityClientError("invalid_response", response.status, "Person Authority returned a malformed error");
      }
      throw new PersonAuthorityClientError(code, response.status, "Person Authority rejected the request");
    }
    if (expectedStatus !== undefined && response.status !== expectedStatus) {
      throw new PersonAuthorityClientError('invalid_response', response.status, 'Person Authority returned an unexpected status');
    }
    return value;
  }

  private async getJson<T>(input: {
    readonly path: string;
    readonly access_token: string;
    readonly validate_response: (value: unknown) => T;
    readonly maximum_response_bytes: number;
    readonly signal?: AbortSignal;
  }): Promise<T> {
    const response = await this.send(input.path, { method: "GET", headers: { accept: "application/json", authorization: `Bearer ${input.access_token}` } }, undefined, input.signal);
    const value = await this.jsonValue(response, input.maximum_response_bytes);
    try {
      return input.validate_response(value);
    } catch {
      throw new PersonAuthorityClientError("invalid_response", response.status, "Person Authority returned a malformed response");
    }
  }

  /** Project/V2 replies are canonical, closed, bounded, and bound to the requested coordinates. */
  private async contextRequest<T>(accessToken: string, input: {
    path: string;
    body?: unknown;
    status?: number;
    validate: (value: unknown) => T;
    matches?: (response: T) => boolean;
    request_id?: string;
    upload?: boolean;
  }): Promise<T> {
    const body = input.body === undefined ? undefined : canonicalJson(input.body);
    if (body !== undefined && Buffer.byteLength(body) > MAX_ORGANIZATION_API_BODY_BYTES) {
      throw new PersonAuthorityClientError('invalid_request', null, 'Person Authority request exceeds its body bound');
    }
    let status: number | null = null;
    try {
      const response = await this.send(input.path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { accept: 'application/json', authorization: `Bearer ${accessToken}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body }),
      });
      status = response.status;
      const { request_id: requestId } = input;
      const result = await closedReply(response, CONTEXT_FAMILY, PROJECT_CONTEXT_RESPONSE_MAX_BYTES, input.validate, input.status ?? 200,
        requestId !== undefined && response.status >= 400 && response.status < 500
          ? code => new PersonContextMutationError(code, response.status, CONTEXT_FAMILY.rejected, requestId, 'not_submitted') : undefined);
      if (input.matches !== undefined && !input.matches(result)) {
        throw new PersonAuthorityClientError('invalid_response', status, 'Person Authority returned different request coordinates');
      }
      return result;
    } catch (error) {
      if (error instanceof PersonContextMutationError) throw error;
      if (input.request_id !== undefined) throw unknownContextMutation(input.request_id, input.upload === true, status);
      if (error instanceof PersonAuthorityClientError) throw error;
      throw new PersonAuthorityClientError('invalid_response', status, 'Person Authority returned a malformed response');
    }
  }

  /** One project-context route (CONTEXT_ROUTES), its request validated before it is sent. */
  async context<K extends ContextRouteName>(accessToken: string, name: K, value: unknown): Promise<ContextReply<K>> {
    const selected = CONTEXT_ROUTES[name] as unknown as ContextRoute<unknown, ContextReply<K>>;
    const request = selected.request(value);
    return this.contextRequest(accessToken, { path: selected.path(request), ...(selected.get === true ? {} : { body: request }),
      ...(selected.status === undefined ? {} : { status: selected.status }),
      ...(selected.mutation === undefined ? {} : { request_id: (request as { readonly request_id: string }).request_id, upload: selected.mutation === 'upload' }),
      validate: selected.response, matches: result => selected.matches(result, request) });
  }

  submitUpdateV3(accessToken: string, value: PersonUpdateSubmitV3) {
    return this.context(accessToken, 'submitUpdateV3', value);
  }

  private documentResponse<T>(response: Response, validate: (value: unknown) => T, expectedStatus = 200): Promise<T> {
    return closedReply(response, DOCUMENT_FAMILY, PERSON_DOCUMENT_JSON_MAX_BYTES, validate, expectedStatus);
  }

  async uploadDocument(accessToken: string, snapshot: DocumentSnapshot) {
    const metadata = validatePersonDocumentUploadMetadataV2(snapshot.metadata);
    const stream = snapshot.open();
    let status: number | null = null;
    try {
      const init: RequestInit & { duplex: 'half' } = {
        method: 'PUT', duplex: 'half', body: stream as unknown as BodyInit,
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json', 'content-type': 'application/octet-stream',
          'content-length': String(metadata.content_length), 'x-echo-document-metadata': Buffer.from(canonicalJson(metadata)).toString('base64url') },
      };
      const response = await this.send(`${PERSON_DOCUMENTS_PATH_V2}/${metadata.request_id}`, init, PERSON_DOCUMENT_TRANSFER_DEADLINE_MS);
      status = response.status;
      const receipt = await this.documentResponse(response, validatePersonDocumentUploadResultV2, 201);
      if (receipt.request_id !== metadata.request_id) throw new Error('Document receipt request changed');
      if (receipt.kind === 'echo-person-document-saved-v2') return receipt;
      for (const key of ['request_id', 'filename', 'title', 'content_length', 'sha256'] as const) {
        if (receipt[key] !== metadata[key]) throw new Error('Document receipt coordinates changed');
      }
      if (canonicalJson(receipt.audience) !== canonicalJson(metadata.audience)) throw new Error('Document receipt audience changed');
      if (canonicalJson(receipt.association_project_ids) !== canonicalJson(metadata.association_project_ids)) throw new Error('Document receipt associations changed');
      return receipt;
    } catch (error) {
      if (error instanceof PersonAuthorityClientError && status !== null && status >= 400 && status < 500 &&
          ['invalid_request', 'conflict', 'not_found', 'stale_access_state', 'unauthorized', 'rate_limited', 'quota_exceeded'].includes(error.code)) {
        throw new PersonContextMutationError(error.code, status, error.message, metadata.request_id, 'not_submitted');
      }
      throw unknownDocumentMutation(metadata.request_id, status);
    } finally { stream.destroy(); }
  }

  async changeDocumentAssociation(accessToken: string, value: PersonDocumentAssociateV1 | PersonDocumentDissociateV1) {
    const add = value.kind === 'echo-person-document-associate-v1';
    const request = add ? validatePersonDocumentAssociateV1(value) : validatePersonDocumentDissociateV1(value);
    const operation = add ? 'associate' : 'dissociate';
    return this.contextRequest(accessToken, { path: `${PERSON_DOCUMENTS_PATH_V2}/${request.document_id}/${operation}`, body: request,
      request_id: request.request_id, validate: validatePersonDocumentAssociationReceiptV1,
      matches: result => result.request_id === request.request_id && result.document_id === request.document_id &&
        result.project_id === request.project_id && result.operation === operation });
  }

  async documentStatusV2(accessToken: string, requestId: string) {
    validatePersonUpdateRequestId(requestId);
    const result = await this.documentResponse(await this.send(`${PERSON_DOCUMENTS_PATH_V2}/requests/${requestId}`, {
      method: 'GET', headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    }), validatePersonDocumentStatusV2);
    if (result.request_id !== requestId) throw new PersonAuthorityClientError('invalid_response', 200, 'Document status coordinates changed.');
    return result;
  }

  async documentMetadataV2(accessToken: string, documentId: string, projectId?: string) {
    validatePersonDocumentIdV1(documentId);
    const result = await this.documentResponse(await this.send(`${PERSON_DOCUMENTS_PATH_V2}/${documentId}${projectId === undefined ? '' : `?${new URLSearchParams({ project_id: validateProjectIdV1(projectId) })}`}`, {
      method: 'GET', headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    }), validatePersonDocumentMetadataV2);
    if (result.document_id !== documentId) throw new PersonAuthorityClientError('invalid_response', 200, 'Document metadata coordinates changed.');
    return result;
  }

  async searchDocumentsV2(accessToken: string, input: PersonDocumentSearchV2) {
    const request = validatePersonDocumentSearchV2(input);
    const result = await this.documentResponse(await this.send(`${PERSON_DOCUMENTS_PATH_V2}/search`, {
      method: 'POST', headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json', 'content-type': 'application/json' }, body: canonicalJson(request),
    }), validatePersonDocumentSearchResultV2);
    if (result.documents.length > request.limit || new Set(result.documents.map(item => item.document_id)).size !== result.documents.length) {
      throw new PersonAuthorityClientError('invalid_response', 200, 'Document search page was invalid.');
    }
    return result;
  }

  async documentOriginalV2(accessToken: string, documentId: string, projectId?: string): Promise<Response> {
    validatePersonDocumentIdV1(documentId);
    const response = await this.send(`${PERSON_DOCUMENTS_PATH_V2}/${documentId}/original${projectId === undefined ? '' : `?${new URLSearchParams({ project_id: validateProjectIdV1(projectId) })}`}`, {
      method: 'GET', headers: { authorization: `Bearer ${accessToken}`, accept: 'application/octet-stream' },
    }, PERSON_DOCUMENT_TRANSFER_DEADLINE_MS);
    if (!response.ok) await this.documentResponse(response, () => { throw new Error('Unexpected document response'); });
    if (response.status !== 200) { await response.body?.cancel(); throw new PersonAuthorityClientError('invalid_response', response.status, 'Document response status was unexpected.'); }
    return response;
  }

  async descriptor(): Promise<OrganizationAuthorityDescriptorResponseV1> {
    const response = await this.send(ORGANIZATION_API_AUTHORITY_DESCRIPTOR_PATH, { method: "GET", headers: { accept: "application/json" } });
    if (!isJsonResponse(response)) throw new PersonAuthorityClientError("invalid_response", response.status, "Person Authority returned a non-JSON descriptor");
    const value = parsedJson(await readBoundedBody(response, MAXIMUM_ORDINARY_RESPONSE_BYTES), response.status);
    if (!response.ok) throw new PersonAuthorityClientError("request_failed", response.status, "Person Authority rejected the descriptor request");
    return validateSuccess(value, response.status, validateOrganizationAuthorityDescriptorResponse);
  }

  private async noContent(input: Omit<JsonRequest, 'method' | 'headers' | 'maximum_request_bytes'> & { readonly access_token: string; readonly method?: "POST" | "DELETE" }): Promise<void> {
    const body = requestBody(input);
    const response = await this.send(input.path, { method: input.method ?? "POST",
      headers: { accept: "application/json", authorization: `Bearer ${input.access_token}`, "content-type": "application/json" }, body });
    const text = await readBoundedBody(response, MAXIMUM_ORDINARY_RESPONSE_BYTES);
    if (response.status === 204 && text === "") return;
    if (!response.ok) {
      const value = parsedJson(text, response.status);
      try {
        const error = validateOrganizationApiError(value);
        throw new PersonAuthorityClientError(error.error.code, response.status, "Person Authority rejected the request");
      } catch (error) {
        if (error instanceof PersonAuthorityClientError) throw error;
      }
    }
    throw new PersonAuthorityClientError("invalid_response", response.status, "Person Authority returned an invalid no-content response");
  }

  beginOidcLogin(request: OrganizationPersonOidcBeginRequestV2): Promise<OrganizationPersonOidcBeginResponseV2> {
    return this.json({ path: ORGANIZATION_API_PERSON_OIDC_BEGIN_PATH, body: request,
      validate_request: validateOrganizationPersonOidcBeginRequest, validate_response: validateOrganizationPersonOidcBeginResponse });
  }

  refresh(refreshToken: string): Promise<OrganizationPersonSessionV2> {
    return this.json({ path: ORGANIZATION_API_PERSON_SESSION_REFRESH_PATH, body: { refresh_token: refreshToken },
      validate_request: validateOrganizationPersonSessionRefreshRequest, validate_response: validateOrganizationPersonSession });
  }

  logout(accessToken: string): Promise<void> {
    return this.noContent({ path: ORGANIZATION_API_PERSON_SESSION_REVOCATIONS_PATH, body: {}, access_token: accessToken,
      validate_request: (value) => {
        if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 0) throw new Error("Person logout request must be empty");
        return value;
      } });
  }

  records(accessToken: string, limit?: number, recordSha256?: `sha256:${string}`): Promise<PersonRecordListV1> {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)) {
      throw new PersonQueryInputError("invalid_limit", "Person record limit must be an integer from 1 to 100");
    }
    if (recordSha256 !== undefined && !/^sha256:[a-f0-9]{64}$/.test(recordSha256)) throw new Error("Person record SHA-256 is invalid");
    return this.getJson({
      path: recordSha256 !== undefined ? `${PERSON_RECORDS_PATH_V1}?record_sha256=${recordSha256}` : limit === undefined ? PERSON_RECORDS_PATH_V1 : `${PERSON_RECORDS_PATH_V1}?limit=${limit}`,
      access_token: accessToken, validate_response: validatePersonRecordListV1, maximum_response_bytes: MAXIMUM_RECORDS_RESPONSE_BYTES,
    });
  }

  searchRecords(accessToken: string, query: string, limit?: number): Promise<PersonRecordSearchV2> {
    return this.json({ path: PERSON_RECORDS_PATH_V1, body: { query, ...(limit === undefined ? {} : { limit }) }, validate_request: validatePersonRecordSearchRequestV2,
      validate_response: validatePersonRecordSearchV2, access_token: accessToken, maximum_response_bytes: MAXIMUM_ORDINARY_RESPONSE_BYTES });
  }

  /**
   * The change check (desktop refresh and notifications v1; ADR-0036): one fingerprint per area of this person's own view, and
   * no content. Every Authority serves it (ADR-0048).
   */
  changes(accessToken: string, signal?: AbortSignal): Promise<PersonChangesV1> {
    return this.getJson({ path: PERSON_CHANGES_ROUTE_V1, access_token: accessToken, validate_response: validatePersonChangesV1,
      maximum_response_bytes: MAXIMUM_ORDINARY_RESPONSE_BYTES, signal });
  }

  /**
   * Project activity (Ask timeline v1, C2): when each of this person's active projects last had something new from someone
   * else that they can read, and no content; 500 projects fit the ordinary bound. Every Authority serves it (ADR-0048).
   */
  projectActivity(accessToken: string, signal?: AbortSignal): Promise<PersonProjectActivityV1> {
    return this.getJson({ path: PERSON_PROJECT_ACTIVITY_PATH_V1, access_token: accessToken, validate_response: validatePersonProjectActivityV1,
      maximum_response_bytes: MAXIMUM_ORDINARY_RESPONSE_BYTES, signal });
  }

  /**
   * The Ask's one transport (`/v7`, the V8 answer, research tool contract v1), streamed in Ask progress V3 (ADR-0039):
   * global by default, and a supplied project ID is a strict project-only scope. The answer may cite live tickets and
   * pages, follow-ups, and the asker's projects, people, tools and tool containers, and must echo the requested scope.
   * The request may carry the asker's previous turn (ADR-0047). Each step event reaches
   * `onProgress` as it arrives, and the answer comes back with the receipt the Authority built after its final check.
   * Every Ask streams: a JSON reply is an error from before the stream started, and an error inside the stream is the
   * error its JSON response would have had. The ask timeout and the caller's signal bound the whole stream.
   */
  async askV7WithProgress(accessToken: string, question: string, scope: ProjectIdV1 | undefined, signal: AbortSignal | undefined,
    onProgress: PersonAskProgressSinkV3, previous?: PersonAnswerPreviousV1): Promise<PersonLiveAnswerV3> {
    const deadline = requestSignal(ASK_TIMEOUT_MS, signal);
    const response = await this.post({ path: PERSON_ANSWER_PATH_V7, body: askRequest(question, scope, previous), validate_request: validatePersonAnswerRequestV3,
      access_token: accessToken, headers: { ...askHeaders(), accept: `${PERSON_ASK_PROGRESS_CONTENT_TYPE_V1}, application/json` } }, deadline);
    if (!isAskProgressStream(response)) {
      await this.jsonValue(response, MAXIMUM_ORDINARY_RESPONSE_BYTES);
      throw new PersonAuthorityClientError("invalid_response", response.status, "Person Authority answered the Ask without its stream");
    }
    const terminal = await readAskProgressStream(response, deadline, onProgress);
    if (terminal.type === 'error') {
      throw new PersonAuthorityClientError(terminal.error.code, terminal.status, 'Person Authority rejected the request');
    }
    return Object.freeze({ result: inAskScope(terminal.response, scope, previous), receipt: terminal.receipt });
  }

  /** Staging-only research evaluation: starts one research run (research loop evaluation v1). */
  async startResearchEval(accessToken: string, value: PersonResearchEvalStartRequestV1, signal?: AbortSignal): Promise<PersonResearchEvalStartReceiptV1> {
    return this.json({ path: PERSON_RESEARCH_EVAL_START_PATH_V1, body: value,
      validate_request: validatePersonResearchEvalStartRequestV1, validate_response: validatePersonResearchEvalStartReceiptV1,
      access_token: accessToken, maximum_response_bytes: MAXIMUM_ORDINARY_RESPONSE_BYTES, timeout_ms: ASK_TIMEOUT_MS, signal });
  }

  /** Reads a research run; a finished result is delivered once and may carry released text. */
  async readResearchEval(accessToken: string, runId: string, signal?: AbortSignal): Promise<PersonResearchEvalReadResponseV1> {
    return this.json({ path: PERSON_RESEARCH_EVAL_READ_PATH_V1, body: { schema_version: 1, run_id: runId },
      validate_request: validatePersonResearchEvalReadRequestV1, validate_response: validatePersonResearchEvalReadResponseV1,
      access_token: accessToken, maximum_response_bytes: PERSON_RESEARCH_EVAL_MAX_RESPONSE_BYTES_V1, timeout_ms: ASK_TIMEOUT_MS, signal });
  }

  async runs<K extends PersonRunsRequestV1['operation']>(accessToken: string, value: Extract<PersonRunsRequestV1, { readonly operation: K }>, signal?: AbortSignal): Promise<PersonRunsResultsV1[K]> {
    const request = validatePersonRunsRequestV1(value);
    return this.json({ path: PERSON_RUNS_PATH_V1, body: request, validate_request: validatePersonRunsRequestV1,
      validate_response: value => validatePersonRunsResultV1(request.operation, value), access_token: accessToken,
      maximum_response_bytes: PERSON_RUNS_MAX_RESPONSE_BYTES_V1, timeout_ms: DEFAULT_TIMEOUT_MS, signal }) as Promise<PersonRunsResultsV1[K]>;
  }

  /**
   * The Ask source check (Ask timeline v1, C1; ADR-0047): whether the caller can still read each source old answers cited, and
   * no content.
   */
  async askCheck(accessToken: string, value: PersonAskCheckRequestV1, signal?: AbortSignal): Promise<PersonAskCheckV1> {
    const request = validatePersonAskCheckRequestV1(value);
    return this.json({
      path: PERSON_ASK_CHECK_PATH_V1, body: request, validate_request: validatePersonAskCheckRequestV1,
      validate_response: response => validatePersonAskCheckV1(response, request), access_token: accessToken,
      maximum_request_bytes: PERSON_ASK_CHECK_LIMITS_V1.body_bytes, maximum_response_bytes: MAXIMUM_ORDINARY_RESPONSE_BYTES, timeout_ms: ASK_CHECK_TIMEOUT_MS, signal,
    });
  }

  /** Model-free list (ADR-0024). Only the caller knows which page is first, so the header is checked here. */
  async list(accessToken: string, value: PersonListRequestV1, signal?: AbortSignal): Promise<PersonListV1> {
    const request = validatePersonListRequestV1(value);
    const response = await this.json({ path: PERSON_LIST_PATH_V1, body: request,
      validate_request: validatePersonListRequestV1, validate_response: validatePersonListResponseV1,
      access_token: accessToken, maximum_response_bytes: PERSON_LIST_RESPONSE_MAX_BYTES_V1, timeout_ms: DEFAULT_TIMEOUT_MS, signal });
    const expectedScope = request.project_id !== undefined ? { kind: 'project', project_id: request.project_id } : { kind: 'only_me' };
    if (canonicalJson(response.scope) !== canonicalJson(expectedScope)) throw new PersonAuthorityClientError('invalid_response', 200, 'Person Authority returned different list scope');
    // Project page 1 carries project; only_me and cursor pages carry no header.
    if ((response.project !== undefined) !== (request.cursor === undefined && expectedScope.kind === 'project')) {
      throw new PersonAuthorityClientError('invalid_response', 200, 'Person Authority returned a list header on the wrong page');
    }
    return response;
  }

  /** Opens one note, imported meeting or document under the caller's current access; a meeting is read as its record. */
  async open(accessToken: string, value: PersonOpenRequestV1, signal?: AbortSignal): Promise<PersonOpenV1> {
    const request = validatePersonOpenRequestV1(value);
    const response = await this.json({ path: PERSON_OPEN_PATH_V1, body: request,
      validate_request: validatePersonOpenRequestV1, validate_response: validatePersonOpenResponseV1,
      access_token: accessToken, maximum_response_bytes: PERSON_OPEN_RESPONSE_MAX_BYTES_V1, timeout_ms: DEFAULT_TIMEOUT_MS, signal });
    if (response.ref !== request.ref) {
      throw new PersonAuthorityClientError('invalid_response', 200, 'Person Authority returned different open coordinates');
    }
    return response;
  }

  async askSourceEvidence(accessToken: string, value: PersonSourceEvidenceReadRequestV1): Promise<PersonAskSourceEvidenceV1> {
    const request = validatePersonSourceEvidenceReadRequestV1(value);
    const response = await this.json({ path: PERSON_SOURCE_EVIDENCE_PATH_V1, body: request,
      validate_request: validatePersonSourceEvidenceReadRequestV1, validate_response: validatePersonSourceEvidenceV1,
      access_token: accessToken, maximum_response_bytes: MAXIMUM_ORDINARY_RESPONSE_BYTES, timeout_ms: ASK_TIMEOUT_MS });
    const { label: _label, ...citation } = response.citation;
    if (canonicalJson(response.scope) !== canonicalJson(request.scope) || canonicalJson(citation) !== canonicalJson(request.citation)) {
      throw new PersonAuthorityClientError('invalid_response', 200, 'Person Authority returned different source evidence coordinates');
    }
    return response;
  }

  /** A tool receives bounded methods tied to this Authority, without the bearer credential. */
  toolTransport(accessToken: string, signal?: AbortSignal): PersonToolTransportV1 {
    const assertPath = (path: string): void => {
      if (!path.startsWith('/') || path.startsWith('//') || new URL(path, this.origin).origin !== this.origin.origin) {
        throw new Error('Person tool request must remain on its Authority');
      }
    };
    const assertBounds = (bytes: number, timeout = this.timeoutMs, request = MAX_ORGANIZATION_API_BODY_BYTES): void => {
      if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > PERSON_TOOL_COLLECTION_RESPONSE_MAX_BYTES_V1 ||
          !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 75_000 ||
          !Number.isSafeInteger(request) || request < 1 || request > PERSON_TOOL_REQUEST_MAX_BYTES_V1) {
        throw new Error('Person tool transport bounds are invalid');
      }
    };
    return Object.freeze({
      json: async <T>(input: PersonToolJsonRequestV1<T>): Promise<T> => {
        assertPath(input.path);
        assertBounds(input.maximum_response_bytes ?? MAXIMUM_ORDINARY_RESPONSE_BYTES, input.timeout_ms, input.maximum_request_bytes);
        return this.json({ path: input.path, body: input.body, validate_request: input.validate_request,
          validate_response: input.validate_response, maximum_response_bytes: input.maximum_response_bytes,
          ...(input.maximum_request_bytes === undefined ? {} : { maximum_request_bytes: input.maximum_request_bytes }),
          timeout_ms: input.timeout_ms, access_token: accessToken, signal });
      },
      getJson: async <T>(input: PersonToolGetRequestV1<T>): Promise<T> => {
        assertPath(input.path);
        assertBounds(input.maximum_response_bytes);
        return this.getJson({ path: input.path, validate_response: input.validate_response,
          maximum_response_bytes: input.maximum_response_bytes, access_token: accessToken, signal });
      },
    });
  }

  tools(accessToken: string) {
    return this.getJson({ path: ORGANIZATION_API_PERSON_TOOLS_PATH_V4, access_token: accessToken,
      validate_response: validateOrganizationPersonToolsV4, maximum_response_bytes: 32768 });
  }

  employees(accessToken: string): Promise<EmployeeRosterV1> {
    return this.getJson({ path: PERSON_EMPLOYEES_PATH_V1, access_token: accessToken, validate_response: validateEmployeeRosterV1,
      maximum_response_bytes: MAXIMUM_RECORDS_RESPONSE_BYTES });
  }

  inviteEmployee(input: { name: string; email: string }, accessToken: string): Promise<EmployeeInvitationV1> {
    return this.json({ path: PERSON_EMPLOYEES_PATH_V1, body: input, validate_request: (value) => validateEmployeeRequestV1(value, true),
      validate_response: validateEmployeeInvitationV1, access_token: accessToken });
  }

  reissueEmployee(input: { email: string }, accessToken: string): Promise<EmployeeInvitationV1> {
    return this.json({ path: PERSON_EMPLOYEES_PATH_V1, body: input, validate_request: (value) => validateEmployeeRequestV1(value, false),
      validate_response: validateEmployeeInvitationV1, access_token: accessToken, method: "PUT" });
  }

  revokeEmployee(input: { email: string }, accessToken: string): Promise<void> {
    return this.noContent({ path: PERSON_EMPLOYEES_PATH_V1, body: input, validate_request: (value) => validateEmployeeRequestV1(value, false),
      access_token: accessToken, method: "DELETE" });
  }
}
