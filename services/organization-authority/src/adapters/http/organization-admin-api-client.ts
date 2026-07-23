import {
  MAX_ORGANIZATION_API_BODY_BYTES,
  MAX_ORGANIZATION_API_CURSOR_CHARACTERS,
  MAX_ORGANIZATION_API_PAGE_ITEMS,
  ORGANIZATION_API_ADMIN_AUDIT_PATH,
  ORGANIZATION_API_ADMIN_AUTH_SCHEME,
  ORGANIZATION_API_ADMIN_ENROLLMENT_GRANTS_PATH,
  ORGANIZATION_API_ADMIN_INSTALLATIONS_PATH,
  ORGANIZATION_API_ADMIN_MEMBERSHIPS_PATH,
  ORGANIZATION_API_ADMIN_OVERVIEW_PATH,
  ORGANIZATION_API_PROXY_AUTH_SCHEME,
  organizationApiInstallationRevocationsPath,
  organizationApiMembershipEnrollmentGrantsPath,
  organizationApiMembershipRevocationsPath,
  TRUSTED_PROXY_AUTHORIZATION_HEADER,
  TRUSTED_PROXY_CLIENT_ID_HEADER,
  validateIssuedOrganizationEnrollmentGrant,
  validateOrganizationAdminOverview,
  validateOrganizationApiError,
  validateOrganizationAuditPage,
  validateOrganizationEnrollmentGrantPage,
  validateOrganizationInstallationPage,
  validateOrganizationMembershipPage,
  validateProvisionedOrganizationMembership,
  validateProvisionOrganizationMembershipRequest,
  validateIssueOrganizationEnrollmentGrantRequest,
  validateRevokeOrganizationSubjectRequest,
  validateRevokedOrganizationInstallation,
  validateRevokedOrganizationMembership,
} from '@echo-brain/organization-api';
import type {
  IssueOrganizationEnrollmentGrantRequestV1,
  IssuedOrganizationEnrollmentGrantV1,
  OrganizationAdminOverviewV1,
  OrganizationApiErrorV1,
  OrganizationApiPageCursorV1,
  OrganizationAuditPageV1,
  OrganizationEnrollmentGrantPageV1,
  OrganizationInstallationPageV1,
  OrganizationMembershipPageV1,
  ProvisionedOrganizationMembershipV1,
  ProvisionOrganizationMembershipRequestV1,
  RevokeOrganizationSubjectRequestV1,
  RevokedOrganizationInstallationV1,
  RevokedOrganizationMembershipV1,
} from '@echo-brain/organization-api';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAXIMUM_TIMEOUT_MS = 120_000;
export const MAX_ORGANIZATION_ADMIN_API_RESPONSE_BYTES = 512 * 1024;

const UUID_V4_SOURCE =
  '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const MEMBERSHIP_ID_PATTERN = new RegExp(`^mem_${UUID_V4_SOURCE}$`);
const INSTALLATION_ID_PATTERN = new RegExp(`^ins_${UUID_V4_SOURCE}$`);

export interface OrganizationAdminApiClientOptions {
  base_url: string;
  admin_token: string;
  trusted_proxy_token: string;
  client_identity: string;
  fetch?: typeof fetch;
  timeout_ms?: number;
}

export interface OrganizationAdminPageRequest {
  cursor?: OrganizationApiPageCursorV1;
  limit?: number;
}

export class OrganizationAdminApiTransportError extends Error {
  readonly code:
    | 'invalid_response'
    | 'request_too_large'
    | 'response_too_large'
    | 'transport_failed';
  readonly status: number | null;

  constructor(
    code: OrganizationAdminApiTransportError['code'],
    message: string,
    status: number | null = null,
  ) {
    super(message);
    this.name = 'OrganizationAdminApiTransportError';
    this.code = code;
    this.status = status;
  }
}

