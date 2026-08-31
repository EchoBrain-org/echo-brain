import { Buffer } from "node:buffer";
import { canonicalJson } from "@echo-brain/federation-protocol";
import {
  MAX_ORGANIZATION_API_BODY_BYTES,
  ORGANIZATION_API_PERSON_MEETING_INGESTION_EXCLUSIONS_PATH,
  ORGANIZATION_API_PERSON_MEETING_INGESTION_EXCLUSION_LIST_PATH,
  ORGANIZATION_API_AUTHORITY_DESCRIPTOR_PATH,
  ORGANIZATION_API_PERSON_OIDC_BEGIN_PATH,
  ORGANIZATION_API_PERSON_SESSION_REFRESH_PATH,
  ORGANIZATION_API_PERSON_SESSION_REVOCATIONS_PATH,
  ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_CHALLENGES_PATH,
  ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_COMPLETIONS_PATH,
  isOrganizationApiValidationError,
  validateOrganizationApiError,
  validateOrganizationAuthorityDescriptorResponse,
  validateOrganizationPersonMeetingIngestionExclusionChangeRequest,
  validateOrganizationMeetingIngestionExclusionListResponse,
  validateOrganizationPersonMeetingIngestionExclusionListRequest,
  validateOrganizationPersonOidcBeginRequest,
  validateOrganizationPersonOidcBeginResponse,
  validateOrganizationPersonSession,
  validateOrganizationPersonSessionRefreshRequest,
  validateOrganizationPersonSlackIdentityLinkBeginRequest,
  validateOrganizationPersonSlackIdentityLinkBeginResponse,
  validateOrganizationPersonSlackIdentityLinkCompleteRequest,
  validateOrganizationPersonSlackIdentityLinkResult,
  type OrganizationPersonMeetingIngestionExclusionChangeRequestV2,
  type OrganizationMeetingIngestionExclusionListResponseV2,
  type OrganizationPersonMeetingIngestionExclusionListRequestV2,
  type OrganizationAuthorityDescriptorResponseV1,
  type OrganizationPersonOidcBeginRequestV2,
  type OrganizationPersonOidcBeginResponseV2,
  type OrganizationPersonSessionV2,
  type OrganizationPersonSlackIdentityLinkBeginRequestV2,
  type OrganizationPersonSlackIdentityLinkBeginResponseV2,
  type OrganizationPersonSlackIdentityLinkCompleteRequestV2,
  type OrganizationPersonSlackIdentityLinkResultV2,
} from "@echo-brain/organization-api";

const DEFAULT_TIMEOUT_MS = 15_000;
const SLACK_TIMEOUT_MS = 75_000;
const ASK_TIMEOUT_MS = 135_000;
const MAXIMUM_ORDINARY_RESPONSE_BYTES = 64 * 1024;
const MAXIMUM_RECORDS_RESPONSE_BYTES = 512 * 1024;
const PERSON_RECORDS_PATH_V1 = "/v1/person/records";
const PERSON_EMPLOYEES_PATH_V1 = "/v1/person/employees";
const PERSON_ANSWER_PATH_V1 = "/v1/person/ask";

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
}

export interface PersonRecordSearchV1 {
  readonly schema_version: 1;
  readonly kind: "echo-clean-person-record-search-v1";
  readonly generation_id: `sha256:${string}`;
  readonly record_head: {
    readonly position: number;
    readonly record_sha256: `sha256:${string}` | null;
  };
  readonly items: readonly PersonRecordSearchItemV1[];
}

export interface PersonRecordSearchItemV1 {
  readonly atom_id: `sha256:${string}`;
  readonly record_sha256: `sha256:${string}`;
  readonly kind: "decision" | "action" | "rationale";
  readonly text: string;
  readonly policy_id:
    | "organization-member-readable-person-v2"
    | "restricted-reviewer-person-v2";
}

export interface PersonAnswerV1 {
  readonly schema_version: 1;
  readonly kind: "echo-clean-person-answer-v1";
  readonly generation_id: `sha256:${string}`;
  readonly record_head: {
    readonly position: number;
    readonly record_sha256: `sha256:${string}` | null;
  };
  readonly answer: string;
  readonly citations: readonly PersonAnswerCitationV1[];
}

export interface PersonAnswerCitationV1 {
  readonly atom_id: `sha256:${string}`;
  readonly record_sha256: `sha256:${string}`;
  readonly policy_id:
    | "organization-member-readable-person-v2"
    | "restricted-reviewer-person-v2";
}

export class PersonAuthorityClientError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = "PersonAuthorityClientError";
  }
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
      ["position", "approval_id", "record_sha256", "envelope"],
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
    });
  });
  return Object.freeze({
    schema_version: 1,
    kind: "echo-clean-person-record-list-v1",
    records: Object.freeze(records),
  });
}

