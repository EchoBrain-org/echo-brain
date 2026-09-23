import type Database from 'better-sqlite3';
import { canonicalSha256, type Sha256Digest } from '@echo-brain/federation-protocol';
import { validatePersonUpdateReceiptV2, validatePersonUpdateSubmitV2, type PersonUpdateSubmitV2 } from '@echo-brain/organization-api';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { PersonUpdateEnrichmentWorkItemV2, PersonUpdateEnrichmentWorkV2 } from '../../../application/ports/person-update-enrichment-work-v2.js';
import type { ProjectUploadEnrichmentAuthorizationV1, ProjectUploadEnrichmentSnapshotV1 } from '../../../application/ports/project-context-v1.js';

const SELECT = `SELECT submission.organization_id, submission.principal_id, submission.membership_id, submission.membership_type,
  submission.context_id, submission.request_id, submission.payload_sha256, submission.title, submission.text,
  submission.audience_kind, submission.audience_project_id, submission.project_id, submission.received_at,
  work.state, work.search_hints, work.enrichment_sha256, work.attempts
  FROM authority_person_updates_v2 AS submission JOIN authority_person_update_work_v2 AS work USING (context_id)`;

function sourceContextId(item: PersonUpdateEnrichmentWorkItemV2): string {
  return `ctx_${canonicalSha256({
    schema_version: 2,
    kind: 'echo-person-update-source-v2',
    organization_id: item.organization_id,
    membership_id: item.membership_id,
    request_id: item.request_id,
  }).slice(7)}`;
}

function audience(item: PersonUpdateEnrichmentWorkItemV2) {
  return item.audience_kind === 'project'
    ? { kind: 'project' as const, project_id: item.audience_project_id }
    : { kind: item.audience_kind };
}
function hasEligibilityBinding(item: PersonUpdateEnrichmentWorkItemV2, eligibility: ProjectUploadEnrichmentSnapshotV1): boolean {
  const uploader = eligibility.uploader;
  return eligibility.context_id === item.context_id &&
    uploader.organization_id === item.organization_id &&
    uploader.principal_id === item.principal_id &&
    uploader.membership_id === item.membership_id &&
    uploader.membership_type === item.membership_type;
}
function denied(): never { throw new AuthorityOperationError('unauthorized', 'request failed'); }

/** SQLite bridge for V7's existing V2 work rows. It schedules nothing itself. */
export class SqlitePersonUpdateEnrichmentWorkV2 implements PersonUpdateEnrichmentWorkV2 {
  constructor(
    private readonly database: Database.Database,
    private readonly authorization: ProjectUploadEnrichmentAuthorizationV1,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    if (![7, 8].includes(database.pragma('user_version', { simple: true }) as number) || database.pragma('foreign_keys', { simple: true }) !== 1) {
      throw new Error('V2 Person upload enrichment requires fresh Authority V7 state with foreign keys enabled');
    }
  }

  claim(): PersonUpdateEnrichmentWorkItemV2 | undefined {
    return this.database.transaction(() => {
      const item = this.database.prepare(`${SELECT} WHERE work.state IN ('pending', 'processing') AND work.retry_at <= ? ORDER BY work.retry_at, submission.context_id LIMIT 1`)
        .get(this.now()) as PersonUpdateEnrichmentWorkItemV2 | undefined;
      if (item === undefined) return undefined;
      const result = this.database.prepare("UPDATE authority_person_update_work_v2 SET state = 'processing' WHERE context_id = ?").run(item.context_id);
      if (result.changes !== 1) throw new Error('V2 Person upload work disappeared');
      return item;
    }).immediate();
  }

  validate(item: PersonUpdateEnrichmentWorkItemV2): PersonUpdateSubmitV2 {
    const request = validatePersonUpdateSubmitV2({
      schema_version: 2,
      kind: 'echo-person-update-submit-v2',
      request_id: item.request_id,
      title: item.title,
      text: item.text,
      project_id: item.project_id,
      audience: audience(item),
    });
    if (canonicalSha256(request) !== item.payload_sha256 || sourceContextId(item) !== item.context_id) throw new Error('V2 Person upload payload integrity failure');
    validatePersonUpdateReceiptV2({
      schema_version: 2,
      kind: 'echo-person-update-receipt-v2',
      request_id: item.request_id,
      context_id: item.context_id,
      received_at: item.received_at,
      project_id: item.project_id,
      audience: audience(item),
      state: 'received',
    });
    return request;
  }

  captureEligibility(item: PersonUpdateEnrichmentWorkItemV2): ProjectUploadEnrichmentSnapshotV1 | undefined {
    const snapshot = this.authorization.capture(item.context_id);
    return snapshot !== undefined && hasEligibilityBinding(item, snapshot) ? snapshot : undefined;
  }

  enriched(item: PersonUpdateEnrichmentWorkItemV2, eligibility: ProjectUploadEnrichmentSnapshotV1, searchHints: string, release: Sha256Digest): void {
    this.database.transaction(() => {
      const current = this.database.prepare(`${SELECT} WHERE submission.context_id = ?`).get(item.context_id) as PersonUpdateEnrichmentWorkItemV2 | undefined;
      if (current === undefined || current.payload_sha256 !== item.payload_sha256 || current.state !== 'processing') throw new Error('V2 Person upload changed during enrichment');
      this.validate(current);
      if (!hasEligibilityBinding(current, eligibility)) denied();
      // Capture and final authorization check share the same custody DB
      // transaction as hint persistence, so revocation cannot race completion.
      this.authorization.assertCurrent(eligibility);
      const result = this.database.prepare("UPDATE authority_person_update_work_v2 SET state = 'ready', search_hints = ?, enrichment_sha256 = ? WHERE context_id = ? AND state = 'processing'")
        .run(searchHints, release, current.context_id);
      if (result.changes !== 1) throw new Error('V2 Person upload work disappeared');
    }).immediate();
  }

  defer(item: PersonUpdateEnrichmentWorkItemV2, retry = true): void {
    const state = retry && item.attempts < 4 ? 'pending' : 'unavailable';
    const retryAt = new Date(Date.parse(this.now()) + 1000 * 2 ** Math.min(item.attempts, 8)).toISOString();
    const result = this.database.prepare("UPDATE authority_person_update_work_v2 SET state = ?, attempts = attempts + 1, retry_at = ? WHERE context_id = ? AND state = 'processing'")
      .run(state, retryAt, item.context_id);
    if (result.changes !== 1) throw new Error('V2 Person upload work disappeared');
  }
}