/** A validated ordinary API error. Credential and request bytes are omitted. */
export class OrganizationAdminApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly response: OrganizationApiErrorV1;

  constructor(status: number, response: OrganizationApiErrorV1) {
    super('organization authority rejected the administrator request');
    this.name = 'OrganizationAdminApiError';
    this.code = response.error.code;
    this.status = status;
    this.response = response;
  }
}

interface AdminRequest<T> {
  method: 'GET' | 'POST';
  path: string;
  expected_status: 200 | 201;
  body?: unknown;
  validate(value: unknown): T;
}

function invalidResponse(status: number): OrganizationAdminApiTransportError {
  return new OrganizationAdminApiTransportError(
    'invalid_response',
    'organization authority returned an invalid administrator response',
    status,
  );
}

function validateVisibleCredential(value: string, label: string): string {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{32,4096}$/.test(value)) {
    throw new Error(`${label} must be 32-4096 visible ASCII bytes`);
  }
  return value;
}

function validateClientIdentity(value: string): string {
  const match = /^cid_([A-Za-z0-9_-]{43})$/.exec(value ?? '');
  if (match === null) {
    throw new Error('administrator client identity must be canonical');
  }
  const bytes = Buffer.from(match[1]!, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== match[1]) {
    throw new Error('administrator client identity must be canonical');
  }
  return value;
}

function validateBaseUrl(value: string): URL {
  if (typeof value !== 'string') {
    throw new Error('organization administrator base URL is invalid');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('organization administrator base URL is invalid');
  }
  if (
    url.protocol !== 'http:' ||
    (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    (value !== url.origin && value !== `${url.origin}/`)
  ) {
    throw new Error(
      'organization administrator base URL must be one bare loopback HTTP origin',
    );
  }
  return url;
}

function validateTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeout) ||
    timeout <= 0 ||
    timeout > MAXIMUM_TIMEOUT_MS
  ) {
    throw new Error(
      `organization administrator timeout must be from 1 through ${MAXIMUM_TIMEOUT_MS} milliseconds`,
    );
  }
  return timeout;
}

function validateCanonicalCursor(value: string): void {
  if (
    value.length === 0 ||
    value.length > MAX_ORGANIZATION_API_CURSOR_CHARACTERS ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new Error('organization administrator page cursor is invalid');
  }
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length === 0 || bytes.toString('base64url') !== value) {
    throw new Error('organization administrator page cursor is invalid');
  }
}

function pageQuery(request: OrganizationAdminPageRequest | undefined): string {
  if (request === undefined) return '';
  const record = request as unknown as Record<string, unknown>;
  if (
    record === null ||
    typeof record !== 'object' ||
    Array.isArray(record) ||
    Object.keys(record).some((key) => key !== 'cursor' && key !== 'limit')
  ) {
    throw new Error('organization administrator page request is invalid');
  }
  const parameters = new URLSearchParams();
  if (request.cursor !== undefined) {
    validateCanonicalCursor(request.cursor);
    parameters.set('cursor', request.cursor);
  }
  if (request.limit !== undefined) {
    if (
      !Number.isSafeInteger(request.limit) ||
      request.limit <= 0 ||
      request.limit > MAX_ORGANIZATION_API_PAGE_ITEMS
    ) {
      throw new Error(
        `organization administrator page limit must be from 1 through ${MAX_ORGANIZATION_API_PAGE_ITEMS}`,
      );
    }
    parameters.set('limit', String(request.limit));
  }
  const query = parameters.toString();
  return query === '' ? '' : `?${query}`;
}

