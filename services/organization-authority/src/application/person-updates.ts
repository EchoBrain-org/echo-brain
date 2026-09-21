import { validatePersonUpdateSubmitV1, validatePersonUpdateRequestId, type PersonUpdateReceiptV1, type PersonUpdateStatusV1, type PersonUpdateSubmitV1 } from '@echo-brain/organization-api';
import type { AuthorityPersonMembershipBinding } from '@echo-brain/organization-authority-kernel/application/ports/authority-repository';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';

export interface PersonUpdateInboxV1 {
  submit(actor: AuthorityPersonMembershipBinding, request: PersonUpdateSubmitV1): PersonUpdateReceiptV1;
  status(actor: AuthorityPersonMembershipBinding, requestId: string): PersonUpdateStatusV1;
}

export class PersonUpdatesApplicationV1 {
  constructor(private readonly authenticate: (accessToken: string) => AuthorityPersonMembershipBinding, private readonly inbox: PersonUpdateInboxV1) {}
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
}
