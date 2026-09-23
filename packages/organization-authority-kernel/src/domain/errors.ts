export type AuthorityErrorCode =
  | 'conflict'
  | 'invalid_request'
  | 'invalid_output'
  | 'not_found'
  | 'stale_access_state'
  | 'unauthorized'
  | 'rate_limited'
  | 'quota_exceeded'
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