function validateSubjectId(
  value: string,
  pattern: RegExp,
  label: string,
): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`${label} must be a canonical identifier`);
  }
  return value;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type');
  if (
    contentType === null ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)
  ) {
    throw invalidResponse(response.status);
  }
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength)) {
      throw invalidResponse(response.status);
    }
    const length = Number(declaredLength);
    if (
      !Number.isSafeInteger(length) ||
      length > MAX_ORGANIZATION_ADMIN_API_RESPONSE_BYTES
    ) {
      throw new OrganizationAdminApiTransportError(
        'response_too_large',
        'organization authority administrator response exceeded its size limit',
        response.status,
      );
    }
  }
  if (response.body === null) throw invalidResponse(response.status);

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch {
        throw new OrganizationAdminApiTransportError(
          'transport_failed',
          'organization authority administrator response could not be read',
          response.status,
        );
      }
      if (result.done) break;
      total += result.value.byteLength;
      if (total > MAX_ORGANIZATION_ADMIN_API_RESPONSE_BYTES) {
        try {
          await reader.cancel();
        } catch {}
        throw new OrganizationAdminApiTransportError(
          'response_too_large',
          'organization authority administrator response exceeded its size limit',
          response.status,
        );
      }
      chunks.push(Buffer.from(result.value));
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw invalidResponse(response.status);

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(chunks, total),
    );
  } catch {
    throw invalidResponse(response.status);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidResponse(response.status);
  }
}

