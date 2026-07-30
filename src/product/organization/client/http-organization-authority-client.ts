import { Buffer } from 'node:buffer';
import {
  isOrganizationApiValidationError,
  MAX_ORGANIZATION_API_BODY_BYTES,
  ORGANIZATION_API_ACCESS_LEASES_PATH,
  ORGANIZATION_API_AUTHORITY_DESCRIPTOR_PATH,
  ORGANIZATION_API_ENROLLMENT_AUTH_SCHEME,
  ORGANIZATION_API_ENROLLMENTS_PATH,
  ORGANIZATION_API_PERMISSION_CHECKS_PATH,
  ORGANIZATION_API_SLACK_LINK_CHALLENGES_PATH,
  ORGANIZATION_API_SLACK_LINK_COMPLETIONS_PATH,
  validateCompletedOrganizationEnrollment,
  validateOrganizationAccessLeaseRequest,
  validateOrganizationAccessLeaseResponse,
  validateOrganizationApiError,
  validateOrganizationAuthorityDescriptorResponse,
  validateOrganizationPermissionCheckDecision,
  validateOrganizationPermissionCheckRequest,
  validateOrganizationSlackLinkBeginRequest,
  validateOrganizationSlackLinkBeginResponse,
  validateOrganizationSlackLinkCompleteRequest,
  validateOrganizationSlackLinkResult,
  type CompleteOrganizationEnrollmentRequestV1,
  type CompletedOrganizationEnrollmentV1,
  type OrganizationAccessLeaseRequestV1,
  type OrganizationAccessLeaseResponseV1,
  type OrganizationAuthorityDescriptorResponseV1,
  type OrganizationPermissionCheckDecisionV1,
  type OrganizationPermissionCheckRequestV1,
  type OrganizationSlackLinkBeginRequestV1,
  type OrganizationSlackLinkBeginResponseV1,
  type OrganizationSlackLinkCompleteRequestV1,
  type OrganizationSlackLinkResultV1,
} from '@echo-brain/organization-api';
import type { OrganizationAuthorityClient } from './authority-client.js';
import { OrganizationAuthorityConflictError } from './authority-client.js';
import { createOrganizationAuthorityCaFetch } from './authority-ca-fetch.js';

const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const SLACK_LINK_TIMEOUT_MS = 75_000;
const JSON_HEADERS = {
  accept: 'application/json',
  'content-type': 'application/json',
} as const;
type ConflictHandling = 'transport-error' | 'stale-access-state';

export interface HttpOrganizationAuthorityClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  authorityCaPem?: string;
  timeoutMs?: number;
  /** Development/test only. Plain HTTP is restricted to loopback hosts. */
  allowInsecureLoopback?: boolean;
}

export class OrganizationAuthorityTransportError extends Error {
  readonly code: string;
  readonly status: number | null;

  constructor(code: string, message: string, status: number | null = null) {
    super(message);
    this.name = 'OrganizationAuthorityTransportError';
    this.code = code;
    this.status = status;
  }
}

function normalizeBaseUrl(value: string, allowInsecureLoopback: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('organization authority base URL is invalid');
  }
  if (
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    (url.pathname !== '' && url.pathname !== '/')
  ) {
    throw new Error(
      'organization authority base URL must be one origin without credentials, path, query, or hash',
    );
  }
  const loopback =
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]' ||
    url.hostname === 'localhost';
  if (
    url.protocol !== 'https:' &&
    !(allowInsecureLoopback && url.protocol === 'http:' && loopback)
  ) {
    throw new Error(
      'organization authority requires HTTPS (plain HTTP is development-only on loopback)',
    );
  }
  url.pathname = '/';
  return url;
}

function canonicalGrantBase64Url(grant: Uint8Array): string {
  if (!(grant instanceof Uint8Array) || grant.byteLength !== 32) {
    throw new Error(
      'organization enrollment grant must contain exactly 32 bytes',
    );
  }
  return Buffer.from(grant).toString('base64url');
}

function invalidResponse(status: number): OrganizationAuthorityTransportError {
  return new OrganizationAuthorityTransportError(
    'invalid_response',
    'organization authority returned a malformed response',
    status,
  );
}

function tryValidate<T>(
  value: unknown,
  validate: (candidate: unknown) => T,
): T | null {
  try {
    return validate(value);
  } catch (error) {
    if (isOrganizationApiValidationError(error)) return null;
    throw error;
  }
}

