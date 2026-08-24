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
