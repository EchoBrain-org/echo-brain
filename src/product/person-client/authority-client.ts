import { PERSON_DIAGNOSTICS_PATH_V1, PERSON_DIAGNOSTICS_MAX_RESPONSE_BYTES_V1, validatePersonDiagnosticsRequestV1, validatePersonDiagnosticsResultV1, type PersonDiagnosticCaptureIdV1, type PersonDiagnosticsRequestV1, type PersonDiagnosticsResultsV1 } from '@echo-brain/organization-api';
import { validatePersonDocumentAssociateV1, validatePersonDocumentDissociateV1, validatePersonDocumentAssociationReceiptV1, type PersonDocumentAssociateV1, type PersonDocumentDissociateV1 } from '@echo-brain/organization-api';
import { PERSON_CHANGES_ROUTE_V1, validatePersonChangesV1, type PersonChangesV1 } from '@echo-brain/organization-api';
import { PERSON_PROJECT_ACTIVITY_PATH_V1, validatePersonProjectActivityV1, type PersonProjectActivityV1 } from '@echo-brain/organization-api';
import { PERSON_ASK_CHECK_LIMITS_V1, PERSON_ASK_CHECK_PATH_V1, validatePersonAskCheckRequestV1, validatePersonAskCheckV1, type PersonAskCheckRequestV1, type PersonAskCheckV1 } from '@echo-brain/organization-api';
import { validatePersonUpdateRequestId } from '@echo-brain/organization-api';
import { PersonQueryInputError, validatePersonQueryText } from "@echo-brain/organization-api";
import {
  PERSON_ASK_PROGRESS_CONTENT_TYPE_V1, PERSON_ASK_PROGRESS_HEADER_V1, PERSON_ASK_PROGRESS_HEADER_VALUE_V3, PERSON_ASK_PROGRESS_STREAM_MAX_BYTES_V1,
  createPersonAskProgressDecoderV3, type PersonAskProgressStepEventV3, type PersonAskProgressTerminalEventV3, type PersonAskReceiptV3,
} from '@echo-brain/organization-api';
import {
  PERSON_ASK_ANSWER_LAYOUT_HEADER_V1, PERSON_ASK_ANSWER_LAYOUT_HEADER_VALUE_V1, PERSON_ASK_CLIENT_NOW_HEADER_V1, PERSON_ASK_TIME_ZONE_HEADER_V1,
  PERSON_ANSWER_PATH_V7,
  PERSON_ANSWER_ROUTE_HEADER_V5,
  PERSON_EVIDENCE_SEARCH_PATH_V1,
  PERSON_EVIDENCE_OPEN_PATH_V1,
  PERSON_RESEARCH_EVAL_MAX_RESPONSE_BYTES_V1,
  PERSON_RESEARCH_EVAL_READ_PATH_V1,
  PERSON_RESEARCH_EVAL_START_PATH_V1,
  PERSON_RUNS_PATH_V1,
  PERSON_RUNS_MAX_RESPONSE_BYTES_V1,
  validatePersonRunsRequestV1,
  validatePersonRunsResultV1,
  type PersonRunsRequestV1,
  type PersonRunsResultsV1,
  validatePersonResearchEvalReadRequestV1,
  validatePersonResearchEvalReadResponseV1,
  validatePersonResearchEvalStartReceiptV1,
  validatePersonResearchEvalStartRequestV1,
  type PersonResearchEvalReadResponseV1,
  type PersonResearchEvalStartReceiptV1,
  type PersonResearchEvalStartRequestV1,
  PERSON_SOURCE_EVIDENCE_PATH_V1,
  PERSON_LIST_PATH_V1,
  PERSON_OPEN_PATH_V1,
  PERSON_LIST_RESPONSE_MAX_BYTES_V1,
  PERSON_OPEN_RESPONSE_MAX_BYTES_V1,
  personRefKindV1,
  validatePersonListRequestV1,
  validatePersonListResponseV1,
  validatePersonOpenRequestV1,
  validatePersonOpenResponseV1,
  validatePersonAnswerRequestV3,
  validatePersonAnswerResponseV8,
  validatePersonEvidenceSearchRequestV1,
  validatePersonEvidenceOpenRequestV1,
  validatePersonEvidenceDeskResponseV1,
  validatePersonSourceEvidenceReadRequestV1,
  validatePersonSourceEvidenceV1,
  type PersonAnswerCitationV3 as OrganizationPersonAnswerCitationV3,
  type PersonAnswerResponseV8 as OrganizationPersonAnswerV8,
  type PersonEvidenceSearchRequestV1,
  type PersonEvidenceOpenRequestV1,
  type PersonEvidenceDeskResponseV1,
  type PersonSourceEvidenceReadRequestV1,
  type PersonSourceEvidenceV1,
  type PersonListRequestV1,
  type PersonListResponseV1,
  type PersonOpenRequestV1,
  type PersonOpenResponseV1,
  type PersonAnswerPreviousV1,
  type ProjectIdV1,
} from '@echo-brain/organization-api';
import {
  PERSON_PROJECTS_PATH_V2,
  validateProjectContextSearchResultV2,
  validateProjectPageRequestV2, validateProjectListV2, validateProjectSummaryV2, type ProjectPageRequestV2,
} from '@echo-brain/organization-api';
import { ORGANIZATION_API_PERSON_TOOLS_PATH_V4, validateOrganizationPersonToolsV4, type PersonToolTransportV1 } from '@echo-brain/organization-api';
import { Buffer } from "node:buffer";
import { PERSON_DOCUMENTS_PATH_V2, PERSON_DOCUMENT_JSON_MAX_BYTES, PERSON_DOCUMENT_TRANSFER_DEADLINE_MS, validatePersonDocumentIdV1, validatePersonDocumentUploadMetadataV2, validatePersonDocumentUploadResultV2, validatePersonDocumentStatusV2, validatePersonDocumentMetadataV2, validatePersonDocumentSearchV2, validatePersonDocumentSearchResultV2, type PersonDocumentSearchV2 } from '@echo-brain/organization-api';
import type { DocumentSnapshot } from './document-file.js';
import {
  PERSON_DIRECTORY_PATH_V1, validateOrganizationDirectorySearchV1, validateOrganizationDirectoryV1, type OrganizationDirectorySearchV1,
} from '@echo-brain/organization-api';
import {
  PERSON_PROJECTS_PATH_V1, PERSON_PROJECT_RENAME_PATH_V1, PERSON_PROJECT_ARCHIVE_PATH_V1, PERSON_PROJECT_LEAVE_PATH_V1, PERSON_UPDATES_PATH_V2, PROJECT_CONTEXT_RESPONSE_MAX_BYTES,
  validateProjectCreateV1, validateProjectCreateReceiptV1,
  validateProjectRenameV1, validateProjectArchiveV1, validateProjectLeaveV1, validateProjectSettingsReceiptV1,
  validateProjectIdV1, validateProjectContextBrowseV1, validateProjectMembersV1,
  validateProjectDirectorySearchV1, validateProjectDirectoryV1, validateProjectMemberAddV1, validateProjectMemberSetV1, validateProjectMemberRemoveV1,
  validateProjectMutationReceiptV1, validateProjectContextAssociateV1, validateProjectContextDissociateV1,
  validateProjectContextSearchV1,
  validatePersonUploadSearchV2, validatePersonUploadSearchResultV2,
  type ProjectCreateV1, type ProjectContextBrowseV1, type ProjectDirectorySearchV1,
  type ProjectRenameV1, type ProjectArchiveV1, type ProjectLeaveV1,
  type ProjectMemberAddV1, type ProjectMemberSetV1, type ProjectMemberRemoveV1, type ProjectContextAssociateV1, type ProjectContextDissociateV1,
  type ProjectContextSearchV1, type PersonUploadSearchV2,
} from '@echo-brain/organization-api';
import {
  PERSON_UPDATES_PATH_V3,
  validatePersonUpdateSubmitV3, validatePersonUpdateReceiptV3, validatePersonUpdateStatusResultV3,
  validatePersonUploadSearchV3, validatePersonUploadSearchResultV3,
  type PersonUpdateSubmitV3, type PersonUploadSearchV3,
} from '@echo-brain/organization-api';
import { canonicalJson } from "@echo-brain/federation-protocol";
import { PERSON_TOOL_COLLECTION_RESPONSE_MAX_BYTES_V1, PERSON_TOOL_REQUEST_MAX_BYTES_V1 } from '@echo-brain/organization-api';
import { MAX_ORGANIZATION_API_BODY_BYTES, ORGANIZATION_API_AUTHORITY_DESCRIPTOR_PATH, ORGANIZATION_API_PERSON_OIDC_BEGIN_PATH, ORGANIZATION_API_PERSON_SESSION_REFRESH_PATH, ORGANIZATION_API_PERSON_SESSION_REVOCATIONS_PATH, isCanonicalPersonEmail, isExpectedPersonEmail, isOrganizationApiValidationError, validateOrganizationApiError, validateOrganizationAuthorityDescriptorResponse, validateOrganizationPersonOidcBeginRequest, validateOrganizationPersonOidcBeginResponse, validateOrganizationPersonSession, validateOrganizationPersonSessionRefreshRequest, type OrganizationAuthorityDescriptorResponseV1, type OrganizationPersonOidcBeginRequestV2, type OrganizationPersonOidcBeginResponseV2, type OrganizationPersonSessionV2 } from "@echo-brain/organization-api";