function validatePersonRecordSearchRequest(value: unknown): {
  readonly query: string;
  readonly limit?: number;
} {
  const request = asPlainRecord(value, "record search request is invalid");
  const keys = Object.keys(request).sort();
  const queryTerms =
    typeof request.query === "string"
      ? new Set(
          (request.query.match(/[\p{L}\p{N}]+/gu) ?? []).map((term) =>
            term.toLowerCase().normalize("NFC"),
          ),
        )
      : new Set<string>();
  if (
    keys.length < 1 ||
    keys.length > 2 ||
    !keys.includes("query") ||
    keys.some((key) => key !== "query" && key !== "limit") ||
    typeof request.query !== "string" ||
    request.query.length === 0 ||
    request.query !== request.query.normalize("NFC") ||
    request.query.trim() !== request.query ||
    /[\p{Cc}\p{Zl}\p{Zp}]/u.test(request.query) ||
    [...request.query].length > 240 ||
    queryTerms.size < 1 ||
    queryTerms.size > 16 ||
    [...queryTerms].some((term) => Buffer.byteLength(term, "utf8") > 64) ||
    (request.limit !== undefined &&
      (!Number.isSafeInteger(request.limit) ||
        (request.limit as number) < 1 ||
        (request.limit as number) > 10))
  ) {
    throw new Error("record search request is invalid");
  }
  return Object.freeze({
    query: request.query,
    ...(request.limit === undefined
      ? {}
      : { limit: request.limit as number }),
  });
}

function validatePersonAnswerRequest(value: unknown): {
  readonly question: string;
} {
  const request = asPlainRecord(value, "ask request is invalid");
  exactKeys(request, ["question"], "ask request is invalid");
  const questionTerms =
    typeof request.question === "string"
      ? new Set(
          (request.question.match(/[\p{L}\p{N}]+/gu) ?? []).map((term) =>
            term.toLowerCase().normalize("NFC"),
          ),
        )
      : new Set<string>();
  if (
    typeof request.question !== "string" ||
    request.question.length === 0 ||
    request.question !== request.question.normalize("NFC") ||
    request.question.trim() !== request.question ||
    /[\p{Cc}\p{Zl}\p{Zp}]/u.test(request.question) ||
    [...request.question].length > 240 ||
    questionTerms.size < 1 ||
    questionTerms.size > 16 ||
    [...questionTerms].some((term) => Buffer.byteLength(term, "utf8") > 64)
  ) {
    throw new Error("ask request is invalid");
  }
  return Object.freeze({ question: request.question });
}

function validatePersonRecordSearch(
  value: unknown,
): PersonRecordSearchV1 {
  const response = asPlainRecord(value, "record search response is invalid");
  exactKeys(
    response,
    ["schema_version", "kind", "generation_id", "record_head", "items"],
    "record search response is invalid",
  );
  if (
    response.schema_version !== 1 ||
    response.kind !== "echo-clean-person-record-search-v1" ||
    typeof response.generation_id !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(response.generation_id) ||
    !Array.isArray(response.items) ||
    response.items.length > 10
  ) {
    throw new Error("record search response is invalid");
  }
  const recordHead = asPlainRecord(response.record_head, "record search response is invalid");
  exactKeys(recordHead, ["position", "record_sha256"], "record search response is invalid");
  if (
    !Number.isSafeInteger(recordHead.position) ||
    (recordHead.position as number) < 0 ||
    (((recordHead.position as number) === 0) !== (recordHead.record_sha256 === null)) ||
    (recordHead.record_sha256 !== null &&
      (typeof recordHead.record_sha256 !== "string" ||
        !/^sha256:[a-f0-9]{64}$/.test(recordHead.record_sha256)))
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
        item.policy_id !== "restricted-reviewer-person-v2")
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
    schema_version: 1,
    kind: "echo-clean-person-record-search-v1",
    generation_id: response.generation_id as `sha256:${string}`,
    record_head: Object.freeze({
      position: recordHead.position as number,
      record_sha256: recordHead.record_sha256 as `sha256:${string}` | null,
    }),
    items: Object.freeze(items),
  });
}

