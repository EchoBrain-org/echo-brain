import { canonicalJson } from '@echo-brain/federation-protocol';
import { validatePersonUpdateSubmitV1, validatePersonUpdateRequestId, validatePersonUploadContextId, validatePersonUploadSearchV1, type PersonUpdateReceiptV1, type PersonUpdateStatusV1, type PersonUpdateSubmitV1, type PersonUploadContentV1, type PersonUploadSearchV1, type PersonUploadSearchResultV1 } from '@echo-brain/organization-api';
import type { AuthorityPersonMembershipBinding } from '@echo-brain/organization-authority-kernel/application/ports/authority-repository';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';

export interface PersonUpdateInboxV1 {
  submit(actor: AuthorityPersonMembershipBinding, request: PersonUpdateSubmitV1): PersonUpdateReceiptV1;
  status(actor: AuthorityPersonMembershipBinding, requestId: string): PersonUpdateStatusV1;
  content(actor: AuthorityPersonMembershipBinding, contextId: string): PersonUploadContentV1;
  search(actor: AuthorityPersonMembershipBinding, request: PersonUploadSearchV1): PersonUploadSearchResultV1;
  auditRead(actor: PersonAccessAuthorization, mode: 'content' | 'search', response: PersonUploadContentV1 | PersonUploadSearchResultV1): void;
}
function authorizationIdentity(value: PersonAccessAuthorization): string {
  const { checked_at: _checkedAt, ...identity } = value;
  return canonicalJson(identity);
}
export class PersonUpdatesApplicationV1 {
  constructor(private readonly authenticate: (accessToken: string) => PersonAccessAuthorization, private readonly inbox: PersonUpdateInboxV1) {}
  submit(accessToken: string, body: unknown): PersonUpdateReceiptV1 {
    const actor = this.authenticate(accessToken);
    let request: PersonUpdateSubmitV1;
    try { request = validatePersonUpdateSubmitV1(body); }
    catch { throw new AuthorityOperationError('invalid_request', 'request failed'); }
    return this.inbox.submit(actor, request);
  }
  status(accessToken: string, requestId: string): PersonUpdateStatusV1 {
    const actor = this.authenticate(accessToken);
    try { validatePersonUpdateRequestId(requestId); }
    catch { throw new AuthorityOperationError('not_found', 'request failed'); }
    return this.inbox.status(actor, requestId);
  }
  content(accessToken: string, contextId: string): PersonUploadContentV1 {
    const actor = this.authenticate(accessToken);
    try { validatePersonUploadContextId(contextId); }
    catch { throw new AuthorityOperationError('not_found', 'request failed'); }
    return this.release(accessToken, actor, 'content', this.inbox.content(actor, contextId));
  }
  search(accessToken: string, body: unknown): PersonUploadSearchResultV1 {
    const actor = this.authenticate(accessToken);
    let request: PersonUploadSearchV1;
    try { request = validatePersonUploadSearchV1(body); }
    catch { throw new AuthorityOperationError('invalid_request', 'request failed'); }
    return this.release(accessToken, actor, 'search', this.inbox.search(actor, request));
  }
  private release<T extends PersonUploadContentV1 | PersonUploadSearchResultV1>(accessToken: string, admitted: PersonAccessAuthorization, mode: 'content' | 'search', response: T): T {
    const current = this.authenticate(accessToken);
    if (authorizationIdentity(current) !== authorizationIdentity(admitted)) throw new AuthorityOperationError('unauthorized', 'request failed');
    // The source and selected visibility are immutable. Current authorization is
    // checked again, and the exact content-free release witness commits before returning.
    this.inbox.auditRead(current, mode, response);
    return response;
  }
}
