import { canonicalSourceContentV1, type SourceAdapterIdentityV1 } from '@echo-brain/organization-processing/core';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type {
  PersonLiveEvidenceCitationV1, PersonLiveEvidencePageV1, PersonLiveEvidenceReaderV1, PersonLiveEvidenceValueV1,
} from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import { intakeContextBatchV1, type ContextCaptureEnvelopeV1, type ContextIntakeAuthorityV1 } from './context-intake-v1.js';

function data(value: unknown, depth = 0): void {
  if (depth > 64) throw new AuthorityOperationError('invalid_output', 'Live context data exceeds its bound');
  if (value === null || typeof value !== 'object') return;
  if (Object.getOwnPropertySymbols(value).length !== 0 || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) throw new AuthorityOperationError('invalid_output', 'Live context data is invalid');
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (Array.isArray(value) && key === 'length') continue;
    if (!('value' in descriptor) || !descriptor.enumerable) throw new AuthorityOperationError('invalid_output', 'Live context data must contain data fields');
    data(descriptor.value, depth + 1);
  }
}
function fields(value: object, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new AuthorityOperationError('invalid_output', 'Live context data has an unknown field');
}

/** Neutral coordinates include container identity; equal object labels cannot merge sources. */
export function contextLiveExternalIdV1(coordinates: { readonly object_id: string; readonly container_id?: string }): string {
  return canonicalSourceContentV1(coordinates);
}

/**
 * Opt-in adapter wrapper for fixture composition. The existing audited reader
 * still owns read authorization, citation validation, release and revalidation.
 * No admission store or graph handle is reachable from this request-only gate.
 */
export function withContextIntakeLiveReaderV1<C extends PersonLiveEvidenceCitationV1>(options: {
  readonly reader: PersonLiveEvidenceReaderV1<C>;
  readonly identity: SourceAdapterIdentityV1;
  readonly authority: ContextIntakeAuthorityV1;
  readonly capture: (value: PersonLiveEvidenceValueV1<C>) => ContextCaptureEnvelopeV1;
}): PersonLiveEvidenceReaderV1<C> {
  const requireRequestOnly: ContextIntakeAuthorityV1 = {
    select(source) {
      const policy = options.authority.select(source);
      if (policy.disposition !== 'request_only') throw new AuthorityOperationError('unauthorized', 'Live context retention is not authorized');
      return policy;
    },
    requireCurrent: (source, policy) => options.authority.requireCurrent(source, policy),
  };
  const gate = async (page: PersonLiveEvidencePageV1<C>, signal?: AbortSignal): Promise<PersonLiveEvidencePageV1<C>> => {
    signal?.throwIfAborted();
    data(page); fields(page, ['items', 'truncated', 'next_cursor']);
    if (!Array.isArray(page.items) || page.items.length > 50) throw new AuthorityOperationError('invalid_output', 'Context live page exceeds its bound');
    for (const value of page.items) {
      fields(value, ['citation', 'handle', 'label', 'text', 'visibility', 'attributes', 'occurred_at']);
      if (value.attributes !== undefined) fields(value.attributes, ['owner', 'due_at', 'status']);
      options.reader.validateCitation(value.citation);
    }
    const snapshot = JSON.parse(canonicalSourceContentV1(page)) as PersonLiveEvidencePageV1<C>;
    if (!Array.isArray(snapshot.items) || snapshot.items.length > 50) throw new AuthorityOperationError('invalid_output', 'Context live page exceeds its bound');
    const captures = snapshot.items.map(value => {
      const validated = options.reader.validateCitation(value.citation);
      const capture = options.capture(value);
      const representation = capture.content.representation;
      if (representation.kind === 'excerpt' && representation.passages.length !== 1) throw new AuthorityOperationError('invalid_output', 'Live excerpts require one exact released passage');
      const text = representation.kind === 'full_snapshot' ? representation.text : representation.kind === 'excerpt' ? representation.passages[0]?.text : undefined;
      if (capture.item.external_id !== contextLiveExternalIdV1(validated.coordinates) ||
          capture.content.label !== value.label || capture.content.provenance.origin_ref !== validated.citation.permalink ||
          text !== value.text || (representation.kind === 'pointer' && representation.pointer !== validated.citation.permalink)) throw new AuthorityOperationError('invalid_output', 'Context live capture differs from its release');
      return capture;
    });
    await intakeContextBatchV1({ identity: options.identity, sources: captures, authority: requireRequestOnly,
      ...(signal === undefined ? {} : { context: { signal } }) });
    signal?.throwIfAborted();
    return snapshot;
  };
  return Object.freeze<PersonLiveEvidenceReaderV1<C>>({
    get binding() { return options.reader.binding; },
    validateCitation: value => options.reader.validateCitation(value),
    search: async input => gate(await options.reader.search(input), input.signal),
    open: async input => gate(await options.reader.open(input), input.signal),
    list: async input => gate(await options.reader.list(input), input.signal),
    revalidate: input => options.reader.revalidate(input),
  });
}
