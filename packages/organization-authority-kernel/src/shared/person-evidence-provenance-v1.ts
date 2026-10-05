/**
 * Only approved records and admitted original revisions already belong to
 * ECHO's retained context. Every other citation, including future external
 * kinds, keeps its metadata and body out of runtime content capture.
 */
export function isRetainedPersonEvidenceCitationV1(citation: { readonly kind: string }): boolean {
  return citation.kind === 'approved_record' || citation.kind === 'source_revision';
}
