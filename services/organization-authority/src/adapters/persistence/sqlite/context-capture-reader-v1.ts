import type Database from 'better-sqlite3';
import {
  assertContextCaptureEnvelopeV1, assertSourceAdmissionScopeV1, canonicalSourceContentV1, CONTEXT_CAPTURE_LIMITS_V1, sourceContentSha256V1,
  type ContextCaptureEnvelopeV1, type SourceAdapterIdentityV1,
} from '@echo-brain/organization-processing/core';
import { deepFreezeContextV1, type ContextCaptureReadPortV1, type RetainedContextCaptureV1 } from '../../../application/context-intake-v1.js';

interface Row {
  readonly source_id: string; readonly adapter_id: string; readonly instance_id: string;
  readonly external_id: string; readonly adapter_version: string; readonly revision_id: string;
  readonly custody_ref: string; readonly access_policy_ref: string; readonly analysis_policy: 'on_request';
  readonly content_sha256: string; readonly revision_sha256: string; readonly manifest_json: string;
  readonly content_json: string;
}

/** Internal retained-custody read port; this never releases bytes to a Person. */
export class SqliteContextCaptureReaderV1 implements ContextCaptureReadPortV1 {
  constructor(private readonly database: Database.Database) {}

  list(input: { readonly organization_id: string; readonly limit?: number }): readonly RetainedContextCaptureV1[] {
    if (typeof input.organization_id !== 'string' || input.organization_id.trim() === '' || input.organization_id.length > 512) throw new Error('Context organization is invalid');
    const limit = input.limit ?? CONTEXT_CAPTURE_LIMITS_V1.batch;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > CONTEXT_CAPTURE_LIMITS_V1.batch) throw new Error('Context read bound is invalid');
    const rows = this.database.prepare(`SELECT s.source_id,s.adapter_id,s.instance_id,s.external_id,
      s.custody_ref,s.access_policy_ref,s.analysis_policy,r.adapter_version,r.revision_id,
      r.content_sha256,r.revision_sha256,r.manifest_json,c.content_json
      FROM authority_sources_v1 s JOIN authority_source_revisions_v1 r
        ON r.organization_id=s.organization_id AND r.source_id=s.source_id
      JOIN authority_source_contents_v1 c
        ON c.organization_id=r.organization_id AND c.source_id=r.source_id AND c.revision_id=r.revision_id
      WHERE s.organization_id=? AND json_extract(c.content_json,'$.kind')='echo-context-capture-v1'
      ORDER BY s.source_id,r.revision_id LIMIT ?`).all(input.organization_id, limit + 1) as Row[];
    // Refuse a partial custody inventory rather than silently truncate revisions.
    if (rows.length > limit) throw new Error('Context retained input set exceeds its bound');
    return Object.freeze(rows.map(row => {
      const identity: SourceAdapterIdentityV1 = { kind: 'source', adapter_id: row.adapter_id, instance_id: row.instance_id, version: row.adapter_version };
      const source = {
        item: { schema_version: 1, source_id: row.source_id, adapter: identity, external_id: row.external_id },
        revision: JSON.parse(row.manifest_json) as ContextCaptureEnvelopeV1['revision'],
        content: JSON.parse(row.content_json) as ContextCaptureEnvelopeV1['content'],
      } satisfies ContextCaptureEnvelopeV1;
      assertContextCaptureEnvelopeV1(source, identity);
      if (source.revision.revision_id !== row.revision_id || source.revision.content_sha256 !== row.content_sha256 || canonicalSourceContentV1(source.content) !== row.content_json) throw new Error('Context retained content integrity failed');
      const { captured_at: _captured, ...immutableRevision } = source.revision;
      if (sourceContentSha256V1(immutableRevision) !== row.revision_sha256) throw new Error('Context retained revision integrity failed');
      const scope = { organization_id: input.organization_id, custody_ref: row.custody_ref, access_policy_ref: row.access_policy_ref, analysis_policy: row.analysis_policy } as const;
      assertSourceAdmissionScopeV1(scope);
      if (scope.analysis_policy !== 'on_request') throw new Error('Context retained processing policy is unsupported');
      return deepFreezeContextV1({ source, scope, revision_sha256: row.revision_sha256 });
    }));
  }
}
