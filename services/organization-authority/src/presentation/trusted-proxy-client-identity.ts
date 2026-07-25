import { Buffer } from 'node:buffer';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  ORGANIZATION_API_PROXY_AUTH_SCHEME,
  TRUSTED_PROXY_AUTHORIZATION_HEADER,
  TRUSTED_PROXY_CLIENT_ID_HEADER,
} from '@echo-brain/organization-api';

const PROXY_AUTHORIZATION_PREFIX = `${ORGANIZATION_API_PROXY_AUTH_SCHEME} `;
const VISIBLE_PROXY_TOKEN_PATTERN = /^[\x21-\x7e]{32,4096}$/;

export class TrustedProxyIdentityError extends Error {
  constructor() {
    super('trusted proxy identity is unavailable');
    this.name = 'TrustedProxyIdentityError';
  }
}

export {
  TRUSTED_PROXY_AUTHORIZATION_HEADER,
  TRUSTED_PROXY_CLIENT_ID_HEADER,
};

export interface RawHeaderRequest {
  readonly rawHeaders: readonly string[];
}

export interface RequestClientIdentityResolver {
  /** Returns one stable, non-secret key suitable for a bounded rate-limit map. */
  resolve(request: RawHeaderRequest): string;
}

function uniqueRawHeader(
  request: RawHeaderRequest,
  expectedName: string,
): string | undefined {
  let value: string | undefined;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]!.toLowerCase() !== expectedName) continue;
    if (value !== undefined) return undefined;
    value = request.rawHeaders[index + 1];
  }
  return value;
}

/**
 * Authenticates the loopback TLS-terminator hop and accepts only a canonical,
 * privacy-preserving digest of the externally authenticated client identity.
 * The terminator must strip both headers from inbound traffic and set them
 * itself before forwarding to this loopback-only origin.
 */
export class AuthenticatedProxyClientIdentityResolver implements RequestClientIdentityResolver {
  private readonly expectedTokenDigest: Buffer;

  constructor(proxyToken: string) {
    if (
      typeof proxyToken !== 'string' ||
      !VISIBLE_PROXY_TOKEN_PATTERN.test(proxyToken)
    ) {
      throw new Error(
        'trusted proxy token must be 32-4096 visible ASCII bytes',
      );
    }
    this.expectedTokenDigest = createHash('sha256')
      .update(proxyToken, 'utf8')
      .digest();
  }

  resolve(request: RawHeaderRequest): string {
    const authorization = uniqueRawHeader(
      request,
      TRUSTED_PROXY_AUTHORIZATION_HEADER,
    );
    if (
      authorization === undefined ||
      !authorization.startsWith(PROXY_AUTHORIZATION_PREFIX)
    ) {
      throw new TrustedProxyIdentityError();
    }
    const token = authorization.slice(PROXY_AUTHORIZATION_PREFIX.length);
    if (!VISIBLE_PROXY_TOKEN_PATTERN.test(token)) {
      throw new TrustedProxyIdentityError();
    }
    const actualTokenDigest = createHash('sha256')
      .update(token, 'utf8')
      .digest();
    if (!timingSafeEqual(actualTokenDigest, this.expectedTokenDigest)) {
      throw new TrustedProxyIdentityError();
    }

    const clientId = uniqueRawHeader(request, TRUSTED_PROXY_CLIENT_ID_HEADER);
    const clientMatch = /^cid_([A-Za-z0-9_-]{43})$/.exec(clientId ?? '');
    if (clientMatch === null) throw new TrustedProxyIdentityError();
    const digest = Buffer.from(clientMatch[1]!, 'base64url');
    if (
      digest.length !== 32 ||
      digest.toString('base64url') !== clientMatch[1]
    ) {
      throw new TrustedProxyIdentityError();
    }
    return clientId!;
  }
}
