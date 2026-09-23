import { assertPersonDocumentCapacityV1 } from './document-quota-v1.js';
import type Database from 'better-sqlite3';
import { assertPersonRequestNamespaceV1 } from './person-request-namespace-v1.js';
import { randomUUID } from 'node:crypto';
import { canonicalJson, canonicalSha256 } from '@echo-brain/federation-protocol';
import { validatePersonUpdateSubmitV1, validatePersonUpdateReceiptV1, validatePersonUpdateStatusV1, validatePersonUploadContentV1, validatePersonUploadSearchResultV1, type PersonUpdateSubmitV1, type PersonUpdateReceiptV1, type PersonUpdateStatusV1, type PersonUploadContentV1, type PersonUploadSearchV1, type PersonUploadSearchResultV1, type PersonUploadVisibilityV1, type PersonUploadMetadataStateV1 } from '@echo-brain/organization-api';
import type { AuthorityPersonMembershipBinding } from '@echo-brain/organization-authority-kernel/application/ports/authority-repository';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';

// V1 bounds the retained corpus as well as per-request memory/CPU. No deletion scheduler is implied.
export const PERSON_UPLOAD_MEMBERSHIP_CAPACITY = 100;
export const PERSON_UPLOAD_ORGANIZATION_CAPACITY = 1000;
export interface StoredPersonUpdateV1 extends AuthorityPersonMembershipBinding {
  readonly request_id: string;
  readonly context_id: string;
  readonly payload_sha256: string;
  readonly title: string;
  readonly text: string;
  readonly visibility: PersonUploadVisibilityV1;
  readonly received_at: string;
  readonly state: PersonUploadMetadataStateV1;
  readonly search_hints: string;
  readonly enrichment_sha256: string | null;
  readonly attempts: number;
}
const SELECT = 'SELECT submission.*, work.state, work.search_hints, work.enrichment_sha256, work.attempts FROM authority_person_updates_v1 AS submission JOIN authority_person_update_work_v1 AS work USING (context_id)';
function contextId(actor: AuthorityPersonMembershipBinding, requestId: string): string {
  return `ctx_${canonicalSha256({ organization_id: actor.organization_id, membership_id: actor.membership_id, request_id: requestId }).slice(7)}`;
}
function normalized(value: string): string { return value.normalize('NFC').toLowerCase(); }