export class OrganizationAdminApiClient {
  private readonly baseUrl: URL;
  private readonly adminToken: string;
  private readonly trustedProxyToken: string;
  private readonly clientIdentity: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: OrganizationAdminApiClientOptions) {
    if (
      options === null ||
      typeof options !== 'object' ||
      Array.isArray(options)
    ) {
      throw new Error('organization administrator client options are invalid');
    }
    this.baseUrl = validateBaseUrl(options.base_url);
    this.adminToken = validateVisibleCredential(
      options.admin_token,
      'administrator token',
    );
    this.trustedProxyToken = validateVisibleCredential(
      options.trusted_proxy_token,
      'trusted proxy token',
    );
    if (this.adminToken === this.trustedProxyToken) {
      throw new Error(
        'administrator and trusted proxy tokens must be distinct credentials',
      );
    }
    this.clientIdentity = validateClientIdentity(options.client_identity);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') {
      throw new Error(
        'organization administrator HTTP transport is unavailable',
      );
    }
    this.timeoutMs = validateTimeout(options.timeout_ms);
  }

  private endpoint(path: string): string {
    return new URL(path, this.baseUrl).href;
  }

  private async request<T>(request: AdminRequest<T>): Promise<T> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `${ORGANIZATION_API_ADMIN_AUTH_SCHEME} ${this.adminToken}`,
      [TRUSTED_PROXY_AUTHORIZATION_HEADER]: `${ORGANIZATION_API_PROXY_AUTH_SCHEME} ${this.trustedProxyToken}`,
      [TRUSTED_PROXY_CLIENT_ID_HEADER]: this.clientIdentity,
    };
    let serializedBody: string | undefined;
    if (request.body !== undefined) {
      serializedBody = JSON.stringify(request.body);
      if (
        Buffer.byteLength(serializedBody, 'utf8') >
        MAX_ORGANIZATION_API_BODY_BYTES
      ) {
        throw new OrganizationAdminApiTransportError(
          'request_too_large',
          'organization administrator request exceeded its size limit',
        );
      }
      headers['content-type'] = 'application/json; charset=utf-8';
    }

    const signal = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint(request.path), {
        method: request.method,
        headers,
        ...(serializedBody === undefined ? {} : { body: serializedBody }),
        redirect: 'error',
        signal,
      });
    } catch {
      throw new OrganizationAdminApiTransportError(
        'transport_failed',
        'organization administrator request failed',
      );
    }

    const value = await readBoundedJson(response);
    if (response.status !== request.expected_status) {
      if (!response.ok) {
        try {
          throw new OrganizationAdminApiError(
            response.status,
            validateOrganizationApiError(value),
          );
        } catch (error) {
          if (error instanceof OrganizationAdminApiError) throw error;
          throw invalidResponse(response.status);
        }
      }
      throw invalidResponse(response.status);
    }
    try {
      return request.validate(value);
    } catch {
      throw invalidResponse(response.status);
    }
  }

  overview(): Promise<OrganizationAdminOverviewV1> {
    return this.request({
      method: 'GET',
      path: ORGANIZATION_API_ADMIN_OVERVIEW_PATH,
      expected_status: 200,
      validate: validateOrganizationAdminOverview,
    });
  }

  listMemberships(
    page?: OrganizationAdminPageRequest,
  ): Promise<OrganizationMembershipPageV1> {
    return this.request({
      method: 'GET',
      path: `${ORGANIZATION_API_ADMIN_MEMBERSHIPS_PATH}${pageQuery(page)}`,
      expected_status: 200,
      validate: validateOrganizationMembershipPage,
    });
  }

  listInstallations(
    page?: OrganizationAdminPageRequest,
  ): Promise<OrganizationInstallationPageV1> {
    return this.request({
      method: 'GET',
      path: `${ORGANIZATION_API_ADMIN_INSTALLATIONS_PATH}${pageQuery(page)}`,
      expected_status: 200,
      validate: validateOrganizationInstallationPage,
    });
  }

  listEnrollmentGrants(
    page?: OrganizationAdminPageRequest,
  ): Promise<OrganizationEnrollmentGrantPageV1> {
    return this.request({
      method: 'GET',
      path: `${ORGANIZATION_API_ADMIN_ENROLLMENT_GRANTS_PATH}${pageQuery(page)}`,
      expected_status: 200,
      validate: validateOrganizationEnrollmentGrantPage,
    });
  }

  listAudit(
    page?: OrganizationAdminPageRequest,
  ): Promise<OrganizationAuditPageV1> {
    return this.request({
      method: 'GET',
      path: `${ORGANIZATION_API_ADMIN_AUDIT_PATH}${pageQuery(page)}`,
      expected_status: 200,
      validate: validateOrganizationAuditPage,
    });
  }

  provisionMembership(
    input: ProvisionOrganizationMembershipRequestV1,
  ): Promise<ProvisionedOrganizationMembershipV1> {
    const body = validateProvisionOrganizationMembershipRequest(input);
    return this.request({
      method: 'POST',
      path: ORGANIZATION_API_ADMIN_MEMBERSHIPS_PATH,
      expected_status: 201,
      body,
      validate: validateProvisionedOrganizationMembership,
    });
  }

  registerEnrollmentGrant(
    membershipId: string,
    input: IssueOrganizationEnrollmentGrantRequestV1,
  ): Promise<IssuedOrganizationEnrollmentGrantV1> {
    const membership = validateSubjectId(
      membershipId,
      MEMBERSHIP_ID_PATTERN,
      'membership_id',
    );
    const body = validateIssueOrganizationEnrollmentGrantRequest(input);
    return this.request({
      method: 'POST',
      path: organizationApiMembershipEnrollmentGrantsPath(membership),
      expected_status: 201,
      body,
      validate: validateIssuedOrganizationEnrollmentGrant,
    });
  }

  revokeMembership(
    membershipId: string,
    input: RevokeOrganizationSubjectRequestV1,
  ): Promise<RevokedOrganizationMembershipV1> {
    const membership = validateSubjectId(
      membershipId,
      MEMBERSHIP_ID_PATTERN,
      'membership_id',
    );
    const body = validateRevokeOrganizationSubjectRequest(input);
    return this.request({
      method: 'POST',
      path: organizationApiMembershipRevocationsPath(membership),
      expected_status: 200,
      body,
      validate: validateRevokedOrganizationMembership,
    });
  }

  revokeInstallation(
    installationId: string,
    input: RevokeOrganizationSubjectRequestV1,
  ): Promise<RevokedOrganizationInstallationV1> {
    const installation = validateSubjectId(
      installationId,
      INSTALLATION_ID_PATTERN,
      'installation_id',
    );
    const body = validateRevokeOrganizationSubjectRequest(input);
    return this.request({
      method: 'POST',
      path: organizationApiInstallationRevocationsPath(installation),
      expected_status: 200,
      body,
      validate: validateRevokedOrganizationInstallation,
    });
  }
}
