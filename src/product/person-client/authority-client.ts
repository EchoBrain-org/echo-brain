import { Buffer } from 'node:buffer';
import { canonicalJson } from '@echo-brain/federation-protocol';
import {
  MAX_ORGANIZATION_API_BODY_BYTES,
  MAX_ORGANIZATION_READABLE_SEARCH_RESPONSE_BYTES,
  MAX_ORGANIZATION_RECENT_DECISIONS_RESPONSE_BYTES,
  MAX_ORGANIZATION_REVIEWER_RECENT_DECISIONS_RESPONSE_BYTES,
  ORGANIZATION_API_PERSON_MEMBER_EXCLUSIONS_PATH,
  ORGANIZATION_API_PERSON_MEMBER_EXCLUSION_LIST_PATH,
  ORGANIZATION_API_AUTHORITY_DESCRIPTOR_PATH,
  ORGANIZATION_API_PERSON_OIDC_BEGIN_PATH,
  ORGANIZATION_API_PERSON_READABLE_SEARCH_PATH,
  ORGANIZATION_API_PERSON_RECENT_DECISIONS_PATH,
  ORGANIZATION_API_PERSON_REVIEWER_RECENT_DECISIONS_PATH,
  ORGANIZATION_API_PERSON_SESSION_REFRESH_PATH,
  ORGANIZATION_API_PERSON_SESSION_REVOCATIONS_PATH,
  ORGANIZATION_API_PERSON_SLACK_LINK_CHALLENGES_PATH,
  ORGANIZATION_API_PERSON_SLACK_LINK_COMPLETIONS_PATH,
  isOrganizationApiValidationError,
  validateOrganizationApiError,
  validateOrganizationAuthorityDescriptorResponse,
  validateOrganizationPersonMemberExclusionChangeRequest,
  validateOrganizationMemberExclusionListResponse,
  validateOrganizationPersonMemberExclusionListRequest,
  validateOrganizationPersonOidcBeginRequest,
  validateOrganizationPersonOidcBeginResponse,
  validateOrganizationPersonReadableSearchRequest,
  validateOrganizationPersonRecentDecisionsRequest,
  validateOrganizationPersonReviewerRecentDecisionsRequest,
  validateOrganizationPersonSession,
  validateOrganizationPersonSessionRefreshRequest,
  validateOrganizationPersonSlackLinkBeginRequest,
  validateOrganizationPersonSlackLinkBeginResponse,
  validateOrganizationPersonSlackLinkCompleteRequest,
  validateOrganizationPersonSlackLinkResult,
  validateOrganizationReadableSearchResponse,
  validateOrganizationRecentDecisionsResponse,
  validateOrganizationReviewerRecentDecisionsResponse,
  type OrganizationPersonMemberExclusionChangeRequestV2,
  type OrganizationMemberExclusionListResponseV2,
  type OrganizationPersonMemberExclusionListRequestV2,
  type OrganizationAuthorityDescriptorResponseV1,
  type OrganizationPersonOidcBeginRequestV2,
  type OrganizationPersonOidcBeginResponseV2,
  type OrganizationPersonReadableSearchRequestV2,
  type OrganizationPersonRecentDecisionsRequestV2,
  type OrganizationPersonReviewerRecentDecisionsRequestV2,
  type OrganizationPersonSessionV2,
  type OrganizationPersonSlackLinkBeginRequestV2,
  type OrganizationPersonSlackLinkBeginResponseV2,
  type OrganizationPersonSlackLinkCompleteRequestV2,
  type OrganizationPersonSlackLinkResultV2,
  type OrganizationReadableSearchResponseV1,
  type OrganizationRecentDecisionsResponseV1,
  type OrganizationReviewerRecentDecisionsResponseV1,
} from '@echo-brain/organization-api';

const DEFAULT_TIMEOUT_MS = 15_000;
const SLACK_TIMEOUT_MS = 75_000;
const MAXIMUM_ORDINARY_RESPONSE_BYTES = 64 * 1024;

