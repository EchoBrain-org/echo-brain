import type Database from 'better-sqlite3';
import {
  assertSourceAdmissionScopeV1, assertSourceEnvelopeV1, canonicalSourceContentV1,
  sourceContentSha256V1,
} from '@echo-brain/organization-processing/core';
import type {
  SourceAdmissionStoreV1, SourceAdmissionScopeV1, SourceEnvelopeV1, AdapterOperationContext,
} from '@echo-brain/organization-processing/core';

/** Internal custody store. Readers still use their domain's current-policy port. */
export class SqliteSourceAdmissionStoreV1 implements SourceAdmissionStoreV1 {
  constructor(private readonly database: Database.Database, private readonly beforeAdmit?: (source:SourceEnvelopeV1,scope:SourceAdmissionScopeV1)=>void) {}

  private atomic<T>(operation: () => T): T {
    // An owning document transaction can include admission/representation writes.
    return this.database.inTransaction ? operation() : this.database.transaction(operation).immediate();
  }

  async admitSourceRevision(input: { readonly scope: SourceAdmissionScopeV1; readonly source: SourceEnvelopeV1 }, context?: AdapterOperationContext): Promise<'admitted' | 'duplicate'> {
    context?.signal.throwIfAborted();
    return this.admit(input);
  }

  admit({ scope, source }: { readonly scope: SourceAdmissionScopeV1; readonly source: SourceEnvelopeV1 }): 'admitted' | 'duplicate' {
    assertSourceAdmissionScopeV1(scope);
    assertSourceEnvelopeV1(source, source.item.adapter);
    const { item, revision } = source;
    const content = canonicalSourceContentV1(source.content);
    const { captured_at: _captured, ...immutableRevision } = revision;
    const revisionHash = sourceContentSha256V1(immutableRevision);
    return this.atomic(() => {
      this.beforeAdmit?.(source,scope);
      const existing = this.database.prepare('SELECT adapter_id,instance_id,external_id,custody_ref,access_policy_ref,analysis_policy FROM authority_sources_v1 WHERE organization_id=? AND source_id=?').get(scope.organization_id,item.source_id);
      const identity = { adapter_id:item.adapter.adapter_id,instance_id:item.adapter.instance_id,external_id:item.external_id,custody_ref:scope.custody_ref,access_policy_ref:scope.access_policy_ref,analysis_policy:scope.analysis_policy };
      if (existing && canonicalSourceContentV1(existing) !== canonicalSourceContentV1(identity)) throw new Error('Source identity or custody conflict');
      if (!existing) this.database.prepare('INSERT INTO authority_sources_v1(organization_id,source_id,adapter_id,instance_id,external_id,custody_ref,access_policy_ref,analysis_policy) VALUES (?,?,?,?,?,?,?,?)').run(scope.organization_id,item.source_id,item.adapter.adapter_id,item.adapter.instance_id,item.external_id,scope.custody_ref,scope.access_policy_ref,scope.analysis_policy);
      const prior = this.database.prepare('SELECT revision_sha256 FROM authority_source_revisions_v1 WHERE organization_id=? AND source_id=? AND revision_id=?').get(scope.organization_id,item.source_id,revision.revision_id) as {revision_sha256:string}|undefined;
      if (prior) {
        if (prior.revision_sha256 !== revisionHash) throw new Error('Source revision conflicts with retained evidence');
        const retained = this.database.prepare('SELECT content_json FROM authority_source_contents_v1 WHERE organization_id=? AND source_id=? AND revision_id=?').get(scope.organization_id,item.source_id,revision.revision_id) as {content_json:string}|undefined;
        if (retained?.content_json !== content) throw new Error('Source revision content integrity failed');
        return 'duplicate';
      }
      this.database.prepare('INSERT INTO authority_source_revisions_v1(organization_id,source_id,revision_id,adapter_version,captured_at,content_sha256,revision_sha256,manifest_json) VALUES (?,?,?,?,?,?,?,?)').run(scope.organization_id,item.source_id,revision.revision_id,item.adapter.version,revision.captured_at,revision.content_sha256,revisionHash,canonicalSourceContentV1(revision));
      this.database.prepare('INSERT INTO authority_source_contents_v1(organization_id,source_id,revision_id,content_json) VALUES (?,?,?,?)').run(scope.organization_id,item.source_id,revision.revision_id,content);
      return 'admitted';
    });
  }

  recordRepresentation(input: { readonly organization_id:string; readonly source_id:string; readonly revision_id:string; readonly processor_version:string; readonly content:unknown }): string {
    if (!input.processor_version || input.processor_version.length > 512) throw new Error('Representation processor version is invalid');
    const content = canonicalSourceContentV1(input.content);
    const hash = sourceContentSha256V1(input.content);
    const representationId = `representation:${sourceContentSha256V1({revision_id:input.revision_id,processor_version:input.processor_version,content_sha256:hash})}`;
    return this.atomic(() => {
      const prior = this.database.prepare('SELECT content_json FROM authority_source_representations_v1 WHERE organization_id=? AND source_id=? AND revision_id=? AND representation_id=?').get(input.organization_id,input.source_id,input.revision_id,representationId) as {content_json:string}|undefined;
      if (prior) {
        if (prior.content_json !== content) throw new Error('Representation integrity failed');
      } else this.database.prepare('INSERT INTO authority_source_representations_v1(organization_id,source_id,revision_id,representation_id,processor_version,content_sha256,content_json) VALUES (?,?,?,?,?,?,?)').run(input.organization_id,input.source_id,input.revision_id,representationId,input.processor_version,hash,content);
      return representationId;
    });
  }
}