const DEFAULT_TIMEOUT_MS = 15_000;
const ASK_TIMEOUT_MS = 135_000;
/** The Ask source check answers within its own 15 seconds; the client waits twice that. */
const ASK_CHECK_TIMEOUT_MS = 30_000;
const MAXIMUM_ORDINARY_RESPONSE_BYTES = 64 * 1024;
const MAXIMUM_RECORDS_RESPONSE_BYTES = 512 * 1024;
const PERSON_RECORDS_PATH_V1 = "/v1/person/records";
const PERSON_EMPLOYEES_PATH_V1 = "/v1/person/employees";
export interface EmployeeInvitationV1 {
  readonly login_grant: string;
  readonly expires_at: string;
}

export interface EmployeeRosterV1 {
  readonly schema_version: 1;
  readonly kind: "echo-clean-person-employee-roster-v1";
  readonly employees: readonly EmployeeRosterItemV1[];
}

export interface EmployeeRosterItemV1 {
  readonly email: string;
  readonly display_name: string;
  readonly membership_status: "active" | "revoked";
  readonly invitation_state: "pending" | "expired" | "redeemed" | "none";
}

export interface PersonRecordListV1 {
  readonly schema_version: 1;
  readonly kind: "echo-clean-person-record-list-v1";
  readonly records: readonly PersonRecordListItemV1[];
}

export interface PersonRecordListItemV1 {
  readonly position: number;
  readonly approval_id: string;
  readonly record_sha256: `sha256:${string}`;
  readonly envelope: Readonly<Record<string, unknown>>;
  readonly source_metadata?: {
    readonly record_approved_by?: { readonly display_name: string };
  };
}

export interface PersonRecordSearchV2 {
  readonly schema_version: 2;
  readonly kind: "echo-clean-person-record-search-v2";
  readonly items: readonly PersonRecordSearchItemV1[];
}

export interface PersonRecordSearchItemV1 {
  readonly atom_id: `sha256:${string}`;
  readonly record_sha256: `sha256:${string}`;
  readonly kind: "decision" | "action" | "rationale";
  readonly text: string;
  readonly policy_id:
    | "organization-member-readable-person-v2"
    | "restricted-reviewer-person-v2"
    | "project-members-readable-person-v1";
}

/** An Ask citation of an approved record or a source passage. */
export type PersonAnswerCitationV3 = OrganizationPersonAnswerCitationV3;
/**
 * The Ask's answer, on `/v7`: it may cite live tickets and pages, follow-ups (ADR-0040), and projects, people, tools and
 * tool containers (research tool contract v1).
 */
export type PersonAnswerV8 = OrganizationPersonAnswerV8;
export type PersonEvidenceSearchV1 = PersonEvidenceSearchRequestV1;
export type PersonEvidenceOpenV1 = PersonEvidenceOpenRequestV1;
export type PersonEvidenceDeskV1 = PersonEvidenceDeskResponseV1;
export type PersonAskSourceEvidenceV1 = PersonSourceEvidenceV1;
export type PersonListV1 = PersonListResponseV1;
export type PersonOpenV1 = PersonOpenResponseV1;

/**
 * A streamed Ask's answer (ADR-0039): the V8 answer, with its V3 receipt when
 * the Authority streamed, and no receipt when it answered in JSON.
 */
export interface PersonLiveAnswerV3 {
  readonly result: PersonAnswerV8;
  readonly receipt?: PersonAskReceiptV3;
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
  /** The Ask route answered it, with its route header: never an Authority without the route. */
  readonly routeMatched: boolean;

  constructor(
    public readonly code: string,
    public readonly status: number | null,
    message: string,
    options: { readonly unsent?: boolean; readonly routeMatched?: boolean } = {},
  ) {
    super(message);
    this.name = "PersonAuthorityClientError";
    this.unsent = options.unsent === true;
    this.routeMatched = options.routeMatched === true;
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
  try {
    url = new URL(value);
  } catch {
    throw new Error("Person Authority origin is invalid");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "" && url.pathname !== "/") ||
    (url.protocol !== "https:" &&
      !(allowInsecureLoopback && url.protocol === "http:" && loopback))
  ) {
    throw new Error("Person Authority must be one HTTPS origin");
  }
  url.pathname = "/";
  return url;
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number,
): Promise<string> {
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
        throw new PersonAuthorityClientError(
          "response_too_large",
          response.status,
          "Person Authority response exceeded its bound",
        );
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    size,
  );
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new PersonAuthorityClientError(
      "invalid_response",
      response.status,
      `Person Authority returned invalid UTF-8: ${String(error)}`,
    );
  }
}

function parsedJson(text: string, status: number): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new PersonAuthorityClientError(
      "invalid_response",
      status,
      "Person Authority returned invalid JSON",
    );
  }
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