export class PersonAuthorityClientError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'PersonAuthorityClientError';
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
    throw new Error('Person Authority origin is invalid');
  }
  const loopback =
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]';
  if (
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    (url.pathname !== '' && url.pathname !== '/') ||
    (url.protocol !== 'https:' &&
      !(allowInsecureLoopback && url.protocol === 'http:' && loopback))
  ) {
    throw new Error('Person Authority must be one HTTPS origin');
  }
  url.pathname = '/';
  return url;
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  if (response.body === null) return '';
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
          'response_too_large',
          response.status,
          'Person Authority response exceeded its bound',
        );
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new PersonAuthorityClientError(
      'invalid_response',
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
      'invalid_response',
      status,
      'Person Authority returned invalid JSON',
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
      'invalid_response',
      status,
      'Person Authority returned a malformed response',
    );
  }
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
      throw new Error('Person Authority timeout must be positive');
    }
  }

  private async send(
    path: string,
    init: Omit<RequestInit, 'redirect' | 'signal'>,
    timeoutMs = this.timeoutMs,
  ): Promise<Response> {
    try {
      return await this.fetchImpl(new URL(path, this.origin), {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new PersonAuthorityClientError(
        'transport_failed',
        null,
        'Person Authority request failed',
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
  }): Promise<T> {
    const request = input.validate_request(input.body);
    const body = canonicalJson(request);
    if (Buffer.byteLength(body) > MAX_ORGANIZATION_API_BODY_BYTES) {
      throw new Error('Person Authority request exceeds its body bound');
    }
    const response = await this.send(
      input.path,
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          ...(input.access_token === undefined
            ? {}
            : { authorization: `Bearer ${input.access_token}` }),
        },
        body,
      },
      input.timeout_ms,
    );
    const contentType = response.headers.get('content-type');
    if (
      contentType === null ||
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)
    ) {
      throw new PersonAuthorityClientError(
        'invalid_response',
        response.status,
        'Person Authority returned a non-JSON response',
      );
    }
    const text = await readBoundedBody(
      response,
      input.maximum_response_bytes ?? MAXIMUM_ORDINARY_RESPONSE_BYTES,
    );
    const value = parsedJson(text, response.status);
    if (!response.ok) {
      let code = 'request_failed';
      try {
        code = validateOrganizationApiError(value).error.code;
      } catch {
        throw new PersonAuthorityClientError(
          'invalid_response',
          response.status,
          'Person Authority returned a malformed error',
        );
      }
      throw new PersonAuthorityClientError(
        code,
        response.status,
        'Person Authority rejected the request',
      );
    }
    if (input.require_canonical_response === true && canonicalJson(value) !== text) {
      throw new PersonAuthorityClientError(
        'invalid_response',
        response.status,
        'Person Authority returned noncanonical response bytes',
      );
    }
    return validateSuccess(value, response.status, input.validate_response);
  }

  async descriptor(): Promise<OrganizationAuthorityDescriptorResponseV1> {
    const response = await this.send(ORGANIZATION_API_AUTHORITY_DESCRIPTOR_PATH, {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    const contentType = response.headers.get('content-type');
    if (
      contentType === null ||
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)
    ) {
      throw new PersonAuthorityClientError(
        'invalid_response',
        response.status,
        'Person Authority returned a non-JSON descriptor',
      );
    }
    const value = parsedJson(
      await readBoundedBody(response, MAXIMUM_ORDINARY_RESPONSE_BYTES),
      response.status,
    );
    if (!response.ok) {
      throw new PersonAuthorityClientError(
        'request_failed',
        response.status,
        'Person Authority rejected the descriptor request',
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
  }): Promise<void> {
    const request = input.validate_request(input.body);
    const body = canonicalJson(request);
    if (Buffer.byteLength(body) > MAX_ORGANIZATION_API_BODY_BYTES) {
      throw new Error('Person Authority request exceeds its body bound');
    }
    const response = await this.send(input.path, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${input.access_token}`,
        'content-type': 'application/json',
      },
      body,
    });
    const text = await readBoundedBody(response, MAXIMUM_ORDINARY_RESPONSE_BYTES);
    if (response.status === 204 && text === '') return;
    if (!response.ok) {
      const value = parsedJson(text, response.status);
      try {
        const error = validateOrganizationApiError(value);
        throw new PersonAuthorityClientError(
          error.error.code,
          response.status,
          'Person Authority rejected the request',
        );
      } catch (error) {
        if (error instanceof PersonAuthorityClientError) throw error;
      }
    }
    throw new PersonAuthorityClientError(
      'invalid_response',
      response.status,
      'Person Authority returned an invalid no-content response',
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
          typeof value !== 'object' ||
          Array.isArray(value) ||
          Object.keys(value).length !== 0
        ) {
          throw new Error('Person logout request must be empty');
        }
        return value;
      },
      access_token: accessToken,
    });
  }

  recentDecisions(
    request: OrganizationPersonRecentDecisionsRequestV2,
    accessToken: string,
  ): Promise<OrganizationRecentDecisionsResponseV1> {
    return this.json({
      path: ORGANIZATION_API_PERSON_RECENT_DECISIONS_PATH,
      body: request,
      validate_request: validateOrganizationPersonRecentDecisionsRequest,
      validate_response: validateOrganizationRecentDecisionsResponse,
      access_token: accessToken,
      maximum_response_bytes: MAX_ORGANIZATION_RECENT_DECISIONS_RESPONSE_BYTES,
      require_canonical_response: true,
    });
  }

  reviewerRecentDecisions(
    request: OrganizationPersonReviewerRecentDecisionsRequestV2,
    accessToken: string,
  ): Promise<OrganizationReviewerRecentDecisionsResponseV1> {
    return this.json({
      path: ORGANIZATION_API_PERSON_REVIEWER_RECENT_DECISIONS_PATH,
      body: request,
      validate_request: validateOrganizationPersonReviewerRecentDecisionsRequest,
      validate_response: validateOrganizationReviewerRecentDecisionsResponse,
      access_token: accessToken,
      maximum_response_bytes:
        MAX_ORGANIZATION_REVIEWER_RECENT_DECISIONS_RESPONSE_BYTES,
      require_canonical_response: true,
    });
  }

  readableSearch(
    request: OrganizationPersonReadableSearchRequestV2,
    accessToken: string,
  ): Promise<OrganizationReadableSearchResponseV1> {
    return this.json({
      path: ORGANIZATION_API_PERSON_READABLE_SEARCH_PATH,
      body: request,
      validate_request: validateOrganizationPersonReadableSearchRequest,
      validate_response: validateOrganizationReadableSearchResponse,
      access_token: accessToken,
      maximum_response_bytes: MAX_ORGANIZATION_READABLE_SEARCH_RESPONSE_BYTES,
      require_canonical_response: true,
    });
  }

  changeExclusion(
    request: OrganizationPersonMemberExclusionChangeRequestV2,
    accessToken: string,
  ): Promise<void> {
    return this.noContent({
      path: ORGANIZATION_API_PERSON_MEMBER_EXCLUSIONS_PATH,
      body: request,
      validate_request: validateOrganizationPersonMemberExclusionChangeRequest,
      access_token: accessToken,
    });
  }

  exclusions(
    request: OrganizationPersonMemberExclusionListRequestV2,
    accessToken: string,
  ): Promise<OrganizationMemberExclusionListResponseV2> {
    return this.json({
      path: ORGANIZATION_API_PERSON_MEMBER_EXCLUSION_LIST_PATH,
      body: request,
      validate_request: validateOrganizationPersonMemberExclusionListRequest,
      validate_response: validateOrganizationMemberExclusionListResponse,
      access_token: accessToken,
      require_canonical_response: true,
    });
  }

  beginSlackLink(
    request: OrganizationPersonSlackLinkBeginRequestV2,
    accessToken: string,
  ): Promise<OrganizationPersonSlackLinkBeginResponseV2> {
    return this.json({
      path: ORGANIZATION_API_PERSON_SLACK_LINK_CHALLENGES_PATH,
      body: request,
      validate_request: validateOrganizationPersonSlackLinkBeginRequest,
      validate_response: validateOrganizationPersonSlackLinkBeginResponse,
      access_token: accessToken,
      timeout_ms: Math.max(this.timeoutMs, SLACK_TIMEOUT_MS),
    });
  }

  completeSlackLink(
    request: OrganizationPersonSlackLinkCompleteRequestV2,
    accessToken: string,
  ): Promise<OrganizationPersonSlackLinkResultV2> {
    return this.json({
      path: ORGANIZATION_API_PERSON_SLACK_LINK_COMPLETIONS_PATH,
      body: request,
      validate_request: validateOrganizationPersonSlackLinkCompleteRequest,
      validate_response: validateOrganizationPersonSlackLinkResult,
      access_token: accessToken,
      timeout_ms: Math.max(this.timeoutMs, SLACK_TIMEOUT_MS),
    });
  }
}
