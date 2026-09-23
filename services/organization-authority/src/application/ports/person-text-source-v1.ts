import type { SourceAdmissionScopeV1, SourceEnvelopeV1 } from '@echo-brain/organization-processing/core';

export interface PersonTextSourceContentV1 {
  readonly schema_version:1;
  readonly kind:'person-text';
  readonly original_api_version:1|2;
  readonly context_id:string;
  readonly title:string;
  readonly text:string;
}
export interface PersonTextSourceInboxV1 {
  next(): { readonly source:SourceEnvelopeV1<PersonTextSourceContentV1>; readonly scope:SourceAdmissionScopeV1 } | undefined;
}
