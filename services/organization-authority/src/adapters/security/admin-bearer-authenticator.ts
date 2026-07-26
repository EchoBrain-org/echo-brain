import { createHash, timingSafeEqual } from 'node:crypto';
import { ORGANIZATION_API_ADMIN_AUTH_SCHEME } from '@echo-brain/organization-api';

const ADMIN_AUTHORIZATION_PREFIX = `${ORGANIZATION_API_ADMIN_AUTH_SCHEME} `;

export class AdminBearerAuthenticator {
  private readonly expectedDigest: Buffer;

  constructor(token: string) {
    if (
      typeof token !== 'string' ||
      token.length < 32 ||
      token.length > 4096 ||
      /[\u0000-\u0020\u007f]/.test(token)
    ) {
      throw new Error(
        'administrator bearer token must be 32-4096 visible bytes',
      );
    }
    this.expectedDigest = createHash('sha256').update(token, 'utf8').digest();
  }

  authenticate(authorizationHeader: string | undefined): boolean {
    if (
      authorizationHeader === undefined ||
      !authorizationHeader.startsWith(ADMIN_AUTHORIZATION_PREFIX)
    ) {
      return false;
    }
    const token = authorizationHeader.slice(ADMIN_AUTHORIZATION_PREFIX.length);
    const actual = createHash('sha256').update(token, 'utf8').digest();
    return timingSafeEqual(actual, this.expectedDigest);
  }
}
