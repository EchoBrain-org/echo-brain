import { Buffer } from 'node:buffer';
import {
  MAX_ORGANIZATION_API_BODY_BYTES,
  validateOrganizationAccessLeaseRequest,
  type CompleteOrganizationEnrollmentRequestV1,
  type OrganizationAccessLeaseRequestV1,
  type OrganizationAccessLeaseResponseV1,
  type OrganizationApiErrorV1,
} from '@echo-brain/organization-api';
import type { OrganizationAuthorityClient } from './authority-client.js';
import { OrganizationAuthorityConflictError } from './authority-client.js';

const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

export interface HttpOrganizationAuthorityClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
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

function errorCode(value: unknown): string | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('error' in value) ||
    typeof value.error !== 'object' ||
    value.error === null ||
    !('code' in value.error) ||
    typeof value.error.code !== 'string'
  ) {
    return null;
  }
  return (value as OrganizationApiErrorV1).error.code;
}

function staleStateResponse(
  value: unknown,
): OrganizationAccessLeaseResponseV1 | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    Object.keys(value).length !== 1 ||
    !('access_state' in value)
  ) {
    return null;
  }
  return value as OrganizationAccessLeaseResponseV1;
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
    this.fetchImpl = options.fetch ?? globalThis.fetch;
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

  private async request(
    path: string,
    init: Omit<RequestInit, 'redirect' | 'signal'>,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint(path), {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new OrganizationAuthorityTransportError(
        'transport_failed',
        `organization authority request failed: ${(error as Error).message}`,
      );
    }
    const value = await this.readJson(response);
    if (response.status === 409) {
      throw new OrganizationAuthorityConflictError(staleStateResponse(value));
    }
    if (!response.ok) {
      throw new OrganizationAuthorityTransportError(
        errorCode(value) ?? 'request_rejected',
        'organization authority rejected the request',
        response.status,
      );
    }
    return value;
  }

  readAuthorityDescriptor(): Promise<unknown> {
    return this.request('/v1/authority-descriptor', {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
  }

  completeEnrollment(input: {
    enrollmentGrant: Uint8Array;
    enrollmentRequest: CompleteOrganizationEnrollmentRequestV1['enrollment_request'];
  }): Promise<unknown> {
    const body = JSON.stringify({
      enrollment_request: input.enrollmentRequest,
    } satisfies CompleteOrganizationEnrollmentRequestV1);
    if (Buffer.byteLength(body) > MAX_ORGANIZATION_API_BODY_BYTES) {
      throw new Error(
        'organization enrollment request exceeds the API body limit',
      );
    }
    return this.request('/v1/enrollments', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Echo-Enrollment ${canonicalGrantBase64Url(input.enrollmentGrant)}`,
        'content-type': 'application/json',
      },
      body,
    });
  }

  issueAccessLease(
    request: OrganizationAccessLeaseRequestV1,
  ): Promise<unknown> {
    const validated = validateOrganizationAccessLeaseRequest(request);
    const body = JSON.stringify(validated);
    if (Buffer.byteLength(body) > MAX_ORGANIZATION_API_BODY_BYTES) {
      throw new Error('organization access request exceeds the API body limit');
    }
    return this.request('/v1/access-leases', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body,
    });
  }
}
