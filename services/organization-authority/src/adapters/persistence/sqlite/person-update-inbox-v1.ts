import type Database from 'better-sqlite3';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { validatePersonUpdateSubmitV1, validatePersonUpdateReceiptV1, validatePersonUpdateStatusV1, type PersonUpdateSubmitV1, type PersonUpdateReceiptV1, type PersonUpdateStatusV1, type PersonUpdateProgressV1 } from '@echo-brain/organization-api';
import type { AuthorityPersonMembershipBinding } from '@echo-brain/organization-authority-kernel/application/ports/authority-repository';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';

export const PERSON_UPDATE_MEMBERSHIP_PENDING_LIMIT = 100;
export const PERSON_UPDATE_ORGANIZATION_PENDING_LIMIT = 1000;
export interface StoredPersonUpdateV1 extends AuthorityPersonMembershipBinding {
  readonly request_id: string;
  readonly payload_sha256: string;
  readonly title: string;
  readonly text: string;
  readonly received_at: string;
  readonly state: PersonUpdateStatusV1['status'];
  readonly reason: string | null;
  readonly outcome: string | null;
  readonly attempts: number;
  readonly candidate_id: string | null;
}

/** Durable pending custody. All admission/capacity decisions linearize in SQLite. */
export class SqlitePersonUpdateInboxV1 {
  constructor(readonly database: Database.Database, private readonly now: () => string = () => new Date().toISOString()) {
    if (database.pragma('user_version', { simple: true }) !== 6) throw new Error('Person updates require Authority V6; use the explicit offline V5-to-V6 transition');
  }

  isActive(actor: AuthorityPersonMembershipBinding): boolean {
    return this.database.prepare(`SELECT 1 FROM authority_memberships WHERE organization_id = ? AND principal_id = ? AND membership_id = ? AND membership_type = ? AND status = 'active'`)
      .get(actor.organization_id, actor.principal_id, actor.membership_id, actor.membership_type) !== undefined;
  }