/** Original context and explicit access are authoritative; search hints are replaceable interpretation. */
export class SqlitePersonUpdateInboxV1 {
  constructor(readonly database: Database.Database, private readonly now: () => string = () => new Date().toISOString()) {
    const version = database.pragma('user_version', { simple: true });
    // Fresh V7 retains the V1 custody tables until the V2 server/client cutover.
    // Project-audience rows live separately and can never enter a V1 query.
    if (version !== 6 && version !== 7 && version !== 8) throw new Error('Person uploads require Authority V6 or fresh V7 state');

  }
  isActive(actor: AuthorityPersonMembershipBinding): boolean {
    return this.database.prepare(`SELECT 1 FROM authority_memberships WHERE organization_id = ? AND principal_id = ? AND membership_id = ? AND membership_type = ? AND status = 'active'`)
      .get(actor.organization_id, actor.principal_id, actor.membership_id, actor.membership_type) !== undefined;
  }
  private assertActive(actor: AuthorityPersonMembershipBinding): void {
    if (!this.isActive(actor)) throw new AuthorityOperationError('unauthorized', 'request failed');
  }
  submit(actor: AuthorityPersonMembershipBinding, value: PersonUpdateSubmitV1): PersonUpdateReceiptV1 {
    const request = validatePersonUpdateSubmitV1(value);
    return this.database.transaction(() => {
      this.assertActive(actor);
      assertPersonRequestNamespaceV1(this.database, actor, request.request_id, 'legacy_text');
      const digest = canonicalSha256(request);
      const existing = this.read(actor, request.request_id);
      if (existing !== undefined) {
        this.validate(existing);
        if (existing.payload_sha256 !== digest) throw new AuthorityOperationError('conflict', 'request failed');
        return this.receipt(existing);
      }
      assertPersonDocumentCapacityV1(this.database,actor,Buffer.byteLength(request.text));
      const receivedAt = this.now(); const id = contextId(actor, request.request_id); const visibility = request.visibility!;
      const receipt = validatePersonUpdateReceiptV1({ schema_version: 1, kind: 'echo-person-update-receipt-v1', request_id: request.request_id, context_id: id, visibility, received_at: receivedAt, state: 'received' });
      this.database.prepare(`INSERT INTO authority_person_updates_v1 (organization_id, principal_id, membership_id, membership_type, request_id, context_id, payload_sha256, title, text, visibility, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(actor.organization_id, actor.principal_id, actor.membership_id, actor.membership_type, request.request_id, id, digest, request.title, request.text, visibility, receivedAt);
      this.database.prepare(`INSERT INTO authority_person_update_work_v1 (context_id, state, retry_at) VALUES (?, 'pending', ?)`).run(id, receivedAt);
      return receipt;
    }).immediate();
  }
  status(actor: AuthorityPersonMembershipBinding, requestId: string): PersonUpdateStatusV1 {
    this.assertActive(actor);
    const row = this.read(actor, requestId);
    if (row === undefined) throw new AuthorityOperationError('not_found', 'request failed');
    this.validate(row);
    return validatePersonUpdateStatusV1({ schema_version: 1, kind: 'echo-person-update-status-v1', request_id: row.request_id, context_id: row.context_id, received_at: row.received_at, visibility: row.visibility, status: 'stored', metadata: row.state });
  }
  read(actor: Pick<AuthorityPersonMembershipBinding, 'organization_id' | 'membership_id'>, requestId: string): StoredPersonUpdateV1 | undefined {
    return this.database.prepare(`${SELECT} WHERE organization_id = ? AND membership_id = ? AND request_id = ?`).get(actor.organization_id, actor.membership_id, requestId) as StoredPersonUpdateV1 | undefined;
  }
  content(actor: AuthorityPersonMembershipBinding, id: string): PersonUploadContentV1 {
    this.assertActive(actor);
    const row = this.database.prepare(`${SELECT} WHERE context_id = ? AND organization_id = ? AND (visibility = 'team' OR membership_id = ?)`)
      .get(id, actor.organization_id, actor.membership_id) as StoredPersonUpdateV1 | undefined;
    if (row === undefined) throw new AuthorityOperationError('not_found', 'request failed');
    this.validate(row);
    return validatePersonUploadContentV1({ schema_version: 1, kind: 'echo-person-upload-content-v1', context_id: row.context_id, received_at: row.received_at, visibility: row.visibility, title: row.title, text: row.text });
  }
  search(actor: AuthorityPersonMembershipBinding, input: PersonUploadSearchV1): PersonUploadSearchResultV1 {
    this.assertActive(actor);
    // Apply permissions before interpreting either original content or model hints.
    const rows = this.database.prepare(`${SELECT} WHERE organization_id = ? AND (visibility = 'team' OR membership_id = ?) ORDER BY received_at DESC, context_id LIMIT ?`)
      .all(actor.organization_id, actor.membership_id, PERSON_UPLOAD_ORGANIZATION_CAPACITY) as StoredPersonUpdateV1[];
    const terms = [...new Set(normalized(input.query).match(/[\p{L}\p{N}]+/gu) ?? [])];
    const matches = rows.flatMap(row => {
      this.validate(row);
      const original = normalized(`${row.title}\n${row.text}`);
      const hints = normalized(row.search_hints);
      if (!terms.every(term => original.includes(term) || hints.includes(term))) return [];
      const score = terms.reduce((total, term) => total + (original.includes(term) ? 2 : 1), 0);
      return [{ row, score }];
    }).sort((a, b) => b.score - a.score || b.row.received_at.localeCompare(a.row.received_at) || a.row.context_id.localeCompare(b.row.context_id));
    return validatePersonUploadSearchResultV1({ schema_version: 1, kind: 'echo-person-upload-search-v1', results: matches.slice(0, input.limit ?? 10).map(({ row }) => ({ context_id: row.context_id, received_at: row.received_at, visibility: row.visibility, title: row.title, excerpt: [...row.text.trim()].slice(0, 300).join('') })) });
  }
  auditRead(actor: PersonAccessAuthorization, mode: 'content' | 'search', response: PersonUploadContentV1 | PersonUploadSearchResultV1): void {
    this.assertActive(actor);
    const { checked_at: _checkedAt, ...authorization } = actor;
    const body = { schema_version: 1, kind: 'echo-person-upload-read-audit-v1', audit_id: randomUUID(), organization_id: actor.organization_id, principal_id: actor.principal_id, membership_id: actor.membership_id, session_family_id: actor.session_family_id, mode, result_count: 'results' in response ? response.results.length : 1, authorization_sha256: canonicalSha256(authorization), response_sha256: canonicalSha256(response), checked_at: actor.checked_at };
    this.database.prepare('INSERT INTO authority_person_upload_read_audit_v1 (row_sha256, body_json, recorded_at) VALUES (?, ?, ?)').run(canonicalSha256(body), canonicalJson(body), actor.checked_at);
  }
  claim(): StoredPersonUpdateV1 | undefined {
    return this.database.transaction(() => {
      const row = this.database.prepare(`${SELECT} WHERE work.state IN ('pending', 'processing') AND work.retry_at <= ? ORDER BY work.retry_at, context_id LIMIT 1`).get(this.now()) as StoredPersonUpdateV1 | undefined;
      if (row === undefined) return undefined;
      this.database.prepare(`UPDATE authority_person_update_work_v1 SET state = 'processing' WHERE context_id = ?`).run(row.context_id);
      return row;
    }).immediate();
  }
  validate(row: StoredPersonUpdateV1): PersonUpdateSubmitV1 {
    const request = validatePersonUpdateSubmitV1({ schema_version: 1, kind: 'echo-person-update-submit-v1', request_id: row.request_id, title: row.title, text: row.text, visibility: row.visibility });
    if (canonicalSha256(request) !== row.payload_sha256 || contextId(row, row.request_id) !== row.context_id) throw new Error('Person upload payload integrity failure');
    this.receipt(row);
    return request;
  }
  enriched(row: StoredPersonUpdateV1, hints: string, release: string): void {
    const result = this.database.prepare(`UPDATE authority_person_update_work_v1 SET state = 'ready', search_hints = ?, enrichment_sha256 = ? WHERE context_id = ?`).run(hints, release, row.context_id);
    if (result.changes !== 1) throw new Error('Person upload work disappeared');
  }
  defer(row: StoredPersonUpdateV1, retry = true): void {
    const state = retry && row.attempts < 4 ? 'pending' : 'unavailable';
    const retryAt = new Date(Date.parse(this.now()) + 1000 * 2 ** Math.min(row.attempts, 8)).toISOString();
    const result = this.database.prepare(`UPDATE authority_person_update_work_v1 SET state = ?, attempts = attempts + 1, retry_at = ? WHERE context_id = ?`).run(state, retryAt, row.context_id);
    if (result.changes !== 1) throw new Error('Person upload work disappeared');
  }
  private receipt(row: StoredPersonUpdateV1): PersonUpdateReceiptV1 {
    return validatePersonUpdateReceiptV1({ schema_version: 1, kind: 'echo-person-update-receipt-v1', request_id: row.request_id, context_id: row.context_id, visibility: row.visibility, received_at: row.received_at, state: 'received' });
  }
}