function validatePersonAnswer(value: unknown): PersonAnswerV1 {
  const response = asPlainRecord(value, "ask response is invalid");
  exactKeys(
    response,
    [
      "schema_version",
      "kind",
      "generation_id",
      "record_head",
      "answer",
      "citations",
    ],
    "ask response is invalid",
  );
  if (
    response.schema_version !== 1 ||
    response.kind !== "echo-clean-person-answer-v1" ||
    typeof response.generation_id !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(response.generation_id) ||
    typeof response.answer !== "string" ||
    response.answer.length === 0 ||
    response.answer.trim() !== response.answer ||
    [...response.answer].length > 12_000 ||
    !Array.isArray(response.citations) ||
    response.citations.length > 16
  ) {
    throw new Error("ask response is invalid");
  }
  const recordHead = asPlainRecord(response.record_head, "ask response is invalid");
  exactKeys(recordHead, ["position", "record_sha256"], "ask response is invalid");
  if (
    !Number.isSafeInteger(recordHead.position) ||
    (recordHead.position as number) < 0 ||
    (((recordHead.position as number) === 0) !== (recordHead.record_sha256 === null)) ||
    (recordHead.record_sha256 !== null &&
      (typeof recordHead.record_sha256 !== "string" ||
        !/^sha256:[a-f0-9]{64}$/.test(recordHead.record_sha256)))
  ) {
    throw new Error("ask response is invalid");
  }
  const seenAtomIds = new Set<string>();
  const citations = response.citations.map((value) => {
    const citation = asPlainRecord(value, "ask citation is invalid");
    exactKeys(
      citation,
      ["atom_id", "record_sha256", "policy_id"],
      "ask citation is invalid",
    );
    if (
      typeof citation.atom_id !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(citation.atom_id) ||
      seenAtomIds.has(citation.atom_id) ||
      typeof citation.record_sha256 !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(citation.record_sha256) ||
      (citation.policy_id !== "organization-member-readable-person-v2" &&
        citation.policy_id !== "restricted-reviewer-person-v2")
    ) {
      throw new Error("ask citation is invalid");
    }
    seenAtomIds.add(citation.atom_id);
    return Object.freeze({
      atom_id: citation.atom_id as `sha256:${string}`,
      record_sha256: citation.record_sha256 as `sha256:${string}`,
      policy_id: citation.policy_id,
    }) as PersonAnswerCitationV1;
  });
  return Object.freeze({
    schema_version: 1,
    kind: "echo-clean-person-answer-v1",
    generation_id: response.generation_id as `sha256:${string}`,
    record_head: Object.freeze({
      position: recordHead.position as number,
      record_sha256: recordHead.record_sha256 as `sha256:${string}` | null,
    }),
    answer: response.answer,
    citations: Object.freeze(citations),
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
      typeof employee.email !== "string" ||
      employee.email.length < 3 ||
      employee.email.length > 254 ||
      employee.email !== employee.email.trim() ||
      employee.email !== employee.email.toLowerCase() ||
      !/^[!-~]+$/.test(employee.email) ||
      employee.email.indexOf("@") <= 0 ||
      employee.email.indexOf("@") !== employee.email.lastIndexOf("@") ||
      employee.email.endsWith("@") ||
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
    (includeName && typeof request.name !== "string")
  ) {
    throw new Error("employee request is invalid");
  }
  return request as Readonly<Record<string, string>>;
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
  ): Promise<Response> {
    try {
      return await this.fetchImpl(new URL(path, this.origin), {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new PersonAuthorityClientError(
        "transport_failed",
        null,
        "Person Authority request failed",
      );
    }
  }

  private async json<T>(input: {
    readonly path: string;
    readonly body: unknown;
    readonly validate_request: (value: unknown) => unknown;
    readonly validate_response: (value: unknown) => T;
    readonly access_token?: string;
    readonly maximum_response_bytes?: number;
    readonly require_canonical_response?: boolean;
    readonly timeout_ms?: number;
    readonly method?: "POST" | "PUT";
  }): Promise<T> {
    const request = input.validate_request(input.body);
    const body = canonicalJson(request);
    if (Buffer.byteLength(body) > MAX_ORGANIZATION_API_BODY_BYTES) {
      throw new Error("Person Authority request exceeds its body bound");
    }
    const response = await this.send(
      input.path,
      {
        method: input.method ?? "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...(input.access_token === undefined
            ? {}
            : { authorization: `Bearer ${input.access_token}` }),
        },
        body,
      },
      input.timeout_ms,
    );
    const contentType = response.headers.get("content-type");
    if (
      contentType === null ||
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)
    ) {
      throw new PersonAuthorityClientError(
        "invalid_response",
        response.status,
        "Person Authority returned a non-JSON response",
      );
    }
    const text = await readBoundedBody(
      response,
      input.maximum_response_bytes ?? MAXIMUM_ORDINARY_RESPONSE_BYTES,
    );
    const value = parsedJson(text, response.status);
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
      );
    }
    if (
      input.require_canonical_response === true &&
      canonicalJson(value) !== text
    ) {
      throw new PersonAuthorityClientError(
        "invalid_response",
        response.status,
        "Person Authority returned noncanonical response bytes",
      );
    }
    return validateSuccess(value, response.status, input.validate_response);
  }

  private async getJson<T>(input: {
    readonly path: string;
    readonly access_token: string;
    readonly validate_response: (value: unknown) => T;
    readonly maximum_response_bytes: number;
  }): Promise<T> {
    const response = await this.send(input.path, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.access_token}`,
      },
    });
    const contentType = response.headers.get("content-type");
    if (
      contentType === null ||
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)
    ) {
      throw new PersonAuthorityClientError(
        "invalid_response",
        response.status,
        "Person Authority returned a non-JSON response",
      );
    }
    const value = parsedJson(
      await readBoundedBody(response, input.maximum_response_bytes),
      response.status,
    );
    if (!response.ok) {
      try {
        const error = validateOrganizationApiError(value);
        throw new PersonAuthorityClientError(
          error.error.code,
          response.status,
          "Person Authority rejected the request",
        );
      } catch (error) {
        if (error instanceof PersonAuthorityClientError) throw error;
        throw new PersonAuthorityClientError(
          "invalid_response",
          response.status,
          "Person Authority returned a malformed error",
        );
      }
    }
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

  async descriptor(): Promise<OrganizationAuthorityDescriptorResponseV1> {
    const response = await this.send(
      ORGANIZATION_API_AUTHORITY_DESCRIPTOR_PATH,
      {
        method: "GET",
        headers: { accept: "application/json" },
      },
    );
    const contentType = response.headers.get("content-type");
    if (
      contentType === null ||
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)
    ) {
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
  ): Promise<PersonRecordListV1> {
    if (
      limit !== undefined &&
      (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    ) {
      throw new Error("Person record limit must be an integer from 1 to 100");
    }
    return this.getJson({
      path:
        limit === undefined
          ? PERSON_RECORDS_PATH_V1
          : `${PERSON_RECORDS_PATH_V1}?limit=${limit}`,
      access_token: accessToken,
      validate_response: validatePersonRecordList,
      maximum_response_bytes: MAXIMUM_RECORDS_RESPONSE_BYTES,
    });
  }

  searchRecords(
    accessToken: string,
    query: string,
    limit?: number,
  ): Promise<PersonRecordSearchV1> {
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

  ask(accessToken: string, question: string): Promise<PersonAnswerV1> {
    return this.json({
      path: PERSON_ANSWER_PATH_V1,
      body: { question },
      validate_request: validatePersonAnswerRequest,
      validate_response: validatePersonAnswer,
      access_token: accessToken,
      maximum_response_bytes: MAXIMUM_ORDINARY_RESPONSE_BYTES,
      timeout_ms: ASK_TIMEOUT_MS,
    });
  }

  changeMeetingIngestionExclusion(
    request: OrganizationPersonMeetingIngestionExclusionChangeRequestV2,
    accessToken: string,
  ): Promise<void> {
    return this.noContent({
      path: ORGANIZATION_API_PERSON_MEETING_INGESTION_EXCLUSIONS_PATH,
      body: request,
      validate_request: validateOrganizationPersonMeetingIngestionExclusionChangeRequest,
      access_token: accessToken,
    });
  }

  meetingIngestionExclusions(
    request: OrganizationPersonMeetingIngestionExclusionListRequestV2,
    accessToken: string,
  ): Promise<OrganizationMeetingIngestionExclusionListResponseV2> {
    return this.json({
      path: ORGANIZATION_API_PERSON_MEETING_INGESTION_EXCLUSION_LIST_PATH,
      body: request,
      validate_request: validateOrganizationPersonMeetingIngestionExclusionListRequest,
      validate_response: validateOrganizationMeetingIngestionExclusionListResponse,
      access_token: accessToken,
      require_canonical_response: true,
    });
  }

  beginSlackIdentityLink(
    request: OrganizationPersonSlackIdentityLinkBeginRequestV2,
    accessToken: string,
  ): Promise<OrganizationPersonSlackIdentityLinkBeginResponseV2> {
    return this.json({
      path: ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_CHALLENGES_PATH,
      body: request,
      validate_request: validateOrganizationPersonSlackIdentityLinkBeginRequest,
      validate_response: validateOrganizationPersonSlackIdentityLinkBeginResponse,
      access_token: accessToken,
      timeout_ms: Math.max(this.timeoutMs, SLACK_TIMEOUT_MS),
    });
  }

  completeSlackIdentityLink(
    request: OrganizationPersonSlackIdentityLinkCompleteRequestV2,
    accessToken: string,
  ): Promise<OrganizationPersonSlackIdentityLinkResultV2> {
    return this.json({
      path: ORGANIZATION_API_PERSON_SLACK_IDENTITY_LINK_COMPLETIONS_PATH,
      body: request,
      validate_request: validateOrganizationPersonSlackIdentityLinkCompleteRequest,
      validate_response: validateOrganizationPersonSlackIdentityLinkResult,
      access_token: accessToken,
      timeout_ms: Math.max(this.timeoutMs, SLACK_TIMEOUT_MS),
    });
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
