import type Database from 'better-sqlite3';
import {
  assertCaptureAnnotationV1, assertCaptureBindingsV1, assertCaptureContainerScopeV1, resolveCaptureContainerV1, assertCaptureClassificationV1, assertCaptureDeriveSnapshotV1,
  assertCaptureRevisionRefV1, assertCaptureTextV1, assertContextCaptureEnvelopeV2, assertPlainContextObjectV1,
  canonicalSourceContentV1, captureAnnotationIdV1, captureRevisionRefV1, captureSnapshotSha256V1,
  CAPTURE_ANNOTATION_PROCESSOR_V1, CAPTURE_FOUNDATION_LIMITS_V1, sourceContentSha256V1,
  type CaptureAnnotationV1, type CaptureBindingsV1, type CaptureContainerScopeV1, type CaptureClassificationV1, type CaptureDeriveSnapshotV1,
  type CaptureSnapshotSelectionV1, type ContextCaptureEnvelopeV2, type SourceAdapterIdentityV1,
} from '@echo-brain/organization-processing/core';
import { requireCurrentCaptureAuthorityV1, snapshotCaptureDataV1, type CaptureFoundationAuthorityV1 } from '../../../application/capture-foundation-v1.js';
import { SqliteSourceAdmissionStoreV1 } from './source-admission-v1.js';