  submit(actor: AuthorityPersonMembershipBinding, value: PersonUpdateSubmitV1): PersonUpdateReceiptV1 {
    const request = validatePersonUpdateSubmitV1(value);
    return this.database.transaction(() => {
      if (!this.isActive(actor)) throw new AuthorityOperationError('unauthorized', 'request failed');
      const digest = canonicalSha256(request);
      const existing = this.read(actor, request.request_id);
      if (existing !== undefined) {
        if (existing.payload_sha256 !== digest) throw new AuthorityOperationError('conflict', 'request failed');
        return this.receipt(existing);
      }
      const count = this.database.prepare(`SELECT count(*) AS organization_count, coalesce(sum(membership_id = ?), 0) AS membership_count FROM authority_person_update_work_v1 WHERE organization_id = ? AND state NOT IN ('resolved', 'no_signals', 'failed')`)
        .get(actor.membership_id, actor.organization_id) as { organization_count: number; membership_count: number };
      if (count.organization_count >= PERSON_UPDATE_ORGANIZATION_PENDING_LIMIT || count.membership_count >= PERSON_UPDATE_MEMBERSHIP_PENDING_LIMIT) throw new AuthorityOperationError('rate_limited', 'request failed');
      const receivedAt = this.now();
      const receipt = validatePersonUpdateReceiptV1({ schema_version: 1, kind: 'echo-person-update-receipt-v1', request_id: request.request_id, received_at: receivedAt, state: 'received' });
      this.database.prepare(`INSERT INTO authority_person_updates_v1 (organization_id, principal_id, membership_id, membership_type, request_id, payload_sha256, title, text, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(actor.organization_id, actor.principal_id, actor.membership_id, actor.membership_type, request.request_id, digest, request.title, request.text, receivedAt);
      this.database.prepare(`INSERT INTO authority_person_update_work_v1 (organization_id, membership_id, request_id, state, retry_at) VALUES (?, ?, ?, 'received', ?)`)
        .run(actor.organization_id, actor.membership_id, request.request_id, receivedAt);
      return receipt;
    }).immediate();
  }

  status(actor: AuthorityPersonMembershipBinding, requestId: string): PersonUpdateStatusV1 {
    if (!this.isActive(actor)) throw new AuthorityOperationError('unauthorized', 'request failed');
    const row = this.read(actor, requestId);
    if (row === undefined) throw new AuthorityOperationError('not_found', 'request failed');
    return validatePersonUpdateStatusV1({ schema_version: 1, kind: 'echo-person-update-status-v1', request_id: row.request_id, received_at: row.received_at, status: row.state,
      ...(row.state === 'resolved' ? { outcome: row.outcome } : {}),
      ...(row.state === 'blocked' || row.state === 'failed' ? { reason: row.reason } : {}),
    });
  }

  read(actor: Pick<AuthorityPersonMembershipBinding, 'organization_id' | 'membership_id'>, requestId: string): StoredPersonUpdateV1 | undefined {
    return this.database.prepare(`SELECT submission.*, work.state, work.reason, work.outcome, work.attempts, work.candidate_id FROM authority_person_updates_v1 AS submission JOIN authority_person_update_work_v1 AS work USING (organization_id, membership_id, request_id) WHERE organization_id = ? AND membership_id = ? AND request_id = ?`)
      .get(actor.organization_id, actor.membership_id, requestId) as StoredPersonUpdateV1 | undefined;
  }

  /** Only the exclusive worker calls this; interrupted claims are immediately reclaimable. */
  claim(): StoredPersonUpdateV1 | undefined {
    return this.database.transaction(() => {
      const row = this.database.prepare(`SELECT submission.*, work.state, work.reason, work.outcome, work.attempts, work.candidate_id FROM authority_person_updates_v1 AS submission JOIN authority_person_update_work_v1 AS work USING (organization_id, membership_id, request_id) WHERE work.state IN ('received', 'processing', 'blocked') AND work.retry_at <= ? ORDER BY work.retry_at, submission.received_at, submission.membership_id, submission.request_id LIMIT 1`)
        .get(this.now()) as StoredPersonUpdateV1 | undefined;
      if (row === undefined) return undefined;
      this.update(row, { status: 'processing' });
      return row;
    }).immediate();
  }

  awaiting(): readonly StoredPersonUpdateV1[] {
    return this.database.prepare(`SELECT submission.*, work.state, work.reason, work.outcome, work.attempts, work.candidate_id FROM authority_person_updates_v1 AS submission JOIN authority_person_update_work_v1 AS work USING (organization_id, membership_id, request_id) WHERE work.state = 'awaiting_approval' ORDER BY submission.received_at LIMIT 1000`).all() as StoredPersonUpdateV1[];
  }

  validate(row: StoredPersonUpdateV1): PersonUpdateSubmitV1 {
    const request = validatePersonUpdateSubmitV1({ schema_version: 1, kind: 'echo-person-update-submit-v1', request_id: row.request_id, title: row.title, text: row.text });
    if (canonicalSha256(request) !== row.payload_sha256) throw new Error('Person update payload integrity failure');
    this.receipt(row);
    return request;
  }

  update(row: StoredPersonUpdateV1, progress: PersonUpdateProgressV1, candidateId?: string): void {
    const retryAt = progress.status === 'blocked'
      ? new Date(Date.parse(this.now()) + Math.min(300_000, 1000 * 2 ** Math.min(row.attempts, 8))).toISOString() : this.now();
    const result = this.database.prepare(`UPDATE authority_person_update_work_v1 SET state = ?, reason = ?, outcome = ?, candidate_id = coalesce(candidate_id, ?), attempts = attempts + ?, retry_at = ? WHERE organization_id = ? AND membership_id = ? AND request_id = ?`)
      .run(progress.status, 'reason' in progress ? progress.reason : null, 'outcome' in progress ? progress.outcome : null, candidateId ?? null, progress.status === 'blocked' ? 1 : 0, retryAt, row.organization_id, row.membership_id, row.request_id);
    if (result.changes !== 1) throw new Error('Person update work disappeared');
  }

  private receipt(row: StoredPersonUpdateV1): PersonUpdateReceiptV1 {
    return validatePersonUpdateReceiptV1({ schema_version: 1, kind: 'echo-person-update-receipt-v1', request_id: row.request_id, received_at: row.received_at, state: 'received' });
  }
}