function validateResponse<T>(
  value: unknown,
  status: number,
  validate: (candidate: unknown) => T,
): T {
  const validated = tryValidate(value, validate);
  if (validated === null) throw invalidResponse(status);
  return validated;
}

export class HttpOrganizationAuthorityClient implements OrganizationAuthorityClient {
  private readonly baseUrl: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: HttpOrganizationAuthorityClientOptions) {
    this.baseUrl = normalizeBaseUrl(
      options.baseUrl,
      options.allowInsecureLoopback === true,
    );
    if (options.fetch !== undefined && options.authorityCaPem !== undefined) {
      throw new Error(
        'organization authority custom fetch and CA PEM are mutually exclusive',
      );
    }
    this.fetchImpl =
      options.fetch ??
      (options.authorityCaPem === undefined
        ? globalThis.fetch
        : createOrganizationAuthorityCaFetch(options.authorityCaPem));
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('organization authority HTTP transport is unavailable');
    }
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error('organization authority timeout must be positive');
    }
  }

  private endpoint(path: string): string {
    return new URL(path, this.baseUrl).href;
  }

  private async readJson(response: Response): Promise<unknown> {
    const contentType = response.headers.get('content-type');
    if (
      contentType === null ||
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)
    ) {
      throw new OrganizationAuthorityTransportError(
        'invalid_response',
        'organization authority returned a non-JSON response',
        response.status,
      );
    }
    const declaredLength = response.headers.get('content-length');
    if (
      declaredLength !== null &&
      (!/^\d+$/.test(declaredLength) ||
        Number(declaredLength) > MAX_RESPONSE_BYTES)
    ) {
      throw new OrganizationAuthorityTransportError(
        'response_too_large',
        'organization authority response exceeded its size limit',
        response.status,
      );
    }
    if (response.body === null) {
      throw new OrganizationAuthorityTransportError(
        'invalid_response',
        'organization authority returned an empty response',
        response.status,
      );
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new OrganizationAuthorityTransportError(
            'response_too_large',
            'organization authority response exceeded its size limit',
            response.status,
          );
        }
        chunks.push(Buffer.from(value));
      }
    } catch (error) {
      if (error instanceof OrganizationAuthorityTransportError) throw error;
      throw new OrganizationAuthorityTransportError(
        'transport_failed',
        'organization authority response could not be read',
        response.status,
      );
    } finally {
      reader.releaseLock();
    }
    const bytes = Buffer.concat(chunks, total);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_RESPONSE_BYTES) {
      throw new OrganizationAuthorityTransportError(
        'invalid_response',
        'organization authority returned an empty or oversized response',
        response.status,
      );
    }
    try {
      return JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      ) as unknown;
    } catch {
      throw new OrganizationAuthorityTransportError(
        'invalid_response',
        'organization authority returned invalid JSON',
        response.status,
      );
    }
  }

  private async request<T>(
    path: string,
    init: Omit<RequestInit, 'redirect' | 'signal'>,
    validateSuccess: (value: unknown) => T,
    conflictHandling: ConflictHandling = 'transport-error',
    signal?: AbortSignal,
    timeoutMs = this.timeoutMs,
  ): Promise<T> {
    let response: Response;
    try {
      const deadline = AbortSignal.timeout(timeoutMs);
      response = await this.fetchImpl(this.endpoint(path), {
        ...init,
        redirect: 'error',
        signal:
          signal === undefined ? deadline : AbortSignal.any([signal, deadline]),
      });
    } catch (error) {
      throw new OrganizationAuthorityTransportError(
        'transport_failed',
        `organization authority request failed: ${(error as Error).message}`,
      );
    }
    const value = await this.readJson(response);
    if (response.status === 409 && conflictHandling === 'stale-access-state') {
      const staleState = tryValidate(
        value,
        validateOrganizationAccessLeaseResponse,
      );
      if (staleState !== null) {
        throw new OrganizationAuthorityConflictError(staleState);
      }
      const apiError = tryValidate(value, validateOrganizationApiError);
      if (apiError === null) throw invalidResponse(response.status);
      throw new OrganizationAuthorityTransportError(
        apiError.error.code,
        'organization authority rejected the request',
        response.status,
      );
    }
    if (!response.ok) {
      const apiError = tryValidate(value, validateOrganizationApiError);
      if (apiError === null) throw invalidResponse(response.status);
      throw new OrganizationAuthorityTransportError(
        apiError.error.code,
        'organization authority rejected the request',
        response.status,
      );
    }
    return validateResponse(value, response.status, validateSuccess);
  }

  private postJson<T>(
    path: string,
    value: unknown,
    requestKind: 'access' | 'permission' | 'Slack link',
    validateSuccess: (value: unknown) => T,
    conflictHandling: ConflictHandling = 'transport-error',
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<T> {
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body) > MAX_ORGANIZATION_API_BODY_BYTES) {
      throw new Error(`organization ${requestKind} request exceeds the API body limit`);
    }
    return this.request(
      path,
      { method: 'POST', headers: JSON_HEADERS, body },
      validateSuccess,
      conflictHandling,
      signal,
      timeoutMs,
    );
  }

  readAuthorityDescriptor(): Promise<OrganizationAuthorityDescriptorResponseV1> {
    return this.request(
      ORGANIZATION_API_AUTHORITY_DESCRIPTOR_PATH,
      {
        method: 'GET',
        headers: { accept: 'application/json' },
      },
      validateOrganizationAuthorityDescriptorResponse,
    );
  }

  completeEnrollment(input: {
    enrollmentGrant: Uint8Array;
    enrollmentRequest: CompleteOrganizationEnrollmentRequestV1['enrollment_request'];
  }): Promise<CompletedOrganizationEnrollmentV1> {
    const body = JSON.stringify({
      enrollment_request: input.enrollmentRequest,
    } satisfies CompleteOrganizationEnrollmentRequestV1);
    if (Buffer.byteLength(body) > MAX_ORGANIZATION_API_BODY_BYTES) {
      throw new Error(
        'organization enrollment request exceeds the API body limit',
      );
    }
    return this.request(
      ORGANIZATION_API_ENROLLMENTS_PATH,
      {
        method: 'POST',
        headers: {
          ...JSON_HEADERS,
          authorization: `${ORGANIZATION_API_ENROLLMENT_AUTH_SCHEME} ${canonicalGrantBase64Url(input.enrollmentGrant)}`,
        },
        body,
      },
      validateCompletedOrganizationEnrollment,
    );
  }

  issueAccessLease(
    request: OrganizationAccessLeaseRequestV1,
  ): Promise<OrganizationAccessLeaseResponseV1> {
    return this.postJson(
      ORGANIZATION_API_ACCESS_LEASES_PATH,
      validateOrganizationAccessLeaseRequest(request),
      'access',
      validateOrganizationAccessLeaseResponse,
      'stale-access-state',
    );
  }

  checkPermission(
    request: OrganizationPermissionCheckRequestV1,
    signal?: AbortSignal,
  ): Promise<OrganizationPermissionCheckDecisionV1> {
    return this.postJson(
      ORGANIZATION_API_PERMISSION_CHECKS_PATH,
      validateOrganizationPermissionCheckRequest(request),
      'permission',
      validateOrganizationPermissionCheckDecision,
      'transport-error',
      signal,
    );
  }

  beginSlackLink(
    request: OrganizationSlackLinkBeginRequestV1,
    signal?: AbortSignal,
  ): Promise<OrganizationSlackLinkBeginResponseV1> {
    return this.postJson(
      ORGANIZATION_API_SLACK_LINK_CHALLENGES_PATH,
      validateOrganizationSlackLinkBeginRequest(request),
      'Slack link',
      validateOrganizationSlackLinkBeginResponse,
      'transport-error',
      signal,
      Math.max(this.timeoutMs, SLACK_LINK_TIMEOUT_MS),
    );
  }

  completeSlackLink(
    request: OrganizationSlackLinkCompleteRequestV1,
    signal?: AbortSignal,
  ): Promise<OrganizationSlackLinkResultV1> {
    return this.postJson(
      ORGANIZATION_API_SLACK_LINK_COMPLETIONS_PATH,
      validateOrganizationSlackLinkCompleteRequest(request),
      'Slack link',
      validateOrganizationSlackLinkResult,
      'transport-error',
      signal,
      Math.max(this.timeoutMs, SLACK_LINK_TIMEOUT_MS),
    );
  }
}