/** `PERSON_ASK_PROGRESS_CONTENT_TYPE_V1`; any other reply to an opted-in Ask is read as today's JSON. */
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
  // Only `/v7` streams, and it marks the stream as its own, so an in-band 404 is never a missing route.
  if (response.status !== 200 || response.body === null || !response.headers.has(PERSON_ANSWER_ROUTE_HEADER_V5)) {
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

type AskScope = ProjectIdV1 | { readonly mine: true } | undefined;

/** The Ask's V3 request, which may carry the asker's previous turn (ADR-0047). */
function askRequest(question: string, scope: AskScope, captureId: PersonDiagnosticCaptureIdV1 | undefined, previous?: PersonAnswerPreviousV1) {
  return validatePersonAnswerRequestV3({ schema_version: 3, question,
    ...(typeof scope === 'string' ? { project_id: scope } : scope?.mine === true ? { mine: true } : {}), ...(captureId === undefined ? {} : { capture_id: captureId }),
    ...(previous === undefined ? {} : { previous }) });
}

/** Every Ask sends the client's clock and time zone and asks for answer layout v1 (ADR-0045). */
function askHeaders(): Readonly<Record<string, string>> {
  return { [PERSON_ASK_CLIENT_NOW_HEADER_V1]: new Date().toISOString(), [PERSON_ASK_TIME_ZONE_HEADER_V1]: Intl.DateTimeFormat().resolvedOptions().timeZone,
    [PERSON_ASK_ANSWER_LAYOUT_HEADER_V1]: PERSON_ASK_ANSWER_LAYOUT_HEADER_VALUE_V1 };
}

/**
 * Every Ask answer must echo the requested scope, and only an answer to an Ask that sent the previous turn may name its
 * question, say what is different since or ask which one (ADR-0047).
 */
function inAskScope<T extends { readonly scope: unknown }>(response: T, scope: AskScope, previous?: PersonAnswerPreviousV1): T {
  const expectedScope = scope === undefined ? { kind: 'global' } : typeof scope === 'string' ? { kind: 'project', project_id: scope } : { kind: 'mine' };
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

function validateSuccess<T>(
  value: unknown,
  status: number,
  validate: (input: unknown) => T,
): T {
  try {
    return validate(value);
  } catch (error) {
    if (!isOrganizationApiValidationError(error)) throw error;
    throw new PersonAuthorityClientError(
      "invalid_response",
      status,
      "Person Authority returned a malformed response",
    );
  }
}

function asPlainRecord(
  value: unknown,
  message: string,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  message: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(message);
  }
}

function validatePersonRecordList(
  value: unknown,
): PersonRecordListV1 {
  const response = asPlainRecord(value, "record list response is invalid");
  exactKeys(
    response,
    ["schema_version", "kind", "records"],
    "record list response is invalid",
  );
  if (
    response.schema_version !== 1 ||
    response.kind !== "echo-clean-person-record-list-v1" ||
    !Array.isArray(response.records) ||
    response.records.length > 100
  ) {
    throw new Error("record list response is invalid");
  }
  let previousPosition = Number.POSITIVE_INFINITY;
  const records = response.records.map((value) => {
    const record = asPlainRecord(value, "record list item is invalid");
    exactKeys(
      record,
      ["position", "approval_id", "record_sha256", "envelope",
        ...(record.source_metadata === undefined ? [] : ["source_metadata"])],
      "record list item is invalid",
    );
    if (
      typeof record.position !== "number" ||
      !Number.isSafeInteger(record.position) ||
      record.position < 1 ||
      record.position >= previousPosition ||
      typeof record.approval_id !== "string" ||
      record.approval_id.length === 0 ||
      record.approval_id.length > 256 ||
      typeof record.record_sha256 !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(record.record_sha256)
    ) {
      throw new Error("record list item is invalid");
    }
    const envelope = asPlainRecord(
      record.envelope,
      "record list item is invalid",
    );
    previousPosition = record.position;
    return Object.freeze({
      position: record.position,
      approval_id: record.approval_id,
      record_sha256: record.record_sha256 as `sha256:${string}`,
      envelope,
      ...(record.source_metadata === undefined ? {} : {
        source_metadata: validateSourceMetadata(record.source_metadata),
      }),
    });
  });
  return Object.freeze({
    schema_version: 1,
    kind: "echo-clean-person-record-list-v1",
    records: Object.freeze(records),
  });
}

function validateSourceMetadata(value: unknown): NonNullable<PersonRecordListItemV1["source_metadata"]> {
  const metadata = asPlainRecord(value, "source metadata is invalid");
  exactKeys(metadata, metadata.record_approved_by === undefined ? [] : ["record_approved_by"], "source metadata is invalid");
  if (metadata.record_approved_by === undefined) return Object.freeze({});
  const approver = asPlainRecord(metadata.record_approved_by, "source approver is invalid");
  exactKeys(approver, ["display_name"], "source approver is invalid");
  if (typeof approver.display_name !== "string" || approver.display_name.trim().length === 0 ||
    approver.display_name.length > 200 || /[\p{Cc}\p{Cf}]/u.test(approver.display_name)) {
    throw new Error("source approver is invalid");
  }
  return Object.freeze({ record_approved_by: Object.freeze({ display_name: approver.display_name }) });
}

function validatePersonRecordSearchRequest(value: unknown): {
  readonly query: string;
  readonly limit?: number;
} {
  const request = asPlainRecord(value, "record search request is invalid");
  const keys = Object.keys(request).sort();
  const query = validatePersonQueryText(request.query);
  if (
    keys.length < 1 || keys.length > 2 || !keys.includes("query") ||
    keys.some(key => key !== "query" && key !== "limit") ||
    (request.limit !== undefined &&
      (!Number.isSafeInteger(request.limit) ||
        (request.limit as number) < 1 ||
        (request.limit as number) > 10))
  ) {
    throw new PersonQueryInputError("invalid_limit", "Search --limit must be an integer from 1 to 10");
  }
  return Object.freeze({
    query,
    ...(request.limit === undefined
      ? {}
      : { limit: request.limit as number }),
  });
}

function validatePersonRecordSearch(
  value: unknown,
): PersonRecordSearchV2 {
  const response = asPlainRecord(value, "record search response is invalid");
  exactKeys(
    response,
    ["schema_version", "kind", "items"],
    "record search response is invalid",
  );
  if (
    response.schema_version !== 2 ||
    response.kind !== "echo-clean-person-record-search-v2" ||
    !Array.isArray(response.items) ||
    response.items.length > 10
  ) {
    throw new Error("record search response is invalid");
  }
  const items = response.items.map((value) => {
    const item = asPlainRecord(value, "record search item is invalid");
    exactKeys(
      item,
      ["atom_id", "record_sha256", "kind", "text", "policy_id"],
      "record search item is invalid",
    );
    if (
      typeof item.atom_id !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(item.atom_id) ||
      typeof item.record_sha256 !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(item.record_sha256) ||
      (item.kind !== "decision" &&
        item.kind !== "action" &&
        item.kind !== "rationale") ||
      typeof item.text !== "string" ||
      item.text.length === 0 ||
      item.text !== item.text.normalize("NFC") ||
      (item.policy_id !== "organization-member-readable-person-v2" &&
        item.policy_id !== "restricted-reviewer-person-v2" &&
        item.policy_id !== "project-members-readable-person-v1")
    ) {
      throw new Error("record search item is invalid");
    }
    return Object.freeze({
      atom_id: item.atom_id as `sha256:${string}`,
      record_sha256: item.record_sha256 as `sha256:${string}`,
      kind: item.kind,
      text: item.text,
      policy_id: item.policy_id,
    });
  });
  return Object.freeze({
    schema_version: 2,
    kind: "echo-clean-person-record-search-v2",
    items: Object.freeze(items),
  });
}

function validateEmployeeInvitation(value: unknown): EmployeeInvitationV1 {
  const response = asPlainRecord(value, "employee invitation response is invalid");
  exactKeys(response, ["login_grant", "expires_at"], "employee invitation response is invalid");
  if (
    typeof response.login_grant !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(response.login_grant) ||
    Buffer.from(response.login_grant, "base64url").length !== 32 ||
    typeof response.expires_at !== "string" ||
    !Number.isFinite(Date.parse(response.expires_at)) ||
    new Date(Date.parse(response.expires_at)).toISOString() !== response.expires_at
  ) {
    throw new Error("employee invitation response is invalid");
  }
  return Object.freeze({
    login_grant: response.login_grant,
    expires_at: response.expires_at,
  });
}

function validateEmployeeRoster(value: unknown): EmployeeRosterV1 {
  const response = asPlainRecord(value, "employee roster response is invalid");
  exactKeys(
    response,
    ["schema_version", "kind", "employees"],
    "employee roster response is invalid",
  );
  if (
    response.schema_version !== 1 ||
    response.kind !== "echo-clean-person-employee-roster-v1" ||
    !Array.isArray(response.employees)
  ) {
    throw new Error("employee roster response is invalid");
  }
  const employees = response.employees.map((value) => {
    const employee = asPlainRecord(value, "employee roster item is invalid");
    exactKeys(
      employee,
      ["email", "display_name", "membership_status", "invitation_state"],
      "employee roster item is invalid",
    );
    if (
      !isCanonicalPersonEmail(employee.email) ||
      typeof employee.display_name !== "string" ||
      employee.display_name.length < 1 ||
      employee.display_name.length > 200 ||
      employee.display_name !== employee.display_name.trim() ||
      employee.display_name !== employee.display_name.normalize("NFC") ||
      /[\u0000-\u001f\u007f]/.test(employee.display_name) ||
      (employee.membership_status !== "active" && employee.membership_status !== "revoked") ||
      (employee.invitation_state !== "pending" &&
        employee.invitation_state !== "expired" &&
        employee.invitation_state !== "redeemed" &&
        employee.invitation_state !== "none")
    ) {
      throw new Error("employee roster item is invalid");
    }
    return Object.freeze({
      email: employee.email,
      display_name: employee.display_name,
      membership_status: employee.membership_status,
      invitation_state: employee.invitation_state,
    }) as EmployeeRosterItemV1;
  });
  return Object.freeze({
    schema_version: 1,
    kind: "echo-clean-person-employee-roster-v1",
    employees: Object.freeze(employees),
  });
}

function employeeInviteRequest(value: unknown, includeName: boolean): Readonly<Record<string, string>> {
  const request = asPlainRecord(value, "employee request is invalid");
  exactKeys(request, includeName ? ["name", "email"] : ["email"], "employee request is invalid");
  if (
    typeof request.email !== "string" ||
    (includeName
      ? !isExpectedPersonEmail(request.email)
      : !isCanonicalPersonEmail(request.email)) ||
    (includeName && typeof request.name !== "string")
  ) {
    throw new Error("employee request is invalid");
  }
  return request as Readonly<Record<string, string>>;
}

interface JsonRequest {
  readonly path: string;
  readonly body: unknown;
  readonly validate_request: (value: unknown) => unknown;
  readonly access_token?: string;
  readonly method?: "POST" | "PUT";
  readonly headers?: Readonly<Record<string, string>>;
  /** Only a tool's bounded request (a handed-in meeting) passes the ordinary body bound. */
  readonly maximum_request_bytes?: number;
}

export class PersonAuthorityClient {
  private readonly origin: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: PersonAuthorityClientOptions) {
    this.origin = normalizeOrigin(
      options.authority_origin,
      options.allow_insecure_loopback === true,
    );
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("Person Authority timeout must be positive");
    }
  }

  private async send(
    path: string,
    init: Omit<RequestInit, "redirect" | "signal">,
    timeoutMs = this.timeoutMs,
    signal?: AbortSignal,
  ): Promise<Response> {
    return this.sendUntil(path, init, requestSignal(timeoutMs, signal));
  }

  /** `deadline` is the request's whole timeout and cancellation, which a streamed body is read under too. */
  private async sendUntil(
    path: string,
    init: Omit<RequestInit, "redirect" | "signal">,
    deadline: AbortSignal,
  ): Promise<Response> {
    try {
      return await this.fetchImpl(new URL(path, this.origin), {
        ...init,
        redirect: "error",
        signal: deadline,
      });
    } catch (error) {
      throw new PersonAuthorityClientError(
        "transport_failed",
        null,
        "Person Authority request failed",
        { unsent: neverSent(error) },
      );
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
    const value = await this.jsonValue(response,
      input.maximum_response_bytes ?? MAXIMUM_ORDINARY_RESPONSE_BYTES, input.expected_status);
    return validateSuccess(value, response.status, input.validate_response);
  }

  /** Sends one validated, bounded JSON request; reading the reply is the caller's. */
  private async post(input: JsonRequest, deadline: AbortSignal): Promise<Response> {
    const request = input.validate_request(input.body);
    const body = canonicalJson(request);
    if (Buffer.byteLength(body) > (input.maximum_request_bytes ?? MAX_ORGANIZATION_API_BODY_BYTES)) {
      throw new Error("Person Authority request exceeds its body bound");
    }
    return this.sendUntil(
      input.path,
      {
        method: input.method ?? "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...(input.access_token === undefined
            ? {}
            : { authorization: `Bearer ${input.access_token}` }),
          ...input.headers,
        },
        body,
      },
      deadline,
    );
  }

  private async jsonValue(response: Response, maximumBytes: number, expectedStatus?: number): Promise<unknown> {
    if (!isJsonResponse(response)) {
      throw new PersonAuthorityClientError(
        "invalid_response",
        response.status,
        "Person Authority returned a non-JSON response",
      );
    }
    const value = parsedJson(await readBoundedBody(response, maximumBytes), response.status);
    if (!response.ok) {
      let code = "request_failed";
      try {
        code = validateOrganizationApiError(value).error.code;
      } catch {
        throw new PersonAuthorityClientError(
          "invalid_response",
          response.status,
          "Person Authority returned a malformed error",
        );
      }
      throw new PersonAuthorityClientError(
        code,
        response.status,
        "Person Authority rejected the request",
        { routeMatched: response.headers.has(PERSON_ANSWER_ROUTE_HEADER_V5) },
      );
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
    readonly headers?: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal;
  }): Promise<T> {
    const response = await this.send(input.path, {
      method: "GET",
      headers: {
        ...input.headers,
        accept: "application/json",
        authorization: `Bearer ${input.access_token}`,
      },
    }, undefined, input.signal);
    const value = await this.jsonValue(response, input.maximum_response_bytes);
    try {
      return input.validate_response(value);
    } catch {
      throw new PersonAuthorityClientError(
        "invalid_response",
        response.status,
        "Person Authority returned a malformed response",
      );
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
  }): Promise<T> {
    const body = input.body === undefined ? undefined : canonicalJson(input.body);
    if (body !== undefined && Buffer.byteLength(body) > MAX_ORGANIZATION_API_BODY_BYTES) {
      throw new PersonAuthorityClientError('invalid_request', null, 'Person Authority request exceeds its body bound');
    }
    let status: number | null = null;
    try {
      const response = await this.send(input.path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { accept: 'application/json', authorization: `Bearer ${accessToken}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body }),
      });
      status = response.status;
      if (!isJsonResponse(response)) {
        throw new PersonAuthorityClientError('invalid_response', status, 'Person Authority returned a non-JSON response');
      }
      const text = await readBoundedBody(response, PROJECT_CONTEXT_RESPONSE_MAX_BYTES);
      const value = parsedContextJson(text, status);
      if (!response.ok) {
        const error = validateSuccess(value, status, validateOrganizationApiError);
        // The generic API envelope permits extension codes; this frozen
        // project/V2 family is closed and cannot infer rejection from one.
        if (!CLOSED_CONTEXT_ERROR_CODES.has(error.error.code)) {
          throw new PersonAuthorityClientError('invalid_response', status, 'Person Authority returned a noncanonical error');
        }
        if (input.request_id !== undefined && status >= 400 && status < 500) {
          throw new PersonContextMutationError(error.error.code, status, 'Person Authority rejected the request', input.request_id, 'not_submitted');
        }
        throw new PersonAuthorityClientError(error.error.code, status, 'Person Authority rejected the request');
      }
      if (status !== (input.status ?? 200)) {
        throw new PersonAuthorityClientError('invalid_response', status, 'Person Authority returned an unexpected status');
      }
      const result = validateSuccess(value, status, input.validate);
      if (input.matches !== undefined && !input.matches(result)) {
        throw new PersonAuthorityClientError('invalid_response', status, 'Person Authority returned different request coordinates');
      }
      return result;
    } catch (error) {
      if (error instanceof PersonContextMutationError) throw error;
      if (input.request_id !== undefined) throw unknownContextMutation(input.request_id, input.path === PERSON_UPDATES_PATH_V3, status);
      if (error instanceof PersonAuthorityClientError) throw error;
      throw new PersonAuthorityClientError('invalid_response', status, 'Person Authority returned a malformed response');
    }
  }

  private async documentResponse<T>(response: Response, validate: (value: unknown) => T, expectedStatus = 200): Promise<T> {
    if (!isJsonResponse(response)) {
      await response.body?.cancel();
      throw new PersonAuthorityClientError('invalid_response', response.status, 'Document response was not JSON.');
    }
    const value = parsedContextJson(await readBoundedBody(response, PERSON_DOCUMENT_JSON_MAX_BYTES), response.status);
    if (!response.ok) {
      const failure = validateSuccess(value, response.status, validateOrganizationApiError);
      if (!CLOSED_CONTEXT_ERROR_CODES.has(failure.error.code)) {
        throw new PersonAuthorityClientError('invalid_response', response.status, 'Document error response was invalid.');
      }
      throw new PersonAuthorityClientError(failure.error.code, response.status, 'Document request was rejected.');
    }
    if (response.status !== expectedStatus) throw new PersonAuthorityClientError('invalid_response', response.status, 'Document response status was unexpected.');
    return validateSuccess(value, response.status, validate);
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

  async projectsV2(accessToken: string, value: ProjectPageRequestV2 = {}) {
    const request = validateProjectPageRequestV2(value);
    const query = new URLSearchParams({ limit: String(request.limit), status: request.status ?? 'active' });
    if (request.cursor !== undefined) query.set('cursor', request.cursor);
    return this.contextRequest(accessToken, { path: `${PERSON_PROJECTS_PATH_V2}?${query}`, validate: validateProjectListV2,
      matches: result => result.items.length <= (request.limit ?? 10) && result.items.every(item => item.status === (request.status ?? 'active')) });
  }

  async createProject(accessToken: string, value: ProjectCreateV1) {
    const request = validateProjectCreateV1(value);
    return this.contextRequest(accessToken, { path: PERSON_PROJECTS_PATH_V1, body: request, status: 201,
      request_id: request.request_id, validate: validateProjectCreateReceiptV1,
      matches: result => result.request_id === request.request_id });
  }

  async readProjectV2(accessToken: string, projectId: string) {
    const project = validateProjectIdV1(projectId);
    return this.contextRequest(accessToken, { path: `${PERSON_PROJECTS_PATH_V2}/${project}`, validate: validateProjectSummaryV2,
      matches: result => result.project_id === project });
  }

  async renameProject(accessToken: string, value: ProjectRenameV1) {
    const request = validateProjectRenameV1(value);
    return this.contextRequest(accessToken, { path: PERSON_PROJECT_RENAME_PATH_V1, body: request,
      request_id: request.request_id, validate: validateProjectSettingsReceiptV1,
      matches: result => result.operation === 'rename' && result.request_id === request.request_id && result.project_id === request.project_id });
  }

  async archiveProject(accessToken: string, value: ProjectArchiveV1) {
    const request = validateProjectArchiveV1(value);
    return this.contextRequest(accessToken, { path: PERSON_PROJECT_ARCHIVE_PATH_V1, body: request,
      request_id: request.request_id, validate: validateProjectSettingsReceiptV1,
      matches: result => result.operation === 'archive' && result.request_id === request.request_id && result.project_id === request.project_id });
  }

  async leaveProject(accessToken: string, value: ProjectLeaveV1) {
    const request = validateProjectLeaveV1(value);
    return this.contextRequest(accessToken, { path: PERSON_PROJECT_LEAVE_PATH_V1, body: request,
      request_id: request.request_id, validate: validateProjectSettingsReceiptV1,
      matches: result => result.operation === 'leave' && result.request_id === request.request_id && result.project_id === request.project_id });
  }

  async projectMembers(accessToken: string, value: ProjectContextBrowseV1) {
    const request = validateProjectContextBrowseV1(value);
    return this.contextRequest(accessToken, { path: `${PERSON_PROJECTS_PATH_V1}/members`, body: request, validate: validateProjectMembersV1,
      matches: result => result.project_id === request.project_id && result.items.length <= (request.limit ?? 10) });
  }

  async projectDirectory(accessToken: string, value: ProjectDirectorySearchV1) {
    const request = validateProjectDirectorySearchV1(value);
    return this.contextRequest(accessToken, { path: `${PERSON_PROJECTS_PATH_V1}/directory`, body: request, validate: validateProjectDirectoryV1,
      matches: result => result.project_id === request.project_id && result.items.length <= (request.limit ?? 10) });
  }

  /** Active people in the signed-in person's own organization; no project needed. */
  async organizationDirectory(accessToken: string, value: OrganizationDirectorySearchV1 = {}) {
    const request = validateOrganizationDirectorySearchV1(value);
    return this.contextRequest(accessToken, { path: PERSON_DIRECTORY_PATH_V1, body: request, validate: validateOrganizationDirectoryV1,
      matches: result => result.items.length <= (request.limit ?? 10) });
  }

  async addProjectMember(accessToken: string, value: ProjectMemberAddV1) {
    const request = validateProjectMemberAddV1(value);
    return this.contextRequest(accessToken, { path: `${PERSON_PROJECTS_PATH_V1}/members/add`, body: request,
      request_id: request.request_id, validate: validateProjectMutationReceiptV1,
      matches: result => result.operation === 'member_set' && result.request_id === request.request_id &&
        result.project_id === request.project_id && result.membership_id === request.membership_id });
  }

  async setProjectMember(accessToken: string, value: ProjectMemberSetV1) {
    const request = validateProjectMemberSetV1(value);
    return this.contextRequest(accessToken, { path: `${PERSON_PROJECTS_PATH_V1}/members/set`, body: request,
      request_id: request.request_id, validate: validateProjectMutationReceiptV1,
      matches: result => result.operation === 'member_set' && result.request_id === request.request_id &&
        result.project_id === request.project_id && result.membership_id === request.membership_id });
  }

  async removeProjectMember(accessToken: string, value: ProjectMemberRemoveV1) {
    const request = validateProjectMemberRemoveV1(value);
    return this.contextRequest(accessToken, { path: `${PERSON_PROJECTS_PATH_V1}/members/remove`, body: request,
      request_id: request.request_id, validate: validateProjectMutationReceiptV1,
      matches: result => result.operation === 'member_remove' && result.request_id === request.request_id &&
        result.project_id === request.project_id && result.membership_id === request.membership_id });
  }

  async associateProjectContext(accessToken: string, value: ProjectContextAssociateV1) {
    const request = validateProjectContextAssociateV1(value);
    return this.contextRequest(accessToken, { path: `${PERSON_PROJECTS_PATH_V1}/context/associate`, body: request,
      request_id: request.request_id, validate: validateProjectMutationReceiptV1,
      matches: result => result.operation === 'associate' && result.request_id === request.request_id &&
        result.project_id === request.project_id && result.context_id === request.context_id });
  }

  async dissociateProjectContext(accessToken: string, value: ProjectContextDissociateV1) {
    const request = validateProjectContextDissociateV1(value);
    return this.contextRequest(accessToken, { path: `${PERSON_PROJECTS_PATH_V1}/context/dissociate`, body: request,
      request_id: request.request_id, validate: validateProjectMutationReceiptV1,
      matches: result => result.operation === 'dissociate' && result.request_id === request.request_id &&
        result.project_id === request.project_id && result.context_id === request.context_id });
  }

  async searchProjectContextV2(accessToken: string, value: ProjectContextSearchV1) {
    const request = validateProjectContextSearchV1(value);
    return this.contextRequest(accessToken, { path: `${PERSON_PROJECTS_PATH_V2}/context/search`, body: request, validate: validateProjectContextSearchResultV2,
      matches: result => result.project_id === request.project_id && result.items.length <= (request.limit ?? 10) });
  }

  async searchUploadsV2(accessToken: string, value: PersonUploadSearchV2) {
    const request = validatePersonUploadSearchV2(value);
    return this.contextRequest(accessToken, { path: `${PERSON_UPDATES_PATH_V2}/search`, body: request, validate: validatePersonUploadSearchResultV2,
      matches: result => result.results.length <= (request.limit ?? 10) });
  }

  async submitUpdateV3(accessToken: string, value: PersonUpdateSubmitV3) {
    const request = validatePersonUpdateSubmitV3(value);
    return this.contextRequest(accessToken, { path: PERSON_UPDATES_PATH_V3, body: request, status: 202,
      request_id: request.request_id, validate: validatePersonUpdateReceiptV3,
      matches: result => result.request_id === request.request_id &&
        canonicalJson(result.association_project_ids) === canonicalJson(request.association_project_ids) &&
        canonicalJson(result.audience) === canonicalJson(request.audience) });
  }

  async updateStatusV3(accessToken: string, requestId: string) {
    validatePersonUpdateRequestId(requestId);
    return this.contextRequest(accessToken, { path: `${PERSON_UPDATES_PATH_V3}/${requestId}`, validate: validatePersonUpdateStatusResultV3,
      matches: result => result.request_id === requestId });
  }

  async searchUploadsV3(accessToken: string, value: PersonUploadSearchV3) {
    const request = validatePersonUploadSearchV3(value);
    return this.contextRequest(accessToken, { path: `${PERSON_UPDATES_PATH_V3}/search`, body: request, validate: validatePersonUploadSearchResultV3,
      matches: result => result.results.length <= (request.limit ?? 10) });
  }

  async descriptor(): Promise<OrganizationAuthorityDescriptorResponseV1> {
    const response = await this.send(
      ORGANIZATION_API_AUTHORITY_DESCRIPTOR_PATH,
      {
        method: "GET",
        headers: { accept: "application/json" },
      },
    );
    if (!isJsonResponse(response)) {
      throw new PersonAuthorityClientError(
        "invalid_response",
        response.status,
        "Person Authority returned a non-JSON descriptor",
      );
    }
    const value = parsedJson(
      await readBoundedBody(response, MAXIMUM_ORDINARY_RESPONSE_BYTES),
      response.status,
    );
    if (!response.ok) {
      throw new PersonAuthorityClientError(
        "request_failed",
        response.status,
        "Person Authority rejected the descriptor request",
      );
    }
    return validateSuccess(
      value,
      response.status,
      validateOrganizationAuthorityDescriptorResponse,
    );
  }

  private async noContent(input: {
    readonly path: string;
    readonly body: unknown;
    readonly validate_request: (value: unknown) => unknown;
    readonly access_token: string;
    readonly method?: "POST" | "DELETE";
  }): Promise<void> {
    const request = input.validate_request(input.body);
    const body = canonicalJson(request);
    if (Buffer.byteLength(body) > MAX_ORGANIZATION_API_BODY_BYTES) {
      throw new Error("Person Authority request exceeds its body bound");
    }
    const response = await this.send(input.path, {
      method: input.method ?? "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.access_token}`,
        "content-type": "application/json",
      },
      body,
    });
    const text = await readBoundedBody(
      response,
      MAXIMUM_ORDINARY_RESPONSE_BYTES,
    );
    if (response.status === 204 && text === "") return;
    if (!response.ok) {
      const value = parsedJson(text, response.status);
      try {
        const error = validateOrganizationApiError(value);
        throw new PersonAuthorityClientError(
          error.error.code,
          response.status,
          "Person Authority rejected the request",
        );
      } catch (error) {
        if (error instanceof PersonAuthorityClientError) throw error;
      }
    }
    throw new PersonAuthorityClientError(
      "invalid_response",
      response.status,
      "Person Authority returned an invalid no-content response",
    );
  }

  beginOidcLogin(
    request: OrganizationPersonOidcBeginRequestV2,
  ): Promise<OrganizationPersonOidcBeginResponseV2> {
    return this.json({
      path: ORGANIZATION_API_PERSON_OIDC_BEGIN_PATH,
      body: request,
      validate_request: validateOrganizationPersonOidcBeginRequest,
      validate_response: validateOrganizationPersonOidcBeginResponse,
    });
  }

  refresh(refreshToken: string): Promise<OrganizationPersonSessionV2> {
    return this.json({
      path: ORGANIZATION_API_PERSON_SESSION_REFRESH_PATH,
      body: { refresh_token: refreshToken },
      validate_request: validateOrganizationPersonSessionRefreshRequest,
      validate_response: validateOrganizationPersonSession,
    });
  }

  logout(accessToken: string): Promise<void> {
    return this.noContent({
      path: ORGANIZATION_API_PERSON_SESSION_REVOCATIONS_PATH,
      body: {},
      validate_request: (value) => {
        if (
          value === null ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          Object.keys(value).length !== 0
        ) {
          throw new Error("Person logout request must be empty");
        }
        return value;
      },
      access_token: accessToken,
    });
  }

  records(
    accessToken: string,
    limit?: number,
    recordSha256?: `sha256:${string}`,
  ): Promise<PersonRecordListV1> {
    if (
      limit !== undefined &&
      (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    ) {
      throw new PersonQueryInputError("invalid_limit", "Person record limit must be an integer from 1 to 100");
    }
    if (
      recordSha256 !== undefined &&
      !/^sha256:[a-f0-9]{64}$/.test(recordSha256)
    ) {
      throw new Error("Person record SHA-256 is invalid");
    }
    return this.getJson({
      path:
        recordSha256 !== undefined
          ? `${PERSON_RECORDS_PATH_V1}?record_sha256=${recordSha256}`
          : limit === undefined
          ? PERSON_RECORDS_PATH_V1
          : `${PERSON_RECORDS_PATH_V1}?limit=${limit}`,
      access_token: accessToken,
      validate_response: validatePersonRecordList,
      headers: { "x-echo-person-record-version": "2" },
      maximum_response_bytes: MAXIMUM_RECORDS_RESPONSE_BYTES,
    });
  }

  searchRecords(
    accessToken: string,
    query: string,
    limit?: number,
  ): Promise<PersonRecordSearchV2> {
    return this.json({
      path: PERSON_RECORDS_PATH_V1,
      body: {
        query,
        ...(limit === undefined ? {} : { limit }),
      },
      validate_request: validatePersonRecordSearchRequest,
      validate_response: validatePersonRecordSearch,
      access_token: accessToken,
      maximum_response_bytes: MAXIMUM_ORDINARY_RESPONSE_BYTES,
    });
  }

  /**
   * The change check (desktop refresh and notifications v1; ADR-0036): one fingerprint per area of this person's own view, and
   * no content. Every Authority serves it (ADR-0048).
   */
  changes(accessToken: string, signal?: AbortSignal): Promise<PersonChangesV1> {
    return this.getJson({
      path: PERSON_CHANGES_ROUTE_V1,
      access_token: accessToken,
      validate_response: validatePersonChangesV1,
      maximum_response_bytes: MAXIMUM_ORDINARY_RESPONSE_BYTES,
      signal,
    });
  }

  /**
   * Project activity (Ask timeline v1, C2): when each of this person's active projects last had something new from someone
   * else that they can read, and no content; 500 projects fit the ordinary bound. Every Authority serves it (ADR-0048).
   */
  projectActivity(accessToken: string, signal?: AbortSignal): Promise<PersonProjectActivityV1> {
    return this.getJson({
      path: PERSON_PROJECT_ACTIVITY_PATH_V1,
      access_token: accessToken,
      validate_response: validatePersonProjectActivityV1,
      maximum_response_bytes: MAXIMUM_ORDINARY_RESPONSE_BYTES,
      signal,
    });
  }

  /** A read of a route an older Authority lacks: its 404 is `not_supported`, with this message, never `not_found`. */
  private async notSupportedOn404<T>(read: Promise<T>, message: string): Promise<T> {
    try {
      return await read;
    } catch (error) {
      if (error instanceof PersonAuthorityClientError && error.status === 404) throw new PersonAuthorityClientError("not_supported", 404, message);
      throw error;
    }
  }

  /**
   * Ask (`/v7`, the V8 answer, research tool contract v1): global by default, a supplied project ID is a strict
   * project-only scope, and mine is only what the asker added. The answer may cite live tickets and pages, follow-ups,
   * and the asker's projects, people, tools and tool containers, and must echo the requested scope. The request may
   * carry the asker's previous turn (ADR-0047).
   */
  askV7(accessToken: string, question: string, scope?: ProjectIdV1 | { readonly mine: true }, signal?: AbortSignal, captureId?: PersonDiagnosticCaptureIdV1, previous?: PersonAnswerPreviousV1): Promise<PersonAnswerV8> {
    return this.askRoute((async () => {
      const response = await this.json({ path: PERSON_ANSWER_PATH_V7, body: askRequest(question, scope, captureId, previous), headers: askHeaders(),
        validate_request: validatePersonAnswerRequestV3, validate_response: validatePersonAnswerResponseV8,
        access_token: accessToken, maximum_response_bytes: MAXIMUM_ORDINARY_RESPONSE_BYTES, timeout_ms: ASK_TIMEOUT_MS, signal });
      return inAskScope(response, scope, previous);
    })());
  }

  /**
   * `askV7` streamed in Ask progress V3 (ADR-0039): each step event reaches
   * `onProgress` as it arrives, and the answer comes back with the receipt the
   * Authority built after its final check. An Authority that does not stream
   * answers with the JSON answer, returned without a receipt, and an error
   * inside the stream is the error its JSON response would have had. The ask
   * timeout and the caller's signal bound the whole stream.
   */
  askV7WithProgress(accessToken: string, question: string, scope: ProjectIdV1 | { readonly mine: true } | undefined, signal: AbortSignal | undefined,
    onProgress: PersonAskProgressSinkV3, previous?: PersonAnswerPreviousV1): Promise<PersonLiveAnswerV3> {
    return this.askRoute((async () => {
      const deadline = requestSignal(ASK_TIMEOUT_MS, signal);
      const response = await this.post({ path: PERSON_ANSWER_PATH_V7, body: askRequest(question, scope, undefined, previous), validate_request: validatePersonAnswerRequestV3,
        access_token: accessToken, headers: { ...askHeaders(), accept: `${PERSON_ASK_PROGRESS_CONTENT_TYPE_V1}, application/json`, [PERSON_ASK_PROGRESS_HEADER_V1]: PERSON_ASK_PROGRESS_HEADER_VALUE_V3 } }, deadline);
      if (!isAskProgressStream(response)) {
        const value = await this.jsonValue(response, MAXIMUM_ORDINARY_RESPONSE_BYTES);
        return Object.freeze({ result: inAskScope(validateSuccess(value, response.status, validatePersonAnswerResponseV8), scope, previous) });
      }
      const terminal = await readAskProgressStream(response, deadline, onProgress);
      if (terminal.type === 'error') {
        throw new PersonAuthorityClientError(terminal.error.code, terminal.status, 'Person Authority rejected the request', { routeMatched: true });
      }
      return Object.freeze({ result: inAskScope(terminal.response, scope, previous), receipt: terminal.receipt });
    })());
  }

  /**
   * An Ask on `/v7`, which answers every request it matches with its route header: a `not_found` 404 without it is an
   * Authority with no `/v7`, `not_supported` here, never `not_found`. Any other failure is the Authority's own.
   */
  private async askRoute<T>(read: Promise<T>): Promise<T> {
    try {
      return await read;
    } catch (error) {
      if (error instanceof PersonAuthorityClientError && error.status === 404 && error.code === "not_found" && !error.routeMatched) {
        throw new PersonAuthorityClientError("not_supported", 404, "This Authority has no /v7 Ask");
      }
      throw error;
    }
  }

  /** Prepares or reads an explicitly requested private capture on the ordinary product route. */
  async diagnostics<K extends PersonDiagnosticsRequestV1['operation']>(accessToken: string, value: Extract<PersonDiagnosticsRequestV1, { readonly operation: K }>, signal?: AbortSignal): Promise<PersonDiagnosticsResultsV1[K]> {
    const request = validatePersonDiagnosticsRequestV1(value);
    const response = await this.json({ path: PERSON_DIAGNOSTICS_PATH_V1, body: request,
      validate_request: validatePersonDiagnosticsRequestV1, validate_response: value => validatePersonDiagnosticsResultV1(request.operation, value),
      access_token: accessToken, maximum_response_bytes: PERSON_DIAGNOSTICS_MAX_RESPONSE_BYTES_V1, timeout_ms: ASK_TIMEOUT_MS, signal });
    if (request.operation === 'read' && response.capture_id !== request.capture_id) throw new PersonAuthorityClientError('invalid_response', 200, 'Person Authority returned a different diagnostic capture');
    return response as PersonDiagnosticsResultsV1[K];
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
   * The Ask source check (Ask timeline v1, C1; ADR-0047): whether each source old answers cited is the same, changed, unreadable
   * or unknown now, and no content. An Authority without the route answers 404, which is `not_supported` here, never `not_found`.
   */
  async askCheck(accessToken: string, value: PersonAskCheckRequestV1, signal?: AbortSignal): Promise<PersonAskCheckV1> {
    const request = validatePersonAskCheckRequestV1(value);
    return this.notSupportedOn404(this.json({
      path: PERSON_ASK_CHECK_PATH_V1, body: request, validate_request: validatePersonAskCheckRequestV1,
      validate_response: response => validatePersonAskCheckV1(response, request), access_token: accessToken,
      maximum_request_bytes: PERSON_ASK_CHECK_LIMITS_V1.body_bytes, maximum_response_bytes: MAXIMUM_ORDINARY_RESPONSE_BYTES, timeout_ms: ASK_CHECK_TIMEOUT_MS, signal,
    }), "This Authority has no Ask source check");
  }

  evidenceSearch(accessToken: string, value: PersonEvidenceSearchV1, signal?: AbortSignal): Promise<PersonEvidenceDeskV1> {
    return this.evidenceDesk(PERSON_EVIDENCE_SEARCH_PATH_V1, validatePersonEvidenceSearchRequestV1, accessToken, value, signal);
  }

  evidenceOpen(accessToken: string, value: PersonEvidenceOpenV1, signal?: AbortSignal): Promise<PersonEvidenceDeskV1> {
    return this.evidenceDesk(PERSON_EVIDENCE_OPEN_PATH_V1, validatePersonEvidenceOpenRequestV1, accessToken, value, signal);
  }

  private async evidenceDesk<T extends { readonly project_id?: string }>(path: string, validate_request: (value: unknown) => T, accessToken: string,
    value: T, signal: AbortSignal | undefined): Promise<PersonEvidenceDeskV1> {
    const request = validate_request(value);
    const response = await this.json({ path, body: request,
      validate_request, validate_response: validatePersonEvidenceDeskResponseV1,
      access_token: accessToken, maximum_response_bytes: MAXIMUM_ORDINARY_RESPONSE_BYTES, signal });
    const expectedScope = request.project_id === undefined ? { kind: 'global' } : { kind: 'project', project_id: request.project_id };
    if (canonicalJson(response.scope) !== canonicalJson(expectedScope)) throw new PersonAuthorityClientError('invalid_response', 200, 'Person Authority returned different evidence scope');
    return response;
  }

  /** Model-free list (ADR-0024). Only the caller knows which page is first, so the header is checked here. */
  async list(accessToken: string, value: PersonListRequestV1, signal?: AbortSignal): Promise<PersonListV1> {
    const request = validatePersonListRequestV1(value);
    const response = await this.json({ path: PERSON_LIST_PATH_V1, body: request,
      validate_request: validatePersonListRequestV1, validate_response: validatePersonListResponseV1,
      access_token: accessToken, maximum_response_bytes: PERSON_LIST_RESPONSE_MAX_BYTES_V1, timeout_ms: DEFAULT_TIMEOUT_MS, signal });
    const expectedScope = request.project_id !== undefined ? { kind: 'project', project_id: request.project_id }
      : request.mine === true ? { kind: 'mine' } : request.only_me === true ? { kind: 'only_me' } : { kind: 'global' };
    if (canonicalJson(response.scope) !== canonicalJson(expectedScope)) throw new PersonAuthorityClientError('invalid_response', 200, 'Person Authority returned different list scope');
    // Global page 1 carries me; project page 1 carries project; mine, only_me and cursor pages carry no header.
    const hasHeader = response.me !== undefined || response.project !== undefined;
    if (hasHeader !== (request.cursor === undefined && (expectedScope.kind === 'global' || expectedScope.kind === 'project'))) {
      throw new PersonAuthorityClientError('invalid_response', 200, 'Person Authority returned a list header on the wrong page');
    }
    return response;
  }

  /** Opens one ref under the caller's current access; a meeting's detail belongs to its first page only. */
  async open(accessToken: string, value: PersonOpenRequestV1, signal?: AbortSignal): Promise<PersonOpenV1> {
    const request = validatePersonOpenRequestV1(value);
    const response = await this.json({ path: PERSON_OPEN_PATH_V1, body: request,
      validate_request: validatePersonOpenRequestV1, validate_response: validatePersonOpenResponseV1,
      access_token: accessToken, maximum_response_bytes: PERSON_OPEN_RESPONSE_MAX_BYTES_V1, timeout_ms: DEFAULT_TIMEOUT_MS, signal });
    if (response.ref !== request.ref ||
      (personRefKindV1(request.ref) === 'meeting' && ('meeting' in response) !== (request.cursor === undefined))) {
      throw new PersonAuthorityClientError('invalid_response', 200, 'Person Authority returned different open coordinates');
    }
    return response;
  }

  async askSourceEvidence(accessToken: string, value: PersonSourceEvidenceReadRequestV1): Promise<PersonAskSourceEvidenceV1> {
    const request = validatePersonSourceEvidenceReadRequestV1(value);
    const response = await this.json({
      path: PERSON_SOURCE_EVIDENCE_PATH_V1,
      body: request,
      validate_request: validatePersonSourceEvidenceReadRequestV1,
      validate_response: validatePersonSourceEvidenceV1,
      access_token: accessToken,
      maximum_response_bytes: MAXIMUM_ORDINARY_RESPONSE_BYTES,
      timeout_ms: ASK_TIMEOUT_MS,
    });
    const { label: _label, ...citation } = response.citation;
    if (
      canonicalJson(response.scope) !== canonicalJson(request.scope) ||
      canonicalJson(citation) !== canonicalJson(request.citation)
    ) {
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
      json: async <T>(input: import('@echo-brain/organization-api').PersonToolJsonRequestV1<T>): Promise<T> => {
        assertPath(input.path);
        assertBounds(input.maximum_response_bytes ?? MAXIMUM_ORDINARY_RESPONSE_BYTES, input.timeout_ms, input.maximum_request_bytes);
        return this.json({ path: input.path, body: input.body, validate_request: input.validate_request,
          validate_response: input.validate_response, maximum_response_bytes: input.maximum_response_bytes,
          ...(input.maximum_request_bytes === undefined ? {} : { maximum_request_bytes: input.maximum_request_bytes }),
          timeout_ms: input.timeout_ms, access_token: accessToken, signal });
      },
      getJson: async <T>(input: import('@echo-brain/organization-api').PersonToolGetRequestV1<T>): Promise<T> => {
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
    return this.getJson({
      path: PERSON_EMPLOYEES_PATH_V1,
      access_token: accessToken,
      validate_response: validateEmployeeRoster,
      maximum_response_bytes: MAXIMUM_RECORDS_RESPONSE_BYTES,
    });
  }

  inviteEmployee(
    input: { name: string; email: string },
    accessToken: string,
  ): Promise<EmployeeInvitationV1> {
    return this.json({
      path: PERSON_EMPLOYEES_PATH_V1,
      body: input,
      validate_request: (value) => employeeInviteRequest(value, true),
      validate_response: validateEmployeeInvitation,
      access_token: accessToken,
    });
  }

  reissueEmployee(
    input: { email: string },
    accessToken: string,
  ): Promise<EmployeeInvitationV1> {
    return this.json({
      path: PERSON_EMPLOYEES_PATH_V1,
      body: input,
      validate_request: (value) => employeeInviteRequest(value, false),
      validate_response: validateEmployeeInvitation,
      access_token: accessToken,
      method: "PUT",
    });
  }

  revokeEmployee(input: { email: string }, accessToken: string): Promise<void> {
    return this.noContent({
      path: PERSON_EMPLOYEES_PATH_V1,
      body: input,
      validate_request: (value) => employeeInviteRequest(value, false),
      access_token: accessToken,
      method: "DELETE",
    });
  }
}
