import type { AdapterConfig, AdapterOperationContext, SourceAdapterV1, SourcePullRequestV1, SourceAdmissionScopeV1, SourceEnvelopeV1 } from '@echo-brain/organization-processing/core';
import type { DocumentExtractionClaimV1, PersonDocumentRepositoryV1 } from '../../application/ports/document-v1.js';
import { PERSON_SOURCE_IDENTITY_V1, personDocumentSourceEnvelopeV1, type PersonDocumentSourceContentV1 } from '../../application/person-document-source-v1.js';
import type { PersonTextSourceContentV1, PersonTextSourceInboxV1 } from '../../application/ports/person-text-source-v1.js';

export type PersonSourceContentV1 = PersonDocumentSourceContentV1 | PersonTextSourceContentV1;

/** One Person source, backed by durable Authority custody rather than the user's device. */
export class PersonSourceAdapterV1 implements SourceAdapterV1<PersonSourceContentV1> {
  readonly identity = PERSON_SOURCE_IDENTITY_V1;
  private claim: DocumentExtractionClaimV1 | undefined;
  private textClaim: ReturnType<PersonTextSourceInboxV1['next']>;
  private preferText = false;
  constructor(private readonly inbox: Pick<PersonDocumentRepositoryV1,'claimExtraction'>, private readonly texts?:PersonTextSourceInboxV1) {}
  validateConfig(config: AdapterConfig) {
    const ok = config.adapter_id === this.identity.adapter_id && config.instance_id === this.identity.instance_id;
    return {ok,errors:ok?[]:['Person source identity mismatch']};
  }
  async healthCheck(context?: AdapterOperationContext) {
    context?.signal.throwIfAborted();
    return {status:'healthy' as const,checked_at:new Date().toISOString()};
  }
  async pull(request: SourcePullRequestV1, context?: AdapterOperationContext) {
    context?.signal.throwIfAborted();
    if (request.cursor !== undefined) throw new Error('Person source uses durable work leases, not provider cursors');
    const preferText = this.preferText;
    this.claim = undefined;
    this.textClaim = undefined;
    // Reserve the other lane before touching an inbox. A failed claim must not
    // permanently pin subsequent cycles to the same unavailable or corrupt row.
    if (preferText) { this.preferText = false; this.textClaim = this.texts?.next(); }
    if (!this.textClaim) { this.preferText = true; this.claim = this.inbox.claimExtraction(); }
    if (!this.textClaim && !this.claim) { this.preferText = false; this.textClaim = this.texts?.next(); }
    const sources:SourceEnvelopeV1<PersonSourceContentV1>[] = this.claim ? [personDocumentSourceEnvelopeV1(this.claim)] : this.textClaim ? [this.textClaim.source] : [];
    return {sources};
  }
  claimFor(source: SourceEnvelopeV1<PersonSourceContentV1>): DocumentExtractionClaimV1 {
    const claim = this.claim;
    if (!claim || source.content.kind !== 'person-document' || source.content.document_id !== claim.document_id || source.revision.revision_id !== claim.source_sha256) throw new Error('Person source claim does not match admitted revision');
    return claim;
  }
  scopeFor(source: SourceEnvelopeV1<PersonSourceContentV1>): SourceAdmissionScopeV1 {
    if (source.content.kind === 'person-text') {
      if (!this.textClaim || this.textClaim.source.item.source_id !== source.item.source_id || this.textClaim.source.revision.revision_id !== source.revision.revision_id) throw new Error('Person text source claim mismatch');
      return this.textClaim.scope;
    }
    return this.claimFor(source).source_scope;
  }
}