interface SourceRow {
  readonly source_id: string; readonly adapter_id: string; readonly instance_id: string; readonly external_id: string;
  readonly revision_id: string; readonly adapter_version: string; readonly captured_at: string; readonly content_sha256: string;
  readonly revision_sha256: string; readonly manifest_json: string; readonly content_json: string;
}
interface CaptureRow extends SourceRow {
  readonly custody_ref: string; readonly access_policy_ref: string; readonly analysis_policy: 'on_request';
  readonly annotation_json: string; readonly annotation_sha256: string; readonly processor_version: string;
}
/** Internal Layer 1 custody and exact Layer 2 input. No public reads or provider I/O. */
export class SqliteCaptureFoundationV1 {
  private readonly sources: SqliteSourceAdmissionStoreV1;
  private readonly containers: CaptureContainerScopeV1;
  constructor(private readonly database: Database.Database, private readonly authority: CaptureFoundationAuthorityV1, containers: CaptureContainerScopeV1) {
    assertCaptureContainerScopeV1(containers);
    this.containers = snapshotCaptureDataV1(containers);
    this.sources = new SqliteSourceAdmissionStoreV1(database);
  }
  private atomic<T>(operation: () => T): T {
    // Always use a transaction/savepoint, including when an owning transaction catches a failure.
    return this.database.transaction(operation).immediate();
  }
  private requireCurrent(operation: 'retain' | 'derive', source: ContextCaptureEnvelopeV2, bindings: CaptureBindingsV1): void {
    const { organization_id } = bindings.scope;
    const mapping = resolveCaptureContainerV1(this.containers, source);
    if (mapping.organization_id !== organization_id || mapping.project_id !== bindings.project_id || mapping.container_ref !== bindings.container_ref) throw new Error('Capture project or organization differs from its configured container mapping');
    if (!this.database.prepare("SELECT 1 FROM authority_projects_v1 WHERE organization_id=? AND project_id=? AND status='active'").get(organization_id, bindings.project_id)) throw new Error('Capture project is not active in this organization');
    for (const person of bindings.people) {
      if (!this.database.prepare("SELECT 1 FROM authority_memberships WHERE organization_id=? AND principal_id=? AND membership_id=? AND status='active'").get(organization_id, person.principal_id, person.membership_id)) throw new Error('Capture Person membership is not active in this organization');
    }
    requireCurrentCaptureAuthorityV1(this.authority, { operation, source, bindings: snapshotCaptureDataV1({ scope: bindings.scope, project_id: bindings.project_id, container_ref: bindings.container_ref, people: bindings.people }) });
  }
  admit(input: {
    readonly identity: SourceAdapterIdentityV1; readonly source: ContextCaptureEnvelopeV2;
    readonly classification: CaptureClassificationV1; readonly bindings?: CaptureBindingsV1;
  }): { readonly admission: 'skipped' } |
      { readonly admission: 'unresolved'; readonly cursor_may_advance: false; readonly retry: ReturnType<typeof captureRevisionRefV1> & { readonly reason: 'needs_review' } } |
      { readonly admission: 'admitted' | 'duplicate'; readonly selection: CaptureSnapshotSelectionV1 } {
    assertPlainContextObjectV1(input, ['identity', 'source', 'classification', 'bindings'], 'Classified capture');
    assertContextCaptureEnvelopeV2(input.source, input.identity); assertCaptureClassificationV1(input.classification, input.source);
    // A rejected body never enters the source store or its representation FK chain.
    if (input.classification.decision === 'skip') return { admission: 'skipped' };
    // No durable queue/checkpoint exists yet. The caller must stop or retry, never advance past this item.
    if (input.classification.decision === 'unresolved') return { admission: 'unresolved', cursor_may_advance: false,
      retry: { ...captureRevisionRefV1(input.source), reason: 'needs_review' } };
    assertCaptureBindingsV1(input.bindings, input.source);
    const source = snapshotCaptureDataV1(input.source);
    const annotation: CaptureAnnotationV1 = snapshotCaptureDataV1({ schema_version: 1, kind: 'echo-capture-annotation-v1', ...input.bindings, classification: input.classification });
    assertCaptureAnnotationV1(annotation, source);
    return this.atomic(() => {
      this.requireCurrent('retain', source, annotation);
      if (source.revision.previous_revision_id !== undefined) {
        const previous = this.database.prepare('SELECT content_sha256 FROM authority_source_revisions_v1 WHERE organization_id=? AND source_id=? AND revision_id=?').get(annotation.scope.organization_id, source.item.source_id, source.revision.previous_revision_id) as { content_sha256: string } | undefined;
        if (!previous) throw new Error('Capture predecessor is not retained for this source');
        if (previous.content_sha256 === source.revision.content_sha256) throw new Error('Unchanged capture must reuse its admitted revision');
        const successor = this.database.prepare("SELECT 1 FROM authority_source_revisions_v1 WHERE organization_id=? AND source_id=? AND json_extract(manifest_json, '$.previous_revision_id')=? AND revision_id!=?").get(annotation.scope.organization_id, source.item.source_id, source.revision.previous_revision_id, source.revision.revision_id);
        if (successor !== undefined) throw new Error('Capture predecessor already has a retained successor');
      } else {
        const otherRevision = this.database.prepare(`SELECT 1 FROM authority_source_revisions_v1
          WHERE organization_id=? AND source_id=? AND NOT EXISTS (
            SELECT 1 FROM authority_source_revisions_v1 WHERE organization_id=? AND source_id=? AND revision_id=?)`)
          .get(annotation.scope.organization_id, source.item.source_id, annotation.scope.organization_id, source.item.source_id, source.revision.revision_id);
        if (otherRevision !== undefined) throw new Error('Capture changed source requires a retained predecessor');
      }
      const admission = this.sources.admit({ scope: annotation.scope, source });
      const annotationId = this.sources.recordRepresentation({ organization_id: annotation.scope.organization_id, source_id: source.item.source_id,
        revision_id: source.revision.revision_id, processor_version: CAPTURE_ANNOTATION_PROCESSOR_V1, content: annotation });
      return { admission, selection: { ...captureRevisionRefV1(source), annotation_representation_id: annotationId } };
    });
  }
  /**
   * The latest retained revision of one source item: the one no retained revision names
   * as its predecessor. The fork guard leaves at most one. Returned only to build the next
   * envelope; this is internal capture input, never a Person read.
   */
  head(input: { readonly organization_id: string; readonly source_id: string }): ContextCaptureEnvelopeV2 | undefined {
    assertPlainContextObjectV1(input, ['organization_id', 'source_id'], 'Capture head request');
    assertCaptureTextV1(input.organization_id, 'Organization');
    if (typeof input.source_id !== 'string' || !/^source:[a-f0-9]{64}$/.test(input.source_id)) throw new Error('Capture head source is invalid');
    return this.atomic(() => {
      const heads = this.database.prepare(`SELECT s.source_id,s.adapter_id,s.instance_id,s.external_id,
        r.revision_id,r.adapter_version,r.captured_at,r.content_sha256,r.revision_sha256,r.manifest_json,c.content_json
        FROM authority_sources_v1 s JOIN authority_source_revisions_v1 r ON r.organization_id=s.organization_id AND r.source_id=s.source_id
        JOIN authority_source_contents_v1 c ON c.organization_id=r.organization_id AND c.source_id=r.source_id AND c.revision_id=r.revision_id
        WHERE s.organization_id=? AND s.source_id=? AND NOT EXISTS (
          SELECT 1 FROM authority_source_revisions_v1 n WHERE n.organization_id=r.organization_id AND n.source_id=r.source_id
            AND json_extract(n.manifest_json, '$.previous_revision_id')=r.revision_id)
        LIMIT 2`).all(input.organization_id, input.source_id) as SourceRow[];
      if (heads.length > 1) throw new Error('Retained capture lineage has more than one head');
      if (heads.length === 0) {
        if (this.database.prepare('SELECT 1 FROM authority_source_revisions_v1 WHERE organization_id=? AND source_id=?').get(input.organization_id, input.source_id) !== undefined) {
          throw new Error('Retained capture lineage has no head');
        }
        return undefined;
      }
      return snapshotCaptureDataV1(this.source(heads[0]!));
    });
  }
  snapshot(input: { readonly organization_id: string; readonly project_id: string; readonly selections: readonly CaptureSnapshotSelectionV1[] }): CaptureDeriveSnapshotV1 {
    assertPlainContextObjectV1(input, ['organization_id', 'project_id', 'selections'], 'Capture snapshot request');
    assertCaptureTextV1(input.organization_id, 'Organization'); assertCaptureTextV1(input.project_id, 'Project');
    if (!Array.isArray(input.selections) || input.selections.length < 1 || input.selections.length > 100) throw new Error('Capture selection exceeds its bound');
    for (const selection of input.selections) {
      assertPlainContextObjectV1(selection, ['source_id', 'revision_id', 'content_sha256', 'annotation_representation_id'], 'Capture selection');
      assertCaptureRevisionRefV1({ source_id: selection.source_id, revision_id: selection.revision_id, content_sha256: selection.content_sha256 });
      if (typeof selection.annotation_representation_id !== 'string' || !/^representation:[a-f0-9]{64}$/.test(selection.annotation_representation_id)) throw new Error('Capture annotation selection is invalid');
    }
    const request = snapshotCaptureDataV1(input);
    return this.atomic(() => {
      let bytes = 0;
      const inputs = request.selections.map(selection => {
        const entry = this.read(request.organization_id, selection); bytes += Buffer.byteLength(canonicalSourceContentV1(entry));
        if (bytes > CAPTURE_FOUNDATION_LIMITS_V1.snapshot_bytes) throw new Error('Capture snapshot exceeds its byte bound');
        return entry;
      });
      inputs.sort((left, right) => {
        const key = (entry: typeof left) => canonicalSourceContentV1([entry.source.item.source_id, entry.source.revision.revision_id]);
        return key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0;
      });
      const body = { schema_version: 1, kind: 'echo-capture-derive-snapshot-v1', organization_id: request.organization_id, project_id: request.project_id, inputs } as const;
      const snapshot = snapshotCaptureDataV1({ ...body, snapshot_sha256: captureSnapshotSha256V1(body) });
      assertCaptureDeriveSnapshotV1(snapshot);
      for (const entry of snapshot.inputs) this.requireCurrent('derive', entry.source, entry.annotation);
      return snapshot;
    });
  }
  private read(organizationId: string, selection: CaptureSnapshotSelectionV1): CaptureDeriveSnapshotV1['inputs'][number] {
    const row = this.database.prepare(`SELECT s.source_id,s.adapter_id,s.instance_id,s.external_id,s.custody_ref,s.access_policy_ref,s.analysis_policy,
      r.revision_id,r.adapter_version,r.captured_at,r.content_sha256,r.revision_sha256,r.manifest_json,c.content_json,
      a.content_json AS annotation_json,a.content_sha256 AS annotation_sha256,a.processor_version
      FROM authority_sources_v1 s JOIN authority_source_revisions_v1 r ON r.organization_id=s.organization_id AND r.source_id=s.source_id
      JOIN authority_source_contents_v1 c ON c.organization_id=r.organization_id AND c.source_id=r.source_id AND c.revision_id=r.revision_id
      JOIN authority_source_representations_v1 a ON a.organization_id=r.organization_id AND a.source_id=r.source_id AND a.revision_id=r.revision_id
      WHERE s.organization_id=? AND s.source_id=? AND r.revision_id=? AND a.representation_id=?`).get(organizationId, selection.source_id, selection.revision_id, selection.annotation_representation_id) as CaptureRow | undefined;
    if (!row) throw new Error('Exact capture or annotation is not retained');
    if (Buffer.byteLength(row.annotation_json) > CAPTURE_FOUNDATION_LIMITS_V1.annotation_bytes) throw new Error('Retained capture exceeds its bound');
    const source = this.source(row);
    const annotation = JSON.parse(row.annotation_json) as CaptureAnnotationV1;
    assertCaptureAnnotationV1(annotation, source);
    const scope = { organization_id: organizationId, custody_ref: row.custody_ref, access_policy_ref: row.access_policy_ref, analysis_policy: row.analysis_policy };
    if (row.content_sha256 !== selection.content_sha256 ||
        canonicalSourceContentV1(annotation.scope) !== canonicalSourceContentV1(scope) || row.processor_version !== CAPTURE_ANNOTATION_PROCESSOR_V1 ||
        canonicalSourceContentV1(annotation) !== row.annotation_json || sourceContentSha256V1(annotation) !== row.annotation_sha256 || captureAnnotationIdV1(selection, annotation) !== selection.annotation_representation_id) throw new Error('Retained capture integrity failed');
    return { source, annotation, annotation_representation_id: selection.annotation_representation_id };
  }
  /** Rebuilds one retained envelope and verifies it against every stored commitment. */
  private source(row: SourceRow): ContextCaptureEnvelopeV2 {
    if (Buffer.byteLength(row.content_json) > 256 * 1024 || Buffer.byteLength(row.manifest_json) > 16 * 1024) throw new Error('Retained capture exceeds its bound');
    const source: ContextCaptureEnvelopeV2 = {
      item: { schema_version: 1, source_id: row.source_id, adapter: { kind: 'source', adapter_id: row.adapter_id, instance_id: row.instance_id, version: row.adapter_version }, external_id: row.external_id },
      revision: JSON.parse(row.manifest_json) as ContextCaptureEnvelopeV2['revision'], content: JSON.parse(row.content_json) as ContextCaptureEnvelopeV2['content'],
    };
    assertContextCaptureEnvelopeV2(source, source.item.adapter);
    const { captured_at: _captured, ...immutableRevision } = source.revision;
    if (source.revision.revision_id !== row.revision_id || source.revision.captured_at !== row.captured_at || source.revision.content_sha256 !== row.content_sha256 ||
        sourceContentSha256V1(immutableRevision) !== row.revision_sha256 || canonicalSourceContentV1(source.content) !== row.content_json || canonicalSourceContentV1(source.revision) !== row.manifest_json) throw new Error('Retained capture integrity failed');
    return source;
  }
}
