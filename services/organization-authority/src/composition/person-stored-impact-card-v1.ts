import { validatePersonAnswerCitationV6, validatePersonImpactCardV1 } from '@echo-brain/organization-api';
import type { StoredImpactCardV1 } from '@echo-brain/organization-authority-kernel/answer-composition/renderers/impact-card-storage-v1';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';

/**
 * A run's stored impact card, checked to hold pointers and ECHO's own lines
 * only, or `unavailable`. The runs service rebuilds a card's view from it,
 * and open items read their decision's first decided line from it.
 */
export function readStoredImpactCardV1(json: string): StoredImpactCardV1 {
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new AuthorityOperationError('unavailable', 'stored impact card is invalid'); }
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('stored card is not an object');
    const raw = value as Record<string, unknown>;
    const keys = Object.keys(raw).sort();
    if (JSON.stringify(keys) !== JSON.stringify(['affected', 'citations', 'decided', 'schema_version', 'status', 'unconfirmed']) || raw.schema_version !== 1 ||
        !Array.isArray(raw.citations) || !Array.isArray(raw.decided) || !Array.isArray(raw.affected) || !Array.isArray(raw.unconfirmed)) throw new Error('stored card has an invalid shape');
    const rawCitations = raw.citations as unknown[];
    const rawDecided = raw.decided as unknown[];
    const rawAffected = raw.affected as unknown[];
    const rawUnconfirmed = raw.unconfirmed as unknown[];
    const citations = rawCitations.map(pointer => {
      if (typeof pointer !== 'object' || pointer === null || Array.isArray(pointer) || typeof (pointer as { readonly kind?: unknown }).kind !== 'string') throw new Error('stored citation is invalid');
      const kind = (pointer as { readonly kind: string }).kind;
      const citationKind = kind === 'ticket' || kind === 'page' || kind === 'slack_message' ? kind : 'decision';
      return validatePersonAnswerCitationV6({ citation: pointer, kind: citationKind, label: 'Stored pointer', visibility: 'only_me' }).citation;
    });
    const affected = rawAffected.map(entry => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error('stored affected row is invalid');
      const row = entry as Record<string, unknown>;
      const allowed = ['citation_index', 'date_at_risk', 'expected', 'relation', 'says_now'];
      if (Object.keys(row).some(key => !allowed.includes(key))) throw new Error('stored affected row has an extra field');
      return { ...row, says_now: row.says_now ?? 'Stored local value.' };
    });
    const validated = validatePersonImpactCardV1({
      status: raw.status, decided: rawDecided, affected, unconfirmed: rawUnconfirmed, people: [],
      citations: citations.map(citation => ({ citation, kind: citation.kind === 'ticket' || citation.kind === 'page' || citation.kind === 'slack_message' ? citation.kind : 'decision', label: 'Stored pointer', visibility: 'only_me' })),
    });
    const local = (index: number) => citations[index]?.kind === 'approved_record' || citations[index]?.kind === 'source_revision';
    if (validated.decided.some(row => !local(row.citation_index)) || rawAffected.some((entry, index) => Object.hasOwn(entry as object, 'says_now') && !local(validated.affected[index]!.citation_index))) throw new Error('stored card contains outside text');
    return Object.freeze({ schema_version: 1 as const, status: validated.status,
      decided: Object.freeze(validated.decided.map(row => Object.freeze({ text: row.text, citation_index: row.citation_index }))),
      affected: Object.freeze(validated.affected.map((row, index) => Object.freeze({ citation_index: row.citation_index,
        ...(row.relation === undefined ? {} : { relation: row.relation }), ...(row.expected === undefined ? {} : { expected: row.expected }),
        ...(row.date_at_risk === undefined ? {} : { date_at_risk: row.date_at_risk }),
        ...(Object.hasOwn(rawAffected[index] as object, 'says_now') ? { says_now: row.says_now } : {}),
      }))),
      unconfirmed: validated.unconfirmed, citations: Object.freeze(citations),
    });
  } catch {
    throw new AuthorityOperationError('unavailable', 'stored impact card is invalid');
  }
}
