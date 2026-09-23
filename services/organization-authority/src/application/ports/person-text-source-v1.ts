import type { SourceAdmissionScopeV1, SourceEnvelopeV1 } from '@echo-brain/organization-processing/core';

export interface PersonTextSourceContentV1 {
  readonly schema_version:1;
  readonly kind:'person-text';
  readonly original_api_version:1|2|3;
  readonly context_id:string;
  readonly title:string;
  readonly text:string;
}
/** Content-free terminal disposition for a malformed retained note. */
export interface PersonTextSourceFailureObservationV1 {
  readonly stage: 'text_source_admission';
  readonly error_code: 'invalid_retained_text';
}
export interface PersonTextSourceInboxV1 {
  next(): { readonly source:SourceEnvelopeV1<PersonTextSourceContentV1>; readonly scope:SourceAdmissionScopeV1 } | undefined;
  /** Drains only closed error codes, never retained note content or identifiers. */
  takeFailureObservations?(): readonly PersonTextSourceFailureObservationV1[];
}
