import type { OrganizationInstallationAccessStateV1 } from '@echo-brain/organization-protocol';

export type AuthorityErrorCode =
  | 'conflict'
  | 'invalid_request'
  | 'not_found'
  | 'stale_access_state'
  | 'unauthorized'
  | 'unavailable';

export class AuthorityOperationError extends Error {
  constructor(
    readonly code: AuthorityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AuthorityOperationError';
  }
}

export class StaleAccessStateError extends AuthorityOperationError {
  constructor(readonly currentState: OrganizationInstallationAccessStateV1) {
    super(
      'stale_access_state',
      'the access lease request does not name the current access state',
    );
    this.name = 'StaleAccessStateError';
  }
}
