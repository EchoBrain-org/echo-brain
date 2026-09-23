import { sourceContentSha256V1, sourceItemIdV1 } from '@echo-brain/organization-processing/core';
import type { SourceAdapterIdentityV1, SourceEnvelopeV1 } from '@echo-brain/organization-processing/core';
import type { DocumentExtractionClaimV1 } from './ports/document-v1.js';

export const PERSON_SOURCE_IDENTITY_V1 = Object.freeze({ kind:'source',adapter_id:'person',instance_id:'authority-inbox',version:'1' } as const) satisfies SourceAdapterIdentityV1;
export interface PersonDocumentSourceContentV1 {
  readonly schema_version:1;
  readonly kind:'person-document';
  readonly document_id:string;
  readonly filename:string;
  readonly original_sha256:string;
  readonly original_size:number;
  readonly media_type:string;
}

/** Bytes remain in the accepted inbox; only a typed artifact descriptor crosses admission. */
export function personDocumentSourceEnvelopeV1(claim: DocumentExtractionClaimV1): SourceEnvelopeV1<PersonDocumentSourceContentV1> {
  const sourceId = sourceItemIdV1(PERSON_SOURCE_IDENTITY_V1,claim.document_id);
  const content: PersonDocumentSourceContentV1 = {schema_version:1,kind:'person-document',document_id:claim.document_id,filename:claim.filename,original_sha256:claim.source_sha256,original_size:claim.bytes.byteLength,media_type:claim.media_type};
  return {
    item:{schema_version:1,source_id:sourceId,adapter:PERSON_SOURCE_IDENTITY_V1,external_id:claim.document_id},
    revision:{schema_version:1,source_id:sourceId,revision_id:claim.source_sha256,captured_at:claim.received_at,content_sha256:sourceContentSha256V1(content),contributor:claim.contributor,artifact_refs:[{artifact_id:claim.document_id,media_type:claim.media_type,sha256:claim.source_sha256.replace(/^sha256:/,''),byte_length:claim.bytes.byteLength}],representation_refs:[]},
    content,
  };
}
